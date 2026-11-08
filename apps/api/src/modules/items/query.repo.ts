// SPDX-License-Identifier: AGPL-3.0-only
import { comparesNumbers, type Field, type Plan, type PlanNode, type PlanRule, type PlanSpan } from '@bines/shared';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { teamMembers, teams } from '../../db/schema';

/**
 * Compiles a query Plan (packages/shared/query) to SQL (13-FILTERS §3). Semantics mirror the in-memory engine
 * (shared/query/evaluate.ts) exactly; `apps/api/test/query.test.ts` runs both over the same fixtures.
 * Only plans without computed values reach here (`planNeedsMemory` = false).
 *
 * Each cell rule is an EXISTS over the item's cell with a predicate, so the (column_id, *_value) indexes apply;
 * "empty" is the absence of a non-empty cell, which also covers semantically empty values ({ids: []}, …).
 */

type Ctx = {
  /** column key → column row id (cells.column_id). */
  columnIds: Map<string, string>;
  timezone: string;
  /**
   * The search also reads the subitems (any depth) — their names and these sub-board cell columns (ids). Only
   * when the subitems are all visible to the actor; otherwise the plan runs in memory.
   */
  subSearchColumnIds?: string[] | null;
};

const I = sql.raw('i');
const NEVER = sql`false`;

const lit = (xs: string[]) =>
  sql`array[${sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  )}]::text[]`;

/** EXISTS over the item's cell of a column, with a predicate on `c`. */
const hasCell = (ctx: Ctx, f: Field & { source: 'column' }, pred: SQL) =>
  sql`exists (select 1 from cells c where c.item_id = ${I}.id and c.column_id = ${ctx.columnIds.get(f.id)!} and ${pred})`;

const textOf = (expr: SQL) => sql`lower(btrim(coalesce(${expr}, ''), E' \\t\\n\\r'))`;

/** A predicate that holds on the item: system fields and the name read the item row; others its cell. */
const on = (ctx: Ctx, f: Field, pred: (value: SQL) => SQL, value: (f: Field) => SQL) =>
  f.source === 'column' && f.def.storage === 'cell' ? hasCell(ctx, f, pred(value(f))) : pred(value(f));

const textRule = (ctx: Ctx, r: PlanRule): SQL => {
  const f = r.field;
  const value = () =>
    f.source === 'column' && f.def.storage === 'item' ? textOf(sql`${I}.name`) : textOf(sql`c.text_value`);
  const has = (pred: (t: SQL) => SQL) => on(ctx, f, pred, value);
  const nonEmpty = has((t) => sql`${t} <> ''`);
  const anyOf = () => {
    const parts: SQL[] = [];
    if (r.wantsEmpty) parts.push(sql`not ${nonEmpty}`);
    if (r.texts.length) parts.push(has((t) => sql`${t} = any(${lit(r.texts)})`));
    return parts.length ? sql`(${sql.join(parts, sql` or `)})` : NEVER;
  };
  const someText = (fn: (t: SQL, v: string) => SQL) =>
    has(
      (t) =>
        sql`(${sql.join(
          r.texts.map((v) => fn(t, v)),
          sql` or `,
        )})`,
    );
  switch (r.operator) {
    case 'is_empty':
      return sql`not ${nonEmpty}`;
    case 'is_not_empty':
      return nonEmpty;
    case 'any_of':
      return anyOf();
    case 'not_any_of':
      return sql`not ${anyOf()}`;
    case 'contains_text':
      return someText((t, v) => sql`strpos(${t}, ${v}) > 0`);
    case 'not_contains_text':
      return sql`not ${someText((t, v) => sql`strpos(${t}, ${v}) > 0`)}`;
    case 'starts_with':
      return someText((t, v) => sql`starts_with(${t}, ${v})`);
    case 'ends_with':
      return someText((t, v) => sql`right(${t}, ${v.length}) = ${v}`);
    default:
      return NEVER;
  }
};

