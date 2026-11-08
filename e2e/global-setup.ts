// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-console -- the cleanup's report is the point of this step. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { API_URL, WEB_URL } from './stack';

/**
 * Before a run (s4f-e2e): `apps/api/scripts/cleanup-local-test-data.ts` — a dry run (its report), then `--apply` —
 * so the local demo account does not pile up test boards, workspaces and kit-board items (above
 * ~400 rows a table virtualizes and specs fail). It only touches leftovers older than 2 hours, never a run in
 * progress.
 *
 * Local databases only. The script itself refuses any DATABASE_URL host but localhost / 127.0.0.1; this step checks
 * the same first and stops the run loudly otherwise (and in CI or with NODE_ENV=production). Skip it with
 * E2E_CLEANUP=0.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** DATABASE_URL as the script will see it: the environment, else the repo's .env (read here, not loaded). */
const databaseUrl = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = join(ROOT, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')).DATABASE_URL : undefined;
};

const run = (args: string[]) => {
  // tsx's CLI run by this node — no shell (DEP0190), no pnpm lookup on PATH.
  const api = join(ROOT, 'apps', 'api');
  const tsx = createRequire(join(api, 'package.json')).resolve('tsx/cli');
  const res = spawnSync(process.execPath, [tsx, 'scripts/cleanup-local-test-data.ts', ...args], {
    cwd: api,
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) throw new Error(`e2e cleanup ${args.join(' ') || '(dry run)'} failed (exit ${res.status})`);
};

/**
 * A stack on an empty database (run-stacks.mjs, E2E_FIRST_RUN_SETUP=1): the web app sends everyone to /setup until
 * the installation has a user, so the owner (SEED_ADMIN_EMAIL) is created here first — the first-run setup's own
 * endpoint, as a new installation's owner would — with a throwaway password; the specs then sign in by magic link as
 * always. Playwright starts the servers before this step. Nothing to do when someone already exists.
 */
const firstRunSetup = async () => {
  const status = (await (await fetch(`${API_URL}/api/v1/setup`)).json()) as { required?: boolean };
  if (!status.required) return;
  const owner = process.env.SEED_ADMIN_EMAIL ?? parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')).SEED_ADMIN_EMAIL;
  if (!owner) throw new Error('e2e first-run setup: SEED_ADMIN_EMAIL is not set (environment or .env)');
  const res = await fetch(`${API_URL}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_URL },
    body: JSON.stringify({ email: owner, password: randomBytes(18).toString('base64url'), name: 'E2E owner' }),
  });
  if (!res.ok) throw new Error(`e2e first-run setup failed: ${res.status} ${await res.text()}`);
  console.log(`e2e: first-run setup — owner ${owner} created`);
};

export default async function globalSetup() {
  if (process.env.E2E_FIRST_RUN_SETUP === '1') await firstRunSetup();
  if (process.env.E2E_CLEANUP === '0') {
    console.log('e2e: local test-data cleanup skipped (E2E_CLEANUP=0)');
    return;
  }
  const refuse = (why: string) => {
    throw new Error(
      `\n\n  e2e cleanup REFUSED: ${why}.\n  It only ever runs on a local database. Fix DATABASE_URL, or run with E2E_CLEANUP=0.\n`,
    );
  };
  if (process.env.CI) refuse('CI is set');
  if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production');
  const url = databaseUrl();
  if (!url) refuse('DATABASE_URL is not set (environment or .env)');
  let host: string;
  try {
    host = new URL(url!).hostname;
  } catch {
    return refuse('DATABASE_URL is not a URL');
  }
  if (!LOCAL_HOSTS.has(host)) refuse(`DATABASE_URL points at "${host}", not localhost / 127.0.0.1`);

  console.log(`e2e: cleaning local test data on ${host} — dry run first`);
  run([]);
  console.log('e2e: applying the cleanup');
  run(['--apply']);
}
