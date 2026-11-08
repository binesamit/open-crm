// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import {
  accountApiLimitsSchema,
  type AccountApiLimits,
  ADMIN_ONLY_SCOPES,
  AppError,
  effectiveTokenLimits,
  type PlatformApiLimits,
  type UpdateTokenLimits,
  newId,
  SERVICE_TOKEN_PREFIX,
  TOKEN_PREFIX,
  type ApiToken,
  type CreatedToken,
  type createServiceTokenSchema,
  type createTokenSchema,
  secretSettingsOf,
  SECRET_TOKEN_STEP_UP_MINUTES,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { accountMembers, apiTokens, users } from '../../db/schema';
import type { Actor } from '../items/items.service';
import { assertFreshCode } from '../secrets/step-up';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { readableBoardIds } from '../boards/boards.access';
import { getAccountSettings } from '../accounts/accounts.repo';
import { accountLocale, st } from '../../lib/i18n';
import { loadPlatformSettings } from '../platform/platform-settings';
import { planApiDailyCap } from '../billing/entitlements';

/** API tokens (06 §1.2): only the SHA-256 is stored; the token itself is shown once, on creation. */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const randomToken = (prefix = TOKEN_PREFIX) => {
  const bytes = randomBytes(40);
  let out = '';
  for (const b of bytes) out += BASE62[b % 62];
  return `${prefix}${out}`;
};
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

type Row = typeof apiTokens.$inferSelect & { userName?: string | null; service?: boolean };

/**
 * API budgets (ANSWERS 6א.9): the platform's defaults (owner console) <- the account's overrides (Administration ->
 * API) <- the token's own. Read on every token request, so the account's part is cached briefly in this process.
 */
const LIMITS_CACHE_MS = 30_000;
const limitsCache = new Map<string, { at: number; value: AccountApiLimits }>();

export const cachedAccountApiLimits = async (db: Db, accountId: string): Promise<AccountApiLimits> => {
  const hit = limitsCache.get(accountId);
  if (hit && Date.now() - hit.at < LIMITS_CACHE_MS) return hit.value;
  const raw = (await getAccountSettings(db, accountId)) as { api_limits?: unknown };
  const parsed = accountApiLimitsSchema.safeParse(raw.api_limits ?? {});
  const value = parsed.success ? parsed.data : {};
  limitsCache.set(accountId, { at: Date.now(), value });
  return value;
};

/** Called when an account's API budgets change in this process. */
export const forgetApiLimits = (accountId: string) => limitsCache.delete(accountId);

type Budgets = { account: AccountApiLimits; platform: PlatformApiLimits };
const budgetsOf = async (db: Db, accountId: string): Promise<Budgets> => ({
  account: await cachedAccountApiLimits(db, accountId),
  platform: (await loadPlatformSettings(db)).api_limits,
});

const limitsOf = (r: Pick<Row, 'tokenPrefix' | 'rateLimitPerMinute' | 'dailyQuota'>, b: Budgets) =>
  effectiveTokenLimits({
    service: r.tokenPrefix.startsWith(SERVICE_TOKEN_PREFIX),
    token: { rate_limit_per_minute: r.rateLimitPerMinute ?? null, daily_quota: r.dailyQuota ?? null },
    account: b.account,
    platform: b.platform,
  });

/** The budgets a presented token runs with now (middleware / MCP). */
export const tokenLimits = async (
  db: Db,
  t: Pick<Row, 'accountId' | 'tokenPrefix' | 'rateLimitPerMinute' | 'dailyQuota'>,
) => {
  const limits = limitsOf(t, await budgetsOf(db, t.accountId));
  // Plans: the plan's daily API cap is an upper bound of every token's own daily quota.
  const cap = await planApiDailyCap(db, t.accountId);
  return cap === null ? limits : { ...limits, daily: Math.max(1, Math.min(limits.daily, cap)) };
};

const dto = (r: Row, b: Budgets): ApiToken => {
  const limits = limitsOf(r, b);
  return {
    id: r.id,
    name: r.name,
    prefix: r.tokenPrefix,
    scopes: r.scopes,
    user_id: r.userId,
    user_name: r.userName ?? null,
    service: r.tokenPrefix.startsWith(SERVICE_TOKEN_PREFIX),
    rate_limit_per_minute: r.rateLimitPerMinute ?? null,
    daily_quota: r.dailyQuota ?? null,
    limits: {
      per_minute: limits.per_minute,
      daily: limits.daily,
      default_per_minute: limits.inherited.per_minute,
      default_daily: limits.inherited.daily,
    },
    board_ids: r.boardIds?.length ? r.boardIds : null,
    last_used_at: r.lastUsedAt?.toISOString() ?? null,
    expires_at: r.expiresAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
};

/**
 * A token's own budgets: within the platform's bounds (zod); above what the account gives its tokens only for an
 * admin - a member may lower their token's budget, never raise it past the account's.
 */
const assertOwnLimits = (
  a: Actor,
  service: boolean,
  input: { rate_limit_per_minute?: number | null; daily_quota?: number | null },
  b: Budgets,
) => {
  if (a.ctx.role === 'admin') return;
  const inherited = effectiveTokenLimits({
    service,
    token: { rate_limit_per_minute: null, daily_quota: null },
    account: b.account,
    platform: b.platform,
  }).inherited;
  if (input.rate_limit_per_minute != null && input.rate_limit_per_minute > inherited.per_minute)
    throw new AppError('forbidden', 'token_limit_above_account', { max: inherited.per_minute });
  if (input.daily_quota != null && input.daily_quota > inherited.daily)
    throw new AppError('forbidden', 'token_limit_above_account', { max: inherited.daily });
};

const live = (now: Date) =>
  and(isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)));

