// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import {
  AppError,
  newId,
  normalizeWebhookEvent,
  type createWebhookSchema,
  type updateWebhookSchema,
  type Webhook,
  type WebhookDelivery,
  scopeAllows,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { webhookDeliveries, webhooks } from '../../db/schema';
import type { AppDeps } from '../../types';
import { allowPrivateOutbound, assertPublicUrl, outboundRequest } from '../../lib/outbound';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, isOwnerOrAdmin, loadBoardAccess } from '../boards/boards.access';
import type { Actor } from '../items/items.service';
import { deliver, queueDelivery } from './delivery';

/** Board webhooks (06 §2.17): subscribe, verify by challenge, sign, retry, log. */
type Row = typeof webhooks.$inferSelect;

const dto = (r: Row): Webhook => ({
  id: r.id,
  board_id: r.boardId!,
  url: r.url,
  event: r.eventType as Webhook['event'],
  config: r.config as Webhook['config'],
  description: r.description,
  is_active: r.isActive,
  verified: !!r.challengeVerifiedAt,
  disabled_reason: r.disabledReason,
  failure_count: r.failureCount,
  secret: r.secret,
  created_at: r.createdAt.toISOString(),
});

const deliveryDto = (d: typeof webhookDeliveries.$inferSelect): WebhookDelivery => ({
  id: d.id,
  webhook_id: d.webhookId,
  automation_id: d.automationId,
  event_id: d.eventId,
  event_type: d.eventType,
  status: d.status,
  attempt: d.attempt,
  response_status: d.responseStatus,
  response_ms: d.responseMs,
  error: d.error,
  next_attempt_at: d.nextAttemptAt?.toISOString() ?? null,
  delivered_at: d.deliveredAt?.toISOString() ?? null,
  created_at: d.createdAt.toISOString(),
});

const newSecret = () => randomBytes(24).toString('hex');

const managed = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  // an extension's server on a board it was granted (its token's board limit) — its own webhooks only
  // to its own origins (assertExtensionTarget); never the board's other channels.
  if (!a.ctx.extServer) assertBoard(access, 'webhook.manage');
  else assertBoard(access, 'item.read');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'webhooks_live_on_the_main_board');
  return access;
};

/**
 * Setting up or changing a channel that carries the board's content: the caller must be able to read its items
 * (S-87 — an admin not subscribed to a private / shareable board does not get them by webhook), and a token needs
 * `boards:read` to have the item itself sent along (S-100 — `webhooks` alone is not a read scope).
 */
const assertContentAccess = (a: Actor, access: Awaited<ReturnType<typeof loadBoardAccess>>, config: unknown) => {
  assertBoard(access, 'item.read');
  const scopes = a.ctx.tokenScopes;
  if (
    (config as { include_item?: boolean } | null | undefined)?.include_item &&
    scopes &&
    !scopeAllows(scopes, 'boards:read')
  )
    throw new AppError('insufficient_scope', 'This token lacks the "boards:read" scope (include_item)', {
      required: 'boards:read',
    });
};

const load = async (db: Db, a: Actor, id: string) => {
  const row = (
    await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.accountId, a.ctx.accountId), eq(webhooks.id, id), isNull(webhooks.deletedAt)))
      .limit(1)
  )[0];
  if (!row?.boardId) throw new AppError('not_found', 'Webhook not found');
  if (a.ctx.extServer && row.createdBy !== a.ctx.extServer.userId) throw new AppError('not_found', 'Webhook not found');
  const access = await managed(db, a, row.boardId);
  return { row, access };
};

/**
 * The handshake (06 §2.17): POST `{"challenge": "<64 hex>"}` and expect 200 with the same challenge back within
 * 5 s — so nobody registers a URL they do not control.
 */
