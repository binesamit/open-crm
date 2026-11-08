// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { activityLog, automations, webhookDeliveries, webhooks } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M6 stage 7 — board webhooks (06 §2.17, §4.3), automation webhooks through the delivery queue, inbound hooks. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Hit = { path: string; headers: Record<string, string>; raw: string; body: Json };

/** A receiver like Make's: answers the challenge, records deliveries, fails on demand. */
let server: Server;
let base: string;
const hits: Hit[] = [];
let failNext = 0;
let echoChallenge = true;

let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let adminId: string;
let boardId: string;
let statusKey: string;
let textKey: string;
let labels: { id: number; label: string }[];
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** Dispatch every new activity row (and run what it causes); deliveries go out inline (no queue in tests). */
const seen = new Set<string>();
const drain = async () => {
  for (let round = 0; round < 10; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) return;
    for (const r of fresh) {
      seen.add(r.id);
      for (const run of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, run);
    }
  }
};
const hitsTo = (path: string) => hits.filter((h) => h.path === path && h.body.challenge === undefined);

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parsed = raw ? (JSON.parse(raw) as Json) : {};
      hits.push({ path: req.url ?? '', headers: req.headers as Record<string, string>, raw, body: parsed });
      if (parsed.challenge) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ challenge: echoChallenge ? parsed.challenge : 'nope' }));
        return;
      }
      if (failNext > 0) {
        failNext--;
        res.writeHead(500);
        res.end('down');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  statusKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'סטטוס', type: 'status' }))).id;
  textKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'אימייל', type: 'text' }))).id;
  const board = await body(await as(admin).get(`/boards/${boardId}`));
  labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels;
  await drain();
});
afterAll(async () => {
  await t.close();
  await new Promise((r) => server.close(r));
});

