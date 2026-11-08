// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegalDocSummary } from '@bines/shared';
import type * as ApiModule from '../../lib/api';

/**
 * Legal documents in the web app: the links come from what the platform published (none = nothing shown)
 * the sign-up checkbox lists every document that requires consent and gates the button, and what a join sends.
 */
const get = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post: vi.fn() }),
}));
const { LegalConsentCheckbox, LegalLinks, legalHref, requiredAcceptances, useConsent } = await import('./legal-links');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (slug: string, requires: boolean, version = 1): LegalDocSummary => ({
  slug,
  title: { he: `${slug}-he`, en: `${slug}-en` },
  version,
  published_at: '2026-10-09T00:00:00.000Z',
  requires_consent: requires,
  purchase_consent: false,
});
const DOCS = [doc('terms', true, 3), doc('privacy', true), doc('cookies', false), doc('licenses', false)];

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  get.mockReset();
  document.documentElement.lang = 'he';
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
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

describe('legal links', () => {
  it('builds addresses and the acceptances a join sends', () => {
    expect(legalHref('terms')).toBe('/legal/terms');
    expect(legalHref('privacy', 'en')).toBe('/legal/privacy?locale=en');
    expect(requiredAcceptances(DOCS)).toEqual([
      { slug: 'terms', version: 3 },
      { slug: 'privacy', version: 1 },
    ]);
    expect(requiredAcceptances(undefined)).toEqual([]);
  });

  it('shows the documents that need consent first, then "all documents"', async () => {
    get.mockResolvedValue({ data: DOCS, consent_checkbox: false });
    await render(createElement(LegalLinks, {}));
    const links = [...host.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links.slice(0, 2)).toEqual([
      ['terms-he', '/legal/terms'],
      ['privacy-he', '/legal/privacy'],
    ]);
    expect(links[2]?.[1]).toBe('/legal');
  });

  it('shows nothing when nothing is published', async () => {
    get.mockResolvedValue({ data: [], consent_checkbox: false });
    await render(createElement(LegalLinks, {}));
    expect(host.querySelector('[data-testid="legal-links"]')).toBeNull();
  });

  const Probe = () => {
    const [on, setOn] = useState(false);
    const c = useConsent(on);
    return createElement(
      'div',
      null,
      createElement(LegalConsentCheckbox, { checked: on, onChange: setOn }),
      createElement('span', { 'data-testid': 'ok' }, `${c.ok}:${c.accepted.map((a) => a.slug).join(',')}`),
    );
  };
  const ok = () => host.querySelector('[data-testid="ok"]')!.textContent;

  it('by default joining agrees ("by joining you agree to …") and sends the current versions', async () => {
    get.mockResolvedValue({ data: DOCS, consent_checkbox: false });
    await render(createElement(Probe));
    expect(host.querySelector('[data-testid="legal-consent-checkbox"]')).toBeNull();
    expect([...host.querySelectorAll('[data-testid="legal-consent"] a')].map((a) => a.textContent)).toEqual([
      'terms-he',
      'privacy-he',
    ]);
    expect(ok()).toBe('true:terms,privacy');
  });

  it('with the checkbox setting, joining waits for the tick', async () => {
    get.mockResolvedValue({ data: DOCS, consent_checkbox: true });
    await render(createElement(Probe));
    expect(ok()).toBe('false:');
    const box = host.querySelector<HTMLInputElement>('[data-testid="legal-consent-checkbox"]')!;
    await act(async () => box.click());
    expect(ok()).toBe('true:terms,privacy');
  });

  it('nothing requiring consent: nothing shown, nothing sent', async () => {
    get.mockResolvedValue({ data: [doc('cookies', false)], consent_checkbox: true });
    await render(createElement(Probe));
    expect(host.querySelector('[data-testid="legal-consent"]')).toBeNull();
    expect(ok()).toBe('true:');
  });
});
