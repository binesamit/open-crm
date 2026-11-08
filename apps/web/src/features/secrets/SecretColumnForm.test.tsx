// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Column } from '@bines/shared';
import type * as ApiModule from '../../lib/api';
import type { BoardDetail } from '../board/board-api';

/**
 * a secret column's settings guard its secrets, so the server takes a fresh two-factor code for any
 * change to them. The settings form asks first: no 2FA → "turn it on" and nothing is sent; no fresh code → the code
 * field, then the settings are saved; a fresh code, or no real change, saves at once.
 */
const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post, put: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../board/board-api', () => ({ useMembers: () => ({ data: { data: [] } }) }));

const { SecretColumnForm } = await import('./SecretColumnForm');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const column = { id: 'pwd', type: 'secret', title: 'סיסמה', settings: {}, read_only: false } as unknown as Column;
let root: Root | null = null;
let onSave: ReturnType<typeof vi.fn<(settings: Record<string, unknown>) => Promise<unknown>>>;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  onSave = vi.fn(async () => undefined);
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    // the form reads the board's loaded items (a column with values keeps its kind).
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(SecretColumnForm, {
          accountId: 'acc',
          board: { id: 'b1' } as BoardDetail,
          column,
          busy: false,
          onSave,
          shell: (body: ReactNode, save: ReactNode) => createElement('div', null, body, save),
        }),
      ),
    );
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  expect($(id)).not.toBeNull();
  await act(async () => $(id)!.click());
};
const typeCode = async (value: string) => {
  const input = $('secret-settings-code-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('secret column settings: the two-factor step-up', () => {
  it('nothing guarded changed: saves at once, no code asked', async () => {
    await click('column-settings-save');
    expect(get).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('no 2FA: says to turn it on, sends nothing', async () => {
    get.mockResolvedValue({ two_factor_enabled: false, verified_at: null });
    await click('secret-copy-allowed');
    await click('column-settings-save');
    expect(get).toHaveBeenCalledWith('/secrets/status');
    expect($('secret-settings-no2fa')).not.toBeNull();
    expect(($('column-settings-save') as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('no fresh code: the code field, then verify and save', async () => {
    get.mockResolvedValue({ two_factor_enabled: true, verified_at: null });
    post.mockResolvedValue({ two_factor_enabled: true, verified_at: new Date().toISOString() });
    await click('secret-copy-allowed');
    await click('column-settings-save');
    expect($('secret-settings-code')).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    await typeCode('123456');
    await click('column-settings-save');
    expect(post).toHaveBeenCalledWith('/secrets/verify', { code: '123456' });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ copy_allowed: false }));
  });

  it('a fresh code: saves at once', async () => {
    get.mockResolvedValue({ two_factor_enabled: true, verified_at: new Date().toISOString() });
    await click('secret-copy-allowed');
    await click('column-settings-save');
    expect($('secret-settings-code')).toBeNull();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ copy_allowed: false }));
  });
});