describe('board webhooks', () => {
  let statusHook: Json;

  it('registers only a URL that answers the challenge; only our event names are accepted', async () => {
    echoChallenge = false;
    const bad = await as(admin).post(`/boards/${boardId}/webhooks`, { url: `${base}/bad`, event: 'item_created' });
    expect(bad.status).toBe(422);
    expect((await body(bad)).error.message).toBe('webhook_challenge_failed');
    echoChallenge = true;
    const foreign = await as(admin).post(`/boards/${boardId}/webhooks`, {
      url: `${base}/status`,
      event: 'change_status_column_value',
    });
    expect(foreign.status).toBe(422);
    expect((await body(foreign)).error.message).toBe('unknown_webhook_event');
    const res = await as(admin).post(`/boards/${boardId}/webhooks`, {
      url: `${base}/status`,
      event: 'status_changed',
      config: { column_id: statusKey, label: labels[1]!.label },
    });
    expect(res.status).toBe(201);
    statusHook = await body(res);
    expect(statusHook).toMatchObject({ event: 'status_changed', verified: true, is_active: true });
    expect(statusHook.secret).toMatch(/^[0-9a-f]{48}$/);
  });

  it('delivers a signed payload for the events it wants only', async () => {
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'ליד א' }));
    await as(admin).put(`/items/${item.id}/cells/${statusKey}`, { value: { index: labels[0]!.id } }); // not the label
    await as(admin).put(`/items/${item.id}/cells/${statusKey}`, { value: { index: labels[1]!.id } });
    await drain();
    const got = hitsTo('/status');
    expect(got).toHaveLength(1);
    const h = got[0]!;
    expect(h.body.event).toMatchObject({
      type: 'status_changed',
      boardId,
      boardName: 'Leads',
      itemId: item.id,
      itemName: 'ליד א',
      columnId: statusKey,
      columnTitle: 'סטטוס',
      value: { index: labels[1]!.id, text: labels[1]!.label },
      previousValue: { index: labels[0]!.id, text: labels[0]!.label },
    });
    const expected = createHmac('sha256', statusHook.secret)
      .update(`${h.headers['x-bines-timestamp']}.${h.raw}`)
      .digest('hex');
    expect(h.headers['x-bines-signature']).toBe(`sha256=${expected}`);
    expect(h.headers['x-bines-event']).toBe('status_changed');
  });

  it('retries a failed delivery, logs every attempt, and can be sent again', async () => {
    failNext = 1;
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'ליד ב' }));
    await as(admin).put(`/items/${item.id}/cells/${statusKey}`, { value: { index: labels[1]!.id } });
    await drain();
    const log = await body(await as(admin).get(`/webhooks/${statusHook.id}/deliveries`));
    const failed = log.data.find((d: Json) => d.status === 'pending');
    expect(failed).toMatchObject({ attempt: 1, response_status: 500, error: 'http_500' });
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 50_000); // ~1 minute
    const again = await body(await as(admin).post(`/webhooks/deliveries/${failed.id}/redeliver`));
    expect(again).toMatchObject({ status: 'delivered', response_status: 200 });
  });

  it('dead after the last retry; 50 dead in a row switch the webhook off', async () => {
    const hook = await body(
      await as(admin).post(`/boards/${boardId}/webhooks`, { url: `${base}/flaky`, event: 'item_created' }),
    );
    await t.db.update(webhooks).set({ failureCount: 49 }).where(eq(webhooks.id, hook.id));
    failNext = 1;
    await as(admin).post(`/boards/${boardId}/items`, { name: 'ליד ג' });
    await drain();
    const [d] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.id));
    // Pretend the 6 retries already happened: the next failure is the last.
    await t.db.update(webhookDeliveries).set({ attempt: 6 }).where(eq(webhookDeliveries.id, d!.id));
    failNext = 1;
    const { deliver } = await import('../src/modules/webhooks/delivery');
    await t.db.update(webhookDeliveries).set({ status: 'pending' }).where(eq(webhookDeliveries.id, d!.id));
    await deliver(t.deps, d!.id);
    const after = (await t.db.select().from(webhooks).where(eq(webhooks.id, hook.id)))[0]!;
    expect((await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, d!.id)))[0]!.status).toBe(
      'dead',
    );
    expect(after).toMatchObject({ isActive: false, disabledReason: 'too_many_failures', failureCount: 50 });
    // Switching it back on clears the streak.
    const on = await body(await as(admin).call('PATCH', `/webhooks/${hook.id}`, { active: true }));
    expect(on).toMatchObject({ is_active: true, failure_count: 0, disabled_reason: null });
    await as(admin).call('DELETE', `/webhooks/${hook.id}`);
  });

  it('ping, rotate the secret; only board owners and admins manage webhooks', async () => {
    const ping = await body(await as(admin).post(`/webhooks/${statusHook.id}/test`));
    expect(ping).toMatchObject({ status: 'delivered', event_type: 'ping' });
    expect(hits.at(-1)!.body.event).toMatchObject({ type: 'ping', webhookId: statusHook.id });
    const rotated = await body(await as(admin).post(`/webhooks/${statusHook.id}/rotate-secret`));
    expect(rotated.secret).not.toBe(statusHook.secret);
    expect((await as(bob).get(`/boards/${boardId}/webhooks`)).status).toBe(403);
    expect(
      (await as(bob).post(`/boards/${boardId}/webhooks`, { url: `${base}/x`, event: 'item_created' })).status,
    ).toBe(403);
  });

  it('S-87: an admin not subscribed to a private board gets no webhook on it', async () => {
    const wsId = (await body(await as(bob).get('/workspaces'))).data[0].id;
    const priv = await body(await as(bob).post('/boards', { name: 'Bob only', workspace_id: wsId, kind: 'private' }));
    const res = await as(admin).post(`/boards/${priv.id}/webhooks`, {
      url: `${base}/priv`,
      event: 'item_created',
      config: { include_item: true },
    });
    expect([403, 404]).toContain(res.status);
    // The board's owner can.
    expect(
      (await as(bob).post(`/boards/${priv.id}/webhooks`, { url: `${base}/priv`, event: 'item_created' })).status,
    ).toBe(201);
  });

  it('S-100: a token needs boards:read for include_item, not only webhooks', async () => {
    const mint = async (scopes: string[]) =>
      (await body(await as(admin).post('/auth/tokens', { name: `wh ${scopes.join(' ')}`, scopes }))).token as string;
    const withToken = (token: string, payload: unknown) =>
      t.app.request(`/api/v1/boards/${boardId}/webhooks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const only = await mint(['webhooks']);
    const withItem = { url: `${base}/tok`, event: 'item_created', config: { include_item: true } };
    const refused = await withToken(only, withItem);
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.code).toBe('insufficient_scope');
    expect((await withToken(only, { url: `${base}/tok`, event: 'item_created' })).status).toBe(201);
    expect((await withToken(await mint(['webhooks', 'boards:read']), withItem)).status).toBe(201);
  });

  it('S-100: an existing include_item webhook keeps delivering the item; a webhooks-only token may still rename or pause it', async () => {
    // Made before the rule (deliveries never look at the token that set a webhook up).
    const hook = await body(
      await as(admin).post(`/boards/${boardId}/webhooks`, {
        url: `${base}/existing`,
        event: 'item_created',
        config: { include_item: true },
      }),
    );
    const only = (await body(await as(admin).post('/auth/tokens', { name: 'wh old', scopes: ['webhooks'] })))
      .token as string;
    const patch = (payload: unknown) =>
      t.app.request(`/api/v1/webhooks/${hook.id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${only}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    expect((await patch({ description: 'renamed' })).status).toBe(200);
    expect((await patch({ active: false })).status).toBe(200);
    // Re-enabling or changing what it sends is a new setup: boards:read needed.
    expect((await patch({ active: true })).status).toBe(403);
    expect((await patch({ config: { include_item: true } })).status).toBe(403);
    await as(admin).patch(`/webhooks/${hook.id}`, { active: true });

    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'still delivered' }));
    await drain();
    const got = hitsTo('/existing');
    expect(got).toHaveLength(1);
    expect(got[0]!.body.event.item.id).toBe(item.id);
  });
});

