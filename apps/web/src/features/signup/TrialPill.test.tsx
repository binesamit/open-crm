// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type MyAccount } from '@bines/shared';

/** The trial pill of a self sign-up account (canvas Welcome, screen 7). */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let path = '/a/studio';
const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: path } }),
  Link: ({ children, params: _p, ...rest }: { children: ReactNode } & Record<string, unknown>) =>
    createElement('a', rest, children),
}));

const { TrialPill, daysLeft } = await import('./TrialPill');

const account = (over: Partial<MyAccount> = {}) =>
  ({
    id: 'A1',
    slug: 'studio',
    name: 'Studio',
    role: 'admin',
    status: 'active',
    origin: 'signup',
    ...over,
  }) as MyAccount;

let root: Root | null = null;
let host: HTMLDivElement;
const render = async (el: ReactNode) => {
  await act(async () => root!.render(el));
};
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  path = '/a/studio';
  navigate.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('TrialPill', () => {
  it('"N trial days left" during a trial, with "upgrade" for admins only', async () => {
    const ends = new Date(Date.now() + 13.2 * 86_400_000).toISOString();
    expect(daysLeft(ends)).toBe(14);
    await render(createElement(TrialPill, { account: account({ plan_status: 'trial', trial_ends_at: ends }) }));
    expect($('trial-pill')!.textContent).toContain(t('trial.pill', { n: 14 }));
    expect($('trial-pill-upgrade')).not.toBeNull();
    await render(
      createElement(TrialPill, { account: account({ role: 'member', plan_status: 'trial', trial_ends_at: ends }) }),
    );
    expect($('trial-pill-upgrade')).toBeNull();
    await render(createElement(TrialPill, { account: account({ plan_status: 'active', trial_ends_at: null }) }));
    expect($('trial-pill')).toBeNull();
  });
});
