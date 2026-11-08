// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  BOARD_VIEW_THROTTLE_MS,
  BOARD_VIEWERS_PAGE,
  type BoardViewer,
  type BoardViewers,
  type UpdateViewDevice,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers, assets, boardViewers, users } from '../../db/schema';
import type { FileStorage } from '../../lib/storage';
import type { Actor } from '../../types';
import { loadSettings } from '../accounts/accounts.service';
import { loadBoardAccess } from '../boards/boards.access';
import { avatarUrl } from '../users/users.service';

/** The account's "show who viewed boards" switch (Administration → General; on by default). */
export const boardViewersEnabled = async (db: Db, accountId: string) =>
  (await loadSettings(db, accountId)).permissions.show_board_viewers;

/**
 * POST /boards/{id}/viewers: "I opened this board". The first open adds the person; a later one moves their time
 * and raises the count only when the last one is older than BOARD_VIEW_THROTTLE_MS (one write per window, however
 * often the app asks). Nothing is stored when the account turned the list off. Returns whether a row changed.
 */
export const markBoardViewed = async (
  db: Db,
  a: Actor,
  boardId: string,
  device: { device: UpdateViewDevice; summary: string },
): Promise<boolean> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (!(await boardViewersEnabled(db, a.ctx.accountId))) return false;
  const out = await db
    .insert(boardViewers)
    .values({
      accountId: a.ctx.accountId,
      boardId: access.board.id,
      userId: a.user.id,
      device: device.device,
      userAgent: device.summary,
    })
    .onConflictDoUpdate({
      target: [boardViewers.boardId, boardViewers.userId],
      set: {
        lastViewedAt: sql`now()`,
        viewCount: sql`${boardViewers.viewCount} + 1`,
        device: sql`excluded.device`,
        userAgent: sql`excluded.user_agent`,
      },
      setWhere: sql`${boardViewers.lastViewedAt} < now() - (${BOARD_VIEW_THROTTLE_MS} * interval '1 millisecond')`,
    })
    .returning({ userId: boardViewers.userId });
  return out.length > 0;
};

/** Cursor = how many rows came before (the list is small: one row per person who ever opened the board). */
const offsetOf = (cursor: string | undefined) => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * GET /boards/{id}/viewers: who opened the board, newest first, for anyone who may read it. People no longer
 * active in the account are left out. A guest sees only themselves (the client side of a board does not learn who
 * on the team looks at it). Empty with `enabled: false` when the account turned the list off.
 */
export const listBoardViewers = async (
  db: Db,
  a: Actor,
  boardId: string,
  q: { limit?: number; cursor?: string },
  storage?: FileStorage,
): Promise<BoardViewers> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const { permissions } = await loadSettings(db, a.ctx.accountId);
  const recentHours = permissions.board_viewers_recent_hours;
  if (!permissions.show_board_viewers)
    return { data: [], total: 0, next_cursor: null, enabled: false, recent_hours: recentHours, recent_total: 0 };
  const limit = q.limit ?? BOARD_VIEWERS_PAGE;
  const offset = offsetOf(q.cursor);
  const where = and(
    eq(boardViewers.accountId, a.ctx.accountId),
    eq(boardViewers.boardId, access.board.id),
    a.ctx.role === 'guest' ? eq(boardViewers.userId, a.user.id) : undefined,
  );
  const active = and(
    eq(accountMembers.accountId, boardViewers.accountId),
    eq(accountMembers.userId, boardViewers.userId),
    isNull(accountMembers.deactivatedAt),
  );
  const [rows, totals] = await Promise.all([
    db
      .select({
        userId: boardViewers.userId,
        device: boardViewers.device,
        userAgent: boardViewers.userAgent,
        viewCount: boardViewers.viewCount,
        firstViewedAt: boardViewers.firstViewedAt,
        lastViewedAt: boardViewers.lastViewedAt,
        name: users.name,
        email: users.email,
        image: users.image,
        avatarKey: assets.storageKey,
        avatarName: assets.fileName,
        avatarMime: assets.mime,
      })
      .from(boardViewers)
      .innerJoin(users, eq(users.id, boardViewers.userId))
      .innerJoin(accountMembers, active)
      .leftJoin(assets, eq(assets.id, users.avatarAssetId))
      .where(where)
      .orderBy(desc(boardViewers.lastViewedAt), asc(boardViewers.userId))
      .limit(limit + 1)
      .offset(offset),
    db
      .select({
        n: count(),
        recent: sql<number>`(count(*) filter (where ${boardViewers.lastViewedAt} > now() - make_interval(hours => ${recentHours})))::int`,
      })
      .from(boardViewers)
      .innerJoin(accountMembers, active)
      .where(where),
  ]);
  const page = rows.slice(0, limit);
  const data: BoardViewer[] = await Promise.all(
    page.map(async (r) => ({
      id: r.userId,
      name: r.name || r.email,
      avatar_url: storage ? await avatarUrl(storage, r) : r.avatarKey ? null : r.image,
      last_viewed_at: r.lastViewedAt.toISOString(),
      first_viewed_at: r.firstViewedAt.toISOString(),
      view_count: r.viewCount,
      device: r.device as UpdateViewDevice,
      user_agent: r.userAgent,
    })),
  );
  return {
    data,
    total: totals[0]?.n ?? 0,
    next_cursor: rows.length > limit ? String(offset + limit) : null,
    enabled: true,
    recent_hours: recentHours,
    recent_total: totals[0]?.recent ?? 0,
  };
};