describe('automation webhooks and inbound hooks', () => {
  const addAutomation = async (recipe: Json) => {
    const id = newId();
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 't',
      recipe: recipe as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    return id;
  };

  it("an automation's webhook action goes through the delivery queue, signed with its secret", async () => {
    const id = await addAutomation({
      trigger: { type: 'item_created' },
      actions: [
        {
          type: 'webhook',
          url: `${base}/auto`,
          method: 'POST',
          payload: { name: '{item.name}' },
          secret: 's3cr3t-s3cr3t-s3',
        },
      ],
    });
    await as(admin).post(`/boards/${boardId}/items`, { name: 'ליד ד' });
    await drain();
    const h = hitsTo('/auto').at(-1)!;
    expect(h.body).toEqual({ name: 'ליד ד' });
    const expected = createHmac('sha256', 's3cr3t-s3cr3t-s3')
      .update(`${h.headers['x-bines-timestamp']}.${h.raw}`)
      .digest('hex');
    expect(h.headers['x-bines-signature']).toBe(`sha256=${expected}`);
    const [d] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.automationId, id));
    expect(d).toMatchObject({ status: 'delivered', actionIndex: 0, eventType: 'automation' });
    await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
  });

  it('an inbound hook finds the item by a column and runs the automation with {payload.*}', async () => {
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'ליד ה' }));
    await as(admin).put(`/items/${item.id}/cells/${textKey}`, { value: 'dana@x.test' });
    const id = await addAutomation({
      trigger: {
        type: 'webhook_in',
        secret: 'inbound-secret-123',
        item_lookup: { column: textKey, path: 'lead.email' },
      },
      actions: [{ type: 'set_item_name', name: '{item.name} ← {payload.lead.source}' }],
    });
    await drain();
    const post = (secret?: string, ip = '198.51.100.7') =>
      t.app.request(`/api/v1/hooks/in/${id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
          ...(secret ? { 'x-bines-secret': secret } : {}),
        },
        body: JSON.stringify({ lead: { email: 'dana@x.test', source: 'אתר' } }),
      });
    expect((await post()).status).toBe(401);
    expect((await post('wrong-secret-0000')).status).toBe(401);
    // S-11: the secret in the URL (logged by proxies) is refused even when it is right.
    const inQuery = await t.app.request(`/api/v1/hooks/in/${id}?secret=inbound-secret-123`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: '{}',
    });
    expect(inQuery.status).toBe(401);
    expect((await body(inQuery)).error.message).toBe('secret_must_be_in_header');
    const ok = await post('inbound-secret-123');
    expect(ok.status).toBe(202);
    expect(await body(ok)).toMatchObject({ item_id: item.id });
    await drain();
    expect((await body(await as(admin).get(`/items/${item.id}`))).name).toBe('ליד ה ← אתר');
    // Switched off → the address is gone.
    await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
    expect((await post('inbound-secret-123')).status).toBe(404);
    const runs = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'webhook_in.received')));
    expect(runs).toHaveLength(1);
  });
});

describe('inbound hooks: secret required, failures limited (S-11)', () => {
  const inbound = (id: string, secret: string | undefined, ip: string) =>
    t.app.request(`/api/v1/hooks/in/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        ...(secret ? { 'x-bines-secret': secret } : {}),
      },
      body: '{}',
    });

  it('an inbound automation saved without a secret gets one; editing keeps it', async () => {
    const created = await body(
      await as(admin).post(`/boards/${boardId}/automations`, {
        recipe: {
          trigger: { type: 'webhook_in', item_lookup: { column: 'id', path: 'item_id' } },
          actions: [{ type: 'set_item_name', name: 'x' }],
        },
        is_active: true,
      }),
    );
    const secret = created.recipe.trigger.secret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const edited = await body(
      await as(admin).patch(`/automations/${created.id}`, {
        recipe: {
          trigger: { type: 'webhook_in', item_lookup: { column: 'id', path: 'item_id' } },
          actions: [{ type: 'set_item_name', name: 'y' }],
        },
      }),
    );
    expect(edited.recipe.trigger.secret).toBe(secret);
    expect((await inbound(created.id, secret, '198.51.100.20')).status).toBe(202);
  });

  it('an automation stored without a secret (saved before S-11) is shut, not open', async () => {
    const id = newId();
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 'legacy',
      recipe: { trigger: { type: 'webhook_in' }, actions: [{ type: 'set_item_name', name: 'x' }] } as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    const res = await inbound(id, undefined, '198.51.100.21');
    expect(res.status).toBe(401);
    expect((await body(res)).error.message).toBe('secret_required');
  });

  it('guessing is cut off after 20 failures per address — another address is not affected', async () => {
    const id = newId();
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 'guarded',
      recipe: {
        trigger: { type: 'webhook_in', secret: 'the-right-secret-123' },
        actions: [{ type: 'set_item_name', name: 'x' }],
      } as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    for (let i = 0; i < 20; i++)
      expect((await inbound(newId(), 'guess-guess-guess-1', '203.0.113.9')).status).toBe(404);
    // the attacker's address is now blocked — even with the right secret
    const blocked = await inbound(id, 'the-right-secret-123', '203.0.113.9');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await inbound(id, 'the-right-secret-123', '203.0.113.10')).status).toBe(202);
  });
});
