// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** E7 files: presign → upload → complete → attach to a cell / update; downloads through item access. */
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let boardId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** Simulates the browser: presign, "PUT" to storage, complete. */
const upload = async (cookie: string, accountId: string, name: string, size = 1234, mime = 'application/pdf') => {
  const pre = await body(await t.api(cookie, accountId).post('/files/presign', { name, size, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, size, mime);
  const done = await t.api(cookie, accountId).post(`/files/${pre.file_id}/complete`);
  expect(done.status).toBe(200);
  return pre.file_id as string;
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  betaId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
    )
  ).account.id;
  betaAdmin = await join('admin@beta.test');

  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'מסמכים', workspace_id: ws }))).id;
  await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, { id: 'docs', title: 'מסמכים', type: 'file' });
  itemId = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'חוזה' }))).id;
});
afterAll(() => t.close());

describe('uploads', () => {
  it('completing before the object exists fails; oversize files are refused', async () => {
    const pre = await body(
      await t.api(admin, acmeId).post('/files/presign', { name: 'a.pdf', size: 10, mime: 'application/pdf' }),
    );
    expect(pre.upload_url).toContain('storage.test');
    expect((await t.api(admin, acmeId).post(`/files/${pre.file_id}/complete`)).status).toBe(422);
    expect((await t.api(admin, acmeId).post('/files/presign', { name: 'big', size: 600 * 1024 * 1024 })).status).toBe(
      413,
    );
  });

  it('account viewers cannot upload', async () => {
    expect((await t.api(vera, acmeId).post('/files/presign', { name: 'a', size: 1 })).status).toBe(403);
  });

  it('a Content-Type sent twice ("a, a") is stored once instead of failing the upload', async () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const pre = await body(
      await t.api(admin, acmeId).post('/files/presign', { name: 'q.docx', size: 53502, mime: docx }),
    );
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 53502, `${docx}, ${docx}`);
    const done = await t.api(admin, acmeId).post(`/files/${pre.file_id}/complete`);
    expect(done.status).toBe(200);
    expect((await body(done)).mime).toBe(docx);
    const row = await t.db.execute<{ mime: string; upload_status: string }>(
      sql`select mime, upload_status from assets where id = ${pre.file_id}`,
    );
    expect(row.rows[0]).toEqual({ mime: docx, upload_status: 'uploaded' });
  });
});

describe('file cells', () => {
  let fileId: string;

  it('attaches an upload to a file cell; the cell lists it', async () => {
    fileId = await upload(admin, acmeId, 'חוזה חתום.pdf');
    expect((await t.api(admin, acmeId).post(`/items/${itemId}/cells/docs/files`, { file_ids: [fileId] })).status).toBe(
      200,
    );
    const item = await body(await t.api(admin, acmeId).get(`/items/${itemId}`));
    expect(item.cells.docs.text).toBe('חוזה חתום.pdf');
    expect(item.cells.docs.value.files[0]).toMatchObject({ asset_id: fileId, name: 'חוזה חתום.pdf', size: 1234 });
  });

  it('only the uploader can attach their file', async () => {
    const res = await t.api(bob, acmeId).post(`/items/${itemId}/cells/docs/files`, { file_ids: [fileId] });
    expect(res.status).toBe(422);
  });

  it('readers of the item get a signed download link; other accounts get 404', async () => {
    const asBob = await body(await t.api(bob, acmeId).get(`/files/${fileId}`));
    expect(asBob.download_url).toContain('?download');
    expect((await t.api(vera, acmeId).get(`/files/${fileId}`)).status).toBe(200);
    expect((await t.api(betaAdmin, betaId).get(`/files/${fileId}`)).status).toBe(404);
  });

  it('a private board hides its files from non-subscribers', async () => {
    const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
    const priv = (
      await body(await t.api(admin, acmeId).post('/boards', { name: 'סודי', workspace_id: ws, kind: 'private' }))
    ).id;
    await t.api(admin, acmeId).post(`/boards/${priv}/columns`, { id: 'docs', title: 'מסמכים', type: 'file' });
    const secretItem = (await body(await t.api(admin, acmeId).post(`/boards/${priv}/items`, { name: 'שכר' }))).id;
    const secret = await upload(admin, acmeId, 'salary.pdf');
    await t.api(admin, acmeId).post(`/items/${secretItem}/cells/docs/files`, { file_ids: [secret] });
    expect((await t.api(bob, acmeId).get(`/files/${secret}`)).status).toBe(404);
  });

  it('removing the last file clears the cell', async () => {
    expect((await t.api(admin, acmeId).del(`/items/${itemId}/cells/docs/files/${fileId}`)).status).toBe(200);
    const item = await body(await t.api(admin, acmeId).get(`/items/${itemId}`));
    expect(item.cells.docs).toBeUndefined();
  });

  it('file cells are written only through the files endpoints', async () => {
    const res = await t.api(admin, acmeId).put(`/items/${itemId}/cells/docs`, { value: { files: [] } });
    expect(res.status).toBe(422);
  });
});

