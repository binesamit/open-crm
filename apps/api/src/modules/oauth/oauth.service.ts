// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  type AccountRole,
  AppError,
  groupsOfScopes,
  MCP_OAUTH_SCOPES,
  type McpConnection,
  type McpScopeGroup,
  newId,
  OAUTH_ACCESS_PREFIX,
  OAUTH_ACCESS_TTL_S,
  OAUTH_REFRESH_PREFIX,
  OAUTH_REFRESH_TTL_S,
  type ApproveOauth,
  type OauthRequest,
  scopesOfGroups,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { mcpConnections, oauthClients, oauthGrants, oauthTokens, users } from '../../db/schema';
import { sha256 } from '../../lib/tokens';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { findAccountById, listAccountsOfUser } from '../accounts/accounts.repo';
import { resolveAccountAccess } from '../support/support.access';
import { recordEvent } from '../activity/activity.repo';
import { loadAiSettings, mayUseMcp, mcpUrl } from '../ai/ai.service';
import { apiOrigin, publicAddress } from '../platform/public-address';
import { recordAudit } from '../audit/audit.repo';
import { cachedSecurity, twoFactorGateBlocks } from '../admin/two-factor.service';
import { ssoApplies, ssoSatisfied } from '../admin/sso-policy';
import { accountClosed, closedError, featureError, hasFeature } from '../billing/entitlements';
import { readableBoardIds } from '../boards/boards.access';
import type { Actor } from '../items/items.service';
import {
  authenticateClient,
  clientHost,
  OAuthError,
  type OAuthClient,
  type PresentedClient,
  redirectMatches,
  resolveClient,
} from './oauth.clients';

/**
 * The MCP authorization server (the planning notes "AGENTS-MCP" §4, מ5; MCP authorization spec 2026-07-28): authorization
 * code + PKCE S256 (mandatory, `state` too), the consent screen's decision (one account — D12 — scopes, boards),
 * code exchange, rotating refresh tokens with replay detection, revocation (RFC 7009), and the access token check
 * of `/mcp`. Tokens are bound to the `/mcp` resource (RFC 8707 audience); everything secret is stored hashed.
 *
 * Why our own and not Better Auth's OAuth provider: better-auth 1.7 core ships no OAuth provider / MCP plugin (it
 * moved to a separate package), and what MCP needs here — binding a grant to one account, a board limit, the
 * account's MCP policy, Client ID Metadata Documents through our SSRF guard — is ours anyway. It is small.
 */

type Deps = Pick<AppDeps, 'db' | 'env'>;

const GRANT_TTL_MS = 15 * 60 * 1000; // the consent screen (incl. signing in) has 15 minutes
const CODE_TTL_MS = 2 * 60 * 1000; // a code is exchanged at once
const LAST_USED_EVERY_MS = 5 * 60 * 1000;

/** The issuer = the API's public address (owner console, M11; else WEB_ORIGIN). */
export const issuerOf = (deps: Deps) => apiOrigin(deps);
export const mcpResourceOf = (deps: Deps) => mcpUrl(deps);
export const resourceMetadataUrl = async (deps: Deps) =>
  `${await issuerOf(deps)}/.well-known/oauth-protected-resource/mcp`;

/** RFC 8707 resource comparison: scheme + host (case-insensitive, URL lowercases them) + path, no trailing slash. */
const canonical = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    if (u.hash || raw.includes('#')) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return null;
  }
};
export const sameResource = (a: string, b: string) => {
  const x = canonical(a);
  return !!x && x === canonical(b);
};

/**
 * Is this `/mcp` on one of our addresses — the current one, WEB_ORIGIN or a previous one the owner keeps during a
 * move (M11)? Connections made before the domain changed keep working until the old address is removed.
 */
export const isOurMcpResource = async (deps: Deps, resource: string) =>
  (await publicAddress(deps)).accepted.some((o) => sameResource(resource, `${o}/mcp`));

const secret = (prefix = '') => `${prefix}${randomBytes(32).toString('base64url')}`;
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** The scopes the client asked for, as known scope strings (unknown ones are dropped — RFC 6749 §3.3). */
const parseScope = (raw: string | null | undefined) =>
  [...new Set((raw ?? '').split(/\s+/).filter(Boolean))].filter((s) => (MCP_OAUTH_SCOPES as string[]).includes(s));

const withParams = (base: string, params: Record<string, string | undefined>) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
};

// ---- GET /oauth/authorize ----

