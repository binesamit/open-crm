// SPDX-License-Identifier: AGPL-3.0-only
import { captureError as capture } from '@bines/server-monitoring';

/**
 * Error monitoring (roadmap ס4) for the worker: the shared module (`@bines/server-monitoring`), so a job's error text
 * is scrubbed exactly like the api's — emails AND credentials (audit 2026-10-10, duplication #1).
 */
export { closeMonitoring, initMonitoring, scrubEvent, type MonitoringEnv } from '@bines/server-monitoring';

/** Reports an error (no-op when monitoring is off), tagged with the job it came from. */
export const captureError = (err: unknown, context: { task?: string; jobId?: string; attempts?: string } = {}) =>
  capture(err, context);
