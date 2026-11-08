// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { type HelpGuideView, t } from '@bines/shared';
import { cn, Dialog } from '@bines/ui';

/** Seconds → `m:ss` (`h:mm:ss` past an hour). */
export const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** "Video 1:20 · 4 steps" — a guide's line under its title and on its card. */
export const guideMeta = (duration: number | null | undefined, steps: number) =>
  [
    duration ? t('guide.meta.video', { time: clock(duration) }) : null,
    steps ? (steps === 1 ? t('guide.meta.step') : t('guide.meta.steps', { n: steps })) : null,
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * A practical guide (canvas ב1): the video — the platform's file with its captions, or a YouTube /
 * Vimeo player — with its chapters beside it (a click jumps there), then the steps: one sentence and one
 * screenshot each, a numbered marker on the spot to click. A screenshot opens large on a click.
 */
export const GuideView = ({ guide }: { guide: HelpGuideView }) => {
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [zoom, setZoom] = useState<{ src: string; n: number; marker: { x: number; y: number } | null } | null>(null);
  const v = guide.video;
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const on = () => setNow(el.currentTime);
    el.addEventListener('timeupdate', on);
    return () => el.removeEventListener('timeupdate', on);
  }, []);
  const chapters = v?.chapters ?? [];
  const current = chapters.reduce((acc, c, i) => (c.at <= now + 0.25 ? i : acc), -1);
  const seek = (at: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = at;
    void el.play().catch(() => undefined);
  };
  return (
    <div className="space-y-5" data-testid="guide">
      {v ? (
        <div className="flex gap-4 max-md:flex-col">
          <div className="min-w-0 flex-1">
            {v.embed_url ? (
              <iframe
                src={v.embed_url}
                title={t('guide.video')}
                className="aspect-video w-full rounded-[12px] border-0 bg-[var(--shell)]"
                allow="encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                data-testid="guide-embed"
              />
            ) : v.src ? (
              <video
                ref={video}
                src={v.src}
                poster={v.poster ?? undefined}
                controls
                preload="metadata"
                playsInline
                className="aspect-video w-full rounded-[12px] bg-[var(--shell)]"
                data-testid="guide-video"
              >
                {v.captions.map((c, i) => (
                  <track
                    key={c.locale}
                    kind="captions"
                    src={c.src}
                    srcLang={c.locale}
                    label={t(c.locale === 'he' ? 'help.locale.he' : 'help.locale.en')}
                    default={i === 0}
                  />
                ))}
              </video>
            ) : null}
          </div>
          {chapters.length && v.src ? (
            <ol
              aria-label={t('guide.chapters')}
              className="flex w-[210px] shrink-0 flex-col gap-1 max-md:w-full"
              data-testid="guide-chapters"
            >
              {chapters.map((c, i) => (
                <li key={`${c.at}:${c.title}`}>
                  <button
                    type="button"
                    onClick={() => seek(c.at)}
                    aria-current={i === current ? 'true' : undefined}
                    data-testid="guide-chapter"
                    className={cn(
                      'flex w-full gap-2.5 rounded-[9px] px-2.5 py-2 text-start text-[0.8125rem] hover:bg-surface-2',
                      i === current && 'bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)]',
                    )}
                  >
                    <span className="w-[2.125rem] shrink-0 text-muted tabular-nums" dir="ltr">
                      {clock(c.at)}
                    </span>
                    <span className="min-w-0 text-fg" dir="auto">
                      {c.title}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      {guide.steps.length ? (
        <section className="space-y-4" aria-labelledby="guide-steps">
          <h2 id="guide-steps" className="font-display text-lg font-extrabold text-heading">
            {t('guide.steps')}
          </h2>
          <ol className="space-y-5" data-testid="guide-steps">
            {guide.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3.5" data-testid="guide-step">
                <span
                  aria-hidden
                  className="grid size-[30px] shrink-0 place-items-center rounded-full bg-primary text-sm text-on-primary"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-2.5">
                  <p className="mt-1 text-[0.9375rem] leading-relaxed text-fg" dir="auto">
                    <span className="sr-only">{t('guide.stepNumber', { n: i + 1 })} </span>
                    {s.text}
                  </p>
                  {s.image ? (
                    <button
                      type="button"
                      onClick={() => setZoom({ src: s.image!, n: i + 1, marker: s.marker })}
                      className="relative block w-full overflow-hidden rounded-[12px] border border-line bg-surface-3 text-start focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                      aria-label={t('guide.zoom', { n: i + 1 })}
                      data-testid="guide-shot"
                    >
                      <Shot src={s.image} n={i + 1} marker={s.marker} />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {zoom ? (
        <Dialog open onClose={() => setZoom(null)} title={t('guide.stepNumber', { n: zoom.n })} className="max-w-5xl">
          <Shot src={zoom.src} n={zoom.n} marker={zoom.marker} />
        </Dialog>
      ) : null}
    </div>
  );
};

/** A screenshot with its numbered marker (placed in fractions of the picture, so it stays put at any size). */
const Shot = ({ src, n, marker }: { src: string; n: number; marker: { x: number; y: number } | null }) => (
  <span className="relative block">
    <img src={src} alt="" className="block h-auto w-full" loading="lazy" />
    {marker ? (
      <span
        aria-hidden
        data-testid="guide-marker"
        className="absolute grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--accent)] text-[0.8125rem] text-[#13221f] shadow-[0_0_0_4px_rgba(255,176,32,0.3)]"
        style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
      >
        {n}
      </span>
    ) : null}
  </span>
);
