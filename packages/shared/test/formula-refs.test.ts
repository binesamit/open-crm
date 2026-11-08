// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formulaRefNames, formulaToKeys, formulaToNames, validateFormula } from '../src/formula';

const cols = [
  { id: 'c_price', title: 'Price' },
  { id: 'c_qty', title: 'כמות' },
  { id: 'c_dates', title: 'Timeline' },
  { id: 'c_a', title: 'Owner' },
  { id: 'c_b', title: 'owner ' },
  { id: 'c_brace', title: 'A {b}' },
  { id: 'c_empty', title: '  ' },
];

describe('formula references by name', () => {
  it('shows ids as names and stores names as ids', () => {
    const stored = 'ROUND({c_price} * {c_qty}, 2)';
    const shown = formulaToNames(stored, cols);
    expect(shown).toBe('ROUND({Price} * {כמות}, 2)');
    expect(formulaToKeys(shown, cols)).toBe(stored);
  });

  it('keeps #attr, strings and unknown references as written', () => {
    expect(formulaToNames('{c_dates#end} & "{c_price}"', cols)).toBe('{Timeline#end} & "{c_price}"');
    expect(formulaToKeys('{timeline#end} & "{Price}"', cols)).toBe('{c_dates#end} & "{Price}"');
    expect(formulaToKeys('{Nope} + {c_price}', cols)).toBe('{Nope} + {c_price}');
    expect(validateFormula(formulaToKeys('{Nope}', cols), new Set(cols.map((c) => c.id)))).toMatch(/Nope/);
  });

  it('keeps the id where a name would not lead back to one column', () => {
    const names = formulaRefNames(cols);
    expect(names.get('c_a')).toBe('c_a'); // "Owner" twice (case and spaces ignored)
    expect(names.get('c_b')).toBe('c_b');
    expect(names.get('c_brace')).toBe('c_brace');
    expect(names.get('c_empty')).toBe('c_empty');
    expect(formulaToNames('{c_a}+{c_b}', cols)).toBe('{c_a}+{c_b}');
    expect(formulaToKeys('{c_a}+{c_b}', cols)).toBe('{c_a}+{c_b}');
    // A title that is another column's id stays an id too.
    expect(formulaRefNames([...cols, { id: 'c_x', title: 'c_price' }]).get('c_x')).toBe('c_x');
  });

  it('follows a rename: the stored id shows under the new name', () => {
    const renamed = cols.map((c) => (c.id === 'c_price' ? { ...c, title: 'Cost' } : c));
    expect(formulaToNames('{c_price}*2', renamed)).toBe('{Cost}*2');
  });

  it('leaves an unclosed "{" alone', () => {
    expect(formulaToNames('{c_price} + {', cols)).toBe('{Price} + {');
    expect(formulaToKeys('{Price} + {Pri', cols)).toBe('{c_price} + {Pri');
  });
});
