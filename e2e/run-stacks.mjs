// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-console -- a CLI runner. */
/**
 * `node e2e/run-stacks.mjs [--shards N] [playwright args]`: the whole suite split over several complete stacks that run
 * side by side on this machine — each with its own fresh database (migrate + seed, fresh-db.mjs), its own Mailpit
 * (a Docker container), its own API, web app and stand-in geocoder on its own ports, and its own share of the spec
 * files (Playwright's --shard). Inside a stack everything runs one after the other on one worker, so the `serial`
 * specs (serial-specs.ts) never meet another test in their account; the stacks share nothing but the machine's
 * clipboard, so the specs that use it (clipboard-specs.ts) all run on the first stack, after its share.
 *
 *   node e2e/run-stacks.mjs                                  # 3 stacks
 *   node e2e/run-stacks.mjs --shards 4 --reporter=line
 *   node e2e/run-stacks.mjs --shards 2 e2e/tz.spec.ts e2e/kb.spec.ts
 *
 * Settings (environment; nothing here is fixed):
 * - E2E_STACKS        how many stacks when --shards is not given (default 3)
 * - E2E_PORT_BASE     stack n uses E2E_PORT_BASE + 10·n … +4: web, API, Mailpit, geocoder, mail provider stand-in
 *                     (default 4100 → 4110–4114, 4120–4124 …). Every port must be free: the run stops before starting anything otherwise.
 * - E2E_HOST          the address the stacks listen on (default 127.0.0.1 — never `localhost`, which a browser may
 *                     resolve to another program's ::1 listener)
 * - E2E_DATABASE_URL  the Postgres server to make the stacks' databases on (default DATABASE_URL, environment or the
 *                     repo's .env); stack n's database is `<its name>_e2e_s<n>`, dropped and made again each run
 * - E2E_TEMPLATE_DB   start each stack's database as a copy of this one (same server, nobody connected — e.g. a
 *                     clone of the database the suite usually runs on) instead of an empty one; without it the run
 *                     creates the owner through the first-run setup (global-setup.ts, E2E_FIRST_RUN_SETUP)
 * - E2E_OWNER_EMAIL   the owner every spec signs in as (default SEED_ADMIN_EMAIL, environment or .env) — set for the
 *                     database, the API and the specs alike
 * - E2E_ACCOUNT_SLUG  the first account of an empty database, where the specs work (default demo, as helpers.ts)
 * - E2E_MAILPIT_IMAGE the Mailpit image (default axllent/mailpit:latest, as docker-compose.yml)
 * - E2E_KEEP=1        leave the stacks' databases behind for a look afterwards (Mailpit containers always go)
 *
 * Needs Docker running (Postgres from docker-compose.yml, and the Mailpit containers). Exit code: non-zero when any
 * stack failed; each stack's full output is in test-results/stacks/s<n>.log.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Playwright's CLI run by this node — no shell (DEP0190), no pnpm lookup on PATH.
const playwrightCli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
// `--shards N` (or `--shards=N`) = E2E_STACKS; every other argument goes to Playwright.
let shardsArg;
const extra = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--shards') shardsArg = process.argv[++i];
  else if (arg.startsWith('--shards=')) shardsArg = arg.slice('--shards='.length);
  else extra.push(arg);
}

const positive = (value, fallback) => (Number(value) > 0 ? Math.floor(Number(value)) : fallback);
const STACKS = positive(shardsArg ?? process.env.E2E_STACKS, 3);
const PORT_BASE = positive(process.env.E2E_PORT_BASE, 4100);
const HOST = process.env.E2E_HOST || '127.0.0.1';
const MAILPIT_IMAGE = process.env.E2E_MAILPIT_IMAGE || 'axllent/mailpit:latest';
const KEEP = process.env.E2E_KEEP === '1';
const TEMPLATE = process.env.E2E_TEMPLATE_DB || '';

const fail = (why) => {
  console.error(`\n  e2e stacks: ${why}\n`);
  process.exit(1);
};

const repoEnv = () => {
  const file = join(root, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
};
const serverUrl = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || repoEnv().DATABASE_URL;
if (!serverUrl) fail('no database server: set E2E_DATABASE_URL or DATABASE_URL (environment or .env)');
const OWNER = process.env.E2E_OWNER_EMAIL || process.env.SEED_ADMIN_EMAIL || repoEnv().SEED_ADMIN_EMAIL;
if (!OWNER) fail('no owner: set E2E_OWNER_EMAIL or SEED_ADMIN_EMAIL (environment or .env)');
/** The owner and the first account, for the database (seed / first-run setup), the API and the specs alike. */
const ACCOUNT_SLUG = process.env.E2E_ACCOUNT_SLUG || 'demo';
const stackIdentity = { SEED_ADMIN_EMAIL: OWNER, SEED_ACCOUNT_SLUG: ACCOUNT_SLUG, SEED_ACCOUNT_NAME: ACCOUNT_SLUG };

