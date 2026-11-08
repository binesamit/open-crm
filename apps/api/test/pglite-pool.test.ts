// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runOnce, type Task } from 'graphile-worker';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseListen, type PgliteClient, PglitePool } from '../src/db/pglite-pool';
import { ensureInstanceSecrets } from '../src/lib/instance-secrets';

/**
 * Standalone mode's embedded database: the pg-pool look-alike over one PGlite that graphile-worker (the job queue) and
 * the worker's plain-SQL repositories run on.
 */
let pg: PGlite;
let pool: PglitePool;

beforeAll(async () => {
  pg = await PGlite.create();
  pool = new PglitePool(pg);
  await pg.exec('create table t (id int primary key, n bigint)');
});
afterAll(async () => {
  await pool.end();
  await pg.close();
});

describe('PglitePool', () => {
  it('reads values like node-postgres (bigint and numeric as strings), takes several statements unparameterised', async () => {
    await pool.query('insert into t values ($1, $2)', [1, '9007199254740993']);
    const { rows, rowCount } = await pool.query({
      text: 'select n, 1.50::numeric as x from t where id = $1',
      values: [1],
    });
    expect(rowCount).toBe(1);
    expect(rows[0]).toEqual({ n: '9007199254740993', x: '1.50' });
    const last = await pool.query('select 1 as a; select 2 as b');
    expect(last.rows).toEqual([{ b: 2 }]);
  });

  it("a client's transaction is isolated and holds the database until it ends", async () => {
    const a = await pool.connect();
    await a.query('begin');
    await a.query('insert into t values (2, 2)');
    let outsideDone = false;
    // Outside queries wait for the transaction (one connection): they see the result only after COMMIT.
    const outside = pool.query('select count(*) as c from t').then((r) => {
      outsideDone = true;
      return r.rows[0]!.c;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(outsideDone).toBe(false);
    await a.query('commit');
    expect(await outside).toBe('2');
    await a.release();

    const b = await pool.connect();
    await b.query('BEGIN');
    await b.query('insert into t values (3, 3)');
    await b.query('ROLLBACK');
    await b.release();
    expect((await pool.query('select count(*) as c from t where id = 3')).rows[0]!.c).toBe('0');
  });

  it('a client released mid-transaction rolls back (never blocks the database)', async () => {
    const c = await pool.connect();
    await c.query('begin');
    await c.query('insert into t values (4, 4)');
    await c.release();
    expect((await pool.query('select count(*) as c from t where id = 4')).rows[0]!.c).toBe('0');
  });

  it('LISTEN on a client hears NOTIFY from anywhere; the callback form of connect works', async () => {
    const heard: unknown[] = [];
    const client = await new Promise<PgliteClient>((resolve, reject) =>
      pool.connect((err, cl) => (err || !cl ? reject(err) : resolve(cl))),
    );
    client.on('notification', (m: { channel: string; payload: string }) => heard.push(m));
    await client.query('LISTEN "jobs:insert"; LISTEN other;');
    await pool.query(`select pg_notify('jobs:insert', '{"count":1}')`);
    await pg.query(`select pg_notify('other', 'x')`);
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([
      expect.objectContaining({ channel: 'jobs:insert', payload: '{"count":1}' }),
      expect.objectContaining({ channel: 'other', payload: 'x' }),
    ]);
    await client.query('UNLISTEN "jobs:insert"');
    await pool.query(`select pg_notify('jobs:insert', 'y')`);
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toHaveLength(2);
    await client.release();
  });

  it('parses LISTEN statements, and nothing else', () => {
    expect(parseListen('LISTEN "jobs:insert"; UNLISTEN "worker:migrate";')).toEqual([
      ['listen', 'jobs:insert'],
      ['unlisten', 'worker:migrate'],
    ]);
    expect(parseListen('listen Bines_Events')).toEqual([['listen', 'bines_events']]);
    expect(parseListen('select 1')).toBeNull();
    expect(parseListen('LISTEN a; select 1')).toBeNull();
  });

  it('graphile-worker installs its schema and runs a job on it', async () => {
    const seen: unknown[] = [];
    const task: Task = async (payload) => {
      seen.push(payload);
    };
    const pgPool = pool as unknown as Pool;
    pool.on('error', () => undefined);
    pool.on('connect', () => undefined);
    // First run installs graphile-worker's schema (its migrations: plpgsql, triggers, SKIP LOCKED).
    await runOnce({ pgPool, taskList: { hello: task } });
    await pool.query(`select graphile_worker.add_job('hello', '{"n":1}'::json)`);
    await runOnce({ pgPool, taskList: { hello: task } });
    expect(seen).toEqual([{ n: 1 }]);
    const left = await pool.query('select count(*) as c from graphile_worker.jobs');
    expect(left.rows[0]!.c).toBe('0');
  });
});

describe('instance secrets', () => {
  it('made once, kept in the data folder, reused; the environment wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bines-data-'));
    try {
      const env: NodeJS.ProcessEnv = {};
      const first = ensureInstanceSecrets(dir, env);
      expect(first.generated.sort()).toEqual(['BETTER_AUTH_SECRET', 'SECRET_MASTER_KEY']);
      expect(env.BETTER_AUTH_SECRET!.length).toBeGreaterThanOrEqual(32);
      expect(Buffer.from(env.SECRET_MASTER_KEY!, 'base64')).toHaveLength(32);
      if (process.platform !== 'win32') expect(statSync(first.file).mode & 0o777).toBe(0o600);

      const again: NodeJS.ProcessEnv = {};
      expect(ensureInstanceSecrets(dir, again).generated).toEqual([]);
      expect(again.BETTER_AUTH_SECRET).toBe(env.BETTER_AUTH_SECRET);

      const own: NodeJS.ProcessEnv = { BETTER_AUTH_SECRET: 'from-the-environment-0123456789abcdef' };
      ensureInstanceSecrets(dir, own);
      expect(own.BETTER_AUTH_SECRET).toBe('from-the-environment-0123456789abcdef');
      expect(own.SECRET_MASTER_KEY).toBe(env.SECRET_MASTER_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
