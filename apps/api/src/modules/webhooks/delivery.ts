// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import { AppError, newId, WEBHOOK_DISABLE_AFTER_DEAD, WEBHOOK_RETRY_MINUTES, type Recipe } from '@bines/shared';
import type { Db } from '../../db/client';
import { automations, webhookDeliveries, webhooks } from '../../db/schema';
import type { AppDeps } from '../../types';
import { enqueueJob } from '../../lib/jobs';
import { allowPrivateOutbound, outboundRequest, signBody, signLite } from '../../lib/outbound';
import { recordError } from '../errors/errors.writer';
import { accountClosed } from '../billing/entitlements';

/**
 * Delivery of one webhook call (06 §2.17), for a board webhook or an automation's `webhook` action: POST the
 * stored body, signed `X-Bines-Signature: sha256=HMAC(secret, timestamp + "." + body)` and
 * `X-Bines-Signature-Lite: sha256=HMAC(secret, timestamp + "." + deliveryId)`; a `flat` subscription also carries
 * `timestamp` and `signatureLite` at the top of the body (Make). Success = 2xx within
 * 10 s. A failure is retried 1m, 5m, 30m, 2h, 6h, 24h, then the delivery is dead; 50 dead in a row disable
 * the webhook.
 */
export type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export const TIMEOUT_MS = 10_000;

export const queueDelivery = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  row: Omit<typeof webhookDeliveries.$inferInsert, 'id'>,
  opts: { stampDeliveryId?: boolean } = {},
) => {
  const id = newId();
  // A `flat` subscription reads the delivery id from the body too (Make cannot rely on header names).
  const event = (row.requestBody as { event?: Record<string, unknown> } | null | undefined)?.event;
  const requestBody =
    opts.stampDeliveryId && event
      ? { ...(row.requestBody as object), event: { ...event, deliveryId: id } }
      : row.requestBody;
  await deps.db.insert(webhookDeliveries).values({ ...row, requestBody, id, status: 'pending' });
  // Where there is no queue (tests, a database the worker never ran on) it goes out right away.
  if (!(await enqueueJob(deps.db, 'webhook.deliver', { delivery_id: id }, { maxAttempts: 1 }))) await deliver(deps, id);
  return id;
};

/** Target, method, headers and signing secret of a delivery. */
const targetOf = async (db: Db, d: DeliveryRow) => {
  if (d.webhookId) {
    const w = (await db.select().from(webhooks).where(eq(webhooks.id, d.webhookId)).limit(1))[0];
    if (!w || w.deletedAt || !w.isActive) return null;
    return { url: w.url, method: 'POST', headers: {} as Record<string, string>, secret: w.secret, webhook: w };
  }
  const a = d.automationId
    ? (await db.select().from(automations).where(eq(automations.id, d.automationId)).limit(1))[0]
    : undefined;
  if (!a || a.deletedAt || !d.url) return null;
  const action = (a.recipe as unknown as Recipe).actions[d.actionIndex ?? -1];
  const secret = action?.type === 'webhook' ? action.secret : undefined;
  return { url: d.url, method: d.method, headers: d.headers ?? {}, secret, webhook: null };
};

