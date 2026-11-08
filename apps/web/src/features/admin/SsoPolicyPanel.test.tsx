// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSecuritySchema, type SecuritySettings, t } from '@bines/shared';
import { queryKeys } from '../../lib/api';
import { SsoPolicyPanel } from './SsoPolicyPanel';

/**
 * Prod / S-72: Administration → Security → sign in through Google / Microsoft — the optional organisation
 * lists (Google Workspace domains, Microsoft tenant ids), "recommended" while empty, saved as the admin adds / removes.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
let root: Root | null = null;
let host: HTMLDivElement;
const onSave = vi.fn();

const settingsWith = (sso: Partial<SecuritySettings['sso']> = {}): SecuritySettings => {
  const base = accountSecuritySchema.parse({});
  return { ...base, sso: { ...base.sso, required: true, ...sso }, domains: [] };
};
const render = (settings: SecuritySettings) => {
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.authConfig, { google: true, microsoft: true });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(SsoPolicyPanel, { settings, busy: false, onSave }),
      ),
    );
  });
};
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  onSave.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('SsoPolicyPanel: organisations (S-72)', () => {
  it('shows both optional lists, "recommended" while empty', () => {
    render(settingsWith());
    expect($('security-sso-google-row')).not.toBeNull();
    expect($('security-sso-microsoft-row')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="security-sso-recommended"]')).toHaveLength(2);
  });

  it('no "recommended" chip once a list has an entry; the entries are shown', () => {
    render(settingsWith({ google_domains: ['acme.com'], microsoft_tenants: [TENANT] }));
    expect(host.querySelectorAll('[data-testid="security-sso-recommended"]')).toHaveLength(0);
    expect($('security-sso-google-domain')!.textContent).toContain('@acme.com');
    expect($('security-sso-microsoft-tenant')!.textContent).toContain(TENANT);
    expect($('security-sso-microsoft-tenant')!.textContent).not.toContain(`@${TENANT}`);
  });

  it('adds a Google domain and a tenant id; a tenant must be a directory id', () => {
    render(settingsWith({ google_domains: ['acme.com'] }));
    type(host.querySelector<HTMLInputElement>('[data-testid="security-sso-google-domain-input"]')!, 'corp.acme.com');
    act(() => $('security-sso-google-domain-add')!.click());
    expect(onSave).toHaveBeenCalledWith({ sso: { google_domains: ['acme.com', 'corp.acme.com'] } });

    const tenant = host.querySelector<HTMLInputElement>('[data-testid="security-sso-microsoft-tenant-input"]')!;
    type(tenant, 'contoso');
    expect(($('security-sso-microsoft-tenant-add') as HTMLButtonElement).disabled).toBe(true);
    type(tenant, TENANT.toUpperCase());
    act(() => $('security-sso-microsoft-tenant-add')!.click());
    expect(onSave).toHaveBeenLastCalledWith({ sso: { microsoft_tenants: [TENANT] } });
  });

  it('removing the last entry saves an empty list (any organisation)', () => {
    render(settingsWith({ microsoft_tenants: [TENANT] }));
    act(() => host.querySelector<HTMLElement>('[data-testid="security-sso-microsoft-tenant-remove"]')!.click());
    expect(onSave).toHaveBeenCalledWith({ sso: { microsoft_tenants: [] } });
  });

  it('has its texts in Hebrew and English', () => {
    for (const key of [
      'sso.policy.recommended',
      'sso.policy.googleDomains',
      'sso.policy.googleDomainsHint',
      'sso.policy.microsoftTenants',
      'sso.policy.microsoftTenantsHint',
      'sso.gate.subtitleOrganization',
      'error.sso_org_excludes_you',
    ] as const) {
      expect(t(key, undefined, 'he')).not.toBe(key);
      expect(t(key, undefined, 'en')).not.toBe(t(key, undefined, 'he'));
    }
  });
});
