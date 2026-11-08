// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundAddressDto } from '@bines/shared';

/** An item's email address, from the card's ⋯ menu: a notice while off; made on demand; replaced. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: InboundAddressDto;
const calls: string[] = [];
const copied: string[] = [];
vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async () => current,
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      current = {
        ...current,
        address: path.endsWith('/rotate')
          ? 'item-bbbbbbbbbbbbbbbbbbbbbbbb@in.test'
          : 'item-aaaaaaaaaaaaaaaaaaaaaaaa@in.test',
        created_at: '2026-10-14T00:00:00Z',
      };
      return current;
    },
    delete: async (path: string) => {
      calls.push(`DELETE ${path}`);
      current = { ...current, address: null, created_at: null };
      return current;
    },
  }),
  errorMessage: String,
}));
vi.mock('../../lib/dialogs', () => ({ confirmDialog: async () => true }));
vi.mock('../../lib/entity-menu', () => ({ copyText: (s: string) => copied.push(s) }));

const { InboundAddressDialog } = await import('./InboundAddress');

let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const mount = async (dto: InboundAddressDto) => {
  current = dto;
  calls.length = 0;
  copied.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(InboundAddressDialog, { accountId: 'A1', kind: 'item', id: 'I1', onClose: () => {} }),
      ),
    ),
  );
  await flush();
};
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('item email address', () => {
  it('says so while incoming email is off, with no address to make', async () => {
    await mount({ kind: 'item', address: null, off: 'account', created_at: null });
    expect($('inbound-address-make')).toBeNull();
    expect($('inbound-address-value')).toBeNull();
  });

  it('opens, makes the address, copies it, replaces it and removes it', async () => {
    await mount({ kind: 'item', address: null, off: null, created_at: null });
    await act(async () => $('inbound-address-make')!.click());
    await flush();
    expect(calls).toEqual(['POST /items/I1/email-address']);
    expect($('inbound-address-value')!.textContent).toBe('item-aaaaaaaaaaaaaaaaaaaaaaaa@in.test');
    await act(async () => $('inbound-address-copy')!.click());
    expect(copied).toEqual(['item-aaaaaaaaaaaaaaaaaaaaaaaa@in.test']);
    await act(async () => $('inbound-address-rotate')!.click());
    await flush();
    expect(calls.at(-1)).toBe('POST /items/I1/email-address/rotate');
    expect($('inbound-address-value')!.textContent).toBe('item-bbbbbbbbbbbbbbbbbbbbbbbb@in.test');
    await act(async () => $('inbound-address-remove')!.click());
    await flush();
    expect(calls.at(-1)).toBe('DELETE /items/I1/email-address');
    expect($('inbound-address-make')).not.toBeNull();
  });
});
