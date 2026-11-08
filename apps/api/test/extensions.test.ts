// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, isNull } from 'drizzle-orm';
import { EXT_TOKEN_PREFIX } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activityLog,
  auditLog,
  automations,
  boards,
  extensionInstallations,
  folders,
  templates,
  workspaces,
} from '../src/db/schema';
import { signExtToken, verifyExtToken } from '../src/modules/extensions/ext-token';
import { forgetExtensionOrigins } from '../src/modules/extensions/ext-origins';
import { assertOriginsAllowed, parseManifest } from '../src/modules/extensions/manifest-source';
import { loadTemplatesFromDisk } from '../src/modules/boards/templates';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/**
 * Extensions — "תוספות" (D27, the planning notes "MARKETPLACE" ת0–ת2): install with consent, scopes, the short-lived
 * extension token (user × granted scopes × board × path allowlist), CSP frame-src per account, CORS for extension
 * origins, the kill switch, data-pack idempotency and the starter kit as a pack.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string; // member
let guest: string;
let acmeId: string;
let otherId: string;
let otherAdmin: string;
let boardId: string;
let board2Id: string;
let privateBoardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const EXT_ORIGIN = 'http://127.0.0.1:3998';
const manifest = (over: Json = {}): Json => ({
  manifest_version: 1,
  id: 'summary-cards',
  name: 'כרטיסי סיכום',
  version: '1.0.0',
  publisher: { name: 'Bines Labs', email: 'dev@bines.test' },
  permissions: ['boards:read'],
  origins: [EXT_ORIGIN],
  features: [{ type: 'board_view', key: 'summary', name: 'סיכום', url: `${EXT_ORIGIN}/index.html` }],
  ...over,
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** A request from the extension's iframe: its origin, the bearer token, no cookie. */
const asExt = (token: string, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      origin: EXT_ORIGIN,
      authorization: `Bearer ${token}`,
      'x-account-id': acmeId,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

const install = async (m: Json, consent: Json = {}, cookie = admin, account = acmeId) =>
  t.api(cookie, account).post('/extensions/install', {
    source: { manifest: m },
    consent: { accept: true, scopes: m.permissions ?? [], ...consent },
  });

const mintFor = async (installationId: string, board = boardId, cookie = bob) =>
  t
    .api(cookie, acmeId)
    .post(`/extensions/installations/${installationId}/token`, { feature: 'summary', board_id: board });

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  board2Id = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Deals', workspace_id: wsId }))).id;
  privateBoardId = (
    await body(await t.api(admin, acmeId).post('/boards', { name: 'Secret', workspace_id: wsId, kind: 'private' }))
  ).id;
  await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Lead A' });
  await t.api(admin, acmeId).post(`/boards/${board2Id}/items`, { name: 'Deal B' });
  // A guest of a shareable board.
  const shareId = (
    await body(await t.api(admin, acmeId).post('/boards', { name: 'Client', workspace_id: wsId, kind: 'shareable' }))
  ).id;
  await t.api(admin, acmeId).post('/users/invite', { emails: ['guest@client.test'], role: 'guest' });
  guest = await join('guest@client.test');
  const users = (await body(await t.api(admin, acmeId).get('/users'))).data as Json[];
  const guestId = users.find((u) => u.email === 'guest@client.test')!.user_id;
  await t.api(admin, acmeId).put(`/boards/${shareId}/members/${guestId}`, {});
});
afterAll(() => t.close());

describe('manifest checks that depend on where we run', () => {
  it('refuses our own origin; in production only public https origins', () => {
    const own = parseManifest.bind(null, { NODE_ENV: 'test', WEB_ORIGIN });
    expect(() => own(manifest({ origins: [WEB_ORIGIN], features: [], data: { board_templates: [] } }))).toThrow();
    const prod = { NODE_ENV: 'production' as const, WEB_ORIGIN: 'https://app.bines.test' };
    expect(() =>
      assertOriginsAllowed(prod, parseManifest({ NODE_ENV: 'test', WEB_ORIGIN }, manifest()) as never),
    ).toThrow();
    expect(() =>
      assertOriginsAllowed(
        prod,
        parseManifest(
          { NODE_ENV: 'test', WEB_ORIGIN },
          manifest({
            origins: ['https://ext.example.com'],
            features: [{ type: 'board_view', key: 'v', name: 'v', url: 'https://ext.example.com/v' }],
          }),
        ),
      ),
    ).not.toThrow();
  });
});

