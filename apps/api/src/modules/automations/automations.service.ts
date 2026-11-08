// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { allowPrivateOutbound, assertPublicUrl } from '../../lib/outbound';
import {
  ACTIONS,
  isMcpBlock,
  AppError,
  canBoard,
  evaluateConditions,
  newId,
  applyTimerDefaults,
  normalizeRecipe,
  columnTypes,
  type ComputedPreviewResult,
  type computedPreviewSchema,
  formatFormulaResult,
  parseComputed,
  recipeItemLevel,
  roundComputed,
  recipeText,
  renderDeep,
  triggerDef,
  validateConditions,
  validateRecipe,
  type AccountAutomation,
  type Automation,
  type AutomationUsage,
  type AutomationRun,
  type AutomationTestResult,
  type Recipe,
  type RecipeIssue,
  PLAN_FEATURE_ACTIONS,
} from '@bines/shared';
import { assertFeature } from '../billing/entitlements';
import type { z } from 'zod';
import type { createAutomationSchema, testAutomationSchema, updateAutomationSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { automationRuns, automations, automationSchedules, boards, items } from '../../db/schema';
import type { AppDeps } from '../../types';
import { newSecretToken } from '../../lib/tokens';
import { findMembership } from '../accounts/accounts.repo';
import { actorRegion } from '../accounts/region';
import { recordEvent } from '../activity/activity.repo';
import {
  assertBoard,
  isOwnerOrAdmin,
  loadBoardAccess,
  readableBoardIds,
  type BoardAccess,
} from '../boards/boards.access';
import { findBoard, findSubBoard, listColumns, listGroups } from '../boards/boards.repo';
import { loadItem, type Actor } from '../items/items.service';
import type { ItemRow } from '../items/items.repo';
import { visibleAcrossBoards } from '../items/visibility';
import { computeValue, textToValue } from './engine/actions';
import { findAgent } from '../agents/agents.repo';
import { findItemTemplate } from '../item-templates/item-templates.repo';
import { variablesOf } from '../item-templates/item-templates.service';
import { mayManageAgent } from '../agents/agents.service';
import { extensionRecipeIssues } from '../extensions/ext-automation';
import { flowRecipeIssues } from '../flows/flows.automation';
import { findAutomation, insertRun, type AutomationRow } from './automations.repo';
import { accountEnv, automationActor, loadSnapshot, queryEnvOf } from './engine/context';
import { enqueueJob, executeRun, runContext } from './engine/runner';
import { syncAutomationSchedules } from './engine/schedules';

/** Automations API (06 §2.16): CRUD, switch, runs, test. The engine is in ./engine. */

const loadAccess = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'automation.read');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'automations_live_on_the_main_board');
  return access;
};

/**
 * Audit 2026-10-10 #5: an automation runs with its owner's rights, so what the owner did not write or agree to must
 * not run as them. Handed to another owner, or its recipe changed by someone else who is not an account admin, it is
 * switched off with this reason — and only its owner (or an admin) switches it back on.
 */
export const OWNER_REVIEW = 'owner_review';

/** Edit / switch / delete: automation.manage, and it is mine — or I own the board / am an admin. */
const mayManage = (access: BoardAccess, a: Actor, row: Pick<AutomationRow, 'ownerId'> | null) =>
  canBoard(access.perm, 'automation.manage').ok && (!row || row.ownerId === a.user.id || isOwnerOrAdmin(access));

const MASK = '•'.repeat(16);

/**
 * What a reader who may not manage the automation sees of its recipe: no inbound secret, no signing secret, no
 * outgoing header values (they hold third-party credentials) and only the origin of an outgoing URL (Make / Zapier
 * hook URLs are themselves secrets). Managers get the recipe as stored, to edit it.
 */
export const redactRecipe = (recipe: Recipe): Recipe => {
  const r = structuredClone(recipe) as Recipe & { trigger: Record<string, unknown> };
  if (r.trigger.type === 'webhook_in' && r.trigger.secret) r.trigger.secret = MASK;
  r.actions = r.actions.map((x) => {
    if (x.type !== 'webhook') return x;
    const w = { ...x } as typeof x & { url: string; headers?: Record<string, string>; secret?: string };
    if (w.secret) w.secret = MASK;
    if (w.headers) w.headers = Object.fromEntries(Object.keys(w.headers).map((k) => [k, MASK]));
    try {
      w.url = `${new URL(w.url).origin}/…`;
    } catch {
      w.url = MASK;
    }
    return w;
  }) as Recipe['actions'];
  return r;
};

