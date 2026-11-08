// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { diskStorage, localFilePath, type DiskStorage } from '../src/lib/disk-storage';
import { createTestContext, WEB_ORIGIN, type TestContext } from './helpers';

/** Standalone mode's local-disk files: signed upload / download links served by the API, same flow as S3. */
let t: TestContext;
let root: string;
let disk: DiskStorage;
let app: ReturnType<typeof createApp>;
let cookie: string;
let accountId: string;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      cookie,
      'x-account-id': accountId,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
const local = (url: string) => url.replace(WEB_ORIGIN, '');

beforeAll(async () => {
  t = await createTestContext({ env: { SEED_ADMIN_EMAIL: '' } });
  root = mkdtempSync(join(tmpdir(), 'bines-files-'));
  disk = diskStorage({ root, secret: 'test-secret-test-secret-test-secret-123', origin: async () => WEB_ORIGIN });
  app = createApp({ ...t.deps, storage: disk });
  const res = await app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery', name: 'Owner' }),
  });
  cookie = t.cookieFrom(res)!;
  accountId = ((await res.json()) as Json).account.id;
});
afterAll(async () => {
  await t.close();
  rmSync(root, { recursive: true, force: true });
});

const presign = async (name: string, bytes: Buffer, mime: string) => {
  const pre = (await (await call('POST', '/files/presign', { name, size: bytes.length, mime })).json()) as Json;
  expect(pre.upload_url).toMatch(new RegExp(`^${WEB_ORIGIN}/api/v1/files/local/`));
  return pre as { file_id: string; upload_url: string; headers: Record<string, string> };
};

describe('local disk storage', () => {
  it('upload → complete → download, bytes intact, on disk under the account', async () => {
    const bytes = Buffer.from('%PDF-1.4 hello');
    const pre = await presign('report.pdf', bytes, 'application/pdf');
    const put = await app.request(local(pre.upload_url), { method: 'PUT', headers: pre.headers, body: bytes });
    expect(put.status).toBe(200);
    const done = (await (await call('POST', `/files/${pre.file_id}/complete`)).json()) as Json;
    expect(done).toMatchObject({ size: bytes.length, mime: 'application/pdf' });

    const file = (await (await call('GET', `/files/${pre.file_id}`)).json()) as Json;
    const dl = await app.request(local(file.download_url));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''report\.pdf/);
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
    const stored = await readFile(join(root, accountId, pre.file_id, 'report.pdf'));
    expect(stored.equals(bytes)).toBe(true);

    // Range (audio / video seeking).
    const part = await app.request(local(file.download_url), { headers: { range: 'bytes=1-3' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 1-3/${bytes.length}`);
    expect(await part.text()).toBe('PDF');
  });

  it('refuses a forged, altered or reused-for-another-purpose link, and more bytes than announced', async () => {
    const bytes = Buffer.from('hello');
    const pre = await presign('a.txt', bytes, 'text/plain');
    const [base, mac] = pre.upload_url.split('.').slice(-2) as [string, string];
    expect(base).toBeTruthy();
    expect((await app.request(local(`${pre.upload_url}x`), { method: 'PUT', body: bytes })).status).toBe(403);
    expect(
      (await app.request(local(pre.upload_url.replace(mac, 'A'.repeat(mac.length))), { method: 'PUT' })).status,
    ).toBe(403);
    // An upload link cannot download.
    expect((await app.request(local(pre.upload_url))).status).toBe(403);
    const big = await app.request(local(pre.upload_url), { method: 'PUT', body: Buffer.from('hello world, longer') });
    expect(big.status).toBe(413);
  });

  it('an expired link is refused', async () => {
    const real = Date.now;
    const pre = await presign('late.txt', Buffer.from('x'), 'text/plain');
    try {
      Date.now = () => real() + 16 * 60 * 1000;
      expect((await app.request(local(pre.upload_url), { method: 'PUT', body: Buffer.from('x') })).status).toBe(403);
    } finally {
      Date.now = real;
    }
  });

  it('a page or script is never served inline from the app origin', async () => {
    const html = Buffer.from('<script>alert(1)</script>');
    const pre = await presign('page.html', html, 'text/html');
    await app.request(local(pre.upload_url), { method: 'PUT', headers: pre.headers, body: html });
    await call('POST', `/files/${pre.file_id}/complete`);
    const key = `${accountId}/${pre.file_id}/page.html`;
    const url = await disk.presignGet(key, 'page.html', { inline: true });
    const res = await app.request(local(url));
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    // An image asked inline is inline, with its type.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await disk.put(`${accountId}/img/a.png`, png, 'image/png');
    const img = await app.request(local(await disk.presignGet(`${accountId}/img/a.png`, 'a.png', { inline: true })));
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-disposition')).toMatch(/^inline/);
    // a recording stored without a type, linked with its media type, plays inline (Range included).
    await disk.put(`${accountId}/m/v.webm`, Buffer.from('webmdata'), 'application/octet-stream');
    const media = await disk.presignGet(`${accountId}/m/v.webm`, 'v.webm', { inline: true, contentType: 'video/webm' });
    const played = await app.request(local(media), { headers: { range: 'bytes=0-3' } });
    expect(played.status).toBe(206);
    expect(played.headers.get('content-type')).toBe('video/webm');
    expect(played.headers.get('content-disposition')).toMatch(/^inline/);
    // The type is part of the signed link: a page type asked that way is still not inline.
    const page = await disk.presignGet(`${accountId}/m/v.webm`, 'v.webm', { inline: true, contentType: 'text/html' });
    expect((await app.request(local(page))).headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('keys never leave the folder; server-side put / get / remove work', async () => {
    expect(() => localFilePath(root, '../x')).toThrow('invalid_storage_key');
    expect(() => localFilePath(root, 'a/../../x')).toThrow('invalid_storage_key');
    expect(() => localFilePath(root, '/etc/passwd')).toThrow('invalid_storage_key');
    await expect(disk.presignPut('a/../../x', 'text/plain', 1)).rejects.toThrow('invalid_storage_key');
    await disk.put('k/one.txt', Buffer.from('one'), 'text/plain');
    expect(await disk.head('k/one.txt')).toEqual({ size: 3, mime: 'text/plain' });
    expect((await disk.get('k/one.txt', 10))?.toString()).toBe('one');
    expect(await disk.get('k/one.txt', 2)).toBeNull();
    await disk.remove('k/one.txt');
    expect(await disk.head('k/one.txt')).toBeNull();
  });

  it('copies an object server-side (a file version made current again)', async () => {
    await disk.put('k/src.pdf', Buffer.from('bytes'), 'application/pdf');
    await disk.copy('k/src.pdf', 'k2/copy.pdf');
    expect(await disk.head('k2/copy.pdf')).toEqual({ size: 5, mime: 'application/pdf' });
    expect((await disk.get('k2/copy.pdf', 10))?.toString()).toBe('bytes');
    await expect(disk.copy('k/missing.pdf', 'k2/x.pdf')).rejects.toThrow();
    await expect(disk.copy('k/src.pdf', '../x')).rejects.toThrow('invalid_storage_key');
  });
});
