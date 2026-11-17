// SPDX-License-Identifier: MIT
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBinesSdk, PROTOCOL, type ExtContext } from '../src';
import { fireBinesTrigger, setAppPageBadge, signBinesBody, verifyBinesSignature } from '../src/server';

/** ext-sdk ת3–ת5: modal frames, notify, selection, storage, uploads — and the server helpers (signed calls). */
const HOST = 'https://app.bines.test';
const ctx: ExtContext = {
  account_id: 'acc',
  board_id: 'brd',
  installation_id: 'ins',
  extension_key: 'demo',
  feature: 'bulk',
  user: { id: 'u', name: 'U' },
  theme: 'light',
  locale: 'he',
  dir: 'rtl',
  surface: 'batch_action',
  selection: { item_ids: ['i1', 'i2'] },
  modal: true,
};

type Sent = { msg: Record<string, any>; target: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
const fakeFrame = (respond?: (url: string, init: RequestInit) => Response) => {
  const sent: Sent[] = [];
  const parent = { postMessage: (msg: Record<string, unknown>, target: string) => sent.push({ msg, target }) };
  const target = new EventTarget();
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    respond ? respond(String(url), init ?? {}) : new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const win = Object.assign(target, { parent, fetch, document: {} }) as unknown as Window;
  const deliver = (data: unknown, origin = HOST) => {
    const e = new Event('message');
    Object.assign(e, { data, origin, source: parent });
    target.dispatchEvent(e);
  };
  const init = (c: ExtContext = ctx) =>
    deliver({
      protocol: PROTOCOL,
      v: 1,
      type: 'init',
      context: c,
      token: {
        token: 'bos_ext_x.y',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        api_base: '/api/v1',
        scopes: [],
      },
    });
  const reply = (id: unknown, result?: unknown) =>
    deliver({ protocol: PROTOCOL, v: 1, type: 'reply', id, ok: true, result });
  const lastRequest = () => sent.filter((s) => s.msg.type === 'request').at(-1)!;
  return { win, sent, fetch, init, reply, lastRequest };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('@bines/ext-sdk — ת3 host actions', () => {
  it('selection: a batch has its items; an item tab its item; a board menu none', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.init();
    expect(await sdk.selection()).toEqual(['i1', 'i2']);
    const g = fakeFrame();
    const sdk2 = createBinesSdk({ window: g.win, fetch: g.fetch });
    g.init({ ...ctx, surface: 'item_view', selection: undefined, item_id: 'i9' });
    expect(await sdk2.selection()).toEqual(['i9']);
    const h = fakeFrame();
    const sdk3 = createBinesSdk({ window: h.win, fetch: h.fetch });
    h.init({ ...ctx, surface: 'board_menu_action', selection: { item_ids: [] } });
    expect(await sdk3.selection()).toEqual([]);
  });

  it('openModal waits until the modal closes (no timeout) and gives back its result', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch, timeoutMs: 20 });
    f.init();
    let result: unknown = 'pending';
    void sdk.openModal({ path: 'confirm.html', params: { n: 2 } }).then((r) => (result = r));
    await tick();
    const req = f.lastRequest();
    expect(req).toMatchObject({
      msg: { action: 'openModal', payload: { path: 'confirm.html', params: { n: 2 } } },
      target: HOST,
    });
    await new Promise((r) => setTimeout(r, 50)); // longer than timeoutMs: still waiting
    expect(result).toBe('pending');
    f.reply(req.msg.id, { done: true });
    await tick();
    expect(result).toEqual({ done: true });
  });

  it('openAutomationBuilder waits for the dialog (no timeout) and gives back what was saved', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch, timeoutMs: 20 });
    f.init();
    let result: unknown = 'pending';
    void sdk
      .openAutomationBuilder({ trigger: 'button_clicked', config: { with_item: true, inputs: { button: 'b-7' } } })
      .then((r) => (result = r));
    await tick();
    const req = f.lastRequest();
    expect(req.msg).toMatchObject({
      action: 'openAutomationBuilder',
      payload: { trigger: 'button_clicked', config: { with_item: true, inputs: { button: 'b-7' } } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBe('pending');
    f.reply(req.msg.id, { saved: true, automation_id: 'a1' });
    await tick();
    expect(result).toEqual({ saved: true, automation_id: 'a1' });
  });

  it('setAutomationActive asks the host (the member’s session) and gives back the state', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.init();
    const switching = sdk.setAutomationActive('01J0000000000000000000000A', false);
    await tick();
    expect(f.lastRequest().msg).toMatchObject({
      action: 'setAutomationActive',
      payload: { automation_id: '01J0000000000000000000000A', active: false },
    });
    f.reply(f.lastRequest().msg.id, { active: false });
    expect(await switching).toEqual({ active: false });
  });

  it('automations(trigger) reads GET /ext/automations with the page token', async () => {
    const f = fakeFrame(
      () => new Response(JSON.stringify({ data: [{ id: 'a1', name: 'x', active: true }] }), { status: 200 }),
    );
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.init();
    expect(await sdk.automations('button_clicked')).toEqual([{ id: 'a1', name: 'x', active: true }]);
    const [url, init] = f.fetch.mock.calls.at(-1)!;
    expect(String(url)).toContain('/api/v1/ext/automations?trigger=button_clicked');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('closeModal and notify are requests to the host (with their payloads)', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.init();
    const closing = sdk.closeModal({ ok: 1 });
    await tick();
    expect(f.lastRequest().msg).toMatchObject({ action: 'closeModal', payload: { result: { ok: 1 } } });
    f.reply(f.lastRequest().msg.id);
    await closing;
    const notifying = sdk.notify('נשמר', { tone: 'success' });
    await tick();
    expect(f.lastRequest().msg).toMatchObject({ action: 'notify', payload: { text: 'נשמר', tone: 'success' } });
    f.reply(f.lastRequest().msg.id);
    await notifying;
  });
});

