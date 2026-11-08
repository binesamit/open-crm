// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { AppError } from '@bines/shared';

/** Calls out of the platform (webhooks, automation webhooks): SSRF guard and HMAC signing (06 §2.17). */

/** Loopback, private, link-local (cloud metadata), CGNAT, documentation, multicast and reserved ranges. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b::', 96], // NAT64 — maps onto IPv4, private included
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo — tunnels to an IPv4 address hidden in the bits (AI-RT13)
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 — all of it (S-35: `2002:7f00::` is 127.0.0.0's; the relay protocol is deprecated, RFC 7526)
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv6');

/** `::ffff:a.b.c.d` / `::ffff:7f00:1` (how the URL parser writes it) → the IPv4 address inside. */
const mappedV4 = (ip: string): string | null => {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const tail = m[1]!;
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
};

/** 6to4 `2002:AABB:CCDD::…` → the IPv4 address it carries (AI-RT13: 2002:7f00:1:: is 127.0.0.1's). */
const sixToFour = (ip: string): string | null => {
  const m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i.exec(ip);
  if (!m) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
};

export const isPrivateIp = (raw: string): boolean => {
  const ip = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = isIP(ip);
  if (v === 4) return BLOCKED.check(ip, 'ipv4');
  if (v === 6) {
    const v4 = mappedV4(ip) ?? sixToFour(ip);
    return v4 ? BLOCKED.check(v4, 'ipv4') : BLOCKED.check(ip, 'ipv6');
  }
  return true; // not an address: refuse
};

const isLocalName = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');

/**
 * Whether outgoing calls may reach private / loopback addresses: in tests, or with the explicit development switch
 * `OUTBOUND_ALLOW_PRIVATE=1` (which production refuses to start with) — one rule for every call site (audit
 * 2026-10-10 #7; a deployment that forgot NODE_ENV=production used to lose the guard).
 */
export const allowPrivateOutbound = (
  env: { NODE_ENV?: string; OUTBOUND_ALLOW_PRIVATE?: string },
  /** false: tests too need the switch (or the module's own test seam), like MCP servers and flows always did. */
  { inTests = true }: { inTests?: boolean } = {},
) => (inTests && env.NODE_ENV === 'test') || (env.NODE_ENV !== 'production' && env.OUTBOUND_ALLOW_PRIVATE === '1');

/** SSRF guard (04 §4.2): https/http to a public address only. Checked when a URL is saved and again on each call. */
export const assertPublicUrl = async (raw: string, allowPrivate = false) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('invalid_value', 'webhook_url_invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('invalid_value', 'webhook_url_invalid');
  if (url.username || url.password) throw new AppError('invalid_value', 'webhook_url_invalid');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // `localhost.` / `metadata.google.internal.` (a fully qualified name) is the same name (AI-RT13).
  if (isLocalName(host.replace(/\.+$/, ''))) throw new AppError('invalid_value', 'webhook_url_private');
  const addrs = isIP(host) ? [host] : (await dnsLookupAsync(host, { all: true })).map((r) => r.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new AppError('invalid_value', 'webhook_url_private');
  return url;
};

/**
 * DNS lookup for outbound sockets that refuses private addresses — the address checked is the address dialled,
 * so a name that re-resolves to 127.0.0.1 / 169.254.169.254 after the first check (DNS rebinding) is refused.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as unknown as { address: string; family: number }[];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      const e = Object.assign(new Error('webhook_url_private'), { code: 'EPRIVATE' });
      return callback(e, '', 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

/** Headers a webhook author may not set: they describe the connection, not the call. */
const HOP_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade']);

export type OutboundResponse = { status: number; ok: boolean; body: string };

/**
 * One outbound HTTP call (webhooks, automation webhooks, the handshake). Never follows redirects (a 3xx is the
 * answer — a redirect to an internal address cannot be used to reach it), dials only public addresses (unless
 * `allowPrivate`, for dev and tests), reads at most `maxBytes` of the answer.
 */
export const outboundRequest = async (
  raw: string | URL,
  opts: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    allowPrivate?: boolean;
    maxBytes?: number;
  },
): Promise<OutboundResponse> => {
  const url = await assertPublicUrl(String(raw), opts.allowPrivate);
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const res = await rawRequest(url, { ...opts, maxBytes });
  return { status: res.status, ok: res.ok, body: res.body.subarray(0, maxBytes).toString('utf8') };
};

/**
 * `outboundRequest` with the answer's headers (outbound MCP, מ10: the session id and the content type of a
 * Streamable HTTP answer) and whether it was cut at `maxBytes`. Same guard: public addresses only unless
 * `allowPrivate`, no redirects.
 */
export const outboundExchange = async (
  raw: string | URL,
  opts: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    allowPrivate?: boolean;
    maxBytes: number;
  },
): Promise<OutboundResponse & { headers: IncomingMessage['headers']; truncated: boolean }> => {
  const url = await assertPublicUrl(String(raw), opts.allowPrivate);
  const res = await rawRequest(url, opts);
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    truncated: res.truncated,
    body: res.body.toString('utf8'),
  };
};

type RawResponse = {
  status: number;
  ok: boolean;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** The answer was longer than `maxBytes` (the rest was not read). */
  truncated: boolean;
};

