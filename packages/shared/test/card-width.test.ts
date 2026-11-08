// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  accountDefaultsSchema,
  CARD_KEY_BIG_STEP_PX,
  CARD_KEY_STEP_PX,
  cardWidthBounds,
  cardWidthFromDrag,
  cardWidthFromKey,
  cardWidthFromPointer,
  clampCardWidth,
  cleanAppearance,
  cleanCardWidth,
  defaultCardWidth,
  resolveCardWidth,
  setAppearanceSchema,
} from '../src';

/** F9 cardw: the item card's width — bounds, clamping, drag and keys. */
describe('card width bounds', () => {
  it('min 380px, max 90% of the window and never closer than 120px to its far edge', () => {
    expect(cardWidthBounds(2000)).toEqual({ min: 380, max: 1800 });
    // 90% of 1000 = 900, but the board keeps 120px → 880.
    expect(cardWidthBounds(1000)).toEqual({ min: 380, max: 880 });
  });
  it('a window too small for the minimum: the min shrinks to the max', () => {
    expect(cardWidthBounds(450)).toEqual({ min: 330, max: 330 });
    expect(cardWidthBounds(100)).toEqual({ min: 0, max: 0 });
  });
  it('follows the account limits', () => {
    expect(cardWidthBounds(2000, { card_min_px: 500, card_max_pct: 60 })).toEqual({ min: 500, max: 1200 });
  });
});

describe('clamping', () => {
  it('keeps a width within the bounds, in whole pixels', () => {
    expect(clampCardWidth(100, 1600)).toBe(380);
    expect(clampCardWidth(5000, 1600)).toBe(1440);
    expect(clampCardWidth(700.6, 1600)).toBe(701);
    expect(clampCardWidth(Number.NaN, 1600)).toBe(380);
  });
  it('re-clamps a saved width when the window gets smaller', () => {
    expect(resolveCardWidth(1400, 2000)).toBe(1400);
    expect(resolveCardWidth(1400, 1200)).toBe(1080);
  });
  it('the default is the account share of the window, clamped', () => {
    expect(defaultCardWidth(1600)).toBe(640);
    expect(defaultCardWidth(800)).toBe(380);
    expect(defaultCardWidth(1600, { card_width_pct: 55 })).toBe(880);
    expect(resolveCardWidth(null, 1600, { card_width_pct: 30 })).toBe(480);
    expect(resolveCardWidth(undefined, 1600)).toBe(640);
  });
});

describe('dragging and keys', () => {
  it('the width is the pointer distance from the inline-start edge (right in RTL)', () => {
    expect(cardWidthFromPointer(1000, 1600, true)).toBe(600);
    expect(cardWidthFromPointer(600, 1600, false)).toBe(600);
    expect(cardWidthFromPointer(1590, 1600, true)).toBe(380);
    expect(cardWidthFromPointer(10, 1600, true)).toBe(1440);
  });
  it('a drag moves the width by the pointer delta from where it began — no jump on grab', () => {
    // Grabbed 1px off the edge, moved 200px into the board: exactly +200.
    expect(cardWidthFromDrag(640, 959.5, 759.5, 1600, true)).toBe(840);
    expect(cardWidthFromDrag(640, 640.5, 840.5, 1600, false)).toBe(840);
    expect(cardWidthFromDrag(640, 960, 960, 1600, true)).toBe(640);
    expect(cardWidthFromDrag(640, 960, 0, 1600, true)).toBe(1440);
    expect(cardWidthFromDrag(640, 960, 1500, 1600, true)).toBe(380);
  });
  it('the arrow into the board widens: left in RTL, right in LTR; Shift = bigger steps; Home / End', () => {
    expect(cardWidthFromKey('ArrowLeft', 600, 1600, true)).toBe(600 + CARD_KEY_STEP_PX);
    expect(cardWidthFromKey('ArrowRight', 600, 1600, true)).toBe(600 - CARD_KEY_STEP_PX);
    expect(cardWidthFromKey('ArrowRight', 600, 1600, false)).toBe(600 + CARD_KEY_STEP_PX);
    expect(cardWidthFromKey('ArrowLeft', 600, 1600, false, { big: true })).toBe(600 - CARD_KEY_BIG_STEP_PX);
    expect(cardWidthFromKey('Home', 600, 1600, true)).toBe(380);
    expect(cardWidthFromKey('End', 600, 1600, true)).toBe(1440);
    expect(cardWidthFromKey('ArrowRight', 385, 1600, true)).toBe(380);
    expect(cardWidthFromKey('a', 600, 1600, true)).toBeNull();
  });
});

describe('stored values', () => {
  it('a stored user width must be a sane whole number', () => {
    expect(cleanCardWidth(640)).toBe(640);
    expect(cleanCardWidth(12.5)).toBeUndefined();
    expect(cleanCardWidth('640')).toBeUndefined();
    expect(cleanCardWidth(50)).toBeUndefined();
    expect(cleanAppearance({ card_width: 700, text_size: 'large' })).toEqual({ card_width: 700, text_size: 'large' });
    expect(setAppearanceSchema.safeParse({ card_width: 10 }).success).toBe(false);
    expect(setAppearanceSchema.parse({ card_width: null })).toEqual({ card_width: null });
  });
  it('the account defaults: 40% / 380px / 90%, within their ranges', () => {
    expect(accountDefaultsSchema.parse({})).toMatchObject({ card_width_pct: 40, card_min_px: 380, card_max_pct: 90 });
    expect(accountDefaultsSchema.safeParse({ card_width_pct: 5 }).success).toBe(false);
    expect(accountDefaultsSchema.safeParse({ card_min_px: 100 }).success).toBe(false);
    expect(accountDefaultsSchema.safeParse({ card_max_pct: 100 }).success).toBe(false);
  });
});
