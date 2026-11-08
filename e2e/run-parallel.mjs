// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-console -- a CLI runner. */
/**
 * `pnpm e2e:parallel [playwright args]` (s4f-e2e): the `isolated` project on E2E_WORKERS workers (default 3), then
 * the `serial` project on one — two invocations, so the serial specs never share the account with a running worker
 * and still run when an isolated one failed. Exit code: non-zero when either part failed.
 *
 *   pnpm e2e:parallel                      # E2E_WORKERS=3
 *   E2E_WORKERS=2 pnpm e2e:parallel --reporter=line
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Playwright's CLI run by this node — no shell (DEP0190), no pnpm lookup on PATH.
const playwrightCli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
const workers = process.env.E2E_WORKERS && Number(process.env.E2E_WORKERS) > 0 ? process.env.E2E_WORKERS : '3';
const extra = process.argv.slice(2);

const run = (project, env) => {
  console.log(`\n=== e2e: project ${project} (${env.E2E_WORKERS} worker${env.E2E_WORKERS === '1' ? '' : 's'}) ===\n`);
  const res = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '-c', 'e2e/playwright.config.ts', `--project=${project}`, '--pass-with-no-tests', ...extra],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, E2E_SPLIT_RUN: '1', ...env },
    },
  );
  return res.status ?? 1;
};

const started = Date.now();
const isolated = run('isolated', { E2E_WORKERS: workers });
// The cleanup already ran before the first part.
const serial = run('serial', { E2E_WORKERS: '1', E2E_CLEANUP: '0' });
console.log(
  `\n=== e2e: isolated ${isolated ? 'FAILED' : 'passed'}, serial ${serial ? 'FAILED' : 'passed'} — ${Math.round((Date.now() - started) / 1000)}s ===`,
);
process.exit(isolated || serial);
