// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorHandler } from 'hono';
import { captureError as capture } from '@bines/server-monitoring';
import type { AppEnv } from '../types';

/**
 * Error monitoring (roadmap ס4): the shared module (`@bines/server-monitoring` — the same scrubbing in the api and
 * the worker) plus what only the api has, the error handler that reports every 5xx.
 */
export { closeMonitoring, initMonitoring, scrubEvent, type MonitoringEnv } from '@bines/server-monitoring';

/** Reports an error (no-op when monitoring is off). `requestId` lets the report be matched with the logs. */
export const captureError = (err: unknown, context: { requestId?: string; task?: string } = {}) =>
  capture(err, context);

/** Wraps the app's error handler: answers stay the same; every 5xx is reported. */
export const reportingErrorHandler =
  (handler: ErrorHandler<AppEnv>): ErrorHandler<AppEnv> =>
  async (err, c) => {
    const res = await handler(err, c);
    if (res.status >= 500) captureError(err, { requestId: c.get('requestId') });
    return res;
  };
