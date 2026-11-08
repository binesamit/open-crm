// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extensionInstallations, webhooks } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod (calendar sync, phase ב1): the generic hooks an extension with its own server needs
 * a page in each member's profile (`user_settings_page`), `POST /ext/introspect` (its server learns who is on that
 * page), and webhooks its server sets up on its boards, only to its own origins and only its own.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let boardId: string;
let board2Id: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

let server: Server;
let ORIGIN = '';
let served: Json = {};
let creds: Json = {};

const manifest = (): Json => ({
  manifest_version: 1,
  id: 'cal-sync',
  name: 'סנכרון יומנים',
  version: '1.0.0',
  publisher: { name: 'Bines Labs', email: 'dev@bines.test' },
  permissions: ['boards:read', 'items:write', 'webhooks'],
  origins: [ORIGIN],
  server: { lifecycle_url: `${ORIGIN}/lifecycle` },
  features: [
    { type: 'user_settings_page', key: 'connect', name: 'יומן Google', url: `${ORIGIN}/connect` },
    { type: 'account_settings_page', key: 'admin', name: 'הגדרות', url: `${ORIGIN}/admin` },
  ],
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const asServer = (token: string, method: string, path: string, payload?: unknown) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/manifest.json') return res.end(JSON.stringify(served));
      if (req.url === '/lifecycle') {
        const b = JSON.parse(raw) as Json;
        if (b.event === 'installed') creds = b.credentials;
        return res.end('{}');
      }
      // The webhook handshake: echo the challenge.
      if (req.url === '/hook') {
        const b = raw ? (JSON.parse(raw) as Json) : {};
        return res.end(JSON.stringify({ challenge: b.challenge }));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t = await createTestContext({ env: { OUTBOUND_ALLOW_PRIVATE: '1' } });
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Meetings', workspace_id: wsId }))).id;
  board2Id = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Other', workspace_id: wsId }))).id;
  served = manifest();
  const res = await t.api(admin, acmeId).post('/extensions/install', {
    source: { manifest_url: `${ORIGIN}/manifest.json` },
    consent: { accept: true, scopes: ['boards:read', 'items:write', 'webhooks'], board_ids: [boardId] },
  });
  expect(res.status).toBe(201);
  const tok = await body(
    await t.app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    }),
  );
  creds.token = tok.access_token;
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a page in each member’s profile', () => {
  it('a member sees it (not the admins’ settings page) and gets a token with no board for it', async () => {
    const features = (await body(await t.api(bob, acmeId).get('/extensions/features'))).data as Json[];
    expect(features.map((f) => f.type)).toEqual(['user_settings_page']);
    const page = features[0]!;
    const minted = await t.api(bob, acmeId).post(`/extensions/installations/${page.installation_id}/token`, {
      feature: 'connect',
    });
    expect(minted.status).toBe(200);
    const m = await body(minted);
    expect(m.board_ids).toEqual([]);
    expect(m.token).toMatch(/^bos_ext_/);
    // The admins' settings page stays theirs.
    const denied = await t.api(bob, acmeId).post(`/extensions/installations/${page.installation_id}/token`, {
      feature: 'admin',
    });
    expect(denied.status).toBe(403);
  });
});

describe('POST /ext/introspect — its server learns who is on its page', () => {
  it('the member behind a page token; inactive for a bad token; a page token may not ask', async () => {
    const inst = (await body(await t.api(bob, acmeId).get('/extensions/features'))).data[0].installation_id;
    const page = (
      await body(await t.api(bob, acmeId).post(`/extensions/installations/${inst}/token`, { feature: 'connect' }))
    ).token as string;
    const res = await asServer(creds.token, 'POST', '/ext/introspect', { token: page });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      active: true,
      user: { email: 'bob@acme.test' },
      account_id: acmeId,
      feature: 'connect',
    });
    expect(await body(await asServer(creds.token, 'POST', '/ext/introspect', { token: `${page}x` }))).toEqual({
      active: false,
    });
    // Only the server asks: the page itself (its own origin) is refused.
    const fromPage = await t.app.request('/api/v1/ext/introspect', {
      method: 'POST',
      headers: { authorization: `Bearer ${page}`, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ token: page }),
    });
    expect([401, 403]).toContain(fromPage.status);
  });
});

describe('webhooks its server sets up', () => {
  let hookId = '';
  it('on its board, to its own origin; never elsewhere, never on a board it was not given', async () => {
    const ok = await asServer(creds.token, 'POST', `/boards/${boardId}/webhooks`, {
      url: `${ORIGIN}/hook`,
      event: 'column_changed',
    });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(201);
    hookId = (await body(ok)).id;
    const elsewhere = await asServer(creds.token, 'POST', `/boards/${boardId}/webhooks`, {
      url: 'https://elsewhere.example.com/hook',
      event: 'column_changed',
    });
    expect(elsewhere.status).toBe(403);
    expect(
      (
        await asServer(creds.token, 'POST', `/boards/${board2Id}/webhooks`, {
          url: `${ORIGIN}/hook`,
          event: 'column_changed',
        })
      ).status,
    ).toBe(404);
  });

  it('lists and changes only its own; the admin’s webhooks stay out of its reach', async () => {
    const mine = await t.api(admin, acmeId).post(`/boards/${boardId}/webhooks`, {
      url: `${ORIGIN}/hook`,
      event: 'item_created',
    });
    expect(mine.status).toBe(201);
    const adminHook = (await body(mine)).id;
    const list = (await body(await asServer(creds.token, 'GET', `/boards/${boardId}/webhooks`))).data as Json[];
    expect(list.map((w) => w.id)).toEqual([hookId]);
    expect((await asServer(creds.token, 'DELETE', `/webhooks/${adminHook}`)).status).toBe(404);
    expect(
      (await asServer(creds.token, 'PATCH', `/webhooks/${hookId}`, { url: 'https://elsewhere.example.com/x' })).status,
    ).toBe(403);
  });

  it('uninstalling stops its webhooks', async () => {
    const inst = (
      await t.db.select().from(extensionInstallations).where(eq(extensionInstallations.key, 'cal-sync'))
    )[0]!;
    expect((await t.api(admin, acmeId).del(`/extensions/installations/${inst.id}`)).status).toBeLessThan(300);
    const row = (
      await t.db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.id, hookId), eq(webhooks.accountId, acmeId)))
    )[0]!;
    expect(row.isActive).toBe(false);
  });
});
