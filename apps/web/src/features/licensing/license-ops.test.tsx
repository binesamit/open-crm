// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IssuedLicense, type LicenseOps, type LicensingSettings, t } from '@bines/shared';
import { BuyPage, goTo, purchaseConfigKey } from './BuyPage';
import { LicenseOpsCards, parseDays } from './LicenseOpsCards';
import { licensingKeys } from './licensing-api';
import { LicensesPanel } from './LicenseServerPanels';
import { LicensingSettingsCard } from './LicensingSettingsCard';

/**
 * License operations in the owner console and the public purchase page: the Reminders and
 * Payments cards (only on a license server; secrets write-only), the "reminder sent" / "paid online" markers in
 * the Licenses list, and the purchase UI — hidden unless the license server sells online.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
let calls: { method: string; url: string; body: unknown }[] = [];
let answers: Record<string, unknown> = {};

const ops = (over: Partial<LicenseOps['payments']> = {}): LicenseOps => ({
  reminders: { enabled: true, days: [30, 7] },
  payments: {
    provider: 'stripe',
    enabled: false,
    secret_key_set: false,
    webhook_secret_set: false,
    plans: {
      business: { price_id: '', seats: null, mode: 'subscription', display_amount: null, currency: 'USD', tiers: [] },
      enterprise: { price_id: '', seats: null, mode: 'subscription', display_amount: null, currency: 'USD', tiers: [] },
    },
    ready: false,
    webhook_url: 'https://lic.example/api/v1/public/licenses/webhook/stripe',
    buy_url: 'https://lic.example/buy',
    ...over,
  },
});

const render = (el: ReactElement, seed: (qc: QueryClient) => void = () => undefined) => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  seed(qc);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, el));
  });
  return qc;
};
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const submitOf = (el: HTMLElement) => act(() => el.closest('form')!.requestSubmit());

beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = new URL(url, 'http://app.test').pathname.replace('/api/v1', '');
      const res = answers[`${method} ${path}`] ?? {};
      return new Response(JSON.stringify(res), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('Reminders and Payments cards', () => {
  it('are not shown where this is not a license server', () => {
    render(createElement(LicenseOpsCards), (qc) => {
      qc.setQueryData(licensingKeys.server, { enabled: false, source: 'none', public_key: null, fingerprint: null });
      qc.setQueryData(licensingKeys.ops, ops());
    });
    expect($('license-reminders')).toBeNull();
    expect($('license-payments')).toBeNull();
  });

  it('shows the reminder days and saves valid ones only', async () => {
    render(createElement(LicenseOpsCards), (qc) => {
      qc.setQueryData(licensingKeys.server, {
        enabled: true,
        source: 'env',
        public_key: 'pem',
        fingerprint: 'SHA256:x',
      });
      qc.setQueryData(licensingKeys.ops, ops());
    });
    const days = $('license-reminders-days') as HTMLInputElement;
    expect(days.value).toBe('30, 7');
    expect(parseDays('30, 7, 7')).toBeNull();
    expect(parseDays('0')).toBeNull();
    expect(parseDays('14 3')).toEqual([14, 3]);
    answers['PATCH /platform/license-ops'] = ops();
    type(days, '14, 3');
    submitOf(days);
    await flush();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ reminders: { days: [14, 3] } });
  });

  it('Payments: off and not live by default; secrets are write-only; saving sends only what was typed', async () => {
    render(createElement(LicenseOpsCards), (qc) => {
      qc.setQueryData(licensingKeys.server, {
        enabled: true,
        source: 'env',
        public_key: 'pem',
        fingerprint: 'SHA256:x',
      });
      qc.setQueryData(licensingKeys.ops, ops({ secret_key_set: true }));
    });
    expect($('license-payments-state')!.dataset.ready).toBe('no');
    expect($('license-payments-webhook-url')!.textContent).toContain('/public/licenses/webhook/stripe');
    // A stored secret is never put back in the field — only "set".
    expect(($('license-payments-secret') as HTMLInputElement).value).toBe('');
    expect($('license-payments-secret-clear')).not.toBeNull();
    expect($('license-payments-webhook-secret-clear')).toBeNull();

    answers['PATCH /platform/license-ops'] = ops();
    type($('license-payments-webhook-secret') as HTMLInputElement, 'whsec_abcdefgh12345');
    type($('license-payments-price-business') as HTMLInputElement, 'price_123');
    type($('license-payments-seats-business') as HTMLInputElement, '25');
    act(() => $('license-payments-mode-business-payment')!.click());
    submitOf($('license-payments-save')!);
    await flush();
    const patch = calls.find((c) => c.method === 'PATCH')!.body as { payments: Record<string, unknown> };
    expect(patch.payments.webhook_secret).toBe('whsec_abcdefgh12345');
    expect('secret_key' in patch.payments).toBe(false);
    expect(patch.payments.plans).toEqual({
      business: {
        price_id: 'price_123',
        seats: 25,
        mode: 'payment',
        display_amount: null,
        currency: 'USD',
        tiers: [],
      },
      enterprise: { price_id: '', seats: null, mode: 'subscription', display_amount: null, currency: 'USD', tiers: [] },
    });
  });

  it('shows "live" once ready', () => {
    render(createElement(LicenseOpsCards), (qc) => {
      qc.setQueryData(licensingKeys.server, {
        enabled: true,
        source: 'env',
        public_key: 'pem',
        fingerprint: 'SHA256:x',
      });
      qc.setQueryData(licensingKeys.ops, ops({ enabled: true, ready: true }));
    });
    expect($('license-payments-state')!.dataset.ready).toBe('yes');
  });
});

describe('Licenses list markers', () => {
  const lic: IssuedLicense = {
    id: '01J0000000000000000000000B',
    ref: 'LIC-1',
    licensee: 'Big Co',
    plan: 'business',
    features: [],
    seats: 10,
    instance_id: null,
    expires: '2027-10-01T00:00:00Z',
    grace_days: 14,
    support: 'standard',
    email: 'big@co.test',
    state: 'expiring',
    key: 'lic1.x.y',
    issued_at: '2026-10-01T00:00:00Z',
    revoked_at: null,
    reminders: [
      { days: 30, sent_at: '2027-09-01T00:00:00Z' },
      { days: 7, sent_at: '2027-09-24T00:00:00Z' },
    ],
    payment_provider: 'stripe',
  };

  it('marks the reminders sent and a license paid online', () => {
    render(createElement(LicensesPanel), (qc) => {
      qc.setQueryData(licensingKeys.server, {
        enabled: true,
        source: 'env',
        public_key: 'pem',
        fingerprint: 'SHA256:x',
      });
      qc.setQueryData(licensingKeys.licenses, {
        data: [lic, { ...lic, id: 'x2', ref: 'LIC-2', reminders: [], payment_provider: null }],
      });
    });
    const [paid, manual] = [...host.querySelectorAll<HTMLElement>('[data-testid="license-row"]')];
    expect(
      [...paid!.querySelectorAll<HTMLElement>('[data-testid="license-reminder"]')].map((e) => e.dataset.days),
    ).toEqual(['30', '7']);
    expect(paid!.querySelector('[data-testid="license-paid"]')).not.toBeNull();
    expect(manual!.querySelector('[data-testid="license-reminder"]')).toBeNull();
    expect(manual!.querySelector('[data-testid="license-paid"]')).toBeNull();
  });
});

describe('Purchase UI', () => {
  it('the public page shows only "not available" when the license server does not sell online', () => {
    render(createElement(BuyPage, {}), (qc) => qc.setQueryData(purchaseConfigKey, { available: false, plans: [] }));
    expect($('buy-unavailable')).not.toBeNull();
    expect($('buy-form')).toBeNull();
    expect($('buy-continue')).toBeNull();
  });

  it('the public page offers the priced editions and goes to the provider', async () => {
    const go = vi.spyOn(goTo, 'href').mockImplementation(() => undefined);
    render(createElement(BuyPage, { plan: 'enterprise', instance: 'inst-12345678' }), (qc) =>
      qc.setQueryData(purchaseConfigKey, {
        available: true,
        plans: [
          { plan: 'business', seats: 25, amount: 590, currency: 'USD', tiers: [] },
          { plan: 'enterprise', seats: null, amount: null, currency: 'USD', tiers: [] },
        ],
      }),
    );
    expect($('buy-unavailable')).toBeNull();
    expect($('buy-plan-business')!.textContent).toContain('25');
    expect($('buy-plan-business')!.textContent).toContain('$590');
    expect(($('buy-instance') as HTMLInputElement).value).toBe('inst-12345678');
    answers['POST /public/licenses/checkout'] = { url: 'https://checkout.stripe.test/x' };
    submitOf($('buy-continue')!);
    await flush();
    await flush();
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      plan: 'enterprise',
      instance_id: 'inst-12345678',
    });
    expect(go).toHaveBeenCalledWith('https://checkout.stripe.test/x');
    go.mockRestore();
  });

  const settings: LicensingSettings = {
    instance_id: '11111111-2222-3333-4444-555555555555',
    server_url: 'https://licenses.example',
    server_url_source: 'setting',
    server_url_setting: 'https://licenses.example',
    server_public_key: 'pem',
    server_key_fingerprint: 'SHA256:x',
    registration: { status: 'registered', email: null, at: null, ask: false },
    offline_register_url: null,
    telemetry: {
      enabled: false,
      forced_off: false,
      last_sent_at: null,
      preview: { instance_id: '11111111-2222-3333-4444-555555555555', version: '1', active_users: 1, boards: 1 },
    },
    update_check_forced_off: false,
  };

  it('the installation shows "Buy a license" only when its license server sells online', () => {
    render(createElement(LicensingSettingsCard), (qc) => {
      qc.setQueryData(licensingKeys.settings, settings);
      qc.setQueryData(licensingKeys.form, { available: true, captcha_site_key: null, purchase_available: false });
    });
    expect($('licensing-buy')).toBeNull();
    act(() => root!.unmount());
    root = createRoot(host);
    render(createElement(LicensingSettingsCard), (qc) => {
      qc.setQueryData(licensingKeys.settings, settings);
      qc.setQueryData(licensingKeys.form, { available: true, captcha_site_key: null, purchase_available: true });
    });
    expect($('licensing-buy')!.getAttribute('href')).toBe(
      'https://licenses.example/buy?instance=11111111-2222-3333-4444-555555555555',
    );
  });

  it('has its texts in Hebrew and English', () => {
    for (const key of [
      'licensing.buy.unavailable',
      'licensing.ops.payments.hint',
      'licensing.ops.reminders.hint',
      'licensing.mail.reminder.subject',
      'licensing.mail.reminderOwner.intro',
    ] as const) {
      expect(t(key, undefined, 'he')).not.toBe(key);
      expect(t(key, undefined, 'en')).not.toBe(t(key, undefined, 'he'));
    }
  });
});
