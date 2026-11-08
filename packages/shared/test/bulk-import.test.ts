// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyImport,
  autoMap,
  BULK_EDIT_MAX_ROWS,
  bulkEditSchema,
  columnLetter,
  draftChanges,
  draftText,
  EMPTY_DRAFT,
  GROUP_COLUMN,
  importCellText,
  importTargets,
  isNewColumnId,
  matchKeyColumns,
  newColumnSettings,
  parseCsv,
  sheetColumns,
  sniffDelimiter,
  sniffType,
  tableData,
  tableHeaders,
  trimTable,
  type SheetRow,
} from '../src';

/** 12-ROADMAP "עריכה גדולה" B3: reading a file, guessing the mapping, and filling the draft from it. */
const columns = sheetColumns([
  { id: 'name', type: 'name', title: 'שם', settings: {} },
  {
    id: 'status',
    type: 'status',
    title: 'Status',
    settings: { labels: [{ id: 0, label: 'Done', color: '#00c875', index: 0 }] },
  },
  { id: 'email', type: 'email', title: 'Contact mail', settings: {} },
  { id: 'phone', type: 'phone', title: 'טלפון נייד', settings: {} },
  { id: 'amount', type: 'numbers', title: 'Amount', settings: {} },
  { id: 'due', type: 'date', title: 'Due date', settings: {} },
  { id: 'item_id', type: 'item_id', title: 'Item ID', settings: {} },
  { id: 'formula', type: 'formula', title: 'Total', settings: {} },
  { id: GROUP_COLUMN, type: 'group', title: 'Group', settings: {} },
]);

const base: SheetRow[] = [
  { key: 'a', itemId: 'a', groupId: 'g', texts: { name: 'Alpha', status: 'Done', amount: '1', item_id: 'X-1' } },
  { key: 'b', itemId: 'b', groupId: 'g', texts: { name: 'Beta ', status: '', amount: '2', item_id: 'X-2' } },
];

describe('reading files', () => {
  it('parses CSV with a sniffed delimiter, quotes, newlines in quotes and a BOM', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(sniffDelimiter('a,"x;y;z",c')).toBe(',');
    const bom = String.fromCharCode(0xfeff);
    expect(parseCsv(`${bom}name,note\r\n"Smith, J","line 1\nline 2"\r\nDoe,"say ""hi"""\r\n`)).toEqual([
      ['name', 'note'],
      ['Smith, J', 'line 1\nline 2'],
      ['Doe', 'say "hi"'],
    ]);
  });

  it('turns spreadsheet values into sheet text', () => {
    expect(importCellText(new Date(Date.UTC(2026, 2, 5)))).toBe('2026-03-05');
    expect(importCellText(new Date(Date.UTC(2026, 2, 5, 14, 30)))).toBe('2026-03-05 14:30');
    expect(importCellText(0.1 + 0.2)).toBe('0.3');
    expect(importCellText(1234567890123)).toBe('1234567890123');
    expect(importCellText(true)).toBe('true');
    expect(importCellText(null)).toBe('');
  });

  it('drops empty rows and trailing empty columns; headers or letters', () => {
    const rows = trimTable([
      ['Name', 'Amount', '', ''],
      ['', '', '', ''],
      ['Gamma', '5', '', ' '],
    ]);
    expect(rows).toEqual([
      ['Name', 'Amount'],
      ['Gamma', '5'],
    ]);
    expect(tableHeaders(rows, true)).toEqual(['Name', 'Amount']);
    expect(tableHeaders(rows, false)).toEqual(['A', 'B']);
    expect(tableData(rows, true)).toEqual([['Gamma', '5']]);
    expect(columnLetter(27)).toBe('AB');
  });
});

describe('type sniffing', () => {
  it('reads what the values are', () => {
    expect(sniffType(['1', '2.5', '1,000', ''])).toBe('numbers');
    expect(sniffType(['2026-01-02', '3/4/2026'])).toBe('date');
    expect(sniffType(['a@x.test', 'b@y.test'])).toBe('email');
    expect(sniffType(['https://x.test', 'www.y.test'])).toBe('link');
    expect(sniffType(['050-1234567', '+972 52 765 4321'])).toBe('phone');
    expect(sniffType(['כן', 'לא', 'v'])).toBe('checkbox');
    expect(sniffType(['Open', 'Closed', 'Open', 'Open', 'Closed'])).toBe('status');
    expect(sniffType(['line\nbreak'])).toBe('long_text');
    expect(sniffType(['Alpha', 'Beta', 'Gamma'])).toBe('text');
    expect(sniffType([])).toBe('text');
  });

  it('gives new label columns empty labels', () => {
    expect(newColumnSettings('status')).toMatchObject({ labels: [] });
    expect(newColumnSettings('text')).not.toHaveProperty('labels');
  });
});

