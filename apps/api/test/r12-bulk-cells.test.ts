// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Round 12 (product decision): an edit of a cell in one of several checked rows applies to all of them — the web
 * sends it to the bulk endpoint (`set_cell`). Here: items and subitems (the sub-board), several column types, one
 * batch and one undo for all of them.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let subBoardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newItem = async (name: string) =>
  (await body(await as(admin).post(`/boards/${boardId}/items`, { name }))) as Json;
const newSub = async (parentId: string, name: string) =>
  (await body(await as(admin).post(`/items/${parentId}/subitems`, { name }))) as Json;
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const setOnAll = (board: string, ids: string[], column_id: string, value: unknown) =>
  as(admin).post(`/boards/${board}/items/bulk`, { item_ids: ids, action: { type: 'set_cell', column_id, value } });

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
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Checked rows', workspace_id: wsId }))).id;
  const seed = await newItem('seed');
  await newSub(seed.id, 'seed sub');
  subBoardId = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id;
});
afterAll(() => t.close());

describe('round 12 — an edit in a checked row applies to every checked row', () => {
  it('status, text, number and date on items: one batch, one undo restores each row', async () => {
    const cols = {
      status: await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'S', type: 'status' })),
      text: await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'T', type: 'text' })),
      num: await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'N', type: 'numbers' })),
      date: await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'D', type: 'date' })),
    };
    const a = await newItem('a');
    const b = await newItem('b');
    const c = await newItem('c');
    await as(admin).put(`/items/${a.id}/cells/${cols.text.id}`, { value: 'before a' });
    const ids = [a.id, b.id, c.id];
    const label = cols.status.settings.labels[0].id;

    const results = [];
    for (const [col, value] of [
      [cols.status, { index: label }],
      [cols.text, 'same for all'],
      [cols.num, 7],
      [cols.date, { date: '2026-11-02' }],
    ] as const) {
      const res = await setOnAll(boardId, ids, col.id, value);
      expect(res.status).toBe(200);
      const out = await body(res);
      expect(out).toMatchObject({ ok: true, done: 3, skipped: 0 });
      results.push(out);
    }
    for (const id of ids) {
      const item = await getItem(id);
      expect(item.cells[cols.status.id].value).toMatchObject({ index: label });
      expect(item.cells[cols.text.id].value).toBe('same for all');
      expect(item.cells[cols.num.id].value).toBe(7);
      expect(item.cells[cols.date.id].value).toMatchObject({ date: '2026-11-02' });
    }
    // Undoing the text edit puts each row's own value back (a's text, none for b and c).
    const textEdit = results[1]!;
    expect(await body(await as(admin).post(`/activity/${textEdit.event_id}/undo`, {}))).toMatchObject({ ok: true });
    expect((await getItem(a.id)).cells[cols.text.id].value).toBe('before a');
    expect((await getItem(b.id)).cells[cols.text.id]).toBeUndefined();
  });

  it('checked subitems: the sub-board column is set on all of them at once', async () => {
    const parent = await newItem('parent');
    const s1 = await newSub(parent.id, 's1');
    const s2 = await newSub(parent.id, 's2');
    const other = await newItem('other parent');
    const s3 = await newSub(other.id, 's3');
    const subStatus = (await body(await as(admin).get(`/boards/${subBoardId}`))).columns.find(
      (col: Json) => col.type === 'status',
    );
    const label = subStatus.settings.labels[1].id;
    const out = await body(await setOnAll(subBoardId, [s1.id, s2.id, s3.id], subStatus.id, { index: label }));
    expect(out).toMatchObject({ done: 3, skipped: 0 });
    for (const s of [s1, s2, s3])
      expect((await getItem(s.id)).cells[subStatus.id].value).toMatchObject({ index: label });
    await as(admin).post(`/activity/${out.event_id}/undo`, {});
    for (const s of [s1, s2, s3]) expect((await getItem(s.id)).cells[subStatus.id]).toBeUndefined();
  });
});

