// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { oauthClients } from '../../db/schema';
import { outboundRequest } from '../../lib/outbound';
import { sha256 } from '../../lib/tokens';

/**
 * OAuth clients of the MCP authorization server (the planning notes "AGENTS-MCP" §4, מ5), per the MCP authorization spec
 * (2026-07-28, "Client Registration"):
 * - **Client ID Metadata Documents** (preferred): the client_id is an https URL with a path; we fetch the JSON
 *   document through the SSRF-safe outbound helper, check `client_id` equals the URL exactly and that it has a name
 *   and redirect URIs, and cache it (an hour). Public clients only (`token_endpoint_auth_method: none`).
 * - **Dynamic Client Registration** (RFC 7591, deprecated in the spec but what most clients still do): a random
 *   client_id; a client that asks for a secret method gets a secret (stored hashed, shown once).
 * Redirect URIs match exactly — except the port of a loopback http URI (RFC 8252 §7.3 / OAuth 2.1).
 */

/** An OAuth protocol error (RFC 6749 §5.2 / RFC 7591 §3.2.2): `error` + `error_description`. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: 400 | 401 | 403 | 429 = 400,
  ) {
    super(description);
  }
}

export type OAuthClient = typeof oauthClients.$inferSelect;

export const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
const CIMD_TTL_MS = 60 * 60 * 1000;
const MAX_METADATA_BYTES = 16 * 1024;

const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** A redirect URI a client may register: https; http only on loopback; an app's own scheme (cursor://…). */
export const validRedirectUri = (raw: string): boolean => {
  if (raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes('#')) return false;
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !FORBIDDEN_SCHEMES.has(u.protocol);
};

/** Exact match; a loopback http URI may differ in its port only (native apps pick a free port). */
export const redirectMatches = (registered: readonly string[], presented: string): boolean => {
  if (registered.includes(presented)) return true;
  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  if (p.protocol !== 'http:' || !LOOPBACK_HOSTS.has(p.hostname) || p.hostname === 'localhost') return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return (
        u.protocol === 'http:' &&
        u.hostname === p.hostname &&
        u.pathname === p.pathname &&
        u.search === p.search &&
        !p.hash
      );
    } catch {
      return false;
    }
  });
};

/** A client_id that names a metadata document: https, a path, no fragment / credentials / dot segments. */
export const isMetadataClientId = (clientId: string): boolean => {
  if (clientId.length > 512 || !clientId.startsWith('https://')) return false;
  try {
    const u = new URL(clientId);
    return (
      u.protocol === 'https:' &&
      u.pathname.length > 1 &&
      !u.hash &&
      !u.username &&
      !u.password &&
      !/\/\.\.?(\/|$)/.test(u.pathname) &&
      u.href === clientId
    );
  } catch {
    return false;
  }
};

/** The host people see for a client: its metadata document's host, else its first redirect URI's. */
export const clientHost = (c: Pick<OAuthClient, 'kind' | 'clientId' | 'redirectUris'>): string => {
  const from = c.kind === 'cimd' ? c.clientId : c.redirectUris[0];
  try {
    const u = new URL(from ?? '');
    return u.host || u.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
};

// ---- Client ID Metadata Documents ----

export type MetadataFetcher = (url: string) => Promise<{ status: number; body: string }>;

const defaultFetcher: MetadataFetcher = async (url) => {
  const res = await outboundRequest(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: 5000,
    maxBytes: MAX_METADATA_BYTES,
  });
  return { status: res.status, body: res.body };
};
let fetchMetadata: MetadataFetcher = defaultFetcher;

/** Tests serve metadata documents without a network (null restores the SSRF-safe fetcher). */
export const setClientMetadataFetcher = (f: MetadataFetcher | null) => {
  fetchMetadata = f ?? defaultFetcher;
};

const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && /^https:\/\//.test(v) && v.length <= 2000 ? v : undefined),
  z.string().optional(),
);

const metadataSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(200),
  redirect_uris: z.array(z.string()).min(1).max(20),
  client_uri: optionalUrl,
  logo_uri: optionalUrl,
  token_endpoint_auth_method: z.string().optional(),
});

/**
 * A metadata URL that could not be fetched or parsed is not tried again for a while (audit 2026-10-10 security
 * #24): an anonymous `client_id=https://…` on /oauth/authorize made this server fetch any public URL on every
 * request (a liveness oracle, a small amplifier); now once per URL per window.
 */
const METADATA_FAILURE_TTL_MS = 5 * 60_000;
const failedMetadata = new Map<string, number>();
export const forgetFailedMetadataForTests = () => failedMetadata.clear();