/**
 * A title as a reader who may not manage the automation sees it (and every AI tool, AI-RT8): a URL in it keeps only
 * its origin — titles written before the sentence stopped quoting webhook paths still carry the whole hook URL.
 */
export const redactTitle = (title: string) =>
  title.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url.replace(/…$/, ''));
      return u.pathname === '/' && !u.search ? u.origin : `${u.origin}/…`;
    } catch {
      return MASK;
    }
  });

const dto = (row: AutomationRow, canManage: boolean): Automation => ({
  id: row.id,
  board_id: row.boardId!,
  title: canManage ? row.title : redactTitle(row.title),
  recipe: canManage ? (row.recipe as unknown as Recipe) : redactRecipe(row.recipe as unknown as Recipe),
  is_active: row.isActive,
  owner_id: row.ownerId,
  seed_key: row.seedKey,
  note: row.note,
  deactivated_reason: row.deactivatedReason,
  run_count: row.runCount,
  last_run_at: row.lastRunAt?.toISOString() ?? null,
  last_error_at: row.lastErrorAt?.toISOString() ?? null,
  revision: row.revision,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  can_manage: canManage,
});

/** A default title: the recipe read as a sentence on its board (04 §8.1). */
const defaultTitle = (
  r: Recipe,
  columns: { key: string; title: string; type: string }[],
  groups: { id: string; title: string }[],
  subColumns?: { key: string; title: string; type: string }[],
  boardName?: string,
  itemTemplateName?: (id: string) => string | undefined,
) =>
  recipeText(r, {
    columns,
    groups,
    ...(subColumns ? { subColumns } : {}),
    ...(boardName ? { parentBoardName: boardName } : {}),
    ...(itemTemplateName ? { itemTemplateName } : {}),
  }).slice(0, 255);

/**
 * Item templates (phase 2): the template each template action names, when it fits the action — a
 * template of the board it creates on (the automation's own board for subitems) that the saver may read. Others are
 * an issue on the action's `template`.
 */
const recipeItemTemplates = async (db: Db, a: Actor, access: BoardAccess, recipe: Recipe) => {
  const found: { id: string; name: string; variables: ReturnType<typeof variablesOf> }[] = [];
  const errors: RecipeIssue[] = [];
  const top = access.board.parentBoardId ?? access.board.id;
  for (const [i, x] of recipe.actions.entries()) {
    if (x.type !== 'create_item_from_template' && x.type !== 'add_template_subitems') continue;
    const want = x.type === 'add_template_subitems' || x.board === '@self' ? top : x.board;
    const row = await findItemTemplate(db, a.ctx.accountId, x.template);
    let fits = !!row && row.boardId === want;
    if (row && fits) {
      try {
        assertBoard(await loadBoardAccess(db, a.ctx, a.user, row.boardId), 'item.read');
      } catch {
        fits = false;
      }
    }
    if (!row || !fits) {
      errors.push({ path: `actions.${i}.template`, code: 'item_template_not_found', detail: x.template });
      continue;
    }
    if (!found.some((f) => f.id === row.id)) found.push({ id: row.id, name: row.name, variables: variablesOf(row) });
  }
  return { found, errors };
};

/**
 * An inbound hook always has a secret (S-11): one saved without it keeps the one it had, or gets a new random one
 * (shown to its managers in the builder, to paste into Make / n8n as the X-Bines-Secret header).
 */
export const ensureInboundSecret = (recipe: Recipe, previous?: Recipe) => {
  if (recipe.trigger.type !== 'webhook_in' || recipe.trigger.secret) return;
  const kept = previous?.trigger.type === 'webhook_in' ? previous.trigger.secret : undefined;
  recipe.trigger.secret = kept ?? newSecretToken(24);
};

/**
 * Actions that send the board's data out of the system (or run something that can): under remote support access
 * (even `edit`) none may be added or changed — a channel set up during a grant would keep leaking after it ends
 * (S-54). Removing one, and everything else, stays allowed.
 */
export const OUTBOUND_ACTIONS: ReadonlySet<string> = new Set([
  'webhook',
  'send_email',
  'send_sms',
  'send_to_integrations',
  'run_extension',
  'run_agent',
]);

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/** Outbound actions of `recipe` not already in `previous` as they are (support access may not save those). */
export const newOutboundActions = (recipe: Recipe, previous?: Recipe) => {
  const before = new Set((previous?.actions ?? []).filter((x) => OUTBOUND_ACTIONS.has(x.type)).map(stable));
  return recipe.actions.filter((x) => OUTBOUND_ACTIONS.has(x.type) && !before.has(stable(x)));
};

