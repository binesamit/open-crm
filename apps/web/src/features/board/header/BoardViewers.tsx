// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  BOARD_VIEW_THROTTLE_MS,
  BOARD_VIEWERS_FACES,
  exactTime,
  type BoardViewer,
  type BoardViewers,
  relativeTime,
  t,
} from '@bines/shared';
import { Avatar, Button, cn, Dialog } from '@bines/ui';
import { api } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { Popover } from '../cells/Popover';

const viewersKey = (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'viewers'];

/**
 * r18boardviews: tells the server this person opened the board — on open, and again when the tab comes
 * back after a while. The server writes at most once per BOARD_VIEW_THROTTLE_MS; a failed report is dropped.
 */
export const useReportBoardOpen = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  useEffect(() => {
    let last = 0;
    const report = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < BOARD_VIEW_THROTTLE_MS) return;
      last = Date.now();
      api(accountId)
        .post<{ ok: true; recorded: boolean }>(`/boards/${boardId}/viewers`)
        .then((r) => {
          if (r.recorded) void qc.invalidateQueries({ queryKey: viewersKey(accountId, boardId) });
        })
        .catch(() => undefined);
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [accountId, boardId, qc]);
};

export const useBoardViewers = (accountId: string, boardId: string) =>
  useInfiniteQuery({
    queryKey: viewersKey(accountId, boardId),
    queryFn: ({ pageParam }) =>
      api(accountId).get<BoardViewers>(
        `/boards/${boardId}/viewers${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 60_000,
  });

/** opened within the account's "recent" window (24 h by default)? */
const isRecent = (v: BoardViewer, hours: number, now: number) => now - Date.parse(v.last_viewed_at) < hours * 3_600_000;

const ViewerRow = ({ v, now, me, earlier }: { v: BoardViewer; now: number; me: boolean; earlier?: boolean }) => (
  <li className="flex items-center gap-2.5 py-1.5" data-testid="board-viewer" data-user-id={v.id}>
    <Avatar name={v.name} url={v.avatar_url} size={28} />
    <div className="min-w-0 flex-1">
      <div className="truncate text-[0.8125rem] font-semibold text-fg">
        {v.name}
        {me ? <span className="ms-1 font-normal text-muted">{t('boardviewers.you')}</span> : null}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <span className="inline-flex" title={v.user_agent || t(`seen.device.${v.device}`)}>
          <Icon name={v.device} size={13} />
        </span>
        <time dateTime={v.last_viewed_at} title={exactTime(v.last_viewed_at)} data-testid="board-viewer-ago">
          {/* An earlier open says when exactly (date and time); a recent one how long ago. */}
          {earlier ? exactTime(v.last_viewed_at) : relativeTime(v.last_viewed_at, now)}
        </time>
        {v.view_count > 1 ? (
          <>
            <span aria-hidden>·</span>
            <span>{t('boardviewers.views', { n: v.view_count })}</span>
          </>
        ) : null}
      </div>
    </div>
  </li>
);

/** The list itself (popover on desktop, dialog on phones): newest first, "show more" pages through the rest. */
const ViewersList = ({ accountId, boardId, meId }: { accountId: string; boardId: string; meId: string }) => {
  const q = useBoardViewers(accountId, boardId);
  // "לפני X" as of when the list opened (it reopens fresh).
  const [now] = useState(() => Date.now());
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  // who opened it within the window first, then "earlier" with the date and time of their last open.
  const hours = q.data?.pages[0]?.recent_hours ?? 24;
  const recent = rows.filter((v) => isRecent(v, hours, now));
  const earlier = rows.filter((v) => !isRecent(v, hours, now));
  const heading = (text: string, testId: string) => (
    <li className="pt-2 pb-0.5 text-[0.6875rem] font-semibold text-muted" data-testid={testId}>
      {text}
    </li>
  );
  return (
    <div data-testid="board-viewers-list" className="flex max-h-96 flex-col">
      {rows.length ? (
        <ul className={cn('overflow-y-auto px-3 py-1', q.isFetching && 'opacity-70')}>
          {heading(t('boardviewers.recent', { n: hours }), 'board-viewers-recent')}
          {recent.length ? (
            recent.map((v) => <ViewerRow key={v.id} v={v} now={now} me={v.id === meId} />)
          ) : (
            <li className="py-1.5 text-xs text-muted">{t('boardviewers.noneRecent')}</li>
          )}
          {earlier.length ? heading(t('boardviewers.earlier'), 'board-viewers-earlier') : null}
          {earlier.map((v) => (
            <ViewerRow key={v.id} v={v} now={now} me={v.id === meId} earlier />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-4 text-sm text-muted" data-testid="board-viewers-empty">
          {q.isPending ? t('app.loading') : t('boardviewers.empty')}
        </p>
      )}
      {q.hasNextPage ? (
        <div className="border-t border-line-soft px-3 py-2">
          <Button
            variant="secondary"
            size="sm"
            busy={q.isFetchingNextPage}
            data-testid="board-viewers-more"
            onClick={() => void q.fetchNextPage()}
          >
            {t('boardviewers.more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

/**
 * Desktop header: "צפו בבורד" — the last few viewers' faces stacked, "+N"; a click opens the list (photo, name,
 * "לפני X"). Hidden when the account turned it off or nobody opened the board yet.
 */
export const BoardViewersButton = ({
  accountId,
  boardId,
  meId,
}: {
  accountId: string;
  boardId: string;
  meId: string;
}) => {
  const [open, setOpen] = useState(false);
  const q = useBoardViewers(accountId, boardId);
  const first = q.data?.pages[0];
  if (!first?.enabled || !first.total) return null;
  // the faces and the count are who opened it in the last `recent_hours`; the rest are in the list.
  // "Recent" as of when the list came from the server — the moment `recent_total` was counted.
  const now = q.dataUpdatedAt;
  const faces = first.data.filter((v) => isRecent(v, first.recent_hours, now)).slice(0, BOARD_VIEWERS_FACES);
  const extra = first.recent_total - faces.length;
  const label = t('boardviewers.labelRecent', { n: first.recent_total, hours: first.recent_hours });
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid="board-viewers"
        data-count={first.recent_total}
        data-total={first.total}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-xs text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Icon name="eye" size={15} />
        <span className="flex items-center ps-1.5" aria-hidden>
          {faces.map((v) => (
            <span key={v.id} className="-ms-1.5 rounded-full ring-2 ring-surface">
              <Avatar name={v.name} url={v.avatar_url} size={20} />
            </span>
          ))}
        </span>
        {extra > 0 ? <span className="font-semibold">+{extra}</span> : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="end" className="w-72 p-0">
        <div role="dialog" aria-label={label}>
          <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-2 text-xs font-semibold text-fg-2">
            <Icon name="eye" size={14} />
            {t('boardviewers.title')}
          </div>
          {open ? <ViewersList accountId={accountId} boardId={boardId} meId={meId} /> : null}
        </div>
      </Popover>
    </span>
  );
};

/** Phones: the same list from the ⋯ menu, in a dialog. */
export const BoardViewersDialog = ({
  accountId,
  boardId,
  boardName,
  meId,
  onClose,
}: {
  accountId: string;
  boardId: string;
  boardName: string;
  meId: string;
  onClose: () => void;
}) => (
  <Dialog
    open
    title={t('boardviewers.title')}
    subtitle={boardName}
    onClose={onClose}
    footer={
      <Button variant="secondary" onClick={onClose}>
        {t('common.close')}
      </Button>
    }
  >
    <div data-testid="board-viewers-dialog" className="-mx-3">
      <ViewersList accountId={accountId} boardId={boardId} meId={meId} />
    </div>
  </Dialog>
);