describe(' — a relation toggle in a checked row links / unlinks on every checked row', () => {
  it('change_links adds and removes one link, each row keeps its own; paste-like set_cell replaces; one undo', async () => {
    const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const clients = (await body(await as(admin).post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
    const target = async (name: string) =>
      (await body(await as(admin).post(`/boards/${clients}/items`, { name }))) as Json;
    const [x, y, z] = [await target('X'), await target('Y'), await target('Z')];
    const rel = await body(
      await as(admin).post(`/boards/${boardId}/columns`, {
        title: 'Client',
        type: 'board_relation',
        settings: { board_ids: [clients] },
      }),
    );
    const a = await newItem('ra');
    const b = await newItem('rb');
    await as(admin).put(`/items/${a.id}/cells/${rel.id}`, { value: { item_ids: [y.id] } });
    const linksOf = async (id: string) => ((await getItem(id)).cells[rel.id]?.value?.item_ids ?? []) as string[];
    const change = (add: string[], remove: string[]) =>
      as(admin).post(`/boards/${boardId}/items/bulk`, {
        item_ids: [a.id, b.id],
        action: { type: 'change_links', column_id: rel.id, add, remove },
      });

    const added = await body(await change([x.id], []));
    expect(added).toMatchObject({ ok: true, done: 2, skipped: 0 });
    expect(await linksOf(a.id)).toEqual([y.id, x.id]); // a keeps Y
    expect(await linksOf(b.id)).toEqual([x.id]);

    await change([], [x.id]);
    expect(await linksOf(a.id)).toEqual([y.id]);
    expect(await linksOf(b.id)).toEqual([]);

    // One undo puts back what the batch changed on each row.
    const again = await body(await change([z.id], []));
    await as(admin).post(`/activity/${again.event_id}/undo`, {});
    expect(await linksOf(a.id)).toEqual([y.id]);
    expect(await linksOf(b.id)).toEqual([]);

    // A paste (set_cell) sets the same links on both.
    await as(admin).post(`/boards/${boardId}/items/bulk`, {
      item_ids: [a.id, b.id],
      action: { type: 'set_cell', column_id: rel.id, value: { item_ids: [z.id] } },
    });
    expect(await linksOf(a.id)).toEqual([z.id]);
    expect(await linksOf(b.id)).toEqual([z.id]);

    // Only relation columns.
    const text = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'TT', type: 'text' }));
    const bad = await as(admin).post(`/boards/${boardId}/items/bulk`, {
      item_ids: [a.id],
      action: { type: 'change_links', column_id: text.id, add: [x.id] },
    });
    expect(bad.status).toBe(422);
  });

  it('a single-link column: the added link replaces each row’s link', async () => {
    const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const people = (await body(await as(admin).post('/boards', { name: 'Owners', workspace_id: wsId }))).id;
    const o1 = (await body(await as(admin).post(`/boards/${people}/items`, { name: 'O1' }))) as Json;
    const o2 = (await body(await as(admin).post(`/boards/${people}/items`, { name: 'O2' }))) as Json;
    const rel = await body(
      await as(admin).post(`/boards/${boardId}/columns`, {
        title: 'Owner',
        type: 'board_relation',
        settings: { board_ids: [people], allow_multiple: false },
      }),
    );
    const a = await newItem('sa');
    const b = await newItem('sb');
    await as(admin).put(`/items/${a.id}/cells/${rel.id}`, { value: { item_ids: [o1.id] } });
    await as(admin).post(`/boards/${boardId}/items/bulk`, {
      item_ids: [a.id, b.id],
      action: { type: 'change_links', column_id: rel.id, add: [o2.id], remove: [o1.id] },
    });
    for (const id of [a.id, b.id]) expect((await getItem(id)).cells[rel.id].value.item_ids).toEqual([o2.id]);
  });
});
