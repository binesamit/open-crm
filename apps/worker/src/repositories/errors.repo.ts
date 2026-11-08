// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ErrorLinks,
  type ErrorSeverity,
  type ErrorSource,
  errorFingerprint,
  errorHubSettingsSchema,
  newId,
  redactErrorMessage,
} from '@bines/shared';
import type { SqlClient } from './trash.repo';

/**
 * The worker's side of the errors hub (the api writes through its batched writer
 * apps/api/src/modules/errors): the same redaction and fingerprint (@bines/shared), the same upsert — a repeat adds
 * to the count, a resolved error reopens — and the hourly count. The worker's failures are rare (a job out of
 * attempts, an email that could not be sent), so each is written at once. Never throws.
 */
export type WorkerError = {
  source: ErrorSource;
  code: string;
  message?: unknown;
  accountId?: string | null;
  severity?: ErrorSeverity;
  links?: ErrorLinks;
};

const settingsOf = async (db: SqlClient) => {
  const res = await db.query(`select settings from platform_settings where id = 'errors'`);
  const parsed = errorHubSettingsSchema.safeParse((res.rows[0] as { settings?: unknown } | undefined)?.settings ?? {});
  return parsed.success ? parsed.data : errorHubSettingsSchema.parse({});
};

export const recordWorkerError = async (db: SqlClient, e: WorkerError, now = new Date()) => {
  try {
    const settings = await settingsOf(db);
    const source = settings.sources[e.source];
    if (!source.enabled) return null;
    const message = redactErrorMessage(e.message ?? e.code);
    const code =
      redactErrorMessage(e.code)
        .replace(/[^\w.:-]+/g, '_')
        .slice(0, 80) || 'error';
    const accountId = e.accountId ?? null;
    const links = Object.fromEntries(Object.entries(e.links ?? {}).filter(([, v]) => typeof v === 'string' && v));
    const fingerprint = errorFingerprint({ source: e.source, code, message, accountId, links });
    const res = await db.query(
      `insert into error_events (id, fingerprint, account_id, source, code, severity, message, links, count, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $9, $9)
       on conflict (fingerprint) do update set
         count = error_events.count + 1,
         last_seen_at = greatest(error_events.last_seen_at, excluded.last_seen_at),
         message = excluded.message,
         links = error_events.links || excluded.links,
         status = case when error_events.status = 'resolved' then 'new' else error_events.status end,
         reopened_count = error_events.reopened_count + case when error_events.status = 'resolved' then 1 else 0 end,
         resolved_at = case when error_events.status = 'resolved' then null else error_events.resolved_at end,
         resolved_by = case when error_events.status = 'resolved' then null else error_events.resolved_by end,
         updated_at = now()
       returning id`,
      [
        newId(),
        fingerprint,
        accountId,
        e.source,
        code,
        e.severity ?? source.severity,
        message,
        JSON.stringify(links),
        now.toISOString(),
      ],
    );
    const id = (res.rows[0] as { id: string }).id;
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    await db.query(
      `insert into error_event_hours (event_id, hour, count) values ($1, $2, 1)
       on conflict (event_id, hour) do update set count = error_event_hours.count + 1`,
      [id, hour.toISOString()],
    );
    return id;
  } catch {
    // The hub must never break the job that failed.
    return null;
  }
};
