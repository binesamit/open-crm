// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import type { Db } from './db/client';
import { createDeps } from './deps';
import type { Env } from './env';
import type { Logger } from './lib/logger';
import { closeMonitoring, reportingErrorHandler } from './lib/monitoring';
import type { EventBus } from './lib/realtime';
import { errorHandler } from './middleware/error';
import { createCollab } from './modules/docs/collab';
import { recordingErrorHandler } from './modules/errors/errors.capture';
import { flushErrors, setErrorWriterLogger } from './modules/errors/errors.writer';
import { seedHelpCenter } from './modules/help/help.seed';
import { ensureInstanceId } from './modules/license/instance';
import { startTelemetry } from './modules/license/licensing.service';
import { syncBucketCors } from './modules/platform/public-address';
import { closeAllStreams } from './modules/realtime/realtime.routes';
import { secretKeyProblem } from './modules/secrets/secret-crypto';
import type { AppDeps } from './types';

/** A job runner started next to the server (graphile-worker's Runner). */
export type JobRunner = { stop: () => Promise<void> };

/**
 * One API process: the app (and the built SPA), live doc co-editing, and — when `startJobs` is given — the job
 * runner. Shared by the classic entry (index.ts: Postgres, WEB_CONCURRENCY processes) and standalone mode
 * (standalone.ts: embedded database, the worker's jobs in the same runner). Ends everything cleanly on SIGTERM.
 */
export const serveApp = async (p: {
  env: Env;
  logger: Logger;
  db: Db;
  closeDb: () => Promise<void>;
  bus: EventBus;
  startJobs?: (deps: AppDeps) => Promise<JobRunner | null>;
  /** How many API processes share the port (WEB_CONCURRENCY): collab warns when several. */
  processes?: number;
  /** This process is the first one (WORKER_INDEX 0): it runs the once-per-installation chores. */
  primary?: boolean;
  /** After the port is open (standalone mode prints where to go). */
  onListening?: (deps: AppDeps, port: number) => void | Promise<void>;
}) => {
  const { env, logger, db } = p;
  const primary = p.primary ?? true;
  const deps = createDeps({ env, logger, db, bus: p.bus });

  // Built SPA next to this app (apps/api/{src,dist} → apps/web/dist); served only when it exists (production build).
  const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const webDistDir = env.NODE_ENV === 'production' && existsSync(webDist) ? webDist : undefined;
  const app = createApp(deps, { webDistDir });
  app.onError(recordingErrorHandler(deps.db, reportingErrorHandler(errorHandler(logger))));
  setErrorWriterLogger(deps.db, logger);
  // M11: the file bucket's CORS follows the public address (S3_SET_CORS only; one process is enough; best effort).
  if (primary) void syncBucketCors(deps);
  // Licensing: this installation's random id is made on first boot; the telemetry heartbeat (OFF unless the owner
  // opted in, never with BINES_TELEMETRY=false) is looked at once an hour by one process.
  await ensureInstanceId(db);
  const stopTelemetry = primary ? startTelemetry(deps) : () => undefined;
  // The help center that ships with the code, on a new installation's first boot (once; help.seed.ts).
  if (primary)
    void seedHelpCenter(deps).catch((err: unknown) => logger.warn({ err: String(err) }, 'help center seed failed'));

  const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
    logger.info(`api listening on http://localhost:${info.port} (docs: /api/docs)`);
    void Promise.resolve(p.onListening?.(deps, info.port)).catch((err: unknown) =>
      logger.warn({ err: String(err) }, 'start-up notice failed'),
    );
  });
  // Secret columns: say so when they cannot work (the key itself is never printed).
  const secretProblem = secretKeyProblem(env);
  if (secretProblem) logger.warn(`secret columns: ${secretProblem}`);

  // Live doc co-editing (M8 ד1): Hocuspocus on the same server, WebSocket at /api/v1/collab. A doc lives in one
  // process's memory — with several processes (WEB_CONCURRENCY > 1, replicas) two editors may land apart.
  const collab = createCollab(deps);
  collab.attach(server as unknown as HttpServer);
  if ((p.processes ?? 1) > 1)
    logger.warn('collab: docs are co-edited in memory per process — with WEB_CONCURRENCY > 1 editors may not meet');

  const jobs = p.startJobs ? await p.startJobs(deps) : null;
  if (jobs) logger.info('job runner started');

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopTelemetry();
    server.close();
    // Open event streams end cleanly (the browser reconnects to the new instance) instead of being cut mid-flight.
    void closeAllStreams()
      .then(() => collab.close()) // saves what editors typed in the last seconds
      .then(() => Promise.all([deps.bus.close(), jobs?.stop(), closeMonitoring(), flushErrors(deps.db)]))
      .then(() => p.closeDb())
      .catch((err: unknown) => logger.error({ err: String(err) }, 'shutdown failed'))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return deps;
};
