// SPDX-License-Identifier: AGPL-3.0-only
import { newId, rankBetween } from '@bines/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { runMigrations } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, schema, type Db } from '../src/db/client';
import { accounts, automations, boards, columns, groups, users, workspaces } from '../src/db/schema';
import type { BoardAccess } from '../src/modules/boards/boards.access';
import { type ColumnRow, listColumns } from '../src/modules/boards/boards.repo';
import { insertItemsBatch } from '../src/modules/bulk/bulk-insert';
import type { Actor } from '../src/modules/items/items.service';

/**
 * B3: 10,000 new rows of a file import as one batch insert on real Postgres — without and with an active
 * automation (then every event queues an `automation.dispatch` job, as for any write).
 * Opt-in: `PERF_DATABASE_URL=postgres://bines:bines@localhost:5433/postgres pnpm --filter @bines/api test bulk-insert.perf`.
 * Creates and drops its own database.
 */
const url = process.env.PERF_DATABASE_URL;
const DB_NAME = `bines_perf_bulk_${Date.now()}`;
const N = 10_000;

let admin: pg.Client;
let pool: pg.Pool;
let db: Db;
const accountId = newId();
const userId = newId();
const boardId = newId();
const groupId = newId();
let cols: ColumnRow[];

const actor = { ctx: { accountId, role: 'admin' }, user: { id: userId }, requestId: 'perf' } as unknown as Actor;
const access = { userId, teamIds: [], role: 'owner' } as unknown as BoardAccess;
const rows = (tag: string) =>
  Array.from({ length: N }, (_, i) => ({
    name: `${tag} ${i}`,
    groupId,
    cells: [
      [cols.find((c) => c.key === 't')!, `text ${i}`],
      [cols.find((c) => c.key === 'n')!, i],
      [cols.find((c) => c.key === 'd')!, { date: '2026-01-02' }],
    ] as [ColumnRow, unknown][],
  }));

describe.skipIf(!url)('bulk insert performance (10k rows, real Postgres)', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${DB_NAME}`);
    const u = new URL(url!);
    u.pathname = `/${DB_NAME}`;
    pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
    db = drizzle(pool, { schema }) as unknown as Db;
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    await runMigrations({ pgPool: pool });

    const wsId = newId();
    await db.insert(accounts).values({ id: accountId, slug: 'perf', name: 'Perf' });
    await db.insert(users).values({ id: userId, email: 'perf@x.test', name: 'Perf' });
    await db.insert(workspaces).values({ id: wsId, accountId, name: 'WS', position: rankBetween(null, null) });
    await db
      .insert(boards)
      .values({ id: boardId, accountId, workspaceId: wsId, name: 'B', position: rankBetween(null, null) });
    await db.insert(groups).values({ id: groupId, accountId, boardId, title: 'G', position: rankBetween(null, null) });
    let p: string | null = null;
    for (const [key, type] of [
      ['name', 'name'],
      ['t', 'text'],
      ['n', 'numbers'],
      ['d', 'date'],
    ]) {
      p = rankBetween(p, null);
      await db
        .insert(columns)
        .values({ id: newId(), accountId, boardId, key: key!, type: type!, title: key!, settings: {}, position: p });
    }
    cols = await listColumns(db, boardId);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin?.end();
  });

  const run = async (tag: string) => {
    const started = Date.now();
    const ids = await db.transaction((tx) => insertItemsBatch(tx, actor, access, boardId, rows(tag), newId()));
    const ms = Date.now() - started;
    expect(ids).toHaveLength(N);
    return ms;
  };

  it('inserts 10,000 rows (3 cells each) in a few seconds', async () => {
    const ms = await run('plain');
    console.warn(`bulk insert, no automations: ${N} rows in ${ms} ms`);
    expect(ms).toBeLessThan(10_000);
  }, 120_000);

  it('with an active automation in the account (a dispatch job per event)', async () => {
    await db.insert(automations).values({
      id: newId(),
      accountId,
      boardId,
      title: 'A',
      recipe: { trigger: { type: 'item_created' }, conditions: [], actions: [] },
    } as never);
    const ms = await run('auto');
    const jobs = (await pool.query('select count(*)::int as n from graphile_worker._private_jobs')).rows[0].n;
    console.warn(`bulk insert, with automations: ${N} rows in ${ms} ms (${jobs} dispatch jobs)`);
    expect(ms).toBeLessThan(20_000);
  }, 120_000);
});
