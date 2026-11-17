// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Fix: #6 (product owner: "let me add docs in the files column too: 'upload a file' or 'new doc'"):
 * a file cell holds docs next to its files. Each "new doc" makes another doc with the item's permissions; the cell
 * lists them (renamed with the doc); removing one sends it to the trash and a restore puts it back in the cell.
 */
let t: TestContext;
let acmeId: string;
let admin: string;
let bob: string; // member
let vera: string; // account viewer
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
const upload = async (cookie: string, name = 'a.pdf') => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size: 100, mime: 'application/pdf' }));
  t.storage.markUploaded((await keyOf(pre.file_id))!, 100, 'application/pdf');
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};
const cellOf = async (itemId: string) => (await body(await as(bob).get(`/items/${itemId}`))).cells.files;

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: ws }))).id;
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'files', title: 'Files', type: 'file' });
});
afterAll(() => t.close());

describe('docs in a file cell (Fix: #6)', () => {
  it('"new doc" makes a doc each time, listed in the cell with the files; rename, remove and restore follow', async () => {
    const item = await body(await as(bob).post(`/boards/${boardId}/items`, { name: 'Acme deal' }));

    // An account viewer cannot add one; a member who edits the item can — a new doc each time.
    expect((await as(vera).post(`/items/${item.id}/cells/files/doc`, {})).status).toBe(403);
    const one = await body(await as(bob).post(`/items/${item.id}/cells/files/doc`, {}));
    expect(one.created).toBe(true);
    expect(one.doc).toMatchObject({ name: 'Acme deal', host: 'cell', cell: { item_id: item.id, column_key: 'files' } });
    expect(one.doc.capabilities).toMatchObject({ 'doc.edit': true, 'doc.manage': true });
    const two = await body(await as(bob).post(`/items/${item.id}/cells/files/doc`, { name: 'Proposal' }));
    expect(two.doc.id).not.toBe(one.doc.id);

    // A file next to them; the cell lists both kinds.
    await as(bob).post(`/items/${item.id}/cells/files/files`, { file_ids: [await upload(bob, 'quote.pdf')] });
    let cell = await cellOf(item.id);
    expect(cell.value.files.map((f: Json) => f.name)).toEqual(['quote.pdf']);
    expect(cell.value.docs).toEqual([
      { doc_id: one.doc.id, name: 'Acme deal' },
      { doc_id: two.doc.id, name: 'Proposal' },
    ]);
    expect(cell.text).toBe('quote.pdf, Acme deal, Proposal');

    // The item's permissions: Vera reads it, read only.
    expect((await body(await as(vera).get(`/docs/${one.doc.id}`))).capabilities).toMatchObject({
      'doc.read': true,
      'doc.edit': false,
    });

    // Renaming a doc renames it in the cell (the files stay).
    await as(bob).patch(`/docs/${two.doc.id}`, { name: 'Proposal v2' });
    cell = await cellOf(item.id);
    expect(cell.value.docs[1]).toEqual({ doc_id: two.doc.id, name: 'Proposal v2' });
    expect(cell.value.files).toHaveLength(1);

    // Removing one (whoever edits the item): to the trash and out of the cell; a restore puts it back.
    expect((await as(vera).del(`/docs/${one.doc.id}`)).status).toBe(403);
    expect((await as(bob).del(`/docs/${one.doc.id}`)).status).toBe(200);
    cell = await cellOf(item.id);
    expect(cell.value.docs).toEqual([{ doc_id: two.doc.id, name: 'Proposal v2' }]);
    expect((await as(bob).get(`/docs/${one.doc.id}`)).status).toBe(404);
    const entry = ((await body(await as(bob).get('/trash'))).data as Json[]).find((x) => x.object_id === one.doc.id)!;
    expect(entry.object_type).toBe('doc');
    expect((await as(bob).post(`/trash/${entry.id}/restore`)).status).toBe(200);
    cell = await cellOf(item.id);
    expect(cell.value.docs.map((d: Json) => d.doc_id)).toEqual([one.doc.id, two.doc.id]);

    // Only docs, no files: the cell stays (and is empty again when the last doc goes).
    const lone = await body(await as(bob).post(`/boards/${boardId}/items`, { name: 'Lone' }));
    const only = await body(await as(bob).post(`/items/${lone.id}/cells/files/doc`, {}));
    expect((await cellOf(lone.id)).value).toEqual({ files: [], docs: [{ doc_id: only.doc.id, name: 'Lone' }] });
    await as(bob).del(`/docs/${only.doc.id}`);
    expect((await body(await as(bob).get(`/items/${lone.id}`))).cells.files ?? null).toBeNull();
  });
});
