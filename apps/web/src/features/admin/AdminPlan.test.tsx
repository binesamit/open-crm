// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@bines/sdk';
import { t, type MyAccount } from '@bines/shared';

/** "התוכנית שלי" → "בקשת שדרוג" (self sign-up ה5): admins on a trial ask for an upgrade; a notice, or the 429 words. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const posts: { path: string; account?: string; body: unknown }[] = [];
let refuse = false;
let online = false;
let perSeat = false;

vi.mock('../../lib/api', () => ({
  api: (account?: string) => ({
    get: async (path: string) => {
      if (path === '/plans/public')
        return {
          data: [
            perSeat
              ? {
                  id: 'P2',
                  name: 'Pro',
                  price_monthly: 85,
                  price_yearly: 828,
                  vat_included: false,
                  pricing: 'per_seat',
                  min_seats: 3,
                  currency: 'ILS',
                  limits: {},
                }
              : { id: 'P2', name: 'Pro' },
          ],
          upgrade: { text: null, url: null },
          closed_text: null,
          contact_url: null,
        };
      if (path === '/plan') return null;
      if (path === '/plan/checkout')
        return online
          ? {
              available: true,
              plans: [{ plan_id: 'P2', name: 'Pro', intervals: ['month', 'year'] }],
              addons: perSeat
                ? [
                    {
                      id: 'ST',
                      name: 'Storage',
                      description: null,
                      limit_kind: 'storage_gb',
                      unit_amount: 100,
                      price_monthly: 29,
                      price_yearly: 290,
                      currency: 'ILS',
                      vat_included: false,
                      plan_ids: [],
                      max_qty: 5,
                      intervals: ['month'],
                    },
                  ]
                : [],
              vat_pct: 18,
            }
          : { available: false, plans: [], addons: [], vat_pct: 18 };
      throw new Error(path);
    },
    post: async (path: string, body: unknown) => {
      posts.push({ path, account, body });
      if (path === '/plan/checkout') return { url: 'https://checkout.stripe.test/c/1' };
      if (refuse)
        throw new ApiError(429, { code: 'rate_limited', request_id: 'r1', message: 'upgrade_request_rate_limited' });
      return { ok: true, ticket_id: null };
    },
  }),
  errorMessage: (e: unknown) =>
    e instanceof ApiError && e.body.message === 'upgrade_request_rate_limited'
      ? 'error:upgrade_request_rate_limited'
      : String(e),
}));

const { AdminPlan } = await import('./AdminPlan');

const account = (over: Partial<MyAccount> = {}) =>
  ({
    id: 'A1',
    slug: 'studio',
    name: 'Studio',
    role: 'admin',
    status: 'active',
    plan_status: 'trial',
    ...over,
  }) as MyAccount;

let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const render = async (a: MyAccount) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // The plan itself loads as a minimal object: the header's buttons show once it is there.
  qc.setQueryData(['account', a.id, 'plan'], {
    subscription: null,
    entitlements: {},
    usage: [],
    history: [],
    upgrade: { text: null, url: null },
    features: [],
    feature_access: [],
  });
  await act(async () =>
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(AdminPlan, { account: a }))),
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
  refuse = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('upgrade request', () => {
  it('only admins, only during a trial', async () => {
    await render(account({ role: 'member' }));
    expect($('plan-upgrade-request')).toBeNull();
    act(() => root!.unmount());
    root = createRoot(host);
    await render(account({ plan_status: 'active' }));
    expect($('plan-upgrade-request')).toBeNull();
  });

  it('sends the note, then a success notice; a second try too soon says so', async () => {
    await render(account());
    await click('plan-upgrade-request');
    expect($('plan-upgrade-request-dialog')).not.toBeNull();
    const note = $('plan-upgrade-request-note') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'We grew');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('plan-upgrade-request-send');
    expect(posts[0]).toEqual({
      path: '/plan/upgrade-request',
      account: 'A1',
      body: { plan_id: null, note: 'We grew' },
    });
    expect($('plan-upgrade-request-sent')!.textContent).toBe(t('plan.upgradeRequest.sent'));
    expect($('plan-upgrade-request-dialog')).toBeNull();

    refuse = true;
    await click('plan-upgrade-request');
    await click('plan-upgrade-request-send');
    expect($('plan-upgrade-request-error')!.textContent).toBe('error:upgrade_request_rate_limited');
  });
});

describe('Upgrade with online payment (ה9)', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    posts.length = 0;
  });
  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    online = false;
  });

  it('when the platform sells its plans: plan + interval → Stripe’s page', async () => {
    online = true;
    const assign = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, search: '', assign } });
    await render(account());
    await click('plan-upgrade');
    expect($('plan-checkout-dialog')).not.toBeNull();
    await click('plan-checkout-interval-year');
    await click('plan-checkout-go');
    expect(posts.at(-1)).toMatchObject({
      path: '/plan/checkout',
      account: 'A1',
      body: { plan_id: 'P2', interval: 'year' },
    });
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/c/1');
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
  });

  it('a per-seat plan (): at least its minimum of seats, add-ons sold online, the total; all sent', async () => {
    online = true;
    perSeat = true;
    const assign = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, search: '', assign } });
    await render(account());
    await click('plan-upgrade');
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(($('plan-checkout-seats') as HTMLInputElement).value).toBe('1');
    expect($('plan-checkout-seats-min')!.textContent).toContain('3');
    // Monthly: 3 seats × 85 = 255.
    await click('plan-checkout-interval-month');
    expect($('plan-checkout-total')!.textContent).toContain('255');
    await click('pricing-addon-ST-more');
    expect($('plan-checkout-total')!.textContent).toContain('284');
    await click('plan-checkout-go');
    expect(posts.at(-1)).toMatchObject({
      path: '/plan/checkout',
      body: { plan_id: 'P2', interval: 'month', seats: 3, addons: { ST: 1 } },
    });
    // Yearly: the add-on has no yearly price, so it is not offered (nor sent).
    await click('plan-checkout-interval-year');
    expect($('pricing-addon-ST')).toBeNull();
    perSeat = false;
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
  });

  it('otherwise Upgrade shows the owner’s text, as before', async () => {
    await render(account());
    await click('plan-upgrade');
    expect($('plan-checkout-dialog')).toBeNull();
    expect($('plan-upgrade-dialog')).not.toBeNull();
  });
});
