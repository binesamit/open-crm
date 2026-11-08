// SPDX-License-Identifier: AGPL-3.0-only
import { assertDeletionAllows } from '../modules/account-deletion/deletion-lock';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  type AccountSecurity,
  ACCOUNT_HEADER,
  ACCOUNT_QUERY,
  AppError,
  isApiToken,
  isExtensionServerToken,
  isExtensionToken,
  isId,
  isOauthAccessToken,
  scopeAllows,
} from '@bines/shared';
import { ipInRanges } from '../lib/ip-allowlist';
import { RateLimiter } from '../lib/rate-limit';
import { assertTwoFactorGate, cachedSecurity } from '../modules/admin/two-factor.service';
import { assertSsoGate } from '../modules/admin/sso-policy';
import { recordAudit } from '../modules/audit/audit.repo';
import { requiredScope } from '../lib/scopes';
import { findAccountById } from '../modules/accounts/accounts.repo';
import {
  assertSupportRequest,
  auditSupportRequest,
  ipExempt,
  isReadRequest,
  resolveAccountAccess,
  touchSupportSession,
} from '../modules/support/support.access';
import { assertFeature, assertPlanStatusAllows, chargeApiCall } from '../modules/billing/entitlements';
import { assertRouteFeature } from '../modules/billing/feature-gates';
import { resolveToken, tokenLimits } from '../modules/tokens/tokens.service';
import { findStaffRoleOf } from '../modules/tickets/tickets.repo';
import { loadPlatformSettings } from '../modules/platform/platform-settings';
import { extensionTokenAuth } from '../modules/extensions/ext-token';
import { extensionServerTokenAuth } from '../modules/extensions/server-side';
import { currentActivityScope, runInActivityScope, tokenLimitStamp } from '../lib/activity-scope';
import type { Actor, AppDeps, AppEnv, RequestMeta, SessionUser } from '../types';

/**
 * Per-token request budget (06 §1.10), in this process: its rate per minute and its daily quota. The numbers are
 * settings (ANSWERS 6א.9): the token's own, else the account's, else the platform's (`tokenLimits`). The limiter's
 * constructor limit is only a fallback; every `take` passes the token's limit.
 */
const tokenLimiter = new RateLimiter(600, 60_000);
const tokenDayLimiter = new RateLimiter(10_000, 86_400_000);

/**
 * Counts one request against a token's budget (06 §1.10): its daily quota and its per-minute rate, with the
 * RateLimit-* headers. Shared by the REST API and the MCP server (`/mcp`), so both draw from one budget.
 */
export const chargeToken = (
  c: { header: (name: string, value: string) => void },
  t: { id: string; accountId: string },
  limits: { per_minute: number; daily: number },
  perAccount: { limiter: RateLimiter; limit: number } | null = null,
) => {
  const day = tokenDayLimiter.take(t.id, limits.daily);
  if (day.waitMs > 0) {
    c.header('Retry-After', String(Math.ceil(day.waitMs / 1000)));
    throw new AppError('rate_limited', 'Daily quota used up', { retry_after_ms: day.waitMs, quota: 'day' });
  }
  // All the account's tokens together (06 §1.10): many tokens cannot multiply one account's share of the server.
  if (perAccount) {
    const acc = perAccount.limiter.take(t.accountId, perAccount.limit);
    if (acc.waitMs > 0) {
      c.header('Retry-After', String(Math.ceil(acc.waitMs / 1000)));
      throw new AppError('rate_limited', 'Too many requests for this account', {
        retry_after_ms: acc.waitMs,
        quota: 'account',
      });
    }
  }
  const rate = tokenLimiter.take(t.id, limits.per_minute);
  c.header('RateLimit-Policy', `${limits.per_minute};w=60, ${limits.daily};w=86400`);
  c.header('RateLimit-Limit', String(limits.per_minute));
  c.header('RateLimit-Remaining', String(Math.max(0, rate.remaining)));
  c.header('RateLimit-Reset', String(Math.ceil(rate.resetMs / 1000)));
  if (rate.waitMs > 0) {
    c.header('Retry-After', String(Math.ceil(rate.waitMs / 1000)));
    throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: rate.waitMs });
  }
};

/**
 * API token (06 §1.2): `Authorization: Bearer bos_pat_…` → the token's user, bound to its account, limited to its
 * scopes (06 §1.3) and its rate. A bad token is a 401 — never a silent anonymous request.
 */
