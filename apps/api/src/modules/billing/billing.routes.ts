// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountPlanSchema,
  assignSubscriptionSchema,
  billingSettingsSchema,
  createPlanSchema,
  planOfferSchema,
  subscriptionPlanSchema,
  planVersionInputSchema,
  subscriptionSchema,
  updateBillingSettingsSchema,
  updatePlanSchema,
  planCheckoutOptionsSchema,
  planCancelPreviewSchema,
  planCancelSchema,
  planCheckoutSchema,
  planPaymentsSchema,
  updatePlanPaymentsSchema,
  upgradeRequestResultSchema,
  upgradeRequestSchema,
  planAddonInputSchema,
  planAddonSchema,
  pricingPageSettingsSchema,
  publicPricingSchema,
  updatePlanAddonSchema,
  updatePricingPageSettingsSchema,
} from '@bines/shared';
import {
  actorOf,
  currentUser,
  requestMeta,
  requireAccount,
  requirePlatformOwner,
  requireUser,
} from '../../middleware/auth';
import { accountHeader, errors, errorSchema, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { loadBillingSettings, updateBillingSettings } from './billing-settings';
import {
  addPlanVersion,
  afterBillingSettingsChange,
  assignSubscription,
  createPlan,
  deletePlan,
  endSubscription,
  getAccountSubscription,
  getMyPlan,
  listCurrentSubscriptions,
  listPlans,
  listPublicPlans,
  updatePlan,
  updatePlanVersion,
} from './plans.service';
import { createPlanCheckout, getPlanPayments, planCheckoutOptions, updatePlanPayments } from './plan-payments';
import { requestUpgrade } from './upgrade-request';
import { cancelPlan, previewCancel, undoCancel } from './cancellation';
import {
  createAddon,
  deleteAddon,
  listAddons,
  loadPricingPage,
  publicPricing,
  updateAddon,
  updatePricingPage,
} from './pricing.service';
import { handleBillingWebhook } from './webhook';

/**
 * Plans: the owner console's plans editor, billing settings and account subscriptions (404 to anyone
 * not a platform owner), an account admin's "My plan" (`GET /plan`, a session only), and the billing-provider
 * webhook stub (`POST /billing/webhook/{provider}`, 501 until a provider is registered).
 */
export const billingRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const guard = [requireUser(), requirePlatformOwner()];
  const tags = ['platform'];
  const r = new OpenAPIHono<AppEnv>();
  const plansList = z.object({ data: z.array(subscriptionPlanSchema) });

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/plans',
      tags,
      summary: 'Subscription plans with their versions',
      middleware: guard,
      responses: { 200: json(plansList, 'Plans'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listPlans(db) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/plans',
      tags,
      summary: 'Create a plan with its first version',
      middleware: guard,
      request: jsonBody(createPlanSchema),
      responses: { 201: json(subscriptionPlanSchema, 'Created'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await createPlan(db, currentUser(c), c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/plans/{id}',
      tags,
      summary: 'Rename, describe, show / hide, order or archive a plan',
      middleware: guard,
      request: { params: idParam, ...jsonBody(updatePlanSchema) },
      responses: { 200: json(subscriptionPlanSchema, 'Updated'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updatePlan(db, c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/plans/{id}',
      tags,
      summary: 'Delete a plan no account ever had (else 409 plan_in_use — archive it)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...errors(401, 404, 409) },
    }),
    async (c) => {
      await deletePlan(db, c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/plans/{id}/versions',
      tags,
      summary: 'Add a version (new prices / limits) — accounts on older versions keep theirs',
      middleware: guard,
      request: { params: idParam, ...jsonBody(planVersionInputSchema) },
      responses: { 201: json(subscriptionPlanSchema, 'Created'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await addPlanVersion(db, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/plan-versions/{id}',
      tags,
      summary: 'Edit a version no subscription ever used (else 409 version_in_use)',
      middleware: guard,
      request: { params: idParam, ...jsonBody(planVersionInputSchema) },
      responses: { 200: json(subscriptionPlanSchema, 'Updated'), ...errors(400, 401, 404, 409) },
    }),
    async (c) => c.json(await updatePlanVersion(db, c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/billing-settings',
      tags,
      summary: 'Billing settings: warning share, grace periods, upgrade text, feature catalogue',
      middleware: guard,
      responses: { 200: json(billingSettingsSchema, 'Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await loadBillingSettings(db), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/billing-settings',
      tags,
      summary: 'Update billing settings (only what is sent)',
      middleware: guard,
      request: jsonBody(updateBillingSettingsSchema),
      responses: { 200: json(billingSettingsSchema, 'Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const next = await updateBillingSettings(db, currentUser(c), c.req.valid('json'));
      afterBillingSettingsChange();
      return c.json(next, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/subscriptions',
      tags,
      summary: 'The current subscription of every account that has one',
      middleware: guard,
      responses: { 200: json(z.object({ data: z.array(subscriptionSchema) }), 'Subscriptions'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listCurrentSubscriptions(db) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/accounts/{id}/subscription',
      tags,
      summary: "An account's plan: subscription, entitlements, usage and history",
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(accountPlanSchema, 'SubscriptionPlan'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getAccountSubscription(db, c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/platform/accounts/{id}/subscription',
      tags,
      summary: 'Assign or change the plan, status, seats and override of an account (applies at once)',
      middleware: guard,
      request: { params: idParam, ...jsonBody(assignSubscriptionSchema) },
      responses: { 200: json(accountPlanSchema, 'SubscriptionPlan'), ...errors(400, 401, 404) },
    }),
    async (c) =>
      c.json(
        await assignSubscription(db, currentUser(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/accounts/{id}/subscription',
      tags,
      summary: 'End the subscription: the account is unlimited (legacy) again; the history stays',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(accountPlanSchema, 'SubscriptionPlan'), ...errors(401, 404) },
    }),
    async (c) => c.json(await endSubscription(db, currentUser(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/plan',
      tags: ['plan'],
      summary: "My plan: the account's subscription, limits with usage, history and the upgrade text (admins)",
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader },
      responses: { 200: json(accountPlanSchema, 'SubscriptionPlan'), ...errors(401, 403, 404, 423) },
    }),
    async (c) => c.json(await getMyPlan(db, c.get('account')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/plan/upgrade-request',
      tags: ['plan'],
      summary: 'Ask to upgrade (admins): a support ticket when the desk is on, else an email to the platform owners',
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader, ...jsonBody(upgradeRequestSchema) },
      responses: { 200: json(upgradeRequestResultSchema, 'UpgradeRequestResult'), ...errors(401, 403, 422, 429) },
    }),
    async (c) => c.json(await requestUpgrade(deps, actorOf(c), c.req.valid('json')), 200),
  );

  // ---- paid upgrade through Stripe (self sign-up ה9) ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/plan/checkout',
      tags: ['plan'],
      summary: 'What Upgrade can pay for online here (admins); available: false = the request only',
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader },
      responses: { 200: json(planCheckoutOptionsSchema, 'PlanCheckoutOptions'), ...errors(401, 403) },
    }),
    async (c) => c.json(await planCheckoutOptions(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/plan/checkout',
      tags: ['plan'],
      summary: 'A Stripe Checkout session for a plan and interval (admins) — the admin is sent to its url',
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader, ...jsonBody(planCheckoutSchema) },
      responses: { 200: json(z.object({ url: z.string() }), 'Checkout'), ...errors(401, 403, 404, 422) },
    }),
    async (c) =>
      c.json(await createPlanCheckout(deps, { ...actorOf(c), meta: requestMeta(c) }, c.req.valid('json')), 200),
  );
  // The account's own cancel: preview, confirm, undo.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/plan/cancel',
      tags: ['plan'],
      summary: 'What cancelling the plan now would do: the case, refund, fee and end date (admins)',
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader },
      responses: { 200: json(planCancelPreviewSchema, 'PlanCancelPreview'), ...errors(401, 403) },
    }),
    async (c) => c.json(await previewCancel(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/plan/cancel',
      tags: ['plan'],
      summary:
        'Cancel the plan as the preview showed (admins); 409 cancel_changed when the refund is no longer the one shown',
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader, ...jsonBody(planCancelSchema) },
      responses: { 200: json(accountPlanSchema, 'SubscriptionPlan'), ...errors(401, 403, 409) },
    }),
    async (c) => c.json(await cancelPlan(deps, actorOf(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/plan/cancel/undo',
      tags: ['plan'],
      summary: 'Undo a cancellation that refunded nothing, before the paid period ends (admins)',
      middleware: [requireAccount(deps)],
      request: { headers: accountHeader },
      responses: { 200: json(accountPlanSchema, 'SubscriptionPlan'), ...errors(401, 403, 409) },
    }),
    async (c) => c.json(await undoCancel(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/plan-payments',
      tags: ['platform'],
      summary: "Paid upgrades: the switch, each public plan's Stripe prices, the shared keys (set or not)",
      middleware: guard,
      responses: { 200: json(planPaymentsSchema, 'PlanPayments'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getPlanPayments(deps), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/plan-payments',
      tags: ['platform'],
      summary: 'Paid upgrades: only what is sent changes (turning on needs the keys and a priced plan)',
      middleware: guard,
      request: { ...jsonBody(updatePlanPaymentsSchema) },
      responses: { 200: json(planPaymentsSchema, 'PlanPayments'), ...errors(400, 401, 404, 422) },
    }),
    async (c) => c.json(await updatePlanPayments(deps, currentUser(c), c.req.valid('json')), 200),
  );

  // --- the pricing page: add-ons, the page's settings, the public JSON ----
  const addonsList = z.object({ data: z.array(planAddonSchema) });
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/plan-addons',
      tags,
      summary: 'Add-ons: units that raise one limit of a plan, priced per unit',
      middleware: guard,
      responses: { 200: json(addonsList, 'Add-ons'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listAddons(db) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/plan-addons',
      tags,
      summary: 'Create an add-on',
      middleware: guard,
      request: jsonBody(planAddonInputSchema),
      responses: { 201: json(planAddonSchema, 'Created'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await createAddon(db, currentUser(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/plan-addons/{id}',
      tags,
      summary: 'Change an add-on (what subscriptions already hold does not change)',
      middleware: guard,
      request: { params: idParam, ...jsonBody(updatePlanAddonSchema) },
      responses: { 200: json(planAddonSchema, 'Updated'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updateAddon(db, c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/plan-addons/{id}',
      tags,
      summary: 'Delete an add-on (subscriptions keep what they hold)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...errors(401, 404) },
    }),
    async (c) => {
      await deleteAddon(db, c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/pricing-page',
      tags,
      summary: 'The pricing page: on / off, VAT, contact link, the custom plan, questions, the sites that may read it',
      middleware: guard,
      responses: { 200: json(pricingPageSettingsSchema, 'Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await loadPricingPage(db), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/pricing-page',
      tags,
      summary: 'Change the pricing page (only what is sent changes)',
      middleware: guard,
      request: jsonBody(updatePricingPageSettingsSchema),
      responses: { 200: json(pricingPageSettingsSchema, 'Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updatePricingPage(db, currentUser(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/pricing',
      tags: ['pricing'],
      summary: 'Public: the pricing page — plans, add-ons, VAT, questions (enabled: false = the page is off)',
      description:
        'No sign-in. Browsers on the sites the owner lists (owner console → Plans → Pricing page) may read it (CORS).',
      responses: { 200: json(publicPricingSchema, 'Pricing') },
    }),
    async (c) => c.json(await publicPricing(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/plans/public',
      tags: ['plan'],
      summary:
        'The offered plans (public, not archived) at their current version, and where to turn — for anyone signed in (the closed-account screen)',
      middleware: [requireUser()],
      responses: { 200: json(planOfferSchema, 'Offer'), ...errors(401) },
    }),
    async (c) => c.json(await listPublicPlans(db), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/billing/webhook/{provider}',
      tags: ['plan'],
      summary: "A billing provider's webhook (501 until a provider is registered under this key)",
      request: {
        params: z.object({
          provider: z
            .string()
            .max(40)
            .openapi({ param: { name: 'provider', in: 'path' } }),
        }),
      },
      responses: {
        200: json(z.object({ received: z.number().int(), applied: z.number().int() }), 'Handled'),
        401: json(errorSchema, 'Bad signature'),
        501: json(errorSchema, 'No provider'),
      },
    }),
    async (c) => {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));
      const res = await handleBillingWebhook(db, c.req.valid('param').provider, {
        headers,
        rawBody: await c.req.text(),
      });
      return c.json(res, 200);
    },
  );

  return r;
};
