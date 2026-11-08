// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** fix2: my profile (PATCH /users/me) and my favourite boards (per account). */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('my profile', () => {
  it('reads and updates my name, title, phone, department, birthday, language and time zone', async () => {
    const before = await body(await as(bob).get('/users/me'));
    expect(before).toMatchObject({
      email: 'bob@acme.test',
      title: null,
      phone: null,
      department: null,
      birthday: null,
    });

    const res = await as(bob).patch('/users/me', {
      name: 'Bob Builder',
      title: 'Sales manager',
      phone: '+972 50-123-4567',
      department: 'Sales',
      birthday: '1990-05-17',
      locale: 'en',
      timezone: 'Europe/London',
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      name: 'Bob Builder',
      title: 'Sales manager',
      phone: '+972 50-123-4567',
      department: 'Sales',
      birthday: '1990-05-17',
      locale: 'en',
      timezone: 'Europe/London',
    });
    // The members list shows the title and phone; /auth/me the new name.
    const members = (await body(await as(admin).get('/users'))).data as Json[];
    expect(members.find((m) => m.email === 'bob@acme.test')).toMatchObject({
      name: 'Bob Builder',
      title: 'Sales manager',
      phone: '+972 50-123-4567',
      department: 'Sales',
    });
    expect((await body(await t.api(bob).get('/auth/me'))).user).toMatchObject({ name: 'Bob Builder', locale: 'en' });

    // An empty text or null clears a field.
    expect(await body(await as(bob).patch('/users/me', { title: '', birthday: null }))).toMatchObject({
      title: null,
      birthday: null,
      phone: '+972 50-123-4567',
    });
    const events = await t.db
      .select({ payload: activityLog.payload })
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'user.profile_updated')));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload)).toContainEqual(
      expect.objectContaining({
        before: expect.objectContaining({ title: null }),
        after: expect.objectContaining({ title: 'Sales manager' }),
      }),
    );
  });

  it('rejects bad values and needs an account', async () => {
    expect((await as(bob).patch('/users/me', { phone: 'call me' })).status).toBe(400);
    expect((await as(bob).patch('/users/me', { birthday: '17/05/1990' })).status).toBe(400);
    expect((await as(bob).patch('/users/me', { timezone: 'Mars/Base' })).status).toBe(400);
    expect((await as(bob).patch('/users/me', { name: '' })).status).toBe(400);
    expect((await t.api(bob).patch('/users/me', { title: 'x' })).status).toBe(400);
  });
});

describe('favourite boards', () => {
  it('keeps my order, per user, and leaves out boards I can no longer open', async () => {
    const mk = async (name: string, kind?: string) =>
      (await body(await as(admin).post('/boards', { name, workspace_id: wsId, ...(kind ? { kind } : {}) })))
        .id as string;
    const a = await mk('Alpha');
    const b = await mk('Beta');
    const secret = await mk('Secret', 'private');

    expect(await body(await as(admin).get('/me/favorite-boards'))).toEqual({ data: [] });
    const put = await body(await as(admin).put('/me/favorite-boards', { board_ids: [b, a, b, secret] }));
    expect(put.data.map((x: Json) => x.name)).toEqual(['Beta', 'Alpha', 'Secret']);
    expect((await body(await as(admin).get('/me/favorite-boards'))).data[0]).toEqual({
      id: b,
      name: 'Beta',
      workspace_id: wsId,
    });

    // Bob's list is his own; a private board he cannot open is dropped.
    expect((await body(await as(bob).get('/me/favorite-boards'))).data).toEqual([]);
    const bobs = await body(await as(bob).put('/me/favorite-boards', { board_ids: [secret, a] }));
    expect(bobs.data.map((x: Json) => x.id)).toEqual([a]);

    // An archived board disappears from the list.
    await as(admin).post(`/boards/${a}/archive`, {});
    expect((await body(await as(admin).get('/me/favorite-boards'))).data.map((x: Json) => x.id)).toEqual([b, secret]);
    expect((await as(admin).put('/me/favorite-boards', { board_ids: 'x' })).status).toBe(400);
  });
});