/**
 * Normalizes (seed shorthands accepted) and validates a recipe against the board: columns, labels, groups,
 * conditions, and boards of cross-board actions the actor can add items to. 422 with `issues` otherwise.
 */
/**
 * for each relation a `set_computed` expression reads (`{<relation>.<key>}`), the columns of the boards
 * it links to — the save checks the key is there. A relation linking to a board I cannot open is not checked.
 */
const computedRelationColumns = async (
  db: Db,
  a: Actor,
  recipe: Recipe,
  itemColumns: Awaited<ReturnType<typeof listColumns>>,
) => {
  const relations = new Set<string>();
  for (const x of recipe.actions) {
    if (x.type !== 'set_computed') continue;
    try {
      for (const ref of parseComputed(x.expression).refs) if (ref.scope === 'relation') relations.add(ref.relation!);
    } catch {
      // A syntax problem is reported by the validation.
    }
  }
  const out: Record<string, { key: string; type: string; title: string }[]> = {};
  for (const key of relations) {
    const column = itemColumns.find((c) => c.key === key && c.type === 'board_relation');
    const boardIds = (column?.settings as { board_ids?: string[] } | undefined)?.board_ids ?? [];
    if (!column || !boardIds.length) continue;
    const cols: { key: string; type: string; title: string }[] = [];
    let readable = true;
    for (const id of boardIds) {
      const ok = await loadBoardAccess(db, a.ctx, a.user, id)
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        readable = false;
        break;
      }
      for (const c of await listColumns(db, id)) cols.push({ key: c.key, type: c.type, title: c.title });
    }
    if (readable) out[key] = cols;
  }
  return out;
};

