// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  GROUP_COLOR_KEYS,
  GROUP_COLORS,
  groupColorHex,
  groupColorInputSchema,
  groupColorOf,
  LEGACY_GROUP_COLOR_KEYS,
  normalizeGroupColor,
  PALETTE,
} from '../src';

describe('group colour keys (F9)', () => {
  it('every legacy key maps onto one of our keys, one to one', () => {
    const targets = Object.values(LEGACY_GROUP_COLOR_KEYS);
    for (const k of targets) expect(GROUP_COLOR_KEYS).toContain(k);
    expect(new Set(targets).size).toBe(targets.length);
    for (const old of Object.keys(LEGACY_GROUP_COLOR_KEYS)) expect(GROUP_COLOR_KEYS).not.toContain(old);
    expect(GROUP_COLOR_KEYS).toHaveLength(19 + 28); // 0083 added every palette key
  });

  it('the keys stay; their hex is our palette (D-PAL)', () => {
    expect(GROUP_COLORS.blue).toBe(PALETTE.blue.light);
    expect(GROUP_COLORS.forest).toBe(PALETTE.forest.light);
    expect(GROUP_COLORS.light_gray).toBe(PALETTE.gray.light); // retired → its twin
    expect(GROUP_COLORS.gray).toBe(PALETTE.gray.light);
  });

  it('reads a legacy key as ours, in code and in input schemas', () => {
    expect(normalizeGroupColor('done_green')).toBe('green');
    expect(normalizeGroupColor('green')).toBe('green');
    expect(normalizeGroupColor('toString')).toBe('toString');
    expect(groupColorInputSchema.parse('stuck_red')).toBe('red');
    expect(groupColorInputSchema.parse('navy')).toBe('navy');
    expect(groupColorInputSchema.safeParse('nope').success).toBe(false);
  });

  it('groupColorOf: a key (ours or legacy), else the closest group colour to a hex', () => {
    expect(groupColorOf('egg_yolk')).toBe('yellow');
    expect(groupColorOf('violet')).toBe('violet');
    expect(groupColorOf('#00c875')).toBe('forest');
    expect(groupColorOf('#fdab3e')).toBe('yellow');
  });

  it('renders stored data with a legacy key in the colour of the key it maps to (groupColorHex)', () => {
    for (const [old, ours] of Object.entries(LEGACY_GROUP_COLOR_KEYS))
      expect(groupColorHex(old)).toBe(GROUP_COLORS[ours]);
    for (const k of GROUP_COLOR_KEYS) expect(groupColorHex(k)).toBe(GROUP_COLORS[k]);
    // Unknown / empty → the fallback (the first group colour by default), never undefined.
    expect(groupColorHex('nope')).toBe(GROUP_COLORS.forest);
    expect(groupColorHex(null)).toBe(GROUP_COLORS.forest);
    expect(groupColorHex('nope', null)).toBeNull();
    expect(groupColorHex('toString', null)).toBeNull();
  });
});