describe('install, consent and scopes (ת0)', () => {
  it('admins only; the preview lists permissions in plain lines and warns about code', async () => {
    expect((await t.api(bob, acmeId).post('/extensions/preview', { manifest: manifest() })).status).toBe(403);
    expect((await t.api(bob, acmeId).get('/extensions')).status).toBe(403);
    const p = await body(await t.api(admin, acmeId).post('/extensions/preview', { manifest: manifest() }));
    expect(p.kind).toBe('code');
    expect(p.scopes).toEqual([{ scope: 'boards:read', write: false }]);
    expect(p.frame_origins).toEqual([EXT_ORIGIN]);
    expect(p.warnings).toEqual(expect.arrayContaining(['runs_code', 'local_origin']));
  });

  it('an invalid manifest is a 422 with readable issues', async () => {
    const res = await t.api(admin, acmeId).post('/extensions/preview', {
      manifest: manifest({
        permissions: ['admin'],
        features: [{ type: 'board_view', key: 'x', name: 'x', url: 'https://evil.test/' }],
      }),
    });
    expect(res.status).toBe(422);
    const err = (await body(res)).error;
    expect(err.message).toBe('manifest_invalid');
    expect(err.details.issues.join('\n')).toMatch(/permissions/);
    const offOrigin = await t.api(admin, acmeId).post('/extensions/preview', {
      manifest: manifest({ features: [{ type: 'board_view', key: 'x', name: 'x', url: 'https://evil.test/' }] }),
    });
    expect((await body(offOrigin)).error.details.issues.join('\n')).toMatch(/feature_origin_not_listed/);
  });

  it('consent cannot grant a scope the manifest did not ask for, nor a board of another account', async () => {
    expect((await install(manifest(), { scopes: ['items:write'] })).status).toBe(422);
    const foreignWs = (await body(await t.api(otherAdmin, otherId).get('/workspaces'))).data[0].id;
    const foreign = (
      await body(await t.api(otherAdmin, otherId).post('/boards', { name: 'X', workspace_id: foreignWs }))
    ).id;
    expect((await install(manifest(), { board_ids: [foreign] })).status).toBe(422);
  });

  it('installs with consent (audited), once; a member cannot install', async () => {
    expect((await install(manifest(), {}, bob)).status).toBe(403);
    const res = await install(manifest(), { board_ids: [boardId, board2Id, privateBoardId] });
    expect(res.status).toBe(201);
    const inst = await body(res);
    expect(inst).toMatchObject({ key: 'summary-cards', status: 'enabled', granted_scopes: ['boards:read'] });
    expect((await install(manifest())).status).toBe(409);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'extension.installed'));
    expect(audits.some((a) => a.targetId === inst.id && a.accountId === acmeId)).toBe(true);
    // Another account knows nothing about it.
    expect(
      (await t.api(otherAdmin, otherId).patch(`/extensions/installations/${inst.id}`, { status: 'disabled' })).status,
    ).toBe(404);
    const views = await body(await t.api(bob, acmeId).get(`/extensions/board-views?board_id=${boardId}`));
    expect(views.data).toEqual([
      expect.objectContaining({ installation_id: inst.id, feature: 'summary', origin: EXT_ORIGIN }),
    ]);
  });
});

