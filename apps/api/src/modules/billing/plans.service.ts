// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountPlan,
  AppError,
  type assignSubscriptionSchema,
  type BillingSettings,
  type createPlanSchema,
  effectiveSubscriptionStatus,
  isPlanFeatureKey,
  newId,
  PLAN_FEATURE_KEYS,
  type PlanFeatureAccess,
  planIncludesFeature,
  type PlanOffer,
  type SubscriptionPlan,
  type PlanVersion,
  planLimitsSchema,
  planOverridesSchema,
  planVersionInputSchema,
  type PlanVersionInput,
  type Subscription,
  subscriptionAddonsSchema,
  type SubscriptionStatus,
  type updatePlanSchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AccountContext, RequestMeta, SessionUser } from '../../types';
import { findAccountById } from '../accounts/accounts.repo';
import { recordAudit } from '../audit/audit.repo';
import { forgetBillingSettings, loadBillingSettings } from './billing-settings';
import { entitlements, entitlementsDto, forgetEntitlements, planFeaturesOf, planUsage } from './entitlements';
import { recordPlanChanged } from './plan-status';
import {
  allCurrentSubscriptions,
  currentSubscription,
  deletePlanRow,
  findPlanRow,
  findVersionRow,
  insertPlanRow,
  insertSubscription,
  insertVersionRow,
  listPlanRows,
  listVersionRows,
  nextVersionNumber,
  planEverUsed,
  type PlanVersionRow,
  subscriptionHistory,
  type SubscriptionWithPlan,
  updatePlanRow,
  updateSubscription,
  updateVersionRow,
  versionEverUsed,
  versionUseCounts,
} from './plans.repo';
import { assertAccountAdmin } from '../../lib/account-admin';
import { cancellationDto } from './cancellation-rules';
import { resolveAddons } from './pricing.service';

/**
 * Plans — the owner console's plans editor and account assignment, and an account admin's "My plan".
 * Every price, limit, feature and status comes from the owner; nothing is seeded.
 */

const toMinor = (v: number) => Math.round(v * 100);
const fromMinor = (v: number) => v / 100;

const versionValues = (input: PlanVersionInput) => {
  const v = planVersionInputSchema.parse(input);
  return {
    priceMonthlyMinor: toMinor(v.price_monthly),
    priceYearlyMinor: toMinor(v.price_yearly),
    currency: v.currency,
    vatIncluded: v.vat_included,
    pricing: v.pricing,
    limits: planLimitsSchema.parse(v.limits) as Record<string, unknown>,
    features: [...new Set(v.features)],
    trialDays: v.trial_days,
  };
};

const versionDto = (r: PlanVersionRow, use: { current: number; ever: number } | undefined): PlanVersion => ({
  id: r.id,
  plan_id: r.planId,
  version: r.version,
  price_monthly: fromMinor(r.priceMonthlyMinor),
  price_yearly: fromMinor(r.priceYearlyMinor),
  currency: r.currency,
  vat_included: r.vatIncluded,
  pricing: r.pricing === 'per_seat' ? 'per_seat' : 'flat',
  limits: planLimitsSchema.safeParse(r.limits).data ?? {},
  features: Array.isArray(r.features) ? r.features : [],
  trial_days: r.trialDays,
  subscribers: use?.current ?? 0,
  locked: (use?.ever ?? 0) > 0,
  created_at: r.createdAt.toISOString(),
});

export const listPlans = async (db: Db): Promise<SubscriptionPlan[]> => {
  const [rows, versions, uses] = await Promise.all([listPlanRows(db), listVersionRows(db), versionUseCounts(db)]);
  return rows.map((p) => {
    const own = versions.filter((v) => v.planId === p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      visibility: p.visibility === 'hidden' ? 'hidden' : 'public',
      sort: p.sort,
      archived: !!p.archivedAt,
      highlights: Array.isArray(p.highlights) ? p.highlights : [],
      recommended: p.recommended,
      min_seats: p.minSeats ?? null,
      current_version_id: own.at(-1)?.id ?? null,
      versions: own.map((v) => versionDto(v, uses.get(v.id))),
      created_at: p.createdAt.toISOString(),
    };
  });
};

