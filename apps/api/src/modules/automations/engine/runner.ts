// SPDX-License-Identifier: AGPL-3.0-only
import { findRun as findRunRow } from '../automations.repo';
import { bumpMeter, METER } from '../../costs/meter';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  addedPersonRefs,
  whoNeedsItem,
  AppError,
  actionDef,
  isMcpBlock,
  newId,
  columnTypes,
  evaluateConditions,
  isDateTrigger,
  matchTrigger,
  recipeSchema,
  subTriggerDepth,
  TRIGGER_EVENT_TYPES,
  type AutomationEvent,
  type Recipe,
  PLAN_FEATURE_ACTIONS,
  planIncludesFeature,
} from '@bines/shared';
import type { Db } from '../../../db/client';
import { enqueueJob } from '../../../lib/jobs';
export { enqueueJob };
import { cells, columns as columnsTable, itemLinks, items, updates } from '../../../db/schema';
import type { AppDeps } from '../../../types';
import { findAccountById } from '../../accounts/accounts.repo';
import { actorRegion } from '../../accounts/region';
import { findBoard, listColumns, listGroups, type BoardRow, type ColumnRow } from '../../boards/boards.repo';
import { memberNames } from '../../items/items.repo';
import { listItems } from '../../items/items.service';
import {
  activeAutomationsOn,
  claimRun,
  deactivateAutomation,
  findActivity,
  findAutomation,
  finishRun,
  insertRun,
  ranRecently,
  runsSince,
  recordRunOutcome,
  type AutomationRow,
} from '../automations.repo';
import {
  accountEnv,
  automationActor,
  loadSnapshot,
  queryEnvOf,
  type AccountEnv,
  type RunScope,
  type Snapshot,
} from './context';
import type { Actor } from '../../items/items.service';
import type { ActivityRow } from '../../activity/activity.repo';
import { loadViewAccess, ownerView, runAction, whoRefsOnItem, type ActionOutcome, type RunCtx } from './actions';
import { syncItemSchedules } from './schedules';
import { fanoutWebhooks } from '../../webhooks/fanout';
import { buildLookup, type ItemVars } from './vars';
import { dispatchAgentTriggers, eventAgentId, eventDepth } from '../../agents/triggers';
import { scheduleAiColumns } from '../../ai2/columns.service';
import { accountClosed, consume, entitlements, planFeaturesOf, writesBlocked } from '../../billing/entitlements';
import { webOrigin } from '../../platform/public-address';
import { recordAutomationRun } from '../../errors/errors.sources';
import { dispatchScenarios } from '../../scenarios/engine';

/** 04 §5.4 */
export const MAX_DEPTH = 5;
export const SELF_LOOP_MS = 10_000;
/** Runs of one automation on one item in a minute before it stops (a person editing fast stays well under it). */
export const RUNS_PER_ITEM_MINUTE = 60;

type AutomationMeta = { automation_id?: string; run_id?: string; depth?: number; chain?: string[] };

const eventOf = (row: NonNullable<Awaited<ReturnType<typeof findActivity>>>, sub: boolean): AutomationEvent => {
  const meta = (row.payload.meta ?? {}) as Record<string, unknown>;
  const auto = meta.automation as AutomationMeta | undefined;
  return {
    id: row.id,
    type: row.type,
    board_id: row.boardId,
    item_id: row.itemId,
    sub,
    column_key: (meta.column_key as string | undefined) ?? null,
    column_type: (meta.column_type as string | undefined) ?? null,
    before: row.payload.before,
    after: row.payload.after,
    meta,
    actor: {
      type: row.actorType,
      id: row.actorId,
      automation_id: auto?.automation_id ?? row.automationId ?? null,
      // An agent run's writes carry its depth too (מ8): agent → automation → agent chains stop at MAX_DEPTH.
      depth: eventDepth(row),
    },
  };
};

const recipeOf = (a: AutomationRow): Recipe | null => {
  const parsed = recipeSchema.safeParse(a.recipe);
  return parsed.success ? parsed.data : null;
};

const toQueryColumns = (cols: ColumnRow[]) =>
  cols.map((c) => ({ id: c.key, type: c.type, settings: c.settings as Record<string, unknown> }));

/**
 * `connected_items_all_done` (04 §2): a change on board B reaches the items of other boards that link to the
 * changed item through the automation's relation column. Returns [automation, item on its board] pairs.
 */
