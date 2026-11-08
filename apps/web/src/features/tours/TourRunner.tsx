// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@bines/shared';
import { Button, cn, hasOpenLayers } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { findAnchor, goToStep, type Running } from './tour-store';
import { checklistSeen } from '../checklist/checklist-api';

/** Room around the lit element, and between it and the bubble. */
const PAD = 8;
const GAP = 14;
const EDGE = 16;
/** How long a step waits for its element to appear (a list loading) before the bubble stands in the middle. */
const WAIT_MS = 1500;

type Box = { top: number; left: number; width: number; height: number };
const boxOf = (el: HTMLElement): Box => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};
const sameBox = (a: Box | null, b: Box | null) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);

const MEDIA = 'max-h-[180px] w-full rounded-[12px] border border-line bg-surface-2 object-contain';

/** A step's clip (a short muted loop) or picture; a file of unknown type is tried as a picture, then as a clip. */
const StepMedia = ({ src, type }: { src: string; type?: string | null }) => {
  const [video, setVideo] = useState(!!type?.startsWith('video/'));
  return video ? (
    <video src={src} className={MEDIA} autoPlay muted loop playsInline data-testid="tour-media" />
  ) : (
    <img src={src} alt="" className={MEDIA} onError={() => !type && setVideo(true)} data-testid="tour-media" />
  );
};

/**
 * A running guided tour (canvas א2): the screen dims, the step's element is lit (a ring in the accent
 * colour) and a bubble beside it says "<tour> · 2 of 5", a title, a sentence and an optional clip, with next / back /
 * skip. The dimming never blocks the page — the person can still click what is lit (a "wait for a click" step goes on
 * when they do). A step whose element is not on the screen (another layout, a phone) shows its bubble in the middle.
 */
export const TourRunner = (props: RunnerProps) => <RunnerStep key={props.run.step} {...props} />;

type RunnerProps = {
  run: Running;
  /** `done` = the last step's "finish"; `dismissed` = closed or skipped. */
  onEnd: (state: 'done' | 'dismissed') => void;
  /** "Watch the video": the guide that links this tour. */
  onGuide?: (slug: string) => void;
  /** The account a "wait for an action" step asks about; none = such a step waits for "next". */
  accountId?: string;
};

/** How often a step waiting for an action asks whether it happened. */
const SEEN_POLL_MS = 2000;

