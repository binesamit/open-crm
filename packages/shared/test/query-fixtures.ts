// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes, type QueryColumn, type QueryEnv, type QueryRow } from '../src';

/**
 * A small board for query tests (13-FILTERS §6). The API parity test writes the same rows to Postgres and
 * checks the SQL compiler returns exactly what the in-memory engine returns.
 */
export const ME = 'u_me';
export const OTHER = 'u_other';
export const TEAM = 't_ops';
/** Account tags (03 §3.1) of the `topics` column. */
export const TAG_RED = 'tg_red';
export const TAG_BLUE = 'tg_blue';

export const columns: QueryColumn[] = [
  { id: 'name', type: 'name', settings: {} },
  {
    id: 'status',
    type: 'status',
    settings: {
      labels: [
        { id: 0, label: 'עובד על זה', color: 'yellow', index: 0 },
        { id: 1, label: 'הושלם', color: 'forest', index: 1, is_done: true },
        { id: 2, label: 'תקוע', color: 'crimson', index: 2 },
        { id: 5, label: 'חדש', color: 'blue', index: 3 },
      ],
    },
  },
  {
    id: 'tags',
    type: 'dropdown',
    settings: {
      labels: [
        { id: 1, label: 'A' },
        { id: 2, label: 'B' },
        { id: 3, label: 'C' },
      ],
    },
  },
  { id: 'owner', type: 'people', settings: {} },
  { id: 'amount', type: 'numbers', settings: {} },
  { id: 'due', type: 'date', settings: { deadline: { status_column_id: 'status' } } },
  { id: 'span', type: 'timeline', settings: {} },
  { id: 'box', type: 'checkbox', settings: {} },
  { id: 'note', type: 'text', settings: {} },
  { id: 'stars', type: 'rating', settings: { max: 5 } },
  { id: 'topics', type: 'tags', settings: {} },
];

export const env = (over: Partial<QueryEnv> = {}): QueryEnv => ({
  columns,
  meId: ME,
  teams: [{ id: TEAM, member_ids: [OTHER] }],
  today: '2026-10-07', // a Wednesday
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
  ...over,
});

type Values = Record<string, unknown>;
export type FixtureItem = { name: string; group: 'g1' | 'g2'; values: Values; created_at?: string };

const p = (id: string, kind: 'person' | 'team' = 'person') => ({ id, kind });

export const fixtureItems: FixtureItem[] = [
  {
    name: 'Alpha',
    group: 'g1',
    values: {
      status: { index: 0 },
      tags: { ids: [1, 2] },
      owner: { persons_and_teams: [p(ME)] },
      amount: 100,
      due: { date: '2026-10-07' },
      span: { from: '2026-10-01', to: '2026-10-10' },
      box: { checked: true },
      note: 'Hello world',
      stars: { rating: 4 },
      topics: { tag_ids: [TAG_RED, TAG_BLUE] },
    },
  },
  {
    name: 'Bravo',
    group: 'g1',
    values: {
      status: { index: 1 },
      tags: { ids: [3] },
      owner: { persons_and_teams: [p(OTHER)] },
      amount: 250.5,
      due: { date: '2026-10-01' },
      note: 'hello again',
    },
  },
  {
    name: 'Charlie',
    group: 'g1',
    values: {
      status: { index: 2 },
      owner: { persons_and_teams: [p(TEAM, 'team')] },
      amount: -5,
      due: { date: '2026-09-30' },
      span: { from: '2026-10-12', to: '2026-10-20' },
      stars: { rating: 2 },
    },
  },
  {
    name: 'Delta',
    group: 'g2',
    values: {
      status: { index: 5 },
      tags: { ids: [2] },
      topics: { tag_ids: [TAG_BLUE] },
      amount: 0,
      due: { date: '2026-10-08', time: '21:30' }, // 00:30 on the 9th in Jerusalem
      note: 'שלום עולם',
    },
  },
  { name: 'Echo', group: 'g2', values: {} },
  {
    name: 'Foxtrot',
    group: 'g2',
    values: {
      status: { index: 1 },
      owner: { persons_and_teams: [p(ME), p(OTHER)] },
      amount: 1000,
      due: { date: '2026-11-15' },
      box: { checked: false },
      note: 'Zebra',
      stars: { rating: 5 },
    },
  },
];

