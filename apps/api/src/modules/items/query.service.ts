// SPDX-License-Identifier: AGPL-3.0-only
import {
  accountSettingsSchema,
  AppError,
  columnTypes,
  applyPlan,
  dateInZone,
  descendantsOf,
  decodeQuery,
  planNeedsMemory,
  planQuery,
  planUsesSubitems,
  pruneQuery,
  flattenRules,
  isRelationMatchOp,
  type FilterGroup,
  type Plan,
  type Query,
  querySchema,
  type QueryEnv,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountCalendar } from '../../lib/account-calendar';
import { getAccountSettings } from '../accounts/accounts.repo';
import { assertBoard, type BoardAccess, loadBoardAccess } from '../boards/boards.access';
import { findSubBoard, listGroups, type ColumnRow } from '../boards/boards.repo';
import { itemsByIds, listBoardItems, type ItemRow } from './items.repo';
import { type Actor, calculatorFor, itemDto, visibleColumns } from './items.service';
import { accountTeams, queryBoardItems } from './query.repo';
import { boardVisibility, filterVisible, type Visibility, visibilitySql } from './visibility';
import { relationUnmatchedEnv } from './relation-filter.service';
import { mirrorSources } from '../boards/mirror-sources';

/**
 * Items query (13-FILTERS §3, §5). Plans without computed values run as SQL (filter, sort and paging in
 * Postgres, DTOs built only for the page); plans that read formulas/mirrors/meta or the item tree are
 * evaluated in memory over the board's items with the same engine the board UI uses.
 */
/** `subColumns` = the sub-board's columns; none (undefined) when the board has no subitems. */
const queryEnv = async (db: Db, a: Actor, columns: ColumnRow[], subColumns?: ColumnRow[]): Promise<QueryEnv> => {
  const [settings, teams, sources] = await Promise.all([
    getAccountSettings(db, a.ctx.accountId).then((s) => accountSettingsSchema.parse(s)),
    accountTeams(db, a.ctx.accountId),
    // A mirror's footer summaries follow its source's type — the outline sums like the browser.
    mirrorSources(db, a, [...columns, ...(subColumns ?? [])]),
  ]);
  const { timezone, weekend, first_day } = settings.locale;
  const calendar = await accountCalendar(db, a.ctx.accountId, settings);
  const queryColumn = (c: ColumnRow) => ({
    id: c.key,
    type: c.type,
    settings: c.settings,
    ...(sources.has(c.id) ? { mirror_source: sources.get(c.id) } : {}),
  });
  return {
    columns: columns.map(queryColumn),
    subitems: subColumns?.map(queryColumn),
    meId: a.user.id,
    teams,
    today: dateInZone(new Date(), timezone),
    timezone,
    weekend,
    firstDay: first_day,
    calendar,
  };
};

/**
 * The page cursor: the offset of the next row and the id of the last row served. The in-memory path continues
 * after that id, so an item created or deleted between two pages neither repeats nor skips a row (audit
 * 2026-10-10 B1); the SQL path keeps the offset (its order can be any column). An older cursor without `k` reads.
 */
const encodeCursor = (offset: number, lastId: string | null) =>
  Buffer.from(JSON.stringify(lastId ? { o: offset, k: lastId } : { o: offset })).toString('base64url');
const decodeCursor = (cursor: string | undefined): { offset: number; lastId: string | null } => {
  if (!cursor) return { offset: 0, lastId: null };
  try {
    const { o, k } = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o?: unknown; k?: unknown };
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0)
      return { offset: o, lastId: typeof k === 'string' && k ? k : null };
  } catch {
    // fall through
  }
  throw new AppError('invalid_query', 'Invalid cursor');
};

/** Parses `?q=` (base64url JSON of a Query); malformed → 422. */
export const parseQueryParam = (q: string | undefined): Query | null => {
  if (!q) return null;
  try {
    return decodeQuery(q);
  } catch {
    throw new AppError('invalid_query', 'Invalid q parameter');
  }
};

