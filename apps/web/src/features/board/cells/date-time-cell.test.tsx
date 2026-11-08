// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REGION, setRegion, type Column } from '@bines/shared';
import { CELLS, type CellProps } from './index';

/**
 * "include time" on a date column — the picker adds a time (our TimeField, never a native input)
 * in the viewer's zone, saved once when the picker closes on an outside click; Esc discards the edit.
 */
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  setRegion(DEFAULT_REGION); // Asia/Jerusalem
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const column = (settings: Record<string, unknown>) =>
  ({ id: 'c1', key: 'due', title: 'Due', type: 'date', settings }) as unknown as Column;

const mount = (settings: Record<string, unknown>, value: unknown, onChange: (v: unknown) => void) =>
  act(() =>
    root.render(
      createElement(CELLS.date!, {
        column: column(settings),
        value,
        text: 'x',
        editable: true,
        onChange,
        members: [],
        accountId: 'a',
        itemId: 'i',
        boardId: 'b',
        canEditSettings: false,
        onSettingsChange: async () => undefined,
      } as unknown as CellProps),
    ),
  );

const open = () => act(() => (host.firstElementChild as HTMLElement).click());
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const escape = () =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
/** A press outside the picker (and outside the cell, which is its anchor). */
const outside = () =>
  act(() => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.remove();
  });

describe('DateCell with a time', () => {
  it('without "include time" there is no time row', async () => {
    await mount({}, { date: '2026-10-05' }, vi.fn());
    await open();
    expect(q('date-time-row')).toBeNull();
    expect(document.body.querySelector('input[type="time"], input[type="date"]')).toBeNull();
  });

  it('adds the column default time and stores it as UTC on an outside click', async () => {
    const onChange = vi.fn();
    await mount({ show_time: true, default_time: '08:15' }, { date: '2026-10-05' }, onChange);
    await open();
    expect(q('date-time-row')).not.toBeNull();
    act(() => q('date-add-time')!.click());
    expect(onChange).not.toHaveBeenCalled(); // saved once, on close
    await outside();
    // 08:15 in Jerusalem (UTC+3 in October) = 05:15Z.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ date: '2026-10-05', time: '05:15' });
  });

  it('shows an existing time even when the setting is off, and can remove it', async () => {
    const onChange = vi.fn();
    await mount({}, { date: '2026-10-04', time: '22:30' }, onChange);
    await open();
    // The local time (01:30 on Oct 5 in Jerusalem) is in our time picker.
    expect(q('date-time-row')!.textContent).toContain('01:30');
    act(() => q('date-remove-time')!.click());
    await outside();
    // The local day stays (Oct 5), without a time.
    expect(onChange).toHaveBeenCalledWith({ date: '2026-10-05' });
  });

  it('Esc discards the pending edit and closes the picker', async () => {
    const onChange = vi.fn();
    await mount({ show_time: true }, { date: '2026-10-05' }, onChange);
    await open();
    act(() => q('date-add-time')!.click());
    await escape();
    expect(q('date-time-row')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // Opened again: the stored value, not the discarded draft.
    await open();
    expect(q('date-add-time')).not.toBeNull();
  });

  it('closing without a change saves nothing', async () => {
    const onChange = vi.fn();
    await mount({ show_time: true }, { date: '2026-10-04', time: '22:30' }, onChange);
    await open();
    await outside();
    expect(onChange).not.toHaveBeenCalled();
  });
});
