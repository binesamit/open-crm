// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { NAME_MIN, fullNameWidth, nameWidth, scrollFromStart } from './mobile-name-width';

/** r25: the phone's name column widens toward the start of the sideways scroll. */
describe('scrollFromStart', () => {
  it('reads a left-to-right scroller as is', () => {
    expect(scrollFromStart(0, 500, false)).toBe(0);
    expect(scrollFromStart(120, 500, false)).toBe(120);
    expect(scrollFromStart(-3, 500, false)).toBe(0); // an overscroll bounce
  });

  it('normalizes every right-to-left convention to the distance from the start', () => {
    // Spec (Chrome 85+, Safari, Firefox): 0 at the start, negative toward the end.
    expect(scrollFromStart(0, 500, true, 'negative')).toBe(0);
    expect(scrollFromStart(-120, 500, true, 'negative')).toBe(120);
    // Positive toward the end.
    expect(scrollFromStart(120, 500, true, 'reverse')).toBe(120);
    // Old Chrome: the maximum at the start.
    expect(scrollFromStart(500, 500, true, 'default')).toBe(0);
    expect(scrollFromStart(380, 500, true, 'default')).toBe(120);
  });
});

describe('nameWidth', () => {
  const full = fullNameWidth(390); // an iPhone: ~65% of the screen

  it('is the full width at the start and shrinks 1:1 with the scroll', () => {
    expect(full).toBe(254);
    expect(nameWidth({ fromStart: 0, full })).toBe(full);
    expect(nameWidth({ fromStart: 40, full })).toBe(full - 40);
    expect(nameWidth({ fromStart: 40, full })).toBeLessThan(nameWidth({ fromStart: 0, full }));
  });

  it('never goes under the minimum', () => {
    expect(nameWidth({ fromStart: 5000, full })).toBe(NAME_MIN);
  });

  it('widens again on the way back (the same mapping both ways)', () => {
    const out = [0, 50, 100, 150].map((s) => nameWidth({ fromStart: s, full }));
    const back = [150, 100, 50, 0].map((s) => nameWidth({ fromStart: s, full }));
    expect(back).toEqual([...out].reverse());
  });

  it('shrinks no more than the scroll can still reach (a short table never bounces at the end)', () => {
    // Two columns: 95px of scroll at full width. The name gives up at most half of it, so the scroll end
    // (95 - 47.5) is still reachable with the name at its narrowest for that table.
    const w = nameWidth({ fromStart: 1000, full, overflow: 95 });
    expect(w).toBe(full - 47.5);
    const reach = 95 - (full - w);
    expect(nameWidth({ fromStart: reach, full, overflow: 95 })).toBe(w);
  });

  it('a screen-wide table keeps the full width', () => {
    expect(nameWidth({ fromStart: 30, full, overflow: 0 })).toBe(full);
  });

  it('full width follows the screen, within bounds', () => {
    expect(fullNameWidth(180)).toBe(140);
    expect(fullNameWidth(1000)).toBe(320);
  });
});
