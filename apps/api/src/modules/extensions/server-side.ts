// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  AppError,
  EXT_CLIENT_ID_PREFIX,
  EXT_CLIENT_SECRET_PREFIX,
  EXT_SERVER_TOKEN_PREFIX,
  EXT_SERVER_TOKEN_TTL_S,
  type ExtensionManifest,
  type LifecycleEvent,
  newId,
  scopeAllows,
} from '@bines/shared';
import type { Context } from 'hono';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  extensionInstallations,
  extensionServerTokens,
  users,
  webhooks,
} from '../../db/schema';
import type { ActivityScope } from '../../lib/activity-scope';
import { allowPrivateOutbound, outboundRequest } from '../../lib/outbound';
import { RateLimiter } from '../../lib/rate-limit';
import { requiredScope } from '../../lib/scopes';
import type { SecretBox } from '../../lib/secrets';
import { sha256 } from '../../lib/tokens';
import type { AppDeps, AppEnv } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { OAuthError, type PresentedClient } from '../oauth/oauth.clients';
import { newSigningSecret, signExtBody } from './ext-signing';
import { assertExtensionRequest, liveInstallation } from './ext-token';
import { findInstallationById, type InstallationRow, updateInstallationRow, userBasics } from './extensions.repo';
import { accountLocale, st } from '../../lib/i18n';
import { apiOrigin } from '../platform/public-address';
import { recordError } from '../errors/errors.writer';
import { scopeBoardIds, scopeWorkspaceIds } from './scope';

/**
 * An extension's own server (D27 ת6, MARKETPLACE §4.3) — "the extension acts as its own service user, never more":
 *
 * - **Service user**: installing a manifest with `server` adds an `is_service` member "תוסף: <name>" to the account
 *   (like an agent's, D26). What its server may do = that member's rights × the granted scopes × the granted boards ×
 *   the extension path allowlist — checked on every request against the installation as it is now.
 * - **OAuth** (the MCP authorization server of מ5, `/oauth/token`): the installation is a confidential client;
 *   `grant_type=client_credentials` with its client id + secret gives an hour-long `bos_xat_…` token. Only hashes
 *   are stored.
 * - **Lifecycle webhooks** (installed / updated / enabled / disabled / uninstalled) go to `server.lifecycle_url`
 *   through the SSRF-safe outbound helper, signed like every webhook (`x-bines-signature`, HMAC-SHA256 over
 *   `<timestamp>.<body>`). `installed` carries the credentials — the server proves them by trading them for a token.
 *   Uninstalling revokes every token, the credentials and the service user's membership.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets'>;

/** The platform's API address (the OAuth issuer, oauth.service `issuerOf`; owner console M11, else WEB_ORIGIN). */
const issuerOf = (deps: Pick<AppDeps, 'db' | 'env'>) => apiOrigin(deps);

const random = (prefix: string, bytes = 32) => `${prefix}${randomBytes(bytes).toString('base64url')}`;

export type ServerCredentials = { clientId: string; clientSecret: string; signingSecret: string };

const sealedFields = (secrets: SecretBox, creds: ServerCredentials) => ({
  serverClientId: creds.clientId,
  serverSecretHash: sha256(creds.clientSecret),
  signingSecret: secrets.seal(creds.signingSecret),
});

const newCredentials = (): ServerCredentials => ({
  clientId: random(EXT_CLIENT_ID_PREFIX, 18),
  clientSecret: random(EXT_CLIENT_SECRET_PREFIX),
  signingSecret: newSigningSecret(),
});

/**
 * Gives an installation its server identity (in the install / approve transaction): the service user (reused and
 * reactivated on a reinstall) and fresh credentials. The plain secrets are returned once, for the `installed` call.
 */