const tokenAuth = async (
  c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0],
  db: AppDeps['db'],
  raw: string,
  perAccount: { limiter: RateLimiter; limit: number } | null,
) => {
  const found = await resolveToken(db, raw);
  if (!found) throw new AppError('unauthenticated', 'Invalid, revoked or expired token');
  const { t, user } = found;
  const need = requiredScope(c.req.method, c.req.path.replace(/^\/api\/v1/, ''));
  if ('forbidden' in need) throw new AppError('forbidden', 'not_with_a_token');
  if (need.scope !== 'any' && !scopeAllows(t.scopes, need.scope))
    throw new AppError('insufficient_scope', `This token lacks the "${need.scope}" scope`, { required: need.scope });
  // Plans: API tokens are the `api` feature — a plan without it stops them (they are kept).
  await assertFeature(db, t.accountId, 'api');
  const limits = await tokenLimits(db, t);
  // Plans: the plan's daily cap on all the account's API calls together (before the token's own quota
  // which the plan also caps, so running out of the plan says so).
  await chargeApiCall(db, t.accountId);
  chargeToken(c, t, limits, perAccount);
  c.set('token', {
    id: t.id,
    accountId: t.accountId,
    scopes: t.scopes,
    ratePerMinute: limits.per_minute,
    boardIds: t.boardIds?.length ? t.boardIds : null,
  });
  c.set('user', {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerified,
    isPlatformOwner: false, // a token never opens the owner console
    // The token's person reads in their own language and zone (A3); a service identity reads in the account's.
    locale: user.locale,
    timezone: user.timezone,
    // S-53: the account's two-factor requirement holds for the token's person too (requireAccount).
    twoFactorEnabled: !!user.twoFactorEnabled,
    ...(user.isService ? { isService: true } : {}),
  });
};

const accountBudgets = new WeakMap<object, { limiter: RateLimiter; limit: number } | null>();
/**
 * The per-account token budget (06 §1.10) of one app: one limiter shared by the REST API and the MCP server (S-27),
 * so tokens cannot get more of the account's share by going through `/mcp`.
 */
export const accountTokenBudget = (env: Pick<AppDeps['env'], 'RATE_LIMIT_ACCOUNT_PER_MIN'>) => {
  if (!accountBudgets.has(env)) {
    const limit = env.RATE_LIMIT_ACCOUNT_PER_MIN;
    accountBudgets.set(env, limit > 0 ? { limiter: new RateLimiter(limit, 60_000), limit } : null);
  }
  return accountBudgets.get(env)!;
};

/** Loads the Better Auth session (or an API token) into `c.var.user`. Only a bad token throws. */
export const loadSession = ({ auth, db, env }: Pick<AppDeps, 'auth' | 'db' | 'env'>) => {
  const perAccount = accountTokenBudget(env);
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('token', null);
    c.set('db', db);
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    // An OAuth access token's audience is the MCP server alone (RFC 8707, מ5): never the REST API.
    if (bearer && isOauthAccessToken(bearer))
      throw new AppError('unauthenticated', 'This token is for the MCP server only');
    if (bearer && isApiToken(bearer)) {
      await tokenAuth(c, db, bearer, perAccount);
      return next();
    }
    // An extension's short-lived token (D27 ת2): its writes are stamped "via app X", one batch per request.
    if (bearer && isExtensionToken(bearer)) {
      const scope = await extensionTokenAuth(c, { db, env }, bearer);
      return runInActivityScope(scope, () => next());
    }
    // An extension server's token (ת6, OAuth client_credentials): it acts as the installation's service user.
    if (bearer && isExtensionServerToken(bearer)) {
      const scope = await extensionServerTokenAuth(c, { db }, bearer);
      return runInActivityScope(scope, () => next());
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    const u = session?.user as (SessionUser & Record<string, unknown>) | undefined;
    // The sign-in session (PWA): a phone's push subscription ends with it.
    c.set('sessionId', (session?.session as { id?: string } | undefined)?.id ?? null);
    c.set(
      'user',
      u
        ? {
            id: u.id,
            email: u.email,
            name: u.name,
            emailVerified: !!u.emailVerified,
            isPlatformOwner: !!u.isPlatformOwner,
            locale: (u.locale as string) ?? 'he',
            timezone: (u.timezone as string | null | undefined) ?? null,
            twoFactorEnabled: !!u.twoFactorEnabled,
            signInMethod:
              ((session?.session as { signInMethod?: string | null } | undefined)?.signInMethod as string | null) ??
              null,
            signInOrg: (session?.session as { signInOrg?: string | null } | undefined)?.signInOrg ?? null,
          }
        : null,
    );
    await next();
  });
};

