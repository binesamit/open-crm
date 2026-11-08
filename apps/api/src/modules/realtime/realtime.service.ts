// SPDX-License-Identifier: AGPL-3.0-only
import {
  AGENT_LIVE_EVENTS,
  AI_LIVE_EVENTS,
  APP_PAGE_LIVE_EVENTS,
  AppError,
  idAt,
  idTime,
  isId,
  PLAN_LIVE_EVENTS,
  SIDEBAR_EVENTS,
  STREAM_RESYNC,
  type StreamEvent,
  UPDATE_SEEN,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { BusEvent } from '../../lib/realtime';
import type { Actor } from '../../types';
import { stillInAccount } from '../support/support.access';
import { loadBoardAccess } from '../boards/boards.access';
import { findSubBoard, listColumns } from '../boards/boards.repo';
import { listBoardItems } from '../items/items.repo';
import { boardVisibility, filterVisible, isVisible, type Visibility } from '../items/visibility';
import { loadItem } from '../items/items.service';
import { boardEventsAfter, inInbox, itemAnyState, itemsLinkingTo, notificationsAfter } from './realtime.repo';

/** Replay covers a day (01 §4); a longer gap, or more than this many events, asks the client to refetch. */
export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REPLAY_LIMIT = 500;
/**
 * Commit order is not id order: replay starts this much before the last id so a late commit is not lost. Ids are
 * minted at insert time, so the slack has to cover a transaction's life (a bulk edit, an import), not a round
 * trip; the client re-sends anything already seen harmlessly (a row refresh), and the board page refetches on
 * every `ready` anyway (audit 2026-10-10, realtime #6/#7).
 */
const REPLAY_SLACK_MS = 60_000;

export type Verdict = 'send' | 'skip' | 'close';

/** What one SSE connection may hear, and how it catches up after a reconnect. */
export type StreamFilter = {
  accept: (e: BusEvent) => Promise<Verdict>;
  /** Events since Last-Event-ID, or `resync` when the gap is too large to replay. */
  replay: (lastId: string) => Promise<BusEvent[] | typeof STREAM_RESYNC>;
  /** Still an active member of the account (checked on every heartbeat). */
  stillAllowed: () => Promise<boolean>;
  /** What of an accepted event is sent (a dashboard sends the board only — M8 ד4); default: all of it. */
  map?: (e: BusEvent) => BusEvent;
  /**
   * Fix: — events this channel derives from one it skipped (another board's item changed, and items here
   * mirror it): sent without an id (they are not in the activity log, so never part of a Last-Event-ID replay).
   */
  derive?: (e: BusEvent) => Promise<BusEvent[]>;
};

/** The derived event: an item here shows something of a linked item that changed (mirror / relation names). */
export const LINKED_CHANGED = 'item.linked_changed';
/** More dependent rows than this: one board-level refresh instead of one event per row. */
export const LINKED_ROWS_MAX = 200;
/** Changes of a linked item that its mirrors / relation cells can show. */
const linkedSourceEvent = (type: string) =>
  (type.startsWith('cell.') || type.startsWith('item.')) && type !== LINKED_CHANGED;

export const toStreamEvent = (e: BusEvent): StreamEvent => ({
  id: e.id,
  type: e.type,
  board_id: e.board_id ?? null,
  item_id: e.item_id ?? null,
  column_id: e.column_id ?? null,
  actor_id: e.actor_id ?? null,
  batch_id: e.batch_id ?? null,
  request_id: e.request_id ?? null,
  ...(e.update_id ? { update_id: e.update_id, seen: e.seen ?? null } : {}),
});

/** The id the replay starts from (the last id's moment less the slack), or null when the gap is past the window. */
const replayStart = (lastId: string): string | null => {
  if (!isId(lastId)) return null;
  const at = idTime(lastId);
  if (Date.now() - at > REPLAY_WINDOW_MS) return null;
  return idAt(at - REPLAY_SLACK_MS);
};

/** Still in the account: an active member, or an active support grant (revoked / expired → the stream closes). */
const memberCheck = (db: Db, a: Actor) => async () => stillInAccount(db, a.ctx.accountId, a.user.id);

/**
 * Board channel (`GET /boards/:id/events`): the board and its sub-board (D14). Read access is checked on
 * connect and again on every `board.*` / `team.*` event (permissions, members, deletion); losing it closes
 * the stream. Item events pass only when the viewer may see the item (`view_items`, 05 §6) — or could see it
 * until now: a restricted viewer keeps the set of items it sees, so the event that takes an item out of it
 * (assignment removed) is still sent and the client drops the item.
 */
export const boardStream = async (db: Db, a: Actor, boardId: string): Promise<StreamFilter> => {
  const first = await loadBoardAccess(db, a.ctx, a.user, boardId); // 404 when unreadable
  const rootId = first.board.parentBoardId ?? first.board.id;
  let boards = new Map<string, Visibility>();
  /** Items a restricted viewer sees now (boards without a rule are not tracked). */
  let seen = new Set<string>();
  /** Boards the relation columns here point at (Fix: ): their item changes may show here through mirrors. */
  let linked = new Set<string>();
  const loadLinked = async () => {
    const next = new Set<string>();
    for (const id of boards.keys())
      for (const c of await listColumns(db, id))
        if (c.type === 'board_relation')
          for (const b of ((c.settings as { board_ids?: unknown }).board_ids as unknown[] | undefined) ?? [])
            if (typeof b === 'string') next.add(b);
    linked = next;
  };

  const load = async () => {
    const root = await loadBoardAccess(db, a.ctx, a.user, rootId);
    const next = new Map<string, Visibility>([[rootId, await boardVisibility(db, a, root)]]);
    const sub = await findSubBoard(db, rootId);
    if (sub) {
      const subAccess = await loadBoardAccess(db, a.ctx, a.user, sub.id);
      next.set(sub.id, await boardVisibility(db, a, subAccess));
    }
    const nextSeen = new Set<string>();
    for (const [id, v] of next) {
      if (!v) continue;
      for (const i of await filterVisible(db, v, await listBoardItems(db, id))) nextSeen.add(i.id);
    }
    boards = next;
    seen = nextSeen;
    await loadLinked();
  };
  await load();

  const accept = async (e: BusEvent): Promise<Verdict> => {
    if (e.user_id) return 'skip'; // personal (notifications) — the /me channel
    // r16seen: who saw an update is not for guests (their `seen` is null too); the item check below still applies.
    if (e.type === UPDATE_SEEN && a.ctx.role === 'guest') return 'skip';
    const touchesAccess = (e.board_id === rootId && e.type.startsWith('board.')) || e.type.startsWith('team.');
    if (touchesAccess) {
      try {
        await load();
      } catch {
        return 'close';
      }
      // A team change (members, deletion) can change what this viewer sees here: the board refetches.
      if (e.type.startsWith('team.')) return 'send';
    }
    if (!e.board_id || !boards.has(e.board_id)) return 'skip';
    // A relation column added / changed / removed here changes which boards are linked.
    if (e.type.startsWith('column.')) await loadLinked().catch(() => undefined);
    const v = boards.get(e.board_id) ?? null;
    if (v && e.item_id) {
      const item = await itemAnyState(db, a.ctx.accountId, e.item_id);
      const now = !!item && (await isVisible(db, v, item));
      const was = seen.delete(e.item_id);
      if (now) seen.add(e.item_id);
      else if (!was) return 'skip';
    }
    return 'send';
  };

  /**
   * Fix: ("a mirror does not update live"): an item on a linked board changed — the items here that
   * link to it get `item.linked_changed`, so the browser refetches just those rows (their mirrors, relation names,
   * formulas over mirrors). Only items this viewer may see; the event says nothing about the source item.
   */
  const derive = async (e: BusEvent): Promise<BusEvent[]> => {
    // A linked board — another one, or this one when a relation column points back at its own board.
    if (e.user_id || !e.item_id || !e.board_id || !linked.has(e.board_id)) return [];
    if (!linkedSourceEvent(e.type) || e.type === UPDATE_SEEN) return [];
    const rows = await itemsLinkingTo(db, a.ctx.accountId, e.item_id, [...boards.keys()], LINKED_ROWS_MAX + 1);
    const base = { id: '', account_id: e.account_id, type: LINKED_CHANGED, column_id: null, actor_id: e.actor_id };
    if (rows.length > LINKED_ROWS_MAX) return [{ ...base, board_id: rootId, item_id: null }];
    const out: BusEvent[] = [];
    for (const row of rows) {
      if (row.id === e.item_id) continue; // linked to itself: its own event already refreshes it
      const v = boards.get(row.boardId) ?? null;
      if (v && !(await isVisible(db, v, row))) continue;
      out.push({ ...base, board_id: row.boardId, item_id: row.id });
    }
    return out;
  };

  return {
    accept,
    derive,
    stillAllowed: memberCheck(db, a),
    replay: async (lastId) => {
      const since = replayStart(lastId);
      if (!since) return STREAM_RESYNC;
      const rows = await boardEventsAfter(db, a.ctx.accountId, [...boards.keys()], since, REPLAY_LIMIT + 1);
      if (rows.length > REPLAY_LIMIT) return STREAM_RESYNC;
      return rows
        .filter((r) => r.id !== lastId)
        .map((r) => ({
          id: r.id,
          account_id: r.accountId,
          type: r.type,
          board_id: r.boardId,
          item_id: r.itemId,
          column_id: r.columnId,
          actor_id: r.actorId,
          actor_type: r.actorType,
          batch_id: r.batchId,
          request_id: r.requestId,
        }));
    },
  };
};

/** r16seen: an `update.seen` reaches /me/events when the update is in my Inbox and I may read its item. */
const seenInMyInbox = async (db: Db, a: Actor, e: BusEvent): Promise<Verdict> => {
  if (a.ctx.role === 'guest' || !e.update_id || !e.item_id) return 'skip';
  if (!(await inInbox(db, a.ctx.accountId, a.user.id, e.update_id))) return 'skip';
  try {
    await loadItem(db, a, e.item_id);
    return 'send';
  } catch (err) {
    if (err instanceof AppError) return 'skip';
    throw err;
  }
};

/** Personal channel (`GET /me/events`): what is addressed to this user in this account (notifications). */
export const meStream = (db: Db, a: Actor): StreamFilter => ({
  // Mine — and the sidebar signals (a doc created / renamed / moved / shared / deleted by someone: the type only,
  // never which doc; the sidebar refetches what the reader may see, M8 ד2), and the AI signals (a connection or
  // the account's AI settings changed: every AI screen refetches — sync-ai), and the plan signal (the account's plan
  // status changed: the app refetches /me/accounts — plans), and the agent signals (an agent created /
  // changed / deleted: mention lists and people pickers refetch the directory), and the count beside an
  // extension's sidebar page (the account's; a member's own is addressed to them). r16seen: `update.seen` of an update in my
  // Inbox, while I may still read its item (not for guests).
  accept: async (e) => {
    if (e.type === UPDATE_SEEN && !e.user_id) return seenInMyInbox(db, a, e);
    return e.user_id === a.user.id ||
      (!e.user_id &&
        (SIDEBAR_EVENTS.has(e.type) ||
          AI_LIVE_EVENTS.has(e.type) ||
          AGENT_LIVE_EVENTS.has(e.type) ||
          PLAN_LIVE_EVENTS.has(e.type) ||
          APP_PAGE_LIVE_EVENTS.has(e.type)))
      ? 'send'
      : 'skip';
  },
  stillAllowed: memberCheck(db, a),
  replay: async (lastId) => {
    const since = replayStart(lastId);
    if (!since) return STREAM_RESYNC;
    const rows = await notificationsAfter(db, a.ctx.accountId, a.user.id, since, REPLAY_LIMIT + 1);
    if (rows.length > REPLAY_LIMIT) return STREAM_RESYNC;
    return rows
      .filter((r) => r.id !== lastId)
      .map((r) => ({
        id: r.id,
        account_id: r.accountId,
        type: 'notification.created',
        board_id: r.boardId,
        item_id: r.itemId,
        actor_id: r.actorId,
        user_id: r.userId,
      }));
  },
});
