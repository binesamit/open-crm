// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { type MyAccount, t } from '@bines/shared';
import { Button, cn, EmptyState, Notice, SkeletonRows } from '@bines/ui';
import { confirmDialog } from '../../lib/dialogs';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { useLaunchTour } from './TourHost';
import { tourTime } from './TourOffer';
import { useMyTours, useTourActions } from './tours-api';

const lengthLabel = (steps: number) => t('tour.list.meta', { steps, time: tourTime(steps) });

/**
 * Every guided tour (canvas א3 — `/a/<slug>/tours`, from the "?" menu): what this person finished, and
 * a button to run each again, as many times as they like. "Reset all" offers every tour again on its screen.
 */
export const ToursPage = ({ account }: { account: MyAccount }) => {
  const tours = useMyTours(account.id);
  const actions = useTourActions(account.id);
  const launch = useLaunchTour(account);
  const [resetting, setResetting] = useState(false);
  const list = [...(tours.data?.tours ?? [])].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const done = list.filter((x) => x.state === 'done').length;
  const reset = async () => {
    if (
      !(await confirmDialog({
        title: t('tour.list.reset'),
        message: t('tour.list.resetConfirm'),
        confirmLabel: t('tour.list.reset'),
      }))
    )
      return;
    setResetting(true);
    try {
      await actions.resetAll();
      showToast({ message: t('tour.list.resetDone') });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setResetting(false);
    }
  };
  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="tours-page">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="font-display text-[1.625rem] leading-tight font-extrabold text-heading">
              {t('tour.list.title')}
            </h1>
            <p className="text-sm text-muted" data-testid="tours-summary">
              {t('tour.list.subtitle', { done, total: list.length })}
            </p>
          </div>
          {list.length ? (
            <Button variant="secondary" busy={resetting} onClick={() => void reset()} data-testid="tours-reset">
              {t('tour.list.reset')}
            </Button>
          ) : null}
        </header>
        {list.length ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={list.length}
            aria-valuenow={done}
            aria-label={t('tour.list.title')}
            className="h-1.5 overflow-hidden rounded-full bg-line"
          >
            <div className="h-full bg-ok transition-[width]" style={{ width: `${(done / list.length) * 100}%` }} />
          </div>
        ) : null}
        {tours.isPending ? (
          <SkeletonRows rows={5} label={t('app.loading')} />
        ) : tours.isError ? (
          <Notice tone="error">{errorMessage(tours.error)}</Notice>
        ) : !tours.data.enabled ? (
          <EmptyState icon={<Icon name="place" size={28} />} title={t('tour.list.off')} testId="tours-off" />
        ) : list.length ? (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="tours-list">
            {list.map((tour) => {
              const isDone = tour.state === 'done';
              return (
                <li
                  key={tour.id}
                  data-testid="tours-row"
                  data-id={tour.id}
                  data-state={tour.state ?? 'new'}
                  className="flex items-center gap-3 rounded-[12px] border border-line bg-surface px-4 py-3.5"
                >
                  <span
                    aria-label={isDone ? t('tour.list.done') : undefined}
                    aria-hidden={isDone ? undefined : true}
                    className={cn(
                      'grid size-[26px] shrink-0 place-items-center rounded-full',
                      isDone ? 'bg-ok text-white' : 'border-[1.5px] border-line-strong',
                    )}
                  >
                    {isDone ? <Icon name="check" size={12} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-fg" dir="auto">
                      {tour.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{lengthLabel(tour.steps.length)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="font-normal"
                    onClick={() => launch(tour)}
                    data-testid="tours-run"
                  >
                    {isDone ? t('tour.list.again') : t('tour.list.start')}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={<Icon name="place" size={28} />} title={t('tour.list.empty')} testId="tours-empty" />
        )}
      </div>
    </main>
  );
};
