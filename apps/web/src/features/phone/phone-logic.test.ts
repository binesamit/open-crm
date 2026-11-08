// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ApiError } from '@bines/sdk';
import {
  buildPhoneSettings,
  cellPhone,
  clickTarget,
  detectPlatform,
  moveAction,
  planPhoneAction,
  smsErrorKey,
  telegramColumnCandidates,
} from './phone-logic';
import { nextTemplateId, parseSmsLimit } from './sms-admin-logic';

const desktop = { platform: 'other' as const, mobile: false };
const android = { platform: 'android' as const, mobile: true };
const ios = { platform: 'ios' as const, mobile: true };
const valid = { phone: '050-123-4567', e164: '+972501234567', valid: true };
const sms = { can_send: true, account_country: 'IL' };

describe('detectPlatform', () => {
  it('reads iOS (also iPadOS posing as a Mac with touch), Android and the rest', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', true)).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('other');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other');
  });
});

describe('cellPhone', () => {
  it('offers the column actions for a valid number', () => {
    const c = cellPhone({ settings: {}, value: valid, sms, device: desktop });
    expect(c.actions).toEqual(['whatsapp', 'telegram', 'call', 'sms', 'copy']);
    expect(c.info.e164).toBe('+972501234567');
  });
  it('a number that is not valid gets only call and copy', () => {
    const c = cellPhone({ settings: {}, value: { phone: '*2700' }, sms, device: desktop });
    expect(c.actions).toEqual(['call', 'copy']);
  });
  it('the switch off = no actions (the plain link of before)', () => {
    const c = cellPhone({ settings: { click_actions_enabled: false }, value: valid, sms, device: desktop });
    expect(c.actions).toEqual([]);
    expect(c.enabled).toBe(false);
  });
  it('hides SMS when the system may not send, unless the device has its own SMS app', () => {
    const no = { can_send: false, account_country: 'IL' };
    expect(cellPhone({ settings: {}, value: valid, sms: no, device: desktop }).actions).not.toContain('sms');
    expect(cellPhone({ settings: {}, value: valid, sms: no, device: android }).actions).toContain('sms');
    expect(cellPhone({ settings: {}, value: valid, sms: null, device: desktop }).actions).not.toContain('sms');
  });
  it('a legacy cell (no e164 yet) is read with the column country', () => {
    const c = cellPhone({ settings: { default_country: 'IL' }, value: { phone: '0501234567' }, sms, device: desktop });
    expect(c.info.valid).toBe(true);
    expect(c.info.e164).toBe('+972501234567');
  });
  it('telegram stays for an invalid number when the row has a username', () => {
    const c = cellPhone({ settings: {}, value: { phone: '12' }, sms, device: desktop, telegramRaw: '@dana_l' });
    expect(c.actions).toEqual(['telegram', 'call', 'copy']);
  });
  it('an empty cell offers nothing', () => {
    expect(cellPhone({ settings: {}, value: null, sms, device: desktop }).actions).toEqual([]);
  });
});

describe('clickTarget', () => {
  const all = ['whatsapp', 'telegram', 'call', 'sms', 'copy'] as const;
  it('a plain click follows the preference (menu by default)', () => {
    expect(clickTarget('click', undefined, {}, [...all])).toBe('menu');
    expect(clickTarget('click', { click: 'call' }, {}, [...all])).toBe('call');
    expect(clickTarget('click', { click: 'column_default' }, { default_action: 'sms' }, [...all])).toBe('sms');
  });
  it('Ctrl+click / long press = the column default', () => {
    expect(clickTarget('default', { click: 'menu' }, { default_action: 'call' }, [...all])).toBe('call');
    // Not offered (invalid number) → the first one there is.
    expect(clickTarget('default', null, { default_action: 'whatsapp' }, ['call', 'copy'])).toBe('call');
    expect(clickTarget('default', null, {}, [])).toBe('none');
  });
});

describe('planPhoneAction', () => {
  const cell = { phone: valid.phone, info: { e164: valid.e164, valid: true, country: 'IL' } };
  it('WhatsApp: wa.me on a phone, the desktop preference on a computer', () => {
    expect(
      planPhoneAction('whatsapp', cell, { device: android, smsFromSystem: true, prefs: { whatsapp_desktop: 'web' } }),
    ).toEqual({ kind: 'open', href: 'https://wa.me/972501234567', newTab: true });
    expect(
      planPhoneAction('whatsapp', cell, { device: desktop, smsFromSystem: true, prefs: { whatsapp_desktop: 'web' } }),
    ).toEqual({ kind: 'open', href: 'https://web.whatsapp.com/send?phone=972501234567', newTab: true });
    expect(
      planPhoneAction('whatsapp', cell, { device: desktop, smsFromSystem: true, prefs: { whatsapp_desktop: 'app' } }),
    ).toEqual({ kind: 'open', href: 'whatsapp://send?phone=972501234567', newTab: false });
  });
  it('Telegram by username when the row has one, else by number', () => {
    expect(
      planPhoneAction('telegram', cell, { device: desktop, smsFromSystem: true, telegramRaw: 't.me/dana_l' }),
    ).toEqual({ kind: 'open', href: 'https://t.me/dana_l', newTab: true });
    expect(planPhoneAction('telegram', cell, { device: desktop, smsFromSystem: true })).toEqual({
      kind: 'open',
      href: 'https://t.me/+972501234567',
      newTab: true,
    });
  });
  it('call: tel: on a phone, the number panel on a computer', () => {
    expect(planPhoneAction('call', cell, { device: ios, smsFromSystem: true })).toEqual({
      kind: 'open',
      href: 'tel:+972501234567',
      newTab: false,
    });
    expect(planPhoneAction('call', cell, { device: desktop, smsFromSystem: true })).toEqual({
      kind: 'call-panel',
      href: 'tel:+972501234567',
      text: '050-123-4567',
    });
  });
  it('copy puts the number as typed', () => {
    expect(planPhoneAction('copy', cell, { device: desktop, smsFromSystem: false })).toEqual({
      kind: 'copy',
      text: '050-123-4567',
    });
  });
  it('SMS: the dialog on a computer; on a phone per the preference', () => {
    expect(planPhoneAction('sms', cell, { device: desktop, smsFromSystem: true })).toEqual({
      kind: 'sms-dialog',
      device: null,
    });
    expect(
      planPhoneAction('sms', cell, { device: android, smsFromSystem: true, prefs: { sms_mobile: 'ask' } }),
    ).toEqual({ kind: 'sms-dialog', device: 'sms:+972501234567' });
    expect(
      planPhoneAction('sms', cell, { device: android, smsFromSystem: true, prefs: { sms_mobile: 'system' } }),
    ).toEqual({ kind: 'sms-dialog', device: null });
    expect(
      planPhoneAction('sms', cell, { device: android, smsFromSystem: true, prefs: { sms_mobile: 'device' } }),
    ).toEqual({ kind: 'open', href: 'sms:+972501234567', newTab: false });
    // The system may not send: a phone still has its own app; a computer has nothing.
    expect(planPhoneAction('sms', cell, { device: android, smsFromSystem: false })).toEqual({
      kind: 'open',
      href: 'sms:+972501234567',
      newTab: false,
    });
    expect(planPhoneAction('sms', cell, { device: desktop, smsFromSystem: false })).toEqual({ kind: 'none' });
  });
});

