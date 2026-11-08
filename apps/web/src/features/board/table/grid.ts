// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cellFromText, getRegion, newId, t, type Column, type TextPerson } from '@bines/shared';
import { hasOpenLayers } from '@bines/ui';
import { isTyping } from '../../../lib/keys';
import { showToast } from '../../../lib/toast';
import { FILE_PASTE_ATTR, FILE_PASTE_EVENT, transferFiles } from '../cells/file-paste';

/**
 * Keyboard grid of the table (07 §10, 14 §3/§15): one active cell — a row (item or subitem) and a column index,
 * -1 = the name column — and an optional range (Shift+arrows). Arrows (RTL-aware), Tab / Shift+Tab, Enter edits
 * (opens the cell's own editor), Delete clears, Esc leaves; Ctrl+C / X / V copy, cut and paste cells as TSV
 * (Excel) plus the exact values for a paste inside Bines. Rows register what can be done with them while
 * rendered; the listeners act only when focus is on the page or in the table, never while typing or with a
 * popover / menu / dialog open.
 */
export type ActiveCell = { itemId: string; col: number };

/** What a rendered row offers the grid. */
export type GridRow = {
  boardId: string;
  /** Value columns in order (the name column is -1). */
  columns: Column[];
  /** The cell element (-1 = name) — clicked to edit, focused when active. */
  cellEl: (col: number) => HTMLElement | null;
  value: (col: number) => unknown;
  text: (col: number) => string;
  editable: (col: number) => boolean;
  /**
   * Writes a cell (null clears); on the name column, renames. `gesture` groups the writes of one paste. `spread`:
   * the paste / clear was on this one cell alone — on a checked row it fills the column on every checked row.
   */
  write: (col: number, value: unknown, gesture?: string, spread?: boolean) => void;
  rename: () => void;
};

export type Grid = {
  active: ActiveCell | null;
  setActive: (cell: ActiveCell | null) => void;
  /** Whether a cell is inside the selected range (not set when only one cell is active). */
  inRange: (itemId: string, col: number) => boolean;
  register: (itemId: string, row: GridRow) => () => void;
  /** From the cell menu (the clipboard events do the same from the keyboard). */
  copy: (cut: boolean) => void;
  paste: () => void;
  clear: () => void;
  /** Opens the active cell's editor (after the menu that asked has closed). */
  edit: () => void;
};

export const GridContext = createContext<Grid | null>(null);
export const useGrid = () => useContext(GridContext);

/** The cell element of a row: `[data-cell="<col>"]` inside the row element. */
export const cellIn = (rowEl: HTMLElement | null, col: number) =>
  rowEl?.querySelector<HTMLElement>(`[data-cell="${col}"]`) ?? null;

const isRtl = () => document.documentElement.dir === 'rtl';

/**
 * What opens a cell's editor: the element marked `data-cell-edit` (when the cell's handler is on an inner
 * element), else the cell's root — every editable cell opens on a click there.
 */
const editorOf = (cell: HTMLElement | null) =>
  cell?.querySelector<HTMLElement>('[data-cell-edit]') ?? (cell?.firstElementChild as HTMLElement | null) ?? null;

/** Internal clipboard flavour: the exact values, so a paste inside Bines keeps labels, people, links. */
export const CELLS_MIME = 'application/x-bines-cells';
type Copied = { type: string | null; column_id: string | null; board_id: string; value: unknown; text: string };

/** At most this many cells per paste (one request each). */
const MAX_PASTE = 1000;

/** The last copy from the grid: a paste of the same text (read back from the system clipboard) uses its values. */
let lastCopy: { tsv: string; cells: Copied[][] } | null = null;

const tsvField = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const toTsv = (rows: string[][]) => rows.map((r) => r.map(tsvField).join('\t')).join('\n');

/** TSV as Excel writes it: tabs and newlines, quoted fields may hold either. */
export const parseTsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === '\t') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

/** The selected rectangle: rows (item ids, top to bottom) × columns [c0, c1]; the active cell alone if no range. */
const rect = (cur: ActiveCell, from: ActiveCell | null, list: string[]) => {
  const a = from ?? cur;
  const i0 = list.indexOf(a.itemId);
  const i1 = list.indexOf(cur.itemId);
  const [r0, r1] = i0 < 0 || i1 < 0 ? [i1, i1] : [Math.min(i0, i1), Math.max(i0, i1)];
  return {
    ids: r0 < 0 ? [cur.itemId] : list.slice(r0, r1 + 1),
    c0: Math.min(a.col, cur.col),
    c1: Math.max(a.col, cur.col),
  };
};