export type AuthorizeOutcome =
  /** Shown on our own page — never redirected to an unverified redirect URI. */
  | { kind: 'error_page'; error: string }
  /** Back to the client with error + state + iss. */
  | { kind: 'redirect'; url: string }
  /** On to the consent screen. */
  | { kind: 'consent'; url: string };

export const startAuthorization = async (deps: Deps, q: URLSearchParams): Promise<AuthorizeOutcome> => {
  const { db } = deps;
  const iss = await issuerOf(deps);
  let client: OAuthClient;
  try {
    client = await resolveClient(db, q.get('client_id'));
  } catch (err) {
    if (err instanceof OAuthError) return { kind: 'error_page', error: 'invalid_client' };
    throw err;
  }
  const asked = q.get('redirect_uri');
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
    return { kind: 'error_page', error: 'invalid_redirect_uri' };

  const state = q.get('state');
  // RFC 6749 §4.1.2.1 sends errors to the client's redirect URI — for a verified (CIMD) client. A self-registered
  // (DCR) client's URI is whatever its registrant typed, so a malformed request would make this origin 302 to any
  // page before anyone consented (open redirect, audit 2026-10-10 security #11): those errors stay on our page.
  const fail = (error: string, description: string): AuthorizeOutcome =>
    client.kind === 'dcr'
      ? { kind: 'error_page', error }
      : {
          kind: 'redirect',
          url: withParams(redirectUri, { error, error_description: description, state: state ?? undefined, iss }),
        };
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  const challenge = q.get('code_challenge');
  if (!challenge || q.get('code_challenge_method') !== 'S256')
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail('invalid_request', 'Malformed code_challenge');
  if (!state) return fail('invalid_request', 'state is required');
  if (state.length > 1024) return fail('invalid_request', 'state is too long');
  const ours = await mcpResourceOf(deps);
  const resources = q.getAll('resource');
  if (resources.some((r) => !sameResource(r, ours)))
    return fail('invalid_target', `This server issues tokens only for ${ours}`);

  const id = newId();
  await db.insert(oauthGrants).values({
    id,
    clientPk: client.id,
    redirectUri,
    state,
    codeChallenge: challenge,
    requestedScopes: parseScope(q.get('scope')),
    resource: ours,
    expiresAt: new Date(Date.now() + GRANT_TTL_MS),
  });
  return { kind: 'consent', url: `${iss}/connect?request=${id}` };
};

// ---- the consent screen (session) ----

/**
 * A pending request, bound to the first person who opens it (audit 2026-10-10 #3): the link of a request someone
 * else started is not theirs to approve — a phishing link is answered as expired.
 */
const pendingGrant = async (db: Db, id: string, userId: string) => {
  const load = async () =>
    (
      await db
        .select({ g: oauthGrants, c: oauthClients })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientPk))
        .where(and(eq(oauthGrants.id, id), eq(oauthGrants.status, 'pending'), gt(oauthGrants.expiresAt, new Date())))
        .limit(1)
    )[0];
  let row = await load();
  if (row && !row.g.userId) {
    await db
      .update(oauthGrants)
      .set({ userId })
      .where(and(eq(oauthGrants.id, id), isNull(oauthGrants.userId)));
    row = await load();
  }
  if (!row || row.g.userId !== userId) throw new AppError('not_found', 'oauth_request_expired');
  return row;
};

/** Why this person may not connect an AI app to the account (null = may). */
const mcpRefusal = async (
  db: Db,
  account: { id: string; status: string },
  role: string,
  user: SessionUser,
): Promise<string | null> => {
  if (account.status === 'suspended') return 'account_suspended';
  // plan-lock: a closed account connects no AI app.
  if (await accountClosed(db, account.id)) return 'account_closed';
  if (role === 'guest') return 'guests_cannot_use_tokens';
  const security = await cachedSecurity(db, account.id);
  // S-53: the account's two-factor requirement — a consent is a way in like a sign-in.
  if (twoFactorGateBlocks(security, role as AccountRole, user)) return 'two_factor_required';
  // S-71: and its "sign in through Google / Microsoft" policy — a password session must not mint a lasting grant.
  if (ssoApplies(security.sso, role as AccountRole, user) && !ssoSatisfied(security.sso, user)) return 'sso_required';
  // Plans: OAuth apps (the MCP server) are the plan's `api`.
  if (!(await hasFeature(db, account.id, 'api'))) return 'plan_feature_unavailable';
  const ai = await loadAiSettings(db, account.id);
  if (!ai.mcp_enabled) return 'mcp_disabled';
  if (!mayUseMcp(ai, role as Parameters<typeof mayUseMcp>[1])) return 'mcp_role_not_allowed';
  return null;
};

