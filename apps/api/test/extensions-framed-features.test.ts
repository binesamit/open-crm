// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asc, eq } from 'drizzle-orm';
import { EXT_STORAGE_QUOTA_BYTES, EXT_STORAGE_VALUE_MAX_BYTES, EXT_UPLOAD_MAX_BYTES } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, auditLog, automationRuns, updates } from '../src/db/schema';
import { enqueueJob } from '../src/lib/jobs';
import type * as Jobs from '../src/lib/jobs';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';

// The queue helper keeps its behaviour (no graphile schema here → false) and records its calls: an extension
// trigger must queue its own `automation.dispatch` — the activity trigger (0046) does not (audit 2026-10-10, #1).
vi.mock('../src/lib/jobs', async (importOriginal) => {
  const m = await importOriginal<typeof Jobs>();
  return { ...m, enqueueJob: vi.fn(m.enqueueJob) };
});
import { callExtension, retryExtensionCall } from '../src/modules/extensions/ext-automation';
import { signExtBody, verifyExtSignature } from '../src/modules/extensions/ext-signing';
import { forgetExtensionOrigins } from '../src/modules/extensions/ext-origins';
import { verifyExtToken } from '../src/modules/extensions/ext-token';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Extensions ת3–ת5 (D27, the planning notes "MARKETPLACE"): item tabs, menu / batch actions, dashboard widgets, settings
 * pages (each surface's token limits), the extension's storage (quota, isolation) and uploads, automation blocks
 * (signed calls, retries, SSRF, the trigger its server fires — signature, timestamp, replay) and the kill switch
 * stopping every surface.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string; // member
let vera: string; // viewer
let guest: string;
let acmeId: string;
let adminId: string;
let boardId: string;
let board2Id: string; // not allowed for the extension
let privateBoardId: string; // allowed, but bob cannot read it
let wsId: string;
let instId: string;
let EXT_ORIGIN = '';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

// ---- the extension's own server (a local HTTP server) ----
let server: Server;
type Hit = { path: string; headers: IncomingHttpHeaders; raw: string; body: Json };
const hits: Hit[] = [];
let mode: 'ok' | 'fail500' | 'fail400' = 'ok';

const manifest = (): Json => ({
  manifest_version: 1,
  id: 'kit',
  name: 'ערכת דוגמה',
  version: '1.0.0',
  publisher: { name: 'Bines Labs' },
  permissions: ['boards:read', 'items:write', 'updates:write'],
  origins: [EXT_ORIGIN],
  features: [
    { type: 'board_view', key: 'summary', name: 'סיכום', url: `${EXT_ORIGIN}/index.html` },
    { type: 'item_view', key: 'tab', name: 'לשונית', url: `${EXT_ORIGIN}/item.html` },
    { type: 'board_menu_action', key: 'act', name: 'פעולה', url: `${EXT_ORIGIN}/action.html` },
    { type: 'batch_action', key: 'bulk', name: 'על המסומנים', url: `${EXT_ORIGIN}/action.html` },
    { type: 'dashboard_widget', key: 'widget', name: 'ווידג׳ט', url: `${EXT_ORIGIN}/widget.html` },
    { type: 'account_settings_page', key: 'settings', name: 'הגדרות', url: `${EXT_ORIGIN}/settings.html` },
    { type: 'panel', key: 'panel', name: 'פאנל', url: `${EXT_ORIGIN}/panel.html` },
    {
      type: 'automation_action',
      key: 'send',
      name: 'שלח הודעה',
      url: `${EXT_ORIGIN}/run`,
      inputs: [
        { key: 'message', label: 'הודעה', type: 'template', required: true },
        { key: 'urgent', label: 'דחוף', type: 'boolean' },
      ],
    },
    {
      type: 'automation_trigger',
      key: 'incoming',
      name: 'הודעה נכנסת',
      payload_fields: [{ key: 'text', label: 'טקסט' }],
      // set per automation (e.g. which button) — a fire runs only the automations it matches.
      inputs: [{ key: 'button', label: 'כפתור' }],
    },
  ],
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** A request from the extension (its page — with its origin — or its server, without one). */
const asExt = (
  token: string,
  method: string,
  path: string,
  payload?: unknown,
  opts: { origin?: string | null; raw?: Buffer; contentType?: string } = {},
) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      ...(opts.origin === null ? {} : { origin: opts.origin ?? EXT_ORIGIN }),
      authorization: `Bearer ${token}`,
      'x-account-id': acmeId,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
    },
    body: opts.raw ?? (payload === undefined ? undefined : JSON.stringify(payload)),
  });

const mint = async (cookie: string, input: Json, id = instId) =>
  t.api(cookie, acmeId).post(`/extensions/installations/${id}/token`, input);
