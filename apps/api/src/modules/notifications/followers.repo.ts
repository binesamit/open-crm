// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { itemFollowers } from '../../db/schema';
import { insertUnnest } from '../../db/unnest';

export type FollowSource = 'creator' | 'assigned' | 'mentioned' | 'update' | 'manual';

/** Automatic follow (D15): adds who is not there yet; a manual unfollow (muted row) is left alone. */
export const followItem = async (
  db: Db,
  accountId: string,
  itemId: string,
  userIds: Iterable<string>,
  source: FollowSource,
) => {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await db
    .insert(itemFollowers)
    .values(ids.map((userId) => ({ itemId, userId, accountId, source })))
    .onConflictDoNothing();
};

/** One user follows many items (the creator of a bulk insert), through `insertUnnest`. */
export const followItems = (db: Db, accountId: string, itemIds: string[], userId: string, source: FollowSource) =>
  insertUnnest(
    db,
    'item_followers',
    [
      ['item_id', 'varchar'],
      ['user_id', 'varchar'],
      ['account_id', 'varchar'],
      ['source', 'varchar'],
    ],
    itemIds.map((itemId) => [itemId, userId, accountId, source]),
    sql`on conflict do nothing`,
  );

/** "Follow" / "Unfollow" from the item menu; an unfollow is remembered. */
export const setFollowing = (db: Db, accountId: string, itemId: string, userId: string, following: boolean) =>
  db
    .insert(itemFollowers)
    .values({ itemId, userId, accountId, source: 'manual', muted: !following })
    .onConflictDoUpdate({
      target: [itemFollowers.itemId, itemFollowers.userId],
      set: { muted: !following, source: sql`case when ${!following} then 'manual' else ${itemFollowers.source} end` },
    });

export const isFollowing = async (db: Db, itemId: string, userId: string) =>
  (
    await db
      .select({ muted: itemFollowers.muted })
      .from(itemFollowers)
      .where(and(eq(itemFollowers.itemId, itemId), eq(itemFollowers.userId, userId)))
      .limit(1)
  )[0]?.muted === false;

/** Everyone who follows the item and did not unfollow it. */
export const followerIds = async (db: Db, itemId: string) =>
  (
    await db
      .select({ userId: itemFollowers.userId })
      .from(itemFollowers)
      .where(and(eq(itemFollowers.itemId, itemId), eq(itemFollowers.muted, false)))
  ).map((r) => r.userId);
