// SPDX-License-Identifier: AGPL-3.0-only
import type { BillingInterval, SubscriptionStatus } from '@bines/shared';

/**
 * The billing-provider interface (stage 3 + answers6: "core = entitlements + a provider INTERFACE
 * providers = trusted platform-level extensions later"). The core decides entitlements; a provider only charges and
 * reports. Nothing implements this yet, so `POST /billing/webhook/{provider}` answers 501.
 *
 * How a provider will plug in (not built — the next stages):
 * 1. A provider (Grow / Cardcom / Stripe …) is a TRUSTED PLATFORM EXTENSION: installed only in the owner console
 *    (never by an account admin — an admin's own "provider" could report "paid" and get a plan for free), with its
 *    own credentials kept in `SecretBox` (write-only in the UI), test / live mode, and which currency it serves.
 * 2. At start-up (or when the owner installs it) the platform calls `registerBillingProvider(adapter)`. The adapter
 *    is a thin client of the extension's server (`lib/outbound.ts`, HMAC-signed calls like `ext-signing.ts`); core
 *    never imports from `extensions/` (rule 12).
 * 3. Checkout: the account admin's "upgrade" calls `createCheckout` and is redirected to the provider's hosted page —
 *    no card number ever passes through us.
 * 4. Webhook: the provider calls `POST /billing/webhook/{key}`. The route takes the raw body, calls `verifyWebhook`
 *    (signature + timestamp; reject on failure), then `mapEvent` → a normalized event. Core never trusts the event
 *    blindly: it re-reads `getStatus(external_id)` from the provider before changing `account_subscriptions`, is
 *    idempotent on `event.id`, and audits every transition. A provider never sets limits — only the status, the
 *    period and the version the owner priced.
 * 5. A daily reconcile job (worker) compares `getStatus` of every subscription with a provider; a gap notifies the
 *    owner. The extension kill switch freezes statuses (it never downgrades an account by silence).
 */

export type CheckoutRequest = {
  accountId: string;
  /** What the account asks to buy (a public plan version) and how. */
  planVersionId: string;
  interval: BillingInterval;
  seats: number | null;
  /** Price and currency as the owner set them on the version (minor units). */
  amountMinor: number;
  currency: string;
  vatIncluded: boolean;
  /** Where the provider sends the person back. */
  successUrl: string;
  cancelUrl: string;
  /** The account admin who started it (receipt email). */
  customer: { email: string; name: string };
};

export type CheckoutSession = { url: string; externalId: string; expiresAt: string | null };

/** The provider's view of one subscription (read back before core changes anything). */
export type ProviderSubscriptionStatus = {
  externalId: string;
  status: SubscriptionStatus;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

/** A provider's webhook, normalized. */
export type BillingEvent = {
  /** The provider's event id (idempotency). */
  id: string;
  type:
    | 'subscription.activated'
    | 'subscription.renewed'
    | 'subscription.past_due'
    | 'subscription.canceled'
    | 'payment.succeeded'
    | 'payment.failed';
  externalId: string;
  occurredAt: string;
};

export type WebhookRequest = { headers: Record<string, string>; rawBody: string };

export interface BillingProvider {
  /** Stable key, used in the webhook path (`/billing/webhook/{key}`) and in `account_subscriptions.provider`. */
  readonly key: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Cancel at period end (or now, when `immediately`). */
  cancel(externalId: string, opts?: { immediately?: boolean }): Promise<void>;
  getStatus(externalId: string): Promise<ProviderSubscriptionStatus>;
  /** Signature / timestamp check of an incoming webhook; false = reject (401) without reading it further. */
  verifyWebhook(req: WebhookRequest): Promise<boolean>;
  /** The webhook as normalized events (none = ignored, e.g. an event type core does not use). */
  mapEvent(req: WebhookRequest): Promise<BillingEvent[]>;
}

const registry = new Map<string, BillingProvider>();

/** Called by the trusted platform extension's adapter (later). One provider per key; re-registering replaces it. */
export const registerBillingProvider = (provider: BillingProvider) => {
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider.key)) throw new Error(`invalid billing provider key: ${provider.key}`);
  registry.set(provider.key, provider);
};
export const unregisterBillingProvider = (key: string) => registry.delete(key);
export const billingProvider = (key: string): BillingProvider | undefined => registry.get(key);

/**
 * What the account's own cancel asks of the provider that bills a subscription — the same narrow
 * contract for every provider (the built-in Stripe connection registers one; a provider extension registers its own).
 * Core decides WHAT happens (the billing settings' rules); the provider only carries it out.
 */
export interface SubscriptionControl {
  /** End billing: `now`, at a moment inside the period, or at the end of the paid period (no renewal). */
  cancel(externalId: string, when: { at: 'now' } | { at: 'period_end' } | { at: 'date'; date: Date }): Promise<void>;
  /** Undo a cancel at period end (the subscription renews again). */
  resume(externalId: string): Promise<void>;
  /**
   * Refund this share (0–1) of the last payment of the subscription to the original payment method; the amount
   * actually refunded, or null when there was nothing to refund.
   */
  refundLastPayment(externalId: string, share: number): Promise<{ amountMinor: number; currency: string } | null>;
}

type ControlFactory<D> = (deps: D) => Promise<SubscriptionControl | null>;
const controls = new Map<string, ControlFactory<never>>();

/** A provider's cancel / refund contract, built per call from the deps (its credentials can change at any time). */
export const registerSubscriptionControl = <D>(key: string, factory: ControlFactory<D>) => {
  controls.set(key, factory as ControlFactory<never>);
};
export const subscriptionControl = async <D>(key: string | null, deps: D): Promise<SubscriptionControl | null> => {
  const factory = key ? (controls.get(key) as ControlFactory<D> | undefined) : undefined;
  return factory ? factory(deps) : null;
};