const viaRelations = async (db: Db, accountId: string, ev: AutomationEvent) => {
  if (ev.type !== 'cell.changed' || !ev.item_id || ev.column_type !== 'status') return [];
  const rows = await db
    .select({ fromItemId: itemLinks.fromItemId, columnKey: columnsTable.key, boardId: columnsTable.boardId })
    .from(itemLinks)
    .innerJoin(columnsTable, eq(columnsTable.id, itemLinks.columnId))
    .innerJoin(items, and(eq(items.id, itemLinks.fromItemId), isNull(items.deletedAt)))
    .where(and(eq(itemLinks.accountId, accountId), eq(itemLinks.toItemId, ev.item_id)));
  if (!rows.length) return [];
  const autos = await activeAutomationsOn(db, accountId, [...new Set(rows.map((r) => r.boardId))]);
  const out: { automation: AutomationRow; itemId: string }[] = [];
  for (const automation of autos) {
    const r = recipeOf(automation);
    if (r?.trigger.type !== 'connected_items_all_done') continue;
    const column = r.trigger.column;
    for (const row of rows)
      if (row.boardId === automation.boardId && row.columnKey === column)
        out.push({ automation, itemId: row.fromItemId });
  }
  return out;
};

/** Events that move date schedules: the watched cell, and the item appearing / disappearing / changing board. */
const SCHEDULE_EVENTS = new Set([
  'cell.changed',
  'item.renamed', // a "last updated" column of chosen columns may watch the name (s4f)
  'item.created',
  'item.restored',
  'item.unarchived',
  'item.archived',
  'item.deleted',
  'item.moved_to_board',
]);

/** Keys of a board's columns computed from the item that a date trigger can read (last updated — s4f). */
const computedDateKeys = async (db: Db, boardId: string) =>
  new Set(
    (await listColumns(db, boardId))
      .filter((c) => !!columnTypes.get(c.type)?.fromItem && !!columnTypes.get(c.type)?.toDate)
      .map((c) => c.key),
  );

/** Live top-level items of the automation's board that meet its conditions now, as its owner sees them. */
/** The items a period trigger runs on now; `null` = the owner cannot act (inactive, gone), nothing matched. */
const matchingItems = async (db: Db, automation: AutomationRow, recipe: Recipe): Promise<string[] | null> => {
  let a;
  try {
    a = await automationActor(db, automation, 'dispatch');
  } catch {
    return null;
  }
  const rows = (await listItems(db, a, automation.boardId!)).filter((i) => i.depth === 0);
  if (!recipe.conditions) return rows.map((r) => r.id);
  const env = await queryEnvOf(
    db,
    automation.accountId,
    await listColumns(db, automation.boardId!),
    await accountEnv(db, automation.accountId),
  );
  try {
    return rows.filter((r) => evaluateConditions(recipe.conditions, r, env).matched).map((r) => r.id);
  } catch (e) {
    // A condition the board cannot answer any more (column removed, operator changed): structural (04 §5.7).
    await deactivateAutomation(db, automation.id, `invalid_condition:${errorOf(e).message}`);
    return [];
  }
};

/**
 * `automation.dispatch` (04 §5.1): one activity row → the runs it causes. Each run row is inserted `pending`
 * (unique per automation × event: a redelivered job adds nothing) and its job queued. Returns the new run ids.
 */
