// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, type MockInstance } from 'vitest';
import { accounts, signupRequests, users } from '../src/db/schema';
import { SIGNUP_INTENT_COOKIE } from '../src/modules/signup/signup.intent';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import {
  body,
  consents,
  errorOf,
  mockTurnstile,
  openSignup,
  PASSWORD,
  pub,
  startBody,
  verifyTokenFor,
} from './signup-fixture';

/**
 * someone only invited into other people's accounts (any role) owns no account here, so the sign-up opens
 * one for them — as they are: their user, their password, their profile; the password typed in the form is not used,
 * and the link signs nobody in (their own sign-in, two-step included, opens the account). Someone who owns an account
 * (opened it, or was its first admin) still gets "you already have an account". The screen's answer never differs.
 */
let verify: MockInstance | undefined;
afterEach(() => verify?.mockRestore());

const OWN_PASSWORD = 'my-own-long-password';

const signIn = (t: TestContext, email: string, password: string) =>
  t.app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password }),
  });

/** Dana opens Acme by signing up; returns her session and Acme's id. */
const danaOwnsAcme = async (t: TestContext) => {
  verify = mockTurnstile();
  await pub(t, 'POST', '/public/signup/start', await startBody(t, 'dana@acme.io'));
  const res = await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, 'dana@acme.io') });
  expect(res.status).toBe(200);
  return { dana: t.cookieFrom(res)!, acmeId: (await body(res)).account.id as string };
};

/** Dana invites `email` into Acme with `role`; they set their own password and accept. */
const invitedInto = async (t: TestContext, dana: string, acmeId: string, email: string, role = 'member') => {
  expect((await t.api(dana, acmeId).post('/users/invite', { emails: [email], role })).status).toBeLessThan(300);
  const token = t.inviteTokenFor(email);
  const signUp = await t.app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'x-invite-token': token },
    body: JSON.stringify({ email, password: OWN_PASSWORD, name: 'Noa Guest' }),
  });
  expect(signUp.status).toBe(200);
  const cookie = t.cookieFrom(signUp)!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};

