// SPDX-License-Identifier: AGPL-3.0-only
import { effectiveDepthMax } from '@bines/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountDefaultsOf,
  columnTypes,
  parseCellValue,
  groupColorOf,
  GROUP_PALETTE,
  withLabelColorKeys,
  IMPORTED_COLUMN_KEY_RE,
  initialRanks,
  newId,
  rankBetween,
  remapChoiceSettings,
  templateViewSchema,
  templateViewSettings,
  withNewColumnDefaults,
  type AnyColumnTypeDef,
} from '@bines/shared';
import { z } from 'zod';
import type { Db } from '../../db/client';
import type { columns as columnsTable } from '../../db/schema';
import {
  findColumnById,
  insertBoard,
  insertBoardMember,
  insertColumns,
  insertGroups,
  insertItemKey,
  listColumns,
  listGroups,
  listTemplateMirrorColumnsMissingSource,
  prefixTaken,
  updateColumnRow,
  upsertBuiltinTemplate,
} from './boards.repo';
import { lastEntityPosition } from '../docs/docs.service';
import { insertItem, upsertCell } from '../items/items.repo';
import { insertView } from '../views/views.repo';
import { accountLocale, st } from '../../lib/i18n';
import { getAccountSettings } from '../accounts/accounts.repo';
import { LEGACY_PERMISSION_SETS, LEGACY_SUBITEMS_TYPE, legacyColumnSettings, legacyDepthMax } from './template-legacy';

/** Shape of seed/templates/*.json (seed/templates/README.md). */
const templateColumn = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  description: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Native templates (saved from a board) keep the column width. */
  width: z.number().int().optional(),
});
export const templateSnapshotSchema = z.object({
  /**
   * Saved from one of our boards (07 §4.3): its columns keep their settings as they were. Otherwise (a built-in
   * template, a pack's) its columns are new ones: the account's defaults for new columns fill what they leave out.
   */
  native: z.boolean().default(false),
  /**
   * 2 = column settings in today's shape (seed/templates/README.md). A snapshot without it (format 1: an account's
   * copy of an older built-in template, an older pack) is read through `template-legacy`.
   */
  format_version: z.number().int().min(1).default(1),
  /** The board's item depth (1 = no subitems). */
  hierarchy_depth_max: z.number().int().min(1).max(6).optional(),
  /** Native: the sub-board's columns (D14). */
  subitem_columns: z.array(templateColumn).default([]),
  key: z.string(),
  existing_board_id: z.union([z.string(), z.number()]).nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  board_kind: z.enum(['public', 'share', 'private']).default('public'),
  folder: z.string().nullable().optional(),
  hierarchy_type: z.enum(['classic', 'multi_level']).default('classic'),
  item_terminology: z.string().default('item'),
  groups: z.array(z.object({ id: z.string(), title: z.string(), color: z.string() })).default([]),
  columns: z.array(templateColumn).default([]),
  add_columns: z.array(templateColumn).default([]),
  /** Native "with items": cell values by column key; `group_id` = a group of `groups`. */
  items: z
    .array(
      z.object({
        group_id: z.string(),
        name: z.string(),
        cells: z.record(z.string(), z.unknown()).default({}),
        subitems: z
          .array(z.object({ name: z.string(), cells: z.record(z.string(), z.unknown()).default({}) }))
          .default([]),
      }),
    )
    .default([]),
  permissions: z
    .object({
      // Format 1 names (view_and_comment, only_edit_content …) map onto today's.
      set: z
        .preprocess(
          (v) => LEGACY_PERMISSION_SETS[String(v)] ?? v,
          z.enum(['edit_everything', 'edit_content', 'edit_assigned', 'view_comment']),
        )
        .default('edit_everything'),
      restrict_column_editing: z.record(z.string(), z.array(z.string())).default({}),
      restrict_column_view: z.record(z.string(), z.array(z.string())).default({}),
    })
    .default({ set: 'edit_everything', restrict_column_editing: {}, restrict_column_view: {} }),
  /** Prod phase B: the board's views, made with it (a saved board's, a kit's, a seed template's). */
  views: z.array(templateViewSchema).max(30).default([]),
});
export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>;