describe('files on updates', () => {
  it('attaches files to an update and lets item readers download them', async () => {
    const f = await upload(bob, acmeId, 'screenshot.png');
    const u = await body(
      await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'מצרף צילום', file_ids: [f] }),
    );
    expect(u.files).toEqual([{ id: f, name: 'screenshot.png', size: 1234, mime: 'application/pdf' }]);
    expect((await t.api(admin, acmeId).get(`/files/${f}`)).status).toBe(200);
    expect((await t.api(betaAdmin, betaId).get(`/files/${f}`)).status).toBe(404);
  });

  it('inline=1 gives a viewing link (the file viewer); access is the same', async () => {
    const f = await upload(bob, acmeId, 'plan.pdf');
    await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'תוכנית', file_ids: [f] });
    const res = await t.api(admin, acmeId).get(`/files/${f}?inline=1`);
    expect(res.status).toBe(200);
    expect((await body(res)).download_url).toContain('storage.test');
    expect((await t.api(betaAdmin, betaId).get(`/files/${f}?inline=1`)).status).toBe(404);
  });

  it('a media file stored without a type plays in place, served as its kind', async () => {
    const f = await upload(bob, acmeId, 'voice.m4a', 2048, 'application/octet-stream');
    await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'הקלטה', file_ids: [f] });
    const seen: unknown[] = [];
    const presignGet = t.deps.storage.presignGet;
    t.deps.storage.presignGet = async (...args) => {
      seen.push(args[2]);
      return presignGet(...args);
    };
    try {
      expect((await t.api(admin, acmeId).get(`/files/${f}?inline=1`)).status).toBe(200);
      expect((await t.api(admin, acmeId).get(`/files/${f}`)).status).toBe(200);
    } finally {
      t.deps.storage.presignGet = presignGet;
    }
    expect(seen).toEqual([{ inline: true, contentType: 'audio/mp4' }, undefined]);
  });

  it('a page or SVG renamed to a media name is never served inline nor as media', async () => {
    const page = await upload(bob, acmeId, 'page.mp4', 100, 'text/html');
    const svg = await upload(bob, acmeId, 'pic.svg', 100, 'application/octet-stream');
    await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'קבצים', file_ids: [page, svg] });
    const seen: unknown[] = [];
    const presignGet = t.deps.storage.presignGet;
    t.deps.storage.presignGet = async (...args) => {
      seen.push(args[2]);
      return presignGet(...args);
    };
    try {
      expect((await t.api(admin, acmeId).get(`/files/${page}?inline=1`)).status).toBe(200);
      expect((await t.api(admin, acmeId).get(`/files/${svg}?inline=1`)).status).toBe(200);
    } finally {
      t.deps.storage.presignGet = presignGet;
    }
    expect(seen).toEqual([undefined, undefined]);
  });

  it('a comment on a file (the viewer) keeps the file id on its document', async () => {
    const f = await upload(bob, acmeId, 'photo.png', 99, 'image/png');
    const u = await body(await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'תמונה', file_ids: [f] }));
    const doc = {
      type: 'doc',
      attrs: { file_id: f },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'על הקובץ photo.png: יפה' }] }],
    };
    const reply = await t.api(admin, acmeId).post(`/updates/${u.id}/replies`, { doc });
    expect(reply.status).toBe(200);
    expect((await body(reply)).body_json.attrs).toEqual({ file_id: f });
  });

  it('the author (or an admin) removes a file from an update; others may not', async () => {
    const f = await upload(bob, acmeId, 'draft.docx');
    const g = await upload(bob, acmeId, 'final.docx');
    const u = await body(
      await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'טיוטה', file_ids: [f, g] }),
    );
    expect((await t.api(vera, acmeId).del(`/updates/${u.id}/files/${f}`)).status).toBe(403);
    expect((await t.api(bob, acmeId).del(`/updates/${u.id}/files/${f}`)).status).toBe(200);
    expect((await t.api(bob, acmeId).del(`/updates/${u.id}/files/${f}`)).status).toBe(404);
    expect((await t.api(admin, acmeId).del(`/updates/${u.id}/files/${g}`)).status).toBe(200);
    const list = await body(await t.api(admin, acmeId).get(`/items/${itemId}/updates`));
    expect(list.data.find((x: Json) => x.id === u.id).files).toEqual([]);
  });
});