export const provisionServer = async (
  tx: Db,
  secrets: SecretBox,
  row: Pick<InstallationRow, 'id' | 'accountId' | 'serviceUserId'>,
  m: ExtensionManifest,
  actorId: string,
): Promise<ServerCredentials> => {
  let userId = row.serviceUserId;
  const lang = await accountLocale(tx, row.accountId);
  if (userId) {
    await tx
      .update(accountMembers)
      .set({ status: 'active' })
      .where(and(eq(accountMembers.accountId, row.accountId), eq(accountMembers.userId, userId)));
    await tx
      .update(users)
      .set({ name: st('server.extensionUser', { name: m.name }, lang).slice(0, 120) })
      .where(eq(users.id, userId));
  } else {
    userId = newId();
    await tx.insert(users).values({
      id: userId,
      email: `ext-${userId.toLowerCase()}@extensions.bines.invalid`,
      name: st('server.extensionUser', { name: m.name }, lang).slice(0, 120),
      isService: true,
    });
    await tx.insert(accountMembers).values({
      id: newId(),
      accountId: row.accountId,
      userId,
      role: 'member',
      status: 'active',
      invitedBy: actorId,
      joinedAt: new Date(),
    });
  }
  const creds = newCredentials();
  await revokeServerTokens(tx, row.id);
  await updateInstallationRow(tx, row.id, {
    serviceUserId: userId,
    ...sealedFields(secrets, creds),
    serverStatus: 'pending',
    serverError: null,
  });
  return creds;
};

export const revokeServerTokens = (db: Db, installationId: string) =>
  db
    .update(extensionServerTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(extensionServerTokens.installationId, installationId), isNull(extensionServerTokens.revokedAt)));

/**
 * Uninstall / a version without a server: no token, no credentials, the service user leaves the account. The signing
 * secret stays (it also signs the automation calls, ת4) — uninstalling clears it (extensions.service).
 */
export const deprovisionServer = async (tx: Db, row: Pick<InstallationRow, 'id' | 'accountId' | 'serviceUserId'>) => {
  await revokeServerTokens(tx, row.id);
  // the webhooks its server set up stop with it.
  if (row.serviceUserId)
    await tx
      .update(webhooks)
      .set({ isActive: false })
      .where(and(eq(webhooks.accountId, row.accountId), eq(webhooks.createdBy, row.serviceUserId)));
  if (row.serviceUserId)
    await tx
      .update(accountMembers)
      .set({ status: 'deactivated' })
      .where(and(eq(accountMembers.accountId, row.accountId), eq(accountMembers.userId, row.serviceUserId)));
  await updateInstallationRow(tx, row.id, {
    serverClientId: null,
    serverSecretHash: null,
    serverStatus: null,
  });
};

// ---- lifecycle webhooks ----

export const LIFECYCLE_TIMEOUT_MS = 10_000;

export type LifecycleCall = {
  event: LifecycleEvent;
  /** Sign with this secret (the uninstall call is made after the row lost it). */
  signingSecret: string;
  credentials?: ServerCredentials;
  reason?: string;
  previousVersion?: string;
};

/**
 * One lifecycle call (best effort, after the change is committed — never undoes it): the outcome is kept on the
 * installation ("connected" / "failed" + why), shown to admins, who can send `installed` again.
 */
export const sendLifecycle = async (
  deps: Deps,
  row: InstallationRow,
  m: ExtensionManifest,
  call: LifecycleCall,
): Promise<'connected' | 'failed' | 'skipped'> => {
  if (!m.server) return 'skipped';
  const { db, env } = deps;
  const account = (
    await db
      .select({ id: accounts.id, name: accounts.name, slug: accounts.slug })
      .from(accounts)
      .where(eq(accounts.id, row.accountId))
      .limit(1)
  )[0];
  const issuer = await issuerOf(deps);
  const deliveryId = newId();
  const payload = {
    event: call.event,
    delivery_id: deliveryId,
    sent_at: new Date().toISOString(),
    platform: issuer,
    account: account ? { id: account.id, name: account.name, slug: account.slug } : { id: row.accountId },
    installation: {
      id: row.id,
      key: row.key,
      version: row.version,
      ...(call.previousVersion ? { previous_version: call.previousVersion } : {}),
      status: row.uninstalledAt ? 'uninstalled' : row.status,
      scopes: row.grantedScopes,
      board_ids: row.boardIds ?? null,
      workspace_ids: scopeWorkspaceIds(row),
    },
    ...(call.reason ? { reason: call.reason } : {}),
    ...(call.credentials
      ? {
          credentials: {
            client_id: call.credentials.clientId,
            client_secret: call.credentials.clientSecret,
            signing_secret: call.credentials.signingSecret,
            token_endpoint: `${issuer}/oauth/token`,
            api_base: `${issuer}/api/v1`,
          },
        }
      : {}),
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  let error: string | null = null;
  try {
    const res = await outboundRequest(m.server.lifecycle_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'BinesOS-Extensions/1',
        'x-bines-event': `extension.${call.event}`,
        'x-bines-delivery': deliveryId,
        'x-bines-timestamp': timestamp,
        'x-bines-signature': signExtBody(call.signingSecret, timestamp, body),
      },
      body,
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
      allowPrivate: allowPrivateOutbound(env),
      maxBytes: 2000,
    });
    if (!res.ok) error = `http_${res.status}`;
  } catch (err) {
    error =
      err instanceof AppError
        ? err.message
        : ((err as Error).name === 'TimeoutError' ? 'timeout' : (err as Error).message || 'unreachable').slice(0, 200);
  }
  // The row may be gone from the account's view (uninstalled): the status is still kept for the audit trail.
  await updateInstallationRow(db, row.id, {
    serverStatus: error ? 'failed' : 'connected',
    serverError: error,
    serverEvent: call.event,
    serverEventAt: new Date(),
  }).catch(() => undefined);
  // Errors hub: the extension's server did not take the lifecycle call.
  if (error)
    recordError(db, {
      source: 'extension',
      code: /^[a-z][a-z0-9_]{2,60}$/.test(error) ? error : 'extension_lifecycle_failed',
      message: `lifecycle ${call.event}: ${error}`,
      accountId: row.accountId,
      links: { installation_id: row.id },
    });
  if (error)
    await recordAudit(db, {
      accountId: row.accountId,
      actorId: null,
      action: 'extension.lifecycle_failed',
      targetType: 'extension',
      targetId: row.id,
      payload: { key: row.key, event: call.event, error },
    }).catch(() => undefined);
  return error ? 'failed' : 'connected';
};

