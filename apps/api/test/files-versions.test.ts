// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeOrphanFiles, purgeTrash } from '../../worker/src/tasks';
import { unusedAssets as workerUnused } from '../../worker/src/repositories/files.repo';
import { storedAssetsBatch } from '../src/modules/account-deletion/account-deletion.repo';
import { storageBytesUsed } from '../src/modules/billing/plans.repo';
import { unusedAssets } from '../src/modules/files/files.repo';
import { WEB_ORIGIN, createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * File versions: a file in a files cell gets new versions; the cell keeps one file at its current
 * version; old versions are read through the file's access, made current again (as a copy) or deleted; removing the
 * file from its cell sends it with all its versions to the trash; nothing that sweeps storage touches a version
 * while its file is in use.
 */
let t: TestContext;
let admin: string;
let bob: string;
let carol: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const keyOf = async (id: string) =>
  (await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${id}`)).rows[0]
    ?.storage_key;
const stored = (key: string) => t.storage.objects.has(key);
const rowExists = async (id: string) => (await keyOf(id)) !== undefined;
const remove = async (key: string) => void t.storage.objects.delete(key);
const noLog = () => undefined;

/** presign → "PUT" (with bytes) → complete. */
const upload = async (cookie: string, name: string, text = name) => {
  const bytes = Buffer.from(text, 'utf8');
  const pre = await body(await as(cookie).post('/files/presign', { name, size: bytes.length, mime: 'text/plain' }));
  const key = (await keyOf(pre.file_id))!;
  t.storage.markUploaded(key, bytes.length, 'text/plain', bytes);
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return { id: pre.file_id as string, key, size: bytes.length };
};
const newItem = async (name: string) => body(await as(admin).post(`/boards/${boardId}/items`, { name }));
const cellFiles = async (itemId: string) =>
  (await body(await as(admin).get(`/items/${itemId}`))).cells.docs?.value.files;
const addVersion = (cookie: string, rootId: string, fileId: string) =>
  as(cookie).post(`/files/${rootId}/versions`, { file_id: fileId });

/** An item with a file of three versions: v1 (admin), v2 (bob), v3 (admin). */
const threeVersions = async (name: string) => {
  const item = await newItem(name);
  const v1 = await upload(admin, `${name}-1.txt`, 'one');
  await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [v1.id] });
  const v2 = await upload(bob, `${name}-2.txt`, 'two two');
  expect((await addVersion(bob, v1.id, v2.id)).status).toBe(200);
  const v3 = await upload(admin, `${name}-3.txt`, 'three three three');
  const res = await addVersion(admin, v1.id, v3.id);
  expect(res.status).toBe(200);
  expect(await body(res)).toMatchObject({ id: v3.id, version: 3, current: true, created_by: { name: 'admin' } });
  return { item, v1, v2, v3 };
};

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  betaId = await mk('Beta', 'beta', 'admin@beta.test');
  betaAdmin = await join('admin@beta.test');
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Docs', workspace_id: ws }))).id;
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'docs', title: 'Docs', type: 'file' });
});
afterAll(() => t.close());

describe('new versions', () => {
  it('the cell keeps one file at its current version; the file id serves the current bytes', async () => {
    const { item, v1, v3 } = await threeVersions('contract');
    const files = await cellFiles(item.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ asset_id: v1.id, name: 'contract-3.txt', size: v3.size, version: 3 });
    expect((await body(await as(admin).get(`/items/${item.id}`))).cells.docs.text).toBe('contract-3.txt');

    const root = await body(await as(bob).get(`/files/${v1.id}`));
    expect(root).toMatchObject({ id: v1.id, name: 'contract-3.txt', size: v3.size, version: 3 });
    expect(root.download_url).toContain(v3.key);
    // `exact=1`: the file itself — version 1, for the viewer's versions tab.
    const first = await body(await as(bob).get(`/files/${v1.id}?exact=1`));
    expect(first).toMatchObject({ id: v1.id, name: 'contract-1.txt', size: v1.size, version: 1 });
    expect(first.download_url).toContain(v1.key);
  });

  it('lists versions newest first with their uploaders; any reader of the file may list', async () => {
    const { v1, v2, v3 } = await threeVersions('list');
    const list = (await body(await as(carol).get(`/files/${v1.id}/versions`))).data;
    expect(list.map((v: Json) => [v.id, v.version, v.current])).toEqual([
      [v3.id, 3, true],
      [v2.id, 2, false],
      [v1.id, 1, false],
    ]);
    expect(list[1]).toMatchObject({ name: 'list-2.txt', size: v2.size, created_by: { name: 'bob' } });
    expect(typeof list[1].created_at).toBe('string');
    expect((await t.api(betaAdmin, betaId).get(`/files/${v1.id}/versions`)).status).toBe(404);
    // A version's id is not a file's id here.
    expect((await as(admin).get(`/files/${v2.id}/versions`)).status).toBe(404);
  });

  it('an old version is read through the file: readers yes, another account or a non-reader 404', async () => {
    const { v1, v2 } = await threeVersions('read');
    const old = await body(await as(carol).get(`/files/${v2.id}`));
    expect(old).toMatchObject({ id: v2.id, name: 'read-2.txt', version: 2 });
    expect(old.download_url).toContain(v2.key);
    expect((await t.api(betaAdmin, betaId).get(`/files/${v2.id}`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).get(`/files/${v1.id}`)).status).toBe(404);

    // A private board: its file's versions are hidden from a non-subscriber.
    const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const priv = await body(await as(admin).post('/boards', { name: 'Secret', workspace_id: ws, kind: 'private' }));
    await as(admin).post(`/boards/${priv.id}/columns`, { id: 'docs', title: 'Docs', type: 'file' });
    const item = await body(await as(admin).post(`/boards/${priv.id}/items`, { name: 'pay' }));
    const f = await upload(admin, 'pay-1.txt');
    await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [f.id] });
    const g = await upload(admin, 'pay-2.txt');
    expect((await addVersion(admin, f.id, g.id)).status).toBe(200);
    expect((await as(carol).get(`/files/${g.id}`)).status).toBe(404);
    expect((await as(carol).get(`/files/${f.id}/versions`)).status).toBe(404);
    expect((await addVersion(carol, f.id, (await upload(carol, 'x.txt')).id)).status).toBe(404);
  });

  it('only a fresh own upload becomes a version; a viewer-only column edit restriction refuses', async () => {
    const item = await newItem('rules');
    const f = await upload(admin, 'rules.txt');
    await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [f.id] });
    // Someone else's upload.
    expect((await addVersion(admin, f.id, (await upload(bob, 'b.txt')).id)).status).toBe(422);
    // An upload already attached somewhere.
    const attached = await upload(admin, 'attached.txt');
    await as(admin).post(`/items/${(await newItem('other')).id}/cells/docs/files`, { file_ids: [attached.id] });
    expect((await addVersion(admin, f.id, attached.id)).status).toBe(409);
    // A version cannot be attached to another cell.
    const v = await upload(admin, 'v.txt');
    expect((await addVersion(admin, f.id, v.id)).status).toBe(200);
    expect(
      (await as(admin).post(`/items/${(await newItem('elsewhere')).id}/cells/docs/files`, { file_ids: [v.id] })).status,
    ).toBe(422);
    // The column's edit restriction applies as when attaching.
    expect((await as(admin).put(`/boards/${boardId}/columns/docs/restriction`, { kind: 'edit' })).status).toBe(200);
    try {
      expect((await addVersion(bob, f.id, (await upload(bob, 'c.txt')).id)).status).toBe(403);
    } finally {
      await as(admin).put(`/boards/${boardId}/columns/docs/restriction`, { kind: null });
    }
  });

  it('versions count toward the storage used', async () => {
    const before = await storageBytesUsed(t.db, acmeId);
    await threeVersions('storage');
    expect((await storageBytesUsed(t.db, acmeId)) - before).toBe(3 + 7 + 17);
  });
});

describe('make current and delete', () => {
  it('make current copies the old version as the next one; history stays linear', async () => {
    const { item, v1 } = await threeVersions('restore');
    const res = await as(bob).post(`/files/${v1.id}/versions/${v1.id}/make-current`);
    expect(res.status).toBe(200);
    const v4 = await body(res);
    expect(v4).toMatchObject({ version: 4, name: 'restore-1.txt', current: true, created_by: { name: 'bob' } });
    expect(v4.id).not.toBe(v1.id);
    const key4 = (await keyOf(v4.id))!;
    expect(t.storage.objects.get(key4)?.body?.toString()).toBe('one');
    expect((await cellFiles(item.id))[0]).toMatchObject({ asset_id: v1.id, name: 'restore-1.txt', version: 4 });
    expect((await body(await as(admin).get(`/files/${v1.id}/versions`))).data.map((v: Json) => v.version)).toEqual([
      4, 3, 2, 1,
    ]);
    const events = (await body(await as(admin).get(`/items/${item.id}/activity`))).data.map((e: Json) => e.type);
    expect(events).toEqual(expect.arrayContaining(['file.version_added', 'file.version_restored']));
  });

  it('deletes a non-current version: its uploader or a board admin; never the current one or version 1', async () => {
    const { item, v1, v2, v3 } = await threeVersions('del');
    expect((await as(carol).del(`/files/${v1.id}/versions/${v2.id}`)).status).toBe(403); // not hers, not admin
    expect((await as(bob).del(`/files/${v1.id}/versions/${v3.id}`)).status).toBe(409); // current
    expect((await as(admin).del(`/files/${v1.id}/versions/${v1.id}`)).status).toBe(409); // anchors the file
    expect((await as(bob).del(`/files/${v1.id}/versions/${v2.id}`)).status).toBe(200); // bob uploaded v2
    expect(stored(v2.key)).toBe(false);
    expect(await rowExists(v2.id)).toBe(false);
    expect((await as(admin).get(`/files/${v2.id}`)).status).toBe(404);
    expect((await body(await as(admin).get(`/files/${v1.id}/versions`))).data.map((v: Json) => v.version)).toEqual([
      3, 1,
    ]);
    expect((await cellFiles(item.id))[0]).toMatchObject({ version: 3 });

    // A board admin (here the account admin) may delete someone else's version.
    const other = await threeVersions('del-admin');
    expect((await as(admin).del(`/files/${other.v1.id}/versions/${other.v2.id}`)).status).toBe(200);
    const events = (await body(await as(admin).get(`/items/${item.id}/activity`))).data.map((e: Json) => e.type);
    expect(events).toContain('file.version_deleted');
  });
});

describe('storage sweeps never take a version of a file in use', () => {
  it('the hourly orphan purge and both unused checks keep every version', async () => {
    const { v1, v2, v3 } = await threeVersions('sweep');
    await t.db.execute(
      sql`update assets set created_at = now() - interval '48 hours' where id in (${v1.id}, ${v2.id}, ${v3.id})`,
    );
    await purgeOrphanFiles(t.pg, remove, 1000, noLog);
    for (const v of [v1, v2, v3]) {
      expect(stored(v.key)).toBe(true);
      expect(await rowExists(v.id)).toBe(true);
    }
    expect(await unusedAssets(t.db, acmeId, [v1.id, v2.id, v3.id])).toEqual([]);
    expect(await workerUnused(t.pg, [v1.id, v2.id, v3.id])).toEqual([]);
  });

  it('a file nothing holds leaves with all its versions, versions first', async () => {
    const { item, v1, v2, v3 } = await threeVersions('orphan');
    // Taken off without the trash (as an AI column's replace does) — straight from the table.
    await t.db.execute(sql`delete from cell_files where item_id = ${item.id}`);
    await t.db.execute(sql`update assets set created_at = now() - interval '48 hours' where id = ${v1.id}`);
    const unused = await workerUnused(t.pg, [v1.id]);
    expect(unused.map((u) => u.id).sort()).toEqual([v1.id, v2.id, v3.id].sort());
    expect(unused.at(-1)!.id).toBe(v1.id);
    await purgeOrphanFiles(t.pg, remove, 1000, noLog);
    for (const v of [v1, v2, v3]) {
      expect(stored(v.key)).toBe(false);
      expect(await rowExists(v.id)).toBe(false);
    }
  });
});

describe('removing a file from its cell', () => {
  it('goes to the trash with all its versions; restore brings it back as it was', async () => {
    const { item, v1, v2, v3 } = await threeVersions('trash');
    const res = await as(bob).del(`/items/${item.id}/cells/docs/files/${v1.id}`);
    expect(res.status).toBe(200);
    expect(await cellFiles(item.id)).toBeUndefined();
    for (const v of [v1, v2, v3]) expect(stored(v.key)).toBe(true);
    // The hourly sweep leaves it alone while it is in the trash.
    await t.db.execute(
      sql`update assets set created_at = now() - interval '48 hours' where id in (${v1.id}, ${v2.id}, ${v3.id})`,
    );
    await purgeOrphanFiles(t.pg, remove, 1000, noLog);
    for (const v of [v1, v2, v3]) expect(stored(v.key)).toBe(true);

    const entry = (await body(await as(bob).get('/trash'))).data.find((e: Json) => e.object_id === v1.id);
    expect(entry).toMatchObject({
      object_type: 'file',
      name: 'trash-3.txt',
      board_id: boardId,
      board_name: 'Docs',
      item_id: item.id,
      item_name: 'trash',
      version_count: 3,
      deleted_by: { name: 'bob' },
    });
    // The same retention as every trash kind (the table's default).
    const days = (new Date(entry.purge_after).getTime() - new Date(entry.deleted_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect((await as(carol).post(`/trash/${entry.id}/restore`)).status).toBe(404);
    expect(await body(await as(bob).post(`/trash/${entry.id}/restore`))).toMatchObject({
      ok: true,
      object_type: 'file',
      object_id: v1.id,
    });
    expect((await cellFiles(item.id))[0]).toMatchObject({ asset_id: v1.id, version: 3, name: 'trash-3.txt' });
    expect((await body(await as(admin).get(`/files/${v1.id}/versions`))).data).toHaveLength(3);
  });

  it('undo of the removal restores it from the trash', async () => {
    const item = await newItem('undo');
    const f = await upload(admin, 'undo.txt');
    await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [f.id] });
    await as(admin).del(`/items/${item.id}/cells/docs/files/${f.id}`);
    const ev = (await body(await as(admin).get(`/items/${item.id}/activity`))).data.find(
      (e: Json) => e.type === 'file.removed',
    );
    expect((await as(admin).post(`/activity/${ev.id}/undo`, {})).status).toBe(200);
    expect((await cellFiles(item.id))[0]).toMatchObject({ asset_id: f.id });
  });

  it('restore refuses clearly when the item is in the trash too', async () => {
    const item = await newItem('gone');
    const f = await upload(admin, 'gone.txt');
    await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [f.id] });
    await as(admin).del(`/items/${item.id}/cells/docs/files/${f.id}`);
    await as(admin).del(`/items/${item.id}`);
    const entry = (await body(await as(admin).get('/trash'))).data.find((e: Json) => e.object_id === f.id);
    expect(entry.version_count).toBe(1); // a file without newer versions
    const res = await as(admin).post(`/trash/${entry.id}/restore`);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toMatchObject({ code: 'parent_in_trash', details: { parent_type: 'item' } });
  });

  it('the trash purge deletes every version’s row and stored bytes', async () => {
    const { item, v1, v2, v3 } = await threeVersions('purge');
    await as(admin).del(`/items/${item.id}/cells/docs/files/${v1.id}`);
    const entry = (await body(await as(admin).get('/trash'))).data.find((e: Json) => e.object_id === v1.id);
    expect((await as(admin).del(`/trash/${entry.id}`)).status).toBe(200);
    const errors: string[] = [];
    await purgeTrash(t.pg, 1000, (m) => errors.push(m), remove);
    expect(errors).toEqual([]);
    for (const v of [v1, v2, v3]) {
      expect(stored(v.key)).toBe(false);
      expect(await rowExists(v.id)).toBe(false);
    }
  });
});

describe('everywhere else a file is read', () => {
  it('"download all" packs each file at its current version', async () => {
    const { item } = await threeVersions('zip');
    const res = await t.app.request(`/api/v1/items/${item.id}/cells/docs/files.zip?account_id=${acmeId}`, {
      headers: { origin: WEB_ORIGIN, cookie: admin },
    });
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['zip-3.txt']);
    expect(Buffer.from(files['zip-3.txt']!).toString()).toBe('three three three');
  });

  it('the board Files view shows the current version', async () => {
    const { item, v1 } = await threeVersions('view');
    const view = (await body(await as(admin).get(`/boards/${boardId}/files`))).data.find((f: Json) => f.id === v1.id);
    expect(view).toMatchObject({ name: 'view-3.txt', size: 17, item_id: item.id });
  });

  it('moving the item to another board keeps the file with its versions', async () => {
    const { item, v1 } = await threeVersions('move');
    const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const target = await body(await as(admin).post('/boards', { name: 'Target', workspace_id: ws }));
    await as(admin).post(`/boards/${target.id}/columns`, { id: 'docs', title: 'Docs', type: 'file' });
    expect((await as(admin).post(`/items/${item.id}/move-to-board`, { board_id: target.id })).status).toBe(200);
    expect((await cellFiles(item.id))[0]).toMatchObject({ asset_id: v1.id, version: 3 });
    expect((await body(await as(admin).get(`/files/${v1.id}/versions`))).data).toHaveLength(3);
    const v5 = await upload(admin, 'move-4.txt');
    expect((await addVersion(admin, v1.id, v5.id)).status).toBe(200);
    expect((await cellFiles(item.id))[0]).toMatchObject({ version: 4 });
  });

  it('account deletion removes versions before their files', async () => {
    const { v1, v2, v3 } = await threeVersions('account');
    const order = (await storedAssetsBatch(t.db, acmeId, 10_000)).map((a) => a.id);
    for (const v of [v2, v3]) expect(order.indexOf(v.id)).toBeLessThan(order.indexOf(v1.id));
  });
});
