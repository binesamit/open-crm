// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  approveOauthSchema,
  isExtensionClientId,
  MCP_OAUTH_SCOPES,
  MCP_SCOPE_GROUPS,
  mcpConnectionSchema,
  oauthDecisionSchema,
  oauthRequestSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { currentUser, requestMeta, requireAccount, requireUser, actorOf } from '../../middleware/auth';
import { ipBucket } from '../../lib/client-ip';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import { RateLimiter } from '../../lib/rate-limit';
import type { AppDeps, AppEnv } from '../../types';
import { CLIENT_AUTH_METHODS, OAuthError, presentedClient, registerClient } from './oauth.clients';
import { exchangeExtensionClientCredentials } from '../extensions/server-side';
import { loadPlatformSettings, productName } from '../platform/platform-settings';
import {
  approveAuthorization,
  denyAuthorization,
  disconnectMcp,
  exchangeCode,
  getAuthorizationRequest,
  issuerOf,
  listMcpConnections,
  mcpResourceOf,
  purgeOldGrants,
  refreshTokens,
  revokeOauthToken,
  startAuthorization,
} from './oauth.service';

/** Largest form body the token / revocation / registration endpoints read. */
const MAX_FORM_BYTES = 16 * 1024;

/** The scopes a new connection is challenged with (read + write); automations are an extra on the consent screen. */
export const MCP_CHALLENGE_SCOPES = [...MCP_SCOPE_GROUPS.read, ...MCP_SCOPE_GROUPS.write];

/** RFC 9728 protected resource metadata of `/mcp`. */
export const protectedResourceMetadata = async (deps: Pick<AppDeps, 'db' | 'env'>) => ({
  resource: await mcpResourceOf(deps),
  authorization_servers: [await issuerOf(deps)],
  scopes_supported: MCP_OAUTH_SCOPES,
  bearer_methods_supported: ['header'],
  // The product name of the owner console (white-label), else the i18n default.
  resource_name: productName(await loadPlatformSettings(deps.db), 'en'),
});

/** RFC 8414 authorization server metadata (+ the MCP spec's CIMD flag and RFC 9207 `iss`). */
export const authorizationServerMetadata = async (deps: Pick<AppDeps, 'db' | 'env'>) => {
  const iss = await issuerOf(deps);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    // client_credentials: extensions' servers only (D27 ת6) — MCP clients use authorization_code.
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    scopes_supported: MCP_OAUTH_SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
};

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

const oauthError = (c: Context<AppEnv>, err: OAuthError) => {
  if (err.status === 401) c.header('WWW-Authenticate', 'Basic realm="bines-os"');
  return c.json({ error: err.error, error_description: err.description }, err.status, NO_STORE);
};

/** A form body (or JSON, which some clients send), size-capped. */
const readForm = async (c: Context<AppEnv>): Promise<URLSearchParams> => {
  const text = await c.req.text();
  if (text.length > MAX_FORM_BYTES) throw new OAuthError('invalid_request', 'Request body too large');
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') p.set(k, v);
      return p;
    } catch {
      throw new OAuthError('invalid_request', 'Malformed JSON body');
    }
  }
  return new URLSearchParams(text);
};

/**
 * The authorization server's own endpoints on the web origin (like `/mcp`, before the SPA fallback): discovery
 * documents, /oauth/authorize (validates, then hands over to the consent page `/connect`), /oauth/token,
 * /oauth/register (DCR) and /oauth/revoke. They speak OAuth's error format, not the API's. Per-address rate limits;
 * nothing secret is ever logged (codes, tokens and secrets travel only in bodies, which we never log).
 */