describe('smsErrorKey', () => {
  const err = (status: number, code: string, message = '', details?: Record<string, unknown>) =>
    new ApiError(status, { code: code as never, message, details, request_id: 'r' });
  it('maps the codes of POST /items/{id}/sms', () => {
    expect(smsErrorKey(err(403, 'forbidden', 'sms_off_for_column'))).toBe('phone.sms.error.offForColumn');
    expect(smsErrorKey(err(403, 'forbidden', 'sms_admins_only', { reason: 'admins_only' }))).toBe(
      'phone.sms.error.denied.admins_only',
    );
    expect(smsErrorKey(err(422, 'sms_unsupported_number', 'x', { reason: 'unsupported_destination' }))).toBe(
      'phone.sms.error.destination',
    );
    expect(smsErrorKey(err(422, 'sms_unsupported_number', 'x', { reason: 'invalid' }))).toBe('phone.sms.error.invalid');
    expect(smsErrorKey(err(429, 'rate_limited', 'x', { reason: 'sms_account_limit' }))).toBe(
      'phone.sms.error.accountLimit',
    );
    expect(smsErrorKey(err(429, 'rate_limited', 'x', { reason: 'sms_user_limit' }))).toBe('phone.sms.error.userLimit');
    expect(smsErrorKey(err(503, 'sms_not_configured'))).toBe('phone.sms.error.notConfigured');
    expect(smsErrorKey(err(502, 'external_error'))).toBe('phone.sms.error.provider');
    expect(smsErrorKey(err(400, 'validation_failed', 'sms_too_long'))).toBe('phone.sms.error.tooLong');
    expect(smsErrorKey(err(404, 'not_found'))).toBeNull();
    expect(smsErrorKey(new Error('x'))).toBeNull();
  });
});

describe('column settings form', () => {
  it('builds the whole settings object (replaced on save)', () => {
    expect(
      buildPhoneSettings(
        { default_country: 'IL', other: 1 },
        {
          enabled: false,
          actions: ['call', 'copy'],
          defaultAction: 'whatsapp',
          defaultCountry: null,
          telegramColumn: 'tg',
        },
      ),
    ).toEqual({
      other: 1,
      click_actions_enabled: false,
      actions: ['call', 'copy'],
      default_action: 'call',
      telegram_username_column: 'tg',
    });
    expect(
      buildPhoneSettings(
        {},
        { enabled: true, actions: [], defaultAction: 'sms', defaultCountry: 'US', telegramColumn: null },
      ),
    ).toMatchObject({ actions: ['call', 'copy'], default_action: 'call', default_country: 'US' });
  });
  it('moves an action up / down', () => {
    expect(moveAction(['whatsapp', 'call', 'copy'], 'call', -1)).toEqual(['call', 'whatsapp', 'copy']);
    expect(moveAction(['whatsapp', 'call', 'copy'], 'copy', 1)).toEqual(['whatsapp', 'call', 'copy']);
  });
  it('only text columns hold a Telegram username', () => {
    expect(
      telegramColumnCandidates([
        { id: 'a', type: 'text' },
        { id: 'b', type: 'phone' },
      ]).map((c) => c.id),
    ).toEqual(['a']);
  });
});

describe('admin SMS helpers', () => {
  it('parses a budget', () => {
    expect(parseSmsLimit('30', 100)).toBe(30);
    expect(parseSmsLimit(' 0 ', 100)).toBeNull();
    expect(parseSmsLimit('101', 100)).toBeNull();
    expect(parseSmsLimit('2.5', 100)).toBeNull();
  });
  it('a new template id is never one in use', () => {
    expect(nextTemplateId([])).toBe('tpl_1');
    expect(nextTemplateId(['tpl_2', 'x'])).toBe('tpl_3');
    expect(nextTemplateId(['tpl_2'])).toBe('tpl_3');
    expect(nextTemplateId(['tpl_1', 'tpl_3', 'tpl_2'])).toBe('tpl_4');
  });
});
