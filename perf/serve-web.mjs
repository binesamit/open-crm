// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A production-like static host for a built web app (gzip, immutable assets, SPA fallback) with /api proxied to
 * a local API — for Lighthouse runs (docs/PERFORMANCE-REVIEW.md). Not used by the app.
 *   node perf/serve-web.mjs <dist dir> [port=4173] [api=http://localhost:3100]
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { createGzip } from 'node:zlib';

const [dir, port = '4173', api = 'http://localhost:3100'] = process.argv.slice(2);
if (!dir) throw new Error('usage: node perf/serve-web.mjs <dist dir> [port] [api]');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const index = readFileSync(join(dir, 'index.html'));
const target = new URL(api);

createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const up = request(
      {
        host: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
    return;
  }
  const path = normalize(join(dir, decodeURIComponent(req.url.split('?')[0])));
  const file = path.startsWith(normalize(dir)) && existsSync(path) && statSync(path).isFile() ? path : null;
  const type = TYPES[file ? extname(file) : '.html'] ?? 'application/octet-stream';
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  res.setHeader('content-type', type);
  res.setHeader(
    'cache-control',
    file?.includes('/assets/') || file?.includes('\\assets\\') ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
  if (gzip) res.setHeader('content-encoding', 'gzip');
  const out = gzip ? createGzip() : null;
  if (out) out.pipe(res);
  const sink = out ?? res;
  if (file) createReadStream(file).pipe(sink);
  else sink.end(index);
}).listen(Number(port), () => console.warn(`web ${dir} on http://localhost:${port} → api ${api}`));
