// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { asc, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAP_ORIGIN_MAX, mapOriginSchema, newId, type RecipeInput } from '@bines/shared';
import { OTHER_SIGN_INS } from '../src/auth/two-factor';
import { activityLog, automations } from '../src/db/schema';
import { isPrivateIp } from '../src/lib/outbound';
import { createSecretBox } from '../src/lib/secrets';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { COLLAB_PATH, createCollab, type Collab } from '../src/modules/docs/collab';
import { ACCOUNT_MAP_ORIGINS_BUDGET, accountOrigins } from '../src/modules/geo/geo.csp';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * Security review, delta 2026-10-06 (docs/SECURITY-REVIEW.md S-24…): what shipped after the first review —
 * the docs WebSocket, MCP, search, time reports, automations, maps, outbound requests.
 */
let t: TestContext;
let collab: Collab;
let server: Server;
let url: string;
let admin: string;
let bob: string; // member
let dan: string; // member — deactivated in the last test
let acmeId: string;
let wsId: string;
let bobId: string;
let adminId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const from = (cookie: string, ip: string) => ({
  patch: (path: string, b: unknown) => as(cookie).call('PATCH', path, b, { 'x-forwarded-for': ip }),
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

type Client = { provider: HocuspocusProvider; failed: () => string | null };
const clients: Client[] = [];
/** A browser-like client with the session cookie, from a given client address (X-Forwarded-For, TRUST_PROXY=edge). */
const connect = (name: string, cookie: string, ip?: string): Client => {
  let failure: string | null = null;
  const headers = { cookie, origin: WEB_ORIGIN, ...(ip ? { 'x-forwarded-for': ip } : {}) };
  const Ws = class extends WebSocket {
    constructor(u: string | URL) {
      super(u, { headers } as unknown as string[]);
    }
  };
  const provider = new HocuspocusProvider({
    url,
    name,
    document: new Y.Doc(),
    token: 'session',
    WebSocketPolyfill: Ws,
    onAuthenticationFailed: ({ reason }) => {
      failure = reason || 'denied';
    },
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  const c = { provider, failed: () => failure };
  clients.push(c);
  return c;
};
const synced = (c: Client) => until(() => c.provider.isSynced || !!c.failed());

beforeAll(async () => {
  t = await createTestContext();
  collab = createCollab(t.deps, { debounce: 50, maxDebounce: 200, recheckMs: 150 });
  server = createServer((_req, res) => res.end());
  collab.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${COLLAB_PATH}`;

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test', 'dan@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  dan = await join('dan@acme.test');
  bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
}, 180_000);
afterAll(async () => {
  for (const c of clients) c.provider.destroy();
  await collab.close();
  await new Promise((r) => server.close(r));
  await t.close();
});

describe('S-24 / S-26 — the account IP allowlist holds for the docs WebSocket and the MCP server', () => {
  it('a socket or an MCP call from an address outside the list is refused; inside it works', async () => {
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Plans' }));
    expect((await as(admin).patch('/ai/settings', { mcp_enabled: true })).status).toBe(200);
    const token = (await body(await as(bob).post('/auth/tokens', { name: 'cli', scopes: ['boards:read'] }))).token;
    const mcp = (ip: string) =>
      t.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

    const on = await from(admin, '198.51.100.7').patch('/security', {
      ip_allowlist: { enabled: true, ranges: ['198.51.100.0/24'] },
    });
    expect(on.status).toBe(200);
    try {
      const outside = connect(doc.collab_name, bob, '203.0.113.9');
      await synced(outside);
      expect(outside.failed()).not.toBeNull();
      const inside = connect(doc.collab_name, bob, '198.51.100.20');
      await synced(inside);
      expect(inside.failed()).toBeNull();

      const refused = await mcp('203.0.113.9');
      expect(refused.status).toBe(403);
      expect((await body(refused)).error.message).toBe('ip_not_allowed');
      expect((await mcp('198.51.100.20')).status).toBe(200);
    } finally {
      await from(admin, '198.51.100.7').patch('/security', { ip_allowlist: { enabled: false } });
    }
  });
});

describe('S-24 — an open docs socket is checked again', () => {
  it('a member deactivated while editing loses the socket (it does not keep writing)', async () => {
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Handover' }));
    const c = connect(doc.collab_name, dan);
    await synced(c);
    expect(c.failed()).toBeNull();
    expect(c.provider.authorizedScope).toBe('read-write');
    const users = (await body(await as(admin).get('/users'))).data as Json[];
    const danId = users.find((u) => u.email === 'dan@acme.test')!.user_id as string;
    expect((await as(admin).post(`/users/${danId}/deactivate`, {})).status).toBe(200);
    await until(() => !!c.failed());
  });
});

describe('S-25 — Google ID-token sign-in gets the same two-factor step', () => {
  it('/sign-in/social is one of the doors that is challenged', () => {
    expect(OTHER_SIGN_INS.has('/sign-in/social')).toBe(true);
    expect(OTHER_SIGN_INS.has('/magic-link/verify')).toBe(true);
    expect(OTHER_SIGN_INS.has('/callback/:id')).toBe(true);
  });
});

/** A private board B (admin only) linked from a shared board A that bob reads. */
const relationSetup = async () => {
  const vault = await body(await as(admin).post('/boards', { name: 'Vault', workspace_id: wsId, kind: 'private' }));
  await as(admin).post(`/boards/${vault.id}/columns`, { id: 'salary', title: 'Salary', type: 'text' });
  const secret = await body(await as(admin).post(`/boards/${vault.id}/items`, { name: 'Zanzibar acquisition' }));
  await as(admin).put(`/items/${secret.id}/cells/salary`, { value: '99999' });
  const open = await body(await as(admin).post('/boards', { name: 'Open', workspace_id: wsId }));
  await as(admin).post(`/boards/${open.id}/columns`, {
    id: 'rel',
    title: 'Linked',
    type: 'board_relation',
    settings: { board_ids: [vault.id], allow_multiple: true },
  });
  return { vault, secret, open };
};

describe('S-28 — names of linked items one may not see stay out of search', () => {
  it('a relation cell pointing at a private board is not searched or shown as "matched"', async () => {
    const { secret, open } = await relationSetup();
    const a = await body(await as(admin).post(`/boards/${open.id}/items`, { name: 'Alpha' }));
    expect((await as(admin).put(`/items/${a.id}/cells/rel`, { value: { item_ids: [secret.id] } })).status).toBe(200);
    expect((await as(bob).get(`/items/${a.id}`)).status).toBe(200); // bob reads the item itself
    const found = await body(await as(bob).get(`/search?q=${encodeURIComponent('Zanzibar')}`));
    expect(JSON.stringify(found)).not.toContain('Zanzibar');
  });
});

describe('S-29 — time reports leave out a time column hidden from the reader', () => {
  it('bob sees no entries of the restricted "hours" column; the admin does', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Billing', workspace_id: wsId }));
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'hours', title: 'Billable', type: 'time_tracking' });
    expect(
      (await as(admin).put(`/boards/${board.id}/columns/hours/restriction`, { kind: 'view', users: [], teams: [] }))
        .status,
    ).toBe(200);
    const item = await body(await as(admin).post(`/boards/${board.id}/items`, { name: 'Client X' }));
    const logged = await as(admin).post(`/items/${item.id}/time/entries`, {
      column_id: 'hours',
      started_at: '2026-09-01T06:00:00Z',
      duration_s: 3600,
    });
    expect(logged.status).toBe(201);
    const report = async (cookie: string) =>
      body(await as(cookie).get(`/boards/${board.id}/time/report?group_by=user`));
    expect((await report(admin)).total_s).toBe(3600);
    const bobs = await report(bob);
    expect(bobs.total_s).toBe(0);
    expect(bobs.rows).toEqual([]);
  });
});

describe('S-32 — "copy from linked item" reads only what the automation owner may see', () => {
  const seen = new Set<string>();
  const drain = async () => {
    for (let round = 0; round < 20; round++) {
      const rows = await t.db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.accountId, acmeId))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
      const fresh = rows.filter((r) => !seen.has(r.id));
      if (!fresh.length) break;
      for (const r of fresh) {
        seen.add(r.id);
        for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
      }
    }
  };

  it('bob’s automation copies nothing from a private board; the admin’s copies the value', async () => {
    const { secret, open } = await relationSetup();
    await as(admin).post(`/boards/${open.id}/columns`, { id: 'bobcopy', title: 'Bob copy', type: 'text' });
    await as(admin).post(`/boards/${open.id}/columns`, { id: 'admincopy', title: 'Admin copy', type: 'text' });
    await drain(); // setup events: nothing listens yet
    const add = async (ownerId: string, column: string) => {
      const recipe: RecipeInput = {
        trigger: { type: 'column_changed', column: 'rel' },
        actions: [{ type: 'copy_from_linked', relation: 'rel', source: 'salary', column }],
      } as unknown as RecipeInput;
      await t.db.insert(automations).values({
        id: newId(),
        accountId: acmeId,
        boardId: open.id,
        title: `copy ${column}`,
        recipe: recipe as never,
        isActive: true,
        ownerId,
        createdBy: ownerId,
      });
    };
    await add(bobId, 'bobcopy');
    await add(adminId, 'admincopy');
    const a = await body(await as(admin).post(`/boards/${open.id}/items`, { name: 'Beta' }));
    await as(admin).put(`/items/${a.id}/cells/rel`, { value: { item_ids: [secret.id] } });
    await drain();
    const cells = (await body(await as(admin).get(`/items/${a.id}`))).cells as Json;
    expect(cells.admincopy?.value).toBe('99999');
    expect(cells.bobcopy?.value ?? null).toBeNull();
  });
});

describe('S-31 — account map origins cannot grow every page’s CSP', () => {
  it('an origin is at most MAP_ORIGIN_MAX characters; all accounts together stay within the budget', async () => {
    const long = `https://${'a'.repeat(300)}.com`;
    expect(mapOriginSchema.safeParse(long).success).toBe(false);
    expect((await as(admin).put('/geo/settings', { extra_origins: [long] })).status).toBe(400);
    const many = Array.from({ length: 200 }, (_, i) => ({
      extra_origins: Array.from(
        { length: 10 },
        (_, j) => `https://${String(i * 10 + j).padStart(4, '0')}${'b'.repeat(200)}.example`,
      ),
    }));
    const origins = accountOrigins(many, new Set(many.flatMap((m) => m.extra_origins)));
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.join(' ').length).toBeLessThanOrEqual(ACCOUNT_MAP_ORIGINS_BUDGET);
    expect(origins.every((o) => o.length <= MAP_ORIGIN_MAX)).toBe(true);
  });
});

describe('S-35 — 6to4 addresses are private in every spelling', () => {
  it('compressed 6to4 forms of loopback / private ranges are blocked', () => {
    expect(isPrivateIp('2002:7f00::')).toBe(true);
    expect(isPrivateIp('2002:a00::1')).toBe(true);
    expect(isPrivateIp('2002:7f00:1::')).toBe(true);
    expect(isPrivateIp('2606:4700::1111')).toBe(false);
  });
});

describe('S-50 — a sealed secret opens only with its full GCM tag', () => {
  it('a truncated tag is refused', () => {
    const box = createSecretBox({
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      SECRETS_KEY: undefined,
    });
    const sealed = box.seal('sk-ant-123');
    expect(box.open(sealed)).toBe('sk-ant-123');
    const [v, iv, tag, data] = sealed.split('.');
    const short = Buffer.from(tag!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => box.open([v, iv, short, data].join('.'))).toThrow();
  });
});
