// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cleanPhoneInput, columnTypes, parseCellValue, phoneText } from '../src';

/**
 * Prod (product owner: "too many errors in the phone column, however I type it"): any way of writing a number is
 * accepted, cleaned, and read with the account's country; one that is not recognised is kept and marked, not refused.
 */
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const LRI = ch(0x2066);
const PDI = ch(0x2069);
const LRM = ch(0x200e);
const NBSP = ch(0xa0);
const EN_DASH = ch(0x2013);

const def = columnTypes.get('phone')!;
const write = (raw: unknown, settings: unknown = {}, country = 'IL') => parseCellValue(def, settings, raw, { country });

describe('cleanPhoneInput', () => {
  it('drops direction marks, unifies dashes and spaces, Latin digits, no "tel:"', () => {
    expect(cleanPhoneInput(`${LRI}+972 54-123-4567${PDI}`)).toBe('+972 54-123-4567');
    expect(cleanPhoneInput(`${LRM}054${EN_DASH}1234567`)).toBe('054-1234567');
    expect(cleanPhoneInput(`054${NBSP}${NBSP}123  4567 `)).toBe('054 123 4567');
    expect(cleanPhoneInput(`${ch(0x660, 0x665, 0x664)}-1234567`)).toBe('054-1234567');
    expect(cleanPhoneInput('tel:+972541234567')).toBe('+972541234567');
  });
  it('phoneText: any wording; empty or too long is not a phone', () => {
    expect(phoneText('054-1234567 שלוחה 12')).toBe('054-1234567 שלוחה 12');
    expect(phoneText(`${LRI}${PDI} `)).toBeNull();
    expect(phoneText('1'.repeat(200))).toBeNull();
  });
});

describe('writing a phone cell', () => {
  const same = '+972541234567';
  it.each([
    `${LRI}+972 54-123-4567${PDI}`,
    '+972 54-123-4567',
    '054-1234567',
    '0541234567',
    '541234567',
    '(054) 123 4567',
    '00972541234567',
    '972-54-123-4567',
    `054${EN_DASH}123${EN_DASH}4567`,
  ])('%s → the same E.164, kept as written (cleaned)', (raw) => {
    const r = write({ phone: raw });
    expect(r.ok).toBe(true);
    const v = (r as { value: { phone: string; e164?: string; valid: boolean } }).value;
    expect(v.e164).toBe(same);
    expect(v.valid).toBe(true);
    expect(v.phone).toBe(cleanPhoneInput(raw));
  });

  it('a number it cannot read is saved and marked, never refused', () => {
    for (const raw of ['12', 'שלוחה 5', '+1 (555) not a number', '054.547.28']) {
      const r = write({ phone: raw });
      expect(r.ok, raw).toBe(true);
      expect((r as { value: { valid: boolean } }).value.valid).toBe(false);
    }
  });

  it('the country: the cell’s, else the column’s, else the account’s', () => {
    const uk = write({ phone: '07911 123456' }, {}, 'GB') as { value: { e164?: string } };
    expect(uk.value.e164).toBe('+447911123456');
    const col = write({ phone: '07911 123456' }, { default_country: 'GB' }, 'IL') as { value: { e164?: string } };
    expect(col.value.e164).toBe('+447911123456');
  });

  it('text → phone (import, conversion) accepts the same', () => {
    expect(def.fromText!(`${LRI}+972 54-123-4567${PDI}`, {} as never, {} as never)).toEqual({
      phone: '+972 54-123-4567',
    });
    expect(def.fromText!('   ', {} as never, {} as never)).toBeUndefined();
  });
});
