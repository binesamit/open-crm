// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useSyncExternalStore } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { helpRouteOf, type Me, type MyAccount, t, TOUR_ROUTE_PATHS } from '@bines/shared';
import { cn } from '@bines/ui';
import { useReadableBoards } from '../board/board-api';
import { useMyTours } from '../tours/tours-api';
import { useLaunchTour } from '../tours/TourHost';
import { setPendingTour } from '../tours/tour-store';
import { showToast } from '../../lib/toast';
import { useChecklist, useChecklistActions } from './checklist-api';

/**
 * "First steps" (canvas screen 3): a floating checklist — each step ticks itself once the person
 * really did it, each has "show me" (its tour). Opens by itself for people who joined lately; "?" → "First steps"
 * brings it back. It never sits over the page's own actions for long: open in full only the first time it shows (and
 * when the person opens it), then a small pill — remembered for the person. Not for guests, nor inside a support
 * visit (the server says).
 */

// ---- the panel's own state in this tab: opened from the menu; unfolded / folded here (null = as remembered) ----
let forced = false;
let expanded: boolean | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => `${forced}:${expanded}`;
/** "?" → "First steps". */
export const openFirstSteps = () => {
  forced = true;
  expanded = true;
  emit();
};
const setExpanded = (v: boolean) => {
  expanded = v;
  emit();
};
const celebratedKey = (accountId: string, userId: string) => `bos.firststeps.done.${accountId}.${userId}`;

export const FirstStepsPanel = ({ me, account }: { me: Me; account: MyAccount }) => {
  const state = useChecklist(account.id, account.role !== 'guest' && !account.support);
  const actions = useChecklistActions(account.id);
  useSyncExternalStore(subscribe, snapshot);
  const tours = useMyTours(account.id, !!state.data?.available).data;
  const launch = useLaunchTour(account);
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const boards = useReadableBoards(account.id);
  const s = state.data;

  // "Well done" once, when the last step ticks.
  useEffect(() => {
    if (!s?.completed) return;
    const key = celebratedKey(account.id, me.user.id);
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {
      return;
    }
    showToast({ message: t('checklist.completed'), seconds: 8 });
  }, [s?.completed, account.id, me.user.id]);

  // Its first showing in full is remembered at once: from the next page on it is a pill (fix — the panel
  // covered page actions such as "add widget"). Open in this tab, it stays open until folded.
  const firstShow = !!s?.available && !!s.open && !s.collapsed && expanded === null;
  useEffect(() => {
    if (!firstShow) return;
    expanded = true;
    void actions.collapse(true).catch(() => undefined);
  }, [firstShow, actions]);

  if (!s?.available || !s.steps.length) return null;
  const show = forced || s.open;
  if (!show) return null;
  const done = s.steps.filter((x) => x.done).length;
  const total = s.steps.length;

  const showMe = (tourId: string) => {
    const tour = tours?.enabled ? tours.tours.find((x) => x.id === tourId) : undefined;
    if (!tour) return;
    fold();
    // A board tour away from a board: open a board first (the tour waits for it), else say which screen it needs.
    if ((tour.route === 'board' || tour.route === 'item') && helpRouteOf(path) !== tour.route) {
      const first = boards.data?.data[0];
      if (first && TOUR_ROUTE_PATHS[tour.route] === undefined) {
        setPendingTour(tour.id);
        void navigate({ to: '/a/$accountSlug/b/$boardId', params: { accountSlug: account.slug, boardId: first.id } });
        return;
      }
    }
    launch(tour);
  };
  const close = () => {
    forced = false;
    emit();
    void actions.dismiss(true).catch(() => undefined);
  };
  function fold() {
    setExpanded(false);
    if (!s?.collapsed) void actions.collapse(true).catch(() => undefined);
  }

  const folded = expanded === false || (expanded === null && s.collapsed && !firstShow);
  if (folded)
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="fixed start-auto end-5 bottom-5 z-flyout flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3.5 py-2 text-sm text-heading shadow-lg"
        data-testid="first-steps-pill"
      >
        {t('checklist.title')}
        <span className="text-muted">{t('checklist.progress', { done, total })}</span>
      </button>
    );

  return (
    <aside
      aria-label={t('checklist.title')}
      className="fixed end-5 bottom-5 z-flyout flex max-h-[min(560px,80vh)] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col rounded-[14px] border border-line-strong bg-surface shadow-xl"
      data-testid="first-steps"
    >
      <div className="flex flex-col gap-2 border-b border-line-soft px-4 pt-3.5 pb-2.5">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-base text-heading">{t('checklist.title')}</h2>
          <span className="text-[13px] text-muted" data-testid="first-steps-progress">
            {t('checklist.progress', { done, total })}
          </span>
          <button
            type="button"
            onClick={fold}
            aria-label={t('checklist.minimize')}
            className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-2"
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            onClick={close}
            aria-label={t('checklist.close')}
            className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-2"
            data-testid="first-steps-close"
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-line-soft" aria-hidden="true">
          <div className="h-full bg-accent" style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </div>
      </div>
      <ul className="flex flex-col overflow-y-auto px-2 pt-1.5 pb-2.5">
        {s.steps.map((step) => (
          <li
            key={step.id}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            data-testid={`first-step-${step.id}`}
          >
            {step.done ? (
              <svg
                role="img"
                aria-label={t('checklist.done')}
                width="18"
                height="18"
                viewBox="0 0 24 24"
                className="shrink-0"
              >
                <circle cx="12" cy="12" r="10" className="fill-primary" />
                <path
                  d="M7.5 12.5l3 3 6-6.5"
                  fill="none"
                  stroke="var(--on-primary, #fff)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" className="shrink-0 text-muted">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={cn('text-sm', step.done ? 'text-muted line-through' : 'text-fg')}>{step.title}</span>
              {step.description ? <span className="text-xs text-muted">{step.description}</span> : null}
            </div>
            {!step.done && step.tour_id && tours?.tours.some((x) => x.id === step.tour_id) ? (
              <button
                type="button"
                onClick={() => showMe(step.tour_id!)}
                className="shrink-0 rounded-[7px] border border-line-strong bg-surface px-2.5 py-1 text-xs text-heading hover:bg-surface-2"
                data-testid={`first-step-show-${step.id}`}
              >
                {t('checklist.showMe')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
};
