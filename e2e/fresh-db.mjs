// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-console -- a setup step's report is the point. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A FRESH database for an E2E stack — `node e2e/fresh-db.mjs <url> [-] [template]` drops and creates it, then
 * runs the migrations and the seed (the first account and the owner's invitation, as a new installation's first boot).
 * The second argument is kept for older callers and ignored. With a template (another database on the same server,
 * nobody connected to it) the new one is a copy of it instead, brought up to date by the migrations. Used by
 * run-stacks.mjs (`<db>_e2e_s<n>`). Local databases and that name shape only — never anything else.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'apps', 'api');
const target = new URL(process.argv[2]);
const template = process.argv[4] || '';
if (template && !/^[a-z0-9_]+$/.test(template))
  throw new Error(`e2e fresh database: unexpected template "${template}"`);
if (!['localhost', '127.0.0.1'].includes(target.hostname))
  throw new Error(`e2e fresh database: refusing a database on "${target.hostname}" (local only)`);
const name = target.pathname.replace(/^\//, '');
if (!/^[a-z0-9_]+_(unreg|e2e_s\d+)$/.test(name)) throw new Error(`e2e fresh database: unexpected name "${name}"`);

const { Client } = createRequire(join(API, 'package.json'))('pg');
const admin = new URL(target);
admin.pathname = '/postgres';
const client = new Client({ connectionString: admin.toString() });
await client.connect();
await client.query(`drop database if exists ${name} with (force)`);
await client.query(template ? `create database ${name} template ${template}` : `create database ${name}`);
await client.end();
console.log(`e2e: fresh database ${name}${template ? ` (a copy of ${template})` : ''}`);

const tsx = createRequire(join(API, 'package.json')).resolve('tsx/cli');
for (const script of ['src/db/migrate.ts', 'src/db/seed.ts']) {
  const res = spawnSync(process.execPath, [tsx, script], {
    cwd: API,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: target.toString() },
  });
  if (res.status !== 0) throw new Error(`e2e fresh database ${name}: ${script} failed (exit ${res.status})`);
}