describe('@bines/ext-sdk — ת5 storage and uploads', () => {
  it('storage: per-user by default, installation on request; a missing key is null', async () => {
    const f = fakeFrame((url, init) => {
      if (url.endsWith('/ext/storage/user/missing'))
        return new Response('{"error":{"code":"not_found"}}', { status: 404 });
      if (init.method === 'GET' && url.includes('/ext/storage/installation/cfg'))
        return new Response(JSON.stringify({ key: 'cfg', value: { a: 1 } }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ key: 'k', size: 3 }] }), { status: 200 });
    });
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.init();
    expect(await sdk.storage.get('missing')).toBeNull();
    expect(await sdk.storage.get('cfg', { scope: 'installation' })).toEqual({ a: 1 });
    await sdk.storage.set('a b', { x: 1 });
    const [url, req] = f.fetch.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(url).toBe(`${HOST}/api/v1/ext/storage/user/a%20b`);
    expect(req.method).toBe('PUT');
    expect(JSON.parse(String(req.body))).toEqual({ value: { x: 1 } });
    expect(await sdk.storage.list({ scope: 'installation', prefix: 'k' })).toEqual([{ key: 'k', size: 3 }]);
    expect(String(f.fetch.mock.calls.at(-1)![0])).toBe(`${HOST}/api/v1/ext/storage/installation?prefix=k`);
  });

  it('files.upload sends the raw bytes, then attaches to the cell when asked', async () => {
    const f = fakeFrame((url) =>
      url.includes('/ext/files')
        ? new Response(JSON.stringify({ id: 'f1', name: 'a.txt', size: 2, mime: 'text/plain' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.init();
    const file = new Blob(['hi'], { type: 'text/plain' });
    const up = await sdk.files.upload(file, { name: 'a.txt', item_id: 'i1', column_id: 'docs' });
    expect(up.id).toBe('f1');
    const [u1, r1] = f.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(u1).toBe(`${HOST}/api/v1/ext/files?name=a.txt&mime=text%2Fplain`);
    expect(r1.body).toBe(file);
    expect((r1.headers as Record<string, string>)['content-type']).toBe('text/plain');
    expect(r1.credentials).toBe('omit');
    const [u2, r2] = f.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(u2).toBe(`${HOST}/api/v1/items/i1/cells/docs/files`);
    expect(JSON.parse(String(r2.body))).toEqual({ file_ids: ['f1'] });
  });
});

describe('@bines/ext-sdk/server — signed calls', () => {
  const secret = 'bext_test_secret';
  const body = JSON.stringify({ type: 'automation_action', input: { message: 'שלום' } });

  it('signs exactly like the platform (HMAC-SHA256 of "<ts>.<body>", hex)', async () => {
    const ts = '1790000000000';
    const want = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
    expect(await signBinesBody(secret, ts, body)).toBe(want);
  });

  it('verifies: good once; a replay, a stale timestamp, a changed body or a missing header are refused', async () => {
    const now = Date.now();
    const ts = String(now);
    const signature = await signBinesBody(secret, ts, body);
    const seen = new Set<string>();
    expect(await verifyBinesSignature({ secret, timestamp: ts, signature, body, now, seen })).toBe('ok');
    expect(await verifyBinesSignature({ secret, timestamp: ts, signature, body, now, seen })).toBe('replay');
    expect(await verifyBinesSignature({ secret, timestamp: ts, signature, body, now: now + 301_000 })).toBe('stale');
    expect(await verifyBinesSignature({ secret, timestamp: ts, signature, body: `${body} `, now })).toBe(
      'bad_signature',
    );
    expect(await verifyBinesSignature({ secret: 'other', timestamp: ts, signature, body, now })).toBe('bad_signature');
    expect(await verifyBinesSignature({ secret, timestamp: null, signature, body, now })).toBe('missing');
    expect(await verifyBinesSignature({ secret, timestamp: 'abc', signature, body, now })).toBe('stale');
  });

  it('fires a trigger with the installation id and a signature over the exact body', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 202 }));
    await fireBinesTrigger({
      appOrigin: 'https://app.bines.test/',
      installationId: 'ins',
      secret,
      block: 'whatsapp.incoming',
      payload: { text: 'hi' },
      itemId: 'i1',
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: 1790000000000,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.bines.test/api/v1/automations/triggers/whatsapp.incoming/fire');
    const h = init.headers as Record<string, string>;
    expect(h['x-bines-installation']).toBe('ins');
    expect(h['x-bines-timestamp']).toBe('1790000000000');
    expect(h['x-bines-signature']).toBe(await signBinesBody(secret, '1790000000000', String(init.body)));
    expect(JSON.parse(String(init.body))).toEqual({ payload: { text: 'hi' }, item_id: 'i1' });
  });
});

