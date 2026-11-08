// SPDX-License-Identifier: AGPL-3.0-only
import { lt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { activityLog, auditLog, notifications } from '../../db/schema';
import { loadPlatformSettings } from './platform-settings';

/**
 * Log retention (privacy — GDPR art. 5(1)(e) storage limitation; the Israeli data-security
 * regulations' log-keeping period): once a day, rows older than what the owner set in Platform settings →
 * Retention are deleted — the security audit log, boards' change history and the bell's notifications. `null`
 * keeps a log until deleted by hand. Everything else has its own rule already (trash 30 days, files, idempotency
 * keys, error hub, sign-up requests, sessions).
 */
export const RETENTION_TASK = 'maintenance.retention';

const DAY_MS = 86_400_000;
const before = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/** One pass; returns how many rows each log lost. Exported for the tests, which pass `now`. */
export const purgeByRetention = async (db: Db, now = new Date()) => {
  const r = (await loadPlatformSettings(db)).retention;
  let audit = 0;
  let activity = 0;
  let bell = 0;
  if (r.audit_days !== null) {
    const gone = await db
      .delete(auditLog)
      .where(lt(auditLog.createdAt, before(now, r.audit_days)))
      .returning({ id: auditLog.id });
    audit = gone.length;
  }
  if (r.activity_days !== null) {
    const gone = await db
      .delete(activityLog)
      .where(lt(activityLog.createdAt, before(now, r.activity_days)))
      .returning({ id: activityLog.id });
    activity = gone.length;
  }
  if (r.notifications_days !== null) {
    const gone = await db
      .delete(notifications)
      .where(lt(notifications.createdAt, before(now, r.notifications_days)))
      .returning({ id: notifications.id });
    bell = gone.length;
  }
  return { audit, activity, notifications: bell };
};
