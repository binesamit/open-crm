// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  AppError,
  type ExtensionManifest,
  extensionKind,
  extensionManifestSchema,
  newId,
  normalizeRecipe,
  type PackData,
  rankBetween,
  REVIEW_CHECKS,
  recipeText,
  type RecipeIssue,
  validateRecipe,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Env } from '../../env';
import { automations, automationTemplates, columns, groups, templates } from '../../db/schema';
import { insertFolders, insertWorkspace } from '../accounts/accounts.repo';
import { listBuiltinTemplates } from '../boards/boards.repo';
import { rankBetweenOrAfter } from '../boards/boards.access';
import { folderSiblings, newFolderPosition } from '../docs/docs.service';
import {
  type InstantiateResult,
  instantiateTemplate,
  resolveBoardRefs,
  type TemplateSnapshot,
  templateSnapshotSchema,
} from '../boards/templates';
import { recordEvent } from '../activity/activity.repo';
import {
  findCatalogEntry,
  findCatalogEntryAny,
  type InstallationRow,
  listCatalog,
  upsertCatalogExtension,
} from './extensions.repo';
import { parseManifest } from './manifest-source';
import { installKitDashboards, installKitDocs } from './kit-content';
import { rememberSampleItems } from '../onboarding/onboarding.repo';

/**
 * Data packs (D27 ת1): an extension with no code — board templates, a starter kit (workspace + folders + boards),
 * automation recipes and agent templates — loaded with the services' own building blocks. Installing is
 * idempotent: what a pack created is remembered on its installation (`state`), so installing again (or after an
 * uninstall) never adds a second workspace, board, template or automation.
 */
export type PackState = {
  /** template key → the account template row it became. */
  templates?: Record<string, string>;
  kit?: {
    workspace_id: string;
    folder_ids: string[];
    boards: Record<string, string>;
    /** Phase B: the kit's dashboards and docs, and the sample rows its templates brought. */
    dashboard_ids?: string[];
    doc_ids?: string[];
    sample_item_ids?: string[];
  };
  /** recipe key → automation id. */
  recipes?: Record<string, string>;
  /** automation template key → the account's automation template it became. */
  automation_templates?: Record<string, string>;
  /** What could not be loaded (a recipe whose board is missing, an invalid template …), for the admin. */
  issues?: string[];
};

// ---- the platform catalog (seed/packs) ----

/** seed/packs from the working dir (api or repo root) or from this file. */
export const packsDir = () => {
  const candidates = [
    process.env.PACKS_DIR,
    resolve(process.cwd(), '../../seed/packs'),
    resolve(process.cwd(), 'seed/packs'),
    fileURLToPath(new URL('../../../../../seed/packs', import.meta.url)),
  ].filter((x): x is string => !!x);
  return candidates.find((d) => existsSync(d)) ?? null;
};

/**
 * Round 13: the catalogue's first-party sample extensions (seed/packs/sample-*.json — a board view and a dashboard
 * widget, code from extensions/catalog) are served from their own origin, which differs per environment: the files
 * say `{{SAMPLE_EXTENSIONS_ORIGIN}}`, filled in from that env var at seed time. Without it (tests, a deploy that
 * does not host them) they are left out. Never the app's own origin (`assertOriginsAllowed` — an extension on our
 * origin would get our cookies and DOM); in production https and public only.
 */
export const SAMPLE_ORIGIN_TOKEN = '{{SAMPLE_EXTENSIONS_ORIGIN}}';

export type PackSeedOptions = {
  /** Where the sample extensions are served from (default: env SAMPLE_EXTENSIONS_ORIGIN). */
  sampleOrigin?: string | null;
  /** The app's origin / environment the samples are checked against (default: env WEB_ORIGIN / NODE_ENV). */
  env?: Pick<Env, 'NODE_ENV' | 'WEB_ORIGIN'>;
};

const seedEnv = (o: PackSeedOptions): Pick<Env, 'NODE_ENV' | 'WEB_ORIGIN'> =>
  o.env ?? {
    NODE_ENV: (process.env.NODE_ENV ?? 'development') as Env['NODE_ENV'],
    WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  };