const tokenFor = async (cookie: string, input: Json) => {
  const res = await mint(cookie, input);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return (await body(res)).token as string;
};

/** Dispatch every new activity row (and run what it causes). */
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

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, raw, body: raw ? (JSON.parse(raw) as Json) : {} });
      const status = mode === 'ok' ? 200 : mode === 'fail500' ? 500 : 400;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { output: { sent: true } } : { error: 'nope' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  EXT_ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  vera = await join('vera@acme.test');
  adminId = (await body(await t.api(admin, acmeId).get('/auth/me'))).user.id;
  wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  const mk = async (name: string, kind?: string) =>
    (await body(await t.api(admin, acmeId).post('/boards', { name, workspace_id: wsId, ...(kind ? { kind } : {}) })))
      .id as string;
  boardId = await mk('Leads');
  board2Id = await mk('Deals');
  privateBoardId = await mk('Secret', 'private');
  await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Lead A' });
  await t.api(admin, acmeId).post(`/boards/${board2Id}/items`, { name: 'Deal B' });
  await t.api(admin, acmeId).post(`/boards/${privateBoardId}/items`, { name: 'Secret C' });
  await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, { id: 'docs', title: 'מסמכים', type: 'file' });
  const share = await mk('Client', 'shareable');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['guest@client.test'], role: 'guest' });
  guest = await join('guest@client.test');
  const users = (await body(await t.api(admin, acmeId).get('/users'))).data as Json[];
  await t
    .api(admin, acmeId)
    .put(`/boards/${share}/members/${users.find((u) => u.email === 'guest@client.test')!.user_id}`, {});

  const res = await t.api(admin, acmeId).post('/extensions/install', {
    source: { manifest: manifest() },
    consent: {
      accept: true,
      scopes: ['boards:read', 'items:write', 'updates:write'],
      board_ids: [boardId, privateBoardId],
    },
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  instId = (await body(res)).id;
  forgetExtensionOrigins();
});
afterAll(async () => {
  await t.close();
  server.close();
});

