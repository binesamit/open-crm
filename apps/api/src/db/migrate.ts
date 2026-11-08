// SPDX-License-Identifier: AGPL-3.0-only
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createDb, MIGRATIONS_DIR } from './client';
import type * as schema from './schema';

/** `pnpm db:migrate` locally; Railway runs `node dist/migrate.js` as the api pre-deploy command. */
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env: rely on the environment
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: DATABASE_URL is not set');
  process.exit(1);
}

const { db, close } = createDb(url);
try {
  await migrate(db as NodePgDatabase<typeof schema>, { migrationsFolder: MIGRATIONS_DIR });
  console.warn('migrate: done');
} finally {
  await close();
}