export const mountOauth = (app: OpenAPIHono<AppEnv>, deps: AppDeps) => {
  const { env } = deps;
  const perMin = env.OAUTH_RATE_PER_MIN;
  const limits = {
    authorize: perMin > 0 ? new RateLimiter(perMin, 60_000) : null,
    token: perMin > 0 ? new RateLimiter(perMin, 60_000) : null,
    register: env.OAUTH_REGISTER_PER_HOUR > 0 ? new RateLimiter(env.OAUTH_REGISTER_PER_HOUR, 60 * 60_000) : null,
    revoke: perMin > 0 ? new RateLimiter(perMin, 60_000) : null,
  };
  const limited = (c: Context<AppEnv>, which: keyof typeof limits) => {
    const wait = limits[which]?.hit(ipBucket(c.get('clientIp'))) ?? 0;
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return oauthError(c, new OAuthError('temporarily_unavailable', 'Too many requests — wait and retry', 429));
    }
    return null;
  };

  // Browser-based MCP clients read the discovery documents and call the token endpoints cross-origin (no cookies).
  const open = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 });
  app.use('/.well-known/oauth-protected-resource', open);
  app.use('/.well-known/oauth-protected-resource/*', open);
  app.use('/.well-known/oauth-authorization-server', open);
  app.use('/.well-known/oauth-authorization-server/*', open);
  app.use('/oauth/token', open);
  app.use('/oauth/register', open);
  app.use('/oauth/revoke', open);

  const prm = async (c: Context<AppEnv>) =>
    c.json(await protectedResourceMetadata(deps), 200, { 'Cache-Control': 'max-age=300' });
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/mcp', prm);
  const asm = async (c: Context<AppEnv>) =>
    c.json(await authorizationServerMetadata(deps), 200, { 'Cache-Control': 'max-age=300' });
  app.get('/.well-known/oauth-authorization-server', asm);

  app.get('/oauth/authorize', async (c) => {
    const busy = limited(c, 'authorize');
    if (busy) return busy;
    void purgeOldGrants(deps.db).catch(() => undefined);
    const out = await startAuthorization(deps, new URL(c.req.url).searchParams);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    if (out.kind === 'error_page') return c.redirect(`${await issuerOf(deps)}/connect?error=${out.error}`, 302);
    return c.redirect(out.url, 302);
  });

  app.post('/oauth/token', async (c) => {
    const busy = limited(c, 'token');
    if (busy) return busy;
    try {
      const form = await readForm(c);
      const presented = presentedClient(c.req.header('authorization'), form);
      const meta = requestMeta(c);
      const grant = form.get('grant_type');
      const body =
        grant === 'authorization_code'
          ? await exchangeCode(deps, form, presented, meta)
          : grant === 'refresh_token'
            ? await refreshTokens(deps, form, presented, meta)
            : // An extension's server (D27 ת6): its installation's client credentials → a token for the REST API.
              grant === 'client_credentials' && isExtensionClientId(presented.clientId)
              ? await exchangeExtensionClientCredentials(deps, form, presented, meta)
              : null;
      if (!body)
        throw new OAuthError(
          'unsupported_grant_type',
          grant === 'client_credentials'
            ? 'client_credentials is only for extension clients'
            : 'grant_type must be authorization_code or refresh_token',
        );
      return c.json(body, 200, NO_STORE);
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err);
      throw err;
    }
  });

  app.post('/oauth/register', async (c) => {
    const busy = limited(c, 'register');
    if (busy) return busy;
    try {
      const text = await c.req.text();
      if (text.length > MAX_FORM_BYTES) throw new OAuthError('invalid_client_metadata', 'Request body too large');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new OAuthError('invalid_client_metadata', 'The body must be JSON');
      }
      return c.json(await registerClient(deps.db, body), 201, NO_STORE);
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err);
      throw err;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const busy = limited(c, 'revoke');
    if (busy) return busy;
    try {
      const form = await readForm(c);
      await revokeOauthToken(deps, form, presentedClient(c.req.header('authorization'), form), requestMeta(c));
      return c.body(null, 200, NO_STORE);
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err);
      throw err;
    }
  });
};

/**
 * `/api/v1` side: the consent screen (session only — lib/scopes keeps tokens out) and the connected-apps list with
 * "disconnect" (profile → API tokens, Administration).
 */
export const oauthApiRoutes = (deps: AppDeps) => {
  const common = errors(400, 401, 403, 404, 422, 423);
  const r = new OpenAPIHono<AppEnv>();
  const signedIn = [requireUser()];
  const scoped = [requireAccount(deps)];
  r.openapi(
    createRoute({
      method: 'get',
      path: '/oauth-requests/{id}',
      tags: ['mcp'],
      summary: 'An AI app asks to connect: who it is, what it asks for, and my accounts it may connect to',
      middleware: signedIn,
      request: { params: idParam },
      responses: { 200: json(oauthRequestSchema, 'The request'), ...common },
    }),
    async (c) => c.json(await getAuthorizationRequest(deps, currentUser(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/oauth-requests/{id}/approve',
      tags: ['mcp'],
      summary: 'Allow the app — one account, the chosen scopes and (optionally) boards; returns where to go next',
      middleware: signedIn,
      request: { params: idParam, ...jsonBody(approveOauthSchema) },
      responses: { 200: json(oauthDecisionSchema, 'Redirect'), ...common },
    }),
    async (c) =>
      c.json(await approveAuthorization(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/oauth-requests/{id}/deny',
      tags: ['mcp'],
      summary: 'Refuse the app; returns where to go next (the app gets access_denied)',
      middleware: signedIn,
      request: { params: idParam },
      responses: { 200: json(oauthDecisionSchema, 'Redirect'), ...common },
    }),
    async (c) => c.json(await denyAuthorization(deps, currentUser(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/mcp-connections',
      tags: ['mcp'],
      summary: 'AI apps connected over OAuth: mine in this account (`all=true`: everyone’s, admins)',
      middleware: scoped,
      request: { headers: accountHeader, query: z.object({ all: z.enum(['true', 'false']).optional() }) },
      responses: { 200: json(z.object({ data: z.array(mcpConnectionSchema) }), 'Connections'), ...common },
    }),
    async (c) => c.json(await listMcpConnections(deps.db, actorOf(c), c.req.valid('query').all === 'true'), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/mcp-connections/{id}',
      tags: ['mcp'],
      summary: 'Disconnect an AI app (mine, or anyone’s for an admin) — its tokens stop working at once',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Disconnected'), ...common },
    }),
    async (c) => c.json(await disconnectMcp(deps.db, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );
  return r;
};
