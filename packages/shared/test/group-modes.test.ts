// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  type GroupMode,
  groupModes,
  groupRows,
  mirrorSourceOf,
  niceRangeSize,
  type QueryEnv,
  type QueryRow,
  resolveField,
} from '../src';

/**
 * Prod ק2: how each column type groups — labels by order or name (and every label), multi-values each or as
 * a combination, people by team, numbers in ranges (in the column's format), text by first letter / domain /
 * country, a relation by linked item, a mirror by its source.
 */
const env: QueryEnv = {
  columns: [
    {
      id: 'st',
      type: 'status',
      settings: {
        labels: [
          { id: 0, label: 'Working', color: 'apricot', index: 1 },
          { id: 1, label: 'Done', color: 'forest', index: 0 },
          { id: 2, label: 'Blocked', color: 'crimson', index: 2 },
        ],
      },
    },
    {
      id: 'dd',
      type: 'dropdown',
      settings: {
        labels: [
          { id: 1, label: 'Urgent' },
          { id: 2, label: 'Client' },
        ],
      },
    },
    { id: 'pp', type: 'people', settings: {} },
    { id: 'amt', type: 'numbers', settings: { unit: { symbol: '₪', direction: 'left' }, thousands: true } },
    { id: 'stars', type: 'rating', settings: {} },
    { id: 'mail', type: 'email', settings: {} },
    { id: 'tel', type: 'phone', settings: {} },
    { id: 'name', type: 'text', settings: {} },
    { id: 'rel', type: 'board_relation', settings: {} },
    {
      id: 'mir',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'x' },
      mirror_source: mirrorSourceOf('numbers', { unit: { symbol: '$', direction: 'left' } }),
    },
  ],
  meId: null,
  teams: [{ id: 'team1', member_ids: ['u1', 'u2'] }],
  today: '2026-10-13',
  timezone: 'UTC',
  weekend: 'fri_sat',
  firstDay: 0,
};
const row = (id: string, cells: Record<string, unknown>): QueryRow => ({
  id,
  group_id: 'g',
  parent_item_id: null,
  depth: 0,
  name: id,
  position: id,
  key: null,
  cells: Object.fromEntries(
    Object.entries(cells).map(([k, v]) => {
      const { text, ...rest } = v as { text?: string };
      return [k, { value: 'value' in rest ? (rest as { value: unknown }).value : v, text: text ?? null }];
    }),
  ),
  created_at: '2026-10-01T00:00:00Z',
  created_by: null,
  updated_at: '2026-10-01T00:00:00Z',
});
const group = (column: string, rows: QueryRow[], mode?: GroupMode, extra: Record<string, unknown> = {}) =>
  groupRows(rows, resolveField(column, env), {
    timezone: 'UTC',
    emptyLabel: '—',
    nameOf: (id) => ({ u1: 'Dana', u2: 'Yossi', team1: 'Sales' })[id],
    teams: env.teams,
    countryName: (c) => ({ IL: 'Israel', US: 'United States' })[c] ?? c,
    mode,
    ...extra,
  }).map((b) => [b.label, b.rows.map((r) => r.id)]);

describe('group modes per column type ( ק2)', () => {
  it('offers each type its modes, the default first', () => {
    const m = (id: string) => groupModes(resolveField(id, env));
    expect(m('st')).toEqual(['each', 'name']);
    expect(m('dd')).toEqual(['each', 'combo']);
    expect(m('pp')).toEqual(['each', 'combo', 'team']);
    expect(m('amt')).toEqual(['ranges', 'exact']);
    expect(m('stars')).toEqual(['exact', 'ranges']);
    expect(m('mail')).toEqual(['exact', 'domain', 'first_letter']);
    expect(m('tel')).toEqual(['exact', 'country']);
    expect(m('mir')).toEqual(['ranges', 'exact']);
  });

  it('status: label order, by name, and every label when asked', () => {
    const rows = [row('a', { st: { index: 0 } }), row('b', { st: { index: 1 } })];
    expect(group('st', rows).map(([l]) => l)).toEqual(['Done', 'Working']);
    expect(group('st', rows, 'name').map(([l]) => l)).toEqual(['Done', 'Working']);
    expect(group('st', rows, 'each', { showEmpty: true }).map(([l]) => l)).toEqual(['Done', 'Working', 'Blocked']);
  });

  it('multi-values: each, or the whole combination', () => {
    const rows = [row('a', { dd: { ids: [1, 2] } }), row('b', { dd: { ids: [2] } })];
    expect(group('dd', rows)).toEqual([
      ['Urgent', ['a']],
      ['Client', ['a', 'b']],
    ]);
    expect(group('dd', rows, 'combo')).toEqual([
      ['Client', ['b']],
      ['Urgent + Client', ['a']],
    ]);
  });

  it('people by team', () => {
    const p = (...ids: string[]) => ({ persons_and_teams: ids.map((id) => ({ id, kind: 'person' })) });
    const rows = [row('a', { pp: p('u1') }), row('b', { pp: p('u3') })];
    expect(group('pp', rows, 'team')).toEqual([
      ['Sales', ['a']],
      ['—', ['b']],
    ]);
  });

  it('numbers in ranges, in the column format; a range size from the view', () => {
    const rows = [row('a', { amt: 120 }), row('b', { amt: 450 }), row('c', { amt: 980 })];
    expect(niceRangeSize(120, 980)).toBe(200);
    expect(group('amt', rows).map(([l]) => l)).toEqual(['₪0 – ₪200', '₪400 – ₪600', '₪800 – ₪1,000']);
    expect(group('amt', rows, 'ranges', { rangeSize: 500 }).map(([l]) => l)).toEqual(['₪0 – ₪500', '₪500 – ₪1,000']);
  });

  it('text: first letter, an email domain, a phone country', () => {
    const t = (text: string, value: unknown = text) => ({ value, text });
    expect(group('name', [row('a', { name: t('alpha') }), row('b', { name: t('Avi') })], 'first_letter')).toEqual([
      ['A', ['a', 'b']],
    ]);
    expect(
      group('mail', [row('a', { mail: t('d@acme.com', { email: 'd@acme.com' }) })], 'domain').map(([l]) => l),
    ).toEqual(['acme.com']);
    expect(
      group('tel', [row('a', { tel: t('050', { phone: '050', country: 'IL' }) })], 'country').map(([l]) => l),
    ).toEqual(['Israel']);
  });

  it('a relation groups by each linked item; a mirror of numbers in ranges of its source', () => {
    const rel = row('a', { rel: { value: { item_ids: ['i1', 'i2'] }, text: 'One, Two' } });
    (rel.cells.rel as { names?: string[] }).names = ['One', 'Two'];
    expect(group('rel', [rel])).toEqual([
      ['One', ['a']],
      ['Two', ['a']],
    ]);
    const m = (n: number) => row(`m${n}`, { mir: { value: { display_value: String(n), number: n }, text: String(n) } });
    expect(group('mir', [m(5), m(15)]).map(([l]) => l)).toEqual(['$4 – $6', '$14 – $16']);
  });
});