export const dispatchEvent = async (deps: AppDeps, eventId: string): Promise<string[]> => {
  const { db } = deps;
  const row = await findActivity(db, eventId);
  if (!row?.boardId) return [];
  const own = await findBoard(db, row.accountId, row.boardId);
  if (!own) return [];
  // plan-lock: nothing of a closed account runs — no webhooks out, agents, AI columns or automations.
  if (await accountClosed(db, row.accountId)) return [];
  // The board's webhooks hear it too (06 §2.17) — a fan-out failure never stops the automations (worker #14).
  await fanoutWebhooks(deps, row, own).catch((err) => deps.logger.error({ err, eventId }, 'webhook fan-out failed'));
  // Agents mentioned in an update / assigned in a people column (מ8) — a failure there never stops the automations.
  await dispatchAgentTriggers(deps, row, own).catch((err) =>
    deps.logger.error({ err, eventId }, 'agent triggers failed'),
  );
  // Auto-run AI columns (מ11) whose inputs changed — debounced; a failure never stops the automations.
  await scheduleAiColumns(deps, row).catch((err) => deps.logger.error({ err, eventId }, 'ai column auto-run failed'));
  // Scenarios of the board (phase 3) — beside the automations; a failure never stops them.
  await dispatchScenarios(deps, row, own).catch((err) =>
    deps.logger.error({ err, eventId }, 'scenario dispatch failed'),
  );
  if (!(TRIGGER_EVENT_TYPES.has(row.type) || SCHEDULE_EVENTS.has(row.type))) return [];
  // An event on a sub-board (D14) is heard by the parent board's subitem triggers.
  const sub = !!own.parentBoardId;
  const listeningBoardId = own.parentBoardId ?? own.id;
  const ev = eventOf(row, sub);
  const boardAutomations = await activeAutomationsOn(db, row.accountId, [listeningBoardId]);

  // Date schedules follow the watched cells and the item's life (04 §5.6).
  if (!sub && ev.item_id && SCHEDULE_EVENTS.has(ev.type)) {
    // s4f: a "last updated" column moves with other cells (any, or its chosen ones — and the name).
    const dated = boardAutomations.some((a) => {
      const t = recipeOf(a)?.trigger;
      return !!t && isDateTrigger(t);
    });
    const computedKeys = dated ? await computedDateKeys(db, listeningBoardId) : new Set<string>();
    const watches = (a: AutomationRow) => {
      const t = recipeOf(a)?.trigger;
      if (!t || !isDateTrigger(t)) return false;
      if (computedKeys.has(t.column)) return true;
      return ev.type !== 'item.renamed' && (ev.type !== 'cell.changed' || t.column === ev.column_key);
    };
    if (ev.type === 'item.moved_to_board' || boardAutomations.some(watches))
      await syncItemSchedules(db, row.accountId, ev.item_id, boardAutomations.filter(watches));
  }
  if (!TRIGGER_EVENT_TYPES.has(row.type)) return [];
  const depth = (ev.actor.depth ?? 0) + 1;
  const parentChain = ((ev.meta?.automation as AutomationMeta | undefined)?.chain ?? []).concat(
    ev.actor.automation_id ? [ev.actor.automation_id] : [],
  );

  const columns = toQueryColumns(await listColumns(db, own.id));
  if (ev.type === 'update.created' && ev.item_id) {
    const id = (ev.after as { update_id?: string } | undefined)?.update_id;
    if (id) {
      const u = (await db.select({ text: updates.bodyText }).from(updates).where(eq(updates.id, id)).limit(1))[0];
      ev.update_text = u?.text ?? '';
    }
  }

  // D14: a subitem trigger may hear only subitems or only sub-subitems (both live on the sub-board).
  let eventDepth: number | null | undefined;
  const depthOfEventItem = async () => {
    if (eventDepth === undefined)
      eventDepth = ev.item_id
        ? ((await db.select({ d: items.depth }).from(items).where(eq(items.id, ev.item_id)).limit(1))[0]?.d ?? null)
        : null;
    return eventDepth;
  };

  const candidates: { automation: AutomationRow; itemId: string | null }[] = [];
  for (const automation of boardAutomations) {
    const recipe = recipeOf(automation);
    if (!recipe) continue;
    // Hard rule: an automation never fires on its own writes.
    if (ev.actor.automation_id === automation.id) continue;
    if (!matchTrigger(recipe.trigger, ev, { automationId: automation.id, columns })) continue;
    const wantDepth = sub ? subTriggerDepth(recipe.trigger) : null;
    if (wantDepth !== null && (await depthOfEventItem()) !== wantDepth) continue;
    let itemId = ev.item_id;
    // "When all subitems…": the run is about the parent.
    if (recipe.trigger.type === 'subitem_status_changed' && recipe.trigger.all_subitems && ev.item_id) {
      itemId =
        (await db.select({ p: items.parentItemId }).from(items).where(eq(items.id, ev.item_id)).limit(1))[0]?.p ?? null;
    }
    if (recipe.trigger.type === 'every_time_period') {
      // "Every day, if …": one run per item that meets the conditions now (scope each_item), or one for the board.
      if (recipe.trigger.scope === 'board') candidates.push({ automation, itemId: null });
      else {
        const ids = await matchingItems(db, automation, recipe);
        // The owner cannot act: one skipped run says so (worker #15 — the tick used to leave no trace).
        if (ids === null)
          await insertRun(db, {
            id: newId(),
            accountId: row.accountId,
            automationId: automation.id,
            eventId: row.id,
            itemId: null,
            status: 'skipped',
            skipReason: 'owner_inactive',
            depth,
            chain: parentChain,
            eventType: row.type,
            finishedAt: new Date(),
          });
        else for (const id of ids) candidates.push({ automation, itemId: id });
      }
      continue;
    }
    candidates.push({ automation, itemId });
  }
  candidates.push(
    ...(await viaRelations(db, row.accountId, ev)).filter((c) => c.automation.id !== ev.actor.automation_id),
  );

  const runIds: string[] = [];
  for (const { automation, itemId } of candidates) {
    const tooDeep = depth > MAX_DEPTH;
    const id = await insertRun(db, {
      id: newId(),
      accountId: row.accountId,
      automationId: automation.id,
      eventId: row.id,
      itemId,
      status: tooDeep ? 'skipped' : 'pending',
      skipReason: tooDeep ? 'max_depth' : null,
      depth,
      chain: parentChain,
      eventType: row.type,
      ...(tooDeep ? { finishedAt: new Date() } : {}),
    });
    // Errors hub: a chain cut at the depth limit is a problem skip (a loop between automations).
    if (id && tooDeep)
      recordAutomationRun(db, {
        accountId: row.accountId,
        automationId: automation.id,
        boardId: automation.boardId,
        runId: id,
        itemId,
        status: 'skipped',
        skipReason: 'max_depth',
      });
    if (!id || tooDeep) continue;
    runIds.push(id);
    await enqueueJob(db, 'automation.run', { run_id: id });
  }
  return runIds;
};

