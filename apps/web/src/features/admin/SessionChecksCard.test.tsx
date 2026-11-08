// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyAccount } from '@bines/shared';

/** Administration → Connections → outside work sessions: off by default; on + interval are saved. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patches: unknown[] = [];
const settings = { session_checks: { enabled: false, interval_minutes: 15 } };

vi.mock('../../lib/api', () => ({
  api: () => ({
    patch: async (_path: string, body: { settings: { session_checks: object } }) => {
      patches.push(body);
      return {
        id: 'A1',
        settings: { session_checks: { ...settings.session_checks, ...body.settings.session_checks } },
      };
    },
  }),
  queryKeys: { myAccounts: ['my-accounts'] },
}));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: async () => undefined }) }));
vi.mock('../../lib/toast', () => ({ showToast: () => undefined }));
vi.mock('../account/CopyLink', () => ({ reasonMessage: String }));
vi.mock('../../lib/region', () => ({ applyAccountRegion: () => undefined }));
vi.mock('../../lib/upload', () => ({ uploadFile: async () => ({ id: 'F1' }) }));

const { SessionChecksCard } = await import('./SessionChecksCard');

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
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(SessionChecksCard, { account }))),
  );
  await flush();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('outside work sessions card', () => {
  it('starts off, with the interval field disabled and nothing to save', () => {
    expect(($('session-checks-enabled') as HTMLInputElement).checked).toBe(false);
    expect(($('session-checks-interval') as HTMLInputElement).disabled).toBe(true);
    expect(($('session-checks-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('switching on and setting the interval saves both; out of range cannot be saved', async () => {
    await act(async () => $('session-checks-enabled')!.click());
    await type('session-checks-interval', '3');
    expect(($('session-checks-save') as HTMLButtonElement).disabled).toBe(true);
    await type('session-checks-interval', '30');
    await act(async () => $('session-checks-save')!.click());
    await flush();
    expect(patches).toEqual([{ settings: { session_checks: { enabled: true, interval_minutes: 30 } } }]);
  });
});