const loadMetadataClient = async (db: Db, clientId: string, cached: OAuthClient | undefined): Promise<OAuthClient> => {
  let doc: z.infer<typeof metadataSchema>;
  const failedAt = failedMetadata.get(clientId);
  if (failedAt && Date.now() - failedAt < METADATA_FAILURE_TTL_MS)
    throw new OAuthError('invalid_client', 'The client metadata document could not be fetched or is invalid');
  try {
    const res = await fetchMetadata(clientId);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const parsed = metadataSchema.safeParse(JSON.parse(res.body));
    if (!parsed.success) throw new Error('invalid document');
    doc = parsed.data;
  } catch {
    if (failedMetadata.size > 10_000) failedMetadata.clear();
    failedMetadata.set(clientId, Date.now());
    throw new OAuthError('invalid_client', 'The client metadata document could not be fetched or is invalid');
  }
  failedMetadata.delete(clientId);
  if (doc.client_id !== clientId)
    throw new OAuthError('invalid_client', 'client_id in the metadata document does not match its URL');
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none')
    throw new OAuthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported');
  if (!doc.redirect_uris.every(validRedirectUri))
    throw new OAuthError('invalid_client', 'The metadata document has an invalid redirect URI');
  const now = new Date();
  const values = {
    clientName: doc.client_name.slice(0, 120),
    clientUri: doc.client_uri ?? null,
    logoUri: doc.logo_uri ?? null,
    redirectUris: doc.redirect_uris,
    authMethod: 'none',
    secretHash: null,
    fetchedAt: now,
    freshUntil: new Date(now.getTime() + CIMD_TTL_MS),
  };
  if (cached) {
    const [row] = await db.update(oauthClients).set(values).where(eq(oauthClients.id, cached.id)).returning();
    return row!;
  }
  const [row] = await db
    .insert(oauthClients)
    .values({ id: newId(), clientId, kind: 'cimd', ...values })
    .onConflictDoUpdate({ target: oauthClients.clientId, set: values })
    .returning();
  return row!;
};

/** The client behind a client_id: a cached / freshly fetched metadata document, or a registered client. */
export const resolveClient = async (db: Db, clientId: string | undefined | null): Promise<OAuthClient> => {
  if (!clientId || clientId.length > 512) throw new OAuthError('invalid_client', 'Unknown client');
  const row = (await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1))[0];
  if (isMetadataClientId(clientId)) {
    if (row && row.kind === 'cimd' && row.freshUntil && row.freshUntil > new Date()) return row;
    return loadMetadataClient(db, clientId, row?.kind === 'cimd' ? row : undefined);
  }
  if (!row || row.kind !== 'dcr') throw new OAuthError('invalid_client', 'Unknown client');
  return row;
};

// ---- Dynamic Client Registration (RFC 7591) ----

export const registrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().min(1).max(120).optional(),
  client_uri: optionalUrl,
  logo_uri: optionalUrl,
  token_endpoint_auth_method: z.enum(CLIENT_AUTH_METHODS).default('none'),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).min(1).default(['code']),
  scope: z.string().max(1000).optional(),
});

export const registerClient = async (db: Db, body: unknown) => {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const bad = parsed.error.issues.some((i) => i.path[0] === 'redirect_uris');
    throw new OAuthError(
      bad ? 'invalid_redirect_uri' : 'invalid_client_metadata',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const input = parsed.data;
  if (!input.redirect_uris.every(validRedirectUri))
    throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must be https, loopback http, or an app scheme');
  if (!input.grant_types.includes('authorization_code'))
    throw new OAuthError('invalid_client_metadata', 'grant_types must include authorization_code');
  const clientId = `bos_cli_${randomBytes(18).toString('base64url')}`;
  const secret = input.token_endpoint_auth_method === 'none' ? null : `bos_cs_${randomBytes(32).toString('base64url')}`;
  const [row] = await db
    .insert(oauthClients)
    .values({
      id: newId(),
      clientId,
      kind: 'dcr',
      clientName: input.client_name ?? clientHost({ kind: 'dcr', clientId, redirectUris: input.redirect_uris }),
      clientUri: input.client_uri ?? null,
      logoUri: input.logo_uri ?? null,
      redirectUris: [...new Set(input.redirect_uris)],
      authMethod: input.token_endpoint_auth_method,
      secretHash: secret ? sha256(secret) : null,
    })
    .returning();
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: row!.clientName,
    redirect_uris: row!.redirectUris,
    token_endpoint_auth_method: input.token_endpoint_auth_method,
    grant_types: input.grant_types,
    response_types: input.response_types,
    ...(input.client_uri ? { client_uri: input.client_uri } : {}),
    ...(input.logo_uri ? { logo_uri: input.logo_uri } : {}),
  };
};

// ---- client authentication at the token / revocation endpoints ----

export type PresentedClient = { clientId: string | null; secret: string | null; basic: boolean };

/** client_id / client_secret from HTTP Basic (RFC 6749 §2.3.1, form-encoded parts) or the request body. */
export const presentedClient = (authorization: string | undefined, form: URLSearchParams): PresentedClient => {
  const basic = authorization?.match(/^Basic\s+(\S+)$/i)?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      return { clientId: dec(decoded.slice(0, i)), secret: dec(decoded.slice(i + 1)), basic: true };
    }
  }
  return { clientId: form.get('client_id'), secret: form.get('client_secret'), basic: false };
};

const sameSecret = (presented: string, hash: string) => {
  const a = Buffer.from(sha256(presented), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The calling client, authenticated by its registered method (public clients: their client_id; PKCE does the rest). */
export const authenticateClient = async (db: Db, p: PresentedClient): Promise<OAuthClient> => {
  let client: OAuthClient;
  try {
    client = await resolveClient(db, p.clientId);
  } catch {
    throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  }
  if (client.authMethod === 'none') return client;
  if (!p.secret || !client.secretHash || !sameSecret(p.secret, client.secretHash))
    throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  return client;
};
