// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { numbersAffixes } from './numbers-affix';

/** r27: a ₪ prefix on a column that already has the ₪ unit shows once, not "₪₪". */
describe('numbersAffixes', () => {
  it('drops a prefix the server text already has (either side, with bidi marks)', () => {
    expect(numbersAffixes('₪1,200', '₪')).toEqual({ prefix: '', suffix: '' });
    expect(numbersAffixes('\u200f1,200\u00a0₪', '₪')).toEqual({ prefix: '', suffix: '' });
    expect(numbersAffixes('45%', undefined, '%')).toEqual({ prefix: '', suffix: '' });
    expect(numbersAffixes('$1.5K', ' $ ')).toEqual({ prefix: '', suffix: '' });
  });

  it('keeps affixes on a plain number or another unit', () => {
    expect(numbersAffixes('1200', '₪', ' לקוחות')).toEqual({ prefix: '₪', suffix: ' לקוחות' });
    expect(numbersAffixes('₪1,200', '$')).toEqual({ prefix: '$', suffix: '' });
    expect(numbersAffixes('₪1,200', undefined, ' / month')).toEqual({ prefix: '', suffix: ' / month' });
  });

  it('a digit affix is never taken for a unit', () => {
    expect(numbersAffixes('₪1,200', '1')).toEqual({ prefix: '1', suffix: '' });
  });
});
