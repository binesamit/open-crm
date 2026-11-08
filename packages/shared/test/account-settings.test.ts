// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  accountSettingsSchema,
  announcementActive,
  currencySymbol,
  nextGroupColor,
  patchOf,
  statusLabelsFromDefaults,
  updateAccountSchema,
} from '../src';

/** Account admin A3: account settings — defaults for new boards / groups / columns and the announcement. */
describe('account settings', () => {
  it('fills defaults for an old settings row and keeps unknown keys', () => {
    const s = accountSettingsSchema.parse({ default_transfer_user_id: 'u1' });
    expect(s.defaults.item_terminology).toBe('item');
    expect(s.defaults.group_colors).toEqual([]);
    expect(s.defaults.status_labels.map((l) => l.label)).toEqual(['בתהליך', 'הושלם', 'חסום']);
    expect(s.defaults.status_labels.map((l) => l.color)).toEqual(['yellow', 'forest', 'crimson']);
    expect(s.announcement).toBeNull();
    expect((s as Record<string, unknown>).default_transfer_user_id).toBe('u1');
  });

  it('patchOf drops defaults so fields that were not sent stay missing', () => {
    const o = z.object({ a: z.string().default('x'), b: z.number().default(1) });
    expect(patchOf(o).parse({ b: 2 })).toEqual({ b: 2 });
    const body = updateAccountSchema.parse({ settings: { locale: { weekend: 'sat_sun' } } });
    expect(body.settings!.locale).toEqual({ weekend: 'sat_sun' });
    expect(updateAccountSchema.parse({ settings: { locale: { currency: 'usd' } } }).settings!.locale).toEqual({
      currency: 'USD',
    });
  });

  it('status labels for a new column: ids and order 0…n', () => {
    expect(
      statusLabelsFromDefaults([
        { label: 'פתוח', color: 'blue' },
        { label: 'סגור', color: 'forest', is_done: true },
      ]),
    ).toEqual([
      { id: 0, label: 'פתוח', color: 'blue', index: 0 },
      { id: 1, label: 'סגור', color: 'forest', index: 1, is_done: true },
    ]);
  });

  it('the next group colour: the account order, then the palette, unused first', () => {
    // D-PAL: our order, the brand's green and amber first.
    expect(nextGroupColor([])).toBe('forest');
    expect(nextGroupColor(['forest'])).toBe('yellow');
    expect(nextGroupColor([], ['purple', 'navy'])).toBe('purple');
    expect(nextGroupColor(['purple'], ['purple', 'navy'])).toBe('navy');
    expect(nextGroupColor(['purple', 'navy'], ['purple', 'navy'])).toBe('forest');
  });

  it('currency symbols and the announcement end date (inclusive)', () => {
    expect(currencySymbol('ILS')).toBe('₪');
    expect(currencySymbol('USD')).toBe('$');
    const a = { id: '1', text: 'x', until: '2026-10-04', updated_at: '' };
    expect(announcementActive(a, '2026-10-04')).toBe(true);
    expect(announcementActive(a, '2026-10-05')).toBe(false);
    expect(announcementActive({ ...a, until: undefined }, '2099-01-01')).toBe(true);
    expect(announcementActive(null, '2026-10-04')).toBe(false);
  });
});
