// SPDX-License-Identifier: AGPL-3.0-only
import type { ChecklistEvent } from '@bines/shared';
import { and, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers, activityLog, auditLog, userProfileSettings } from '../../db/schema';

/**
 * "First steps": whether a person did each thing in an account — from their own activity-log events
 * (undone ones do not count; a link written on the other side of a two-way column is not theirs) — and their own
 * checklist state, per account, in `user_profile_settings.settings.first_steps[accountId]`.
 */

export type ChecklistPrefs = {
  dismissed?: boolean;
  /** Folded into its pill (fix: never over the page's own actions after its first showing). */
  collapsed?: boolean;
  /** Steps found done (kept, so a done step is never looked up again). */
  done?: string[];
  /** When the app last reported each of its events (ISO). */
  marks?: Record<string, string>;
  completed_at?: string | null;
};

const notReflected = sql`(${activityLog.payload}->'meta'->>'reflected_from') is null`;

/** The activity-log rule of each event the log records (`joined` and the app's events are not here). */
const RULES: Partial<Record<ChecklistEvent, { types: string[]; extra?: SQL }>> = {
  item_created: { types: ['item.created'] },
  value_changed: { types: ['cell.changed', 'item.renamed'], extra: notReflected },
  update_written: { types: ['update.created', 'update.replied'] },
  file_added: { types: ['file.added'] },
  items_linked: {
    types: ['cell.changed'],
    extra: sql`${activityLog.payload}->'meta'->>'column_type' = 'board_relation' and ${notReflected}`,
  },
  timer_started: { types: ['time.started'] },
  // A kit's recipes are written as its installer's, without the automation's id in `meta`: not theirs.
  automation_created: { types: ['automation.created'], extra: sql`${activityLog.payload}->'meta' ? 'automation_id'` },
  dashboard_created: { types: ['dashboard.created'] },
  doc_created: { types: ['doc.created'] },
};

/** Did this person do it in this account (since `since`, when given)? */
export const didEvent = async (
  db: Db,
  accountId: string,
  userId: string,
  event: ChecklistEvent,
  since?: Date,
): Promise<boolean> => {
  if (event === 'teammate_invited') {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.accountId, accountId),
          eq(auditLog.actorId, userId),
          eq(auditLog.action, 'user.invited'),
          ...(since ? [gt(auditLog.createdAt, since)] : []),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  const rule = RULES[event];
  if (!rule) return false;
  const rows = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.accountId, accountId),
        inArray(activityLog.type, rule.types),
        eq(activityLog.actorId, userId),
        isNull(activityLog.undoneAt),
        ...(since ? [gt(activityLog.createdAt, since)] : []),
        ...(rule.extra ? [rule.extra] : []),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

/** When the person joined the account (null = unknown: treated as long ago). */
export const joinedAt = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ joinedAt: accountMembers.joinedAt, createdAt: accountMembers.createdAt })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
      .limit(1)
  ).map((r) => r.joinedAt ?? r.createdAt)[0] ?? null;

const allPrefs = async (db: Db, userId: string) =>
  ((
    await db
      .select({ v: sql<unknown>`${userProfileSettings.settings}->'first_steps'` })
      .from(userProfileSettings)
      .where(eq(userProfileSettings.userId, userId))
      .limit(1)
  )[0]?.v ?? {}) as Record<string, ChecklistPrefs>;

export const checklistPrefsOf = async (db: Db, userId: string, accountId: string): Promise<ChecklistPrefs> =>
  (await allPrefs(db, userId))[accountId] ?? {};

/** Saves this account's part (the other accounts' parts stay as they are). */
export const setChecklistPrefs = async (db: Db, userId: string, accountId: string, prefs: ChecklistPrefs) => {
  const all = { ...(await allPrefs(db, userId)), [accountId]: prefs };
  const json = JSON.stringify(all);
  await db
    .insert(userProfileSettings)
    .values({ userId, settings: { first_steps: all } })
    .onConflictDoUpdate({
      target: userProfileSettings.userId,
      set: {
        settings: sql`${userProfileSettings.settings} || jsonb_build_object('first_steps', ${json}::jsonb)`,
        updatedAt: new Date(),
      },
    });
};