export const loadPacksFromDisk = (dir: string, o: PackSeedOptions = {}): ExtensionManifest[] => {
  const origin = o.sampleOrigin === undefined ? (process.env.SAMPLE_EXTENSIONS_ORIGIN ?? null) : o.sampleOrigin;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      let raw = readFileSync(join(dir, f), 'utf8');
      if (raw.includes(SAMPLE_ORIGIN_TOKEN)) {
        if (!origin) return [];
        raw = raw.replaceAll(SAMPLE_ORIGIN_TOKEN, origin.replace(/\/+$/, ''));
        try {
          return [parseManifest(seedEnv(o), JSON.parse(raw))];
        } catch (err) {
          console.warn(`seed/packs/${f}: skipped (${err instanceof Error ? err.message : String(err)})`);
          return [];
        }
      }
      return [extensionManifestSchema.parse(JSON.parse(raw))];
    });
};

/**
 * The review a first-party sample is published with (a code extension enters the catalogue only with the §8 review —
 * these are reviewed with the repository's code: read-only scopes, no server, text-only rendering, CSP-pinned).
 */
const sampleReview = (m: ExtensionManifest) => ({
  checks: Object.fromEntries(REVIEW_CHECKS.map((k) => [k, true])),
  notes: `First-party sample (extensions/catalog in the repository), reviewed with the code: ${m.permissions.join(', ')}${
    m.permissions.some((p) => p.endsWith(':write'))
      ? ' (writes board content with the person’s own rights, "via app")'
      : ' (read-only)'
  }, no server, API data rendered as text, its own origin.`,
  privacy_url: null,
  reviewed_by: null,
  reviewed_at: new Date().toISOString(),
});

/**
 * `pnpm db:seed` (bootstrap): upsert the catalog packs by key, like the built-in templates — except what the
 * platform owner took over in the owner console (M11 stage 3): an entry they published, edited or saved (it has a
 * publisher), or one they removed, is never overwritten or brought back by a deploy.
 */
export const seedCatalogPacks = async (db: Db, dir: string | null = packsDir(), o: PackSeedOptions = {}) => {
  if (!dir) return 0;
  const list = loadPacksFromDisk(dir, o);
  for (const m of list) {
    const known = await findCatalogEntryAny(db, m.id);
    if (known && (known.publishedBy || known.deletedAt)) continue;
    const code = extensionKind(m) === 'code';
    await upsertCatalogExtension(db, {
      id: newId(),
      accountId: null,
      key: m.id,
      name: m.name,
      version: m.version,
      kind: extensionKind(m),
      manifest: m as unknown as Record<string, unknown>,
      ...(code ? { review: sampleReview(m), publishedAt: new Date() } : {}),
    });
  }
  return list.length;
};

/** Catalog packs with a starter kit (the owner console's "starter kit" picker). */
export const starterKits = async (db: Db) =>
  (await listCatalog(db)).flatMap((row) => {
    const m = extensionManifestSchema.safeParse(row.manifest);
    return m.success && m.data.data?.starter_kit ? [m.data] : [];
  });

/** `empty` → none; `default` → the catalog kit marked default (else none); else the catalog pack by key. */
export const resolveStarterKit = async (db: Db, key: string): Promise<ExtensionManifest | null> => {
  if (key === 'empty') return null;
  if (key === 'default') return (await starterKits(db)).find((m) => m.data?.starter_kit?.default) ?? null;
  const row = await findCatalogEntry(db, key);
  const m = row ? extensionManifestSchema.safeParse(row.manifest) : null;
  if (!m?.success || !m.data.data?.starter_kit) throw new AppError('invalid_value', 'unknown_starter_kit');
  return m.data;
};

// ---- installing a pack's data ----

type Ctx = { accountId: string; actorId: string | null; requestId?: string | null };

const parseTemplate = (raw: unknown, issues: string[]): TemplateSnapshot | null => {
  const parsed = templateSnapshotSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  issues.push(`template ${(raw as { key?: string })?.key ?? '?'}: invalid`);
  return null;
};

