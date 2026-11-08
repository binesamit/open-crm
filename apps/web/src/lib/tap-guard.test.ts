// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { TAP_GUARD_HOLD_MS, TAP_GUARD_MS, tapGuardActive, tapGuardArm, tapGuardLift } from '@bines/ui';

/** r25: the tap that closed a layer on a phone never also opens what lies under it. */
describe('tap guard', () => {
  it('is off until a tap closes a layer', () => {
    expect(tapGuardActive(null, 0)).toBe(false);
  });

  it('swallows the click of the closing tap (it comes right after the finger lifts)', () => {
    const g = tapGuardLift(tapGuardArm(1000), 1080);
    expect(tapGuardActive(g, 1090)).toBe(true);
    expect(tapGuardActive(g, 1080 + TAP_GUARD_MS - 1)).toBe(true);
  });

  it('lets the next tap through (a second tap opens the other cell)', () => {
    const g = tapGuardLift(tapGuardArm(1000), 1080);
    expect(tapGuardActive(g, 1080 + TAP_GUARD_MS)).toBe(false);
    expect(tapGuardActive(g, 2000)).toBe(false);
  });

  it('holds while the finger is down, never longer than the hold limit', () => {
    const g = tapGuardArm(1000);
    expect(tapGuardActive(g, 1000 + TAP_GUARD_HOLD_MS - 1)).toBe(true);
    expect(tapGuardActive(g, 1000 + TAP_GUARD_HOLD_MS)).toBe(false);
  });

  it('counts from the first lift only', () => {
    const g = tapGuardLift(tapGuardLift(tapGuardArm(1000), 1050), 1300);
    expect(g).toEqual({ down: 1000, up: 1050 });
    expect(tapGuardLift(null, 5)).toBeNull();
  });
});
