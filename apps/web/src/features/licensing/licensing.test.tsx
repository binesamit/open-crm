// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Installation,
  type IssuedLicense,
  type LicenseServerStatus,
  type LicenseStatus,
  type LicensingSettings,
  LICENSED_FEATURE_KEYS,
  t,
} from '@bines/shared';
import { LicenseCard } from '../owner/LicenseCard';
import { licensingKeys } from './licensing-api';
import { InstallationsPanel, LicenseServerCard, LicensesPanel } from './LicenseServerPanels';
import { LicensingSettingsCard } from './LicensingSettingsCard';
import { RegistrationForm } from './RegistrationForm';

/**
 * Licensing in the app (docs/LICENSING.md): the registration questionnaire (optional, unavailable without a license
 * server, the marketing box unticked), the provider's key beside the server address, the license card's states and
 * banners, and the license server's screens: the signing key ("Create a signing key", remove), Installations /
 * Licenses ("not a license server", the list, the issue form preset from the plan).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
let calls: { method: string; url: string; body: unknown }[] = [];
let answers: Record<string, unknown> = {};

const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtest\n-----END PUBLIC KEY-----';
const server = (over: Partial<LicenseServerStatus> = {}): LicenseServerStatus => ({
  enabled: true,
  source: 'env',
  public_key: PEM,
  fingerprint: 'SHA256:abcd1234',
  ...over,
});
const settings = (over: Partial<LicensingSettings> = {}): LicensingSettings => ({
  instance_id: '11111111-2222-3333-4444-555555555555',
  server_url: 'https://licenses.example',
  server_url_source: 'setting',
  server_url_setting: 'https://licenses.example',
  server_public_key: PEM,
  server_key_fingerprint: 'SHA256:abcd1234',
  registration: { status: 'unasked', email: null, at: null, ask: true },
  offline_register_url: 'https://licenses.example/register?instance=11111111-2222-3333-4444-555555555555',
  telemetry: {
    enabled: false,
    forced_off: false,
    last_sent_at: null,
    preview: { instance_id: '11111111-2222-3333-4444-555555555555', version: '1.0.0', active_users: 3, boards: 4 },
  },
  update_check_forced_off: false,
  ...over,
});
const status = (over: Partial<LicenseStatus> = {}): LicenseStatus => ({
  state: 'none',
  problem: null,
  licensee: null,
  features: [],
  expires: null,
  id: null,
  issued_at: null,
  installed_at: null,
  plan: null,
  support: null,
  seats: null,
  seats_used: 3,
  seats_exceeded: false,
  grace_days: null,
  grace_ends: null,
  days_left: null,
  key_instance_id: null,
  instance_id: '11111111-2222-3333-4444-555555555555',
  checked_at: null,
  ee_features: [...LICENSED_FEATURE_KEYS],
  ...over,
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

describe('RegistrationForm', () => {
  it('says "registration unavailable" with no license server', () => {
    render(createElement(RegistrationForm, {}), (qc) =>
      qc.setQueryData(
        licensingKeys.settings,
        settings({ server_url: '', server_url_source: 'none', server_url_setting: null, offline_register_url: null }),
      ),
    );
    expect($('registration')!.dataset.state).toBe('unavailable');
    expect($('registration')!.textContent).toContain(t('licensing.register.unavailable'));
  });

  it('sends the answers (marketing off unless ticked) and then waits for the email', async () => {
    answers['POST /platform/registration'] = settings({
      registration: { status: 'pending', email: 'it@acme.test', at: null, ask: false },
    });
    render(createElement(RegistrationForm, {}), (qc) => {
      qc.setQueryData(licensingKeys.settings, settings());
      qc.setQueryData(licensingKeys.form, { available: true, captcha_site_key: null });
    });
    expect(($('registration-submit') as HTMLButtonElement).disabled).toBe(true);
    type($('registration-company') as HTMLInputElement, 'Acme');
    act(() => $('registration-size-6-20')!.click());
    act(() => $('registration-use-crm')!.click());
    type($('registration-email') as HTMLInputElement, 'it@acme.test');
    act(() => $('registration-submit')!.click());
    await flush();
    const sent = calls.find((c) => c.method === 'POST' && c.url.endsWith('/platform/registration'));
    expect(sent?.body).toMatchObject({
      company: 'Acme',
      size: '6-20',
      use_case: 'crm',
      email: 'it@acme.test',
      marketing_opt_in: false,
    });
    expect($('registration')!.dataset.state).toBe('pending');
    expect($('registration-offline')).not.toBeNull();
  });
});

describe('LicenseCard', () => {
  const card = (s: LicenseStatus, set: LicensingSettings = settings()) =>
    render(createElement(LicenseCard), (qc) => {
      qc.setQueryData(licensingKeys.license, s);
      qc.setQueryData(licensingKeys.settings, set);
    });

  it('no key: "Get a free key" and the installation id', () => {
    card(status());
    expect($('owner-license-state')!.dataset.state).toBe('none');
    expect($('owner-license-free')).not.toBeNull();
    expect($('owner-license-banner')).toBeNull();
    expect($('owner-license-instance')!.textContent).toContain('11111111-2222');
  });

  it('valid: plan, seats, expiry; no banner; the online check is offered', () => {
    card(
      status({
        state: 'valid',
        licensee: 'Acme',
        plan: 'business',
        seats: 50,
        expires: '2099-01-01T00:00:00Z',
        grace_days: 14,
        grace_ends: '2099-01-15T00:00:00Z',
        days_left: 200,
        features: ['saml'],
      }),
    );
    expect($('owner-license-plan')!.textContent).toBe(t('licensing.plan.business'));
    expect($('owner-license-seats')!.textContent).toBe(t('owner.license.seatsOf', { used: 3, seats: 50 }));
    expect($('owner-license-banner')).toBeNull();
    expect($('owner-license-free')).toBeNull();
    expect($('owner-license-check')).not.toBeNull();
  });

  it.each([
    ['expiring', 'expiring'],
    ['grace', 'grace'],
    ['expired', 'expired'],
    ['revoked', 'revoked'],
  ] as const)('%s: a banner', (state, banner) => {
    card(
      status({
        state,
        plan: 'business',
        expires: '2099-01-01T00:00:00Z',
        grace_ends: '2099-01-15T00:00:00Z',
        days_left: 5,
      }),
    );
    expect($('owner-license-state')!.dataset.state).toBe(state);
    expect($('owner-license-banner')!.dataset.banner).toBe(banner);
  });

  it('above the seats: a warning banner, still valid', () => {
    card(status({ state: 'valid', plan: 'business', seats: 2, seats_used: 3, seats_exceeded: true }));
    expect($('owner-license-banner')!.dataset.banner).toBe('seats');
  });

  it('no online check when the server forces it off', () => {
    card(status({ state: 'valid', plan: 'registered' }), settings({ update_check_forced_off: true }));
    expect($('owner-license-check')).toBeNull();
  });
});

describe('License server screens', () => {
  const inst: Installation = {
    id: '01J0000000000000000000000A',
    instance_id: 'aaaa-bbbb-cccc',
    company: 'Acme Ltd',
    size: '6-20',
    role: 'CTO',
    use_case: 'crm',
    email: 'it@acme.test',
    email_verified: true,
    marketing_opt_in: false,
    version: '1.0.0',
    registered_at: '2026-10-01T00:00:00Z',
    verified_at: '2026-10-01T00:00:00Z',
    last_seen_at: null,
    active_users: null,
    boards: null,
    license_id: null,
    secret_set: false,
  };
  const lic: IssuedLicense = {
    id: '01J0000000000000000000000B',
    ref: 'LIC-1',
    licensee: 'Big Co',
    plan: 'business',
    features: ['saml'],
    seats: 10,
    instance_id: null,
    expires: '2027-10-01T00:00:00Z',
    grace_days: 14,
    support: 'standard',
    email: null,
    state: 'valid',
    key: 'lic1.x.y',
    issued_at: '2026-10-01T00:00:00Z',
    revoked_at: null,
    reminders: [],
    payment_provider: null,
  };

  it('"not a license server" without the signing key', () => {
    render(createElement('div', null, createElement(InstallationsPanel), createElement(LicensesPanel)), (qc) =>
      qc.setQueryData(
        licensingKeys.server,
        server({ enabled: false, source: 'none', public_key: null, fingerprint: null }),
      ),
    );
    expect($('installations-off')).not.toBeNull();
    expect($('licenses-off')).not.toBeNull();
    expect($('licenses-issue')).toBeNull();
  });

  it('lists installations, with filters and CSV', () => {
    render(createElement(InstallationsPanel), (qc) => {
      qc.setQueryData(licensingKeys.server, server());
      qc.setQueryData(licensingKeys.installations(''), { data: [inst] });
    });
    expect(host.querySelectorAll('[data-testid="installation-row"]')).toHaveLength(1);
    expect($('installations-table')!.textContent).toContain('Acme Ltd');
    expect($('installations-csv')).not.toBeNull();
    expect($('installations-size-6-20')).not.toBeNull();
    expect($('installation-release')).toBeNull();
  });

  it('offers "release registration" only for an installation that holds a secret', () => {
    render(createElement(InstallationsPanel), (qc) => {
      qc.setQueryData(licensingKeys.server, server());
      qc.setQueryData(licensingKeys.installations(''), {
        data: [inst, { ...inst, id: '01J0000000000000000000000C', instance_id: 'dddd', secret_set: true }],
      });
    });
    const buttons = host.querySelectorAll('[data-testid="installation-release"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest('tr')!.getAttribute('data-instance')).toBe('dddd');
  });

  it('lists licenses with their actions; the issue form presets the plan’s features', () => {
    render(createElement(LicensesPanel), (qc) => {
      qc.setQueryData(licensingKeys.server, server());
      qc.setQueryData(licensingKeys.licenses, { data: [lic] });
    });
    const row = $('license-row')!;
    expect(row.dataset.state).toBe('valid');
    for (const a of ['license-copy', 'license-email', 'license-renew', 'license-plan', 'license-revoke'])
      expect(row.querySelector(`[data-testid="${a}"]`)).not.toBeNull();
    act(() => $('licenses-issue')!.click());
    const checked = (k: string) =>
      (document.querySelector(`[data-testid="issue-feature-${k}"]`) as HTMLInputElement).checked;
    expect(checked('saml')).toBe(true);
    expect(checked('log_streaming')).toBe(false);
    act(() => (document.querySelector('[data-testid="issue-plan-enterprise"]') as HTMLElement).click());
    expect(checked('log_streaming')).toBe(true);
    act(() => (document.querySelector('[data-testid="issue-plan-registered"]') as HTMLElement).click());
    expect(checked('saml')).toBe(false);
    expect(checked('template_library')).toBe(true);
    expect(document.querySelector('[data-testid="issue-expires"]')!.textContent).toContain(t('owner.license.never'));
  });

  it('has its texts in Hebrew and English', () => {
    for (const key of [
      'licensing.tab',
      'licensing.register.unavailable',
      'licensing.register.skip',
      'licensing.server.off',
      'licensing.server.create',
      'licensing.server.removeBody',
      'licensing.settings.providerKeyMissing',
      'owner.license.banner.grace',
      'licensing.telemetry.hint',
    ] as const) {
      expect(t(key, undefined, 'he')).not.toBe(key);
      expect(t(key, undefined, 'en')).not.toBe(t(key, undefined, 'he'));
    }
  });
});

describe('License server card (the signing key)', () => {
  const off = () => server({ enabled: false, source: 'none', public_key: null, fingerprint: null });

  it('off: "Become a license server" — creating a key makes this installation one', async () => {
    answers['POST /platform/license-server/key'] = server({ source: 'setting' });
    const qc = render(createElement('div', null, createElement(LicenseServerCard), createElement(LicensesPanel)), (q) =>
      q.setQueryData(licensingKeys.server, off()),
    );
    expect($('license-server')!.dataset.enabled).toBe('false');
    expect($('license-server')!.textContent).toContain(t('licensing.server.becomeHint'));
    expect($('license-server-fingerprint')).toBeNull();
    expect($('licenses-off')).not.toBeNull();
    act(() => $('license-server-create')!.click());
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/platform/license-server/key'))).toBe(true);
    expect(qc.getQueryData<LicenseServerStatus>(licensingKeys.server)?.enabled).toBe(true);
    expect($('license-server')!.dataset.enabled).toBe('true');
    expect($('license-server-fingerprint')!.textContent).toBe('SHA256:abcd1234');
    expect(($('license-server-public-key') as HTMLTextAreaElement).value).toBe(PEM);
    // A key made here can be removed; the lists are open now.
    expect($('license-server-remove')).not.toBeNull();
    expect($('licenses-off')).toBeNull();
  });

  it('on, from the environment: the fingerprint and the PEM, managed in LICENSE_SIGNING_KEY — no "remove"', () => {
    render(createElement(LicenseServerCard), (qc) => qc.setQueryData(licensingKeys.server, server()));
    expect($('license-server-source')!.dataset.source).toBe('env');
    expect($('license-server')!.textContent).toContain(t('licensing.server.envHint'));
    expect($('license-server-fingerprint')!.textContent).toBe('SHA256:abcd1234');
    expect($('license-server-copy')).not.toBeNull();
    expect($('license-server-remove')).toBeNull();
  });
});

describe('The provider key (licensing settings)', () => {
  const card = (s: LicensingSettings) =>
    render(createElement(LicensingSettingsCard), (qc) => qc.setQueryData(licensingKeys.settings, s));

  it('shows the fingerprint fetched from the license server', () => {
    card(settings());
    expect($('licensing-provider-key')!.dataset.fingerprint).toBe('SHA256:abcd1234');
    expect($('licensing-provider-key')!.textContent).toContain('SHA256:abcd1234');
    expect($('licensing-provider-key-missing')).toBeNull();
  });

  it('when it could not be fetched: a note and a field to paste the PEM, saved with PATCH', async () => {
    answers['PATCH /platform/licensing'] = settings();
    card(settings({ server_public_key: null, server_key_fingerprint: null }));
    expect($('licensing-provider-key')).toBeNull();
    expect($('licensing-provider-key-missing')!.textContent).toContain(t('licensing.settings.providerKeyMissing'));
    expect(($('licensing-provider-key-save') as HTMLButtonElement).disabled).toBe(true);
    const area = $('licensing-provider-key-input') as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, `${PEM}\n`);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => area.closest('form')!.requestSubmit());
    await flush();
    const sent = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/platform/licensing'));
    expect(sent?.body).toEqual({ server_public_key: PEM });
  });

  it('nothing about a key without a license server address', () => {
    card(
      settings({ server_url: '', server_url_source: 'none', server_url_setting: null, server_key_fingerprint: null }),
    );
    expect($('licensing-provider-key')).toBeNull();
    expect($('licensing-provider-key-missing')).toBeNull();
  });
});