/** The pack's board templates → the account's templates (template picker). Restored when installed again. */
const installTemplates = async (tx: Db, c: Ctx, data: PackData, state: PackState, issues: string[]) => {
  const out: Record<string, string> = { ...state.templates };
  for (const raw of data.board_templates) {
    const snap = parseTemplate(raw, issues);
    if (!snap) continue;
    const known = out[snap.key];
    if (known) {
      await tx
        .update(templates)
        .set({ deletedAt: null, name: snap.name, description: snap.description ?? null, snapshot: snap as never })
        .where(and(eq(templates.id, known), eq(templates.accountId, c.accountId)));
      continue;
    }
    // A template of the same key the account made itself stays its own: the pack's is skipped.
    const taken = (
      await tx
        .select({ id: templates.id })
        .from(templates)
        .where(and(eq(templates.accountId, c.accountId), eq(templates.key, snap.key), isNull(templates.deletedAt)))
        .limit(1)
    )[0];
    if (taken) {
      issues.push(`template ${snap.key}: the account already has one with this key`);
      continue;
    }
    const id = newId();
    await tx.insert(templates).values({
      id,
      accountId: c.accountId,
      kind: 'board',
      key: snap.key,
      name: snap.name,
      description: snap.description ?? null,
      category: snap.folder ?? null,
      snapshot: snap as never,
      isBuiltin: false,
      createdBy: c.actorId,
    });
    out[snap.key] = id;
  }
  return out;
};

/**
 * A starter kit: the workspace (or the one given — a new account's first), its folders, and a board per template,
 * each into its folder (named, or the one whose name starts with the template's `folder` code), then cross-board
 * relations wired — exactly what the hard-coded kit did before (D12).
 */
export const installStarterKit = async (
  tx: Db,
  c: Ctx,
  data: PackData,
  opts: { workspaceId?: string; workspaceName: string; withItems?: boolean },
  issues: string[],
): Promise<NonNullable<PackState['kit']>> => {
  const kit = data.starter_kit!;
  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    workspaceId = newId();
    await insertWorkspace(tx, {
      id: workspaceId,
      accountId: c.accountId,
      // A kit without a workspace name (M11 stage 3: no name fixed in a kit) takes the pack's name here.
      name: kit.workspace_name ?? opts.workspaceName,
      kind: 'open',
      position: rankBetween(null, null),
      createdBy: c.actorId,
    });
  }
  // After the workspace's last folder, before its boards (one order for folders and boards).
  const ranks: string[] = [];
  let prev: string | null = kit.folders.length ? await newFolderPosition(tx, c.accountId, workspaceId!, null) : null;
  const next = (await folderSiblings(tx, c.accountId, workspaceId!, null)).find(
    (x) => prev !== null && x.position > prev,
  );
  for (const _ of kit.folders) {
    ranks.push(prev!);
    prev = rankBetweenOrAfter(prev, next?.position ?? null);
  }
  const folderRows = kit.folders.map((name, i) => ({
    id: newId(),
    accountId: c.accountId,
    workspaceId: workspaceId!,
    name,
    depth: 0,
    position: ranks[i]!,
    createdBy: c.actorId,
  }));
  await insertFolders(tx, folderRows);

  // Which templates: the listed ones (the pack's own first, then built-in), then every built-in one not excluded.
  const builtin = await listBuiltinTemplates(tx);
  const own = new Map(
    data.board_templates.flatMap((raw) => {
      const s = templateSnapshotSchema.safeParse(raw);
      return s.success ? [[s.data.key, s.data] as const] : [];
    }),
  );
  const picks: { snapshot: TemplateSnapshot; templateId: string | null; folder?: string }[] = [];
  for (const b of kit.boards) {
    const mine = own.get(b.template);
    const row = mine ? null : builtin.find((t) => t.key === b.template);
    const snapshot = mine ?? (row ? templateSnapshotSchema.parse(row.snapshot) : null);
    if (!snapshot) {
      issues.push(`kit board ${b.template}: no such template`);
      continue;
    }
    picks.push({ snapshot, templateId: row?.id ?? null, folder: b.folder });
  }
  if (kit.all_builtin_templates) {
    const except = new Set([...kit.all_builtin_templates.except, ...picks.map((p) => p.snapshot.key)]);
    for (const row of builtin.filter((t) => !except.has(t.key)))
      picks.push({ snapshot: templateSnapshotSchema.parse(row.snapshot), templateId: row.id });
  }

  const refs = new Map<string, string>();
  const pending: InstantiateResult['pendingRefs'] = [];
  const boards: Record<string, string> = {};
  const sample: string[] = [];
  for (const p of picks) {
    const folder = p.folder
      ? folderRows.find((f) => f.name === p.folder)
      : folderRows.find((f) => p.snapshot.folder && f.name.startsWith(p.snapshot.folder));
    const res = await instantiateTemplate(tx, {
      accountId: c.accountId,
      workspaceId,
      folderId: folder?.id ?? null,
      createdBy: c.actorId,
      snapshot: p.snapshot,
      templateId: p.templateId,
      withItems: opts.withItems,
    });
    sample.push(...res.itemIds);
    boards[p.snapshot.key] = res.boardId;
    refs.set(`@${p.snapshot.key}`, res.boardId);
    if (p.snapshot.existing_board_id != null) refs.set(String(p.snapshot.existing_board_id), res.boardId);
    pending.push(...res.pendingRefs);
  }
  await resolveBoardRefs(tx, refs, pending);
  const place = { workspaceId, folders: folderRows.map((f) => ({ id: f.id, name: f.name })), boards };
  const dashboardIds = await installKitDashboards(tx, c, kit, place, issues);
  const docIds = await installKitDocs(tx, c, kit, place, issues);
  if (sample.length) await rememberSampleItems(tx, c.accountId, sample);
  return {
    workspace_id: workspaceId,
    folder_ids: folderRows.map((f) => f.id),
    boards,
    dashboard_ids: dashboardIds,
    doc_ids: docIds,
    sample_item_ids: sample,
  };
};

