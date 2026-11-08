// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  buildBulkEdit,
  bulkEditSchema,
  columnTypes,
  defaultDecisions,
  draftChanges,
  draftText,
  EMPTY_DRAFT,
  GROUP_COLUMN,
  labelDecisionKey,
  parseSheetCell,
  parseTsv,
  pasteBlock,
  rangeBlock,
  rangeWrites,
  reviewDraft,
  setTexts,
  sheetColumns,
  sheetText,
  toTsv,
  type BulkEnv,
  type SheetRow,
} from '../src';

const STATUS = {
  labels: [
    { id: 0, label: 'בעבודה', color: 'yellow', index: 0 },
    { id: 1, label: 'הושלם', color: 'forest', index: 1 },
    { id: 5, label: 'ישן', color: 'gray', index: 2, is_deactivated: true },
  ],
};
const DROPDOWN = {
  labels: [
    { id: 0, label: 'Red' },
    { id: 1, label: 'Blue' },
  ],
};

const columns = sheetColumns([
  { id: 'name', type: 'name', title: 'Name', settings: {} },
  { id: 'status', type: 'status', title: 'Status', settings: STATUS },
  { id: 'text', type: 'text', title: 'Text', settings: {} },
  { id: 'formula', type: 'formula', title: 'F', settings: {} },
  { id: 'num', type: 'numbers', title: 'N', settings: {} },
  { id: 'date', type: 'date', title: 'D', settings: {} },
  { id: 'dd', type: 'dropdown', title: 'DD', settings: DROPDOWN },
  { id: 'tags', type: 'tags', title: 'Tags', settings: {} },
  { id: 'people', type: 'people', title: 'P', settings: {} },
  { id: 'files', type: 'file', title: 'Files', settings: {} },
  { id: 'rel', type: 'board_relation', title: 'R', settings: {} },
  { id: 'locked', type: 'text', title: 'L', settings: {}, restricted_edit: true },
  { id: GROUP_COLUMN, type: 'group', title: 'Group', settings: {} },
]);
const col = (id: string) => columns.find((c) => c.id === id)!;
const idx = (id: string) => columns.findIndex((c) => c.id === id);

const env: BulkEnv = {
  people: [
    { id: 'u1', kind: 'person', name: 'Dana Levi', email: 'dana@x.test' },
    { id: 't1', kind: 'team', name: 'Sales' },
  ],
  tags: [{ id: 'g1', name: 'vip' }],
  groups: [
    { id: 'g-a', title: 'Leads' },
    { id: 'g-b', title: 'Won' },
  ],
};

const base: SheetRow[] = [
  { key: 'i1', itemId: 'i1', groupId: 'g-a', texts: { name: 'One', status: 'בעבודה', text: 'a', formula: '42' } },
  { key: 'i2', itemId: 'i2', groupId: 'g-a', texts: { name: 'Two', status: '', text: 'b' } },
];

describe('sheet columns', () => {
  it('freezes computed, engine-written, relation and restricted columns', () => {
    expect(Object.fromEntries(columns.map((c) => [c.id, c.mode]))).toEqual({
      name: 'name',
      status: 'edit',
      text: 'edit',
      formula: 'frozen',
      num: 'edit',
      date: 'edit',
      dd: 'edit',
      tags: 'edit',
      people: 'edit',
      files: 'frozen',
      rel: 'frozen',
      locked: 'frozen',
      [GROUP_COLUMN]: 'group',
    });
  });

  it('edit text reads back as the same value for every text type', () => {
    const cases: [string, unknown, unknown?][] = [
      ['numbers', 1234.5, { unit: { symbol: 'kg', direction: 'right' }, thousands: true }],
      ['email', { email: 'a@b.co', text: 'Alice' }],
      ['link', { url: 'https://x.test/p', text: 'site' }],
      ['date', { date: '2026-03-04', time: '09:30' }],
      ['timeline', { from: '2026-03-04', to: '2026-03-09' }],
      ['checkbox', { checked: true }],
      ['rating', { rating: 4 }],
      ['long_text', { text: 'line 1\nline 2' }],
      ['phone', { phone: '050-1234567' }],
    ];
    for (const [type, value, settings = {}] of cases) {
      const def = columnTypes.get(type)!;
      const text = sheetText(type, { value, text: def.toText(value, settings, {}) });
      const column = sheetColumns([{ id: 'c', type, title: type, settings: settings as Record<string, unknown> }])[0]!;
      const back = parseSheetCell(column, text, env);
      expect(back, type).toEqual({ kind: 'value', value: type === 'numbers' ? value : expect.anything() });
      if (type !== 'numbers' && type !== 'email' && type !== 'link')
        expect((back as { value: unknown }).value, type).toEqual(value);
    }
    expect(sheetText('text', undefined)).toBe('');
  });
});

