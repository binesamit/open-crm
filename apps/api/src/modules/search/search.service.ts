// SPDX-License-Identifier: AGPL-3.0-only
import {
  displayUpdateHtml,
  INBOX_MONTHS,
  type Inbox,
  type InboxEntry,
  SEARCH_LIMIT,
  SEARCH_MIN,
  SEARCH_RECENT_MAX,
  type SearchResult,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { FileStorage } from '../../lib/storage';
import { seenOf } from '../updates/views.service';
import type { Actor } from '../../types';
import { readableBoardIds } from '../boards/boards.access';
import { boardsByIds, listGroups } from '../boards/boards.repo';
import { itemsByIds, type ItemRow } from '../items/items.repo';
import { visibleAcrossBoards } from '../items/visibility';
import { memberSettings, setMemberSettings } from '../mywork/mywork.repo';
import { announceRead, markUpdatesRead } from '../notifications/notifications.repo';
import {
  boardHits,
  dismissInbox,
  dashboardHits,
  docHits,
  fileHits,
  inboxRows,
  itemHits,
  peopleHits,
  tagHits,
  updateHits,
} from './search.repo';
import { readableDocIds } from '../docs/docs.access';
import { readableDashboards } from '../dashboards/dashboards.access';
import { dashboardsByIds } from '../dashboards/dashboards.repo';

/** Hits are fetched in surplus, then filtered by access; this many per kind are kept. */
const SURPLUS = 5;

/** The board an item opens on — its own, or the parent board for a subitem (D14) — with its name. */
const topBoards = async (db: Db, accountId: string, boardIds: string[]) => {
  const own = await boardsByIds(db, accountId, [...new Set(boardIds)]);
  const parents = await boardsByIds(db, accountId, [
    ...new Set(own.flatMap((b) => (b.parentBoardId ? [b.parentBoardId] : []))),
  ]);
  const byId = new Map([...own, ...parents].map((b) => [b.id, b]));
  return (boardId: string) => {
    const b = byId.get(boardId);
    const top = b?.parentBoardId ? byId.get(b.parentBoardId) : b;
    return top ? { id: top.id, name: top.name } : null;
  };
};

/** Items (by id) that exist and the actor may see, in the order given. */
const visibleItems = async (db: Db, a: Actor, ids: string[]) => {
  const rows = await itemsByIds(db, a.ctx.accountId, [...new Set(ids)]);
  const ok = await visibleAcrossBoards(db, a, rows);
  const byId = new Map(rows.filter((r) => ok.has(r.id)).map((r) => [r.id, r]));
  return byId;
};

/**
 * GET /search (07 §9.1): items (name or cell text), boards, updates and people. Every item and update hit is
 * on a board the actor can read and an item they may see (05 §6); boards likewise. Guests get no people.
 */
export const searchEverything = async (
  db: Db,
  a: Actor,
  raw: string,
  opts: { archived?: boolean } = {},
): Promise<SearchResult> => {
  // `#name` = by tag: items through their tags columns, and the tags themselves (03 §3.1). A plain search finds
  // tagged items too (fix2); a `#tag` search lists more of them (it is "show me this tag's items").
  const tagMode = raw.trim().startsWith('#');
  const q = raw.trim().replace(/^#+/, '').trim();
  const empty = { items: [], boards: [], updates: [], people: [], tags: [], files: [], docs: [], dashboards: [] };
  const archived = !!opts.archived;
  if (q.length < (tagMode ? 1 : SEARCH_MIN)) return empty;
  const acc = a.ctx.accountId;
  const guest = a.ctx.role === 'guest';
  const none = Promise.resolve([]);
  const itemLimit = tagMode ? SEARCH_LIMIT * 3 : SEARCH_LIMIT;
  const [itemRows, boardRows, updateRows, people, tags, fileRows, docRows, dashboardRows] = await Promise.all([
    itemHits(db, acc, q, itemLimit * SURPLUS, tagMode, archived),
    tagMode ? none : boardHits(db, acc, q, SEARCH_LIMIT * SURPLUS),
    tagMode ? none : updateHits(db, acc, q, SEARCH_LIMIT * SURPLUS),
    guest || tagMode ? none : peopleHits(db, acc, q, SEARCH_LIMIT),
    guest ? none : tagHits(db, acc, q, SEARCH_LIMIT),
    tagMode ? none : fileHits(db, acc, q, SEARCH_LIMIT * SURPLUS, archived),
    tagMode ? none : docHits(db, acc, q, SEARCH_LIMIT * SURPLUS),
    tagMode ? none : dashboardHits(db, acc, q, SEARCH_LIMIT * SURPLUS),
  ]);
  // Dashboards: only those I may open — for a guest, the shareable ones shared with them.
  const workspaceOf = new Map(dashboardRows.map((d) => [d.id, d.workspace]));
  const dashboards = (
    await readableDashboards(
      db,
      a.ctx,
      a.user,
      await dashboardsByIds(
        db,
        acc,
        dashboardRows.map((d) => d.id),
      ),
    )
  )
    .slice(0, SEARCH_LIMIT)
    .map(({ dashboard: d }) => ({ id: d.id, name: d.name, workspace: workspaceOf.get(d.id) ?? null }));
  // Docs (M8): only those I may open, with the text around the match when the name did not match.
  const docOk = await readableDocIds(
    db,
    a.ctx,
    a.user,
    docRows.map((d) => d.id),
  );
  const docs = docRows
    .filter((d) => docOk.has(d.id))
    .slice(0, SEARCH_LIMIT)
    .map((d) => ({
      id: d.id,
      name: d.name,
      workspace: d.workspace,
      excerpt: d.text ? excerptAround(d.text.replace(/\s+/g, ' '), q) : null,
    }));

  const items = await visibleItems(db, a, [
    ...itemRows.map((r) => r.id),
    ...updateRows.map((r) => r.item_id),
    ...fileRows.map((r) => r.item_id),
  ]);
  const top = await topBoards(
    db,
    acc,
    [...items.values()].map((i) => i.boardId),
  );
  const groupsOf = new Map<string, Awaited<ReturnType<typeof listGroups>>>();
  const groupOf = async (item: ItemRow) => {
    if (!item.groupId) return null;
    if (!groupsOf.has(item.boardId)) groupsOf.set(item.boardId, await listGroups(db, item.boardId));
    const g = groupsOf.get(item.boardId)!.find((x) => x.id === item.groupId);
    return g ? { title: g.title, color: g.color } : null;
  };

  const itemOut: SearchResult['items'] = [];
  for (const r of itemRows) {
    const item = items.get(r.id);
    const board = item && top(item.boardId);
    if (!item || !board) continue;
    itemOut.push({
      id: item.id,
      name: item.name,
      board,
      group: await groupOf(item),
      matched: r.matched,
      archived: !!item.archivedAt,
    });
    if (itemOut.length === itemLimit) break;
  }

  const readable = await readableBoardIds(
    db,
    a.ctx,
    a.user,
    boardRows.map((b) => b.id),
  );
  const boards = boardRows.filter((b) => readable.has(b.id)).slice(0, SEARCH_LIMIT);

  const updates: SearchResult['updates'] = [];
  for (const u of updateRows) {
    const item = items.get(u.item_id);
    const board = item && top(item.boardId);
    if (!item || !board) continue;
    updates.push({
      id: u.id,
      item: { id: item.id, name: item.name },
      board,
      author: u.author,
      excerpt: excerptAround(u.body_text, q),
      created_at: new Date(u.created_at).toISOString(),
    });
    if (updates.length === SEARCH_LIMIT) break;
  }

  const files: SearchResult['files'] = [];
  for (const f of fileRows) {
    const item = items.get(f.item_id);
    const board = item && top(item.boardId);
    if (!item || !board) continue;
    files.push({ id: f.id, name: f.name, item: { id: item.id, name: item.name }, board, in_update: f.in_update });
    if (files.length === SEARCH_LIMIT) break;
  }

  return { items: itemOut, boards, updates, people, tags, files, docs, dashboards };
};

/** My recent searches in this account (newest first), kept on the server. */
export const recentSearches = async (db: Db, a: Actor) => {
  const all = (await memberSettings(db, a.ctx.accountId, a.user.id)) as { recent_searches?: unknown };
  return Array.isArray(all.recent_searches)
    ? all.recent_searches.filter((x): x is string => typeof x === 'string').slice(0, SEARCH_RECENT_MAX)
    : [];
};

export const rememberSearch = async (db: Db, a: Actor, q: string) => {
  const all = (await memberSettings(db, a.ctx.accountId, a.user.id)) as Record<string, unknown>;
  const next = [q, ...(await recentSearches(db, a)).filter((x) => x !== q)].slice(0, SEARCH_RECENT_MAX);
  await setMemberSettings(db, a.ctx.accountId, a.user.id, { ...all, recent_searches: next });
  return next;
};

export const clearRecentSearches = async (db: Db, a: Actor) => {
  const all = (await memberSettings(db, a.ctx.accountId, a.user.id)) as Record<string, unknown>;
  await setMemberSettings(db, a.ctx.accountId, a.user.id, { ...all, recent_searches: [] });
  return [];
};

/** ~120 characters of `text` around the first match of `q`. */
export const excerptAround = (text: string, q: string, size = 120) => {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0 || text.length <= size) return text.slice(0, size);
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), text.length - size));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + size)}${start + size < text.length ? '…' : ''}`;
};

const INBOX_PAGE = 20;
/** The top-bar badge counts up to this many (shown as 99+). */
const INBOX_COUNT_MAX = 100;

const inboxSince = () => {
  const since = new Date();
  since.setMonth(since.getMonth() - INBOX_MONTHS);
  return since;
};

/** My "mark all read" watermark for this account's Inbox. */
const clearedAt = async (db: Db, a: Actor) => {
  const v = ((await memberSettings(db, a.ctx.accountId, a.user.id)) as { inbox_cleared_at?: string }).inbox_cleared_at;
  return v ? new Date(v) : null;
};

/** Rows → entries I may still see, with the board each opens on. */
const toEntries = async (db: Db, a: Actor, rows: Awaited<ReturnType<typeof inboxRows>>): Promise<InboxEntry[]> => {
  const items = await visibleItems(
    db,
    a,
    rows.map((r) => r.item_id),
  );
  const top = await topBoards(
    db,
    a.ctx.accountId,
    [...items.values()].map((i) => i.boardId),
  );
  return rows.flatMap((r) => {
    const item = items.get(r.item_id);
    const board = item && top(item.boardId);
    if (!item || !board) return [];
    return [
      {
        id: r.id,
        parent_update_id: r.parent_update_id,
        item: { id: item.id, name: item.name },
        board,
        author: r.author_id && r.author_name ? { id: r.author_id, name: r.author_name } : null,
        body_html: displayUpdateHtml(r.body_html, r.body_text),
        file_names: r.file_names ?? [],
        created_at: new Date(r.created_at).toISOString(),
        mention: r.mention,
        read: r.read,
      },
    ];
  });
};

/**
 * GET /me/inbox (07 §9.3): updates and replies by others on items I follow, plus those that mention me, from
 * the last 6 months, newest first; only items I can still see. Read ones (V, or before "mark all read") are
 * left out unless `read`; `mentions` keeps only the ones naming me.
 */
export const myInbox = async (
  db: Db,
  a: Actor,
  opts: { before?: string; mentions?: boolean; read?: boolean },
  storage?: FileStorage,
): Promise<Inbox> => {
  const rows = await inboxRows(db, a.ctx.accountId, a.user.id, {
    since: inboxSince(),
    before: opts.before,
    mentionsOnly: !!opts.mentions,
    limit: INBOX_PAGE + 1,
    clearedAt: await clearedAt(db, a),
    includeRead: !!opts.read,
  });
  const page = rows.slice(0, INBOX_PAGE);
  const entries = await toEntries(db, a, page);
  // r16seen: who saw each entry (the same `seen` as in the item's thread; null when off, and for guests).
  const seen = await seenOf(
    db,
    a,
    entries.map((e) => e.id),
    storage,
  );
  return {
    data: entries.map((e) => ({ ...e, seen: seen(e.id) })),
    next_cursor: rows.length > INBOX_PAGE ? page[page.length - 1]!.id : null,
  };
};

/** Unread Inbox entries for the top-bar badge (counted up to 100). */
export const inboxUnread = async (db: Db, a: Actor) => {
  const rows = await inboxRows(db, a.ctx.accountId, a.user.id, {
    since: inboxSince(),
    mentionsOnly: false,
    limit: INBOX_COUNT_MAX,
    clearedAt: await clearedAt(db, a),
    includeRead: false,
  });
  return { unread: (await toEntries(db, a, rows)).length };
};

/**
 * Mark Inbox entries read: some (V) or all (a watermark at now). Their bell notifications are read with them,
 * and my other tabs hear about it (`notification.read` on /me/events). Reading is personal — no activity event.
 */
export const markInboxRead = async (db: Db, a: Actor, ids: string[] | null) => {
  await db.transaction(async (tx) => {
    if (ids) {
      await dismissInbox(tx, a.ctx.accountId, a.user.id, ids);
      await markUpdatesRead(tx, a.ctx.accountId, a.user.id, ids);
    } else {
      const now = new Date();
      const all = (await memberSettings(tx, a.ctx.accountId, a.user.id)) as Record<string, unknown>;
      await setMemberSettings(tx, a.ctx.accountId, a.user.id, { ...all, inbox_cleared_at: now.toISOString() });
      await markUpdatesRead(tx, a.ctx.accountId, a.user.id, null, now);
    }
    await announceRead(tx, a.ctx.accountId, a.user.id);
  });
  return { ok: true as const, ...(await inboxUnread(db, a)) };
};