/**
 * Automation recipes onto the kit's boards — **inactive** (D21: an admin tests and switches each on), owned by the
 * admin who installed the pack. A recipe the board cannot satisfy is still loaded, with the issues in its note.
 */
export const installRecipes = async (tx: Db, c: Ctx, data: PackData, state: PackState, issues: string[]) => {
  const out: Record<string, string> = { ...state.recipes };
  const boardsByKey = state.kit?.boards ?? {};
  for (const r of data.automation_recipes) {
    if (out[r.key]) continue;
    const boardId = boardsByKey[r.board];
    if (!boardId) {
      issues.push(`recipe ${r.key}: no kit board ${r.board}`);
      continue;
    }
    if (!c.actorId) {
      issues.push(`recipe ${r.key}: no admin to own it`);
      continue;
    }
    const [cols, grps] = await Promise.all([
      tx
        .select()
        .from(columns)
        .where(and(eq(columns.boardId, boardId), isNull(columns.deletedAt))),
      tx
        .select()
        .from(groups)
        .where(and(eq(groups.boardId, boardId), isNull(groups.deletedAt))),
    ]);
    const normalized = normalizeRecipe(r.recipe, {
      columns: cols.map((x) => ({ key: x.key, title: x.title, type: x.type })),
      resolveBoard: (ref) => (ref.startsWith('@') ? (boardsByKey[ref.slice(1)] ?? null) : null),
    });
    if (!normalized.ok) {
      issues.push(`recipe ${r.key}: ${normalized.error}`);
      continue;
    }
    const { errors } = validateRecipe(normalized.recipe, {
      columns: cols.map((x) => ({
        key: x.key,
        type: x.type,
        title: x.title,
        settings: x.settings as Record<string, unknown>,
      })),
      groups: grps.map((g) => ({ id: g.id, title: g.title })),
    });
    const problems = errors.map((e: RecipeIssue) => `${e.code} ${e.path}`);
    const id = newId();
    await tx.insert(automations).values({
      id,
      accountId: c.accountId,
      boardId,
      title: (
        r.title ??
        recipeText(normalized.recipe, {
          columns: cols.map((x) => ({ key: x.key, title: x.title, type: x.type })),
          groups: grps.map((g) => ({ id: g.id, title: g.title })),
        })
      ).slice(0, 255),
      recipe: normalized.recipe as never,
      isActive: false,
      ownerId: c.actorId,
      createdBy: c.actorId,
      note: problems.length ? `pack: ${problems.join('; ')}` : null,
      deactivatedReason: problems.length ? 'needs_fixing' : null,
    });
    await recordEvent(tx, {
      accountId: c.accountId,
      type: 'automation.created',
      actorId: c.actorId,
      boardId,
      requestId: c.requestId ?? null,
      after: { id, title: r.title ?? null, via: 'extension' },
    });
    out[r.key] = id;
  }
  return out;
};

