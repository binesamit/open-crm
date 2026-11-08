// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type createStarterKitSchema,
  type ExtensionManifest,
  extensionManifestSchema,
  kitGallerySchema,
  newId,
  type StarterKitDetail,
  type updateStarterKitSchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import { findAccountById, findMembership } from '../accounts/accounts.repo';
import { readableBoardIds } from '../boards/boards.access';
import { boardsByIds, listAccountBoards, listBuiltinTemplates, listWorkspaces } from '../boards/boards.repo';
import { exportPack } from '../extensions/pack-export';
import {
  findCatalogEntry,
  findCatalogEntryAny,
  insertExtension,
  installCountsByKey,
  listCatalog,
  updateExtensionRow,
} from '../extensions/extensions.repo';
import { foldersByIds, findKitVersion, insertKitVersion, listKitVersions } from './starter-kits.repo';
import { findDashboard, listDashboardsInWorkspace, listWidgets } from '../dashboards/dashboards.repo';
import { findDoc, listDocsInWorkspace, loadDocContent } from '../docs/docs.repo';

/**
 * Starter kits as data (M11 stage 3): the platform owner defines the kits a new account
 * opens with, in the owner console — no code, no file. A kit is a data pack of the platform catalog (D27 ת1) with
 * a `starter_kit` (first workspace name, folders, boards from templates, automations). The owner saves one from
 * boards of an account they are an admin of (never bypassing an account: their own membership reads the boards),
 * edits it, previews it, removes it; every save is a new version and the earlier ones are kept to restore.
 */
type KitManifest = ExtensionManifest & { data: NonNullable<ExtensionManifest['data']> };

const parseKit = (manifest: unknown): KitManifest | null => {
  const m = extensionManifestSchema.safeParse(manifest);
  return m.success && m.data.data?.starter_kit ? (m.data as KitManifest) : null;
};

const loadKit = async (db: Db, key: string) => {
  const row = await findCatalogEntry(db, key);
  const kit = row ? parseKit(row.manifest) : null;
  if (!row || !kit) throw new AppError('not_found', 'Starter kit not found');
  return { row, kit };
};

/** 1.4.2 → 1.5.0: every save of a kit is a new minor version. */
export const nextKitVersion = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : '1.0.0';
};

/**
 * Writes a kit into the catalog as a new version (the owner is its publisher from now on, so a deploy's seeding
 * never overwrites it) and keeps that version. A kit seeded from a file gets its seeded version kept first, so the
 * owner's first edit can be undone.
 */
const saveKit = async (
  db: Db,
  owner: SessionUser,
  manifest: KitManifest,
  note: string,
  existing?: { id: string; manifest: unknown; version: string },
) => {
  const m = extensionManifestSchema.parse(manifest) as KitManifest;
  const now = new Date();
  await db.transaction(async (tx) => {
    if (existing && !(await listKitVersions(tx, m.id)).length)
      await insertKitVersion(tx, {
        id: newId(),
        key: m.id,
        version: existing.version,
        manifest: existing.manifest as Record<string, unknown>,
        note: 'seeded',
        createdBy: null,
      });
    const fields = {
      name: m.name,
      version: m.version,
      kind: 'data',
      manifest: m as unknown as Record<string, unknown>,
      sourceUrl: null,
      publishedBy: owner.id,
      publishedAt: now,
    };
    if (existing) await updateExtensionRow(tx, existing.id, fields);
    else await insertExtension(tx, { id: newId(), accountId: null, key: m.id, createdBy: owner.id, ...fields });
    await insertKitVersion(tx, {
      id: newId(),
      key: m.id,
      version: m.version,
      manifest: m as unknown as Record<string, unknown>,
      note,
      createdBy: owner.id,
    });
  });
};

/** One default kit at a time: the others lose the flag (each a new version, noted). */
const clearOtherDefaults = async (db: Db, owner: SessionUser, key: string) => {
  for (const row of await listCatalog(db)) {
    const kit = parseKit(row.manifest);
    if (!kit || row.key === key || !kit.data.starter_kit?.default) continue;
    const next: KitManifest = {
      ...kit,
      version: nextKitVersion(kit.version),
      data: { ...kit.data, starter_kit: { ...kit.data.starter_kit, default: false } },
    };
    await saveKit(db, owner, next, 'default_moved', row);
  }
};

