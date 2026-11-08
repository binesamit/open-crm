// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { mergeRows, type Outline, type OutlineRequestInput, WINDOW_PAGE, type WindowedInfo } from '@bines/shared';
import { api } from '../../lib/api';
import type { Item } from './board-api';

/**
 * Windowed boards in the browser (perf review §7.1, shared/api/windowed.ts). A board above the threshold keeps in
 * its items cache only the rows that were on screen; the view's outline (ids per section, counts, summaries)
 * comes from the server and the table shows a placeholder row for every id not loaded yet, loading them in
 * windows as they scroll into view. Everything that already writes the items cache — cell edits, drags, live
 * row refreshes — works unchanged; an outline refresh follows such a change (throttled).
 */

/** The items cache: every row of a normal board, or the loaded rows of a windowed one (`windowed` set). */
export type ItemsData = { data: Item[]; windowed?: WindowedInfo };

const itemsKey = (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'items'] as const;
/** Under the items key: every invalidation of the board's items refreshes its outlines too. */
export const outlineKey = (accountId: string, boardId: string, req: unknown) =>
  [...itemsKey(accountId, boardId), 'outline', req] as const;

/** Rows a windowed board last had on screen — what a refetch of its items cache reloads (the rest are dropped). */
const onScreen = new Map<string, string[]>();
const SCREEN_MAX = 600;

const fetchRows = async (accountId: string, boardId: string, ids: string[]): Promise<Item[]> => {
  const out: Item[] = [];
  for (let i = 0; i < ids.length; i += WINDOW_PAGE) {
    const chunk = ids.slice(i, i + WINDOW_PAGE);
    out.push(...(await api(accountId).get<{ data: Item[] }>(`/boards/${boardId}/items?ids=${chunk.join(',')}`)).data);
  }
  return out;
};

/**
 * The items query's fetch (`useItems`): asks for the whole board with `window=1`; a windowed answer comes back
 * without rows, so a refetch reloads only the rows that were on screen.
 */
export const fetchBoardItems = async (accountId: string, boardId: string): Promise<ItemsData> => {
  const res = await api(accountId).get<ItemsData>(`/boards/${boardId}/items?window=1`);
  if (!res.windowed) return res;
  return { data: await fetchRows(accountId, boardId, onScreen.get(boardId) ?? []), windowed: res.windowed };
};

/** Placeholder rows: one object per id (stable, so rows don't re-render), recognised by `isStub`. */
const stubs = new WeakSet<Item>();
const stubCache = new Map<string, Item>();
export const isStub = (item: Item) => stubs.has(item);
export const stubItem = (id: string, boardId: string, groupId: string | null): Item => {
  const hit = stubCache.get(id);
  if (hit && hit.group_id === groupId && hit.board_id === boardId) return hit;
  const stub: Item = {
    id,
    board_id: boardId,
    group_id: groupId,
    parent_item_id: null,
    depth: 0,
    name: '',
    position: '',
    key: null,
    cells: {},
    created_at: '',
    created_by: null,
    updated_at: '',
  };
  stubs.add(stub);
  if (stubCache.size > 200_000) stubCache.clear();
  stubCache.set(id, stub);
  return stub;
};

/** The view's outline (ids per section + summaries) — the previous one stays on screen while a new one loads. */
export const useOutline = (accountId: string, boardId: string, req: OutlineRequestInput | null) =>
  useQuery({
    queryKey: outlineKey(accountId, boardId, req),
    queryFn: () => api(accountId).post<Outline>(`/boards/${boardId}/items/outline`, req ?? {}),
    enabled: !!req,
    placeholderData: keepPreviousData,
  });

/** After a change to the loaded rows (an edit, a drag, a live refresh), the outline refreshes at most this often. */
const OUTLINE_REFRESH_MS = 800;
/** Rows in view are loaded at most this often while the view moves (one request per window, not per row). */
const LOAD_DELAY_MS = 120;

/**
 * Loads rows of a windowed board as they come into view (`need`), and refreshes its outlines when the loaded
 * rows change for another reason. Ids asked for that do not come back (deleted, hidden) are not asked again until
 * the outline changes.
 */
export const useWindowRows = (accountId: string, boardId: string, enabled: boolean) => {
  const qc = useQueryClient();
  const inflight = useRef(new Set<string>());
  const gone = useRef(new Set<string>());
  const own = useRef(0);
  const key = itemsKey(accountId, boardId);

  const load = useCallback(
    (ids: string[]) => {
      if (!enabled || !ids.length) return;
      onScreen.set(boardId, ids.slice(0, SCREEN_MAX));
      const cached = qc.getQueryData<ItemsData>(key);
      const have = new Set(cached?.data.map((i) => i.id));
      const missing = ids.filter((id) => !have.has(id) && !inflight.current.has(id) && !gone.current.has(id));
      for (let i = 0; i < missing.length; i += WINDOW_PAGE) {
        const chunk = missing.slice(i, i + WINDOW_PAGE);
        for (const id of chunk) inflight.current.add(id);
        void fetchRows(accountId, boardId, chunk)
          .then((fresh) => {
            const back = new Set(fresh.map((r) => r.id));
            for (const id of chunk) if (!back.has(id)) gone.current.add(id);
            own.current++;
            try {
              qc.setQueryData<ItemsData>(key, (old) =>
                old ? { ...old, data: mergeRows(old.data, chunk, fresh) } : old,
              );
            } finally {
              own.current--;
            }
          })
          .catch(() => undefined)
          .finally(() => {
            for (const id of chunk) inflight.current.delete(id);
          });
      }
    },
    // `key` is rebuilt every render from these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, accountId, boardId, qc],
  );
  // While scrolling, the range changes on every row: load what the view shows once it settles a moment.
  // `source`: who is asking (the table, one phone section…) — each one's latest range counts.
  const latest = useRef(new Map<string, string[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const need = useCallback(
    (ids: string[], source = '') => {
      latest.current.set(source, ids);
      timer.current ??= setTimeout(() => {
        timer.current = null;
        load([...new Set([...latest.current.values()].flat())]);
      }, LOAD_DELAY_MS);
    },
    [load],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Edits, drags and live refreshes write the items cache by hand: the outline (order, counts, summaries) may
  // have changed with them.
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const refresh = () => {
      timer = null;
      last = Date.now();
      gone.current.clear();
      void qc.invalidateQueries({ queryKey: [...itemsKey(accountId, boardId), 'outline'] });
    };
    const hash = JSON.stringify(itemsKey(accountId, boardId));
    return qc.getQueryCache().subscribe((e) => {
      if (e.type !== 'updated' || e.query.queryHash !== hash || own.current) return;
      if (e.action.type !== 'success' || !e.action.manual) return;
      timer ??= setTimeout(refresh, Math.max(0, OUTLINE_REFRESH_MS - (Date.now() - last)));
    });
  }, [enabled, qc, accountId, boardId]);

  return need;
};
