// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiredScope } from '../src/lib/scopes';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** r18boardviews: who viewed a board and how long ago — throttle, permissions, the switch, isolation. */
let t: TestContext;
let admin: string;
let bob: string;
let carol: string; // a member who cannot see the closed-workspace board
let guest: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let boardId: string;
let secretBoard: string;
const id: Record<string, string> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const open = (cookie: string, board = boardId, ua = CHROME_WIN) =>
  as(cookie).call('POST', `/boards/${board}/viewers`, undefined, { 'user-agent': ua });
const viewers = async (cookie: string, board = boardId, query = '') =>
  body(await as(cookie).get(`/boards/${board}/viewers${query}`));
/** Moves everyone's last open on the board back by `minutes` (past the throttle window). */
const age = (minutes: number) =>
  t.db.execute(
    sql`update board_viewers set last_viewed_at = last_viewed_at - (${minutes} * interval '1 minute') where board_id = ${boardId}`,
  );

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  await as(admin).post('/users/invite', { emails: ['g@client.test'], role: 'guest' });
  guest = await join('g@client.test');
  for (const u of (await body(await as(admin).get('/users'))).data as Json[]) id[u.email.split('@')[0]] = u.user_id;

  betaId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
    )
  ).account.id;
  betaAdmin = await join('admin@beta.test');

  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Clients', workspace_id: ws, kind: 'shareable' }))).id;
  // A shareable board is read by its subscribers.
  for (const who of [id.g, id.bob, id.carol]) await as(admin).put(`/boards/${boardId}/members/${who}`, {});
  const closed = (await body(await as(admin).post('/workspaces', { name: 'Closed', kind: 'closed' }))).id;
  secretBoard = (await body(await as(admin).post('/boards', { name: 'Secret', workspace_id: closed }))).id;
});
afterAll(() => t.close());

describe('recording opens', () => {
  it('adds a person on the first open, with the device from the headers', async () => {
    expect(await body(await open(bob, boardId, SAFARI_IPHONE))).toEqual({ ok: true, recorded: true });
    const list = await viewers(admin);
    expect(list.enabled).toBe(true);
    expect(list.total).toBe(1);
    expect(list.data[0]).toMatchObject({
      id: id.bob,
      name: expect.any(String),
      view_count: 1,
      device: 'mobile',
      user_agent: 'Safari · iOS',
    });
    expect(Date.parse(list.data[0].last_viewed_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('writes at most once per 5 minutes per person and board', async () => {
    expect(await body(await open(bob))).toEqual({ ok: true, recorded: false });
    expect(await body(await open(bob))).toEqual({ ok: true, recorded: false });
    let row = (await viewers(admin)).data[0];
    expect(row.view_count).toBe(1);
    expect(row.device).toBe('mobile'); // untouched inside the window
    await age(6);
    expect(await body(await open(bob))).toEqual({ ok: true, recorded: true });
    row = (await viewers(admin)).data[0];
    expect(row.view_count).toBe(2);
    expect(row.device).toBe('desktop');
    expect(Date.parse(row.last_viewed_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('lists newest first and pages', async () => {
    await age(10);
    await open(admin);
    await open(guest);
    const all = await viewers(admin);
    expect(all.total).toBe(3);
    expect(all.data[all.data.length - 1].id).toBe(id.bob); // the oldest open
    const first = await viewers(admin, boardId, '?limit=2');
    expect(first.data).toHaveLength(2);
    expect(first.next_cursor).toBe('2');
    const second = await viewers(admin, boardId, `?limit=2&cursor=${first.next_cursor}`);
    expect(second.data.map((v: Json) => v.id)).toEqual([id.bob]);
    expect(second.next_cursor).toBeNull();
  });
});

describe('recent viewers', () => {
  it("counts who opened within the account's window (24 h by default); an admin changes the window", async () => {
    const now = await viewers(admin);
    expect(now).toMatchObject({ recent_hours: 24, recent_total: now.total });
    // Everyone's last open two days ago: still listed, no longer recent.
    await age(48 * 60);
    const old = await viewers(admin);
    expect(old.total).toBe(now.total);
    expect(old.recent_total).toBe(0);
    const wide = await as(admin).patch('/accounts/me', {
      settings: { permissions: { board_viewers_recent_hours: 72 } },
    });
    expect((await body(wide)).settings.permissions.board_viewers_recent_hours).toBe(72);
    expect(await viewers(admin)).toMatchObject({ recent_hours: 72, recent_total: now.total });
    expect(
      (await as(admin).patch('/accounts/me', { settings: { permissions: { board_viewers_recent_hours: 0 } } })).status,
    ).toBe(400);
    await as(admin).patch('/accounts/me', { settings: { permissions: { board_viewers_recent_hours: 24 } } });
  });
});

describe('permissions', () => {
  it('only people who can read the board may report or list (404 otherwise)', async () => {
    expect((await open(carol, secretBoard)).status).toBe(404);
    expect((await as(carol).get(`/boards/${secretBoard}/viewers`)).status).toBe(404);
    expect((await open(admin, secretBoard)).status).toBe(200);
    expect((await viewers(admin, secretBoard)).total).toBe(1);
  });

  it('a guest sees only themselves', async () => {
    const list = await viewers(guest);
    expect(list.total).toBe(1);
    expect(list.data.map((v: Json) => v.id)).toEqual([id.g]);
    // Staff see the guest among everyone else.
    expect((await viewers(bob)).data.map((v: Json) => v.id)).toContain(id.g);
  });

  it('reading needs boards:read on a token; reporting an open is never a token', () => {
    expect(requiredScope('GET', '/boards/x/viewers')).toEqual({ scope: 'boards:read' });
    expect(requiredScope('POST', '/boards/x/viewers')).toEqual({ forbidden: true });
  });
});

describe('the account switch (settings.permissions.show_board_viewers)', () => {
  it('is on by default; off = nothing listed and nothing recorded', async () => {
    const me = await body(await as(admin).get('/accounts/me'));
    expect(me.settings.permissions.show_board_viewers).toBe(true);
    const off = await as(admin).patch('/accounts/me', { settings: { permissions: { show_board_viewers: false } } });
    expect((await body(off)).settings.permissions.show_board_viewers).toBe(false);
    expect(await viewers(admin)).toEqual({
      data: [],
      total: 0,
      next_cursor: null,
      enabled: false,
      recent_hours: 24,
      recent_total: 0,
    });
    await age(10);
    expect(await body(await open(carol))).toEqual({ ok: true, recorded: false });
    await as(admin).patch('/accounts/me', { settings: { permissions: { show_board_viewers: true } } });
    const back = await viewers(admin);
    expect(back.enabled).toBe(true);
    expect(back.data.map((v: Json) => v.id)).not.toContain(id.carol);
  });
});

describe('cross-account isolation', () => {
  it("another account's admin can neither report nor read this board's viewers", async () => {
    expect((await t.api(betaAdmin, betaId).call('POST', `/boards/${boardId}/viewers`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).get(`/boards/${boardId}/viewers`)).status).toBe(404);
    // Even naming Acme in the header does not help someone who is not in it.
    expect((await t.api(betaAdmin, acmeId).get(`/boards/${boardId}/viewers`)).status).not.toBe(200);
    const rows = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from board_viewers where account_id <> ${acmeId}`,
    );
    expect((rows as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(0);
  });

  it('deactivated people drop out of the list', async () => {
    await t.db.execute(
      sql`update account_members set deactivated_at = now() where user_id = ${id.bob} and account_id = ${acmeId}`,
    );
    expect((await viewers(admin)).data.map((v: Json) => v.id)).not.toContain(id.bob);
  });
});