/** Everything a query over one board needs: access, columns, visibility, env, plan — and where it can run. */
export type PreparedQuery = {
  access: BoardAccess;
  columns: ColumnRow[];
  v: Visibility;
  subAccess: BoardAccess | null;
  subColumns: ColumnRow[] | undefined;
  env: QueryEnv;
  plan: Plan;
  /** The plan runs as SQL (else in memory over the board's items). */
  inSql: boolean;
  /** The search reads the subitems in SQL (see below). */
  subSearchInSql: boolean;
};

/**
 * Strict by default: a rule whose column is gone or whose type lacks the operator fails with 422 (unknown_column /
 * invalid_operator) — API, automation, MCP and AI callers see the error. Lenient — the query's
 * `ignore_invalid_rules` (saved views: board, windowed view, chart, export, doc embeds, dashboards) or `lenient`
 * (a relation's filter) — drops such rules (`pruneQuery`) so old or imported data keeps working.
 */
export const prepareQuery = async (
  db: Db,
  a: Actor,
  boardId: string,
  query: Query,
  opts: { lenient?: boolean } = {},
): Promise<PreparedQuery> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const columns = await visibleColumns(db, access);
  const v = await boardVisibility(db, a, access);
  // SQL can apply the rule on top-level boards; a sub-board's rule needs the parent items (memory path).
  const sqlVisibility = !v || !access.board.parentBoardId;
  // A top-level board's subitems (D14): `sub:` rules, the search and match_children read them.
  const subBoard = access.board.parentBoardId ? null : await findSubBoard(db, boardId);
  const subAccess = subBoard ? await loadBoardAccess(db, a.ctx, a.user, subBoard.id) : null;
  const subColumns = subAccess ? await visibleColumns(db, subAccess) : undefined;
  const env = await queryEnv(db, a, columns, subColumns);
  // r19relfilter: "has a link that does not match" reads the relation's unmatched items (for this viewer).
  const matchRules = flattenRules(query.filter).filter((r) => isRelationMatchOp(r.operator) && !r.disabled);
  if (matchRules.length)
    env.relationUnmatched = await relationUnmatchedEnv(db, a, columns, [
      ...new Set(matchRules.map((r) => r.column_id)),
    ]);
  const plan = planQuery(opts.lenient || query.ignore_invalid_rules ? pruneQuery(query, env) : query, env);
  // A search that also reads the subitems (and nothing else about them) runs as SQL too, when every subitem is
  // visible to the actor (perf review: in memory it loaded the whole board — ~4 s on a 30k-item board).
  const subSearchInSql =
    plan.searchSubitems &&
    !!subAccess &&
    !planNeedsMemory({ ...plan, searchSubitems: false }) &&
    (await boardVisibility(db, a, subAccess)) === null;
  const inSql = (!planNeedsMemory(plan) || subSearchInSql) && sqlVisibility;
  return { access, columns, v, subAccess, subColumns, env, plan, inSql, subSearchInSql };
};

/** The SQL path: matching ids in query order (board group, sort levels, position), with their groups. */
export const sqlMatches = (
  db: Db,
  a: Actor,
  p: PreparedQuery,
  opts: { offset: number; limit: number; countOnly?: boolean; withGroups?: boolean; byGroup?: boolean },
) =>
  queryBoardItems(db, {
    subSearchColumnIds: p.subSearchInSql
      ? (p.subColumns ?? []).filter((c) => columnTypes.get(c.type)?.storage === 'cell').map((c) => c.id)
      : null,
    visibility: visibilitySql(p.v),
    accountId: a.ctx.accountId,
    boardId: p.access.board.id,
    plan: p.plan,
    columnIds: new Map(p.columns.map((c) => [c.key, c.id])),
    timezone: p.env.timezone,
    offset: opts.offset,
    limit: opts.limit,
    countOnly: opts.countOnly,
    withGroups: opts.withGroups,
    byGroup: opts.byGroup,
  });