describe('profile photo (M1.1 #6)', () => {
  const bobRow = async () =>
    (await body(await t.api(admin, acmeId).get('/users'))).data.find((m: Json) => m.email === 'bob@acme.test');

  it('sets, shows and removes my photo; only my own image uploads qualify', async () => {
    expect((await bobRow()).avatar_url).toBeNull();
    const photo = await upload(bob, acmeId, 'me.png', 2048, 'image/png');
    const set = await body(await t.api(bob, acmeId).put('/users/me/avatar', { file_id: photo }));
    expect(set.avatar_url).toContain('storage.test');
    expect((await bobRow()).avatar_url).toContain('storage.test');
    expect((await body(await t.api(bob).get('/auth/me'))).user.avatar_url).toContain('storage.test');

    const pdf = await upload(bob, acmeId, 'cv.pdf');
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: pdf })).status).toBe(422);
    // S-14: an SVG can carry script — never a profile photo
    const svg = await upload(bob, acmeId, 'me.svg', 500, 'image/svg+xml');
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: svg })).status).toBe(422);
    const big = await upload(bob, acmeId, 'big.png', 6 * 1024 * 1024, 'image/png');
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: big })).status).toBe(413);
    const adminPhoto = await upload(admin, acmeId, 'admin.png', 1000, 'image/png');
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: adminPhoto })).status).toBe(422);

    const removed = await body(await t.api(bob, acmeId).del('/users/me/avatar'));
    expect(removed.avatar_url).toBeNull();
    expect((await bobRow()).avatar_url).toBeNull();
  });

  it('without file storage a photo is just missing: the people list, my profile and the mention list still answer', async () => {
    const photo = await upload(bob, acmeId, 'me.png', 2048, 'image/png');
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: photo })).status).toBe(200);
    // An installation whose storage is gone (no S3, no files folder): every link answers storage_not_configured.
    const presignGet = t.deps.storage.presignGet;
    t.deps.storage.presignGet = async () => {
      throw new Error('storage_not_configured');
    };
    try {
      const people = await t.api(admin, acmeId).get('/users');
      expect(people.status).toBe(200);
      expect((await body(people)).data.find((m: Json) => m.email === 'bob@acme.test').avatar_url).toBeNull();
      expect((await body(await t.api(bob).get('/auth/me'))).user.avatar_url).toBeNull();
      // A file someone asked to download still says why it cannot.
      const pdf = await upload(bob, acmeId, 'cv.pdf');
      expect((await t.api(bob, acmeId).get(`/files/${pdf}`)).status).toBeGreaterThanOrEqual(500);
    } finally {
      t.deps.storage.presignGet = presignGet;
    }
    await t.api(bob, acmeId).del('/users/me/avatar');
  });

  it('accepts PNG / JPEG / WebP only (never SVG); a replaced or removed photo leaves storage', async () => {
    const svg = await upload(bob, acmeId, 'me.svg', 500, 'image/svg+xml');
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: svg })).status).toBe(422);
    const keyOf = async (id: string) =>
      (await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${id}`)).rows[0]
        ?.storage_key;
    const first = await upload(bob, acmeId, 'one.jpg', 900, 'image/jpeg');
    const firstKey = (await keyOf(first))!;
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: first })).status).toBe(200);
    const second = await upload(bob, acmeId, 'two.webp', 900, 'image/webp');
    const secondKey = (await keyOf(second))!;
    expect((await t.api(bob, acmeId).put('/users/me/avatar', { file_id: second })).status).toBe(200);
    expect(t.storage.objects.has(firstKey)).toBe(false);
    expect(await keyOf(first)).toBeUndefined();
    expect(t.storage.objects.has(secondKey)).toBe(true);
    expect((await t.api(bob, acmeId).del('/users/me/avatar')).status).toBe(200);
    expect(t.storage.objects.has(secondKey)).toBe(false);
  });
});

describe('audit 2026-10-10 security #21 — a file name that is a path step', () => {
  it('"." and ".." become "file"; ordinary names keep their letters', async () => {
    const { safeName } = await import('../src/modules/files/files.service');
    expect(safeName('..')).toBe('file');
    expect(safeName('.')).toBe('file');
    expect(safeName('...')).toBe('file');
    expect(safeName('..hidden')).toBe('..hidden');
    expect(safeName('דוח 2026.pdf')).toBe('דוח_2026.pdf');
  });
});
