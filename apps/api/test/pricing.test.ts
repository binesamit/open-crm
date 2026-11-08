// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSubscriptions, issuedLicenses } from '../src/db/schema';
import { forgetPricingPage } from '../src/modules/billing/pricing.service';
import { forgetLicense } from '../src/modules/license/license.service';
import { resetLicenseServerLimits } from '../src/modules/license/license-server.service';
import { resetPurchaseLimits } from '../src/modules/license/license-purchase.service';
import { setPaymentFetchForTests, stripeSignature } from '../src/modules/license/license-payments';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * The pricing page and its calculator: the plans' marketing fields, add-ons (the owner's units that
 * raise one limit — a snapshot on the subscription), the page's settings and the public JSON (off by default; no
 * sign-in; CORS for the owner's sites only), the upgrade checkout's seats and add-on lines (mocked Stripe) and what
 * the paid webhook applies; on a license server, editions sold in seat tiers.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// A fake Stripe test key, joined at run time so secret scanners do not mistake it for a real one.
const SECRET_KEY = ['sk', 'test', '51AbCdEfGhIjKlMnOpQrStUv'].join('_');
const WEBHOOK_SECRET = 'whsec_TestSigningSecret123456';
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

describe('the pricing page (cloud)', () => {
  let t: TestContext;
  let owner: string;
  let admin: string;
  let accountId: string;
  let freeId: string;
  let proId: string;
  let proVersion: string;
  let hiddenId: string;
  let storage: Json;
  let runs: Json;
  const calls: { url: string; init: RequestInit }[] = [];
  const as = (cookie: string) => t.api(cookie, accountId);
  const pub = (path: string, init: RequestInit = {}) => t.app.request(`/api/v1${path}`, init);
  const join = async (email: string) => {
    const token = t.inviteTokenFor(email);
    const cookie = (await t.signInWithMagicLink(email)).cookie!;
    await t.api(cookie).post('/invitations/accept', { token });
    return cookie;
  };
  const sub = async () =>
    (await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, accountId))).find(
      (r) => !r.endedAt,
    )!;
  const webhook = (payload: unknown) => {
    const raw = JSON.stringify(payload);
    return pub('/public/licenses/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(WEBHOOK_SECRET, raw, Math.floor(Date.now() / 1000)),
      },
      body: raw,
    });
  };

  beforeAll(async () => {
    forgetPricingPage();
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
    setPaymentFetchForTests(async (url, init) => {
      calls.push({ url, init });
      const json = url.includes('/checkout/sessions')
        ? { id: 'cs_test_p', url: 'https://checkout.stripe.test/c/cs_test_p' }
        : {
            id: 'sub_p',
            status: 'active',
            cancel_at_period_end: false,
            items: { data: [{ current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] },
          };
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }, 180_000);
  afterAll(async () => {
    setPaymentFetchForTests(null);
    forgetPricingPage();
    await t.close();
  });

  it('plans carry the marketing fields (highlights, recommended, a per-seat minimum)', async () => {
    const free = await body(
      await t.api(owner).post('/platform/plans', {
        name: 'Free',
        sort: 0,
        highlights: ['Up to 2 people'],
        version: { price_monthly: 0, price_yearly: 0, limits: { seats: 2, storage_gb: 1 } },
      }),
    );
    freeId = free.id;
    const pro = await body(
      await t.api(owner).post('/platform/plans', {
        name: 'Pro',
        description: 'For teams that connect everything',
        sort: 1,
        highlights: ['API and MCP', ' Extensions '],
        recommended: true,
        min_seats: 3,
        version: {
          price_monthly: 85,
          price_yearly: 828,
          vat_included: false,
          pricing: 'per_seat',
          trial_days: 14,
          limits: { storage_gb: 100, automation_runs: 10_000 },
          features: ['api', 'extensions'],
        },
      }),
    );
    proId = pro.id;
    proVersion = pro.current_version_id;
    expect(pro).toMatchObject({ highlights: ['API and MCP', 'Extensions'], recommended: true, min_seats: 3 });
    const hidden = await body(
      await t
        .api(owner)
        .post('/platform/plans', { name: 'Hidden', visibility: 'hidden', version: { price_monthly: 1 } }),
    );
    hiddenId = hidden.id;
    const patched = await body(
      await t.api(owner).patch(`/platform/plans/${proId}`, { highlights: ['API and MCP'], min_seats: null }),
    );
    expect(patched).toMatchObject({ highlights: ['API and MCP'], recommended: true, min_seats: null });
    await t.api(owner).patch(`/platform/plans/${proId}`, { min_seats: 3 });
    expect((await t.api(owner).patch(`/platform/plans/${proId}`, { min_seats: 0 })).status).toBe(400);
  });

  it('add-ons: the owner’s alone (404 to others), validated, listed in order', async () => {
    expect((await as(admin).get('/platform/plan-addons')).status).toBe(404);
    storage = await body(
      await t.api(owner).post('/platform/plan-addons', {
        name: 'Storage 100GB',
        limit_kind: 'storage_gb',
        unit_amount: 100,
        price_monthly: 29,
        price_yearly: 290,
        vat_included: false,
        sort: 1,
      }),
    );
    expect(storage).toMatchObject({ name: 'Storage 100GB', limit_kind: 'storage_gb', max_qty: 20, active: true });
    runs = await body(
      await t.api(owner).post('/platform/plan-addons', {
        name: '5,000 runs',
        limit_kind: 'automation_runs',
        unit_amount: 5000,
        price_monthly: 39,
        price_yearly: 390,
        plan_ids: [proId],
        sort: 0,
      }),
    );
    expect(
      (await t.api(owner).post('/platform/plan-addons', { name: 'Bad', limit_kind: 'nope', unit_amount: 1 })).status,
    ).toBe(400);
    expect(
      (await t.api(owner).post('/platform/plan-addons', { name: 'Zero', limit_kind: 'items', unit_amount: 0 })).status,
    ).toBe(400);
    const list = (await body(await t.api(owner).get('/platform/plan-addons'))).data as Json[];
    expect(list.map((a) => a.name)).toEqual(['5,000 runs', 'Storage 100GB']);
  });

  it('the public JSON is off by default: no plans, no texts — and needs no sign-in', async () => {
    const res = await pub('/public/pricing');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ enabled: false, plans: [], addons: [], faq: [], self_host: null });
    expect((await as(admin).get('/platform/pricing-page')).status).toBe(404);
  });

  it('turned on: the public plans in order with their fields, active add-ons, the owner’s texts', async () => {
    const off = await body(
      await t.api(owner).post('/platform/plan-addons', {
        name: 'Off sale',
        limit_kind: 'items',
        unit_amount: 1000,
        active: false,
      }),
    );
    const page = await body(
      await t.api(owner).patch('/platform/pricing-page', {
        enabled: true,
        headline: 'Clear pricing',
        yearly_note: 'Two months free',
        vat_pct: 17,
        contact_url: 'mailto:sales@example.com',
        custom_name: 'Enterprise',
        custom_text: 'SSO and SLA',
        faq: [{ q: 'What is a seat?', a: 'A person with a login.' }],
        cors_origins: ['https://www.example.com'],
      }),
    );
    expect(page).toMatchObject({ enabled: true, vat_pct: 17, vat_default_on: false, headline: 'Clear pricing' });
    expect((await t.api(owner).patch('/platform/pricing-page', { cors_origins: ['not a url'] })).status).toBe(400);
    expect((await t.api(owner).patch('/platform/pricing-page', { contact_url: 'javascript:alert(1)' })).status).toBe(
      400,
    );

    const json = await body(await pub('/public/pricing'));
    expect(json).toMatchObject({
      enabled: true,
      headline: 'Clear pricing',
      yearly_note: 'Two months free',
      vat_pct: 17,
      contact_url: 'mailto:sales@example.com',
      custom: { name: 'Enterprise', text: 'SSO and SLA' },
      faq: [{ q: 'What is a seat?', a: 'A person with a login.' }],
      signup_open: false,
      self_host: null,
    });
    expect((json.plans as Json[]).map((p) => p.id)).toEqual([freeId, proId]);
    expect(json.plans.some((p: Json) => p.id === hiddenId)).toBe(false);
    expect(json.plans[1]).toMatchObject({
      name: 'Pro',
      description: 'For teams that connect everything',
      highlights: ['API and MCP'],
      recommended: true,
      min_seats: 3,
      price_monthly: 85,
      price_yearly: 828,
      vat_included: false,
      pricing: 'per_seat',
      trial_days: 14,
      limits: { storage_gb: 100, automation_runs: 10_000 },
    });
    expect((json.addons as Json[]).map((a) => a.name)).toEqual(['5,000 runs', 'Storage 100GB']);
    expect(json.addons.some((a: Json) => a.id === off.id)).toBe(false);
    expect(json.addons[0]).not.toHaveProperty('active');
    // Nothing internal leaks: no subscriber counts, no version ids.
    expect(JSON.stringify(json)).not.toContain('subscribers');
    expect(JSON.stringify(json)).not.toContain(proVersion);
  });

  it('CORS: a listed site may read it from a browser; any other site gets no access', async () => {
    const listed = await pub('/public/pricing', { headers: { origin: 'https://www.example.com' } });
    expect(listed.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
    expect(listed.headers.get('access-control-allow-credentials')).toBeNull();
    const other = await pub('/public/pricing', { headers: { origin: 'https://evil.example.org' } });
    expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.org');
    // Only this route: another public route keeps the platform's own CORS.
    const elsewhere = await pub('/public/signup/config', { headers: { origin: 'https://www.example.com' } });
    expect(elsewhere.headers.get('access-control-allow-origin')).not.toBe('https://www.example.com');
  });

  it('add-ons held raise their limit (a snapshot: a later edit does not change it); off-sale ones are refused', async () => {
    const put = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, {
      plan_version_id: proVersion,
      status: 'active',
      addons: { [storage.id]: 2, [runs.id]: 1 },
    });
    expect(put.status).toBe(200);
    const view = await body(put);
    expect(view.subscription.addons[storage.id]).toEqual({
      qty: 2,
      limit_kind: 'storage_gb',
      amount: 200,
      name: 'Storage 100GB',
    });
    expect(view.entitlements.limits).toMatchObject({ storage_gb: 300, automation_runs: 15_000 });
    // The owner changes the add-on: what the account holds stays.
    await t.api(owner).patch(`/platform/plan-addons/${storage.id}`, { unit_amount: 50, active: false });
    const again = await body(await as(admin).get('/plan'));
    expect(again.entitlements.limits.storage_gb).toBe(300);
    // Same quantity of an add-on now off sale: kept. A new quantity: refused.
    const same = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, {
      plan_version_id: proVersion,
      addons: { [storage.id]: 2, [runs.id]: 1 },
    });
    expect(same.status).toBe(200);
    const more = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, {
      plan_version_id: proVersion,
      addons: { [storage.id]: 3 },
    });
    expect(more.status).toBe(422);
    expect((await body(more)).error.message).toBe('addon_invalid');
    await t.api(owner).patch(`/platform/plan-addons/${storage.id}`, { unit_amount: 100, active: true });
    // 0 drops one.
    const drop = await body(
      await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, {
        plan_version_id: proVersion,
        addons: { [storage.id]: 0, [runs.id]: 1 },
      }),
    );
    expect(drop.subscription.addons[storage.id]).toBeUndefined();
    expect(drop.entitlements.limits.storage_gb).toBe(100);
    // An unlimited limit stays unlimited.
    expect(drop.entitlements.limits.items ?? null).toBeNull();
  });

  it('checkout: seats as the quantity (at least the people in it and the minimum), add-ons as their own lines', async () => {
    await t.api(owner).patch('/platform/plan-payments', {
      secret_key: SECRET_KEY,
      webhook_secret: WEBHOOK_SECRET,
      prices: { [proId]: { month: 'price_ProMonthly01', year: 'price_ProYearly01' } },
      addon_prices: { [storage.id]: { month: 'price_StorageM01', year: null } },
      enabled: true,
    });
    const opts = await body(await as(admin).get('/plan/checkout'));
    expect(opts.vat_pct).toBe(17);
    expect(opts.addons).toEqual([
      expect.objectContaining({ id: storage.id, name: 'Storage 100GB', intervals: ['month'], max_qty: 20 }),
    ]);
    const payments = await body(await t.api(owner).get('/platform/plan-payments'));
    expect(payments.addon_prices[storage.id]).toEqual({ month: 'price_StorageM01', year: null });

    // Default: the seats in use (1) lifted to the plan's minimum (3).
    expect((await as(admin).post('/plan/checkout', { plan_id: proId, interval: 'month' })).status).toBe(200);
    let sent = new URLSearchParams(String(calls.at(-1)!.init.body));
    expect(sent.get('line_items[0][price]')).toBe('price_ProMonthly01');
    expect(sent.get('line_items[0][quantity]')).toBe('3');
    expect(sent.get('metadata[seats]')).toBe('3');

    const res = await as(admin).post('/plan/checkout', {
      plan_id: proId,
      interval: 'month',
      seats: 8,
      addons: { [storage.id]: 2 },
    });
    expect(res.status).toBe(200);
    sent = new URLSearchParams(String(calls.at(-1)!.init.body));
    expect(sent.get('line_items[0][quantity]')).toBe('8');
    expect(sent.get('line_items[1][price]')).toBe('price_StorageM01');
    expect(sent.get('line_items[1][quantity]')).toBe('2');
    expect(sent.get('metadata[addons]')).toBe(`${storage.id}:2`);

    // An add-on with no price for the interval, or not sold online at all: refused.
    const yearly = await as(admin).post('/plan/checkout', {
      plan_id: proId,
      interval: 'year',
      addons: { [storage.id]: 1 },
    });
    expect(yearly.status).toBe(422);
    expect((await body(yearly)).error.message).toBe('addon_not_for_sale');
    expect(
      (await as(admin).post('/plan/checkout', { plan_id: proId, interval: 'month', addons: { [runs.id]: 1 } })).status,
    ).toBe(422);
  });

  it('never fewer seats than the people in the account', async () => {
    await as(admin).post('/users/invite', { emails: ['a@acme.io', 'b@acme.io', 'c@acme.io'], role: 'member' });
    const res = await as(admin).post('/plan/checkout', { plan_id: proId, interval: 'month', seats: 3 });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('seats_below_usage');
  });

  it('the paid webhook applies the seats and the add-ons bought', async () => {
    const res = await webhook({
      id: 'evt_pricing_paid',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_p',
          payment_status: 'paid',
          subscription: 'sub_p',
          metadata: {
            kind: 'account_plan',
            account_id: accountId,
            plan_id: proId,
            interval: 'month',
            seats: '8',
            addons: `${storage.id}:2,nope:1`,
          },
        },
      },
    });
    expect(await body(res)).toEqual({ received: true, handled: 'activated' });
    const s = await sub();
    expect(s).toMatchObject({ status: 'active', seats: 8 });
    expect(Object.keys(s.addons as Json)).toEqual([storage.id]);
    const plan = await body(await as(admin).get('/plan'));
    expect(plan.entitlements.limits).toMatchObject({ seats: 8, storage_gb: 300 });
  });
});

