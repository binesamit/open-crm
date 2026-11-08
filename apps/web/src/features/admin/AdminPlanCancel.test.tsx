// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyAccount } from '@bines/shared';

/**
 * "התוכנית שלי": the purchase documents are ticked before paying; "ביטול המנוי" shows what the server
 * computed (the case, the refund, the end date) and confirms with the refund shown; a cancel with nothing refunded is
 * taken back with "חזרה מהביטול".
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posts: { path: string; body: unknown }[] = [];
let cancellation: Record<string, unknown> | null = null;

const subscription = () => ({
  id: 'S1',
  account_id: 'A1',
  plan_id: 'P2',
  plan_name: 'Pro',
  plan_version_id: 'V1',
  version: 1,
  status: 'active',
  effective_status: 'active',
  status_since: '2026-01-01T00:00:00.000Z',
  interval: 'year',
  seats: null,
  period_start: '2026-01-01T00:00:00.000Z',
  period_end: '2027-01-01T00:00:00.000Z',
  trial_ends_at: null,
  cancel_at_period_end: !!cancellation,
  overrides: {},
  addons: {},
  note: null,
  status_message: null,
  provider: null,
  external_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  cancellation,
});
const plan = () => ({
  subscription: subscription(),
  entitlements: {},
  usage: [],
  history: [],
  upgrade: { text: null, url: null },
  features: [],
  feature_access: [],
});

vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async (path: string) => {
      if (path === '/plan') return plan();
      if (path === '/plans/public')
        return { data: [{ id: 'P2', name: 'Pro' }], upgrade: { text: null, url: null }, closed_text: null };
      if (path === '/plan/checkout')
        return {
          available: true,
          plans: [{ plan_id: 'P2', name: 'Pro', intervals: ['month'] }],
          addons: [],
          vat_pct: 18,
          legal: [
            {
              slug: 'subscription',
              title: { he: 'תנאי מנוי', en: 'Subscription terms' },
              version: 3,
              published_at: '2026-10-01T00:00:00.000Z',
              requires_consent: false,
              purchase_consent: true,
            },
          ],
        };
      if (path === '/plan/cancel')
        return {
          available: true,
          reason: null,
          case: 'yearly_no_refund',
          interval: 'year',
          currency: 'ILS',
          paid: 1000,
          monthly_price: 120,
          months_used: 9,
          fee: 0,
          refund: 0,
          ends_at: '2027-01-01T00:00:00.000Z',
          period_end: '2027-01-01T00:00:00.000Z',
          automatic_refund: false,
          terms: null,
        };
      throw new Error(path);
    },
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      if (path === '/plan/checkout') return { url: 'https://checkout.stripe.test/c/1' };
      if (path === '/plan/cancel') {
        cancellation = { case: 'yearly_no_refund', refund: 0, currency: 'ILS', at: 'x', resumable: true };
        return plan();
      }
      if (path === '/plan/cancel/undo') {
        cancellation = null;
        return plan();
      }
      throw new Error(path);
    },
  }),
  errorMessage: (e: unknown) => String(e),
}));

const { AdminPlan } = await import('./AdminPlan');

const account = { id: 'A1', slug: 'studio', name: 'Studio', role: 'admin', status: 'active' } as MyAccount;
let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const render = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(AdminPlan, { account }))),
  );
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => $(id)!.click());
  await flush();
};

beforeEach(() => {
  posts.length = 0;
  cancellation = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('buying: the purchase documents', () => {
  it('pays only once the subscription terms are ticked, and sends their version', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, configurable: true });
    await render();
    await click('plan-upgrade');
    expect($('plan-checkout-consent')!.textContent).toContain('תנאי מנוי');
    expect(($('plan-checkout-go') as HTMLButtonElement).disabled).toBe(true);
    await click('plan-checkout-consent-checkbox');
    expect(($('plan-checkout-go') as HTMLButtonElement).disabled).toBe(false);
    await click('plan-checkout-go');
    expect(posts.at(-1)).toMatchObject({
      path: '/plan/checkout',
      body: { plan_id: 'P2', accepted: [{ slug: 'subscription', version: 3 }] },
    });
  });
});

describe('cancelling', () => {
  it('shows the computed case and offers deleting the account; confirms with the refund shown', async () => {
    await render();
    await click('plan-cancel-open');
    expect($('plan-cancel-case')!.dataset.case).toBe('yearly_no_refund');
    expect($('plan-cancel-used')!.textContent).toContain('9');
    expect($('plan-cancel-delete-hint')!.querySelector('a')!.getAttribute('href')).toBe('/a/studio/admin/general');
    await click('plan-cancel-confirm');
    expect(posts.at(-1)).toEqual({ path: '/plan/cancel', body: { expected_refund: 0 } });
    expect($('plan-cancel-dialog')).toBeNull();
    expect($('plan-cancel-state')).not.toBeNull();
  });

  it('takes back a cancel that refunded nothing', async () => {
    cancellation = { case: 'period_end', refund: 0, currency: 'ILS', at: 'x', resumable: true };
    await render();
    expect($('plan-cancel-open')).toBeNull();
    await click('plan-cancel-undo');
    expect(posts.at(-1)).toEqual({ path: '/plan/cancel/undo', body: undefined });
    expect($('plan-cancel-open')).not.toBeNull();
  });
});
