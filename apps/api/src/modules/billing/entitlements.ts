// SPDX-License-Identifier: AGPL-3.0-only
import { PLAN_FEATURE_KEYS } from '@bines/shared';
import {
  AppError,
  effectiveSubscriptionStatus,
  type EntitlementsDto,
  featureAllowed,
  mergeLimits,
  addonExtras,
  subscriptionAddonsSchema,
  PLAN_LIMIT_KINDS,
  PLAN_LIMIT_PERIOD,
  type PlanFeatureKey,
  type PlanLimitKind,
  type PlanLimits,
  planLimitsSchema,
  planOverridesSchema,
  type PlanUsage,
  statusBlocksAi,
  type SubscriptionStatus,
  WRITE_BLOCKING_STATUSES,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { usageBetween } from '../ai/ai.repo';
import { notifyUsers } from '../notifications/notify';
import { licensedFeatures } from '../license/license.service';
import { loadBillingSettings } from './billing-settings';
import {
  accountDeletionScheduled,
  activeAdminIds,
  boardsUsed,
  bumpCounter,
  counterValue,
  currentSubscription,
  itemsUsed,
  markAlert,
  seatsUsed,
  storageBytesUsed,
  type SubscriptionWithPlan,
} from './plans.repo';

/**
 * Entitlements: what an account may have and do now — its subscription's plan version, the seats it
 * bought, the owner's override, and the status that holds now (billing settings). No subscription = legacy =
 * unlimited (every account before plans existed, until the owner assigns one).
 *
 * `assertWithinLimit(db, accountId, kind, delta)` is the one check every creation point calls: over the limit it
 * blocks only that next action (402 `plan_limit_reached` {kind, limit, used, upgrade}); nothing is ever deleted or
 * hidden. Passing the warning share (`warn_pct`, 80 by default) notifies the account's admins once a period; using
 * the last unit notifies them once more ("reached").
 */

export const GB = 1024 ** 3;

export type Entitlements = {
  accountId: string;
  unlimited: boolean;
  subscription: SubscriptionWithPlan | null;
  /** The status that holds now (null = no subscription). */
  status: SubscriptionStatus | null;
  /** Every kind present; null = unlimited. */
  limits: Record<PlanLimitKind, number | null>;
  features: string[];
};

const UNLIMITED = Object.fromEntries(PLAN_LIMIT_KINDS.map((k) => [k, null])) as Record<PlanLimitKind, null>;

/** The current subscription per account, briefly (the hot path: every scoped request reads the status). */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; sub: SubscriptionWithPlan | null }>();

/** accounts scheduled for deletion, briefly (the same hot path). */
const deletionCache = new Map<string, { at: number; scheduled: boolean }>();

/** After an owner / provider change (and in tests): read the subscription again. */
export const forgetEntitlements = (accountId?: string) => {
  if (accountId) {
    cache.delete(accountId);
    deletionCache.delete(accountId);
  } else {
    cache.clear();
    deletionCache.clear();
  }
};

/** Is the account's deletion scheduled ? Then it is locked like a closed account. */
export const deletionScheduled = async (db: Db, accountId: string) => {
  const hit = deletionCache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.scheduled;
  const scheduled = await accountDeletionScheduled(db, accountId);
  if (deletionCache.size > 5000) deletionCache.clear();
  deletionCache.set(accountId, { at: Date.now(), scheduled });
  return scheduled;
};

const subscriptionOf = async (db: Db, accountId: string) => {
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.sub;
  const sub = (await currentSubscription(db, accountId)) ?? null;
  if (cache.size > 5000) cache.clear();
  cache.set(accountId, { at: Date.now(), sub });
  return sub;
};

const parseLimits = (raw: unknown): PlanLimits => {
  const parsed = planLimitsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
};
const parseOverrides = (raw: unknown) => {
  const parsed = planOverridesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
};

export const entitlements = async (db: Db, accountId: string, now = new Date()): Promise<Entitlements> => {
  const own = await entitlementsOfPlan(db, accountId, now);
  // an account scheduled for deletion runs nothing — every gate reads it as closed (jobs, sockets
  // public links, MCP, AI). Its requests have their own gate (requireAccount → assertDeletionAllows).
  return (await deletionScheduled(db, accountId)) ? { ...own, status: 'closed' } : own;
};

