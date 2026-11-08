// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveSubscriptionStatus, newId, type RecipeInput } from '@bines/shared';
import { accountSubscriptions, activityLog, automationRuns, automations, notifications } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { completeWith } from '../src/modules/ai/ai.service';
import { consume, forgetEntitlements } from '../src/modules/billing/entitlements';
import { registerBillingProvider, unregisterBillingProvider } from '../src/modules/billing/provider';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Plans (stages 1–3): the owner's plans editor (versions, grandfathering), assigning a plan / status /
 * override to an account, every limit at its enforcement point (seats, boards, items incl. bulk import, storage,
 * automation runs, AI, API calls), the 80% / reached notices once a period, the monthly reset, read-only and
 * suspended, legacy accounts unlimited, "My plan", and the billing webhook stub.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let legacyId: string;
let betaId: string;
let gammaId: string;
let gammaAdmin: string;
let wsId: string;
let boardId: string;
let adminId: string;
let planId: string;
let v1: string;
let v2: string;
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
const view = async (accountId: string) => body(await t.api(owner).get(`/platform/accounts/${accountId}/subscription`));
const used = async (accountId: string, kind: string) =>
  ((await view(accountId)).usage as Json[]).find((u) => u.kind === kind)!.used as number;
/** Same version, new override / status (in place). */
const set = async (accountId: string, patch: Json, version = v1) => {
  const res = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, {
    plan_version_id: version,
    ...patch,
  });
  expect(res.status).toBe(200);
  return body(res);
};
const expectLimit = async (res: Response, kind: string) => {
  expect(res.status).toBe(402);
  const err = (await body(res)).error;
  expect(err.code).toBe('plan_limit_reached');
  expect(err.details).toMatchObject({ kind, upgrade: true });
  expect(typeof err.details.limit).toBe('number');
  expect(typeof err.details.used).toBe('number');
  return err.details as Json;
};

const seen = new Set<string>();
const drain = async (accountId: string) => {
  const rows = await t.db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(eq(activityLog.accountId, accountId))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
  }
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  legacyId = await mk('Legacy', 'legacy', 'admin@legacy.test');
  betaId = await mk('Beta', 'beta', 'admin@beta.test');
  gammaId = await mk('Gamma', 'gamma', 'admin@gamma.test');
  admin = await join('admin@acme.test');
  await join('admin@legacy.test');
  await join('admin@beta.test');
  gammaAdmin = await join('admin@gamma.test');
  await as().post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  await as().post(`/boards/${boardId}/items`, { name: 'Dana' });
});
afterAll(() => t.close());

describe('legacy accounts', () => {
  it('have no subscription and no limits — nothing is seeded', async () => {
    const plans = await body(await t.api(owner).get('/platform/plans'));
    expect(plans.data).toEqual([]);
    const v = await view(legacyId);
    expect(v.subscription).toBeNull();
    expect(v.entitlements).toMatchObject({ unlimited: true, status: null });
    expect((v.usage as Json[]).every((u) => u.limit === null)).toBe(true);
    const legacyAdmin = (await t.signInWithMagicLink('admin@legacy.test')).cookie!;
    const ws = (await body(await t.api(legacyAdmin, legacyId).get('/workspaces'))).data[0].id;
    for (const name of ['A', 'B', 'C'])
      expect((await t.api(legacyAdmin, legacyId).post('/boards', { name, workspace_id: ws })).status).toBe(201);
  });
});

