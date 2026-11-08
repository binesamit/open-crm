// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, automationRuns, webhookDeliveries } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { completeWith } from '../src/modules/ai/ai.service';
import { guardToolCall } from '../src/modules/ai/tools/guard';
import { closedAllows } from '../src/modules/billing/entitlements';
import { deliver } from '../src/modules/webhooks/delivery';
import type { Actor } from '../src/modules/items/items.service';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * plan-lock: the owner can close an account (subscription status `closed`). While closed every
 * account-scoped answer is 403 `account_closed` — REST, API tokens, MCP, live streams, public forms, inbound
 * webhooks — except the current user, the account's plan, the offered plans and support tickets; background work
 * does not run; nothing is deleted, and reopening brings everything back. In a read-only (or suspended) account the
 * AI does not work at all — the assistant does not even open.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let otherId: string;
let otherAdmin: string;
let wsId: string;
let boardId: string;
let itemId: string;
let v1: string;
let apiToken: string;
let formToken: string;
let hookId: string;
let hookSecret: string;
let automationId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const mk = async (name: string, slug: string, email: string) =>
  (
    await body(
      await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
    )
  ).account.id as string;
const as = (cookie = admin, account = acmeId) => t.api(cookie, account);
const set = async (accountId: string, patch: Json) => {
  const res = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, { plan_version_id: v1, ...patch });
  expect(res.status).toBe(200);
  return body(res);
};
const expectClosed = async (res: Response) => {
  expect(res.status).toBe(403);
  expect((await body(res)).error.code).toBe('account_closed');
};
const mine = async (cookie: string, accountId: string) =>
  ((await body(await t.api(cookie).get('/me/accounts'))).data as Json[]).find((a) => a.id === accountId)!;
const bearer = (path: string, init: RequestInit = {}) =>
  t.app.request(`/api/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiToken}`, ...(init.headers as Record<string, string>) },
  });
const mcp = () =>
  t.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
