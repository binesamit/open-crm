// SPDX-License-Identifier: AGPL-3.0-only
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AppError } from '@bines/shared';
import type { Db } from '../../db/client';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';

/**
 * What the support agent may read from the database — an ALLOW-LIST, the one source for both
 * `describe_record` and `query_data`. Whatever a tool returns goes to an AI provider, so:
 *
 * - Only the tables and columns below exist for the agent. Never sessions, verifications, auth accounts / password
 *   hashes, API tokens, sealed secrets or connection keys, webhook secrets, 2FA, OAuth tokens, form passwords, mail
 *   bodies, document contents — none of those tables or columns are listed, and nothing is read by `select *`.
 * - The model never writes SQL. `query_data` takes a table, columns, filters, grouping and a limit — each name checked
 *   against this list — and the statement is built here with identifiers and bound values: no functions, no
 *   sub-queries, no second statement, nothing to trick.
 * - It runs in a READ ONLY transaction with a 5-second statement timeout.
 * - `m` = metadata (ids, statuses, counts, times): always shown, and the only columns a filter, a grouping or an order
 *   may use (no guessing a customer's text through a filter). `c` = an account's content (names, titles, error text):
 *   shown only while the person who started the run has access to that row's account (a support grant or a
 *   membership); a row with content asked for and no account is dropped.
 * - Every query is in the platform's audit log with its statement.
 */
type Kind = 'm' | 'c';
type TableRule = { account: string | null; columns: Record<string, Kind> };

const meta = (...names: string[]) => Object.fromEntries(names.map((n) => [n, 'm' as const]));
const content = (...names: string[]) => Object.fromEntries(names.map((n) => [n, 'c' as const]));

export const DATA_TABLES: Record<string, TableRule> = {
  accounts: {
    account: 'id',
    columns: {
      ...meta('id', 'plan', 'status', 'suspended_at', 'origin', 'created_at', 'updated_at', 'deleted_at'),
      ...content('slug', 'name'),
    },
  },
  account_members: {
    account: 'account_id',
    columns: meta(
      'id',
      'account_id',
      'user_id',
      'role',
      'status',
      'invited_at',
      'joined_at',
      'deactivated_at',
      'created_at',
    ),
  },
  users: {
    account: null,
    columns: meta(
      'id',
      'locale',
      'is_platform_owner',
      'is_service',
      'two_factor_enabled',
      'last_seen_at',
      'created_at',
    ),
  },
  workspaces: {
    account: 'account_id',
    columns: {
      ...meta('id', 'account_id', 'kind', 'created_at', 'updated_at', 'archived_at', 'deleted_at'),
      ...content('name'),
    },
  },
  boards: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'workspace_id',
        'folder_id',
        'parent_board_id',
        'kind',
        'hierarchy_depth_max',
        'permission_set',
        'view_items',
        'created_at',
        'updated_at',
        'archived_at',
        'deleted_at',
      ),
      ...content('name'),
    },
  },
  groups: {
    account: 'account_id',
    columns: {
      ...meta('id', 'account_id', 'board_id', 'created_at', 'updated_at', 'archived_at', 'deleted_at'),
      ...content('title'),
    },
  },
  items: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'board_id',
        'group_id',
        'parent_item_id',
        'root_item_id',
        'depth',
        'child_count',
        'creator_type',
        'last_cell_change_at',
        'created_at',
        'updated_at',
        'archived_at',
        'deleted_at',
      ),
      ...content('name'),
    },
  },
  columns: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'board_id',
        'type',
        'is_required',
        'converting_id',
        'created_at',
        'archived_at',
        'deleted_at',
      ),
      ...content('key', 'title'),
    },
  },
  automations: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'board_id',
        'is_active',
        'run_count',
        'last_run_at',
        'last_error_at',
        'consecutive_errors',
        'created_at',
        'updated_at',
        'deleted_at',
      ),
      ...content('deactivated_reason', 'title'),
    },
  },
  automation_runs: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'automation_id',
        'item_id',
        'status',
        'skip_reason',
        'depth',
        'event_type',
        'started_at',
        'finished_at',
        'created_at',
      ),
      ...content('error'),
    },
  },
  agents: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'is_active',
        'model',
        'effort',
        'approval_mode',
        'created_at',
        'updated_at',
        'deleted_at',
      ),
      ...content('name'),
    },
  },
  agent_runs: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'agent_id',
        'trigger',
        'item_id',
        'dry_run',
        'status',
        'skip_reason',
        'model',
        'steps',
        'tool_calls',
        'cost_usd',
        'started_at',
        'finished_at',
        'created_at',
      ),
      ...content('error'),
    },
  },
  webhooks: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'board_id',
        'event_type',
        'is_active',
        'failure_count',
        'created_at',
        'updated_at',
        'deleted_at',
      ),
      // Free text (a delivery's error): content.
      ...content('disabled_reason'),
    },
  },
  webhook_deliveries: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'webhook_id',
        'automation_id',
        'event_type',
        'status',
        'attempt',
        'response_status',
        'response_ms',
        'next_attempt_at',
        'delivered_at',
        'created_at',
      ),
      ...content('error'),
    },
  },
  error_events: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'source',
        'code',
        'severity',
        'count',
        'status',
        'first_seen_at',
        'last_seen_at',
        'muted_until',
        'resolved_at',
        'reopened_count',
        'ticket_id',
      ),
      ...content('message'),
    },
  },
  import_jobs: {
    account: 'account_id',
    columns: {
      ...meta('id', 'account_id', 'source', 'status', 'started_at', 'finished_at', 'created_at'),
      ...content('error'),
    },
  },
  ai_usage: {
    account: 'account_id',
    columns: meta(
      'account_id',
      'day',
      'source',
      'connection_id',
      'model',
      'calls',
      'input_tokens',
      'output_tokens',
      'cost_usd',
    ),
  },
  support_tickets: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'number',
        'account_id',
        'status',
        'priority',
        'assignee_id',
        'created_at',
        'updated_at',
        'solved_at',
        'closed_at',
        'deleted_at',
      ),
      ...content('subject'),
    },
  },
  forms: {
    account: 'account_id',
    columns: {
      ...meta('id', 'account_id', 'board_id', 'is_active', 'require_login', 'created_at', 'updated_at'),
      ...content('title'),
    },
  },
  docs: {
    account: 'account_id',
    columns: {
      ...meta(
        'id',
        'account_id',
        'workspace_id',
        'kind',
        'board_id',
        'item_id',
        'created_at',
        'updated_at',
        'archived_at',
        'deleted_at',
      ),
      ...content('host', 'name'),
    },
  },
};
export const DATA_TABLE_NAMES = Object.keys(DATA_TABLES) as [string, ...string[]];

