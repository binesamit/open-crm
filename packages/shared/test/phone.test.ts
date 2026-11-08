// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  accountSettingsSchema,
  columnTypes,
  normalizePhone,
  parseCellValue,
  phoneActionLink,
  phoneColumnConfig,
  phoneColumnSettingsSchema,
  phoneDefaultAction,
  phoneInfoOf,
  phoneMenuActions,
  resolvePhoneClick,
  sendItemSmsSchema,
  smsSegments,
  telegramUsername,
  validateRecipe,
} from '../src';

describe('normalizePhone', () => {
  it('reads local numbers with the first known country and international ones on their own', () => {
    expect(normalizePhone('050-123 4567', 'IL')).toEqual({ e164: '+972501234567', valid: true, country: 'IL' });
    expect(normalizePhone('+1 (212) 555-0100', 'IL')).toMatchObject({ e164: '+12125550100', valid: true });
    expect(normalizePhone('00972501234567', null, 'US')).toMatchObject({ e164: '+972501234567', valid: true });
    expect(normalizePhone('03-6123456', undefined, 'IL')).toMatchObject({ e164: '+97236123456', valid: true });
    expect(normalizePhone('(212) 555-0100', 'XX', 'US')).toMatchObject({ e164: '+12125550100' });
  });
  it('never guesses: extensions, star numbers and missing digits are not valid', () => {
    expect(normalizePhone('*2700', 'IL')).toEqual({ e164: null, valid: false, country: null });
    expect(normalizePhone('#31#', 'IL').valid).toBe(false);
    expect(normalizePhone('050-123', 'IL').valid).toBe(false);
    expect(normalizePhone('0501234567').valid).toBe(false); // no country at all
  });
});

describe('phone column', () => {
  const def = columnTypes.get('phone')!;
  it('normalize derives e164 + valid; the display text is what was typed', () => {
    const out = parseCellValue(def, { default_country: 'IL' }, { phone: '054-765 4321', e164: '+1555', valid: true });
    expect(out).toMatchObject({
      ok: true,
      value: { phone: '054-765 4321', e164: '+972547654321', valid: true },
      derived: { textValue: '054-765 4321' },
    });
  });
  it('falls back to the account country (ctx) when the column has none', () => {
    const out = parseCellValue(def, {}, { phone: '(212) 555-0100' }, { country: 'US' });
    expect(out.ok && out.value).toMatchObject({ e164: '+12125550100', valid: true });
  });
  it('settings: defaults filled, validation of the action subset', () => {
    expect(phoneColumnConfig({})).toEqual({
      enabled: true,
      actions: ['whatsapp', 'telegram', 'call', 'sms', 'copy'],
      defaultAction: 'whatsapp',
      defaultCountry: null,
      telegramUsernameColumn: null,
    });
    expect(
      phoneColumnConfig({ actions: ['copy', 'call'], default_action: 'sms', click_actions_enabled: false }),
    ).toEqual(expect.objectContaining({ enabled: false, actions: ['copy', 'call'], defaultAction: 'copy' }));
    expect(phoneColumnSettingsSchema.safeParse({ actions: ['call'], default_action: 'sms' }).success).toBe(false);
    expect(phoneColumnSettingsSchema.safeParse({ actions: ['call', 'call'] }).success).toBe(false);
    expect(phoneColumnSettingsSchema.safeParse({ actions: [] }).success).toBe(false);
    expect(phoneColumnSettingsSchema.safeParse({ default_country: 'ZZ' }).success).toBe(false);
    expect(phoneColumnSettingsSchema.parse({ default_country: 'us' }).default_country).toBe('US');
  });
  it('phoneInfoOf uses stored keys, else computes for legacy cells', () => {
    expect(phoneInfoOf({ phone: 'x', e164: '+972501234567', valid: true })).toMatchObject({ valid: true });
    expect(phoneInfoOf({ phone: '0501234567' }, 'IL')).toMatchObject({ e164: '+972501234567', valid: true });
    expect(phoneInfoOf({ phone: '0501234567' }, null, 'IL')).toMatchObject({ valid: true });
    expect(phoneInfoOf(null)).toEqual({ e164: null, valid: false, country: null });
  });
});