export const prepareRecipe = async (db: Db, a: Actor, access: BoardAccess, raw: unknown, previous?: Recipe) => {
  const boardId = access.board.id;
  const [columns, groups, subBoard] = await Promise.all([
    listColumns(db, boardId),
    listGroups(db, boardId),
    findSubBoard(db, boardId),
  ]);
  // D14: subitem triggers and parent / subitem actions read the sub-board's columns.
  const subColumns = subBoard ? await listColumns(db, subBoard.id) : undefined;
  const asRecipeColumns = (cols: typeof columns) =>
    cols.map((c) => ({ key: c.key, type: c.type, title: c.title, settings: c.settings as Record<string, unknown> }));
  const normalized = normalizeRecipe(raw, {
    columns: columns.map((c) => ({ key: c.key, title: c.title, type: c.type })),
  });
  if (!normalized.ok)
    throw new AppError('invalid_recipe', normalized.error, {
      issues: [{ path: normalized.error.split(':')[0] ?? '', code: 'schema', detail: normalized.error }],
    });
  const recipe = normalized.recipe;
  if (a.ctx.support && newOutboundActions(recipe, previous).length)
    throw new AppError('forbidden', 'support_not_allowed', { reason: 'outbound_action' });
  ensureInboundSecret(recipe, previous);
  const templates = await recipeItemTemplates(db, a, access, recipe);
  const relationColumns = await computedRelationColumns(
    db,
    a,
    recipe,
    recipeItemLevel(recipe.trigger) === 'sub' ? (subColumns ?? []) : columns,
  );
  const { errors, warnings } = validateRecipe(recipe, {
    columns: asRecipeColumns(columns),
    groups: groups.map((g) => ({ id: g.id, title: g.title })),
    ...(subColumns ? { subColumns: asRecipeColumns(subColumns) } : {}),
    itemTemplates: templates.found,
    relationColumns,
  });
  // A template that does not fit its action is reported once (by the check above, not again as unknown).
  for (const issue of templates.errors)
    if (!errors.some((e) => e.path === issue.path && e.code === issue.code)) errors.push(issue);
  for (const [i, x] of recipe.actions.entries()) {
    if (
      (x.type !== 'create_item' && x.type !== 'move_to_board' && x.type !== 'create_item_from_template') ||
      x.board === '@self'
    )
      continue;
    const target = await findBoard(db, a.ctx.accountId, x.board);
    let ok = !!target && !target.parentBoardId;
    if (ok) {
      try {
        assertBoard(await loadBoardAccess(db, a.ctx, a.user, x.board), 'item.create');
      } catch {
        ok = false;
      }
    }
    if (!ok) errors.push({ path: `actions.${i}.board`, code: 'board_not_found', detail: x.board });
  }
  // Plans: the advanced actions (webhook, email, SMS, integrations, agents) are a plan feature.
  for (const x of recipe.actions) {
    const feature = PLAN_FEATURE_ACTIONS[x.type];
    if (feature) await assertFeature(db, a.ctx.accountId, feature);
  }
  // run_agent (מ8): an agent of this account that I manage (an automation runs it as its owner).
  for (const [i, x] of recipe.actions.entries()) {
    if (x.type !== 'run_agent') continue;
    const found = await findAgent(db, a.ctx.accountId, x.agent);
    if (!found || !(await mayManageAgent(db, a, found.a)))
      errors.push({ path: `actions.${i}.agent`, code: 'agent_not_found', detail: x.agent });
  }
  // A typed external email address: account admins only (audit 2026-10-10 #1; people of the account and addresses
  // from a column stay open to every editor, within the account's daily budget).
  if (a.ctx.role !== 'admin')
    for (const [i, x] of recipe.actions.entries()) {
      if (x.type !== 'send_email') continue;
      for (const ref of Array.isArray(x.to) ? x.to : [x.to])
        if (typeof ref === 'string' && ref.includes('@') && !ref.startsWith('@') && !ref.includes(':'))
          errors.push({ path: `actions.${i}.to`, code: 'external_email_admin_only', detail: ref });
    }
  // A fixed webhook address (no {placeholders}) is checked now, not only when it is called: a private / loopback
  // host is refused at save (audit 2026-10-10 #7). A name that does not resolve yet is left to the call's own guard.
  for (const [i, x] of recipe.actions.entries()) {
    if (x.type !== 'webhook' || x.url.includes('{')) continue;
    try {
      await assertPublicUrl(x.url, allowPrivateOutbound(process.env));
    } catch (e) {
      if (e instanceof AppError) errors.push({ path: `actions.${i}.url`, code: e.message, detail: x.url });
    }
  }
  // Extension blocks (D27 ת4): an enabled installation allowed on this board, its required inputs filled.
  errors.push(...(await extensionRecipeIssues(db, a.ctx.accountId, boardId, recipe)));
  // External flows: a chosen connection must be one I may see.
  errors.push(...(await flowRecipeIssues(db, a, recipe)));
  const env = await accountEnv(db, a.ctx.accountId);
  try {
    // "Only if" reads the run's item: a subitem's conditions are on the sub-board's columns (D14).
    const itemColumns = recipeItemLevel(recipe.trigger) === 'sub' ? (subColumns ?? []) : columns;
    validateConditions(recipe.conditions, await queryEnvOf(db, a.ctx.accountId, itemColumns, env));
  } catch (e) {
    errors.push({ path: 'conditions', code: (e as AppError).code ?? 'invalid', detail: (e as Error).message });
  }
  // "For each subitem (that …)": the filter is over the sub-board's columns.
  for (const [i, x] of recipe.actions.entries()) {
    if (!('where' in x) || !x.where) continue;
    try {
      validateConditions(x.where, await queryEnvOf(db, a.ctx.accountId, subColumns ?? [], env));
    } catch (e) {
      errors.push({
        path: `actions.${i}.where`,
        code: (e as AppError).code ?? 'invalid',
        detail: (e as Error).message,
      });
    }
  }
  for (const u of normalized.unresolved) warnings.push({ path: 'recipe', code: 'unresolved', detail: u });
  if (errors.length) throw new AppError('invalid_recipe', 'The recipe does not fit the board', { issues: errors });
  return {
    recipe,
    warnings: warnings as RecipeIssue[],
    title: defaultTitle(
      recipe,
      columns.map((c) => ({ key: c.key, title: c.title, type: c.type })),
      groups.map((g) => ({ id: g.id, title: g.title })),
      subColumns?.map((c) => ({ key: c.key, title: c.title, type: c.type })),
      access.board.name,
      (id) => templates.found.find((x) => x.id === id)?.name,
    ),
  };
};

export const listAutomations = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadAccess(db, a, boardId);
  const rows = await db
    .select()
    .from(automations)
    .where(
      and(eq(automations.accountId, a.ctx.accountId), eq(automations.boardId, boardId), isNull(automations.deletedAt)),
    )
    .orderBy(desc(automations.createdAt));
  return { data: rows.map((r) => dto(r, mayManage(access, a, r))) };
};

export const loadAutomation = async (db: Db, a: Actor, id: string) => {
  const row = await findAutomation(db, a.ctx.accountId, id);
  if (!row?.boardId) throw new AppError('not_found', 'Automation not found');
  const access = await loadAccess(db, a, row.boardId);
  return { row, access };
};

export const getAutomation = async (db: Db, a: Actor, id: string) => {
  const { row, access } = await loadAutomation(db, a, id);
  return dto(row, mayManage(access, a, row));
};