type LogEntry = {
  index: number;
  type: string;
  status: 'ok' | 'skipped' | 'error';
  duration_ms: number;
  output?: Record<string, unknown>;
  reason?: string;
  error?: string;
  code?: string;
  warnings?: string[];
};

/** Actions after a failed `create_item` that need its result, or anything on an item that is gone. */
const dependsOnFailure = (type: string, failed: Set<string>) =>
  type === 'connect_items' &&
  (failed.has('create_item') ||
    failed.has('create_subitem') ||
    failed.has('duplicate_item') ||
    failed.has('create_item_from_template'));

const errorOf = (e: unknown): { code: string; message: string } =>
  e instanceof AppError
    ? { code: e.code, message: e.message }
    : { code: 'internal', message: (e as Error)?.message ?? 'error' };

/** Structural errors (the board changed under the recipe) deactivate the automation at once (04 §5.7). */
const STRUCTURAL =
  /^(column_not_found|group_not_found|board_not_found|label_not_found|agent_not_found|item_template_not_found):/;

/**
 * `automation.run` (04 §5.3): claim → fresh snapshot → deep trigger checks → conditions → actions in order,
 * each in its own transaction through the services, attributed to the run. Independent actions continue
 * after a failure.
 */
export const executeRun = async (deps: Pick<AppDeps, 'db' | 'env' | 'mailer' | 'logger'> & AppDeps, runId: string) => {
  const { db } = deps;
  const run = await claimRun(db, runId);
  if (!run) return null;
  const automation = await findAutomation(db, run.accountId, run.automationId);
  const boardId = automation?.boardId ?? null;
  const finish = (
    status: 'succeeded' | 'partial' | 'failed' | 'skipped',
    extra: { skipReason?: string; error?: string; actionsLog?: LogEntry[] } = {},
  ) =>
    finishRun(db, run.id, { status, ...extra }).then(() => {
      // Errors hub: failures, and skips whose reason is a problem (decided by the hub's settings).
      recordAutomationRun(db, {
        accountId: run.accountId,
        automationId: run.automationId,
        boardId,
        runId: run.id,
        itemId: run.itemId,
        status,
        ...extra,
      });
      return { status, ...extra };
    });

  // Audit 2026-10-10 (automations #3): a throw anywhere outside the action loop (a lookup, the plan check, the
  // run context) used to leave the claimed row `running` for good — the retried job finds no `pending` row.
  // Now it ends the run as failed; `failStaleRuns` (the schedule tick) covers a process that died mid-run.
  try {
    return await executeClaimedRun(deps, run, automation, finish);
  } catch (e) {
    await recordRunOutcome(db, run.automationId, 'error').catch(() => undefined);
    return finish('failed', { error: errorOf(e).message });
  }
};

type ClaimedRun = NonNullable<Awaited<ReturnType<typeof claimRun>>>;
type Finish = (
  status: 'succeeded' | 'partial' | 'failed' | 'skipped',
  extra?: { skipReason?: string; error?: string; actionsLog?: LogEntry[] },
) => Promise<{ status: string; skipReason?: string; error?: string; actionsLog?: LogEntry[] }>;