const stacks = Array.from({ length: STACKS }, (_, i) => {
  const n = i + 1;
  const port = (k) => PORT_BASE + 10 * n + k;
  const db = new URL(serverUrl);
  db.pathname = `${db.pathname.replace(/^\//, '') || 'bines_os'}_e2e_s${n}`;
  return {
    n,
    name: `s${n}`,
    ports: [port(0), port(1), port(2), port(3), port(4)],
    web: `http://${HOST}:${port(0)}`,
    api: `http://${HOST}:${port(1)}`,
    mailPort: port(2),
    mail: `http://${HOST}:${port(2)}`,
    geo: `http://${HOST}:${port(3)}`,
    fakeMail: `http://${HOST}:${port(4)}`,
    db: db.toString(),
    // Unique per port base: two sessions on different bases never touch each other's container.
    container: `bines-e2e-${PORT_BASE}-s${n}`,
  };
});

/** True when nothing listens on host:port (we can bind it ourselves). */
const portFree = (port) =>
  new Promise((resolve) => {
    const server = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });

/** Runs a command; its output goes to `log` (and, prefixed, to the console when `echo`). Resolves with its exit code. */
const run = (cmd, args, { env, log, prefix }) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...stackIdentity, ...env } });
    const pipe = (stream) => {
      let rest = '';
      stream.on('data', (chunk) => {
        log.write(chunk);
        const lines = (rest + chunk.toString()).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) console.log(`[${prefix}] ${line}`);
      });
      stream.on('end', () => rest.trim() && console.log(`[${prefix}] ${rest}`));
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      log.write(`${err.stack}\n`);
      resolve(1);
    });
  });

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });

