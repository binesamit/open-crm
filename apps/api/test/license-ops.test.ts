// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyLicenseKey } from '../src/modules/license/license-key';
import { forgetLicense } from '../src/modules/license/license.service';
import { resetLicenseServerLimits } from '../src/modules/license/license-server.service';
import { resetPurchaseLimits } from '../src/modules/license/license-purchase.service';
import { dueThreshold, sendExpiryReminders } from '../src/modules/license/license-reminders';
import { setPaymentFetchForTests, stripeProvider, stripeSignature } from '../src/modules/license/license-payments';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * License operations: expiry reminders (settings, the hourly job's thresholds, idempotency, reset
 * on renewal, the markers in the Licenses list) and the optional Stripe purchase (OFF and hidden until set up;
 * secrets sealed and never returned; checkout through a mocked Stripe — no test ever calls Stripe; the webhook's
 * signature check; a paid checkout issues and emails the key; a subscription's next invoice renews it; replays
 * change nothing). And an installation that is not a license server: all of it 404 / 503 / no-op.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DAY = 86_400_000;
// A fake Stripe test key, joined at run time so secret scanners do not mistake it for a real one.
const SECRET_KEY = ['sk', 'test', '51AbCdEfGhIjKlMnOpQrStUv'].join('_');
const WEBHOOK_SECRET = 'whsec_TestSigningSecret123456';
const signingPem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const iso = (ms: number) => new Date(ms).toISOString();