describe('auto mapping', () => {
  it('matches by title, similar title, the name words and the values', () => {
    const headers = ['Name', 'status', 'Amounts', 'mail', 'Due', 'Notes', 'tel'];
    const data = [
      ['Alpha', 'Done', '1', 'a@x.test', '2026-01-02', 'hello', '050-1234567'],
      ['Gamma', 'New', '3', 'c@x.test', '2026-02-03', 'world', '052-7654321'],
    ];
    const map = autoMap(headers, data, columns);
    expect(map.map((m) => (m.kind === 'column' ? m.columnId : m.kind))).toEqual([
      'name', // "Name" → the name column (its title here is "שם")
      'status', // same title, any case
      'amount', // similar title, values are numbers
      'email', // the only email column, values are emails
      'due', // similar ("Due" in "Due date"), values are dates
      'ignore',
      'phone', // the only phone column, values are phones
    ]);
  });

  it('takes the first text column as the name when nothing else does', () => {
    const map = autoMap(['Company', 'Count'], [['Acme', '3']], columns);
    expect(map[0]).toEqual({ kind: 'column', columnId: 'name' });
  });

  it('offers the writable columns, and keys to match by', () => {
    expect(importTargets(columns).map((c) => c.id)).toEqual([
      'name',
      'status',
      'email',
      'phone',
      'amount',
      'due',
      GROUP_COLUMN,
    ]);
    expect(matchKeyColumns(columns).map((c) => c.id)).toEqual(['name', 'email', 'phone', 'amount', 'item_id']);
  });
});

describe('applying a file', () => {
  const withNew = [
    ...columns.slice(0, -1),
    ...sheetColumns([{ id: '__new_1', type: 'text', title: 'Notes', settings: {} }]),
    columns.at(-1)!,
  ];

  it('updates matched rows (empty cells keep the value) and appends the rest', () => {
    const data = [
      ['alpha', '', '10', 'note a'],
      ['Gamma', 'Done', '3', 'note g'],
      ['beta', 'Done', '', ''],
      ['gamma', '', '4', ''],
      ['', '', '', ''],
    ];
    const res = applyImport(base, EMPTY_DRAFT, withNew, data, ['name', 'status', 'amount', '__new_1'], 'name');
    expect(res).toMatchObject({ updated: 2, created: 1, skipped: 0, rows: 3, tooMany: false });
    const d = res.draft;
    expect(draftText(base, d, 0, 'amount')).toBe('10');
    expect(draftText(base, d, 0, 'status')).toBe('Done'); // empty in the file: kept
    expect(draftText(base, d, 0, 'name')).toBe('Alpha'); // the key keeps the item's own spelling
    expect(draftText(base, d, 1, 'status')).toBe('Done');
    expect(draftText(base, d, 1, 'amount')).toBe('2');
    expect(draftText(base, d, 2, 'name')).toBe('Gamma');
    expect(draftText(base, d, 2, 'amount')).toBe('4'); // "gamma" again: the same new row
    expect(draftText(base, d, 2, '__new_1')).toBe('note g');
    expect(d.added).toBe(1);
    expect(draftChanges(base, d, withNew).filter((c) => c.row === 2)).toHaveLength(4);
    expect(draftChanges(base, d, withNew).some((c) => c.row < 2 && c.column.id === 'name')).toBe(false);
  });

  it('matches by a frozen id column without writing it; without a key every row is new', () => {
    const data = [['X-2', '7']];
    const byId = applyImport(base, EMPTY_DRAFT, withNew, data, ['item_id', 'amount'], 'item_id');
    expect(byId).toMatchObject({ updated: 1, created: 0, skipped: 0 });
    expect(draftText(base, byId.draft, 1, 'amount')).toBe('7');
    const plain = applyImport(base, EMPTY_DRAFT, withNew, [['Alpha', '1']], ['name', 'amount'], null);
    expect(plain).toMatchObject({ updated: 0, created: 1 });
    // A file column on a frozen (computed) column is skipped and counted.
    const frozen = applyImport(base, EMPTY_DRAFT, withNew, [['New', '5']], ['name', 'formula'], null);
    expect(frozen.skipped).toBe(1);
  });

  it('applies nothing above the row limit', () => {
    const data = Array.from({ length: BULK_EDIT_MAX_ROWS }, (_, i) => [`r${i}`]);
    const res = applyImport(base, EMPTY_DRAFT, withNew, data, ['name'], null);
    expect(res).toMatchObject({ tooMany: true, rows: BULK_EDIT_MAX_ROWS + 2 });
    expect(res.draft).toBe(EMPTY_DRAFT);
  });

  it('new columns travel in the request by ref', () => {
    expect(isNewColumnId('__new_1')).toBe(true);
    expect(isNewColumnId('text')).toBe(false);
    const ok = bulkEditSchema.safeParse({
      columns: [{ ref: '__new_1', title: 'Notes', type: 'text' }],
      labels: [],
      tags: [],
      rows: [{ name: 'x', cells: { __new_1: 'y' } }],
    });
    expect(ok.success).toBe(true);
    expect(
      bulkEditSchema.safeParse({
        columns: [{ ref: 'text', title: 'T', type: 'text' }],
        labels: [],
        tags: [],
        rows: [{ name: 'x', cells: {} }],
      }).success,
    ).toBe(false);
  });
});