/** the count beside a sidebar page — from its page (own count) and from its server. */
describe('@bines/ext-sdk — app page badge', () => {
  it('setBadge asks the host, with this page as the default key', async () => {
    const f = fakeFrame();
    const sdk = createBinesSdk({ window: f.win, fetch: f.fetch });
    f.init({ ...ctx, surface: 'app_page', feature: 'inbox', modal: false, selection: undefined });
    const setting = sdk.setBadge(3);
    await tick();
    expect(f.lastRequest().msg).toMatchObject({ action: 'setBadge', payload: { count: 3 } });
    f.reply(f.lastRequest().msg.id);
    await setting;
    const clearing = sdk.setBadge(null, { key: 'other' });
    await tick();
    expect(f.lastRequest().msg).toMatchObject({ action: 'setBadge', payload: { count: null, key: 'other' } });
    f.reply(f.lastRequest().msg.id);
    await clearing;
  });

  it('setAppPageBadge: PUT /ext/app-pages/<key>/badge with the count (and the member)', async () => {
    const api = vi.fn(async () => ({ key: 'inbox', count: 2, user_id: 'u1' }));
    expect(await setAppPageBadge({ api } as never, 'inbox', 2, { userId: 'u1' })).toMatchObject({ count: 2 });
    expect(api).toHaveBeenCalledWith('PUT', '/ext/app-pages/inbox/badge', { count: 2, user_id: 'u1' });
    await setAppPageBadge({ api } as never, 'inbox', null);
    expect(api).toHaveBeenLastCalledWith('PUT', '/ext/app-pages/inbox/badge', { count: null });
  });
});
