// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { compareSemver } from '@bines/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountMembers,
  activityLog,
  auditLog,
  extensionInstallations,
  extensionServerTokens,
  notifications,
  users,
} from '../src/db/schema';
import { dailyUpdateCheck } from '../src/modules/extensions/updates';
import { extensionCronItems } from '../src/modules/extensions/jobs';
import { parseCronItems } from 'graphile-worker';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/**
 * Extensions ת6–ת7 (D27, the planning notes "MARKETPLACE" §4.3–§4.6, §8): an extension's own server — its service user,
 * OAuth client credentials at /oauth/token, signed lifecycle webhooks — the daily update check (auto-apply vs
 * awaiting approval), lock and rollback, and the platform catalog (publish with the §8 review, install elsewhere,
 * unpublish) with the kill switch.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
let boardId: string;
let board2Id: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

// ---- the extension's own server: its manifest and its lifecycle endpoint ----
let server: Server;
let ORIGIN = '';
let served: Json = {};
let lifecycleStatus = 200;
const calls: { headers: IncomingHttpHeaders; raw: string; body: Json }[] = [];

const manifest = (over: Json = {}): Json => ({
  manifest_version: 1,
  id: 'crm-sync',
  name: 'סנכרון CRM',
  version: '1.0.0',
  publisher: { name: 'Bines Labs', email: 'dev@bines.test' },
  permissions: ['boards:read', 'items:write'],
  origins: [ORIGIN],
  server: { lifecycle_url: `${ORIGIN}/lifecycle` },
  ...over,
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const sign = (secret: string, ts: string, raw: string) =>
  `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;

/** The client_credentials exchange, as an extension's server does it (HTTP Basic). */
const tokenFor = (clientId: string, secret: string, extra: Record<string, string> = {}) =>
  t.app.request('/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...extra }).toString(),
  });

const asServer = (token: string, method: string, path: string, payload?: unknown) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

const lastCall = (event: string) => [...calls].reverse().find((c) => c.body.event === event);

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/manifest.json') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(served));
      }
      if (req.url === '/lifecycle' && req.method === 'POST') {
        const raw = Buffer.concat(chunks).toString('utf8');
        calls.push({ headers: req.headers, raw, body: JSON.parse(raw) as Json });
        res.statusCode = lifecycleStatus;
        return res.end('{}');
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
  await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Lead A' });
  await t.api(admin, acmeId).post(`/boards/${board2Id}/items`, { name: 'Deal B' });
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  lifecycleStatus = 200;
});

describe('semver and the manifest `server` section', () => {
  it('compares versions numerically; a server must be on a listed origin; adding one needs consent', async () => {
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1);
    expect(compareSemver('2.0.0-beta', '2.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    const bad = await t.api(admin, acmeId).post('/extensions/preview', {
      manifest: manifest({ server: { lifecycle_url: 'https://elsewhere.example.com/hook' } }),
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await body(bad))).toContain('server_origin_not_listed');
    const ok = await body(await t.api(admin, acmeId).post('/extensions/preview', { manifest: manifest() }));
    expect(ok.kind).toBe('code');
    expect(ok.warnings).toContain('runs_code');
  });
});