const numberRule = (ctx: Ctx, r: PlanRule): SQL => {
  const f = r.field;
  const value = () => (f.source === 'system' ? sql`${I}.depth::float8` : sql`c.number_value`);
  const has = (pred: (n: SQL) => SQL) => on(ctx, f, pred, value);
  const nonEmpty = has((n) => sql`${n} is not null`);
  const [a, b] = r.numbers;
  const anyOf = () => {
    const parts: SQL[] = [];
    if (r.wantsEmpty) parts.push(sql`not ${nonEmpty}`);
    if (r.numbers.length)
      parts.push(
        has(
          (n) =>
            sql`${n} = any(array[${sql.join(
              r.numbers.map((x) => sql`${x}`),
              sql`, `,
            )}]::float8[])`,
        ),
      );
    return parts.length ? sql`(${sql.join(parts, sql` or `)})` : NEVER;
  };
  switch (r.operator) {
    case 'is_empty':
      return sql`not ${nonEmpty}`;
    case 'is_not_empty':
      return nonEmpty;
    case 'any_of':
      return anyOf();
    case 'not_any_of':
      return sql`not ${anyOf()}`;
    case 'greater_than':
      return has((n) => sql`${n} > ${a!}`);
    case 'greater_than_or_equal':
      return has((n) => sql`${n} >= ${a!}`);
    case 'lower_than':
      return has((n) => sql`${n} < ${a!}`);
    case 'lower_than_or_equal':
      return has((n) => sql`${n} <= ${a!}`);
    case 'between':
      return has((n) => sql`${n} between ${Math.min(a!, b!)} and ${Math.max(a!, b!)}`);
    default:
      return NEVER;
  }
};

/**
 * Local calendar dates of a cell: a plain date (stored at 00:00 UTC) is never shifted; a date with a time is
 * converted to the account timezone — the same rule as shared `localDate`.
 */
const cellFrom = (tz: string) =>
  sql`(case when c.value ? 'time' then (c.date_value at time zone ${tz})::date else (c.date_value at time zone 'UTC')::date end)`;
const cellTo = (tz: string) =>
  sql`(case when c.date_end_value is null then ${cellFrom(tz)} else (c.date_end_value at time zone 'UTC')::date end)`;

const dateRule = (ctx: Ctx, r: PlanRule): SQL => {
  const f = r.field;
  const tz = ctx.timezone;
  let from: SQL;
  let to: SQL;
  if (f.source === 'system') {
    const col = f.id === '__created_at__' ? sql`${I}.created_at` : sql`${I}.updated_at`;
    from = to = sql`(${col} at time zone ${tz})::date`;
  } else {
    from = r.attribute === 'end' ? cellTo(tz) : cellFrom(tz);
    to = r.attribute === 'start' ? cellFrom(tz) : cellTo(tz);
  }
  const has = (pred: SQL) => (f.source === 'column' ? hasCell(ctx, f, pred) : pred);
  const nonEmpty = f.source === 'column' ? has(sql`c.date_value is not null`) : sql`true`;
  const overlap = (s: PlanSpan) =>
    sql`(${s.to === null ? sql`true` : sql`${from} <= ${s.to}::date`} and ${s.from === null ? sql`true` : sql`${to} >= ${s.from}::date`})`;
  const notDone = () => {
    const o = r.overdue!;
    return o.doneIds.length
      ? sql`not ${hasCell(ctx, o.statusField, sql`(c.value->>'index') = any(${lit(o.doneIds)})`)}`
      : sql`true`;
  };
  const anyOf = () => {
    const parts: SQL[] = [];
    if (r.wantsEmpty) parts.push(sql`not ${nonEmpty}`);
    for (const s of r.spans)
      parts.push(s.overdue && r.overdue ? sql`(${has(overlap(s))} and ${notDone()})` : has(overlap(s)));
    return parts.length ? sql`(${sql.join(parts, sql` or `)})` : NEVER;
  };
  const s0 = r.spans[0];
  switch (r.operator) {
    case 'is_empty':
      return sql`not ${nonEmpty}`;
    case 'is_not_empty':
      return nonEmpty;
    case 'any_of':
      return anyOf();
    case 'not_any_of':
      return sql`not ${anyOf()}`;
    case 'greater_than':
      return s0?.to ? has(sql`${from} > ${s0.to}::date`) : NEVER;
    case 'lower_than':
      return s0?.from ? has(sql`${to} < ${s0.from}::date`) : NEVER;
    case 'between':
    case 'within_the_last':
    case 'within_the_next':
      return s0 ? has(overlap(s0)) : NEVER;
    default:
      return NEVER;
  }
};