const event = (db: Db, a: Actor, type: string, row: AutomationRow, extra: { before?: unknown; after?: unknown } = {}) =>
  recordEvent(db, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: row.boardId,
    meta: { automation_id: row.id, title: row.title },
    ...extra,
  });

export const createAutomation = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof createAutomationSchema>,
  opts: { seedKey?: string; note?: string } = {},
) => {
  const access = await loadAccess(db, a, boardId);
  if (!mayManage(access, a, null)) throw new AppError('forbidden', 'automation_manage');
  // A new timer action is the timer of whoever made the change unless it says otherwise.
  const { recipe, warnings, title } = await prepareRecipe(db, a, access, applyTimerDefaults(input.recipe));
  const id = newId();
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(automations)
      .values({
        id,
        accountId: a.ctx.accountId,
        boardId,
        title: input.title ?? title,
        recipe: recipe as never,
        isActive: input.is_active,
        ownerId: a.user.id,
        createdBy: a.user.id,
        seedKey: opts.seedKey ?? null,
        note: opts.note ?? null,
      })
      .returning();
    await event(tx, a, 'automation.created', created!, { after: { is_active: input.is_active } });
    return created!;
  });
  if (row.isActive) await syncAutomationSchedules(db, row);
  return { ...dto(row, true), warnings };
};

export const updateAutomation = async (
  db: Db,
  a: Actor,
  id: string,
  input: z.infer<typeof updateAutomationSchema>,
  ifMatch: number | null,
) => {
  const { row, access } = await loadAutomation(db, a, id);
  if (!mayManage(access, a, row)) throw new AppError('forbidden', 'automation_manage');
  if (ifMatch !== null && ifMatch !== row.revision)
    throw new AppError('revision_mismatch', 'The automation was saved by someone else', { revision: row.revision });
  let recipe: Recipe | undefined;
  let warnings: RecipeIssue[] = [];
  if (input.recipe)
    ({ recipe, warnings } = await prepareRecipe(
      db,
      a,
      access,
      // Timer actions saved before "whose timer" existed stay the owner's; new ones default to the person.
      applyTimerDefaults(input.recipe, row.recipe as unknown as Recipe),
      row.recipe as unknown as Recipe,
    ));
  if (input.owner_id && input.owner_id !== row.ownerId) {
    // S-54: who an automation runs as is not support's to change (it would outlive the grant).
    if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed', { reason: 'automation_owner' });
    // Transferring ownership (04 §8.2): board owners and admins; the new owner must be an active member.
    if (!isOwnerOrAdmin(access)) throw new AppError('forbidden', 'owner_or_admin_only');
    const m = await findMembership(db, a.ctx.accountId, input.owner_id);
    if (m?.status !== 'active' || m.role === 'viewer') throw new AppError('invalid_value', 'owner_not_eligible');
  }
  const admin = a.ctx.role === 'admin';
  const owner = input.owner_id ?? row.ownerId;
  // Someone else's rights would run what I wrote or chose: off until that owner switches it on (#5).
  const review =
    !admin &&
    owner !== a.user.id &&
    ((!!input.owner_id && input.owner_id !== row.ownerId) || (!!recipe && row.ownerId !== a.user.id));
  if (input.is_active === true && !admin && owner !== a.user.id && (review || row.deactivatedReason === OWNER_REVIEW))
    throw new AppError('forbidden', 'automation_owner_must_activate');
  const activating = input.is_active === true && !row.isActive;
  const next = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(automations)
      .set({
        ...(input.title ? { title: input.title } : {}),
        ...(recipe ? { recipe: recipe as never } : {}),
        ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
        ...(input.owner_id ? { ownerId: input.owner_id } : {}),
        // Switching on (or fixing the recipe) clears the reason it was switched off.
        ...(activating || recipe ? { deactivatedReason: null, consecutiveErrors: 0 } : {}),
        ...(review ? { isActive: false, deactivatedReason: OWNER_REVIEW } : {}),
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, row.id))
      .returning();
    await event(tx, a, 'automation.updated', updated!, {
      before: { is_active: row.isActive, revision: row.revision },
      after: { is_active: updated!.isActive, revision: updated!.revision },
    });
    return updated!;
  });
  if (next.isActive && (activating || recipe)) await syncAutomationSchedules(db, next);
  return { ...dto(next, true), warnings };
};

export const deleteAutomation = async (db: Db, a: Actor, id: string) => {
  const { row, access } = await loadAutomation(db, a, id);
  if (!mayManage(access, a, row)) throw new AppError('forbidden', 'automation_manage');
  await db.transaction(async (tx) => {
    await tx.update(automations).set({ deletedAt: new Date(), isActive: false }).where(eq(automations.id, row.id));
    await tx.delete(automationSchedules).where(eq(automationSchedules.automationId, row.id));
    await event(tx, a, 'automation.deleted', row);
  });
  return { ok: true as const };
};