/**
 * GET /plans/public (anyone signed in — the closed-account screen, a future sign-up): the offered plans
 * (visibility `public`, not archived, in the owner's order) at their current version, with the owner's feature
 * labels, and where to turn (the billing settings' texts and links). Nothing internal (subscribers, versions).
 */
export const listPublicPlans = async (db: Db): Promise<PlanOffer> => {
  const [plans, settings] = await Promise.all([listPlans(db), loadBillingSettings(db)]);
  const labels = new Map(settings.features.map((f) => [f.key, f.label]));
  const data = plans.flatMap((p) => {
    const v = p.versions.find((x) => x.id === p.current_version_id);
    if (p.archived || p.visibility !== 'public' || !v) return [];
    return [
      {
        id: p.id,
        name: p.name,
        description: p.description,
        price_monthly: v.price_monthly,
        price_yearly: v.price_yearly,
        currency: v.currency,
        vat_included: v.vat_included,
        pricing: v.pricing,
        trial_days: v.trial_days,
        features: v.features.map((key) => ({ key, label: labels.get(key) ?? null })),
        highlights: p.highlights,
        recommended: p.recommended,
        min_seats: p.min_seats,
        limits: v.limits,
      },
    ];
  });
  return {
    data,
    upgrade: { text: settings.upgrade_text ?? null, url: settings.upgrade_url ?? null },
    closed_text: settings.closed_text ?? null,
    contact_url: settings.contact_url ?? null,
  };
};

const planById = async (db: Db, id: string) => {
  const found = (await listPlans(db)).find((p) => p.id === id);
  if (!found) throw new AppError('not_found', 'SubscriptionPlan not found');
  return found;
};

export const createPlan = async (db: Db, owner: SessionUser, input: z.infer<typeof createPlanSchema>) => {
  const id = newId();
  await db.transaction(async (tx) => {
    await insertPlanRow(tx, {
      id,
      name: input.name,
      description: input.description?.trim() || null,
      visibility: input.visibility,
      sort: input.sort,
      highlights: input.highlights,
      recommended: input.recommended,
      minSeats: input.min_seats,
      createdBy: owner.id,
    });
    await insertVersionRow(tx, {
      id: newId(),
      planId: id,
      version: 1,
      ...versionValues(input.version),
      createdBy: owner.id,
    });
  });
  return planById(db, id);
};

export const updatePlan = async (db: Db, id: string, input: z.infer<typeof updatePlanSchema>) => {
  if (!(await findPlanRow(db, id))) throw new AppError('not_found', 'SubscriptionPlan not found');
  await updatePlanRow(db, id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
    ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
    ...(input.highlights !== undefined ? { highlights: input.highlights } : {}),
    ...(input.recommended !== undefined ? { recommended: input.recommended } : {}),
    ...(input.min_seats !== undefined ? { minSeats: input.min_seats } : {}),
  });
  return planById(db, id);
};

/** A plan nobody ever subscribed to can go; one with history is archived instead (409 plan_in_use). */
export const deletePlan = async (db: Db, id: string) => {
  if (!(await findPlanRow(db, id))) throw new AppError('not_found', 'SubscriptionPlan not found');
  if (await planEverUsed(db, id)) throw new AppError('conflict', 'plan_in_use');
  await deletePlanRow(db, id);
};

/** A new version (a new price / new limits): new subscriptions get it; existing ones keep theirs (grandfathering). */
export const addPlanVersion = async (db: Db, owner: SessionUser, planId: string, input: PlanVersionInput) => {
  if (!(await findPlanRow(db, planId))) throw new AppError('not_found', 'SubscriptionPlan not found');
  await db.transaction(async (tx) => {
    const version = await nextVersionNumber(tx, planId);
    await insertVersionRow(tx, { id: newId(), planId, version, ...versionValues(input), createdBy: owner.id });
  });
  return planById(db, planId);
};

