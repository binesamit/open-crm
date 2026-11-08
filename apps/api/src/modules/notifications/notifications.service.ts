// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type BoardNotifications,
  digestOf,
  type DigestFrequency,
  formatDigest,
  NOTIFICATION_CATEGORIES,
  type Notification,
  type NotificationList,
  type NotificationSettings,
  type NotificationChannel,
  type NotificationType,
  formatQuiet,
  parseQuiet,
  PUSH_BADGE_ROW,
  type QuietHours,
} from '@bines/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import { findMembership } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import {
  assertBoard,
  type BoardAccess,
  isOwnerOrAdmin,
  loadBoardAccess,
  readableBoardIds,
} from '../boards/boards.access';
import { findBoard, updateBoardRow } from '../boards/boards.repo';
import type { ItemRow } from '../items/items.repo';
import { accountTeams } from '../items/query.repo';
import { boardVisibility, isVisible } from '../items/visibility';
import { loadDocAccess } from '../docs/docs.access';
import { loadDashboardAccess } from '../dashboards/dashboards.access';
import { followerIds, followItem, isFollowing, setFollowing } from './followers.repo';
import { announceRead, columnTitle, listNotifications, markRead, unreadCount } from './notifications.repo';
import { notifyUsers } from './notify';
import { clearBoardSettings, mutedBoards, putSetting, settingRows } from './settings.repo';

/**
 * `inbound.external`: mail from outside the account, written in the name of its address's creator
 * who did not write it, so they hear about it like everyone else and the notification has no actor.
 */
type Actor = {
  ctx: AccountContext;
  user: SessionUser;
  requestId?: string;
  automation?: { id: string; title: string };
  inbound?: { external: boolean };
};

/** The actor did not do it themselves: an automation (as its owner) or outside mail (as its address's creator). */
const actsForSomeoneElse = (a: Actor) => !!a.automation || !!a.inbound?.external;

/**
 * Who of `userIds` may hear about `item`: active members of the account who can read the board and see the
 * item (`view_items`, 05 §6) — a notification never leaks an item. The actor is never notified (D15 rules) —
 * except by an automation: it acts as its owner, but the owner did not do it.
 */
const audience = async (db: Db, a: Actor, item: ItemRow, userIds: Iterable<string>) => {
  const out: string[] = [];
  for (const id of new Set(userIds)) {
    if (id === a.user.id && !actsForSomeoneElse(a)) continue;
    const m = await findMembership(db, a.ctx.accountId, id);
    if (m?.status !== 'active') continue;
    const ctx = { ...a.ctx, role: m.role, membershipId: m.id };
    const user = { id } as SessionUser;
    try {
      const access = await loadBoardAccess(db, ctx, user, item.boardId);
      if (await isVisible(db, await boardVisibility(db, { ctx, user }, access), item)) out.push(id);
    } catch {
      // cannot read the board: no notification
    }
  }
  return out;
};

/** The item's board and the board whose settings rule it (the parent, for a subitem — D14). */
const boardsOf = async (db: Db, accountId: string, item: ItemRow) => {
  const own = await findBoard(db, accountId, item.boardId);
  const top = own?.parentBoardId ? await findBoard(db, accountId, own.parentBoardId) : own;
  return { ids: [own?.id ?? null, top?.id ?? null], top };
};

/** "Mute for everyone" by a board owner (08 §12.2), kept in the board's settings. */
const mutedForEveryone = (board: { settings: unknown } | undefined) =>
  !!(board?.settings as { notifications_muted?: boolean } | undefined)?.notifications_muted;

type Draft = {
  type: NotificationType;
  item: ItemRow;
  updateId?: string;
  excerpt?: string;
  columnTitle?: string | null;
};

/**
 * An item's notification, in the action's transaction: to the item's audience, through `notifyUsers` (the
 * recipient's settings decide, 08 §12.3). A board muted for everyone sends nothing.
 */