export const handshake = async (deps: Pick<AppDeps, 'env'>, url: string) => {
  const allowPrivate = allowPrivateOutbound(deps.env);
  await assertPublicUrl(url, allowPrivate);
  const challenge = randomBytes(32).toString('hex');
  try {
    const res = await outboundRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'BinesOS-Webhooks/1' },
      body: JSON.stringify({ challenge }),
      timeoutMs: 5000,
      allowPrivate,
      maxBytes: 4096,
    });
    let body: { challenge?: string } | null = null;
    try {
      body = JSON.parse(res.body) as { challenge?: string };
    } catch {
      body = null;
    }
    if (res.ok && body?.challenge === challenge) return;
  } catch (e) {
    if (e instanceof AppError) throw e;
    // below
  }
  throw new AppError('invalid_value', 'webhook_challenge_failed', { url });
};

/** an extension's server sends its webhooks only to an origin its manifest lists. */
const assertExtensionTarget = (a: Actor, url: string) => {
  if (!a.ctx.extServer) return;
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    // below
  }
  if (!a.ctx.extServer.origins.includes(origin)) throw new AppError('forbidden', 'extension_webhook_origin', { url });
};

const assertNotSupport = (a: Actor) => {
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed', { reason: 'webhook' });
};

export const listWebhooks = async (db: Db, a: Actor, boardId: string) => {
  await managed(db, a, boardId);
  const rows = await db
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.accountId, a.ctx.accountId),
        eq(webhooks.boardId, boardId),
        isNull(webhooks.deletedAt),
        // an extension's server lists its own webhooks only.
        ...(a.ctx.extServer ? [eq(webhooks.createdBy, a.ctx.extServer.userId)] : []),
      ),
    )
    .orderBy(desc(webhooks.createdAt));
  return { data: rows.map(dto) };
};

export const getWebhook = async (db: Db, a: Actor, id: string) => dto((await load(db, a, id)).row);

export const createWebhook = async (
  deps: AppDeps,
  a: Actor,
  boardId: string,
  input: z.infer<typeof createWebhookSchema>,
) => {
  const { db } = deps;
  // S-54: remote support access (even `edit`) never sets up or changes an outgoing channel — it would outlive the grant.
  assertNotSupport(a);
  const access = await managed(db, a, boardId);
  assertContentAccess(a, access, input.config);
  const event = normalizeWebhookEvent(input.event);
  if (!event) throw new AppError('invalid_value', 'unknown_webhook_event', { event: input.event });
  if (event === 'specific_column_changed' && !input.config?.column_id)
    throw new AppError('invalid_value', 'column_id_required', { event });
  if (event === 'item_moved_to_specific_group' && !input.config?.group_id)
    throw new AppError('invalid_value', 'group_id_required', { event });
  assertExtensionTarget(a, input.url);
  if (input.skip_handshake && !isOwnerOrAdmin(access)) throw new AppError('forbidden', 'skip_handshake');
  if (!input.skip_handshake) await handshake(deps, input.url);
  else await assertPublicUrl(input.url, allowPrivateOutbound(deps.env));
  const id = newId();
  const [row] = await db.transaction(async (tx) => {
    const r = await tx
      .insert(webhooks)
      .values({
        id,
        accountId: a.ctx.accountId,
        boardId,
        url: input.url,
        eventType: event,
        config: (input.config ?? {}) as Record<string, never>,
        description: input.description ?? null,
        secret: input.secret ?? newSecret(),
        challengeVerifiedAt: input.skip_handshake ? null : new Date(),
        createdBy: a.user.id,
      })
      .returning();
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'webhook.created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      meta: { webhook_id: id, event, url: input.url },
    });
    return r;
  });
  return dto(row!);
};