/** id models: label (status), labels (dropdown), tags, people, links, and the system id fields. */
const idRule = (ctx: Ctx, r: PlanRule): SQL => {
  const f = r.field;
  let any: (ids: string[]) => SQL;
  let nonEmpty: SQL;
  if (f.source === 'system') {
    const col =
      f.id === '__group__'
        ? sql`${I}.group_id`
        : f.id === '__parent__'
          ? sql`${I}.parent_item_id`
          : sql`${I}.created_by`;
    any = (ids) => sql`${col} = any(${lit(ids)})`;
    nonEmpty = sql`${col} is not null`;
  } else if (f.model === 'links') {
    // item_links is the truth for relations (03 §2.16); deleted targets don't count.
    const link = (pred: SQL) =>
      sql`exists (select 1 from item_links l join items t on t.id = l.to_item_id and t.deleted_at is null
        where l.from_item_id = ${I}.id and l.column_id = ${ctx.columnIds.get(f.id)!} and ${pred})`;
    any = (ids) => link(sql`l.to_item_id = any(${lit(ids)})`);
    nonEmpty = link(sql`true`);
  } else {
    // Arrays of ids: dropdown `ids`, tags `tag_ids`, people `persons_and_teams[].id`.
    const key = f.model === 'labels' ? 'ids' : f.model === 'tags' ? 'tag_ids' : null;
    const elems =
      f.model === 'label'
        ? null
        : key
          ? sql`(select e from jsonb_array_elements_text(c.value->${sql.raw(`'${key}'`)}) e)`
          : sql`(select p->>'id' from jsonb_array_elements(c.value->'persons_and_teams') p)`;
    const list = key ? sql`c.value->${sql.raw(`'${key}'`)}` : sql`c.value->'persons_and_teams'`;
    any = (ids) =>
      hasCell(
        ctx,
        f,
        elems
          ? sql`exists (${elems} intersect select unnest(${lit(ids)}))`
          : sql`(c.value->>'index') = any(${lit(ids)})`,
      );
    nonEmpty = hasCell(
      ctx,
      f,
      elems ? sql`jsonb_typeof(${list}) = 'array' and jsonb_array_length(${list}) > 0` : sql`c.value ? 'index'`,
    );
  }
  const anyOf = () => {
    const parts: SQL[] = [];
    if (r.wantsEmpty) parts.push(sql`not ${nonEmpty}`);
    if (r.ids.length) parts.push(any(r.ids));
    return parts.length ? sql`(${sql.join(parts, sql` or `)})` : NEVER;
  };
  switch (r.operator) {
    case 'is_empty':
      return sql`not ${nonEmpty}`;
    case 'is_not_empty':
      return nonEmpty;
    case 'any_of':
      return anyOf();
    case 'not_any_of':
      return sql`not ${anyOf()}`;
    case 'is_done':
      return r.ids.length ? any(r.ids) : NEVER;
    case 'is_not_done':
      return r.ids.length ? sql`not ${any(r.ids)}` : sql`true`;
    // r19relfilter: the unmatched linked items were resolved into `ids` before planning.
    case 'has_unmatched_link':
      return r.ids.length ? any(r.ids) : NEVER;
    case 'no_unmatched_link':
      return r.ids.length ? sql`not ${any(r.ids)}` : sql`true`;
    default:
      return NEVER;
  }
};

const ruleSql = (ctx: Ctx, r: PlanRule): SQL => {
  const m = r.field.model;
  const textOp = ['contains_text', 'not_contains_text', 'starts_with', 'ends_with'].includes(r.operator);
  if (m === 'checkbox') {
    const checked = hasCell(ctx, r.field as Field & { source: 'column' }, sql`(c.value->>'checked') = 'true'`);
    return r.operator === 'is_not_empty' ? checked : sql`not ${checked}`;
  }
  // a timer column — some timer runs on the cell now.
  if (r.operator === 'is_running' || r.operator === 'is_not_running') {
    const running = hasCell(ctx, r.field as Field & { source: 'column' }, sql`(c.value->>'running') = 'true'`);
    return r.operator === 'is_running' ? running : sql`not ${running}`;
  }
  if (comparesNumbers(m, r.operator)) return numberRule(ctx, r);
  if (textOp || m === 'text' || m === 'files') return textRule(ctx, r);
  if (m === 'date') return dateRule(ctx, r);
  return idRule(ctx, r);
};

const nodeSql = (ctx: Ctx, n: PlanNode): SQL => {
  const inner =
    n.kind === 'rule'
      ? ruleSql(ctx, n)
      : n.nodes.length
        ? sql`(${sql.join(
            n.nodes.map((c) => nodeSql(ctx, c)),
            n.operator === 'and' ? sql` and ` : sql` or `,
          )})`
        : n.operator === 'and'
          ? sql`true`
          : NEVER;
  return n.negate ? sql`(not ${inner})` : inner;
};

