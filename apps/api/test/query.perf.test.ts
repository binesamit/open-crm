// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes, newId, parseCellValue, planQuery, querySchema, rankBetween } from '@bines/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, schema, type Db } from '../src/db/client';
import { accounts, boards, cells, columns, groups, items, workspaces } from '../src/db/schema';
import { queryBoardItems } from '../src/modules/items/query.repo';
import { columns as fixtureColumns } from '../../../packages/shared/test/query-fixtures';

/**
 * M2 DoD (13-FILTERS §6): a 3-level query over 10k items answers in < 150 ms on real Postgres.
 * Opt-in — needs a server: `PERF_DATABASE_URL=postgres://bines:bines@localhost:5433/postgres pnpm --filter @bines/api test query.perf`.
 * Creates and drops its own database.
 */
const url = process.env.PERF_DATABASE_URL;
const DB_NAME = `bines_perf_${Date.now()}`;
const N = 10_000;

let admin: pg.Client;
let pool: pg.Pool;
let db: Db;
const accountId = newId();
const boardId = newId();
const columnIds = new Map<string, string>();

describe.skipIf(!url)('items/query performance (10k items, real Postgres)', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${DB_NAME}`);
    const u = new URL(url!);
    u.pathname = `/${DB_NAME}`;
    pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
    db = drizzle(pool, { schema }) as unknown as Db;
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });

    const wsId = newId();
    await db.insert(accounts).values({ id: accountId, slug: 'perf', name: 'Perf' });
    await db.insert(workspaces).values({ id: wsId, accountId, name: 'WS', position: rankBetween(null, null) });
    await db
      .insert(boards)
      .values({ id: boardId, accountId, workspaceId: wsId, name: 'Perf', position: rankBetween(null, null) });
    const groupIds = Array.from({ length: 5 }, () => newId());
    let gp: string | null = null;
    for (const [i, id] of groupIds.entries()) {
      gp = rankBetween(gp, null);
      await db.insert(groups).values({ id, accountId, boardId, title: `G${i}`, position: gp });
    }
    let cp: string | null = null;
    for (const c of fixtureColumns) {
      const id = newId();
      columnIds.set(c.id, id);
      cp = rankBetween(cp, null);
      await db
        .insert(columns)
        .values({ id, accountId, boardId, key: c.id, type: c.type, title: c.id, settings: c.settings, position: cp });
    }

    const users = ['u1', 'u2', 'u3', 'u4'];
    const settingsOf = (key: string) => {
      const c = fixtureColumns.find((x) => x.id === key)!;
      return { ...(columnTypes.get(c.type)!.defaultSettings as object), ...c.settings };
    };
    const typeOf = (key: string) => columnTypes.get(fixtureColumns.find((x) => x.id === key)!.type)!;
    let pos: string | null = null;
    for (let start = 0; start < N; start += 1000) {
      const itemRows: (typeof items.$inferInsert)[] = [];
      const cellRows: (typeof cells.$inferInsert)[] = [];
      for (let i = start; i < start + 1000; i++) {
        const id = newId();
        pos = rankBetween(pos, null);
        itemRows.push({ id, accountId, boardId, groupId: groupIds[i % 5]!, position: pos, name: `Item ${i}` });
        const values: Record<string, unknown> = {
          status: { index: [0, 1, 2, 5][i % 4] },
          tags: { ids: [1 + (i % 3)] },
          owner: { persons_and_teams: [{ id: users[i % 4], kind: 'person' }] },
          amount: (i * 37) % 1000,
          due: { date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` },
          note: `note ${i % 100}`,
        };
        for (const [key, raw] of Object.entries(values)) {
          const parsed = parseCellValue(typeOf(key), settingsOf(key), raw);
          if (!parsed.ok) throw new Error(`${key}: ${parsed.error}`);
          cellRows.push({
            itemId: id,
            columnId: columnIds.get(key)!,
            accountId,
            boardId,
            value: parsed.value as Record<string, never>,
            ...parsed.derived,
          });
        }
      }
      await db.insert(items).values(itemRows);
      await db.insert(cells).values(cellRows);
    }
    await pool.query('analyze');
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${DB_NAME}`);
    await admin?.end();
  });

  it('answers a 3-level query in < 150 ms', async () => {
    const q = querySchema.parse({
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [
          {
            kind: 'group',
            operator: 'or',
            rules: [
              { column_id: 'status', operator: 'any_of', values: ['חדש'] },
              {
                kind: 'group',
                operator: 'and',
                rules: [
                  { column_id: 'amount', operator: 'greater_than', values: [500] },
                  { column_id: 'due', operator: 'any_of', values: ['THIS_MONTH', 'PAST'] },
                ],
              },
            ],
          },
          {
            kind: 'group',
            operator: 'and',
            negate: true,
            rules: [{ column_id: 'owner', operator: 'any_of', values: ['user:u2'] }],
          },
        ],
      },
      search: 'item',
      sort: [{ column_id: 'amount', direction: 'desc' }],
    });
    const plan = planQuery(q, {
      columns: fixtureColumns,
      meId: 'u1',
      today: '2026-10-07',
      timezone: 'Asia/Jerusalem',
      weekend: 'fri_sat',
      firstDay: 0,
    });
    const run = () =>
      queryBoardItems(db, { accountId, boardId, plan, columnIds, timezone: 'Asia/Jerusalem', offset: 0, limit: 100 });
    await run(); // warm up
    const times: number[] = [];
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      total = (await run()).total;
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[3]!;
    console.warn(
      `10k items, 3-level query: ${total} matches, median ${median.toFixed(1)} ms (${times.map((t) => t.toFixed(0)).join(', ')})`,
    );
    expect(total).toBeGreaterThan(0);
    expect(median).toBeLessThan(150);
  });
});
