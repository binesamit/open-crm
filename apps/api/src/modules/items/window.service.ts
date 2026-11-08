// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  BULK_QUERY_MAX,
  type BulkQueryRequest,
  columnTypes,
  type Field,
  OUTLINE_COMPUTED_MAX,
  OUTLINE_MAX_IDS,
  type Outline,
  type OutlineRequest,
  type OutlineSummary,
  outlineSections,
  type GroupLevel,
  groupOptsOf,
  type QueryRow,
  readIds,
  resolveField,
  type WindowedInfo,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { listGroups } from '../boards/boards.repo';
import { tagsByIds } from '../tags/tags.repo';
import { listTeamRows } from '../teams/teams.repo';
import { bulkItems } from './bulk.service';
import { memberNames } from './items.repo';
import { type Actor, calculatorFor } from './items.service';
import { memoryMatches, type PreparedQuery, prepareQuery, sqlMatches } from './query.service';
import { boardCellsOfColumns, boardItemBasics, countBoardItems } from './window.repo';

/**
 * Windowed boards (perf review §7.1, shared/api/windowed.ts). A top-level board with more live items than the
 * threshold is not sent whole: `GET /boards/:id/items?window=1` answers with its size only, and the table works
 * from the outline (`boardOutline`) plus rows fetched by id as they scroll into view. Sub-boards always load
 * whole (their rows come with their parents).
 */
export const windowInfo = async (
  db: Db,
  a: Actor,
  boardId: string,
  threshold: number,
): Promise<WindowedInfo | null> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  if (access.board.parentBoardId) return null;
  const total = await countBoardItems(db, boardId);
  return total > threshold ? { total, threshold } : null;
};

const ITEM_FIELDS = new Set(['__creator__', '__created_at__', '__updated_at__']);
/** A cell the outline can read straight from the table (no relation, mirror, formula or item metadata). */
const isStored = (f: Field) =>
  f.source === 'column' &&
  f.def.storage === 'cell' &&
  !f.def.fromItem &&
  f.def.engine !== 'links' &&
  f.def.engine !== 'mirror' &&
  f.def.engine !== 'formula';

const lightRow = (id: string, groupId: string | null): QueryRow => ({
  id,
  group_id: groupId,
  parent_item_id: null,
  depth: 0,
  name: '',
  position: '',
  key: null,
  cells: {},
  created_at: '',
  created_by: null,
  updated_at: '',
});

/**
 * Fills light rows (SQL path) with what `fields` read: stored cells straight from `cells` (only those columns),
 * the name / creator / times from `items`, computed values (formula, mirror, relation, meta, the key) through
 * the calculator — only when one of them is asked for.
 */
const fillRows = async (db: Db, a: Actor, p: PreparedQuery, rows: QueryRow[], fields: Field[]) => {
  if (!rows.length || !fields.length) return;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const columnByKey = new Map(p.columns.map((c) => [c.key, c]));
  const stored = fields.filter(isStored);
  if (stored.length) {
    const keyOf = new Map(stored.map((f) => [columnByKey.get(f.id)!.id, f.id]));
    for (const c of await boardCellsOfColumns(db, p.access.board.id, [...keyOf.keys()])) {
      const row = byId.get(c.item_id);
      if (row) row.cells[keyOf.get(c.column_id)!] = { value: c.value, text: c.text_value };
    }
  }
  const needsItem = fields.some(
    (f) => (f.source === 'system' && ITEM_FIELDS.has(f.id)) || (f.source === 'column' && f.def.storage === 'item'),
  );
  if (needsItem) {
    for (const it of await boardItemBasics(db, p.access.board.id)) {
      const row = byId.get(it.id);
      if (!row) continue;
      row.name = it.name;
      row.created_by = it.created_by;
      row.created_at = new Date(it.created_at).toISOString();
      row.updated_at = new Date(it.updated_at).toISOString();
    }
  }
  const computed = fields.filter(
    (f) => (f.source === 'column' && !isStored(f) && f.def.storage !== 'item') || f.id === '__key__',
  );
  if (computed.length) {
    const calc = await calculatorFor(db, a, [...byId.keys()]);
    for (const row of rows) {
      const item = calc.item(row.id);
      if (!item) continue;
      for (const f of computed) {
        if (f.source === 'system') row.key = calc.keyOf(item);
        else {
          const col = columnByKey.get(f.id)!;
          const v = calc.display(row.id, col, columnTypes.get(col.type)!);
          if (v) row.cells[f.id] = v;
        }
      }
    }
  }
};