/**
 * The memory path: every visible item of the board as a DTO (subitems attached when the plan reads them),
 * filtered and sorted by the plan. `calc` builds more DTOs; `byId` has the item rows.
 */
export const memoryMatches = async (db: Db, a: Actor, p: PreparedQuery, byGroup = true) => {
  const boardId = p.access.board.id;
  const [all, groups] = await Promise.all([listBoardItems(db, boardId), listGroups(db, boardId)]);
  const items = await filterVisible(db, p.v, all);
  const calc = await calculatorFor(
    db,
    a,
    items.map((i) => i.id),
    items,
    boardId,
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  const rank = new Map(groups.map((g, i) => [g.id, i]));
  const rows = items.map((i) => itemDto(calc, i, p.columns));
  if (p.subAccess && planUsesSubitems(p.plan)) {
    // The subitems the actor may see (every depth — D14), as rows of the sub-board's columns.
    const children = await filterVisible(
      db,
      await boardVisibility(db, a, p.subAccess),
      await listBoardItems(db, p.subAccess.board.id),
    );
    const subCalc = await calculatorFor(
      db,
      a,
      children.map((c) => c.id),
      children,
      p.subAccess.board.id,
    );
    // Each top item gets all its descendants (a filter on a sub-sub-item keeps the top item too).
    const byParent = new Map<string, ReturnType<typeof itemDto>[]>();
    for (const c of [...children].sort((x, y) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0))) {
      const list = byParent.get(c.parentItemId!) ?? [];
      list.push(itemDto(subCalc, c, p.subColumns ?? []));
      byParent.set(c.parentItemId!, list);
    }
    for (const r of rows) Object.assign(r, { subitems: descendantsOf(byParent, r.id) });
  }
  const matched = applyPlan(rows, p.plan, p.env.timezone, byGroup ? rank : undefined);
  return { matched, byId, calc };
};

type Options = { cursor?: string; limit: number | null; countOnly?: boolean };

export const queryItems = async (db: Db, a: Actor, boardId: string, query: Query, opts: Options) => {
  const p = await prepareQuery(db, a, boardId, query);
  let { offset } = decodeCursor(opts.cursor);
  const { lastId } = decodeCursor(opts.cursor);
  const limit = opts.limit ?? Number.MAX_SAFE_INTEGER;

  let pageItems: ItemRow[];
  let total: number;
  let calc;
  if (p.inSql) {
    const page = await sqlMatches(db, a, p, { offset, limit: Math.min(limit, 100_000), countOnly: opts.countOnly });
    total = page.total;
    if (opts.countOnly) return { data: [], total, next_cursor: null };
    const rows = new Map((await itemsByIds(db, a.ctx.accountId, page.ids)).map((r) => [r.id, r]));
    pageItems = page.ids.map((id) => rows.get(id)).filter((r) => !!r);
    calc = await calculatorFor(
      db,
      a,
      pageItems.map((i) => i.id),
    );
  } else {
    const m = await memoryMatches(db, a, p);
    calc = m.calc;
    total = m.matched.length;
    if (opts.countOnly) return { data: [], total, next_cursor: null };
    // Continue after the last row served when it is still there; else from the offset (a deleted row).
    const at = lastId ? m.matched.findIndex((d) => d.id === lastId) : -1;
    if (at >= 0) offset = at + 1;
    pageItems = m.matched.slice(offset, offset + limit).map((d) => m.byId.get(d.id)!);
  }
  const data = pageItems.map((i) => itemDto(calc, i, p.columns));
  const next = offset + data.length;
  return { data, total, next_cursor: next < total ? encodeCursor(next, data.at(-1)?.id ?? null) : null };
};