export const getAuthorizationRequest = async (deps: Deps, user: SessionUser, id: string): Promise<OauthRequest> => {
  const { g, c } = await pendingGrant(deps.db, id, user.id);
  const mine = await listAccountsOfUser(deps.db, user.id);
  const accounts = await Promise.all(
    mine.map(async (a) => {
      const reason = await mcpRefusal(deps.db, a, a.role, user);
      return {
        id: a.id,
        name: a.name,
        slug: a.slug,
        role: a.role,
        allowed: !reason,
        reason,
        read_only: a.role === 'viewer',
      };
    }),
  );
  let redirectHost = '';
  try {
    const u = new URL(g.redirectUri);
    redirectHost = u.host || u.protocol.replace(/:$/, '');
  } catch {
    // validated on the way in
  }
  return {
    id: g.id,
    client: {
      name: c.clientName,
      host: clientHost(c),
      uri: c.clientUri,
      kind: c.kind === 'cimd' ? 'cimd' : 'dcr',
      verified: c.kind === 'cimd',
    },
    redirect_host: redirectHost,
    requested_groups: groupsOfScopes(g.requestedScopes),
    accounts,
    expires_at: g.expiresAt.toISOString(),
  };
};

export const approveAuthorization = async (
  deps: Deps,
  user: SessionUser,
  id: string,
  input: ApproveOauth,
): Promise<{ redirect_to: string }> => {
  const { db } = deps;
  const { g } = await pendingGrant(db, id, user.id);
  const [account, membership] = await Promise.all([
    findAccountById(db, input.account_id),
    resolveAccountAccess(db, input.account_id, user.id),
  ]);
  // Another person's account / an unknown one: the same 404 as everywhere (D12).
  if (!account || !membership || membership.kind === 'inactive') throw new AppError('not_found', 'Account not found');
  const refusal = await mcpRefusal(db, account, membership.role, user);
  if (refusal === 'plan_feature_unavailable') throw featureError('api');
  if (refusal === 'account_closed') throw closedError();
  if (refusal) throw new AppError(refusal === 'account_suspended' ? 'account_suspended' : 'forbidden', refusal);
  const groups: McpScopeGroup[] = [...new Set<McpScopeGroup>(['read', ...input.groups])];
  // Viewers connect read-only (the tools would refuse writes anyway; the grant says so up front).
  // Remote support access in view mode connects read-only too (and only while the grant lasts).
  if ((membership.role === 'viewer' || membership.support?.mode === 'view') && groups.some((x) => x !== 'read'))
    throw new AppError('forbidden', 'viewers_read_only');
  const scopes = scopesOfGroups(groups);
  let boardIds: string[] | null = null;
  if (input.board_ids) {
    const ctx = {
      account,
      accountId: account.id,
      role: membership.role,
      membershipId: membership.membershipId,
      support: membership.support,
    };
    const readable = await readableBoardIds(db, ctx, user, input.board_ids);
    const bad = input.board_ids.filter((b) => !readable.has(b));
    if (bad.length) throw new AppError('invalid_value', 'board_not_found', { board_ids: bad });
    boardIds = [...new Set(input.board_ids)];
  }
  const code = secret();
  const updated = await db
    .update(oauthGrants)
    .set({
      status: 'approved',
      userId: user.id,
      accountId: account.id,
      scopes,
      boardIds,
      codeHash: sha256(code),
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
    })
    .where(and(eq(oauthGrants.id, g.id), eq(oauthGrants.status, 'pending')))
    .returning({ id: oauthGrants.id });
  if (!updated.length) throw new AppError('not_found', 'oauth_request_expired');
  return { redirect_to: withParams(g.redirectUri, { code, state: g.state, iss: await issuerOf(deps) }) };
};

export const denyAuthorization = async (deps: Deps, user: SessionUser, id: string) => {
  const { g } = await pendingGrant(deps.db, id, user.id);
  await deps.db
    .update(oauthGrants)
    .set({ status: 'denied' })
    .where(and(eq(oauthGrants.id, g.id), eq(oauthGrants.status, 'pending')));
  return {
    redirect_to: withParams(g.redirectUri, {
      error: 'access_denied',
      error_description: 'The user denied the request',
      state: g.state,
      iss: await issuerOf(deps),
    }),
  };
};

