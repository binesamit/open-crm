// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type BulkEnv,
  type Draft,
  draftRowCount,
  draftText,
  isEdited,
  isNewRow,
  parseSheetCell,
  parseTsv,
  pasteBlock,
  rangeBlock,
  rangeWrites,
  type SheetColumn,
  type SheetRange,
  type SheetRow,
  setTexts,
  toTsv,
  writable,
  t,
} from '@bines/shared';
import { cn, useLayer } from '@bines/ui';
import { Icon } from '../../../lib/icons';
import { isModLetter } from '../../../lib/keys';

export type Cell = { row: number; col: number };

const ROW_H = 34;
const GUTTER = 56;
const NAME_W = 240;
const COL_W = 168;
/** Empty rows under the last one, to type or paste new rows into (a paste may go further: it adds rows). */
const SPARE_ROWS = 20;

const widthOf = (c: SheetColumn) => (c.mode === 'name' ? NAME_W : COL_W);
const isRtl = () => document.documentElement.dir === 'rtl';

/**
 * The bulk-edit sheet (B1): every cell is text, like a spreadsheet. Virtualized rows (thousands of items);
 * keyboard as in a spreadsheet — arrows (RTL: ← is the next column), Tab, Enter / F2 edit, typing replaces,
 * Delete clears, Shift extends, Ctrl+A, Ctrl+C / X / V of rectangles (TSV, Excel), Ctrl+Z / Y step the draft.
 * Frozen columns (computed / engine-written) are greyed and skipped by paste; edited cells are tinted, cells that
 * will not read as their type are marked red, new values (labels, tags, unknown people) blue.
 */
