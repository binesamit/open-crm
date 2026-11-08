// SPDX-License-Identifier: AGPL-3.0-only
import { newId, rankBetween } from '@bines/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { runMigrations } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, schema, type Db } from '../src/db/client';
import { accounts, automations, boards, columns, groups, itemLinks, items, users, workspaces } from '../src/db/schema';
import { recordEvent, recordEvents } from '../src/modules/activity/activity.repo';

/**
 * Migration 0046: the dispatch trigger queues an `automation.dispatch` job only for events something can hear —
 * not for every event of an account that has a listener somewhere (a bulk edit on a quiet board flooded the queue).
 * Needs graphile-worker's schema, so real Postgres. Opt-in:
 * `PERF_DATABASE_URL=postgres://bines:bines@localhost:5433/postgres pnpm --filter @bines/api test dispatch-listeners`.
 * Creates and drops its own database.
 */
const url = process.env.PERF_DATABASE_URL;
const DB_NAME = `bines_dispatch_${Date.now()}`;

let admin: pg.Client;
let pool: pg.Pool;
let db: Db;
const accountId = newId();
const userId = newId();
const ids = { listened: newId(), quiet: newId(), sub: newId(), ai: newId(), linking: newId() };
const linkedItem = newId();

const jobs = async () =>
  (
    await pool.query<{ n: number }>(
      "select count(*)::int as n from graphile_worker.jobs where task_identifier = 'automation.dispatch'",
    )
  ).rows[0]!.n;
const queued = async (fn: () => Promise<unknown>) => {
  const before = await jobs();
  await fn();
  return (await jobs()) - before;
};
const event = (boardId: string, type = 'cell.changed', meta: Record<string, unknown> = { column_type: 'text' }) => ({
  accountId,
  type,
  actorId: userId,
  boardId,
  itemId: newId(),
  meta,
});

describe.skipIf(!url)('automation dispatch trigger: only events something listens to (real Postgres)', () => {
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
    await db.insert(accounts).values({ id: accountId, slug: 'disp', name: 'Dispatch' });
    await db.insert(users).values({ id: userId, email: 'disp@x.test', name: 'D' });
    await db.insert(workspaces).values({ id: wsId, accountId, name: 'WS', position: rankBetween(null, null) });
    const board = (id: string, parentBoardId?: string) => ({
      id,
      accountId,
      workspaceId: wsId,
      name: id,
      position: rankBetween(null, null),
      ...(parentBoardId ? { parentBoardId } : {}),
    });
    await db.insert(boards).values([board(ids.listened), board(ids.quiet), board(ids.ai), board(ids.linking)]);
    await db.insert(boards).values(board(ids.sub, ids.listened));
    const automation = (boardId: string, trigger: Record<string, unknown>) => ({
      id: newId(),
      accountId,
      boardId,
      title: 'A',
      recipe: { trigger, conditions: [], actions: [] },
    });
    await db
      .insert(automations)
      .values([
        automation(ids.listened, { type: 'item_created' }),
        automation(ids.linking, { type: 'connected_items_all_done', column: 'rel' }),
      ]);
    await db.insert(columns).values({
      id: newId(),
      accountId,
      boardId: ids.ai,
      key: 'summary',
      type: 'ai',
      title: 'AI',
      settings: { auto_run: true },
      position: rankBetween(null, null),
    });
    // An item of the quiet board, linked from the board with a "connected items all done" automation.
    const relCol = newId();
    await db.insert(columns).values({
      id: relCol,
      accountId,
      boardId: ids.linking,
      key: 'rel',
      type: 'board_relation',
      title: 'Rel',
      settings: {},
      position: rankBetween(null, null),
    });
    const groupQuiet = newId();
    const groupLinking = newId();
    await db.insert(groups).values([
      { id: groupQuiet, accountId, boardId: ids.quiet, title: 'G', position: rankBetween(null, null) },
      { id: groupLinking, accountId, boardId: ids.linking, title: 'G', position: rankBetween(null, null) },
    ]);
    const fromItem = newId();
    await db.insert(items).values([
      { id: linkedItem, accountId, boardId: ids.quiet, groupId: groupQuiet, name: 'x', position: 'a' },
      { id: fromItem, accountId, boardId: ids.linking, groupId: groupLinking, name: 'y', position: 'a' },
    ] as never);
    await db
      .insert(itemLinks)
      .values({ id: newId(), accountId, columnId: relCol, fromItemId: fromItem, toItemId: linkedItem, position: 'a' });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin?.end();
  });

  it('queues the events of a board with an automation, and of its sub-board', async () => {
    expect(await queued(() => recordEvent(db, event(ids.listened)))).toBe(1);
    expect(await queued(() => recordEvent(db, event(ids.sub)))).toBe(1);
  });

  it('queues nothing for a board nobody listens to — also for a bulk edit', async () => {
    expect(await queued(() => recordEvent(db, event(ids.quiet)))).toBe(0);
    const bulk = Array.from({ length: 500 }, () => event(ids.quiet));
    expect(await queued(() => recordEvents(db, bulk))).toBe(0);
    // …in the same statement as heard events: only those.
    expect(await queued(() => recordEvents(db, [...bulk.slice(0, 10), event(ids.listened)]))).toBe(1);
    // Events without a board never reach an automation.
    expect(await queued(() => recordEvent(db, { accountId, type: 'item.created', actorId: userId }))).toBe(0);
  });

  it('queues the inputs of an auto-run AI column on its board', async () => {
    expect(await queued(() => recordEvent(db, event(ids.ai)))).toBe(1);
    expect(await queued(() => recordEvent(db, event(ids.ai, 'update.edited')))).toBe(0);
  });

  it('queues a status change of an item linked from a board with an automation', async () => {
    const status = { ...event(ids.quiet, 'cell.changed', { column_type: 'status' }), itemId: linkedItem };
    expect(await queued(() => recordEvent(db, status))).toBe(1);
    expect(await queued(() => recordEvent(db, { ...status, meta: { column_type: 'text' } }))).toBe(0);
  });

  it('keeps the account-wide rule for an item moved to another board', async () => {
    expect(await queued(() => recordEvent(db, event(ids.quiet, 'item.moved_to_board', {})))).toBe(1);
  });
});
