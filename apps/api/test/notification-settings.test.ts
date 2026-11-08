// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { activityLog, notifications } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M4 step 4 (D15, 08 §12.2–12.3): following items, personal settings, muting a board. */
let t: TestContext;
let admin: string;
let bob: string;
let dana: string;
let acmeId: string;
let ids: Record<'admin' | 'bob' | 'dana', string>;
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
const bell = async (cookie: string) => (await body(await as(cookie).get('/me/notifications'))).data as Json[];
const newItem = async (name: string, board = boardId) =>
  (await body(await as(admin).post(`/boards/${board}/items`, { name }))).id as string;
const follows = async (cookie: string, item: string) =>
  (await body(await as(cookie).get(`/items/${item}/follow`))).following;
const assign = (item: string, userId: string) =>
  as(admin).put(`/items/${item}/cells/${peopleKey}`, {
    value: { persons_and_teams: [{ kind: 'person', id: userId }] },
  });
/** Every notification row of a user (bell or not). */
const rows = (userId: string, type: string) =>
  t.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

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
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test'), dana: idOf('dana@acme.test') };
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: ws.id }))).id;
  peopleKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Owner', type: 'people' }))).id;
});
afterAll(() => t.close());

describe('following (D15)', () => {
  it('creator, writer, mentioned and assigned follow automatically; followers hear new updates', async () => {
    const item = await newItem('Follow me');
    expect(await follows(admin, item)).toBe(true);
    expect(await follows(bob, item)).toBe(false);

    await as(bob).post(`/items/${item}/updates`, { body: 'שאלה של בוב' });
    expect(await follows(bob, item)).toBe(true);
    expect((await bell(admin))[0]).toMatchObject({
      type: 'item_update',
      actor: { id: ids.bob },
      excerpt: 'שאלה של בוב',
    });

    await as(admin).post(`/items/${item}/updates`, { body: `[@Dana](user:${ids.dana}) תראי` });
    expect(await follows(dana, item)).toBe(true);
    // Bob follows: he hears the update; Dana was mentioned, so hers is the mention (one each).
    expect((await bell(bob))[0]).toMatchObject({ type: 'item_update', actor: { id: ids.admin } });
    expect((await bell(dana)).map((n) => n.type)).toEqual(['mention']);

    const other = await newItem('Assigned');
    await assign(other, ids.bob);
    expect(await follows(bob, other)).toBe(true);
  });

  it('a manual unfollow is kept: no more updates, and automatic rules do not re-add', async () => {
    const item = await newItem('Quiet');
    await as(bob).post(`/items/${item}/updates`, { body: 'אני כאן' });
    expect(await body(await as(bob).put(`/items/${item}/follow`, { following: false }))).toEqual({ following: false });
    const before = (await bell(bob)).length;
    await as(dana).post(`/items/${item}/updates`, { body: 'עדכון' });
    expect(await bell(bob)).toHaveLength(before);

    await as(bob).post(`/items/${item}/updates`, { body: 'שוב אני' }); // writing would follow — not after an unfollow
    expect(await follows(bob, item)).toBe(false);
    expect(await body(await as(bob).put(`/items/${item}/follow`, { following: true }))).toEqual({ following: true });
    await as(dana).post(`/items/${item}/updates`, { body: 'ועוד' });
    expect((await bell(bob))[0]).toMatchObject({ type: 'item_update', excerpt: 'ועוד' });
    expect((await as(bob).get(`/items/${newId()}/follow`)).status).toBe(404);
  });
});

