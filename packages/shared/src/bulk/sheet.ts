// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes, ownWriter } from '../columns';
import { parseCsv } from './delimited';

/**
 * "ייבוא ועריכה" (12-ROADMAP, bulk edit like a spreadsheet; called "עריכה גדולה" until): the board as one flat sheet of text cells, edited
 * as a draft that is written only on "finish". This file is the sheet model — which columns can be typed into,
 * the text a cell shows for editing, and the draft operations (type, paste a block, clear a range) — shared by the
 * sheet UI and, later, by file import (B3), which fills the same draft from a mapped file.
 */

/** The sheet's own column for new rows: the group they go to (by title). Existing rows keep theirs. */
export const GROUP_COLUMN = '__group';
/**
 * The subitems sheet's own column (B4): the parent item, by name — an item of the items sheet, or (boards deeper
 * than one level) a subitem. Typed on a new row it is required; changed on an existing one it moves the subitem.
 */
export const PARENT_COLUMN = '__parent';

/**
 * The most rows a draft may hold (existing + new) — the server takes as many in one batch. Same as the export cap
 * (10,000), so an exported board can be edited in a file and imported back.
 */
export const BULK_EDIT_MAX_ROWS = 10_000;

/**
 * `name`: the item name; `group` / `parent`: the pseudo-columns above; `edit`: typed as text and parsed per type;
 * `frozen`: computed or engine-written (formula, mirror, item id, created/updated, time tracking, files, votes,
 * relations) or restricted for this user — shown greyed, never written; `secret`: a secret column
 * write-only — its values are never loaded, a typed / imported text is sent once and encrypted by the server.
 */
export type SheetColumnMode = 'name' | 'group' | 'parent' | 'edit' | 'secret' | 'frozen';

export type SheetColumnInput = {
  id: string;
  type: string;
  title: string;
  settings: Record<string, unknown>;
  /** The board says this user may not edit the column (05 §6.1). */
  restricted_edit?: boolean;
};
export type SheetColumn = SheetColumnInput & { mode: SheetColumnMode };

/** Types a sheet cell can be typed into: the ones `cellFromText` reads (07 §10 paste). */
export const SHEET_TEXT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'long_text',
  'numbers',
  'rating',
  'checkbox',
  'email',
  'phone',
  'link',
  'date',
  'timeline',
  'status',
  'dropdown',
  'tags',
  'people',
  'hour',
  'week',
  'world_clock',
  'color_picker',
  'country',
  'location',
]);

export const sheetColumnMode = (c: SheetColumnInput): SheetColumnMode => {
  if (c.id === GROUP_COLUMN) return 'group';
  if (c.id === PARENT_COLUMN) return 'parent';
  if (c.type === 'name') return 'name';
  const def = columnTypes.get(c.type);
  if (def?.engine === 'secret') return c.restricted_edit ? 'frozen' : 'secret';
  if (!def || def.readOnly || def.storage !== 'cell' || ownWriter(def) || def.engine === 'links') return 'frozen';
  if (c.restricted_edit) return 'frozen';
  return SHEET_TEXT_TYPES.has(c.type) ? 'edit' : 'frozen';
};

export const sheetColumns = (cols: SheetColumnInput[]): SheetColumn[] =>
  cols.map((c) => ({ ...c, mode: sheetColumnMode(c) }));

/**
 * The text a cell shows in the sheet: what typing it back would give the same value. Mostly the cell's display
 * text; numbers without unit / thousands, emails and links by address (their display text is a label).
 */
export const sheetText = (type: string, cell: { value: unknown; text: string | null } | undefined): string => {
  // A secret is never in the sheet: only whether it is set (`SheetRow.secrets`).
  if (type === 'secret' || !cell || cell.value === null || cell.value === undefined) return '';
  const v = cell.value as Record<string, unknown>;
  if (type === 'numbers' && typeof cell.value === 'number') return String(cell.value);
  if (type === 'numbers' && typeof cell.value === 'string') return cell.value;
  if (type === 'email' && typeof v.email === 'string') return v.email;
  if (type === 'link' && typeof v.url === 'string') return v.url;
  if (type === 'long_text' && typeof v.text === 'string') return v.text;
  return cell.text ?? '';
};

/** One row as loaded: an item (or, with `itemId: null`, nothing yet) and the original text of every column. */
export type SheetRow = {
  key: string;
  itemId: string | null;
  groupId: string | null;
  texts: Record<string, string>;
  /** Subitems sheet (B4): the item's parent and level (1 = a subitem of an item). */
  parentId?: string | null;
  depth?: number;
  /** Secret columns whose cell has a value — shown masked; a new text there replaces it. */
  secrets?: string[];
};

/**
 * The draft: changed texts per row index (existing rows first, then new ones), and how many new rows follow the
 * loaded ones. Immutable — every operation returns a new draft, so the sheet can undo its own steps.
 */
export type Draft = { edits: Record<number, Record<string, string>>; added: number };
export const EMPTY_DRAFT: Draft = { edits: {}, added: 0 };

export const draftRowCount = (base: SheetRow[], d: Draft) => base.length + d.added;
export const isNewRow = (base: SheetRow[], row: number) => row >= base.length;

export const draftText = (base: SheetRow[], d: Draft, row: number, col: string): string =>
  d.edits[row]?.[col] ?? base[row]?.texts[col] ?? '';

