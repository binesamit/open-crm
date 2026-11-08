// SPDX-License-Identifier: AGPL-3.0-only
import { cellFromText, columnTypes } from '../columns';
export { parseCsv, sniffDelimiter } from './delimited';
import {
  BULK_EDIT_MAX_ROWS,
  type CellWrite,
  type Draft,
  draftText,
  SHEET_TEXT_TYPES,
  type SheetColumn,
  type SheetRow,
  setTexts,
} from './sheet';

/**
 * "ייבוא ועריכה" B3 — a file (.xlsx / .csv) into the sheet's draft: the file is read in the browser into a table of
 * texts, each file column is mapped to a board column (auto-matched by name and by the kind of values in it), to a
 * new column of some type, or ignored; rows may update existing items matched by a key column, the rest are new
 * rows. The result is the same draft a paste makes, so the B2 review and the one-batch write apply unchanged.
 */

/** Largest file the import reads (the browser parses it; a bulk edit holds BULK_EDIT_MAX_ROWS rows anyway). */
export const BULK_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Largest bulk-edit request body (the API reads up to 5 MB — MAX_REQUEST_BYTES); above it the review says so. */
export const BULK_EDIT_MAX_BYTES = 5 * 1024 * 1024;
/** New columns one import may add. */
export const BULK_IMPORT_MAX_NEW_COLUMNS = 50;
/** The sheet's id of a column the import will create on "finish" (never a valid column key: keys start a–z). */
export const NEW_COLUMN_PREFIX = '__new_';
export const isNewColumnId = (id: string) => id.startsWith(NEW_COLUMN_PREFIX);

/** One sheet of a file: its name (xlsx tab; the file name for csv) and its rows as text. */
export type ImportTable = { name: string; rows: string[][] };

// ---- reading ----

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * A spreadsheet value as the text the sheet would take: dates as `YYYY-MM-DD` (+ ` HH:MM` when there is a time),
 * numbers without exponent or float noise, booleans as true / false. xlsx dates come as UTC-midnight `Date`s.
 */
export const importCellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const h = v.getUTCHours();
    const m = v.getUTCMinutes();
    // A time-only cell (an Excel serial below 1) comes as a moment on 1899-12-30: just its time, so it reads as
    // an hour value and never as a date in 1899 (audit C2).
    if (v.getUTCFullYear() < 1900) return `${pad2(h)}:${pad2(m)}`;
    const date = `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
    return h || m ? `${date} ${pad2(h)}:${pad2(m)}` : date;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v)) return Math.abs(v) < 1e21 ? v.toFixed(0) : String(v);
    return String(Number(v.toPrecision(15)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

/** Drops empty rows and the empty columns at the end of every row (Excel keeps formatted blank cells). */
export const trimTable = (rows: string[][]): string[][] => {
  const kept = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const width = kept.reduce((w, r) => {
    let last = r.length - 1;
    while (last >= 0 && r[last]!.trim() === '') last--;
    return Math.max(w, last + 1);
  }, 0);
  return kept.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
};

/** Spreadsheet column letters: 0 → A, 25 → Z, 26 → AA. */
export const columnLetter = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** The file's columns: the first row's texts when it is a header row (a blank one → its letter), else letters. */
export const tableHeaders = (rows: string[][], header: boolean): string[] => {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return Array.from({ length: width }, (_, i) => (header ? rows[0]?.[i]?.trim() : '') || columnLetter(i));
};
export const tableData = (rows: string[][], header: boolean) => (header ? rows.slice(1) : rows);

// ---- what a column holds ----

const SAMPLE = 500;
const CHECKBOX_WORDS = new Set(['v', '✓', '✔', 'x', 'true', 'false', 'yes', 'no', 'כן', 'לא']);

/**
 * The column type a file column's values read as (for "new column" and to break ties when matching): every
 * non-empty value of the sample must read as that type. Few repeating values → status; long or multi-line → long
 * text; else text.
 */
export const sniffType = (values: string[]): string => {
  const sample = values
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, SAMPLE);
  if (!sample.length) return 'text';
  const all = (type: string) => sample.every((v) => cellFromText(type, v, {}) !== undefined);
  if (sample.every((v) => CHECKBOX_WORDS.has(v.toLocaleLowerCase()))) return 'checkbox';
  if (all('numbers')) return 'numbers';
  if (all('date')) return 'date';
  if (all('timeline') && sample.some((v) => /\s[–—-]\s/.test(v))) return 'timeline';
  if (all('email')) return 'email';
  if (sample.every((v) => /^https?:\/\//i.test(v) || /^www\./i.test(v))) return 'link';
  if (all('phone') && sample.every((v) => (v.match(/\d/g)?.length ?? 0) >= 7)) return 'phone';
  if (sample.some((v) => v.includes('\n') || v.length > 200)) return 'long_text';
  const distinct = new Set(sample.map((v) => v.toLocaleLowerCase()));
  if (
    sample.length >= 4 &&
    distinct.size <= 12 &&
    distinct.size * 2 <= sample.length &&
    [...distinct].every((v) => v.length <= 30)
  )
    return 'status';
  return 'text';
};

/** Types a new column of the import may have: the ones the sheet can type into. */
export const IMPORT_NEW_TYPES: readonly string[] = [...SHEET_TEXT_TYPES];

/** Settings of a new column the import makes: labels start empty (every value is then a new label to add). */
export const newColumnSettings = (type: string): Record<string, unknown> => {
  const def = columnTypes.get(type);
  const base = (def?.defaultSettings ?? {}) as Record<string, unknown>;
  return def?.labelIds ? { ...base, labels: [] } : { ...base };
};

// ---- mapping ----

/** Where one file column goes. */
export type ImportTarget =
  { kind: 'column'; columnId: string } | { kind: 'new'; type: string; title: string } | { kind: 'ignore' };

/** Sheet columns a file column can fill: the name, typed columns, the group (new rows), the parent (subitems). */
export const importTargets = (columns: SheetColumn[]) =>
  columns.filter(
    (c) => c.mode === 'name' || c.mode === 'edit' || c.mode === 'secret' || c.mode === 'group' || c.mode === 'parent',
  );

/** Columns existing items can be matched by: the name, any text-like column, an item id. */
const KEY_TYPES = new Set(['text', 'email', 'phone', 'link', 'numbers', 'item_id']);
export const matchKeyColumns = (columns: SheetColumn[]) =>
  columns.filter((c) => c.mode === 'name' || (KEY_TYPES.has(c.type) && c.mode !== 'group'));

const normTitle = (s: string) =>
  s
    .toLocaleLowerCase()
    .replace(/[\s_\-.:,;'"`״׳()[\]{}/\\#*]+/g, '')
    .trim();