const executeClaimedRun = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'mailer' | 'logger'> & AppDeps,
  run: ClaimedRun,
  automation: Awaited<ReturnType<typeof findAutomation>>,
  finish: Finish,
) => {
  const { db } = deps;
  if (!automation?.isActive) return finish('skipped', { skipReason: 'inactive' });
  // plan-lock: a closed account runs nothing (the run is recorded as skipped; the automation stays on).
  if (await accountClosed(db, run.accountId)) return finish('skipped', { skipReason: 'account_closed' });
  const recipe = recipeOf(automation);
  if (!recipe) return finish('failed', { error: 'invalid_recipe' });
  const row = run.eventId ? await findActivity(db, run.eventId) : undefined;

  // Self re-trigger: the same automation on the same item within 10 s, inside an automation chain (04 §5.4).
  if (
    run.itemId &&
    run.depth > 1 &&
    (await ranRecently(db, automation.id, run.itemId, new Date(Date.now() - SELF_LOOP_MS), run.id))
  )
    return finish('skipped', { skipReason: 'self_loop' });
  // a general brake — the same automation on the same item more than RUNS_PER_ITEM_MINUTE times in a
  // minute stops with an error in its history (a loop the depth rules cannot see: through an integration, say).
  if (
    run.itemId &&
    (await runsSince(db, automation.id, run.itemId, new Date(Date.now() - 60_000), run.id)) >= RUNS_PER_ITEM_MINUTE
  )
    return finish('failed', { error: 'run_limit' });

  let a;
  try {
    a = await automationActor(db, automation, run.id);
  } catch (e) {
    await recordRunOutcome(db, automation.id, 'error');
    return finish('failed', { error: errorOf(e).message });
  }
  const board = (await findBoard(db, run.accountId, automation.boardId!)) as BoardRow | undefined;
  if (!board) return finish('skipped', { skipReason: 'board_gone' });

  const env = await accountEnv(db, run.accountId);
  const trigger = recipe.trigger;
  const goneOk = trigger.type === 'item_deleted' || trigger.type === 'item_archived';
  let snap: Snapshot | null = null;
  if (run.itemId) {
    // An `item_deleted` run reads the trashed item too (audit 2026-10-10, automations #2): its name and cells
    // render in messages, `notify` has a recipient context, and the actions that need a live item skip `item_gone`.
    snap = await loadSnapshot(db, a, run.itemId, { gone: goneOk });
    if (!snap && !goneOk) return finish('skipped', { skipReason: 'item_gone' });
  }

  // Deep trigger checks (04 §2): they need data the event did not carry.
  if (trigger.type === 'subitem_status_changed' && trigger.all_subitems && snap) {
    if (!(await allSubitemsMatch(db, snap, trigger.column, trigger.labels)))
      return finish('skipped', { skipReason: 'not_all_subitems' });
  }
  if (trigger.type === 'connected_items_all_done' && snap) {
    if (!(await allConnectedDone(db, a, snap, trigger))) return finish('skipped', { skipReason: 'not_all_done' });
  }

  if (snap && recipe.conditions) {
    const qenv = await queryEnvOf(db, run.accountId, snap.columns, env);
    let result;
    try {
      result = evaluateConditions(recipe.conditions, snap.item, qenv);
    } catch (e) {
      await deactivateAutomation(db, automation.id, `invalid_condition:${errorOf(e).message}`);
      return finish('failed', { error: `invalid_condition:${errorOf(e).message}` });
    }
    if (!result.matched)
      return finish('skipped', {
        skipReason: 'conditions',
        actionsLog: [
          {
            index: -1,
            type: 'conditions',
            status: 'skipped',
            duration_ms: 0,
            reason: result.failed_rule ?? 'conditions',
          },
        ],
      });
  }

  // Plans: a read-only / suspended subscription pauses automations (they stay on); a run that would pass
  // the month's run limit is skipped — the automation is never switched off or deleted.
  const plan = await entitlements(db, run.accountId);
  if (writesBlocked(plan.status))
    return finish('skipped', {
      skipReason:
        plan.status === 'closed' ? 'account_closed' : plan.status === 'suspended' ? 'plan_suspended' : 'plan_read_only',
    });
  // Plans: an action whose feature the plan lacks is skipped (the automation stays as it is).
  const planFeatures = planFeaturesOf(plan);
  try {
    await consume(db, run.accountId, 'automation_runs', 1);
    // Costs: a run is counted per day on its account.
    void bumpMeter(db, METER.automationRuns, 1, run.accountId);
  } catch (e) {
    if (e instanceof AppError && e.code === 'plan_limit_reached')
      return finish('skipped', { skipReason: 'plan_limit_reached' });
    throw e;
  }

  const ctx: RunCtx = await runContext(deps, {
    automation,
    a,
    board,
    snap,
    row,
    run: { id: run.id, depth: run.depth, chain: run.chain },
    env,
  });

  ctx.eventId = run.eventId;
  // Deep trigger check (04 §2): a `person_assigned` whose `who` is read off the item — the creator, a people
  // column, a mirror (worker #16: such a `who` used to match whoever was added).
  if (trigger.type === 'person_assigned' && whoNeedsItem(trigger.who)) {
    const added = row ? addedPersonRefs(row.payload.before, row.payload.after) : [];
    const wanted = await whoRefsOnItem(ctx, trigger.who);
    if (!added.some((p) => wanted.has(p))) return finish('skipped', { skipReason: 'who_mismatch' });
  }
  // The trigger item is in the trash: only the actions marked `onGoneItem` run (notify, email, webhook …).
  if (snap?.row.deletedAt) ctx.itemGone = true;
  const log: LogEntry[] = [];
  const failedTypes = new Set<string>();
  let structural: string | null = null;
  for (const [index, action] of recipe.actions.entries()) {
    const def = actionDef(action);
    const started = Date.now();
    const push = (o: ActionOutcome) => {
      const entry: LogEntry = { index, type: action.type, status: o.status, duration_ms: Date.now() - started };
      if (o.status === 'ok')
        Object.assign(entry, o.output ? { output: o.output } : {}, o.warnings ? { warnings: o.warnings } : {});
      else if (o.status === 'skipped') entry.reason = o.reason;
      else Object.assign(entry, { error: o.error, code: o.code });
      log.push(entry);
    };
    // A registry action marked unavailable is skipped; an `mcp:<tool>` block (מ10) always may run.
    if (def.available === false && !(action.type === 'run_extension' && isMcpBlock(action.block))) {
      push({ status: 'skipped', reason: 'not_available' });
      continue;
    }
    const feature = PLAN_FEATURE_ACTIONS[action.type];
    if (feature && !planIncludesFeature(planFeatures, feature)) {
      push({ status: 'skipped', reason: 'plan_feature_unavailable' });
      continue;
    }
    if ((ctx.itemGone || !ctx.snap) && def.needsItem && !def.onGoneItem) {
      push({ status: 'skipped', reason: ctx.snap || goneOk || ctx.itemGone ? 'item_gone' : 'no_item' });
      continue;
    }
    if (dependsOnFailure(action.type, failedTypes)) {
      push({ status: 'skipped', reason: 'dependency' });
      continue;
    }
    try {
      ctx.actionIndex = index;
      // r19relfilter: links to items a relation's filter does not offer are made and noted in the run log.
      ctx.a.notes = [];
      push(withNotes(await runAction(ctx, action), ctx.a.notes));
    } catch (e) {
      // a move the status workflow blocks is skipped with its reason — not an error that counts toward
      // switching the automation off.
      if (e instanceof AppError && e.code === 'workflow_blocked') {
        push({ status: 'skipped', reason: e.message });
        continue;
      }
      const err = errorOf(e);
      failedTypes.add(action.type);
      if (STRUCTURAL.test(err.message)) structural ??= err.message;
      push({ status: 'error', error: err.message, code: err.code });
    }
  }

  const oks = log.filter((l) => l.status === 'ok').length;
  const errors = log.filter((l) => l.status === 'error').length;
  const status = errors === 0 ? (oks ? 'succeeded' : 'skipped') : oks ? 'partial' : 'failed';
  await recordRunOutcome(db, automation.id, errors ? 'error' : 'ok');
  if (structural) await deactivateAutomation(db, automation.id, structural);
  return finish(status, {
    actionsLog: log,
    ...(status === 'skipped' ? { skipReason: 'nothing_to_do' } : {}),
    ...(errors ? { error: log.find((l) => l.error)?.error } : {}),
  });
};

