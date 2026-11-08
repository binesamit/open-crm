// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSubscriptions } from '../src/db/schema';
import { forgetEntitlements } from '../src/modules/billing/entitlements';
import { sendRenewalReminders } from '../src/modules/billing/renewal-reminder';
import { setPaymentFetchForTests, stripeSignature } from '../src/modules/license/license-payments';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Agreements for subscriptions: the purchase documents are ticked at checkout (recorded with the
 * version); the purchase email carries the seller's details and the cancel terms; an admin previews and confirms a
 * cancel by the billing settings' rules — the provider that bills it carries it out (Stripe mocked: no test calls
 * Stripe), a hand-set subscription tells the owners what to refund; a cancel with nothing refunded is undone until
 * the period ends; a yearly plan is reminded before it renews, once.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// A fake Stripe test key, joined at run time so secret scanners do not mistake it for a real one.
const SECRET_KEY = ['sk', 'test', '51AbCdEfGhIjKlMnOpQrStUv'].join('_');
const WEBHOOK_SECRET = 'whsec_TestSigningSecret123456';
const DAY = 86_400_000;
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

let t: TestContext;
let owner: string;
let admin: string;
let member: string;
let accountId: string;
let planId: string;
let versionId: string;
const calls: { url: string; init: RequestInit }[] = [];
const as = (cookie: string) => t.api(cookie, accountId);
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = (await t.signInWithMagicLink(email)).cookie!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const webhook = (payload: unknown) => {
  const raw = JSON.stringify(payload);
  return t.app.request('/api/v1/public/licenses/webhook/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripeSignature(WEBHOOK_SECRET, raw, Math.floor(Date.now() / 1000)),
    },
    body: raw,
  });
};
const sub = async () =>
  (await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, accountId))).find(
    (r) => !r.endedAt,
  )!;
const setSub = async (patch: Partial<typeof accountSubscriptions.$inferInsert>) => {
  await t.db
    .update(accountSubscriptions)
    .set(patch)
    .where(eq(accountSubscriptions.id, (await sub()).id));
  forgetEntitlements(accountId);
};
/** A hand-set subscription (no provider), as the owner assigns it. */
const assign = async (interval: 'month' | 'year') => {
  const res = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, {
    plan_version_id: versionId,
    status: 'active',
    interval,
    cancel_at_period_end: false,
  });
  expect(res.status).toBe(200);
  await setSub({ provider: null, externalId: null, purchasedAt: null, cancellation: null, cancelAtPeriodEnd: false });
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const plan = await body(
    await t.api(owner).post('/platform/plans', { name: 'Pro', version: { price_monthly: 120, price_yearly: 1000 } }),
  );
  planId = plan.id;
  versionId = plan.current_version_id;
  accountId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.io',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.io');
  await as(admin).post('/users/invite', { emails: ['mem@acme.io'], role: 'member' });
  member = await join('mem@acme.io');
  await t.api(owner).patch('/platform/settings', {
    legal: {
      company_legal_name: 'Operator Ltd',
      company_id: '512345678',
      company_address: '1 Main St',
      contact_email: 'hello@operator.test',
    },
  });
  setPaymentFetchForTests(async (url, init) => {
    calls.push({ url, init });
    let json: Json = {};
    if (url.includes('/checkout/sessions')) json = { id: 'cs_1', url: 'https://checkout.stripe.test/c/cs_1' };
    else if (url.includes('expand[]=latest_invoice'))
      json = {
        id: 'sub_9',
        latest_invoice: { id: 'in_9', amount_paid: 120_000, currency: 'ils', payment_intent: 'pi_9' },
      };
    else if (url.includes('/refunds')) json = { id: 're_1' };
    else if (url.includes('/subscriptions/'))
      json = {
        id: 'sub_9',
        status: 'active',
        cancel_at_period_end: false,
        items: {
          data: [
            {
              current_period_start: Math.floor(Date.now() / 1000),
              current_period_end: Math.floor((Date.now() + 365 * DAY) / 1000),
            },
          ],
        },
      };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await t.api(owner).patch('/platform/plan-payments', {
    secret_key: SECRET_KEY,
    webhook_secret: WEBHOOK_SECRET,
    prices: { [planId]: { month: 'price_ProMonthly01', year: 'price_ProYearly01' } },
    enabled: true,
  });
});
afterAll(async () => {
  setPaymentFetchForTests(null);
  await t.close();
});