const searchSql = (ctx: Ctx, plan: Plan): SQL => {
  const q = plan.search!;
  const cellCols = plan.searchFields
    .filter((f): f is Field & { source: 'column' } => f.source === 'column' && f.def.storage === 'cell')
    .map((f) => ctx.columnIds.get(f.id)!);
  const inCells = cellCols.length
    ? sql` or exists (select 1 from cells c where c.item_id = ${I}.id and c.column_id = any(${lit(cellCols)})
        and strpos(lower(coalesce(c.text_value, '')), ${q}) > 0)`
    : sql``;
  const sub = ctx.subSearchColumnIds;
  const inSubitems = sub
    ? sql` or exists (select 1 from items s where s.root_item_id = ${I}.id and s.deleted_at is null
        and s.archived_at is null and (strpos(lower(s.name), ${q}) > 0${
          sub.length
            ? sql` or exists (select 1 from cells sc where sc.item_id = s.id and sc.column_id = any(${lit(sub)})
                and strpos(lower(coalesce(sc.text_value, '')), ${q}) > 0)`
            : sql``
        }))`
    : sql``;
  return sql`(strpos(lower(${I}.name), ${q}) > 0${inCells}${inSubitems})`;
};

const sortExpr = (ctx: Ctx, f: Field): SQL => {
  if (f.source === 'system') {
    if (f.id === '__created_at__') return sql`${I}.created_at`;
    if (f.id === '__updated_at__') return sql`${I}.updated_at`;
    if (f.id === '__depth__') return sql`${I}.depth::float8`;
    const col =
      f.id === '__group__'
        ? sql`${I}.group_id`
        : f.id === '__parent__'
          ? sql`${I}.parent_item_id`
          : sql`${I}.created_by`;
    return sql`nullif(lower(btrim(coalesce(${col}, ''))), '') collate "C"`;
  }
  if (f.def.storage === 'item') return sql`nullif(${textOf(sql`${I}.name`)}, '') collate "C"`;
  const cell = (col: SQL) =>
    sql`(select ${col} from cells c where c.item_id = ${I}.id and c.column_id = ${ctx.columnIds.get(f.id)!})`;
  if (f.sortKey === 'number') return cell(sql`c.number_value`);
  if (f.sortKey === 'date') return cell(sql`c.date_value`);
  return sql`nullif(${textOf(cell(sql`c.text_value`))}, '') collate "C"`;
};

export type ItemsQueryPage = { ids: string[]; total: number; groups?: (string | null)[] };

/**
 * Runs a plan over one board: filter + search + scope in WHERE, the board's group order, the sort levels,
 * then position (13 §3). Offset paging; `total` counts every match.
 */
