// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { type MyTour, t, tourSeconds } from '@bines/shared';
import { Button } from '@bines/ui';
import { Icon } from '../../lib/icons';

/** A tour's length for people: "40 seconds", "a minute", "2 minutes" (~10 seconds a step). */
export const tourTime = (steps: number) => {
  const s = tourSeconds(steps);
  if (s < 60) return t('tour.seconds', { n: s });
  const m = Math.round(s / 60);
  return m === 1 ? t('tour.minute') : t('tour.minutes', { n: m });
};

/**
 * The offer on a first visit to a screen (canvas א1): a small card in the bottom corner — never over
 * the work — "first time in <screen>? a tour of N steps, about X seconds", start / not now, and "don't offer me
 * tours" (the person's own switch; their profile turns it back on). "Not now" and ✕ mark the tour as seen: it is not
 * offered again, and the "?" menu runs it any time.
 */
export const TourOffer = ({
  tour,
  onStart,
  onLater,
  onNoMore,
}: {
  tour: MyTour;
  onStart: () => void;
  onLater: () => void;
  onNoMore: () => void;
}) => {
  const [noMore, setNoMore] = useState(false);
  const later = () => (noMore ? onNoMore() : onLater());
  // Its own layer at the end of the page, over an open item card or dialog (it never blocks them: a small card).
  return createPortal(
    <aside
      aria-label={t('tour.offer.label')}
      data-testid="tour-offer"
      data-tour-id={tour.id}
      className="anim-pop fixed end-4 bottom-4 z-tour flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-[16px] border border-line bg-surface px-5 py-[18px] shadow-[0_12px_32px_rgba(13,59,53,0.18)] sm:end-6 sm:bottom-6"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-[var(--accent-soft)] text-[var(--accent-fg)]"
        >
          <Icon name="place" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg leading-snug font-extrabold text-heading" dir="auto">
            {t('tour.offer.title', { title: tour.title })}
          </h2>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">
            {t('tour.offer.text', { steps: tour.steps.length, time: tourTime(tour.steps.length) })}
          </p>
        </div>
        <button
          type="button"
          aria-label={t('tour.close')}
          onClick={later}
          data-testid="tour-offer-close"
          className="grid size-[30px] shrink-0 place-items-center rounded-[9px] text-muted hover:bg-surface-2 hover:text-fg"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="accent" className="font-normal" onClick={onStart} data-testid="tour-offer-start">
          {t('tour.offer.start')}
        </Button>
        <Button variant="secondary" className="font-normal" onClick={later} data-testid="tour-offer-later">
          {t('tour.offer.later')}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={noMore}
          onChange={(e) => setNoMore(e.target.checked)}
          className="size-4 accent-[var(--primary)]"
          data-testid="tour-offer-nomore"
        />
        {t('tour.offer.noMore')}
      </label>
    </aside>,
    document.body,
  );
};
