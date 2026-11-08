// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDeletionStatus, AccountExport, MyAccount, PendingDeletion } from '@bines/shared';

/**
 * the account data dialogs — the export panel, "Delete the account" (export offered, the name, a fresh
 * two-factor code; no 2FA = no way through), the locked "scheduled for deletion" screen (admins cancel; members do
 * not) and the owner console's "delete now" (the slug and the owner's code).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { method: string; path: string; body?: unknown }[] = [];
let exportsList: AccountExport[];
let status: AccountDeletionStatus;
const signOut = vi.fn();

vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      if (path === '/account-export') return { data: exportsList };
      if (path === '/account-deletion') return status;
      if (path.endsWith('/download')) return { url: 'https://files.test/x.zip' };
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      if (path === '/account-export') return { ...ready, id: 'E2', status: 'pending' };
      return { ok: true };
    },
  }),
  errorMessage: (e: unknown) => String(e),
  queryKeys: { me: ['me'], myAccounts: ['me', 'accounts'], platformAccounts: ['platform', 'accounts'] },
}));
vi.mock('../shell/use-profile', () => ({ useProfile: () => ({ list: [], switchTo: vi.fn(), signOut }) }));
vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

const { DeleteAccountDialog, ExportPanel } = await import('./AccountData');
const { AccountDeletionScreen } = await import('../shell/AccountDeletion');
const { DeleteNowDialog } = await import('../owner/PendingDeletions');

const ready: AccountExport = {
  id: 'E1',
  status: 'ready',
  requested_by: { id: 'u1', name: 'Dana' },
  created_at: '2026-10-01T10:00:00Z',
  finished_at: '2026-10-01T10:01:00Z',
  expires_at: '2099-10-08T10:01:00Z',
  size_bytes: 3 * 1024 * 1024,
  summary: { boards: 2, docs: 1, files: 4, users: 3, skipped: [] },
  error: null,
};
const acme = { id: 'A1', name: 'Acme Ltd', slug: 'acme', role: 'admin', status: 'active' } as unknown as MyAccount;
const me = { user: { id: 'u1', email: 'dana@acme.test', name: 'Dana' } } as never;

let root: Root;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const render = async (el: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, el)));
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => $(id)!.click());
  await flush();
};
const type = (id: string, value: string) =>
  act(() => {
    const input = $(id) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  calls.length = 0;
  exportsList = [ready];
  status = {
    scheduled_at: null,
    due_at: null,
    requested_by: null,
    two_factor_enabled: true,
    grace_days: 30,
    export_days: 7,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('export panel', () => {
  it('shows a ready export with its download, and starts a new one', async () => {
    await render(createElement(ExportPanel, { accountId: 'A1' }));
    expect($('account-export-ready')).toBeTruthy();
    expect($('account-export-summary')!.textContent).toContain('4');
    await click('account-export-start');
    expect(calls).toContainEqual({ method: 'POST', path: '/account-export', body: undefined });
  });

  it('says it is being built, without a start button', async () => {
    exportsList = [{ ...ready, status: 'running', expires_at: null }];
    await render(createElement(ExportPanel, { accountId: 'A1' }));
    expect($('account-export-building')).toBeTruthy();
    expect($('account-export-start')).toBeNull();
  });
});

describe('delete account dialog', () => {
  it('offers the export, then asks for the exact name, then the code', async () => {
    await render(createElement(DeleteAccountDialog, { account: acme, status, onClose: vi.fn() }));
    expect($('account-export')).toBeTruthy();
    await click('delete-account-next');
    const next = $('delete-account-name-next') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await type('delete-account-name', 'Acme');
    expect(($('delete-account-name-next') as HTMLButtonElement).disabled).toBe(true);
    await type('delete-account-name', ' acme ltd ');
    expect(($('delete-account-name-next') as HTMLButtonElement).disabled).toBe(false);
    await click('delete-account-name-next');
    expect(($('delete-account-confirm') as HTMLButtonElement).disabled).toBe(true);
    await type('delete-account-code', '123456');
    await click('delete-account-confirm');
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/account-deletion',
      body: { confirm_name: ' acme ltd ', code: '123456' },
    });
  });

  it('without two-factor sign-in the last step explains it and cannot be passed', async () => {
    status = { ...status, two_factor_enabled: false };
    await render(createElement(DeleteAccountDialog, { account: acme, status, onClose: vi.fn() }));
    await click('delete-account-next');
    await type('delete-account-name', 'Acme Ltd');
    await click('delete-account-name-next');
    expect($('delete-account-no2fa')).toBeTruthy();
    expect($('delete-account-confirm')).toBeNull();
  });
});

describe('scheduled for deletion screen', () => {
  beforeEach(() => {
    status = {
      ...status,
      scheduled_at: '2026-10-01T00:00:00Z',
      due_at: '2026-10-31T00:00:00Z',
      requested_by: { id: 'u1', name: 'Dana' },
    };
  });

  it('an admin sees the date, the export and cancels', async () => {
    await render(createElement(AccountDeletionScreen, { me, account: { ...acme, deletion_due_at: status.due_at } }));
    expect($('account-deletion-title')!.textContent).toContain('Acme Ltd');
    expect($('account-deletion-date')!.textContent).toBeTruthy();
    expect($('account-export')).toBeTruthy();
    await click('account-deletion-cancel');
    expect(calls).toContainEqual({ method: 'POST', path: '/account-deletion/cancel', body: undefined });
  });

  it('a member sees the date but no cancel and no export; Esc does not close it', async () => {
    await render(
      createElement(AccountDeletionScreen, {
        me,
        account: { ...acme, role: 'member', deletion_due_at: status.due_at } as MyAccount,
      }),
    );
    expect($('account-deletion-cancel')).toBeNull();
    expect($('account-export')).toBeNull();
    await act(async () => {
      $('account-deletion')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect($('account-deletion')).toBeTruthy();
    await click('deletion-sign-out');
    expect(signOut).toHaveBeenCalled();
  });
});

describe('owner console: delete now', () => {
  it('needs the exact slug and a code', async () => {
    const row: PendingDeletion = {
      id: 'A1',
      name: 'Acme Ltd',
      slug: 'acme',
      scheduled_at: '2026-10-01T00:00:00Z',
      due_at: '2026-10-31T00:00:00Z',
      requested_by: null,
    };
    const onDone = vi.fn(async () => undefined);
    await render(createElement(DeleteNowDialog, { row, onClose: vi.fn(), onDone }));
    await type('owner-delete-now-slug', 'acm');
    await type('owner-delete-now-code', '654321');
    expect(($('owner-delete-now-confirm') as HTMLButtonElement).disabled).toBe(true);
    await type('owner-delete-now-slug', 'acme');
    await click('owner-delete-now-confirm');
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/platform/accounts/A1/deletion/now',
      body: { confirm_slug: 'acme', code: '654321' },
    });
    expect(onDone).toHaveBeenCalled();
  });
});
