// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  autoMap,
  type BulkEnv,
  bulkEditSchema,
  buildBulkEdit,
  buildSubitems,
  defaultDecisions,
  EMPTY_DRAFT,
  GROUP_COLUMN,
  mainRowRef,
  mergeReviews,
  PARENT_COLUMN,
  planParents,
  reviewDraft,
  reviewSubitems,
  type SheetRow,
  setTexts,
  sheetColumns,
  subEnv,
  subRowRef,
  subSheetColumns,
  type SheetState,
} from '../src';

const STATUS = { labels: [{ id: 0, label: 'Open', color: 'yellow', index: 0 }] };
const mainColumns = sheetColumns([
  { id: 'name', type: 'name', title: 'Name', settings: {} },
  { id: 'status', type: 'status', title: 'Status', settings: STATUS },
  { id: GROUP_COLUMN, type: 'group', title: 'Group', settings: {} },
]);
const subColumns = subSheetColumns(
  [
    { id: 'name', type: 'name', title: 'Subitem', settings: {} },
    { id: 'status', type: 'status', title: 'Status', settings: STATUS },
  ],
  'Parent item',
);
const env: BulkEnv = { people: [], tags: [], groups: [{ id: 'g1', title: 'G' }] };

const mainBase: SheetRow[] = [
  { key: 'a', itemId: 'A', groupId: 'g1', texts: { name: 'Alpha', status: '', [GROUP_COLUMN]: 'G' } },
  { key: 'b', itemId: 'B', groupId: 'g1', texts: { name: 'Beta', status: '', [GROUP_COLUMN]: 'G' } },
  { key: 'd', itemId: 'D', groupId: 'g1', texts: { name: 'Dup', status: '', [GROUP_COLUMN]: 'G' } },
  { key: 'd2', itemId: 'D2', groupId: 'g1', texts: { name: 'dup ', status: '', [GROUP_COLUMN]: 'G' } },
];
const subBase: SheetRow[] = [
  {
    key: 's1',
    itemId: 'S1',
    groupId: null,
    parentId: 'A',
    depth: 1,
    texts: { 's:name': 'Task', 's:status': '', [PARENT_COLUMN]: 'Alpha' },
  },
  {
    key: 's2',
    itemId: 'S2',
    groupId: null,
    parentId: 'S1',
    depth: 2,
    texts: { 's:name': 'Step', 's:status': '', [PARENT_COLUMN]: 'Task' },
  },
];
const col = (cols: typeof mainColumns, id: string) => cols.findIndex((c) => c.id === id);

/** The main sheet with a new row "Gamma" at the end. */
const main: SheetState = {
  base: mainBase,
  draft: setTexts(mainBase, EMPTY_DRAFT, mainColumns, [{ row: 4, col: 0, text: 'Gamma' }]).draft,
  columns: mainColumns,
};
const subWith = (writes: { row: number; col: string; text: string }[], base = subBase): SheetState => ({
  base,
  draft: setTexts(
    base,
    EMPTY_DRAFT,
    subColumns,
    writes.map((w) => ({ row: w.row, col: col(subColumns, w.col), text: w.text })),
  ).draft,
  columns: subColumns,
});

describe('subitems sheet: columns', () => {
  it('prefixes the sub-board columns and ends with the parent column', () => {
    expect(subColumns.map((c) => [c.id, c.mode])).toEqual([
      ['s:name', 'name'],
      ['s:status', 'edit'],
      [PARENT_COLUMN, 'parent'],
    ]);
  });

  it('auto-maps a "parent item" file column to it', () => {
    const t = autoMap(['Name', 'Parent item'], [['x', 'Alpha']], subColumns);
    expect(t[1]).toEqual({ kind: 'column', columnId: PARENT_COLUMN });
  });
});

