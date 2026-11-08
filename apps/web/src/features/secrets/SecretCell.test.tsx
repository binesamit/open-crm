// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@bines/sdk';
import { type Column, t } from '@bines/shared';
import type { CellProps } from '../board/cells';
import type * as ApiModule from '../../lib/api';

/**
 * Prod "the secret column doesn't let me enter a value": an empty secret cell had nothing to click (its only
 * trigger was an empty, 0 px tall button and the cell itself had no click). These render the real cell and walk the
 * set / replace / clear path an editor takes from the cell, with the API answer shown in the panel.
 */
const put = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ put, post, get: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));

const { SecretCell } = await import('../board/cells/SecretCell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const column = { id: 'pwd', type: 'secret', title: 'סיסמה', settings: {}, read_only: false } as unknown as Column;
const MARKER = { set: true, updated_at: '2026-10-08T00:00:00.000Z', updated_by: null };

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  put.mockReset();
  post.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const render = (props: Partial<CellProps>, qc = new QueryClient()) => {
  const all = {
    column,
    value: null,
    text: null,
    editable: true,
    accountId: 'acc',
    itemId: 'item1',
    boardId: 'b1',
    members: [],
    onChange: vi.fn(),
    canEditSettings: false,
    onSettingsChange: vi.fn(),
    ...props,
  } as CellProps;
  act(() => {
    root = createRoot(host);
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(SecretCell, all)));
  });
  return qc;
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const type = async (value: string) => {
  const input = $('secret-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/**
 * Enter in a text field submits its form the way a browser does (HTML "implicit submission", which happy-dom does not
 * do by itself): the form's default button — its FIRST submit button in tree order, and a <button> without a `type`
 * is a submit button — gets a click; the page's microtasks run (React commits there); then, if the button and the form
 * are still in the page, the form is submitted.
 */
const pressEnter = async (input: HTMLInputElement) => {
  const form = input.form;
  let byDefault: HTMLButtonElement | undefined;
  let click: MouseEvent | null = null;
  await act(async () => {
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(key);
    if (key.defaultPrevented || !form) return;
    byDefault = [...form.querySelectorAll('button')].find((el) => el.type === 'submit');
    if (!byDefault || byDefault.disabled) return;
    // The click's listeners only (Element's dispatch, without happy-dom's own button activation)…
    click = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.getPrototypeOf(HTMLButtonElement.prototype).dispatchEvent.call(byDefault, click);
  });
  // …React commits (the browser runs microtasks between the click's listeners and its activation)…
  if (!form || byDefault?.disabled) return;
  await act(async () => {
    // …then the activation: submit, unless the click cancelled it or took the form out of the page.
    if ((click as MouseEvent | null)?.defaultPrevented || !form.isConnected) return;
    if (byDefault && !byDefault.isConnected) return;
    form.requestSubmit(byDefault);
  });
};
const typeInto = async (testId: string, value: string) => {
  const input = $(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
};
const stepUp = () =>
  new ApiError(403, {
    code: 'secret_step_up_required',
    message: 'A fresh two-factor code is needed',
    request_id: 'r',
    details: { verify_minutes: 15 },
  } as never);

// Prod bug (product owner: "I had to type 3 times until it took the value", "I entered the code twice before it showed
// the value"). The panels' Cancel / Clear were <Button>s without `type`, i.e. submit buttons placed BEFORE Save /
// Verify: Enter in the field "clicked" the first one — Cancel (the value or the code was thrown away, the panel
// closed) or, when replacing, Clear (the secret was deleted). Only a mouse click on Save / Verify worked.
describe('SecretCell: Enter in the panels', () => {
  it('Enter in the set panel saves the typed value (it closed the panel and dropped it)', async () => {
    put.mockResolvedValue({});
    render({});
    await click($('secret-cell'));
    const input = await typeInto('secret-input', 'hunter2');
    await pressEnter(input);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('/items/item1/cells/pwd/secret', { value: 'hunter2' });
    expect($('secret-edit-panel')).toBeNull();
  });

  it('Enter in the replace panel replaces — it never clears the secret', async () => {
    put.mockResolvedValue({});
    render({ value: MARKER });
    await click($('secret-cell'));
    const input = await typeInto('secret-input', 'new-one');
    await pressEnter(input);
    expect(put).not.toHaveBeenCalledWith('/items/item1/cells/pwd/secret', { value: null });
    expect(put).toHaveBeenCalledWith('/items/item1/cells/pwd/secret', { value: 'new-one' });
  });

  it('one code + Enter verifies and reveals (it closed the panel; the code had to be typed again)', async () => {
    post.mockImplementation((path: string) => {
      if (path === '/secrets/verify') return Promise.resolve({ two_factor_enabled: true, verified_at: 'now' });
      // The reveal: refused until the code is verified.
      return post.mock.calls.some((c) => c[0] === '/secrets/verify')
        ? Promise.resolve({ value: 'plain', reveal_seconds: 30, copy_allowed: true })
        : Promise.reject(stepUp());
    });
    render({ value: MARKER });
    await click($('secret-reveal'));
    expect($('secret-code-panel')).not.toBeNull();
    const input = await typeInto('secret-code', '123456');
    await pressEnter(input);
    expect(post.mock.calls.filter((c) => c[0] === '/secrets/verify')).toEqual([
      ['/secrets/verify', { code: '123456' }],
    ]);
    expect($('secret-value')?.textContent).toBe('plain');
    expect($('secret-code-panel')).toBeNull();
  });
});

// Product decision ("deleting / replacing a secret — with a code?"): the server asks for the reveal's fresh code
// before a replace / clear (the column's setting); the cell shows the code panel and sends the change again after it.
describe('SecretCell: replace / clear behind the code', () => {
  it('replace → code panel ("verify before changing") → one code → the same change is sent again', async () => {
    put.mockRejectedValueOnce(stepUp()).mockResolvedValueOnce({});
    post.mockResolvedValue({ two_factor_enabled: true, verified_at: 'now' });
    render({ value: MARKER });
    await click($('secret-cell'));
    await pressEnter(await typeInto('secret-input', 'rotated'));
    expect($('secret-edit-panel')).toBeNull();
    expect($('secret-code-panel')).not.toBeNull();
    expect($('secret-code-panel')!.textContent).toContain(t('secret.code.titleChange'));
    expect($('secret-code-submit')!.textContent).toContain(t('secret.code.submitChange'));
    await pressEnter(await typeInto('secret-code', '654321'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/secrets/verify', { code: '654321' });
    expect(put.mock.calls).toEqual([
      ['/items/item1/cells/pwd/secret', { value: 'rotated' }],
      ['/items/item1/cells/pwd/secret', { value: 'rotated' }],
    ]);
    expect($('secret-code-panel')).toBeNull();
    expect($('secret-value')).toBeNull(); // a change never reveals
  });

  it('clear without 2FA → the "turn 2FA on" panel, nothing cleared', async () => {
    put.mockRejectedValue(
      new ApiError(403, { code: 'secret_two_factor_required', message: 'x', request_id: 'r' } as never),
    );
    render({ value: MARKER });
    await click($('secret-cell'));
    await click($('secret-clear'));
    expect($('secret-no2fa-panel')).not.toBeNull();
    expect($('secret-no2fa-panel')!.textContent).toContain(t('secret.no2fa.hintChange'));
  });

  it('a wrong code keeps the panel with the error; Cancel drops the pending change', async () => {
    put.mockRejectedValue(stepUp());
    post.mockRejectedValue(new ApiError(422, { code: 'secret_code_invalid', message: 'x', request_id: 'r' } as never));
    render({ value: MARKER });
    await click($('secret-cell'));
    await pressEnter(await typeInto('secret-input', 'rotated'));
    await pressEnter(await typeInto('secret-code', '000000'));
    expect($('secret-code-panel')).not.toBeNull();
    expect($('secret-error')?.textContent).toBeTruthy();
    expect(put).toHaveBeenCalledTimes(1);
    await click($('secret-code-cancel'));
    expect($('secret-code-panel')).toBeNull();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('the saved item goes straight into the board cache (the dots show without waiting for a refetch)', async () => {
    const qc = new QueryClient();
    const before = { id: 'item1', name: 'x', cells: {} };
    const after = { id: 'item1', name: 'x', cells: { pwd: { value: MARKER, text: null } }, event_id: null };
    qc.setQueryData(['account', 'acc', 'board', 'b1', 'items'], { data: [before, { id: 'other', cells: {} }] });
    put.mockResolvedValue(after);
    render({}, qc);
    await click($('secret-cell'));
    await pressEnter(await typeInto('secret-input', 'v'));
    const cached = qc.getQueryData<{ data: { id: string; cells: Record<string, unknown> }[] }>([
      'account',
      'acc',
      'board',
      'b1',
      'items',
    ]);
    expect(cached!.data[0]!.cells.pwd).toEqual({ value: MARKER, text: null });
    expect(cached!.data[1]!.id).toBe('other');
  });
});

describe('SecretCell: set / replace / clear from the cell', () => {
  it('an empty cell opens the set panel when the cell itself is clicked (not only the empty button)', async () => {
    render({});
    expect($('secret-cell')!.dataset.editable).toBe('true');
    await click($('secret-cell'));
    expect($('secret-edit-panel')).not.toBeNull();
  });

  it('saves the value through PUT …/secret without any 2FA step', async () => {
    put.mockResolvedValue({});
    render({});
    await click($('secret-masked'));
    await type('hunter2');
    await click($('secret-save'));
    expect(put).toHaveBeenCalledWith('/items/item1/cells/pwd/secret', { value: 'hunter2' });
    expect(post).not.toHaveBeenCalled(); // no /secrets/verify, no reveal
    expect($('secret-edit-panel')).toBeNull();
  });

  it('replaces and clears an existing value from the cell', async () => {
    put.mockResolvedValue({});
    render({ value: MARKER });
    expect($('secret-masked')!.textContent).toBe('••••••');
    await click($('secret-cell'));
    await type('new-one');
    await click($('secret-save'));
    expect(put).toHaveBeenLastCalledWith('/items/item1/cells/pwd/secret', { value: 'new-one' });
    await click($('secret-masked'));
    await click($('secret-clear'));
    expect(put).toHaveBeenLastCalledWith('/items/item1/cells/pwd/secret', { value: null });
  });

  it('shows the API error in the panel instead of failing silently', async () => {
    put.mockRejectedValue(
      new ApiError(503, { code: 'secret_master_key_missing', message: 'x', request_id: 'r' } as never),
    );
    render({});
    await click($('secret-cell'));
    await type('v');
    await click($('secret-save'));
    const panel = $('secret-edit-panel');
    expect(panel).not.toBeNull();
    expect($('secret-error')?.textContent).toBeTruthy();
  });

  it('the eye reveals without opening the set panel', async () => {
    post.mockResolvedValue({ value: 'plain', reveal_seconds: 30, copy_allowed: true });
    render({ value: MARKER });
    await click($('secret-reveal'));
    expect(post).toHaveBeenCalledWith('/items/item1/cells/pwd/secret/reveal');
    expect($('secret-edit-panel')).toBeNull();
    expect($('secret-value')!.textContent).toBe('plain');
  });

  it('a viewer without edit rights cannot open the set panel', async () => {
    render({ editable: false });
    await click($('secret-cell'));
    expect($('secret-edit-panel')).toBeNull();
  });
});

// a column setting for long secrets of several lines.
describe('SecretCell: long text (multiline setting)', () => {
  const long = { ...column, settings: { multiline: true } } as unknown as Column;
  const typeArea = async (value: string) => {
    const area = $('secret-input') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return area;
  };

  it('one line by default; with the setting a text area where Enter is a new line and Ctrl+Enter saves', async () => {
    render({});
    await click($('secret-cell'));
    expect($('secret-input')!.tagName).toBe('INPUT');
    act(() => root?.unmount());
    root = null;
    put.mockResolvedValue({});
    render({ column: long });
    await click($('secret-cell'));
    const area = await typeArea('line one\nline two');
    expect(area.tagName).toBe('TEXTAREA');
    await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(put).not.toHaveBeenCalled();
    await act(async () =>
      area.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    expect(put).toHaveBeenCalledWith('/items/item1/cells/pwd/secret', { value: 'line one\nline two' });
  });

  it('a revealed long value: its first line in the cell, the whole text beside it', async () => {
    post.mockResolvedValue({ value: 'user: dana\npass: hunter2', reveal_seconds: 30, copy_allowed: true });
    render({ column: long, value: MARKER });
    await click($('secret-reveal'));
    expect($('secret-value')!.textContent).toBe('user: dana');
    expect($('secret-value-full')!.textContent).toBe('user: dana\npass: hunter2');
  });
});