describe('owner console: plans and versions', () => {
  it('is the owner’s only', async () => {
    expect((await as().get('/platform/plans')).status).toBe(404);
    expect((await as().post('/platform/plans', { name: 'X' })).status).toBe(404);
  });

  it('creates a plan with a version, edits an unused version, locks a used one (grandfathering)', async () => {
    const created = await t.api(owner).post('/platform/plans', {
      name: 'Pro',
      description: 'For teams',
      version: { price_monthly: 49.9, price_yearly: 499, currency: 'ILS', pricing: 'per_seat', limits: { boards: 50 } },
    });
    expect(created.status).toBe(201);
    const plan = await body(created);
    planId = plan.id;
    v1 = plan.current_version_id;
    expect(plan.versions[0]).toMatchObject({ version: 1, price_monthly: 49.9, pricing: 'per_seat', locked: false });

    // Unused: editable in place.
    const edited = await body(
      await t.api(owner).patch(`/platform/plan-versions/${v1}`, { price_monthly: 59, limits: { boards: 50 } }),
    );
    expect(edited.versions[0].price_monthly).toBe(59);

    // Assigned → locked: a new price is a new version.
    const assigned = await set(acmeId, {});
    expect(assigned.subscription).toMatchObject({ plan_name: 'Pro', version: 1, status: 'active', interval: 'month' });
    expect(assigned.entitlements.limits.boards).toBe(50);
    const locked = await t.api(owner).patch(`/platform/plan-versions/${v1}`, { price_monthly: 69 });
    expect(locked.status).toBe(409);
    expect((await body(locked)).error.message).toBe('version_in_use');

    const two = await body(
      await t.api(owner).post(`/platform/plans/${planId}/versions`, { price_monthly: 79, limits: { boards: 1 } }),
    );
    v2 = two.current_version_id;
    expect(two.versions.map((v: Json) => v.version)).toEqual([1, 2]);
    expect(two.versions[0]).toMatchObject({ locked: true, subscribers: 1 });

    // Acme keeps v1's limits; a new account gets v2's.
    expect((await view(acmeId)).entitlements.limits.boards).toBe(50);
    const beta = await set(betaId, {}, v2);
    expect(beta.entitlements.limits.boards).toBe(1);

    // A plan with history cannot be deleted (archive instead).
    expect((await t.api(owner).del(`/platform/plans/${planId}`)).status).toBe(409);
    const archived = await body(await t.api(owner).patch(`/platform/plans/${planId}`, { archived: true }));
    expect(archived.archived).toBe(true);
    await t.api(owner).patch(`/platform/plans/${planId}`, { archived: false });

    // Ending a subscription = legacy again; the row stays in the history.
    const ended = await body(await t.api(owner).del(`/platform/accounts/${betaId}/subscription`));
    expect(ended.subscription).toBeNull();
    expect(ended.entitlements.unlimited).toBe(true);
    expect(ended.history).toHaveLength(1);
    expect(ended.history[0].ended_at).not.toBeNull();
  });

  it('lists the current subscriptions for the accounts list', async () => {
    const subs = (await body(await t.api(owner).get('/platform/subscriptions'))).data as Json[];
    expect(subs.map((s) => s.account_id)).toEqual([acmeId]);
  });
});

