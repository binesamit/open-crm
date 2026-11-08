// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { isInlineSafeMime, type FileStorage } from './storage';

/**
 * Files on the local disk (standalone mode, or any install with FILES_DIR and no S3): `FILES_DIR/<key>` plus a
 * `<key>.meta.json` beside it (type and size). The browser still never gets a raw path: like presigned S3 URLs, every
 * upload / download link is short-lived and signed (HMAC of the installation's secret), and only this server can
 * make one. The API checks access before it makes a link, exactly as with S3 — the link itself is the permission.
 *
 * The bytes are served from the app's own origin, so a download is never rendered as a page: only the types a browser
 * shows without running code (isInlineSafeMime) may be inline; everything else is an attachment, with nosniff.
 */
export const LOCAL_FILES_PATH = '/api/v1/files/local';

const UPLOAD_TTL = 15 * 60;
const DOWNLOAD_TTL = 15 * 60;
const META = '.meta.json';

type LinkPayload =
  | { o: 'p'; k: string; e: number; m: string; s: number }
  /** `t`: serve as this type instead of the stored one (a media file stored without a type). */
  | { o: 'g'; k: string; e: number; d: string; i: boolean; t?: string };

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export type DiskStorage = FileStorage & {
  readonly root: string;
  /** Reads a link made by this storage; null when forged, altered or expired. */
  verify(token: string): LinkPayload | null;
  pathOf(key: string): string;
};

const disks = new WeakSet<object>();
export const isDiskStorage = (s: FileStorage): s is DiskStorage => disks.has(s);

/** `FILES_DIR/<key>`, refusing anything that would leave the folder (`..`, absolute paths, NUL). */
export const localFilePath = (root: string, key: string) => {
  const base = resolve(root);
  const parts = key.split('/');
  if (!key || key.includes('\0') || key.includes('\\') || parts.some((p) => !p || p === '.' || p === '..'))
    throw new Error('invalid_storage_key');
  const full = resolve(base, ...parts);
  if (!full.startsWith(base + sep)) throw new Error('invalid_storage_key');
  return full;
};

export const diskStorage = (opts: {
  root: string;
  /** The installation's secret (BETTER_AUTH_SECRET); the link key is derived from it. */
  secret: string;
  /** The API's public origin (owner console, else WEB_ORIGIN) — links are absolute, like S3's. */
  origin: () => Promise<string>;
}): DiskStorage => {
  const root = resolve(opts.root);
  const key = createHmac('sha256', opts.secret).update('bines:file-links:v1').digest();
  const sign = (body: string) => createHmac('sha256', key).update(body).digest();
  const link = async (payload: LinkPayload) => {
    const body = b64(JSON.stringify(payload));
    return `${(await opts.origin()).replace(/\/+$/, '')}${LOCAL_FILES_PATH}/${body}.${b64(sign(body))}`;
  };
  const exp = (ttl: number) => Math.floor(Date.now() / 1000) + ttl;

  const storage: DiskStorage = {
    root,
    pathOf: (k) => localFilePath(root, k),
    verify(token) {
      const [body, mac] = token.split('.');
      if (!body || !mac) return null;
      const want = sign(body);
      const got = Buffer.from(mac, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkPayload;
        return p.e >= Date.now() / 1000 ? p : null;
      } catch {
        return null;
      }
    },
    async presignPut(k, mime, size) {
      localFilePath(root, k);
      return {
        url: await link({ o: 'p', k, e: exp(UPLOAD_TTL), m: mime, s: size }),
        headers: { 'content-type': mime },
      };
    },
    async presignGet(k, fileName, o) {
      localFilePath(root, k);
      const d = `${o?.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
      return link({
        o: 'g',
        k,
        e: exp(o?.ttl ?? DOWNLOAD_TTL),
        d,
        i: !!o?.inline,
        ...(o?.contentType ? { t: o.contentType } : {}),
      });
    },
    async head(k) {
      try {
        const path = localFilePath(root, k);
        const [st, meta] = await Promise.all([stat(path), readFile(path + META, 'utf8').catch(() => '{}')]);
        const m = JSON.parse(meta) as { mime?: string };
        return { size: st.size, mime: m.mime || 'application/octet-stream' };
      } catch {
        return null;
      }
    },
    async remove(k) {
      const path = localFilePath(root, k);
      await rm(path, { force: true });
      await rm(path + META, { force: true });
    },
    async copy(from, to) {
      const src = localFilePath(root, from);
      const meta = JSON.parse(await readFile(src + META, 'utf8').catch(() => '{}')) as { mime?: string };
      const { size } = await stat(src);
      await writeObject(localFilePath(root, to), createReadStream(src), meta.mime || 'application/octet-stream', size);
    },
    async put(k, body, mime) {
      await writeObject(localFilePath(root, k), Readable.from([body]), mime, body.length);
    },
    async putFile(k, from, mime) {
      const { size } = await stat(from);
      await writeObject(localFilePath(root, k), createReadStream(from), mime, size);
    },
    async getStream(k) {
      try {
        const path = localFilePath(root, k);
        await stat(path);
        return createReadStream(path);
      } catch {
        return null;
      }
    },
    async get(k, maxBytes) {
      try {
        const path = localFilePath(root, k);
        if ((await stat(path)).size > maxBytes) return null;
        return await readFile(path);
      } catch {
        return null;
      }
    },
  };
  disks.add(storage);
  return storage;
};

/** Streams into a temporary file, then moves it into place (a half-written upload is never served). */
const writeObject = async (path: string, body: Readable, mime: string, maxBytes: number) => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.part`;
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new Error('too_large') : null, chunk);
    },
  });
  try {
    await pipeline(body, count, createWriteStream(tmp));
    await writeFile(`${path}${META}`, JSON.stringify({ mime, size: bytes }));
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return bytes;
};

