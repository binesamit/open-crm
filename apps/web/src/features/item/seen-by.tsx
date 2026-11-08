// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { exactTime, relativeTime, t, type UpdateSeen, type UpdateViewDevice, type UpdateViewer } from '@bines/shared';
import { Avatar, cn } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api } from '../../lib/api';
import { Popover } from '../board/cells/Popover';

/** How long an update must stay ≥50% on screen (with the tab visible) to count as seen. */
const DWELL_MS = 1000;
/** Reports go out in one batch at most this often (r16seen: short, so a viewer sees themselves appear soon). */
const FLUSH_MS = 1500;
/** The same update is reported again (to move "last seen") at most this often per page session. */
const REPORT_AGAIN_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Reporting: what became visible goes to POST /updates/views in batches
// ---------------------------------------------------------------------------
const pending = new Map<string, Set<string>>();
const reportedAt = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

const flush = () => {
  timer = null;
  for (const [accountId, ids] of pending) {
    pending.delete(accountId);
    // 100 per request (the API's cap); a failed report is dropped — the next sighting reports it again.
    const all = [...ids];
    for (let i = 0; i < all.length; i += 100) {
      api(accountId)
        .post('/updates/views', { update_ids: all.slice(i, i + 100) })
        .catch(() => all.slice(i, i + 100).forEach((id) => reportedAt.delete(`${accountId}:${id}`)));
    }
  }
};

const queueSeen = (accountId: string, updateId: string) => {
  const key = `${accountId}:${updateId}`;
  const last = reportedAt.get(key);
  if (last && Date.now() - last < REPORT_AGAIN_MS) return;
  reportedAt.set(key, Date.now());
  const ids = pending.get(accountId) ?? new Set<string>();
  ids.add(updateId);
  pending.set(accountId, ids);
  timer ??= setTimeout(flush, FLUSH_MS);
};

/**
 * Marks an update or reply seen once its element was at least half on screen for a second while the tab was
 * visible ("seen by"). `skip`: my own update, or nothing to report.
 */
export const useMarkSeen = (ref: RefObject<HTMLElement | null>, accountId: string, updateId: string, skip = false) => {
  useEffect(() => {
    const el = ref.current;
    if (skip || !el || typeof IntersectionObserver === 'undefined') return;
    let visible = false;
    let dwell: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (dwell) clearTimeout(dwell);
      dwell = null;
    };
    const arm = () => {
      stop();
      if (!visible || document.visibilityState !== 'visible') return;
      dwell = setTimeout(() => queueSeen(accountId, updateId), DWELL_MS);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        // Half of it on screen — or, for one taller than the screen, half the screen filled by it.
        const screen = entry?.rootBounds?.height ?? window.innerHeight;
        visible =
          !!entry &&
          entry.isIntersecting &&
          (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= screen * 0.5);
        arm();
      },
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(el);
    document.addEventListener('visibilitychange', arm);
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', arm);
    };
  }, [ref, accountId, updateId, skip]);
};

// ---------------------------------------------------------------------------
// Display: eye + stacked avatars in the footer, the list on hover / tap
// ---------------------------------------------------------------------------
const DEVICE_ICON: Record<UpdateViewDevice, 'desktop' | 'mobile' | 'tablet'> = {
  desktop: 'desktop',
  mobile: 'mobile',
  tablet: 'tablet',
};

const ViewerRow = ({ v, now, photo }: { v: UpdateViewer; now: number; photo: string | null }) => (
  <li className="flex items-start gap-2.5 py-1.5" data-testid="seen-by-viewer" data-user-id={v.id}>
    <Avatar name={v.name} url={photo} size={28} />
    <div className="min-w-0 flex-1">
      <div className="truncate text-[0.8125rem] font-semibold text-fg">{v.name}</div>
      <ul className="flex flex-col gap-0.5">
        {v.devices.map((d) => (
          <li
            key={d.device}
            className="flex items-center gap-1.5 text-xs text-muted"
            data-testid="seen-by-device"
            data-device={d.device}
          >
            <span className="inline-flex" title={t(`seen.device.${d.device}`)}>
              <Icon name={DEVICE_ICON[d.device]} size={13} />
            </span>
            <span className="truncate" dir="ltr">
              {d.user_agent || t(`seen.device.${d.device}`)}
            </span>
            <span aria-hidden>·</span>
            <time dateTime={d.last_seen_at} title={exactTime(d.last_seen_at)} className="shrink-0">
              {relativeTime(d.last_seen_at, now)}
            </time>
          </li>
        ))}
      </ul>
    </div>
  </li>
);

/**
 * "Seen by" in an update's / reply's footer: an eye with up to 3 stacked avatars and "+N"; hovering (or tapping)
 * opens the list — photo, name, each device with its browser/OS and when. When more people saw it than the
 * update carries, the list loads them all (GET /updates/{id}/views).
 */
export const SeenBy = ({
  accountId,
  updateId,
  seen,
  now,
  photoOf,
}: {
  accountId: string;
  updateId: string;
  seen: UpdateSeen | null | undefined;
  now: number;
  /** A member's photo when the viewer row has none (the people list already holds signed links). */
  photoOf: (userId: string) => string | null | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = openTimer.current = null;
  };
  useEffect(() => clearTimers, []);
  const more = !!seen && seen.count > seen.users.length;
  const full = useQuery({
    queryKey: ['account', accountId, 'update-views', updateId],
    queryFn: () => api(accountId).get<{ data: UpdateViewer[] }>(`/updates/${updateId}/views`),
    enabled: open && more,
    staleTime: 30_000,
  });
  if (!seen || seen.count === 0) return null;
  const viewers = more && full.data ? full.data.data : seen.users;
  const photo = (v: UpdateViewer) => v.avatar_url ?? photoOf(v.id) ?? null;
  const extra = seen.count - Math.min(3, seen.users.length);
  const label = t('seen.label', { n: seen.count });
  const hoverOpen = () => {
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), 250);
  };
  const hoverClose = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  };

  return (
    <span className="relative inline-flex" onMouseEnter={hoverOpen} onMouseLeave={hoverClose}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="seen-by"
        data-count={seen.count}
        onClick={() => {
          clearTimers();
          setOpen((v) => !v);
        }}
        className="inline-flex h-[1.625rem] items-center gap-1.5 rounded-full px-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
      >
        <Icon name="eye" size={14} />
        <span className="flex items-center ps-1.5" aria-hidden>
          {seen.users.slice(0, 3).map((v) => (
            <span key={v.id} className="-ms-1.5 rounded-full ring-2 ring-surface">
              <Avatar name={v.name} url={photo(v)} size={18} />
            </span>
          ))}
        </span>
        {extra > 0 ? <span className="font-semibold">+{extra}</span> : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="end" className="w-72 p-0">
        <div
          role="dialog"
          aria-label={label}
          data-testid="seen-by-list"
          onMouseEnter={clearTimers}
          onMouseLeave={hoverClose}
          className="flex max-h-80 flex-col"
        >
          <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-2 text-xs font-semibold text-fg-2">
            <Icon name="eye" size={14} />
            {label}
          </div>
          <ul className={cn('overflow-y-auto px-3 py-1', full.isFetching && 'opacity-70')}>
            {viewers.map((v) => (
              <ViewerRow key={v.id} v={v} now={now} photo={photo(v)} />
            ))}
          </ul>
        </div>
      </Popover>
    </span>
  );
};