describe('ת6 — the extension server: service user, OAuth client credentials, signed lifecycle', () => {
  let instId: string;
  let creds: Json;

  it('install → a service user + credentials delivered in a signed `installed` call', async () => {
    served = manifest();
    const res = await t.api(admin, acmeId).post('/extensions/install', {
      source: { manifest_url: `${ORIGIN}/manifest.json` },
      consent: { accept: true, scopes: ['boards:read', 'items:write'], board_ids: [boardId] },
    });
    expect(res.status).toBe(201);
    const inst = await body(res);
    instId = inst.id;
    expect(inst.server).toMatchObject({ status: 'connected', last_event: 'installed' });
    expect(inst.server.client_id).toMatch(/^bos_extc_/);
    const call = lastCall('installed')!;
    expect(call.headers['x-bines-event']).toBe('extension.installed');
    creds = call.body.credentials;
    expect(creds).toMatchObject({
      client_id: inst.server.client_id,
      token_endpoint: expect.stringMatching(/\/oauth\/token$/),
      api_base: expect.stringMatching(/\/api\/v1$/),
    });
    // Signed with the signing secret it carries (HMAC-SHA256 over "<timestamp>.<body>").
    const ts = String(call.headers['x-bines-timestamp']);
    expect(call.headers['x-bines-signature']).toBe(sign(creds.signing_secret, ts, call.raw));
    expect(call.body.installation).toMatchObject({ id: instId, key: 'crm-sync', board_ids: [boardId] });
    // Only hashes / sealed values at rest.
    const row = (await t.db.select().from(extensionInstallations).where(eq(extensionInstallations.id, instId)))[0]!;
    expect(JSON.stringify(row)).not.toContain(creds.client_secret);
    expect(JSON.stringify(row)).not.toContain(creds.signing_secret);
    // ONE signing secret per installation: the one delivered is the one admins see (and ת4 calls are signed with).
    const shown = await body(await t.api(admin, acmeId).get(`/extensions/installations/${instId}/secret`));
    expect(shown.secret).toBe(creds.signing_secret);
    // The service user: is_service, a member of the account — not a person in the people list.
    const svcUser = (await t.db.select().from(users).where(eq(users.id, row.serviceUserId!)))[0]!;
    expect(svcUser.isService).toBe(true);
    expect(svcUser.name).toBe(he('server.extensionUser', { name: 'סנכרון CRM' }));
    const people = await body(await t.api(admin, acmeId).get('/users'));
    expect(JSON.stringify(people)).not.toContain(row.serviceUserId);
    // The first version is on record.
    const versions = await body(await t.api(admin, acmeId).get(`/extensions/installations/${instId}/versions`));
    expect(versions.data).toMatchObject([{ version: '1.0.0', via: 'installed', current: true }]);
  });

  it('client_credentials: a token for the API; wrong secret / wider scope / another resource refused', async () => {
    expect((await tokenFor(creds.client_id, 'bos_exts_wrong')).status).toBe(401);
    const wider = await tokenFor(creds.client_id, creds.client_secret, { scope: 'boards:read users:write' });
    expect(wider.status).toBe(400);
    expect((await body(wider)).error).toBe('invalid_scope');
    const target = await tokenFor(creds.client_id, creds.client_secret, { resource: 'https://evil.test/api/v1' });
    expect((await body(target)).error).toBe('invalid_target');
    // A client_credentials grant for anything but an extension client is unsupported.
    expect(
      (
        await body(
          await t.app.request('/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials&client_id=bos_cli_x&client_secret=y',
          }),
        )
      ).error,
    ).toBe('unsupported_grant_type');
    const res = await tokenFor(creds.client_id, creds.client_secret);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const tok = await body(res);
    expect(tok).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'boards:read items:write',
      installation_id: instId,
      account_id: acmeId,
    });
    expect(tok.access_token).toMatch(/^bos_xat_/);
    const stored = await t.db
      .select()
      .from(extensionServerTokens)
      .where(eq(extensionServerTokens.installationId, instId));
    expect(JSON.stringify(stored)).not.toContain(tok.access_token);
    creds.token = tok.access_token;
  });

  it('the server token acts as the service user × granted scopes × granted boards × the allowlist', async () => {
    const items = await asServer(creds.token, 'GET', `/boards/${boardId}/items`);
    expect(items.status).toBe(200);
    expect(JSON.stringify(await body(items))).toContain('Lead A');
    // Another board of the account: not granted → it does not exist for the extension.
    expect((await asServer(creds.token, 'GET', `/boards/${board2Id}/items`)).status).toBe(404);
    // Off the allowlist (tokens, extensions, admin, AI, agents, the owner console).
    for (const [m, p] of [
      ['GET', '/auth/tokens'],
      ['GET', '/extensions'],
      ['GET', '/agents'],
      ['GET', '/platform/accounts'],
      ['GET', '/mcp-servers'],
      ['GET', `/boards/${boardId}/permissions`],
    ] as const)
      expect((await asServer(creds.token, m, p)).status, p).toBe(403);
    // A write within scope: stamped "via app" (server) with the request's batch.
    const created = await asServer(creds.token, 'POST', `/boards/${boardId}/items`, { name: 'From the server' });
    expect(created.status).toBe(201);
    const item = await body(created);
    const ev = (await t.db.select().from(activityLog).where(eq(activityLog.itemId, item.id)))[0]!;
    expect((ev.payload as Json).meta).toMatchObject({
      via: 'app',
      app: { key: 'crm-sync', installation_id: instId, server: true },
    });
    expect(ev.batchId).toBeTruthy();
    // A narrower grant applies to tokens already issued.
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { scopes: ['boards:read'] });
    const denied = await asServer(creds.token, 'POST', `/boards/${boardId}/items`, { name: 'again' });
    expect((await body(denied)).error.code).toBe('insufficient_scope');
    // …and the server heard `updated`, signed with its signing secret.
    const upd = lastCall('updated')!;
    expect(upd.headers['x-bines-signature']).toBe(
      sign(creds.signing_secret, String(upd.headers['x-bines-timestamp']), upd.raw),
    );
    expect(upd.body.installation.scopes).toEqual(['boards:read']);
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { scopes: ['boards:read', 'items:write'] });
  });

  it('disable → `disabled` (signed) and the token stops; enable → `enabled` and it works again', async () => {
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { status: 'disabled' });
    const off = lastCall('disabled')!;
    expect(off.headers['x-bines-signature']).toBe(
      sign(creds.signing_secret, String(off.headers['x-bines-timestamp']), off.raw),
    );
    expect((await asServer(creds.token, 'GET', `/boards/${boardId}/items`)).status).toBe(401);
    expect((await tokenFor(creds.client_id, creds.client_secret)).status).toBe(400); // unauthorized_client
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { status: 'enabled' });
    expect(lastCall('enabled')).toBeDefined();
    expect((await asServer(creds.token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
  });

  it('a failed lifecycle call is shown and audited; "reconnect" rotates the credentials', async () => {
    lifecycleStatus = 500;
    const failed = await body(await t.api(admin, acmeId).post(`/extensions/installations/${instId}/server/reconnect`));
    expect(failed.server).toMatchObject({ status: 'failed', last_error: 'http_500' });
    expect(
      (await t.db.select().from(auditLog).where(eq(auditLog.action, 'extension.lifecycle_failed'))).length,
    ).toBeGreaterThan(0);
    lifecycleStatus = 200;
    const ok = await body(await t.api(admin, acmeId).post(`/extensions/installations/${instId}/server/reconnect`));
    expect(ok.server.status).toBe('connected');
    const fresh = lastCall('installed')!.body.credentials;
    expect(fresh.client_secret).not.toBe(creds.client_secret);
    // The old secret and the old tokens stop; the new ones work.
    expect((await tokenFor(creds.client_id, creds.client_secret)).status).toBe(401);
    expect((await asServer(creds.token, 'GET', `/boards/${boardId}/items`)).status).toBe(401);
    const tok = await body(await tokenFor(fresh.client_id, fresh.client_secret));
    expect((await asServer(tok.access_token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
    creds = { ...fresh, token: tok.access_token };
    // Members cannot reconnect (or see any of it).
    expect((await t.api(bob, acmeId).post(`/extensions/installations/${instId}/server/reconnect`)).status).toBe(403);
  });

  it('rotating the signing secret of a server extension delivers it in a new `installed` call', async () => {
    const before = calls.length;
    const rotated = await body(
      await t.api(admin, acmeId).post(`/extensions/installations/${instId}/secret/rotate`, {}),
    );
    expect(rotated.secret).not.toBe(creds.signing_secret);
    expect(calls.length).toBeGreaterThan(before);
    const call = lastCall('installed')!;
    const fresh = call.body.credentials;
    expect(fresh.signing_secret).toBe(rotated.secret);
    expect(call.headers['x-bines-signature']).toBe(
      sign(rotated.secret, String(call.headers['x-bines-timestamp']), call.raw),
    );
    const tok = await body(await tokenFor(fresh.client_id, fresh.client_secret));
    creds = { ...fresh, token: tok.access_token };
  });

  it('the kill switch stops the server token and tells the server (reason platform_kill)', async () => {
    expect((await t.api(owner).post('/platform/extensions/kill', { key: 'crm-sync', reason: 'audit' })).status).toBe(
      200,
    );
    expect(lastCall('disabled')!.body.reason).toBe('platform_kill');
    expect((await asServer(creds.token, 'GET', `/boards/${boardId}/items`)).status).toBe(401);
    expect((await t.api(owner).del('/platform/extensions/kill/crm-sync')).status).toBe(200);
    expect(lastCall('enabled')!.body.reason).toBe('platform_kill');
    expect((await asServer(creds.token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
  });

  it('another account cannot reach the installation, its versions or its server', async () => {
    expect((await t.api(otherAdmin, otherId).get(`/extensions/installations/${instId}/versions`)).status).toBe(404);
    expect((await t.api(otherAdmin, otherId).post(`/extensions/installations/${instId}/server/reconnect`)).status).toBe(
      404,
    );
    // The token is bound to its account: naming another one is a 404.
    const res = await t.app.request(`/api/v1/boards/${boardId}/items`, {
      headers: { authorization: `Bearer ${creds.token}`, 'x-account-id': otherId },
    });
    expect(res.status).toBe(404);
  });
});

describe('ת6 — versions: the daily check, consent, lock, rollback', () => {
  const instIdOf = async () =>
    (await body(await t.api(admin, acmeId).get('/extensions'))).installed.find((i: Json) => i.key === 'crm-sync');

  it('the daily job applies a version that asks for nothing new (and tells the server)', async () => {
    expect(() => parseCronItems(extensionCronItems)).not.toThrow();
    served = manifest({ version: '1.0.1' });
    const out = await dailyUpdateCheck(t.deps);
    expect(out.updated).toBeGreaterThanOrEqual(1);
    const inst = await instIdOf();
    expect(inst).toMatchObject({ version: '1.0.1', pending_update: null, check_error: null });
    expect(inst.last_checked_at).toBeTruthy();
    expect(lastCall('updated')!.body.installation).toMatchObject({ version: '1.0.1', previous_version: '1.0.0' });
    const versions = await body(await t.api(admin, acmeId).get(`/extensions/installations/${inst.id}/versions`));
    expect(versions.data[0]).toMatchObject({ version: '1.0.1', via: 'auto', current: true, applied_by_name: null });
  });

  it('a new scope waits for an admin (bell, once) and the current version keeps running', async () => {
    served = manifest({ version: '1.1.0', permissions: ['boards:read', 'items:write', 'updates:write'] });
    await dailyUpdateCheck(t.deps);
    await dailyUpdateCheck(t.deps); // the next day: still waiting, no second bell
    const inst = await instIdOf();
    expect(inst).toMatchObject({
      version: '1.0.1',
      pending_update: { version: '1.1.0', added_scopes: ['updates:write'] },
    });
    const bells = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.accountId, acmeId), eq(notifications.type, 'extension_update')));
    expect(bells.length).toBe(1); // one admin, one bell
    expect((bells[0]!.payload as Json).excerpt).toContain('1.1.0');
    // Approve with consent → applied, recorded as approved.
    const approved = await body(
      await t.api(admin, acmeId).post(`/extensions/installations/${inst.id}/approve-update`, {
        consent: { accept: true, scopes: ['boards:read', 'items:write', 'updates:write'], board_ids: [boardId] },
      }),
    );
    expect(approved).toMatchObject({ version: '1.1.0', pending_update: null });
    const versions = await body(await t.api(admin, acmeId).get(`/extensions/installations/${inst.id}/versions`));
    expect(versions.data[0]).toMatchObject({ version: '1.1.0', via: 'approved' });
  });

  it('automatic updates off: even a plain patch waits; a locked installation only reports it', async () => {
    let inst = await instIdOf();
    await t.api(admin, acmeId).patch(`/extensions/installations/${inst.id}/versioning`, { auto_update: false });
    served = manifest({ version: '1.1.1', permissions: ['boards:read', 'items:write', 'updates:write'] });
    expect(
      (await body(await t.api(admin, acmeId).post(`/extensions/installations/${inst.id}/check-update`))).status,
    ).toBe('pending');
    await t.api(admin, acmeId).patch(`/extensions/installations/${inst.id}/versioning`, {
      auto_update: true,
      version_locked: true,
    });
    served = manifest({ version: '1.1.2', permissions: ['boards:read', 'items:write', 'updates:write'] });
    const locked = await body(await t.api(admin, acmeId).post(`/extensions/installations/${inst.id}/check-update`));
    expect(locked.status).toBe('locked');
    expect(locked.installation).toMatchObject({ version: '1.1.0', version_locked: true });
    expect(locked.installation.pending_update.version).toBe('1.1.2');
    // Unlocked: the next check applies it (nothing new asked).
    await t.api(admin, acmeId).patch(`/extensions/installations/${inst.id}/versioning`, { version_locked: false });
    await dailyUpdateCheck(t.deps);
    inst = await instIdOf();
    expect(inst).toMatchObject({ version: '1.1.2', pending_update: null });
    // Members: no versioning.
    expect(
      (await t.api(bob, acmeId).patch(`/extensions/installations/${inst.id}/versioning`, { version_locked: true }))
        .status,
    ).toBe(403);
  });

  it('rollback: back to an approved version, locked there; the daily check does not move it', async () => {
    const inst = await instIdOf();
    const versions = (await body(await t.api(admin, acmeId).get(`/extensions/installations/${inst.id}/versions`))).data;
    const v110 = versions.find((v: Json) => v.version === '1.1.0');
    const res = await body(
      await t.api(admin, acmeId).post(`/extensions/installations/${inst.id}/rollback`, { version_id: v110.id }),
    );
    expect(res).toMatchObject({ status: 'updated', installation: { version: '1.1.0', version_locked: true } });
    await dailyUpdateCheck(t.deps);
    expect((await instIdOf()).version).toBe('1.1.0');
    // Another installation's version id is not found.
    expect(
      (
        await t.api(admin, acmeId).post(`/extensions/installations/${inst.id}/rollback`, {
          version_id: '01J00000000000000000000000',
        })
      ).status,
    ).toBe(404);
    await t.api(admin, acmeId).patch(`/extensions/installations/${inst.id}/versioning`, { version_locked: false });
  });

  it('a broken manifest: the job records it on the installation and carries on', async () => {
    served = { not: 'a manifest' };
    const out = await dailyUpdateCheck(t.deps);
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect((await instIdOf()).check_error).toBe('manifest_invalid');
  });

  it('uninstall → `uninstalled` (signed), every token and the service user’s membership end', async () => {
    served = manifest({ version: '1.1.2', permissions: ['boards:read', 'items:write', 'updates:write'] });
    const inst = await instIdOf();
    const row = (await t.db.select().from(extensionInstallations).where(eq(extensionInstallations.id, inst.id)))[0]!;
    const fresh = lastCall('installed')!.body.credentials;
    const tok = await body(await tokenFor(fresh.client_id, fresh.client_secret));
    expect((await t.api(admin, acmeId).del(`/extensions/installations/${inst.id}`)).status).toBe(200);
    const gone = lastCall('uninstalled')!;
    expect(gone.headers['x-bines-signature']).toBe(
      sign(fresh.signing_secret, String(gone.headers['x-bines-timestamp']), gone.raw),
    );
    expect(gone.body.installation.status).toBe('uninstalled');
    expect((await asServer(tok.access_token, 'GET', `/boards/${boardId}/items`)).status).toBe(401);
    expect((await tokenFor(fresh.client_id, fresh.client_secret)).status).toBe(401);
    const m = (
      await t.db
        .select()
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, acmeId), eq(accountMembers.userId, row.serviceUserId!)))
    )[0]!;
    expect(m.status).toBe('deactivated');
  });
});