describe('buying: the purchase documents and the confirmation', () => {
  it('asks for the published subscription terms at checkout and records the acceptance', async () => {
    expect((await t.api(owner).post('/platform/legal/subscription/publish')).status).toBe(200);
    const opts = await body(await as(admin).get('/plan/checkout'));
    expect(opts.legal.map((d: Json) => d.slug)).toEqual(['subscription']);
    const doc = opts.legal[0];
    const missing = await as(admin).post('/plan/checkout', { plan_id: planId, interval: 'year' });
    expect(missing.status).toBe(422);
    expect((await body(missing)).error.code).toBe('legal_consent_required');
    const ok = await as(admin).post('/plan/checkout', {
      plan_id: planId,
      interval: 'year',
      accepted: [{ slug: 'subscription', version: doc.version }],
    });
    expect(ok.status).toBe(200);
    const csv = await (await t.api(owner).get('/platform/legal/consents.csv?slug=subscription')).text();
    expect(csv).toMatch(/subscription,1,[^,]+,checkout,admin@acme\.io/);
  });

  it('the paid checkout records when it was bought and emails the seller’s details and the cancel terms', async () => {
    const before = t.mailer.sent.length;
    const res = await webhook({
      id: 'evt_paid_9',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          payment_status: 'paid',
          subscription: 'sub_9',
          amount_total: 100_000,
          currency: 'ils',
          metadata: { kind: 'account_plan', account_id: accountId, plan_id: planId, interval: 'year' },
        },
      },
    });
    expect(await body(res)).toEqual({ received: true, handled: 'activated' });
    const s = await sub();
    expect(s.purchasedAt).toBeInstanceOf(Date);
    const mail = t.mailer.sent.slice(before).find((m) => m.to === 'admin@acme.io')!;
    const text = JSON.stringify(mail);
    expect(text).toContain('Operator Ltd');
    expect(text).toContain('512345678');
    expect(text).toContain('/legal/subscription');
  });
});