// ---- POST /oauth/token ----

export type TokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

const issueTokens = async (db: Db, conn: typeof mcpConnections.$inferSelect, resource: string) => {
  const access = secret(OAUTH_ACCESS_PREFIX);
  const refresh = secret(OAUTH_REFRESH_PREFIX);
  const now = Date.now();
  await db.insert(oauthTokens).values([
    {
      id: newId(),
      accountId: conn.accountId,
      connectionId: conn.id,
      kind: 'access',
      tokenHash: sha256(access),
      resource,
      expiresAt: new Date(now + OAUTH_ACCESS_TTL_S * 1000),
    },
    {
      id: newId(),
      accountId: conn.accountId,
      connectionId: conn.id,
      kind: 'refresh',
      tokenHash: sha256(refresh),
      resource,
      expiresAt: new Date(now + OAUTH_REFRESH_TTL_S * 1000),
    },
  ]);
  return {
    access_token: access,
    token_type: 'Bearer' as const,
    expires_in: OAUTH_ACCESS_TTL_S,
    refresh_token: refresh,
    scope: conn.scopes.join(' '),
  };
};

/** Ends a connection: no token of it works any more. `by` null = the client itself / a replay. */
const revokeConnection = async (
  db: Db,
  conn: typeof mcpConnections.$inferSelect,
  by: string | null,
  reason: 'user' | 'admin' | 'client' | 'replay' | 'replaced',
  meta?: RequestMeta,
) => {
  const now = new Date();
  await db.transaction(async (tx) => {
    const done = await tx
      .update(mcpConnections)
      .set({ revokedAt: now, revokedBy: by })
      .where(and(eq(mcpConnections.id, conn.id), isNull(mcpConnections.revokedAt)))
      .returning({ id: mcpConnections.id });
    await tx
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.connectionId, conn.id), isNull(oauthTokens.revokedAt)));
    if (!done.length) return;
    await recordEvent(tx, {
      accountId: conn.accountId,
      type: 'mcp.disconnected',
      actorId: by ?? conn.userId,
      requestId: meta?.requestId ?? null,
      meta: { connection_id: conn.id, client: conn.clientName, reason },
    });
    await recordAudit(tx, {
      accountId: conn.accountId,
      actorId: by,
      action: reason === 'replay' ? 'mcp.token_replay' : 'mcp.disconnected',
      targetType: 'mcp_connection',
      targetId: conn.id,
      payload: { client: conn.clientName, owner_id: conn.userId, reason },
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
  });
};

const findConnection = async (db: Db, id: string | null) =>
  id ? (await db.select().from(mcpConnections).where(eq(mcpConnections.id, id)).limit(1))[0] : undefined;

const checkResource = async (deps: Deps, form: URLSearchParams, granted: string) => {
  for (const r of form.getAll('resource'))
    if (!sameResource(r, granted) || !(await isOurMcpResource(deps, r)))
      throw new OAuthError('invalid_target', 'The resource does not match the grant');
};