export const BulkSheet = ({
  columns,
  base,
  draft,
  env,
  onChange,
  onUndo,
  onRedo,
  onSkipped,
  focus,
  levels,
  label,
}: {
  columns: SheetColumn[];
  base: SheetRow[];
  draft: Draft;
  env: BulkEnv;
  onChange: (next: Draft) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Cells a paste could not take (frozen columns, past the last column). */
  onSkipped: (n: number) => void;
  /** A cell to go to (the review's "fix" link). */
  focus?: Cell | null;
  /** Subitems sheet (B4): each row's level (1 = under an item), shown as an indent of the name. */
  levels?: (number | null)[];
  /** The grid's accessible name (which sheet). */
  label?: string;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Cell>(() => focus ?? { row: 0, col: 0 });
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<{ text: string; typed: boolean } | null>(null);
  const dragging = useRef(false);

  const rowCount = draftRowCount(base, draft);
  const total = rowCount + SPARE_ROWS;
  const range: SheetRange = {
    r0: Math.min(active.row, anchor?.row ?? active.row),
    r1: Math.max(active.row, anchor?.row ?? active.row),
    c0: Math.min(active.col, anchor?.col ?? active.col),
    c1: Math.max(active.col, anchor?.col ?? active.col),
  };

  // eslint-disable-next-line react-hooks/incompatible-library -- the compiler skips memoising this one component
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    scrollPaddingStart: ROW_H,
  });

  const apply = (writes: Parameters<typeof setTexts>[3]) => {
    const { draft: next, skipped } = setTexts(base, draft, columns, writes);
    onChange(next);
    return skipped;
  };

  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });
  useEffect(() => {
    focusGrid();
  }, []);
  // The review's "fix" link: the cell becomes active and in view.
  useEffect(() => {
    if (!focus) return;
    setActive(focus);
    setAnchor(null);
    focusGrid();
  }, [focus]);
  // The active cell stays in view (rows by the virtualizer, columns by the browser) — when the keyboard moved it: a
  // cell the mouse picked is under the pointer, and scrolling then would slide the next row under a held button.
  const byPointer = useRef(false);
  useEffect(() => {
    if (byPointer.current) {
      byPointer.current = false;
      return;
    }
    virtualizer.scrollToIndex(active.row, { align: 'auto' });
    requestAnimationFrame(() =>
      gridRef.current
        ?.querySelector(`[data-bulk-cell="${active.row}:${active.col}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    );
  }, [active.row, active.col, virtualizer]);

  const move = (row: number, col: number, extend = false) => {
    const r = Math.max(0, Math.min(total - 1, row));
    const c = Math.max(0, Math.min(columns.length - 1, col));
    if (extend) setAnchor((a) => a ?? active);
    else setAnchor(null);
    setActive({ row: r, col: c });
  };

  const startEdit = (text: string | null) => {
    const column = columns[active.col];
    if (!column || !writable(base, column, active.row)) return;
    setAnchor(null);
    setEditing(
      text === null ? { text: draftText(base, draft, active.row, column.id), typed: false } : { text, typed: true },
    );
  };

  const commit = (text: string, then?: Cell) => {
    const column = columns[active.col];
    setEditing(null);
    if (column && text !== draftText(base, draft, active.row, column.id))
      apply([{ row: active.row, col: active.col, text }]);
    if (then) move(then.row, then.col);
    // At once (a key pressed right after Enter — Ctrl+Z — must reach the grid), and again after the editor unmounts.
    focusGrid();
    requestAnimationFrame(focusGrid);
  };
  const cancel = () => {
    setEditing(null);
    focusGrid();
    requestAnimationFrame(focusGrid);
  };

  const forward = (e: { key: string }) => (e.key === 'ArrowLeft') === isRtl();

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing) return; // the editor handles its own keys
    const mod = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const native = e.nativeEvent;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (isModLetter(native, 'z')) {
      stop();
      onUndo();
      return;
    }
    if (isModLetter(native, 'z', true) || isModLetter(native, 'y')) {
      stop();
      onRedo();
      return;
    }
    if (isModLetter(native, 'a')) {
      stop();
      setAnchor({ row: 0, col: 0 });
      setActive({ row: Math.max(0, rowCount - 1), col: columns.length - 1 });
      return;
    }
    // Copy / cut / paste come as clipboard events (below); other Ctrl+keys are the browser's.
    if (mod && !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.stopPropagation();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        stop();
        move(mod ? rowCount - 1 : active.row + 1, active.col, shift);
        return;
      case 'ArrowUp':
        stop();
        move(mod ? 0 : active.row - 1, active.col, shift);
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        stop();
        const next = forward(e);
        move(active.row, mod ? (next ? columns.length - 1 : 0) : active.col + (next ? 1 : -1), shift);
        return;
      }
      case 'Home':
        stop();
        move(mod ? 0 : active.row, 0, shift);
        return;
      case 'End':
        stop();
        move(mod ? Math.max(0, rowCount - 1) : active.row, columns.length - 1, shift);
        return;
      case 'PageDown':
      case 'PageUp': {
        stop();
        const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_H * 10) / ROW_H) - 1);
        move(active.row + (e.key === 'PageDown' ? page : -page), active.col, shift);
        return;
      }
      case 'Tab': {
        stop();
        if (!shift && active.col < columns.length - 1) move(active.row, active.col + 1);
        else if (shift && active.col > 0) move(active.row, active.col - 1);
        else if (!shift) move(active.row + 1, 0);
        else if (active.row > 0) move(active.row - 1, columns.length - 1);
        return;
      }
      case 'Enter':
      case 'F2':
        stop();
        if (shift && e.key === 'Enter') move(active.row - 1, active.col);
        else startEdit(null);
        return;
      case 'Delete':
      case 'Backspace': {
        stop();
        apply(rangeWrites(range, () => ''));
        return;
      }
      case 'Escape':
        if (anchor) {
          stop();
          setAnchor(null);
        }
        return;
    }
    if (e.key.length === 1 && !e.altKey) {
      stop();
      startEdit(e.key);
    }
  };

  const onCopy = (e: ReactClipboardEvent<HTMLDivElement>, cut: boolean) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    e.clipboardData.setData('text/plain', toTsv(rangeBlock(base, draft, columns, range)));
    if (cut) apply(rangeWrites(range, () => ''));
  };

  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    const block = parseTsv(e.clipboardData.getData('text/plain').replace(/\r?\n$/, ''));
    if (!block.length) return;
    const single = block.length === 1 && block[0]!.length === 1;
    const many = range.r1 > range.r0 || range.c1 > range.c0;
    // One copied value fills the selected range (Excel); a block goes from the range's top-left cell.
    const { draft: next, skipped } =
      single && many
        ? setTexts(
            base,
            draft,
            columns,
            rangeWrites(range, () => block[0]![0]!),
          )
        : pasteBlock(base, draft, columns, { row: range.r0, col: range.c0 }, block);
    onChange(next);
    if (!(single && many)) {
      setAnchor({ row: range.r0, col: range.c0 });
      setActive({
        row: range.r0 + block.length - 1,
        col: Math.min(columns.length - 1, range.c0 + Math.max(...block.map((l) => l.length)) - 1),
      });
    }
    if (skipped) onSkipped(skipped);
  };

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const pointTo = (cell: Cell) => {
    if (cell.row === active.row && cell.col === active.col) return;
    byPointer.current = true;
    setActive(cell);
  };
  const onCellDown = (cell: Cell, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // An open editor was committed by its layer (outside mousedown) already.
    e.preventDefault();
    focusGrid();
    pointTo(cell);
    if (e.shiftKey) {
      setAnchor((a) => a ?? active);
      return;
    }
    dragging.current = true;
    setAnchor(cell);
  };
  const onCellEnter = (cell: Cell) => {
    if (dragging.current) pointTo(cell);
  };
  const onCellDouble = (cell: Cell) => {
    setActive(cell);
    const column = columns[cell.col];
    if (!column || !writable(base, column, cell.row)) return;
    setAnchor(null);
    setEditing({ text: draftText(base, draft, cell.row, column.id), typed: false });
  };

  const widths = columns.map(widthOf);
  const fullWidth = GUTTER + widths.reduce((s, w) => s + w, 0);
  // Inline offsets for the sticky gutter and name column.
  const nameAt = GUTTER;

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto rounded-[var(--radius)] border border-line bg-surface"
      data-testid="bulk-scroll"
    >
      <div
        ref={gridRef}
        role="grid"
        aria-label={label ?? t('bulk.title')}
        aria-rowcount={total}
        aria-colcount={columns.length}
        tabIndex={0}
        data-testid="bulk-grid"
        data-rows={rowCount}
        onKeyDown={onKeyDown}
        onCopy={(e) => onCopy(e, false)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        className="relative outline-none"
        style={{ minWidth: fullWidth, height: ROW_H * (total + 1) }}
      >
        {/* Header */}
        <div
          role="row"
          className="sticky top-0 z-20 flex border-b border-line-strong bg-surface-2"
          style={{ height: ROW_H }}
        >
          <div
            className="sticky z-10 shrink-0 border-e border-line bg-surface-2"
            style={{ width: GUTTER, insetInlineStart: 0 }}
          />
          {columns.map((c, ci) => (
            <div
              key={c.id}
              role="columnheader"
              data-bulk-header={c.id}
              data-mode={c.mode}
              title={c.mode === 'frozen' ? t('bulk.frozen') : c.mode === 'secret' ? t('bulk.secret.column') : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1.5 truncate border-e border-line px-2 text-xs font-semibold',
                c.mode === 'frozen' ? 'text-muted' : 'text-heading',
                c.mode === 'name' && 'sticky z-10 bg-surface-2',
                // The last column takes the rest of a wide screen (the sheet never ends in a blank band).
                (c.mode === 'group' || c.mode === 'parent') && 'grow',
              )}
              style={{ width: widths[ci], ...(c.mode === 'name' ? { insetInlineStart: nameAt } : {}) }}
            >
              {c.mode === 'frozen' ? <LockIcon /> : null}
              <span className="truncate">{c.title}</span>
            </div>
          ))}
        </div>
        {virtualizer.getVirtualItems().map((v) => (
          <SheetRowView
            key={v.index}
            row={v.index}
            top={v.start + ROW_H}
            columns={columns}
            widths={widths}
            base={base}
            draft={draft}
            env={env}
            fresh={isNewRow(base, v.index)}
            level={levels?.[v.index] ?? null}
            spare={v.index >= rowCount}
            active={active.row === v.index ? active.col : -1}
            r0={range.r0}
            r1={range.r1}
            c0={range.c0}
            c1={range.c1}
            editor={
              active.row === v.index && editing ? (
                <CellEditor
                  initial={editing.text}
                  typed={editing.typed}
                  multiline={
                    columns[active.col]?.type === 'long_text' ||
                    (columns[active.col]?.mode === 'secret' && columns[active.col]?.settings.multiline === true)
                  }
                  secret={columns[active.col]?.mode === 'secret'}
                  onCommit={(text, dir) => {
                    if (!dir) return commit(text);
                    const next =
                      dir === 'down'
                        ? { row: active.row + 1, col: active.col }
                        : dir === 'up'
                          ? { row: Math.max(0, active.row - 1), col: active.col }
                          : dir === 'next'
                            ? { row: active.row, col: Math.min(columns.length - 1, active.col + 1) }
                            : { row: active.row, col: Math.max(0, active.col - 1) };
                    commit(text, next);
                  }}
                  onCancel={cancel}
                />
              ) : null
            }
            onDown={onCellDown}
            onEnter={onCellEnter}
            onDouble={onCellDouble}
          />
        ))}
      </div>
    </div>
  );
};

type RowProps = {
  row: number;
  top: number;
  columns: SheetColumn[];
  widths: number[];
  base: SheetRow[];
  draft: Draft;
  env: BulkEnv;
  fresh: boolean;
  /** Subitems sheet: the row's level. */
  level: number | null;
  spare: boolean;
  /** The active column on this row, else -1. */
  active: number;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  editor: React.ReactNode;
  onDown: (cell: Cell, e: React.MouseEvent) => void;
  onEnter: (cell: Cell) => void;
  onDouble: (cell: Cell) => void;
};

/** One sheet row, positioned by `top` (never a transform: popovers inside must stay fixed to the page). */
const SheetRowView = ({
  row,
  top,
  columns,
  widths,
  base,
  draft,
  env,
  fresh,
  level,
  spare,
  active,
  r0,
  r1,
  c0,
  c1,
  editor,
  onDown,
  onEnter,
  onDouble,
}: RowProps) => {
  const inRows = row >= r0 && row <= r1;
  return (
    <div
      role="row"
      data-bulk-row={row}
      data-new={fresh && !spare ? 'true' : undefined}
      data-level={level ?? undefined}
      className="absolute inset-x-0 flex border-b border-line-soft"
      style={{ top, height: ROW_H }}
    >
      <div
        role="rowheader"
        className={cn(
          'sticky z-10 flex shrink-0 items-center justify-end border-e border-line bg-surface-2 px-2 text-[0.6875rem] tabular-nums',
          fresh && !spare ? 'font-semibold text-ok-fg' : 'text-muted',
        )}
        style={{ width: GUTTER, insetInlineStart: 0 }}
      >
        {spare ? '' : fresh ? `+${row - base.length + 1}` : row + 1}
      </div>
      {columns.map((c, ci) => {
        const canWrite = writable(base, c, row);
        const text = draftText(base, draft, row, c.id);
        const edited = isEdited(base, draft, row, c.id) || (fresh && !!text);
        const parse = edited && (text.trim() || c.mode === 'parent') ? parseSheetCell(c, text, env, row).kind : null;
        const selected = inRows && ci >= c0 && ci <= c1;
        const isActive = active === ci;
        return (
          <div
            key={c.id}
            role="gridcell"
            aria-selected={selected}
            aria-readonly={!canWrite}
            data-bulk-cell={`${row}:${ci}`}
            data-column={c.id}
            data-edited={edited ? 'true' : undefined}
            data-parse={parse ?? undefined}
            onMouseDown={(e) => onDown({ row, col: ci }, e)}
            onMouseEnter={() => onEnter({ row, col: ci })}
            onDoubleClick={() => onDouble({ row, col: ci })}
            className={cn(
              'relative flex shrink-0 items-center border-e border-line-soft px-2 text-[0.8125rem] select-none',
              !canWrite && 'bg-surface-2 text-muted',
              canWrite && edited && 'bg-accent-soft',
              parse === 'invalid' && 'text-danger-fg',
              (parse === 'labels' || parse === 'tags' || parse === 'people') && 'text-info-fg',
              selected && !isActive && 'bg-primary-soft',
              c.mode === 'name' && 'sticky z-[5] font-medium',
              (c.mode === 'group' || c.mode === 'parent') && 'grow',
              c.mode === 'name' && !selected && !edited && 'bg-surface',
            )}
            style={{ width: widths[ci], ...(c.mode === 'name' ? { insetInlineStart: GUTTER } : {}) }}
          >
            {isActive && editor ? (
              editor
            ) : (
              <>
                {c.mode === 'name' && level && level > 1 ? (
                  // A sub-subitem: a corner mark, indented one step per level below the first.
                  <span
                    aria-hidden
                    data-testid="bulk-level"
                    className="shrink-0 text-muted"
                    style={{ paddingInlineStart: (level - 2) * 12 }}
                  >
                    ↳&nbsp;
                  </span>
                ) : null}
                {c.mode === 'secret' ? (
                  // a secret is never shown — a new one as dots, a stored one as fainter dots.
                  <span
                    className={cn('truncate tracking-widest', !text && 'text-muted')}
                    data-testid="bulk-secret"
                    data-state={text ? 'new' : base[row]?.secrets?.includes(c.id) ? 'set' : 'empty'}
                  >
                    {text || base[row]?.secrets?.includes(c.id) ? '••••••' : ''}
                  </span>
                ) : (
                  <span className="truncate">{text.replace(/\n/g, ' ⏎ ')}</span>
                )}
              </>
            )}
            {parse === 'invalid' ? (
              <span
                aria-hidden
                className="absolute end-0 top-0 size-0 border-s-[7px] border-t-[7px] border-s-transparent border-t-[var(--danger)]"
              />
            ) : null}
            {isActive ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-px z-[6] border-2 border-[var(--primary)]"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

type Dir = 'down' | 'up' | 'next' | 'prev';

/**
 * The text editor in the active cell. Typing a character opens it with that character ("enter" mode, as in
 * Excel: arrows commit and move); Enter / F2 / double-click open it on the text ("edit" mode: arrows move the
 * caret). Enter commits and goes down, Tab sideways, Esc cancels (a layer: the dialog stays open), a click
 * elsewhere commits.
 */
const CellEditor = ({
  initial,
  typed,
  multiline,
  secret,
  onCommit,
  onCancel,
}: {
  initial: string;
  typed: boolean;
  multiline: boolean;
  /** A secret column: typed as dots, never filled in by a password manager. */
  secret?: boolean;
  onCommit: (text: string, dir?: Dir) => void;
  onCancel: () => void;
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);
  useLayer(ref, true, () => onCommit(latest.current), onCancel);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !(multiline && e.altKey)) {
      e.preventDefault();
      onCommit(text, e.shiftKey ? 'up' : 'down');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setText((t) => `${t}\n`);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onCommit(text, e.shiftKey ? 'prev' : 'next');
    } else if (typed && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      onCommit(text, e.key === 'ArrowDown' ? 'down' : 'up');
    } else if (typed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      onCommit(text, (e.key === 'ArrowLeft') === isRtl() ? 'next' : 'prev');
    }
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={text}
      data-testid="bulk-editor"
      aria-label={t('bulk.editCell')}
      {...(secret ? { autoComplete: 'off', spellCheck: false, 'data-1p-ignore': true, 'data-lpignore': 'true' } : {})}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'absolute inset-0 z-[7] resize-none overflow-hidden bg-surface px-2 py-[0.4375rem] text-[0.8125rem] leading-[1.125rem] text-fg outline-none',
        secret && '[-webkit-text-security:disc]',
      )}
    />
  );
};

const LockIcon = () => <Icon name="lock" size={12} />;
