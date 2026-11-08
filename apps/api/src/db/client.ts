// SPDX-License-Identifier: AGPL-3.0-only
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

/** Driver-agnostic handle: node-postgres in dev/prod, PGlite in tests. Repositories depend only on this. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle = { db: Db; close: () => Promise<void> };

/**
 * A connection that runs its queries one after another. Inside a transaction every query shares one connection,
 * and code that awaits several at once (`Promise.all` over a `tx`, e.g. `loadBoardAccess`) relied on pg queueing
 * them — deprecated in pg@8 ("client.query() when the client is already executing"), an error in pg@9. The queue
 * is per connection: queries outside a transaction still run in parallel on the pool. Callback / submittable calls
 * (pg's own) pass through untouched.
 */
export class SerialClient extends pg.Client {
  private tail: Promise<unknown> = Promise.resolve();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg's query() has many overloads
  override query(...args: any[]): any {
    const base = super.query.bind(this) as (...a: unknown[]) => unknown;
    const first = args[0] as { submit?: unknown } | undefined;
    if (args.some((a) => typeof a === 'function') || typeof first?.submit === 'function') return base(...args);
    const run = () => base(...args);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export const createDb = (connectionString: string): DbHandle => {
  const pool = new pg.Pool({ connectionString, max: 10, Client: SerialClient });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
};

/** Migrations live in apps/api/drizzle; every script runs with cwd = apps/api (pnpm --filter). */
export const MIGRATIONS_DIR = 'drizzle';

export { schema };
