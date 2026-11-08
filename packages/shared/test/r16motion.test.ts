// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  appearanceResponseSchema,
  cleanAppearance,
  cleanMotion,
  MOTION_PREFS,
  resolveMotion,
  setAppearanceSchema,
} from '../src';

describe('r16motion — the animations setting', () => {
  it('"by device" follows prefers-reduced-motion; an explicit choice wins over the device', () => {
    expect(resolveMotion('system', false)).toBe('full');
    expect(resolveMotion('system', true)).toBe('reduced');
    expect(resolveMotion(undefined, false)).toBe('full');
    expect(resolveMotion(null, true)).toBe('reduced');
    expect(resolveMotion('full', true)).toBe('full');
    expect(resolveMotion('reduced', false)).toBe('reduced');
    expect(resolveMotion('off', false)).toBe('off');
    expect(resolveMotion('off', true)).toBe('off');
  });

  it('keeps only known values from stored JSON', () => {
    expect(MOTION_PREFS).toEqual(['system', 'full', 'reduced', 'off']);
    expect(cleanMotion('off')).toBe('off');
    expect(cleanMotion('bouncy')).toBeUndefined();
    expect(cleanMotion(1)).toBeUndefined();
    expect(cleanAppearance({ motion: 'reduced', text_size: 'large' })).toEqual({
      motion: 'reduced',
      text_size: 'large',
    });
    expect(cleanAppearance({ motion: 'wild' })).toEqual({});
  });

  it('PUT accepts a choice or null; the response defaults to "by device"', () => {
    expect(setAppearanceSchema.parse({ motion: 'off' })).toEqual({ motion: 'off' });
    expect(setAppearanceSchema.parse({ motion: null })).toEqual({ motion: null });
    expect(setAppearanceSchema.safeParse({ motion: 'fast' }).success).toBe(false);
    const r = appearanceResponseSchema.parse({ user: {}, account_default: null });
    expect(r.motion).toBe('system');
  });
});
