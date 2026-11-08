// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signupSettingsSchema, t, type SignupRequest, type SignupSettingsResponse } from '@bines/shared';

/**
 * Owner console, self sign-up (canvas OwnerSettings / OwnerQueue, screens 10–11): the card's readiness list and save
 * (with the trial emails), and the requests queue — shown with approval on or once requests exist; approve / reject.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { method: string; path: string; body?: unknown };
const calls: Call[] = [];
let settings: SignupSettingsResponse;
let requests: SignupRequest[];

vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      if (path === '/platform/signup-settings') return settings;
      if (path === '/platform/billing-settings') return { read_only_days: 30 };
      if (path.startsWith('/platform/signup-requests')) {
        const status = new URLSearchParams(path.split('?')[1]).get('status');
        return { data: requests.filter((r) => !status || r.status === status), next: null };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: 'POST', path, body });
      return {};
    },
    patch: async (path: string, body: unknown) => {
      calls.push({ method: 'PATCH', path, body });
      return settings;
    },
  }),
  errorMessage: (e: unknown) => String(e),
  queryKeys: { platformAccounts: ['platform', 'accounts'] },
}));
vi.mock('../../lib/branding', () => ({ useAuthConfig: () => ({ data: { google: true, microsoft: false } }) }));
vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('./console-links', () => ({ useConsoleJump: () => vi.fn() }));
vi.mock('./StarterKits', () => ({ useKits: () => ({ data: { data: [] } }), kitName: (k: { name: string }) => k.name }));
vi.mock('./Plans', () => ({
  usePlans: () => ({
    data: {
      data: [
        {
          id: 'P1',
          name: 'Basic',
          visibility: 'public',
          archived: false,
          current_version_id: 'V1',
          versions: [{ id: 'V1' }],
        },
      ],
    },
  }),
}));

const { SignupSettingsCard } = await import('./SignupSettings');
const { SignupRequestsPanel } = await import('./SignupRequests');

const response = (over: Partial<SignupSettingsResponse> = {}): SignupSettingsResponse => ({
  settings: signupSettingsSchema.parse({ default_plan_id: 'P1' }),
  ready: false,
  missing: ['captcha', 'legal'],
  open: false,
  ...over,
});
const request = (over: Partial<SignupRequest> = {}): SignupRequest => ({
  id: 'R1',
  email: 'dana@studio.test',
  name: 'Dana Levi',
  org_name: 'Studio Or',
  method: 'google',
  status: 'pending_approval',
  plan_version_id: 'V1',
  locale: 'he',
  ip: null,
  user_agent: null,
  account_id: null,
  user_id: null,
  reason: null,
  decided_by: null,
  decided_at: null,
  verified_at: new Date().toISOString(),
  expires_at: null,
  created_at: new Date().toISOString(),
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const render = async (el: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(createElement(QueryClientProvider, { client: qc }, el)));
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => $(id)!.click());
  await flush();
};

beforeEach(() => {
  calls.length = 0;
  settings = response();
  requests = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the self sign-up card', () => {
  it('lists what is ready and what is missing, from the server', async () => {
    await render(createElement(SignupSettingsCard));
    expect($('signup-settings-state')!.textContent).toBe(t('signup.settings.state.off'));
    expect($('signup-readiness')!.textContent).toContain(t('signup.ready.many', { n: 2 }));
    expect($('signup-ready-email')!.dataset.ok).toBe('true');
    expect($('signup-ready-captcha')!.dataset.ok).toBe('false');
    expect($('signup-ready-legal')!.textContent).toContain(t('signup.missing.legal'));
    // Registering, or a key, is never a requirement.
    expect($('signup-ready-registration')).toBeNull();
    expect($('signup-ready-enterprise')).toBeNull();
    // The methods as chips (on by default).
    expect(($('signup-set-method-google') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
  });

  it('saves every setting, the trial emails in the PATCH shape, and the suspension days on billing', async () => {
    await render(createElement(SignupSettingsCard));
    await click('signup-set-captcha');
    await click('signup-set-enabled');
    await click('signup-email-reminder_first-enabled');
    await click('signup-email-welcome-text');
    expect($('signup-email-welcome-subject')).not.toBeNull();
    await click('signup-settings-save');
    const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/platform/signup-settings')!.body as {
      emails: Record<string, Record<string, unknown>>;
    };
    expect(patch).toMatchObject({ enabled: true, require_captcha: false, trial_days: 14, default_plan_id: 'P1' });
    expect(patch.emails.reminder_first).toMatchObject({ enabled: false, days: 3 });
    // The emails sent at the moment itself take no days.
    expect(patch.emails.welcome).not.toHaveProperty('days');
    // Unchanged: billing settings are not written.
    expect(calls.some((c) => c.path === '/platform/billing-settings' && c.method === 'PATCH')).toBe(false);
  });
});

describe('the requests queue', () => {
  it('hidden while approval is off and nothing was ever asked', async () => {
    await render(createElement(SignupRequestsPanel));
    expect($('signup-requests')).toBeNull();
  });

  it('waiting requests: approve opens the account, reject asks for a reason and the domain block', async () => {
    settings = response({ settings: signupSettingsSchema.parse({ approval: true }) });
    requests = [request(), request({ id: 'R2', email: 'uri@other.test', status: 'rejected', reason: 'spam' })];
    await render(createElement(SignupRequestsPanel));
    expect($('signup-requests-waiting')!.textContent).toBe(t('signup.requests.waiting', { n: 1 }));
    const row = $('signup-request-dana@studio.test')!;
    expect(row.textContent).toContain('Studio Or · Dana Levi');
    expect(row.textContent).toContain('Basic');
    expect(row.textContent).toContain('Google');
    await act(async () => row.querySelector<HTMLElement>('[data-testid="signup-request-approve"]')!.click());
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/platform/signup-requests/R1/approve')).toBe(true);

    await act(async () => row.querySelector<HTMLElement>('[data-testid="signup-request-reject"]')!.click());
    await flush();
    const reason = $('signup-reject-reason') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reason, 'Not a fit');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('signup-reject-block');
    await click('signup-reject-confirm');
    expect(calls.find((c) => c.path === '/platform/signup-requests/R1/reject')!.body).toEqual({
      reason: 'Not a fit',
      block_domain: true,
    });

    // The other tabs list the ended requests (with the rejection's reason).
    await click('signup-requests-tab-rejected');
    expect($('signup-request-uri@other.test')!.textContent).toContain(t('signup.requests.reason', { reason: 'spam' }));
  });
});