/** A version may change only while no subscription ever used it (409 version_in_use → make a new version). */
export const updatePlanVersion = async (db: Db, versionId: string, input: PlanVersionInput) => {
  const row = await findVersionRow(db, versionId);
  if (!row) throw new AppError('not_found', 'SubscriptionPlan version not found');
  if (await versionEverUsed(db, versionId)) throw new AppError('conflict', 'version_in_use');
  await updateVersionRow(db, versionId, versionValues(input));
  return planById(db, row.planId);
};

// ---- subscriptions ----

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const subscriptionDto = (
  s: SubscriptionWithPlan,
  settings: BillingSettings,
  now = new Date(),
): Subscription => ({
  id: s.id,
  account_id: s.accountId,
  plan_id: s.plan.id,
  plan_name: s.plan.name,
  plan_version_id: s.planVersionId,
  version: s.version.version,
  status: s.status,
  effective_status: s.endedAt
    ? s.status
    : effectiveSubscriptionStatus(
        {
          status: s.status,
          statusSince: s.statusSince,
          trialEndsAt: s.trialEndsAt,
          periodEnd: s.periodEnd,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          trialEndStatus: s.trialEndStatus,
        },
        settings,
        now,
      ),
  status_since: s.statusSince.toISOString(),
  interval: s.interval === 'year' ? 'year' : 'month',
  seats: s.seats,
  period_start: s.periodStart.toISOString(),
  period_end: iso(s.periodEnd),
  trial_ends_at: iso(s.trialEndsAt),
  cancel_at_period_end: s.cancelAtPeriodEnd,
  overrides: planOverridesSchema.safeParse(s.overrides).data ?? {},
  addons: subscriptionAddonsSchema.safeParse(s.addons).data ?? {},
  note: s.note,
  status_message: s.statusMessage ?? null,
  provider: s.provider,
  external_id: s.externalId,
  created_at: s.createdAt.toISOString(),
  ended_at: iso(s.endedAt),
  cancellation: cancellationDto(s, now),
});

const addInterval = (from: Date, interval: 'month' | 'year') => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + (interval === 'year' ? 12 : 1));
  return d;
};
const addDays = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000);

/** The whole picture of one account: its subscription, entitlements, usage bars and history. */
export const accountPlanView = async (db: Db, accountId: string, now = new Date()): Promise<AccountPlan> => {
  const [settings, e, history] = await Promise.all([
    loadBillingSettings(db),
    entitlements(db, accountId, now),
    subscriptionHistory(db, accountId),
  ]);
  return {
    subscription: e.subscription ? subscriptionDto(e.subscription, settings, now) : null,
    entitlements: entitlementsDto(e),
    usage: await planUsage(db, e, now),
    history: history.map((s) => subscriptionDto(s, settings, now)),
    upgrade: { text: settings.upgrade_text ?? null, url: settings.upgrade_url ?? null },
    features: settings.features,
    feature_access: featureAccess(planFeaturesOf(e), settings.features, e.features),
  };
};

/**
 * "My plan" features (plans): the gated keys first (in their order), then the owner's own catalogue
 * keys and any key the version lists that the catalogue lacks — each with the catalogue's label and whether the
 * plan includes it (`planIncludesFeature`: null = everything).
 */
export const featureAccess = (
  included: string[] | null,
  catalogue: { key: string; label: string }[],
  listed: string[],
): PlanFeatureAccess[] => {
  const labels = new Map(catalogue.map((f) => [f.key, f.label]));
  const keys = [...new Set<string>([...PLAN_FEATURE_KEYS, ...catalogue.map((f) => f.key), ...listed])];
  return keys.map((key) => ({
    key,
    label: labels.get(key) ?? null,
    included: planIncludesFeature(included, key),
    gated: isPlanFeatureKey(key),
  }));
};

