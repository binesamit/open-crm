// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { notifications } from '../src/db/schema';
import { notifyUsers } from '../src/modules/notifications/notify';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 07 §9.3 (M4 step 2): who gets a notification, never for oneself, never about an item one cannot see. */
let t: TestContext;
let admin: string;
let bob: string;
let dana: string; // in team Sales
let carol: string; // viewer
let acmeId: string;
let ids: Record<'admin' | 'bob' | 'dana' | 'carol', string>;
let boardId: string;
let peopleKey: string;
let salesId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const inbox = async (cookie: string, query = '') => body(await as(cookie).get(`/me/notifications${query}`));
const mention = (name: string, id: string) => `[@${name}](user:${id})`;
const newItem = async (name: string) => (await body(await as(admin).post(`/boards/${boardId}/items`, { name }))).id;
const assign = (itemId: string, who: { kind: 'person' | 'team'; id: string }[]) =>
  as(admin).put(`/items/${itemId}/cells/${peopleKey}`, { value: { persons_and_teams: who } });

beforeAll(async () => {
  t = await createTestContext();
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test', 'dana@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  dana = await join('dana@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = {
    admin: idOf('admin@acme.test'),
    bob: idOf('bob@acme.test'),
    dana: idOf('dana@acme.test'),
    carol: idOf('carol@acme.test'),
  };
  salesId = (await body(await as(admin).post('/teams', { name: 'Sales', member_ids: [ids.dana] }))).id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: ws.id }))).id;
  peopleKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Owner', type: 'people' }))).id;
});
afterAll(() => t.close());

describe('assigned', () => {
  it('a person, or the members of a team, newly put in a people cell hear it — not the actor', async () => {
    const item = await newItem('Deal A');
    expect((await assign(item, [{ kind: 'person', id: ids.bob }])).status).toBe(200);
    const mine = await inbox(bob);
    expect(mine.unread_count).toBe(1);
    expect(mine.data[0]).toMatchObject({
      type: 'assigned',
      read_at: null,
      actor: { id: ids.admin, name: 'admin' },
      board: { id: boardId, name: 'Deals' },
      item: { id: item, name: 'Deal A' },
      column_title: 'Owner',
    });

    // Adding the team and admin: only Dana is new (Bob was there; admin is the actor).
    await assign(item, [
      { kind: 'person', id: ids.bob },
      { kind: 'team', id: salesId },
      { kind: 'person', id: ids.admin },
    ]);
    expect((await inbox(bob)).unread_count).toBe(1);
    expect((await inbox(dana)).data.map((n: Json) => n.type)).toEqual(['assigned']);
    // (The admin did invite them all: those "accepted your invitation" notifications are not about this item.)
    expect((await inbox(admin)).data.filter((n: Json) => n.type !== 'invitation_accepted')).toEqual([]);
  });
});

describe('updates', () => {
  let item: string;
  let bobUpdate: string;

  it('a mention notifies the mentioned person with an excerpt', async () => {
    item = await newItem('Deal B');
    const u = await body(
      await as(admin).post(`/items/${item}/updates`, { body: `${mention('Bob', ids.bob)} תבדוק את זה` }),
    );
    const n = (await inbox(bob)).data[0];
    expect(n).toMatchObject({ type: 'mention', update_id: u.id, item: { id: item } });
    expect(n.excerpt).toContain('תבדוק את זה');
  });

  it("a reply notifies the replied update's author; a mention in the reply wins", async () => {
    bobUpdate = (await body(await as(bob).post(`/items/${item}/updates`, { body: 'שאלה' }))).id;
    const before = (await inbox(bob)).data.length;
    await as(dana).post(`/updates/${bobUpdate}/replies`, { body: 'תשובה' });
    const after = (await inbox(bob)).data;
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({ type: 'reply', actor: { id: ids.dana }, excerpt: 'תשובה' });

    await as(dana).post(`/updates/${bobUpdate}/replies`, { body: `${mention('Bob', ids.bob)} שוב` });
    const again = (await inbox(bob)).data;
    expect(again).toHaveLength(before + 2);
    expect(again[0].type).toBe('mention');
    // Replying to my own update tells nobody.
    const count = (await inbox(bob)).data.length;
    await as(bob).post(`/updates/${bobUpdate}/replies`, { body: 'עוד ממני' });
    expect((await inbox(bob)).data).toHaveLength(count);
  });

  it('editing an update tells only the newly mentioned', async () => {
    const u = await body(await as(admin).post(`/items/${item}/updates`, { body: mention('Dana', ids.dana) }));
    const danaBefore = (await inbox(dana)).data.length;
    const bobBefore = (await inbox(bob)).data.length;
    await as(admin).patch(`/updates/${u.id}`, { body: `${mention('Dana', ids.dana)} ${mention('Bob', ids.bob)}` });
    expect((await inbox(dana)).data).toHaveLength(danaBefore);
    expect((await inbox(bob)).data).toHaveLength(bobBefore + 1);
  });

  it('never about an item the person cannot see (view_items)', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, {
      view_items: { mode: 'assigned_or_created', column_ids: 'any_people' },
    });
    const hidden = await newItem('Hidden');
    const before = (await inbox(carol)).data.length;
    await as(admin).post(`/items/${hidden}/updates`, { body: mention('Carol', ids.carol) });
    expect((await inbox(carol)).data).toHaveLength(before);
    // Assigned: the item becomes visible to her, so she hears it.
    await assign(hidden, [{ kind: 'person', id: ids.carol }]);
    expect((await inbox(carol)).data[0]).toMatchObject({ type: 'assigned', item: { name: 'Hidden' } });
    await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'all' } });
  });
});

