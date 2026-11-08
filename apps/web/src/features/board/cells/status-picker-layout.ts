// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pal40 — the status picker's layout: the column's labels flow down COLUMNS of at most
 * `PER_COLUMN` chips; past that they flow into more columns instead of one tall list. Up to `ANCHORED_COLUMNS`
 * columns the picker hangs off its cell as before; more (or a picker taller than the room above and below the cell)
 * and it floats beside the centre of the viewport instead (`placeCentred`), never over the cell. Wider than the
 * viewport, its columns scroll across inside it (RTL: they start on the right).
 */
export const STATUS_PICKER = {
  /** Chips in one column before the labels flow into another one. */
  PER_COLUMN: 8,
  /** Up to this many columns the picker stays anchored to its cell. */
  ANCHORED_COLUMNS: 2,
  /** One column (px) — the single list keeps its old width (w-56 less the padding). */
  COLUMN_WIDTH: 184,
  SINGLE_WIDTH: 224,
  COLUMN_GAP: 6,
  ROW_GAP: 4,
  CHIP_HEIGHT: 32,
  /** The panel's padding (each side) and the footer below the chips (clear, edit labels). */
  PADDING: 8,
  FOOTER: 72,
  MARGIN: 8,
} as const;

export type StatusPickerLayout = {
  columns: number;
  rows: number;
  /** Floats beside the centre of the viewport (not anchored to the cell). */
  centred: boolean;
  /** The chips' full width and the panel's width (capped by the viewport: then the chips scroll across). */
  contentWidth: number;
  panelWidth: number;
  scrollsAcross: boolean;
};

/** Columns for `count` labels: `PER_COLUMN` per column. */
export const statusPickerColumns = (count: number) => Math.max(1, Math.ceil(count / STATUS_PICKER.PER_COLUMN));

/** Rows: the labels spread evenly over the columns (9 → 5 + 4, not 8 + 1). */
export const statusPickerRows = (count: number) => Math.max(1, Math.ceil(count / statusPickerColumns(count)));

/** The chips' height (px) for `rows` rows, plus the padding and the footer: the panel's natural height. */
export const statusPickerHeight = (rows: number) =>
  rows * STATUS_PICKER.CHIP_HEIGHT +
  (rows - 1) * STATUS_PICKER.ROW_GAP +
  STATUS_PICKER.FOOTER +
  2 * STATUS_PICKER.PADDING;

/**
 * The layout for `count` labels opened from a cell at `anchor` (its top / bottom, px) in a `viewport`.
 * `anchor` / `viewport` may be left out (unit tests of the column logic, the server-side screenshot of nothing).
 */
export const statusPickerLayout = (
  count: number,
  anchor?: { top: number; bottom: number } | null,
  viewport?: { width: number; height: number } | null,
): StatusPickerLayout => {
  const S = STATUS_PICKER;
  const columns = statusPickerColumns(count);
  const rows = statusPickerRows(count);
  const contentWidth =
    columns === 1 ? S.SINGLE_WIDTH - 2 * S.PADDING : columns * S.COLUMN_WIDTH + (columns - 1) * S.COLUMN_GAP;
  const natural = contentWidth + 2 * S.PADDING;
  // Too tall for the room on either side of the cell: anchored, it would cover the cell.
  const height = statusPickerHeight(rows);
  const room =
    anchor && viewport
      ? Math.max(anchor.top - S.MARGIN - 4, viewport.height - S.MARGIN - anchor.bottom - 4)
      : Number.POSITIVE_INFINITY;
  const centred = columns > S.ANCHORED_COLUMNS || height > room;
  const maxWidth = viewport ? viewport.width - 2 * S.MARGIN : Number.POSITIVE_INFINITY;
  const panelWidth = Math.min(natural, maxWidth);
  return { columns, rows, centred, contentWidth, panelWidth, scrollsAcross: natural > maxWidth };
};

/**
 * Arrow keys over chips laid out down columns of `rows` (index = column × rows + row): ↑ / ↓ inside a column,
 * ← / → across columns — in RTL the next column is on the left. Home / End: the first / last chip. Stays put at an
 * edge; `null` = not a navigation key.
 */
export const statusPickerMove = (index: number, key: string, count: number, rows: number, rtl: boolean) => {
  if (count <= 0) return null;
  const last = count - 1;
  const row = index % rows;
  const next = rtl ? 'ArrowLeft' : 'ArrowRight';
  const prev = rtl ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case 'ArrowDown':
      return row < rows - 1 && index < last ? index + 1 : index;
    case 'ArrowUp':
      return row > 0 ? index - 1 : index;
    case next: {
      if (index + rows <= last) return index + rows;
      // The next column is shorter: its last chip.
      return Math.floor(last / rows) > Math.floor(index / rows) ? last : index;
    }
    case prev:
      return index - rows >= 0 ? index - rows : index;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
};

/**
 * c9 — the label editor lays the labels out in the picker's own columns, so each label is edited
 * where it will appear: `items` split in reading order into columns of `statusPickerRows` (the picker's
 * `grid-flow-col` fills them the same way; RTL: the first column on the right). `single` = one list (phones, where
 * the picker is one list in the bottom sheet).
 */
export const statusPickerColumnsOf = <T>(items: readonly T[], single = false): T[][] => {
  if (single || items.length === 0) return [[...items]];
  const rows = statusPickerRows(items.length);
  const columns: T[][] = [];
  for (let i = 0; i < items.length; i += rows) columns.push(items.slice(i, i + rows));
  return columns;
};

/** The label editor's columns: wider than a chip (handle, colour, name, done, delete — the old single list's w-72). */
export const LABEL_EDITOR = { COLUMN_WIDTH: 288, COLUMN_GAP: 12 } as const;
