// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import {
  AppError,
  SEEN_EVENT_USERS,
  SEEN_PREVIEW_LIMIT,
  UPDATE_SEEN,
  type UpdateSeen,
  type UpdateViewDevice,
  type UpdateViewer,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { EVENTS_CHANNEL } from '../../lib/realtime';
import type { FileStorage } from '../../lib/storage';
import type { Actor } from '../../types';
import { loadSettings } from '../accounts/accounts.service';
import { loadItem } from '../items/items.service';
import { avatarUrl } from '../users/users.service';
import { findUpdate, updatePlace, updatesByIds, upsertUpdateViews, type UpdateViewRow, viewsOf } from './updates.repo';

/** The account's "show who viewed updates" switch (Administration → General; on by default). */
export const viewsEnabled = async (db: Db, accountId: string) =>
  (await loadSettings(db, accountId)).permissions.show_update_views;

/**
 * POST /updates/views: the updates and replies that became visible on this person's screen. Names they cannot
 * read (another account, an item hidden from them, a deleted update) are skipped silently — the batch is a hint,
 * not a command — and their own updates are never counted. Returns how many were recorded.
 */
export const markViewed = async (
  db: Db,
  a: Actor,
  updateIds: string[],
  device: { device: UpdateViewDevice; summary: string },
) => {
  if (!(await viewsEnabled(db, a.ctx.accountId))) return 0;
  const rows = (await updatesByIds(db, a.ctx.accountId, [...new Set(updateIds)])).filter(
    (u) => u.createdBy !== a.user.id,
  );
  const readable = new Set<string>();
  for (const itemId of new Set(rows.map((r) => r.itemId))) {
    try {
      await loadItem(db, a, itemId);
      readable.add(itemId);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }
  const seen = rows.filter((r) => readable.has(r.itemId));
  const first = await upsertUpdateViews(
    db,
    seen.map((r) => ({
      accountId: a.ctx.accountId,
      updateId: r.id,
      userId: a.user.id,
      device: device.device,
      userAgent: device.summary,
    })),
  );
  // r16seen: a first view (or a new device) goes live to whoever has the update on screen.
  await Promise.all(first.map((id) => queueSeenEvent(db, a.ctx.accountId, id)));
  return seen.length;
};

// ---------------------------------------------------------------------------
// Live: `update.seen` on the board channel (and /me/events for Inbox entries)
// ---------------------------------------------------------------------------
/** At most one `update.seen` per update per this window: the first goes out at once, the rest as one at its end. */
export const SEEN_EMIT_MS = 2000;
const windows = new Map<string, { dirty: boolean }>();

/**
 * Announces an update's viewers now (count + the newest few, photos left out — every screen already holds the
 * people's photos). Not an activity row: views are not a change to the account's data, and nothing is replayed.
 */
const announceSeen = async (db: Db, accountId: string, updateId: string) => {
  const place = await updatePlace(db, accountId, updateId);
  if (!place) return;
  const people = [...((await viewersByUpdate(await viewsOf(db, accountId, [updateId]))).get(updateId)?.values() ?? [])];
  const seen: UpdateSeen = { count: people.length, users: people.slice(0, SEEN_EVENT_USERS) };
  await db.execute(
    sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({
      id: '',
      account_id: accountId,
      type: UPDATE_SEEN,
      board_id: place.boardId,
      item_id: place.itemId,
      update_id: updateId,
      seen,
    })})`,
  );
};

/**
 * Coalesces `update.seen` per update (SEEN_EMIT_MS): a burst of viewers becomes the first event plus one more at
 * the end of the window. Best effort — a lost event only means the next load shows it (failures are swallowed).
 */
export const queueSeenEvent = async (db: Db, accountId: string, updateId: string): Promise<void> => {
  const key = `${accountId}:${updateId}`;
  const open = windows.get(key);
  if (open) {
    open.dirty = true;
    return;
  }
  windows.set(key, { dirty: false });
  const timer = setTimeout(() => {
    const w = windows.get(key);
    windows.delete(key);
    if (w?.dirty) void queueSeenEvent(db, accountId, updateId);
  }, SEEN_EMIT_MS);
  timer.unref?.();
  await announceSeen(db, accountId, updateId).catch(() => undefined);
};

/** Groups view rows (newest first) per update → per person, with every device they used. */
const viewersByUpdate = async (rows: UpdateViewRow[], storage?: FileStorage) => {
  const photos = new Map<string, Promise<string | null>>();
  const photo = (r: UpdateViewRow) => {
    // Without storage (the live event) an uploaded photo is left out: the app falls back to the people list.
    if (!photos.has(r.userId))
      photos.set(r.userId, storage ? avatarUrl(storage, r) : Promise.resolve(r.avatarKey ? null : r.image));
    return photos.get(r.userId)!;
  };
  const out = new Map<string, Map<string, UpdateViewer>>();
  for (const r of rows) {
    const people = out.get(r.updateId) ?? new Map<string, UpdateViewer>();
    out.set(r.updateId, people);
    const at = r.lastSeenAt.toISOString();
    const viewer = people.get(r.userId) ?? {
      id: r.userId,
      name: r.name || r.email,
      avatar_url: await photo(r),
      devices: [],
      last_seen_at: at,
    };
    viewer.devices.push({ device: r.device as UpdateViewDevice, user_agent: r.userAgent, last_seen_at: at });
    people.set(r.userId, viewer);
  }
  return out;
};

/**
 * The `seen` of each update (by id) for this reader: null for everyone when the account turned it off, and for
 * guests (they see the client side of a board, not who inside the team read what).
 */
export const seenOf = async (
  db: Db,
  a: Actor,
  updateIds: string[],
  storage?: FileStorage,
): Promise<(id: string) => UpdateSeen | null> => {
  if (a.ctx.role === 'guest' || !updateIds.length || !(await viewsEnabled(db, a.ctx.accountId))) return () => null;
  const grouped = await viewersByUpdate(await viewsOf(db, a.ctx.accountId, updateIds), storage);
  return (id) => {
    const people = [...(grouped.get(id)?.values() ?? [])];
    return { count: people.length, users: people.slice(0, SEEN_PREVIEW_LIMIT) };
  };
};

/** GET /updates/{id}/views: everyone who saw it, for whoever may read the item (not guests). */
export const listViewers = async (db: Db, a: Actor, updateId: string, storage?: FileStorage) => {
  const update = await findUpdate(db, a.ctx.accountId, updateId);
  if (!update) throw new AppError('not_found', 'Update not found');
  await loadItem(db, a, update.itemId);
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'guest_restricted');
  if (!(await viewsEnabled(db, a.ctx.accountId))) return [];
  const grouped = await viewersByUpdate(await viewsOf(db, a.ctx.accountId, [update.id]), storage);
  return [...(grouped.get(update.id)?.values() ?? [])];
};
