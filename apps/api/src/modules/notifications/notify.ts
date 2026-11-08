// SPDX-License-Identifier: AGPL-3.0-only
import { channelAllowed, newId, NOTIFICATION_EXCERPT, type NotificationType, pushAllowed } from '@bines/shared';
import type { Db } from '../../db/client';
import { insertNotifications, type NotificationInsert } from './notifications.repo';
import { settingRows } from './settings.repo';

/** What a notification is about and points at (the bell's link, the email's names). */
export type NotificationTarget = Pick<NotificationInsert, 'boardId' | 'itemId' | 'updateId' | 'docId' | 'dashboardId'>;

export type NotifyUsersDraft = {
  accountId: string;
  type: NotificationType;
  /** Who did it (null = the system). Not filtered here: the caller chooses the audience. */
  actorId: string | null;
  /**
   * The boards whose per-board settings and personal board mutes apply (the board and, for a subitem, its parent —
   * D14). Empty / absent = an account-wide notification: only the account-wide settings apply.
   */
  boardIds?: (string | null | undefined)[];
  target?: NotificationTarget;
  /** The type's own data (`excerpt` is cut to NOTIFICATION_EXCERPT). */
  payload?: Record<string, unknown>;
  /**
   * The sender's own channel choice, on top of each user's settings (a flow connection's alert channel; the tickets
   * module emails its own messages). false = never by this channel; absent = by the user's settings.
   */
  bell?: boolean;
  email?: boolean;
};

/**
 * THE way a notification is written (08 §12.3) — every module's notifications go through here. Per recipient, the
 * type's rules (`NOTIFICATION_TYPE_META`) and the recipient's settings decide (`channelAllowed` / `pushAllowed`,
 * account defaults included): bell, email and phone all off → no row; bell off → a row for the email / the phone
 * only (`bell: false`, hidden from the bell); a `required` type always reaches the bell and the email. The row's
 * insert triggers announce it on /me/events and queue its email and push (the worker checks the same rules).
 * The audience (who may see the object, never the actor, active members) and "mute for everyone" are the caller's.
 * Returns the users a row was written for.
 */
export const notifyUsers = async (tx: Db, d: NotifyUsersDraft, userIds: Iterable<string>): Promise<string[]> => {
  const ids = [...new Set(userIds)];
  if (!ids.length) return [];
  const boardIds = d.boardIds ?? [];
  const settings = await settingRows(tx, d.accountId, ids);
  const to = ids.flatMap((userId) => {
    const rows = settings.get(userId) ?? [];
    const bell = d.bell !== false && channelAllowed(rows, 'in_app', d.type, boardIds);
    const email = d.email !== false && channelAllowed(rows, 'email', d.type, boardIds);
    return bell || email || pushAllowed(rows, d.type, boardIds) ? [{ userId, bell }] : [];
  });
  const excerpt = d.payload?.excerpt;
  const now = new Date();
  await insertNotifications(
    tx,
    to.map(({ userId, bell }) => ({
      id: newId(),
      accountId: d.accountId,
      userId,
      type: d.type,
      actorId: d.actorId,
      ...d.target,
      // Not by email (the sender's choice): the email queue sees it as sent already.
      ...(d.email === false ? { emailedAt: now } : {}),
      payload: {
        ...d.payload,
        ...(typeof excerpt === 'string' ? { excerpt: excerpt.slice(0, NOTIFICATION_EXCERPT) } : {}),
        ...(bell ? {} : { bell: false }),
      },
    })),
  );
  return to.map((r) => r.userId);
};
