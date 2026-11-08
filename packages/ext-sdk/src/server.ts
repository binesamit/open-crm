// SPDX-License-Identifier: MIT
/**
 * @bines/ext-sdk/server (MIT) — for an extension's **server**. Web Crypto + fetch only (Node 20+, Deno, Bun,
 * Workers), dependency-free, erasable TypeScript; never put this in a page — the secrets belong on the server.
 *
 * One signing scheme for every signed call between Bines and your server (automation actions and triggers, D27 ת4;
 * lifecycle webhooks, ת6), with the installation's one signing secret: `X-Bines-Timestamp` (ms) and
 * `X-Bines-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`. The secret comes in the `installed`
 * lifecycle call (an extension with `server` in its manifest) or from Administration → תוספות → the extension.
 *
 *   // ת4: an automation action / a trigger
 *   const check = await verifyBinesSignature({ secret, timestamp, signature, body });  // 'ok' | why not
 *   await fireBinesTrigger({ appOrigin, installationId, secret, block: 'my-ext.new_lead', payload });
 *
 *   // ת6: lifecycle + the REST API as the extension's service user
 *   const event = await verifyLifecycle({ secret, headers, body });   // throws when the signature is wrong
 *   if (event.event === 'installed') save(event.credentials);          // keep them in your secret store
 *   const client = createServerClient(saved);                          // tokens are fetched and renewed for you
 *   await client.api('GET', `/boards/${boardId}/items`);
 */

export type LifecycleEventName = 'installed' | 'updated' | 'enabled' | 'disabled' | 'uninstalled';

export type ServerCredentials = {
  client_id: string;
  client_secret: string;
  signing_secret: string;
  token_endpoint: string;
  api_base: string;
};

export type LifecycleEvent = {
  event: LifecycleEventName;
  delivery_id: string;
  sent_at: string;
  platform: string;
  account: { id: string; name?: string; slug?: string };
  installation: {
    id: string;
    key: string;
    version: string;
    previous_version?: string;
    status: string;
    scopes: string[];
    board_ids: string[] | null;
    /** Whole workspaces it works on (their boards now and later); with `board_ids` null too = every board. */
    workspace_ids: string[] | null;
  };
  /** Why (e.g. `platform_kill` when the platform owner switched the extension off everywhere). */
  reason?: string;
  /** Only in `installed`: keep them secret; the signing secret signs every later call. */
  credentials?: ServerCredentials;
};

export class LifecycleSignatureError extends Error {}

/** `https://host[:port]` of a URL, or null. */
const originOf = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
};

export const SIGNATURE_TOLERANCE_SECONDS = 300;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** `sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">` — the one signature (ת4 calls and ת6 lifecycle alike). */
export const signBinesBody = async (secret: string, timestamp: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`)))}`;
};

/** The lifecycle signature — the same scheme as every other signed call. */
export const signLifecycle = signBinesBody;

/** Constant-time string comparison. */
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export type VerifyResult = 'ok' | 'missing' | 'stale' | 'bad_signature' | 'replay';

/** Remembers signatures already accepted (a Set, or your own store). */
export type SeenStore = { has: (sig: string) => boolean; add: (sig: string) => unknown };

/**
 * Checks a call from Bines: the timestamp is within the tolerance, the signature matches the **raw** body, and (with
 * `seen`) it was not accepted before — a replay. Read the body as text before parsing it.
 */
export const verifyBinesSignature = async (p: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string;
  now?: number;
  toleranceSeconds?: number;
  seen?: SeenStore;
}): Promise<VerifyResult> => {
  if (!p.timestamp || !p.signature) return 'missing';
  const ts = Number(p.timestamp);
  if (!/^\d{10,16}$/.test(p.timestamp) || !Number.isFinite(ts)) return 'stale';
  const tolerance = (p.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS) * 1000;
  if (Math.abs((p.now ?? Date.now()) - ts) > tolerance) return 'stale';
  if (!same(await signBinesBody(p.secret, p.timestamp, p.body), p.signature)) return 'bad_signature';
  if (p.seen) {
    if (p.seen.has(p.signature)) return 'replay';
    p.seen.add(p.signature);
  }
  return 'ok';
};

/**
 * Fires one of your extension's automation triggers: `POST <app>/api/v1/automations/triggers/<block>/fire`, signed.
 * `block` = `<extension id>.<trigger key>`; `payload` becomes `{payload.*}` in the automation.
 */
export const fireBinesTrigger = async (p: {
  appOrigin: string;
  installationId: string;
  secret: string;
  block: string;
  payload: Record<string, unknown>;
  boardId?: string;
  itemId?: string;
  fetch?: typeof fetch;
  now?: number;
}): Promise<Response> => {
  const body = JSON.stringify({
    payload: p.payload,
    ...(p.boardId ? { board_id: p.boardId } : {}),
    ...(p.itemId ? { item_id: p.itemId } : {}),
  });
  const timestamp = String(p.now ?? Date.now());
  const url = `${p.appOrigin.replace(/\/$/, '')}/api/v1/automations/triggers/${encodeURIComponent(p.block)}/fire`;
  return (p.fetch ?? fetch)(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bines-installation': p.installationId,
      'x-bines-timestamp': timestamp,
      'x-bines-signature': await signBinesBody(p.secret, timestamp, body),
    },
    body,
  });
};