describe('phoneActionLink', () => {
  const p = { phone: '050-123 4567', e164: '+972501234567' };
  it('builds the link of every action', () => {
    expect(phoneActionLink('whatsapp', p)).toBe('https://wa.me/972501234567');
    expect(phoneActionLink('whatsapp', p, { whatsapp: 'app', text: 'שלום' })).toBe(
      `whatsapp://send?phone=972501234567&text=${encodeURIComponent('שלום')}`,
    );
    expect(phoneActionLink('whatsapp', p, { whatsapp: 'web' })).toBe(
      'https://web.whatsapp.com/send?phone=972501234567',
    );
    expect(phoneActionLink('telegram', p)).toBe('https://t.me/+972501234567');
    expect(phoneActionLink('telegram', p, { telegramUsername: '@dana_k' })).toBe('https://t.me/dana_k');
    expect(phoneActionLink('call', p)).toBe('tel:+972501234567');
    expect(phoneActionLink('sms', p)).toBe('sms:+972501234567');
    expect(phoneActionLink('sms', p, { text: 'a b', platform: 'ios' })).toBe('sms:+972501234567&body=a%20b');
    expect(phoneActionLink('sms', p, { text: 'a b', platform: 'android' })).toBe('sms:+972501234567?body=a%20b');
    expect(phoneActionLink('copy', p)).toBeNull();
  });
  it('a number that is not valid only dials as typed', () => {
    const bad = { phone: '*2700', e164: null };
    expect(phoneActionLink('call', bad)).toBe('tel:*2700');
    expect(phoneActionLink('call', { phone: '#31#', e164: null })).toBe('tel:%2331%23');
    expect(phoneActionLink('whatsapp', bad)).toBeNull();
    expect(phoneActionLink('sms', bad)).toBeNull();
    expect(phoneActionLink('telegram', bad)).toBeNull();
    expect(phoneActionLink('telegram', bad, { telegramUsername: 'https://t.me/dana_k' })).toBe('https://t.me/dana_k');
  });
  it('telegramUsername reads the usual forms', () => {
    expect(telegramUsername('@dana_k')).toBe('dana_k');
    expect(telegramUsername('t.me/dana_k')).toBe('dana_k');
    expect(telegramUsername('a b')).toBeNull();
    expect(telegramUsername('')).toBeNull();
  });
});

describe('menu and click', () => {
  it('menu actions follow the column, validity, SMS rights and telegram username', () => {
    expect(phoneMenuActions({}, { valid: true })).toEqual(['whatsapp', 'telegram', 'call', 'sms', 'copy']);
    expect(phoneMenuActions({}, { valid: false })).toEqual(['call', 'copy']);
    expect(phoneMenuActions({}, { valid: false }, { telegramUsername: 'dana_k' })).toEqual([
      'telegram',
      'call',
      'copy',
    ]);
    expect(phoneMenuActions({}, { valid: true }, { smsFromSystem: false })).not.toContain('sms');
    expect(phoneMenuActions({}, { valid: true }, { smsFromSystem: false, deviceSms: true })).toContain('sms');
    expect(phoneMenuActions({ click_actions_enabled: false }, { valid: true })).toEqual([]);
    expect(phoneMenuActions({ actions: ['call', 'whatsapp'] }, { valid: true })).toEqual(['call', 'whatsapp']);
  });
  it('resolvePhoneClick / phoneDefaultAction', () => {
    const all = ['whatsapp', 'call', 'copy'] as const;
    expect(resolvePhoneClick(null, {}, [...all])).toBe('menu');
    expect(resolvePhoneClick({ click: 'call' }, {}, [...all])).toBe('call');
    expect(resolvePhoneClick({ click: 'sms' }, {}, [...all])).toBe('menu');
    expect(resolvePhoneClick({ click: 'column_default' }, { default_action: 'copy' }, [...all])).toBe('copy');
    expect(resolvePhoneClick({ click: 'menu' }, {}, ['call'])).toBe('call');
    expect(resolvePhoneClick({ click: 'menu' }, {}, [])).toBe('none');
    expect(phoneDefaultAction({}, [...all])).toBe('whatsapp');
    expect(phoneDefaultAction({}, ['call', 'copy'])).toBe('call');
    expect(phoneDefaultAction({}, [])).toBeNull();
  });
});

describe('SMS shapes', () => {
  it('smsSegments: GSM 160/153, UCS-2 70/67', () => {
    expect(smsSegments('')).toBe(0);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('ש'.repeat(70))).toBe(1);
    expect(smsSegments('ש'.repeat(71))).toBe(2);
    expect(smsSegments('€'.repeat(80))).toBe(1);
  });
  it('sendItemSmsSchema: a template or a text, not both', () => {
    expect(sendItemSmsSchema.safeParse({ column_id: 'phone', text: 'x' }).success).toBe(true);
    expect(sendItemSmsSchema.safeParse({ column_id: 'phone', template_id: 't' }).success).toBe(true);
    expect(sendItemSmsSchema.safeParse({ column_id: 'phone' }).success).toBe(false);
    expect(sendItemSmsSchema.safeParse({ column_id: 'phone', text: 'x', template_id: 't' }).success).toBe(false);
  });
  it('account settings: SMS defaults and the account country', () => {
    const s = accountSettingsSchema.parse({});
    expect(s.sms).toEqual({
      send_policy: 'members',
      templates: [],
      limits: { per_user_per_hour: 30, per_account_per_day: 500 },
    });
    expect(s.locale.country).toBe('IL');
    // An account saved before keeps its sender id and gets the defaults.
    expect(accountSettingsSchema.parse({ sms: { sender_id: 'Acme' } }).sms.sender_id).toBe('Acme');
  });
  it('send_sms recipes: a phone column and a template or message', () => {
    const board = { columns: [{ key: 'tel', type: 'phone', title: 'T', settings: {} }], groups: [] };
    const recipe = (a: Record<string, unknown>) =>
      validateRecipe({ trigger: { type: 'item_created' }, actions: [{ type: 'send_sms', ...a }] } as never, board);
    expect(recipe({ column: 'tel', message: 'hi {item.name}' }).errors).toEqual([]);
    expect(recipe({ column: 'tel' }).errors.map((e) => e.code)).toEqual(['required']);
  });
});
