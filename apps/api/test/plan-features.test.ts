// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, PLAN_FEATURE_KEYS, planIncludesFeature } from '@bines/shared';
import { activityLog, automationRuns, automations } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { completeWith } from '../src/modules/ai/ai.service';
import { routeFeature } from '../src/modules/billing/feature-gates';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/**
 * Plan feature gates (plans): every gate answers 402 `plan_feature_unavailable` {feature, upgrade}
 * a legacy account (no subscription) and a version with an empty feature list have everything; a downgrade keeps
 * what exists readable (only creating / editing / using is blocked); /me/accounts carries `plan_features` and
 * "My plan" lists what is included and what is not. Also (a) the monthly period setting and (b) seats.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
let legacyId: string;
let openId: string;
let legacyAdmin: string;
let openAdmin: string;
let wsId: string;
let boardId: string;
/** A version that lists features (only `guests`): everything else is off. */
let basicV: string;
/** A version that lists none: every feature. */
let openV: string;
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
const assign = async (accountId: string, version: string) => {
  const res = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, { plan_version_id: version });
  expect(res.status).toBe(200);
};
const expectFeature = async (res: Response, feature: string) => {
  expect(res.status).toBe(402);
  const err = (await body(res)).error;
  expect(err.code).toBe('plan_feature_unavailable');
  expect(err.details).toEqual({ feature, upgrade: true });
};
const myAccount = async (cookie: string, accountId: string) =>
  ((await body(await t.api(cookie).get('/me/accounts'))).data as Json[]).find((a) => a.id === accountId)!;

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

// Made under the open plan, before the downgrade.
let dashboardId: string;
let docId: string;
let formViewId: string;
let formToken: string;
let apiToken: string;
let mailAutomationId: string;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  legacyId = await mk('Legacy', 'legacy', 'admin@legacy.test');
  openId = await mk('Open', 'open', 'admin@open.test');
  admin = await join('admin@acme.test');
  legacyAdmin = await join('admin@legacy.test');
  openAdmin = await join('admin@open.test');
  wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId }))).id;

  const basic = await body(
    await t.api(owner).post('/platform/plans', { name: 'Basic', version: { features: ['guests'] } }),
  );
  basicV = basic.versions[0].id;
  const open = await body(await t.api(owner).post('/platform/plans', { name: 'Open', version: { features: [] } }));
  openV = open.versions[0].id;
  await assign(openId, openV);
  await assign(acmeId, openV);
});
afterAll(() => t.close());

describe('the shared rule', () => {
  it('null (legacy) and an empty list include everything; a list includes only itself', () => {
    for (const k of PLAN_FEATURE_KEYS) {
      expect(planIncludesFeature(null, k)).toBe(true);
      expect(planIncludesFeature([], k)).toBe(true);
    }
    expect(planIncludesFeature(['guests'], 'guests')).toBe(true);
    expect(planIncludesFeature(['guests'], 'ai')).toBe(false);
  });

  it('the route table: writes of gated routes only — reads, DELETEs and the open exceptions pass', () => {
    const cases: [string, string, string | null][] = [
      ['POST', '/ai/assistant/conversations', 'ai'],
      ['POST', '/ai/assistant/conversations/x/messages', 'ai'],
      ['GET', '/ai/assistant/conversations', null],
      ['POST', '/boards/b/ai-columns/c/run', 'ai'],
      ['POST', '/agents', 'ai'],
      ['PATCH', '/agents/a', 'ai'],
      ['POST', '/agents/a/runs', 'ai'],
      ['POST', '/agents/runs/r/cancel', null],
      ['POST', '/agents/runs/r/undo', null],
      ['DELETE', '/agents/a', null],
      ['POST', '/auth/tokens', 'api'],
      ['POST', '/auth/service-tokens', 'api'],
      ['PATCH', '/auth/tokens/x', 'api'],
      ['DELETE', '/auth/tokens/x', null],
      ['POST', '/extensions/install', 'extensions'],
      ['POST', '/extensions/preview', 'extensions'],
      ['POST', '/extensions/installations/i/approve-update', 'extensions'],
      ['PATCH', '/extensions/installations/i', null],
      ['POST', '/flow-connections', 'flows'],
      ['PUT', '/flow-connections/c/flows/f/active', 'flows'],
      ['GET', '/flow-connections', null],
      ['POST', '/workspaces/w/dashboards', 'dashboards'],
      ['PATCH', '/dashboards/d', 'dashboards'],
      ['POST', '/dashboards/d/widgets', 'dashboards'],
      ['PUT', '/dashboards/d/layout', 'dashboards'],
      ['PATCH', '/dashboard-widgets/w', 'dashboards'],
      ['POST', '/dashboards/d/widgets/w/data', null],
      ['GET', '/dashboards/d', null],
      ['POST', '/workspaces/w/docs', 'docs'],
      ['PATCH', '/docs/d', 'docs'],
      ['POST', '/docs/d/duplicate', 'docs'],
      ['POST', '/docs/d/versions', 'docs'],
      ['POST', '/docs/d/versions/v/restore', 'docs'],
      ['POST', '/items/i/cells/c/doc', 'docs'],
      ['POST', '/docs/d/collab-token', null],
      ['POST', '/docs/d/comments', null],
      ['PATCH', '/views/v/form', 'forms'],
      ['POST', '/views/v/form/token', 'forms'],
      ['GET', '/views/v/form', null],
      ['POST', '/boards/b/items', null],
      ['POST', '/support-access', null],
    ];
    for (const [method, path, feature] of cases)
      expect([method, path, routeFeature(method, path)]).toEqual([method, path, feature]);
  });
});