export const requireUser = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get('user')) throw new AppError('unauthenticated', 'Sign in required');
    await next();
  });

/**
 * S-77 (owner console → Platform settings → Security, optional, off by default): when on, the platform owner and
 * support staff open the console only with two-factor sign-in on — 403 console_two_factor_required until they turn
 * it on (their profile, outside the console). Checked after who they are is known, so everyone else still gets 404.
 */
export const assertConsoleTwoFactor = async (db: AppDeps['db'], user: SessionUser) => {
  if (user.twoFactorEnabled) return;
  if ((await loadPlatformSettings(db)).security.console_two_factor)
    throw new AppError('forbidden', 'console_two_factor_required');
};

/** The owner console answers 404 to everyone else, so it does not advertise itself (D12). */
export const requirePlatformOwner = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user?.isPlatformOwner) throw new AppError('not_found', 'Route not found');
    const db = c.get('db');
    // Fail closed: every console route runs after loadSession, which sets it.
    if (!db) throw new AppError('internal', 'requirePlatformOwner needs loadSession');
    await assertConsoleTwoFactor(db, user);
    await next();
  });

/**
 * The owner console's Support section: the platform owner, or an active support person (agent / lead
 * by their verified address) — who opens nothing else of the console (`requirePlatformOwner` stays owner-only) and
 * no account's data without a grant. 404 to everyone else, and never with a token.
 */
export const requireSupportConsole = ({ db }: Pick<AppDeps, 'db'>) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user || c.get('token')) throw new AppError('not_found', 'Route not found');
    const role = user.isPlatformOwner ? 'owner' : (await findStaffRoleOf(db, user.id))?.role;
    if (!role) throw new AppError('not_found', 'Route not found');
    await assertConsoleTwoFactor(db, user);
    c.set('supportRole', role === 'owner' ? 'owner' : role === 'lead' ? 'lead' : 'agent');
    await next();
  });

/**
 * Account scoping (D12, 06 §1.1): X-Account-Id + an active membership of the session user — or an active remote
 * support grant (as an admin, reads only in view mode, every request audited).
 * Unknown account / no membership → 404 (no existence leak); deactivated → 403; suspended → 423.
 * `query`: SSE routes also take `?account_id=` — EventSource cannot send headers.
 */