const notify = async (tx: Db, a: Actor, d: Draft, userIds: Iterable<string>) => {
  const { ids: boardIds, top } = await boardsOf(tx, a.ctx.accountId, d.item);
  if (mutedForEveryone(top)) return [];
  return notifyUsers(
    tx,
    {
      accountId: a.ctx.accountId,
      type: d.type,
      actorId: a.inbound?.external ? null : a.user.id,
      boardIds,
      target: { boardId: d.item.boardId, itemId: d.item.id, updateId: d.updateId ?? null },
      payload: {
        ...(d.excerpt ? { excerpt: d.excerpt } : {}),
        ...(d.columnTitle ? { column_title: d.columnTitle } : {}),
      },
    },
    await audience(tx, a, d.item, userIds),
  );
};

type People = { persons_and_teams?: { id: string; kind: string }[] } | null | undefined;

/** People a people-cell value names: persons, and the members of its teams. */
const peopleIn = async (db: Db, accountId: string, value: People) => {
  const list = value?.persons_and_teams ?? [];
  const persons = list.filter((p) => p.kind === 'person').map((p) => p.id);
  const teamIds = list.filter((p) => p.kind === 'team').map((p) => p.id);
  if (!teamIds.length) return new Set(persons);
  const teams = await accountTeams(db, accountId);
  return new Set([...persons, ...teams.filter((t) => teamIds.includes(t.id)).flatMap((t) => t.member_ids)]);
};

/**
 * A people cell changed: everyone newly in it (directly or through a team) hears "assigned to you" and
 * follows the item (D15).
 */
export const notifyAssigned = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  columnId: string,
  before: unknown,
  after: unknown,
) => {
  const had = await peopleIn(tx, a.ctx.accountId, before as People);
  const added = [...(await peopleIn(tx, a.ctx.accountId, after as People))].filter((id) => !had.has(id));
  if (!added.length) return;
  await notify(tx, a, { type: 'assigned', item, columnTitle: await columnTitle(tx, columnId) }, added);
  await followItem(tx, a.ctx.accountId, item.id, added, 'assigned');
};

/** The creator follows a new item (D15). */
export const followNewItem = (tx: Db, a: Actor, itemId: string) =>
  followItem(tx, a.ctx.accountId, itemId, [a.user.id], 'creator');

/**
 * A new update or reply: mentioned people hear "mentioned you"; the author of the update replied to hears
 * "replied"; the item's other followers hear "new update" — one notification each, in that order of priority.
 * On edit only newly mentioned people are told. The writer and the mentioned then follow the item (D15).
 */
export const notifyUpdate = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  u: {
    id: string;
    text: string;
    mentions: string[];
    parentAuthorId?: string | null;
    previousMentions?: string[];
    edited?: boolean;
  },
) => {
  const mentioned = u.mentions.filter((id) => !u.previousMentions?.includes(id));
  const draft = { item, updateId: u.id, excerpt: u.text };
  await notify(tx, a, { ...draft, type: 'mention' }, mentioned);
  if (!u.edited) {
    const external = !!a.inbound?.external;
    const skip = new Set([...u.mentions, ...(external ? [] : [a.user.id])]);
    if (u.parentAuthorId && !skip.has(u.parentAuthorId)) {
      await notify(tx, a, { ...draft, type: 'reply' }, [u.parentAuthorId]);
      skip.add(u.parentAuthorId);
    }
    const followers = (await followerIds(tx, item.id)).filter((id) => !skip.has(id));
    // Outside mail: its address's creator hears about it too (they did not write it).
    await notify(tx, a, { ...draft, type: 'item_update' }, external ? [...followers, a.user.id] : followers);
    await followItem(tx, a.ctx.accountId, item.id, [a.user.id], 'update');
  }
  await followItem(tx, a.ctx.accountId, item.id, mentioned, 'mentioned');
};

const PAGE = 30;