const NAME_WORDS = new Set(['name', 'שם', 'item', 'פריט', 'title', 'כותרת', 'נושא', 'subject'].map(normTitle));
/** File headers that mean the parent of a subitem (B4). */
const PARENT_WORDS = new Set(['parent', 'parent item', 'פריט אב', 'אב', 'פריט הורה', 'הורה'].map(normTitle));

/** Edit distance, capped (titles are short). */
const distance = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
};
const similar = (a: string, b: string) =>
  (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) ||
  (Math.min(a.length, b.length) >= 4 && distance(a, b) <= (Math.min(a.length, b.length) >= 7 ? 2 : 1));

/** Whether values sniffed as `sniffed` fit a column of `type` (text-ish columns take anything). */
const fits = (sniffed: string, type: string) =>
  sniffed === type ||
  ['text', 'long_text', 'name', 'group', 'parent'].includes(type) ||
  (type === 'dropdown' && (sniffed === 'status' || sniffed === 'text')) ||
  (type === 'tags' && (sniffed === 'status' || sniffed === 'text')) ||
  (type === 'status' && sniffed === 'text') ||
  (type === 'people' && (sniffed === 'text' || sniffed === 'email' || sniffed === 'status')) ||
  (type === 'timeline' && sniffed === 'date') ||
  (type === 'rating' && sniffed === 'numbers');

/**
 * The first guess of the mapping: (1) same title (normalized; "name" / "שם" / "item"… → the name column),
 * (2) a similar title whose type fits the values, (3) the one column of an unusual type the values read as (email,
 * phone, link, date, timeline) — each board column once. No column for the name → the first unmapped text column
 * becomes the name. The rest are ignored (the user may make them new columns).
 */