export const exchangeCode = async (
  deps: Deps,
  form: URLSearchParams,
  presented: PresentedClient,
  meta: RequestMeta,
): Promise<TokenResponse> => {
  const { db } = deps;
  const client = await authenticateClient(db, presented);
  const code = form.get('code');
  const verifier = form.get('code_verifier');
  if (!code) throw new OAuthError('invalid_request', 'code is required');
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
    throw new OAuthError('invalid_request', 'A valid code_verifier is required (PKCE)');
  const g = (
    await db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.codeHash, sha256(code)))
      .limit(1)
  )[0];
  if (!g) throw new OAuthError('invalid_grant', 'Invalid authorization code');
  if (g.status === 'used') {
    // A code used twice: someone else may hold it — whatever it produced stops working (OAuth 2.1 §4.1.3).
    const conn = await findConnection(db, g.connectionId);
    if (conn) await revokeConnection(db, conn, null, 'replay', meta);
    throw new OAuthError('invalid_grant', 'Authorization code already used');
  }
  if (g.status !== 'approved' || !g.codeExpiresAt || g.codeExpiresAt < new Date())
    throw new OAuthError('invalid_grant', 'Authorization code expired');
  if (g.clientPk !== client.id) throw new OAuthError('invalid_grant', 'The code was issued to another client');
  const redirectUri = form.get('redirect_uri');
  if (redirectUri !== null && redirectUri !== g.redirectUri)
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
  if (s256(verifier) !== g.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE verification failed');
  await checkResource(deps, form, g.resource);
  if (!g.userId || !g.accountId || !g.scopes) throw new OAuthError('invalid_grant', 'Invalid authorization code');

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(oauthGrants)
      .set({ status: 'used' })
      .where(and(eq(oauthGrants.id, g.id), eq(oauthGrants.status, 'approved')))
      .returning({ id: oauthGrants.id });
    if (!claimed.length) throw new OAuthError('invalid_grant', 'Authorization code already used');
    // Connecting the same app to the same account again replaces the old connection (one row per app there).
    const previous = await tx
      .select()
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.accountId, g.accountId!),
          eq(mcpConnections.userId, g.userId!),
          eq(mcpConnections.clientPk, client.id),
          isNull(mcpConnections.revokedAt),
        ),
      );
    for (const p of previous) await revokeConnection(tx, p, g.userId, 'replaced', meta);
    const [conn] = await tx
      .insert(mcpConnections)
      .values({
        id: newId(),
        accountId: g.accountId!,
        userId: g.userId!,
        clientPk: client.id,
        clientName: client.clientName,
        scopes: g.scopes!,
        boardIds: g.boardIds?.length ? g.boardIds : null,
      })
      .returning();
    await tx.update(oauthGrants).set({ connectionId: conn!.id }).where(eq(oauthGrants.id, g.id));
    await recordEvent(tx, {
      accountId: conn!.accountId,
      type: 'mcp.connected',
      actorId: conn!.userId,
      requestId: meta.requestId,
      meta: { connection_id: conn!.id, client: conn!.clientName, scopes: conn!.scopes },
    });
    await recordAudit(tx, {
      accountId: conn!.accountId,
      actorId: conn!.userId,
      action: 'mcp.connected',
      targetType: 'mcp_connection',
      targetId: conn!.id,
      payload: {
        client: conn!.clientName,
        client_host: clientHost(client),
        scopes: conn!.scopes,
        board_ids: conn!.boardIds,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return issueTokens(tx, conn!, g.resource);
  });
};

export const refreshTokens = async (
  deps: Deps,
  form: URLSearchParams,
  presented: PresentedClient,
  meta: RequestMeta,
): Promise<TokenResponse> => {
  const { db } = deps;
  const client = await authenticateClient(db, presented);
  const raw = form.get('refresh_token');
  if (!raw) throw new OAuthError('invalid_request', 'refresh_token is required');
  const row = (
    await db
      .select({ t: oauthTokens, conn: mcpConnections })
      .from(oauthTokens)
      .innerJoin(mcpConnections, eq(mcpConnections.id, oauthTokens.connectionId))
      .where(and(eq(oauthTokens.tokenHash, sha256(raw)), eq(oauthTokens.kind, 'refresh')))
      .limit(1)
  )[0];
  if (!row || row.conn.clientPk !== client.id) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  const { t, conn } = row;
  if (t.usedAt && !conn.revokedAt) {
    // A rotated refresh token came back: it leaked, or the client is confused — end the connection.
    await revokeConnection(db, conn, null, 'replay', meta);
    throw new OAuthError('invalid_grant', 'Refresh token already used');
  }
  if (t.revokedAt || conn.revokedAt || t.expiresAt < new Date())
    throw new OAuthError('invalid_grant', 'Refresh token revoked or expired');
  await checkResource(deps, form, t.resource);
  const asked = form.get('scope');
  if (
    asked &&
    asked
      .split(/\s+/)
      .filter(Boolean)
      .some((s) => !conn.scopes.includes(s))
  )
    throw new OAuthError('invalid_scope', 'A refresh cannot add scopes — connect again');
  return db.transaction(async (tx) => {
    const rotated = await tx
      .update(oauthTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthTokens.id, t.id), isNull(oauthTokens.usedAt)))
      .returning({ id: oauthTokens.id });
    if (!rotated.length) throw new OAuthError('invalid_grant', 'Refresh token already used');
    return issueTokens(tx, conn, t.resource);
  });
};

// ---- POST /oauth/revoke (RFC 7009) ----