// ---- read ----
/** GET /platform/starter-kits/{key} — what a new account would get, and the kit's versions. */
export const kitDetail = async (db: Db, key: string): Promise<StarterKitDetail> => {
  const { row, kit } = await loadKit(db, key);
  const sk = kit.data.starter_kit!;
  const own = new Map(
    kit.data.board_templates.map((t) => [String(t.key), { name: String(t.name), folder: null as string | null }]),
  );
  const builtin = await listBuiltinTemplates(db);
  const builtinByKey = new Map(builtin.map((t) => [t.key, t]));
  const folderOfCode = (code: unknown) =>
    typeof code === 'string' && code ? (sk.folders.find((f) => f.startsWith(code)) ?? null) : null;
  const boards: StarterKitDetail['boards'] = sk.boards.map((b) => {
    const mine = own.get(b.template);
    const bi = mine ? undefined : builtinByKey.get(b.template);
    return {
      template: b.template,
      name: mine?.name ?? bi?.name ?? null,
      folder: b.folder ?? (bi ? folderOfCode((bi.snapshot as { folder?: unknown }).folder) : null),
      source: mine ? 'kit' : bi ? 'builtin' : 'missing',
      listed: true,
    };
  });
  if (sk.all_builtin_templates) {
    const skip = new Set([...sk.all_builtin_templates.except, ...sk.boards.map((b) => b.template)]);
    for (const t of builtin.filter((x) => !skip.has(x.key)))
      boards.push({
        template: t.key,
        name: t.name,
        folder: folderOfCode((t.snapshot as { folder?: unknown }).folder),
        source: 'builtin',
        listed: false,
      });
  }
  const versions = await listKitVersions(db, key);
  return {
    key: kit.id,
    name: kit.name,
    name_en: kit.name_en ?? null,
    description: kit.description ?? null,
    description_en: kit.description_en ?? null,
    icon: kit.icon ?? null,
    version: kit.version,
    default: !!sk.default,
    workspace_name: sk.workspace_name ?? null,
    gallery: kitGallerySchema.parse(sk.gallery ?? {}),
    folders: sk.folders,
    boards,
    all_builtin_templates: sk.all_builtin_templates ? { except: sk.all_builtin_templates.except } : null,
    templates: [...own].map(([k, v]) => ({ key: k, name: v.name })),
    automation_recipes: kit.data.automation_recipes.length,
    dashboards: sk.dashboards.map((d) => d.name),
    docs: sk.docs.map((d) => d.name),
    automation_templates: kit.data.automation_templates.length,
    installs: (await installCountsByKey(db)).get(key) ?? 0,
    updated_at: row.updatedAt.toISOString(),
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      note: v.note,
      created_at: v.createdAt.toISOString(),
      created_by: v.createdBy || v.createdByEmail || null,
    })),
  };
};

// ---- "save as starter kit" from an account's boards ----
/**
 * The owner acts in that account as its member — an active admin there (like "save as pack" for an account admin):
 * the console never reads an account's boards past its own permissions (D12: the platform owner bypasses nothing).
 */
const ownerInAccount = async (db: Db, owner: SessionUser, accountId: string): Promise<AccountContext> => {
  const [account, membership] = await Promise.all([
    findAccountById(db, accountId),
    findMembership(db, accountId, owner.id),
  ]);
  if (!account || account.deletedAt) throw new AppError('not_found', 'Account not found');
  if (membership?.status !== 'active' || membership.role !== 'admin')
    throw new AppError('forbidden', 'kit_needs_account_admin');
  return { account, accountId, role: 'admin', membershipId: membership.id, boardLimit: null };
};

/** GET /platform/accounts/{id}/kit-boards — the boards of that account I may take into a kit. */
export const kitSourceBoards = async (db: Db, owner: SessionUser, accountId: string) => {
  const ctx = await ownerInAccount(db, owner, accountId);
  const all = (await listAccountBoards(db, accountId)).filter((b) => !b.parentBoardId);
  const readable = await readableBoardIds(
    db,
    ctx,
    owner,
    all.map((b) => b.id),
  );
  const rows = await boardsByIds(db, accountId, [...readable]);
  const [workspaces, folders] = await Promise.all([
    listWorkspaces(db, accountId),
    foldersByIds(db, accountId, [...new Set(rows.flatMap((b) => (b.folderId ? [b.folderId] : [])))]),
  ]);
  const ws = new Map(workspaces.map((w) => [w.id, w.name]));
  const fs = new Map(folders.map((f) => [f.id, f.name]));
  return {
    data: all
      .filter((b) => readable.has(b.id))
      .map((b) => {
        const full = rows.find((r) => r.id === b.id);
        return {
          id: b.id,
          name: b.name,
          workspace: ws.get(b.workspaceId) ?? '',
          folder: full?.folderId ? (fs.get(full.folderId) ?? null) : null,
        };
      }),
    // Phase B: the account's dashboards and docs (its admin sees them all).
    dashboards: (
      await Promise.all(
        workspaces.map(async (w) =>
          (await listDashboardsInWorkspace(db, accountId, w.id)).map((d) => ({
            id: d.id,
            name: d.name,
            workspace: w.name,
          })),
        ),
      )
    ).flat(),
    docs: (
      await Promise.all(
        workspaces.map(async (w) =>
          (await listDocsInWorkspace(db, accountId, w.id)).map((d) => ({ id: d.id, name: d.name, workspace: w.name })),
        ),
      )
    ).flat(),
  };
};