/** The socket part of an outbound call: a URL already checked by `assertPublicUrl`, the guarded lookup, a cap. */
const rawRequest = (
  url: URL,
  opts: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    allowPrivate?: boolean;
    maxBytes: number;
  },
): Promise<RawResponse> => {
  const maxBytes = opts.maxBytes;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {}))
    if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
  if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<RawResponse>((resolve, reject) => {
    const req = send(
      url,
      {
        method: opts.method,
        headers,
        timeout: opts.timeoutMs,
        ...(opts.allowPrivate ? {} : { lookup: guardedLookup }),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size > maxBytes) return;
          chunks.push(c);
          size += c.length;
          if (size > maxBytes) res.destroy();
        });
        const done = () => {
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: res.headers,
            body: Buffer.concat(chunks).subarray(0, maxBytes),
            truncated: size > maxBytes,
          });
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    const timer = setTimeout(
      () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
      opts.timeoutMs,
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    req.on('error', (err: Error & { code?: string }) => {
      clearTimeout(timer);
      reject(err.code === 'EPRIVATE' ? new AppError('invalid_value', 'webhook_url_private') : err);
    });
    req.on('close', () => clearTimeout(timer));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
};

export type OutboundDownload = { url: string; mime: string; fileName: string | null; body: Buffer };

/** `filename=` / `filename*=UTF-8''…` of a Content-Disposition header. */
const dispositionName = (header: string | undefined) => {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // fall through to the plain name
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain ? plain[1]!.trim() : null;
};

/**
 * A file from a URL (attach a file from a link — AGENTS-MCP §4): GET, public addresses only (always — the URL may
 * come from a model, so there is no private-address escape hatch), at most `maxBytes` (a longer answer is refused,
 * not cut), redirects followed up to `maxRedirects` with every hop checked again like the first.
 */
export const outboundDownload = async (
  raw: string,
  opts: {
    maxBytes: number;
    timeoutMs: number;
    maxRedirects?: number;
    /** Only where the caller's URL is not a model's: tests and dev with the switch (allowPrivateOutbound). */
    allowPrivate?: boolean;
  },
): Promise<OutboundDownload> => {
  // An unknown host is a bad link, not a server error.
  const publicUrl = (u: string) =>
    assertPublicUrl(u, opts.allowPrivate).catch((err: Error) => {
      if (err instanceof AppError) throw err;
      throw new AppError('invalid_value', 'url_unreachable');
    });
  let url = await publicUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await rawRequest(url, {
      method: 'GET',
      headers: { accept: '*/*', 'user-agent': 'BinesOS-FileFetch/1.0' },
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
    }).catch((err: Error) => {
      if (err instanceof AppError) throw err;
      throw new AppError('external_error', err.name === 'TimeoutError' ? 'download_timeout' : 'download_failed');
    });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= (opts.maxRedirects ?? 3)) throw new AppError('invalid_value', 'too_many_redirects');
      url = await publicUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new AppError('external_error', `download_failed: HTTP ${res.status}`, { status: res.status });
    if (res.truncated) throw new AppError('payload_too_large', 'file_too_large', { max_bytes: opts.maxBytes });
    const mime = String(res.headers['content-type'] ?? 'application/octet-stream')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const last = url.pathname.split('/').pop() ?? '';
    let fromPath: string | null = last || null;
    try {
      fromPath = decodeURIComponent(last) || null;
    } catch {
      // keep it encoded
    }
    return {
      url: url.toString(),
      mime: mime || 'application/octet-stream',
      fileName: dispositionName(res.headers['content-disposition']) ?? fromPath,
      body: res.body,
    };
  }
};

export const signBody = (secret: string, timestamp: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/**
 * The lite signature of a webhook delivery (`X-Bines-Signature-Lite`): HMAC-SHA256(secret
 * timestamp + "." + deliveryId). It proves the sender knows the secret without signing the raw body, so a receiver
 * that sees only the parsed body (Make's webhook IML, which cannot reproduce the bytes) can recompute it. Replay is
 * bounded by the timestamp window and the unique delivery id. The full-body `X-Bines-Signature` is still sent.
 */
export const signLite = (secret: string, timestamp: string, deliveryId: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}`).digest('hex')}`;

/**
 * A `fetch` for calls to AI providers: the same guard as every outbound call — public addresses only
 * (checked on the URL and again on the address dialled, so DNS rebinding is refused) unless `allowPrivate` (the
 * owner's "allow local AI endpoints"), no redirects followed, an answer capped at `maxBytes`. The answer streams,
 * so a model's text reaches the person as it is written.
 */
export const guardedFetch =
  (opts: { allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number } = {}) =>
  async (
    input: string,
    init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal },
  ): Promise<Response> => {
    const url = await assertPublicUrl(input, opts.allowPrivate);
    const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {}))
      if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const req = send(
        url,
        { method: init.method, headers, timeout: timeoutMs, ...(opts.allowPrivate ? {} : { lookup: guardedLookup }) },
        (res: IncomingMessage) => {
          let size = 0;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on('data', (c: Buffer) => {
                size += c.length;
                if (size > maxBytes) {
                  res.destroy();
                  controller.error(new Error('response_too_large'));
                  return;
                }
                controller.enqueue(new Uint8Array(c));
              });
              res.on('end', () => controller.close());
              res.on('error', (err) => controller.error(err));
            },
            cancel() {
              res.destroy();
            },
          });
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
          const status = res.statusCode ?? 0;
          // A redirect is the answer, never followed (it could point inside the network).
          resolve(new Response(status === 204 || status === 304 ? null : body, { status, headers: h }));
        },
      );
      init.signal?.addEventListener('abort', () =>
        req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      req.on('error', (err: Error & { code?: string }) =>
        reject(err.code === 'EPRIVATE' ? new AppError('invalid_value', 'webhook_url_private') : err),
      );
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  };