describe('framed features (ת3/ת5): where each one shows', () => {
  it('lists item tabs, menu and batch actions on allowed boards; settings pages to admins only; none to guests', async () => {
    const on = async (cookie: string, q: string) =>
      ((await body(await t.api(cookie, acmeId).get(`/extensions/features${q}`))).data as Json[]).map(
        (f) => `${f.type}:${f.feature}`,
      );
    expect(await on(bob, `?board_id=${boardId}`)).toEqual([
      'board_view:summary',
      'item_view:tab',
      'board_menu_action:act',
      'batch_action:bulk',
      'dashboard_widget:widget',
      'panel:panel',
    ]);
    // A board the installation is not allowed on: only what is not about a board.
    expect(await on(bob, `?board_id=${board2Id}`)).toEqual(['dashboard_widget:widget', 'panel:panel']);
    expect(await on(admin, '?type=account_settings_page')).toEqual(['account_settings_page:settings']);
    expect(await on(bob, '?type=account_settings_page')).toEqual([]);
    expect(await on(guest, '')).toEqual([]);
    const act = (await body(await t.api(bob, acmeId).get(`/extensions/features?type=board_menu_action`))).data[0];
    expect(act).toMatchObject({ contexts: ['board', 'item'], modal: { width: 560, height: 420 } });
    // The automation server is not a frame origin (CSP / CORS list pages only).
    const inst = (await body(await t.api(admin, acmeId).get('/extensions'))).installed[0];
    expect(inst.frame_origins).toEqual([EXT_ORIGIN]);
  });

  it('an item tab / menu / batch token is for one allowed board the user reads', async () => {
    for (const feature of ['tab', 'act', 'bulk']) {
      const tok = await body(await mint(bob, { feature, board_id: boardId }));
      expect(tok.board_ids).toEqual([boardId]);
      expect((await mint(bob, { feature, board_id: board2Id })).status).toBe(403);
      expect((await mint(bob, { feature, board_id: privateBoardId })).status).toBe(404);
      expect((await mint(bob, { feature })).status).toBe(400);
    }
    // Automation blocks are no pages: no token for them from a browser.
    expect((await mint(bob, { feature: 'send', board_id: boardId })).status).toBe(404);
  });

  it('a batch action writes the selection "via app X", one batch, undoable', async () => {
    const token = await tokenFor(bob, { feature: 'bulk', board_id: boardId });
    const res = await asExt(token, 'POST', `/boards/${boardId}/items`, { name: 'From the batch action' });
    expect(res.status).toBe(201);
    const item = await body(res);
    const ev = (await t.db.select().from(activityLog).where(eq(activityLog.itemId, item.id))).find(
      (e) => e.type === 'item.created',
    )!;
    expect((ev.payload as Json).meta).toMatchObject({ via: 'app', app: { key: 'kit', installation_id: instId } });
    expect(ev.batchId).toBeTruthy();
    expect((await t.api(bob, acmeId).post(`/activity/${ev.id}/undo`, {})).status).toBe(200);
    // Writing on a board the token was not minted for: refused.
    const other = (await body(await t.api(admin, acmeId).get(`/boards/${board2Id}/items`))).data[0];
    expect((await asExt(token, 'POST', `/items/${other.id}/updates`, { body: 'x' })).status).toBe(404);
  });

  it('the settings page: admins only, and its token reads no board at all', async () => {
    expect((await mint(bob, { feature: 'settings' })).status).toBe(403);
    const tok = await body(await mint(admin, { feature: 'settings' }));
    expect(tok.board_ids).toEqual([]);
    expect((await asExt(tok.token, 'GET', `/boards/${boardId}/items`)).status).toBe(404);
    expect((await asExt(tok.token, 'GET', '/auth/me')).status).toBe(200);
  });

  it("a panel (): the installation's boards this person reads — never another board", async () => {
    const bobs = await body(await mint(bob, { feature: 'panel' }));
    // Bob reads Leads; Secret is private to its members; Deals is not allowed for the installation.
    expect(bobs.board_ids).toEqual([boardId]);
    expect(bobs.board_id).toBe('');
    expect((await asExt(bobs.token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
    expect((await asExt(bobs.token, 'GET', `/boards/${privateBoardId}/items`)).status).toBe(404);
    expect((await asExt(bobs.token, 'GET', `/boards/${board2Id}/items`)).status).toBe(404);
    const admins = await body(await mint(admin, { feature: 'panel' }));
    expect([...admins.board_ids].sort()).toEqual([boardId, privateBoardId].sort());
    expect((await mint(guest, { feature: 'panel' })).status).toBe(404);
  });
});

describe('dashboard widgets (ת5): only what the viewer may see', () => {
  let dashId: string;
  let widgetId: string;
  beforeAll(async () => {
    const d = await t.api(admin, acmeId).post(`/workspaces/${wsId}/dashboards`, {
      name: 'Overview',
      board_ids: [boardId, board2Id, privateBoardId],
    });
    expect(d.status).toBe(201);
    dashId = (await body(d)).id;
    const w = await t.api(admin, acmeId).post(`/dashboards/${dashId}/widgets`, {
      type: 'extension',
      settings: { installation_id: instId, feature: 'widget' },
    });
    expect(w.status, JSON.stringify(await w.clone().json())).toBe(201);
    widgetId = (await body(w)).id;
  });

  it("the token reads the dashboard's boards that this viewer reads and the extension is allowed on", async () => {
    const forBob = await body(await mint(bob, { feature: 'widget', dashboard_id: dashId, widget_id: widgetId }));
    expect(forBob.board_ids).toEqual([boardId]); // not Deals (extension), not Secret (bob)
    const forAdmin = await body(await mint(admin, { feature: 'widget', dashboard_id: dashId, widget_id: widgetId }));
    expect(forAdmin.board_ids).toEqual([boardId, privateBoardId]);
    expect((await asExt(forBob.token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
    expect((await asExt(forBob.token, 'GET', `/boards/${privateBoardId}/items`)).status).toBe(404);
    expect((await asExt(forBob.token, 'GET', `/boards/${board2Id}/items`)).status).toBe(404);
    expect((await asExt(forAdmin.token, 'GET', `/boards/${privateBoardId}/items`)).status).toBe(200);
    // Never the dashboard itself, nor another feature's or another widget's token.
    expect((await asExt(forBob.token, 'GET', `/dashboards/${dashId}`)).status).toBe(403);
    expect((await mint(bob, { feature: 'widget', dashboard_id: dashId, widget_id: 'x'.repeat(26) })).status).toBe(404);
    expect((await mint(bob, { feature: 'widget', dashboard_id: dashId })).status).toBe(400);
    const tamper = verifyExtToken(t.deps.env, forBob.token)!;
    expect(tamper.bs).toEqual([boardId]);
  });

  it('a viewer who cannot see the dashboard gets no token', async () => {
    const p = await body(
      await t.api(admin, acmeId).post(`/workspaces/${wsId}/dashboards`, { name: 'Mine', kind: 'private' }),
    );
    const w = await body(
      await t.api(admin, acmeId).post(`/dashboards/${p.id}/widgets`, {
        type: 'extension',
        settings: { installation_id: instId, feature: 'widget' },
      }),
    );
    expect((await mint(bob, { feature: 'widget', dashboard_id: p.id, widget_id: w.id })).status).toBe(404);
  });
});

describe('a board view with more boards (): picked on the tab, still only what the viewer may see', () => {
  const mkView = async (board: string, ext: Json) => {
    const res = await t
      .api(admin, acmeId)
      .post(`/boards/${board}/views`, { name: 'אימון', type: 'extension', settings: { extension: ext } });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return (await body(res)).id as string;
  };

  it("the tab's boards join the token: only those the viewer reads and the extension is allowed on", async () => {
    const viewId = await mkView(boardId, {
      installation_id: instId,
      feature: 'summary',
      board_ids: [privateBoardId, board2Id, boardId],
    });
    const forBob = await body(await mint(bob, { feature: 'summary', board_id: boardId, view_id: viewId }));
    expect(forBob.board_ids).toEqual([boardId]); // not Secret (bob cannot read it), not Deals (not allowed)
    const forAdmin = await body(await mint(admin, { feature: 'summary', board_id: boardId, view_id: viewId }));
    expect(forAdmin.board_ids).toEqual([boardId, privateBoardId]);
    expect(verifyExtToken(t.deps.env, forAdmin.token)!.bs).toEqual([boardId, privateBoardId]);
    // It writes there with the person's own rights, "via app".
    const made = await asExt(forAdmin.token, 'POST', `/boards/${privateBoardId}/items`, { name: 'נרשם מהתוסף' });
    expect(made.status, JSON.stringify(await made.clone().json())).toBe(201);
    expect((await asExt(forAdmin.token, 'GET', `/boards/${board2Id}/items`)).status).toBe(404);
    expect((await asExt(forBob.token, 'GET', `/boards/${privateBoardId}/items`)).status).toBe(404);
    // Without the tab: the one board, as before.
    expect((await body(await mint(admin, { feature: 'summary', board_id: boardId }))).board_ids).toEqual([boardId]);
  });

  it('a tab of another board, feature or installation adds nothing; other surfaces ignore it', async () => {
    const other = await mkView(privateBoardId, { installation_id: instId, feature: 'summary', board_ids: [boardId] });
    expect((await mint(admin, { feature: 'summary', board_id: boardId, view_id: other })).status).toBe(404);
    const wrongFeature = await mkView(boardId, {
      installation_id: instId,
      feature: 'tab',
      board_ids: [privateBoardId],
    });
    expect((await mint(admin, { feature: 'summary', board_id: boardId, view_id: wrongFeature })).status).toBe(404);
    // An item tab never takes a view's boards.
    const tab = await body(await mint(admin, { feature: 'tab', board_id: boardId, view_id: wrongFeature }));
    expect(tab.board_ids).toEqual([boardId]);
    // Too many boards on a tab is refused by the view schema.
    const tooMany = await t.api(admin, acmeId).post(`/boards/${boardId}/views`, {
      name: 'x',
      type: 'extension',
      settings: { extension: { installation_id: instId, feature: 'summary', board_ids: Array(21).fill(boardId) } },
    });
    expect(tooMany.status).toBe(400);
  });
});

describe("the extension's storage (ת5)", () => {
  it('per user and per installation, isolated, extension token only', async () => {
    const bobTok = await tokenFor(bob, { feature: 'tab', board_id: boardId });
    const adminTok = await tokenFor(admin, { feature: 'tab', board_id: boardId });
    expect((await asExt(bobTok, 'PUT', '/ext/storage/user/prefs', { value: { color: 'red' } })).status).toBe(200);
    expect((await asExt(adminTok, 'GET', '/ext/storage/user/prefs')).status).toBe(404);
    expect((await body(await asExt(bobTok, 'GET', '/ext/storage/user/prefs'))).value).toEqual({ color: 'red' });
    expect((await asExt(adminTok, 'PUT', '/ext/storage/installation/config', { value: { n: 1 } })).status).toBe(200);
    expect((await body(await asExt(bobTok, 'GET', '/ext/storage/installation/config'))).value).toEqual({ n: 1 });
    const list = await body(await asExt(bobTok, 'GET', '/ext/storage/user'));
    expect(list.data.map((x: Json) => x.key)).toEqual(['prefs']);
    expect(list.quota_bytes).toBe(EXT_STORAGE_QUOTA_BYTES);
    // A session (or an API token) is not an extension: no storage.
    expect((await t.api(bob, acmeId).get('/ext/storage/user')).status).toBe(403);
    expect((await asExt(bobTok, 'PUT', '/ext/storage/user/bad key!', { value: 1 })).status).toBe(422);
    expect((await asExt(bobTok, 'DELETE', '/ext/storage/user/prefs')).status).toBe(200);
    expect((await asExt(bobTok, 'GET', '/ext/storage/user/prefs')).status).toBe(404);
  });

  it('viewers read the shared keys but do not change them', async () => {
    const tok = await tokenFor(vera, { feature: 'tab', board_id: boardId });
    expect((await asExt(tok, 'GET', '/ext/storage/installation/config')).status).toBe(200);
    expect((await asExt(tok, 'PUT', '/ext/storage/installation/config', { value: 2 })).status).toBe(403);
    expect((await asExt(tok, 'PUT', '/ext/storage/user/mine', { value: 2 })).status).toBe(200);
  });

  it('a value and the installation have a quota', async () => {
    const tok = await tokenFor(admin, { feature: 'tab', board_id: boardId });
    const big = 'x'.repeat(EXT_STORAGE_VALUE_MAX_BYTES);
    const tooBig = await asExt(tok, 'PUT', '/ext/storage/user/big', { value: big });
    expect(tooBig.status).toBe(413);
    const chunk = 'y'.repeat(EXT_STORAGE_VALUE_MAX_BYTES - 100);
    let refused: Json | null = null;
    for (let i = 0; i < 40 && !refused; i++) {
      const res = await asExt(tok, 'PUT', `/ext/storage/installation/fill-${i}`, { value: chunk });
      if (res.status !== 200) refused = { status: res.status, body: await body(res) };
    }
    expect(refused).toMatchObject({ status: 413, body: { error: { message: 'storage_quota_exceeded' } } });
    // Overwriting a key with a smaller value is fine, and freeing space lets writes in again.
    expect((await asExt(tok, 'PUT', '/ext/storage/installation/fill-0', { value: 1 })).status).toBe(200);
    expect((await asExt(tok, 'PUT', '/ext/storage/installation/again', { value: 'small' })).status).toBe(200);
  });
});

describe('files.upload (ת5): through the assets, attached with the user rights', () => {
  it('uploads ≤ 4 MB with items:write, then attaches to a file cell "via app"', async () => {
    const token = await tokenFor(bob, { feature: 'tab', board_id: boardId });
    const item = (await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items`))).data.find(
      (i: Json) => i.name === 'Lead A',
    );
    const up = await asExt(token, 'POST', '/ext/files?name=report.pdf&mime=application/pdf', undefined, {
      raw: Buffer.from('%PDF-1.4 hello'),
      contentType: 'application/octet-stream',
    });
    expect(up.status, JSON.stringify(await up.clone().json())).toBe(200);
    const file = await body(up);
    expect(file).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', size: 14 });
    const attach = await asExt(token, 'POST', `/items/${item.id}/cells/docs/files`, { file_ids: [file.id] });
    expect(attach.status).toBe(200);
    const ev = (
      await t.db.select().from(activityLog).where(eq(activityLog.itemId, item.id)).orderBy(asc(activityLog.id))
    ).at(-1)!;
    expect((ev.payload as Json).meta).toMatchObject({ via: 'app' });
    const huge = await asExt(token, 'POST', '/ext/files?name=big.bin', undefined, {
      raw: Buffer.alloc(EXT_UPLOAD_MAX_BYTES + 1),
      contentType: 'application/octet-stream',
    });
    expect(huge.status).toBe(413);
    // A viewer may not upload; a session is not an extension.
    const veraTok = await tokenFor(vera, { feature: 'tab', board_id: boardId });
    expect(
      (
        await asExt(veraTok, 'POST', '/ext/files?name=a.txt', undefined, {
          raw: Buffer.from('a'),
          contentType: 'text/plain',
        })
      ).status,
    ).toBe(403);
  });
});

describe('automation blocks (ת4)', () => {
  let secret: string;
  let autoId: string;
  beforeAll(async () => {
    expect((await t.api(bob, acmeId).get(`/extensions/installations/${instId}/secret`)).status).toBe(403);
    secret = (await body(await t.api(admin, acmeId).get(`/extensions/installations/${instId}/secret`))).secret;
    expect(secret).toMatch(/^bos_extw_/);
    expect((await t.db.select().from(auditLog).where(eq(auditLog.action, 'extension.secret_viewed'))).length).toBe(1);
  });

  it('the builder gets the blocks with their forms; a recipe must name a block of an allowed board, inputs filled', async () => {
    const blocks = await body(await t.api(bob, acmeId).get(`/extensions/automation-blocks?board_id=${boardId}`));
    expect(blocks.actions).toEqual([
      expect.objectContaining({ block: 'kit.send', name: 'שלח הודעה', inputs: expect.any(Array) }),
    ]);
    expect(blocks.actions[0].inputs[0]).toMatchObject({ key: 'message', type: 'template', required: true });
    expect(blocks.triggers).toEqual([expect.objectContaining({ block: 'kit.incoming' })]);
    expect(
      (await body(await t.api(bob, acmeId).get(`/extensions/automation-blocks?board_id=${board2Id}`))).actions,
    ).toEqual([]);

    const save = (board: string, action: Json) =>
      t.api(admin, acmeId).post(`/boards/${board}/automations`, {
        recipe: { trigger: { type: 'item_created' }, actions: [action] },
      });
    const missing = await save(boardId, { type: 'run_extension', block: 'kit.send', input: {} });
    expect(missing.status).toBe(422);
    expect((await body(missing)).error.details.issues).toEqual([
      expect.objectContaining({ path: 'actions.0.input.message', code: 'extension_input_missing' }),
    ]);
    const unknown = await save(boardId, { type: 'run_extension', block: 'kit.nope', input: {} });
    expect((await body(unknown)).error.details.issues[0].code).toBe('extension_block_not_found');
    const offBoard = await save(board2Id, { type: 'run_extension', block: 'kit.send', input: { message: 'x' } });
    expect(offBoard.status).toBe(422);
    const ok = await save(boardId, {
      type: 'run_extension',
      block: 'kit.send',
      input: { message: 'שלום {item.name}', urgent: true, stray: 'dropped' },
    });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(201);
    autoId = (await body(ok)).id;
  });

  it('runs: a signed POST with the item, the rendered input and a token; the call back is "via app" and in the chain', async () => {
    await drain();
    hits.length = 0;
    mode = 'ok';
    const item = await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Dana' }));
    await drain();
    const hit = hits.find((h) => h.path === '/run')!;
    expect(hit).toBeDefined();
    // Our signature verifies with the installation's secret (and only once — a replay is refused).
    const sig = {
      timestamp: String(hit.headers['x-bines-timestamp']),
      signature: String(hit.headers['x-bines-signature']),
    };
    expect(verifyExtSignature(secret, { ...sig, body: hit.raw })).toBe('ok');
    expect(verifyExtSignature(secret, { ...sig, body: hit.raw })).toBe('replay');
    expect(hit.headers['x-bines-installation']).toBe(instId);
    expect(hit.body).toMatchObject({
      type: 'automation_action',
      block: 'kit.send',
      automation_id: autoId,
      item: { id: item.id, name: 'Dana' },
      input: { message: 'שלום Dana', urgent: true },
      attempt: 1,
    });
    expect(hit.body.input.stray).toBeUndefined();
    const run = (
      await t.db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, autoId))
        .orderBy(asc(automationRuns.id))
    ).at(-1)!;
    expect(run.status).toBe('succeeded');
    expect((run.actionsLog as Json[])[0]).toMatchObject({
      type: 'run_extension',
      status: 'ok',
      output: { http_status: 200, attempts: 1, result: { sent: true } },
    });
    // The extension's server writes back with the token from the call (no Origin: a server).
    const back = await asExt(
      hit.body.token.token,
      'POST',
      `/items/${item.id}/updates`,
      { body: 'נשלח' },
      { origin: null },
    );
    expect(back.status).toBe(200);
    const ev = (await t.db.select().from(activityLog).where(eq(activityLog.itemId, item.id))).find(
      (e) => e.type === 'update.created',
    )!;
    expect((ev.payload as Json).meta).toMatchObject({
      via: 'app',
      automation: { automation_id: autoId, depth: 1 },
    });
    // The token reads only the automation's board.
    expect(
      (await asExt(hit.body.token.token, 'GET', `/boards/${board2Id}/items`, undefined, { origin: null })).status,
    ).toBe(404);
  });

  it('a failure is recorded in the run; a server error retries (attempt 2) and the run follows', async () => {
    hits.length = 0;
    mode = 'fail500';
    await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Flaky' });
    await drain();
    let run = (
      await t.db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, autoId))
        .orderBy(asc(automationRuns.id))
    ).at(-1)!;
    expect(run.status).toBe('failed');
    expect((run.actionsLog as Json[])[0]).toMatchObject({ status: 'error', error: 'http_500' });
    // The queue's next attempt (driven by hand here: no queue in tests).
    mode = 'ok';
    const hit = hits.find((h) => h.path === '/run')!;
    const { token: _token, attempt: _attempt, ...callBody } = hit.body;
    void _token;
    void _attempt;
    const r = await retryExtensionCall(t.deps, {
      ref: {
        account_id: acmeId,
        installation_id: instId,
        feature: 'send',
        run_id: run.id,
        automation_id: autoId,
        action_index: 0,
        user_id: adminId,
        board_id: boardId,
        depth: 1,
        chain: [],
      },
      body: callBody,
      attempt: 2,
    });
    expect(r.ok).toBe(true);
    expect(hits.at(-1)!.body.attempt).toBe(2);
    expect(hits.at(-1)!.headers['x-bines-attempt']).toBe('2');
    run = (await t.db.select().from(automationRuns).where(eq(automationRuns.id, run.id)))[0]!;
    expect(run.status).toBe('succeeded');
    expect((run.actionsLog as Json[])[0]).toMatchObject({ status: 'ok', output: { attempts: 2 } });
  });

  it('a 4xx is final (no retry); a private address is refused in production (SSRF)', async () => {
    mode = 'fail400';
    const ref = {
      account_id: acmeId,
      installation_id: instId,
      feature: 'send',
      run_id: 'r'.repeat(26),
      automation_id: autoId,
      action_index: 0,
      user_id: adminId,
      board_id: boardId,
      depth: 1,
      chain: [],
    };
    const r4 = await callExtension(t.deps, ref, {}, 1);
    expect(r4).toMatchObject({ ok: false, retry: false, error: 'http_400' });
    const prod = { ...t.deps, env: { ...t.deps.env, NODE_ENV: 'production' as const } };
    const before = hits.length;
    const ssrf = await callExtension(prod, ref, {}, 1);
    expect(ssrf).toMatchObject({ ok: false, retry: false, error: 'webhook_url_private' });
    expect(hits.length).toBe(before);
    mode = 'ok';
  });

  it("the extension's trigger: signed, fresh, once — then the board's automations run with its payload", async () => {
    const res = await t.api(admin, acmeId).post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'extension_trigger', block: 'kit.incoming', with_item: true },
        actions: [{ type: 'create_update', body: 'נכנס: {payload.text}' }],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    await drain();
    const item = await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Caller' }));
    await drain();
    const fire = (raw: string, headers: Record<string, string>, block = 'kit.incoming') =>
      t.app.request(`/api/v1/automations/triggers/${block}/fire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.9', ...headers },
        body: raw,
      });
    const raw = JSON.stringify({ item_id: item.id, payload: { text: 'שלום מהוואטסאפ' } });
    const ts = String(Date.now());
    const good = {
      'x-bines-installation': instId,
      'x-bines-timestamp': ts,
      'x-bines-signature': signExtBody(secret, ts, raw),
    };
    vi.mocked(enqueueJob).mockClear();
    const ok = await fire(raw, good);
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(202);
    const events = (await body(ok)).events as Json[];
    expect(events).toEqual([expect.objectContaining({ board_id: boardId, item_id: item.id })]);
    // The `extension_trigger.fired` event queued its dispatch (the queue exists in production; none here).
    expect(vi.mocked(enqueueJob).mock.calls.filter((c) => c[1] === 'automation.dispatch')).toEqual([
      [expect.anything(), 'automation.dispatch', { event_id: events[0]!.event_id, account_id: acmeId }],
    ]);
    await drain();
    const ups = await t.db.select().from(updates).where(eq(updates.itemId, item.id));
    expect(ups.map((u) => u.bodyText)).toContain('נכנס: שלום מהוואטסאפ');
    // The same call again (replay), a stale timestamp, a bad signature, another key / installation: refused.
    expect((await fire(raw, good)).status).toBe(401);
    const old = String(Date.now() - 10 * 60_000);
    expect(
      (await fire(raw, { ...good, 'x-bines-timestamp': old, 'x-bines-signature': signExtBody(secret, old, raw) }))
        .status,
    ).toBe(401);
    const ts2 = String(Date.now());
    expect(
      (await fire(raw, { ...good, 'x-bines-timestamp': ts2, 'x-bines-signature': signExtBody('wrong', ts2, raw) }))
        .status,
    ).toBe(401);
    expect((await fire(raw, { ...good, 'x-bines-installation': 'x'.repeat(26) })).status).toBe(404);
    expect((await fire(raw, good, 'kit.nope')).status).toBe(404);
  });

  it('trigger inputs (): an automation set to a button runs only for its fires; one without, for all', async () => {
    // Only the trigger's own inputs may be stored.
    const unknown = await t.api(admin, acmeId).post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'extension_trigger', block: 'kit.incoming', inputs: { other: 'x' } },
        actions: [{ type: 'create_update', body: 'x' }],
      },
    });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(await body(unknown))).toContain('extension_input_unknown');
    const res = await t.api(admin, acmeId).post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'extension_trigger', block: 'kit.incoming', with_item: true, inputs: { button: 'b-1' } },
        actions: [{ type: 'create_update', body: 'כפתור 1: {payload.text}' }],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect((await body(res)).recipe.trigger.inputs).toEqual({ button: 'b-1' });
    // The builder offers the field.
    const blocks = await body(await t.api(admin, acmeId).get(`/extensions/automation-blocks?board_id=${boardId}`));
    expect((blocks.triggers as Json[]).find((b) => b.block === 'kit.incoming')!.inputs).toEqual([
      { key: 'button', label: 'כפתור', label_en: null, type: 'text', placeholder: null },
    ]);
    await drain();
    const item = await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Buttons' }));
    await drain();
    const fireWith = async (payload: Json, ip: string) => {
      const raw = JSON.stringify({ item_id: item.id, payload });
      const ts = String(Date.now());
      const r = await t.app.request('/api/v1/automations/triggers/kit.incoming/fire', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
          'x-bines-installation': instId,
          'x-bines-timestamp': ts,
          'x-bines-signature': signExtBody(secret, ts, raw),
        },
        body: raw,
      });
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(202);
      await drain();
      return (await t.db.select().from(updates).where(eq(updates.itemId, item.id))).map((u) => u.bodyText);
    };
    // Another button: only the automation without inputs (as before) runs.
    const other = await fireWith({ button: 'b-2', text: 'שני' }, '198.51.100.21');
    expect(other).toContain('נכנס: שני');
    expect(other.some((x) => x?.startsWith('כפתור 1'))).toBe(false);
    // Its own button: both run.
    const own = await fireWith({ button: 'b-1', text: 'ראשון' }, '198.51.100.22');
    expect(own).toContain('נכנס: ראשון');
    expect(own).toContain('כפתור 1: ראשון');
  });

  it('rotating the secret: the old one stops at once', async () => {
    const rotated = await body(
      await t.api(admin, acmeId).post(`/extensions/installations/${instId}/secret/rotate`, {}),
    );
    expect(rotated.secret).not.toBe(secret);
    const raw = JSON.stringify({ payload: {} });
    const ts = String(Date.now());
    const res = await t.app.request('/api/v1/automations/triggers/kit.incoming/fire', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.10',
        'x-bines-installation': instId,
        'x-bines-timestamp': ts,
        'x-bines-signature': signExtBody(secret, ts, raw),
      },
      body: raw,
    });
    expect(res.status).toBe(401);
    secret = rotated.secret;
  });
});