/** Tokens in this account: mine, or every member's for an admin (`all`). */
/** Guests have only their own profile: no API tokens at all (product fix list). */
const assertNotGuest = (a: Actor) => {
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'guests_cannot_use_tokens');
};

export const listTokens = async (db: Db, a: Actor, all = false) => {
  assertNotGuest(a);
  // Remote support (even in view mode) never sees the account's tokens — names, prefixes, scopes, owners
  // (audit 2026-10-10 security #15); the route is on support's never-list too.
  if (a.ctx.support) throw new AppError('forbidden', 'not_for_support');
  if (all && a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  const rows = await db
    .select({ t: apiTokens, userName: users.name })
    .from(apiTokens)
    .leftJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.accountId, a.ctx.accountId),
        live(new Date()),
        all ? undefined : eq(apiTokens.userId, a.user.id),
      ),
    )
    .orderBy(desc(apiTokens.createdAt));
  const b = await budgetsOf(db, a.ctx.accountId);
  return { data: rows.map((r) => dto({ ...r.t, userName: r.userName }, b)) };
};

/** S-85: how fresh the two-factor code must be to mint a `secrets:read` token (shared with the web dialog). */
export { SECRET_TOKEN_STEP_UP_MINUTES };

export const createToken = async (
  db: Db,
  a: Actor & { sessionId?: string | null },
  input: z.infer<typeof createTokenSchema>,
): Promise<CreatedToken> => {
  // Viewers and guests cannot create tokens; admin-level scopes only for admins.
  assertNotGuest(a);
  if (a.ctx.role === 'viewer') throw new AppError('forbidden', 'viewers_cannot_create_tokens');
  if (a.ctx.role !== 'admin' && input.scopes.some((s) => ADMIN_ONLY_SCOPES.includes(s)))
    throw new AppError('forbidden', 'admin_scope');
  // S-85: `secrets:read` stands in for the secret step-up (a fresh 2FA code) — so minting it takes one, or a stolen
  // session (without the code) would mint its way around the step-up.
  if (input.scopes.includes('secrets:read')) {
    if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
    await assertFreshCode(
      db,
      { ctx: a.ctx, user: a.user, sessionId: a.sessionId ?? null },
      secretSettingsOf({ verify_minutes: SECRET_TOKEN_STEP_UP_MINUTES }),
    );
  }
  // Board limit: boards the user can read now (a token never widens what its user sees).
  if (input.board_ids) {
    const readable = await readableBoardIds(db, a.ctx, a.user, input.board_ids);
    const bad = input.board_ids.filter((id) => !readable.has(id));
    if (bad.length) throw new AppError('invalid_value', 'board_not_found', { board_ids: bad });
  }
  const b = await budgetsOf(db, a.ctx.accountId);
  assertOwnLimits(a, false, input, b);
  const token = randomToken();
  const id = newId();
  const expiresAt = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000) : null;
  const [row] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(apiTokens)
      .values({
        id,
        accountId: a.ctx.accountId,
        userId: a.user.id,
        name: input.name,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 12),
        scopes: [...new Set(input.scopes)],
        boardIds: input.board_ids ? [...new Set(input.board_ids)] : null,
        rateLimitPerMinute: input.rate_limit_per_minute ?? null,
        dailyQuota: input.daily_quota ?? null,
        expiresAt,
        createdBy: a.user.id,
      })
      .returning();
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'token.created',
      actorId: a.user.id,
      requestId: a.requestId,
      meta: { token_id: id, name: input.name, scopes: input.scopes },
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'token.created',
      targetType: 'token',
      targetId: id,
      payload: { name: input.name, scopes: input.scopes, service: false },
    });
    return inserted;
  });
  return { ...dto({ ...row!, userName: a.user.name }, b), token };
};

/** Revoke: my own token, or any in the account for an admin. */
export const revokeToken = async (db: Db, a: Actor, id: string) => {
  const row = (
    await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.accountId, a.ctx.accountId), eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .limit(1)
  )[0];
  if (!row || (row.userId !== a.user.id && a.ctx.role !== 'admin')) throw new AppError('not_found', 'Token not found');
  await db.transaction(async (tx) => {
    await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'token.revoked',
      actorId: a.user.id,
      requestId: a.requestId,
      meta: { token_id: id, name: row.name },
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'token.revoked',
      targetType: 'token',
      targetId: id,
      payload: { name: row.name, owner_id: row.userId },
    });
  });
  return { ok: true as const };
};

