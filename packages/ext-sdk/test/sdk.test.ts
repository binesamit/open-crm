// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';
import { createBinesSdk, PROTOCOL, type ExtContext } from '../src';

const HOST = 'https://app.bines.test';
const ctx: ExtContext = {
  account_id: 'acc',
  board_id: 'brd',
  installation_id: 'ins',
  extension_key: 'demo',
  feature: 'v',
  user: { id: 'u', name: 'U' },
  theme: 'light',
  locale: 'he',
  dir: 'rtl',
};

/** A frame window whose parent records what the page posts. */
const fakeFrame = () => {
  const sent: { msg: Record<string, unknown>; target: string }[] = [];
  const parent = { postMessage: (msg: Record<string, unknown>, target: string) => sent.push({ msg, target }) };
  const target = new EventTarget();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'i1' }] }), { status: 200 }));
  const win = Object.assign(target, { parent, fetch, document: {} }) as unknown as Window;
  const deliver = (data: unknown, origin = HOST, source: unknown = parent) => {
    const e = new Event('message');
    Object.assign(e, { data, origin, source });
    target.dispatchEvent(e);
  };
  return { win, sent, deliver, fetch };
};

const init = (expiresInMs = 10 * 60_000) => ({
  protocol: PROTOCOL,
  v: 1,
  type: 'init',
  context: ctx,
  token: {
    token: 'bos_ext_x.y',
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    api_base: '/api/v1',
    scopes: ['boards:read'],
  },
});

describe('@bines/ext-sdk', () => {
  it('says ready (no secret) and learns the host from its init; ignores other senders', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    expect(f.sent[0]).toEqual({ msg: { protocol: PROTOCOL, v: 1, type: 'ready' }, target: '*' });
    f.deliver(init(), HOST, {}); // not the parent window
    let ready = false;
    void sdk.ready().then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);
    f.deliver(init());
    expect(await sdk.get('context')).toEqual(ctx);
  });

  it('calls the API with the token, without cookies, on the host origin', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.deliver(init());
    await sdk.items();
    const [url, req] = f.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HOST}/api/v1/boards/brd/items`);
    expect(req.credentials).toBe('omit');
    expect((req.headers as Record<string, string>).authorization).toBe('Bearer bos_ext_x.y');
    expect((req.headers as Record<string, string>)['x-account-id']).toBe('acc');
  });

  it('asks the host for a fresh token before it runs out — and only from the known host origin', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch, timeoutMs: 1000 });
    f.deliver(init(30_000)); // half a minute left
    const call = sdk.api('GET', '/auth/me');
    await new Promise((r) => setTimeout(r, 0));
    const req = f.sent.find((s) => s.msg.type === 'request')!;
    expect(req).toMatchObject({ msg: { action: 'token' }, target: HOST });
    // A reply from another origin is ignored; the host's is taken.
    const fresh = { ...init().token, token: 'bos_ext_new.sig' };
    f.deliver(
      { protocol: PROTOCOL, v: 1, type: 'reply', id: req.msg.id, ok: true, result: fresh },
      'https://evil.test',
    );
    f.deliver({ protocol: PROTOCOL, v: 1, type: 'reply', id: req.msg.id, ok: true, result: fresh });
    await call;
    const [, opts] = f.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((opts.headers as Record<string, string>).authorization).toBe('Bearer bos_ext_new.sig');
  });

  it('token() hands the current token to the page (for its own server), fresh when it runs out', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch, timeoutMs: 1000 });
    f.deliver(init());
    expect((await sdk.token()).token).toBe('bos_ext_x.y');
    expect(f.fetch).not.toHaveBeenCalled();
    const f2 = fakeFrame();
    const sdk2 = createBinesSdk({ window: f2.win, fetch: f2.fetch, timeoutMs: 1000 });
    f2.deliver(init(30_000));
    const t = sdk2.token();
    await new Promise((r) => setTimeout(r, 0));
    const req = f2.sent.find((s) => s.msg.type === 'request')!;
    expect(req.msg.action).toBe('token');
    const fresh = { ...init().token, token: 'bos_ext_new.sig' };
    f2.deliver({ protocol: PROTOCOL, v: 1, type: 'reply', id: req.msg.id, ok: true, result: fresh });
    expect((await t).token).toBe('bos_ext_new.sig');
  });

  it('a pinned host origin ignores an init from anywhere else', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch, hostOrigin: HOST });
    let ready = false;
    void sdk.ready().then(() => (ready = true));
    f.deliver(init(), 'https://evil.test');
    await Promise.resolve();
    expect(ready).toBe(false);
    f.deliver(init(), HOST);
    await sdk.ready();
  });
});

describe('audit 2026-10-10 web #1 — an unpinned SDK learns its host only from an https (or localhost) parent', () => {
  it('ignores an init from a plain-http origin, takes one from https or localhost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = fakeFrame();
      const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
      expect(warn).toHaveBeenCalledTimes(1);
      let ready = false;
      void sdk.ready().then(() => (ready = true));
      f.deliver(init(), 'http://evil.example');
      await Promise.resolve();
      expect(ready).toBe(false);
      f.deliver(init(), 'https://bines.example');
      expect(await sdk.get('context')).toEqual(ctx);
      const dev = fakeFrame();
      const devSdk = createBinesSdk({ window: dev.win, fetch: dev.fetch });
      dev.deliver(init(), 'http://localhost:5173');
      expect(await devSdk.get('context')).toEqual(ctx);
    } finally {
      warn.mockRestore();
    }
  });
});