export const listMyNotifications = async (
  db: Db,
  a: Actor,
  opts: { before?: string; limit?: number; unread?: boolean },
): Promise<NotificationList> => {
  const limit = Math.min(opts.limit ?? PAGE, 100);
  const rows = await listNotifications(db, a.ctx.accountId, a.user.id, { ...opts, limit: limit + 1 });
  const page = rows.slice(0, limit);
  // Boards I can no longer read drop out of the list (their names would leak).
  const readable = await readableBoardIds(
    db,
    a.ctx,
    a.user,
    page.flatMap((r) => (r.boardId ? [r.boardId] : [])),
  );
  // Doc notifications (M8): only docs I can still read (gone or hidden → dropped, like a board).
  const docIds = [...new Set(page.flatMap((r) => (r.n.docId ? [r.n.docId] : [])))];
  const readableDocs = new Set<string>();
  for (const id of docIds) {
    try {
      await loadDocAccess(db, a.ctx, a.user, id);
      readableDocs.add(id);
    } catch {
      // not readable any more
    }
  }
  // Dashboard notifications (shared with me): only dashboards I can still open.
  const readableDashboards = new Set<string>();
  for (const id of new Set(page.flatMap((r) => (r.n.dashboardId ? [r.n.dashboardId] : [])))) {
    try {
      await loadDashboardAccess(db, a.ctx, a.user, id);
      readableDashboards.add(id);
    } catch {
      // not readable any more
    }
  }
  const data: Notification[] = page
    .filter((r) =>
      r.n.docId
        ? readableDocs.has(r.n.docId)
        : r.n.dashboardId
          ? readableDashboards.has(r.n.dashboardId)
          : !r.boardId || readable.has(r.boardId),
    )
    .map(({ n, actorName, itemName, boardId, boardName, docName, dashboardName }) => {
      const payload = n.payload as {
        excerpt?: string;
        column_title?: string;
        thread_id?: string;
        agent?: { agent_id: string; agent_name: string | null; run_id: string; approval_id: string | null };
        ticket?: { id: string; number: number; subject: string };
        flow?: { connection_id?: string; flow_id?: string | null; run_id?: string | null };
        view_name?: string;
        column_key?: string;
      };
      return {
        doc: n.docId ? { id: n.docId, name: docName ?? '', thread_id: payload.thread_id ?? null } : null,
        dashboard: n.dashboardId ? { id: n.dashboardId, name: dashboardName ?? '' } : null,
        id: n.id,
        type: n.type,
        created_at: n.createdAt.toISOString(),
        read_at: n.readAt?.toISOString() ?? null,
        actor: n.actorId && actorName ? { id: n.actorId, name: actorName } : null,
        board: boardId && boardName ? { id: boardId, name: boardName } : null,
        item: n.itemId && itemName ? { id: n.itemId, name: itemName } : null,
        update_id: n.updateId,
        excerpt: payload.excerpt ?? null,
        column_title: payload.column_title ?? null,
        ...(payload.agent ? { agent: payload.agent } : {}),
        // A support ticket: the bell opens it.
        ...(payload.ticket ? { ticket: payload.ticket } : {}),
        // An external flow: the bell opens it in the flows screen.
        ...(payload.flow?.connection_id
          ? {
              flow: {
                connection_id: payload.flow.connection_id,
                flow_id: payload.flow.flow_id ?? null,
                run_id: payload.flow.run_id ?? null,
              },
            }
          : {}),
        // A relation column's view is gone (r19relfilter): the bell opens that column's settings.
        ...(n.type === 'relation_view_missing'
          ? { relation_view: { view_name: payload.view_name ?? '', column_key: payload.column_key ?? null } }
          : {}),
      };
    });
  return {
    data,
    unread_count: await unreadCount(db, a.ctx.accountId, a.user.id),
    next_cursor: rows.length > limit ? page[page.length - 1]!.n.id : null,
  };
};

export const markMyNotificationsRead = async (db: Db, a: Actor, ids: string[] | null) => {
  await markRead(db, a.ctx.accountId, a.user.id, ids);
  await announceRead(db, a.ctx.accountId, a.user.id);
  return { ok: true as const, unread_count: await unreadCount(db, a.ctx.accountId, a.user.id) };
};

// ---------------------------------------------------------------------------
// Settings (08 §12.2–12.3) and following (D15)
// ---------------------------------------------------------------------------

/**
 * My settings in this account: per category bell / email / phone (bell and email on unless switched off; the phone
 * only for PUSH_DEFAULT_CATEGORIES unless chosen), digest, muted boards, phone quiet hours and the icon badge.
 */