const runDto = (r: typeof automationRuns.$inferSelect): AutomationRun => ({
  id: r.id,
  automation_id: r.automationId,
  event_id: r.eventId,
  event_type: r.eventType,
  item_id: r.itemId,
  status: r.status,
  skip_reason: r.skipReason,
  error: r.error,
  depth: r.depth,
  started_at: r.startedAt?.toISOString() ?? null,
  finished_at: r.finishedAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
  log: r.actionsLog as AutomationRun['log'],
});

export const listRuns = async (
  db: Db,
  a: Actor,
  id: string,
  q: { status?: AutomationRun['status']; item_id?: string; limit: number; before?: string },
) => {
  const { row } = await loadAutomation(db, a, id);
  const rows = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, row.id),
        q.status ? eq(automationRuns.status, q.status) : undefined,
        q.item_id ? eq(automationRuns.itemId, q.item_id) : undefined,
        q.before ? lt(automationRuns.id, q.before) : undefined,
      ),
    )
    .orderBy(desc(automationRuns.id))
    .limit(q.limit + 1); // one more than the page: `next` only when there really is one (audit B4)
  const page = rows.slice(0, q.limit);
  return { data: page.map(runDto), next: rows.length > q.limit ? page[page.length - 1]!.id : null };
};

/**
 * Runs of every automation of a board, newest first (the AI tool `automation_runs` by board): whoever may read
 * the board's automations (`automation.read`) — the same as listing them.
 */
export const listBoardRuns = async (
  db: Db,
  a: Actor,
  boardId: string,
  q: { status?: AutomationRun['status']; item_id?: string; limit: number; before?: string },
) => {
  await loadAccess(db, a, boardId);
  const rows = await db
    .select({ run: automationRuns })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automationRuns.accountId, a.ctx.accountId),
        eq(automations.boardId, boardId),
        isNull(automations.deletedAt),
        q.status ? eq(automationRuns.status, q.status) : undefined,
        q.item_id ? eq(automationRuns.itemId, q.item_id) : undefined,
        q.before ? lt(automationRuns.id, q.before) : undefined,
      ),
    )
    .orderBy(desc(automationRuns.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    data: page.map((r) => runDto(r.run)),
    next: rows.length > q.limit ? page[page.length - 1]!.run.id : null,
  };
};

/** Strings of an action, rendered for the preview (04 §8.4). */
const renderAction = (
  action: Record<string, unknown>,
  lookup: Parameters<typeof renderDeep>[1],
  region: Parameters<typeof renderDeep>[3],
) => {
  const warnings: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) if (k !== 'type') out[k] = renderDeep(v, lookup, warnings, region);
  return out;
};

/**
 * "Run a test" (04 §8.4). Dry run: conditions + every action rendered for the item, nothing written. Real
 * run: a run with no event (`manual.test`), executed as usual.
 */
