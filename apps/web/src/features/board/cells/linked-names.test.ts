// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { linkedNames } from './linked-names';

describe('linked item names ( bug fix b)', () => {
  it('uses names[] aligned with item_ids — a name with ", " stays whole', () => {
    expect(linkedNames(['a', 'b'], ['Smith, John', 'Acme'], 'Smith, John, Acme')).toEqual(['Smith, John', 'Acme']);
  });

  it('falls back to splitting text for old payloads, then to the id', () => {
    expect(linkedNames(['a', 'b'], undefined, 'One, Two')).toEqual(['One', 'Two']);
    expect(linkedNames(['a', 'b'], undefined, null)).toEqual(['a', 'b']);
    expect(linkedNames(['a', 'b'], ['Only'], null)).toEqual(['Only', 'b']);
  });
});