export const revokeOauthToken = async (
  deps: Deps,
  form: URLSearchParams,
  presented: PresentedClient,
  meta: RequestMeta,
) => {
  const { db } = deps;
  const client = await authenticateClient(db, presented);
  const raw = form.get('token');
  if (!raw) throw new OAuthError('invalid_request', 'token is required');
  const row = (
    await db
      .select({ t: oauthTokens, conn: mcpConnections })
      .from(oauthTokens)
      .innerJoin(mcpConnections, eq(mcpConnections.id, oauthTokens.connectionId))
      .where(eq(oauthTokens.tokenHash, sha256(raw)))
      .limit(1)
  )[0];
  // Unknown tokens and other clients' tokens: 200 all the same (RFC 7009 §2.2), nothing revealed.
  if (!row || row.conn.clientPk !== client.id) return;
  if (row.t.kind === 'refresh') await revokeConnection(db, row.conn, null, 'client', meta);
  else await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.id, row.t.id));
};

// ---- /mcp: the access token check ----

export type ResolvedOauthToken = {
  connection: typeof mcpConnections.$inferSelect;
  user: typeof users.$inferSelect;
  resource: string;
};

/** A presented access token → its live connection and user; null = unknown, expired or revoked. */
export const resolveOauthAccessToken = async (db: Db, raw: string, now = new Date()) => {
  const row = (
    await db
      .select({ t: oauthTokens, connection: mcpConnections, user: users })
      .from(oauthTokens)
      .innerJoin(mcpConnections, eq(mcpConnections.id, oauthTokens.connectionId))
      .innerJoin(users, eq(users.id, mcpConnections.userId))
      .where(
        and(
          eq(oauthTokens.tokenHash, sha256(raw)),
          eq(oauthTokens.kind, 'access'),
          isNull(oauthTokens.revokedAt),
          isNull(mcpConnections.revokedAt),
          gt(oauthTokens.expiresAt, now),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  const c = row.connection;
  if (!c.lastUsedAt || now.getTime() - c.lastUsedAt.getTime() > LAST_USED_EVERY_MS)
    void db
      .update(mcpConnections)
      .set({ lastUsedAt: now })
      .where(
        and(eq(mcpConnections.id, c.id), or(isNull(mcpConnections.lastUsedAt), lt(mcpConnections.lastUsedAt, now))),
      )
      .catch(() => undefined);
  return { connection: c, user: row.user, resource: row.t.resource } satisfies ResolvedOauthToken;
};

// ---- connected apps (profile → API tokens, Administration) ----

const assertNotGuest = (a: Actor) => {
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'guests_cannot_use_tokens');
};

export const listMcpConnections = async (db: Db, a: Actor, all = false): Promise<{ data: McpConnection[] }> => {
  assertNotGuest(a);
  if (all && a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  const rows = await db
    .select({ c: mcpConnections, client: oauthClients, userName: users.name })
    .from(mcpConnections)
    .innerJoin(oauthClients, eq(oauthClients.id, mcpConnections.clientPk))
    .leftJoin(users, eq(users.id, mcpConnections.userId))
    .where(
      and(
        eq(mcpConnections.accountId, a.ctx.accountId),
        isNull(mcpConnections.revokedAt),
        all ? undefined : eq(mcpConnections.userId, a.user.id),
      ),
    )
    .orderBy(desc(mcpConnections.createdAt));
  return {
    data: rows.map(({ c, client, userName }) => ({
      id: c.id,
      client_name: c.clientName,
      client_host: clientHost(client),
      user_id: c.userId,
      user_name: userName,
      scopes: c.scopes,
      board_ids: c.boardIds?.length ? c.boardIds : null,
      last_used_at: c.lastUsedAt?.toISOString() ?? null,
      created_at: c.createdAt.toISOString(),
    })),
  };
};

/** Disconnect an AI app: my own, or anyone's in the account for an admin. Its tokens stop working at once. */
export const disconnectMcp = async (db: Db, a: Actor, id: string, meta: RequestMeta) => {
  const conn = (
    await db
      .select()
      .from(mcpConnections)
      .where(
        and(eq(mcpConnections.accountId, a.ctx.accountId), eq(mcpConnections.id, id), isNull(mcpConnections.revokedAt)),
      )
      .limit(1)
  )[0];
  if (!conn || (conn.userId !== a.user.id && a.ctx.role !== 'admin'))
    throw new AppError('not_found', 'Connection not found');
  await revokeConnection(db, conn, a.user.id, conn.userId === a.user.id ? 'user' : 'admin', meta);
  return { ok: true as const };
};

/** Housekeeping: authorization requests long past their time (called opportunistically, cheap). */
export const purgeOldGrants = (db: Db) =>
  db
    .delete(oauthGrants)
    .where(
      and(
        lt(oauthGrants.expiresAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        inArray(oauthGrants.status, ['pending', 'denied', 'approved']),
      ),
    );