export const deliver = async (deps: Pick<AppDeps, 'db' | 'env'>, id: string) => {
  const { db } = deps;
  const d = (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1))[0];
  if (!d || d.status !== 'pending') return d ?? null;
  // plan-lock: a closed account sends nothing out — the delivery stops here (kept, never retried).
  if (await accountClosed(db, d.accountId)) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'failed', error: 'account_closed', nextAttemptAt: null })
      .where(eq(webhookDeliveries.id, id));
    return null;
  }
  const target = await targetOf(db, d);
  if (!target) {
    await db
      .update(webhookDeliveries)
      .set({ status: 'failed', error: 'target_gone', nextAttemptAt: null })
      .where(eq(webhookDeliveries.id, id));
    recordDeliveryFailure(db, d, 'target_gone', 'warning');
    return null;
  }
  const attempt = d.attempt + 1;
  const timestamp = String(Date.now());
  const lite = target.secret ? signLite(target.secret, timestamp, d.id) : null;
  // A `flat` subscription (Make) gets the timestamp and the lite signature in the body too: its webhook code may not
  // see the headers. The full-body signature below covers these fields as well.
  const flat = (target.webhook?.config as { format?: string } | undefined)?.format === 'flat';
  const sent =
    flat && lite && d.requestBody && typeof d.requestBody === 'object' && !Array.isArray(d.requestBody)
      ? { ...(d.requestBody as object), timestamp, signatureLite: lite }
      : d.requestBody;
  const body = JSON.stringify(sent);
  const started = Date.now();
  let status: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  try {
    const res = await outboundRequest(target.url, {
      method: target.method,
      headers: {
        ...target.headers,
        'content-type': 'application/json',
        'user-agent': 'BinesOS-Webhooks/1',
        'x-bines-event': d.eventType ?? 'event',
        'x-bines-delivery': d.id,
        'x-bines-timestamp': timestamp,
        ...(target.secret ? { 'x-bines-signature': signBody(target.secret, timestamp, body) } : {}),
        ...(lite ? { 'x-bines-signature-lite': lite } : {}),
      },
      body,
      timeoutMs: TIMEOUT_MS,
      allowPrivate: allowPrivateOutbound(deps.env),
      maxBytes: 2000,
    });
    status = res.status;
    responseBody = res.body.slice(0, 2000);
    if (!res.ok) error = `http_${res.status}`;
  } catch (e) {
    error =
      e instanceof AppError
        ? e.message
        : ((e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message).slice(0, 300);
  }
  const ms = Date.now() - started;
  if (!error) {
    await db
      .update(webhookDeliveries)
      .set({
        status: 'delivered',
        attempt,
        responseStatus: status,
        responseBody,
        responseMs: ms,
        error: null,
        deliveredAt: new Date(),
        nextAttemptAt: null,
      })
      .where(eq(webhookDeliveries.id, id));
    if (target.webhook?.failureCount)
      await db.update(webhooks).set({ failureCount: 0 }).where(eq(webhooks.id, target.webhook.id));
    return { ...d, status: 'delivered' as const, attempt, responseStatus: status };
  }
  const retryIn = WEBHOOK_RETRY_MINUTES[attempt - 1];
  // A blocked (private) URL will not get better: no retries.
  const final = retryIn === undefined || error === 'webhook_url_private' || error === 'webhook_url_invalid';
  const next = final ? null : new Date(Date.now() + retryIn * 60_000);
  await db
    .update(webhookDeliveries)
    .set({
      status: final ? 'dead' : 'pending',
      attempt,
      responseStatus: status,
      responseBody,
      responseMs: ms,
      error,
      nextAttemptAt: next,
    })
    .where(eq(webhookDeliveries.id, id));
  // Errors hub: a delivery that gave up (dead) is an error; a failed attempt that will retry, a warning.
  recordDeliveryFailure(db, d, error, final ? 'error' : 'warning');
  if (next) await enqueueJob(db, 'webhook.deliver', { delivery_id: id }, { runAt: next, maxAttempts: 1 });
  if (final && target.webhook) {
    const [w] = await db
      .update(webhooks)
      .set({ failureCount: sql`${webhooks.failureCount} + 1` })
      .where(eq(webhooks.id, target.webhook.id))
      .returning({ failures: webhooks.failureCount });
    if (w && w.failures >= WEBHOOK_DISABLE_AFTER_DEAD)
      await db
        .update(webhooks)
        .set({ isActive: false, disabledReason: 'too_many_failures' })
        .where(and(eq(webhooks.id, target.webhook.id), eq(webhooks.isActive, true)));
  }
  return { ...d, status: final ? ('dead' as const) : ('pending' as const), attempt, responseStatus: status, error };
};

/** One webhook failure in the errors hub: the webhook (or the automation's webhook action), never the payload or URL. */
const recordDeliveryFailure = (
  db: AppDeps['db'],
  d: typeof webhookDeliveries.$inferSelect,
  error: string,
  severity: 'warning' | 'error',
) =>
  recordError(db, {
    source: 'webhook',
    code: /^[a-z][a-z0-9_]{2,60}$/.test(error) ? error : 'delivery_failed',
    message: error,
    accountId: d.accountId,
    severity,
    links: {
      delivery_id: d.id,
      ...(d.webhookId ? { webhook_id: d.webhookId } : {}),
      ...(d.automationId ? { automation_id: d.automationId } : {}),
    },
  });