/** Rotates the credentials (old tokens stop) and sends `installed` again — "connect the server again". */
export const rotateServerCredentials = async (deps: Deps, row: InstallationRow, m: ExtensionManifest) => {
  const creds = newCredentials();
  await deps.db.transaction(async (tx) => {
    await revokeServerTokens(tx, row.id);
    await updateInstallationRow(tx, row.id, { ...sealedFields(deps.secrets, creds), serverStatus: 'pending' });
  });
  const fresh = (await findInstallationById(deps.db, row.id))!;
  return sendLifecycle(deps, fresh, m, { event: 'installed', signingSecret: creds.signingSecret, credentials: creds });
};

// ---- the token endpoint: client_credentials ----

const sameHash = (presented: string, hash: string) => {
  const a = Buffer.from(sha256(presented), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Tokens an installation may get per hour (a server asks again about once an hour; this is a runaway guard). */
const tokenIssueLimiter = new RateLimiter(60, 60 * 60_000);

export type ExtensionTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  installation_id: string;
  account_id: string;
  api_base: string;
};

/**
 * `POST /oauth/token` with `grant_type=client_credentials` and an extension's client id: an access token for its
 * server. Confidential clients only (Basic or post); the installation must be live (enabled, not killed); `scope`
 * may narrow the grant, never widen it; `resource`, when sent, must be this API (RFC 8707).
 */
export const exchangeExtensionClientCredentials = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  form: URLSearchParams,
  presented: PresentedClient,
  meta: { ip: string | null; userAgent: string | null },
): Promise<ExtensionTokenResponse> => {
  const { db } = deps;
  const clientId = presented.clientId;
  if (!clientId || !clientId.startsWith(EXT_CLIENT_ID_PREFIX) || clientId.length > 64 || !presented.secret)
    throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  const row = (
    await db.select().from(extensionInstallations).where(eq(extensionInstallations.serverClientId, clientId)).limit(1)
  )[0];
  if (!row?.serverSecretHash || !sameHash(presented.secret, row.serverSecretHash))
    throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  const live = await liveInstallation(db, row.id, row.accountId);
  if (!live || !live.manifest.server || !row.serviceUserId)
    throw new OAuthError('unauthorized_client', 'This extension is not active in the account');
  const api = `${await issuerOf(deps)}/api/v1`;
  for (const r of form.getAll('resource'))
    if (r.replace(/\/+$/, '') !== api)
      throw new OAuthError('invalid_target', `This client gets tokens only for ${api}`);
  const asked = (form.get('scope') ?? '').split(/\s+/).filter(Boolean);
  const extra = asked.filter((s) => !row.grantedScopes.includes(s));
  if (extra.length) throw new OAuthError('invalid_scope', `Not granted: ${extra.join(' ')}`);
  const scopes = asked.length ? [...new Set(asked)] : row.grantedScopes;
  const wait = tokenIssueLimiter.hit(row.id);
  if (wait > 0) throw new OAuthError('temporarily_unavailable', 'Too many tokens for this extension', 429);
  const token = random(EXT_SERVER_TOKEN_PREFIX);
  await db.insert(extensionServerTokens).values({
    id: newId(),
    accountId: row.accountId,
    installationId: row.id,
    tokenHash: sha256(token),
    // EXT-RT16: a narrower `scope` is what the token may do (null = the grant as it is at each request).
    scopes: asked.length ? scopes : null,
    expiresAt: new Date(Date.now() + EXT_SERVER_TOKEN_TTL_S * 1000),
  });
  // The first token after `installed` proves the server holds the credentials.
  if (row.serverStatus !== 'connected')
    await updateInstallationRow(db, row.id, { serverStatus: 'connected', serverError: null });
  await recordAudit(db, {
    accountId: row.accountId,
    actorId: row.serviceUserId,
    action: 'extension.server_token',
    targetType: 'extension',
    targetId: row.id,
    payload: { key: row.key, scopes },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: EXT_SERVER_TOKEN_TTL_S,
    scope: scopes.join(' '),
    installation_id: row.id,
    account_id: row.accountId,
    api_base: api,
  };
};

// ---- a request with a server token ----

/** Requests per installation's server per minute. */
export const EXT_SERVER_RATE = 600;
const perServer = new RateLimiter(EXT_SERVER_RATE, 60_000);

/**
 * `Authorization: Bearer bos_xat_…` (loadSession): the token's installation must be live; the request runs as its
 * service user, with the granted scopes as they are now (∩ the scope the token asked for), the granted boards
 * and the extension path allowlist. Writes are stamped "via app X (server)", one batch per request.
 */
export const extensionServerTokenAuth = async (
  c: Context<AppEnv>,
  deps: Pick<AppDeps, 'db'>,
  raw: string,
): Promise<ActivityScope> => {
  const { db } = deps;
  if (!raw.startsWith(EXT_SERVER_TOKEN_PREFIX) || raw.length > 200)
    throw new AppError('unauthenticated', 'Invalid or expired extension token');
  const t = (
    await db
      .select()
      .from(extensionServerTokens)
      .where(
        and(
          eq(extensionServerTokens.tokenHash, sha256(raw)),
          isNull(extensionServerTokens.revokedAt),
          gt(extensionServerTokens.expiresAt, new Date()),
        ),
      )
      .limit(1)
  )[0];
  if (!t) throw new AppError('unauthenticated', 'Invalid or expired extension token');
  const live = await liveInstallation(db, t.installationId, t.accountId);
  if (!live || !live.manifest.server || !live.row.serviceUserId)
    throw new AppError('unauthenticated', 'This extension is not active');
  const { row, manifest } = live;
  const path = await assertExtensionRequest(c, row.accountId, { server: true });
  // EXT-RT16: the grant as it is now, narrowed to what the token asked for.
  const scopes = t.scopes ? row.grantedScopes.filter((x) => t.scopes!.includes(x)) : row.grantedScopes;
  const need = requiredScope(c.req.method, path);
  if ('forbidden' in need) throw new AppError('forbidden', 'not_for_extensions');
  if (need.scope !== 'any' && !scopeAllows(scopes, need.scope))
    throw new AppError('insufficient_scope', `This extension lacks the "${need.scope}" scope`, {
      required: need.scope,
    });
  const r = perServer.take(row.id, EXT_SERVER_RATE);
  if (r.waitMs > 0) {
    c.header('Retry-After', String(Math.ceil(r.waitMs / 1000)));
    throw new AppError('rate_limited', 'Too many requests from this extension', { retry_after_ms: r.waitMs });
  }
  const user = await userBasics(db, row.serviceUserId!);
  if (!user || !user.isService) throw new AppError('unauthenticated', 'This extension is not active');
  c.set('token', {
    id: `extsrv:${row.id}`,
    accountId: row.accountId,
    scopes,
    ratePerMinute: EXT_SERVER_RATE,
    // EXT-RT11: the granted list as it is (an empty list is no board, never "every board"); chosen workspaces add
    // their boards as they are now.
    boardIds: await scopeBoardIds(db, row),
    ext: { installationId: row.id, key: row.key, allowGuests: false, server: { origins: manifest.origins } },
  });
  c.set('user', {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: false,
    isPlatformOwner: false,
    locale: user.locale,
    timezone: user.timezone,
    isService: true,
  });
  return {
    batchId: newId(),
    meta: { via: 'app', app: { key: row.key, name: manifest.name, installation_id: row.id, server: true } },
  };
};
