// SPDX-License-Identifier: AGPL-3.0-only
import { type BillingSettings, PLAN_CHANGED_EVENT, type SubscriptionStatus, subscriptionStateAt } from '@bines/shared';
import type { Db } from '../../db/client';
import { recordEvents } from '../activity/activity.repo';
import { licensedFeatures } from '../license/license.service';
import { loadBillingSettings } from './billing-settings';
import { currentFeatureLists, currentSubscriptionRows, type SubscriptionRow } from './plans.repo';

/**
 * The plan status members see (plans): `plan_status` (and `plan_features`) on GET /me/accounts and /auth/me, and the
 * `account.plan_changed` signal on /me/events (type only) whenever it may have changed — an owner write, a provider
 * event, a billing-settings change, or a scheduled step (the minute sweep below). The app refetches /me/accounts.
 */
export type PlanStatusFields = {
  plan_status: SubscriptionStatus | null;
  plan_status_since: string | null;
  /** The owner's message about the status (the closed screen: why); null = the platform's text. */
  plan_status_message: string | null;
  read_only_at: string | null;
  /** While the status is `trial`: when it ends (the "N trial days left" pill); else null. */
  trial_ends_at: string | null;
  /** The plan's features; null = every feature (legacy, or a version that lists none). */
  plan_features: string[] | null;
};
const LEGACY: PlanStatusFields = {
  plan_status: null,
  plan_status_since: null,
  plan_status_message: null,
  read_only_at: null,
  trial_ends_at: null,
  plan_features: null,
};

const stateOf = (s: SubscriptionRow, settings: BillingSettings, now: Date) => subscriptionStateAt(s, settings, now);

/**
 * Each account's plan status now. Reads the subscription rows directly (not the entitlements cache), so a refetch
 * right after `account.plan_changed` sees the change.
 */
export const planStatusesOf = async (
  db: Db,
  accountIds: string[],
  now = new Date(),
): Promise<Map<string, PlanStatusFields>> => {
  const out = new Map<string, PlanStatusFields>();
  if (!accountIds.length) return out;
  const rows = await currentSubscriptionRows(db, accountIds);
  if (!rows.length) return out;
  const [settings, features] = await Promise.all([loadBillingSettings(db), currentFeatureLists(db, accountIds)]);
  for (const s of rows) {
    const st = stateOf(s, settings, now);
    const listed = features.get(s.accountId) ?? [];
    out.set(s.accountId, {
      plan_status: st.status,
      plan_status_since: st.since.toISOString(),
      plan_status_message: s.statusMessage ?? null,
      read_only_at: st.read_only_at ? st.read_only_at.toISOString() : null,
      trial_ends_at: st.status === 'trial' && s.trialEndsAt ? s.trialEndsAt.toISOString() : null,
      plan_features: listed.length ? listed : null,
    });
  }
  return out;
};

/**
 * The plan status plus `license_features`: what the installation's enterprise license key unlocks (the same for
 * every account; empty without a valid key) — the app's gates combine both (`featureAllowed`).
 */
export const planStatusOf = async (db: Db, accountId: string, now = new Date()) => ({
  ...((await planStatusesOf(db, [accountId], now)).get(accountId) ?? LEGACY),
  license_features: await licensedFeatures(db, now),
});

export const withPlanStatus = async <T extends { id: string }>(db: Db, accounts: T[]) => {
  const [map, license_features] = await Promise.all([
    planStatusesOf(
      db,
      accounts.map((a) => a.id),
    ),
    licensedFeatures(db),
  ]);
  return accounts.map((a) => ({ ...a, ...(map.get(a.id) ?? LEGACY), license_features }));
};

/** `account.plan_changed` to every member of these accounts (one activity row each; realtime carries the type). */
export const recordPlanChanged = async (
  db: Db,
  accountIds: string[],
  actor: { id: string | null; type: 'user' | 'system' },
  reason: string,
) => {
  if (!accountIds.length) return;
  await recordEvents(
    db,
    accountIds.map((accountId) => ({
      accountId,
      type: PLAN_CHANGED_EVENT,
      actorId: actor.id,
      actorType: actor.type,
      meta: { reason },
    })),
  );
};

/** Accounts whose effective status differs between two moments / two settings. */
const changedBetween = (
  rows: SubscriptionRow[],
  a: { settings: BillingSettings; at: Date },
  b: { settings: BillingSettings; at: Date },
) =>
  rows
    .filter((s) => stateOf(s, a.settings, a.at).status !== stateOf(s, b.settings, b.at).status)
    .map((s) => s.accountId);

/** The billing settings changed: tell the accounts whose status moved with them. */
export const announceSettingsChange = async (db: Db, before: BillingSettings, after: BillingSettings) => {
  const now = new Date();
  const moved = changedBetween(
    await currentSubscriptionRows(db),
    { settings: before, at: now },
    { settings: after, at: now },
  );
  await recordPlanChanged(db, moved, { id: null, type: 'system' }, 'billing_settings');
  return moved.length;
};

/**
 * `billing.plan_transitions` (every minute): accounts whose status changed by the schedule in (from, to] — a trial
 * ended, the grace ran out, read-only became suspended, a cancellation reached the period end. Stateless: each run
 * covers the minute before its scheduled time; runs missed within the backfill period run late (billing/jobs.ts).
 */
export const sweepPlanTransitions = async (db: Db, from: Date, to: Date) => {
  const settings = await loadBillingSettings(db);
  const moved = changedBetween(await currentSubscriptionRows(db), { settings, at: from }, { settings, at: to });
  await recordPlanChanged(db, moved, { id: null, type: 'system' }, 'schedule');
  return moved;
};
