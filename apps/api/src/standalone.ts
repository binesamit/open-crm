// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { mailTransport } from '@bines/server-mail';
// The composition root of standalone mode: the maintenance worker's jobs join the api's runner (one process).
// eslint-disable-next-line no-restricted-imports -- the only place the api imports the worker (docs/DECISIONS.md D31)
import { cronItems as workerCron, taskList as workerTasks } from '@bines/worker/tasks';
import { createDb, MIGRATIONS_DIR } from './db/client';
import { ensureFirstAccount, firstAccountFromEnv, seedCatalog } from './db/bootstrap';
import { migrateEmbedded, openEmbeddedDb } from './db/embedded';
import { PglitePool } from './db/pglite-pool';
import type * as schema from './db/schema';
import { loadEnv } from './env';
import { ensureInstanceSecrets } from './lib/instance-secrets';
import { createLogger } from './lib/logger';
import { initMonitoring } from './lib/monitoring';
import { createListenBus, createPgBus } from './lib/realtime';
import { startAutomationRunner } from './modules/automations/jobs';
import { setupRequired } from './modules/setup/setup.service';
import { serveApp } from './serve';

/**
 * Standalone mode — the whole platform in one process, zero configuration (docs/SELF-HOSTING.md "Install in 1
 * minute"; the Docker image's default command):
 *
 *   docker run -it --rm -p 3000:3000 -v bines_data:/data <image>   →   open http://localhost:3000
 *
 * - Database: DATABASE_URL, else an embedded Postgres (PGlite) in `$DATA_DIR/db`; migrations run at every boot.
 * - Files: S3 when configured, else `$DATA_DIR/files` (served by the API through signed links).
 * - Secrets: from the environment, else made once and kept in `$DATA_DIR/secrets.json` (0600; never printed).
 * - The owner: created in the browser on first visit (modules/setup) — or SEED_ADMIN_EMAIL as in the compose setup.
 * - Jobs: the api's automation engine and the maintenance worker's jobs (trash, files, notifications, digests…)
 *   run in this process's job runner. PGlite is one connection, so this mode is one process: for more load or
 *   several replicas, use Postgres (DATABASE_URL) or the compose setup.
 */
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env file: rely on the environment
}

const dataDir = resolve(process.env.DATA_DIR?.trim() || 'data');
process.env.DATA_DIR = dataDir;
try {
  mkdirSync(dataDir, { recursive: true });
} catch (err) {
  console.error(`standalone: cannot use the data folder ${dataDir} (${(err as Error).message}) - mount a volume there`);
  process.exit(1);
}

let secrets: ReturnType<typeof ensureInstanceSecrets>;
try {
  secrets = ensureInstanceSecrets(dataDir);
} catch (err) {
  console.error(`standalone: ${(err as Error).message}`);
  process.exit(1);
}

// The address people open. Unset: a PaaS's public domain (Railway), else this machine; the first-run setup then
// saves the address the owner really used (AUTO_PUBLIC_ADDRESS), editable in the owner console.
const port = process.env.API_PORT || process.env.PORT || '3000';
if (!process.env.WEB_ORIGIN?.trim()) {
  const paas = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  process.env.WEB_ORIGIN = paas ? `https://${paas}` : `http://localhost:${port}`;
  process.env.AUTO_PUBLIC_ADDRESS = 'true';
}
const embedded = !process.env.DATABASE_URL?.trim();
const s3 = !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID);
if (!s3 && !process.env.FILES_DIR?.trim()) process.env.FILES_DIR = join(dataDir, 'files');

const env = loadEnv();
const logger = createLogger(env);
if (initMonitoring(env, 'api')) logger.info('error monitoring on');
logger.info(
  {
    data: dataDir,
    database: embedded ? 'embedded (PGlite)' : 'postgres (DATABASE_URL)',
    files: s3 ? 's3' : 'local disk',
  },
  'standalone mode',
);
// Names only — never a value.
if (secrets.generated.length) logger.info({ file: secrets.file, made: secrets.generated }, 'generated secrets');

const templatesDir = process.env.TEMPLATES_DIR ?? '../../seed/templates';

const database = embedded ? await openEmbedded() : await openPostgres();
// The built-in templates and catalog packs (idempotent); the first account and its admin invitation only when the
// owner is named in the environment — otherwise the first-run setup makes them.
await seedCatalog(database.db, { templatesDir });
if (env.SEED_ADMIN_EMAIL)
  await ensureFirstAccount(database.db, { ownerEmail: env.SEED_ADMIN_EMAIL, firstAccount: firstAccountFromEnv() });

await serveApp({
  env,
  logger,
  db: database.db,
  closeDb: database.close,
  bus: database.bus,
  startJobs:
    process.env.AUTOMATIONS === 'off'
      ? undefined
      : (deps) => startAutomationRunner(deps, database.queue, { tasks: workerTasks, cron: workerCron }),
  onListening: async (deps) => {
    if (mailTransport(process.env) === 'none')
      logger.info(
        'email is off: people sign in with a password and invitations give a link to copy. To send email set ' +
          'SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and EMAIL_FROM (see docs/SELF-HOSTING.md)',
      );
    if (await setupRequired(deps)) logger.info(`open ${env.WEB_ORIGIN} to create the owner account`);
  },
});

async function openEmbedded() {
  logger.info('opening the embedded database (first start takes a little longer)');
  const e = await openEmbeddedDb(join(dataDir, 'db'));
  await migrateEmbedded(e.db);
  const pool = new PglitePool(e.pg);
  // graphile-worker wants both handlers on a pool it did not make (an embedded pool never loses a connection).
  pool.on('error', (err: Error) => logger.error({ err: String(err) }, 'job queue: database error'));
  pool.on('connect', () => undefined);
  return {
    db: e.db,
    bus: createListenBus((channel, fn) => e.pg.listen(channel, fn), logger),
    queue: { pgPool: pool as unknown as Pool },
    close: async () => {
      await pool.end();
      await e.close();
    },
  };
}

async function openPostgres() {
  const url = env.DATABASE_URL!;
  const { db, close } = createDb(url);
  await migratePostgres(db as NodePgDatabase<typeof schema>, { migrationsFolder: MIGRATIONS_DIR });
  return { db, bus: createPgBus(url, logger), queue: url, close };
}
