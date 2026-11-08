// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, type MockInstance } from 'vitest';
import { accountSubscriptions, accounts, boards, legalConsents, signupRequests, users } from '../src/db/schema';
import { planStatusesOf } from '../src/modules/billing/plan-status';
import { forgetBillingSettings } from '../src/modules/billing/billing-settings';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import { body, errorOf, mockTurnstile, openSignup, PASSWORD, pub, startBody, verifyTokenFor } from './signup-fixture';

/**
 * Self sign-up (D32, stage ה1): the switch off changes nothing; on, a person starts with email + password, verifies
 * the email and lands in a new account of their own — through the existing doors: the starter kit, the first-admin
 * invitation, the password policy, the plan's trial (read-only at its end, suspended 30 days later), legal consent.
 * The answer is the same for a registered address (the email tells them). Manual approval holds a request for the owner.
 */
let verify: MockInstance | undefined;
afterEach(() => verify?.mockRestore());

describe('switched off (the default): nothing new answers, every existing door is unchanged', () => {
  let t: TestContext;
  let owner: string;
  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  });
  afterAll(() => t.close());

  it('the public routes answer 404 (config says closed) and nothing is stored', async () => {
    expect(await body(await pub(t, 'GET', '/public/signup/config'))).toMatchObject({
      open: false,
      methods: [],
      plans: [],
      legal: [],
      captcha_site_key: null,
    });
    const start = await pub(t, 'POST', '/public/signup/start', await startBody(t, 'new@example.com'));
    expect(start.status).toBe(404);
    expect((await pub(t, 'POST', '/public/signup/resend', { email: 'new@example.com' })).status).toBe(404);
    expect((await pub(t, 'POST', '/public/signup/verify', { token: 'x'.repeat(43) })).status).toBe(404);
    const intent = { name: 'N', org_name: 'O', method: 'google', captcha_token: 'good' };
    const res = await pub(t, 'POST', '/public/signup/intent', intent);
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await t.db.select().from(signupRequests)).toHaveLength(0);
    expect(t.mailer.sent.some((m) => m.to === 'new@example.com')).toBe(false);
  });

  it('the owner sees the default settings (off) and what is missing; turning it on is refused until ready', async () => {
    const s = await body(await t.api(owner).get('/platform/signup-settings'));
    expect(s.settings).toMatchObject({
      enabled: false,
      mode: 'open',
      methods: ['password', 'google', 'microsoft'],
      trial_days: 14,
      trial_end_status: 'read_only',
      approval: false,
      require_captcha: true,
      block_disposable: true,
      rate_ip_hour: 5,
      rate_email_day: 3,
      daily_cap: 50,
    });
    expect(s).toMatchObject({ ready: false, open: false });
    expect(s.missing).toEqual(['captcha', 'default_plan']);
    const on = await t.api(owner).patch('/platform/signup-settings', { enabled: true });
    expect(on.status).toBe(422);
    const err = await errorOf(on);
    expect(err.code).toBe('signup_not_ready');
    expect(err.details.missing).toEqual(['captcha', 'default_plan']);
    // Other settings save while it stays off.
    const saved = await t
      .api(owner)
      .patch('/platform/signup-settings', { daily_cap: 10, domain_block: ['Spam.Example'] });
    expect(saved.status).toBe(200);
    expect((await body(saved)).settings).toMatchObject({
      enabled: false,
      daily_cap: 10,
      domain_block: ['spam.example'],
    });
    // An unknown starter kit is refused when saved, not at the first sign-up.
    expect((await t.api(owner).patch('/platform/signup-settings', { starter_kit: 'no-such-kit' })).status).toBe(422);
  });

  it('only the platform owner reaches the settings and the queue (404 to anyone else)', async () => {
    expect((await pub(t, 'GET', '/platform/signup-settings')).status).toBe(401);
    expect((await t.api(undefined).get('/platform/signup-requests')).status).toBe(401);
  });

  it('a password sign-up without an invitation is still refused by Better Auth', async () => {
    const res = await t.signUpWithPassword('stranger@example.com');
    expect(res.status).toBe(403);
    expect(await t.db.select().from(users).where(eq(users.email, 'stranger@example.com'))).toHaveLength(0);
  });
});