/**
 * Phase B: dashboards and docs of the same account for the kit — a dashboard's boards and its widgets'
 * boards become the kit's template refs (`@<key>`, the keys "save as pack" gives the boards: `<key>_<n>` in order);
 * boards not in the kit drop out. A doc keeps its content (no comments, no people).
 */
const kitContentFrom = async (
  db: Db,
  accountId: string,
  input: { key: string; board_ids: string[]; dashboard_ids: string[]; doc_ids: string[] },
) => {
  const ids = [...new Set(input.board_ids)];
  const prefix = input.key.replace(/-/g, '_').slice(0, 30);
  const keyOf = new Map(ids.map((id, i) => [id, `${prefix}_${i + 1}`]));
  const ref = (id: unknown) => (typeof id === 'string' && keyOf.has(id) ? `@${keyOf.get(id)}` : null);
  const dashboards = [];
  for (const id of input.dashboard_ids) {
    const d = await findDashboard(db, accountId, id);
    if (!d || d.deletedAt) throw new AppError('not_found', 'Dashboard not found');
    const sources = ((d.settings as { board_ids?: string[] }).board_ids ?? []).flatMap((b) =>
      keyOf.has(b) ? [keyOf.get(b)!] : [],
    );
    const widgets = (await listWidgets(db, d.id)).map((w) => {
      const s = { ...(w.settings as Record<string, unknown>) };
      if (Array.isArray(s.board_ids)) s.board_ids = s.board_ids.flatMap((b) => (ref(b) ? [ref(b)!] : []));
      if ('board_id' in s) s.board_id = ref(s.board_id);
      if ('view_id' in s) s.view_id = null;
      return { type: w.type, title: w.title, settings: s };
    });
    dashboards.push({ name: d.name, boards: sources, widgets });
  }
  const docs = [];
  for (const id of input.doc_ids) {
    const meta = await findDoc(db, accountId, id);
    const row = meta ? await loadDocContent(db, accountId, id) : undefined;
    if (!meta || !row) throw new AppError('not_found', 'Doc not found');
    docs.push({ name: meta.name, content: (row.content ?? { type: 'doc', content: [] }) as Record<string, unknown> });
  }
  return { dashboards, docs };
};

/** POST /platform/starter-kits — boards of an account (as templates) + their folders (+ automations) → a kit. */
export const createKitFromBoards = async (
  db: Db,
  owner: SessionUser,
  input: z.infer<typeof createStarterKitSchema>,
) => {
  if (await findCatalogEntry(db, input.key)) throw new AppError('conflict', 'kit_key_taken');
  const ctx = await ownerInAccount(db, owner, input.account_id);
  const pack = await exportPack(
    db,
    { ctx, user: owner },
    { key: input.key, name: input.name, board_ids: input.board_ids, include_automations: input.include_automations },
  );
  const data = pack.data!;
  let folders: string[] = [];
  let boards = data.starter_kit!.boards;
  if (input.keep_folders) {
    // Each board into a folder named like its folder there, the folders in that account's order.
    const rows = await boardsByIds(db, ctx.accountId, [...new Set(input.board_ids)]);
    const folderRows = await foldersByIds(db, ctx.accountId, [
      ...new Set(rows.flatMap((b) => (b.folderId ? [b.folderId] : []))),
    ]);
    const nameOf = new Map(folderRows.map((f) => [f.id, f.name]));
    folders = [...new Set(folderRows.map((f) => f.name))];
    const ids = [...new Set(input.board_ids)];
    boards = boards.map((b, i) => {
      const folderId = rows.find((r) => r.id === ids[i])?.folderId;
      const folder = folderId ? nameOf.get(folderId) : undefined;
      return folder ? { ...b, folder } : { template: b.template };
    });
  }
  const previous = await findCatalogEntryAny(db, input.key);
  const kit: KitManifest = {
    ...pack,
    ...(input.name_en ? { name_en: input.name_en } : {}),
    ...(input.description ? { description: input.description } : {}),
    // A kit removed earlier under the same key: the new one continues its version numbers.
    version: previous ? nextKitVersion(previous.version) : '1.0.0',
    data: {
      ...data,
      starter_kit: {
        default: input.default,
        ...(input.workspace_name ? { workspace_name: input.workspace_name } : {}),
        folders,
        boards,
        ...(await kitContentFrom(db, ctx.accountId, input)),
      },
    },
  };
  await saveKit(db, owner, kit, 'from_boards');
  if (input.default) await clearOtherDefaults(db, owner, input.key);
  return kitDetail(db, input.key);
};

