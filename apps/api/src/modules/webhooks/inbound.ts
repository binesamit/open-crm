// SPDX-License-Identifier: AGPL-3.0-only
import { timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { AppError, recipeSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { automations, cells, columns, items } from '../../db/schema';
import { ipBucket } from '../../lib/client-ip';
import { RateLimiter } from '../../lib/rate-limit';
import { recordEvent } from '../activity/activity.repo';
import { assertAccountOpen } from '../billing/entitlements';

/**
 * Inbound webhook trigger (04 §2 `webhook_in`): `POST /hooks/in/:automationId` — no session; the automation's
 * secret in the `X-Bines-Secret` header is required (S-11: never in the URL, where proxies log it). 60 accepted
 * calls a minute per automation; failed attempts (unknown id, bad or missing secret) are limited too — per client
 * address only (S-57: a per-automation limit let anyone who knew the URL lock out the real caller; the secret is
 * 24 random bytes, so spreading guesses over many addresses gains nothing). The JSON body becomes `{payload.*}`;
 * `item_lookup` finds the item the call is about (by id, or by a column's text).
 */
const limiter = new RateLimiter(60, 60_000);
/** Failed attempts: 20 per client address, 10 minutes. */
const failuresByIp = new RateLimiter(20, 10 * 60_000);
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const at = (obj: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const receiveInbound = async (
  db: Db,
  automationId: string,
  payload: unknown,
  secret: string | undefined,
  clientIp: string | null = null,
) => {
  const ipKey = ipBucket(clientIp);
  const blocked = failuresByIp.peek(ipKey);
  if (blocked > 0) throw new AppError('rate_limited', 'Too many failed attempts', { retry_after_ms: blocked });
  const fail = (code: 'not_found' | 'unauthenticated', message: string): never => {
    failuresByIp.hit(ipKey);
    throw new AppError(code, message);
  };
  const a = (
    await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, automationId), isNull(automations.deletedAt)))
      .limit(1)
  )[0];
  const recipe = a ? recipeSchema.safeParse(a.recipe) : null;
  const trigger = recipe?.success ? recipe.data.trigger : null;
  // Unknown, switched off or not an inbound trigger: all the same 404 (nothing to probe).
  if (!a?.boardId || !a.isActive || trigger?.type !== 'webhook_in') return fail('not_found', 'Not found');
  // An automation saved before secrets were required has none: it stays shut until it is saved again (a secret
  // is generated then), rather than open to anyone who learns its id.
  if (!trigger.secret) return fail('unauthenticated', 'secret_required');
  if (!(secret && sameSecret(secret, trigger.secret))) return fail('unauthenticated', 'Bad secret');
  const wait = limiter.hit(a.id);
  if (wait > 0) throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: wait });
  // plan-lock: a closed account takes nothing in (403 account_closed; the automation is kept).
  await assertAccountOpen(db, a.accountId);

  let itemId: string | null = null;
  if (trigger.item_lookup) {
    const want = at(payload, trigger.item_lookup.path);
    if (want !== undefined && want !== null && String(want).trim()) {
      const text = String(want).trim();
      if (trigger.item_lookup.column === 'id') {
        const hit = (
          await db
            .select({ id: items.id })
            .from(items)
            .where(and(eq(items.id, text), eq(items.boardId, a.boardId), isNull(items.deletedAt)))
            .limit(1)
        )[0];
        itemId = hit?.id ?? null;
      } else {
        const col = (
          await db
            .select({ id: columns.id })
            .from(columns)
            .where(and(eq(columns.boardId, a.boardId), eq(columns.key, trigger.item_lookup.column)))
            .limit(1)
        )[0];
        const hit = col
          ? (
              await db
                .select({ id: cells.itemId })
                .from(cells)
                .innerJoin(items, and(eq(items.id, cells.itemId), isNull(items.deletedAt)))
                .where(and(eq(cells.columnId, col.id), eq(cells.textValue, text)))
                .limit(1)
            )[0]
          : undefined;
        itemId = hit?.id ?? null;
      }
    }
  }
  const eventId = await recordEvent(db, {
    accountId: a.accountId,
    type: 'webhook_in.received',
    actorId: null,
    actorType: 'system',
    boardId: a.boardId,
    itemId,
    meta: { automation_id: a.id, payload: payload as Record<string, unknown> },
  });
  return { event_id: eventId, item_id: itemId };
};
