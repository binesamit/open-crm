// SPDX-License-Identifier: AGPL-3.0-only
/**
 * F9 cardw (product decision — "a minimum width for the item / subitem panel and a maximum
 * for the screen, resizable by drag"): the item card's width. The account sets the default width (a share of the
 * window) and the limits (Administration → General → defaults); each user may drag the card's edge to their own
 * width (px, kept in their appearance on the server — every device), which wins over the default. Whatever is
 * stored, the width in effect is always clamped to the limits of the current window.
 */

/** The account defaults (`account_settings.settings.defaults.card_*`). */
export const CARD_WIDTH_DEFAULTS = {
  /** The card's default width, % of the window. */
  card_width_pct: 40,
  /** The narrowest the card may get (px) — its tabs and fields stay usable. */
  card_min_px: 380,
  /** The widest it may get, % of the window (and never closer than `CARD_BOARD_GAP_PX` to the window's far edge). */
  card_max_pct: 90,
} as const;

/** Bounds of the account settings themselves. */
export const CARD_WIDTH_PCT_RANGE = { min: 20, max: 95 } as const;
export const CARD_MIN_PX_RANGE = { min: 280, max: 1200 } as const;
export const CARD_MAX_PCT_RANGE = { min: 30, max: 95 } as const;
/** A stored user width outside this range is ignored (garbage). */
export const CARD_USER_PX_RANGE = { min: 200, max: 8000 } as const;

/** Presets offered for the default width (the setting stores the %, so any value works). */
export const CARD_WIDTH_PRESETS = { narrow: 30, medium: 40, wide: 55 } as const;
export type CardWidthPreset = keyof typeof CARD_WIDTH_PRESETS;

/** The board always keeps at least this much of the window visible beside the card (px). */
export const CARD_BOARD_GAP_PX = 120;
/** Keyboard steps of the resize handle (px): arrows, Shift+arrows. */
export const CARD_KEY_STEP_PX = 16;
export const CARD_KEY_BIG_STEP_PX = 80;

export type CardWidthLimits = { card_width_pct?: number; card_min_px?: number; card_max_pct?: number };

/** The min / max width (px) of the card in a window `viewport` px wide. The min never exceeds the max. */
export const cardWidthBounds = (viewport: number, limits: CardWidthLimits = {}) => {
  const vw = Math.max(0, Math.round(viewport));
  const maxPct = limits.card_max_pct ?? CARD_WIDTH_DEFAULTS.card_max_pct;
  const max = Math.max(0, Math.min(Math.floor((vw * maxPct) / 100), vw - CARD_BOARD_GAP_PX));
  const min = Math.min(limits.card_min_px ?? CARD_WIDTH_DEFAULTS.card_min_px, max);
  return { min, max };
};

/** `px` kept within the bounds of this window (whole pixels). */
export const clampCardWidth = (px: number, viewport: number, limits: CardWidthLimits = {}) => {
  const { min, max } = cardWidthBounds(viewport, limits);
  if (!Number.isFinite(px)) return min;
  return Math.round(Math.min(max, Math.max(min, px)));
};

/** The account's default width (px) in this window, clamped. */
export const defaultCardWidth = (viewport: number, limits: CardWidthLimits = {}) =>
  clampCardWidth((viewport * (limits.card_width_pct ?? CARD_WIDTH_DEFAULTS.card_width_pct)) / 100, viewport, limits);

/** The width in effect: the user's own (dragged) width, else the account's default — always clamped. */
export const resolveCardWidth = (userPx: number | null | undefined, viewport: number, limits: CardWidthLimits = {}) =>
  typeof userPx === 'number' && Number.isFinite(userPx)
    ? clampCardWidth(userPx, viewport, limits)
    : defaultCardWidth(viewport, limits);

/**
 * The width while dragging the handle: the card is anchored at the window's inline-start edge, so its width is the
 * pointer's distance from that edge — the right edge in RTL, the left one in LTR.
 */
export const cardWidthFromPointer = (clientX: number, viewport: number, rtl: boolean, limits: CardWidthLimits = {}) =>
  clampCardWidth(rtl ? viewport - clientX : clientX, viewport, limits);

/**
 * The width while dragging, relative to where the drag began: the start width plus how far the pointer moved into the
 * board (left in RTL). Grabbing the handle anywhere across its width never makes the card jump.
 */
export const cardWidthFromDrag = (
  startWidth: number,
  startX: number,
  clientX: number,
  viewport: number,
  rtl: boolean,
  limits: CardWidthLimits = {},
) => clampCardWidth(startWidth + (rtl ? startX - clientX : clientX - startX), viewport, limits);

/**
 * A keyboard step on the handle (a `separator`): the arrow that points into the board widens the card, the other one
 * narrows it (left widens in RTL); Home / End = the min / max.
 */
export const cardWidthFromKey = (
  key: string,
  current: number,
  viewport: number,
  rtl: boolean,
  opts: { big?: boolean; limits?: CardWidthLimits } = {},
): number | null => {
  const { min, max } = cardWidthBounds(viewport, opts.limits);
  const step = opts.big ? CARD_KEY_BIG_STEP_PX : CARD_KEY_STEP_PX;
  const grow = rtl ? 'ArrowLeft' : 'ArrowRight';
  const shrink = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === grow || key === 'ArrowUp') return clampCardWidth(current + step, viewport, opts.limits);
  if (key === shrink || key === 'ArrowDown') return clampCardWidth(current - step, viewport, opts.limits);
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return null;
};

/** A stored (untrusted) user width, or undefined. */
export const cleanCardWidth = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= CARD_USER_PX_RANGE.min && v <= CARD_USER_PX_RANGE.max
    ? v
    : undefined;