const entitlementsOfPlan = async (db: Db, accountId: string, now: Date): Promise<Entitlements> => {
  const sub = await subscriptionOf(db, accountId);
  if (!sub) return { accountId, unlimited: true, subscription: null, status: null, limits: UNLIMITED, features: [] };
  const settings = await loadBillingSettings(db);
  const status = effectiveSubscriptionStatus(
    {
      status: sub.status,
      statusSince: sub.statusSince,
      trialEndsAt: sub.trialEndsAt,
      periodEnd: sub.periodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      trialEndStatus: sub.trialEndStatus,
    },
    settings,
    now,
  );
  const held = subscriptionAddonsSchema.safeParse(sub.addons ?? {});
  const merged = mergeLimits(
    parseLimits(sub.version.limits),
    sub.seats,
    parseOverrides(sub.overrides),
    addonExtras(held.success ? held.data : {}),
  );
  const limits = Object.fromEntries(PLAN_LIMIT_KINDS.map((k) => [k, merged[k] ?? null])) as Record<
    PlanLimitKind,
    number | null
  >;
  return {
    accountId,
    unlimited: false,
    subscription: sub,
    status,
    limits,
    features: Array.isArray(sub.version.features) ? sub.version.features : [],
  };
};

/** The plan's feature list for `planIncludesFeature`: null = everything (legacy, or a version that lists none). */
export const planFeaturesOf = (e: Pick<Entitlements, 'unlimited' | 'features'>): string[] | null =>
  e.unlimited || e.features.length === 0 ? null : e.features;

export const entitlementsDto = (e: Entitlements): EntitlementsDto => ({
  unlimited: e.unlimited,
  status: e.status,
  limits: e.limits,
  features: e.features,
  all_features: planFeaturesOf(e) === null,
});

/**
 * Does the account's plan include this feature (plans)? Legacy (no subscription) and a version with an
 * empty feature list = everything; only a version that lists features is restricted to them. An enterprise feature
 * (`EE_FEATURE_KEYS`, none yet) needs the installation's license key or an explicit plan listing (`featureAllowed`).
 */
export const hasFeature = async (db: Db, accountId: string, key: string) =>
  featureAllowed(planFeaturesOf(await entitlements(db, accountId)), await licensedFeatures(db), key);

export const featureError = (feature: PlanFeatureKey) =>
  new AppError('plan_feature_unavailable', `The plan does not include: ${feature}`, { feature, upgrade: true });

/**
 * The one feature check before creating or using something gated (402 `plan_feature_unavailable`
 * {feature, upgrade: true}). Never deletes or hides: what exists stays readable (feature-gates.ts for the routes).
 */
export const assertFeature = async (db: Db, accountId: string, feature: PlanFeatureKey) => {
  if (!(await hasFeature(db, accountId, feature))) throw featureError(feature);
};

// ---- periods & usage ----

const monthOf = (now: Date) => now.toISOString().slice(0, 7);
const dayOf = (now: Date) => now.toISOString().slice(0, 10);
/** The counter / alert period of a kind: the UTC day for daily kinds, else the UTC month (alerts once a month). */
export const periodKey = (kind: PlanLimitKind, now: Date) =>
  PLAN_LIMIT_PERIOD[kind] === 'day' ? dayOf(now) : monthOf(now);
const nextMonthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

/**
 * API calls of all the account's tokens today, in this process (like the per-token budgets: one API instance; more
 * replicas would each count on their own).
 */
const apiCalls = new Map<string, { day: string; count: number }>();
const apiCallsToday = (accountId: string, now: Date) => {
  const c = apiCalls.get(accountId);
  return c && c.day === dayOf(now) ? c.count : 0;
};

/** How much of `kind` the account uses now (in the kind's unit: GB for storage, USD for AI). */
export const usageOf = async (db: Db, accountId: string, kind: PlanLimitKind, now = new Date()): Promise<number> => {
  switch (kind) {
    case 'seats':
      return seatsUsed(db, accountId);
    case 'boards':
      return boardsUsed(db, accountId);
    case 'items':
      return itemsUsed(db, accountId);
    case 'storage_gb':
      return (await storageBytesUsed(db, accountId)) / GB;
    case 'automation_runs':
      return counterValue(db, accountId, periodKey(kind, now), kind);
    case 'ai_usd':
      return (await usageBetween(db, accountId, `${monthOf(now)}-01`, nextMonthStart(now))).reduce(
        (s, r) => s + Number(r.costUsd),
        0,
      );
    case 'api_calls_per_day':
      return apiCallsToday(accountId, now);
  }
};

const round = (v: number) => Math.round(v * 100) / 100;

/** Every limit with its usage (the "My plan" bars). */
export const planUsage = async (db: Db, e: Entitlements, now = new Date()): Promise<PlanUsage[]> => {
  const out: PlanUsage[] = [];
  for (const kind of PLAN_LIMIT_KINDS) {
    const used = round(await usageOf(db, e.accountId, kind, now));
    const limit = e.limits[kind];
    out.push({
      kind,
      used,
      limit,
      pct: limit === null ? null : limit === 0 ? (used > 0 ? 100 : 0) : Math.round((used / limit) * 100),
      period: PLAN_LIMIT_PERIOD[kind],
    });
  }
  return out;
};