export const updateWebhook = async (
  deps: AppDeps,
  a: Actor,
  id: string,
  input: z.infer<typeof updateWebhookSchema>,
) => {
  const { db } = deps;
  // S-54: remote support access (even `edit`) never sets up or changes an outgoing channel — it would outlive the grant.
  assertNotSupport(a);
  const { row, access } = await load(db, a, id);
  const urlChanged = input.url && input.url !== row.url;
  // Turning a channel off or renaming it stays open to whoever manages it; (re)directing or widening it does not.
  if (input.config !== undefined || urlChanged || input.active === true)
    assertContentAccess(a, access, input.config ?? row.config);
  if (urlChanged) assertExtensionTarget(a, input.url!);
  if (input.skip_handshake && !isOwnerOrAdmin(access)) throw new AppError('forbidden', 'skip_handshake');
  if (urlChanged && !input.skip_handshake) await handshake(deps, input.url!);
  // S-102: without the handshake the address is still checked (as on create).
  else if (urlChanged) await assertPublicUrl(input.url!, allowPrivateOutbound(deps.env));
  const [next] = await db
    .update(webhooks)
    .set({
      ...(input.url ? { url: input.url } : {}),
      ...(urlChanged ? { challengeVerifiedAt: input.skip_handshake ? null : new Date() } : {}),
      ...(input.config ? { config: input.config as Record<string, never> } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // Switching back on clears the failure streak and the reason it was switched off.
      ...(input.active !== undefined
        ? { isActive: input.active, ...(input.active ? { failureCount: 0, disabledReason: null } : {}) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(webhooks.id, row.id))
    .returning();
  return dto(next!);
};

export const deleteWebhook = async (db: Db, a: Actor, id: string) => {
  const { row } = await load(db, a, id);
  await db.transaction(async (tx) => {
    await tx.update(webhooks).set({ deletedAt: new Date(), isActive: false }).where(eq(webhooks.id, row.id));
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'webhook.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: row.boardId,
      meta: { webhook_id: row.id },
    });
  });
  return { ok: true as const };
};

export const rotateSecret = async (db: Db, a: Actor, id: string) => {
  assertNotSupport(a);
  const { row } = await load(db, a, id);
  const [next] = await db
    .update(webhooks)
    .set({ secret: newSecret(), updatedAt: new Date() })
    .where(eq(webhooks.id, row.id))
    .returning();
  return dto(next!);
};

const DELIVERIES_PAGE = 50;

export const listDeliveries = async (db: Db, a: Actor, id: string, before?: string) => {
  const { row } = await load(db, a, id);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.webhookId, row.id), before ? lt(webhookDeliveries.id, before) : undefined))
    .orderBy(desc(webhookDeliveries.id))
    .limit(DELIVERIES_PAGE + 1); // one more than the page: `next` only when there really is one (audit B4)
  const page = rows.slice(0, DELIVERIES_PAGE);
  return { data: page.map(deliveryDto), next: rows.length > DELIVERIES_PAGE ? page[page.length - 1]!.id : null };
};

/** Send a delivery again now (any state): a fresh attempt with the same body. */
export const redeliver = async (deps: AppDeps, a: Actor, deliveryId: string) => {
  const { db } = deps;
  const d = (
    await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.accountId, a.ctx.accountId), eq(webhookDeliveries.id, deliveryId)))
      .limit(1)
  )[0];
  if (!d?.webhookId) throw new AppError('not_found', 'Delivery not found');
  await load(db, a, d.webhookId);
  await db
    .update(webhookDeliveries)
    .set({ status: 'pending', attempt: 0, nextAttemptAt: null, error: null })
    .where(eq(webhookDeliveries.id, d.id));

  await deliver(deps, d.id);
  return deliveryDto((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, d.id)))[0]!);
};

/** A synthetic `ping` (06 §4.3) through the normal delivery path. */
export const pingWebhook = async (deps: AppDeps, a: Actor, id: string) => {
  const { db } = deps;
  const { row } = await load(db, a, id);
  const deliveryId = await queueDelivery(deps, {
    accountId: a.ctx.accountId,
    webhookId: row.id,
    eventId: newId(),
    eventType: 'ping',
    requestBody: {
      event: { type: 'ping', webhookId: row.id, boardId: row.boardId, triggerTime: new Date().toISOString() },
    },
  });
  return deliveryDto((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)))[0]!);
};