describe('limits at their enforcement points', () => {
  it('boards: blocks only the next board, keeps every board', async () => {
    const before = await used(acmeId, 'boards');
    await set(acmeId, { overrides: { boards: before } });
    const details = await expectLimit(await as().post('/boards', { name: 'One more', workspace_id: wsId }), 'boards');
    expect(details).toMatchObject({ limit: before, used: before });
    expect((await body(await as().get('/boards'))).data.length).toBeGreaterThan(0);
    await set(acmeId, { overrides: {} });
    expect((await as().post('/boards', { name: 'Now fine', workspace_id: wsId })).status).toBe(201);
  });

  it('items: the API, subitems and the bulk import', async () => {
    const before = await used(acmeId, 'items');
    await set(acmeId, { overrides: { items: before + 1 } });
    const ok = await as().post(`/boards/${boardId}/items`, { name: 'Last one' });
    expect(ok.status).toBe(201);
    await expectLimit(await as().post(`/boards/${boardId}/items`, { name: 'Too many' }), 'items');
    await expectLimit(await as().post(`/items/${(await body(ok)).id}/subitems`, { name: 'Sub' }), 'items');
    await expectLimit(
      await as().post(`/boards/${boardId}/items/bulk-edit`, {
        labels: [],
        tags: [],
        columns: [],
        rows: [{ name: 'r1', cells: {} }],
      }),
      'items',
    );
    expect(await used(acmeId, 'items')).toBe(before + 1);
    // Override null = no limit for this kind.
    await set(acmeId, { overrides: { items: null } });
    const bulk = await as().post(`/boards/${boardId}/items/bulk-edit`, {
      labels: [],
      tags: [],
      columns: [],
      rows: [
        { name: 'r1', cells: {} },
        { name: 'r2', cells: {} },
      ],
    });
    expect(bulk.status).toBe(200);
    await set(acmeId, { overrides: {} });
  });

  it('seats: invitations and re-activation; guests take none', async () => {
    const seats = await used(acmeId, 'seats');
    expect(seats).toBe(2); // admin + bob
    await set(acmeId, { overrides: { seats: 3 } });
    expect((await as().post('/users/invite', { emails: ['carol@acme.test'], role: 'member' })).status).toBe(200);
    await expectLimit(await as().post('/users/invite', { emails: ['dan@acme.test'], role: 'member' }), 'seats');
    // Re-inviting the same address takes no new seat.
    expect((await as().post('/users/invite', { emails: ['carol@acme.test'], role: 'member' })).status).toBe(200);
    // Deactivate bob → a seat frees; carol's pending invitation keeps hers; bob back in fits again.
    const bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;
    expect((await as().post(`/users/${bobId}/deactivate`, {})).status).toBe(200);
    expect((await as().post('/users/invite', { emails: ['dan@acme.test'], role: 'member' })).status).toBe(200);
    await expectLimit(await as().post(`/users/${bobId}/activate`, {}), 'seats');
    await set(acmeId, { overrides: {} });
    expect((await as().post(`/users/${bobId}/activate`, {})).status).toBe(200);
    bob = (await t.signInWithMagicLink('bob@acme.test')).cookie!; // deactivation ended his sessions
  });

  it('storage: an upload over the plan’s storage is refused before it starts', async () => {
    await set(acmeId, { overrides: { storage_gb: 0.000001 } }); // ~1 KB
    await expectLimit(
      await as().post('/files/presign', { name: 'big.pdf', size: 5000, mime: 'application/pdf' }),
      'storage_gb',
    );
    expect((await as().post('/files/presign', { name: 'small.pdf', size: 100, mime: 'application/pdf' })).status).toBe(
      200,
    );
    await set(acmeId, { overrides: {} });
  });

  it('automation runs: the month’s runs counted; over the limit a run is skipped, the automation stays on', async () => {
    await drain(acmeId);
    await set(acmeId, { overrides: { automation_runs: 1 } });
    const autoId = newId();
    await t.db.insert(automations).values({
      id: autoId,
      accountId: acmeId,
      boardId,
      title: 'Prefix',
      recipe: {
        trigger: { type: 'item_created' },
        actions: [{ type: 'set_item_name', name: 'L: {item.name}' }],
      } satisfies RecipeInput as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    await as().post(`/boards/${boardId}/items`, { name: 'first' });
    await as().post(`/boards/${boardId}/items`, { name: 'second' });
    await drain(acmeId);
    const runs = await t.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, autoId))
      .orderBy(asc(automationRuns.createdAt));
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'skipped']);
    expect(runs[1]!.skipReason).toBe('plan_limit_reached');
    const auto = (await t.db.select().from(automations).where(eq(automations.id, autoId)))[0]!;
    expect(auto.isActive).toBe(true);
    expect(await used(acmeId, 'automation_runs')).toBe(1);
    await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, autoId));
    await set(acmeId, { overrides: {} });
  });

  it('AI: the plan’s monthly budget caps every model call', async () => {
    expect((await as().patch('/ai/settings', { enabled: true })).status).toBe(200);
    await set(acmeId, { overrides: { ai_usd: 0 } });
    await expect(
      completeWith(t.deps, acmeId, newId(), 'test', { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'plan_limit_reached', details: { kind: 'ai_usd' } });
    await set(acmeId, { overrides: {} });
    // Without the plan's cap the call goes on (and fails on the unknown connection instead).
    await expect(
      completeWith(t.deps, acmeId, newId(), 'test', { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('API calls: all the account’s tokens together, per day', async () => {
    const { token } = await body(await as().post('/auth/tokens', { name: 'Make', scopes: ['boards:read'] }));
    await set(acmeId, { overrides: { api_calls_per_day: 2 } });
    const call = () => t.app.request('/api/v1/workspaces', { headers: { authorization: `Bearer ${token}` } });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    await expectLimit(await call(), 'api_calls_per_day');
    await set(acmeId, { overrides: {} });
    expect((await call()).status).toBe(200);
  });
});

describe('notices and periods', () => {
  it('warns the admins once at the warning share, once more when the limit is reached', async () => {
    await set(gammaId, {});
    const ws = (await body(await t.api(gammaAdmin, gammaId).get('/workspaces'))).data[0].id;
    const board = (await body(await t.api(gammaAdmin, gammaId).post('/boards', { name: 'G', workspace_id: ws }))).id;
    const base = await used(gammaId, 'items');
    await set(gammaId, { overrides: { items: base + 5 } });
    const notices = async () =>
      (
        await t.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.accountId, gammaId), eq(notifications.type, 'plan_limit')))
      ).map((n) => (n.payload as Json).level as string);
    for (let i = 0; i < 3; i++) await t.api(gammaAdmin, gammaId).post(`/boards/${board}/items`, { name: `i${i}` });
    expect(await notices()).toEqual([]); // 3 / 5 = 60 %
    await t.api(gammaAdmin, gammaId).post(`/boards/${board}/items`, { name: 'i3' }); // 80 %
    expect(await notices()).toEqual(['warn']);
    await t.api(gammaAdmin, gammaId).post(`/boards/${board}/items`, { name: 'i4' }); // 100 %
    expect((await notices()).sort()).toEqual(['reached', 'warn']);
    await expectLimit(await t.api(gammaAdmin, gammaId).post(`/boards/${board}/items`, { name: 'i5' }), 'items');
    expect(await notices()).toHaveLength(2); // once a period each
    const n = (
      await t.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.accountId, gammaId), eq(notifications.type, 'plan_limit')))
    )[0]!;
    expect(n.payload).toMatchObject({ kind: 'items' });
  });

  it('consumption counters reset every month', async () => {
    await set(gammaId, { overrides: { automation_runs: 2 } });
    const jan = new Date('2031-01-15T10:00:00Z');
    await consume(t.db as never, gammaId, 'automation_runs', 1, jan);
    await consume(t.db as never, gammaId, 'automation_runs', 1, new Date('2031-01-20T10:00:00Z'));
    await expect(
      consume(t.db as never, gammaId, 'automation_runs', 1, new Date('2031-01-31T23:59:00Z')),
    ).rejects.toMatchObject({ code: 'plan_limit_reached' });
    await expect(
      consume(t.db as never, gammaId, 'automation_runs', 1, new Date('2031-02-01T00:00:00Z')),
    ).resolves.toBeUndefined();
  });
});

