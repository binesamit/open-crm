// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS_DIR, schema, type Db } from './client';

/**
 * The embedded database of standalone mode (docs/SELF-HOSTING.md "Install in 1 minute"): PGlite — Postgres compiled
 * to WebAssembly, the same engine the test suite runs on — persisted in a folder (`$DATA_DIR/db`). One connection,
 * one process: the api and the job runner share it (src/standalone.ts). Postgres stays the way to scale.
 */
export const openEmbeddedDb = async (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const pg = await PGlite.create(dir, { extensions: { pg_trgm } });
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { pg, db, close: () => pg.close() };
};

/** The same migrations as Postgres (apps/api/drizzle), applied at every boot; already-applied ones are skipped. */
export const migrateEmbedded = (db: Db) =>
  migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_DIR });
