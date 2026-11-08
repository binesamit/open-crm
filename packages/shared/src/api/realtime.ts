// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { type UpdateSeen, updateSeenSchema } from './updates';

/**
 * One message on an SSE channel (01 §4): ids only — the browser refetches what it shows. `ready` opens every
 * stream; `resync` means "too much was missed, refetch everything"; `revoked` means access was lost.
 */
export const streamEventSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    board_id: z.string().nullable().optional(),
    item_id: z.string().nullable().optional(),
    column_id: z.string().nullable().optional(),
    actor_id: z.string().nullable().optional(),
    batch_id: z.string().nullable().optional(),
    request_id: z.string().nullable().optional(),
    /** `update.seen` only: the update or reply whose viewers changed. */
    update_id: z.string().nullable().optional(),
    /** `update.seen` only: its viewer count now and the newest viewers (photos left out — the app has them). */
    seen: updateSeenSchema.nullable().optional(),
    /** `ready` only, client-side: told to a late joiner of an open channel — not a (re)connection of the stream. */
    late: z.boolean().optional(),
  })
  .meta({ id: 'StreamEvent' });
export type StreamEvent = z.infer<typeof streamEventSchema>;

export const STREAM_READY = 'ready';
export const STREAM_RESYNC = 'resync';
export const STREAM_REVOKED = 'revoked';
/** Query parameter carrying the account on SSE routes (EventSource cannot send X-Account-Id). */
export const ACCOUNT_QUERY = 'account_id';

/**
 * Live row refresh (perf review): an event about one item (a cell, the item itself, its updates, files, time)
 * refetches just that row — `GET /boards/:id/items?ids=` — instead of the whole board, which on a 30k-item board
 * is ~40 MB and seconds of server time for every viewer on every edit. At most this many rows per request.
 */
export const LIVE_ROWS_MAX = 200;

/**
 * Events that change what a workspace's sidebar shows (M8 ד2): `/me/events` passes them to everyone in the
 * account — the type only, never which doc — and the sidebar refetches what the reader may see.
 */
export const SIDEBAR_EVENTS: ReadonlySet<string> = new Set([
  'doc.created',
  'doc.updated',
  'doc.moved',
  'doc.deleted',
  'doc.restored',
  'doc.duplicated',
  'doc.members_changed',
  // The open-comment counts next to docs (ד3).
  'doc.comment_added',
  'doc.comment_deleted',
  'doc.thread_resolved',
  'doc.thread_reopened',
  // Dashboards (ד4).
  'dashboard.created',
  'dashboard.updated',
  'dashboard.moved',
  'dashboard.deleted',
  'dashboard.restored',
  'dashboard.duplicated',
  'dashboard.members_changed',
]);
/**
 * Events that change what AI screens show (sync-ai: "connecting AI should work everywhere at once"): an AI
 * connection added / changed / removed, or the account's settings (AI on / off, the assistant's connection).
 * `/me/events` passes them to everyone in the account — the type only — and every AI screen refetches.
 */
export const AI_LIVE_EVENTS: ReadonlySet<string> = new Set([
  'ai_connection.created',
  'ai_connection.updated',
  'ai_connection.deleted',
  'account.updated',
]);

/**
 * r16seen ("it must be live — also for the viewer"): someone saw an update or reply for the first time
 * (or on a new device). Not an activity row and never replayed; it carries the count and the newest viewers so
 * open screens patch the update's `seen` without a refetch. Never a row event (nothing on the board changed).
 */
export const UPDATE_SEEN = 'update.seen';
/** How many of the newest viewers ride on an `update.seen` event (the NOTIFY payload stays small). */
export const SEEN_EVENT_USERS = 5;

/**
 * Merges an `update.seen` event into a cached `seen`: the event's viewers go first (newest), each person once,
 * capped at the preview limit; the count is the server's. A photo the cache already had is kept.
 */
export const mergeSeen = (old: UpdateSeen | null | undefined, live: UpdateSeen, limit: number): UpdateSeen => {
  const before = new Map((old?.users ?? []).map((u) => [u.id, u]));
  const fresh = live.users.map((u) => ({ ...u, avatar_url: u.avatar_url ?? before.get(u.id)?.avatar_url ?? null }));
  const ids = new Set(fresh.map((u) => u.id));
  const users = [...fresh, ...(old?.users ?? []).filter((u) => !ids.has(u.id))].slice(0, limit);
  return { count: Math.max(live.count, users.length), users };
};

/**
 * An account's plan status changed (plans): the owner assigned / changed / ended its subscription, status
 * or override, a billing provider reported a change, the billing settings moved it, or a scheduled step happened (a
 * trial ended, the grace ran out, read-only became suspended). `/me/events` passes it to everyone in the account —
 * the type only (`{ id, type: 'account.plan_changed' }`) — and the app refetches `GET /me/accounts` (`plan_status`).
 */
export const PLAN_CHANGED_EVENT = 'account.plan_changed';
export const PLAN_LIVE_EVENTS: ReadonlySet<string> = new Set([PLAN_CHANGED_EVENT]);

/**
 * the count beside an extension's sidebar page changed. `/me/events` passes it to the member it is for
 * (`user_id`), or to everyone in the account (the account's count) — the type only; the sidebar refetches
 * `GET /extensions/app-pages`. Not an activity row, never replayed.
 */
export const APP_PAGE_BADGE_EVENT = 'extension.app_page_badge';
export const APP_PAGE_LIVE_EVENTS: ReadonlySet<string> = new Set([APP_PAGE_BADGE_EVENT]);

const ROW_EVENTS = new Set(['item', 'cell', 'update', 'file', 'time', 'vote', 'secret']);

/** Whether an event can be applied by refreshing its item's row (else: refetch the board's items). */
export const isRowEvent = (e: Pick<StreamEvent, 'type' | 'item_id' | 'board_id'>) =>
  e.type !== UPDATE_SEEN && !!e.item_id && !!e.board_id && ROW_EVENTS.has(e.type.split('.')[0]!);

/**
 * Merges refreshed rows into a cached list: `asked` ids that came back replace their row (or are appended when
 * new); asked ids that did not come back are gone (deleted, archived, moved away, now hidden) and are dropped.
 * Rows not asked about are untouched; order is kept (the table sorts by group and position itself).
 */
export const mergeRows = <T extends { id: string }>(rows: T[], asked: string[], fresh: T[]): T[] => {
  const byId = new Map(fresh.map((r) => [r.id, r]));
  const askedSet = new Set(asked);
  const out = rows.filter((r) => !askedSet.has(r.id) || byId.has(r.id)).map((r) => byId.get(r.id) ?? r);
  const present = new Set(rows.map((r) => r.id));
  for (const r of fresh) if (!present.has(r.id)) out.push(r);
  return out;
};
