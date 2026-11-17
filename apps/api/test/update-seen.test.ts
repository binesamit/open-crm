// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEN_EMIT_MS } from '../src/modules/updates/views.service';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * r16seen — "seen by" live: a first view (or a new device) goes out as `update.seen` on the board channel to whoever
 * may read the item, and on /me/events to those who have the update in their Inbox; coalesced per update.
 */
let t: TestContext;
let acmeId: string;
let admin: string;
let bob: string;
let carol: string;
let dave: string;
let boardId: string;
let itemId: string;
let peopleKey: string;
const ids: Record<string, string> = {};
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
const see = (cookie: string, updateIds: string[], ua = CHROME_WIN) =>
  as(cookie).call('POST', '/updates/views', { update_ids: updateIds }, { 'user-agent': ua });
const post = async (text: string) => (await body(await as(admin).post(`/items/${itemId}/updates`, { body: text }))).id;
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

type Stream = { events: Json[]; next: (pred: (e: Json) => boolean, ms?: number) => Promise<Json>; close: () => void };

/** Opens an SSE route the way EventSource does and collects the parsed messages. */
const open = async (cookie: string, path: string): Promise<Stream> => {
  const res = await t.app.request(`/api/v1${path}?account_id=${acmeId}`, { headers: { origin: WEB_ORIGIN, cookie } });
  expect(res.status).toBe(200);
  const events: Json[] = [];
  const waiters = new Set<() => void>();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let buf = '';
  void (async () => {
    while (!done) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const data = buf
          .slice(0, cut)
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        buf = buf.slice(cut + 2);
        if (!data) continue;
        events.push(JSON.parse(data));
        for (const w of [...waiters]) w();
      }
    }
  })();
  const next = (pred: (e: Json) => boolean, ms = 3000) =>
    new Promise<Json>((resolve, reject) => {
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
    });
  await next((e) => e.type === 'ready');
  return {
    events,
    next,
    close: () => {
      done = true;
      void reader.cancel().catch(() => {});
    },
  };
};
const seenOf = (s: Stream, updateId: string) =>
  s.events.filter((e) => e.type === 'update.seen' && e.update_id === updateId);

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
  await t
    .api(admin, acmeId)
    .post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test', 'dave@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  dave = await join('dave@acme.test');
  for (const u of (await body(await as(admin).get('/users'))).data as Json[]) ids[u.email] = u.user_id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'פניות', workspace_id: ws }))).id;
  peopleKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Owner', type: 'people' }))).id;
  // Only assigned people (and admins) see items: bob and dave are on this one, carol is not.
  await as(admin).put(`/boards/${boardId}/permissions`, {
    view_items: { mode: 'assigned_or_created', column_ids: 'any_people' },
  });
  itemId = (
    await body(
      await as(admin).post(`/boards/${boardId}/items`, {
        name: 'פנייה 1',
        cells: {
          [peopleKey]: {
            persons_and_teams: [
              { kind: 'person', id: ids['bob@acme.test'] },
              { kind: 'person', id: ids['dave@acme.test'] },
            ],
          },
        },
      }),
    )
  ).id;
  // dave follows the item: its updates are in his Inbox.
  expect((await as(dave).put(`/items/${itemId}/follow`, { following: true })).status).toBe(200);
});
afterAll(() => t.close());

describe('update.seen on the board channel', () => {
  it('reaches a reader of the item (the author) and the viewer, never one who may not see the item', async () => {
    const updateId = await post('שלום');
    const owner = await open(admin, `/boards/${boardId}/events`);
    const viewer = await open(bob, `/boards/${boardId}/events`);
    const hidden = await open(carol, `/boards/${boardId}/events`);

    expect((await body(await see(bob, [updateId]))).recorded).toBe(1);
    const e = await owner.next((x) => x.type === 'update.seen' && x.update_id === updateId);
    expect(e).toMatchObject({ board_id: boardId, item_id: itemId, seen: { count: 1 } });
    expect(e.id ?? '').toBe(''); // not in the activity log: never part of a Last-Event-ID replay
    expect(e.seen.users[0]).toMatchObject({ id: ids['bob@acme.test'], devices: [{ device: 'desktop' }] });
    // The viewer hears their own view (product decision: they see themselves appear).
    await viewer.next((x) => x.type === 'update.seen' && x.update_id === updateId);
    await settle();
    expect(seenOf(hidden, updateId)).toHaveLength(0);
    // No other event rode along (no activity row, no row refresh).
    expect(owner.events.filter((x) => x.type !== 'ready' && x.type !== 'update.seen')).toHaveLength(0);
    owner.close();
    viewer.close();
    hidden.close();
  });

  it('goes out for a first view or a new device only, coalesced per update', async () => {
    const updateId = await post('עוד');
    const owner = await open(admin, `/boards/${boardId}/events`);
    await see(bob, [updateId]);
    await owner.next((x) => x.type === 'update.seen' && x.update_id === updateId);
    // Within the window: dave (a new viewer) and bob on a phone (a new device) → one more event at its end.
    await see(dave, [updateId]);
    await see(bob, [updateId], SAFARI_IPHONE);
    await settle();
    expect(seenOf(owner, updateId)).toHaveLength(1);
    const last = await owner.next(
      (x) => x.type === 'update.seen' && x.update_id === updateId && x.seen.count === 2,
      SEEN_EMIT_MS + 2000,
    );
    const bobRow = last.seen.users.find((u: Json) => u.id === ids['bob@acme.test']);
    expect(bobRow.devices.map((d: Json) => d.device).sort()).toEqual(['desktop', 'mobile']);
    await settle(SEEN_EMIT_MS + 300);
    expect(seenOf(owner, updateId)).toHaveLength(2);
    // Seeing it again on a known device is not news.
    await see(dave, [updateId]);
    await settle();
    expect(seenOf(owner, updateId)).toHaveLength(2);
    owner.close();
  });

  it("the author's own view is still not counted (no event)", async () => {
    const updateId = await post('שלי');
    const owner = await open(admin, `/boards/${boardId}/events`);
    expect((await body(await see(admin, [updateId]))).recorded).toBe(0);
    await settle();
    expect(seenOf(owner, updateId)).toHaveLength(0);
    owner.close();
  });
});

describe('update.seen on /me/events (Inbox)', () => {
  it('reaches whoever has the update in their Inbox, not the author or others', async () => {
    const updateId = await post('לאינבוקס');
    const follower = await open(dave, '/me/events');
    const author = await open(admin, '/me/events');
    const outsider = await open(carol, '/me/events');
    await see(bob, [updateId]);
    const e = await follower.next((x) => x.type === 'update.seen' && x.update_id === updateId);
    expect(e.seen.count).toBe(1);
    await settle();
    expect(seenOf(author, updateId)).toHaveLength(0);
    expect(seenOf(outsider, updateId)).toHaveLength(0);
    follower.close();
    author.close();
    outsider.close();
  });

  it('the Inbox entries carry `seen`', async () => {
    const updateId = await post('נראה באינבוקס');
    await see(bob, [updateId]);
    const inbox = (await body(await as(dave).get('/me/inbox'))).data as Json[];
    const entry = inbox.find((x) => x.id === updateId)!;
    expect(entry.seen).toMatchObject({ count: 1, users: [{ id: ids['bob@acme.test'] }] });
  });
});