describe('switched on: start → email → verify → a new account on a trial', () => {
  let t: TestContext;
  let owner: string;
  let planId: string;
  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    verify = mockTurnstile();
    planId = await openSignup(t, owner, { starter_kit: 'crm-starter' });
  });
  afterAll(() => t.close());

  it('config shows the open screen: methods, the plans, the documents, the site key', async () => {
    const c = await body(await pub(t, 'GET', '/public/signup/config'));
    expect(c).toMatchObject({
      open: true,
      methods: ['password', 'google', 'microsoft'],
      choose_plan: true,
      default_plan_id: planId,
      trial_days: 14,
      captcha_site_key: '0xSIGNUP',
      password_min_length: 8,
    });
    expect(c.plans.map((p: { id: string }) => p.id)).toEqual([planId]);
    expect(c.legal.map((d: { slug: string }) => d.slug).sort()).toEqual(['privacy', 'terms']);
  });

  it('creates the account with its starter kit, the admin, the trial and the consent — and signs the person in', async () => {
    verify = mockTurnstile();
    const start = await pub(t, 'POST', '/public/signup/start', await startBody(t, 'Dana@Acme-Labs.io'));
    expect(start.status).toBe(200);
    expect(await body(start)).toEqual({ ok: true });
    const [req] = await t.db.select().from(signupRequests).where(eq(signupRequests.email, 'dana@acme-labs.io'));
    expect(req).toMatchObject({ status: 'pending_email', method: 'password', orgName: 'Acme Labs', sends: 1 });
    // Only a hash of the password is kept, and no plain token.
    expect(req!.passwordHash).toBeTruthy();
    expect(req!.passwordHash).not.toContain(PASSWORD);
    const token = verifyTokenFor(t, 'dana@acme-labs.io');
    expect(req!.tokenHash).not.toBe(token);
    // Nobody exists before the link is opened.
    expect(await t.db.select().from(users).where(eq(users.email, 'dana@acme-labs.io'))).toHaveLength(0);

    const res = await pub(t, 'POST', '/public/signup/verify', { token });
    expect(res.status).toBe(200);
    const result = await body(res);
    expect(result).toMatchObject({ status: 'provisioned', account: { slug: 'acme-labs', name: 'Acme Labs' } });
    const cookie = t.cookieFrom(res);
    expect(cookie).toBeTruthy();

    // The person is the account's admin (the session works at once).
    const mine = await body(await t.api(cookie).get('/me/accounts'));
    expect(mine.data).toEqual([
      expect.objectContaining({ id: result.account.id, role: 'admin', plan_status: 'trial' }),
    ]);
    const [user] = await t.db.select().from(users).where(eq(users.email, 'dana@acme-labs.io'));
    expect(user).toMatchObject({ emailVerified: true, isPlatformOwner: false, locale: 'en', name: 'Dana Cohen' });

    // The account: opened by sign-up, the starter kit's boards.
    const [account] = await t.db.select().from(accounts).where(eq(accounts.id, result.account.id));
    expect(account!.origin).toBe('signup');
    const kitBoards = await t.db.select().from(boards).where(eq(boards.accountId, account!.id));
    expect(kitBoards.length).toBeGreaterThanOrEqual(4);

    // The trial: the setting's 14 days (the plan has none of its own), ending by the sign-up's own rule.
    const [sub] = await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, account!.id));
    expect(sub).toMatchObject({ status: 'trial', trialEndStatus: 'read_only' });
    const days = (sub!.trialEndsAt!.getTime() - sub!.statusSince.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);

    // Consent to the current versions, recorded as joining by sign-up.
    const rows = await t.db.select().from(legalConsents).where(eq(legalConsents.userId, user!.id));
    expect(rows.map((r) => r.context)).toEqual(['signup', 'signup']);
    expect(await body(await t.api(cookie).get('/me/legal'))).toEqual({ pending: [] });

    // The request is done; the password hash is gone.
    const [done] = await t.db.select().from(signupRequests).where(eq(signupRequests.id, req!.id));
    expect(done).toMatchObject({ status: 'provisioned', accountId: account!.id, userId: user!.id, passwordHash: null });

    // The chosen password works on the ordinary sign-in.
    const signIn = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email: 'dana@acme-labs.io', password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);

    // The link works once.
    const again = await pub(t, 'POST', '/public/signup/verify', { token });
    expect(again.status).toBe(404);
    expect((await errorOf(again)).code).toBe('verification_invalid');
    // The owner heard about it (setting on by default).
    expect(t.lastMailTo(OWNER_EMAIL).subject).toContain('Acme Labs');
  });

  it('a registered address gets the same answer; its email says "you already have an account"', async () => {
    verify = mockTurnstile();
    const before = t.mailer.sent.length;
    const res = await pub(t, 'POST', '/public/signup/start', await startBody(t, 'dana@acme-labs.io'));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    const mail = t.lastMailTo('dana@acme-labs.io');
    expect(t.mailer.sent.length).toBe(before + 1);
    expect(mail.subject).toMatch(/already have/i);
    expect(mail.text).not.toContain('signup/verify');
    // The platform owner's own address too.
    const own = await pub(t, 'POST', '/public/signup/start', await startBody(t, OWNER_EMAIL));
    expect(await body(own)).toEqual({ ok: true });
    expect(t.lastMailTo(OWNER_EMAIL).subject).toMatch(/already have/i);
    const rows = await t.db.select().from(signupRequests).where(eq(signupRequests.status, 'existing_user'));
    expect(rows.map((r) => r.email).sort()).toEqual(['dana@acme-labs.io', OWNER_EMAIL]);
  });

  it('a second organisation of the same name gets its own slug; a Hebrew name falls back to the address', async () => {
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'second@acme-labs.io'));
    const a = await body(
      await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, 'second@acme-labs.io') }),
    );
    expect(a.account.slug).toBe('acme-labs-2');
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'yossi.k@kfar.co.il', { org_name: 'כפר הנוער' }));
    const b = await body(
      await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, 'yossi.k@kfar.co.il') }),
    );
    expect(b.account).toMatchObject({ slug: 'yossi-k', name: 'כפר הנוער' });
  });

  it('send again: a new link after the cooldown only, the old one stops; always the same answer', async () => {
    verify = mockTurnstile();
    const email = 'resend@acme-labs.io';
    await pub(t, 'POST', '/public/signup/start', await startBody(t, email));
    const first = verifyTokenFor(t, email);
    // Within the cooldown: nothing sent.
    const count = () => t.mailer.sent.filter((m) => m.to === email).length;
    expect(await body(await pub(t, 'POST', '/public/signup/resend', { email }))).toEqual({ ok: true });
    expect(count()).toBe(1);
    // Unknown address: the same answer, nothing sent.
    expect(await body(await pub(t, 'POST', '/public/signup/resend', { email: 'nobody@x.io' }))).toEqual({ ok: true });
    // Past the cooldown.
    await t.db
      .update(signupRequests)
      .set({ lastSentAt: new Date(Date.now() - 120_000) })
      .where(eq(signupRequests.email, email));
    await pub(t, 'POST', '/public/signup/resend', { email });
    expect(count()).toBe(2);
    const second = verifyTokenFor(t, email);
    expect(second).not.toBe(first);
    expect((await pub(t, 'POST', '/public/signup/verify', { token: first })).status).toBe(404);
    expect((await pub(t, 'POST', '/public/signup/verify', { token: second })).status).toBe(200);
  });

  it('the trial ends in read-only at once, suspended 30 days later; closed never by itself', async () => {
    const [req] = await t.db
      .select()
      .from(signupRequests)
      .where(and(eq(signupRequests.email, 'dana@acme-labs.io'), eq(signupRequests.status, 'provisioned')));
    const id = req!.accountId!;
    forgetBillingSettings();
    const [sub] = await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, id));
    const end = sub!.trialEndsAt!;
    const at = (ms: number) => planStatusesOf(t.db as never, [id], new Date(end.getTime() + ms));
    expect((await at(-60_000)).get(id)).toMatchObject({ plan_status: 'trial', read_only_at: end.toISOString() });
    expect((await at(60_000)).get(id)).toMatchObject({ plan_status: 'read_only' });
    expect((await at(29 * 86_400_000)).get(id)).toMatchObject({ plan_status: 'read_only' });
    expect((await at(31 * 86_400_000)).get(id)).toMatchObject({ plan_status: 'suspended' });
    expect((await at(3650 * 86_400_000)).get(id)!.plan_status).toBe('suspended');
  });

  it('a plan version with trial days of its own decides its trial', async () => {
    verify = mockTurnstile();
    const plan = await body(
      await t.api(owner).post('/platform/plans', { name: 'Pro', version: { trial_days: 30, price_monthly: 10 } }),
    );
    const email = 'pro@acme-labs.io';
    await pub(t, 'POST', '/public/signup/start', await startBody(t, email, { plan_id: plan.id }));
    const res = await body(await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, email) }));
    const [sub] = await t.db
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, res.account.id));
    expect(sub!.planVersionId).toBe(plan.current_version_id);
    expect(Math.round((sub!.trialEndsAt!.getTime() - sub!.statusSince.getTime()) / 86_400_000)).toBe(30);
    // A plan that is not offered is refused.
    const hidden = await body(await t.api(owner).post('/platform/plans', { name: 'Secret', visibility: 'hidden' }));
    const bad = await pub(
      t,
      'POST',
      '/public/signup/start',
      await startBody(t, 'h@acme-labs.io', { plan_id: hidden.id }),
    );
    expect(bad.status).toBe(422);
    expect((await errorOf(bad)).message).toBe('plan_unavailable');
  });

  it('a password shorter than the platform minimum is refused before anything is stored', async () => {
    verify = mockTurnstile();
    const res = await pub(
      t,
      'POST',
      '/public/signup/start',
      await startBody(t, 'short@acme-labs.io', { password: 'abc1234' }),
    );
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toBe('password_min_length');
    expect(await t.db.select().from(signupRequests).where(eq(signupRequests.email, 'short@acme-labs.io'))).toHaveLength(
      0,
    );
  });
});