// ---- alerts ----

/** Alerts already marked this period (skip the database round trip on every later action). */
const marked = new Set<string>();

const notifyAdmins = async (
  db: Db,
  accountId: string,
  kind: PlanLimitKind,
  level: 'warn' | 'reached',
  used: number,
  limit: number,
  now: Date,
) => {
  const period = periodKey(kind, now);
  const memo = `${accountId}:${period}:${kind}:${level}`;
  if (marked.has(memo)) return;
  if (!(await markAlert(db, accountId, period, kind, level))) {
    if (marked.size > 20_000) marked.clear();
    marked.add(memo);
    return;
  }
  const admins = await activeAdminIds(db, accountId);
  // Required (billing): the plan's status always reaches the admins.
  await notifyUsers(
    db,
    {
      accountId,
      type: 'plan_limit',
      actorId: null,
      payload: { kind, level, used: round(used), limit, excerpt: `${round(used)} / ${limit}` },
    },
    admins,
  );
};

const warnIfNear = async (db: Db, e: Entitlements, kind: PlanLimitKind, after: number, limit: number, now: Date) => {
  if (limit <= 0) return;
  if (after >= limit) return notifyAdmins(db, e.accountId, kind, 'reached', after, limit, now);
  const { warn_pct } = await loadBillingSettings(db);
  if (after * 100 >= limit * warn_pct) await notifyAdmins(db, e.accountId, kind, 'warn', after, limit, now);
};

const limitError = (kind: PlanLimitKind, limit: number, used: number) =>
  new AppError('plan_limit_reached', `Plan limit reached: ${kind}`, {
    kind,
    limit,
    used: round(used),
    upgrade: true,
  });

/**
 * The one check before something that counts against a plan (`delta` in the kind's unit). Unlimited → nothing. Over
 * → 402 `plan_limit_reached`; `delta` 0 = "is anything left" (AI budget). Near / at the limit → the admins' alert.
 */
export const assertWithinLimit = async (
  db: Db,
  accountId: string,
  kind: PlanLimitKind,
  delta = 1,
  now = new Date(),
) => {
  const e = await entitlements(db, accountId, now);
  const limit = e.limits[kind];
  if (limit === null) return;
  const used = await usageOf(db, accountId, kind, now);
  const over = delta > 0 ? used + delta > limit + 1e-9 : used >= limit;
  if (over) throw limitError(kind, limit, used);
  await warnIfNear(db, e, kind, used + delta, limit, now);
};

/** A monthly consumption (automation runs): checked, then counted. Resets with the month (a new counter row). */
export const consume = async (db: Db, accountId: string, kind: 'automation_runs', delta = 1, now = new Date()) => {
  const e = await entitlements(db, accountId, now);
  const limit = e.limits[kind];
  if (limit !== null) {
    const used = await counterValue(db, accountId, periodKey(kind, now), kind);
    if (used + delta > limit) throw limitError(kind, limit, used);
  }
  const after = await bumpCounter(db, accountId, periodKey(kind, now), kind, delta);
  if (limit !== null) await warnIfNear(db, e, kind, after, limit, now);
};

/**
 * One API request of a token of the account (06 §1.10, the plan's daily cap on top of the token budgets). The
 * per-token daily quota is capped by the plan in `tokenLimits`; this one counts all the account's tokens together.
 */
export const chargeApiCall = async (db: Db, accountId: string, now = new Date()) => {
  const e = await entitlements(db, accountId, now);
  const limit = e.limits.api_calls_per_day;
  if (limit === null) return;
  const day = dayOf(now);
  const c = apiCalls.get(accountId);
  const used = c && c.day === day ? c.count : 0;
  if (used + 1 > limit) throw limitError('api_calls_per_day', limit, used);
  if (apiCalls.size > 20_000) apiCalls.clear();
  apiCalls.set(accountId, { day, count: used + 1 });
  await warnIfNear(db, e, 'api_calls_per_day', used + 1, limit, now);
};

/** The plan's daily API cap for one token's quota (null = none). */
export const planApiDailyCap = async (db: Db, accountId: string) =>
  (await entitlements(db, accountId)).limits.api_calls_per_day;

/** Has the account used up its plan's monthly AI budget (USD)? No limit → false. */
export const planAiBudgetUsedUp = async (db: Db, accountId: string, now = new Date()) => {
  const limit = (await entitlements(db, accountId, now)).limits.ai_usd;
  return limit !== null && (await usageOf(db, accountId, 'ai_usd', now)) >= limit;
};

// ---- status ----

/** `read_only` / `suspended` / `closed` stop writes; null (no subscription), trial, active and past_due write as usual. */
export const writesBlocked = (status: SubscriptionStatus | null) =>
  !!status && WRITE_BLOCKING_STATUSES.includes(status);

