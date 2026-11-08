// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { filterTokenOptions, insertToken, tokenQuery, type TokenOption } from './formula-tokens';

const options: TokenOption[] = [
  { kind: 'column', key: 'status', title: 'Status' },
  { kind: 'column', key: 'numbers_1', title: 'Price' },
  { kind: 'column', key: 'date_4', title: 'Due date' },
  { kind: 'function', name: 'SUM', he: 'סכום' },
  { kind: 'function', name: 'DAYS', he: 'ימים' },
];

describe('formula "{" list', () => {
  it('finds the open "{" before the caret and what was typed after it', () => {
    expect(tokenQuery('{', 1)).toEqual({ start: 0, query: '' });
    expect(tokenQuery('1 + {pri', 8)).toEqual({ start: 4, query: 'pri' });
    expect(tokenQuery('{a} + 2', 7)).toBeNull(); // closed
    expect(tokenQuery('{a\n', 3)).toBeNull(); // the line moved on
    expect(tokenQuery('no brace', 8)).toBeNull();
  });

  it('filters live: columns first, start-of-word before inside, functions after columns', () => {
    expect(filterTokenOptions(options, '').map((o) => (o.kind === 'column' ? o.key : o.name))).toEqual([
      'status',
      'numbers_1',
      'date_4',
      'SUM',
      'DAYS',
    ]);
    expect(filterTokenOptions(options, 'da').map((o) => (o.kind === 'column' ? o.key : o.name))).toEqual([
      'date_4',
      'DAYS',
    ]);
    // By key too, and by the Hebrew name of a function.
    expect(filterTokenOptions(options, 'numbers').map((o) => o.kind === 'column' && o.key)).toEqual(['numbers_1']);
    expect(filterTokenOptions(options, 'סכו').map((o) => o.kind === 'function' && o.name)).toEqual(['SUM']);
    expect(filterTokenOptions(options, 'zzz')).toEqual([]);
  });

  it('inserts {key} for a column in place of the typed "{query" and puts the caret after it', () => {
    expect(insertToken('1 + {pri', 4, 8, options[1]!)).toEqual({ text: '1 + {numbers_1}', caret: 15 });
    expect(insertToken('{} * 2', 0, 1, options[0]!)).toEqual({ text: '{status} * 2', caret: 8 });
    // Re-picking inside an existing token replaces the whole token.
    expect(insertToken('{sta} + 1', 0, 4, options[0]!)).toEqual({ text: '{status} + 1', caret: 8 });
  });

  it('inserts NAME() for a function with the caret inside the brackets', () => {
    expect(insertToken('{su', 0, 3, options[3]!)).toEqual({ text: 'SUM()', caret: 4 });
  });
});