/** GET /plan — Administration → My plan (the account's admins). */
export const getMyPlan = async (db: Db, ctx: AccountContext) => {
  assertAccountAdmin(ctx);
  return accountPlanView(db, ctx.accountId);
};

export const listCurrentSubscriptions = async (db: Db) => {
  const settings = await loadBillingSettings(db);
  const now = new Date();
  return (await allCurrentSubscriptions(db)).map((s) => subscriptionDto(s, settings, now));
};

const assertAccount = async (db: Db, accountId: string) => {
  if (!(await findAccountById(db, accountId))) throw new AppError('not_found', 'Account not found');
};

/**
 * PUT /platform/accounts/:id/subscription (owner). Another version = the current row ends and a new one starts (the
 * history; a new period, a trial when the version has trial days); the same version = the row changes in place
 * (status, seats, interval, override, note; `renew` starts a new period). Applies at once.
 */
export const assignSubscription = async (
  db: Db,
  owner: SessionUser,
  accountId: string,
  input: z.infer<typeof assignSubscriptionSchema>,
  meta: RequestMeta,
) => {
  await assertAccount(db, accountId);
  const version = await findVersionRow(db, input.plan_version_id);
  if (!version) throw new AppError('not_found', 'SubscriptionPlan version not found');
  const now = new Date();
  const cur = await currentSubscription(db, accountId);
  const overrides = input.overrides
    ? (planOverridesSchema.parse(input.overrides) as Record<string, unknown>)
    : undefined;
  // Add-ons: the quantities sent replace what the subscription holds (a snapshot of each unit).
  const held = subscriptionAddonsSchema.safeParse(cur?.addons ?? {});
  const addons = input.addons
    ? ((await resolveAddons(db, input.addons, held.success ? held.data : {})) as Record<string, unknown>)
    : undefined;
  await db.transaction(async (tx) => {
    if (cur && cur.planVersionId === version.id) {
      const status: SubscriptionStatus = input.status ?? cur.status;
      const interval = input.interval ?? cur.interval;
      const renew = !!input.renew || interval !== cur.interval;
      await updateSubscription(tx, cur.id, {
        status,
        ...(status !== cur.status ? { statusSince: now } : {}),
        interval,
        ...(input.seats !== undefined ? { seats: input.seats } : {}),
        ...(input.cancel_at_period_end !== undefined ? { cancelAtPeriodEnd: input.cancel_at_period_end } : {}),
        // The owner taking a cancellation back also clears the account's own record of it.
        ...(input.cancel_at_period_end === false ? { cancellation: null } : {}),
        ...(overrides ? { overrides } : {}),
        ...(addons ? { addons } : {}),
        ...(input.note !== undefined ? { note: input.note || null } : {}),
        ...(input.status_message !== undefined ? { statusMessage: input.status_message || null } : {}),
        ...(renew ? { periodStart: now, periodEnd: addInterval(now, interval === 'year' ? 'year' : 'month') } : {}),
      });
      await recordAudit(tx, {
        accountId,
        actorId: owner.id,
        action: 'plan.subscription_updated',
        targetType: 'subscription',
        targetId: cur.id,
        payload: { via: 'platform_owner', before: { status: cur.status }, after: { status }, ...input },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await recordPlanChanged(tx, [accountId], { id: owner.id, type: 'user' }, 'subscription_updated');
      return;
    }
    if (cur) await updateSubscription(tx, cur.id, { endedAt: now });
    const status: SubscriptionStatus = input.status ?? (version.trialDays > 0 ? 'trial' : 'active');
    const id = newId();
    await insertSubscription(tx, {
      id,
      accountId,
      planVersionId: version.id,
      status,
      statusSince: now,
      interval: input.interval,
      seats: input.seats ?? cur?.seats ?? null,
      periodStart: now,
      periodEnd: addInterval(now, input.interval),
      trialEndsAt: status === 'trial' ? addDays(now, Math.max(version.trialDays, 1)) : null,
      cancelAtPeriodEnd: input.cancel_at_period_end ?? false,
      overrides: overrides ?? (cur?.overrides as Record<string, unknown> | undefined) ?? {},
      addons: addons ?? (cur?.addons as Record<string, unknown> | undefined) ?? {},
      note: input.note || null,
      statusMessage: input.status_message || null,
      createdBy: owner.id,
    });
    await recordAudit(tx, {
      accountId,
      actorId: owner.id,
      action: 'plan.assigned',
      targetType: 'subscription',
      targetId: id,
      payload: {
        via: 'platform_owner',
        plan_version_id: version.id,
        status,
        replaced: cur?.id ?? null,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await recordPlanChanged(tx, [accountId], { id: owner.id, type: 'user' }, 'plan_assigned');
  });
  forgetEntitlements(accountId);
  return accountPlanView(db, accountId);
};

/**
 * Self sign-up (D32): the new account's first subscription — the chosen plan's version, a trial of the version's own
 * days (else the sign-up setting's `trialDays`; none = active) that ends by the sign-up's own rule
 * (`trialEndStatus`). No card: nothing is charged here. Audited as `plan.assigned` via `signup`.
 */
export const startSignupSubscription = async (
  db: Db,
  p: { accountId: string; versionId: string; trialDays: number; trialEndStatus: string; actorId: string | null },
) => {
  const version = await findVersionRow(db, p.versionId);
  if (!version) throw new AppError('not_found', 'SubscriptionPlan version not found');
  const days = version.trialDays > 0 ? version.trialDays : p.trialDays;
  const status: SubscriptionStatus = days > 0 ? 'trial' : 'active';
  const now = new Date();
  const id = newId();
  await db.transaction(async (tx) => {
    await insertSubscription(tx, {
      id,
      accountId: p.accountId,
      planVersionId: version.id,
      status,
      statusSince: now,
      interval: 'month',
      periodStart: now,
      periodEnd: addInterval(now, 'month'),
      trialEndsAt: status === 'trial' ? addDays(now, days) : null,
      trialEndStatus: status === 'trial' ? p.trialEndStatus : null,
      createdBy: p.actorId,
    });
    await recordAudit(tx, {
      accountId: p.accountId,
      actorId: p.actorId,
      action: 'plan.assigned',
      targetType: 'subscription',
      targetId: id,
      payload: { via: 'signup', plan_version_id: version.id, status, trial_days: status === 'trial' ? days : 0 },
    });
    await recordPlanChanged(tx, [p.accountId], { id: p.actorId, type: 'system' }, 'plan_assigned');
  });
  forgetEntitlements(p.accountId);
};

/** DELETE /platform/accounts/:id/subscription — the account goes back to legacy (unlimited); the row stays in history. */
export const endSubscription = async (db: Db, owner: SessionUser, accountId: string, meta: RequestMeta) => {
  await assertAccount(db, accountId);
  const cur = await currentSubscription(db, accountId);
  if (cur) {
    await db.transaction(async (tx) => {
      await updateSubscription(tx, cur.id, { endedAt: new Date() });
      await recordAudit(tx, {
        accountId,
        actorId: owner.id,
        action: 'plan.ended',
        targetType: 'subscription',
        targetId: cur.id,
        payload: { via: 'platform_owner' },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await recordPlanChanged(tx, [accountId], { id: owner.id, type: 'user' }, 'plan_ended');
    });
  }
  forgetEntitlements(accountId);
  return accountPlanView(db, accountId);
};

export const getAccountSubscription = async (db: Db, accountId: string) => {
  await assertAccount(db, accountId);
  return accountPlanView(db, accountId);
};

/** Owner writes to the settings change every account's effective status: forget the caches. */
export const afterBillingSettingsChange = () => {
  forgetBillingSettings();
  forgetEntitlements();
};