export const mySettings = async (db: Db, a: Actor): Promise<NotificationSettings> => {
  const rows = (await settingRows(db, a.ctx.accountId, [a.user.id])).get(a.user.id) ?? [];
  const off = (channel: NotificationChannel, key: string) =>
    rows.some((r) => r.channel === channel && r.type === key && r.board_id === null && !r.enabled);
  const digest = digestOf(rows);
  const pushRow = (type: string) => rows.find((r) => r.channel === 'push' && r.type === type && r.board_id === null);
  return {
    categories: NOTIFICATION_CATEGORIES.map((key) => ({
      key,
      bell: !off('in_app', key),
      email: !off('email', key),
      push: !off('push', key),
    })),
    digest: digest.frequency,
    digest_hour: digest.hour,
    digest_weekday: digest.weekday,
    muted_boards: await mutedBoards(db, a.ctx.accountId, a.user.id),
    quiet: parseQuiet(pushRow('*')?.digest),
    badge: pushRow(PUSH_BADGE_ROW)?.enabled ?? true,
  };
};

export const updateMySettings = async (
  db: Db,
  a: Actor,
  input: {
    categories?: { key: string; bell?: boolean; email?: boolean; push?: boolean }[];
    digest?: DigestFrequency;
    digest_hour?: number;
    digest_weekday?: number;
    quiet?: QuietHours;
    badge?: boolean;
  },
) => {
  const base = { accountId: a.ctx.accountId, userId: a.user.id, boardId: null };
  await db.transaction(async (tx) => {
    // One change of my settings at a time: the page saves each pick at once, and parallel saves (delete + insert of the
    // same row, and the summary read before it is changed) failed with a unique violation or lost a pick.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notif-settings:${a.ctx.accountId}:${a.user.id}`}))`);
    // A summary change starts from what I get now (my row, else the account default).
    const current = digestOf((await settingRows(tx, a.ctx.accountId, [a.user.id])).get(a.user.id) ?? []);
    for (const c of input.categories ?? []) {
      if (c.bell !== undefined) await putSetting(tx, { ...base, channel: 'in_app', type: c.key, enabled: c.bell });
      if (c.email !== undefined) await putSetting(tx, { ...base, channel: 'email', type: c.key, enabled: c.email });
      if (c.push !== undefined) await putSetting(tx, { ...base, channel: 'push', type: c.key, enabled: c.push });
    }
    // The phone's account-wide row keeps the quiet hours (`quiet:<from>:<to>`); a separate row the badge choice.
    if (input.quiet)
      await putSetting(tx, { ...base, channel: 'push', type: '*', enabled: true, digest: formatQuiet(input.quiet) });
    if (input.badge !== undefined)
      await putSetting(tx, { ...base, channel: 'push', type: PUSH_BADGE_ROW, enabled: input.badge });
    if (input.digest !== undefined || input.digest_hour !== undefined || input.digest_weekday !== undefined) {
      const digest = formatDigest({
        frequency: input.digest ?? current.frequency,
        hour: input.digest_hour ?? current.hour,
        weekday: input.digest_weekday ?? current.weekday,
      });
      await putSetting(tx, { ...base, channel: 'email', type: '*', enabled: true, digest });
    }
  });
  return mySettings(db, a);
};

const canMuteForEveryone = (access: BoardAccess) => isOwnerOrAdmin(access);

/** A board's notifications as I see them (board header). Sub-boards follow their parent (D14). */
export const boardNotifications = async (db: Db, a: Actor, boardId: string): Promise<BoardNotifications> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const top = access.board.parentBoardId
    ? await findBoard(db, a.ctx.accountId, access.board.parentBoardId)
    : access.board;
  const rows = ((await settingRows(db, a.ctx.accountId, [a.user.id])).get(a.user.id) ?? []).filter(
    (r) => r.board_id === top?.id,
  );
  const muted = rows.some((r) => r.channel === 'in_app' && r.type === '*' && !r.enabled);
  const off = (channel: 'in_app' | 'email', key: string) =>
    rows.some((r) => r.channel === channel && r.type === key && !r.enabled);
  const custom = !muted && rows.some((r) => r.type !== '*');
  return {
    mode: muted ? 'muted' : custom ? 'custom' : 'all',
    muted,
    categories: NOTIFICATION_CATEGORIES.map((key) => ({ key, bell: !off('in_app', key), email: !off('email', key) })),
    muted_for_everyone: mutedForEveryone(top),
    can_mute_for_everyone: canMuteForEveryone(access),
  };
};