describe('the kill switch stops every surface', () => {
  it('features, tokens, storage, uploads, automation calls and triggers — and they come back', async () => {
    const token = await tokenFor(bob, { feature: 'tab', board_id: boardId });
    const secret = (await body(await t.api(admin, acmeId).get(`/extensions/installations/${instId}/secret`))).secret;
    expect((await t.api(owner).post('/platform/extensions/kill', { key: 'kit', reason: 'leak' })).status).toBe(200);
    expect((await body(await t.api(bob, acmeId).get(`/extensions/features?board_id=${boardId}`))).data).toEqual([]);
    expect((await body(await t.api(bob, acmeId).get('/extensions/automation-blocks'))).actions).toEqual([]);
    expect((await mint(bob, { feature: 'tab', board_id: boardId })).status).toBe(404);
    expect((await asExt(token, 'GET', '/ext/storage/installation/config')).status).toBe(401);
    expect((await asExt(token, 'GET', `/boards/${boardId}/items`)).status).toBe(401);
    // An automation that calls it records the failure.
    hits.length = 0;
    await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'While killed' });
    await drain();
    expect(hits.filter((h) => h.path === '/run')).toEqual([]);
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.accountId, acmeId));
    const last = runs.filter((r) => (r.actionsLog as Json[])[0]?.type === 'run_extension').at(-1)!;
    expect((last.actionsLog as Json[])[0]).toMatchObject({ status: 'error', error: 'extension_unavailable' });
    const raw = JSON.stringify({ payload: {} });
    const ts = String(Date.now());
    const fired = await t.app.request('/api/v1/automations/triggers/kit.incoming/fire', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.11',
        'x-bines-installation': instId,
        'x-bines-timestamp': ts,
        'x-bines-signature': signExtBody(secret, ts, raw),
      },
      body: raw,
    });
    expect(fired.status).toBe(404);
    expect((await t.api(owner).del('/platform/extensions/kill/kit')).status).toBe(200);
    expect((await asExt(token, 'GET', '/ext/storage/installation/config')).status).toBe(200);
    expect((await body(await t.api(bob, acmeId).get(`/extensions/features?board_id=${boardId}`))).data.length).toBe(6);
  });

  it('disabling the installation stops them too', async () => {
    const tab = await tokenFor(bob, { feature: 'tab', board_id: boardId });
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { status: 'disabled' });
    expect((await asExt(tab, 'PUT', '/ext/storage/user/x', { value: 1 })).status).toBe(401);
    expect((await body(await t.api(bob, acmeId).get('/extensions/features'))).data).toEqual([]);
    await t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, { status: 'enabled' });
  });
});

describe('audit 2026-10-10 security #18 — a frame token is the frame’s', () => {
  it('a request without an Origin header is refused (a browser always sends one from the iframe)', async () => {
    const token = await tokenFor(bob, { feature: 'tab', board_id: boardId });
    expect((await asExt(token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
    expect((await asExt(token, 'GET', `/boards/${boardId}/items`, undefined, { origin: null })).status).toBe(401);
  });
});