describe('legacy and empty lists = everything', () => {
  it('a legacy account (no subscription): /me/accounts null, every gated thing works', async () => {
    const me = await myAccount(legacyAdmin, legacyId);
    expect(me.plan_status).toBeNull();
    expect(me.plan_features).toBeNull();
    const ws = (await body(await t.api(legacyAdmin, legacyId).get('/workspaces'))).data[0].id;
    expect((await t.api(legacyAdmin, legacyId).post(`/workspaces/${ws}/dashboards`, { name: 'D' })).status).toBe(201);
    expect((await t.api(legacyAdmin, legacyId).post(`/workspaces/${ws}/docs`, { name: 'Doc' })).status).toBe(201);
    expect(
      (await t.api(legacyAdmin, legacyId).post('/auth/tokens', { name: 'T', scopes: ['boards:read'] })).status,
    ).toBe(201);
    const plan = await body(await t.api(legacyAdmin, legacyId).get('/plan'));
    expect(plan.entitlements).toMatchObject({ unlimited: true, all_features: true });
    expect((plan.feature_access as Json[]).every((f) => f.included)).toBe(true);
  });

  it('a version with an empty feature list: /me/accounts null, every gated thing works', async () => {
    const me = await myAccount(openAdmin, openId);
    expect(me.plan_status).toBe('active');
    expect(me.plan_features).toBeNull();
    const api = t.api(openAdmin, openId);
    const ws = (await body(await api.get('/workspaces'))).data[0].id;
    const board = (await body(await api.post('/boards', { name: 'B', workspace_id: ws }))).id;
    expect((await api.post(`/workspaces/${ws}/dashboards`, { name: 'D' })).status).toBe(201);
    expect((await api.post(`/workspaces/${ws}/docs`, { name: 'Doc' })).status).toBe(201);
    expect((await api.post(`/boards/${board}/views`, { type: 'form', name: 'F' })).status).toBe(201);
    expect((await api.post('/users/invite', { emails: ['g@open.test'], role: 'guest' })).status).toBe(200);
    const plan = await body(await api.get('/plan'));
    expect(plan.entitlements).toMatchObject({ unlimited: false, all_features: true, features: [] });
    expect((plan.feature_access as Json[]).every((f) => f.included)).toBe(true);
  });
});