describe('ת7 — the platform catalog: publish with the §8 review, install elsewhere, unpublish', () => {
  const pub = (m: Json, checks: Json, cookie = owner) =>
    t.api(cookie).post('/platform/extensions/catalog', {
      source: { manifest: m },
      review: { checks, notes: 'Reviewed the code and the hosting.' },
    });
  const allChecks = {
    https_only: true,
    least_scopes: true,
    no_token_storage: true,
    verifies_signatures: true,
    no_eval: true,
    privacy_policy: true,
    platform_limits: true,
  };
  const catalogManifest = () =>
    manifest({
      id: 'quote-sender',
      name: 'שליחת הצעות',
      permissions: ['boards:read'],
      server: { lifecycle_url: `${ORIGIN}/lifecycle` },
    });

  it('only the platform owner; a code extension needs every check of the review', async () => {
    expect((await pub(catalogManifest(), allChecks, admin)).status).toBe(404);
    const preview = await body(
      await t.api(owner).post('/platform/extensions/catalog/preview', { manifest: catalogManifest() }),
    );
    expect(preview).toMatchObject({ kind: 'code', review_required: true, existing: null });
    expect(preview.warnings).toEqual(expect.arrayContaining(['runs_code', 'has_server', 'local_origin']));
    const partial = await pub(catalogManifest(), { ...allChecks, verifies_signatures: false });
    expect(partial.status).toBe(422);
    expect((await body(partial)).error.details.missing).toEqual(['verifies_signatures']);
    expect((await pub(catalogManifest(), allChecks)).status).toBe(200);
    const list = await body(await t.api(owner).get('/platform/extensions'));
    const entry = list.data.find((e: Json) => e.key === 'quote-sender');
    expect(entry).toMatchObject({ catalog: true, kind: 'code', installs: 0 });
    expect(entry.entry).toMatchObject({ version: '1.0.0', review: { checks: allChecks, notes: expect.any(String) } });
    expect(entry.entry.review.reviewed_by_name).toBeTruthy();
  });

  it('another account installs it from the catalog, with consent; its server gets credentials', async () => {
    const cat = (await body(await t.api(otherAdmin, otherId).get('/extensions'))).catalog;
    expect(cat.find((c: Json) => c.key === 'quote-sender')).toMatchObject({ installed: false, kind: 'code' });
    const res = await t.api(otherAdmin, otherId).post('/extensions/install', {
      source: { catalog_key: 'quote-sender' },
      consent: { accept: true, scopes: ['boards:read'] },
    });
    expect(res.status).toBe(201);
    const inst = await body(res);
    expect(inst).toMatchObject({ source: 'catalog', key: 'quote-sender' });
    expect(lastCall('installed')!.body.account.id).toBe(otherId);
    // Republished with more: the installation waits for consent (update check against the catalog).
    expect(
      (await pub({ ...catalogManifest(), version: '1.1.0', permissions: ['boards:read', 'items:write'] }, allChecks))
        .status,
    ).toBe(200);
    const check = await body(
      await t.api(otherAdmin, otherId).post(`/extensions/installations/${inst.id}/check-update`),
    );
    expect(check.status).toBe('pending');
    expect(check.installation.pending_update.added_scopes).toEqual(['items:write']);
    // The account's audit log shows the owner's publishing.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, otherId), eq(auditLog.action, 'extension.catalog_published')));
    expect(audits.length).toBe(1);
  });

  it('a data pack needs no review; unpublishing hides it — installed copies keep running', async () => {
    const pack = {
      manifest_version: 1,
      id: 'mini-pack',
      name: 'חבילה קטנה',
      version: '1.0.0',
      publisher: { name: 'Bines' },
      data: { board_templates: [] },
    };
    expect((await pub(pack, {})).status).toBe(200);
    expect((await t.api(owner).del('/platform/extensions/catalog/quote-sender')).status).toBe(200);
    const cat = (await body(await t.api(admin, acmeId).get('/extensions'))).catalog.map((c: Json) => c.key);
    expect(cat).toContain('mini-pack');
    expect(cat).not.toContain('quote-sender');
    const other = (await body(await t.api(otherAdmin, otherId).get('/extensions'))).installed;
    expect(other.find((i: Json) => i.key === 'quote-sender')).toMatchObject({ status: 'enabled', version: '1.0.0' });
    expect((await t.api(owner).del('/platform/extensions/catalog/quote-sender')).status).toBe(404);
  });
});
