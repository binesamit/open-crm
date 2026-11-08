// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * f9-updedit: editing an update or reply attaches and removes files under the same conditions as
 * posting one — only the author, only the editor's own finished uploads of this account, at most 20 files, never
 * text and files both empty; removed files are detached and leave storage.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let betaId: string;
let betaAdmin: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const keyOf = async (id: string) =>
  (await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${id}`)).rows[0]
    ?.storage_key;

/** presign → "PUT" (the fake storage) → complete; returns the file id and its storage key. */
const upload = async (cookie: string, account: string, name: string, mime = 'application/pdf') => {
  const api = t.api(cookie, account);
  const pre = await body(await api.post('/files/presign', { name, size: 100, mime }));
  const key = (await keyOf(pre.file_id))!;
  t.storage.markUploaded(key, 100, mime);
  expect((await api.post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return { id: pre.file_id as string, key };
};
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const account = async (name: string, slug: string, email: string) =>
    (await body(await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email }))).account
      .id as string;
  acmeId = await account('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  betaId = await account('Beta', 'beta', 'admin@beta.test');
  betaAdmin = await join('admin@beta.test');
  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  const board = await body(await t.api(admin, acmeId).post('/boards', { name: 'עדכונים', workspace_id: ws }));
  itemId = (await body(await t.api(admin, acmeId).post(`/boards/${board.id}/items`, { name: 'פריט' }))).id;
});
afterAll(() => t.close());

describe('editing an update: files (f9-updedit)', () => {
  it('adds files (after the existing ones) and removes one; the removed file is detached and leaves storage', async () => {
    const api = t.api(admin, acmeId);
    const first = await upload(admin, acmeId, 'first.pdf');
    const u = await body(await api.post(`/items/${itemId}/updates`, { doc: doc('hello'), file_ids: [first.id] }));
    expect(u.edited_at).toBeNull();

    // Text and a new pasted image in one save.
    const shot = await upload(admin, acmeId, 'shot.png', 'image/png');
    const res = await api.patch(`/updates/${u.id}`, { doc: doc('hello again'), file_ids: [shot.id] });
    expect(res.status).toBe(200);
    const edited = await body(res);
    expect(edited.body_text).toBe('hello again');
    expect(edited.files.map((f: Json) => f.name)).toEqual(['first.pdf', 'shot.png']);
    expect(edited.edited_at).not.toBeNull();

    // Files only: the text stays as it was.
    const more = await upload(admin, acmeId, 'more.pdf');
    const added = await body(await api.patch(`/updates/${u.id}`, { file_ids: [more.id] }));
    expect(added.body_text).toBe('hello again');
    expect(added.files.map((f: Json) => f.name)).toEqual(['first.pdf', 'shot.png', 'more.pdf']);

    // Removing one: detached, out of storage, logged as file.removed.
    const removed = await body(
      await api.patch(`/updates/${u.id}`, { doc: doc('hello again'), remove_file_ids: [first.id] }),
    );
    expect(removed.files.map((f: Json) => f.name)).toEqual(['shot.png', 'more.pdf']);
    expect(t.storage.objects.has(first.key)).toBe(false);
    expect(await keyOf(first.id)).toBeUndefined();
    const activity = (await body(await api.get(`/items/${itemId}/activity`))).data as Json[];
    expect(activity.some((e) => e.type === 'file.removed' && e.before?.file_id === first.id)).toBe(true);

    // Re-sending an attached file changes nothing (no duplicate).
    const again = await body(await api.patch(`/updates/${u.id}`, { file_ids: [shot.id] }));
    expect(again.files).toHaveLength(2);
  });

  it('a reply is edited the same way', async () => {
    const api = t.api(admin, acmeId);
    const top = await body(await api.post(`/items/${itemId}/updates`, { body: 'top' }));
    const reply = await body(await api.post(`/updates/${top.id}/replies`, { body: 'reply' }));
    const f = await upload(admin, acmeId, 'reply.pdf');
    const res = await api.patch(`/updates/${reply.id}`, { body: 'reply', file_ids: [f.id] });
    expect(res.status).toBe(200);
    expect((await body(res)).files.map((x: Json) => x.name)).toEqual(['reply.pdf']);
  });

  it("refuses someone else's file, another account's file, an unfinished upload and a file not on the update", async () => {
    const api = t.api(admin, acmeId);
    const u = await body(await api.post(`/items/${itemId}/updates`, { body: 'mine' }));
    const bobs = await upload(bob, acmeId, 'bob.pdf');
    expect((await api.patch(`/updates/${u.id}`, { file_ids: [bobs.id] })).status).toBe(422);
    const betas = await upload(betaAdmin, betaId, 'beta.pdf');
    expect((await api.patch(`/updates/${u.id}`, { file_ids: [betas.id] })).status).toBe(422);
    const pending = await body(await api.post('/files/presign', { name: 'p.pdf', size: 5, mime: 'application/pdf' }));
    expect((await api.patch(`/updates/${u.id}`, { file_ids: [pending.file_id] })).status).toBe(422);
    // A file of another update can't be removed through this one.
    const other = await upload(admin, acmeId, 'other.pdf');
    await api.post(`/items/${itemId}/updates`, { body: 'other', file_ids: [other.id] });
    expect((await api.patch(`/updates/${u.id}`, { remove_file_ids: [other.id] })).status).toBe(404);
    expect(t.storage.objects.has(other.key)).toBe(true);
    // Nothing changed.
    const threads = (await body(await api.get(`/items/${itemId}/updates`))).data as Json[];
    const same = threads.find((x) => x.id === u.id)!;
    expect(same.files).toHaveLength(0);
    expect(same.edited_at).toBeNull();
  });

  it('only the author edits — nor adds or removes files', async () => {
    const f = await upload(admin, acmeId, 'a.pdf');
    const u = await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { body: 'x', file_ids: [f.id] }));
    const asBob = t.api(bob, acmeId);
    const bobFile = await upload(bob, acmeId, 'b.pdf');
    expect((await asBob.patch(`/updates/${u.id}`, { file_ids: [bobFile.id] })).status).toBe(403);
    expect((await asBob.patch(`/updates/${u.id}`, { remove_file_ids: [f.id] })).status).toBe(403);
    expect(t.storage.objects.has(f.key)).toBe(true);
    // Another account never reaches it.
    expect((await t.api(betaAdmin, betaId).patch(`/updates/${u.id}`, { remove_file_ids: [f.id] })).status).toBe(404);
  });

  it('text and files may not both end up empty; files-only after an edit is fine', async () => {
    const api = t.api(admin, acmeId);
    const f = await upload(admin, acmeId, 'keep.pdf');
    const u = await body(await api.post(`/items/${itemId}/updates`, { body: 'text', file_ids: [f.id] }));
    // Clearing the text, keeping the file.
    const cleared = await api.patch(`/updates/${u.id}`, { doc: emptyDoc });
    expect(cleared.status).toBe(200);
    expect((await body(cleared)).body_text).toBe('');
    // …then removing the last file too: refused, and the file stays.
    expect((await api.patch(`/updates/${u.id}`, { doc: emptyDoc, remove_file_ids: [f.id] })).status).toBe(400);
    expect((await api.patch(`/updates/${u.id}`, { remove_file_ids: [f.id] })).status).toBe(400);
    expect(t.storage.objects.has(f.key)).toBe(true);
    // An empty request is refused by the schema.
    expect((await api.patch(`/updates/${u.id}`, {})).status).toBe(400);
  });

  it('keeps at most 20 files on an update', async () => {
    const api = t.api(admin, acmeId);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await upload(admin, acmeId, `f${i}.pdf`)).id);
    const u = await body(await api.post(`/items/${itemId}/updates`, { body: 'full', file_ids: ids }));
    expect(u.files).toHaveLength(20);
    const extra = await upload(admin, acmeId, 'extra.pdf');
    const res = await api.patch(`/updates/${u.id}`, { file_ids: [extra.id] });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('too_many_files');
    // Swapping one for another fits.
    const swap = await api.patch(`/updates/${u.id}`, { file_ids: [extra.id], remove_file_ids: [ids[0]] });
    expect(swap.status).toBe(200);
    expect((await body(swap)).files).toHaveLength(20);
  });
});
