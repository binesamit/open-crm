// SPDX-License-Identifier: AGPL-3.0-only
import cluster from 'node:cluster';
import { createDb } from './db/client';
import { loadEnv } from './env';
import { createLogger } from './lib/logger';
import { initMonitoring } from './lib/monitoring';
import { createPgBus } from './lib/realtime';
import { startAutomationRunner } from './modules/automations/jobs';
import { serveApp } from './serve';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env file: rely on the real environment (Railway)
}

const env = loadEnv();
const logger = createLogger(env);
if (!env.DATABASE_URL)
  throw new Error('DATABASE_URL is not set (see .env.example) - or run dist/standalone.js, the all-in-one mode');
// GlitchTip (roadmap ס4): on only when SENTRY_DSN is set; reports unhandled errors and every 5xx answer.
if (initMonitoring(env, 'api')) logger.info('error monitoring on');

/**
 * WEB_CONCURRENCY=n (opt-in, default 1): n API processes on one port (node:cluster), so heavy requests — opening
 * a 30k-item board is ~1–2 s of CPU — do not queue every other request behind them (perf review). Safe because
 * nothing request-scoped lives in process memory: sessions are in Postgres, live events come from Postgres
 * NOTIFY to every process, and the automation queue is graphile-worker's. Per-process: the API-token rate
 * limiters (each process counts its own share). Railway replicas are the same idea across machines.
 */
const processes = Math.max(1, Math.min(32, Number(process.env.WEB_CONCURRENCY ?? 1) || 1));
if (processes > 1 && cluster.isPrimary) {
  let stopping = false;
  const indexOf = new Map<number, string>();
  const fork = (index: string) => indexOf.set(cluster.fork({ WORKER_INDEX: index }).id, index);
  for (let i = 0; i < processes; i++) fork(String(i));
  cluster.on('exit', (worker, code) => {
    if (stopping) return;
    logger.warn({ pid: worker.process.pid, code }, 'api process exited — starting another');
    fork(indexOf.get(worker.id) ?? '1'); // the same slot: slot 0 runs the automation engine
    indexOf.delete(worker.id);
  });
  const stopAll = () => {
    stopping = true;
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGTERM');
  };
  process.on('SIGTERM', stopAll);
  process.on('SIGINT', stopAll);
} else {
  await serveApi();
}

async function serveApi() {
  const { db, close } = createDb(env.DATABASE_URL!);
  const primary = (process.env.WORKER_INDEX ?? '0') === '0';
  // Automations (M6, D21): the engine's jobs run here, next to the services. AUTOMATIONS=off disables them.
  // With several processes one runs the engine (graphile-worker would coordinate more, but one is enough).
  const runsAutomations = process.env.AUTOMATIONS !== 'off' && primary;
  await serveApp({
    env,
    logger,
    db,
    closeDb: close,
    bus: createPgBus(env.DATABASE_URL!, logger),
    processes,
    primary,
    startJobs: runsAutomations ? (deps) => startAutomationRunner(deps, env.DATABASE_URL!) : undefined,
  });
}
