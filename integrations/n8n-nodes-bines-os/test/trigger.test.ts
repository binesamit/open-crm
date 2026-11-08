// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { IDataObject, IHookFunctions, IWebhookFunctions } from 'n8n-workflow';
import { BinesOsTrigger } from '../nodes/BinesOsTrigger/BinesOsTrigger.node';
import { handleDelivery } from '../nodes/BinesOsTrigger/delivery';
import { checkExists, configOf, create, remove, type HookState } from '../nodes/BinesOsTrigger/hooks';
import { signature, verifySignature } from '../nodes/shared/signature';
import { BASE, makeCtx } from './mock';

const asHook = (ctx: ReturnType<typeof makeCtx>) => ctx as unknown as IHookFunctions;
const URL_ = 'https://n8n.example.com/webhook/abc/webhook';

describe('subscription config', () => {
  it('narrows each event the way the platform reads it', () => {
    const base = { boardId: 'b1', includeItem: true };
    expect(configOf({ ...base, event: 'item_created' })).toEqual({ include_item: true });
    expect(configOf({ ...base, event: 'specific_column_changed', columnId: 'phone' })).toEqual({
      include_item: true,
      column_id: 'phone',
    });
    expect(configOf({ ...base, event: 'status_changed', statusColumnId: 'status', label: 'Done' })).toEqual({
      include_item: true,
      column_id: 'status',
      label: 'Done',
    });
    expect(configOf({ ...base, event: 'item_moved_to_specific_group', groupId: 'g2' })).toMatchObject({
      group_id: 'g2',
    });
    expect(configOf({ ...base, event: 'automation_sent', channel: ' leads ', includeItem: false })).toEqual({
      include_item: false,
      channel: 'leads',
    });
  });
});

describe('REST-hook lifecycle', () => {
  it('create: subscribes the webhook URL with a fresh secret and remembers it', async () => {
    const ctx = makeCtx({
      params: { boardId: 'b1', event: 'status_changed', statusColumnId: 'status', label: 'Done', options: {} },
      route: () => ({ id: 'w1' }),
    });
    expect(await create.call(asHook(ctx))).toBe(true);
    const call = ctx.calls[0]!;
    expect(call).toMatchObject({ method: 'POST', url: `${BASE}/api/v1/boards/b1/webhooks`, auth: true });
    const body = call.body as IDataObject;
    expect(body).toMatchObject({
      url: URL_,
      event: 'status_changed',
      config: { include_item: true, column_id: 'status', label: 'Done' },
      description: 'n8n: Leads',
    });
    expect(String(body.secret)).toMatch(/^[0-9a-f]{48}$/);
    expect(ctx.staticData).toMatchObject({ webhookId: 'w1', secret: body.secret });
  });

  it('create: when the challenge cannot be answered yet, retries without the handshake', async () => {
    let n = 0;
    const ctx = makeCtx({
      params: { boardId: 'b1', event: 'item_created', options: {} },
      route: () =>
        n++ === 0
          ? Object.assign(new Error('Request failed with status code 422'), {
              response: {
                status: 422,
                data: { error: { code: 'invalid_value', message: 'webhook_challenge_failed' } },
              },
            })
          : { id: 'w2' },
    });
    expect(await create.call(asHook(ctx))).toBe(true);
    expect((ctx.calls[1]!.body as IDataObject).skip_handshake).toBe(true);
    expect(ctx.staticData.webhookId).toBe('w2');
  });

  it('checkExists: true for its own live subscription; a gone one (404) is forgotten', async () => {
    const live = makeCtx({
      params: { boardId: 'b1', event: 'item_created', options: {} },
      staticData: { webhookId: 'w1', secret: 's' },
      route: () => ({ id: 'w1', url: URL_, event: 'item_created', is_active: true }),
    });
    expect(await checkExists.call(asHook(live))).toBe(true);
    expect(live.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/api/v1/webhooks/w1` });

    const gone = makeCtx({
      params: { boardId: 'b1', event: 'item_created', options: {} },
      staticData: { webhookId: 'w1', secret: 's' },
      route: () =>
        Object.assign(new Error('Request failed with status code 404'), {
          response: { status: 404, data: { error: { code: 'not_found', message: 'Webhook not found' } } },
        }),
    });
    expect(await checkExists.call(asHook(gone))).toBe(false);
    expect((gone.staticData as HookState).webhookId).toBeUndefined();
  });

  it('checkExists: a subscription for another event is replaced', async () => {
    const ctx = makeCtx({
      params: { boardId: 'b1', event: 'item_created', options: {} },
      staticData: { webhookId: 'w1' },
      route: (c) =>
        c.method === 'GET' ? { id: 'w1', url: URL_, event: 'update_created', is_active: true } : { ok: true },
    });
    expect(await checkExists.call(asHook(ctx))).toBe(false);
    expect(ctx.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });

  it('delete: unsubscribes and clears the state (an already-gone subscription is fine)', async () => {
    const ctx = makeCtx({
      params: {},
      staticData: { webhookId: 'w1', secret: 's' },
      route: () => Object.assign(new Error('404'), { httpCode: '404' }),
    });
    expect(await remove.call(asHook(ctx))).toBe(true);
    expect(ctx.calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/api/v1/webhooks/w1` });
    expect(ctx.staticData).toEqual({});
  });
});

