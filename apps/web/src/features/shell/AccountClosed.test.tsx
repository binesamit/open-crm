// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type MyAccount, type PlanOffer } from '@bines/shared';

/**
 * plan-lock: the closed-account screen — the account's name and why, the offered plans, "contact
 * us" (a support ticket from the screen, or the owner's link), the other accounts and sign-out; nothing closes it.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { method: string; path: string; account?: string; body?: unknown }[] = [];
let offer: PlanOffer;
let ticketOptions: { enabled: boolean; may_open: boolean };
const signOut = vi.fn();
const switchTo = vi.fn();
let accounts: MyAccount[];

vi.mock('../../lib/api', () => ({
  api: (account?: string) => ({
    get: async (path: string) => {
      calls.push({ method: 'GET', path, account });
      if (path === '/plans/public') return offer;
      if (path === '/support/tickets/options') return ticketOptions;
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: 'POST', path, account, body });
      return { id: 't1' };
    },
  }),
  errorMessage: (e: unknown) => String(e),
  queryKeys: { me: ['me'], myAccounts: ['me', 'accounts'] },
}));
vi.mock('./use-profile', () => ({
  useProfile: () => ({ list: accounts, switchTo, signOut }),
}));

const { AccountClosedScreen, contactWayOf } = await import('./AccountClosed');

const acme = {
  id: 'A1',
  name: 'Acme',
  slug: 'acme',
  role: 'member',
  status: 'active',
  plan_status: 'closed',
  plan_status_message: 'Unpaid since June',
} as unknown as MyAccount;
const other = { ...acme, id: 'B2', name: 'Beta', slug: 'beta', plan_status: 'active' } as unknown as MyAccount;
const me = { user: { id: 'u1', email: 'bob@acme.test', name: 'Bob' } } as never;

let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const render = async (account: MyAccount = acme) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      createElement(QueryClientProvider, { client: qc }, createElement(AccountClosedScreen, { me, account })),
    );
  });
  await flush();
};
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  calls.length = 0;
  signOut.mockReset();
  switchTo.mockReset();
  accounts = [acme, other];
  offer = {
    data: [
      {
        id: 'P1',
        name: 'Team',
        description: 'For small teams',
        price_monthly: 49,
        price_yearly: 490,
        currency: 'ILS',
        vat_included: true,
        pricing: 'flat',
        trial_days: 14,
        features: [{ key: 'crm', label: 'CRM' }],
        highlights: [],
        recommended: false,
        min_seats: null,
        limits: {},
      },
    ],
    upgrade: { text: null, url: null },
    closed_text: null,
    contact_url: null,
  };
  ticketOptions = { enabled: true, may_open: true };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('AccountClosedScreen', () => {
  it('shows the account, why it is closed and the offered plans — and fetches nothing of the account', async () => {
    await render();
    expect($('account-closed')!.getAttribute('role')).toBe('alertdialog');
    expect($('account-closed-title')!.textContent).toContain('Acme');
    expect($('account-closed-reason')!.textContent).toBe('Unpaid since June');
    expect($('closed-plan-P1')!.textContent).toContain('Team');
    expect($('closed-plan-P1')!.textContent).toContain('CRM');
    // Only the allowlist: the offered plans (no account) and the support form's options.
    for (const c of calls) expect(['/plans/public', '/support/tickets/options']).toContain(c.path);
  });

  it('falls back to the platform text, then to the app’s own', async () => {
    offer.closed_text = 'Call us at 03-0000000';
    // The live list (/me/accounts) is what the screen reads: the owner cleared the account's message.
    accounts = [{ ...acme, plan_status_message: null } as MyAccount];
    await render(acme);
    expect($('account-closed-reason')!.textContent).toBe('Call us at 03-0000000');
    act(() => root!.unmount());
    root = createRoot(host);
    offer.closed_text = null;
    await render(acme);
    expect($('account-closed-reason')!.textContent).toBe(t('closed.defaultText' as never));
  });

  it('cannot be dismissed: no close button, Esc does nothing', async () => {
    await render();
    const screen = $('account-closed')!;
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      screen.dispatchEvent(esc);
    });
    expect($('account-closed')).not.toBeNull();
    const labels = [...screen.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(labels.some((l) => /close|סגירה/i.test(l ?? ''))).toBe(false);
  });

  it('"choose a plan" opens the contact form with the plan, and sends a support ticket from the account', async () => {
    await render();
    act(() => $('closed-choose-P1')!.click());
    const text = host.querySelector<HTMLTextAreaElement>('[data-testid="closed-contact-message"]')!;
    expect(text.value).toContain('Team');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="closed-contact-form"]')!.requestSubmit();
    });
    await flush();
    const sent = calls.find((c) => c.method === 'POST');
    expect(sent).toMatchObject({ path: '/support/tickets', account: 'A1' });
    expect($('closed-contact-sent')).not.toBeNull();
  });

  it('with the owner’s contact link, "contact us" is that link', async () => {
    offer.contact_url = 'mailto:sales@example.com';
    await render();
    expect($('closed-contact')!.getAttribute('href')).toBe('mailto:sales@example.com');
  });

  it('switch account lists the other accounts; sign out signs out', async () => {
    await render();
    act(() => $('closed-switch-beta')!.click());
    expect(switchTo).toHaveBeenCalledWith(other);
    expect($('closed-switch-acme')).toBeNull();
    act(() => $('closed-sign-out')!.click());
    expect(signOut).toHaveBeenCalled();
  });

  it('no other account: no switch', async () => {
    accounts = [acme];
    await render();
    expect($('closed-switch')).toBeNull();
  });
});

describe('contactWayOf', () => {
  const base: PlanOffer = { data: [], upgrade: { text: null, url: null }, closed_text: null, contact_url: null };
  it('the owner’s contact link first, then a ticket, then the upgrade link, then words', () => {
    expect(contactWayOf({ ...base, contact_url: 'https://x.test' }, true)).toEqual({
      kind: 'url',
      url: 'https://x.test',
    });
    expect(contactWayOf(base, true)).toEqual({ kind: 'ticket' });
    expect(contactWayOf({ ...base, upgrade: { text: null, url: 'https://u.test' } }, false)).toEqual({
      kind: 'url',
      url: 'https://u.test',
    });
    expect(contactWayOf({ ...base, upgrade: { text: 'Call', url: null } }, false)).toEqual({
      kind: 'none',
      text: 'Call',
    });
  });

  it('every text of the screen exists in Hebrew and English', () => {
    for (const key of [
      'closed.title',
      'closed.defaultText',
      'closed.plans',
      'closed.choose',
      'closed.contact',
      'closed.switch',
      'closed.signOut',
      'error.account_closed',
      'plan.status.closed',
      'plan.ai.blocked',
      'ai2.assistant.off.plan_status',
    ]) {
      expect(t(key as never, { name: 'X' }, 'he')).not.toBe(key);
      expect(t(key as never, { name: 'X' }, 'en')).not.toBe(t(key as never, { name: 'X' }, 'he'));
    }
  });
});
