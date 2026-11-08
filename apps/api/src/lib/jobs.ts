// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

const hasWorker = async (db: Db) => {
  const res = (await db.execute(sql`select to_regnamespace('graphile_worker') is not null as ok`)) as {
    rows: { ok: boolean }[];
  };
  return !!res.rows[0]?.ok;
};

/**
 * Queues a graphile-worker job when the worker's schema exists (prod, dev); tests drive the engine by hand.
 * `queueName`: jobs of one named queue run one at a time, in order (graphile's job queues). `jobKey`: at most one
 * waiting job per key — a new one replaces it (a locked, running one stays and the new one waits behind it).
 */
export const enqueueJob = async (
  db: Db,
  task: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; maxAttempts?: number; queueName?: string; jobKey?: string } = {},
) => {
  if (!(await hasWorker(db))) return false;
  await db.execute(
    sql`select graphile_worker.add_job(${task}, ${JSON.stringify(payload)}::json, queue_name => ${opts.queueName ?? null}::text, run_at => ${(opts.runAt ?? new Date()).toISOString()}::timestamptz, max_attempts => ${opts.maxAttempts ?? 3}, job_key => ${opts.jobKey ?? null}::text)`,
  );
  return true;
};

/**
 * A job with this key waits or runs now (false without the worker's schema). A job locked longer ago than
 * `staleMs` counts as gone (its process died; graphile frees it only hours later).
 */
export const jobKeyLive = async (db: Db, key: string, staleMs: number) => {
  if (!(await hasWorker(db))) return false;
  const res = (await db.execute(
    sql`select 1 from graphile_worker.jobs where key = ${key} and (locked_at is null or locked_at > now() - make_interval(secs => ${staleMs / 1000})) limit 1`,
  )) as { rows: unknown[] };
  return res.rows.length > 0;
};