describe('extension tokens (ת2): user × granted scopes × board', () => {
  let instId: string;
  beforeAll(async () => {
    instId = (await body(await t.api(admin, acmeId).get('/extensions'))).installed.find(
      (i: Json) => i.key === 'summary-cards',
    ).id;
  });

  it('is minted for a board the user can read and the installation is allowed on, minutes long', async () => {
    const res = await mintFor(instId);
    expect(res.status).toBe(200);
    const tok = await body(res);
    expect(tok.token.startsWith(EXT_TOKEN_PREFIX)).toBe(true);
    expect(tok).toMatchObject({ board_id: boardId, origin: EXT_ORIGIN, scopes: ['boards:read'], api_base: '/api/v1' });
    const ttl = new Date(tok.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(5 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1000);
    // Bob cannot read the private board: no token for it.
    expect((await mintFor(instId, privateBoardId)).status).toBe(404);
    // An unknown feature, another account's header: nothing.
    expect(
      (
        await t
          .api(bob, acmeId)
          .post(`/extensions/installations/${instId}/token`, { feature: 'nope', board_id: boardId })
      ).status,
    ).toBe(404);
    expect(
      (
        await t
          .api(otherAdmin, otherId)
          .post(`/extensions/installations/${instId}/token`, { feature: 'summary', board_id: boardId })
      ).status,
    ).toBe(404);
  });

  it('reads the board it was minted for — and nothing else', async () => {
    const { token } = await body(await mintFor(instId));
    const items = await asExt(token, 'GET', `/boards/${boardId}/items`);
    expect(items.status).toBe(200);
    expect(JSON.stringify(await body(items))).toContain('Lead A');
    expect((await asExt(token, 'GET', `/boards/${board2Id}/items`)).status).toBe(404);
    expect((await asExt(token, 'GET', '/auth/me')).status).toBe(200);
  });

  it('a write outside its scopes is refused; so is anything off the allowlist', async () => {
    const { token } = await body(await mintFor(instId));
    const denied = await asExt(token, 'POST', `/boards/${boardId}/items`, { name: 'x' });
    expect(denied.status).toBe(403);
    expect((await body(denied)).error.code).toBe('insufficient_scope');
    for (const [m, p] of [
      ['GET', '/auth/tokens'],
      ['GET', '/extensions'],
      ['POST', `/extensions/installations/${instId}/token`],
      ['GET', '/platform/accounts'],
      ['GET', `/boards/${boardId}/permissions`],
      ['GET', '/agents'],
      ['GET', '/accounts/me'],
    ] as const)
      expect(
        (await asExt(token, m, p, m === 'POST' ? { feature: 'summary', board_id: boardId } : undefined)).status,
        p,
      ).toBe(403);
  });

  it('is bound to its origin, its signature and its expiry', async () => {
    const { token } = await body(await mintFor(instId));
    expect((await asExt(token, 'GET', '/auth/me', undefined, { origin: 'https://evil.test' })).status).toBe(401);
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect((await asExt(tampered, 'GET', '/auth/me')).status).toBe(401);
    const claims = verifyExtToken(t.deps.env, token)!;
    const expired = signExtToken(t.deps.env, { ...claims, e: Math.floor(Date.now() / 1000) - 1 });
    expect((await asExt(expired, 'GET', '/auth/me')).status).toBe(401);
    // A token for another board than its installation allows (forged with the right key) is still refused.
    const forged = signExtToken(t.deps.env, { ...claims, b: 'x'.repeat(26) });
    expect((await asExt(forged, 'GET', `/boards/${boardId}/items`)).status).toBe(404);
  });

  it('writes within scope are stamped "via app" with one batch per request, and undo works', async () => {
    const res = await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, {
      scopes: [],
    });
    expect(res.status).toBe(200);
    // Granted scopes can only grow up to the manifest: approve a version that asks for items:write first.
    const v2 = manifest({ version: '1.1.0', permissions: ['boards:read', 'items:write'] });
    const inst2 = await install({ ...v2, id: 'writer-ext' }, { board_ids: [boardId] });
    expect(inst2.status).toBe(201);
    const writerId = (await body(inst2)).id;
    const { token } = await body(
      await t
        .api(bob, acmeId)
        .post(`/extensions/installations/${writerId}/token`, { feature: 'summary', board_id: boardId }),
    );
    const created = await asExt(token, 'POST', `/boards/${boardId}/items`, { name: 'From the app' });
    expect(created.status).toBe(201);
    const item = await body(created);
    const ev = (await t.db.select().from(activityLog).where(eq(activityLog.itemId, item.id)))[0]!;
    expect((ev.payload as Json).meta).toMatchObject({
      via: 'app',
      app: { key: 'writer-ext', installation_id: writerId },
    });
    expect(ev.batchId).toBeTruthy();
    const undo = await t.api(bob, acmeId).post(`/activity/${ev.id}/undo`, {});
    expect(undo.status).toBe(200);
    // A narrower grant applies to tokens already minted.
    await t.api(admin, acmeId).patch(`/extensions/installations/${writerId}`, { scopes: ['boards:read'] });
    expect((await asExt(token, 'POST', `/boards/${boardId}/items`, { name: 'again' })).status).toBe(403);
    // Re-enable the first one's read scope for the next tests.
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { scopes: ['boards:read'] });
  });

  it('disabling or uninstalling stops its tokens at once', async () => {
    const { token } = await body(await mintFor(instId));
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { status: 'disabled' });
    expect((await asExt(token, 'GET', `/boards/${boardId}/items`)).status).toBe(401);
    expect((await mintFor(instId)).status).toBe(404);
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { status: 'enabled' });
    expect((await asExt(token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
  });

  it('guests get nothing unless the admin allowed guests', async () => {
    expect((await t.api(guest, acmeId).get('/extensions/board-views')).status).toBe(200);
    expect((await body(await t.api(guest, acmeId).get('/extensions/board-views'))).data).toEqual([]);
    expect((await mintFor(instId, boardId, guest)).status).toBe(404);
  });
});

