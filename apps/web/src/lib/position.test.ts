// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { placeFloating } from '@bines/ui';

/** Round 12: every floating element stays on the screen (reported: the @mention list opened off the right edge). */
const vp = { width: 400, height: 800 };
const box = (left: number, top: number, w = 0, h = 20) => ({ left, top, right: left + w, bottom: top + h });

describe('placeFloating', () => {
  it('RTL: lines the list up with the caret on its right — not running off the right edge', () => {
    // A caret near the right edge (Hebrew text starts there); the 240px list must end at the caret.
    const p = placeFloating(box(380, 100), { width: 240, height: 200 }, vp, { rtl: true });
    expect(p.left).toBe(140);
    expect(p.left + 240).toBeLessThanOrEqual(vp.width - 8);
    expect(p.side).toBe('bottom');
  });

  it('LTR at the right edge: flips to the other edge, then shifts inside', () => {
    const p = placeFloating(box(350, 100, 30), { width: 240, height: 200 }, vp, { rtl: false });
    expect(p.left).toBe(380 - 240); // its end edge
    const q = placeFloating(box(390, 100), { width: 240, height: 200 }, vp, { rtl: false });
    expect(q.left + 240).toBeLessThanOrEqual(vp.width - 8);
    expect(q.left).toBeGreaterThanOrEqual(8);
  });

  it('RTL at the left edge: never off the left side', () => {
    const p = placeFloating(box(20, 100), { width: 240, height: 200 }, vp, { rtl: true });
    expect(p.left).toBeGreaterThanOrEqual(8);
  });

  it('flips above when there is no room below, and caps the height to the room', () => {
    const p = placeFloating(box(100, 700), { width: 200, height: 300 }, vp);
    expect(p.side).toBe('top');
    expect(p.top).toBe(700 - 4 - 300);
    const tall = placeFloating(box(100, 390), { width: 200, height: 1000 }, vp);
    expect(tall.maxHeight).toBeLessThan(400);
    expect(tall.top).toBeGreaterThanOrEqual(8);
  });

  it('a panel wider than the screen starts at the margin (and is capped)', () => {
    const p = placeFloating(box(100, 100), { width: 640, height: 100 }, vp);
    expect(p.left).toBe(8);
    expect(p.maxWidth).toBe(384);
  });

  it('stays inside the item card when it fits there, else uses the screen', () => {
    const card = { left: 100, top: 0, right: 400, bottom: 800 };
    const p = placeFloating(box(110, 100), { width: 200, height: 100 }, vp, { rtl: true, boundary: card });
    expect(p.left).toBeGreaterThanOrEqual(104);
    const wide = placeFloating(box(110, 100), { width: 340, height: 100 }, vp, { rtl: true, boundary: card });
    expect(wide.left).toBeGreaterThanOrEqual(8);
    expect(wide.left + 340).toBeLessThanOrEqual(392);
  });

  it('a point (a right click) opens toward the inline-start, the other way when short of room', () => {
    const rtl = placeFloating(box(300, 100, 0, 0), { width: 230, height: 100 }, vp, { rtl: true, gap: 0 });
    expect(rtl.left).toBe(70);
    const flipped = placeFloating(box(100, 100, 0, 0), { width: 230, height: 100 }, vp, { rtl: true, gap: 0 });
    expect(flipped.left).toBe(100);
  });
});
