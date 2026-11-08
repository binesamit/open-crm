// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { billingSettingsSchema, trialEmailsSchema } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it, type MockInstance } from 'vitest';
import { accountSubscriptions, accounts, trialEmailsSent, users } from '../src/db/schema';
import { forgetUpgradeRequestLimits } from '../src/modules/billing/upgrade-request';
import { dueTrialEmail, sendDueTrialEmails } from '../src/modules/signup/signup.trial';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { body, mockTurnstile, openSignup, pub, startBody, verifyTokenFor } from './signup-fixture';

/**
 * Self sign-up ה5: the trial emails (welcome, two reminders, ended, before suspension — each with its own switch,
 * days and text, sent once per subscription) and "request upgrade".
 */
const DAY = 86_400_000;
const emails = trialEmailsSchema.parse({});
const billing = billingSettingsSchema.parse({});

describe('which trial email is due (pure)', () => {
  const end = new Date('2026-11-15T10:00:00Z');
  const sub = {
    status: 'trial' as const,
    statusSince: new Date(end.getTime() - 14 * DAY),
    trialEndsAt: end,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndStatus: 'read_only',
  };
  const at = (ms: number) => new Date(end.getTime() + ms);
  const due = (done: string[], ms: number, e = emails) =>
    dueTrialEmail(sub, e, billing, new Set(done as never), at(ms));

  it('welcome first, then the reminders by their days, then ended, then before suspension', () => {
    expect(due([], -10 * DAY)).toEqual({ send: 'welcome', skip: [] });
    expect(due(['welcome'], -10 * DAY)).toEqual({ send: null, skip: [] });
    expect(due(['welcome'], -3 * DAY + 1)).toEqual({ send: 'reminder_first', skip: [] });
    expect(due(['welcome', 'reminder_first'], -DAY + 1)).toEqual({ send: 'reminder_last', skip: [] });
    expect(due(['welcome', 'reminder_first', 'reminder_last'], 1)).toEqual({ send: 'ended', skip: [] });
    const before = 30 * DAY - 7 * DAY;
    expect(due(['welcome', 'reminder_first', 'reminder_last', 'ended'], before - 1)).toEqual({ send: null, skip: [] });
    expect(due(['welcome', 'reminder_first', 'reminder_last', 'ended'], before + 1)).toEqual({
      send: 'before_suspend',
      skip: [],
    });
  });

  it('a late run never sends what is overtaken: the later email goes, the earlier is passed over', () => {
    expect(due(['welcome'], -DAY / 2)).toEqual({ send: 'reminder_last', skip: ['reminder_first'] });
    expect(due([], 2 * DAY)).toEqual({ send: 'ended', skip: ['welcome', 'reminder_first', 'reminder_last'] });
    // Suspended already: no "read-only" emails at all.
    expect(due(['welcome', 'reminder_first', 'reminder_last'], 31 * DAY)).toEqual({
      send: null,
      skip: ['ended', 'before_suspend'],
    });
  });

  it('a switched-off email is never sent nor recorded; a trial that ends active gets no read-only emails', () => {
    const off = trialEmailsSchema.parse({ reminder_first: { enabled: false } });
    expect(due(['welcome'], -2 * DAY, off)).toEqual({ send: null, skip: [] });
    const active = dueTrialEmail(
      { ...sub, trialEndStatus: 'active' },
      emails,
      billing,
      new Set(['welcome'] as never),
      at(DAY),
    );
    expect(active).toEqual({ send: null, skip: ['reminder_first', 'reminder_last', 'ended', 'before_suspend'] });
    // Upgraded (no longer a trial): nothing.
    expect(dueTrialEmail({ ...sub, status: 'active' }, emails, billing, new Set(), at(-DAY))).toEqual({
      send: null,
      skip: [],
    });
  });
});

