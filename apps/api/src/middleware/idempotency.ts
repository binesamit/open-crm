// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { ACCOUNT_HEADER, AppError, isId } from '@bines/shared';
import type { Db } from '../db/client';
import { idempotencyKeys } from '../db/schema';
import type { AppDeps, AppEnv } from '../types';

/**
 * `Idempotency-Key` (06 §1.9) on POST / PUT / PATCH / DELETE: the first request runs and its answer is kept 24 h
 * per caller (token or user); a replay gets that answer again (`Idempotent-Replayed: true`) instead of doing it
 * twice — what Make / n8n need when they retry after a timeout. The same key with another request → 409.
 * Answers below 500 are kept (a rejected request replays its 4xx, like Stripe); a 5xx or a crash frees the key.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

/**
 * S-86: answers that carry a secret (a revealed / copied secret value or secret update, a new API token, a collab
 * token, a sign-in link) are never kept — the key table would hold them in plaintext for 24 h, and a replay would
 * skip the route's own checks (step-up, rate limit, audit). These run as if no key was sent.
 */
const SENSITIVE_PATH =
  /\/secret(\/|$)|\/secrets(\/|$)|\/updates\/[^/]+\/(reveal|secret-copy)$|tokens(\/|$)|collab-token|recovery|sign-in-link|two-factor|\/platform\/licenses|\/files\/presign/i;

export const idempotency = ({ db }: Pick<AppDeps, 'db'>) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const key = c.req.header('idempotency-key')?.trim();
    const user = c.get('user');
    if (!key || !MUTATING.has(c.req.method) || !user) return next();
    if (SENSITIVE_PATH.test(c.req.path)) return next();
    if (key.length > 128) throw new AppError('bad_request', 'Idempotency-Key is at most 128 characters');
    const token = c.get('token');
    // The header is read before `requireAccount` validates it: a malformed value is not keyed on (it would hit the
    // key table's varchar(26) and 500 — audit 2026-10-10 security #20); the route itself still answers it.
    const accountId = token?.accountId ?? c.req.header(ACCOUNT_HEADER);
    if (!accountId || !isId(accountId)) return next(); // unscoped routes: nothing to key on
    const principalId = token?.id ?? user.id;
    const body = await c.req.text();
    const requestHash = createHash('sha256').update(`${c.req.method} ${c.req.path}\n${body}`).digest('hex');
    const where = and(
      eq(idempotencyKeys.accountId, accountId),
      eq(idempotencyKeys.principalId, principalId),
      eq(idempotencyKeys.key, key),
    );

    const claim = () =>
      db
        .insert(idempotencyKeys)
        .values({ key, accountId, principalId, requestHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
    let fresh = await claim();
    if (!fresh.length) {
      const prev = (await db.select().from(idempotencyKeys).where(where).limit(1))[0];
      if (prev && Date.now() - prev.createdAt.getTime() > IDEMPOTENCY_TTL_MS) {
        // Expired (not yet purged): forget it and run as new.
        await db.delete(idempotencyKeys).where(where);
        fresh = await claim();
      }
    }
    if (!fresh.length) {
      const prev = (await db.select().from(idempotencyKeys).where(where).limit(1))[0];
      if (prev?.requestHash !== requestHash)
        throw new AppError('idempotency_conflict', 'This Idempotency-Key was used for another request');
      if (prev.responseStatus === null)
        throw new AppError('idempotency_in_progress', 'The first request is still running');
      c.header('Idempotent-Replayed', 'true');
      return c.json(prev.responseBody as object, prev.responseStatus as 200);
    }

    try {
      await next();
    } catch (e) {
      await db.delete(idempotencyKeys).where(where); // a failed request may be tried again
      throw e;
    }
    const res = c.res;
    const json = res.headers.get('content-type')?.includes('application/json');
    // A route that marks its answer no-store (S-86) is not kept either.
    if (res.status >= 500 || !json || /no-store/i.test(res.headers.get('cache-control') ?? '')) {
      await db.delete(idempotencyKeys).where(where);
      return;
    }
    const stored = await res
      .clone()
      .json()
      .catch(() => null);
    await db.update(idempotencyKeys).set({ responseStatus: res.status, responseBody: stored }).where(where);
  });

/** Hourly: keys older than 24 h go. */
export const purgeIdempotencyKeys = (db: Db, now = new Date()) =>
  db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)));