/** One step of the tour (a new step is a new mount: its element is looked for from scratch). */
const RunnerStep = ({ run, onEnd, onGuide, accountId }: RunnerProps) => {
  const { tour, step: index } = run;
  const step = tour.steps[index]!;
  const last = index === tour.steps.length - 1;
  // a step that waits until the person really does it ("creates an item") goes on by itself.
  const waitEvent = !run.preview && accountId ? step.wait_event : null;
  useEffect(() => {
    if (!waitEvent || !accountId) return;
    const since = new Date().toISOString();
    let stopped = false;
    const id = window.setInterval(() => {
      void checklistSeen(accountId, waitEvent, since)
        .then((r) => {
          if (stopped || !r.seen) return;
          stopped = true;
          if (last) onEnd('done');
          else goToStep(index + 1);
        })
        .catch(() => undefined);
    }, SEEN_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [waitEvent, accountId, index, last, onEnd]);
  const [box, setBox] = useState<Box | null>(null);
  const [gaveUp, setGaveUp] = useState(!step.anchor);
  const bubble = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(240);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });

  // Follow the element: it may appear late, move when the page scrolls or the layout changes.
  useEffect(() => {
    if (!step.anchor) return;
    let scrolled = false;
    const started = performance.now();
    const tick = () => {
      const el = findAnchor(step.anchor);
      if (!el) {
        if (performance.now() - started > WAIT_MS) setGaveUp(true);
        setBox(null);
        return;
      }
      setGaveUp(false);
      if (!scrolled) {
        scrolled = true;
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth)
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      const next = boxOf(el);
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    tick();
    const timer = window.setInterval(tick, 200);
    const onMove = () => {
      setView({ w: window.innerWidth, h: window.innerHeight });
      tick();
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [step.anchor, index]);

  // "Wait for a click": the step goes on when the person presses the lit element.
  useEffect(() => {
    if (!step.wait_click || !step.anchor) return;
    const onClick = (e: MouseEvent) => {
      const el = findAnchor(step.anchor);
      if (el && e.target instanceof Node && el.contains(e.target)) {
        if (last) onEnd('done');
        else goToStep(index + 1);
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [step.wait_click, step.anchor, index, last, onEnd]);

  // Esc closes the tour (an open menu or dialog keeps its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !hasOpenLayers() && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        e.preventDefault();
        onEnd('dismissed');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEnd]);

  // The bubble takes the focus on each step (keyboard and screen readers follow the tour).
  useEffect(() => {
    if (!step.wait_click) bubble.current?.focus({ preventScroll: true });
  }, [index, step.wait_click]);

  const waiting = !!step.anchor && !box && !gaveUp;
  // The bubble's height places it above or below the element (it changes when a clip loads).
  useEffect(() => {
    const el = bubble.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight || 240));
    ro.observe(el);
    return () => ro.disconnect();
  }, [waiting]);

  const width = Math.min(372, view.w - EDGE * 2);
  let top: number;
  let left: number;
  let arrow: { side: 'top' | 'bottom'; x: number } | null = null;
  if (box) {
    const cx = box.left + box.width / 2;
    left = Math.min(Math.max(cx - width / 2, EDGE), view.w - width - EDGE);
    const below = box.top + box.height + PAD + GAP;
    const above = box.top - PAD - GAP - height;
    if (below + height <= view.h - EDGE) {
      top = below;
      arrow = { side: 'top', x: cx - left };
    } else if (above >= EDGE) {
      top = above;
      arrow = { side: 'bottom', x: cx - left };
    } else top = Math.max(EDGE, view.h - height - EDGE);
    if (arrow) arrow.x = Math.min(Math.max(arrow.x, 24), width - 24);
  } else {
    top = Math.max(EDGE, (view.h - height) / 2);
    left = (view.w - width) / 2;
  }

  const media = step.media ? <StepMedia key={step.media} src={step.media} type={step.media_type} /> : null;

  return createPortal(
    <div data-testid="tour" data-tour-id={tour.id} data-step={index} data-preview={run.preview || undefined}>
      {/* The dimming: a ring around the lit element and a shadow over everything else; it never takes a click. */}
      {box ? (
        <div
          aria-hidden
          data-testid="tour-spotlight"
          className="pointer-events-none fixed z-tour rounded-[12px] transition-[top,left,width,height] duration-200 motion-reduce:transition-none"
          style={{
            top: box.top - PAD,
            left: box.left - PAD,
            width: box.width + PAD * 2,
            height: box.height + PAD * 2,
            boxShadow: '0 0 0 3px var(--accent), 0 0 0 200vmax rgba(7, 36, 32, 0.55)',
          }}
        />
      ) : waiting ? null : (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-tour bg-[rgba(7,36,32,0.55)]" />
      )}
      {waiting ? null : (
        <section
          ref={bubble}
          role="dialog"
          aria-label={tour.title}
          aria-describedby="tour-step-body"
          tabIndex={-1}
          data-testid="tour-bubble"
          className="anim-pop fixed z-tour-step flex flex-col gap-3 rounded-[16px] bg-surface px-5 pt-[18px] pb-4 shadow-[0_16px_40px_rgba(7,36,32,0.35)] outline-none"
          style={{ top, left, width }}
        >
          {arrow ? (
            <span
              aria-hidden
              className={cn(
                'absolute size-4 rotate-45 rounded-[3px] bg-surface',
                arrow.side === 'top' ? '-top-2' : '-bottom-2',
              )}
              style={{ left: arrow.x - 8 }}
            />
          ) : null}
          <div className="flex items-center gap-2">
            <span
              className="truncate rounded-full bg-[var(--accent-soft)] px-2.5 py-[3px] text-xs text-[var(--accent-fg)]"
              data-testid="tour-count"
            >
              {t('tour.count', { title: tour.title, n: index + 1, total: tour.steps.length })}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              aria-label={t('tour.close')}
              onClick={() => onEnd('dismissed')}
              data-testid="tour-close"
              className="grid size-[30px] shrink-0 place-items-center rounded-[9px] text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <h2 className="font-display text-[1.1875rem] leading-snug font-extrabold text-heading" dir="auto">
            {step.title}
          </h2>
          {step.body ? (
            <p id="tour-step-body" className="text-sm leading-relaxed whitespace-pre-line text-fg-2" dir="auto">
              {step.body}
            </p>
          ) : null}
          {media}
          {step.wait_click && box ? (
            <p className="text-xs text-[var(--accent-fg)]" data-testid="tour-wait">
              {t('tour.waitClick')}
            </p>
          ) : null}
          {waitEvent ? (
            <p className="text-xs text-[var(--accent-fg)]" data-testid="tour-wait-event">
              {t('tour.waitEvent')}
            </p>
          ) : null}
          <div className="flex items-center gap-1.5" aria-hidden>
            {tour.steps.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  'h-2 rounded-full',
                  i === index ? 'w-5 bg-heading' : 'w-2',
                  i < index && 'bg-ok',
                  i > index && 'bg-line-strong',
                )}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {step.wait_click && box ? null : (
              <Button
                variant="accent"
                className="font-normal"
                onClick={() => (last ? onEnd('done') : goToStep(index + 1))}
                data-testid={last ? 'tour-finish' : 'tour-next'}
              >
                {last ? t('tour.finish') : t('tour.next')}
              </Button>
            )}
            {index > 0 ? (
              <Button
                variant="secondary"
                className="font-normal"
                onClick={() => goToStep(index - 1)}
                data-testid="tour-back"
              >
                {t('tour.back')}
              </Button>
            ) : null}
            <span className="flex-1" />
            {last && tour.guide_slug && onGuide ? (
              <button
                type="button"
                onClick={() => onGuide(tour.guide_slug!)}
                className="h-[38px] px-1.5 text-[0.8125rem] text-link underline-offset-2 hover:underline"
                data-testid="tour-guide"
              >
                {t('tour.watchVideo')}
              </button>
            ) : null}
            {last ? null : (
              <button
                type="button"
                onClick={() => onEnd('dismissed')}
                className="h-[38px] px-1.5 text-[0.8125rem] text-muted underline underline-offset-2 hover:text-fg"
                data-testid="tour-skip"
              >
                {t('tour.skip')}
              </button>
            )}
          </div>
        </section>
      )}
    </div>,
    document.body,
  );
};