export const testAutomation = async (
  deps: AppDeps,
  a: Actor,
  id: string,
  input: z.infer<typeof testAutomationSchema>,
): Promise<AutomationTestResult> => {
  const { db } = deps;
  const { row, access } = await loadAutomation(db, a, id);
  if (!mayManage(access, a, row)) throw new AppError('forbidden', 'automation_manage');
  const recipe = row.recipe as unknown as Recipe;
  const needsItem = triggerDef(recipe.trigger).hasItem(recipe.trigger as never);
  if (needsItem && !input.item_id) throw new AppError('bad_request', 'item_id_required');
  if (input.item_id) {
    const { item } = await loadItem(db, a, input.item_id); // I can see it
    // A subitem trigger's item is a subitem: it lives on the board's sub-board (D14).
    const subScope = recipeItemLevel(recipe.trigger) === 'sub';
    const onBoard = subScope
      ? (await findBoard(db, a.ctx.accountId, item.boardId))?.parentBoardId === row.boardId
      : item.boardId === row.boardId;
    if (!onBoard) throw new AppError('bad_request', 'item_not_on_board');
  }
  if (!input.dry_run) {
    const runId = newId();
    await insertRun(db, {
      id: runId,
      accountId: a.ctx.accountId,
      automationId: row.id,
      itemId: input.item_id ?? null,
      status: 'pending',
      depth: 1,
      chain: [],
      eventType: 'manual.test',
    });
    // Queued like any run; where there is no queue (tests) it runs right away.
    if (!(await enqueueJob(db, 'automation.run', { run_id: runId }))) await executeRun(deps, runId);
    return { conditions: { matched: true, failed_rule: null }, actions: [], run_id: runId };
  }
  const owner = await automationActor(db, row, 'preview');
  const env = await accountEnv(db, a.ctx.accountId);
  const snap = input.item_id ? await loadSnapshot(db, owner, input.item_id) : null;
  const conditions =
    snap && recipe.conditions
      ? evaluateConditions(recipe.conditions, snap.item, await queryEnvOf(db, a.ctx.accountId, snap.columns, env))
      : ({ matched: true } as const);
  const ctx = await runContext(deps, {
    automation: row,
    a: owner,
    board: access.board,
    snap,
    row: undefined,
    run: { id: 'preview', depth: 1, chain: [] },
    env,
  });
  const lookup = ctx.lookup();
  // a computed value shows what it would be on this item (or why it would not be written).
  const computed = new Map<number, Record<string, unknown>>();
  for (const [index, x] of recipe.actions.entries()) {
    if (x.type !== 'set_computed' || !snap) continue;
    try {
      const out = await computeValue(ctx, snap, x.expression);
      computed.set(
        index,
        out.ok ? { result: roundComputed(out.value, x.round) } : { result: null, reason: out.reason },
      );
    } catch (e) {
      computed.set(index, { result: null, error: (e as Error).message });
    }
  }
  return {
    conditions: { matched: conditions.matched, failed_rule: conditions.matched ? null : conditions.failed_rule },
    actions: recipe.actions.map((x, index) => ({
      index,
      type: x.type,
      rendered: { ...renderAction(x as Record<string, unknown>, lookup, ctx.region), ...computed.get(index) },
      would_write: ACTIONS[x.type].writes && conditions.matched,
      ...(ACTIONS[x.type].available === false && !(x.type === 'run_extension' && isMcpBlock(x.block))
        ? { skipped: 'not_available' }
        : {}),
    })),
  };
};

/** Automations of the boards I can read (admins: the whole account's boards they can read). */
const visibleAutomations = async (db: Db, a: Actor) => {
  const rows = await db
    .select({ a: automations, boardName: boards.name })
    .from(automations)
    .innerJoin(boards, and(eq(boards.id, automations.boardId), isNull(boards.deletedAt)))
    .where(and(eq(automations.accountId, a.ctx.accountId), isNull(automations.deletedAt)))
    .orderBy(boards.name, desc(automations.createdAt));
  const readable = await readableBoardIds(db, a.ctx, a.user, [...new Set(rows.map((r) => r.a.boardId!))]);
  return rows.filter((r) => readable.has(r.a.boardId!));
};

/** GET /automations — account-wide list (04 §8.2) with runs and errors of the last 7 days. */
export const listAccountAutomations = async (db: Db, a: Actor): Promise<{ data: AccountAutomation[] }> => {
  const rows = await visibleAutomations(db, a);
  const ids = rows.map((r) => r.a.id);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const counts = ids.length
    ? await db
        .select({
          id: automationRuns.automationId,
          runs: sql<number>`count(*) filter (where ${automationRuns.status} <> 'skipped')::int`,
          errors: sql<number>`count(*) filter (where ${automationRuns.status} in ('failed', 'partial'))::int`,
        })
        .from(automationRuns)
        .where(and(inArray(automationRuns.automationId, ids), gte(automationRuns.createdAt, since)))
        .groupBy(automationRuns.automationId)
    : [];
  const byId = new Map(counts.map((c) => [c.id, c]));
  const accesses = new Map<string, BoardAccess>();
  const data: AccountAutomation[] = [];
  for (const r of rows) {
    const boardId = r.a.boardId!;
    if (!accesses.has(boardId)) accesses.set(boardId, await loadBoardAccess(db, a.ctx, a.user, boardId));
    data.push({
      ...dto(r.a, mayManage(accesses.get(boardId)!, a, r.a)),
      board_name: r.boardName,
      runs_7d: byId.get(r.a.id)?.runs ?? 0,
      errors_7d: byId.get(r.a.id)?.errors ?? 0,
    });
  }
  return { data };
};