describe('parseSheetCell', () => {
  it('labels: existing by name (case-insensitive, not deactivated), new ones reported', () => {
    expect(parseSheetCell(col('status'), ' הושלם ', env)).toEqual({ kind: 'value', value: { index: 1 } });
    expect(parseSheetCell(col('status'), 'ישן', env)).toEqual({ kind: 'labels', known: [], fresh: ['ישן'] });
    expect(parseSheetCell(col('status'), 'x'.repeat(31), env)).toEqual({ kind: 'invalid' });
    expect(parseSheetCell(col('dd'), 'red, Green; blue', env)).toEqual({
      kind: 'labels',
      known: [0, 1],
      fresh: ['Green'],
    });
    expect(parseSheetCell(col('dd'), 'Blue,red', env)).toEqual({ kind: 'value', value: { ids: [1, 0] } });
  });

  it('tags and people: new tags and missing people are reported, found ones kept', () => {
    expect(parseSheetCell(col('tags'), '#VIP, new one', env)).toEqual({
      kind: 'tags',
      names: ['VIP', 'new one'],
      fresh: ['new one'],
    });
    expect(parseSheetCell(col('tags'), 'vip', env)).toEqual({ kind: 'value', value: { tags: ['vip'] } });
    expect(parseSheetCell(col('people'), 'dana@x.test, sales, Nobody', env)).toEqual({
      kind: 'people',
      found: [
        { id: 'u1', kind: 'person' },
        { id: 't1', kind: 'team' },
      ],
      missing: ['Nobody'],
    });
    expect(parseSheetCell(col('people'), 'Dana Levi', env)).toEqual({
      kind: 'value',
      value: { persons_and_teams: [{ id: 'u1', kind: 'person' }] },
    });
  });

  it('typed values: invalid text is flagged, empty clears', () => {
    expect(parseSheetCell(col('num'), '₪1,200', env)).toEqual({ kind: 'value', value: 1200 });
    expect(parseSheetCell(col('num'), 'abc', env)).toEqual({ kind: 'invalid' });
    expect(parseSheetCell(col('date'), '31/02/2026', env)).toEqual({ kind: 'invalid' });
    expect(parseSheetCell(col('date'), '5.3.26', env)).toEqual({ kind: 'value', value: { date: '2026-03-05' } });
    expect(parseSheetCell(col('text'), '   ', env)).toEqual({ kind: 'clear' });
    expect(parseSheetCell(col('formula'), '1', env)).toEqual({ kind: 'invalid' });
  });

  it('name and group', () => {
    expect(parseSheetCell(col('name'), '  New  ', env)).toEqual({ kind: 'value', value: 'New' });
    expect(parseSheetCell(col('name'), '', env)).toEqual({ kind: 'invalid' });
    expect(parseSheetCell(col(GROUP_COLUMN), 'won', env)).toEqual({ kind: 'value', value: 'g-b' });
    expect(parseSheetCell(col(GROUP_COLUMN), 'Lost', env)).toEqual({ kind: 'invalid' });
  });
});

describe('draft', () => {
  it('pastes a block past the last row as new rows, skipping frozen cells', () => {
    const block = parseTsv('Two b\tהושלם\tc\t99\nThree\tחדש\tz\t1\n');
    const { draft, skipped } = pasteBlock(base, EMPTY_DRAFT, columns, { row: 1, col: 0 }, block);
    expect(skipped).toBe(2); // the formula column, twice
    expect(draft.added).toBe(1);
    expect(draftText(base, draft, 1, 'name')).toBe('Two b');
    expect(draftText(base, draft, 2, 'status')).toBe('חדש');
    expect(draftText(base, draft, 0, 'name')).toBe('One');
    expect(draftChanges(base, draft, columns).map((c) => [c.row, c.column.id, c.text])).toEqual([
      [1, 'name', 'Two b'],
      [1, 'status', 'הושלם'],
      [1, 'text', 'c'],
      [2, 'name', 'Three'],
      [2, 'status', 'חדש'],
      [2, 'text', 'z'],
    ]);
  });

  it('typing the original text back drops the edit; clearing new rows removes them', () => {
    let d = setTexts(base, EMPTY_DRAFT, columns, [{ row: 0, col: idx('text'), text: 'changed' }]).draft;
    d = setTexts(base, d, columns, [{ row: 0, col: idx('text'), text: 'a' }]).draft;
    expect(d.edits).toEqual({});
    d = setTexts(base, d, columns, [{ row: 3, col: 0, text: 'far' }]).draft;
    expect(d.added).toBe(2);
    d = setTexts(
      base,
      d,
      columns,
      rangeWrites({ r0: 2, r1: 3, c0: 0, c1: 2 }, () => ''),
    ).draft;
    expect(d.added).toBe(0);
  });

  it('the group column takes text only on new rows', () => {
    const g = idx(GROUP_COLUMN);
    expect(setTexts(base, EMPTY_DRAFT, columns, [{ row: 0, col: g, text: 'Won' }]).skipped).toBe(1);
    expect(setTexts(base, EMPTY_DRAFT, columns, [{ row: 2, col: g, text: 'Won' }]).skipped).toBe(0);
  });

  it('copies a range as TSV that pastes back the same', () => {
    const block = rangeBlock(base, EMPTY_DRAFT, columns, { r0: 0, r1: 1, c0: 0, c1: 2 });
    expect(block).toEqual([
      ['One', 'בעבודה', 'a'],
      ['Two', '', 'b'],
    ]);
    expect(
      parseTsv(
        toTsv([
          ['a\tb', 'q"x'],
          ['line\nbreak', ''],
        ]),
      ),
    ).toEqual([
      ['a\tb', 'q"x'],
      ['line\nbreak', ''],
    ]);
  });
});

