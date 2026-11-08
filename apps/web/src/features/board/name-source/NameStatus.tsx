// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Item } from '@bines/shared';
import { boardKeys, type BoardDetail } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { Popover } from '../cells/Popover';
import { useOpenItem } from '../open-item';
import { showToast } from '../../../lib/toast';
import {
  boardNameSource,
  computedNameInfo,
  recomputeRunning,
  useNameDuplicates,
  useNameSource,
} from './name-source-api';
import { t } from '@bines/shared';

/** After item changes the duplicates list is fetched again — once things settle (NAME-API §6.6). */
const DUPLICATES_DEBOUNCE_MS = 1200;

/**
 * A big board's background name recompute (NAME-API §6.2): a non-blocking progress bar; done → a toast and the items
 * reload; failed → a toast. Progress comes from the board's live channel (`board.names_recompute_progress`
 * invalidates the board's keys) and, as a fallback, a 2s poll while it runs.
 */
const RecomputeProgress = ({ board }: { board: BoardDetail }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const computed = computedNameInfo(board).computed;
  const q = useNameSource(accountId, board.id, computed);
  const r = q.data?.recompute ?? null;
  const isRunning = recomputeRunning(q.data);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !isRunning && r) {
      if (r.status === 'done') {
        showToast({ message: t('name.source.recomputed', { renamed: r.renamed }) });
        void qc.invalidateQueries({ queryKey: boardKeys.items(accountId, board.id) });
      } else if (r.status === 'failed') showToast({ message: t('name.source.recomputeFailed'), tone: 'error' });
    }
    was.current = isRunning;
  }, [isRunning, r, qc, accountId, board.id]);
  if (!isRunning || !r) return null;
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
  return (
    <span
      className="inline-flex items-center gap-2 text-xs text-muted"
      data-testid="name-recompute"
      data-pct={pct}
      role="status"
    >
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
      {t('name.source.recomputing', { done: r.done, total: r.total })}
    </span>
  );
};

/**
 * Duplicate names (NAME-API §6.6), when the board warns about them: a warning chip with the count; a click lists
 * each shared name, how many items have it, and links to them.
 */
const DuplicatesChip = ({ board, items }: { board: BoardDetail; items?: Item[] }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const warn = !!boardNameSource(board).warn_duplicates;
  const q = useNameDuplicates(accountId, board.id, warn);
  const [open, setOpen] = useState(false);
  const openItem = useOpenItem(board.parent_board_id ?? board.id);
  // Names on screen changed (an edit here or from the live channel): refetch, debounced.
  const signature = items?.map((i) => `${i.id}:${i.name}`).join('|') ?? '';
  const first = useRef(true);
  const refetch = q.refetch;
  useEffect(() => {
    if (!warn) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const id = setTimeout(() => void refetch(), DUPLICATES_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [signature, warn, refetch]);
  const d = q.data;
  if (!warn || !d || !d.count) return null;
  const nameOf = (id: string) => items?.find((i) => i.id === id)?.name;
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid="name-duplicates"
        data-count={d.count}
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-soft px-2.5 text-xs font-semibold text-accent-fg hover:brightness-[0.97]"
      >
        <span aria-hidden>⚠</span>
        {t('name.duplicates.badge', { count: d.count })}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-80 p-2">
        <div className="flex flex-col gap-2" data-testid="name-duplicates-list">
          <p className="px-1 text-sm font-semibold">{t('name.duplicates.title')}</p>
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {d.groups.map((g) => (
              <li key={g.name} className="rounded-[8px] bg-surface-3 p-2" data-testid="name-duplicates-group">
                <p className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate font-semibold">{g.name || '—'}</span>
                  <span className="shrink-0 text-xs text-muted">{t('name.duplicates.items', { count: g.count })}</span>
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {g.item_ids.map((id, i) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        openItem(id);
                      }}
                      className="rounded-full bg-surface px-2 py-0.5 text-xs text-primary hover:underline"
                    >
                      {nameOf(id) ? `${nameOf(id)} #${i + 1}` : `#${i + 1}`}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Popover>
    </span>
  );
};

/** The board's name status line: recompute progress and the duplicates warning (nothing when neither applies). */
export const NameStatus = ({ board, items }: { board: BoardDetail; items?: Item[] }) => (
  <>
    <RecomputeProgress board={board} />
    <DuplicatesChip board={board} items={items} />
  </>
);