/** Notes the services left during an action (a link the relation filter does not offer) join its warnings. */
const withNotes = (o: ActionOutcome, notes: { kind: string; column_key: string; names: string[] }[]): ActionOutcome =>
  o.status === 'ok' && notes.length
    ? {
        ...o,
        warnings: [
          ...(o.warnings ?? []),
          ...notes.map((n) => `relation_not_in_filter:${n.column_key}:${n.names.join(', ')}`),
        ],
      }
    : o;

type Label = { id: number; label: string; is_done?: boolean };

/** Every live subitem of the parent has one of the labels on `column` (04 §2 `all_subitems`). */
const allSubitemsMatch = async (db: Db, parent: Snapshot, column: string, labels: 'any' | string[]) => {
  const children = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.parentItemId, parent.row.id), isNull(items.deletedAt), isNull(items.archivedAt)));
  if (!children.length) return false;
  const subBoardId = (
    await db.select({ b: items.boardId }).from(items).where(eq(items.id, children[0]!.id)).limit(1)
  )[0]?.b;
  const col = subBoardId ? (await listColumns(db, subBoardId)).find((c) => c.key === column) : undefined;
  if (!col) return false;
  const all = (col.settings as { labels?: Label[] }).labels ?? [];
  const wanted = new Set(
    all.filter((l) => (labels === 'any' ? true : labels.some((x) => x.trim() === l.label.trim()))).map((l) => l.id),
  );
  const rows = await db
    .select({ itemId: cells.itemId, value: cells.value })
    .from(cells)
    .where(
      and(
        inArray(
          cells.itemId,
          children.map((c) => c.id),
        ),
        eq(cells.columnId, col.id),
      ),
    );
  const byItem = new Map(rows.map((r) => [r.itemId, (r.value as { index?: number }).index]));
  return children.every((c) => {
    const idx = byItem.get(c.id);
    return idx !== undefined && wanted.has(idx);
  });
};

