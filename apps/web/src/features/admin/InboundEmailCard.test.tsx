// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyAccount } from '@bines/shared';

/** Administration → Connections → incoming email: off by default; policy and domains are saved. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patches: { settings: { inbound_email: Record<string, unknown> } }[] = [];
const saved = {
  enabled: false,
  senders: 'anyone',
  domains: [] as string[],
  body_images: true,
  body_image_min_kb: 10,
  remote_images: true,
};
/** The image settings as saved. */
const images = { body_images: true, body_image_min_kb: 10, remote_images: true };

vi.mock('../../lib/api', () => ({
  api: () => ({
    patch: async (_path: string, body: { settings: { inbound_email: object } }) => {
      patches.push(body as (typeof patches)[number]);
      return { id: 'A1', settings: { inbound_email: { ...saved, ...body.settings.inbound_email } } };
    },
  }),
  queryKeys: { myAccounts: ['my-accounts'] },
}));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: async () => undefined }) }));
vi.mock('../../lib/toast', () => ({ showToast: () => undefined }));
vi.mock('../account/CopyLink', () => ({ reasonMessage: String }));
vi.mock('../../lib/region', () => ({ applyAccountRegion: () => undefined }));
vi.mock('../../lib/upload', () => ({ uploadFile: async () => ({ id: 'F1' }) }));

const { InboundEmailCard } = await import('./InboundEmailCard');

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
const mount = async (domain: string | null) => {
  patches.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['account', 'A1', 'detail'], {
    id: 'A1',
    settings: { inbound_email: saved },
    platform_defaults: { inbound_domain: domain },
  });
  await act(async () =>
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(InboundEmailCard, { account }))),
  );
  await flush();
};
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('incoming email card', () => {
  it('starts off; says so when the platform has no inbound domain', async () => {
    await mount(null);
    expect(($('inbound-email-enabled') as HTMLInputElement).checked).toBe(false);
    expect(($('inbound-email-save') as HTMLButtonElement).disabled).toBe(true);
    expect($('inbound-email-settings')!.textContent).toMatch(/דומיין|domain/);
  });

  it('turning on with "some domains" needs a valid list, then saves all three', async () => {
    await mount('in.platform.test');
    await act(async () => $('inbound-email-enabled')!.click());
    const domainsOption = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')][2]!;
    await act(async () => domainsOption.click());
    // No domain yet: nothing to save.
    expect(($('inbound-email-save') as HTMLButtonElement).disabled).toBe(true);
    await type('inbound-email-domains', 'client.co.il, not a domain');
    expect(($('inbound-email-save') as HTMLButtonElement).disabled).toBe(true);
    await type('inbound-email-domains', 'Client.co.il, @partner.com');
    await act(async () => $('inbound-email-save')!.click());
    await flush();
    expect(patches).toEqual([
      {
        settings: {
          inbound_email: { enabled: true, senders: 'domains', domains: ['client.co.il', 'partner.com'], ...images },
        },
      },
    ]);
  });

  it("the message's images: body images with a size threshold, images from the web", async () => {
    patches.length = 0;
    await mount('in.platform.test');
    expect(($('inbound-email-body-images') as HTMLInputElement).checked).toBe(true);
    expect(($('inbound-email-remote-images') as HTMLInputElement).checked).toBe(true);
    await type('inbound-email-min-image', '5000');
    expect(($('inbound-email-save') as HTMLButtonElement).disabled).toBe(true);
    await type('inbound-email-min-image', '4');
    await act(async () => $('inbound-email-remote-images')!.click());
    await act(async () => $('inbound-email-save')!.click());
    await flush();
    expect(patches.at(-1)!.settings.inbound_email).toMatchObject({
      body_images: true,
      body_image_min_kb: 4,
      remote_images: false,
    });
    // Body images off: the threshold goes away.
    await act(async () => $('inbound-email-body-images')!.click());
    expect($('inbound-email-min-image')).toBeNull();
  });
});
