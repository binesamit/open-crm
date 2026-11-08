// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationsGuide as Guide, MyAccount } from '@bines/shared';
import type * as ApiModule from '../../lib/api';

/**
 * "n8n and Make" next to the API tokens — the n8n steps with the package, the Make steps with the
 * owner's invitation link (or "ask your administrator" without one), and the instance URL with a copy button.
 */
const get = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}));
const copyText = vi.fn();
vi.mock('../../lib/entity-menu', () => ({ copyText: (s: string) => copyText(s) }));

const { IntegrationsGuide } = await import('./IntegrationsGuide');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account = { id: 'a1', slug: 'acme', name: 'Acme', role: 'admin' } as unknown as MyAccount;
const LINK = 'https://www.make.com/en/hq/app-invitation/0123456789abcdef';
const guide = (over: Partial<Guide> = {}): Guide => ({
  product_name: 'Acme Work',
  base_url: 'https://work.acme.example',
  api_base: 'https://work.acme.example/api/v1',
  n8n_package: 'n8n-nodes-acme',
  make_invitation_url: LINK,
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  get.mockReset();
  copyText.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const render = async (onCreateToken?: () => void) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(IntegrationsGuide, { account, onCreateToken })),
    );
  });
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('n8n and Make guide', () => {
  it('shows both sections with the package, the invitation link and the instance URL', async () => {
    get.mockResolvedValue(guide());
    await render();
    expect(get).toHaveBeenCalledWith('/auth/integrations');
    expect($('integrations-n8n')?.textContent).toContain('Community nodes');
    expect($('integrations-n8n-package')?.textContent).toBe('n8n-nodes-acme');
    expect($('integrations-make')).not.toBeNull();
    expect($('integrations-make-link')?.getAttribute('href')).toBe(LINK);
    expect($('integrations-make-no-link')).toBeNull();
    expect($('integrations-base-url')?.textContent).toBe('https://work.acme.example');
    expect($('integrations-guide')?.textContent).toContain('Acme Work');
  });

  it('without an invitation link tells people to ask their administrator', async () => {
    get.mockResolvedValue(guide({ make_invitation_url: null }));
    await render();
    expect($('integrations-make-link')).toBeNull();
    expect($('integrations-make-no-link')).not.toBeNull();
    expect($('integrations-n8n')).not.toBeNull();
  });

  it('copies the instance URL and the package name; "create a token" calls back', async () => {
    get.mockResolvedValue(guide());
    const onCreateToken = vi.fn();
    await render(onCreateToken);
    await act(async () => $('integrations-base-url-copy')!.click());
    expect(copyText).toHaveBeenLastCalledWith('https://work.acme.example');
    await act(async () => $('integrations-n8n-package-copy')!.click());
    expect(copyText).toHaveBeenLastCalledWith('n8n-nodes-acme');
    await act(async () => $('integrations-create-token')!.click());
    expect(onCreateToken).toHaveBeenCalledOnce();
  });
});