describe('trial emails of a self sign-up account (worker job)', () => {
  let t: TestContext;
  let owner: string;
  let verify: MockInstance;
  let accountId: string;
  let end: Date;
  const subjects = (to: string) => t.mailer.sent.filter((m) => m.to === to).map((m) => m.subject);

  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    verify = mockTurnstile();
    await openSignup(t, owner);
    const start = await pub(t, 'POST', '/public/signup/start', await startBody(t, 'dana@trial-co.io'));
    expect(start.status).toBe(200);
    const res = await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, 'dana@trial-co.io') });
    expect(res.status).toBe(200);
    accountId = (await body(res)).account.id;
    const [sub] = await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, accountId));
    end = sub!.trialEndsAt!;
  });
  afterAll(() => {
    verify.mockRestore();
    return t.close();
  });

  it('the welcome goes out when the account is created, to its admin, with an upgrade button to My plan', () => {
    const welcome = t.mailer.sent.filter((m) => m.to === 'dana@trial-co.io' && m.subject.startsWith('Welcome'));
    expect(welcome).toHaveLength(1);
    expect(welcome[0]!.text).toContain('/admin/plan');
    expect(welcome[0]!.text).toContain('Acme Labs');
  });

  it('each email once, on its day; runs in between send nothing', async () => {
    const run = (ms: number) => sendDueTrialEmails(t.deps, new Date(end.getTime() + ms));
    expect(await run(-5 * DAY)).toBe(0);
    expect(await run(-2.5 * DAY)).toBe(1);
    expect(await run(-2.4 * DAY)).toBe(0);
    expect(await run(-0.5 * DAY)).toBe(1);
    expect(await run(1)).toBe(1);
    expect(await run(2 * DAY)).toBe(0);
    expect(await run(24 * DAY)).toBe(1);
    expect(await run(25 * DAY)).toBe(0);
    expect(subjects('dana@trial-co.io')).toEqual(
      expect.arrayContaining([
        'Welcome to Bines OS',
        '3 days left in your trial',
        'One day left in your trial',
        'Your trial ended — the account is read-only',
        'The account will be suspended in 6 days',
      ]),
    );
    const rows = await t.db.select().from(trialEmailsSent);
    expect(rows.map((r) => r.kind).sort()).toEqual(
      ['before_suspend', 'ended', 'reminder_first', 'reminder_last', 'welcome'].sort(),
    );
  });

  it("the owner's own text and switches (console) apply; other accounts are never mailed", async () => {
    const res = await t.api(owner).patch('/platform/signup-settings', {
      emails: { welcome: { en: { subject: 'Hello {org}, {days}' } }, reminder_first: { enabled: false, days: 5 } },
    });
    expect(res.status).toBe(200);
    const saved = (await body(res)).settings.emails;
    expect(saved.welcome.en.subject).toBe('Hello {org}, {days}');
    expect(saved.reminder_first).toMatchObject({ enabled: false, days: 5 });
    expect(saved.reminder_last).toMatchObject({ enabled: true, days: 1 }); // untouched
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'noa@second-co.io', { org_name: 'Second Co' }));
    await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, 'noa@second-co.io') });
    expect(subjects('noa@second-co.io')).toContain('Hello Second Co, 14');
    const [acc] = await t.db.select().from(accounts).where(eq(accounts.name, 'Second Co'));
    const [sub] = await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, acc!.id));
    await sendDueTrialEmails(t.deps, new Date(sub!.trialEndsAt!.getTime() - 4 * DAY));
    expect(subjects('noa@second-co.io').some((s) => s.includes('days left'))).toBe(false);
    // An account the owner created (not self sign-up) gets none of these.
    const before = t.mailer.sent.length;
    await t.api(owner).post('/platform/accounts', {
      name: 'Manual',
      slug: 'manual',
      first_admin_email: 'm@manual.test',
      template_set: 'empty',
    });
    const after = t.mailer.sent.slice(before).filter((m) => m.subject.includes('trial'));
    expect(after).toHaveLength(0);
  });

  it('request upgrade: admins only, a known plan, an email to the owner without a support desk, then limited', async () => {
    forgetUpgradeRequestLimits();
    const cookie = t.cookieFrom(
      await pub(t, 'POST', '/public/signup/verify', { token: 'nope' }), // no session from a bad token
    );
    expect(cookie).toBeFalsy();
    const [dana] = await t.db.select().from(users).where(eq(users.email, 'dana@trial-co.io'));
    const admin = (await t.signInWithMagicLink(dana!.email)).cookie!;
    const as = (c: string) => t.api(c, accountId);
    const plans = (await body(await as(admin).get('/plans/public'))).data as { id: string; name: string }[];
    expect((await as(admin).post('/plan/upgrade-request', { plan_id: 'nope' })).status).toBe(422);
    // The support desk is on: the request is a ticket of the account (its staff are told as for any ticket).
    const ticketed = await body(await as(admin).post('/plan/upgrade-request', { plan_id: plans[0]!.id }));
    expect(ticketed.ticket_id).toEqual(expect.any(String));
    const ticket = await body(await as(admin).get(`/support/tickets/${ticketed.ticket_id}`));
    expect(ticket.subject).toContain(plans[0]!.name);
    // Desk off: an email to the platform owner instead.
    expect((await t.api(owner).patch('/platform/support/settings', { enabled: false })).status).toBe(200);
    forgetUpgradeRequestLimits();
    const before = t.mailer.sent.length;
    const ok = await as(admin).post('/plan/upgrade-request', { plan_id: plans[0]!.id, note: 'We are 12 people' });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual({ ok: true, ticket_id: null });
    const toOwner = t.mailer.sent.slice(before).find((m) => m.to === OWNER_EMAIL);
    expect(toOwner?.subject).toContain('Acme Labs');
    expect(toOwner?.text).toContain('We are 12 people');
    expect((await as(admin).post('/plan/upgrade-request', {})).status).toBe(200);
    expect((await as(admin).post('/plan/upgrade-request', {})).status).toBe(200);
    expect((await as(admin).post('/plan/upgrade-request', {})).status).toBe(429);
    // Someone not in the account gets nothing from it.
    expect((await t.api(owner, accountId).post('/plan/upgrade-request', {})).status).toBe(404);
  });
});
