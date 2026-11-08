// SPDX-License-Identifier: AGPL-3.0-only
import { type SQL, sql } from 'drizzle-orm';
import type { Db } from './client';

/** Rows per statement: one array parameter per column, so only memory bounds it. */
const ROWS_PER_STATEMENT = 5000;

/**
 * Many rows in a few statements (bulk edit / file import of thousands of rows): `insert … select * from
 * unnest($1::t1[], $2::t2[], …)` sends one array per column — a dozen parameters instead of one per value, which
 * is what made multi-row VALUES inserts slow to build and parse. `cols` = [column, Postgres element type]; each row
 * gives the values in that order (null allowed; jsonb as a JSON string). Sent as text arrays and cast, which
 * every driver serializes alike (PGlite does not know arrays of our enums). `suffix` e.g. `on conflict do nothing`.
 * For repositories only (raw SQL stays in `repositories/`, CLAUDE.md rule 8).
 */
export const insertUnnest = async (
  db: Db,
  table: string,
  cols: [string, string][],
  rows: unknown[][],
  suffix: SQL = sql``,
) => {
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const part = rows.slice(i, i + ROWS_PER_STATEMENT);
    const arrays = cols.map(
      ([, type], c) =>
        sql`${sql.param(part.map((r) => (r[c] === undefined || r[c] === null ? null : String(r[c]))))}::text[]::${sql.raw(type)}[]`,
    );
    await db.execute(
      sql`insert into ${sql.identifier(table)} (${sql.join(
        cols.map(([name]) => sql.identifier(name)),
        sql`, `,
      )}) select * from unnest(${sql.join(arrays, sql`, `)}) ${suffix}`,
    );
  }
};
