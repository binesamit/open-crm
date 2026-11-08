// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CSV_BOM, decimalHours, toCsv } from '../src';

describe('toCsv', () => {
  it('quotes what needs quoting, keeps Hebrew, BOM + CRLF', () => {
    const out = toCsv(
      ['שם', 'הערה'],
      [
        ['פגישה', 'א, ב'],
        ['x', 'he said "hi"'],
        [null, 3],
      ],
    );
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(out.slice(1)).toBe('שם,הערה\r\nפגישה,"א, ב"\r\nx,"he said ""hi"""\r\n,3\r\n');
  });
  it('neutralises formulas (CSV injection) but keeps numbers and phone numbers', () => {
    const tab = String.fromCharCode(9);
    const out = toCsv(
      ['a'],
      [
        ['=HYPERLINK("http://x","y")'],
        ['+SUM(1,2)'],
        ['-2+3'],
        ['@cmd'],
        [`${tab}x`],
        ['-5'],
        ['+972 50 1234567'],
        [-7],
      ],
    );
    expect(out.slice(1).split('\r\n').slice(1, -1)).toEqual([
      `"'=HYPERLINK(""http://x"",""y"")"`,
      `"'+SUM(1,2)"`,
      "'-2+3",
      "'@cmd",
      `'${tab}x`,
      '-5',
      '+972 50 1234567',
      '-7',
    ]);
  });
  it('decimal hours', () => {
    expect(decimalHours(5400)).toBe(1.5);
    expect(decimalHours(100)).toBe(0.03);
  });
});