/**
 * A batch action on every item a query matches (`POST items/bulk-query`) — "select all" on a windowed board
 * reaches rows the browser never loaded. Same rules, events and undo as `items/bulk`; at most BULK_QUERY_MAX.
 */
export const bulkByQuery = async (db: Db, a: Actor, boardId: string, input: BulkQueryRequest) => {
  const p = await prepareQuery(db, a, boardId, input.query);
  const ids = p.inSql
    ? (await sqlMatches(db, a, p, { offset: 0, limit: BULK_QUERY_MAX + 1 })).ids
    : (await memoryMatches(db, a, p)).matched.map((r) => r.id);
  if (ids.length > BULK_QUERY_MAX)
    throw new AppError('validation_failed', `At most ${BULK_QUERY_MAX} items in one batch`, { max: BULK_QUERY_MAX });
  if (!ids.length) throw new AppError('validation_failed', 'No items match');
  return bulkItems(db, a, boardId, { item_ids: ids, action: input.action });
};

/** Bucket names for a grouping by people / teams / tags (the browser relabels with its own lists). */
const namesFor = async (db: Db, a: Actor, field: Field, rows: QueryRow[]) => {
  const names = new Map<string, string>();
  if (field.model !== 'people' && field.model !== 'tags') return names;
  const ids = [...new Set(rows.flatMap((r) => readIds(r, field)))];
  if (!ids.length) return names;
  if (field.model === 'tags') {
    for (const t of await tagsByIds(db, a.ctx.accountId, ids)) names.set(t.id, `#${t.name}`);
    return names;
  }
  for (const [id, n] of await memberNames(db, a.ctx.accountId, ids)) names.set(id, n);
  if (ids.some((id) => !names.has(id)))
    for (const t of await listTeamRows(db, a.ctx.accountId)) names.set(t.id, t.name);
  return names;
};

const resolveSummary = (s: { column_id: string; fn?: OutlineSummary['fn'] }, p: PreparedQuery) => {
  try {
    return { field: resolveField(s.column_id, p.env), fn: s.fn };
  } catch {
    return null; // a hidden or deleted column: no summary
  }
};

/**
 * The outline of a view over a (windowed) board: every matching id in view order by section, each section's
 * footer summaries and group-title summary — filter, sort, grouping and summaries on the server, with the same
 * engine as the browser. Plans SQL can run read only the cells the sections need; others run in memory.
 */