export const autoMap = (headers: string[], data: string[][], columns: SheetColumn[]): ImportTarget[] => {
  const targets = importTargets(columns);
  const sniffed = headers.map((_, i) => sniffType(data.map((r) => r[i] ?? '')));
  const out: (ImportTarget | null)[] = headers.map(() => null);
  const used = new Set<string>();
  const take = (i: number, c: SheetColumn) => {
    out[i] = { kind: 'column', columnId: c.id };
    used.add(c.id);
  };
  const name = targets.find((c) => c.mode === 'name');
  headers.forEach((h, i) => {
    const n = normTitle(h);
    if (!n) return;
    const hit = targets.find((c) => !used.has(c.id) && normTitle(c.title) === n);
    const parent = targets.find((c) => c.mode === 'parent' && !used.has(c.id));
    if (hit) take(i, hit);
    else if (name && !used.has(name.id) && NAME_WORDS.has(n)) take(i, name);
    else if (parent && PARENT_WORDS.has(n)) take(i, parent);
  });
  headers.forEach((h, i) => {
    if (out[i]) return;
    const n = normTitle(h);
    if (!n) return;
    const hit = targets.find((c) => !used.has(c.id) && similar(normTitle(c.title), n) && fits(sniffed[i]!, c.type));
    if (hit) take(i, hit);
  });
  for (const type of ['email', 'phone', 'link', 'date', 'timeline']) {
    const files = headers.map((_, i) => i).filter((i) => !out[i] && sniffed[i] === type);
    const cols = targets.filter((c) => !used.has(c.id) && c.type === type);
    if (files.length === 1 && cols.length === 1) take(files[0]!, cols[0]!);
  }
  if (name && !used.has(name.id)) {
    const i = headers.findIndex((_, j) => !out[j] && sniffed[j] === 'text');
    if (i >= 0) take(i, name);
  }
  return out.map((x) => x ?? { kind: 'ignore' });
};

/** A suggested "new column" target for a file column: its header as title, its values' type. */
export const newColumnTarget = (header: string, values: string[]): ImportTarget => ({
  kind: 'new',
  type: sniffType(values),
  title: header.trim().slice(0, 255) || 'Column',
});

// ---- into the draft ----

const normKey = (s: string) => s.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export type ImportResult = {
  draft: Draft;
  /** Existing rows (or rows already in the draft) the file updated. */
  updated: number;
  /** New rows added at the end. */
  created: number;
  /** Cells that could not go in (a frozen column). */
  skipped: number;
  /** Rows of the draft after the import; above BULK_EDIT_MAX_ROWS nothing is applied (`draft` is the input). */
  rows: number;
  tooMany: boolean;
};

/**
 * The file's data rows into the draft. `columnFor[i]` = the sheet column id file column i writes (null = ignored;
 * the caller has added new columns to `columns` already). With `matchBy` (a sheet column some file column maps
 * to), a row whose key equals a row's text there (case- and space-insensitive) updates that row — empty file cells
 * then leave the row's value alone; a key repeated in the file updates the same row. Other rows are added at the
 * end. Rows of only empty cells are skipped. Nothing is applied when the rows would not fit (BULK_EDIT_MAX_ROWS).
 */
export const applyImport = (
  base: SheetRow[],
  d: Draft,
  columns: SheetColumn[],
  data: string[][],
  columnFor: (string | null)[],
  matchBy: string | null,
): ImportResult => {
  const index = new Map(columns.map((c, i) => [c.id, i]));
  const writable = columnFor.map((id) => {
    const at = id === null ? undefined : index.get(id);
    const c = at === undefined ? undefined : columns[at];
    return c && c.mode !== 'frozen' ? at! : -1;
  });
  const keyFile = matchBy ? columnFor.indexOf(matchBy) : -1;
  const keys = new Map<string, number>();
  const total = base.length + d.added;
  if (keyFile >= 0)
    for (let r = 0; r < total; r++) {
      const k = normKey(draftText(base, d, r, matchBy!));
      if (k && !keys.has(k)) keys.set(k, r);
    }
  const writes: CellWrite[] = [];
  let next = total;
  const touched = new Set<number>();
  let created = 0;
  let skipped = 0;
  for (const line of data) {
    if (!line.some((t, i) => writable[i]! >= 0 && t.trim() !== '')) continue;
    const key = keyFile >= 0 ? normKey(line[keyFile] ?? '') : '';
    let row = key ? keys.get(key) : undefined;
    const fresh = row === undefined;
    if (fresh) {
      row = next++;
      created++;
      if (key) keys.set(key, row);
    } else if (row! < total) touched.add(row!);
    line.forEach((text, i) => {
      if (columnFor[i] === null || columnFor[i] === undefined) return;
      if (writable[i]! < 0) {
        if (text.trim() && i !== keyFile) skipped++;
        return;
      }
      // A matched row keeps its own key text (matching ignores case and spaces) and the values the file leaves empty.
      if (!fresh && (i === keyFile || text.trim() === '')) return;
      writes.push({ row: row!, col: writable[i]!, text });
    });
  }
  const updated = touched.size;
  if (next > BULK_EDIT_MAX_ROWS) return { draft: d, updated, created, skipped, rows: next, tooMany: true };
  const res = setTexts(base, d, columns, writes);
  return { draft: res.draft, updated, created, skipped: skipped + res.skipped, rows: next, tooMany: false };
};