describe('CSP frame-src per account and CORS for extension origins', () => {
  it('the account page lists its enabled extensions’ origins; another account’s page does not', async () => {
    forgetExtensionOrigins();
    const csp = async (path: string) => (await t.app.request(path)).headers.get('content-security-policy') ?? '';
    const frameSrc = (c: string) => c.split(';').find((d) => d.trim().startsWith('frame-src')) ?? '';
    expect(frameSrc(await csp('/a/acme/b/x'))).toContain(EXT_ORIGIN);
    expect(frameSrc(await csp('/a/other/b/x'))).not.toContain(EXT_ORIGIN);
    expect(frameSrc(await csp('/login'))).not.toContain(EXT_ORIGIN);
    expect(await csp('/api/v1/health')).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('preflight from an extension origin passes without credentials; a cookie alone is refused', async () => {
    const pre = await t.app.request('/api/v1/auth/me', {
      method: 'OPTIONS',
      headers: {
        origin: EXT_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(EXT_ORIGIN);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    const withCookie = await t.app.request('/api/v1/auth/me', { headers: { origin: EXT_ORIGIN, cookie: bob } });
    expect(withCookie.status).toBe(401);
    // An origin no extension uses gets no CORS grant from us.
    const stranger = await t.app.request('/api/v1/auth/me', {
      method: 'OPTIONS',
      headers: { origin: 'https://stranger.test', 'access-control-request-method': 'GET' },
    });
    expect(stranger.headers.get('access-control-allow-origin')).not.toBe('https://stranger.test');
  });
});

describe('emergency kill switch (platform owner)', () => {
  it('stops the extension in every account at once — tokens, minting, frames; and comes back', async () => {
    const instId = (await body(await t.api(admin, acmeId).get('/extensions'))).installed.find(
      (i: Json) => i.key === 'summary-cards',
    ).id;
    // The other extension served from the same origin goes first (else the origin stays framed for it).
    const writer = (await body(await t.api(admin, acmeId).get('/extensions'))).installed.find(
      (i: Json) => i.key === 'writer-ext',
    ).id;
    await t.api(admin, acmeId).del(`/extensions/installations/${writer}`);
    const { token } = await body(await mintFor(instId));
    expect(
      (await t.api(admin).post('/platform/extensions/kill', { key: 'summary-cards', reason: 'leak' })).status,
    ).toBe(404);
    expect(
      (await t.api(owner).post('/platform/extensions/kill', { key: 'summary-cards', reason: 'leak' })).status,
    ).toBe(200);
    expect((await asExt(token, 'GET', `/boards/${boardId}/items`)).status).toBe(401);
    expect((await mintFor(instId)).status).toBe(404);
    const csp = (await t.app.request('/a/acme/')).headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain(EXT_ORIGIN);
    const list = await body(await t.api(owner).get('/platform/extensions'));
    expect(list.data.find((e: Json) => e.key === 'summary-cards')).toMatchObject({
      killed: { reason: 'leak' },
      installs: 1,
    });
    expect((await t.db.select().from(auditLog).where(eq(auditLog.action, 'extension.killed'))).length).toBe(1);
    // Installing a killed extension is refused too.
    expect((await install({ ...manifest(), id: 'summary-cards' }, {}, otherAdmin, otherId)).status).toBe(403);
    expect((await t.api(owner).del('/platform/extensions/kill/summary-cards')).status).toBe(200);
    expect((await asExt(token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
  });
});

describe('data packs (ת1): install is idempotent', () => {
  const pack = {
    manifest_version: 1,
    id: 'crm-pack',
    name: 'ערכת CRM',
    version: '1.0.0',
    publisher: { name: 'Bines' },
    data: {
      board_templates: [
        {
          key: 'pack_leads',
          name: 'לידים (חבילה)',
          native: true,
          groups: [{ id: 'g1', title: 'חדשים', color: 'blue' }],
          columns: [{ id: 'status', title: 'סטטוס', type: 'status', settings: {} }],
        },
      ],
      starter_kit: {
        workspace_name: 'CRM',
        folders: ['01 · מכירות'],
        boards: [{ template: 'pack_leads', folder: '01 · מכירות' }],
      },
      automation_recipes: [
        {
          key: 'notify-new',
          board: 'pack_leads',
          title: 'כשנוצר פריט',
          recipe: {
            trigger: { type: 'item_created' },
            conditions: [],
            actions: [{ type: 'notify', to: '@board_owners', message: '{item.name}' }],
          },
        },
      ],
      agent_templates: [{ key: 'pack-agent', name: 'סוכן חבילה', role: 'r', instructions: 'i', tools: [] }],
    },
  };
  const counts = async () => ({
    ws: (
      await t.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.accountId, acmeId), eq(workspaces.name, 'CRM')))
    ).length,
    boards: (
      await t.db
        .select()
        .from(boards)
        .where(and(eq(boards.accountId, acmeId), eq(boards.name, 'לידים (חבילה)'), isNull(boards.deletedAt)))
    ).length,
    templates: (
      await t.db
        .select()
        .from(templates)
        .where(and(eq(templates.accountId, acmeId), eq(templates.key, 'pack_leads'), isNull(templates.deletedAt)))
    ).length,
    automations: (await t.db.select().from(automations).where(eq(automations.accountId, acmeId))).length,
  });

  it('loads templates, a kit, inactive recipes; uninstall + reinstall adds nothing twice', async () => {
    const before = await counts();
    const res = await install(pack);
    expect(res.status).toBe(201);
    const inst = await body(res);
    expect(inst.kind).toBe('data');
    expect(inst.data).toMatchObject({ board_templates: 1, automation_recipes: 1, agent_templates: 1 });
    const once = await counts();
    expect(once).toEqual({ ws: 1, boards: 1, templates: 1, automations: before.automations + 1 });
    const auto = (await t.db.select().from(automations).where(eq(automations.accountId, acmeId))).at(-1)!;
    expect(auto.isActive).toBe(false);
    // Uninstall: the template leaves the picker; the boards stay.
    expect((await t.api(admin, acmeId).del(`/extensions/installations/${inst.id}`)).status).toBe(200);
    expect((await counts()).templates).toBe(0);
    expect((await counts()).boards).toBe(1);
    // Reinstall: the same installation row, nothing duplicated, the template is back.
    const again = await body(await install(pack));
    expect(again.id).toBe(inst.id);
    expect(await counts()).toEqual(once);
    const rows = await t.db.select().from(extensionInstallations).where(eq(extensionInstallations.key, 'crm-pack'));
    expect(rows).toHaveLength(1);
  });

  it('"save as pack": boards + their automations → a manifest another account installs', async () => {
    const leads = (
      await t.db
        .select()
        .from(boards)
        .where(and(eq(boards.accountId, acmeId), eq(boards.name, 'לידים (חבילה)'), isNull(boards.deletedAt)))
    )[0]!;
    expect(
      (await t.api(bob, acmeId).post('/extensions/packs/export', { key: 'my-pack', name: 'x', board_ids: [leads.id] }))
        .status,
    ).toBe(403);
    const res = await t.api(admin, acmeId).post('/extensions/packs/export', {
      key: 'my-pack',
      name: 'החבילה שלי',
      board_ids: [leads.id],
    });
    expect(res.status).toBe(200);
    const m = await body(res);
    expect(m).toMatchObject({ id: 'my-pack', permissions: [], features: [] });
    expect(m.data.board_templates).toHaveLength(1);
    expect(m.data.automation_recipes).toHaveLength(1);
    const installed = await install(m, {}, otherAdmin, otherId);
    expect(installed.status).toBe(201);
    const made = await t.db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, otherId), eq(boards.name, 'לידים (חבילה)')));
    expect(made).toHaveLength(1);
    // A board of another account cannot be exported.
    expect(
      (
        await t
          .api(otherAdmin, otherId)
          .post('/extensions/packs/export', { key: 'x-pack', name: 'x', board_ids: [leads.id] })
      ).status,
    ).toBe(404);
  });

  it('a pack’s agent templates join the starter-agents picker', async () => {
    const list = await body(await t.api(admin, acmeId).get('/agents/templates'));
    expect(list.data.map((x: Json) => x.key)).toContain('pack-agent');
  });
});

describe('updates need consent again only when they ask for more (§4.5)', () => {
  let server: Server;
  let url: string;
  let served: Json;
  beforeAll(async () => {
    served = { ...manifest(), id: 'remote-ext' };
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(served));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manifest.json`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('by URL; a patch updates by itself; a new scope waits for the admin', async () => {
    const res = await t.api(admin, acmeId).post('/extensions/install', {
      source: { manifest_url: url },
      consent: { accept: true, scopes: ['boards:read'] },
    });
    expect(res.status).toBe(201);
    const id = (await body(res)).id;
    served = { ...served, version: '1.0.1' };
    const auto = await body(await t.api(admin, acmeId).post(`/extensions/installations/${id}/check-update`));
    expect(auto).toMatchObject({ status: 'updated', installation: { version: '1.0.1' } });
    served = { ...served, version: '2.0.0', permissions: ['boards:read', 'items:write'] };
    const pending = await body(await t.api(admin, acmeId).post(`/extensions/installations/${id}/check-update`));
    expect(pending.status).toBe('pending');
    expect(pending.installation).toMatchObject({
      version: '1.0.1',
      granted_scopes: ['boards:read'],
      pending_update: { version: '2.0.0', added_scopes: ['items:write'] },
    });
    const approved = await body(
      await t.api(admin, acmeId).post(`/extensions/installations/${id}/approve-update`, {
        consent: { accept: true, scopes: ['boards:read', 'items:write'] },
      }),
    );
    expect(approved).toMatchObject({
      version: '2.0.0',
      granted_scopes: ['boards:read', 'items:write'],
      pending_update: null,
    });
  });
});

describe('the starter kit is a data pack (ת1) — new accounts as before', () => {
  it('"bines" (and "default") = the account name, folders 01–07, a board per built-in template but the per-instance ones', async () => {
    const created = await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Kit',
        slug: 'kit-co',
        first_admin_email: 'a@kit.test',
        template_set: 'bines',
      }),
    );
    const id = created.account.id as string;
    const ws = await t.db.select().from(workspaces).where(eq(workspaces.accountId, id));
    expect(ws.map((w) => w.name)).toEqual(['Kit']);
    const fs = (await t.db.select().from(folders).where(eq(folders.accountId, id))).sort((a, b) =>
      a.position < b.position ? -1 : 1,
    );
    expect(fs.map((f) => f.name)).toEqual([
      '01 · מכירות',
      '02 · לקוחות ושירות',
      '03 · פרויקטים',
      '04 · כספים',
      '05 · ידע',
      '06 · תפעול ו-AI',
      '07 · פורטלים',
    ]);
    const expected = loadTemplatesFromDisk('../../seed/templates').filter(
      (x) => !['portal_client', 'project_multilevel'].includes(x.key),
    );
    const bs = await t.db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, id), isNull(boards.parentBoardId)));
    expect(bs.map((b) => b.name).sort()).toEqual(expected.map((x) => x.name).sort());
    for (const tpl of expected) {
      const b = bs.find((x) => x.name === tpl.name)!;
      const f = fs.find((x) => x.id === b.folderId);
      if (tpl.folder) expect(f?.name.startsWith(tpl.folder), tpl.key).toBe(true);
    }
    // The kit shows as the account's installed pack.
    const inst = await t.db.select().from(extensionInstallations).where(eq(extensionInstallations.accountId, id));
    expect(inst.map((i) => i.key)).toEqual(['bines']);

    const viaDefault = await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Kit2',
        slug: 'kit-two',
        first_admin_email: 'b@kit.test',
        template_set: 'default',
      }),
    );
    const bs2 = await t.db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, viaDefault.account.id), isNull(boards.parentBoardId)));
    expect(bs2).toHaveLength(bs.length);
  });

  it('"empty" = one workspace "ראשי" and no boards; an unknown kit is refused', async () => {
    const created = await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'E',
        slug: 'empty-co',
        first_admin_email: 'e@e.test',
        template_set: 'empty',
      }),
    );
    const ws = await t.db.select().from(workspaces).where(eq(workspaces.accountId, created.account.id));
    expect(ws.map((w) => w.name)).toEqual([he('server.mainWorkspace')]);
    expect((await t.db.select().from(boards).where(eq(boards.accountId, created.account.id))).length).toBe(0);
    const bad = await t.api(owner).post('/platform/accounts', {
      name: 'X',
      slug: 'nokit-co',
      first_admin_email: 'x@x.test',
      template_set: 'no-such-kit',
    });
    expect(bad.status).toBe(422);
    const kits = await body(await t.api(owner).get('/platform/starter-kits'));
    // Round 13: the catalogue's "CRM starter" pack is a kit too (not the default).
    expect(kits.data).toEqual([
      expect.objectContaining({ key: 'bines', default: true }),
      expect.objectContaining({ key: 'crm-starter', default: false }),
    ]);
  });
});