describe('personal settings (08 §12.3)', () => {
  it('start all on, instant, nothing muted', async () => {
    const s = await body(await as(dana).get('/me/notifications/settings'));
    expect(s.digest).toBe('instant');
    expect(s.muted_boards).toEqual([]);
    // The phone (r19pwa): assignment and mention only, until chosen.
    expect(s.categories).toEqual([
      { key: 'assigned', bell: true, email: true, push: true },
      { key: 'mentioned', bell: true, email: true, push: true },
      { key: 'item_updates', bell: true, email: true, push: false },
      { key: 'reminders', bell: true, email: true, push: false },
    ]);
  });

  it('picks saved at the same time all land (no lost pick, no conflict)', async () => {
    const results = await Promise.all([
      as(dana).patch('/me/notifications/settings', { digest: 'weekly' }),
      as(dana).patch('/me/notifications/settings', { digest_weekday: 4 }),
      as(dana).patch('/me/notifications/settings', { digest_hour: 17 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const s = await body(await as(dana).get('/me/notifications/settings'));
    expect(s).toMatchObject({ digest: 'weekly', digest_weekday: 4, digest_hour: 17 });
    await as(dana).patch('/me/notifications/settings', { digest: 'instant' });
  });

  it('bell off keeps the email (row hidden from the bell); all channels off writes nothing', async () => {
    const s = await body(
      await as(dana).patch('/me/notifications/settings', { categories: [{ key: 'assigned', bell: false }] }),
    );
    expect(s.categories[0]).toEqual({ key: 'assigned', bell: false, email: true, push: true });
    const item = await newItem('Bell off');
    await assign(item, ids.dana);
    expect((await bell(dana)).some((n) => n.item?.id === item)).toBe(false);
    const hidden = (await rows(ids.dana, 'assigned')).find((r) => r.itemId === item);
    expect(hidden?.payload).toMatchObject({ bell: false });
    expect((await body(await as(dana).get('/me/notifications'))).unread_count).toBe(
      (await bell(dana)).filter((n) => !n.read_at).length,
    );

    // Bell and email off, the phone still on (r19pwa): the row stays for the push.
    await as(dana).patch('/me/notifications/settings', { categories: [{ key: 'assigned', email: false }] });
    const phoneOnly = await newItem('Phone only');
    await assign(phoneOnly, ids.dana);
    expect((await rows(ids.dana, 'assigned')).some((r) => r.itemId === phoneOnly)).toBe(true);

    await as(dana).patch('/me/notifications/settings', { categories: [{ key: 'assigned', push: false }] });
    const item2 = await newItem('All off');
    await assign(item2, ids.dana);
    expect((await rows(ids.dana, 'assigned')).some((r) => r.itemId === item2)).toBe(false);

    await as(dana).patch('/me/notifications/settings', {
      categories: [{ key: 'assigned', bell: true, email: true, push: true }],
      digest: 'daily',
    });
    const after = await body(await as(dana).get('/me/notifications/settings'));
    expect(after.categories[0]).toEqual({ key: 'assigned', bell: true, email: true, push: true });
    expect(after.digest).toBe('daily');
    expect((await as(dana).patch('/me/notifications/settings', { categories: [{ key: 'nope' }] })).status).toBe(400);
  });

  it('the summary email: daily or weekly, at a chosen hour and weekday', async () => {
    const s = await body(
      await as(dana).patch('/me/notifications/settings', { digest: 'weekly', digest_hour: 17, digest_weekday: 4 }),
    );
    expect(s).toMatchObject({ digest: 'weekly', digest_hour: 17, digest_weekday: 4 });
    // Changing only the hour keeps the frequency and the day.
    expect(await body(await as(dana).patch('/me/notifications/settings', { digest_hour: 7 }))).toMatchObject({
      digest: 'weekly',
      digest_hour: 7,
      digest_weekday: 4,
    });
    expect((await as(dana).patch('/me/notifications/settings', { digest_hour: 24 })).status).toBe(400);
    await as(dana).patch('/me/notifications/settings', { digest: 'instant' });
  });

  it('account defaults (admins) apply to members who have not chosen; a personal choice wins', async () => {
    expect((await as(bob).patch('/accounts/me', { settings: { notifications: { digest: 'daily' } } })).status).toBe(
      403,
    );
    const res = await as(admin).patch('/accounts/me', {
      settings: {
        notifications: {
          categories: [{ key: 'item_updates', bell: true, email: false }],
          digest: 'daily',
          digest_hour: 9,
        },
      },
    });
    expect(res.status).toBe(200);
    // Bob never chose: he gets the defaults.
    const bobs = await body(await as(bob).get('/me/notifications/settings'));
    expect(bobs.categories.find((c: Json) => c.key === 'item_updates')).toEqual({
      key: 'item_updates',
      bell: true,
      email: false,
      push: false,
    });
    expect(bobs).toMatchObject({ digest: 'daily', digest_hour: 9 });
    // Dana chose "instant" herself (above): her choice stays.
    expect((await body(await as(dana).get('/me/notifications/settings'))).digest).toBe('instant');
    // Bob turns item-update emails back on for himself.
    await as(bob).patch('/me/notifications/settings', { categories: [{ key: 'item_updates', email: true }] });
    expect(
      (await body(await as(bob).get('/me/notifications/settings'))).categories.find(
        (c: Json) => c.key === 'item_updates',
      ).email,
    ).toBe(true);
    await as(admin).patch('/accounts/me', { settings: { notifications: { categories: [], digest: 'instant' } } });
  });

  it('need an account (they are kept per account)', async () => {
    expect((await t.api(dana).get('/me/notifications/settings')).status).toBe(400);
  });
});

describe('board mute (08 §12.2)', () => {
  it('mutes a board for me only', async () => {
    expect(await body(await as(bob).put(`/boards/${boardId}/notifications`, { muted: true }))).toMatchObject({
      mode: 'muted',
      muted: true,
      muted_for_everyone: false,
      can_mute_for_everyone: false,
    });
    expect((await body(await as(bob).get('/me/notifications/settings'))).muted_boards).toEqual([
      { id: boardId, name: 'Deals' },
    ]);
    const item = await newItem('Muted for bob');
    await assign(item, ids.bob);
    expect((await rows(ids.bob, 'assigned')).some((r) => r.itemId === item)).toBe(false);

    await as(bob).put(`/boards/${boardId}/notifications`, { muted: false });
    const item2 = await newItem('Heard again');
    await assign(item2, ids.bob);
    expect((await bell(bob))[0]).toMatchObject({ type: 'assigned', item: { id: item2 } });
  });

  it('custom: only the categories I choose come from this board', async () => {
    const custom = await body(
      await as(bob).put(`/boards/${boardId}/notifications`, {
        categories: [
          { key: 'assigned', bell: false, email: false },
          { key: 'mentioned', bell: true, email: true },
          { key: 'item_updates', bell: true, email: true },
          { key: 'reminders', bell: true, email: true },
        ],
      }),
    );
    expect(custom).toMatchObject({ mode: 'custom', muted: false });
    expect(custom.categories[0]).toEqual({ key: 'assigned', bell: false, email: false });
    const item = await newItem('Custom: not assigned');
    await assign(item, ids.bob);
    expect((await rows(ids.bob, 'assigned')).some((r) => r.itemId === item)).toBe(false);
    await as(dana).post(`/items/${item}/updates`, { body: `[@Bob](user:${ids.bob}) כאן` });
    expect((await bell(bob))[0]).toMatchObject({ type: 'mention', item: { id: item } });
    // Back to everything.
    expect(await body(await as(bob).put(`/boards/${boardId}/notifications`, { mode: 'all' }))).toMatchObject({
      mode: 'all',
    });
  });

  it('owners and admins mute it for everyone; it is a board event', async () => {
    expect((await as(bob).put(`/boards/${boardId}/notifications`, { muted_for_everyone: true })).status).toBe(403);
    const res = await body(await as(admin).put(`/boards/${boardId}/notifications`, { muted_for_everyone: true }));
    expect(res).toMatchObject({ muted_for_everyone: true, can_mute_for_everyone: true });
    expect(await body(await as(bob).get(`/boards/${boardId}/notifications`))).toMatchObject({
      muted: false,
      muted_for_everyone: true,
    });
    const item = await newItem('Silent');
    await assign(item, ids.bob);
    await as(dana).post(`/items/${item}/updates`, { body: `[@Bob](user:${ids.bob}) היי` });
    expect((await rows(ids.bob, 'assigned')).some((r) => r.itemId === item)).toBe(false);
    expect((await rows(ids.bob, 'mention')).some((r) => r.itemId === item)).toBe(false);
    const [event] = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.boardId, boardId), eq(activityLog.type, 'board.notifications_muted')));
    expect(event?.payload).toMatchObject({
      before: { muted_for_everyone: false },
      after: { muted_for_everyone: true },
    });
    await as(admin).put(`/boards/${boardId}/notifications`, { muted_for_everyone: false });
  });
});
