// SPDX-License-Identifier: AGPL-3.0-only
import { accountSettingsSchema, AppError, isApiToken, isOauthAccessToken, type AiSettings } from '@bines/shared';
import type { Context } from 'hono';
import { accountTokenBudget, assertIpAllowed, chargeToken } from '../../middleware/auth';
import { chargeApiCall, entitlements, hasFeature } from '../billing/entitlements';
import { cachedSecurity, twoFactorGateBlocks } from '../admin/two-factor.service';
import type { AppDeps, AppEnv, SupportAccess } from '../../types';
import { findAccountById, getAccountSettings } from '../accounts/accounts.repo';
import { resolveAccountAccess, touchSupportSession } from '../support/support.access';
import { loadAiSettings, mayUseMcp } from '../ai/ai.service';
import type { Actor } from '../items/items.service';
import { isOurMcpResource, resolveOauthAccessToken } from '../oauth/oauth.service';
import { resolveToken, tokenLimits } from '../tokens/tokens.service';

/**
 * Who is calling `/mcp` (the planning notes "AGENTS-MCP" §4 "אימות"):
 * - `Authorization: Bearer bos_pat_…` / `bos_svc_…` (מ3) → the token's user in the token's account (D12: a token =
 *   one account; the account never comes from the model), its scopes, its board limit and its rate budget (shared
 *   with the REST API);
 * - an OAuth access token `bos_oat_…` (מ5: Claude.ai, ChatGPT) → its connection: one user in one account, the
 *   consented scopes and boards — accepted only when issued for this server (audience = the `/mcp` resource).
 * Guests never; viewers / members only when the account allows them (perm.mcp).
 */
export type McpPrincipal = {
  actor: Actor;
  scopes: string[];
  /** The API token's id, or the OAuth connection's id (rate budget, the activity log's `mcp.token_id`). */
  tokenId: string;
  /** The token's name / the OAuth app's name — shown in the activity log as the client ("Claude Code", "Claude"…). */
  client: string;
  /** How it authenticated. */
  via: 'token' | 'oauth';
  ai: AiSettings;
  /** In the account by remote support access: `view` = read tools only; every call audited. */
  support: SupportAccess | null;
};

export class McpAuthError extends Error {
  constructor(
    readonly status: 401 | 402 | 403 | 404 | 423 | 429,
    readonly code: string,
    message: string,
    /** 401: whether a token was presented (then `error="invalid_token"` in the challenge). */
    readonly presented = true,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Charged = {
  id: string;
  accountId: string;
  tokenPrefix: string;
  rateLimitPerMinute: number | null;
  dailyQuota: number | null;
};
type TokenUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean | null;
  locale?: string | null;
  timezone?: string | null;
  isService?: boolean | null;
  twoFactorEnabled?: boolean | null;
};

/**
 * The MCP session's person (like a REST token, middleware/auth.ts): their own language and zone; a service identity
 * — or a person with no supported language — reads in the account's language (Settings → Region).
 */
export const mcpSessionUser = async (deps: Pick<AppDeps, 'db'>, accountId: string, user: TokenUser) => {
  const own = user.locale === 'he' || user.locale === 'en' ? user.locale : null;
  const accountLanguage = async () => {
    const parsed = accountSettingsSchema.safeParse(await getAccountSettings(deps.db, accountId));
    return (parsed.success ? parsed.data : accountSettingsSchema.parse({})).locale.language;
  };
  const locale = own && !user.isService ? own : await accountLanguage();
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerified,
    isPlatformOwner: false, // a token never opens the owner console
    locale,
    timezone: user.isService ? null : (user.timezone ?? null), // null = the account's (A3)
    ...(user.isService ? { isService: true } : {}),
  };
};

const resolveBearer = async (deps: AppDeps, bearer: string) => {
  if (isOauthAccessToken(bearer)) {
    const found = await resolveOauthAccessToken(deps.db, bearer);
    if (!found) throw new McpAuthError(401, 'invalid_token', 'Invalid, revoked or expired token');
    // Audience (RFC 8707): a token issued for another resource is refused. One issued on an address the owner still
    // accepts (the current one, WEB_ORIGIN, or a previous one kept during a move — M11) stays valid.
    if (!(await isOurMcpResource(deps, found.resource)))
      throw new McpAuthError(401, 'invalid_token', 'The token was not issued for this server');
    const conn = found.connection;
    const charged: Charged = {
      id: conn.id,
      accountId: conn.accountId,
      // OAuth connections run on the personal token budget of the account / platform (06 §1.10, ANSWERS 6א.9).
      tokenPrefix: 'bos_oat_',
      rateLimitPerMinute: null,
      dailyQuota: null,
    };
    const user: TokenUser = found.user;
    return {
      charged,
      user,
      scopes: conn.scopes,
      boardIds: conn.boardIds,
      client: conn.clientName,
      via: 'oauth' as const,
    };
  }
  if (isApiToken(bearer)) {
    const found = await resolveToken(deps.db, bearer);
    if (!found) throw new McpAuthError(401, 'invalid_token', 'Invalid, revoked or expired token');
    const { t, user } = found;
    return {
      charged: t as Charged,
      user: user as TokenUser,
      scopes: t.scopes,
      boardIds: t.boardIds,
      client: t.name,
      via: 'token' as const,
    };
  }
  throw new McpAuthError(401, 'invalid_token', 'Unknown token');
};

