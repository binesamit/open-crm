// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  digestOf,
  formatDigest,
  formatQuiet,
  inQuietHours,
  parseDigest,
  parseQuiet,
  pushAllowed,
  withDefaults,
  type SettingRow,
} from '../src';

/** 08 §12.3: the summary email's schedule and the account defaults under personal choices. */
describe('digest schedule', () => {
  it('round-trips daily / weekly with hour and weekday; old "daily" is 08:00', () => {
    expect(parseDigest('daily')).toEqual({ frequency: 'daily', hour: 8, weekday: 0 });
    expect(parseDigest(formatDigest({ frequency: 'weekly', hour: 17, weekday: 4 }))).toEqual({
      frequency: 'weekly',
      hour: 17,
      weekday: 4,
    });
    expect(parseDigest('daily:99')).toMatchObject({ hour: 8 });
    expect(parseDigest('nonsense').frequency).toBe('instant');
  });
});

describe('withDefaults', () => {
  const defaults = {
    categories: [{ key: 'item_updates' as const, bell: true, email: false }],
    digest: 'weekly' as const,
    digest_hour: 9,
    digest_weekday: 1,
  };
  it('fills what the member has not chosen', () => {
    const rows = withDefaults([], defaults);
    expect(rows).toContainEqual({
      channel: 'email',
      type: 'item_updates',
      board_id: null,
      enabled: false,
      digest: 'instant',
    });
    expect(digestOf(rows)).toEqual({ frequency: 'weekly', hour: 9, weekday: 1 });
  });
  it('a personal row wins', () => {
    const own: SettingRow[] = [
      { channel: 'email', type: 'item_updates', board_id: null, enabled: true, digest: 'instant' },
      { channel: 'email', type: '*', board_id: null, enabled: true, digest: 'instant' },
    ];
    const rows = withDefaults(own, defaults);
    // The phone's defaults (r19pwa) add push rows only.
    expect(rows.filter((r) => r.channel !== 'push')).toEqual(own);
    expect(digestOf(rows).frequency).toBe('instant');
  });
});

describe('the phone channel (r19pwa)', () => {
  it('defaults to assignment and mention only; the account default and my own row win', () => {
    const none = withDefaults([], null);
    expect(pushAllowed(none, 'assigned', [])).toBe(true);
    expect(pushAllowed(none, 'mention', [])).toBe(true);
    expect(pushAllowed(none, 'reply', [])).toBe(false);
    expect(pushAllowed(none, 'automation', [])).toBe(false);
    // The bell and email are untouched by the phone's defaults.
    expect(none.every((r) => r.channel === 'push')).toBe(true);

    const account = withDefaults([], {
      categories: [{ key: 'item_updates', bell: true, email: true, push: true }],
      digest: 'instant',
      digest_hour: 8,
      digest_weekday: 0,
    });
    expect(pushAllowed(account, 'reply', [])).toBe(true);

    const mine = withDefaults(
      [{ channel: 'push', type: 'reminders', board_id: null, enabled: true, digest: 'instant' }],
      null,
    );
    expect(pushAllowed(mine, 'automation', [])).toBe(true);
  });

  it('a board silenced in my bell is silent on the phone', () => {
    const rows = withDefaults(
      [{ channel: 'in_app', type: '*', board_id: 'B1', enabled: false, digest: 'instant' }],
      null,
    );
    expect(pushAllowed(rows, 'mention', ['B1'])).toBe(false);
    expect(pushAllowed(rows, 'mention', ['B2'])).toBe(true);
  });

  it('quiet hours wrap midnight; equal ends never silence', () => {
    const q = parseQuiet(formatQuiet({ enabled: true, from: 22, to: 7 }));
    expect(q).toEqual({ enabled: true, from: 22, to: 7 });
    expect([21, 22, 23, 0, 6, 7].map((h) => inQuietHours(q, h))).toEqual([false, true, true, true, true, false]);
    expect(inQuietHours({ enabled: true, from: 9, to: 17 }, 12)).toBe(true);
    expect(inQuietHours({ enabled: true, from: 9, to: 9 }, 9)).toBe(false);
    expect(parseQuiet('instant').enabled).toBe(false);
    expect(parseQuiet('quiet:99:1').enabled).toBe(false);
  });
});
