// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MEDIA_SPEEDS, t, type MediaKind } from '@bines/shared';
import { cn, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';

/**
 * The app's own audio / video player: files stored in the account's storage play here — in an update
 * in the file viewer — with our controls (play, ±10 s, seek, speed, volume, full screen, picture in picture) and
 * the keyboard (Space / K, ← →, ↑ ↓, M, F). Speed and volume are remembered on this device; one player plays at a
 * time (starting one pauses the others).
 */

const PREFS_KEY = 'bines:media-player';
type Prefs = { rate: number; volume: number; muted: boolean };
const DEFAULT_PREFS: Prefs = { rate: 1, volume: 1, muted: false };

export const readMediaPrefs = (): Prefs => {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    return {
      rate: (MEDIA_SPEEDS as readonly number[]).includes(raw?.rate as number) ? (raw!.rate as number) : 1,
      volume: typeof raw?.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : 1,
      muted: raw?.muted === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
};
const saveMediaPrefs = (patch: Partial<Prefs>) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readMediaPrefs(), ...patch }));
  } catch {
    // Private mode / blocked storage: the choice holds for this player only.
  }
};

/** "1:05", "12:40", "1:02:03". */
export const formatMediaTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/** The one playing now: starting another pauses it. */
let playing: HTMLMediaElement | null = null;

const SKIP_S = 10;
const ARROW_S = 5;

