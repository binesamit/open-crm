// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_PAGE_BADGE_EVENT } from '@bines/shared';
import type { Db } from '../src/db/client';
import { activityLog, extensionAppPageBadges, extensionInstallations } from '../src/db/schema';
import { meStream } from '../src/modules/realtime/realtime.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * an extension's page in the sidebar (`app_page`) and the count beside it — a generic hook any
 * extension may use. Its server sets the account's count or one member's; its page only its own user's; never
 * another extension's, never a key that is not its own `app_page`. Its page token works on items like a panel's: the
 * installation's top-level boards this member reads, with the member's own rights, written "via app".
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let bobId: string;
let adminId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

let server: Server;
let ORIGIN = '';
const creds: Record<string, Json> = {};
const tokens: Record<string, string> = {};
const installs: Record<string, string> = {};

const manifest = (id: string): Json => ({
  manifest_version: 1,
  id,
  name: `Ext ${id}`,
  version: '1.0.0',
  publisher: { name: 'Labs', email: 'dev@labs.test' },
  permissions: id === 'ext-c' ? ['boards:read', 'items:write'] : ['boards:read'],
  origins: [ORIGIN],
  server: { lifecycle_url: `${ORIGIN}/${id}/lifecycle` },
  features: [
    {
      type: 'app_page',
      key: 'inbox',
      name: 'שיחות',
      name_en: 'Conversations',
      url: `${ORIGIN}/${id}/inbox`,
      icon: 'chat',
    },
    { type: 'user_settings_page', key: 'connect', name: 'חיבור', url: `${ORIGIN}/${id}/connect` },
    { type: 'automation_trigger', key: 'button', name: 'כפתור בשיחה', payload_fields: [] },
  ],
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const call = (token: string, method: string, path: string, payload?: unknown, origin?: string) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(origin ? { origin } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

const badgeOf = async (cookie: string, key = 'ext-a') => {
  const pages = (await body(await t.api(cookie, acmeId).get('/extensions/app-pages'))).data as Json[];
  return pages.find((p) => p.extension_key === key)?.badge as number | null | undefined;
};

const install = async (id: string, consent: Json = { scopes: ['boards:read'] }) => {
  const res = await t.api(admin, acmeId).post('/extensions/install', {
    source: { manifest_url: `${ORIGIN}/${id}/manifest.json` },
    consent: { accept: true, ...consent },
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  installs[id] = (await body(res)).id;
  const c = creds[id]!;
  const tok = await body(
    await t.app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    }),
  );
  tokens[id] = tok.access_token;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      const m = /^\/(ext-[a-z])\/(manifest\.json|lifecycle)$/.exec(req.url ?? '');
      if (m && m[2] === 'manifest.json') return res.end(JSON.stringify(manifest(m[1]!)));
      if (m && m[2] === 'lifecycle') {
        const b = JSON.parse(raw) as Json;
        if (b.event === 'installed') creds[m[1]!] = b.credentials;
        return res.end('{}');
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
  const people = (await body(await t.api(admin, acmeId).get('/users'))).data as Json[];
  bobId = people.find((p) => p.email === 'bob@acme.test')!.user_id;
  adminId = people.find((p) => p.email === 'admin@acme.test')!.user_id;
  await install('ext-a');
  await install('ext-b');
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('the sidebar page', () => {
  it('every member sees it, with its icon and no count yet; a page token (no board in the account yet)', async () => {
    const pages = (await body(await t.api(bob, acmeId).get('/extensions/app-pages'))).data as Json[];
    expect(pages.map((p) => [p.extension_key, p.feature, p.type])).toEqual([
      ['ext-a', 'inbox', 'app_page'],
      ['ext-b', 'inbox', 'app_page'],
    ]);
    expect(pages[0]).toMatchObject({ name: 'שיחות', name_en: 'Conversations', page_icon: 'chat', badge: null });
    // It is a framed feature like the others (the profile page is not in this list).
    const features = (await body(await t.api(bob, acmeId).get('/extensions/features?type=app_page'))).data as Json[];
    expect(features).toHaveLength(2);
    const minted = await t.api(bob, acmeId).post(`/extensions/installations/${installs['ext-a']}/token`, {
      feature: 'inbox',
    });
    expect(minted.status).toBe(200);
    // Its boards are the panel's: the installation's boards this member reads — none exist yet here.
    expect((await body(minted)).board_ids).toEqual([]);
  });

  it('a disabled extension’s page leaves the sidebar', async () => {
    await t.api(admin, acmeId).patch(`/extensions/installations/${installs['ext-b']}`, { status: 'disabled' });
    expect(await badgeOf(bob, 'ext-b')).toBeUndefined();
    await t.api(admin, acmeId).patch(`/extensions/installations/${installs['ext-b']}`, { status: 'enabled' });
    expect(await badgeOf(bob, 'ext-b')).toBeNull();
  });
});

describe('PUT /ext/app-pages/{key}/badge — its server', () => {
  it('sets the account’s count (everyone) and one member’s (wins for them); null removes it', async () => {
    const all = await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', { count: 5 });
    expect(all.status, JSON.stringify(await all.clone().json())).toBe(200);
    expect(await body(all)).toEqual({ key: 'inbox', count: 5, user_id: null });
    expect(await badgeOf(bob)).toBe(5);
    expect(await badgeOf(admin)).toBe(5);

    expect(
      (await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', { count: 2, user_id: bobId })).status,
    ).toBe(200);
    expect(await badgeOf(bob)).toBe(2);
    expect(await badgeOf(admin)).toBe(5);
    // Setting it again replaces it (one row per page × member).
    await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', { count: 0, user_id: bobId });
    expect(await badgeOf(bob)).toBe(0);
    const rows = await t.db
      .select()
      .from(extensionAppPageBadges)
      .where(eq(extensionAppPageBadges.installationId, installs['ext-a']!));
    expect(rows).toHaveLength(2);

    await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', { count: null, user_id: bobId });
    expect(await badgeOf(bob)).toBe(5);
  });

  it('a key that is not one of its own app pages is 404; so is someone outside the account', async () => {
    expect((await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/nope/badge', { count: 1 })).status).toBe(404);
    // Its profile page is not a sidebar page.
    expect((await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/connect/badge', { count: 1 })).status).toBe(404);
    expect(
      (
        await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', {
          count: 1,
          user_id: '01J0000000000000000000000X',
        })
      ).status,
    ).toBe(404);
  });

  it('refuses bad counts', async () => {
    expect((await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', { count: -1 })).status).toBe(400);
    expect((await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', { count: 1.5 })).status).toBe(400);
    expect((await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', {})).status).toBe(400);
  });

  it('another extension cannot touch it — the same key reaches only its own page', async () => {
    await call(tokens['ext-b']!, 'PUT', '/ext/app-pages/inbox/badge', { count: 9 });
    expect(await badgeOf(bob, 'ext-b')).toBe(9);
    expect(await badgeOf(bob, 'ext-a')).toBe(5);
  });

  it('needs an extension token: no token, a session or a member’s API token is refused', async () => {
    const anon = await t.app.request('/api/v1/ext/app-pages/inbox/badge', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-account-id': acmeId },
      body: JSON.stringify({ count: 1 }),
    });
    expect(anon.status).toBe(401);
    const session = await t.api(bob, acmeId).put('/ext/app-pages/inbox/badge', { count: 1 });
    expect(session.status).toBe(403);
    expect(await badgeOf(bob)).toBe(5);
  });
});

describe('its page sets only its own user’s count', () => {
  it('with its page token (from its origin)', async () => {
    const page = (
      await body(
        await t.api(bob, acmeId).post(`/extensions/installations/${installs['ext-a']}/token`, { feature: 'inbox' }),
      )
    ).token as string;
    const own = await call(page, 'PUT', '/ext/app-pages/inbox/badge', { count: 3 }, ORIGIN);
    expect(own.status, JSON.stringify(await own.clone().json())).toBe(200);
    expect(await body(own)).toEqual({ key: 'inbox', count: 3, user_id: bobId });
    expect(await badgeOf(bob)).toBe(3);
    expect(await badgeOf(admin)).toBe(5);
    const other = await call(page, 'PUT', '/ext/app-pages/inbox/badge', { count: 3, user_id: adminId }, ORIGIN);
    expect(other.status).toBe(403);
    // A page token is bound to its origin.
    expect((await call(page, 'PUT', '/ext/app-pages/inbox/badge', { count: 1 }, 'https://evil.example')).status).toBe(
      401,
    );
  });

  it('through the app (`setBadge`): the signed-in member’s own count only', async () => {
    const path = `/extensions/installations/${installs['ext-a']}/app-pages/inbox/badge`;
    const ok = await t.api(admin, acmeId).put(path, { count: 7 });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual({ key: 'inbox', count: 7, user_id: adminId });
    expect(await badgeOf(admin)).toBe(7);
    expect(await badgeOf(bob)).toBe(3);
    expect((await t.api(admin, acmeId).put(path, { count: 1, user_id: bobId })).status).toBe(403);
    expect(
      (
        await t
          .api(admin, acmeId)
          .put(`/extensions/installations/${installs['ext-a']}/app-pages/connect/badge`, { count: 1 })
      ).status,
    ).toBe(404);
  });
});

describe('live: /me/events', () => {
  it('the account’s count reaches everyone; a member’s count only that member', async () => {
    const stream = meStream(t.db as unknown as Db, {
      ctx: { accountId: acmeId } as never,
      user: { id: bobId } as never,
    });
    const e = { id: '', account_id: acmeId, type: APP_PAGE_BADGE_EVENT };
    expect(await stream.accept(e as never)).toBe('send');
    expect(await stream.accept({ ...e, user_id: bobId } as never)).toBe('send');
    expect(await stream.accept({ ...e, user_id: adminId } as never)).toBe('skip');
  });
});

describe('its page works on items with the member’s own rights (like a panel)', () => {
  let leads: string; // allowed, bob reads it
  let deals: string; // bob reads it, the installation is not allowed on it
  let secret: string; // allowed, bob cannot read it
  let leadId: string;
  let page: string;
  const asPage = (method: string, path: string, payload?: unknown) => call(page, method, path, payload, ORIGIN);
  beforeAll(async () => {
    const wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id as string;
    const mk = async (name: string, kind?: string) =>
      (await body(await t.api(admin, acmeId).post('/boards', { name, workspace_id: wsId, ...(kind ? { kind } : {}) })))
        .id as string;
    leads = await mk('Leads');
    deals = await mk('Deals');
    secret = await mk('Secret', 'private');
    await t.api(admin, acmeId).post(`/boards/${leads}/columns`, { id: 'phone', title: 'טלפון', type: 'text' });
    leadId = (await body(await t.api(admin, acmeId).post(`/boards/${leads}/items`, { name: 'Dana' }))).id;
    await install('ext-c', { scopes: ['boards:read', 'items:write'], board_ids: [leads, secret] });
    const minted = await body(
      await t.api(bob, acmeId).post(`/extensions/installations/${installs['ext-c']}/token`, { feature: 'inbox' }),
    );
    expect(minted.board_ids).toEqual([leads]);
    expect(minted.board_id).toBe('');
    page = minted.token;
  });

  it('the installation’s boards this member reads — never more; the profile page still reads none', async () => {
    const admins = await body(
      await t.api(admin, acmeId).post(`/extensions/installations/${installs['ext-c']}/token`, { feature: 'inbox' }),
    );
    expect([...admins.board_ids].sort()).toEqual([leads, secret].sort());
    const profile = await body(
      await t.api(bob, acmeId).post(`/extensions/installations/${installs['ext-c']}/token`, { feature: 'connect' }),
    );
    expect(profile.board_ids).toEqual([]);
    expect((await call(profile.token, 'GET', `/boards/${leads}`, undefined, ORIGIN)).status).toBe(404);
  });

  it('reads the board (columns) and an item with its cells', async () => {
    const board = await asPage('GET', `/boards/${leads}`);
    expect(board.status, JSON.stringify(await board.clone().json())).toBe(200);
    expect(((await body(board)).columns as Json[]).map((c) => c.id)).toContain('phone');
    const item = await asPage('GET', `/items/${leadId}`);
    expect(item.status).toBe(200);
    expect(await body(item)).toMatchObject({ id: leadId, board_id: leads, name: 'Dana' });
  });

  it('updates the item and one cell, and creates an item — each "via app", one batch', async () => {
    const patched = await asPage('PATCH', `/items/${leadId}`, { name: 'Dana Levi', cells: { phone: '050-1234567' } });
    expect(patched.status, JSON.stringify(await patched.clone().json())).toBe(200);
    const cell = await asPage('PUT', `/items/${leadId}/cells/phone`, { value: '052-7654321' });
    expect(cell.status, JSON.stringify(await cell.clone().json())).toBe(200);
    const read = await body(await t.api(bob, acmeId).get(`/items/${leadId}`));
    expect(read.name).toBe('Dana Levi');
    expect((read.cells as Json).phone).toMatchObject({ value: '052-7654321' });

    const created = await asPage('POST', `/boards/${leads}/items`, { name: 'New lead from the inbox' });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const newId = (await body(created)).id as string;
    for (const [itemId, type] of [
      [leadId, 'item.renamed'],
      [newId, 'item.created'],
    ] as const) {
      const evs = await t.db.select().from(activityLog).where(eq(activityLog.itemId, itemId));
      const ev = evs.find((e) => e.type === type) ?? evs.find((e) => e.type.startsWith('item.'));
      expect(ev, `${type}: ${evs.map((e) => e.type).join(',')}`).toBeTruthy();
      expect((ev!.payload as Json).meta).toMatchObject({
        via: 'app',
        app: { key: 'ext-c', installation_id: installs['ext-c'] },
      });
      expect(ev!.actorId).toBe(bobId);
      expect(ev!.batchId).toBeTruthy();
    }
  });

  it('refused on a board the installation is not allowed on, or the member cannot read', async () => {
    const dealId = (await body(await t.api(admin, acmeId).post(`/boards/${deals}/items`, { name: 'Deal' }))).id;
    const secretId = (await body(await t.api(admin, acmeId).post(`/boards/${secret}/items`, { name: 'Hidden' }))).id;
    for (const [board, item] of [
      [deals, dealId],
      [secret, secretId],
    ] as const) {
      expect((await asPage('GET', `/boards/${board}`)).status).toBe(404);
      expect((await asPage('GET', `/items/${item}`)).status).toBe(404);
      expect((await asPage('PATCH', `/items/${item}`, { name: 'x' })).status).toBe(404);
      expect((await asPage('POST', `/boards/${board}/items`, { name: 'x' })).status).toBe(404);
    }
    // Like every frame token: it never changes who sees a board.
    expect((await asPage('PATCH', `/boards/${leads}`, { kind: 'private' })).status).toBe(403);
  });

  it('a viewer’s page reads but cannot write — the member’s rights, not the app’s', async () => {
    await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
    const vera = await join('vera@acme.test');
    const tok = await body(
      await t.api(vera, acmeId).post(`/extensions/installations/${installs['ext-c']}/token`, { feature: 'inbox' }),
    );
    expect(tok.board_ids).toEqual([leads]);
    expect((await call(tok.token, 'GET', `/items/${leadId}`, undefined, ORIGIN)).status).toBe(200);
    expect((await call(tok.token, 'PATCH', `/items/${leadId}`, { name: 'x' }, ORIGIN)).status).toBe(403);
    expect((await call(tok.token, 'POST', `/boards/${leads}/items`, { name: 'x' }, ORIGIN)).status).toBe(403);
  });
});

describe('GET /ext/automations — which automations use its own trigger (its page, read only)', () => {
  let leads: string;
  let secret: string; // allowed for it, but bob cannot read it
  let page: string;
  let onButton: string;
  beforeAll(async () => {
    const boards = (await body(await t.api(admin, acmeId).get('/boards'))).data as Json[];
    leads = boards.find((b) => b.name === 'Leads')!.id;
    secret = boards.find((b) => b.name === 'Secret')!.id;
    const mk = async (board: string, block: string, title: string) => {
      const res = await t.api(admin, acmeId).post(`/boards/${board}/automations`, {
        title,
        recipe: {
          trigger: { type: 'extension_trigger', block, with_item: true },
          actions: [{ type: 'create_update', body: 'x' }],
        },
      });
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
      return (await body(res)).id as string;
    };
    onButton = await mk(leads, 'ext-c.button', 'On the button');
    await mk(secret, 'ext-c.button', 'On a board bob cannot read');
    await mk(leads, 'ext-a.button', 'Another extension’s trigger');
    page = (
      await body(
        await t.api(bob, acmeId).post(`/extensions/installations/${installs['ext-c']}/token`, { feature: 'inbox' }),
      )
    ).token;
  });

  it('lists its own trigger’s automations on the boards its token reads — never another extension’s', async () => {
    // The admin's page sees both of its boards; bob's only the one he reads.
    const res = await call(page, 'GET', '/ext/automations?trigger=button', undefined, ORIGIN);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const rows = (await body(res)).data as Json[];
    expect(rows).toEqual([
      expect.objectContaining({
        board_id: leads,
        name: 'On the button',
        active: true,
        trigger: { type: 'extension_trigger', block: 'ext-c.button', with_item: true },
      }),
    ]);
    const admins = (
      await body(
        await t.api(admin, acmeId).post(`/extensions/installations/${installs['ext-c']}/token`, { feature: 'inbox' }),
      )
    ).token as string;
    const all = (await body(await call(admins, 'GET', '/ext/automations?trigger=button', undefined, ORIGIN)))
      .data as Json[];
    expect(all.map((r) => r.board_id).sort()).toEqual([leads, secret].sort());
  });

  it('refuses a key that is not its own trigger, a write, and a server token', async () => {
    expect((await call(page, 'GET', '/ext/automations?trigger=inbox', undefined, ORIGIN)).status).toBe(404);
    expect((await call(page, 'GET', '/ext/automations?trigger=nope', undefined, ORIGIN)).status).toBe(404);
    expect((await call(page, 'POST', '/ext/automations?trigger=button', {}, ORIGIN)).status).toBe(403);
    expect((await call(tokens['ext-c']!, 'GET', '/ext/automations?trigger=button')).status).toBe(403);
    // The automations routes themselves stay closed to an extension (EXT-RT1): switching one on / off goes through
    // the app (`setAutomationActive`, the member's session), never with its token.
    expect((await call(page, 'GET', `/boards/${leads}/automations`, undefined, ORIGIN)).status).toBe(403);
    expect((await call(page, 'POST', `/automations/${onButton}/deactivate`, {}, ORIGIN)).status).toBe(403);
  });
});

describe('uninstalling', () => {
  it('takes its counts with it', async () => {
    expect((await t.api(admin, acmeId).del(`/extensions/installations/${installs['ext-a']}`)).status).toBeLessThan(300);
    expect(await badgeOf(bob, 'ext-a')).toBeUndefined();
    const inst = (
      await t.db.select().from(extensionInstallations).where(eq(extensionInstallations.id, installs['ext-a']!))
    )[0];
    // Uninstall keeps the row (history) or removes it; either way the server may no longer set a count.
    expect(inst === undefined || inst.uninstalledAt !== null).toBe(true);
    expect(
      (await call(tokens['ext-a']!, 'PUT', '/ext/app-pages/inbox/badge', { count: 1 })).status,
    ).toBeGreaterThanOrEqual(400);
  });
});
