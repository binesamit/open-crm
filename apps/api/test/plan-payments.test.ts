// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSubscriptions } from '../src/db/schema';
import { forgetEntitlements } from '../src/modules/billing/entitlements';
import { setPaymentFetchForTests, stripeSignature } from '../src/modules/license/license-payments';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Paid upgrade through Stripe (self sign-up ה9): the license purchase's Stripe keys also sell the public plans (a price
 * per interval); off until set up; My plan → checkout (mocked Stripe — no test ever calls Stripe) → the signed
 * webhook (the same endpoint) makes the subscription active with Stripe's period and emails the admins; a failed
 * payment or a cancelled subscription → past due; replays change nothing. On an installation that is NOT a license
 * server (no signing key): plans still sell.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// A fake Stripe test key, joined at run time so secret scanners do not mistake it for a real one.
const SECRET_KEY = ['sk', 'test', '51AbCdEfGhIjKlMnOpQrStUv'].join('_');
const WEBHOOK_SECRET = 'whsec_TestSigningSecret123456';
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

let t: TestContext;
let owner: string;
let admin: string;
let member: string;
let accountId: string;
let planId: string;
let stripeSub = { status: 'active', start: 1_790_000_000, end: 1_792_600_000 };
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
const sub = async () => {
  const rows = await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, accountId));
  return rows.find((r) => !r.endedAt)!;
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const plan = await body(
    await t.api(owner).post('/platform/plans', { name: 'Pro', version: { price_monthly: 99, price_yearly: 990 } }),
  );
  planId = plan.id;
  const acc = await body(
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.io',
      template_set: 'empty',
    }),
  );
  accountId = acc.account.id;
  admin = await join('admin@acme.io');
  await as(admin).post('/users/invite', { emails: ['mem@acme.io'], role: 'member' });
  member = await join('mem@acme.io');
  const put = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, {
    plan_version_id: plan.current_version_id,
    status: 'trial',
  });
  expect(put.status).toBe(200);
  setPaymentFetchForTests(async (url, init) => {
    calls.push({ url, init });
    const json = url.includes('/checkout/sessions')
      ? { id: 'cs_test_9', url: 'https://checkout.stripe.test/c/cs_test_9' }
      : {
          id: 'sub_123',
          status: stripeSub.status,
          cancel_at_period_end: false,
          items: { data: [{ current_period_start: stripeSub.start, current_period_end: stripeSub.end }] },
        };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterAll(async () => {
  setPaymentFetchForTests(null);
  await t.close();
});

describe('setting it up (owner console)', () => {
  it('off by default: My plan offers the request only; turning on needs the keys and a priced plan', async () => {
    expect(await body(await as(admin).get('/plan/checkout'))).toEqual({
      available: false,
      plans: [],
      addons: [],
      vat_pct: 18,
      legal: [],
    });
    const early = await t.api(owner).patch('/platform/plan-payments', { enabled: true });
    expect(early.status).toBe(422);
    const res = await body(
      await t.api(owner).patch('/platform/plan-payments', {
        secret_key: SECRET_KEY,
        webhook_secret: WEBHOOK_SECRET,
        prices: { [planId]: { month: 'price_ProMonthly01', year: null } },
        enabled: true,
      }),
    );
    expect(res).toMatchObject({ enabled: true, ready: true, secret_key_set: true, webhook_secret_set: true });
    expect(res.prices[planId]).toEqual({ month: 'price_ProMonthly01', year: null });
    expect(JSON.stringify(res)).not.toContain(SECRET_KEY);
    expect(res.webhook_url).toContain('/api/v1/public/licenses/webhook/stripe');
    expect(
      (await t.api(owner).patch('/platform/plan-payments', { prices: { [planId]: { year: 'nope' } } })).status,
    ).toBe(400);
  });
});

describe('an admin upgrades', () => {
  it('admins only; the priced plan and interval; a Stripe Checkout session tagged with the account', async () => {
    expect((await as(member).get('/plan/checkout')).status).toBe(403);
    const opts = await body(await as(admin).get('/plan/checkout'));
    expect(opts).toEqual({
      available: true,
      plans: [{ plan_id: planId, name: 'Pro', intervals: ['month'] }],
      addons: [],
      vat_pct: 18,
      legal: [],
    });
    expect((await as(admin).post('/plan/checkout', { plan_id: planId, interval: 'year' })).status).toBe(422);
    const res = await body(await as(admin).post('/plan/checkout', { plan_id: planId, interval: 'month' }));
    expect(res).toEqual({ url: 'https://checkout.stripe.test/c/cs_test_9' });
    const sent = new URLSearchParams(String(calls.at(-1)!.init.body));
    expect(sent.get('mode')).toBe('subscription');
    expect(sent.get('line_items[0][price]')).toBe('price_ProMonthly01');
    expect(sent.get('metadata[kind]')).toBe('account_plan');
    expect(sent.get('metadata[account_id]')).toBe(accountId);
    expect(sent.get('subscription_data[metadata][account_id]')).toBe(accountId);
    expect(sent.get('customer_email')).toBe('admin@acme.io');
    expect(sent.get('success_url')).toContain('/a/acme/admin/plan?checkout=success');
    expect(String((calls.at(-1)!.init.headers as Record<string, string>).authorization)).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('the paid checkout (signed webhook): trial → active with Stripe’s period, emailed; a replay changes nothing', async () => {
    const before = t.mailer.sent.length;
    const ev = {
      id: 'evt_paid_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_9',
          payment_status: 'paid',
          subscription: 'sub_123',
          metadata: { kind: 'account_plan', account_id: accountId, plan_id: planId, interval: 'month' },
        },
      },
    };
    const res = await webhook(ev);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ received: true, handled: 'activated' });
    const s = await sub();
    expect(s).toMatchObject({ status: 'active', provider: 'stripe', externalId: 'sub_123', trialEndsAt: null });
    expect(s.periodEnd!.getTime()).toBe(stripeSub.end * 1000);
    expect(t.mailer.sent.slice(before).some((m) => m.to === 'admin@acme.io' && m.subject.includes('Pro'))).toBe(true);
    forgetEntitlements(accountId);
    expect((await body(await as(admin).get('/plan'))).subscription.status).toBe('active');
    expect(await body(await webhook(ev))).toEqual({ received: true, handled: 'duplicate' });
  });

  it('a failed payment → past due (emailed); the next paid invoice → active; cancelled → past due', async () => {
    const failed = await webhook({
      id: 'evt_fail_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', subscription: 'sub_123' } },
    });
    expect(await body(failed)).toEqual({ received: true, handled: 'past_due' });
    expect((await sub()).status).toBe('past_due');

    stripeSub = { status: 'active', start: 1_792_600_000, end: 1_795_200_000 };
    const paid = await webhook({
      id: 'evt_paid_2',
      type: 'invoice.paid',
      data: { object: { id: 'in_2', billing_reason: 'subscription_cycle', subscription: 'sub_123' } },
    });
    expect(await body(paid)).toEqual({ received: true, handled: 'renewed' });
    const renewed = await sub();
    expect(renewed.status).toBe('active');
    expect(renewed.periodEnd!.getTime()).toBe(1_795_200_000 * 1000);

    const gone = await webhook({
      id: 'evt_del_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_123', status: 'canceled' } },
    });
    expect(await body(gone)).toEqual({ received: true, handled: 'past_due' });
    expect((await sub()).status).toBe('past_due');
  });

  it('not ours: an unsigned call is refused; another subscription’s event is the license purchase’s (none here)', async () => {
    const raw = JSON.stringify({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } });
    const bad = await t.app.request('/api/v1/public/licenses/webhook/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' },
      body: raw,
    });
    expect(bad.status).toBe(401);
    const other = await webhook({
      id: 'evt_other',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_9', subscription: 'sub_unknown' } },
    });
    // Not a license server here: the license purchase answers 404, and no account changed.
    expect(other.status).toBe(404);
    expect((await sub()).status).toBe('past_due');
  });
});
