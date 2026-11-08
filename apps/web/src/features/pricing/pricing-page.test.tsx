// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PublicPricing, setLocale, t } from '@bines/shared';

vi.mock('../../lib/branding', () => ({ useBranding: () => ({ productName: 'Bines OS' }), useSourceInfo: () => null }));
vi.mock('../legal/legal-links', () => ({ LegalLinks: () => null }));

const { PricingPage, pricingKey } = await import('./PricingPage');

/**
 * The public pricing page (canvas variant A): off = "not available"; on = the calculator and the
 * plan cards, every figure from the shared calculation as the people, the interval, VAT and add-ons change; the
 * buttons (trial at sign-up, else "talk to us"); the comparison table; the self-hosted tab only on a license server.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

const plan = (over: Partial<PublicPricing['plans'][number]>): PublicPricing['plans'][number] => ({
  id: 'P',
  name: 'Plan',
  description: null,
  highlights: [],
  recommended: false,
  min_seats: null,
  price_monthly: 0,
  price_yearly: 0,
  currency: 'ILS',
  vat_included: false,
  pricing: 'per_seat',
  trial_days: 0,
  limits: {},
  features: [],
  ...over,
});

const data = (over: Partial<PublicPricing> = {}): PublicPricing => ({
  enabled: true,
  headline: '',
  subheadline: '',
  yearly_note: 'Two months free',
  plans: [
    plan({ id: 'FREE', name: 'Free', limits: { seats: 2 }, highlights: ['Up to 2 people'] }),
    plan({
      id: 'PRO',
      name: 'Pro',
      description: 'For teams',
      recommended: true,
      price_monthly: 85,
      price_yearly: 828,
      trial_days: 14,
      limits: { storage_gb: 100 },
      features: [{ key: 'api', label: null }],
      highlights: ['API and MCP'],
    }),
  ],
  addons: [
    {
      id: 'ST',
      name: 'Storage 100GB',
      description: null,
      limit_kind: 'storage_gb',
      unit_amount: 100,
      price_monthly: 29,
      price_yearly: 290,
      currency: 'ILS',
      vat_included: false,
      plan_ids: [],
      max_qty: 20,
    },
  ],
  vat_pct: 18,
  vat_default_on: false,
  contact_url: 'mailto:sales@example.com',
  custom: { name: 'Enterprise', text: 'SSO and SLA' },
  faq: [{ q: 'What is a seat?', a: 'A person with a login.' }],
  signup_open: true,
  features: [],
  self_host: null,
  ...over,
});

const render = (d: PublicPricing, props: { tab?: 'cloud' | 'self'; embed?: boolean } = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(pricingKey, d);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(PricingPage, props)));
  });
};
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) => act(() => el!.click());
const text = (id: string) => $(id)?.textContent ?? '';
const typeIn = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  setLocale('en');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the pricing page', () => {
  it('off: says it is not available, nothing else', () => {
    render({ ...data(), enabled: false, plans: [] });
    expect($('pricing-off')).not.toBeNull();
    expect(host.textContent).toContain(t('pricing.unavailable'));
    expect($('pricing-calculator')).toBeNull();
  });

  it('on: the app’s title, yearly by default, each card’s price for the people chosen', () => {
    render(data());
    expect(host.textContent).toContain(t('pricing.headline'));
    expect(text('pricing-interval-year')).toContain('Two months free');
    // 5 people (the default), yearly: 828 / 12 = 69 a person a month → 345 a month, 4,140 a year.
    expect(text('pricing-plan-PRO-unit')).toBe('₪69');
    expect(text('pricing-plan-PRO-total')).toContain('₪345');
    expect(text('pricing-plan-PRO-total')).toContain('₪4,140');
    expect(text('pricing-plan-PRO-total')).toContain(t('pricing.save', { price: '₪960' }));
    // Free holds 2: 5 people do not fit.
    expect(text('pricing-plan-FREE-total')).toContain(t('pricing.noFit', { max: '2', seats: '5' }));
  });

  it('monthly, more people, VAT and an add-on change the figures at once', () => {
    render(data());
    click($('pricing-interval-month'));
    expect(text('pricing-plan-PRO-unit')).toBe('₪85');
    click($('pricing-seats-less'));
    click($('pricing-seats-less'));
    click($('pricing-seats-less'));
    expect(($('pricing-seats') as HTMLInputElement).value).toBe('2');
    expect(text('pricing-plan-PRO-total')).toContain('₪170');
    expect(text('pricing-plan-FREE-total')).toContain(t('pricing.free.noCard'));
    typeIn($('pricing-seats') as HTMLInputElement, '10');
    expect(text('pricing-plan-PRO-total')).toContain('₪850');
    click($('pricing-addon-ST-more'));
    expect(text('pricing-plan-PRO-total')).toContain('₪879');
    // The free plan takes no add-ons.
    expect(text('pricing-plan-FREE-total')).not.toContain('₪29');
    click($('pricing-vat'));
    expect(text('pricing-plan-PRO-unit')).toBe('₪100');
    expect(text('pricing-footnote')).toContain('including VAT');
  });

  it('buttons: a trial at sign-up when it is open (the plan picked), else “talk to us”', () => {
    render(data());
    expect($('pricing-cta-PRO')!.getAttribute('href')).toBe('/signup?plan=PRO');
    expect($('pricing-cta-PRO')!.textContent).toBe(t('pricing.cta.trial', { days: '14' }));
    expect($('pricing-cta-FREE')!.textContent).toBe(t('pricing.cta.free'));
    expect($('pricing-signup')).not.toBeNull();
    act(() => root!.unmount());
    root = createRoot(host);
    render(data({ signup_open: false }));
    expect($('pricing-cta-PRO')!.getAttribute('href')).toBe('mailto:sales@example.com');
    expect($('pricing-signup')).toBeNull();
  });

  it('the custom strip, the comparison table and the questions', () => {
    render(data());
    expect(text('pricing-custom')).toContain('Enterprise');
    const table = $('pricing-compare')!;
    expect(table.textContent).toContain(t('plan.kind.storage_gb'));
    expect(table.textContent).toContain(t('plan.feature.api'));
    expect(text('pricing-faq')).toContain('What is a seat?');
    expect(text('pricing-footnote')).toContain(t('pricing.foot.noMinimum'));
  });

  it('no self-hosted tab off a license server; on one, the editions with the tiers and a buy link', () => {
    render(data());
    expect($('pricing-tab-self')).toBeNull();
    act(() => root!.unmount());
    root = createRoot(host);
    render(
      data({
        self_host: {
          buy_available: true,
          editions: [
            {
              plan: 'business',
              currency: 'USD',
              tiers: [
                { index: 0, seats: 25, amount: 590 },
                { index: 1, seats: 100, amount: 1490 },
              ],
            },
          ],
        },
      }),
      { tab: 'self' },
    );
    expect($('pricing-self')).not.toBeNull();
    expect(text('pricing-self-business')).toContain('$590');
    click($('pricing-tier-1'));
    expect(text('pricing-self-business')).toContain('$1,490');
    expect($('pricing-self-buy')!.getAttribute('href')).toBe('/buy?plan=business&tier=1');
    click($('pricing-tab-cloud'));
    expect($('pricing-calculator')).not.toBeNull();
  });
});
