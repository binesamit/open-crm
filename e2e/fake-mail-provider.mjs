// SPDX-License-Identifier: AGPL-3.0-only
// Test-only stand-in for the mail provider's receiving API, started by playwright.config.ts: the API's
// RESEND_API_BASE points here, so a spec delivers an email without Resend. A spec stores a message
// (POST /__messages), then sends the signed webhook to the API; the API's job reads the message, its attachments and
// their files from here, and the image proxy fetches the message's images from the web (/img/…) from here too.
import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';

const PORT = Number(process.env.FAKE_MAIL_PORT ?? 3998);
const messages = new Map();

/** A PNG of w×h: noise (a photo-like file that does not compress) or one colour (a tiny signature image). */
const png = (w, h, noise) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let seed = 7;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[y * (w * 3 + 1) + 1 + x] = noise ? (seed >> 16) & 0xff : 90;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** An attachment's bytes: given (base64), or a generated PNG ({png: {w, h, noise}}). */
const bytesOf = (a) => (a.png ? png(a.png.w, a.png.h, !!a.png.noise) : Buffer.from(a.base64 ?? '', 'base64'));

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const origin = `http://${req.headers.host}`;
  if (pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && pathname === '/__messages') {
    let body = '';
    for await (const c of req) body += c;
    const m = JSON.parse(body);
    messages.set(m.id, { ...m, attachments: (m.attachments ?? []).map((a) => ({ ...a, bytes: bytesOf(a) })) });
    return json(res, 200, { ok: true });
  }
  let match = /^\/emails\/receiving\/([^/]+)$/.exec(pathname);
  if (match) {
    const m = messages.get(decodeURIComponent(match[1]));
    if (!m) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { object: 'email', id: m.id, raw: null, ...m.email });
  }
  match = /^\/emails\/receiving\/([^/]+)\/attachments$/.exec(pathname);
  if (match) {
    const m = messages.get(decodeURIComponent(match[1]));
    if (!m) return json(res, 404, { error: 'not_found' });
    return json(res, 200, {
      data: m.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        content_disposition: a.content_disposition ?? null,
        content_id: a.content_id ?? null,
        size: a.bytes.length,
        download_url: `${origin}/files/${encodeURIComponent(m.id)}/${encodeURIComponent(a.id)}`,
      })),
    });
  }
  match = /^\/files\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (match) {
    const a = messages
      .get(decodeURIComponent(match[1]))
      ?.attachments.find((x) => x.id === decodeURIComponent(match[2]));
    if (!a) return json(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': a.content_type });
    return res.end(a.bytes);
  }
  // A message's image from the web (/img/<name>.png): a small picture.
  if (/^\/img\/[\w-]+\.png$/.test(pathname)) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(png(120, 40, false));
  }
  return json(res, 404, { error: 'not_found' });
}).listen(PORT, '127.0.0.1');
