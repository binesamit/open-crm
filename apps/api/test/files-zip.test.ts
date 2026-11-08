// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { columns } from '../src/db/schema';
import { WEB_ORIGIN, createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * "Download all": a files cell's or an update's files as one streamed ZIP. Hebrew names keep their
 * letters (the UTF-8 flag), equal names get " (2)", every file is checked like a single download (a hidden column,
 * another account: 404), a file that cannot be included is counted in a note — never named; `check=1` answers the
 * same checks as JSON; the account's `downloads` setting turns it off and limits it.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let betaAdmin: string;
let boardId: string;
let itemId: string;
let columnId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const keyOf = async (fileId: string) =>
  (await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${fileId}`)).rows[0]!
    .storage_key;

/** Presign, "PUT" the bytes to storage, complete. */
const upload = async (cookie: string, name: string, text: string, mime = 'application/pdf') => {
  const bytes = Buffer.from(text, 'utf8');
  const pre = await body(await t.api(cookie, acmeId).post('/files/presign', { name, size: bytes.length, mime }));
  t.storage.markUploaded(await keyOf(pre.file_id), bytes.length, mime, bytes);
  expect((await t.api(cookie, acmeId).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};

/** A download as the browser makes it: the session cookie, the account in the query (no headers). */
const download = (cookie: string, path: string) =>
  t.app.request(`/api/v1${path}${path.includes('?') ? '&' : '?'}account_id=${acmeId}`, {
    headers: { origin: WEB_ORIGIN, cookie },
  });

const unzip = async (res: Response) => {
  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  return { buf, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString()])) };
};

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await body(
    await t.api(owner).post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
  );
  betaAdmin = await join('admin@beta.test');

  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'מסמכים', workspace_id: ws }))).id;
  columnId = (
    await body(await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, { title: 'קבצים', type: 'file' }))
  ).id;
  itemId = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'חוזה שכירות' }))).id;
});
afterAll(() => t.close());

describe('a files cell as one ZIP', () => {
  it('streams every file: Hebrew names kept, equal names numbered, the contents intact', async () => {
    const ids = [
      await upload(admin, 'דוח.pdf', 'first report'),
      await upload(admin, 'דוח.pdf', 'second report'),
      await upload(admin, 'photo.png', 'png bytes', 'image/png'),
    ];
    expect(
      (await t.api(admin, acmeId).post(`/items/${itemId}/cells/${columnId}/files`, { file_ids: ids })).status,
    ).toBe(200);
    const path = `/items/${itemId}/cells/${columnId}/files.zip`;

    // The app asks first: the same checks, as JSON.
    const check = await t.api(admin, acmeId).get(`${path}?check=1`);
    expect(check.status).toBe(200);
    expect(await body(check)).toEqual({ files: 3, skipped: 0 });

    const res = await download(bob, path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('חוזה שכירות - קבצים.zip')}`,
    );
    const { buf, files } = await unzip(res);
    expect(files).toEqual({ 'דוח.pdf': 'first report', 'דוח (2).pdf': 'second report', 'photo.png': 'png bytes' });
    // Every local header says "UTF-8 names" (bit 11) and "sizes after the data" (bit 3).
    const view = Buffer.from(buf);
    for (let at = view.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); at >= 0;) {
      expect(view.readUInt16LE(at + 6) & 0x0808).toBe(0x0808);
      at = view.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at + 4);
    }
  });

  it('a file that cannot be included is counted in a note, never named', async () => {
    const gone = await upload(admin, 'סודי ביותר.pdf', 'secret');
    await t.api(admin, acmeId).post(`/items/${itemId}/cells/${columnId}/files`, { file_ids: [gone] });
    t.storage.objects.delete(await keyOf(gone));
    const { files } = await unzip(await download(admin, `/items/${itemId}/cells/${columnId}/files.zip`));
    expect(Object.keys(files)).toHaveLength(4);
    const note = Object.entries(files).find(([name]) => name.endsWith('.txt'))!;
    expect(note[1]).toContain('1');
    expect(JSON.stringify(files)).not.toContain('סודי ביותר');
  });

  it('only for whoever may read the cell: another account and a hidden column answer 404', async () => {
    const path = `/items/${itemId}/cells/${columnId}/files.zip`;
    expect((await t.api(betaAdmin, acmeId).get(`${path}?check=1`)).status).toBe(404);
    expect((await download(betaAdmin, path)).status).toBe(404);
    const adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
    await t.db
      .update(columns)
      .set({ restrictedView: { users: [adminId], teams: [] } })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, columnId)));
    try {
      expect((await t.api(bob, acmeId).get(`${path}?check=1`)).status).toBe(404);
      expect((await download(admin, path)).status).toBe(200);
    } finally {
      await t.db
        .update(columns)
        .set({ restrictedView: null })
        .where(and(eq(columns.boardId, boardId), eq(columns.key, columnId)));
    }
    // A column that is not a files column.
    const text = (
      await body(await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, { title: 'הערה', type: 'text' }))
    ).id;
    expect((await t.api(admin, acmeId).get(`/items/${itemId}/cells/${text}/files.zip?check=1`)).status).toBe(404);
  });

  it("the account's setting: off = 403 zip_disabled; over the limits = 413", async () => {
    const path = `/items/${itemId}/cells/${columnId}/files.zip?check=1`;
    const set = (downloads: Json) => t.api(admin, acmeId).patch('/accounts/me', { settings: { downloads } });
    expect((await set({ zip_max_files: 2 })).status).toBe(200);
    let res = await t.api(bob, acmeId).get(path);
    expect(res.status).toBe(413);
    expect((await body(res)).error).toMatchObject({ message: 'zip_too_many_files', details: { max_files: 2 } });
    expect((await set({ zip_max_files: 200, zip_max_mb: 1 })).status).toBe(200);
    // Under 1 MB: fine. (The limit counts the files' own sizes.)
    expect((await t.api(bob, acmeId).get(path)).status).toBe(200);
    expect((await set({ zip_enabled: false })).status).toBe(200);
    res = await t.api(bob, acmeId).get(path);
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('zip_disabled');
    // Out of range values are refused; back on.
    expect((await set({ zip_max_files: 1 })).status).toBe(400);
    expect((await set({ zip_enabled: true, zip_max_mb: 1024 })).status).toBe(200);
  });
});

describe("an update's files as one ZIP", () => {
  it('the files of one update; the item must be readable', async () => {
    const ids = [await upload(bob, 'סיכום.docx', 'summary'), await upload(bob, 'נספח.txt', 'appendix', 'text/plain')];
    const u = await body(
      await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'מצרף שני קבצים', file_ids: ids }),
    );
    const res = await download(admin, `/updates/${u.id}/files.zip`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { files } = await unzip(res);
    expect(files).toEqual({ 'סיכום.docx': 'summary', 'נספח.txt': 'appendix' });
    expect((await t.api(betaAdmin, acmeId).get(`/updates/${u.id}/files.zip?check=1`)).status).toBe(404);
    expect((await t.api(admin, acmeId).get(`/updates/01ZZZZZZZZZZZZZZZZZZZZZZZZ/files.zip?check=1`)).status).toBe(404);
  });
});