/** The pack's automation templates → the account's template library (restored, never doubled, when installed again). */
const installAutomationTemplates = async (tx: Db, c: Ctx, data: PackData, state: PackState) => {
  const out: Record<string, string> = { ...state.automation_templates };
  for (const t of data.automation_templates) {
    const values = {
      name: t.name,
      description: t.description ?? null,
      category: t.category ?? null,
      recipe: t.recipe,
      slots: t.slots,
      packKey: t.key,
    };
    const known = out[t.key];
    if (known) {
      await tx
        .update(automationTemplates)
        .set({ ...values, deletedAt: null, updatedAt: new Date() })
        .where(and(eq(automationTemplates.id, known), eq(automationTemplates.accountId, c.accountId)));
      continue;
    }
    const id = newId();
    await tx.insert(automationTemplates).values({ id, accountId: c.accountId, createdBy: c.actorId, ...values });
    out[t.key] = id;
  }
  return out;
};

/**
 * Installs (or re-installs) a pack's data into an account. Returns the new installation state. Idempotent: the
 * kit is made once, templates are restored rather than duplicated, a recipe is loaded once.
 */
export const installPackData = async (
  tx: Db,
  c: Ctx,
  manifest: ExtensionManifest,
  previous: PackState,
  opts: { workspaceId?: string; withItems?: boolean } = {},
): Promise<PackState> => {
  const data = manifest.data;
  if (!data) return previous;
  const issues: string[] = [];
  const state: PackState = { ...previous };
  state.templates = await installTemplates(tx, c, data, state, issues);
  if (data.starter_kit && !state.kit)
    state.kit = await installStarterKit(tx, c, data, { ...opts, workspaceName: manifest.name }, issues);
  state.recipes = await installRecipes(tx, c, data, state, issues);
  if (data.automation_templates.length)
    state.automation_templates = await installAutomationTemplates(tx, c, data, state);
  state.issues = issues;
  return state;
};

/** Uninstall: the pack's templates leave the picker (boards, automations and agents made from it stay — they are the account's). */
export const removePackTemplates = async (tx: Db, accountId: string, state: PackState) => {
  const autoIds = Object.values(state.automation_templates ?? {});
  if (autoIds.length)
    await tx
      .update(automationTemplates)
      .set({ deletedAt: new Date() })
      .where(and(eq(automationTemplates.accountId, accountId), inArray(automationTemplates.id, autoIds)));
  const ids = Object.values(state.templates ?? {});
  if (!ids.length) return;
  await tx
    .update(templates)
    .set({ deletedAt: new Date() })
    .where(and(eq(templates.accountId, accountId), inArray(templates.id, ids)));
};

export const packStateOf = (row: Pick<InstallationRow, 'state'>): PackState => (row.state ?? {}) as PackState;

/** A pack's data in numbers (the consent screen and the installed list). */
export const packSummary = (m: ExtensionManifest) =>
  m.data
    ? {
        board_templates: m.data.board_templates.length,
        starter_kit: m.data.starter_kit
          ? {
              workspace_name: m.data.starter_kit.workspace_name ?? m.name,
              folders: m.data.starter_kit.folders.length,
              boards: m.data.starter_kit.boards.length,
              all_builtin: !!m.data.starter_kit.all_builtin_templates,
            }
          : null,
        automation_recipes: m.data.automation_recipes.length,
        agent_templates: m.data.agent_templates.length,
        automation_templates: m.data.automation_templates.length,
      }
    : null;