export const queryBoardItems = async (
  db: Db,
  p: {
    accountId: string;
    boardId: string;
    plan: Plan;
    columnIds: Map<string, string>;
    timezone: string;
    offset: number;
    limit: number;
    countOnly?: boolean;
    /** Item-level visibility (05 §6) as a condition on `items i`; null = everything. */
    visibility?: SQL | null;
    /** See Ctx.subSearchColumnIds. */
    subSearchColumnIds?: string[] | null;
    /** Also return each match's group (`groups`, parallel to `ids`) — the windowed board's sections. */
    withGroups?: boolean;
    /** false: no board-group order first (a view grouped by column, Cards, Kanban — like the board UI). */
    byGroup?: boolean;
    /** r19relfilter: only these items (a relation's linked items, checked against its filter). */
    ids?: string[] | null;
    /** r19relfilter: the item name contains this (lowercased) text — the relation picker's search. */
    nameContains?: string | null;
    /** Never these items (AI style examples: the item being processed). */
    excludeIds?: string[] | null;
    /**
     * AI style examples: only items with a usable image in this file column (uploaded, not deleted
     * one of `mimes`, at most `maxBytes`), the item whose newest such image was added last first — before any other
     * order (the plan's sort and the board's group order are not used).
     */
    newestFile?: { columnId: string; mimes: readonly string[]; maxBytes: number } | null;
  },
): Promise<ItemsQueryPage> => {
  const ctx: Ctx = { columnIds: p.columnIds, timezone: p.timezone, subSearchColumnIds: p.subSearchColumnIds };
  const where: SQL[] = [
    sql`${I}.account_id = ${p.accountId}`,
    sql`${I}.board_id = ${p.boardId}`,
    sql`${I}.deleted_at is null`,
    sql`${I}.archived_at is null`,
  ];
  if (p.plan.scope === 'parents') where.push(sql`${I}.depth = 0`);
  if (p.plan.scope === 'subitems') where.push(sql`${I}.depth > 0`);
  if (p.plan.search) where.push(searchSql(ctx, p.plan));
  if (p.plan.filter) where.push(nodeSql(ctx, p.plan.filter));
  if (p.visibility) where.push(p.visibility);
  if (p.ids) where.push(p.ids.length ? sql`${I}.id = any(${sql.param(p.ids)}::varchar[])` : NEVER);
  if (p.nameContains) where.push(sql`strpos(lower(${I}.name), ${p.nameContains}) > 0`);
  if (p.excludeIds?.length) where.push(sql`not (${I}.id = any(${sql.param(p.excludeIds)}::varchar[]))`);
  // The newest usable image of the column per item (null = none: the item is left out). Each file is judged by its
  // current version: the newest uploaded one of the root and its versions.
  const nf = p.newestFile;
  const newestFileAt = nf
    ? sql`(select max(cf.created_at) from cell_files cf join assets a on a.id = cf.asset_id
        join lateral (select v.mime, v.size from assets v
          where (v.id = a.id or v.parent_asset_id = a.id) and v.deleted_at is null and v.upload_status = 'uploaded'
          order by v.version desc limit 1) cur on true
        where cf.item_id = ${I}.id and cf.column_id = ${nf.columnId} and a.deleted_at is null
        and cur.mime = any(${lit([...nf.mimes])}) and cur.size <= ${nf.maxBytes})`
    : null;
  if (newestFileAt) where.push(sql`${newestFileAt} is not null`);
  const whereSql = sql.join(where, sql` and `);

  const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
  // Filters over many cells look expensive to the planner, which then spends ~0.5 s JIT-compiling a query that
  // runs in a few ms; these queries are short, so JIT is off for them.
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local jit = off`);
    const count = async () =>
      Number(
        rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from items i where ${whereSql}`))[0]?.n ?? 0,
      );
    if (p.countOnly) return { ids: [], total: await count() };

    const order: SQL[] = newestFileAt
      ? [sql`${newestFileAt} desc`]
      : p.byGroup === false
        ? []
        : [sql`coalesce(g.position, '') collate "C"`];
    for (const s of newestFileAt ? [] : p.plan.sort) {
      order.push(
        sql`${sortExpr(ctx, s.field)} ${s.direction === 'asc' ? sql`asc` : sql`desc`} ${s.nulls === 'first' ? sql`nulls first` : sql`nulls last`}`,
      );
    }
    order.push(sql`${I}.position collate "C"`, sql`${I}.id collate "C"`);
    if (p.withGroups) {
      // Every match at once (a windowed board's outline): the total is the row count — no window aggregate,
      // which doubled the time on 30k rows — and the sort of long position keys stays in memory, not on disk.
      await tx.execute(sql`set local work_mem = '64MB'`);
      const all = rows<{ id: string; group_id: string | null }>(
        await tx.execute(sql`
          select ${I}.id as id, ${I}.group_id as group_id from items i left join groups g on g.id = ${I}.group_id
          where ${whereSql}
          order by ${sql.join(order, sql`, `)}
          limit ${p.limit} offset ${p.offset}`),
      );
      return { ids: all.map((r) => r.id), total: p.offset + all.length, groups: all.map((r) => r.group_id) };
    }
    // One pass for the page and the total; a page past the end has no rows to carry it, so count separately.
    const page = rows<{ id: string; total: number }>(
      await tx.execute(sql`
        select ${I}.id as id, count(*) over ()::int as total from items i left join groups g on g.id = ${I}.group_id
        where ${whereSql}
        order by ${sql.join(order, sql`, `)}
        limit ${p.limit} offset ${p.offset}`),
    );
    return { ids: page.map((r) => r.id), total: page.length ? Number(page[0]!.total) : await count() };
  });
};

/** Teams of an account with their members — people filters expand `team:<id>` and a user's own teams. */
export const accountTeams = async (db: Db, accountId: string) => {
  const rows = await db
    .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(teams, and(eq(teams.id, teamMembers.teamId), isNull(teams.deletedAt)))
    .where(eq(teamMembers.accountId, accountId));
  const byTeam = new Map<string, string[]>();
  for (const r of rows) byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r.userId]);
  return [...byTeam].map(([id, member_ids]) => ({ id, member_ids }));
};
