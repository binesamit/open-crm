// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import type { Db } from '../../db/client';
import { recordAudit } from '../audit/audit.repo';
import { forgetEntitlements } from './entitlements';
import { recordPlanChanged } from './plan-status';
import { subscriptionByProviderRef, updateSubscription } from './plans.repo';
import { billingProvider, type WebhookRequest } from './provider';

/**
 * POST /billing/webhook/{provider} (stage 3). No provider registered under the key → 501
 * `not_implemented` (the state today). With one: its signature check (401 on failure), its events normalized, and
 * for each the subscription it refers to is updated from `getStatus` — never from the event itself — so replays
 * and out-of-order events change nothing. Every change is audited in the account.
 */
export const handleBillingWebhook = async (db: Db, key: string, req: WebhookRequest) => {
  const provider = billingProvider(key);
  if (!provider) throw new AppError('not_implemented', 'No billing provider is registered', { provider: key });
  if (!(await provider.verifyWebhook(req))) throw new AppError('unauthenticated', 'invalid_signature');
  const events = await provider.mapEvent(req);
  let applied = 0;
  for (const ev of events) {
    const sub = await subscriptionByProviderRef(db, key, ev.externalId);
    if (!sub) continue;
    const truth = await provider.getStatus(ev.externalId);
    const now = new Date();
    await db.transaction(async (tx) => {
      await updateSubscription(tx, sub.id, {
        status: truth.status,
        ...(truth.status !== sub.status ? { statusSince: now } : {}),
        ...(truth.periodStart ? { periodStart: new Date(truth.periodStart) } : {}),
        ...(truth.periodEnd ? { periodEnd: new Date(truth.periodEnd) } : {}),
        cancelAtPeriodEnd: truth.cancelAtPeriodEnd,
      });
      await recordAudit(tx, {
        accountId: sub.accountId,
        actorId: null,
        action: 'plan.provider_event',
        targetType: 'subscription',
        targetId: sub.id,
        payload: { provider: key, event_id: ev.id, type: ev.type, before: sub.status, after: truth.status },
      });
      await recordPlanChanged(tx, [sub.accountId], { id: null, type: 'system' }, 'provider_event');
    });
    forgetEntitlements(sub.accountId);
    applied++;
  }
  return { received: events.length, applied };
};