const safeContentType = (mime: string, inline: boolean) =>
  inline && isInlineSafeMime(mime) ? mime : 'application/octet-stream';

/** `bytes=a-b` → the range within `size`, or null (a missing / unsupported header = the whole file). */
const parseRange = (header: string | undefined, size: number): { start: number; end: number } | 'bad' | null => {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? 'bad' : { start, end };
};

/**
 * The links' endpoint: PUT (the browser's upload, at most the size the API agreed to) and GET / HEAD (download,
 * with Range for audio / video). Mounted on the app itself, outside /api/v1's JSON body limit and session.
 */
export const mountDiskFiles = (app: OpenAPIHono<AppEnv>, storage: DiskStorage) => {
  const path = `${LOCAL_FILES_PATH}/:token`;
  app.put(path, async (c) => {
    const p = storage.verify(c.req.param('token'));
    if (!p || p.o !== 'p') return c.json({ error: { code: 'forbidden', message: 'Invalid or expired link' } }, 403);
    const declared = Number(c.req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > p.s)
      return c.json({ error: { code: 'payload_too_large', message: 'Larger than announced' } }, 413);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: { code: 'invalid_value', message: 'Empty upload' } }, 400);
    try {
      await writeObject(
        storage.pathOf(p.k),
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        p.m,
        p.s,
      );
    } catch (err) {
      if ((err as Error).message === 'too_large')
        return c.json({ error: { code: 'payload_too_large', message: 'Larger than announced' } }, 413);
      throw err;
    }
    return c.body(null, 200);
  });
  app.on(['GET', 'HEAD'], path, async (c) => {
    const p = storage.verify(c.req.param('token'));
    if (!p || p.o !== 'g') return c.json({ error: { code: 'forbidden', message: 'Invalid or expired link' } }, 403);
    const file = storage.pathOf(p.k);
    const meta = await storage.head(p.k);
    if (!meta) return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404);
    const mime = p.t ?? meta.mime;
    const inline = p.i && isInlineSafeMime(mime);
    const headers: Record<string, string> = {
      'content-type': safeContentType(mime, inline),
      'content-disposition': inline ? p.d : p.d.replace(/^inline/, 'attachment'),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=300',
    };
    const range = parseRange(c.req.header('range'), meta.size);
    if (range === 'bad') return c.body(null, 416, { ...headers, 'content-range': `bytes */${meta.size}` });
    const { start, end } = range ?? { start: 0, end: meta.size - 1 };
    const length = meta.size === 0 ? 0 : end - start + 1;
    headers['content-length'] = String(length);
    if (range) headers['content-range'] = `bytes ${start}-${end}/${meta.size}`;
    const status = range ? 206 : 200;
    if (c.req.method === 'HEAD' || length === 0) return c.body(null, status, headers);
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return c.body(stream, status, headers);
  });
};
