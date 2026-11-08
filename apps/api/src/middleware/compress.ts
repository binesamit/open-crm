// SPDX-License-Identifier: AGPL-3.0-only
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';

const gzipAsync = promisify(gzip);
/** Below this a JSON answer goes as is: gzip costs more than it saves. */
export const GZIP_MIN_BYTES = 8 * 1024;

/**
 * gzip for large JSON answers (perf review: a 30k-item board is ~44 MB of JSON, ~4 MB gzipped — seconds on a real
 * network). Compression runs on libuv's thread pool (async zlib), not on the event loop. `c.json` sets no
 * Content-Length, so Hono's own `compress()` would gzip every tiny answer; this one measures first. Event
 * streams and anything already encoded are left alone.
 */
export const gzipJson = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    await next();
    const res = c.res;
    if (
      c.req.method === 'HEAD' ||
      !res.body ||
      res.headers.has('content-encoding') ||
      !res.headers.get('content-type')?.startsWith('application/json') ||
      !/\bgzip\b/i.test(c.req.header('accept-encoding') ?? '')
    )
      return;
    const raw = Buffer.from(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    headers.append('Vary', 'Accept-Encoding');
    if (raw.byteLength < GZIP_MIN_BYTES) {
      c.res = new Response(raw, { status: res.status, headers });
      return;
    }
    const zipped = await gzipAsync(raw, { level: 5 });
    headers.set('Content-Encoding', 'gzip');
    headers.set('Content-Length', String(zipped.byteLength));
    c.res = new Response(zipped, { status: res.status, headers });
  });
