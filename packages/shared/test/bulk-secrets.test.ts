// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  buildBulkEdit,
  bulkEditSchema,
  draftChanges,
  EMPTY_DRAFT,
  importTargets,
  rangeBlock,
  reviewDraft,
  setTexts,
  sheetColumns,
  sheetText,
  type BulkEnv,
  type SheetRow,
} from '../src';

/**
 * secret columns in "ייבוא ועריכה" — write-only in the sheet and the file import. Their values are
 * never loaded or shown, a typed text goes in `rows[].secrets` (never `cells`), an empty text never clears a stored
 * secret, the review counts new ones and ones over a stored value, and a copied range leaves them out.
 */
const PLAIN = 'Sheet-S3cret-9911';
const env: BulkEnv = { people: [], tags: [], groups: [{ id: 'g1', title: 'Group' }] };
const columns = sheetColumns([
  { id: 'name', type: 'name', title: 'Name', settings: {} },
  { id: 'pwd', type: 'secret', title: 'Password', settings: {} },
  { id: 'locked', type: 'secret', title: 'Locked', settings: {}, restricted_edit: true },
  { id: 'note', type: 'text', title: 'Note', settings: {} },
]);
const base: SheetRow[] = [
  { key: 'a', itemId: 'A', groupId: 'g1', texts: { name: 'Has one', pwd: '', note: '' }, secrets: ['pwd'] },
  { key: 'b', itemId: 'B', groupId: 'g1', texts: { name: 'Empty', pwd: '', note: '' } },
];
const col = (id: string) => columns.findIndex((c) => c.id === id);

describe('secret columns in the sheet', () => {
  it('is write-only (frozen when the column is restricted for me) and never loads a value', () => {
    expect(columns.map((c) => c.mode)).toEqual(['name', 'secret', 'frozen', 'edit']);
    expect(sheetText('secret', { value: { set: true }, text: '••••' })).toBe('');
    expect(importTargets(columns).map((c) => c.id)).toEqual(['name', 'pwd', 'note']);
  });

  it('a typed secret goes in `secrets`, never `cells`; an empty text never clears; the review counts both kinds', () => {
    const { draft } = setTexts(base, EMPTY_DRAFT, columns, [
      { row: 0, col: col('pwd'), text: PLAIN },
      { row: 1, col: col('pwd'), text: PLAIN },
      { row: 1, col: col('note'), text: 'x' },
      { row: 2, col: col('name'), text: 'New' },
      { row: 2, col: col('pwd'), text: PLAIN },
      { row: 0, col: col('locked'), text: PLAIN }, // frozen: skipped
    ]);
    const review = reviewDraft(base, draft, columns, env);
    expect(review.secrets).toEqual({ set: 2, replace: 1 });
    const { request } = buildBulkEdit(
      base,
      draft,
      columns,
      env,
      { labels: {}, tags: {} },
      { groupId: 'g1', name: 'x' },
    );
    expect(request.rows).toEqual([
      { item_id: 'A', cells: {}, secrets: { pwd: PLAIN } },
      { item_id: 'B', cells: { note: 'x' }, secrets: { pwd: PLAIN } },
      { name: 'New', group_id: 'g1', cells: {}, secrets: { pwd: PLAIN } },
    ]);
    expect(bulkEditSchema.safeParse(request).success).toBe(true);
    // Clearing the typed text leaves the stored secret alone (nothing to send).
    const cleared = setTexts(base, draft, columns, [{ row: 0, col: col('pwd'), text: '' }]).draft;
    expect(draftChanges(base, cleared, columns).some((c) => c.row === 0 && c.column.id === 'pwd')).toBe(false);
  });

  it('an invalid (too long) secret is listed without its text; a copied range leaves secrets out', () => {
    const long = `${PLAIN}${'x'.repeat(10_001)}`;
    const { draft } = setTexts(base, EMPTY_DRAFT, columns, [
      { row: 1, col: col('pwd'), text: long },
      { row: 1, col: col('note'), text: 'n' },
    ]);
    const review = reviewDraft(base, draft, columns, env);
    expect(review.invalid).toEqual([{ row: 1, columnId: 'pwd', text: '' }]);
    expect(JSON.stringify(review)).not.toContain(PLAIN);
    expect(rangeBlock(base, draft, columns, { r0: 1, r1: 1, c0: col('pwd'), c1: col('note') })).toEqual([
      ['', '', 'n'],
    ]);
  });
});