export const requireAccount = (
  deps: Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>,
  opts: { query?: boolean } = {},
) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { db } = deps;
    const user = c.get('user');
    if (!user) throw new AppError('unauthenticated', 'Sign in required');
    const token = c.get('token');
    const asked = c.req.header(ACCOUNT_HEADER) ?? (opts.query ? c.req.query(ACCOUNT_QUERY) : undefined);
    // A token is bound to its account (D12): the header may repeat it, never name another.
    if (token && asked && asked !== token.accountId) throw new AppError('not_found', 'Account not found');
    const accountId = asked ?? token?.accountId;
    if (!accountId) throw new AppError('bad_request', `${ACCOUNT_HEADER} header is required`);
    if (!isId(accountId)) throw new AppError('not_found', 'Account not found');

    const [account, access] = await Promise.all([
      findAccountById(db, accountId),
      resolveAccountAccess(db, accountId, user.id),
    ]);
    if (!account || !access) throw new AppError('not_found', 'Account not found');
    if (access.kind === 'inactive') throw new AppError('forbidden', 'Membership is not active');
    if (account.status === 'suspended') throw new AppError('account_suspended', 'Account is suspended');
    // Guests never use API tokens (a token made before this rule, or after a role change, stops working).
    if (token && access.role === 'guest' && !token.ext?.allowGuests)
      throw new AppError('forbidden', 'guests_cannot_use_tokens');
    // M8 ד12: the account's IP allowlist (the real client address, S-10) and its two-factor requirement.
    const security = await cachedSecurity(db, accountId);
    if (security.ip_allowlist.enabled) await assertIpAllowed(db, c, accountId, user, security);
    // S-53: a personal token acts as its person, so it is held to the requirement too (service identities are not
    // people; an extension's token is minted from a session that already passed it).
    if (!token?.ext) assertTwoFactorGate(security, access.role, user);
    // Plan: an account that requires Google / Microsoft sign-in (sessions only; support access is the
    // operator's own).
    if (!token && !access.support) assertSsoGate(security, access.role, user);
    // Plans: a read-only subscription takes reads only; a suspended one only its admins' "My plan"; a
    // closed one (plan-lock) only its plan and support tickets, and nothing at all with a token.
    const scopedPath = c.req.path.replace(/^\/api\/v1/, '');
    if (account.deletionDueAt) {
      // scheduled for deletion — only its deletion screen's requests (and support) answer.
      assertDeletionAllows({ dueAt: account.deletionDueAt, method: c.req.method, path: scopedPath, token: !!token });
    } else {
      await assertPlanStatusAllows(db, {
        accountId,
        role: access.role,
        method: c.req.method,
        path: scopedPath,
        isRead: isReadRequest(c.req.method, scopedPath),
        token: !!token,
      });
      // Plans: creating / editing / using a feature the plan does not include → 402.
      await assertRouteFeature(db, accountId, c.req.method, scopedPath);
    }

    c.set('account', {
      account,
      accountId,
      role: access.role,
      membershipId: access.membershipId,
      boardLimit: token?.boardIds ?? null,
      tokenScopes: token?.scopes ?? null,
      support: access.support,
      extServer:
        token?.ext?.server && user
          ? { installationId: token.ext.installationId, userId: user.id, origins: token.ext.server.origins }
          : null,
    });
    // S-64: a narrowed token's events say so — what they start later (an AI column's auto-run) keeps its limits.
    const stamp = tokenLimitStamp(token?.boardIds, token?.scopes);
    const go = () => {
      if (!Object.keys(stamp).length) return next();
      const outer = currentActivityScope();
      return runInActivityScope({ ...outer, meta: { ...outer?.meta, ...stamp } }, () => next());
    };
    if (!access.support) return go();

    // Remote support access: the mode decides what may run; everything is audited.
    const support = access.support;
    const path = c.req.path.replace(/^\/api\/v1/, '');
    const meta = { ip: c.get('clientIp') ?? null, userAgent: c.req.header('user-agent') ?? null };
    const audit = { accountId, user, support, via: 'rest' as const, ...meta };
    let kind: 'read' | 'write';
    try {
      kind = assertSupportRequest(support, c.req.method, path);
    } catch (err) {
      await auditSupportRequest(db, {
        ...audit,
        kind: 'refused',
        detail: { method: c.req.method, path, code: err instanceof AppError ? err.code : 'error' },
      });
      throw err;
    }
    await touchSupportSession(deps, audit);
    await go();
    await auditSupportRequest(db, {
      ...audit,
      kind,
      detail: { method: c.req.method, path, status: c.res.status },
      key: `${c.req.method} ${path}`,
    });
  });

/** One `security.ip_blocked` audit row per person and address per 10 minutes (a refused page retries a lot). */
const blockedAudits = new RateLimiter(1, 10 * 60_000);

/**
 * The IP allowlist (M8 ד12): only from these addresses. Exempt: the people the account's admins chose, and the
 * platform owner while the owner console says so (default on — the way back in when an account locks itself out
 * by an address that changed). Everyone else gets 403 ip_not_allowed.
 */
export const assertIpAllowed = async (
  db: AppDeps['db'],
  c: Context<AppEnv>,
  accountId: string,
  user: SessionUser,
  security: AccountSecurity,
) => {
  const ip = c.get('clientIp') ?? null;
  if (ipInRanges(ip, security.ip_allowlist.ranges) || (await ipExempt(db, user, security))) return;
  if (blockedAudits.hit(`${accountId}:${user.id}:${ip ?? '-'}`) === 0)
    await recordAudit(db, {
      accountId,
      actorId: user.isService ? null : user.id,
      action: 'security.ip_blocked',
      targetType: 'user',
      targetId: user.id,
      payload: { ip, path: c.req.path, token: !!c.get('token') },
      ip,
      userAgent: c.req.header('user-agent') ?? null,
    });
  throw new AppError('forbidden', 'ip_not_allowed');
};

export const requestMeta = (c: Context<AppEnv>): RequestMeta => ({
  ip: c.get('clientIp') ?? null, // lib/client-ip.ts: trusted proxy config, never the client's own header (S-10)
  userAgent: c.req.header('user-agent') ?? null,
  requestId: c.get('requestId'),
});

export const currentUser = (c: Context<AppEnv>): SessionUser => {
  const user = c.get('user');
  if (!user) throw new AppError('unauthenticated', 'Sign in required');
  return user;
};

/** The request's service actor (`Actor`, types.ts): its account context, signed-in user and request id. */
export const actorOf = (c: Context<AppEnv>): Actor => ({
  ctx: c.get('account'),
  user: currentUser(c),
  requestId: c.get('requestId'),
  sessionId: c.get('sessionId') ?? null,
  token: c.get('token') ?? null,
});
