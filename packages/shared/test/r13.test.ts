// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  appearanceSchema,
  changedSettings,
  cleanAppearance,
  defaultViewSettings,
  resolveAppearance,
  scaledRowPx,
  setAppearanceSchema,
  TEXT_SCALE,
  viewSettingsSchema,
} from '../src';

describe('round 13 — appearance (text size + density per user)', () => {
  it('defaults to normal / normal; the user wins over the account default', () => {
    expect(appearanceSchema.parse({})).toEqual({ text_size: 'normal', density: 'normal' });
    expect(resolveAppearance(null)).toEqual({ text_size: 'normal', density: 'normal' });
    expect(resolveAppearance({ text_size: 'large' }, { text_size: 'small', density: 'compact' })).toEqual({
      text_size: 'large',
      density: 'compact',
    });
    expect(resolveAppearance(undefined, { density: 'comfortable' }).density).toBe('comfortable');
  });

  it('drops unknown stored values', () => {
    expect(cleanAppearance({ text_size: 'huge', density: 'normal' })).toEqual({ density: 'normal' });
    expect(cleanAppearance(null)).toEqual({});
    expect(setAppearanceSchema.safeParse({ text_size: 'huge' }).success).toBe(false);
    expect(setAppearanceSchema.parse({ text_size: null })).toEqual({ text_size: null });
  });

  it('scales row heights by text size × density, in whole pixels', () => {
    expect(TEXT_SCALE).toEqual({ small: 0.9, normal: 1, large: 1.12, xlarge: 1.25 });
    expect(scaledRowPx(38, { text_size: 'normal', density: 'normal' })).toBe(38);
    expect(scaledRowPx(38, { text_size: 'xlarge', density: 'normal' })).toBe(48);
    expect(scaledRowPx(38, { text_size: 'normal', density: 'compact' })).toBe(32);
    expect(scaledRowPx(38, { text_size: 'large', density: 'comfortable' })).toBe(51);
    // Headers and other fixed rows follow the text only.
    expect(scaledRowPx(32, { text_size: 'small', density: 'comfortable' }, false)).toBe(29);
  });
});

describe('round 13 — the view hides subitem columns', () => {
  it('keeps subitems_hidden_columns (default empty) and counts it as a change to save', () => {
    expect(defaultViewSettings().subitems_hidden_columns).toEqual([]);
    const s = viewSettingsSchema.parse({ subitems_hidden_columns: ['status', 'date4'] });
    expect(s.subitems_hidden_columns).toEqual(['status', 'date4']);
    expect(changedSettings({}, { subitems_hidden_columns: ['status'] })).toEqual(['subitems_hidden_columns']);
  });
});