describe('statuses', () => {
  it('read_only: reads work (also POST queries), writes wait — except the admins’ billing and administration', async () => {
    await set(acmeId, { status: 'read_only' });
    expect((await as().get('/boards')).status).toBe(200);
    expect((await as().get(`/boards/${boardId}`)).status).toBe(200);
    expect((await as().post(`/boards/${boardId}/items/query`, {})).status).toBe(200);
    const write = await as().post(`/boards/${boardId}/items`, { name: 'x' });
    expect(write.status).toBe(423);
    expect((await body(write)).error.code).toBe('plan_read_only');
    expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'x' })).status).toBe(423);
    expect((await as().get('/plan')).status).toBe(200);
    expect((await as().patch('/accounts/me', { name: 'Acme Ltd' })).status).toBe(200);
  });

  it('suspended: only the admins’ "My plan" answers', async () => {
    await set(acmeId, { status: 'suspended' });
    const res = await as().get('/boards');
    expect(res.status).toBe(423);
    expect((await body(res)).error.code).toBe('plan_suspended');
    expect((await as().get('/plan')).status).toBe(200);
    expect((await as(bob).get('/plan')).status).toBe(423);
    await set(acmeId, { status: 'active' });
    expect((await as().get('/boards')).status).toBe(200);
  });

  it('support tickets stay open in read_only and suspended accounts', async () => {
    for (const status of ['read_only', 'suspended']) {
      await set(acmeId, { status });
      const opened = await as(bob).post('/support/tickets', { subject: `Blocked ${status}`, description: 'Help' });
      expect(opened.status).toBe(201);
      const id = (await body(opened)).id as string;
      expect((await as(bob).get(`/support/tickets/${id}`)).status).toBe(200);
      expect((await as(bob).post(`/support/tickets/${id}/messages`, { body: 'More' })).status).toBe(200);
      expect((await as(bob).post(`/support/tickets/${id}/close`)).status).toBe(200);
      expect((await as(bob).post(`/support/tickets/${id}/rating`, { rating: 4 })).status).toBe(200);
      // Admins' approve / decline reach the tickets module (an unknown request is its 404, not the plan's 423).
      expect((await as().post('/support/access-requests/01ZZZZZZZZZZZZZZZZZZZZZZZZ/approve')).status).toBe(404);
      expect((await as().post('/support/access-requests/01ZZZZZZZZZZZZZZZZZZZZZZZZ/decline')).status).toBe(404);
      // Everything else stays blocked.
      expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'x' })).status).toBe(423);
    }
    await set(acmeId, { status: 'active' });
  });

  it('past_due → read_only after the grace period → suspended later (billing settings)', async () => {
    const settings = {
      past_due_grace_days: 7,
      read_only_days: 30,
      trial_end_status: 'past_due',
      canceled_status: 'read_only',
    } as const;
    const since = new Date('2031-03-01T00:00:00Z');
    const s = {
      status: 'past_due' as const,
      statusSince: since,
      trialEndsAt: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
    };
    expect(effectiveSubscriptionStatus(s, settings, new Date('2031-03-05T00:00:00Z'))).toBe('past_due');
    expect(effectiveSubscriptionStatus(s, settings, new Date('2031-03-09T00:00:00Z'))).toBe('read_only');
    expect(effectiveSubscriptionStatus(s, settings, new Date('2031-04-08T00:00:00Z'))).toBe('suspended');
    expect(effectiveSubscriptionStatus(s, { ...settings, past_due_grace_days: null }, new Date('2032-01-01'))).toBe(
      'past_due',
    );
    // A trial past its end; a cancellation past the period end.
    const trial = { ...s, status: 'trial' as const, trialEndsAt: since };
    expect(effectiveSubscriptionStatus(trial, settings, new Date('2031-03-02T00:00:00Z'))).toBe('past_due');
    const cancel = { ...s, status: 'active' as const, periodEnd: since, cancelAtPeriodEnd: true };
    expect(effectiveSubscriptionStatus(cancel, settings, new Date('2031-03-02T00:00:00Z'))).toBe('read_only');

    // The settings are the owner's, and the account's effective status follows them.
    const patched = await body(await t.api(owner).patch('/platform/billing-settings', { past_due_grace_days: 0 }));
    expect(patched.past_due_grace_days).toBe(0);
    await set(acmeId, { status: 'past_due' });
    expect((await as().post(`/boards/${boardId}/items`, { name: 'x' })).status).toBe(423);
    await t.api(owner).patch('/platform/billing-settings', { past_due_grace_days: 7 });
    expect((await as().post(`/boards/${boardId}/items`, { name: 'x' })).status).toBe(201);
    await set(acmeId, { status: 'active' });
  });
});

