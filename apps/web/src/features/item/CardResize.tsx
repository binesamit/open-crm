// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { cardWidthBounds, cardWidthFromDrag, cardWidthFromKey, type CardWidthLimits, t } from '@bines/shared';
import { cn } from '@bines/ui';
import { saveCardWidth, saveCardWidthSoon, useMyCardWidth } from '../../lib/card-width';

const isRtl = () => document.documentElement.dir === 'rtl';

/**
 * F9 cardw: the handle on the card's inner edge (the one facing the board — inline-end): drag it (mouse / touch /
 * pen), or focus it and use the arrows (Shift = bigger steps, Home / End = min / max); a double click goes back to
 * the account's default width. While dragging, the panel's width is set directly once per frame (no re-render);
 * the width is saved for the user when the drag ends.
 */
export const CardResizeHandle = ({
  width,
  viewport,
  limits,
  accountId,
}: {
  width: number;
  viewport: number;
  limits: CardWidthLimits | undefined;
  accountId: string;
}) => {
  const [dragging, setDragging] = useState(false);
  // The width while dragging / stepping, and what it started from: the width in effect and my saved width.
  const [live, setLive] = useState<{ px: number; from: number; mine: number | null } | null>(null);
  const mine = useMyCardWidth();
  // The handle sits directly in the card panel; its parent is what gets resized.
  const self = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const frame = useRef(0);
  const next = useRef<number | null>(null);
  const startX = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const { min, max } = cardWidthBounds(viewport, limits);
  // Once either changes (saved — here, by ⋯ → reset, or on another device), the live value is done.
  const shown = live && live.from === width && live.mine === mine ? live.px : width;

  const paint = (px: number) => {
    next.current = px;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const card = self.current?.parentElement;
      if (card && next.current !== null) card.style.width = `${next.current}px`;
    });
  };
  const end = (commit: boolean) => {
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    document.documentElement.classList.remove('card-resizing');
    const px = next.current;
    next.current = null;
    setLive(null);
    if (commit && px !== null && px !== width) void saveCardWidth(px, accountId);
    else if (self.current?.parentElement) self.current.parentElement.style.width = `${width}px`;
  };

  return (
    <div
      ref={self}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('cardw.resize')}
      aria-valuenow={shown}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${shown}px`}
      tabIndex={0}
      data-tip={t('cardw.resizeHint')}
      data-testid="card-resize"
      data-dragging={dragging ? 'true' : undefined}
      className="group/resize absolute inset-y-0 -end-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none select-none max-md:hidden"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        document.documentElement.classList.add('card-resizing');
        next.current = width;
        startX.current = e.clientX;
        active.current = true;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        const px = cardWidthFromDrag(width, startX.current, e.clientX, window.innerWidth, isRtl(), limits);
        setLive({ px, from: width, mine });
        paint(px);
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(true)}
      onDoubleClick={() => {
        // Steps not saved yet are dropped too (the save waiting for them is cancelled by this one).
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        setLive(null);
        if (self.current?.parentElement) self.current.parentElement.style.width = `${width}px`;
        void saveCardWidth(null, accountId);
      }}
      onKeyDown={(e) => {
        const px = cardWidthFromKey(e.key, shown, window.innerWidth, isRtl(), { big: e.shiftKey, limits });
        if (px === null) return;
        e.preventDefault();
        e.stopPropagation();
        setLive({ px, from: width, mine });
        paint(px);
        // Saved once the keys stop (a held arrow is many steps); a reset meanwhile cancels it.
        saveCardWidthSoon(px, accountId, 400);
      }}
    >
      {/* The visible line: hidden until hover / focus / drag (F4: quiet chrome). */}
      <span
        aria-hidden
        className={cn(
          'h-full w-0.5 rounded-full bg-[var(--primary)] opacity-0 transition-opacity duration-150 group-hover/resize:opacity-60 group-focus-visible/resize:opacity-100',
          dragging && 'opacity-100',
        )}
      />
    </div>
  );
};
