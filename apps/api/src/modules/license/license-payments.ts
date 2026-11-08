// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentMode, PurchasablePlan } from '@bines/shared';

/**
 * Selling licenses online: a small provider interface, so a provider other than Stripe can be
 * added beside it. A provider only takes the payment and reports it; the license server issues / renews the key
 * itself (the same service the owner's buttons use). Never a card number through us: the buyer pays on the
 * provider's hosted page.
 */
export type CheckoutInput = {
  plan: PurchasablePlan;
  /** The tier bought (its index), when the edition is sold in tiers. */
  tier?: number | null;
  priceId: string;
  mode: PaymentMode;
  instanceId: string | null;
  email: string | null;
  locale: 'he' | 'en';
  successUrl: string;
  cancelUrl: string;
};

/** A provider's webhook, normalized. */
export type PaymentEvent =
  | {
      kind: 'purchase';
      id: string;
      type: string;
      plan: string | null;
      /** The tier bought, when the edition is sold in tiers. */
      tier: number | null;
      instanceId: string | null;
      email: string | null;
      name: string | null;
      locale: string | null;
      customerId: string | null;
      subscriptionId: string | null;
    }
  | { kind: 'renewal'; id: string; type: string; subscriptionId: string }
  | { kind: 'ignored'; id: string; type: string };

export type ProviderSecrets = { secretKey: string; webhookSecret: string };

export interface LicensePaymentProvider {
  /** Stable key — the webhook path `/public/licenses/webhook/{key}` and `issued_licenses.payment_provider`. */
  readonly key: string;
  createCheckout(secrets: ProviderSecrets, input: CheckoutInput): Promise<{ url: string; id: string }>;
  /** The signature (and its timestamp) of an incoming webhook; false = reject without reading it further. */
  verifyWebhook(secrets: ProviderSecrets, rawBody: string, headers: Record<string, string>, now?: Date): boolean;
  parseEvent(rawBody: string): PaymentEvent;
}

/** Outbound calls to the provider (tests replace it — no test ever reaches Stripe). */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const realFetch: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
let fetcher: Fetch = realFetch;
export const setPaymentFetchForTests = (f: Fetch | null) => {
  fetcher = f ?? realFetch;
};

// ---------------------------------------------------------------- Stripe

const STRIPE_API = 'https://api.stripe.com/v1';
/** Stripe's default tolerance for the signed timestamp. */
const STRIPE_TOLERANCE_S = 300;

const form = (fields: Record<string, string | null | undefined>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && v !== '') body.append(k, v);
  return body.toString();
};

/** `t=…,v1=…[,v1=…]` → the timestamp and the v1 signatures. */
const parseStripeSignature = (header: string) => {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s.trim());
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    if (k === 'v1' && v && /^[0-9a-f]+$/i.test(v)) v1.push(v.toLowerCase());
  }
  return { t, v1 };
};

/** Signs a payload the way Stripe does (tests build valid webhooks with it). */
export const stripeSignature = (webhookSecret: string, rawBody: string, timestamp: number) =>
  `t=${timestamp},v1=${createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

/**
 * A Stripe API call with the account's secret key (the license purchase's and the plan upgrades' — one Stripe
 * account). `form` = an x-www-form-urlencoded body; GET when absent. Goes through the test-replaceable fetch.
 */
export const stripeCall = async (
  secretKey: string,
  path: string,
  body?: Record<string, string | null | undefined>,
  /** DELETE (cancelling a subscription now); else POST with a body, GET without. */
  method?: 'DELETE',
) => {
  const res = await fetcher(`${STRIPE_API}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: form(body) } : {}),
  });
  const json = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  // Stripe's own error code only (it never echoes the key); the key itself is never logged.
  if (!res.ok)
    throw new Error(`stripe ${path} failed: ${res.status} ${String((json.error as { code?: unknown })?.code ?? '')}`);
  return json;
};

type StripeObject = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as StripeObject) : {});

/** invoice.subscription (older API versions) or invoice.parent.subscription_details.subscription (newer). */
const invoiceSubscription = (inv: StripeObject) =>
  str(inv.subscription) ?? str(obj(obj(inv.parent).subscription_details).subscription);

export const stripeProvider: LicensePaymentProvider = {
  key: 'stripe',

  async createCheckout(secrets, input) {
    const meta = {
      plan: input.plan,
      instance_id: input.instanceId ?? '',
      locale: input.locale,
      tier: input.tier === null || input.tier === undefined ? '' : String(input.tier),
    };
    const res = await fetcher(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secrets.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form({
        mode: input.mode,
        'line_items[0][price]': input.priceId,
        'line_items[0][quantity]': '1',
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        customer_email: input.email,
        locale: input.locale,
        'metadata[plan]': meta.plan,
        'metadata[instance_id]': meta.instance_id,
        'metadata[locale]': meta.locale,
        'metadata[tier]': meta.tier,
        // The subscription carries them too (its renewals are matched by the subscription id).
        ...(input.mode === 'subscription'
          ? {
              'subscription_data[metadata][plan]': meta.plan,
              'subscription_data[metadata][instance_id]': meta.instance_id,
              'subscription_data[metadata][tier]': meta.tier,
            }
          : {}),
      }),
    });
    const json = obj(await res.json().catch(() => null));
    const url = str(json.url);
    const id = str(json.id);
    // Stripe's own error text only (it never echoes the key); the key itself is never logged.
    if (!res.ok || !url || !id)
      throw new Error(`stripe checkout failed: ${res.status} ${str(obj(json.error).code) ?? ''}`);
    return { url, id };
  },

  verifyWebhook(secrets, rawBody, headers, now = new Date()) {
    const header = headers['stripe-signature'];
    if (!header) return false;
    const { t, v1 } = parseStripeSignature(header);
    if (t === null || !v1.length) return false;
    if (Math.abs(now.getTime() / 1000 - t) > STRIPE_TOLERANCE_S) return false;
    const expected = Buffer.from(
      createHmac('sha256', secrets.webhookSecret).update(`${t}.${rawBody}`).digest('hex'),
      'utf8',
    );
    return v1.some((sig) => {
      const got = Buffer.from(sig, 'utf8');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  },

  parseEvent(rawBody) {
    const ev = obj(JSON.parse(rawBody));
    const id = str(ev.id) ?? '';
    const type = str(ev.type) ?? '';
    const o = obj(obj(ev.data).object);
    if (type === 'checkout.session.completed') {
      const paid = o.payment_status === 'paid' || o.payment_status === 'no_payment_required';
      if (!paid) return { kind: 'ignored', id, type };
      const meta = obj(o.metadata);
      const customer = obj(o.customer_details);
      return {
        kind: 'purchase',
        id,
        type,
        plan: str(meta.plan),
        tier: /^\d$/.test(str(meta.tier) ?? '') ? Number(meta.tier) : null,
        instanceId: str(meta.instance_id),
        locale: str(meta.locale),
        email: str(customer.email) ?? str(o.customer_email),
        name: str(customer.name),
        customerId: str(o.customer),
        subscriptionId: str(o.subscription),
      };
    }
    // The first invoice of a subscription is the purchase itself (checkout.session.completed issues the key);
    // later ones (a new period) renew it.
    if (type === 'invoice.paid' && o.billing_reason === 'subscription_cycle') {
      const subscriptionId = invoiceSubscription(o);
      if (subscriptionId) return { kind: 'renewal', id, type, subscriptionId };
    }
    return { kind: 'ignored', id, type };
  },
};

const providers = new Map<string, LicensePaymentProvider>([[stripeProvider.key, stripeProvider]]);
export const paymentProvider = (key: string) => providers.get(key);