/** GET /automations/usage (04 §8.3): runs per day by outcome, actions carried out, what is due soon. */
export const automationUsage = async (db: Db, a: Actor): Promise<AutomationUsage> => {
  const rows = await visibleAutomations(db, a);
  const ids = rows.map((r) => r.a.id);
  // Days are the account's (region timezone) on both sides — the SQL buckets and the list of days — so "today" is
  // the reader's today also between their midnight and UTC's.
  const { timezone: tz } = await actorRegion(db, a);
  const dayOf = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t));
  const now0 = Date.now();
  const since = new Date(now0 - 31 * 86_400_000);
  const perDay = ids.length
    ? await db
        .select({
          day: sql<string>`to_char(${automationRuns.createdAt} at time zone ${tz}, 'YYYY-MM-DD')`,
          status: automationRuns.status,
          runs: sql<number>`count(*)::int`,
          actions: sql<number>`coalesce(sum((select count(*) from jsonb_array_elements(${automationRuns.actionsLog}) e where e->>'status' = 'ok')), 0)::int`,
        })
        .from(automationRuns)
        .where(and(inArray(automationRuns.automationId, ids), gte(automationRuns.createdAt, since)))
        .groupBy(sql`1`, automationRuns.status)
    : [];
  const days: AutomationUsage['days'] = [];
  for (let i = 29; i >= 0; i--) {
    const day = dayOf(now0 - i * 86_400_000);
    const of = (st: string) => perDay.filter((p) => p.day === day && p.status === st).reduce((n, p) => n + p.runs, 0);
    days.push({
      day,
      succeeded: of('succeeded'),
      partial: of('partial'),
      failed: of('failed'),
      skipped: of('skipped'),
      actions: perDay.filter((p) => p.day === day).reduce((n, p) => n + p.actions, 0),
    });
  }
  const now = new Date();
  const due = ids.length
    ? ((
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(automationSchedules)
          .where(
            and(
              inArray(
                automationSchedules.automationId,
                rows
                  .filter((r) => r.a.isActive)
                  .map((r) => r.a.id)
                  .concat(['']),
              ),
              isNull(automationSchedules.firedAt),
              lte(automationSchedules.fireAt, new Date(now.getTime() + 86_400_000)),
            ),
          )
      )[0]?.n ?? 0)
    : 0;
  return {
    days,
    active: rows.filter((r) => r.a.isActive).length,
    total: rows.length,
    needs_fixing: rows.filter((r) => !!r.a.deactivatedReason).length,
    scheduled_24h: due,
  };
};

/**
 * the builder's preview of a `set_computed` expression — computed on up to three items of the board
 * (or its sub-board) I can see, or on one item; nothing is written. A problem the save would refuse comes back as
 * `error` (the expression, a column that is not there).
 */
export const previewComputed = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof computedPreviewSchema>,
): Promise<ComputedPreviewResult> => {
  const access = await loadAccess(db, a, boardId);
  const target = input.level === 'sub' ? await findSubBoard(db, access.board.id) : access.board;
  if (!target) return { samples: [] };
  let rows: ItemRow[];
  if (input.item_id) {
    const { item } = await loadItem(db, a, input.item_id);
    if (item.boardId !== target.id) throw new AppError('bad_request', 'item_not_on_board');
    rows = [item];
  } else {
    const first = await db
      .select()
      .from(items)
      .where(and(eq(items.boardId, target.id), isNull(items.archivedAt), isNull(items.deletedAt)))
      .orderBy(items.createdAt)
      .limit(30);
    const visible = await visibleAcrossBoards(db, a, first);
    rows = first.filter((r) => visible.has(r.id)).slice(0, 3);
  }
  const env = await accountEnv(db, a.ctx.accountId);
  const ctx = {
    db,
    a,
    timezone: env.timezone,
    region: await actorRegion(db, a),
    calendar: env.calendar,
    now: new Date(),
  };
  const column = input.column ? (await listColumns(db, target.id)).find((c) => c.key === input.column) : undefined;
  const def = column && columnTypes.get(column.type);
  const samples: ComputedPreviewResult['samples'] = [];
  for (const row of rows) {
    const snap = await loadSnapshot(db, a, row.id);
    if (!snap) continue;
    let out;
    try {
      out = await computeValue(ctx, snap, input.expression);
    } catch (e) {
      const [code, ...rest] = (e as Error).message.split(':');
      return { samples: [], error: { code: code!, ...(rest.length ? { detail: rest.join(':') } : {}) } };
    }
    const base = { item_id: row.id, name: row.name };
    if (!out.ok) {
      samples.push({ ...base, ok: false, text: null, reason: out.reason });
      continue;
    }
    const v = roundComputed(out.value, input.round);
    const raw = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
    if (!column || !def) {
      samples.push({ ...base, ok: true, text: formatFormulaResult(v) });
      continue;
    }
    const value = textToValue(column, raw, ctx.region);
    samples.push(
      value === undefined
        ? { ...base, ok: false, text: null, reason: 'not_a_value' }
        : { ...base, ok: true, text: def.toText(value as never, column.settings as never, { region: ctx.region }) },
    );
  }
  return { samples };
};