export const loadTemplatesFromDisk = (dir: string): TemplateSnapshot[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => templateSnapshotSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
    .sort((a, b) => a.key.localeCompare(b.key));

/** `pnpm db:seed`: upsert the built-in templates (global, account_id NULL) by key. */
export const seedBuiltinTemplates = async (db: Db, dir: string) => {
  const list = loadTemplatesFromDisk(dir);
  for (const t of list) {
    await upsertBuiltinTemplate(db, {
      id: newId(),
      accountId: null,
      kind: 'board',
      key: t.key,
      name: t.name,
      description: t.description ?? null,
      category: t.folder ?? null,
      snapshot: t as unknown as Record<string, unknown>,
      isBuiltin: true,
    });
  }
  return list.length;
};

const KIND = { public: 'main', share: 'shareable', private: 'private' } as const;

const isLegacy = (t: TemplateSnapshot) => !t.native && t.format_version < 2;

/** A template column's settings as they are (valid ones, colours as keys), else the type's defaults. */
const keptSettings = (def: AnyColumnTypeDef, settings: Record<string, unknown>) =>
  (def.settingsSchema.safeParse(settings).success ? withLabelColorKeys(settings) : def.defaultSettings) as Record<
    string,
    unknown
  >;

/** A template column's settings in today's shape (a format 1 snapshot's converted). */
const snapshotColumnSettings = (t: TemplateSnapshot, def: AnyColumnTypeDef, settings: Record<string, unknown>) =>
  isLegacy(t) ? (legacyColumnSettings(def, settings) as Record<string, unknown>) : keptSettings(def, settings);

export type InstantiateResult = {
  boardId: string;
  skipped: { column: string; type: string }[];
  /** relation columns whose target boards are template refs (`@contacts`), resolved by the caller. */
  pendingRefs: { columnId: string; refs: string[] }[];
  /** The rows made from the template's items (sample data a kit can take away later). */
  itemIds: string[];
};

/**
 * Creates a board from a template snapshot inside the caller's transaction: groups, columns (types through the
 * registry; P1/unknown types skipped and reported), custom item keys, column edit/view restrictions.
 */
export const instantiateTemplate = async (
  tx: Db,
  p: {
    accountId: string;
    workspaceId: string;
    folderId: string | null;
    createdBy: string | null;
    snapshot: TemplateSnapshot;
    templateId?: string | null;
    name?: string;
    kind?: 'main' | 'shareable' | 'private';
    /** false = the template's rows are left out (a kit built "without sample data"). */
    withItems?: boolean;
  },
): Promise<InstantiateResult> => {
  const t = p.snapshot;
  const boardId = newId();
  const lang = await accountLocale(tx, p.accountId);
  const newDefaults = t.native ? undefined : accountDefaultsOf(await getAccountSettings(tx, p.accountId));
  const legacy = isLegacy(t);
  await insertBoard(tx, {
    id: boardId,
    accountId: p.accountId,
    workspaceId: p.workspaceId,
    folderId: p.folderId,
    name: p.name ?? t.name,
    description: t.description ?? null,
    kind: p.kind ?? KIND[t.board_kind],
    position: rankBetween(await lastEntityPosition(tx, p.workspaceId, p.folderId), null),
    itemTerminology: t.item_terminology,
    hierarchyDepthMax: t.native
      ? effectiveDepthMax(t.hierarchy_depth_max)
      : legacy
        ? legacyDepthMax(t)
        : (t.hierarchy_depth_max ?? 1),
    permissionSet: t.permissions.set,
    createdFromTemplateId: p.templateId ?? null,
    createdBy: p.createdBy,
  });
  if (p.createdBy) {
    await insertBoardMember(tx, {
      boardId,
      userId: p.createdBy,
      accountId: p.accountId,
      role: 'owner',
      addedBy: p.createdBy,
    });
  }

  const groupRanks = initialRanks(Math.max(t.groups.length, 1));
  const templateGroups = t.groups.length
    ? t.groups
    : [{ id: 'topics', title: st('server.newGroup', undefined, lang), color: GROUP_PALETTE[0] }];
  // The template's group id → the new group (a relation filter on the board's own groups follows them).
  const groupOf = new Map(templateGroups.map((g) => [g.id, newId()]));
  await insertGroups(
    tx,
    templateGroups.map((g, i) => ({
      id: groupOf.get(g.id)!,
      accountId: p.accountId,
      boardId,
      title: g.title,
      // A key (ours or a legacy one in an older native template) or a hex.
      color: groupColorOf(g.color),
      position: groupRanks[i]!,
      sourceGroupId: g.id,
      createdBy: p.createdBy,
    })),
  );

  const skipped: InstantiateResult['skipped'] = [];
  const pendingRefs: InstantiateResult['pendingRefs'] = [];
  // A native template with subitem columns brings its sub-board (D14); its id is known up front so that relation
  // columns of the template that link to the board itself (`@self` / `@self_sub`, see boardSnapshot) point at it.
  const subId = t.native && t.subitem_columns.length ? newId() : null;
  const selfRefs = new Map([['@self', boardId], ...(subId ? [['@self_sub', subId] as const] : [])]);
  const resolveSelf = (settings: Record<string, unknown>) =>
    resolveRelationRefs(
      settings,
      (ref) => selfRefs.get(ref),
      (g) => groupOf.get(g),
    );
  const all = [...t.columns, ...t.add_columns].filter((c) => !legacy || c.type !== LEGACY_SUBITEMS_TYPE);
  if (!all.some((c) => c.type === 'name')) all.unshift({ id: 'name', title: 'Name', type: 'name', settings: {} });
  const colRanks = initialRanks(all.length);
  const rows: (typeof columnsTable.$inferInsert)[] = [];
  const restrictedEdit = t.permissions.restrict_column_editing;
  const restrictedView = t.permissions.restrict_column_view;

  for (const [i, col] of all.entries()) {
    const def = columnTypes.get(col.type);
    if (!def || !IMPORTED_COLUMN_KEY_RE.test(col.id)) {
      skipped.push({ column: col.id, type: col.type });
      continue;
    }
    // A native template (a saved / duplicated board) keeps its columns' settings as they were; a built-in template's
    // columns are new ones — the account's defaults for new columns fill what the template leaves out.
    let settings = t.native
      ? keptSettings(def, col.settings)
      : withNewColumnDefaults(def, snapshotColumnSettings(t, def, col.settings), newDefaults);
    if (col.type === 'board_relation') settings = resolveSelf(settings);
    const id = newId();
    rows.push({
      id,
      accountId: p.accountId,
      boardId,
      key: col.id,
      type: col.type,
      title:
        !t.native && col.type === 'name' && col.title === 'Name' ? st('server.nameColumn', undefined, lang) : col.title,
      description: col.description ?? null,
      settings,
      position: colRanks[i]!,
      width: col.width ?? (col.type === 'name' ? 280 : col.type === 'long_text' ? 220 : 150),
      // '@owner' = owners only: an empty list, since owners bypass restrictions (05 §6.1).
      restrictedEdit: restrictedEdit[col.id] ? { users: [], teams: [] } : null,
      restrictedView: !restrictedEdit[col.id] && restrictedView[col.id] ? { users: [], teams: [] } : null,
      sourceColumnId: col.id,
      createdBy: p.createdBy,
    });
    const refs = (settings.board_refs as string[] | undefined) ?? [];
    if (col.type === 'board_relation' && refs.length) pendingRefs.push({ columnId: id, refs });

    if (col.type === 'item_id' && settings.display === 'custom_key' && typeof settings.prefix === 'string') {
      let prefix = settings.prefix;
      for (let n = 2; await prefixTaken(tx, p.accountId, prefix); n++)
        prefix = `${settings.prefix.replace(/-$/, '')}${n}-`;
      settings.prefix = prefix;
      await insertColumns(tx, [rows.pop()!]);
      await insertItemKey(tx, {
        id: newId(),
        accountId: p.accountId,
        boardId,
        columnId: id,
        prefix,
        padding: Number(settings.padding ?? 4),
      });
    }
  }
  await insertColumns(tx, rows);

  if (subId) {
    const sid = subId;
    await insertBoard(tx, {
      id: sid,
      accountId: p.accountId,
      workspaceId: p.workspaceId,
      folderId: null,
      parentBoardId: boardId,
      name: st('server.subitemsBoard', { board: p.name ?? t.name }, lang).slice(0, 255),
      kind: p.kind ?? KIND[t.board_kind],
      position: rankBetween(null, null),
      hierarchyDepthMax: effectiveDepthMax(t.hierarchy_depth_max),
      createdBy: p.createdBy,
    });
    const subRanks = initialRanks(t.subitem_columns.length);
    await insertColumns(
      tx,
      t.subitem_columns.flatMap((col, i) => {
        const def = columnTypes.get(col.type);
        if (!def) return [];
        const settings = keptSettings(def, col.settings);
        return [
          {
            id: newId(),
            accountId: p.accountId,
            boardId: sid,
            key: col.id,
            type: col.type,
            title: col.title,
            description: col.description ?? null,
            settings: col.type === 'board_relation' ? resolveSelf(settings) : settings,
            position: subRanks[i]!,
            width: col.width ?? 150,
            createdBy: p.createdBy,
          },
        ];
      }),
    );
  }
  const itemIds = t.items.length && p.withItems !== false ? await insertTemplateItems(tx, p, t, boardId, subId) : [];
  await insertTemplateViews(tx, p, t, boardId, new Set(rows.map((r) => r.key)), groupOf);
  return { boardId, skipped, pendingRefs, itemIds };
};

/** A cell value from a template, checked against the new column (an invalid one is left out). */
const templateCell = (column: { id: string; type: string; settings: unknown }, value: unknown) => {
  const def = columnTypes.get(column.type);
  if (!def || def.storage !== 'cell' || def.readOnly) return null;
  const parsed = parseCellValue(def, column.settings, value);
  return parsed.ok ? parsed : null;
};

/** The items of a "with items" template (07 §4.3), in their groups, with their values and subitems. */
/** The template's views on the new board (its columns as they were made; references to missing ones dropped). */
const insertTemplateViews = async (
  tx: Db,
  p: { accountId: string; createdBy: string | null },
  t: TemplateSnapshot,
  boardId: string,
  keys: Set<string>,
  groups: Map<string, string>,
) => {
  const made = t.views.flatMap((v) => {
    const settings = templateViewSettings(v, keys, groups);
    return settings ? [{ v, settings }] : [];
  });
  const ranks = initialRanks(made.length);
  for (const [i, { v, settings }] of made.entries())
    await insertView(tx, {
      id: newId(),
      accountId: p.accountId,
      boardId,
      type: v.type,
      name: v.name,
      settings: settings as Record<string, unknown>,
      position: ranks[i]!,
      createdBy: p.createdBy,
    });
};

const insertTemplateItems = async (
  tx: Db,
  p: { accountId: string; createdBy: string | null },
  t: TemplateSnapshot,
  boardId: string,
  subId: string | null,
): Promise<string[]> => {
  const made: string[] = [];
  const groupOf = new Map((await listGroups(tx, boardId)).map((g) => [g.sourceGroupId ?? '', g.id]));
  const firstGroup = (await listGroups(tx, boardId))[0]!.id;
  const byKey = new Map((await listColumns(tx, boardId)).map((c) => [c.key, c]));
  const subByKey = new Map((subId ? await listColumns(tx, subId) : []).map((c) => [c.key, c]));
  const ranks = initialRanks(t.items.length);
  const write = async (
    itemId: string,
    board: string,
    columns: Map<string, Awaited<ReturnType<typeof listColumns>>[number]>,
    cells: Record<string, unknown>,
  ) => {
    for (const [key, value] of Object.entries(cells)) {
      const column = columns.get(key);
      const parsed = column ? templateCell(column, value) : null;
      if (!column || !parsed) continue;
      await upsertCell(tx, {
        itemId,
        columnId: column.id,
        accountId: p.accountId,
        boardId: board,
        value: parsed.value as Record<string, unknown>,
        textValue: parsed.derived.textValue,
        numberValue: parsed.derived.numberValue,
        dateValue: parsed.derived.dateValue,
        dateEndValue: parsed.derived.dateEndValue,
        updatedBy: p.createdBy,
        updatedByType: 'user',
      });
    }
  };
  for (const [i, it] of t.items.entries()) {
    const id = newId();
    await insertItem(tx, {
      id,
      accountId: p.accountId,
      boardId,
      groupId: groupOf.get(it.group_id) ?? firstGroup,
      position: ranks[i]!,
      name: it.name,
      createdBy: p.createdBy,
      creatorType: 'user',
    });
    await write(id, boardId, byKey, it.cells);
    made.push(id);
    if (!subId) continue;
    const subRanks = initialRanks(it.subitems.length);
    for (const [j, sub] of it.subitems.entries()) {
      const childId = newId();
      await insertItem(tx, {
        id: childId,
        accountId: p.accountId,
        boardId: subId,
        groupId: null,
        parentItemId: id,
        rootItemId: id,
        depth: 1,
        position: subRanks[j]!,
        name: sub.name,
        createdBy: p.createdBy,
        creatorType: 'user',
      });
      await write(childId, subId, subByKey, sub.cells);
    }
  }
  return made;
};

/**
 * Points relation columns at the boards their refs name, once a whole kit is instantiated together:
 * `@contacts` → by template key, `5103597801` → by the template's `existing_board_id` (the id of the board it was
 * taken from).
 */
export const resolveBoardRefs = async (
  tx: Db,
  boardIdByRef: Map<string, string>,
  pending: InstantiateResult['pendingRefs'],
) => {
  for (const { columnId, refs } of pending) {
    if (!refs.some((r) => boardIdByRef.has(r))) continue;
    const col = await findColumnById(tx, columnId);
    if (!col) continue;
    await updateColumnRow(tx, columnId, {
      settings: resolveRelationRefs(col.settings as Record<string, unknown>, (r) => boardIdByRef.get(r)),
    });
  }
};

/**
 * A relation column's template refs (`board_refs`) resolved: the boards found join `board_ids` (refs not found stay
 * refs), and its choice filters keyed by a ref move to that board (r19relfilter; `group`: the new board's groups,
 * for a board made from this very template).
 */
export const resolveRelationRefs = (
  settings: Record<string, unknown>,
  lookup: (ref: string) => string | undefined,
  group?: (id: string) => string | undefined,
) => {
  const refs = (settings.board_refs as string[] | undefined) ?? [];
  const found = refs.flatMap((r) => (lookup(r) ? [lookup(r)!] : []));
  if (!found.length) return settings;
  const { board_refs: _refs, ...rest } = settings;
  const left = refs.filter((r) => !lookup(r));
  const ids = [...new Set([...((rest.board_ids as string[] | undefined) ?? []), ...found])];
  return remapChoiceSettings(
    { ...rest, board_ids: ids, ...(left.length ? { board_refs: left } : {}) },
    { board: lookup, group },
  );
};

/**
 * Idempotent repair for mirror columns made from a template before their source column was read from it: columns
 * whose settings miss the source column the template names get it (and what else the template sets).
 */
export const repairTemplateColumns = async (db: Db) => {
  let fixed = 0;
  for (const col of await listTemplateMirrorColumnsMissingSource(db)) {
    const snapshot = templateSnapshotSchema.safeParse(col.snapshot);
    if (!snapshot.success) continue;
    const source = [...snapshot.data.columns, ...snapshot.data.add_columns].find((c) => c.id === col.key);
    const def = columnTypes.get(col.type);
    if (!source || !def) continue;
    const settings = snapshotColumnSettings(snapshot.data, def, source.settings);
    if (!settings.source_column_id) continue;
    await updateColumnRow(db, col.id, { settings: { ...col.settings, ...settings } });
    fixed++;
  }
  return fixed;
};
