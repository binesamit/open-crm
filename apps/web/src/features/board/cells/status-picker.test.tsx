// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PICKER_COLORS, PICKER_COLUMNS, type StatusLabel } from '@bines/shared';
import { placeCentred } from '@bines/ui';
import { ColorGrid } from '../../../lib/label-color';
import { StatusPicker } from './StatusPicker';
import { LabelEditor } from './LabelEditor';
import { PopoverSheetContext } from './Popover';
import {
  LABEL_EDITOR,
  STATUS_PICKER,
  statusPickerColumns,
  statusPickerColumnsOf,
  statusPickerLayout,
  statusPickerMove,
  statusPickerRows,
} from './status-picker-layout';

/**
 * pal40: the status picker lays its labels out in columns of eight; past two columns (or taller than
 * the room around the cell) it floats beside the centre of the viewport, never over the cell; wider than the
 * viewport, its columns scroll across inside it. The colour picker shows the forty colours, five rows of eight.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wide = { width: 1440, height: 900 };
const cell = { top: 300, bottom: 336 };

describe('status picker layout', () => {
  it('columns by label count: eight per column, then another column', () => {
    expect([1, 3, 8, 9, 16, 17, 24, 25, 30, 40].map(statusPickerColumns)).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
    // The labels spread evenly over the columns (9 → 5 + 4).
    expect([1, 8, 9, 16, 17, 30].map(statusPickerRows)).toEqual([1, 8, 5, 8, 6, 8]);
    expect(statusPickerColumns(0)).toBe(1);
  });

  it('stays anchored to the cell up to two columns; centred beyond', () => {
    expect(statusPickerLayout(3, cell, wide).centred).toBe(false);
    expect(statusPickerLayout(8, cell, wide).centred).toBe(false);
    expect(statusPickerLayout(16, cell, wide)).toMatchObject({ columns: 2, centred: false });
    expect(statusPickerLayout(17, cell, wide)).toMatchObject({ columns: 3, centred: true });
    expect(statusPickerLayout(30, cell, wide)).toMatchObject({ columns: 4, rows: 8, centred: true });
  });

  it('also centred when anchored it would cover the cell (no room above or below)', () => {
    // A short window: eight rows do not fit above or below a cell in the middle.
    const short = { width: 1440, height: 520 };
    expect(statusPickerLayout(8, { top: 240, bottom: 276 }, short).centred).toBe(true);
    expect(statusPickerLayout(3, { top: 240, bottom: 276 }, short).centred).toBe(false);
  });

  it('wider than the viewport: the panel is capped and its columns scroll across', () => {
    const l = statusPickerLayout(34, cell, { width: 900, height: 800 });
    expect(l.columns).toBe(5);
    expect(l.contentWidth).toBe(5 * STATUS_PICKER.COLUMN_WIDTH + 4 * STATUS_PICKER.COLUMN_GAP);
    expect(l.panelWidth).toBe(900 - 2 * STATUS_PICKER.MARGIN);
    expect(l.scrollsAcross).toBe(true);
    expect(statusPickerLayout(30, cell, wide).scrollsAcross).toBe(false);
  });

  it('arrow keys: down / up in a column, across columns (mirrored in RTL), Home / End', () => {
    // 20 labels → 3 columns of 7 (the last one 6): index = column × 7 + row.
    const rows = statusPickerRows(20);
    expect(rows).toBe(7);
    expect(statusPickerMove(0, 'ArrowDown', 20, rows, true)).toBe(1);
    expect(statusPickerMove(6, 'ArrowDown', 20, rows, true)).toBe(6); // the column's end
    expect(statusPickerMove(1, 'ArrowUp', 20, rows, true)).toBe(0);
    expect(statusPickerMove(2, 'ArrowLeft', 20, rows, true)).toBe(9); // RTL: the next column is on the left
    expect(statusPickerMove(9, 'ArrowRight', 20, rows, true)).toBe(2);
    expect(statusPickerMove(2, 'ArrowRight', 20, rows, false)).toBe(9); // LTR
    expect(statusPickerMove(13, 'ArrowLeft', 20, rows, true)).toBe(19); // a shorter last column: its last chip
    expect(statusPickerMove(5, 'End', 20, rows, true)).toBe(19);
    expect(statusPickerMove(5, 'Home', 20, rows, true)).toBe(0);
    expect(statusPickerMove(5, 'Enter', 20, rows, true)).toBeNull();
  });
});

describe('placeCentred', () => {
  const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });

  it('centres the panel in the viewport when that leaves the cell in sight', () => {
    const p = placeCentred(box(100, 60, 140, 36), { width: 800, height: 320 }, wide);
    expect(p.left).toBe((1440 - 800) / 2);
    expect(p.top).toBe((900 - 320) / 2);
  });

  it('a cell in the middle: the panel moves to the larger band, never over the cell', () => {
    const anchor = box(600, 400, 160, 36);
    const p = placeCentred(anchor, { width: 800, height: 320 }, wide);
    const covers = p.top < anchor.bottom && p.top + Math.min(320, p.maxHeight) > anchor.top;
    expect(covers).toBe(false);
    expect(p.side).toBe('bottom');
    expect(p.top).toBeGreaterThanOrEqual(anchor.bottom);
  });

  it('never wider than the viewport less the margins', () => {
    const p = placeCentred(box(10, 10, 100, 30), { width: 2000, height: 300 }, { width: 900, height: 800 });
    expect(p.left).toBe(8);
    expect(p.maxWidth).toBe(884);
  });
});

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
const render = (el: ReturnType<typeof createElement>) => {
  act(() => {
    root = createRoot(host);
    root.render(el);
  });
};

const labels = (n: number): StatusLabel[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, label: `L${i}`, color: PICKER_COLORS[i % 40]!, index: i }));

describe('StatusPicker', () => {
  it('lays the chips out down columns inside a scroll box that scrolls across', () => {
    const layout = statusPickerLayout(34, cell, { width: 900, height: 800 });
    render(
      createElement(StatusPicker, { labels: labels(34), currentId: 3, layout, onPick: vi.fn(), onClear: vi.fn() }),
    );
    const picker = host.querySelector<HTMLElement>('[data-testid="status-picker"]')!;
    expect(picker.dataset.columns).toBe('5');
    expect(picker.dataset.layout).toBe('centre');
    const scroll = host.querySelector<HTMLElement>('[data-testid="status-picker-scroll"]')!;
    expect(scroll.className).toContain('overflow-auto');
    expect(scroll.dataset.scrollsAcross).toBe('true');
    const grid = scroll.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-flow-col'); // down the columns first
    expect(grid.style.gridTemplateRows).toBe('repeat(7, minmax(32px, auto))');
    expect(grid.style.width).toBe(`${layout.contentWidth}px`);
    expect(host.querySelectorAll('[data-testid="status-option"]')).toHaveLength(34);
    // The current label takes the focus first.
    expect(host.querySelector('[data-autofocus]')?.textContent).toBe('L3');
  });

  it('arrow keys move across columns and Enter / click picks', () => {
    const onPick = vi.fn();
    const layout = statusPickerLayout(20, cell, wide);
    render(createElement(StatusPicker, { labels: labels(20), currentId: undefined, layout, onPick, onClear: vi.fn() }));
    const chips = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="status-option"]')];
    chips[0]!.focus();
    act(() => {
      chips[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(chips[layout.rows]);
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: layout.rows }));
  });

  it('a label the workflow blocks is faded; a click does nothing, or asks the owner to pass it', () => {
    const onPick = vi.fn();
    const onPickBlocked = vi.fn();
    const props = {
      labels: labels(3),
      currentId: 0,
      layout: statusPickerLayout(3, cell, wide),
      onPick,
      onClear: vi.fn(),
    };
    render(createElement(StatusPicker, { ...props, blocked: new Set([2]) }));
    let chips = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="status-option"]')];
    expect(chips[2]!.dataset.blocked).toBe('true');
    expect(chips[2]!.getAttribute('aria-disabled')).toBe('true');
    expect(chips[1]!.dataset.blocked).toBeUndefined();
    act(() => chips[2]!.click());
    expect(onPick).not.toHaveBeenCalled();
    render(createElement(StatusPicker, { ...props, blocked: new Set([2]), onPickBlocked }));
    chips = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="status-option"]')];
    expect(chips[2]!.getAttribute('aria-disabled')).toBeNull();
    act(() => chips[2]!.click());
    expect(onPickBlocked).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    act(() => chips[1]!.click());
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('one column for a few labels, with the clear option', () => {
    const onClear = vi.fn();
    render(
      createElement(StatusPicker, {
        labels: labels(3),
        currentId: 0,
        layout: statusPickerLayout(3, cell, wide),
        onPick: vi.fn(),
        onClear,
      }),
    );
    expect(host.querySelector<HTMLElement>('[data-testid="status-picker"]')!.dataset.columns).toBe('1');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="status-clear"]')!.click());
    expect(onClear).toHaveBeenCalled();
  });
});

describe('statusPickerColumnsOf (c9)', () => {
  it("splits in reading order into the picker's columns and rows", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
    for (let n = 1; n <= 60; n++) {
      const cols = statusPickerColumnsOf(ids(n));
      expect(cols).toHaveLength(statusPickerColumns(n));
      expect(cols.flat()).toEqual(ids(n));
      for (const c of cols.slice(0, -1)) expect(c).toHaveLength(statusPickerRows(n));
    }
    // 9 → 5 + 4, 17 → 6 + 6 + 5: the picker's grid-flow-col puts the same labels in each column.
    expect(statusPickerColumnsOf(ids(9))).toEqual([ids(5), [5, 6, 7, 8]]);
    expect(statusPickerColumnsOf(ids(17)).map((c) => c.length)).toEqual([6, 6, 5]);
  });

  it('one list when single (phones) or empty', () => {
    expect(statusPickerColumnsOf([1, 2, 3, 4, 5, 6, 7, 8, 9], true)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9]]);
    expect(statusPickerColumnsOf([])).toEqual([[]]);
  });
});

describe("LabelEditor in the picker's columns (c9)", () => {
  const editor = (n: number, opts: { withColor?: boolean; sheet?: boolean } = {}) =>
    createElement(
      PopoverSheetContext.Provider,
      { value: !!opts.sheet },
      createElement(LabelEditor, {
        labels: labels(n),
        withColor: opts.withColor ?? true,
        maxLength: 30,
        onSave: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
  const columnsOf = () =>
    [...host.querySelectorAll<HTMLElement>('[data-testid="label-editor-column"]')].map((c) =>
      [...c.querySelectorAll<HTMLInputElement>('input')].map((i) => i.value),
    );

  it.each([3, 9, 16, 17, 34])('%i labels: the same columns as the picker, in reading order', (n) => {
    render(editor(n));
    const root = host.querySelector<HTMLElement>('[data-testid="label-editor"]')!;
    const picker = statusPickerLayout(n, cell, wide);
    expect(root.dataset.columns).toBe(String(picker.columns));
    expect(root.dataset.rows).toBe(String(picker.rows));
    const cols = columnsOf();
    expect(cols).toHaveLength(picker.columns);
    expect(cols.flat()).toEqual(labels(n).map((l) => l.label));
    expect(cols[0]).toHaveLength(picker.rows);
    const ul = host.querySelector<HTMLElement>('[data-testid="label-editor-column"]')!;
    expect(ul.style.width).toBe(`${LABEL_EDITOR.COLUMN_WIDTH}px`);
  });

  it('a new label shows at once in the column it will land in (8 → 9: a second column)', () => {
    render(editor(8));
    expect(columnsOf()).toHaveLength(1);
    const add = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('+'))!;
    act(() => add.click());
    const cols = columnsOf();
    expect(cols.map((c) => c.length)).toEqual([5, 4]);
    const last = host.querySelectorAll<HTMLElement>('[data-testid="label-editor-column"]')[1]!.lastElementChild!;
    expect(last.getAttribute('data-fresh')).toBe('true');
    expect(document.activeElement).toBe(last.querySelector('input'));
  });

  it('phones (the sheet) and dropdown labels keep one list', () => {
    render(editor(20, { sheet: true }));
    expect(host.querySelector<HTMLElement>('[data-testid="label-editor"]')!.dataset.columns).toBe('1');
    expect(host.querySelector('[data-testid="label-editor-column"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="label-row"]')).toHaveLength(20);
    act(() => root?.unmount());
    render(editor(20, { withColor: false }));
    expect(host.querySelector<HTMLElement>('[data-testid="label-editor"]')!.dataset.columns).toBe('1');
  });

  it('a status label is edited as the chip the table shows: tint, ink and the real-look swatches', () => {
    render(editor(3));
    const row = host.querySelector<HTMLElement>('[data-testid="label-row"]')!;
    const name = row.querySelector<HTMLInputElement>('input')!;
    const key = labels(3)[0]!.color;
    expect(name.className).toContain('label-tag');
    expect(name.style.getPropertyValue('--tag-soft')).toBe(`var(--c-${key}-soft)`);
    expect(name.style.getPropertyValue('--tag-ink')).toBe(`var(--c-${key}-ink)`);
    const swatch = row.querySelector<HTMLElement>('[data-testid="label-color"]')!;
    expect(swatch.className).toContain('label-tag');
    expect(swatch.style.getPropertyValue('--tag-soft')).toBe(`var(--c-${key}-soft)`);
    act(() => swatch.click());
    const option = row.querySelector<HTMLElement>('[data-testid="label-swatch"][data-color="midnight"]')!;
    expect(option.dataset.look).toBe('label');
    expect(option.style.getPropertyValue('--tag-soft')).toBe('var(--c-midnight-soft)');
    // Dropdown labels keep the plain field.
    act(() => root?.unmount());
    render(editor(3, { withColor: false }));
    const plain = host.querySelector<HTMLInputElement>('[data-testid="label-row"] input')!;
    expect(plain.className).not.toContain('label-tag');
    expect(plain.style.getPropertyValue('--tag-soft')).toBe('');
  });
});

describe('ColorGrid', () => {
  it('shows all forty colours, five rows of eight, grouped vivid / deep + neutral / soft', () => {
    const onPick = vi.fn();
    render(
      createElement(ColorGrid, {
        label: 'colour',
        testId: 'grid',
        itemTestId: 'swatch',
        selected: (k: string) => k === 'moss',
        onPick,
      }),
    );
    const swatches = [...host.querySelectorAll<HTMLElement>('[data-testid="swatch"]')];
    expect(swatches.map((s) => s.dataset.color)).toEqual([...PICKER_COLORS]);
    expect(swatches.length / PICKER_COLUMNS).toBe(5);
    const groups = [...host.querySelectorAll<HTMLElement>('[data-color-group]')];
    expect(groups.map((g) => [g.dataset.colorGroup, g.children.length])).toEqual([
      ['vivid', 16],
      ['deep', 16],
      ['soft', 8],
    ]);
    for (const g of groups) expect(g.className).toContain('grid-cols-8');
    expect(host.querySelector('[data-color="moss"]')?.getAttribute('aria-checked')).toBe('true');
    act(() => host.querySelector<HTMLButtonElement>('[data-color="rust"]')!.click());
    expect(onPick).toHaveBeenCalledWith('rust');
  });
});

describe('LabelEditor: leaving keeps the edits', () => {
  const mount = () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(createElement(LabelEditor, { labels: labels(3), withColor: true, maxLength: 30, onSave, onCancel }));
    return { onSave, onCancel };
  };
  const rename = (i: number, value: string) => {
    const input = host.querySelectorAll<HTMLInputElement>('[data-testid="label-row"] input')[i]!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const leave = () => act(() => root?.unmount());

  it('closing without Save saves what changed, a new unnamed label aside', () => {
    const { onSave } = mount();
    rename(0, 'Renamed');
    const add = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('+'))!;
    act(() => add.click());
    leave();
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as { label: string; index: number }[];
    expect(saved.map((l) => l.label)).toEqual([
      'Renamed',
      ...labels(3)
        .slice(1)
        .map((l) => l.label),
    ]);
    expect(saved.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it('nothing changed, Cancel, or already saved: leaving saves nothing more', () => {
    const a = mount();
    leave();
    expect(a.onSave).not.toHaveBeenCalled();

    const b = mount();
    rename(0, 'Dropped');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="label-editor-cancel"]')!.click());
    leave();
    expect(b.onCancel).toHaveBeenCalledTimes(1);
    expect(b.onSave).not.toHaveBeenCalled();

    const c = mount();
    rename(0, 'Saved');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="label-editor-save"]')!.click());
    leave();
    expect(c.onSave).toHaveBeenCalledTimes(1);
  });
});
