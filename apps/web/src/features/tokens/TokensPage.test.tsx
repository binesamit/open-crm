// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@bines/sdk';
import type { CreatedToken, MyAccount } from '@bines/shared';
import type * as ApiModule from '../../lib/api';

/**
 * S-85: minting a personal `secrets:read` token takes a fresh two-factor code. The "new token" dialog asks for it the
 * way the secret column does: no 2FA → the scope is off with "turn on 2FA"; no fresh code → the code field in the
 * dialog, then the token is created; a fresh code creates at once; a `secret_step_up_required` answer from the server
 * opens the same code field.
 */
const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../automations/automations-api', () => ({ useAllBoards: () => [] }));

const { CreateDialog } = await import('./TokensPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const admin = { id: 'a1', slug: 'acme', name: 'Acme', role: 'admin' } as unknown as MyAccount;
const member = { ...admin, role: 'member' } as unknown as MyAccount;
const CREATED = { id: 't1', name: 'script', token: 'bos_pat_x', scopes: ['secrets:read'] };
const stepUpError = () =>
  new ApiError(403, { code: 'secret_step_up_required', message: 'STEP-UP-NEEDED', request_id: 'r' } as never);

let root: Root | null = null;
let host: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn<(created?: CreatedToken) => void>>;
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  onClose = vi.fn<(created?: CreatedToken) => void>();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const render = async (account: MyAccount, service = false) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(CreateDialog, { account, service, onClose })),
    );
  });
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  expect($(id)).not.toBeNull();
  await act(async () => $(id)!.click());
  await flush();
};
const type = async (id: string, value: string) => {
  const input = $(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const tokenCalls = () => post.mock.calls.filter(([path]) => path === '/auth/tokens');
const status = (s: { two_factor_enabled: boolean; verified_at: string | null }) =>
  get.mockImplementation(async (path: string) => (path === '/secrets/status' ? s : { data: [] }));

describe('new token dialog: secrets:read takes a fresh two-factor code (S-85)', () => {
  it('a member is never offered the scope and no status is read', async () => {
    await render(member);
    expect($('token-scope-secrets:read')).toBeNull();
    expect(get).not.toHaveBeenCalledWith('/secrets/status');
  });

  it('no 2FA: the scope is off with the "turn on 2FA" notice', async () => {
    status({ two_factor_enabled: false, verified_at: null });
    await render(admin);
    expect(get).toHaveBeenCalledWith('/secrets/status');
    expect($('token-secrets-no2fa')).not.toBeNull();
    const row = $('token-scope-secrets:read') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute('aria-checked')).toBe('false');
  });

  it('no fresh code: the code field, then verify and create', async () => {
    status({ two_factor_enabled: true, verified_at: null });
    post.mockImplementation(async (path: string) => (path === '/auth/tokens' ? CREATED : {}));
    await render(admin);
    await type('token-name', 'script');
    await click('token-scope-secrets:read');
    await click('token-create-confirm');
    expect($('token-secrets-code')).not.toBeNull();
    expect(tokenCalls()).toHaveLength(0);
    expect(($('token-create-confirm') as HTMLButtonElement).disabled).toBe(true);
    await type('token-secrets-code-input', '123456');
    await click('token-create-confirm');
    expect(post).toHaveBeenCalledWith('/secrets/verify', { code: '123456' });
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]![1]).toEqual(expect.objectContaining({ scopes: expect.arrayContaining(['secrets:read']) }));
    expect(onClose).toHaveBeenCalledWith(CREATED);
  });

  it('a wrong code: the error in the panel, nothing created', async () => {
    status({ two_factor_enabled: true, verified_at: null });
    post.mockImplementation(async (path: string) => {
      if (path === '/secrets/verify')
        throw new ApiError(422, { code: 'secret_code_invalid', message: 'bad code', request_id: 'r' } as never);
      return CREATED;
    });
    await render(admin);
    await type('token-name', 'script');
    await click('token-scope-secrets:read');
    await click('token-create-confirm');
    await type('token-secrets-code-input', '000000');
    await click('token-create-confirm');
    expect($('token-secrets-code-error')).not.toBeNull();
    expect(tokenCalls()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a fresh code: creates at once', async () => {
    status({ two_factor_enabled: true, verified_at: new Date().toISOString() });
    post.mockResolvedValue(CREATED);
    await render(admin);
    await type('token-name', 'script');
    await click('token-scope-secrets:read');
    await click('token-create-confirm');
    expect($('token-secrets-code')).toBeNull();
    expect(tokenCalls()).toHaveLength(1);
    expect(onClose).toHaveBeenCalledWith(CREATED);
  });

  it('the server asks for the code anyway: the same code field, then the token is created', async () => {
    status({ two_factor_enabled: true, verified_at: new Date().toISOString() });
    let first = true;
    post.mockImplementation(async (path: string) => {
      if (path === '/auth/tokens' && first) {
        first = false;
        throw stepUpError();
      }
      return path === '/auth/tokens' ? CREATED : {};
    });
    await render(admin);
    await type('token-name', 'script');
    await click('token-scope-secrets:read');
    await click('token-create-confirm');
    expect($('token-secrets-code')).not.toBeNull();
    // The server's answer opens the step; it is not shown as an error.
    expect(document.body.textContent).not.toContain('STEP-UP-NEEDED');
    await type('token-secrets-code-input', '123456');
    await click('token-create-confirm');
    expect(post).toHaveBeenCalledWith('/secrets/verify', { code: '123456' });
    expect(tokenCalls()).toHaveLength(2);
    expect(onClose).toHaveBeenCalledWith(CREATED);
  });

  it('other scopes need no code and no status check before creating', async () => {
    status({ two_factor_enabled: true, verified_at: null });
    post.mockResolvedValue({ ...CREATED, scopes: ['boards:read'] });
    await render(admin);
    await type('token-name', 'script');
    get.mockClear();
    await click('token-create-confirm');
    expect(get).not.toHaveBeenCalled();
    expect(tokenCalls()).toHaveLength(1);
  });

  it('a service token never reads my step-up', async () => {
    await render(admin, true);
    expect(get).not.toHaveBeenCalledWith('/secrets/status');
  });
});