describe('the pricing page on a license server: editions in seat tiers', () => {
  let t: TestContext;
  let owner: string;
  const calls: { url: string; init: RequestInit }[] = [];
  const pub = (path: string, init: RequestInit = {}) => t.app.request(`/api/v1${path}`, init);
  const post = (path: string, payload: unknown) =>
    pub(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const signingPem = () =>
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  beforeAll(async () => {
    forgetLicense();
    forgetPricingPage();
    resetLicenseServerLimits();
    resetPurchaseLimits();
    t = await createTestContext({ env: { LICENSE_SIGNING_KEY: signingPem().replace(/\n/g, '\\n') } });
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    setPaymentFetchForTests(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'cs_t', url: 'https://checkout.stripe.test/c/cs_t' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  }, 180_000);
  afterAll(async () => {
    setPaymentFetchForTests(null);
    forgetLicense();
    forgetPricingPage();
    await t.close();
  });

  it('tiers: each with its seats, its price and the price shown; the pricing page and /buy show them', async () => {
    const ops = await t.api(owner).patch('/platform/license-ops', {
      payments: {
        secret_key: SECRET_KEY,
        webhook_secret: WEBHOOK_SECRET,
        plans: {
          business: {
            mode: 'subscription',
            currency: 'USD',
            tiers: [
              { seats: 25, price_id: 'price_b25', display_amount: 590 },
              { seats: 100, price_id: 'price_b100', display_amount: 1490 },
              { seats: null, price_id: '', display_amount: 2990 },
            ],
          },
        },
        enabled: true,
      },
    });
    expect(ops.status).toBe(200);
    expect((await body(ops)).payments.ready).toBe(true);
    await t.api(owner).patch('/platform/pricing-page', { enabled: true });
    const json = await body(await pub('/public/pricing'));
    expect(json.self_host.buy_available).toBe(true);
    expect(json.self_host.editions.find((e: Json) => e.plan === 'business')).toEqual({
      plan: 'business',
      currency: 'USD',
      tiers: [
        { index: 0, seats: 25, amount: 590 },
        { index: 1, seats: 100, amount: 1490 },
        { index: 2, seats: null, amount: 2990 },
      ],
    });
    // /buy offers only the tiers it can sell online.
    const buy = await body(await pub('/public/licenses/purchase'));
    expect(buy.plans).toEqual([
      {
        plan: 'business',
        seats: null,
        amount: null,
        currency: 'USD',
        tiers: [
          { index: 0, seats: 25, amount: 590 },
          { index: 1, seats: 100, amount: 1490 },
        ],
      },
    ]);
  });

  it('checkout of a tier uses its price and tags it; the paid webhook issues a key with the tier’s seats', async () => {
    expect((await post('/public/licenses/checkout', { plan: 'business', tier: 1 })).status).toBe(200);
    const sent = new URLSearchParams(String(calls.at(-1)!.init.body));
    expect(sent.get('line_items[0][price]')).toBe('price_b100');
    expect(sent.get('metadata[tier]')).toBe('1');
    // A tier shown but not sold online: refused.
    expect((await post('/public/licenses/checkout', { plan: 'business', tier: 2 })).status).toBe(422);

    const raw = JSON.stringify({
      id: 'evt_tier_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_t',
          payment_status: 'paid',
          customer: 'cus_t',
          subscription: 'sub_t',
          customer_details: { email: 'buyer@tier.test', name: 'Tier Buyer' },
          metadata: { plan: 'business', tier: '1', instance_id: '', locale: 'en' },
        },
      },
    });
    const res = await pub('/public/licenses/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(WEBHOOK_SECRET, raw, Math.floor(Date.now() / 1000)),
      },
      body: raw,
    });
    expect(await body(res)).toEqual({ received: true, handled: 'issued' });
    const row = (await t.db.select().from(issuedLicenses).where(eq(issuedLicenses.paymentSubscriptionId, 'sub_t')))[0]!;
    expect(row.seats).toBe(100);
  });
});
