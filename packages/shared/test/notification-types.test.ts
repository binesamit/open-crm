// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_OF,
  channelAllowed,
  NOTIFICATION_TYPE_META,
  NOTIFICATION_TYPES,
  notificationTypeMeta,
  pushAllowed,
  REQUIRED_NOTIFICATION_TYPES,
  type SettingRow,
  withDefaults,
} from '../src';

const off = (channel: SettingRow['channel'], type: string, board_id: string | null = null): SettingRow => ({
  channel,
  type,
  board_id,
  enabled: false,
  digest: 'instant',
});

/** The one table of notification types (08 §12.3): category + required. */
describe('NOTIFICATION_TYPE_META', () => {
  it('lists every type once, and the derived lists agree with it', () => {
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
    for (const t of NOTIFICATION_TYPES) expect(CATEGORY_OF[t] ?? null).toBe(NOTIFICATION_TYPE_META[t].category);
    expect(notificationTypeMeta('nope')).toBeUndefined();
    expect(notificationTypeMeta('toString')).toBeUndefined();
  });

  it('the required types are security, billing and the support tickets (a product decision — 08 §12.3)', () => {
    expect([...REQUIRED_NOTIFICATION_TYPES].sort()).toEqual(
      [
        'ai_budget',
        'extension_update',
        'plan_limit',
        'secret_reveals',
        'ticket_access_request',
        'ticket_reply',
        'ticket_status',
      ].sort(),
    );
    // A type with no switch must be required, or it would never be sent.
    for (const t of NOTIFICATION_TYPES)
      if (NOTIFICATION_TYPE_META[t].category === null) expect(NOTIFICATION_TYPE_META[t].required).toBe(true);
  });
});

describe('channelAllowed with required types', () => {
  const everythingOff: SettingRow[] = [
    off('in_app', '*'),
    off('email', '*'),
    off('push', '*'),
    off('in_app', 'reminders', 'b1'),
    off('in_app', '*', 'b1'),
  ];

  it('a required type reaches the bell and the email whatever the settings say', () => {
    for (const t of REQUIRED_NOTIFICATION_TYPES) {
      expect(channelAllowed(everythingOff, 'in_app', t, ['b1'])).toBe(true);
      expect(channelAllowed(everythingOff, 'email', t, ['b1'])).toBe(true);
    }
  });

  it('the phone keeps its switch; a type with no category never buzzes it', () => {
    expect(pushAllowed(everythingOff, 'secret_reveals', [])).toBe(false);
    const mine: SettingRow[] = [
      { channel: 'push', type: 'reminders', board_id: null, enabled: true, digest: 'instant' },
    ];
    expect(pushAllowed(withDefaults(mine, null), 'secret_reveals', [])).toBe(true);
    expect(pushAllowed(withDefaults(mine, null), 'ticket_reply', [])).toBe(false);
  });

  it('a non-required type follows the settings (account-wide and per board)', () => {
    expect(channelAllowed([], 'in_app', 'flow_failed', [])).toBe(true);
    expect(channelAllowed([off('in_app', 'reminders')], 'in_app', 'flow_failed', [])).toBe(false);
    expect(channelAllowed([off('in_app', 'reminders', 'b1')], 'in_app', 'agent_approval', ['b1'])).toBe(false);
    expect(channelAllowed([off('in_app', 'reminders', 'b1')], 'in_app', 'agent_approval', [])).toBe(true);
    expect(channelAllowed([off('email', '*')], 'email', 'error_alert', [])).toBe(false);
  });
});
