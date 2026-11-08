// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import type { AppEnv } from '../types';

/**
 * The real client address (security review S-10) — one helper for every rate limiter, Better Auth, the audit log
 * and sessions. Which header to believe is configuration, never guessed per request:
 *
 * - `TRUST_PROXY=edge` (default; Railway): the edge proxy replaces whatever X-Forwarded-For the client sent and puts
 *   the connecting address first ("We do strip X-Forwarded-For at our edge… The first value of the X-Forwarded-For
 *   is the real connecting IP", per Railway). Hops it adds inside its network come after it.
 * - `TRUST_PROXY=<n>` (1, 2, …): n proxies of ours each append the address they saw. The client is the n-th entry
 *   from the right; anything to its left was written by the client and is ignored (spoof-proof without an edge
 *   that strips the header).
 * - `TRUST_PROXY=none`: no proxy in front (local dev); forwarded headers are ignored, the TCP peer is the client.
 *
 * Rule for operators: `edge` is only safe where the origin cannot be reached except through that edge
 * (Railway: the service has no public port of its own).
 *
 * `CLIENT_IP_HEADER` (default `x-forwarded-for`) names the header; a single-value header such as `x-real-ip` or
 * `cf-connecting-ip` works with `edge`. Anything that is not an IP address counts as unknown (null).
 */
export type TrustProxy = 'edge' | 'none' | number;
export type ClientIpConfig = { trust: TrustProxy; header: string };

/** Internal header carrying the resolved address to Better Auth; any value a client sends is replaced. */
export const RESOLVED_IP_HEADER = 'x-bines-client-ip';

export const parseTrustProxy = (raw: string | undefined): TrustProxy => {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'edge' || v === 'true') return 'edge';
  if (v === 'none' || v === 'false' || v === '0') return 'none';
  const n = Number(v);
  if (Number.isInteger(n) && n > 0 && n < 20) return n;
  throw new Error(`TRUST_PROXY must be "edge", "none" or a hop count (1-19), got "${raw}"`);
};

export const clientIpConfig = (env: Pick<Env, 'TRUST_PROXY' | 'CLIENT_IP_HEADER'>): ClientIpConfig => ({
  trust: parseTrustProxy(env.TRUST_PROXY),
  header: (env.CLIENT_IP_HEADER ?? 'x-forwarded-for').toLowerCase(),
});

/** A valid address, IPv4-mapped IPv6 unwrapped (`::ffff:1.2.3.4` → `1.2.3.4`), else null. */
export const normalizeIp = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  let v = raw.trim();
  // "[2001:db8::1]:443" / "1.2.3.4:5678" — some proxies append the port
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(v);
  if (mapped) v = mapped[1]!;
  const kind = isIP(v);
  if (kind === 4) return v;
  if (kind === 6) return v.toLowerCase();
  return null;
};

/** Resolves the client address from the request headers (and the TCP peer for `none`). */
export const resolveClientIp = (
  cfg: ClientIpConfig,
  headers: { get(name: string): string | null },
  peer?: string | null,
): string | null => {
  if (cfg.trust === 'none') return normalizeIp(peer);
  const value = headers.get(cfg.header);
  // No header at all: nothing forwarded the request, so the peer is the client (local dev, health probes).
  if (!value) return normalizeIp(peer);
  const chain = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return null;
  if (cfg.trust === 'edge') return normalizeIp(chain[0]);
  // n trusted proxies appended n entries: the one the first of them saw is n from the right.
  const at = chain.length - cfg.trust;
  return at >= 0 ? normalizeIp(chain[at]) : null;
};

/** A key for per-IP rate limits: an IPv6 client usually owns a whole /64, so it counts as one. */
export const ipBucket = (ip: string | null): string => {
  if (!ip) return 'ip:unknown';
  if (!ip.includes(':')) return `ip:${ip}`;
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `ip:${groups.slice(0, 4).join(':')}::/64`;
};

const peerOf = (c: Context<AppEnv>): string | null => {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
};

/** Resolves the address once per request into `c.var.clientIp`. */
export const clientIp =
  (cfg: ClientIpConfig): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    c.set('clientIp', resolveClientIp(cfg, c.req.raw.headers, peerOf(c)));
    await next();
  };

/** The request as Better Auth should see it: our resolved address in RESOLVED_IP_HEADER, nothing the client set. */
export const withResolvedIp = (req: Request, ip: string | null): Request => {
  const headers = new Headers(req.headers);
  headers.delete(RESOLVED_IP_HEADER);
  if (ip) headers.set(RESOLVED_IP_HEADER, ip);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(req.url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: req.redirect,
    signal: req.signal,
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
};
