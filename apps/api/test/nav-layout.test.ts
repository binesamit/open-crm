// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountMembers, activityLog, users } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * the sidebar / top bar layout. Admins set the account's default (and may lock it); each member may
 * keep their own in that account (`account_members.settings.nav`, merged in — other keys there stay).
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let bobId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

const bobSettings = async () =>
  (
    await t.db
      .select({ settings: accountMembers.settings })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, acmeId), eq(accountMembers.userId, bobId)))
  )[0]!.settings as Json;

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
  ).account.id as string;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = (await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'bob@acme.test')))[0]!.id;
});
afterAll(() => t.close());

describe('nav layout (sidebar / top bar)', () => {
  it('starts with everything in the sidebar', async () => {
    const res = await as(bob).get('/me/nav');
    expect(res.status).toBe(200);
    const r = await body(res);
    expect(Object.values(r.layout).every((p) => p === 'side')).toBe(true);
    expect(r.mine).toBeNull();
    expect(r.account).toEqual({ placement: {}, locked: false });
  });

  it('a member keeps their own layout, merged into their settings (other keys stay)', async () => {
    await t.db
      .update(accountMembers)
      .set({ settings: { erasure_requested_at: '2026-10-11T00:00:00Z', my_work: { hide_done: true } } })
      .where(and(eq(accountMembers.accountId, acmeId), eq(accountMembers.userId, bobId)));
    const res = await as(bob).put('/me/nav', { placement: { home: 'top', search: 'top', tree: 'top' } });
    expect(res.status).toBe(200);
    const r = await body(res);
    expect(r.mine).toEqual({ home: 'top', search: 'top' });
    expect(r.layout).toMatchObject({ home: 'top', search: 'top', bell: 'side' });
    expect(await bobSettings()).toEqual({
      erasure_requested_at: '2026-10-11T00:00:00Z',
      my_work: { hide_done: true },
      nav: { home: 'top', search: 'top' },
    });
    // Back to the account's layout: only `nav` goes.
    const back = await body(await as(bob).put('/me/nav', { placement: null }));
    expect(back.mine).toBeNull();
    expect(await bobSettings()).toEqual({
      erasure_requested_at: '2026-10-11T00:00:00Z',
      my_work: { hide_done: true },
    });
  });

  it("only admins set the account's default; members follow it; one event", async () => {
    expect((await as(bob).put('/accounts/me/nav', { placement: { bell: 'top' }, locked: false })).status).toBe(403);
    const res = await as(admin).put('/accounts/me/nav', { placement: { bell: 'top', inbox: 'top' }, locked: false });
    expect(res.status).toBe(200);
    const r = await body(await as(bob).get('/me/nav'));
    expect(r.account).toEqual({ placement: { bell: 'top', inbox: 'top' }, locked: false });
    expect(r.layout).toMatchObject({ bell: 'top', inbox: 'top', home: 'side' });
    // Mine wins for what I chose; the account's default fills the rest.
    const mine = await body(await as(bob).put('/me/nav', { placement: { bell: 'side' } }));
    expect(mine.layout).toMatchObject({ bell: 'side', inbox: 'top' });
    const events = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'account.updated')));
    expect(events.filter((e) => JSON.stringify(e.payload).includes('"nav"'))).toHaveLength(1);
  });

  it("a locked layout applies to everyone and members can't change theirs", async () => {
    await as(admin).put('/accounts/me/nav', { placement: { bell: 'top' }, locked: true });
    const r = await body(await as(bob).get('/me/nav'));
    expect(r.layout).toMatchObject({ bell: 'top', inbox: 'side' });
    const refused = await as(bob).put('/me/nav', { placement: { bell: 'side' } });
    expect(refused.status).toBe(403);
    // Following the account again is always allowed.
    expect((await as(bob).put('/me/nav', { placement: null })).status).toBe(200);
  });

  it('a member hides places they do not use; the account mark can not be hidden', async () => {
    await as(admin).put('/accounts/me/nav', { placement: {}, locked: false });
    const r = await body(
      await as(bob).put('/me/nav', { placement: { automations: 'hidden', flows: 'hidden', account: 'hidden' } }),
    );
    expect(r.mine).toEqual({ automations: 'hidden', flows: 'hidden' });
    expect(r.layout).toMatchObject({ automations: 'hidden', flows: 'hidden', account: 'side' });
    await as(bob).put('/me/nav', { placement: null });
  });

  it('rejects unknown places', async () => {
    expect((await as(bob).put('/me/nav', { placement: { home: 'left' } })).status).toBe(400);
    expect((await as(admin).put('/accounts/me/nav', { placement: {}, locked: 'yes' })).status).toBe(400);
  });
});