describe('manual approval: verified requests wait for the platform owner', () => {
  let t: TestContext;
  let owner: string;
  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    verify = mockTurnstile();
    await openSignup(t, owner, { approval: true });
  });
  afterAll(() => t.close());

  const verified = async (email: string, org: string) => {
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, email, { org_name: org }));
    const res = await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, email) });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    // The "being reviewed" screen shows what was asked for.
    expect(await body(res)).toEqual({
      status: 'pending_approval',
      account: null,
      request: { org_name: org, plan_name: 'Starter', trial_days: 14 },
    });
    const list = await body(await t.api(owner).get('/platform/signup-requests?status=pending_approval'));
    return (list.data as { id: string; email: string }[]).find((r) => r.email === email)!;
  };

  it('approve: the account is created, the person signs in with their password, an email says it is ready', async () => {
    const req = await verified('wait@beta.io', 'Beta Works');
    expect(t.lastMailTo(OWNER_EMAIL).subject).toContain('Beta Works');
    expect(await t.db.select().from(accounts).where(eq(accounts.name, 'Beta Works'))).toHaveLength(0);
    // The same address again while waiting: the same answer; the email says it is still being reviewed.
    verify = mockTurnstile();
    expect(await body(await pub(t, 'POST', '/public/signup/start', await startBody(t, 'wait@beta.io')))).toEqual({
      ok: true,
    });
    expect(t.lastMailTo('wait@beta.io').subject).toMatch(/reviewed/i);

    const res = await t.api(owner).post(`/platform/signup-requests/${req.id}/approve`);
    expect(res.status).toBe(200);
    const done = await body(res);
    expect(done).toMatchObject({ status: 'provisioned', decided_by: expect.any(String) });
    expect(t.lastMailTo('wait@beta.io').subject).toMatch(/ready/i);
    // Twice = 409.
    expect((await t.api(owner).post(`/platform/signup-requests/${req.id}/approve`)).status).toBe(409);
    const signIn = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email: 'wait@beta.io', password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    const mine = await body(await t.api(t.cookieFrom(signIn)).get('/me/accounts'));
    expect(mine.data).toEqual([expect.objectContaining({ id: done.account_id, role: 'admin' })]);
    // The owner did not get the new person's session.
    const me = await body(await t.api(owner).get('/auth/me'));
    expect(me.user.email).toBe(OWNER_EMAIL);
  });

  it('reject: the request ends with a reason, the domain can be blocked, no account', async () => {
    const req = await verified('spam@gamma.io', 'Gamma');
    const res = await t.api(owner).post(`/platform/signup-requests/${req.id}/reject`, {
      reason: 'Not a fit',
      block_domain: true,
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ status: 'rejected', reason: 'Not a fit' });
    const [row] = await t.db.select().from(signupRequests).where(eq(signupRequests.id, req.id));
    expect(row!.passwordHash).toBeNull();
    const mail = t.lastMailTo('spam@gamma.io');
    expect(mail.subject).toMatch(/request/i);
    expect(mail.text).toContain('Not a fit');
    const s = await body(await t.api(owner).get('/platform/signup-settings'));
    expect(s.settings.domain_block).toContain('gamma.io');
    expect(await t.db.select().from(users).where(eq(users.email, 'spam@gamma.io'))).toHaveLength(0);
    // The domain is now refused at the start.
    verify = mockTurnstile();
    const again = await pub(t, 'POST', '/public/signup/start', await startBody(t, 'other@gamma.io'));
    expect(again.status).toBe(422);
    expect((await errorOf(again)).details).toEqual({ reason: 'domain_blocked' });
  });

  it('the queue lists newest first, searches, and is the owner’s only', async () => {
    const all = await body(await t.api(owner).get('/platform/signup-requests'));
    expect(all.data.length).toBeGreaterThanOrEqual(2);
    // Pages by id (audit 2026-10-10 B3): `next` is the last id, and the next page starts after it — no row lost
    // or repeated even when two requests share a millisecond.
    const first = await body(await t.api(owner).get('/platform/signup-requests?limit=1'));
    expect(first.data).toHaveLength(1);
    expect(first.next).toBe(first.data[0].id);
    const second = await body(await t.api(owner).get(`/platform/signup-requests?limit=1&before=${first.next}`));
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);
    expect([first.data[0].id, second.data[0].id]).toEqual(all.data.slice(0, 2).map((r: { id: string }) => r.id));
    const found = await body(await t.api(owner).get('/platform/signup-requests?q=gamma'));
    expect(found.data.map((r: { email: string }) => r.email)).toEqual(['spam@gamma.io']);
    // A person signed in, not the owner: 404.
    const signIn = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email: 'wait@beta.io', password: PASSWORD }),
    });
    const member = t.cookieFrom(signIn);
    expect((await t.api(member).get('/platform/signup-requests')).status).toBe(404);
    expect((await t.api(member).get('/platform/signup-settings')).status).toBe(404);
    expect((await t.api(member).patch('/platform/signup-settings', { enabled: false })).status).toBe(404);
  });

  it('turning the switch off closes the public routes at once', async () => {
    expect((await t.api(owner).patch('/platform/signup-settings', { enabled: false })).status).toBe(200);
    expect((await pub(t, 'POST', '/public/signup/start', await startBody(t, 'late@delta.io'))).status).toBe(404);
    expect((await body(await pub(t, 'GET', '/public/signup/config'))).open).toBe(false);
  });
});