const inbound = () =>
  t.app.request(`/api/v1/hooks/in/${hookId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bines-secret': hookSecret },
    body: JSON.stringify({ item_id: itemId }),
  });
const events = async (accountId: string) =>
  (
    await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, accountId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
  ).map((r) => r.id);

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await as().post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Dana' }))).id;
  const plan = await body(
    await t.api(owner).post('/platform/plans', {
      name: 'Team',
      description: 'For small teams',
      version: { price_monthly: 49, price_yearly: 490, currency: 'ILS', features: [] },
    }),
  );
  v1 = plan.current_version_id;
  await t.api(owner).post('/platform/plans', { name: 'Secret deal', visibility: 'hidden', version: {} });
  await set(acmeId, { status: 'active' });
  apiToken = (await body(await as().post('/auth/tokens', { name: 'Make', scopes: ['boards:read'] }))).token;
  const formViewId = (await body(await as().post(`/boards/${boardId}/views`, { type: 'form', name: 'Contact' }))).id;
  formToken = (await body(await as().get(`/views/${formViewId}/form`))).token;
  const hook = await as().post(`/boards/${boardId}/automations`, {
    recipe: {
      trigger: { type: 'webhook_in', item_lookup: { column: 'id', path: 'item_id' } },
      actions: [{ type: 'set_item_name', name: 'From outside' }],
    },
    is_active: true,
  });
  const created = await body(hook);
  expect(hook.status, JSON.stringify(created)).toBe(201);
  hookId = created.id;
  hookSecret = created.recipe.trigger.secret;
  automationId = (
    await body(
      await as().post(`/boards/${boardId}/automations`, {
        recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'set_item_name', name: 'Auto: {item.name}' }] },
      }),
    )
  ).id;
  for (const id of [apiToken, formToken, hookId, hookSecret, automationId]) expect(id).toBeTruthy();
  // Everything so far ran (the automations' own creation events included).
  for (const e of await events(acmeId))
    for (const runId of await dispatchEvent(t.deps, e)) await executeRun(t.deps, runId);
});
afterAll(() => t.close());

describe('the allowlist rule', () => {
  it('opens only the plan (read) and the support tickets', () => {
    expect(closedAllows('GET', '/plan')).toBe(true);
    expect(closedAllows('GET', '/support/tickets/options')).toBe(true);
    expect(closedAllows('POST', '/support/tickets')).toBe(true);
    expect(closedAllows('GET', '/support/tickets/01ABC')).toBe(true);
    expect(closedAllows('POST', '/support/tickets/01ABC/messages')).toBe(true);
    for (const [m, p] of [
      ['PUT', '/plan'],
      ['GET', '/boards'],
      ['GET', '/workspaces'],
      ['GET', '/files/x'],
      ['GET', '/me/events'],
      ['GET', '/users/me'],
      ['POST', '/ai/assistant/conversations'],
      ['GET', '/support-access'],
      ['PUT', '/support/tickets/settings'],
      ['GET', '/support/tickets/1/attachments/2'],
    ] as const)
      expect(closedAllows(m, p), `${m} ${p}`).toBe(false);
  });
});

describe('closing an account', () => {
  let pendingEvent: string;
  let queuedRun: string;
  let deliveryId: string;

  it('the owner sets `closed` with a message; members see it on /me/accounts and /auth/me', async () => {
    // Work that was queued before the account closed: an event not dispatched yet, a run not executed yet.
    await as().post(`/boards/${boardId}/items`, { name: 'Before close' });
    const before = await events(acmeId);
    pendingEvent = before.at(-1)!;
    await as().post(`/boards/${boardId}/items`, { name: 'Queued run' });
    const runs = await dispatchEvent(t.deps, (await events(acmeId)).at(-1)!);
    expect(runs.length).toBe(1);
    queuedRun = runs[0]!;
    // An outgoing webhook delivery waiting for its job (an automation's `webhook` action).
    deliveryId = '01J0000000000000000000000D';
    await t.db.insert(webhookDeliveries).values({
      id: deliveryId,
      accountId: acmeId,
      automationId,
      actionIndex: 0,
      url: 'https://example.com/hook',
      eventId: pendingEvent,
      eventType: 'item.created',
      requestBody: { x: 1 },
      status: 'pending',
    });

    const view = await set(acmeId, { status: 'closed', status_message: 'Unpaid since June' });
    expect(view.subscription).toMatchObject({ status: 'closed', effective_status: 'closed' });
    expect(view.subscription.status_message).toBe('Unpaid since June');
    expect(await mine(bob, acmeId)).toMatchObject({
      plan_status: 'closed',
      plan_status_message: 'Unpaid since June',
      read_only_at: null,
    });
    const me = await body(await t.api(bob, acmeId).get('/auth/me'));
    expect(me.account).toMatchObject({ id: acmeId, plan_status: 'closed' });
    expect(me.user.email).toBe('bob@acme.test');
  });

  it('every account-scoped route answers 403 account_closed — reads, writes, admins and members alike', async () => {
    for (const cookie of [admin, bob]) {
      await expectClosed(await as(cookie).get('/workspaces'));
      await expectClosed(await as(cookie).get(`/boards/${boardId}`));
      await expectClosed(await as(cookie).get(`/items/${itemId}`));
      await expectClosed(await as(cookie).post(`/boards/${boardId}/items`, { name: 'X' }));
      await expectClosed(await as(cookie).get('/users/me'));
      await expectClosed(await as(cookie).get('/search?q=Dana'));
      await expectClosed(await as(cookie).get('/me/notifications'));
      await expectClosed(await as(cookie).get('/ai/assistant/status'));
      await expectClosed(await as(cookie).post('/files/presign', { name: 'a.txt', size: 1, mime: 'text/plain' }));
    }
    await expectClosed(await as().get('/accounts/me'));
    await expectClosed(await as().get('/users'));
    await expectClosed(await as().patch('/accounts/me', { name: 'Renamed' }));
    await expectClosed(await as().post('/auth/tokens', { name: 'New', scopes: ['boards:read'] }));
    await expectClosed(await as().post(`/docs/x/collab-token`));
  });

  it('the live stream is refused', async () => {
    const res = await t.app.request(`/api/v1/me/events?account_id=${acmeId}`, {
      headers: { origin: WEB_ORIGIN, cookie: bob },
    });
    await expectClosed(res);
  });

  it('the allowlist answers: the current user, the accounts list, the plan, the offered plans, support', async () => {
    expect((await t.api(bob).get('/auth/me')).status).toBe(200);
    expect((await t.api(bob).get('/me/accounts')).status).toBe(200);
    const plan = await as().get('/plan');
    expect(plan.status).toBe(200);
    expect((await body(plan)).subscription.status).toBe('closed');
    // "My plan" stays the admins' page.
    expect((await as(bob).get('/plan')).status).toBe(403);
    const offer = await body(await t.api(bob).get('/plans/public'));
    expect(offer.data.map((p: Json) => p.name)).toEqual(['Team']);
    expect(offer.data[0]).toMatchObject({ price_monthly: 49, price_yearly: 490, currency: 'ILS' });
    expect(offer.data[0]).not.toHaveProperty('subscribers');
    expect(offer).toHaveProperty('contact_url');
    expect((await as(bob).get('/support/tickets/options')).status).toBe(200);
    // Sign-out is Better Auth's own and never account-scoped.
    const out = await t.app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, cookie: (await t.signInWithMagicLink('bob@acme.test')).cookie! },
    });
    expect(out.status).toBe(200);
  });

  it('the offered plans need a signed-in person, never a token', async () => {
    expect((await t.app.request('/api/v1/plans/public')).status).toBe(401);
    expect((await bearer('/plans/public')).status).toBe(403);
  });

  it('a support ticket can be opened from the closed account (contact us)', async () => {
    const opts = await body(await as(bob).get('/support/tickets/options'));
    expect(opts).toMatchObject({ enabled: true, may_open: true });
    const res = await as(bob).post('/support/tickets', { subject: 'Reopen', description: 'Please reopen' });
    expect(res.status).toBe(201);
    const ticket = await body(res);
    expect((await as(bob).get(`/support/tickets/${ticket.id}`)).status).toBe(200);
    expect((await as(bob).post(`/support/tickets/${ticket.id}/messages`, { body: 'Any news?' })).status).toBeLessThan(
      300,
    );
    expect((await as(bob).get('/support/tickets')).status).toBe(200);
  });

  it('API tokens and the MCP server are refused (the token is kept)', async () => {
    await expectClosed(await bearer('/workspaces'));
    await expectClosed(await bearer(`/boards/${boardId}`));
    // Even the allowlist is not for tokens.
    expect((await bearer('/support/tickets/options')).status).toBe(403);
    const m = await mcp();
    expect(m.status).toBe(403);
    expect(JSON.stringify(await body(m))).toContain('account_closed');
  });

  it('public forms and inbound webhooks of the account are refused', async () => {
    await expectClosed(await t.app.request(`/api/v1/public/forms/${formToken}`));
    await expectClosed(await inbound());
  });

  it('background work does not run: a pending event dispatches nothing, a queued run is skipped, no webhook goes out', async () => {
    expect(await dispatchEvent(t.deps, pendingEvent)).toEqual([]);
    await executeRun(t.deps, queuedRun);
    const run = (await t.db.select().from(automationRuns).where(eq(automationRuns.id, queuedRun)))[0]!;
    expect(run).toMatchObject({ status: 'skipped', skipReason: 'account_closed' });
    await deliver(t.deps, deliveryId);
    const after = (await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)))[0]!;
    expect(after).toMatchObject({ status: 'failed', error: 'account_closed' });
    // The automation itself stays on (nothing is switched off or deleted).
    const autos = await t.db
      .select({ runs: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, automationId), eq(automationRuns.status, 'skipped')));
    expect(autos.length).toBeGreaterThan(0);
  });

  it('no AI: a model call is refused', async () => {
    await expect(completeWith(t.deps, acmeId, 'none', 'assistant', { messages: [] } as never)).rejects.toMatchObject({
      code: 'account_closed',
    });
  });

  it('another account of the same platform is untouched', async () => {
    expect((await t.api(otherAdmin, otherId).get('/workspaces')).status).toBe(200);
  });

  it('reopening brings everything back — nothing was deleted', async () => {
    await set(acmeId, { status: 'active', status_message: null });
    expect(await mine(bob, acmeId)).toMatchObject({ plan_status: 'active', plan_status_message: null });
    const item = await as(bob).get(`/items/${itemId}`);
    expect(item.status).toBe(200);
    expect((await body(item)).name).toContain('Dana');
    expect((await bearer('/workspaces')).status).toBe(200);
    expect((await mcp()).status).toBe(200);
    expect((await t.app.request(`/api/v1/public/forms/${formToken}`)).status).toBe(200);
    expect((await inbound()).status).toBe(202);
  });
});

describe('read-only and suspended: no AI at all', () => {
  const actor = (): Actor =>
    ({
      ctx: { accountId: acmeId, role: 'admin', account: { id: acmeId }, membershipId: 'm' },
      user: { id: 'u', email: 'admin@acme.test', name: 'admin', emailVerified: true, isPlatformOwner: false },
      requestId: 'r',
    }) as unknown as Actor;
  const readTool = { name: 'list_boards', risk: 'read' as const };

  it('read-only: the assistant says why and opens nothing; reads elsewhere still work', async () => {
    await set(acmeId, { status: 'read_only' });
    const st = await body(await as().get('/ai/assistant/status'));
    expect(st).toMatchObject({ available: false, reason: 'plan_status' });
    const list = await as().get(`/ai/assistant/conversations?board_id=${boardId}`);
    expect(list.status).toBe(423);
    expect((await body(list)).error).toMatchObject({ code: 'plan_read_only', details: { ai: true } });
    expect((await as().get('/workspaces')).status).toBe(200);
  });

  it('read-only: every model call and the assistant / agents’ tool reads are refused; MCP reads are not', async () => {
    await expect(completeWith(t.deps, acmeId, 'none', 'column', { messages: [] } as never)).rejects.toMatchObject({
      code: 'plan_read_only',
    });
    for (const surface of ['assistant', 'agent'] as const)
      await expect(guardToolCall(t.deps, { surface, actor: actor(), tool: readTool, input: {} })).rejects.toMatchObject(
        { code: 'plan_read_only' },
      );
    await expect(
      guardToolCall(t.deps, { surface: 'mcp', actor: actor(), tool: readTool, input: {} }),
    ).resolves.toBeUndefined();
  });

  it('suspended and closed: the tool guard refuses every surface', async () => {
    await set(acmeId, { status: 'suspended' });
    await expect(
      guardToolCall(t.deps, { surface: 'mcp', actor: actor(), tool: readTool, input: {} }),
    ).rejects.toMatchObject({ code: 'plan_suspended' });
    await set(acmeId, { status: 'closed' });
    await expect(
      guardToolCall(t.deps, { surface: 'assistant', actor: actor(), tool: readTool, input: {} }),
    ).rejects.toMatchObject({ code: 'account_closed' });
    await set(acmeId, { status: 'active' });
    const st = await body(await as().get('/ai/assistant/status'));
    expect(st.reason).not.toBe('plan_status');
  });
});

describe('billing settings: the closed screen texts', () => {
  it('the owner sets the text and the contact target; the offer carries them; a bad target is refused', async () => {
    const res = await t
      .api(owner)
      .patch('/platform/billing-settings', { closed_text: 'Call us', contact_url: 'mailto:sales@example.com' });
    expect(res.status).toBe(200);
    const offer = await body(await t.api(bob).get('/plans/public'));
    expect(offer).toMatchObject({ closed_text: 'Call us', contact_url: 'mailto:sales@example.com' });
    expect(
      (await t.api(owner).patch('/platform/billing-settings', { contact_url: 'javascript:alert(1)' })).status,
    ).toBe(400);
    await t.api(owner).patch('/platform/billing-settings', { closed_text: null, contact_url: null });
    expect(await body(await t.api(bob).get('/plans/public'))).toMatchObject({ closed_text: null, contact_url: null });
  });
});