/**
 * Mute a board for myself (bell and email, every category), or — board owners and admins — for everyone.
 * Muting for everyone changes the board, so it is an event (`board.notifications_muted`).
 */
export const setBoardNotifications = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: {
    mode?: 'all' | 'muted';
    muted?: boolean;
    categories?: { key: string; bell: boolean; email: boolean }[];
    muted_for_everyone?: boolean;
  },
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board_follows_parent');
  if (input.muted_for_everyone !== undefined && !canMuteForEveryone(access))
    throw new AppError('forbidden', 'board_owner_only');
  const muted = input.mode ? input.mode === 'muted' : input.muted;
  const me = { accountId: a.ctx.accountId, userId: a.user.id, boardId };
  await db.transaction(async (tx) => {
    // "Everything" and "muted" replace a custom choice; custom replaces a mute.
    if (muted !== undefined || input.categories) await clearBoardSettings(tx, a.ctx.accountId, a.user.id, boardId);
    if (muted) {
      for (const channel of ['in_app', 'email', 'push'] as const)
        await putSetting(tx, { ...me, channel, type: '*', enabled: false });
    } else if (input.categories) {
      for (const c of input.categories) {
        if (!c.bell) await putSetting(tx, { ...me, channel: 'in_app', type: c.key, enabled: false });
        if (!c.email) await putSetting(tx, { ...me, channel: 'email', type: c.key, enabled: false });
      }
    }
    if (input.muted_for_everyone !== undefined) {
      const before = mutedForEveryone(access.board);
      await updateBoardRow(tx, boardId, {
        settings: { ...(access.board.settings as object), notifications_muted: input.muted_for_everyone },
      });
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'board.notifications_muted',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId,
        before: { muted_for_everyone: before },
        after: { muted_for_everyone: input.muted_for_everyone },
      });
    }
  });
  return boardNotifications(db, a, boardId);
};

/** My follow state on an item the caller already loaded (visibility checked). */
export const myFollow = async (db: Db, a: Actor, item: ItemRow) => ({
  following: await isFollowing(db, item.id, a.user.id),
});

export const setMyFollow = async (db: Db, a: Actor, item: ItemRow, following: boolean) => {
  await setFollowing(db, a.ctx.accountId, item.id, a.user.id, following);
  return myFollow(db, a, item);
};

/** An automation's `notify` action (04 §4.2): the rendered message to each recipient who can see the item. */
export const notifyFromAutomation = (tx: Db, a: Actor, item: ItemRow, userIds: string[], message: string) =>
  notify(tx, a, { type: 'automation', item, excerpt: message }, userIds);

/**
 * An automation's message about no item — a board-level run about an external flow: to the active
 * members of `userIds` who can read the board, by their settings for the board; `flow` = where a click opens it.
 */
export const notifyBoardFromAutomation = async (
  tx: Db,
  a: Actor,
  boardId: string,
  userIds: string[],
  message: string,
  flow: { connection_id: string; flow_id: string | null; run_id: string | null },
) => {
  const board = await findBoard(tx, a.ctx.accountId, boardId);
  if (!board || mutedForEveryone(board)) return [];
  const audienceIds: string[] = [];
  for (const id of new Set(userIds)) {
    const m = await findMembership(tx, a.ctx.accountId, id);
    if (m?.status !== 'active') continue;
    try {
      const ctx = { ...a.ctx, role: m.role, membershipId: m.id };
      assertBoard(await loadBoardAccess(tx, ctx, { id } as SessionUser, boardId), 'item.read');
      audienceIds.push(id);
    } catch {
      // cannot read the board: no notification
    }
  }
  return notifyUsers(
    tx,
    {
      accountId: a.ctx.accountId,
      type: 'automation',
      actorId: a.user.id,
      boardIds: [boardId],
      target: { boardId, itemId: null },
      payload: { excerpt: message, flow },
    },
    audienceIds,
  );
};
