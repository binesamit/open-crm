// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { heightAboveKeyboard, keyboardOpen } from './use-keyboard';

/** the phone's keyboard, read from what it does (the browser never says). */
describe('the on-screen keyboard', () => {
  it('open when the visual viewport shrinks under the layout (iOS), or the window shrinks (Android)', () => {
    expect(keyboardOpen({ viewport: 400, layout: 800, tallest: 800 })).toBe(true);
    expect(keyboardOpen({ viewport: 450, layout: 450, tallest: 800 })).toBe(true);
  });

  it('closed otherwise — a browser bar coming and going, or a focused field without a keyboard', () => {
    expect(keyboardOpen({ viewport: 760, layout: 800, tallest: 820 })).toBe(false);
    expect(keyboardOpen({ viewport: 800, layout: 800, tallest: 800 })).toBe(false);
  });

  it('a frame ends above the keyboard; without one it is left alone', () => {
    expect(heightAboveKeyboard({ viewport: 400, offsetTop: 0, layout: 800, top: 100 })).toBe(300);
    // iOS scrolled the visual viewport down: its visible bottom is offsetTop + height.
    expect(heightAboveKeyboard({ viewport: 400, offsetTop: 50, layout: 800, top: 100 })).toBe(350);
    expect(heightAboveKeyboard({ viewport: 790, offsetTop: 0, layout: 800, top: 100 })).toBeNull();
  });
});