export const DATA_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'not_null'] as const;
export type DataFilter = {
  column: string;
  op: (typeof DATA_OPS)[number];
  value?: string | number | boolean | (string | number)[];
};
export type DataQuery = {
  table: string;
  columns: string[];
  filters?: DataFilter[];
  group_by?: string[];
  count?: boolean;
  order_by?: { column: string; dir?: 'asc' | 'desc' };
  limit?: number;
};

export const MAX_ROWS = 200;
const ACCOUNT_ALIAS = '__account';

const ruleOf = (table: string) => {
  const rule = Object.hasOwn(DATA_TABLES, table) ? DATA_TABLES[table] : undefined;
  if (!rule) throw new AppError('invalid_value', 'data_table_not_allowed', { table });
  return rule;
};
const mustColumn = (rule: TableRule, column: string, metaOnly: boolean) => {
  const kind = Object.hasOwn(rule.columns, column) ? rule.columns[column] : undefined;
  if (!kind) throw new AppError('invalid_value', 'data_column_not_allowed', { column });
  if (metaOnly && kind !== 'm') throw new AppError('invalid_value', 'data_column_metadata_only', { column });
  return kind;
};
const id = (name: string) => sql.identifier(name);

const condition = (f: DataFilter): SQL => {
  const col = id(f.column);
  const v = f.value;
  switch (f.op) {
    case 'is_null':
      return sql`${col} is null`;
    case 'not_null':
      return sql`${col} is not null`;
    case 'in': {
      const list = (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined).slice(0, 100);
      if (!list.length) throw new AppError('invalid_value', 'data_filter_value');
      return sql`${col} in (${sql.join(
        list.map((x) => sql`${x}`),
        sql`, `,
      )})`;
    }
    default: {
      if (v === undefined || Array.isArray(v)) throw new AppError('invalid_value', 'data_filter_value');
      const op = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
      return sql`${col} ${sql.raw(op)} ${v}`;
    }
  }
};