/** Every item linked through the relation column is "done" (default: labels flagged done on its first status). */
const allConnectedDone = async (
  db: Db,
  a: Parameters<typeof loadSnapshot>[1],
  snap: Snapshot,
  t: Extract<Recipe['trigger'], { type: 'connected_items_all_done' }>,
) => {
  const ids = (snap.item.cells[t.column]?.value as { item_ids?: string[] } | null)?.item_ids ?? [];
  if (!ids.length) return false;
  for (const id of ids) {
    const linked = await loadSnapshot(db, a, id);
    if (!linked) return false;
    const status = t.done_column
      ? linked.columns.find((c) => c.key === t.done_column)
      : linked.columns.find((c) => c.type === 'status');
    if (!status) return false;
    const labels = (status.settings as { labels?: Label[] }).labels ?? [];
    const done = new Set(
      labels.filter((l) => (t.done_labels?.length ? t.done_labels.includes(l.label) : l.is_done)).map((l) => l.id),
    );
    const idx = (linked.item.cells[status.key]?.value as { index?: number } | null)?.index;
    if (idx === undefined || !done.has(idx)) return false;
  }
  return true;
};

/** Triggers that fire on a clock: a `run_agent` they start is a scheduled run (`trigger: schedule`). */
const SCHEDULED_TRIGGERS = new Set(['every_time_period', 'date_arrived', 'date_arrives_before']);

