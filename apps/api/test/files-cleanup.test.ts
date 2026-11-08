// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeOrphanFiles, purgeTrash } from '../../worker/src/tasks';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Owner fix6-server 2: files leave storage (R2) when nothing uses them any more — at once when taken off a cell or
 * an update or discarded from the composer, on trash purge for deleted updates / items / boards, and by the
 * hourly sweep for uploads never attached for 24 hours. Storage is the in-memory fake (`t.storage.objects`).
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
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

/** presign → "PUT" → complete; returns the file id and its storage key. */
const upload = async (cookie: string, name = 'a.pdf') => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size: 100, mime: 'application/pdf' }));
  const key = (await keyOf(pre.file_id))!;
  t.storage.markUploaded(key, 100, 'application/pdf');
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return { id: pre.file_id as string, key };
};
const stored = (key: string) => t.storage.objects.has(key);
const rowExists = async (id: string) => (await keyOf(id)) !== undefined;
const newItem = async (name: string) => body(await as(admin).post(`/boards/${boardId}/items`, { name }));
const noLog = () => undefined;
const remove = async (key: string) => void t.storage.objects.delete(key);

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Docs', workspace_id: ws }))).id;
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'docs', title: 'Docs', type: 'file' });
});
afterAll(() => t.close());

describe('DELETE /files/{id} (the composer discards an unsent upload)', () => {
  it('removes the object and the row at once; only the uploader; not once attached', async () => {
    const f = await upload(admin);
    expect(stored(f.key)).toBe(true);
    expect((await as(bob).del(`/files/${f.id}`)).status).toBe(404); // not theirs
    const res = await as(admin).del(`/files/${f.id}`);
    expect(res.status).toBe(200);
    expect(stored(f.key)).toBe(false);
    expect(await rowExists(f.id)).toBe(false);
    expect((await as(admin).del(`/files/${f.id}`)).status).toBe(404);

    // A pending upload (never completed) can be discarded too.
    const pre = await body(await as(admin).post('/files/presign', { name: 'p.pdf', size: 5, mime: 'application/pdf' }));
    expect((await as(admin).del(`/files/${pre.file_id}`)).status).toBe(200);
    expect(await rowExists(pre.file_id)).toBe(false);

    // Attached to an update: 409, it stays.
    const g = await upload(admin);
    const item = await newItem('with update');
    await as(admin).post(`/items/${item.id}/updates`, { body: 'see file', file_ids: [g.id] });
    expect((await as(admin).del(`/files/${g.id}`)).status).toBe(409);
    expect(stored(g.key)).toBe(true);
  });

  it('is account-scoped: another account cannot see the file', async () => {
    const f = await upload(admin);
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const beta = (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: 'Beta',
          slug: 'beta-files',
          first_admin_email: 'admin@beta.test',
          template_set: 'empty',
        }),
      )
    ).account.id as string;
    const betaAdmin = await join('admin@beta.test');
    expect((await t.api(betaAdmin, beta).del(`/files/${f.id}`)).status).toBe(404);
    expect(stored(f.key)).toBe(true);
  });
});

