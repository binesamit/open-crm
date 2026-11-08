// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PricingPageSettings, setLocale } from '@bines/shared';

/**
 * Owner console → Plans: the add-ons card (list, a new add-on with its limit, unit, prices and plans)
 * and the pricing page card (the switch saves at once; the form sends the texts, VAT, questions and the sites).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: { method: string; path: string; body: unknown }[] = [];
const page: PricingPageSettings = {
  enabled: false,
  headline: '',
  subheadline: '',
  yearly_note: '',
  vat_pct: 18,
  vat_default_on: false,
  contact_url: null,
  custom_name: '',
  custom_text: '',
  faq: [],
  cors_origins: [],
};

vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async (path: string) => {
      if (path === '/platform/plan-addons') return { data: [] };
      if (path === '/platform/plans')
        return { data: [{ id: 'P1', name: 'Pro', archived: false, versions: [], current_version_id: null }] };
      if (path === '/platform/pricing-page') return page;
      throw new Error(path);
    },
    post: async (path: string, body: unknown) => {
      sent.push({ method: 'POST', path, body });
      return { id: 'A1', ...(body as object) };
    },
    patch: async (path: string, body: unknown) => {
      sent.push({ method: 'PATCH', path, body });
      return { ...page, ...(body as object) };
    },
    delete: async () => ({ ok: true }),
  }),
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../../lib/toast', () => ({ showToast: () => undefined }));

const { AddonsCard, PricingPageCard } = await import('./PricingCards');

let root: Root | null = null;
let host: HTMLDivElement;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const render = async (el: ReturnType<typeof createElement>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, el)));
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const type = async (el: HTMLElement | null, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = async (el: HTMLElement | null) => {
  await act(async () => el!.click());
  await flush();
};

beforeEach(() => {
  setLocale('en');
  sent.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the add-ons card', () => {
  it('a new add-on: name, the limit it raises, unit, prices, its plans', async () => {
    await render(createElement(AddonsCard));
    expect($('plan-addons')).not.toBeNull();
    await click($('addon-new'));
    await type($('addon-name'), 'Storage 100GB');
    await type($('addon-unit'), '100');
    await type($('addon-monthly'), '29');
    await type($('addon-yearly'), '290');
    const pro = Array.from(document.querySelectorAll<HTMLLabelElement>('[data-testid="addon-dialog"] label')).find(
      (l) => l.textContent === 'Pro',
    )!;
    await click(pro.querySelector('input'));
    await click($('addon-save'));
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      path: '/platform/plan-addons',
      body: {
        name: 'Storage 100GB',
        limit_kind: 'storage_gb',
        unit_amount: 100,
        price_monthly: 29,
        price_yearly: 290,
        currency: 'ILS',
        vat_included: false,
        max_qty: 20,
        active: true,
        plan_ids: ['P1'],
      },
    });
  });
});

describe('the pricing page card', () => {
  it('the switch saves at once; the form sends the texts, VAT, a question and the sites', async () => {
    await render(createElement(PricingPageCard));
    await click($('pricing-page-switch'));
    expect(sent.at(-1)).toEqual({ method: 'PATCH', path: '/platform/pricing-page', body: { enabled: true } });
    await type($('pricing-page-headline'), 'Clear pricing');
    await type($('pricing-page-vat'), '17');
    await type($('pricing-page-cors'), 'https://www.example.com/\nhttps://example.org');
    await act(async () => $('pricing-page-save')!.closest('form')!.requestSubmit());
    await flush();
    expect(sent.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/platform/pricing-page',
      body: {
        headline: 'Clear pricing',
        vat_pct: 17,
        contact_url: null,
        faq: [],
        cors_origins: ['https://www.example.com', 'https://example.org'],
      },
    });
  });
});
