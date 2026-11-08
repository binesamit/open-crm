// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyAccount } from '@bines/shared';

/** Administration → General → downloading several files: on by default; the limits are saved. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patches: unknown[] = [];
const settings = { downloads: { zip_enabled: true, zip_max_files: 200, zip_max_mb: 1024 } };

vi.mock('../../lib/api', () => ({
  api: () => ({
    patch: async (_path: string, body: { settings: { downloads: object } }) => {
      patches.push(body);
      return { id: 'A1', settings: { downloads: { ...settings.downloads, ...body.settings.downloads } } };
    },
  }),
  queryKeys: { myAccounts: ['my-accounts'] },
}));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: async () => undefined }) }));
vi.mock('../../lib/toast', () => ({ showToast: () => undefined }));
vi.mock('../account/CopyLink', () => ({ reasonMessage: String }));
vi.mock('../../lib/region', () => ({ applyAccountRegion: () => undefined }));
vi.mock('../../lib/upload', () => ({ uploadFile: async () => ({ id: 'F1' }) }));

const { DownloadsCard } = await import('./DownloadsCard');

const account = { id: 'A1', slug: 'studio', name: 'Studio', role: 'admin', status: 'active' } as MyAccount;

let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const type = async (id: string, value: string) => {
  const input = $(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(async () => {
  patches.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['account', 'A1', 'detail'], { id: 'A1', settings });
  await act(async () =>
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(DownloadsCard, { account }))),
  );
  await flush();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('downloads card', () => {
  it('starts on with the built-in limits and nothing to save', () => {
    expect(($('admin-downloads-enabled') as HTMLInputElement).checked).toBe(true);
    expect(($('admin-downloads-max-files') as HTMLInputElement).value).toBe('200');
    expect(($('admin-downloads-max-mb') as HTMLInputElement).value).toBe('1024');
    expect(($('admin-downloads-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('new limits are saved; out of range cannot be saved; off disables the limits', async () => {
    await type('admin-downloads-max-files', '1');
    expect(($('admin-downloads-save') as HTMLButtonElement).disabled).toBe(true);
    await type('admin-downloads-max-files', '50');
    await type('admin-downloads-max-mb', '300');
    await act(async () => $('admin-downloads-save')!.click());
    await flush();
    expect(patches).toEqual([{ settings: { downloads: { zip_enabled: true, zip_max_files: 50, zip_max_mb: 300 } } }]);
    await act(async () => $('admin-downloads-enabled')!.click());
    expect(($('admin-downloads-max-files') as HTMLInputElement).disabled).toBe(true);
  });
});
