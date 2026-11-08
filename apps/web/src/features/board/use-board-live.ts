// SPDX-License-Identifier: AGPL-3.0-only
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isRowEvent,
  LIVE_ROWS_MAX,
  mergeRows,
  STREAM_READY,
  STREAM_RESYNC,
  STREAM_REVOKED,
  type StreamEvent,
  UPDATE_SEEN,
} from '@bines/shared';
import { api } from '../../lib/api';
import { fromThisTab, useEventStream } from '../../lib/realtime';
import type { Item } from './board-api';

/** What to refetch for one event (01 §4: targeted invalidation, never the whole cache). */
const keysFor = (accountId: string, boardId: string, e: StreamEvent): QueryKey[] => {
  // A team changed (members, deletion): visibility and rights here may have — this board's items and details.
  if (e.type.startsWith('team.')) return [['account', accountId, 'board', boardId]];
  if (!e.board_id) return [];
  const board = ['account', accountId, 'board', e.board_id];
  const item = e.item_id ? [['account', accountId, 'item', e.item_id]] : [];
  // Item-scoped events refresh their row (`rowRefresh` below); here only what else they touch.
  const rows = isRowEvent(e);
  // D28: a background column conversion moved on — its progress (the header badge, the dialog), not the items.
  if (e.type === 'column.conversion_progress') return [[...board, 'conversions']];
  switch (e.type.split('.')[0]) {
    case 'board':
      return [board, ['account', accountId, 'tree']];
    case 'column':
    case 'group':
      return [board];
    case 'view':
      return [[...board, 'views']];
    case 'update':
      return [...(rows ? [] : [[...board, 'items']]), [...board, 'update-counts'], ...item];
    case 'time':
      return [...(rows ? [] : [[...board, 'items']]), [...board, 'time-report'], ...item];
    default: // item.*, cell.*, update.*, file.*, batch.*, restores
      return [...(rows ? [] : [[...board, 'items']]), ...item];
  }
};

/** A burst (a bulk action is one event per item) becomes one refetch per key. */
const FLUSH_MS = 150;

/**
 * Live board (M4): listens on the board channel (sub-board included) and refetches what other people and
 * automations changed. Returns whether the channel is open (`data-live` on the page, for E2E).
 */
export const useBoardLive = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const pending = useRef(new Map<string, QueryKey>());
  const pendingRows = useRef(new Map<string, Set<string>>()); // board id → item ids
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Refetches these rows of a board's cached items and merges them in (perf review: never the whole board for
   * one edit). Too many rows, or a failed request → the board's items are refetched. Returns the rows before and
   * after (null when nothing was patched).
   */
  const patchRows = useCallback(
    async (rowsBoardId: string, ids: string[]): Promise<Item[] | null> => {
      const itemsKey = ['account', accountId, 'board', rowsBoardId, 'items'];
      const cached = qc.getQueryData<{ data: Item[] }>(itemsKey);
      if (!cached) return null; // not on screen: it loads fresh when it is
      if (ids.length > LIVE_ROWS_MAX) {
        void qc.invalidateQueries({ queryKey: itemsKey });
        return null;
      }
      try {
        const fresh = (await api(accountId).get<{ data: Item[] }>(`/boards/${rowsBoardId}/items?ids=${ids.join(',')}`))
          .data;
        qc.setQueryData<{ data: Item[] }>(itemsKey, (old) =>
          // `...old`: a windowed board's cache keeps its `windowed` marker (windowed.ts).
          old ? { ...old, data: mergeRows(old.data, ids, fresh) } : old,
        );
        const asked = new Set(ids);
        return [...fresh, ...cached.data.filter((i) => asked.has(i.id))];
      } catch {
        void qc.invalidateQueries({ queryKey: itemsKey });
        return null;
      }
    },
    [qc, accountId],
  );

  /** A sub-board row also refreshes its parents here: their mirrors over subitems may have changed. */
  const refreshRows = useCallback(
    async (rowsBoardId: string, ids: string[]) => {
      const touched = await patchRows(rowsBoardId, ids);
      if (!touched || rowsBoardId === boardId) return;
      const main = qc.getQueryData<{ data: Item[] }>(['account', accountId, 'board', boardId, 'items']);
      const shown = new Set(main?.data.map((i) => i.id));
      const parents = [...new Set(touched.flatMap((i) => (i.parent_item_id ? [i.parent_item_id] : [])))];
      const visible = parents.filter((id) => shown.has(id));
      if (visible.length) await patchRows(boardId, visible);
    },
    [patchRows, qc, accountId, boardId],
  );

  const flush = useCallback(() => {
    timer.current = null;
    const keys = [...pending.current.values()];
    pending.current.clear();
    const rows = [...pendingRows.current];
    pendingRows.current.clear();
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    for (const [rowsBoardId, ids] of rows) void refreshRows(rowsBoardId, [...ids]);
  }, [qc, refreshRows]);

  // Leaving the board inside the flush window: the pending refetch is for the board just left (web #8).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const queue = useCallback(
    (key: QueryKey) => {
      pending.current.set(JSON.stringify(key), key);
      timer.current ??= setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  const queueRow = useCallback(
    (rowsBoardId: string, itemId: string) => {
      const set = pendingRows.current.get(rowsBoardId) ?? new Set<string>();
      set.add(itemId);
      pendingRows.current.set(rowsBoardId, set);
      timer.current ??= setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  /** The parents of a sub-board row, up to the top-level item, from what is cached (nothing cached → nothing). */
  const queueAncestors = useCallback(
    (subBoardId: string, itemId: string) => {
      const sub = qc.getQueryData<{ data: Item[] }>(['account', accountId, 'board', subBoardId, 'items'])?.data ?? [];
      const byId = new Map(sub.map((i) => [i.id, i]));
      let parent = byId.get(itemId)?.parent_item_id ?? null;
      for (let depth = 0; parent && depth < 6; depth++) {
        const up = byId.get(parent);
        if (!up) {
          queueRow(boardId, parent); // a top-level item of this board
          return;
        }
        queueRow(subBoardId, parent);
        parent = up.parent_item_id ?? null;
      }
    },
    [qc, accountId, boardId, queueRow],
  );

  useEventStream(`/boards/${boardId}/events`, accountId, (e) => {
    if (e.type === STREAM_READY) {
      setLive(true);
      // Every (re)connection refetches the board (audit 2026-10-10, realtime #7): the items loaded before the
      // server subscribed this stream, and a write in between was never heard; after a reconnect the replay
      // may have missed a long transaction (#6). A late joiner of an open channel missed nothing.
      if (!e.late) queue(['account', accountId, 'board', boardId]);
      return;
    }
    // r16seen: who saw an update changes nothing on the board — the item card patches its thread (seen-live.ts).
    if (e.type === UPDATE_SEEN) return;
    if (e.type === STREAM_REVOKED) {
      setLive(false);
      return queue(['account', accountId, 'board', boardId]);
    }
    if (e.type === STREAM_RESYNC) {
      queue(['account', accountId, 'board']);
      return queue(['account', accountId, 'item']);
    }
    if (fromThisTab(e)) {
      // Fix: my own edit of a subitem — its row is already up to date here, but the rows above it show
      // mirrors / progress / formulas over their subitems: refresh those ancestors.
      if (isRowEvent(e) && e.board_id !== boardId) queueAncestors(e.board_id!, e.item_id!);
      return;
    }
    if (isRowEvent(e)) queueRow(e.board_id!, e.item_id!);
    for (const key of keysFor(accountId, boardId, e)) queue(key);
  });

  return live;
};
