// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formulaProblem, quotedFormulaRefs, validateFormula } from '../src/formula';

/**
 * a formula's problem as data (the editor says it in Hebrew with the column's name), a column after
 * a complete value or after `NAME()` says what is missing, and `"{Column}"` (text, not the value) is pointed out.
 */
describe('formulaProblem', () => {
  it('a column after a function call: it belongs inside the brackets', () => {
    expect(formulaProblem('CONCATENATE(){פלטפורמה} - {לקוח / פרויקט}')).toEqual({
      code: 'unexpected_column',
      column: 'פלטפורמה',
      afterCall: ')',
    });
  });

  it('two columns without a comma between them', () => {
    expect(formulaProblem('CONCATENATE({a} {b})')).toEqual({ code: 'missing_paren_after', token: 'CONCATENATE' });
    expect(formulaProblem('{a} {b}')).toEqual({ code: 'unexpected_column', column: 'b' });
  });

  it('codes for the other problems; the English messages stay as they were', () => {
    expect(formulaProblem('')).toEqual({ code: 'empty' });
    expect(formulaProblem('"abc')).toEqual({ code: 'unterminated_string' });
    expect(formulaProblem('{a')).toEqual({ code: 'unterminated_ref' });
    expect(formulaProblem('abc')).toEqual({ code: 'unknown_name', token: 'ABC' });
    expect(formulaProblem('NOPE(1)')).toEqual({ code: 'unknown_function', token: 'NOPE' });
    expect(formulaProblem('{x}+1', new Set(['a']))).toEqual({ code: 'unknown_column', column: 'x' });
    expect(formulaProblem('1 +')).toEqual({ code: 'unexpected_end' });
    expect(formulaProblem('1 ; 2')).toEqual({ code: 'unexpected_char', token: ';' });
    expect(validateFormula('{a} {dropdown}')).toBe('Unexpected "dropdown"');
    expect(validateFormula('NOPE(1)')).toBe('Unknown function NOPE');
    expect(formulaProblem('CONCATENATE({פלטפורמה}, " - ", {לקוח / פרויקט})')).toBeNull();
  });
});

describe('quotedFormulaRefs', () => {
  const cols = [
    { id: 'dropdown', title: 'פלטפורמה' },
    { id: 'board_relation', title: 'לקוח / פרויקט' },
  ];
  it('finds the board’s columns written inside quotes (by name or id), once each', () => {
    expect(quotedFormulaRefs('CONCATENATE("{פלטפורמה}", "{לקוח / פרויקט}", "{פלטפורמה}")', cols)).toEqual([
      'פלטפורמה',
      'לקוח / פרויקט',
    ]);
    expect(quotedFormulaRefs('"{dropdown#x}"', cols)).toEqual(['dropdown']);
  });
  it('ignores references outside quotes and braces that are not columns', () => {
    expect(quotedFormulaRefs('CONCATENATE({פלטפורמה}, "{not a column}")', cols)).toEqual([]);
  });
});