describe('deliveries', () => {
  const signingKey = ['test', 'signing', 'key'].join('-'); // a fixture, not a secret
  const body = {
    event: {
      type: 'item_created',
      itemId: 'i1',
      item: { id: 'i1', name: 'Dana', cells: { status: { value: { index: 1 }, text: 'Done' } } },
    },
  };
  const raw = JSON.stringify(body);
  const now = 1_790_000_000_000;
  const ts = String(now);

  it('answers the challenge', () => {
    expect(handleDelivery({ body: { challenge: 'abc' }, headers: {}, verify: true, secret: signingKey })).toEqual({
      kind: 'challenge',
      response: { challenge: 'abc' },
    });
  });

  it('accepts a correctly signed delivery and flattens the item', () => {
    const out = handleDelivery({
      body,
      rawBody: raw,
      headers: {
        'x-bines-timestamp': ts,
        'x-bines-signature': signature(signingKey, ts, raw),
        'x-bines-delivery': 'd1',
      },
      secret: signingKey,
      verify: true,
      now,
    });
    expect(out.kind).toBe('event');
    if (out.kind !== 'event') return;
    expect(out.json).toMatchObject({ type: 'item_created', itemId: 'i1', deliveryId: 'd1' });
    expect((out.json.item as IDataObject).column_values).toEqual({ status: 'Done' });
  });

  it('refuses a forged, an unsigned and an old delivery', () => {
    const forged = handleDelivery({
      body,
      rawBody: raw,
      headers: { 'x-bines-timestamp': ts, 'x-bines-signature': signature('other-secret-000000', ts, raw) },
      secret: signingKey,
      verify: true,
      now,
    });
    expect(forged).toMatchObject({ kind: 'reject', status: 401 });
    expect(handleDelivery({ body, rawBody: raw, headers: {}, secret: signingKey, verify: true, now })).toMatchObject({
      kind: 'reject',
    });
    expect(verifySignature(signingKey, ts, raw, signature(signingKey, ts, raw), now + 60 * 60 * 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    // Verification switched off: taken as is.
    expect(handleDelivery({ body, headers: {}, secret: signingKey, verify: false }).kind).toBe('event');
  });

  it('falls back to the re-serialised body when n8n kept no raw body', () => {
    const out = handleDelivery({
      body,
      headers: { 'x-bines-timestamp': ts, 'x-bines-signature': signature(signingKey, ts, raw) },
      secret: signingKey,
      verify: true,
      now,
    });
    expect(out.kind).toBe('event');
  });

  it('the node: challenge → response; event → workflow data; bad signature → 401', async () => {
    const node = new BinesOsTrigger();
    let status = 0;
    const make = (b: IDataObject, headers: IDataObject) =>
      ({
        getRequestObject: () => ({ rawBody: Buffer.from(JSON.stringify(b)) }),
        getBodyData: () => b,
        getHeaderData: () => headers,
        getWorkflowStaticData: () => ({ secret: signingKey }),
        getNodeParameter: () => ({}),
        getResponseObject: () => ({
          status: (s: number) => {
            status = s;
            return { json: () => undefined };
          },
        }),
        helpers: { returnJsonArray: (rows: IDataObject[]) => rows.map((json) => ({ json })) },
      }) as unknown as IWebhookFunctions;
    expect(await node.webhook.call(make({ challenge: 'c1' }, {}))).toEqual({ webhookResponse: { challenge: 'c1' } });
    const fresh = String(Date.now());
    const ok = await node.webhook.call(
      make(body, { 'x-bines-timestamp': fresh, 'x-bines-signature': signature(signingKey, fresh, raw) }),
    );
    expect(ok.workflowData?.[0]?.[0]?.json).toMatchObject({ type: 'item_created' });
    expect(
      await node.webhook.call(make(body, { 'x-bines-timestamp': fresh, 'x-bines-signature': 'sha256=00' })),
    ).toEqual({ noWebhookResponse: true });
    expect(status).toBe(401);
  });
});