export const authenticateMcp = async (deps: AppDeps, c: Context<AppEnv>): Promise<McpPrincipal> => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!bearer) throw new McpAuthError(401, 'unauthenticated', 'Authorization required', false);
  const { charged: t, user, scopes, boardIds, client, via } = await resolveBearer(deps, bearer);
  try {
    await chargeApiCall(deps.db, t.accountId); // the plan's daily API cap
    chargeToken(c, t, await tokenLimits(deps.db, t), accountTokenBudget(deps.env));
  } catch (err) {
    if (err instanceof AppError) throw new McpAuthError(429, err.code, err.message);
    throw err;
  }
  const [account, membership] = await Promise.all([
    findAccountById(deps.db, t.accountId),
    resolveAccountAccess(deps.db, t.accountId, user.id),
  ]);
  if (!account || !membership) throw new McpAuthError(404, 'not_found', 'Account not found');
  if (membership.kind === 'inactive') throw new McpAuthError(403, 'forbidden', 'Membership is not active');
  if (account.status === 'suspended') throw new McpAuthError(423, 'account_suspended', 'Account is suspended');
  // Plans: a suspended subscription answers nothing; a read-only one runs read tools only (mcp.server)
  // a closed one (plan-lock) answers nothing either — 403 `account_closed`.
  const planStatus = (await entitlements(deps.db, account.id)).status;
  if (planStatus === 'closed') throw new McpAuthError(403, 'account_closed', 'The account is closed');
  if (planStatus === 'suspended')
    throw new McpAuthError(423, 'plan_suspended', 'The account’s subscription is suspended');
  // Plans: the MCP server is the `api` feature.
  if (!(await hasFeature(deps.db, account.id, 'api')))
    throw new McpAuthError(402, 'plan_feature_unavailable', 'The plan does not include: api', true, {
      feature: 'api',
      upgrade: true,
    });
  if (membership.role === 'guest') throw new McpAuthError(403, 'forbidden', 'guests_cannot_use_tokens');
  const sessionUser = await mcpSessionUser(deps, account.id, user);
  // S-26: the account's IP allowlist holds for the MCP server too (a leaked token / OAuth connection elsewhere).
  const security = await cachedSecurity(deps.db, account.id);
  if (security.ip_allowlist.enabled) {
    try {
      await assertIpAllowed(deps.db, c, account.id, sessionUser, security);
    } catch (err) {
      if (err instanceof AppError) throw new McpAuthError(403, 'forbidden', 'ip_not_allowed');
      throw err;
    }
  }
  // S-53: the account's two-factor requirement, checked on every call — an OAuth connection or a token made before
  // the policy (or by someone who never enrolled) stops until its person turns 2FA on.
  if (
    twoFactorGateBlocks(security, membership.role, {
      isService: !!user.isService,
      twoFactorEnabled: !!user.twoFactorEnabled,
    })
  )
    throw new McpAuthError(403, 'forbidden', 'two_factor_required');
  const ai = await loadAiSettings(deps.db, account.id);
  if (!ai.mcp_enabled) throw new McpAuthError(403, 'forbidden', 'mcp_disabled');
  if (!mayUseMcp(ai, membership.role)) throw new McpAuthError(403, 'forbidden', 'mcp_role_not_allowed');
  if (membership.support)
    await touchSupportSession(deps, {
      accountId: account.id,
      user,
      support: membership.support,
      via: 'mcp',
      ip: c.get('clientIp') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
  return {
    actor: {
      ctx: {
        account,
        accountId: account.id,
        role: membership.role,
        membershipId: membership.membershipId,
        boardLimit: boardIds?.length ? boardIds : null,
        tokenScopes: scopes,
        support: membership.support,
      },
      user: sessionUser,
      requestId: c.get('requestId'),
    },
    scopes,
    tokenId: t.id,
    client,
    via,
    ai,
    support: membership.support,
  };
};