describe('cancelling', () => {
  it('admins only; inside the window: refund less the fee, the provider cancels now and refunds', async () => {
    expect((await as(member).get('/plan/cancel')).status).toBe(403);
    const p = await body(await as(admin).get('/plan/cancel'));
    // ₪1,000 paid; 5% = ₪50 (under the ₪100 cap) → ₪950
    expect(p).toMatchObject({ available: true, case: 'cooling_off', paid: 1000, fee: 50, refund: 950 });
    expect(p.automatic_refund).toBe(true);
    expect(p.terms.slug).toBe('subscription');
    expect((await as(admin).post('/plan/cancel', { expected_refund: 900 })).status).toBe(409);
    const n = calls.length;
    const res = await as(admin).post('/plan/cancel', { expected_refund: 950 });
    expect(res.status).toBe(200);
    const made = calls.slice(n);
    expect(made.some((c) => c.init.method === 'DELETE' && c.url.endsWith('/subscriptions/sub_9'))).toBe(true);
    const refund = made.find((c) => c.url.endsWith('/refunds'))!;
    const sent = new URLSearchParams(String(refund.init.body));
    expect(sent.get('payment_intent')).toBe('pi_9');
    // the share refunded (950 / 1000) of what Stripe actually took
    expect(sent.get('amount')).toBe(String(Math.round(120_000 * 0.95)));
    const plan = await body(res);
    expect(plan.subscription.cancellation).toMatchObject({ case: 'cooling_off', refund: 950, resumable: false });
    expect((await body(await as(admin).get('/plan/cancel'))).reason).toBe('already_canceled');
    // the deletion Stripe then reports ends it as cancelled, not as a failed payment
    await webhook({ id: 'evt_del_9', type: 'customer.subscription.deleted', data: { object: { id: 'sub_9' } } });
    expect((await sub()).status).toBe('active');
    expect((await sub()).cancelAtPeriodEnd).toBe(true);
  });

  it('monthly by hand: no refund, it ends with the month, and the cancel can be undone', async () => {
    await assign('month');
    const p = await body(await as(admin).get('/plan/cancel'));
    expect(p).toMatchObject({ case: 'period_end', refund: 0, automatic_refund: false });
    const done = await body(await as(admin).post('/plan/cancel', { expected_refund: 0 }));
    expect(done.subscription.cancel_at_period_end).toBe(true);
    expect(done.subscription.cancellation).toMatchObject({ case: 'period_end', resumable: true });
    const undone = await body(await as(admin).post('/plan/cancel/undo'));
    expect(undone.subscription.cancel_at_period_end).toBe(false);
    expect(undone.subscription.cancellation).toBeNull();
    expect((await as(admin).post('/plan/cancel/undo')).status).toBe(409);
  });

  it('yearly by hand: the unused part at the monthly price; the owners are told to refund it', async () => {
    await assign('year');
    // 4 months started: 1,000 − 4 × 120 = ₪520
    const start = new Date(Date.now() - (3 * 30 + 5) * DAY);
    await setSub({ periodStart: start, periodEnd: new Date(start.getTime() + 365 * DAY) });
    const p = await body(await as(admin).get('/plan/cancel'));
    expect(p).toMatchObject({ case: 'yearly_refund', months_used: 4, monthly_price: 120, refund: 520 });
    const before = t.mailer.sent.length;
    await as(admin).post('/plan/cancel', { expected_refund: 520 });
    const mails = t.mailer.sent.slice(before);
    expect(mails.some((m) => m.to === OWNER_EMAIL && JSON.stringify(m).includes('Acme'))).toBe(true);
    expect(mails.some((m) => m.to === 'admin@acme.io')).toBe(true);
    const s = await sub();
    expect(s.cancelAtPeriodEnd).toBe(true);
    expect((s.cancellation as Json).refund_minor).toBe(52_000);
    expect((await as(admin).post('/plan/cancel/undo')).status).toBe(409);
  });

  it('yearly by hand, late in the year: nothing back, it runs to the year’s end', async () => {
    await assign('year');
    const start = new Date(Date.now() - (8 * 30 + 10) * DAY);
    const end = new Date(start.getTime() + 365 * DAY);
    await setSub({ periodStart: start, periodEnd: end });
    const p = await body(await as(admin).get('/plan/cancel'));
    expect(p).toMatchObject({ case: 'yearly_no_refund', refund: 0 });
    expect(new Date(p.ends_at).getTime()).toBe(end.getTime());
  });
});

describe('the yearly renewal reminder', () => {
  it('emails the admins once before a yearly plan renews by itself', async () => {
    await assign('year');
    await setSub({ periodEnd: new Date(Date.now() + 10 * DAY), renewalRemindedFor: null });
    const before = t.mailer.sent.length;
    expect(await sendRenewalReminders(t.deps)).toBeGreaterThanOrEqual(1);
    expect(t.mailer.sent.slice(before).some((m) => m.to === 'admin@acme.io')).toBe(true);
    expect(await sendRenewalReminders(t.deps)).toBe(0);
    // off when the setting is empty
    await setSub({ renewalRemindedFor: null });
    await t.api(owner).patch('/platform/billing-settings', { renewal_reminder_days: null });
    expect(await sendRenewalReminders(t.deps)).toBe(0);
  });
});