/**
 * r19relfilter: the items of a board that match a query, for this viewer — only among `ids` when given, only
 * those whose name contains `name`. Ordered by name (`byName`, the relation picker) or board order.
 * Rules on columns that are gone are dropped (`prune`). Returns the page and the total.
 */
export const matchIds = async (
  db: Db,
  a: Actor,
  boardId: string,
  query: Query,
  opts: { ids?: string[] | null; name?: string | null; offset?: number; limit: number; byName?: boolean },
): Promise<{ ids: string[]; total: number }> => {
  const nameKey = opts.byName ? (await visibleColumnsOf(db, a, boardId)).find((c) => c.type === 'name')?.key : null;
  const q: Query = nameKey ? { ...query, sort: [{ column_id: nameKey, direction: 'asc', nulls: 'last' }] } : query;
  const p = await prepareQuery(db, a, boardId, q, { lenient: true });
  const name = opts.name?.trim().toLowerCase() || null;
  const offset = opts.offset ?? 0;
  if (p.inSql) {
    const page = await queryBoardItems(db, {
      subSearchColumnIds: p.subSearchInSql
        ? (p.subColumns ?? []).filter((c) => columnTypes.get(c.type)?.storage === 'cell').map((c) => c.id)
        : null,
      visibility: visibilitySql(p.v),
      accountId: a.ctx.accountId,
      boardId: p.access.board.id,
      plan: p.plan,
      columnIds: new Map(p.columns.map((c) => [c.key, c.id])),
      timezone: p.env.timezone,
      offset,
      limit: opts.limit,
      byGroup: !nameKey,
      ids: opts.ids ?? null,
      nameContains: name,
    });
    return { ids: page.ids, total: page.total };
  }
  const m = await memoryMatches(db, a, p, !nameKey);
  const only = opts.ids ? new Set(opts.ids) : null;
  const hits = m.matched.filter((r) => (!only || only.has(r.id)) && (!name || r.name.toLowerCase().includes(name)));
  return { ids: hits.slice(offset, offset + opts.limit).map((r) => r.id), total: hits.length };
};

/**
 * AI style examples: the items of a board that match `filter` for this viewer (their board rights
 * item visibility, the columns they may see — a rule on a column hidden from them is `unknown_column`), that hold a
 * usable image in a file column (`newestFile`), the one whose image was added last first, at most `limit`, never
 * `exclude`. One SQL query when the plan runs in SQL; otherwise the matches in memory (formulas, mirrors …), then
 * one SQL query over their ids.
 */
export const newestFileMatches = async (
  db: Db,
  a: Actor,
  boardId: string,
  filter: FilterGroup | null,
  o: { newestFile: { columnId: string; mimes: readonly string[]; maxBytes: number }; exclude: string[]; limit: number },
): Promise<string[]> => {
  const p = await prepareQuery(db, a, boardId, querySchema.parse({ ...(filter ? { filter } : {}), scope: 'all' }));
  const base = {
    subSearchColumnIds: null,
    accountId: a.ctx.accountId,
    boardId: p.access.board.id,
    columnIds: new Map(p.columns.map((c) => [c.key, c.id])),
    timezone: p.env.timezone,
    offset: 0,
    limit: o.limit,
    byGroup: false,
    excludeIds: o.exclude,
    newestFile: o.newestFile,
  };
  if (p.inSql) return (await queryBoardItems(db, { ...base, plan: p.plan, visibility: visibilitySql(p.v) })).ids;
  const m = await memoryMatches(db, a, p, false);
  if (!m.matched.length) return [];
  const plain = planQuery(querySchema.parse({}), p.env);
  return (await queryBoardItems(db, { ...base, plan: plain, ids: m.matched.map((r) => r.id) })).ids;
};

const visibleColumnsOf = async (db: Db, a: Actor, boardId: string) =>
  visibleColumns(db, await loadBoardAccess(db, a.ctx, a.user, boardId));