describe('taking a file off deletes it from storage', () => {
  it('a file cell: to the trash first (); out of storage on purge unless another cell holds it', async () => {
    const one = await newItem('one');
    const two = await newItem('two');
    const f = await upload(admin);
    await as(admin).post(`/items/${one.id}/cells/docs/files`, { file_ids: [f.id] });
    await as(admin).post(`/items/${two.id}/cells/docs/files`, { file_ids: [f.id] });
    expect((await as(admin).del(`/items/${one.id}/cells/docs/files/${f.id}`)).status).toBe(200);
    expect(stored(f.key)).toBe(true); // "two" still holds it
    expect((await as(admin).del(`/items/${two.id}/cells/docs/files/${f.id}`)).status).toBe(200);
    // In the trash (one entry for both cells): still stored, the hourly sweep leaves it alone.
    expect(stored(f.key)).toBe(true);
    const entries = (await body(await as(admin).get('/trash'))).data.filter((e: Json) => e.object_id === f.id);
    expect(entries).toHaveLength(1);
    await t.db.execute(sql`update assets set created_at = now() - interval '25 hours' where id = ${f.id}`);
    await purgeOrphanFiles(t.pg, remove, 1000, noLog);
    expect(stored(f.key)).toBe(true);
    // Deleted permanently → the trash purge takes it out of storage.
    expect((await as(admin).del(`/trash/${entries[0].id}`)).status).toBe(200);
    await purgeTrash(t.pg, 1000, noLog, remove);
    expect(stored(f.key)).toBe(false);
    expect(await rowExists(f.id)).toBe(false);
  });

  it('a file on an update or a reply', async () => {
    const item = await newItem('updates');
    const f = await upload(admin);
    const u = await body(await as(admin).post(`/items/${item.id}/updates`, { body: 'x', file_ids: [f.id] }));
    expect((await as(admin).del(`/updates/${u.id}/files/${f.id}`)).status).toBe(200);
    expect(stored(f.key)).toBe(false);
    expect(await rowExists(f.id)).toBe(false);
  });

  it('storage down: the row stays for the sweep', async () => {
    const item = await newItem('down');
    const f = await upload(admin);
    const u = await body(await as(admin).post(`/items/${item.id}/updates`, { body: 'x', file_ids: [f.id] }));
    const original = t.storage.remove;
    t.storage.remove = async () => Promise.reject(new Error('down'));
    try {
      expect((await as(admin).del(`/updates/${u.id}/files/${f.id}`)).status).toBe(200);
    } finally {
      t.storage.remove = original;
    }
    expect(await rowExists(f.id)).toBe(true);
    expect(stored(f.key)).toBe(true);
  });
});

describe('trash purge deletes the files of what it purges', () => {
  it('an update with a reply, an item with a file cell, a board', async () => {
    const item = await newItem('purged item');
    const cellFile = await upload(admin);
    await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [cellFile.id] });

    const host = await newItem('update host');
    const updFile = await upload(admin);
    const replyFile = await upload(admin);
    const u = await body(await as(admin).post(`/items/${host.id}/updates`, { body: 'u', file_ids: [updFile.id] }));
    await as(admin).post(`/updates/${u.id}/replies`, { body: 'r', file_ids: [replyFile.id] });

    // Another item keeps a file shared with the purged item: it must stay.
    const keeper = await newItem('keeper');
    const shared = await upload(admin);
    await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [shared.id] });
    await as(admin).post(`/items/${keeper.id}/cells/docs/files`, { file_ids: [shared.id] });

    const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const board = await body(await as(admin).post('/boards', { name: 'Gone', workspace_id: ws }));
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'docs', title: 'Docs', type: 'file' });
    const onBoard = await body(await as(admin).post(`/boards/${board.id}/items`, { name: 'on board' }));
    const boardFile = await upload(admin);
    await as(admin).post(`/items/${onBoard.id}/cells/docs/files`, { file_ids: [boardFile.id] });

    await as(admin).del(`/items/${item.id}`);
    await as(admin).del(`/updates/${u.id}`);
    await as(admin).del(`/boards/${board.id}`);
    // In trash: everything is still stored (restore must bring the files back).
    for (const f of [cellFile, updFile, replyFile, boardFile, shared]) expect(stored(f.key)).toBe(true);

    expect((await as(admin).del('/trash')).status).toBe(200); // delete permanently → due now
    const errors: string[] = [];
    await purgeTrash(t.pg, 1000, (m) => errors.push(m), remove);
    expect(errors).toEqual([]);
    for (const f of [cellFile, updFile, replyFile, boardFile]) {
      expect(stored(f.key)).toBe(false);
      expect(await rowExists(f.id)).toBe(false);
    }
    expect(stored(shared.key)).toBe(true);
    expect(await rowExists(shared.id)).toBe(true);
  });
});

describe('the hourly sweep (files.purge)', () => {
  it('removes uploads never attached for 24 hours; recent or used ones stay', async () => {
    const old = await upload(admin, 'old.pdf');
    const recent = await upload(admin, 'recent.pdf');
    const usedOld = await upload(admin, 'used.pdf');
    const item = await newItem('sweep');
    await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [usedOld.id] });
    await t.db.execute(
      sql`update assets set created_at = now() - interval '25 hours' where id in (${old.id}, ${usedOld.id})`,
    );
    await t.db.execute(sql`update assets set created_at = now() - interval '23 hours' where id = ${recent.id}`);
    await purgeOrphanFiles(t.pg, remove, 1000, noLog);
    expect(stored(old.key)).toBe(false);
    expect(await rowExists(old.id)).toBe(false);
    expect(stored(recent.key)).toBe(true);
    expect(stored(usedOld.key)).toBe(true);
  });
});
