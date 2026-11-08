// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Web links in a files column: links beside a cell's files, kept in the cell
 * value — add / change / remove, each undoable; files coming and going keep them; viewers and other columns refused.
 */
let t: TestContext;
let admin: string;
let vera: string;
let acmeId: string;
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
const as = () => t.api(admin, acmeId);
const links = `/items/{item}/cells/docs/links`;
const path = (item = itemId) => links.replace('{item}', item);

const cell = async (item = itemId) =>
  (
    await t.db.execute<{ value: Json; text_value: string | null; number_value: string | null }>(
      sql`select c.value, c.text_value, c.number_value from cells c join columns col on col.id = c.column_id
          where c.item_id = ${item} and col.key = 'docs'`,
    )
  ).rows[0];
const lastEvent = async (type: string) =>
  (
    await t.db.execute<{ id: string }>(
      sql`select id from activity_log where item_id = ${itemId} and type = ${type} order by id desc limit 1`,
    )
  ).rows[0]!.id;

const upload = async (name: string) => {
  const size = 1000;
  const mime = 'application/pdf';
  const pre = await body(await as().post('/files/presign', { name, size, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, size, mime);
  await as().post(`/files/${pre.file_id}/complete`);
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
  await as().post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  vera = await join('vera@acme.test');
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'לקוחות', workspace_id: ws }))).id;
  await as().post(`/boards/${boardId}/columns`, { id: 'docs', title: 'חומרים', type: 'file' });
  await as().post(`/boards/${boardId}/columns`, { id: 'note', title: 'הערה', type: 'text' });
  itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'לקוח א' }))).id;
});
afterAll(() => t.close());

describe('links in a files cell', () => {
  it('adds a link (example.com gains https://) and the cell lists it, in its text and count', async () => {
    const res = await as().post(path(), { url: 'drive.google.com/folder/1', name: ' תיקייה ' });
    expect(res.status).toBe(200);
    const link = await body(res);
    expect(link).toMatchObject({ url: 'https://drive.google.com/folder/1', name: 'תיקייה' });
    const c = (await cell())!;
    expect(c.value.links).toEqual([link]);
    expect(c.value.files).toEqual([]);
    expect(c.text_value).toBe('תיקייה https://drive.google.com/folder/1');
    expect(Number(c.number_value)).toBe(1);
    // The board's rows carry it like any cell value.
    const items = await body(await as().get(`/boards/${boardId}/items`));
    const row = items.data.find((i: Json) => i.id === itemId);
    expect(row.cells.docs.value.links[0].url).toBe('https://drive.google.com/folder/1');
  });

  it('refuses anything but http(s), a non-files column and a viewer', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.test/a', 'not a link'])
      expect((await body(await as().post(path(), { url }))).error?.message ?? '').toContain('invalid_link');
    expect((await as().post(`/items/${itemId}/cells/note/links`, { url: 'https://a.test' })).status).toBe(404);
    expect((await t.api(vera, acmeId).post(path(), { url: 'https://a.test' })).status).toBe(403);
  });

  it('keeps links when files come and go', async () => {
    const fileId = await upload('brief.pdf');
    expect((await as().post(`/items/${itemId}/cells/docs/files`, { file_ids: [fileId] })).status).toBe(200);
    let c = (await cell())!;
    expect(c.value.files).toHaveLength(1);
    expect(c.value.links).toHaveLength(1);
    expect(Number(c.number_value)).toBe(2);
    expect((await as().del(`/items/${itemId}/cells/docs/files/${fileId}`)).status).toBe(200);
    c = (await cell())!;
    expect(c.value.files).toEqual([]);
    expect(c.value.links).toHaveLength(1);
  });

  it('changes a link; undo puts the old one back', async () => {
    const [link] = (await cell())!.value.links;
    const res = await as().patch(`${path()}/${link.id}`, { name: '' });
    expect(res.status).toBe(200);
    expect((await body(res)).name).toBe('');
    expect((await cell())!.text_value).toBe('https://drive.google.com/folder/1');
    expect((await as().patch(`${path()}/${link.id}`, { url: 'javascript:x' })).status).toBe(422);
    expect((await as().patch(`${path()}/nope`, { name: 'x' })).status).toBe(404);
    const ev = await lastEvent('file.link_changed');
    expect((await as().post(`/activity/${ev}/undo`, {})).status).toBe(200);
    expect((await cell())!.value.links[0].name).toBe('תיקייה');
  });

  it('removes a link (the empty cell goes); undo brings it back in its place', async () => {
    await as().post(path(), { url: 'https://figma.com/file/2' });
    const [first, second] = (await cell())!.value.links;
    expect((await as().del(`${path()}/${first.id}`)).status).toBe(200);
    expect((await cell())!.value.links.map((l: Json) => l.id)).toEqual([second.id]);
    expect((await as().post(`/activity/${await lastEvent('file.link_removed')}/undo`, {})).status).toBe(200);
    expect((await cell())!.value.links.map((l: Json) => l.id)).toEqual([first.id, second.id]);
    // Undo of an add removes it; with nothing left the cell is cleared.
    expect((await as().del(`${path()}/${first.id}`)).status).toBe(200);
    const added = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where type = 'file.link_added' and payload -> 'after' -> 'link' ->> 'id' = ${second.id}`,
      )
    ).rows[0]!.id;
    expect((await as().post(`/activity/${added}/undo`, {})).status).toBe(200);
    expect(await cell()).toBeUndefined();
  });

  it('two links added at once both stay (the cell row is locked per change)', async () => {
    const other = (await body(await as().post(`/boards/${boardId}/items`, { name: 'לקוח ב' }))).id;
    const res = await Promise.all(
      ['https://a.test/1', 'https://a.test/2', 'https://a.test/3'].map((url) => as().post(path(other), { url })),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await cell(other))!.value.links).toHaveLength(3);
  });
});