export const boardOutline = async (db: Db, a: Actor, boardId: string, req: OutlineRequest): Promise<Outline> => {
  const p = await prepareQuery(db, a, boardId, req.query);
  const groupKey = req.lanes_by ?? req.query.group_by?.column_id;
  const groupField = groupKey ? resolveField(groupKey, p.env) : null;
  const byGroup = !groupField && req.layout === 'groups';
  // Prod ק3: the levels under the first (a table's view only; Kanban lanes stay one level).
  const subLevels = req.lanes_by
    ? []
    : (req.query.subgroups ?? []).flatMap((g) => {
        try {
          return [{ g, field: resolveField(g.column_id, p.env) }];
        } catch {
          return []; // a column that is gone: that level is skipped
        }
      });
  let summaries = req.summaries.flatMap((s) => resolveSummary(s, p) ?? []);
  let groupSummary = req.group_summary ? resolveSummary(req.group_summary, p) : null;
  const skipped = new Set<string>();

  let rows: QueryRow[];
  let truncated = false;
  if (p.inSql) {
    const page = await sqlMatches(db, a, p, { offset: 0, limit: OUTLINE_MAX_IDS + 1, withGroups: true, byGroup });
    truncated = page.ids.length > OUTLINE_MAX_IDS;
    rows = page.ids.slice(0, OUTLINE_MAX_IDS).map((id, i) => lightRow(id, page.groups?.[i] ?? null));
    if (rows.length > OUTLINE_COMPUTED_MAX) {
      const cheap = (s: OutlineSummary) => {
        if (s.field.source === 'column' && !isStored(s.field) && s.field.def.storage !== 'item')
          skipped.add(s.field.id);
        return !skipped.has(s.field.id);
      };
      summaries = summaries.filter(cheap);
      if (groupSummary && !cheap(groupSummary)) groupSummary = null;
    }
    const fields = [
      groupField,
      ...subLevels.map((l) => l.field),
      ...summaries.map((s) => s.field),
      groupSummary?.field,
    ].filter((f): f is Field => !!f);
    await fillRows(db, a, p, rows, fields);
  } else {
    rows = (await memoryMatches(db, a, p, byGroup)).matched;
    truncated = rows.length > OUTLINE_MAX_IDS;
    rows = rows.slice(0, OUTLINE_MAX_IDS);
  }

  const groups = byGroup ? await listGroups(db, boardId) : [];
  const names = groupField ? await namesFor(db, a, groupField, rows) : new Map<string, string>();
  for (const l of subLevels) for (const [k, v] of await namesFor(db, a, l.field, rows)) names.set(k, v);
  // Nested: the first level is the grouping's column, or the board's groups in their order (their titles).
  const levels: GroupLevel[] | undefined = subLevels.length
    ? (() => {
        const base = {
          timezone: p.env.timezone,
          nameOf: (id: string) => names.get(id),
          emptyLabel: '',
          checkedLabel: '',
          dates: { env: p.env, label: (key: string) => key },
          teams: p.env.teams,
        };
        const rank = new Map(groups.map((g, i) => [g.id, i]));
        const first: GroupLevel = groupField
          ? { field: groupField, opts: groupOptsOf(req.query.group_by, base) }
          : {
              field: resolveField('__group__', p.env),
              opts: {
                ...base,
                nameOf: (id: string) => groups.find((g) => g.id === id)?.title,
                rank: (key: string) => rank.get(key) ?? Number.MAX_SAFE_INTEGER,
              },
            };
        return [first, ...subLevels.map((l) => ({ field: l.field, opts: groupOptsOf(l.g, base) }))];
      })()
    : undefined;
  const sections = outlineSections(byGroup || groupField ? rows : rows.map((r) => ({ ...r, group_id: '' })), {
    timezone: p.env.timezone,
    groupOrder: byGroup ? groups.map((g) => g.id) : [''],
    ...(groupField
      ? {
          // Kanban lanes keep the relative date buckets; a table's grouping takes its own date unit.
          groupBy: req.lanes_by
            ? { field: groupField, direction: 'asc' as const }
            : {
                field: groupField,
                direction: req.query.group_by?.direction,
                dateUnit: req.query.group_by?.date_unit,
                pastDetail: req.query.group_by?.past_detail,
                dateEdge: req.query.group_by?.date_edge,
                mode: req.query.group_by?.mode,
                rangeSize: req.query.group_by?.range_size,
                showEmpty: req.query.group_by?.show_empty,
                teams: p.env.teams,
              },
          nameOf: (id: string) => names.get(id),
          dates: p.env,
        }
      : {}),
    summaries,
    groupSummary,
    ...(levels ? { levels } : {}),
  });
  return {
    total: rows.length,
    sections,
    ...(groupField ? { grouped_by: groupField.id } : {}),
    ...(truncated ? { truncated } : {}),
    ...(skipped.size ? { skipped_summaries: [...skipped] } : {}),
  };
};