export const isEdited = (base: SheetRow[], d: Draft, row: number, col: string) =>
  d.edits[row]?.[col] !== undefined && d.edits[row]![col] !== (base[row]?.texts[col] ?? '');

/** Whether this cell takes text: frozen columns never; the group column only on new rows. */
export const writable = (base: SheetRow[], column: SheetColumn, row: number) =>
  column.mode === 'name' ||
  column.mode === 'edit' ||
  column.mode === 'secret' ||
  column.mode === 'parent' ||
  (column.mode === 'group' && isNewRow(base, row));

export type CellWrite = { row: number; col: number; text: string };

/**
 * Writes texts into the draft. A row past the end adds new rows up to it (paste below the last row); a cell that
 * cannot take text (frozen, a past-the-end column) is skipped and counted. A text equal to the loaded one drops
 * the edit; a trailing new row left empty is removed.
 */
export const setTexts = (
  base: SheetRow[],
  d: Draft,
  columns: SheetColumn[],
  writes: CellWrite[],
): { draft: Draft; skipped: number } => {
  const edits: Draft['edits'] = { ...d.edits };
  let added = d.added;
  let skipped = 0;
  const touched = new Set<number>();
  for (const w of writes) {
    const column = columns[w.col];
    if (!column || w.row < 0 || w.row >= BULK_EDIT_MAX_ROWS || !writable(base, column, w.row)) {
      skipped++;
      continue;
    }
    if (w.row >= base.length + added) added = w.row - base.length + 1;
    if (!touched.has(w.row)) {
      edits[w.row] = { ...edits[w.row] };
      touched.add(w.row);
    }
    const original = base[w.row]?.texts[column.id] ?? '';
    const text = column.mode === 'name' || column.mode === 'parent' ? w.text.replace(/[\r\n]+/g, ' ') : w.text;
    if (text === original && w.row < base.length) delete edits[w.row]![column.id];
    else edits[w.row]![column.id] = text;
    if (!Object.keys(edits[w.row]!).length) delete edits[w.row];
  }
  // New rows emptied at the end go away (a cut or Delete of the rows just pasted).
  while (added > 0 && !rowHasText(edits[base.length + added - 1])) {
    delete edits[base.length + added - 1];
    added--;
  }
  return { draft: { edits, added }, skipped };
};

export const rowHasText = (cells: Record<string, string> | undefined) =>
  !!cells && Object.values(cells).some((t) => t.trim() !== '');

/** A rectangular block (Excel / TSV) with its top-left cell at `at`; rows past the end become new rows. */
export const pasteBlock = (
  base: SheetRow[],
  d: Draft,
  columns: SheetColumn[],
  at: { row: number; col: number },
  block: string[][],
) =>
  setTexts(
    base,
    d,
    columns,
    block.flatMap((line, i) => line.map((text, j) => ({ row: at.row + i, col: at.col + j, text }))),
  );

export type SheetRange = { r0: number; r1: number; c0: number; c1: number };

/** Every cell of a range, one write each (Delete clears, a single copied value fills the range). */
export const rangeWrites = (r: SheetRange, text: (row: number, col: number) => string): CellWrite[] => {
  const out: CellWrite[] = [];
  for (let row = r.r0; row <= r.r1; row++)
    for (let col = r.c0; col <= r.c1; col++) out.push({ row, col, text: text(row, col) });
  return out;
};

/** The texts of a range as a block (Ctrl+C). */
export const rangeBlock = (base: SheetRow[], d: Draft, columns: SheetColumn[], r: SheetRange): string[][] => {
  const out: string[][] = [];
  for (let row = r.r0; row <= r.r1; row++) {
    const line: string[] = [];
    for (let col = r.c0; col <= r.c1; col++)
      // A secret column copies as empty (its text never leaves the cell).
      line.push(columns[col]?.mode === 'secret' ? '' : draftText(base, d, row, columns[col]?.id ?? ''));
    out.push(line);
  }
  return out;
};

/** A changed cell of the draft: what the review and the request are built from. */
export type DraftChange = { row: number; itemId: string | null; column: SheetColumn; text: string };

/** Changed cells of existing rows, and every non-empty cell of new rows (new rows with no text are ignored). */
export const draftChanges = (base: SheetRow[], d: Draft, columns: SheetColumn[]): DraftChange[] => {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const out: DraftChange[] = [];
  for (const [key, cells] of Object.entries(d.edits)) {
    const row = Number(key);
    const fresh = isNewRow(base, row);
    if (fresh && !rowHasText(cells)) continue;
    for (const [colId, text] of Object.entries(cells)) {
      const column = byId.get(colId);
      if (!column || !writable(base, column, row)) continue;
      if (fresh ? text.trim() === '' : text === (base[row]?.texts[colId] ?? '')) continue;
      // A secret is never cleared from the sheet: an empty text leaves the stored value alone.
      if (column.mode === 'secret' && text === '') continue;
      out.push({ row, itemId: base[row]?.itemId ?? null, column, text });
    }
  }
  return out.sort((a, b) => a.row - b.row);
};

/** TSV as Excel writes it: tabs and newlines; quoted fields may hold either. */
/** Pasted TSV (Excel, Sheets) → rows: the CSV parser with a tab (duplication #5). */
export const parseTsv = (text: string): string[][] => parseCsv(text, '\t');

const tsvField = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const toTsv = (rows: string[][]) => rows.map((r) => r.map(tsvField).join('\t')).join('\n');