describe('a registered person who owns no account opens one by signing up', () => {
  let t: TestContext;
  let owner: string;
  let dana: string;
  let acmeId: string;
  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    verify = mockTurnstile();
    await openSignup(t, owner);
    ({ dana, acmeId } = await danaOwnsAcme(t));
  }, 180_000);
  afterAll(() => t.close());

  it('an invited member: the same answer, a link that opens their own account with their own password', async () => {
    const noa = await invitedInto(t, dana, acmeId, 'noa@guest.io');
    verify = mockTurnstile();
    const start = await pub(
      t,
      'POST',
      '/public/signup/start',
      await startBody(t, 'Noa@Guest.io', { org_name: 'Noa Studio', name: 'Someone Else' }),
    );
    expect(start.status).toBe(200);
    expect(await body(start)).toEqual({ ok: true });
    const mail = t.lastMailTo('noa@guest.io');
    expect(mail.subject).toMatch(/your own account/i);
    expect(mail.text).toContain('existing password');
    const [req] = await t.db.select().from(signupRequests).where(eq(signupRequests.email, 'noa@guest.io'));
    // No password of its own is kept: the person is known.
    expect(req).toMatchObject({ status: 'pending_email', passwordHash: null, userId: expect.any(String) });

    const res = await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, 'noa@guest.io') });
    expect(res.status).toBe(200);
    const result = await body(res);
    expect(result).toMatchObject({ status: 'provisioned', account: { name: 'Noa Studio' } });
    // Nobody is signed in by the link.
    expect(t.cookieFrom(res)).toBeUndefined();

    // One person, both accounts: admin of the new one, still a member of Acme.
    expect(await t.db.select().from(users).where(eq(users.email, 'noa@guest.io'))).toHaveLength(1);
    const mine = await body(await t.api(noa).get('/me/accounts'));
    expect(mine.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: acmeId, role: 'member' }),
        expect.objectContaining({ id: result.account.id, role: 'admin', plan_status: 'trial' }),
      ]),
    );
    // Their own password still works, the typed one never did; their name is unchanged.
    expect((await signIn(t, 'noa@guest.io', OWN_PASSWORD)).status).toBe(200);
    expect((await signIn(t, 'noa@guest.io', PASSWORD)).status).not.toBe(200);
    const [user] = await t.db.select().from(users).where(eq(users.email, 'noa@guest.io'));
    expect(user!.name).toBe('Noa Guest');
    const [done] = await t.db.select().from(signupRequests).where(eq(signupRequests.id, req!.id));
    expect(done).toMatchObject({ status: 'provisioned', accountId: result.account.id, userId: user!.id });

    // Now they own one: another start says "you already have an account".
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'noa@guest.io', { org_name: 'Third' }));
    expect(t.lastMailTo('noa@guest.io').subject).toMatch(/already have/i);
  });

  it('an invited admin of someone else’s account counts as owning none', async () => {
    await invitedInto(t, dana, acmeId, 'ron@helper.io', 'admin');
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'ron@helper.io', { org_name: 'Ron Co' }));
    expect(t.lastMailTo('ron@helper.io').subject).toMatch(/your own account/i);
  });

  it('the account’s opener (and the platform owner) still get "you already have an account"', async () => {
    for (const email of ['dana@acme.io', OWNER_EMAIL]) {
      verify = mockTurnstile();
      const res = await pub(t, 'POST', '/public/signup/start', await startBody(t, email, { org_name: 'Another' }));
      expect(await body(res)).toEqual({ ok: true });
      const mail = t.lastMailTo(email);
      expect(mail.subject).toMatch(/already have/i);
      expect(mail.text).not.toContain('signup/verify');
    }
  });

  it('a second start replaces the first link: only the newest one opens an account', async () => {
    await invitedInto(t, dana, acmeId, 'lea@guest.io');
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'lea@guest.io', { org_name: 'Lea One' }));
    const first = verifyTokenFor(t, 'lea@guest.io');
    // A second start replaces the first link; the second one is used.
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'lea@guest.io', { org_name: 'Lea Two' }));
    const second = verifyTokenFor(t, 'lea@guest.io');
    expect((await pub(t, 'POST', '/public/signup/verify', { token: second })).status).toBe(200);
    expect((await pub(t, 'POST', '/public/signup/verify', { token: first })).status).toBe(404);
    expect(await t.db.select().from(accounts).where(eq(accounts.name, 'Lea One'))).toHaveLength(0);
  });

  it('Google / Microsoft: an invited member completes into a new account of their own', async () => {
    const sam = await invitedInto(t, dana, acmeId, 'sam@guest.io');
    verify = mockTurnstile();
    const res = await pub(t, 'POST', '/public/signup/intent', {
      method: 'google',
      name: 'Sam',
      org_name: 'Sam Works',
      accept_legal: await consents(t),
      captcha_token: 'good',
    });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).toContain(`${SIGNUP_INTENT_COOKIE}=`);
    const done = await pub(t, 'POST', '/public/signup/complete', {}, undefined, `${sam}; ${cookie}`);
    expect(done.status).toBe(200);
    const result = await body(done);
    expect(result).toMatchObject({ status: 'provisioned', account: { name: 'Sam Works' } });
    const mine = await body(await t.api(sam).get('/me/accounts'));
    expect(mine.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: result.account.id, role: 'admin' })]),
    );
    // The account's opener is still refused there.
    verify = mockTurnstile();
    const again = await pub(t, 'POST', '/public/signup/intent', {
      method: 'google',
      name: 'Dana',
      org_name: 'Dana Two',
      accept_legal: await consents(t),
      captcha_token: 'good',
    });
    const c2 = again.headers.get('set-cookie')!.split(';')[0]!;
    const refused = await pub(t, 'POST', '/public/signup/complete', {}, undefined, `${dana}; ${c2}`);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe('signup_already_registered');
  });
});

describe('with manual approval: the owner approves the existing person’s request', () => {
  let t: TestContext;
  let owner: string;
  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    verify = mockTurnstile();
    await openSignup(t, owner);
  }, 180_000);
  afterAll(() => t.close());

  it('approve: the account goes to the person as they are, their password unchanged', async () => {
    const { dana, acmeId } = await danaOwnsAcme(t);
    const noa = await invitedInto(t, dana, acmeId, 'noa@guest.io');
    expect((await t.api(owner).patch('/platform/signup-settings', { approval: true })).status).toBe(200);
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'noa@guest.io', { org_name: 'Noa Approved' }));
    const res = await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, 'noa@guest.io') });
    expect(await body(res)).toMatchObject({ status: 'pending_approval' });
    const list = await body(await t.api(owner).get('/platform/signup-requests?status=pending_approval'));
    const req = (list.data as { id: string; email: string }[]).find((r) => r.email === 'noa@guest.io')!;
    const approved = await t.api(owner).post(`/platform/signup-requests/${req.id}/approve`);
    expect(approved.status).toBe(200);
    const mine = await body(await t.api(noa).get('/me/accounts'));
    expect(mine.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Noa Approved', role: 'admin' })]),
    );
    expect((await signIn(t, 'noa@guest.io', OWN_PASSWORD)).status).toBe(200);
    // The owner's session is untouched.
    expect((await body(await t.api(owner).get('/auth/me'))).user.email).toBe(OWNER_EMAIL);
  });
});
