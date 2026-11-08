// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { acceptsDrop, GROUP_DROP } from './row-dnd';

/** a dragged group lands only on group titles; items and subitems never land there. */
describe('acceptsDrop', () => {
  it('a group lands on group titles only', () => {
    expect(acceptsDrop(`${GROUP_DROP}g1`, { group: true })).toBe(true);
    expect(acceptsDrop('item1', { group: true })).toBe(false);
    expect(acceptsDrop('end:g1', { group: true })).toBe(false);
  });
  it('an item lands anywhere but a group title', () => {
    expect(acceptsDrop(`${GROUP_DROP}g1`, {})).toBe(false);
    expect(acceptsDrop('item1', {})).toBe(true);
    expect(acceptsDrop('subadd:p1', { group: false })).toBe(true);
  });
});