const header = (headers: Headers | Record<string, string | string[] | undefined>, name: string) => {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Checks a lifecycle call: the signature over the **raw** body, and a timestamp no older than `maxAgeMs` (replay
 * guard). `secret` = the signing secret you saved from `installed`. For the `installed` call itself you have no
 * secret yet: pass `trustInstalled: true` — the call is then signed with the secret it carries, and you prove the
 * credentials are real by trading them for a token (`createServerClient(...).token()`) before you trust them.
 */
export const verifyLifecycle = async (opts: {
  secret?: string | null;
  headers: Headers | Record<string, string | string[] | undefined>;
  body: string;
  maxAgeMs?: number;
  trustInstalled?: boolean;
  /**
   * The Bines origin you work with (e.g. `https://app.example.com`) — **required** with `trustInstalled`: anyone can
   * sign an `installed` call with a secret of their own, so its `platform`, `token_endpoint` and `api_base` must be
   * this origin, or the credentials would lead your server to someone else's "platform" (EXT-RT6).
   */
  platform?: string;
  now?: number;
}): Promise<LifecycleEvent> => {
  const ts = header(opts.headers, 'x-bines-timestamp');
  const sig = header(opts.headers, 'x-bines-signature');
  if (!ts || !sig) throw new LifecycleSignatureError('missing signature headers');
  const age = (opts.now ?? Date.now()) - Number(ts);
  if (!Number.isFinite(age) || Math.abs(age) > (opts.maxAgeMs ?? SIGNATURE_TOLERANCE_SECONDS * 1000))
    throw new LifecycleSignatureError('stale timestamp');
  let event: LifecycleEvent;
  try {
    event = JSON.parse(opts.body) as LifecycleEvent;
  } catch {
    throw new LifecycleSignatureError('body is not JSON');
  }
  const selfSigned = !opts.secret && opts.trustInstalled && event.event === 'installed';
  if (selfSigned) {
    const platform = originOf(opts.platform);
    if (!platform) throw new LifecycleSignatureError('platform origin required to trust an installed call');
    const c = event.credentials;
    if (
      originOf(event.platform) !== platform ||
      !c ||
      originOf(c.token_endpoint) !== platform ||
      originOf(c.api_base) !== platform
    )
      throw new LifecycleSignatureError('installed call from another platform');
  }
  const secret = opts.secret ?? (selfSigned ? event.credentials?.signing_secret : null);
  if (!secret) throw new LifecycleSignatureError('no signing secret');
  if (!same(await signLifecycle(secret, ts, opts.body), sig)) throw new LifecycleSignatureError('bad signature');
  return event;
};

export type ServerClient = {
  /** A valid access token (fetched with the client credentials, renewed a minute before it expires). */
  token: () => Promise<string>;
  /** A REST call as the extension's service user (JSON in, JSON out). */
  api: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
};

export class BinesServerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const createServerClient = (
  creds: Pick<ServerCredentials, 'client_id' | 'client_secret' | 'token_endpoint' | 'api_base'>,
  opts: { fetch?: typeof fetch } = {},
): ServerClient => {
  const doFetch = opts.fetch ?? fetch;
  // EXT-RT6: the client secret goes only to the platform whose API it is for.
  const origin = originOf(creds.api_base);
  if (!origin || originOf(creds.token_endpoint) !== origin)
    throw new BinesServerError(0, 'bad_credentials', 'token_endpoint and api_base must be on the same origin');
  let current: { token: string; until: number } | null = null;
  const token = async () => {
    if (current && current.until > Date.now()) return current.token;
    const res = await doFetch(creds.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(`${encodeURIComponent(creds.client_id)}:${encodeURIComponent(creds.client_secret)}`)}`,
      },
      body: 'grant_type=client_credentials',
    });
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !data.access_token) throw new BinesServerError(res.status, data.error ?? 'token_failed', 'token');
    current = { token: data.access_token, until: Date.now() + Math.max(60, (data.expires_in ?? 3600) - 60) * 1000 };
    return current.token;
  };
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const send = async () =>
      doFetch(`${creds.api_base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await token()}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await send();
    if (res.status === 401) {
      current = null;
      res = await send();
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new BinesServerError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
    }
    return data as T;
  };
  return { token, api };
};

/**
 * the count beside one of your sidebar pages (`app_page` `key`) — the account's (everyone), or one
 * member's with `userId` (wins over the account's for them). `null` removes it. Open apps update at once.
 */
export const setAppPageBadge = (
  client: Pick<ServerClient, 'api'>,
  key: string,
  count: number | null,
  opts: { userId?: string } = {},
) =>
  client.api<{ key: string; count: number | null; user_id: string | null }>(
    'PUT',
    `/ext/app-pages/${encodeURIComponent(key)}/badge`,
    { count, ...(opts.userId ? { user_id: opts.userId } : {}) },
  );