// ---- edit / remove / versions ----
const withoutNulls = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;

/** PATCH /platform/starter-kits/{key} — any field; a new version. */
export const updateKit = async (
  db: Db,
  owner: SessionUser,
  key: string,
  input: z.infer<typeof updateStarterKitSchema>,
) => {
  const { row, kit } = await loadKit(db, key);
  const sk = kit.data.starter_kit!;
  const folders = input.folders ?? sk.folders;
  const boards =
    input.boards?.map((b) => (b.folder ? { template: b.template, folder: b.folder } : { template: b.template })) ??
    sk.boards;
  // Every board names a template the kit has (its own or a built-in one), in a folder the kit makes.
  const builtin = new Set((await listBuiltinTemplates(db)).map((t) => t.key));
  const own = new Set(kit.data.board_templates.map((t) => String(t.key)));
  for (const b of boards) {
    if (!own.has(b.template) && !builtin.has(b.template))
      throw new AppError('invalid_value', 'unknown_template', { template: b.template });
    if (b.folder && !folders.includes(b.folder))
      throw new AppError('invalid_value', 'unknown_folder', { folder: b.folder });
  }
  const allBuiltin =
    input.all_builtin_templates === undefined ? sk.all_builtin_templates : (input.all_builtin_templates ?? undefined);
  const next = withoutNulls({
    ...kit,
    name: input.name ?? kit.name,
    name_en: input.name_en === undefined ? kit.name_en : input.name_en,
    description: input.description === undefined ? kit.description : input.description,
    description_en: input.description_en === undefined ? kit.description_en : input.description_en,
    icon: input.icon === undefined ? kit.icon : input.icon,
    version: nextKitVersion(kit.version),
    data: {
      ...kit.data,
      starter_kit: withoutNulls({
        default: input.default ?? sk.default,
        workspace_name: input.workspace_name === undefined ? sk.workspace_name : input.workspace_name,
        folders,
        boards,
        all_builtin_templates: allBuiltin,
        // The start screen's card: the fields sent, over what it had.
        gallery: input.gallery ? kitGallerySchema.parse({ ...sk.gallery, ...input.gallery }) : sk.gallery,
        // Phase B: its dashboards and docs stay as they were.
        dashboards: sk.dashboards,
        docs: sk.docs,
      }),
    },
  }) as KitManifest;
  await saveKit(db, owner, next, 'edited', row);
  if (input.default) await clearOtherDefaults(db, owner, key);
  return kitDetail(db, key);
};

/**
 * DELETE /platform/starter-kits/{key} — out of the catalog: no new account opens with it, a deploy does not bring
 * it back; accounts that opened with it keep everything it made. Its versions stay (a kit saved again under the
 * same key continues them).
 */
export const deleteKit = async (db: Db, key: string) => {
  const { row } = await loadKit(db, key);
  await updateExtensionRow(db, row.id, { deletedAt: new Date() });
  return { ok: true as const };
};

/** POST /platform/starter-kits/{key}/versions/{versionId}/restore — that version's content as a new version. */
export const restoreKitVersion = async (db: Db, owner: SessionUser, key: string, versionId: string) => {
  const { row, kit } = await loadKit(db, key);
  const v = await findKitVersion(db, key, versionId);
  const old = v ? parseKit(v.manifest) : null;
  if (!v || !old) throw new AppError('not_found', 'Version not found');
  await saveKit(db, owner, { ...old, id: key, version: nextKitVersion(kit.version) }, 'restored', row);
  if (old.data.starter_kit?.default) await clearOtherDefaults(db, owner, key);
  return kitDetail(db, key);
};
