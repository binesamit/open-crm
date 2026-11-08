// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  cleanAccountNav,
  cleanNavPlacement,
  NAV_PRESET_SIDE,
  NAV_PRESET_TOP,
  NAV_SLOTS,
  navPresetOf,
  resolveNavLayout,
} from '../src';

/** where the shell's places sit — mine → the account's default → the sidebar. */
describe('nav layout', () => {
  const none = { placement: {}, locked: false };

  it('defaults to everything in the sidebar', () => {
    expect(resolveNavLayout(null, none)).toEqual(NAV_PRESET_SIDE);
    expect(navPresetOf(resolveNavLayout(null, none))).toBe('side');
  });

  it("follows the account's default for whatever I did not choose", () => {
    const account = { placement: { home: 'top', search: 'top' } as const, locked: false };
    const l = resolveNavLayout(null, account);
    expect(l.home).toBe('top');
    expect(l.search).toBe('top');
    expect(l.bell).toBe('side');
    expect(resolveNavLayout({ home: 'side' }, account)).toMatchObject({ home: 'side', search: 'top', bell: 'side' });
  });

  it('a locked account layout wins over mine', () => {
    const account = { placement: { bell: 'top' } as const, locked: true };
    expect(resolveNavLayout({ bell: 'side', home: 'top' }, account)).toMatchObject({ bell: 'top', home: 'side' });
  });

  it('names the presets', () => {
    expect(navPresetOf(NAV_PRESET_TOP)).toBe('top');
    expect(navPresetOf({ ...NAV_PRESET_SIDE, inbox: 'top' })).toBe('custom');
    expect(NAV_SLOTS.every((s) => NAV_PRESET_TOP[s] === 'top')).toBe(true);
  });

  it('hides any place but the account (its mark is the way home)', () => {
    expect(cleanNavPlacement({ automations: 'hidden', flows: 'hidden', account: 'hidden' })).toEqual({
      automations: 'hidden',
      flows: 'hidden',
    });
    const l = resolveNavLayout({ flows: 'hidden' }, { placement: { automations: 'hidden' }, locked: false });
    expect(l).toMatchObject({ flows: 'hidden', automations: 'hidden', account: 'side' });
    expect(navPresetOf(l)).toBe('custom');
  });

  it('cleans stored values: unknown places and slots are dropped', () => {
    expect(cleanNavPlacement({ home: 'top', bell: 'left', tree: 'top', profile: 'top' })).toEqual({ home: 'top' });
    expect(cleanNavPlacement('top')).toEqual({});
    expect(cleanAccountNav({ placement: { search: 'top' }, locked: 'yes' })).toEqual({
      placement: { search: 'top' },
      locked: false,
    });
    expect(cleanAccountNav(undefined)).toEqual(none);
  });
});