/**
 * PATCH /tokens/{id}: the token's own budgets (null = back to the account's). Its owner (within the account's
 * budgets) or an admin (within the platform's bounds).
 */
export const updateTokenLimits = async (db: Db, a: Actor, id: string, input: UpdateTokenLimits) => {
  assertNotGuest(a);
  const row = (
    await db
      .select({ t: apiTokens, userName: users.name })
      .from(apiTokens)
      .leftJoin(users, eq(users.id, apiTokens.userId))
      .where(and(eq(apiTokens.accountId, a.ctx.accountId), eq(apiTokens.id, id), live(new Date())))
      .limit(1)
  )[0];
  if (!row || (row.t.userId !== a.user.id && a.ctx.role !== 'admin'))
    throw new AppError('not_found', 'Token not found');
  const b = await budgetsOf(db, a.ctx.accountId);
  assertOwnLimits(a, row.t.tokenPrefix.startsWith(SERVICE_TOKEN_PREFIX), input, b);
  const set: Partial<typeof apiTokens.$inferInsert> = {};
  if (input.rate_limit_per_minute !== undefined) set.rateLimitPerMinute = input.rate_limit_per_minute;
  if (input.daily_quota !== undefined) set.dailyQuota = input.daily_quota;
  if (!Object.keys(set).length) return dto({ ...row.t, userName: row.userName }, b);
  const [updated] = await db.transaction(async (tx) => {
    const out = await tx.update(apiTokens).set(set).where(eq(apiTokens.id, id)).returning();
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'token.limits_changed',
      targetType: 'token',
      targetId: id,
      payload: {
        before: { rate_limit_per_minute: row.t.rateLimitPerMinute, daily_quota: row.t.dailyQuota },
        after: input,
      },
    });
    return out;
  });
  return dto({ ...updated!, userName: row.userName }, b);
};

/** Resolves a presented token (middleware); null = unknown, revoked or expired. */
export const resolveToken = async (db: Db, token: string, now = new Date()) => {
  const row = (
    await db
      .select({ t: apiTokens, user: users })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(and(eq(apiTokens.tokenHash, hashToken(token)), live(now)))
      .limit(1)
  )[0];
  if (!row) return null;
  // last_used_at at most once every 5 minutes (no write per request).
  if (!row.t.lastUsedAt || now.getTime() - row.t.lastUsedAt.getTime() > 5 * 60_000)
    void db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(and(eq(apiTokens.id, row.t.id), or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, now))))
      .catch(() => undefined);
  return row;
};

/**
 * A service token (06 §1.2), admins only: a service member "שירות: <name>" joins the account with the chosen role
 * (it never signs in — no password, an address nobody receives), and the token acts as it. Activity shows the
 * service, not a person.
 */
export const createServiceToken = async (
  db: Db,
  a: Actor,
  input: z.infer<typeof createServiceTokenSchema>,
): Promise<CreatedToken> => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  // The boards a service token is limited to must be the account's (and readable), as for a personal token
  // (audit 2026-10-10 security #27 — they were stored as typed).
  if (input.board_ids) {
    const readable = await readableBoardIds(db, a.ctx, a.user, input.board_ids);
    const bad = input.board_ids.filter((id) => !readable.has(id));
    if (bad.length) throw new AppError('invalid_value', 'board_not_found', { board_ids: bad });
  }
  const userId = newId();
  const b = await budgetsOf(db, a.ctx.accountId);
  const name = st('server.serviceUser', { name: input.name }, await accountLocale(db, a.ctx.accountId)).slice(0, 120);
  const token = randomToken(SERVICE_TOKEN_PREFIX);
  const id = newId();
  const expiresAt = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000) : null;
  const [row] = await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email: `svc-${userId.toLowerCase()}@service.bines.invalid`,
      name,
      isService: true,
    });
    await tx.insert(accountMembers).values({
      id: newId(),
      accountId: a.ctx.accountId,
      userId,
      role: input.role,
      status: 'active',
      invitedBy: a.user.id,
      joinedAt: new Date(),
    });
    const inserted = await tx
      .insert(apiTokens)
      .values({
        id,
        accountId: a.ctx.accountId,
        userId,
        name: input.name,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 12),
        scopes: [...new Set(input.scopes)],
        boardIds: input.board_ids ? [...new Set(input.board_ids)] : null,
        // Null = the account's / platform's service-token budget (06 §1.10, ANSWERS 6א.9).
        rateLimitPerMinute: input.rate_limit_per_minute ?? null,
        dailyQuota: input.daily_quota ?? null,
        expiresAt,
        createdBy: a.user.id,
      })
      .returning();
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'token.created',
      actorId: a.user.id,
      requestId: a.requestId,
      meta: { token_id: id, name: input.name, scopes: input.scopes, service_user_id: userId, role: input.role },
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'token.created',
      targetType: 'token',
      targetId: id,
      payload: { name: input.name, scopes: input.scopes, service: true, role: input.role },
    });
    return inserted;
  });
  return { ...dto({ ...row!, userName: name }, b), token };
};
