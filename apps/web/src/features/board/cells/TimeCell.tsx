// SPDX-License-Identifier: AGPL-3.0-only
import { useContext } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { formatDuration, formatTime, t, type TimeSettings, type TimeValue } from '@bines/shared';
import { cn } from '@bines/ui';
import { since, useNow, useTimeMutations } from '../../time/time-api';
import { BoardAccountContext } from '../board-context';
import type { CellProps } from './index';

/**
 * time_tracking cell (03 §3.3, M1.1 #11): the total (+ every running timer, live), ▶ / ⏸ for my own timer, and
 * the value opens the item's time log. Timers on other items keep running — several may run at once.
 */
export const TimeCell = ({ column, value, editable, members, accountId, itemId }: CellProps) => {
  const { slug, meId } = useContext(BoardAccountContext);
  const params = useParams({ strict: false }) as { boardId?: string };
  const navigate = useNavigate();
  const m = useTimeMutations(accountId);
  const v = value as TimeValue | null;
  const settings = column.settings as TimeSettings;
  const runners = v?.runners ?? [];
  const now = useNow(runners.length > 0);
  const total = (v?.duration ?? 0) + runners.reduce((s, r) => s + since(r.since, now), 0);
  const mineRunning = runners.some((r) => r.user_id === meId);
  const names = runners
    .map((r) => {
      const who = members.find((x) => x.user_id === r.user_id);
      const time = formatTime(r.since);
      return t('time.runningBy', { name: who?.name || who?.email || '?', time });
    })
    .join('\n');
  const busy = m.start.isPending || m.stop.isPending;

  const openLog = () =>
    void navigate({
      to: '/a/$accountSlug/b/$boardId/i/$itemId',
      params: { accountSlug: slug, boardId: params.boardId!, itemId },
      search: { tab: 'time' },
    });

  return (
    <div className="group relative flex h-full w-full items-center justify-center gap-1.5 px-2 text-sm">
      {editable ? (
        <button
          type="button"
          disabled={busy}
          aria-label={mineRunning ? t('time.stop') : t('time.start')}
          title={mineRunning ? t('time.stop') : t('time.start')}
          onClick={() => (mineRunning ? m.stop : m.start).mutate({ itemId, columnId: column.id })}
          data-tour="board.timer"
          className={cn(
            'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-[0.6875rem] text-[var(--on-bar)] transition-opacity',
            mineRunning ? 'bg-[var(--danger)]' : 'bg-[var(--bar)] opacity-0 focus:opacity-100 group-hover:opacity-100',
          )}
        >
          {mineRunning ? '⏸' : '▶'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={openLog}
        title={names || t('time.openLog')}
        dir="ltr"
        data-testid="cell-value"
        className={cn(
          'cursor-pointer font-mono hover:underline',
          v?.running && 'animate-pulse text-danger-fg',
          !total && !v?.running && 'text-muted',
        )}
      >
        {total || v?.running ? formatDuration(total, settings) : '—'}
      </button>
    </div>
  );
};
