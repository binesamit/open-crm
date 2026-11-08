// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accountSettingsSchema, newId, type NotificationChannel, type SettingRow, withDefaults } from '@bines/shared';
import type { Db } from '../../db/client';
import { boards, notificationSettings } from '../../db/schema';
import { getAccountSettings } from '../accounts/accounts.repo';

/** The account's notification defaults (admins; 08 §12.3). */
export const accountNotificationDefaults = async (db: Db, accountId: string) =>
  accountSettingsSchema.parse(await getAccountSettings(db, accountId)).notifications;

/**
 * Every notification_settings row of these users in this account, as the rules read them — with the account
 * defaults filled in where a user has no row of their own (`withDefaults`).
 */
export const settingRows = async (db: Db, accountId: string, userIds: string[]) => {
  if (!userIds.length) return new Map<string, SettingRow[]>();
  const defaults = await accountNotificationDefaults(db, accountId);
  const rows = await db
    .select()
    .from(notificationSettings)
    .where(and(eq(notificationSettings.accountId, accountId), inArray(notificationSettings.userId, userIds)));
  const byUser = new Map<string, SettingRow[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ channel: r.channel, type: r.type, board_id: r.boardId, enabled: r.enabled, digest: r.digest });
    byUser.set(r.userId, list);
  }
  for (const id of userIds) byUser.set(id, withDefaults(byUser.get(id) ?? [], defaults));
  return byUser;
};

/** Removes my rows for one board (its notifications go back to "everything", within my own settings). */
export const clearBoardSettings = (db: Db, accountId: string, userId: string, boardId: string) =>
  db
    .delete(notificationSettings)
    .where(
      and(
        eq(notificationSettings.accountId, accountId),
        eq(notificationSettings.userId, userId),
        eq(notificationSettings.boardId, boardId),
      ),
    );

/** Writes one setting (replacing the row with the same account, user, channel, type and board). */
export const putSetting = async (
  db: Db,
  s: {
    accountId: string;
    userId: string;
    channel: NotificationChannel;
    type: string;
    boardId: string | null;
    enabled: boolean;
    digest?: string;
  },
) => {
  await db
    .delete(notificationSettings)
    .where(
      and(
        eq(notificationSettings.accountId, s.accountId),
        eq(notificationSettings.userId, s.userId),
        eq(notificationSettings.channel, s.channel),
        eq(notificationSettings.type, s.type),
        s.boardId ? eq(notificationSettings.boardId, s.boardId) : isNull(notificationSettings.boardId),
      ),
    );
  await db.insert(notificationSettings).values({
    id: newId(),
    accountId: s.accountId,
    userId: s.userId,
    channel: s.channel,
    type: s.type,
    boardId: s.boardId,
    enabled: s.enabled,
    digest: s.digest ?? 'instant',
  });
};

/** Boards I muted for myself (a disabled '*' row on the bell for that board), with their names. */
export const mutedBoards = (db: Db, accountId: string, userId: string) =>
  db
    .select({ id: boards.id, name: boards.name })
    .from(notificationSettings)
    .innerJoin(boards, eq(boards.id, notificationSettings.boardId))
    .where(
      and(
        eq(notificationSettings.accountId, accountId),
        eq(notificationSettings.userId, userId),
        eq(notificationSettings.channel, 'in_app'),
        eq(notificationSettings.type, '*'),
        eq(notificationSettings.enabled, false),
        isNull(boards.deletedAt),
      ),
    )
    .orderBy(boards.name);
