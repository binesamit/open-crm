// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { KEYBOARD_SETTLE_MS, menuClosesOn } from '@bines/ui';

/** r19small: the on-screen keyboard must not close a menu opened in the phone's filter sheet. */
const base = { sinceOpenMs: 5000, sinceViewportMs: Infinity, typing: false, touch: false };

describe('menuClosesOn', () => {
  it('a resize closes only when the width changed (the keyboard changes the height only)', () => {
    expect(menuClosesOn({ ...base, kind: 'resize', widthChanged: false, touch: true, typing: true })).toBe(false);
    expect(menuClosesOn({ ...base, kind: 'resize', widthChanged: true })).toBe(true);
  });
  it('a page scroll while the keyboard moves the viewport, or while typing on a touch screen, keeps it', () => {
    expect(menuClosesOn({ ...base, kind: 'scroll', sinceViewportMs: KEYBOARD_SETTLE_MS - 1 })).toBe(false);
    expect(menuClosesOn({ ...base, kind: 'scroll', touch: true, typing: true })).toBe(false);
  });
  it('a scroll inside it, or right after it opened, keeps it', () => {
    expect(menuClosesOn({ ...base, kind: 'scroll', inside: true })).toBe(false);
    expect(menuClosesOn({ ...base, kind: 'scroll', sinceOpenMs: 50 })).toBe(false);
  });
  it('a page scroll otherwise closes it (desktop: a wheel scroll even with its search focused)', () => {
    expect(menuClosesOn({ ...base, kind: 'scroll' })).toBe(true);
    expect(menuClosesOn({ ...base, kind: 'scroll', typing: true })).toBe(true);
    expect(menuClosesOn({ ...base, kind: 'scroll', touch: true })).toBe(true);
  });
});
