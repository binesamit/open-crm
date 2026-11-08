// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@bines/sdk';
import { t, type SignupConfig } from '@bines/shared';

/**
 * Self sign-up pages (D32, canvas Main / Verify / Complete): closed, the form → "check your email" with the resend
 * countdown, the refusals in words, the email link (account opened / under review / invalid) and the details asked
 * after Google / Microsoft.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { method: string; path: string; body?: unknown };
const calls: Call[] = [];
let config: SignupConfig;
let answer: (c: Call) => unknown;
const navigate = vi.fn();
const social = vi.fn(async () => ({ error: null }));

vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async (path: string) => {
      const c = { method: 'GET', path };
      calls.push(c);
      if (path === '/public/signup/config') return config;
      return answer(c);
    },
    post: async (path: string, body: unknown) => {
      const c = { method: 'POST', path, body };
      calls.push(c);
      return answer(c);
    },
  }),
  errorMessage: (e: unknown) => (e instanceof ApiError ? `error:${e.body.code}` : String(e)),
  fetchMe: async () => ({ user: { id: 'u1', name: 'Noa Levi', email: 'noa@acme.test', avatar_url: null } }),
  queryKeys: { me: ['me'], myAccounts: ['me', 'accounts'] },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({
    children,
    to,
    search: _s,
    params: _p,
    ...rest
  }: { children: ReactNode; to: string } & Record<string, unknown>) =>
    createElement('a', { href: to, ...rest }, children),
}));
vi.mock('../../lib/branding', () => ({
  useAuthConfig: () => ({ data: { google: true, microsoft: false } }),
  useBranding: () => ({ productName: 'Bines OS', loginSubtitle: null }),
  useSourceInfo: () => null,
}));
vi.mock('../../lib/auth-client', () => ({ authClient: { signIn: { social } } }));
vi.mock('../forms/turnstile', () => ({
  useTurnstile: () => ({ ref: { current: null }, token: null, failed: false, reset: vi.fn() }),
}));
vi.mock('../legal/legal-links', () => ({
  LegalLinks: () => null,
  LegalConsentCheckbox: ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) =>
    createElement('input', {
      type: 'checkbox',
      'data-testid': 'legal-consent-checkbox',
      checked,
      onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked),
    }),
  useConsent: (checked: boolean) => ({ ok: checked, accepted: checked ? [{ slug: 'terms', version: 2 }] : [] }),
  MarketingOptInCheckbox: () => null,
}));

const { SignupPage } = await import('./SignupPage');
const { SignupVerifyPage } = await import('./SignupVerifyPage');
const { SignupCompletePage, resetCompleteTry } = await import('./SignupCompletePage');

const openConfig = (over: Partial<SignupConfig> = {}): SignupConfig => ({
  open: true,
  methods: ['password', 'google', 'microsoft'],
  choose_plan: true,
  default_plan_id: 'P2',
  plans: [
    {
      id: 'P1',
      name: 'Basic',
      description: null,
      price_monthly: 49,
      price_yearly: 490,
      currency: 'ILS',
      vat_included: true,
      pricing: 'flat',
      trial_days: 0,
      features: [],
      highlights: [],
      recommended: false,
      min_seats: null,
      limits: {},
    },
    {
      id: 'P2',
      name: 'Pro',
      description: null,
      price_monthly: 99,
      price_yearly: 990,
      currency: 'ILS',
      vat_included: true,
      pricing: 'flat',
      trial_days: 30,
      features: [],
      highlights: [],
      recommended: false,
      min_seats: null,
      limits: {},
    },
  ],
  trial_days: 14,
  legal: [],
  captcha_site_key: null,
  password_min_length: 10,
  link_hours: 24,
  resend_seconds: 60,
  mode: 'open',
  sample_boards: true,
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
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const type = async (id: string, value: string) => {
  const el = $(id) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = async (id: string) => {
  await act(async () => $(id)!.click());
  await flush();
};

beforeEach(() => {
  calls.length = 0;
  navigate.mockReset();
  social.mockClear();
  config = openConfig();
  answer = () => ({ ok: true });
  window.history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
});

describe('/signup', () => {
  it('closed: the closed screen with sign-in (and the owner’s contact link when set)', async () => {
    config = openConfig({ open: false });
    answer = (c) =>
      c.path === '/plans/public'
        ? { data: [], upgrade: { text: null, url: null }, contact_url: 'https://acme.test/contact', closed_text: null }
        : null;
    await render(createElement(SignupPage, {}));
    expect($('signup-closed')!.textContent).toContain(t('signup.closed.title'));
    expect($('signup-closed-login')!.getAttribute('href')).toBe('/login');
    expect($('signup-closed-contact')!.getAttribute('href')).toBe('https://acme.test/contact');
    expect($('signup-form')).toBeNull();
  });

  it('the form: trial chip of the chosen plan, only configured providers, plans with prices', async () => {
    await render(createElement(SignupPage, {}));
    expect($('signup-trial')!.textContent).toBe(t('signup.trialChip', { n: 30 }));
    expect($('signup-google')).not.toBeNull();
    // Microsoft is offered by the owner but not configured for sign-in: no button.
    expect($('signup-microsoft')).toBeNull();
    expect($('signup-plan-P1')!.textContent).toContain('Basic');
    // The default plan is pre-selected; choosing another changes the trial chip (its own days, else the setting).
    expect(($('signup-plan-P2')!.querySelector('input') as HTMLInputElement).checked).toBe(true);
    await act(async () => ($('signup-plan-P1')!.querySelector('input') as HTMLInputElement).click());
    expect($('signup-trial')!.textContent).toBe(t('signup.trialChip', { n: 14 }));
  });

  it('domain_join mode (ה7): join your organisation — no organisation field, no plans, no trial', async () => {
    config = openConfig({ mode: 'domain_join' });
    await render(createElement(SignupPage, {}));
    expect($('signup-page')!.textContent).toContain(t('signup.join.title'));
    expect($('signup-org')).toBeNull();
    expect($('signup-plans')).toBeNull();
    expect($('signup-trial')).toBeNull();
    expect($('signup-email')).not.toBeNull();
  });

  it('a password start → "check your email" with a resend countdown; "wrong address" goes back', async () => {
    await render(createElement(SignupPage, {}));
    await type('signup-name', 'Dana Levi');
    await type('signup-org', 'Studio Or');
    await type('signup-email', 'dana@acme.test');
    await type('signup-password', 'a-long-password');
    // The consent checkbox is required before submitting.
    expect(($('signup-submit') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => $('legal-consent-checkbox')!.click());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    const start = calls.find((c) => c.path === '/public/signup/start')!;
    expect(start.body).toMatchObject({
      name: 'Dana Levi',
      org_name: 'Studio Or',
      email: 'dana@acme.test',
      password: 'a-long-password',
      plan_id: 'P2',
      accept_legal: [{ slug: 'terms', version: 2 }],
    });
    expect($('signup-check-address')!.textContent).toBe('dana@acme.test');
    const resend = $('signup-resend') as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toBe(t('signup.check.resendIn', { time: '1:00' }));
    for (let i = 0; i < 61; i++) await act(async () => vi.advanceTimersByTime(1_000));
    await flush();
    expect(resend.disabled).toBe(false);
    await click('signup-resend');
    expect(calls.some((c) => c.path === '/public/signup/resend')).toBe(true);
    expect($('signup-resent')).not.toBeNull();
    await click('signup-wrong-address');
    expect($('signup-form')).not.toBeNull();
    expect(($('signup-email') as HTMLInputElement).value).toBe('dana@acme.test');
  });

  it('a refused address says why (the rule), a short password is caught first', async () => {
    answer = () => {
      throw new ApiError(422, {
        code: 'signup_email_not_allowed',
        request_id: 'r1',
        message: 'x',
        details: { reason: 'disposable' },
      });
    };
    await render(createElement(SignupPage, {}));
    await type('signup-name', 'D');
    await type('signup-org', 'O');
    await type('signup-email', 'd@mailinator.com');
    await type('signup-password', 'short');
    await act(async () => $('legal-consent-checkbox')!.click());
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    await flush();
    expect(calls.some((c) => c.path === '/public/signup/start')).toBe(false);
    expect($('signup-error')!.textContent).toContain('10');
    await type('signup-password', 'long-enough-pw');
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    await flush();
    expect($('signup-error')!.textContent).toBe(t('error.signup_email_not_allowed.disposable'));
  });

  it('Google: the intent first (what the form holds), then the provider with /signup/complete', async () => {
    await render(createElement(SignupPage, {}));
    await type('signup-org', 'Studio Or');
    await click('signup-google');
    const intent = calls.find((c) => c.path === '/public/signup/intent')!;
    expect(intent.body).toMatchObject({ method: 'google', org_name: 'Studio Or', plan_id: 'P2', accept_legal: [] });
    expect(social).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', callbackURL: '/signup/complete?via=google' }),
    );
  });
});

describe('/signup/verify', () => {
  it('opens the new account after the steps', async () => {
    window.history.replaceState(null, '', '/signup/verify#token=tok_aaaaaaaaaaaaaaaaaaaa');
    answer = () => ({
      status: 'provisioned',
      account: { id: 'A1', slug: 'studio-or', name: 'Studio Or' },
      request: { org_name: 'Studio Or', plan_name: 'Pro', trial_days: 30 },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(createElement(SignupVerifyPage));
    expect(window.location.hash).toBe('');
    expect($('signup-preparing')!.textContent).toContain(t('signup.preparing.accountNamed', { org: 'Studio Or' }));
    expect($('signup-preparing')!.textContent).toContain(t('signup.preparing.trial', { n: 30 }));
    await act(async () => vi.advanceTimersByTime(1_000));
    await flush();
    expect(navigate).toHaveBeenCalledWith({ to: '/a/$accountSlug', params: { accountSlug: 'studio-or' } });
    expect(calls.filter((c) => c.path === '/public/signup/verify')).toHaveLength(1);
  });

  it('manual approval: "being reviewed" with the organisation and plan', async () => {
    window.history.replaceState(null, '', '/signup/verify#token=tok_bbbbbbbbbbbbbbbbbbbb');
    answer = () => ({
      status: 'pending_approval',
      account: null,
      request: { org_name: 'Studio Or', plan_name: 'Pro', trial_days: 30 },
    });
    await render(createElement(SignupVerifyPage));
    expect($('signup-pending')).not.toBeNull();
    expect($('signup-pending-details')!.textContent).toContain(t('signup.pending.planTrial', { plan: 'Pro', n: 30 }));
  });

  it('a used or expired link: the problem screen', async () => {
    window.history.replaceState(null, '', '/signup/verify#token=tok_cccccccccccccccccccc');
    answer = () => {
      throw new ApiError(404, { code: 'verification_invalid', request_id: 'r1', message: 'x' });
    };
    await render(createElement(SignupVerifyPage));
    expect($('signup-verify-invalid-message')!.textContent).toBe(t('signup.problem.invalid'));
  });
});

describe('/signup/complete', () => {
  it('asks only what is missing, then sends it', async () => {
    resetCompleteTry();
    let n = 0;
    answer = (c) => {
      if (c.path !== '/public/signup/complete') return null;
      if (n++ === 0)
        throw new ApiError(422, {
          code: 'signup_details_required',
          request_id: 'r1',
          message: 'x',
          details: { missing: ['org_name', 'legal'] },
        });
      return {
        status: 'pending_approval',
        account: null,
        request: { org_name: 'Later', plan_name: null, trial_days: 14 },
      };
    };
    await render(createElement(SignupCompletePage, { via: 'google' }));
    expect($('signup-complete')!.textContent).toContain(t('signup.complete.titleMany'));
    expect($('signup-complete-who')!.textContent).toContain(t('signup.complete.viaGoogle'));
    expect(($('signup-complete-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('signup-complete-org', 'Later');
    await act(async () => $('legal-consent-checkbox')!.click());
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    await flush();
    const sent = calls.filter((c) => c.path === '/public/signup/complete');
    expect(sent[1]!.body).toMatchObject({
      org_name: 'Later',
      plan_id: 'P2',
      accept_legal: [{ slug: 'terms', version: 2 }],
    });
    expect($('signup-pending')).not.toBeNull();
  });

  it('someone who already had an account is told so', async () => {
    resetCompleteTry();
    answer = () => {
      throw new ApiError(409, { code: 'signup_already_registered', request_id: 'r1', message: 'x' });
    };
    await render(createElement(SignupCompletePage, {}));
    expect($('signup-registered')).not.toBeNull();
  });
});