/** The selection is one value cell (not a range, not the name). */
const oneCell = (r: ReturnType<typeof rect>) => r.ids.length === 1 && r.c0 === r.c1 && r.c0 >= 0;

export const useGridState = ({
  order,
  tableRef,
  reveal,
  people,
  rowsSelected,
}: {
  /** Navigable rows (items and open subitems) top to bottom. */
  order: string[];
  tableRef: React.RefObject<HTMLElement | null>;
  /** Scrolls a row (by item id) into the rendered window. */
  reveal: (itemId: string) => void;
  /** Members and teams, for pasting names into people cells. */
  people: TextPerson[];
  /** Rows are checked: Delete belongs to the batch bar (delete the items, 07 §10), not to the cell. */
  rowsSelected: boolean;
}): Grid => {
  const [active, setActiveState] = useState<ActiveCell | null>(null);
  const [anchor, setAnchor] = useState<ActiveCell | null>(null);
  const rows = useRef(new Map<string, GridRow>());
  const state = useRef({ active, anchor, order, people, rowsSelected });
  useEffect(() => {
    state.current = { active, anchor, order, people, rowsSelected };
  });

  const setActive = useCallback((cell: ActiveCell | null) => {
    setActiveState(cell);
    setAnchor(null);
  }, []);

  // The active cell takes focus (and comes into view) whenever it changes.
  useEffect(() => {
    if (!active) return;
    const el = rows.current.get(active.itemId)?.cellEl(active.col);
    if (el && document.activeElement !== el && !isTyping(document.activeElement)) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [active]);

  /** The selected cells as text rows and exact values (rows not rendered are skipped). */
  const copyOut = useCallback(() => {
    const { active: cur, anchor: from, order: list } = state.current;
    if (!cur) return null;
    const r = rect(cur, from, list);
    const cells: Copied[][] = [];
    for (const id of r.ids) {
      const row = rows.current.get(id);
      if (!row) continue;
      const line: Copied[] = [];
      for (let c = r.c0; c <= Math.min(r.c1, row.columns.length - 1); c++) {
        const col = c < 0 ? null : row.columns[c]!;
        line.push({
          type: col?.type ?? null,
          column_id: col?.id ?? null,
          board_id: row.boardId,
          value: row.value(c),
          text: row.text(c),
        });
      }
      cells.push(line);
    }
    const tsv = toTsv(cells.map((l) => l.map((c) => c.text)));
    lastCopy = { tsv, cells };
    return { tsv, cells };
  }, []);

  /** Clears the editable value cells of the selection. */
  const clearCells = useCallback(() => {
    const { active: cur, anchor: from, order: list } = state.current;
    if (!cur) return;
    const r = rect(cur, from, list);
    const gesture = newId();
    const one = oneCell(r);
    for (const id of r.ids) {
      const row = rows.current.get(id);
      for (let c = Math.max(0, r.c0); c <= r.c1; c++)
        if (row?.editable(c) && row.value(c) != null) row.write(c, null, gesture, one);
    }
  }, []);

  /** Pastes text rows (and, when they came from the grid, their exact values) at the selection. */
  const pasteCells = useCallback((texts: string[][], source: Copied[][] | null) => {
    const { active: cur, anchor: from, order: list, people } = state.current;
    if (!cur || !texts.length) return;
    const r = rect(cur, from, list);
    // One copied cell fills the whole selected range; otherwise the block lands at the range's corner.
    const single = texts.length === 1 && texts[0]!.length === 1;
    const startIndex = Math.max(0, list.indexOf(r.ids[0]!));
    const targetIds = single ? r.ids : list.slice(startIndex, startIndex + texts.length);
    let skipped = 0;
    let written = 0;
    const gesture = newId();
    targetIds.forEach((id, ri) => {
      const row = rows.current.get(id);
      const srcRow = single ? 0 : ri;
      const width = single ? r.c1 - r.c0 + 1 : texts[srcRow]!.length;
      for (let k = 0; k < width; k++) {
        const c = r.c0 + k;
        const sk = single ? 0 : k;
        if (!row || c >= row.columns.length || written >= MAX_PASTE) {
          skipped++;
          continue;
        }
        const text = texts[srcRow]![sk] ?? '';
        const src = source?.[srcRow]?.[sk];
        if (c < 0) {
          if (row.editable(-1) && text.trim()) {
            row.write(-1, text.trim(), gesture);
            written++;
          } else skipped++;
          continue;
        }
        const col = row.columns[c]!;
        // Same column, or the same type with a value that does not depend on the column (not labels): exact.
        const exact =
          src &&
          src.type === col.type &&
          ((src.column_id === col.id && src.board_id === row.boardId) || !['status', 'dropdown'].includes(col.type));
        // A pasted date with a time is wall-clock in the account's zone (audit 2026-10-10 A1).
        const value = exact ? src.value : cellFromText(col.type, text, col.settings, people, { region: getRegion() });
        if (!row.editable(c) || value === undefined) {
          skipped++;
          continue;
        }
        // One cell pasted into one cell may fill the checked rows too (the row decides): write even when equal.
        const one = single && oneCell(r);
        if (one || JSON.stringify(value ?? null) !== JSON.stringify(row.value(c) ?? null))
          row.write(c, value, gesture, one);
        written++;
      }
    });
    if (skipped) showToast({ message: t('grid.pasteSkipped', { n: skipped }) });
  }, []);

  /** Plain text from the clipboard: our own last copy when it is the same text (exact values), else TSV. */
  const pasteText = useCallback(
    (text: string, source: Copied[][] | null = null) => {
      const own = source ?? (lastCopy && lastCopy.tsv === text ? lastCopy.cells : null);
      pasteCells(own ? own.map((l) => l.map((c) => c.text)) : parseTsv(text), own);
    },
    [pasteCells],
  );

  const edit = useCallback(() => {
    requestAnimationFrame(() => {
      const cur = state.current.active;
      if (!cur) return;
      const row = rows.current.get(cur.itemId);
      if (cur.col < 0) row?.rename();
      else editorOf(row?.cellEl(cur.col) ?? null)?.click();
    });
  }, []);

  // Menu actions: the system clipboard through the async API (the menu has the focus, not the table).
  const copy = useCallback(
    (cut: boolean) => {
      const out = copyOut();
      if (!out) return;
      void navigator.clipboard?.writeText(out.tsv).catch(() => undefined);
      if (cut) clearCells();
    },
    [copyOut, clearCells],
  );
  const paste = useCallback(() => {
    const fallback = () =>
      lastCopy &&
      pasteCells(
        lastCopy.cells.map((l) => l.map((c) => c.text)),
        lastCopy.cells,
      );
    if (!navigator.clipboard?.readText) return void fallback();
    navigator.clipboard.readText().then((text) => pasteText(text), fallback);
  }, [pasteCells, pasteText]);

  useEffect(() => {
    /** Whether a key / clipboard event belongs to the grid. */
    const ours = (e: Event) => {
      const cur = state.current.active;
      if (!cur || e.defaultPrevented || hasOpenLayers() || isTyping(e.target)) return null;
      const target = e.target as Node | null;
      if (target !== document.body && !tableRef.current?.contains(target)) return null;
      return cur;
    };

    const onKey = (e: KeyboardEvent) => {
      // Tab in an inline editor (a text or number cell) saves it — its blur commits — and goes on, as in a sheet.
      const fromEditor =
        e.key === 'Tab' &&
        !e.defaultPrevented &&
        !!state.current.active &&
        isTyping(e.target) &&
        !hasOpenLayers() &&
        !!tableRef.current?.contains(e.target as Node);
      if (fromEditor) (e.target as HTMLElement).blur();
      const cur = fromEditor ? state.current.active : ours(e);
      if (!cur || e.altKey) return;
      const { order: list, anchor: from } = state.current;
      const row = rows.current.get(cur.itemId);
      const index = list.indexOf(cur.itemId);
      const width = (id: string) => (rows.current.get(id) ?? row)?.columns.length ?? 0;
      /** Moves the active cell; with `extend` (Shift) the range grows from where it started. */
      const go = (itemId: string, col: number, extend = false) => {
        e.preventDefault();
        reveal(itemId);
        const next = { itemId, col: Math.max(-1, Math.min(col, width(itemId) - 1)) };
        setActiveState(next);
        setAnchor(extend ? (from ?? cur) : null);
      };
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      switch (e.key) {
        case 'ArrowDown':
          if (!mod && index >= 0 && index < list.length - 1) go(list[index + 1]!, cur.col, shift);
          return;
        case 'ArrowUp':
          if (!mod && index > 0) go(list[index - 1]!, cur.col, shift);
          return;
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (mod) return;
          // In RTL the next column is to the left.
          const forward = (e.key === 'ArrowLeft') === isRtl();
          go(cur.itemId, cur.col + (forward ? 1 : -1), shift);
          return;
        }
        case 'Tab': {
          if (mod) return;
          const last = width(cur.itemId) - 1;
          if (!shift && cur.col < last) go(cur.itemId, cur.col + 1);
          else if (shift && cur.col > -1) go(cur.itemId, cur.col - 1);
          else if (!shift && index < list.length - 1) go(list[index + 1]!, -1);
          else if (shift && index > 0) go(list[index - 1]!, width(list[index - 1]!) - 1);
          else e.preventDefault();
          return;
        }
        case 'Enter':
        case 'F2':
          if (mod || shift || !row) return;
          e.preventDefault();
          if (cur.col === -1) row.rename();
          else editorOf(row.cellEl(cur.col))?.click();
          return;
        case 'Delete':
        case 'Backspace':
          if (state.current.rowsSelected) return;
          e.preventDefault();
          clearCells();
          return;
        case 'Escape':
          if (from) setAnchor(null);
          else {
            setActive(null);
            (document.activeElement as HTMLElement | null)?.blur();
          }
          return;
      }
    };

    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (!ours(e) || !e.clipboardData || window.getSelection()?.toString()) return;
      const out = copyOut();
      if (!out) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', out.tsv);
      e.clipboardData.setData(CELLS_MIME, JSON.stringify(out.cells));
      if (cut) clearCells();
    };

    const onPaste = (e: ClipboardEvent) => {
      const cur = ours(e);
      if (!cur || !e.clipboardData) return;
      // r19small: files (a copied image, a screenshot) pasted on a files cell go to that cell — it
      // uploads them (and says so when it is read-only). Files on another cell are not text: nothing is pasted.
      const files = transferFiles(e.clipboardData);
      if (files.length && !e.clipboardData.getData(CELLS_MIME)) {
        const row = rows.current.get(cur.itemId);
        const cell = cur.col >= 0 ? row?.cellEl(cur.col) : null;
        const target = cell?.querySelector(`[${FILE_PASTE_ATTR}]`);
        if (target && row?.columns[cur.col]?.type === 'file') {
          e.preventDefault();
          target.dispatchEvent(new CustomEvent(FILE_PASTE_EVENT, { detail: files }));
          return;
        }
        if (!e.clipboardData.getData('text/plain')) return;
      }
      e.preventDefault();
      let source: Copied[][] | null = null;
      try {
        const raw = e.clipboardData.getData(CELLS_MIME);
        if (raw) source = JSON.parse(raw) as Copied[][];
      } catch {
        source = null;
      }
      pasteText(e.clipboardData.getData('text/plain'), source);
    };

    // An editor or popover that closes drops the focus to the page: it goes back to the active cell.
    const onFocusOut = (e: FocusEvent) => {
      const cur = state.current.active;
      if (!cur || e.relatedTarget) return;
      requestAnimationFrame(() => {
        if (state.current.active !== cur) return;
        if (document.activeElement && document.activeElement !== document.body) return;
        rows.current.get(cur.itemId)?.cellEl(cur.col)?.focus({ preventScroll: true });
      });
    };

    // A click elsewhere on the page (not in the table, nor in a popover / menu / dialog it opened) leaves it.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!state.current.active || !target || tableRef.current?.contains(target)) return;
      if (target.closest('[data-testid="popover"], [role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      setActive(null);
    };

    const onCopyEvent = (e: ClipboardEvent) => onCopy(e, false);
    const onCutEvent = (e: ClipboardEvent) => onCopy(e, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('copy', onCopyEvent);
    document.addEventListener('cut', onCutEvent);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('copy', onCopyEvent);
      document.removeEventListener('cut', onCutEvent);
      document.removeEventListener('paste', onPaste);
    };
  }, [tableRef, reveal, setActive, copyOut, clearCells, pasteText]);

  const register = useCallback((itemId: string, row: GridRow) => {
    rows.current.set(itemId, row);
    return () => {
      if (rows.current.get(itemId) === row) rows.current.delete(itemId);
    };
  }, []);

  const selected = useMemo(() => {
    if (!active || !anchor) return null;
    const r = rect(active, anchor, order);
    return { ids: new Set(r.ids), c0: r.c0, c1: r.c1 };
  }, [active, anchor, order]);
  const inRange = useCallback(
    (itemId: string, col: number) => !!selected && selected.ids.has(itemId) && col >= selected.c0 && col <= selected.c1,
    [selected],
  );

  return useMemo(
    () => ({ active, setActive, inRange, register, copy, paste, clear: clearCells, edit }),
    [active, setActive, inRange, register, copy, paste, clearCells, edit],
  );
};
