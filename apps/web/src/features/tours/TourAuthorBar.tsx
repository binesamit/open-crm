// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { hasMessage, helpAssetPath, t, tDynamic } from '@bines/shared';
import { Button } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { fetchConsoleTour } from './tours-api';
import { type AuthorMode, clearAuthorMode, PICKED_KEY, startTour } from './tour-store';

/** A mark's name for people: the app's own label for it, else the mark itself. */
export const anchorLabel = (anchor: string) =>
  hasMessage(`tour.anchor.${anchor}`) ? tDynamic(`tour.anchor.${anchor}`) : anchor;

/** The marked element under a point (never the bar itself). */
const markedAt = (target: EventTarget | null) => {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-tour]') : null;
  return el && !el.closest('[data-tour-author]') ? el : null;
};

/**
 * The owner console's tools on the app's own screen (canvas א4 "pick on the screen" / "preview"), in
 * a tab the console opened: a bar at the top of the page.
 * - Pick: every element a tour can point at is outlined; clicking one points the step at it (the console's tab
 *   reloads the tour). "Pause" lets clicks through, to get to the right screen first.
 * - Preview: runs the tour as it is now — a draft too — without recording anything.
 */
export const TourAuthorBar = ({ author }: { author: AuthorMode }) => {
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState<{ anchor: string; top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const picking = author.mode === 'pick' && !paused;

  useEffect(() => {
    if (!picking) return;
    document.documentElement.dataset.tourPicking = '1';
    const onMove = (e: PointerEvent) => {
      const el = markedAt(e.target);
      if (!el) return setHover(null);
      const r = el.getBoundingClientRect();
      setHover({ anchor: el.dataset.tour!, top: Math.max(4, r.top - 26), left: r.left });
    };
    const onClick = (e: MouseEvent) => {
      const el = markedAt(e.target);
      if (!el || !author.stepId) return;
      e.preventDefault();
      e.stopPropagation();
      const anchor = el.dataset.tour!;
      setBusy(true);
      api()
        .post(`/platform/support/help/tours/${encodeURIComponent(author.tourId)}/anchor`, {
          step_id: author.stepId,
          anchor,
        })
        .then(() => {
          try {
            localStorage.setItem(
              PICKED_KEY,
              JSON.stringify({ tourId: author.tourId, stepId: author.stepId, anchor, at: Date.now() }),
            );
          } catch {
            // The console tab reloads the tour when its window gets the focus anyway.
          }
          showToast({ message: t('tour.author.picked', { name: anchorLabel(anchor) }) });
          clearAuthorMode();
        })
        .catch((err) => showToast({ message: errorMessage(err), tone: 'error' }))
        .finally(() => setBusy(false));
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('click', onClick, true);
    return () => {
      delete document.documentElement.dataset.tourPicking;
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('click', onClick, true);
      setHover(null);
    };
  }, [picking, author.tourId, author.stepId]);

  const preview = async () => {
    setBusy(true);
    try {
      const tour = await fetchConsoleTour(author.tourId);
      clearAuthorMode();
      startTour(
        {
          id: tour.id,
          title: tour.title,
          route: tour.route,
          steps: tour.steps.map((s) => ({ ...s, media: s.media_id ? helpAssetPath(s.media_id) : null })),
        },
        { preview: true },
      );
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        data-tour-author
        data-testid="tour-author-bar"
        data-mode={author.mode}
        role="region"
        aria-label={t('tour.author.label')}
        className="fixed inset-x-0 top-0 z-tour-top flex flex-wrap items-center gap-2 bg-[var(--accent)] px-4 py-2 text-sm text-[#13221f] shadow-md"
      >
        <Icon name={author.mode === 'pick' ? 'place' : 'play'} size={16} />
        <span className="min-w-0 flex-1" dir="auto">
          {author.mode === 'pick'
            ? paused
              ? t('tour.author.paused')
              : t('tour.author.pick', { title: author.title ?? '' })
            : t('tour.author.preview', { title: author.title ?? '' })}
        </span>
        {author.mode === 'pick' ? (
          <Button
            size="sm"
            variant="secondary"
            className="font-normal"
            onClick={() => setPaused((p) => !p)}
            data-testid="tour-author-pause"
          >
            {paused ? t('tour.author.resume') : t('tour.author.pause')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="font-normal"
            busy={busy}
            onClick={() => void preview()}
            data-testid="tour-author-start"
          >
            {t('tour.author.start')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="font-normal"
          onClick={clearAuthorMode}
          data-testid="tour-author-cancel"
        >
          {t('common.cancel')}
        </Button>
      </div>
      {picking && hover ? (
        <span
          aria-hidden
          className="pointer-events-none fixed z-tour-top rounded-[6px] bg-heading px-2 py-0.5 text-xs text-white"
          style={{ top: hover.top, left: hover.left }}
          data-testid="tour-author-hover"
        >
          {anchorLabel(hover.anchor)}
        </span>
      ) : null}
    </>
  );
};