describe('planParents', () => {
  it('matches parents by name in both drafts: existing items, new rows, subitems (deeper boards)', () => {
    const sub = subWith([
      { row: 2, col: 's:name', text: 'n1' },
      { row: 2, col: PARENT_COLUMN, text: ' beta ' },
      { row: 3, col: 's:name', text: 'n2' },
      { row: 3, col: PARENT_COLUMN, text: 'Gamma' },
      { row: 4, col: 's:name', text: 'n3' },
      { row: 4, col: PARENT_COLUMN, text: 'n2' },
      { row: 5, col: 's:name', text: 'n4' },
      { row: 5, col: PARENT_COLUMN, text: 'Task' },
    ]);
    const plan = planParents(main, sub, 3);
    expect(plan.resolve(0)).toEqual({ kind: 'value', value: { item_id: 'A' } });
    expect(plan.resolve(2)).toEqual({ kind: 'value', value: { item_id: 'B' } });
    expect(plan.resolve(3)).toEqual({ kind: 'value', value: { ref: mainRowRef(4) } });
    expect(plan.resolve(4)).toEqual({ kind: 'value', value: { ref: subRowRef(3) } });
    expect(plan.resolve(5)).toEqual({ kind: 'value', value: { item_id: 'S1' } });
    expect(plan.depth.slice(0, 6)).toEqual([1, 2, 1, 1, 2, 2]);
  });

  it('flags missing, ambiguous, empty, too deep and looping parents', () => {
    const sub = subWith([
      { row: 2, col: 's:name', text: 'x' },
      { row: 2, col: PARENT_COLUMN, text: 'Nobody' },
      { row: 3, col: 's:name', text: 'y' },
      { row: 3, col: PARENT_COLUMN, text: 'DUP' },
      { row: 4, col: 's:name', text: 'z' },
      { row: 5, col: 's:name', text: 'deep' },
      { row: 5, col: PARENT_COLUMN, text: 'Step' },
    ]);
    const plan = planParents(main, sub, 2);
    expect(plan.resolve(2)).toEqual({ kind: 'invalid', reason: 'parent_missing' });
    expect(plan.resolve(3)).toEqual({ kind: 'invalid', reason: 'parent_ambiguous' });
    expect(plan.resolve(4)).toEqual({ kind: 'invalid', reason: 'parent_required' });
    expect(plan.resolve(5)).toEqual({ kind: 'invalid', reason: 'parent_depth' });
    // Under its own subitem.
    const loop = planParents(main, subWith([{ row: 0, col: PARENT_COLUMN, text: 'Step' }]), 3);
    expect(loop.resolve(0)).toEqual({ kind: 'invalid', reason: 'parent_cycle' });
  });

  it('blames a moved subitem when its own subitems would go too deep', () => {
    const sub = subWith(
      [{ row: 0, col: PARENT_COLUMN, text: 'Other' }],
      [
        ...subBase,
        {
          key: 's3',
          itemId: 'S3',
          groupId: null,
          parentId: 'B',
          depth: 1,
          texts: { 's:name': 'Other', 's:status': '', [PARENT_COLUMN]: 'Beta' },
        },
      ],
    );
    const plan = planParents(main, sub, 2);
    expect(plan.resolve(0)).toEqual({ kind: 'invalid', reason: 'parent_depth' });
    // Untouched subitems keep their parent.
    expect(plan.resolve(1)).toEqual({ kind: 'value', value: { item_id: 'S1' } });
  });

  it('only matches items on one-level boards', () => {
    const sub = subWith([
      { row: 2, col: 's:name', text: 'x' },
      { row: 2, col: PARENT_COLUMN, text: 'Task' },
    ]);
    expect(planParents(main, sub, 1).resolve(2)).toEqual({ kind: 'invalid', reason: 'parent_missing' });
  });
});

describe('review and request', () => {
  it('reviews both sheets as one; builds subitems with refs, sub-board keys and moves', () => {
    const sub = subWith([
      { row: 1, col: PARENT_COLUMN, text: 'Beta' }, // move Step under an item
      { row: 0, col: PARENT_COLUMN, text: 'Alpha' }, // typed back to its own: no move
      { row: 2, col: 's:name', text: 'new under new' },
      { row: 2, col: 's:status', text: 'Fresh' },
      { row: 2, col: PARENT_COLUMN, text: 'gamma' },
      { row: 3, col: 's:name', text: 'orphan' },
      { row: 4, col: 's:name', text: 'child of orphan' },
      { row: 4, col: PARENT_COLUMN, text: 'orphan' },
    ]);
    const plan = planParents(main, sub, 2);
    const senv = subEnv(env, plan);
    const subReview = reviewSubitems(sub, senv);
    expect(subReview.invalid).toEqual([
      { row: 3, columnId: PARENT_COLUMN, text: '', reason: 'parent_required', sheet: 'sub' },
    ]);
    const review = mergeReviews(reviewDraft(main.base, main.draft, main.columns, env), subReview);
    expect(review.labels).toEqual([{ columnId: 's:status', name: 'Fresh', count: 1 }]);
    expect(review.created).toBe(1 + 3);

    const decisions = defaultDecisions(review, [...main.columns, ...sub.columns]);
    const m = buildBulkEdit(main.base, main.draft, main.columns, env, decisions, {
      groupId: 'g1',
      name: 'Item',
      ref: mainRowRef,
    });
    expect(m.request.rows).toEqual([{ ref: mainRowRef(4), name: 'Gamma', group_id: 'g1', cells: {} }]);
    const refs = new Set(m.request.rows.flatMap((r) => (r.ref ? [r.ref] : [])));
    const s = buildSubitems(sub, senv, decisions, { name: 'Subitem' }, refs);
    expect(s.subitems.labels).toEqual([
      { column_id: 'status', id: 1, label: 'Fresh', color: expect.any(String), index: 1 },
    ]);
    expect(s.subitems.rows).toEqual([
      { item_id: 'S2', parent_item_id: 'B', cells: {} },
      { ref: subRowRef(2), name: 'new under new', parent_ref: mainRowRef(4), cells: { status: { index: 1 } } },
    ]);
    // The orphan and the row under it are left out.
    expect(s.skipped).toBe(2);
    expect(bulkEditSchema.safeParse({ ...m.request, subitems: s.subitems }).success).toBe(true);
  });
});
