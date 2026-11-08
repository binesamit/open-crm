// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { activityLog, notifications } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/** 01 §4: SSE board/personal channels — fan-out on commit, permissions + view_items, Last-Event-ID replay. */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let otherId: string;
let ids: Record<'admin' | 'bob', string>;
let boardId: string;
let peopleKey: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

type Stream = {
  status: number;
  events: Json[];
  next: (pred: (e: Json) => boolean, ms?: number) => Promise<Json>;
  close: () => Promise<void>;
};

/** Opens an SSE route the way EventSource does (cookie + ?account_id=) and collects parsed messages. */
const open = async (cookie: string, path: string, opts: { lastId?: string; account?: string } = {}) => {
  const res = await t.app.request(`/api/v1${path}?account_id=${opts.account ?? acmeId}`, {
    headers: { origin: WEB_ORIGIN, cookie, ...(opts.lastId ? { 'last-event-id': opts.lastId } : {}) },
  });
  const events: Json[] = [];
  const waiters = new Set<() => void>();
  const stream: Stream = {
    status: res.status,
    events,
    next: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const hit = events.find(pred);
          if (!hit) return false;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.type))}`));
        }, ms);
        if (!check()) waiters.add(check);
      }),
    close: async () => {},
  };
  if (res.status !== 200) return stream;
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;
  void (async () => {
    while (!done) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        const id = /^id: ?(.*)$/m.exec(block)?.[1];
        events.push({ ...JSON.parse(data), sse_id: id });
        for (const w of [...waiters]) w();
      }
    }
  })();
  stream.close = async () => {
    done = true;
    await reader.cancel().catch(() => {});
  };
  await stream.next((e) => e.type === 'ready');
  return stream;
};

/** Gives stray events time to arrive before asserting that none did. */
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'boss@other.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test') };
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Live', workspace_id: ws.id }))).id;
  peopleKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Owner', type: 'people' }))).id;
});
afterAll(() => t.close());

describe('board channel', () => {
  it('needs a session, an account and a readable board', async () => {
    const res = await t.app.request(`/api/v1/boards/${boardId}/events`, { headers: { origin: WEB_ORIGIN } });
    expect(res.status).toBe(401);
    expect((await t.app.request(`/api/v1/boards/${boardId}/events`, { headers: { cookie: bob } })).status).toBe(400);
    expect((await open(bob, `/boards/${newId()}/events`)).status).toBe(404);
    expect((await open(bob, `/boards/${boardId}/events`, { account: otherId })).status).toBe(404);
  });

  it("delivers another user's committed change with its ids and request id", async () => {
    const s = await open(bob, `/boards/${boardId}/events`);
    const res = await as(admin).call(
      'POST',
      `/boards/${boardId}/items`,
      { name: 'Live one' },
      { 'x-request-id': 'tab_abc123-1' },
    );
    const item = await body(res);
    const e = await s.next((x) => x.type === 'item.created');
    expect(e).toMatchObject({ board_id: boardId, item_id: item.id, actor_id: ids.admin, request_id: 'tab_abc123-1' });
    expect(e.sse_id).toBe(e.id);
    await s.close();
  });

  it('does not deliver events of another board or of a failed write', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    const other = (await body(await as(admin).post('/boards', { name: 'Elsewhere', workspace_id: ws.id }))).id;
    const s = await open(bob, `/boards/${boardId}/events`);
    await as(admin).post(`/boards/${other}/items`, { name: 'Not here' });
    expect((await as(admin).post(`/boards/${boardId}/items`, { name: '' })).status).toBe(400);
    await settle();
    expect(s.events.map((e) => e.type)).toEqual(['ready']);
    await s.close();
  });

  it('carries sub-board events on the parent board channel (D14)', async () => {
    const parent = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Parent' }));
    const s = await open(bob, `/boards/${boardId}/events`);
    const sub = await body(await as(admin).post(`/items/${parent.id}/subitems`, { name: 'Child' }));
    const e = await s.next((x) => x.type === 'item.created' && x.item_id === sub.id);
    expect(e.board_id).not.toBe(boardId);
    await s.close();
  });

  it('hides events on items the viewer may not see (view_items)', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, {
      view_items: { mode: 'assigned_or_created', column_ids: 'any_people' },
    });
    const s = await open(bob, `/boards/${boardId}/events`);
    await as(admin).post(`/boards/${boardId}/items`, { name: 'Secret' });
    const mine = await body(
      await as(admin).post(`/boards/${boardId}/items`, {
        name: 'For bob',
        cells: { [peopleKey]: { persons_and_teams: [{ kind: 'person', id: ids.bob }] } },
      }),
    );
    const e = await s.next((x) => x.type === 'item.created');
    expect(e.item_id).toBe(mine.id);
    await settle();
    expect(s.events.filter((x) => x.type === 'item.created')).toHaveLength(1);

    // Unassigned: the change that hides the item still reaches bob (his client drops it); later ones do not.
    await as(admin).put(`/items/${mine.id}/cells/${peopleKey}`, { value: { persons_and_teams: [] } });
    const gone = await s.next((x) => x.item_id === mine.id && x.type !== 'item.created');
    expect(gone.type).toMatch(/^cell\./);
    const before = s.events.length;
    await as(admin).patch(`/items/${mine.id}`, { name: 'Not for bob' });
    await settle();
    expect(s.events.slice(before).filter((x) => x.item_id === mine.id)).toHaveLength(0);
    await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'all' } });
    await s.close();
  });

  it('a team change reaches the board stream (visibility may have changed)', async () => {
    const s = await open(bob, `/boards/${boardId}/events`);
    await as(admin).post('/teams', { name: `Live team ${Date.now()}`, member_ids: [ids.bob] });
    const e = await s.next((x) => String(x.type).startsWith('team.'));
    expect(e.type).toMatch(/^team\./);
    await s.close();
  });

  it('replays what was missed after Last-Event-ID, or asks for a resync', async () => {
    const s = await open(bob, `/boards/${boardId}/events`);
    await as(admin).post(`/boards/${boardId}/items`, { name: 'Seen' });
    const seen = await s.next((x) => x.type === 'item.created');
    await s.close();
    const missed = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Missed' }));

    const again = await open(bob, `/boards/${boardId}/events`, { lastId: seen.id });
    const e = await again.next((x) => x.type === 'item.created' && x.item_id === missed.id);
    expect(e.id > seen.id).toBe(true);
    expect(again.events.some((x) => x.id === seen.id)).toBe(false);
    await again.close();

    const stale = await open(bob, `/boards/${boardId}/events`, { lastId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    await stale.next((x) => x.type === 'resync');
    await stale.close();
  });

  it('replays a row whose transaction started long before the last id (replay by id, audit 2026-10-10 #6)', async () => {
    const s = await open(bob, `/boards/${boardId}/events`);
    await as(admin).post(`/boards/${boardId}/items`, { name: 'Before the bulk' });
    const seen = await s.next((x) => x.type === 'item.created');
    await s.close();
    // A bulk write that began two minutes ago and committed after the client dropped: its rows carry
    // `created_at` = the transaction's start (`now()`), well before the last id's moment.
    const late = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Late commit' }));
    const lateEvent = (
      await t.db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(eq(activityLog.itemId, late.id), eq(activityLog.type, 'item.created')))
    )[0]!;
    await t.db
      .update(activityLog)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(activityLog.id, lateEvent.id));
    const again = await open(bob, `/boards/${boardId}/events`, { lastId: seen.id });
    const e = await again.next((x) => x.type === 'item.created' && x.item_id === late.id);
    expect(e.id).toBe(lateEvent.id); // by `created_at` it was outside the window and never replayed
    await again.close();
  });

  it('closes with `revoked` when the board goes away', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    const temp = (await body(await as(admin).post('/boards', { name: 'Temp', workspace_id: ws.id }))).id;
    const s = await open(bob, `/boards/${temp}/events`);
    await as(admin).del(`/boards/${temp}`);
    await s.next((x) => x.type === 'revoked');
    await s.close();
  });
});

describe('personal channel', () => {
  it('delivers a notification only to its user, and replays it', async () => {
    const mine = await open(bob, '/me/events');
    const theirs = await open(admin, '/me/events');
    const id = newId();
    await t.db.insert(notifications).values({ id, accountId: acmeId, userId: ids.bob, type: 'time.forgotten' });
    const e = await mine.next((x) => x.type === 'notification.created');
    expect(e.id).toBe(id);
    await settle();
    expect(theirs.events.map((x) => x.type)).toEqual(['ready']);
    await Promise.all([mine.close(), theirs.close()]);

    const later = newId();
    await t.db.insert(notifications).values({ id: later, accountId: acmeId, userId: ids.bob, type: 'time.forgotten' });
    const again = await open(bob, '/me/events', { lastId: id });
    await again.next((x) => x.type === 'notification.created' && x.id === later);
    await again.close();
  });
  it('tells my other tabs when I mark notifications read', async () => {
    const tab = await open(bob, '/me/events');
    const theirs = await open(admin, '/me/events');
    expect((await as(bob).post('/me/notifications/read', { all: true })).status).toBe(200);
    await tab.next((x) => x.type === 'notification.read');
    await settle();
    expect(theirs.events.map((x) => x.type)).toEqual(['ready']);
    await Promise.all([tab.close(), theirs.close()]);
  });
});