describe('license operations on a license server', () => {
  let t: TestContext;
  let owner: string;
  const stripeCalls: { url: string; init: RequestInit }[] = [];

  const publicCall = (path: string, init: RequestInit = {}) => t.app.request(`/api/v1${path}`, init);
  const webhook = (payload: unknown, opts: { secret?: string; at?: number; signature?: string | null } = {}) => {
    const raw = JSON.stringify(payload);
    const sig =
      opts.signature === undefined
        ? stripeSignature(opts.secret ?? WEBHOOK_SECRET, raw, Math.floor((opts.at ?? Date.now()) / 1000))
        : opts.signature;
    return publicCall('/public/licenses/webhook/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) },
      body: raw,
    });
  };
  const licenses = async () => (await body(await t.api(owner).get('/platform/licenses'))).data as Json[];
  const issue = async (extra: Json) =>
    body(
      await t.api(owner).post('/platform/licenses', {
        plan: 'business',
        features: ['sso'],
        licensee: 'Acme',
        seats: 10,
        ...extra,
      }),
    );
  const mailsTo = (to: string) => t.mailer.sent.filter((m) => m.to === to);

  beforeAll(async () => {
    forgetLicense();
    resetLicenseServerLimits();
    resetPurchaseLimits();
    t = await createTestContext({ env: { LICENSE_SIGNING_KEY: signingPem().replace(/\n/g, '\\n') } });
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    setPaymentFetchForTests(async (url, init) => {
      stripeCalls.push({ url, init });
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/cs_test_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  }, 180_000);
  afterAll(async () => {
    setPaymentFetchForTests(null);
    forgetLicense();
    await t.close();
  });

  // ---------------------------------------------------------------- settings

  it('starts with reminders on (30, 7) and payments off, unready and hidden', async () => {
    const ops = await body(await t.api(owner).get('/platform/license-ops'));
    expect(ops.reminders).toEqual({ enabled: true, days: [30, 7] });
    expect(ops.payments).toMatchObject({
      provider: 'stripe',
      enabled: false,
      secret_key_set: false,
      webhook_secret_set: false,
      ready: false,
      plans: { business: { price_id: '', seats: null, mode: 'subscription' } },
    });
    expect(ops.payments.webhook_url).toMatch(/\/api\/v1\/public\/licenses\/webhook\/stripe$/);
    expect(await body(await publicCall('/public/licenses/purchase'))).toEqual({ available: false, plans: [] });
    expect((await body(await publicCall('/public/installations/config'))).purchase_available).toBe(false);
    const checkout = await publicCall('/public/licenses/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'business' }),
    });
    expect(checkout.status).toBe(404);
    // Unconfigured: the webhook is not there either.
    expect((await webhook({ id: 'evt_0', type: 'checkout.session.completed' })).status).toBe(404);
    expect(stripeCalls).toEqual([]);
  });

  it('changes the reminder settings (validated) and refuses to turn payments on unready', async () => {
    const res = await t.api(owner).patch('/platform/license-ops', { reminders: { days: [3, 14] } });
    expect(res.status).toBe(200);
    expect((await body(res)).reminders).toEqual({ enabled: true, days: [14, 3] });
    expect((await t.api(owner).patch('/platform/license-ops', { reminders: { days: [0] } })).status).toBe(400);
    expect((await t.api(owner).patch('/platform/license-ops', { reminders: { days: [7, 7] } })).status).toBe(400);
    await t.api(owner).patch('/platform/license-ops', { reminders: { days: [30, 7] } });

    const on = await t.api(owner).patch('/platform/license-ops', { payments: { enabled: true } });
    expect(on.status).toBe(422);
    expect((await body(on)).error.message).toBe('payments_not_ready');
    expect((await t.api(owner).patch('/platform/license-ops', { payments: { secret_key: 'not-a-key' } })).status).toBe(
      400,
    );
  });

  // ---------------------------------------------------------------- reminders

  it('sends the 30-day reminder once to the customer and the owner, then the 7-day one, then nothing', async () => {
    const now = Date.now();
    const lic = await issue({ licensee: 'Remind Co', email: 'buyer@remind.test', expires: iso(now + 20 * DAY) });
    // Far away, revoked, and never-expiring licenses get nothing.
    await issue({ licensee: 'Far', email: 'far@x.test', expires: iso(now + 100 * DAY) });
    const revoked = await issue({ licensee: 'Gone', email: 'gone@x.test', expires: iso(now + 5 * DAY) });
    await t.api(owner).post(`/platform/licenses/${revoked.id}/revoke`);
    await issue({ licensee: 'Forever', email: 'forever@x.test', expires: null });

    const before = t.mailer.sent.length;
    const first = await sendExpiryReminders(t.deps, new Date(now));
    expect(first).toEqual({ status: 'ran', sent: [{ license_id: lic.id, days: 30 }] });
    const customer = mailsTo('buyer@remind.test').at(-1)!;
    expect(customer.subject).toMatch(/20|30|ימים|days/);
    expect(customer.text).toContain('Remind Co');
    expect(mailsTo(OWNER_EMAIL).at(-1)!.text).toContain('buyer@remind.test');
    expect(t.mailer.sent.length - before).toBe(2);
    for (const to of ['far@x.test', 'gone@x.test', 'forever@x.test']) expect(mailsTo(to)).toEqual([]);

    // Idempotent: the same hour again (or another process) sends nothing.
    expect(await sendExpiryReminders(t.deps, new Date(now + 3_600_000))).toEqual({ status: 'ran', sent: [] });
    expect(t.mailer.sent.length - before).toBe(2);

    // Six days left: the 7-day reminder, once.
    expect(await sendExpiryReminders(t.deps, new Date(now + 14 * DAY))).toEqual({
      status: 'ran',
      sent: [{ license_id: lic.id, days: 7 }],
    });
    expect(await sendExpiryReminders(t.deps, new Date(now + 15 * DAY))).toEqual({ status: 'ran', sent: [] });
    expect(mailsTo('buyer@remind.test')).toHaveLength(2);

    // The Licenses list marks them.
    const row = (await licenses()).find((l) => l.id === lic.id)!;
    expect(row.reminders.map((r: Json) => r.days)).toEqual([30, 7]);
    expect(row.payment_provider).toBeNull();

    // A renewal moves the expiry: its reminders start over.
    await t.api(owner).post(`/platform/licenses/${lic.id}/renew`);
    expect((await licenses()).find((l) => l.id === lic.id)!.reminders).toEqual([]);
  });

  it('sends only the nearest threshold reached, and nothing when turned off', async () => {
    const days = [30, 7];
    const now = new Date('2026-01-01T00:00:00Z');
    expect(dueThreshold(new Date(now.getTime() + 40 * DAY), now, days)).toBeNull();
    expect(dueThreshold(new Date(now.getTime() + 30 * DAY), now, days)).toBe(30);
    expect(dueThreshold(new Date(now.getTime() + 5 * DAY), now, days)).toBe(7);
    expect(dueThreshold(new Date(now.getTime() - DAY), now, days)).toBeNull();

    await t.api(owner).patch('/platform/license-ops', { reminders: { enabled: false } });
    await issue({ licensee: 'Quiet', email: 'quiet@x.test', expires: iso(Date.now() + 3 * DAY) });
    expect(await sendExpiryReminders(t.deps)).toEqual({ status: 'disabled' });
    expect(mailsTo('quiet@x.test')).toEqual([]);
    await t.api(owner).patch('/platform/license-ops', { reminders: { enabled: true } });
  });

  // ---------------------------------------------------------------- payments

  it('keeps the Stripe secrets sealed and returns only whether they are set', async () => {
    const res = await t.api(owner).patch('/platform/license-ops', {
      payments: {
        secret_key: SECRET_KEY,
        webhook_secret: WEBHOOK_SECRET,
        plans: { business: { price_id: 'price_business_1', seats: 25, mode: 'subscription' } },
        enabled: true,
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(WEBHOOK_SECRET);
    const ops = JSON.parse(text) as Json;
    expect(ops.payments).toMatchObject({ enabled: true, secret_key_set: true, webhook_secret_set: true, ready: true });
    // Stored sealed, not in clear.
    const stored = JSON.stringify(await t.pg.query(`select settings from platform_settings where id = 'license_ops'`));
    expect(stored).not.toContain(SECRET_KEY);
    expect(stored).not.toContain(WEBHOOK_SECRET);
  });

  it('shows the purchase once ready, and starts a checkout through (mocked) Stripe', async () => {
    expect(await body(await publicCall('/public/licenses/purchase'))).toEqual({
      available: true,
      plans: [{ plan: 'business', seats: 25, amount: null, currency: 'USD', tiers: [] }],
    });
    expect((await body(await publicCall('/public/installations/config'))).purchase_available).toBe(true);

    const res = await publicCall('/public/licenses/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'business', instance_id: 'inst-12345678', email: 'new@buyer.test', locale: 'en' }),
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ url: 'https://checkout.stripe.test/c/cs_test_1' });
    const call = stripeCalls.at(-1)!;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET_KEY}`);
    const sent = new URLSearchParams(call.init.body as string);
    expect(sent.get('mode')).toBe('subscription');
    expect(sent.get('line_items[0][price]')).toBe('price_business_1');
    expect(sent.get('metadata[plan]')).toBe('business');
    expect(sent.get('metadata[instance_id]')).toBe('inst-12345678');
    expect(sent.get('customer_email')).toBe('new@buyer.test');
    expect(sent.get('success_url')).toMatch(/\/buy\/success/);

    // An edition with no price is not for sale.
    const enterprise = await publicCall('/public/licenses/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'enterprise' }),
    });
    expect(enterprise.status).toBe(422);
  });

  it('rejects a webhook with no, a wrong, or a stale signature', async () => {
    const ev = { id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } };
    expect((await webhook(ev, { signature: null })).status).toBe(401);
    expect((await webhook(ev, { secret: 'whsec_SomeoneElse1234' })).status).toBe(401);
    expect((await webhook(ev, { at: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect((await webhook(ev, { signature: 't=abc,v1=zz' })).status).toBe(401);
  });

  const completed = {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        mode: 'subscription',
        payment_status: 'paid',
        customer: 'cus_1',
        subscription: 'sub_1',
        customer_details: { email: 'new@buyer.test', name: 'New Buyer Ltd' },
        metadata: { plan: 'business', instance_id: 'inst-12345678', locale: 'en' },
      },
    },
  };

  it('issues the license on a paid checkout, emails the key, and ignores the replay', async () => {
    const count = (await licenses()).length;
    const res = await webhook(completed);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ received: true, handled: 'issued' });
    const all = await licenses();
    expect(all).toHaveLength(count + 1);
    const lic = all.find((l) => l.licensee === 'New Buyer Ltd')!;
    expect(lic).toMatchObject({
      plan: 'business',
      seats: 25,
      instance_id: 'inst-12345678',
      email: 'new@buyer.test',
      payment_provider: 'stripe',
      state: 'valid',
    });
    expect(verifyLicenseKey(lic.key, undefined, new Date(), 'inst-12345678').payload?.plan).toBe('business');
    expect(mailsTo('new@buyer.test').at(-1)!.text).toContain(lic.key);

    const replay = await webhook(completed);
    expect(await body(replay)).toEqual({ received: true, handled: 'duplicate' });
    expect(await licenses()).toHaveLength(count + 1);
  });

  it('renews on the next paid invoice of the subscription (not the first one), once', async () => {
    const before = (await licenses()).find((l) => l.licensee === 'New Buyer Ltd')!;
    const first = await webhook({
      id: 'evt_inv_create',
      type: 'invoice.paid',
      data: { object: { billing_reason: 'subscription_create', subscription: 'sub_1' } },
    });
    expect(await body(first)).toEqual({ received: true, handled: 'ignored' });

    const mails = mailsTo('new@buyer.test').length;
    const cycle = {
      id: 'evt_inv_cycle',
      type: 'invoice.paid',
      // The newer API shape: the subscription under parent.subscription_details.
      data: {
        object: { billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } },
      },
    };
    expect(await body(await webhook(cycle))).toEqual({ received: true, handled: 'renewed' });
    const after = (await licenses()).find((l) => l.id === before.id)!;
    expect(Date.parse(after.expires) - Date.parse(before.expires)).toBeGreaterThan(360 * DAY);
    expect(after.key).not.toBe(before.key);
    expect(mailsTo('new@buyer.test')).toHaveLength(mails + 1);

    expect(await body(await webhook(cycle))).toEqual({ received: true, handled: 'duplicate' });
    expect((await licenses()).find((l) => l.id === before.id)!.expires).toBe(after.expires);
  });

  it('ignores unpaid checkouts and unrelated events; manual issuing is untouched', async () => {
    const unpaid = {
      ...completed,
      id: 'evt_unpaid',
      data: { object: { ...completed.data.object, payment_status: 'unpaid' } },
    };
    expect(await body(await webhook(unpaid))).toEqual({ received: true, handled: 'ignored' });
    expect(await body(await webhook({ id: 'evt_other', type: 'customer.created', data: { object: {} } }))).toEqual({
      received: true,
      handled: 'ignored',
    });
    expect((await issue({ licensee: 'By hand', expires: iso(Date.now() + 365 * DAY) })).payment_provider).toBeNull();
  });

  it('hides the purchase again when turned off', async () => {
    await t.api(owner).patch('/platform/license-ops', { payments: { enabled: false } });
    expect(await body(await publicCall('/public/licenses/purchase'))).toEqual({ available: false, plans: [] });
    expect((await body(await publicCall('/public/installations/config'))).purchase_available).toBe(false);
  });
});

describe('Stripe signature check (unit)', () => {
  const secrets = { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET };
  const raw = '{"id":"evt_1"}';
  it('accepts its own signature, also among several v1 values, within the tolerance', () => {
    const now = new Date();
    const ts = Math.floor(now.getTime() / 1000);
    const sig = stripeSignature(WEBHOOK_SECRET, raw, ts);
    expect(stripeProvider.verifyWebhook(secrets, raw, { 'stripe-signature': sig }, now)).toBe(true);
    expect(
      stripeProvider.verifyWebhook(
        secrets,
        raw,
        { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)},${sig.split(',')[1]}` },
        now,
      ),
    ).toBe(true);
    expect(stripeProvider.verifyWebhook(secrets, `${raw} `, { 'stripe-signature': sig }, now)).toBe(false);
    expect(
      stripeProvider.verifyWebhook(secrets, raw, { 'stripe-signature': sig }, new Date(now.getTime() + 301_000)),
    ).toBe(false);
  });
});

describe('an installation that is not a license server', () => {
  let t: TestContext;
  let owner: string;
  beforeAll(async () => {
    forgetLicense();
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  }, 180_000);
  afterAll(async () => {
    await t.close();
  });

  it('has no purchase, no webhook, no settings and sends no reminders', async () => {
    expect((await t.app.request('/api/v1/public/licenses/purchase')).status).toBe(404);
    expect(
      (
        await t.app.request('/api/v1/public/licenses/webhook/stripe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect((await t.api(owner).get('/platform/license-ops')).status).toBe(503);
    expect(await sendExpiryReminders(t.deps)).toEqual({ status: 'not_server' });
  });
});