describe('reading', () => {
  it('pages by cursor and marks some or all read', async () => {
    const all = await inbox(bob);
    expect(all.data.length).toBeGreaterThan(2);
    const first = await inbox(bob, '?limit=2');
    expect(first.data).toHaveLength(2);
    const second = await inbox(bob, `?limit=2&before=${first.next_cursor}`);
    expect(second.data[0].id).toBe(all.data[2].id);

    const res = await body(await as(bob).post('/me/notifications/read', { ids: [all.data[0].id] }));
    expect(res).toEqual({ ok: true, unread_count: all.unread_count - 1 });
    expect((await inbox(bob, '?unread=1')).data.map((n: Json) => n.id)).not.toContain(all.data[0].id);
    // Someone else's id is ignored.
    await as(dana).post('/me/notifications/read', { ids: [all.data[1].id] });
    expect((await inbox(bob)).unread_count).toBe(all.unread_count - 1);

    expect(await body(await as(bob).post('/me/notifications/read', { all: true }))).toEqual({
      ok: true,
      unread_count: 0,
    });
    expect((await inbox(bob)).data.every((n: Json) => n.read_at)).toBe(true);
    expect((await as(bob).post('/me/notifications/read', {})).status).toBe(400);
  });

  it('needs an account', async () => {
    expect((await t.api(bob).get('/me/notifications')).status).toBe(400);
  });
});

/**
 * dedup-1: every module writes through `notifyUsers` — the user's settings decide, except for the required types
 * (security / billing, `NOTIFICATION_TYPE_META`), which always reach the bell and the email.
 */
describe('notifyUsers: settings and required types', () => {
  const rowsOf = async (type: string) =>
    (await t.db.select().from(notifications).where(eq(notifications.type, type))).filter((n) => n.userId === ids.dana);
  const send = (type: 'flow_failed' | 'secret_reveals', excerpt: string) =>
    notifyUsers(t.db as unknown as Db, { accountId: acmeId, type, actorId: null, payload: { excerpt } }, [ids.dana]);

  it('a switched-off category: bell off → a row for the email only; bell and email off → none', async () => {
    await as(dana).patch('/me/notifications/settings', { categories: [{ key: 'reminders', bell: false }] });
    expect(await send('flow_failed', 'f1')).toEqual([ids.dana]);
    expect((await rowsOf('flow_failed'))[0]!.payload).toMatchObject({ excerpt: 'f1', bell: false });
    expect((await inbox(dana)).data.some((n: Json) => n.type === 'flow_failed')).toBe(false);

    await as(dana).patch('/me/notifications/settings', {
      categories: [{ key: 'reminders', bell: false, email: false }],
    });
    expect(await send('flow_failed', 'f2')).toEqual([]);
    expect(await rowsOf('flow_failed')).toHaveLength(1);
  });

  it('a required type reaches the bell even with its category off; the sender may skip the email', async () => {
    expect(await send('secret_reveals', 's1')).toEqual([ids.dana]);
    const [row] = await rowsOf('secret_reveals');
    expect(row!.payload).toEqual({ excerpt: 's1' });
    expect(row!.emailedAt).toBeNull();
    expect((await inbox(dana)).data.find((n: Json) => n.type === 'secret_reveals')).toMatchObject({ excerpt: 's1' });

    await notifyUsers(
      t.db as unknown as Db,
      { accountId: acmeId, type: 'ticket_status', actorId: null, email: false, payload: { excerpt: 'x'.repeat(200) } },
      [ids.dana],
    );
    const [ticket] = await rowsOf('ticket_status');
    expect(ticket!.emailedAt).not.toBeNull();
    expect((ticket!.payload as { excerpt: string }).excerpt).toHaveLength(140);
    await as(dana).patch('/me/notifications/settings', { categories: [{ key: 'reminders', bell: true, email: true }] });
  });
});
