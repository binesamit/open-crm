// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyAccount } from '@bines/shared';
import type * as ApiModule from '../../../lib/api';
import type { Me } from '../../../lib/api';

/**
 * Errors hub (product decision: the warning triangle is not shown all the time in the top bar): the counts sit where
 * they belong — the unread error alerts on the console's "Errors & health" tab (owner and support staff only; nobody
 * else makes a call), the account's open errors on Administration → Health.
 */
const get = vi.fn();
vi.mock('../../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), Link: () => null }));

const { ErrorCount, useUnreadErrorAlerts } = await import('./ErrorCount');
const { useOpenHealthCount } = await import('../../admin/AdminHealth');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const me = (user: Partial<Me['user']>) =>
  ({ user: { id: 'u1', is_platform_owner: false, support_role: null, ...user } }) as unknown as Me;
const account = { id: 'a1', slug: 'acme', name: 'Acme', role: 'admin' } as unknown as MyAccount;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  get.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const AlertsCount = ({ who }: { who: Me }) => createElement(ErrorCount, { n: useUnreadErrorAlerts(who), testId: 'n' });
const HealthCount = () => createElement(ErrorCount, { n: useOpenHealthCount(account), testId: 'n' });

const render = async (el: ReturnType<typeof createElement>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(QueryClientProvider, { client: qc }, el));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const count = () => host.querySelector('[data-testid="n"]')?.textContent ?? null;

describe('ErrorCount', () => {
  it('shows nothing at zero, and caps at 99+', async () => {
    await render(createElement(ErrorCount, { n: 0, testId: 'n' }));
    expect(count()).toBeNull();
    act(() => root?.unmount());
    await render(createElement(ErrorCount, { n: 250, testId: 'n' }));
    expect(count()).toBe('99+');
  });

  it('unread alerts: a regular member makes no call and sees nothing', async () => {
    await render(createElement(AlertsCount, { who: me({}) }));
    expect(get).not.toHaveBeenCalled();
    expect(count()).toBeNull();
  });

  it('unread alerts: the platform owner and support staff see the count', async () => {
    get.mockResolvedValue({ data: [], unread: 3 });
    await render(createElement(AlertsCount, { who: me({ is_platform_owner: true }) }));
    expect(get).toHaveBeenCalledWith('/platform/errors/alerts');
    expect(count()).toBe('3');
    act(() => root?.unmount());
    get.mockResolvedValue({ data: [], unread: 2 });
    await render(createElement(AlertsCount, { who: me({ support_role: 'agent' } as Partial<Me['user']>) }));
    expect(count()).toBe('2');
  });

  it("Health: the account's open errors, nothing while the page is off", async () => {
    get.mockResolvedValue({ enabled: true, open: 4, occurrences_24h: 9, data: [] });
    await render(createElement(HealthCount));
    expect(get).toHaveBeenCalledWith('/account-health?state=open');
    expect(count()).toBe('4');
    act(() => root?.unmount());
    get.mockResolvedValue({ enabled: false, open: 4, occurrences_24h: 9, data: [] });
    await render(createElement(HealthCount));
    expect(count()).toBeNull();
  });
});