const CtlButton = ({
  icon,
  label,
  onClick,
  testId,
  pressed,
}: {
  icon: IconName;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
  pressed?: boolean;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    onClick={onClick}
    data-testid={testId}
    className="media-ctl grid size-8 shrink-0 place-items-center rounded-full text-current focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
  >
    <Icon name={icon} size={16} />
  </button>
);

/**
 * A bar one drags or clicks (time, volume) — ours, not the browser's range input; ← → (and ↑ ↓) move it by `step`.
 * Laid out left to right (its parent is `dir="ltr"`).
 */
const Track = ({
  value,
  max,
  step,
  label,
  valueText,
  loaded = 0,
  onChange,
  onDrag,
  dark,
  testId,
  className,
}: {
  value: number;
  max: number;
  step: number;
  label: string;
  valueText: string;
  loaded?: number;
  onChange: (v: number) => void;
  onDrag?: (on: boolean) => void;
  dark: boolean;
  testId?: string;
  className?: string;
}) => {
  const [drag, setDrag] = useState(false);
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const from = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onChange(Math.min(Math.max(0, (e.clientX - r.left) / r.width), 1) * max);
  };
  const dragging = (on: boolean) => {
    setDrag(on);
    onDrag?.(on);
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max * 100) / 100}
      aria-valuenow={Math.round(value * 100) / 100}
      aria-valuetext={valueText}
      data-testid={testId}
      className={cn('group/track relative flex h-6 cursor-pointer touch-none items-center outline-none', className)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging(true);
        from(e);
      }}
      onPointerMove={(e) => drag && from(e)}
      onPointerUp={() => dragging(false)}
      onPointerCancel={() => dragging(false)}
      onKeyDown={(e) => {
        const d =
          e.key === 'ArrowRight' || e.key === 'ArrowUp'
            ? step
            : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
              ? -step
              : 0;
        if (e.key === 'Home') onChange(0);
        else if (e.key === 'End') onChange(max);
        else if (d) onChange(Math.min(Math.max(0, value + d), max));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span
        className={cn(
          'relative h-1 w-full overflow-hidden rounded-full group-focus-visible/track:outline-2 group-focus-visible/track:outline-offset-4 group-focus-visible/track:outline-[var(--focus-ring)]',
          dark ? 'bg-white/30' : 'bg-line',
        )}
      >
        {loaded ? (
          <span
            className={cn('absolute inset-y-0 left-0', dark ? 'bg-white/40' : 'bg-line-strong')}
            style={{ width: `${Math.min(100, (loaded / max) * 100)}%` }}
          />
        ) : null}
        <span
          className={cn('absolute inset-y-0 left-0', dark ? 'bg-white' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={cn(
          'absolute size-3 -translate-x-1/2 rounded-full opacity-0 shadow group-hover/track:opacity-100 group-focus-visible/track:opacity-100',
          dark ? 'bg-white' : 'bg-primary',
          drag && 'opacity-100',
        )}
        style={{ left: `${pct}%` }}
      />
    </div>
  );
};

export const MediaPlayer = ({
  src,
  kind,
  name,
  compact = false,
  onError,
  className,
}: {
  src: string;
  kind: MediaKind;
  name: string;
  /** In an update: smaller (a video at most 20rem wide, audio one slim bar). */
  compact?: boolean;
  /** The browser cannot play it (a format it does not know): the caller offers the download. */
  onError?: () => void;
  className?: string;
}) => {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const speed = useActionMenu();
  const [prefs, setPrefs] = useState(readMediaPrefs);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const video = kind === 'video';

  // The remembered speed / volume on the element (and again after a new source loads).
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    el.playbackRate = prefs.rate;
    el.volume = prefs.volume;
    el.muted = prefs.muted;
  }, [prefs, src]);

  useEffect(
    () => () => {
      if (playing === media.current) playing = null;
    },
    [],
  );

  const update = (patch: Partial<Prefs>) => {
    setPrefs((p) => ({ ...p, ...patch }));
    saveMediaPrefs(patch);
  };
  const toggle = () => {
    const el = media.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };
  const seekTo = (s: number) => {
    const el = media.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.min(Math.max(0, s), el.duration);
    setTime(el.currentTime);
  };
  const setVolume = (v: number) => update({ volume: Math.min(Math.max(0, v), 1), muted: v <= 0 });
  const fullscreen = () => {
    const box = root.current;
    if (!box) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void box.requestFullscreen?.().catch(() => undefined);
  };
  const pip = () => {
    const el = media.current as HTMLVideoElement | null;
    if (!el) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture?.();
    else void el.requestPictureInPicture?.().catch(() => undefined);
  };
  const canPip = video && typeof document !== 'undefined' && !!document.pictureInPictureEnabled;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
    const k = e.key.toLowerCase();
    const handled = (() => {
      if (k === ' ' || k === 'k') toggle();
      else if (e.key === 'ArrowLeft') seekTo(time - ARROW_S);
      else if (e.key === 'ArrowRight') seekTo(time + ARROW_S);
      else if (e.key === 'ArrowUp') setVolume(prefs.volume + 0.1);
      else if (e.key === 'ArrowDown') setVolume(prefs.volume - 0.1);
      else if (k === 'm') update({ muted: !prefs.muted });
      else if (k === 'f' && video) fullscreen();
      else return false;
      return true;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const speeds: MenuEntry[] = MEDIA_SPEEDS.map((r) => ({
    label: r === 1 ? t('media.speedNormal') : `×${r}`,
    checked: prefs.rate === r,
    testId: `media-speed-${r}`,
    onSelect: () => update({ rate: r }),
  }));
  const muted = prefs.muted || prefs.volume === 0;

  if (failed)
    return (
      <p className="text-sm text-muted" data-testid="media-player-failed">
        {t('media.cannotPlay')}
      </p>
    );

  const bar = (
    // The bar reads left to right in both directions (time runs that way on every player).
    <div
      dir="ltr"
      className={cn(
        'flex w-full items-center gap-1 text-xs',
        video
          ? 'media-dark absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-1.5 text-white transition-opacity'
          : 'rounded-full border border-line bg-surface-2 px-1.5 py-1 text-fg',
        video && !paused && !dragging && 'opacity-0 group-hover/media:opacity-100 group-focus-within/media:opacity-100',
      )}
    >
      <CtlButton
        icon={paused ? 'play' : 'pause'}
        label={t(paused ? 'media.play' : 'media.pause')}
        onClick={toggle}
        testId="media-play"
      />
      {!compact || video ? (
        <>
          <CtlButton icon="rewind" label={t('media.back', { s: SKIP_S })} onClick={() => seekTo(time - SKIP_S)} />
          <CtlButton icon="forward" label={t('media.ahead', { s: SKIP_S })} onClick={() => seekTo(time + SKIP_S)} />
        </>
      ) : null}
      <span className="shrink-0 tabular-nums" data-testid="media-time">
        {formatMediaTime(time)}
      </span>
      <Track
        value={time}
        max={duration}
        step={ARROW_S}
        loaded={buffered}
        label={t('media.seek')}
        valueText={`${formatMediaTime(time)} / ${formatMediaTime(duration)}`}
        onChange={seekTo}
        onDrag={setDragging}
        dark={video}
        testId="media-seek"
        className="mx-1 min-w-12 flex-1"
      />
      <span className="shrink-0 tabular-nums text-current/80" data-testid="media-duration">
        {formatMediaTime(duration)}
      </span>
      <button
        type="button"
        onClick={speed.fromTrigger}
        aria-haspopup="menu"
        aria-label={t('media.speed')}
        title={t('media.speed')}
        data-testid="media-speed"
        className="media-ctl h-7 shrink-0 rounded-full px-2 tabular-nums"
      >
        ×{prefs.rate}
      </button>
      <span className="group/vol flex shrink-0 items-center">
        <CtlButton
          icon={muted ? 'mute' : 'volume'}
          label={t(muted ? 'media.unmute' : 'media.mute')}
          onClick={() => update({ muted: !muted, ...(muted && prefs.volume === 0 ? { volume: 1 } : {}) })}
          pressed={muted}
          testId="media-mute"
        />
        {!compact ? (
          <Track
            value={muted ? 0 : prefs.volume}
            max={1}
            step={0.1}
            label={t('media.volume')}
            valueText={`${Math.round((muted ? 0 : prefs.volume) * 100)}%`}
            onChange={setVolume}
            dark={video}
            testId="media-volume"
            className="w-0 overflow-hidden opacity-0 transition-all group-hover/vol:ms-1 group-hover/vol:w-16 group-hover/vol:opacity-100 focus-visible:ms-1 focus-visible:w-16 focus-visible:opacity-100"
          />
        ) : null}
      </span>
      {canPip ? <CtlButton icon="pip" label={t('media.pip')} onClick={pip} /> : null}
      {video ? (
        <CtlButton icon="fullscreen" label={t('media.fullscreen')} onClick={fullscreen} testId="media-fullscreen" />
      ) : null}
    </div>
  );

  const events = {
    onPlay: () => {
      if (playing && playing !== media.current) playing.pause();
      playing = media.current;
      setPaused(false);
    },
    onPause: () => setPaused(true),
    onEnded: () => setPaused(true),
    onTimeUpdate: () => {
      const el = media.current;
      if (!el) return;
      setTime(el.currentTime);
      if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
    },
    onLoadedMetadata: () => {
      const el = media.current;
      if (!el) return;
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      el.playbackRate = prefs.rate;
    },
    onDurationChange: () => {
      const el = media.current;
      if (el && Number.isFinite(el.duration)) setDuration(el.duration);
    },
    onError: () => {
      setFailed(true);
      onError?.();
    },
  };

  return (
    <div
      ref={root}
      className={cn(
        'group/media relative outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        video ? 'overflow-hidden rounded-[10px] bg-black' : 'w-full',
        video && compact && 'w-80 max-w-full',
        className,
      )}
      tabIndex={0}
      role="group"
      aria-label={t(video ? 'media.videoOf' : 'media.audioOf', { name })}
      data-testid="media-player"
      data-kind={kind}
      data-state={paused ? 'paused' : 'playing'}
      onKeyDown={onKey}
    >
      {video ? (
        <video
          ref={media}
          src={src}
          preload="metadata"
          playsInline
          onClick={toggle}
          className={cn('block w-full', compact ? 'max-h-60' : 'max-h-[calc(100dvh-14rem)]')}
          {...events}
        />
      ) : (
        <audio ref={media} src={src} preload="metadata" className="hidden" {...events} />
      )}
      {bar}
      <Menu at={speed.at} onClose={speed.close} items={speeds} label={t('media.speed')} />
    </div>
  );
};