describe('"My plan"', () => {
  it('shows the admins their plan, usage bars, history and the owner’s upgrade text', async () => {
    await t.api(owner).patch('/platform/billing-settings', {
      upgrade_text: 'Write to us to upgrade',
      upgrade_url: 'https://example.test/upgrade',
      features: [{ key: 'ai', label: 'AI' }],
    });
    const plan = await body(await as().get('/plan'));
    expect(plan.subscription).toMatchObject({ plan_name: 'Pro', effective_status: 'active' });
    expect(plan.usage.find((u: Json) => u.kind === 'seats')).toMatchObject({ limit: null });
    expect(plan.upgrade).toEqual({ text: 'Write to us to upgrade', url: 'https://example.test/upgrade' });
    expect(plan.features).toEqual([{ key: 'ai', label: 'AI' }]);
    expect(plan.history.length).toBeGreaterThan(0);
    expect((await as(bob).get('/plan')).status).toBe(403);
    // A token never reads it.
    const { token } = await body(await as().post('/auth/tokens', { name: 'T', scopes: ['admin'] }));
    expect((await t.app.request('/api/v1/plan', { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
  });
});

describe('billing webhook stub', () => {
  it('answers 501 until a provider is registered; a registered one is verified and read back', async () => {
    const res = await t.app.request('/api/v1/billing/webhook/acmepay', { method: 'POST', body: '{}' });
    expect(res.status).toBe(501);
    expect((await body(res)).error.code).toBe('not_implemented');

    const sub = (await view(acmeId)).subscription;
    await t.db
      .update(accountSubscriptions)
      .set({ provider: 'acmepay', externalId: 'sub_1' })
      .where(eq(accountSubscriptions.id, sub.id));
    registerBillingProvider({
      key: 'acmepay',
      createCheckout: () => Promise.reject(new Error('not used')),
      cancel: () => Promise.resolve(),
      getStatus: (externalId) =>
        Promise.resolve({
          externalId,
          status: 'past_due',
          periodStart: null,
          periodEnd: null,
          cancelAtPeriodEnd: false,
        }),
      verifyWebhook: (req) => Promise.resolve(req.headers['x-signature'] === 'good'),
      // The event says "activated"; core believes getStatus (past_due), never the event.
      mapEvent: () =>
        Promise.resolve([
          { id: 'ev_1', type: 'subscription.activated', externalId: 'sub_1', occurredAt: new Date().toISOString() },
        ]),
    });
    try {
      const bad = await t.app.request('/api/v1/billing/webhook/acmepay', {
        method: 'POST',
        headers: { 'x-signature': 'bad' },
        body: '{}',
      });
      expect(bad.status).toBe(401);
      const good = await t.app.request('/api/v1/billing/webhook/acmepay', {
        method: 'POST',
        headers: { 'x-signature': 'good' },
        body: '{}',
      });
      expect(good.status).toBe(200);
      expect(await body(good)).toEqual({ received: 1, applied: 1 });
      forgetEntitlements(acmeId);
      expect((await view(acmeId)).subscription.status).toBe('past_due');
      const audit = await t.db.execute(
        sql`select action from audit_log where account_id = ${acmeId} and action = 'plan.provider_event'`,
      );
      expect((audit as unknown as { rows: unknown[] }).rows).toHaveLength(1);
    } finally {
      unregisterBillingProvider('acmepay');
      await set(acmeId, { status: 'active' });
    }
  });
});