describe('review and request', () => {
  const writes = [
    { row: 0, col: idx('status'), text: 'Waiting' },
    { row: 1, col: idx('status'), text: 'waiting' },
    { row: 1, col: idx('num'), text: 'oops' },
    { row: 0, col: idx('tags'), text: 'vip, fresh' },
    { row: 0, col: idx('people'), text: 'Nobody' },
    { row: 1, col: idx('people'), text: 'Dana Levi, Ghost' },
    { row: 0, col: idx('dd'), text: 'Red, Purple' },
    { row: 2, col: 0, text: 'New row' },
    { row: 2, col: idx('status'), text: 'Waiting' },
    { row: 2, col: idx(GROUP_COLUMN), text: 'Won' },
    { row: 3, col: idx('text'), text: 'nameless' },
    { row: 0, col: 0, text: 'One renamed' },
  ];
  const draft = setTexts(base, EMPTY_DRAFT, columns, writes).draft;

  it('lists new labels / tags, invalid cells and missing people', () => {
    const r = reviewDraft(base, draft, columns, env);
    expect(r.labels).toEqual([
      { columnId: 'status', name: 'Waiting', count: 3 },
      { columnId: 'dd', name: 'Purple', count: 1 },
    ]);
    expect(r.tags).toEqual([{ columnId: 'tags', name: 'fresh', count: 1 }]);
    expect(r.invalid).toEqual([{ row: 1, columnId: 'num', text: 'oops' }]);
    expect(r.people).toEqual([
      { name: 'Nobody', count: 1 },
      { name: 'Ghost', count: 1 },
    ]);
    expect(r).toMatchObject({ updated: 2, created: 2, cells: 12 });
  });

  it('builds one request: new label ids after the highest, declined values left out', () => {
    const r = reviewDraft(base, draft, columns, env);
    const decisions = defaultDecisions(r, columns);
    expect(decisions.labels[labelDecisionKey('status', 'waiting')]).toMatchObject({ add: true, color: 'crimson' });
    decisions.labels[labelDecisionKey('dd', 'Purple')] = { add: false };
    const { request, skipped } = buildBulkEdit(base, draft, columns, env, decisions, {
      groupId: 'g-a',
      name: 'Item',
    });
    expect(bulkEditSchema.safeParse(request).success).toBe(true);
    // invalid number + "Nobody" (no one found).
    expect(skipped).toBe(2);
    expect(request.labels).toEqual([{ column_id: 'status', id: 6, label: 'Waiting', color: 'crimson', index: 3 }]);
    expect(request.tags).toEqual([{ name: 'fresh', color: expect.any(String) }]);
    expect(request.rows).toEqual([
      {
        item_id: 'i1',
        name: 'One renamed',
        cells: { status: { index: 6 }, tags: { tags: ['vip', 'fresh'] }, dd: { ids: [0] } },
      },
      {
        item_id: 'i2',
        cells: { status: { index: 6 }, people: { persons_and_teams: [{ id: 'u1', kind: 'person' }] } },
      },
      { name: 'New row', group_id: 'g-b', cells: { status: { index: 6 } } },
      { name: 'Item', group_id: 'g-a', cells: { text: 'nameless' } },
    ]);
  });

  it('a declined status label skips its cells; a declined tag drops only that tag', () => {
    const r = reviewDraft(base, draft, columns, env);
    const decisions = defaultDecisions(r, columns);
    decisions.labels[labelDecisionKey('status', 'Waiting')] = { add: false };
    decisions.tags.fresh = { add: false };
    const { request } = buildBulkEdit(base, draft, columns, env, decisions, { groupId: null, name: 'Item' });
    expect(request.labels.map((l) => l.label)).toEqual(['Purple']);
    expect(request.rows[0]!.cells).toEqual({ tags: { tags: ['vip'] }, dd: { ids: [0, 2] } });
    expect(request.rows[2]).toEqual({ name: 'New row', group_id: 'g-b', cells: {} });
  });
});