export const closedError = () =>
  new AppError('account_closed', 'The account is closed', { upgrade: true, closed: true });

/** Is the account closed now (plan-lock)? Reads the brief entitlements cache (an owner's write clears it). */
export const accountClosed = async (db: Db, accountId: string) =>
  (await entitlements(db, accountId)).status === 'closed';

/**
 * The one check before anything of an account runs outside a request (a job, an engine actor, a socket, a public
 * link): a closed account runs nothing (403 `account_closed`). Nothing is deleted; it all resumes when reopened.
 */
export const assertAccountOpen = async (db: Db, accountId: string) => {
  if (await accountClosed(db, accountId)) throw closedError();
};

/**
 * The AI's own status gate (plan-lock): in a read-only, suspended or closed account the AI does not work at
 * all — no assistant (not even its reads), no agents, no AI columns, no images, no help assistant. The error is the
 * status's own (423 `plan_read_only` / `plan_suspended`, 403 `account_closed`) with `ai: true`.
 */
export const aiStatusError = (status: SubscriptionStatus | null): AppError | null => {
  if (!statusBlocksAi(status)) return null;
  if (status === 'closed') return closedError();
  return status === 'suspended'
    ? new AppError('plan_suspended', 'The account’s subscription is suspended', { upgrade: true, ai: true })
    : new AppError('plan_read_only', 'AI is not available while the account is read-only', {
        upgrade: true,
        ai: true,
      });
};

export const assertAiStatusAllows = async (db: Db, accountId: string) => {
  const err = aiStatusError((await entitlements(db, accountId)).status);
  if (err) throw err;
};

/**
 * Status gate for a request (requireAccount): support tickets (`/support/*`) always pass; `suspended` answers
 * everything else with 423 `plan_suspended` except the admins' "My plan" (`/plan`); `read_only` answers writes with
 * 423 `plan_read_only` except the admins' billing and
 * administration (people, invitations, account settings, security) — reads always work, nothing is hidden.
 * `closed` (plan-lock) answers everything with 403 `account_closed` except `CLOSED_OPEN`, and never to a token.
 */
const SUSPENDED_OPEN = /^\/plan(\/|$)/;
/**
 * Support tickets (product decision): a blocked account can always reach support — open, reply, close, rate, and
 * approve / decline access requests — whatever its subscription status (the tickets module checks roles itself).
 */
const SUPPORT_OPEN = /^\/support(\/|$)/;
const READ_ONLY_ADMIN = /^\/(plan|billing|users|invitations|accounts\/me|security|support-access)(\/|$)/;
/**
 * What a closed account still answers inside its scope (plan-lock): its plan ("My plan", read only) and support
 * tickets ("contact us": the form's options, open one, read / reply to / close / reopen / rate one's own). Everything
 * else — boards, files, search, live streams, profile, administration, AI — is 403 `account_closed`. Outside the
 * account scope the person keeps /auth/me, /me/accounts, sign-out and the offered plans (`GET /plans/public`).
 */
const CLOSED_OPEN: { method: RegExp; path: RegExp }[] = [
  { method: /^GET$/, path: /^\/plan$/ },
  { method: /^(GET|POST)$/, path: /^\/support\/tickets(\/[A-Za-z0-9_-]+(\/(messages|close|reopen|rating))?)?$/ },
];

/** Does a closed account answer this request (method + path inside the account scope)? */
export const closedAllows = (method: string, path: string) =>
  CLOSED_OPEN.some((r) => r.method.test(method) && r.path.test(path));

export const assertPlanStatusAllows = async (
  db: Db,
  p: { accountId: string; role: string; method: string; path: string; isRead: boolean; token?: boolean },
) => {
  const { status } = await entitlements(db, p.accountId);
  if (!writesBlocked(status)) return;
  if (status === 'closed') {
    // A token (an API client, an extension, an app) never reaches even the allowlist: it is for the account's people.
    if (!p.token && closedAllows(p.method, p.path)) return;
    throw closedError();
  }
  if (SUPPORT_OPEN.test(p.path)) return;
  const admin = p.role === 'admin';
  if (status === 'suspended') {
    if (admin && SUSPENDED_OPEN.test(p.path)) return;
    throw new AppError('plan_suspended', 'The account’s subscription is suspended', { upgrade: true });
  }
  if (p.isRead || (admin && READ_ONLY_ADMIN.test(p.path))) return;
  throw new AppError('plan_read_only', 'The account’s subscription is read-only', { upgrade: true });
};

/** The plan's features this account does not have (the AI says so); none on an unlimited plan. */
export const missingFeatures = async (db: Db, accountId: string): Promise<string[]> => {
  const out: string[] = [];
  for (const key of PLAN_FEATURE_KEYS) if (!(await hasFeature(db, accountId, key))) out.push(key);
  return out;
};