const waitFor = async (url, seconds) => {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const removeContainers = () => {
  for (const s of stacks) docker(['rm', '-f', s.container]);
};

// Before anything starts: Docker, and every port of every stack free.
if (docker(['info', '--format', '{{.ServerVersion}}']).status !== 0)
  fail('Docker is not running (Postgres and the stacks’ Mailpit containers need it) — start Docker Desktop');
removeContainers(); // a crashed earlier run's leftovers, by this port base's names only
const taken = [];
for (const s of stacks) for (const p of s.ports) if (!(await portFree(p))) taken.push(p);
if (taken.length)
  fail(`port${taken.length > 1 ? 's' : ''} ${taken.join(', ')} already in use — pick another E2E_PORT_BASE`);

const logDir = join(root, 'test-results', 'stacks');
mkdirSync(logDir, { recursive: true });
process.on('SIGINT', () => {
  removeContainers();
  process.exit(130);
});

const started = Date.now();
console.log(
  `e2e: ${STACKS} stack${STACKS > 1 ? 's' : ''} — ${stacks.map((s) => `${s.name} ${s.web}`).join(', ')}; logs in ${logDir}`,
);

const runStack = async (s) => {
  const log = createWriteStream(join(logDir, `${s.name}.log`));
  const say = (text) => {
    console.log(`[${s.name}] ${text}`);
    log.write(`${text}\n`);
  };
  const t0 = Date.now();
  const mail = docker(['run', '-d', '--rm', '--name', s.container, '-p', `${HOST}:${s.mailPort}:8025`, MAILPIT_IMAGE]);
  if (mail.status !== 0) {
    say(`Mailpit container failed: ${mail.stderr.trim()}`);
    return { s, code: 1, step: 'mailpit' };
  }
  const dbCode = await run(process.execPath, [join(root, 'e2e', 'fresh-db.mjs'), s.db, 'off', TEMPLATE], {
    log,
    prefix: s.name,
  });
  if (dbCode !== 0) return { s, code: dbCode, step: 'database' };
  if (!(await waitFor(`${s.mail}/api/v1/info`, 30))) {
    say('Mailpit did not answer');
    return { s, code: 1, step: 'mailpit' };
  }
  say(`ready in ${Math.round((Date.now() - t0) / 1000)}s — running shard ${s.n}/${STACKS}`);
  const playwright = (args, env) =>
    run(process.execPath, [playwrightCli, 'test', '-c', 'e2e/playwright.config.ts', '--pass-with-no-tests', ...args], {
      log,
      prefix: s.name,
      env: {
        E2E_STACK: s.name,
        E2E_WEB_URL: s.web,
        E2E_API_URL: s.api,
        E2E_MAILPIT_URL: s.mail,
        E2E_GEO_URL: s.geo,
        E2E_FAKE_MAIL_URL: s.fakeMail,
        E2E_DATABASE_URL: s.db,
        // One worker per stack: `serial` and `isolated` specs never overlap inside it (the stacks are the
        // parallelism). Fresh database: no leftovers to clean. Never another program's server on these ports.
        E2E_WORKERS: '1',
        E2E_SPLIT_RUN: '1',
        E2E_CLEANUP: '0',
        E2E_REUSE_SERVERS: '0',
        E2E_FIRST_RUN_SETUP: '1',
        ...env,
      },
    });
  // Its share, without the specs on the machine's clipboard (clipboard-specs.ts) — another stack would overwrite it.
  let code = await playwright([`--shard=${s.n}/${STACKS}`, `--output=test-results/stacks/${s.name}`, ...extra], {
    E2E_CLIPBOARD: 'skip',
  });
  // Then the first stack runs all of those, one after the other: the clipboard is never used by two at once.
  if (s.n === 1) {
    say('clipboard specs (clipboard-specs.ts), on this stack only');
    const clipboard = await playwright([`--output=test-results/stacks/${s.name}-clipboard`, ...extra], {
      E2E_CLIPBOARD: 'only',
    });
    code ||= clipboard;
  }
  return { s, code, step: 'tests', seconds: Math.round((Date.now() - t0) / 1000) };
};

let results;
try {
  results = await Promise.all(stacks.map(runStack));
} finally {
  removeContainers();
}
if (!KEEP)
  for (const s of stacks) {
    const db = new URL(s.db);
    const name = db.pathname.replace(/^\//, '');
    db.pathname = '/postgres';
    const { Client } = createRequire(join(root, 'apps', 'api', 'package.json'))('pg');
    const client = new Client({ connectionString: db.toString() });
    try {
      await client.connect();
      await client.query(`drop database if exists ${name} with (force)`);
    } catch (err) {
      console.log(`e2e: could not drop ${name}: ${err.message}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

console.log('');
for (const { s, code, step, seconds } of results)
  console.log(
    `=== e2e ${s.name}: ${code ? `FAILED (${step})` : 'passed'}${seconds ? ` — ${seconds}s` : ''} — ${join(logDir, `${s.name}.log`)}`,
  );
console.log(`=== e2e: ${STACKS} stacks, ${Math.round((Date.now() - started) / 1000)}s in all ===`);
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
