// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cardFieldsPerRowFor, cardFieldsPerRowOf, itemCardSettingsSchema } from '../src';

describe('card fields per row (r15)', () => {
  it('defaults to one per row', () => {
    expect(cardFieldsPerRowOf(undefined)).toBe(1);
    expect(cardFieldsPerRowOf({})).toBe(1);
    expect(cardFieldsPerRowOf({ tabs: [] })).toBe(1);
  });

  it('reads 1 / 2 / 3 / auto and ignores anything else', () => {
    expect(cardFieldsPerRowOf({ fields_per_row: 2 })).toBe(2);
    expect(cardFieldsPerRowOf({ fields_per_row: 3 })).toBe(3);
    expect(cardFieldsPerRowOf({ fields_per_row: 'auto' })).toBe('auto');
    expect(cardFieldsPerRowOf({ fields_per_row: 4 })).toBe(1);
    expect(cardFieldsPerRowOf({ fields_per_row: '2' })).toBe(1);
  });

  it('a subitems board without its own setting follows its parent board', () => {
    expect(cardFieldsPerRowFor({ tabs: [] }, { fields_per_row: 2 })).toBe(2);
    expect(cardFieldsPerRowFor(undefined, { fields_per_row: 'auto' })).toBe('auto');
    expect(cardFieldsPerRowFor({ fields_per_row: 1 }, { fields_per_row: 3 })).toBe(1);
    expect(cardFieldsPerRowFor({ fields_per_row: 3 }, { fields_per_row: 2 })).toBe(3);
    expect(cardFieldsPerRowFor({ tabs: [] }, { tabs: [] })).toBe(1);
    // A main board has no parent: its own setting or 1.
    expect(cardFieldsPerRowFor({ tabs: [] })).toBe(1);
  });

  it('the card settings accept 1 / 2 / 3 / auto only', () => {
    expect(itemCardSettingsSchema.parse({ fields_per_row: 'auto' }).fields_per_row).toBe('auto');
    expect(itemCardSettingsSchema.parse({ tabs: [] }).fields_per_row).toBeUndefined();
    expect(itemCardSettingsSchema.safeParse({ fields_per_row: 7 }).success).toBe(false);
  });
});
