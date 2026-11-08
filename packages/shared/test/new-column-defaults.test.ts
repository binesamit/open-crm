// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  accountDefaultsOf,
  cellFromText,
  columnTypes,
  DEFAULT_REGION,
  parseCellValue,
  prepareConversion,
  renderTemplate,
  withNewColumnDefaults,
} from '../src';

/** a new numbers column shows a thousands separator — the account's default for new columns. */
const numbers = columnTypes.get('numbers')!;

describe('withNewColumnDefaults', () => {
  it('a new numbers column writes thousands from the account default (on when unknown)', () => {
    expect(withNewColumnDefaults(numbers, undefined, undefined)).toEqual({ footer: 'sum', thousands: true });
    expect(withNewColumnDefaults(numbers, undefined, { number_thousands: true })).toEqual({
      footer: 'sum',
      thousands: true,
    });
    expect(withNewColumnDefaults(numbers, undefined, { number_thousands: false })).toEqual({
      footer: 'sum',
      thousands: false,
    });
  });
  it('settings given win; keys they leave out take the default', () => {
    expect(withNewColumnDefaults(numbers, { thousands: false }, { number_thousands: true })).toEqual({
      thousands: false,
    });
    expect(withNewColumnDefaults(numbers, { unit: { symbol: '₪', direction: 'left' } }, {})).toEqual({
      thousands: true,
      unit: { symbol: '₪', direction: 'left' },
    });
  });
  it('other types are unchanged', () => {
    const text = columnTypes.get('text')!;
    expect(withNewColumnDefaults(text, undefined, { number_thousands: true })).toEqual({});
    expect(withNewColumnDefaults(columnTypes.get('rating')!, undefined, {})).toEqual({ max: 5, symbol: 'stars' });
  });
  it('the account default is on unless saved off', () => {
    expect(accountDefaultsOf({}).number_thousands).toBe(true);
    expect(accountDefaultsOf({ defaults: { number_thousands: false } }).number_thousands).toBe(false);
  });
});

describe('existing columns keep their look', () => {
  it('unset thousands = no separator (reads never fall back to the new-column default)', () => {
    const r = parseCellValue(numbers, { footer: 'sum' }, 1234567);
    expect(r.ok && r.derived.textValue).toBe('1234567');
    const n = parseCellValue(numbers, withNewColumnDefaults(numbers, undefined, {}), 1234567);
    expect(n.ok && n.derived.textValue).toBe('1,234,567');
  });
});

describe('a column converted to numbers', () => {
  it('starts with the account default', () => {
    const on = prepareConversion({ from: { type: 'text', settings: {} }, toType: 'numbers', values: ['1000'] });
    expect(on.to.settings.thousands).toBe(true);
    const off = prepareConversion({
      from: { type: 'text', settings: {} },
      toType: 'numbers',
      values: ['1000'],
      env: { newColumnDefaults: { number_thousands: false } },
    });
    expect(off.to.settings.thousands).toBe(false);
  });
});

describe('automation helpers read a number shown with a separator', () => {
  const lookup = (path: string) => (path === 'item.amount' ? '1,234.5' : undefined);
  it('|number and |currency', () => {
    expect(renderTemplate('{item.amount|number:2}', lookup).text).toBe('1234.50');
    expect(
      renderTemplate('{item.amount|currency}', lookup, {
        region: { ...DEFAULT_REGION, language: 'en', currency: 'USD' },
      }).text,
    ).toBe('$1,234.50');
    // A cell typed as "1,234" still reads as a number (paste / bulk edit).
    expect(cellFromText('numbers', '1,234', {})).toBe(1234);
  });
});