describe('a downgrade to a plan that lists features', () => {
  it('before: the open plan makes a dashboard, a doc, a form, a token and a mail automation', async () => {
    dashboardId = (await body(await as().post(`/workspaces/${wsId}/dashboards`, { name: 'Sales' }))).id;
    docId = (await body(await as().post(`/workspaces/${wsId}/docs`, { name: 'Notes' }))).id;
    formViewId = (await body(await as().post(`/boards/${boardId}/views`, { type: 'form', name: 'Contact' }))).id;
    formToken = (await body(await as().get(`/views/${formViewId}/form`))).token;
    apiToken = (await body(await as().post('/auth/tokens', { name: 'Make', scopes: ['boards:read'] }))).token;
    const res = await as().post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'item_created' },
        actions: [
          { type: 'send_email', to: ['x@example.com'], subject: 'New', body_html: '{item.name}' },
          { type: 'set_item_name', name: 'M: {item.name}' },
        ],
      },
    });
    expect(res.status).toBe(201);
    mailAutomationId = (await body(res)).id;
    for (const id of [dashboardId, docId, formViewId, formToken, apiToken, mailAutomationId]) expect(id).toBeTruthy();
    await assign(acmeId, basicV);
  });

  it('/me/accounts exposes the listed features; "My plan" lists included and not included', async () => {
    const me = await myAccount(admin, acmeId);
    expect(me.plan_features).toEqual(['guests']);
    const auth = await body(await as().get('/auth/me'));
    expect(auth.account.plan_features).toEqual(['guests']);
    const plan = await body(await as().get('/plan'));
    expect(plan.entitlements).toMatchObject({ all_features: false, features: ['guests'] });
    const access = new Map((plan.feature_access as Json[]).map((f) => [f.key, f]));
    for (const k of PLAN_FEATURE_KEYS) expect(access.get(k)).toMatchObject({ gated: true, included: k === 'guests' });
  });

  it('ai: the assistant, agents, AI columns (new and runs), the model call', async () => {
    await expectFeature(await as().post('/ai/assistant/conversations', {}), 'ai');
    await expectFeature(await as().post('/agents', {}), 'ai');
    await expectFeature(await as().post(`/boards/${boardId}/columns`, { type: 'ai', title: 'Summary' }), 'ai');
    await expectFeature(await as().post(`/boards/${boardId}/ai-columns/x/run`, {}), 'ai');
    expect((await as().patch('/ai/settings', { enabled: true })).status).toBe(200);
    await expect(
      completeWith(t.deps, acmeId, newId(), 'assistant', { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'plan_feature_unavailable', details: { feature: 'ai', upgrade: true } });
    // Other column types are not gated.
    expect((await as().post(`/boards/${boardId}/columns`, { type: 'text', title: 'Notes' })).status).toBe(201);
  });

  it('automations_advanced: saving one is refused; an existing one skips that action and runs the rest', async () => {
    await expectFeature(
      await as().post(`/boards/${boardId}/automations`, {
        recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'webhook', url: 'https://h.example.com/x' }] },
      }),
      'automations_advanced',
    );
    // A plain automation still saves.
    const plain = await as().post(`/boards/${boardId}/automations`, {
      recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'set_item_name', name: '{item.name}' }] },
    });
    expect(plain.status).toBe(201);
    await t.db
      .update(automations)
      .set({ isActive: false })
      .where(eq(automations.id, (await body(plain)).id));
    await drain(acmeId);
    await as().post(`/boards/${boardId}/items`, { name: 'Dana' });
    await drain(acmeId);
    const runs = await t.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, mailAutomationId))
      .orderBy(asc(automationRuns.createdAt));
    const log = runs.at(-1)!.actionsLog as Json[];
    expect(log[0]).toMatchObject({ type: 'send_email', status: 'skipped', reason: 'plan_feature_unavailable' });
    expect(log[1]).toMatchObject({ type: 'set_item_name', status: 'ok' });
    const auto = (await t.db.select().from(automations).where(eq(automations.id, mailAutomationId)))[0]!;
    expect(auto.isActive).toBe(true);
  });

  it('api: new tokens refused, an existing token stops (kept), the MCP server answers 402', async () => {
    await expectFeature(await as().post('/auth/tokens', { name: 'X', scopes: ['boards:read'] }), 'api');
    await expectFeature(await as().post('/auth/service-tokens', { name: 'X', scopes: ['boards:read'] }), 'api');
    await expectFeature(
      await t.app.request('/api/v1/workspaces', { headers: { authorization: `Bearer ${apiToken}` } }),
      'api',
    );
    const listed = await body(await as().get('/auth/tokens'));
    expect((listed.data as Json[]).some((x) => x.name === 'Make')).toBe(true);
    const mcp = await t.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    await expectFeature(mcp, 'api');
    // An AI app's consent: the account shows as not allowed (why), approving it is refused.
    const reg = await t.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
    });
    const clientId = (await body(reg)).client_id as string;
    const verifier = randomBytes(32).toString('base64url');
    const auth = await t.app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        state: 's',
        resource: `${WEB_ORIGIN}/mcp`,
        scope: 'boards:read',
      }).toString()}`,
    );
    expect(auth.status).toBe(302);
    const requestId = new URL(auth.headers.get('location')!).searchParams.get('request')!;
    const req = await body(await t.api(admin).get(`/oauth-requests/${requestId}`));
    expect((req.accounts as Json[]).find((a) => a.id === acmeId)).toMatchObject({
      allowed: false,
      reason: 'plan_feature_unavailable',
    });
    await expectFeature(
      await t.api(admin).post(`/oauth-requests/${requestId}/approve`, { account_id: acmeId, groups: [] }),
      'api',
    );
  });

  it('extensions and flows', async () => {
    await expectFeature(await as().post('/extensions/install', {}), 'extensions');
    await expectFeature(await as().post('/extensions/preview', {}), 'extensions');
    await expectFeature(await as().post('/flow-connections', {}), 'flows');
    expect((await as().get('/extensions')).status).toBe(200);
  });

  it('dashboards: an existing one stays readable; creating and editing are refused', async () => {
    await expectFeature(await as().post(`/workspaces/${wsId}/dashboards`, { name: 'New' }), 'dashboards');
    const read = await as().get(`/dashboards/${dashboardId}`);
    expect(read.status).toBe(200);
    expect((await body(read)).name).toBe('Sales');
    await expectFeature(await as().patch(`/dashboards/${dashboardId}`, { name: 'Renamed' }), 'dashboards');
    await expectFeature(await as().post(`/dashboards/${dashboardId}/widgets`, {}), 'dashboards');
  });

  it('docs: an existing one stays readable; creating and editing are refused', async () => {
    await expectFeature(await as().post(`/workspaces/${wsId}/docs`, { name: 'New' }), 'docs');
    const read = await as().get(`/docs/${docId}`);
    expect(read.status).toBe(200);
    expect((await body(read)).name).toBe('Notes');
    expect((await as().get(`/docs/${docId}/content`)).status).toBe(200);
    await expectFeature(await as().patch(`/docs/${docId}`, { name: 'Renamed' }), 'docs');
    // The editor's token still opens it (read-only — collab.ts).
    expect((await as().post(`/docs/${docId}/collab-token`)).status).toBe(200);
  });

  it('forms: the existing form opens; new form views, edits and public answers are refused', async () => {
    await expectFeature(await as().post(`/boards/${boardId}/views`, { type: 'form', name: 'New' }), 'forms');
    expect((await as().post(`/boards/${boardId}/views`, { type: 'table', name: 'Table' })).status).toBe(201);
    const form = await as().get(`/views/${formViewId}/form`);
    expect(form.status).toBe(200);
    expect((await body(form)).title).toBe('Contact');
    await expectFeature(await as().patch(`/views/${formViewId}/form`, { title: 'X' }), 'forms');
    await expectFeature(await as().post(`/views/${formViewId}/form/token`), 'forms');
    await expectFeature(await t.app.request(`/api/v1/public/forms/${formToken}`), 'forms');
  });

  it('guests: listed in the plan — inviting one works (the gate is per feature)', async () => {
    expect((await as().post('/users/invite', { emails: ['guest@acme.test'], role: 'guest' })).status).toBe(200);
  });

  it('guests: off the plan, inviting one is refused; members still invite', async () => {
    const noGuests = await body(
      await t.api(owner).post('/platform/plans', { name: 'Docs only', version: { features: ['docs'] } }),
    );
    await assign(acmeId, noGuests.versions[0].id);
    await expectFeature(await as().post('/users/invite', { emails: ['g2@acme.test'], role: 'guest' }), 'guests');
    expect((await as().post('/users/invite', { emails: ['m2@acme.test'], role: 'member' })).status).toBe(200);
    // Docs are in this plan again: editing the old doc works.
    expect((await as().patch(`/docs/${docId}`, { name: 'Renamed' })).status).toBe(200);
  });

  it('an upgrade back to the open plan restores everything — nothing was deleted', async () => {
    await assign(acmeId, openV);
    expect((await myAccount(admin, acmeId)).plan_features).toBeNull();
    expect((await as().patch(`/dashboards/${dashboardId}`, { name: 'Sales 2' })).status).toBe(200);
    expect(
      (await t.app.request('/api/v1/workspaces', { headers: { authorization: `Bearer ${apiToken}` } })).status,
    ).toBe(200);
    expect((await as().get(`/views/${formViewId}/form`)).status).toBe(200);
  });
});

describe('(a) the monthly period and (b) seats', () => {
  it('the usage period is a billing setting: calendar by default, nothing else accepted yet', async () => {
    const s = await body(await t.api(owner).get('/platform/billing-settings'));
    expect(s.usage_period).toBe('calendar');
    expect((await t.api(owner).patch('/platform/billing-settings', { usage_period: 'calendar' })).status).toBe(200);
    expect(
      (await t.api(owner).patch('/platform/billing-settings', { usage_period: 'subscription_period' })).status,
    ).toBe(400);
  });

  it('guests and service identities take no seat', async () => {
    const seats = async () =>
      ((await body(await t.api(owner).get(`/platform/accounts/${openId}/subscription`))).usage as Json[]).find(
        (u) => u.kind === 'seats',
      )!.used as number;
    const before = await seats();
    const api = t.api(openAdmin, openId);
    expect((await api.post('/auth/service-tokens', { name: 'Bot', scopes: ['boards:read'] })).status).toBe(201);
    expect((await api.post('/users/invite', { emails: ['g3@open.test'], role: 'guest' })).status).toBe(200);
    expect(await seats()).toBe(before);
    expect((await api.post('/users/invite', { emails: ['m3@open.test'], role: 'member' })).status).toBe(200);
    expect(await seats()).toBe(before + 1);
  });
});