/** The statement for a query — every name from the allow-list, every value bound. Exported for the audit and tests. */
export const buildDataQuery = (q: DataQuery): { statement: SQL; contentAsked: boolean; rule: TableRule } => {
  const rule = ruleOf(q.table);
  const filters = (q.filters ?? []).slice(0, 10);
  for (const f of filters) mustColumn(rule, f.column, true);
  const where = filters.length ? sql` where ${sql.join(filters.map(condition), sql` and `)}` : sql``;
  const limit = Math.min(MAX_ROWS, Math.max(1, q.limit ?? 50));
  if (q.group_by?.length || q.count) {
    // Counts: only metadata columns, so a count never reveals content.
    const by = (q.group_by ?? []).slice(0, 4);
    for (const c of by) mustColumn(rule, c, true);
    const cols = [...by.map((c) => id(c)), sql`count(*)::int as ${id('count')}`];
    const groupBy = by.length ? sql` group by ${sql.join(by.map(id), sql`, `)}` : sql``;
    const orderBy = by.length ? sql` order by ${id('count')} desc` : sql``;
    return {
      statement: sql`select ${sql.join(cols, sql`, `)} from ${id(q.table)}${where}${groupBy}${orderBy} limit ${limit}`,
      contentAsked: false,
      rule,
    };
  }
  const columns = [...new Set(q.columns)].slice(0, 20);
  if (!columns.length) throw new AppError('invalid_value', 'data_columns_required');
  const contentAsked = columns.map((c) => mustColumn(rule, c, false)).some((k) => k === 'c');
  const select: SQL[] = columns.map((c) => sql`${id(c)}`);
  // Content needs each row's account (to check access) — read under a private alias, never shown.
  if (contentAsked && rule.account) select.push(sql`${id(rule.account)} as ${id(ACCOUNT_ALIAS)}`);
  let orderBy = sql``;
  if (q.order_by) {
    mustColumn(rule, q.order_by.column, true);
    orderBy = sql` order by ${id(q.order_by.column)} ${sql.raw(q.order_by.dir === 'asc' ? 'asc' : 'desc')}`;
  }
  return {
    statement: sql`select ${sql.join(select, sql`, `)} from ${id(q.table)}${where}${orderBy} limit ${limit}`,
    contentAsked,
    rule,
  };
};

const dialect = new PgDialect();

/**
 * Runs a query read-only and returns its rows with content filtered by access. `hasAccess(accountId)` is the run's
 * requester's access to an account. `mask` cleans any text that leaves.
 */
export const runDataQuery = async (
  db: Db,
  q: DataQuery,
  ctx: {
    runId: string;
    actorId: string | null;
    hasAccess: (accountId: string) => Promise<boolean>;
    mask: (v: unknown) => unknown;
  },
) => {
  const { statement, contentAsked, rule } = buildDataQuery(q);
  const text = dialect.sqlToQuery(statement).sql;
  await insertPlatformAudit(db, {
    action: 'support_agent.query',
    targetType: 'table',
    targetId: q.table.slice(0, 64),
    actorId: ctx.actorId,
    payload: { run_id: ctx.runId, query: q, sql: text.slice(0, 2000) },
  });
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`set local statement_timeout = 5000`);
    return ((await tx.execute(statement)) as { rows: Record<string, unknown>[] }).rows;
  });
  const access = new Map<string, boolean>();
  const out: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const row of rows) {
    const accountId = (row[ACCOUNT_ALIAS] as string | null | undefined) ?? null;
    if (contentAsked && !accountId) {
      // Content asked for, and the row has no account to check: never passed on.
      dropped += 1;
      continue;
    }
    if (accountId && !access.has(accountId)) access.set(accountId, await ctx.hasAccess(accountId));
    const full = !!accountId && access.get(accountId) === true;
    const shown: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (column === ACCOUNT_ALIAS) continue;
      const kind = column === 'count' ? 'm' : rule.columns[column];
      shown[column] = kind === 'm' || full ? ctx.mask(value) : '[hidden: no access]';
    }
    out.push(shown);
  }
  return { rows: out, ...(dropped ? { dropped_without_account: dropped } : {}) };
};

/** One row by id — the same allow-list (describe_record): metadata always, content with access. */
export const describeById = async (db: Db, table: string, rowId: string, ctx: Parameters<typeof runDataQuery>[2]) => {
  const rule = ruleOf(table);
  const columns = Object.keys(rule.columns);
  const { rows } = await runDataQuery(
    db,
    { table, columns, filters: [{ column: rule.columns.id ? 'id' : columns[0]!, op: 'eq', value: rowId }], limit: 1 },
    ctx,
  );
  return rows[0] ?? null;
};