/** Builds Item-DTO-like rows (cells carry `{value, text}`) for the in-memory engine. */
export const fixtureRows = (): QueryRow[] =>
  fixtureItems.map((it, i) => {
    const cells: QueryRow['cells'] = {};
    for (const [key, value] of Object.entries(it.values)) {
      const col = columns.find((c) => c.id === key)!;
      const def = columnTypes.get(col.type)!;
      const settings = { ...(def.defaultSettings as object), ...col.settings };
      cells[key] = { value, text: def.toText(value, settings, { userName: (id) => id, tagName: (id) => id }) };
    }
    return {
      id: `i${i}`,
      group_id: it.group,
      parent_item_id: null,
      depth: 0,
      name: it.name,
      position: String.fromCharCode(97 + i),
      key: null,
      cells,
      created_at: it.created_at ?? '2026-10-01T10:00:00.000Z',
      created_by: ME,
      updated_at: '2026-10-05T10:00:00.000Z',
    };
  });

/** Queries with their expected matches (names, in board order), shared by unit and parity tests. */
export const queryCases: { title: string; query: Record<string, unknown>; expect: string[] }[] = [
  {
    title: 'status any_of by label text',
    query: rule('status', 'any_of', ['תקוע', 'חדש']),
    expect: ['Charlie', 'Delta'],
  },
  { title: 'status any_of by id', query: rule('status', 'any_of', [1]), expect: ['Bravo', 'Foxtrot'] },
  {
    title: 'status not_any_of keeps empty',
    query: rule('status', 'not_any_of', ['הושלם']),
    expect: ['Alpha', 'Charlie', 'Delta', 'Echo'],
  },
  { title: 'status any_of with blank', query: rule('status', 'any_of', [null, 'תקוע']), expect: ['Charlie', 'Echo'] },
  { title: 'status unknown label matches nothing', query: rule('status', 'any_of', ['אין כזה']), expect: [] },
  { title: 'status is_done', query: rule('status', 'is_done', []), expect: ['Bravo', 'Foxtrot'] },
  {
    title: 'status is_not_done',
    query: rule('status', 'is_not_done', []),
    expect: ['Alpha', 'Charlie', 'Delta', 'Echo'],
  },
  { title: 'status is_empty', query: rule('status', 'is_empty', []), expect: ['Echo'] },
  { title: 'dropdown any_of', query: rule('tags', 'any_of', ['B']), expect: ['Alpha', 'Delta'] },
  {
    title: 'dropdown not_any_of',
    query: rule('tags', 'not_any_of', ['B', 'C']),
    expect: ['Charlie', 'Echo', 'Foxtrot'],
  },
  { title: 'dropdown is_not_empty', query: rule('tags', 'is_not_empty', []), expect: ['Alpha', 'Bravo', 'Delta'] },
  { title: 'tags any_of', query: rule('topics', 'any_of', [TAG_BLUE]), expect: ['Alpha', 'Delta'] },
  {
    title: 'tags any_of with blank',
    query: rule('topics', 'any_of', [null, TAG_RED]),
    expect: ['Alpha', 'Bravo', 'Charlie', 'Echo', 'Foxtrot'],
  },
  {
    title: 'tags not_any_of',
    query: rule('topics', 'not_any_of', [TAG_RED]),
    expect: ['Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'],
  },
  { title: 'tags is_empty', query: rule('topics', 'is_empty', []), expect: ['Bravo', 'Charlie', 'Echo', 'Foxtrot'] },
  { title: 'people me', query: rule('owner', 'any_of', ['me']), expect: ['Alpha', 'Foxtrot'] },
  {
    title: 'people user includes their team',
    query: rule('owner', 'any_of', [`user:${OTHER}`]),
    expect: ['Bravo', 'Charlie', 'Foxtrot'],
  },
  {
    title: 'people team includes members',
    query: rule('owner', 'any_of', [`team:${TEAM}`]),
    expect: ['Bravo', 'Charlie', 'Foxtrot'],
  },
  { title: 'people none', query: rule('owner', 'any_of', ['none']), expect: ['Delta', 'Echo'] },
  { title: 'people not me', query: rule('owner', 'not_any_of', ['me']), expect: ['Bravo', 'Charlie', 'Delta', 'Echo'] },
  { title: 'number greater_than', query: rule('amount', 'greater_than', [100]), expect: ['Bravo', 'Foxtrot'] },
  { title: 'number gte', query: rule('amount', 'greater_than_or_equal', [100]), expect: ['Alpha', 'Bravo', 'Foxtrot'] },
  { title: 'number lower_than', query: rule('amount', 'lower_than', [0]), expect: ['Charlie'] },
  { title: 'number between', query: rule('amount', 'between', [300, 0]), expect: ['Alpha', 'Bravo', 'Delta'] },
  { title: 'number any_of', query: rule('amount', 'any_of', [0, 1000]), expect: ['Delta', 'Foxtrot'] },
  { title: 'number is_empty', query: rule('amount', 'is_empty', []), expect: ['Echo'] },
  {
    title: 'text contains (case-insensitive)',
    query: rule('note', 'contains_text', ['HELLO']),
    expect: ['Alpha', 'Bravo'],
  },
  {
    title: 'text not contains keeps empty',
    query: rule('note', 'not_contains_text', ['hello']),
    expect: ['Charlie', 'Delta', 'Echo', 'Foxtrot'],
  },
  { title: 'text any_of exact', query: rule('note', 'any_of', ['zebra']), expect: ['Foxtrot'] },
  { title: 'text starts_with hebrew', query: rule('note', 'starts_with', ['שלום']), expect: ['Delta'] },
  { title: 'text ends_with', query: rule('note', 'ends_with', ['again']), expect: ['Bravo'] },
  { title: 'text is_empty', query: rule('note', 'is_empty', []), expect: ['Charlie', 'Echo'] },
  { title: 'name contains', query: rule('name', 'contains_text', ['o']), expect: ['Bravo', 'Echo', 'Foxtrot'] },
  { title: 'date TODAY', query: rule('due', 'any_of', ['TODAY']), expect: ['Alpha'] },
  {
    title: 'date with time in account timezone',
    query: rule('due', 'any_of', ['EXACT:2026-10-09']),
    expect: ['Delta'],
  },
  { title: 'date THIS_WEEK (Sun–Sat)', query: rule('due', 'any_of', ['THIS_WEEK']), expect: ['Alpha', 'Delta'] },
  { title: 'date PAST', query: rule('due', 'any_of', ['PAST']), expect: ['Bravo', 'Charlie'] },
  { title: 'date OVERDUE skips done', query: rule('due', 'any_of', ['OVERDUE']), expect: ['Charlie'] },
  { title: 'date lower_than TODAY', query: rule('due', 'lower_than', ['TODAY']), expect: ['Bravo', 'Charlie'] },
  { title: 'date greater_than TODAY', query: rule('due', 'greater_than', ['TODAY']), expect: ['Delta', 'Foxtrot'] },
  { title: 'date between', query: rule('due', 'between', ['2026-10-01', '2026-10-08']), expect: ['Alpha', 'Bravo'] },
  {
    title: 'date within the last 7 days',
    query: rule('due', 'within_the_last', [7, 'days']),
    expect: ['Alpha', 'Bravo', 'Charlie'],
  },
  {
    title: 'date within the next 3 workdays',
    query: rule('due', 'within_the_next', [3, 'workdays']),
    expect: ['Alpha', 'Delta'],
  },
  { title: 'date NEXT_MONTH', query: rule('due', 'any_of', ['NEXT_MONTH']), expect: ['Foxtrot'] },
  // Fix: — relative dates, stored as tokens and resolved in the account's calendar (Jerusalem, Sunday).
  { title: 'date LAST_WEEK', query: rule('due', 'any_of', ['LAST_WEEK']), expect: ['Bravo', 'Charlie'] },
  {
    title: 'date THIS_QUARTER',
    query: rule('due', 'any_of', ['THIS_QUARTER']),
    expect: ['Alpha', 'Bravo', 'Delta', 'Foxtrot'],
  },
  { title: 'date LAST_QUARTER', query: rule('due', 'any_of', ['LAST_QUARTER']), expect: ['Charlie'] },
  {
    title: 'date THIS_YEAR',
    query: rule('due', 'any_of', ['THIS_YEAR']),
    expect: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Foxtrot'],
  },
  {
    title: 'date not LAST_YEAR keeps empty',
    query: rule('due', 'not_any_of', ['LAST_YEAR']),
    expect: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'],
  },
  {
    title: 'date YESTERDAY / TOMORROW / NEXT_MONTH',
    query: rule('due', 'any_of', ['YESTERDAY', 'TOMORROW', 'NEXT_MONTH']),
    expect: ['Foxtrot'],
  },
  { title: 'date N days ago', query: rule('due', 'any_of', ['DAYS_AGO:7']), expect: ['Charlie'] },
  {
    title: 'date N days ahead, in the account timezone',
    query: rule('due', 'any_of', ['DAYS_AHEAD:2']),
    expect: ['Delta'],
  },
  { title: 'date before N days ago', query: rule('due', 'lower_than', ['DAYS_AGO:6']), expect: ['Charlie'] },
  {
    title: 'date after N days ahead',
    query: rule('due', 'greater_than', ['DAYS_AHEAD:1']),
    expect: ['Delta', 'Foxtrot'],
  },
  {
    title: 'date between N days ago and today',
    query: rule('due', 'between', ['DAYS_AGO:7', 'TODAY']),
    expect: ['Alpha', 'Bravo', 'Charlie'],
  },
  { title: 'date is_empty', query: rule('due', 'is_empty', []), expect: ['Echo'] },
  { title: 'timeline overlaps today', query: rule('span', 'any_of', ['TODAY']), expect: ['Alpha'] },
  { title: 'timeline start attribute', query: rule('span', 'greater_than', ['TODAY'], 'start'), expect: ['Charlie'] },
  { title: 'timeline end before', query: rule('span', 'lower_than', ['2026-10-11']), expect: ['Alpha'] },
  { title: 'checkbox checked', query: rule('box', 'is_not_empty', []), expect: ['Alpha'] },
  {
    title: 'checkbox unchecked (false or no cell)',
    query: rule('box', 'is_empty', []),
    expect: ['Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'],
  },
  { title: 'rating greater_than', query: rule('stars', 'greater_than', [3]), expect: ['Alpha', 'Foxtrot'] },
  { title: 'group any_of', query: rule('__group__', 'any_of', ['g2']), expect: ['Delta', 'Echo', 'Foxtrot'] },
  {
    title: 'nested: status new OR (P≥100 AND not done) AND NOT note empty',
    query: {
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [
          {
            kind: 'group',
            operator: 'or',
            rules: [
              r('status', 'any_of', ['חדש']),
              {
                kind: 'group',
                operator: 'and',
                rules: [r('amount', 'greater_than_or_equal', [100]), r('status', 'is_not_done', [])],
              },
            ],
          },
          { kind: 'group', operator: 'and', negate: true, rules: [r('note', 'is_empty', [])] },
        ],
      },
    },
    expect: ['Alpha', 'Delta'],
  },
  {
    title: 'negated rule',
    query: {
      filter: { kind: 'group', operator: 'and', rules: [{ ...r('status', 'any_of', ['הושלם']), negate: true }] },
    },
    expect: ['Alpha', 'Charlie', 'Delta', 'Echo'],
  },
  {
    title: 'incomplete rules are ignored',
    query: {
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [r('status', 'any_of', []), r('amount', 'greater_than', [500])],
      },
    },
    expect: ['Foxtrot'],
  },
  { title: 'search name and cells', query: { search: 'hello' }, expect: ['Alpha', 'Bravo'] },
  { title: 'search by label text', query: { search: 'תקוע' }, expect: ['Charlie'] },
  { title: 'person filter (me)', query: { person: 'me' }, expect: ['Alpha', 'Foxtrot'] },
  { title: 'search AND filter', query: { search: 'again', ...rule('status', 'is_done', []) }, expect: ['Bravo'] },
];

function r(column_id: string, operator: string, values: unknown[], attribute?: string) {
  return { kind: 'rule', column_id, operator, values, ...(attribute ? { attribute } : {}) };
}
function rule(column_id: string, operator: string, values: unknown[], attribute?: string) {
  return { filter: { kind: 'group', operator: 'and', rules: [r(column_id, operator, values, attribute)] } };
}