/** The context every action of a run (or a dry run) reads: templates, links, the trigger item and the actor. */
export const runContext = async (
  deps: AppDeps,
  p: {
    automation: AutomationRow;
    a: Actor;
    board: BoardRow;
    snap: Snapshot | null;
    row: ActivityRow | undefined;
    run: { id: string; depth: number; chain: string[] };
    env: AccountEnv;
  },
): Promise<RunCtx> => {
  const { db } = deps;
  const { automation, a, board, snap, row, run, env } = p;
  const [account, region] = await Promise.all([findAccountById(db, automation.accountId), actorRegion(db, a)]);
  const appUrl = await webOrigin(deps);
  const topBoardId = board.parentBoardId ?? board.id;
  const itemUrl = (boardId: string, itemId: string) =>
    `${appUrl}/a/${account?.slug ?? ''}/b/${boardId === board.id ? topBoardId : boardId}/i/${itemId}`;
  const origin = await originActor(db, row);
  const eventActorId = origin.id;
  const names = await memberNames(
    db,
    automation.accountId,
    [eventActorId, snap?.item.created_by].filter((x): x is string => !!x),
  );
  const groups = await listGroups(db, board.id);
  // D14: `{parent.*}` = the run item's parent; `{subitem.*}` = the subitem the event was about (a subitem trigger's
  // item, or the subitem that completed "all subitems").
  const parent = snap?.row.parentItemId ? await loadSnapshot(db, a, snap.row.parentItemId) : null;
  let subitem: Snapshot | null = snap?.board.parentBoardId ? snap : null;
  if (row?.itemId && row.itemId !== snap?.row.id) {
    const evItem = await loadSnapshot(db, a, row.itemId);
    if (evItem?.board.parentBoardId) subitem = evItem;
  }

  // A flow trigger's run: the flow it is about — `{flow.*}`, and where a notify opens.
  const flowMeta = row?.type.startsWith('flow.')
    ? ((row.payload.meta as { flow?: Record<string, unknown> } | undefined)?.flow ?? null)
    : null;
  const scope: RunScope = { automation_id: automation.id, run_id: run.id, depth: run.depth, chain: run.chain };
  const triggerType = (automation.recipe as { trigger?: { type?: string } } | null)?.trigger?.type;
  const ctx: RunCtx = {
    db,
    deps,
    a,
    scope,
    board,
    snap,
    created: null,
    parent,
    subitem,
    eventActorId,
    eventActorType: origin.type,
    eventAgentId: row ? eventAgentId(row) : null,
    scheduled: !!triggerType && SCHEDULED_TRIGGERS.has(triggerType),
    today: env.today,
    timezone: env.timezone,
    region,
    calendar: env.calendar,
    now: new Date(),
    itemUrl,
    flow: flowMeta,
    lookup: () => {
      // S-83: templates read only the columns the automation's owner may see (05 §6.1).
      const vars = (raw: Snapshot | null): ItemVars | undefined => {
        const s = raw ? ownerView(ctx, raw) : null;
        return s
          ? {
              item: s.item,
              columns: s.columns,
              // A subitem opens on its board's page (the sub-board has none of its own).
              url: itemUrl(s.board.parentBoardId ?? s.board.id, s.row.id),
              groupTitle: groups.find((g) => g.id === s.item.group_id)?.title,
            }
          : undefined;
      };
      const ev = row ? eventOf(row, false) : null;
      // A change in a column hidden from the owner has no previous / new value for them (S-83).
      const colRow = ev?.column_key
        ? (snap ? ownerView(ctx, snap) : null)?.columns.find((c) => c.key === ev.column_key)
        : undefined;
      const textOf = (v: unknown) => {
        const val = (v as { value?: unknown } | undefined)?.value;
        const def = colRow && columnTypes.get(colRow.type);
        if (!def || val === null || val === undefined) return '';
        try {
          return def.toText(
            val,
            { ...(def.defaultSettings as object), ...(colRow!.settings as object) },
            { userName: (id) => names.get(id), region },
          );
        } catch {
          return '';
        }
      };
      return buildLookup({
        item: vars(ctx.snap),
        parent: vars(ctx.parent ?? null),
        subitem: vars(ctx.subitem ?? null),
        created: vars(ctx.created),
        board: { id: board.id, name: board.name, url: `${appUrl}/a/${account?.slug ?? ''}/b/${topBoardId}` },
        actor: { id: eventActorId, name: (eventActorId && names.get(eventActorId)) || '', email: '' },
        creatorName: (id) => (id && names.get(id)) || '',
        previousValue: textOf(ev?.before),
        newValue: textOf(ev?.after),
        updateText: ev?.update_text,
        payload: (row?.payload.meta as { payload?: unknown } | undefined)?.payload,
        flow: flowMeta,
        today: env.today,
        now: ctx.now,
        automation: { title: automation.title },
        runId: run.id,
      });
    },
  };
  await loadViewAccess(ctx, snap, parent, subitem);
  return ctx;
};

/**
 * The person behind an event, for `@actor` and `{actor.*}`: the actor of a user / API event; for a row an
 * automation wrote, the first human in its chain (the run that started it, then its event) — it used to resolve to
 * the previous automation's owner (audit 2026-10-10, automations #6). No human in the chain: nobody (`null`), so
 * "notify @actor" skips instead of reaching the owner.
 */
const originActor = async (
  db: Db,
  row: Awaited<ReturnType<typeof findActivity>> | undefined,
): Promise<{ id: string | null; type: string | null }> => {
  if (!row) return { id: null, type: null };
  if (row.actorType === 'user' || row.actorType === 'api') return { id: row.actorId, type: row.actorType };
  // The run that wrote the row, then the runs it came from (the 0017 trigger stamps {run_id, chain}).
  const auto = (row.payload as { meta?: { automation?: AutomationMeta } } | null)?.meta?.automation;
  const runIds = [auto?.run_id, ...(auto?.chain ?? [])].filter((x): x is string => !!x);
  for (const runId of runIds) {
    const run = await findRunRow(db, runId);
    const ev = run?.eventId ? await findActivity(db, run.eventId) : undefined;
    if (ev && (ev.actorType === 'user' || ev.actorType === 'api')) return { id: ev.actorId, type: ev.actorType };
  }
  return { id: null, type: row.actorType ?? null };
};
