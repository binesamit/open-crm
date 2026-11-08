// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 12-ROADMAP "עריכה גדולה" B4: the subitems sheet — new subitems (also under new items), moves, one undo. */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let subBoardId: string;
let subStatus: { id: string; settings: { labels: { id: number; label: string }[] } };
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
const edit = (payload: Json) =>
  as(admin).post(`/boards/${boardId}/items/bulk-edit`, { labels: [], tags: [], rows: [], ...payload });
const sub = (payload: Json) => ({ labels: [], ...payload });

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
  boardId = (await body(await as(admin).post('/boards', { name: 'Tree', workspace_id: wsId }))).id;
  // The first subitem creates the sub-board.
  const seed = await newItem('seed');
  await newSub(seed.id, 'seed sub');
  subBoardId = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id;
  subStatus = (await body(await as(admin).get(`/boards/${subBoardId}`))).columns.find((c: Json) => c.type === 'status');
});
afterAll(() => t.close());

describe('bulk edit — subitems sheet', () => {
  it('creates subitems under existing items, new items and new subitems of the same batch; one undo', async () => {
    const parent = await newItem('existing parent');
    const kept = await newSub(parent.id, 'kept sub');
    const freshId = Math.max(...subStatus.settings.labels.map((l) => l.id)) + 1;
    const res = await edit({
      rows: [{ name: 'new parent', ref: '__row_m0', cells: {} }],
      subitems: sub({
        labels: [{ column_id: subStatus.id, id: freshId, label: 'Sub new', color: 'blue' }],
        rows: [
          { item_id: kept.id, name: 'kept sub 2', cells: { [subStatus.id]: { index: freshId } } },
          { name: 'under existing', parent_item_id: parent.id, cells: {} },
          { name: 'under new', ref: '__row_s0', parent_ref: '__row_m0', cells: { [subStatus.id]: { index: freshId } } },
          // Listed before its parent: written a level later.
          { name: 'sub-sub', parent_ref: '__row_s0', cells: {} },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ created: 1, sub_created: 3, sub_updated: 1, labels_added: 1, reparented: 0 });

    const newParentId = out.item_ids[0];
    const [underExisting, underNew, subSub] = out.subitem_ids.length === 3 ? out.subitem_ids : [];
    const a = await getItem(underExisting);
    expect(a).toMatchObject({ name: 'under existing', parent_item_id: parent.id, depth: 1, board_id: subBoardId });
    const b = await getItem(underNew);
    expect(b).toMatchObject({ name: 'under new', parent_item_id: newParentId, depth: 1 });
    expect(b.cells[subStatus.id].text).toBe('Sub new');
    expect(await getItem(subSub)).toMatchObject({ name: 'sub-sub', parent_item_id: underNew, depth: 2 });
    expect((await getItem(kept.id)).name).toBe('kept sub 2');

    // Undo from the activity log: the summary event undoes the batch.
    const undo = await as(admin).post(`/activity/${out.event_id}/undo`, {});
    expect(undo.status).toBe(200);
    for (const id of [newParentId, underExisting, underNew, subSub])
      expect((await as(admin).get(`/items/${id}`)).status).toBe(404);
    const k = await getItem(kept.id);
    expect(k.name).toBe('kept sub');
    expect(k.cells[subStatus.id]).toBeUndefined();
    // One trash entry for the new item (its new subitems inside it), one for the subitem under the old parent.
    const labels = (await body(await as(admin).get(`/boards/${subBoardId}`))).columns.find(
      (c: Json) => c.id === subStatus.id,
    ).settings.labels as Json[];
    expect(labels.find((l) => l.id === freshId)?.is_deactivated ?? true).toBe(true);
  });

  it('moves a subitem (with its own) to another parent, also a new one; undo puts it back', async () => {
    const p1 = await newItem('p1');
    const moving = await newSub(p1.id, 'moving');
    const child = await newSub(moving.id, 'moving child');
    const p2 = await newItem('p2');
    const res = await edit({
      rows: [{ name: 'p3 new', ref: '__row_m7', cells: {} }],
      subitems: sub({
        rows: [
          { item_id: moving.id, parent_item_id: p2.id, cells: {} },
          { item_id: child.id, parent_ref: '__row_m7', cells: {} },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ reparented: 2, sub_updated: 0 });
    expect(await getItem(moving.id)).toMatchObject({ parent_item_id: p2.id, depth: 1 });
    expect(await getItem(child.id)).toMatchObject({ parent_item_id: out.item_ids[0], depth: 1 });

    expect((await as(admin).post(`/boards/${boardId}/items/bulk-edit/${out.batch_id}/undo`, {})).status).toBe(200);
    expect(await getItem(moving.id)).toMatchObject({ parent_item_id: p1.id, depth: 1 });
    expect(await getItem(child.id)).toMatchObject({ parent_item_id: moving.id, depth: 2 });
    expect((await as(admin).get(`/items/${out.item_ids[0]}`)).status).toBe(404);
  });

  it('keeps the board levels: new and moved subitems', async () => {
    const p = await newItem('deep');
    const s1 = await newSub(p.id, 'level 1');
    const s2 = await newSub(s1.id, 'level 2');
    // A third level (this board allows 2).
    const tooDeep = await edit({ subitems: sub({ rows: [{ name: 'level 3', parent_item_id: s2.id, cells: {} }] }) });
    expect(tooDeep.status).toBe(422);
    expect((await body(tooDeep)).error.code).toBe('depth_exceeded');
    // s1 (with s2 under it) under another subitem: s2 would be level 3.
    const other = await newSub(p.id, 'other');
    const moveDeep = await edit({ subitems: sub({ rows: [{ item_id: s1.id, parent_item_id: other.id, cells: {} }] }) });
    expect((await body(moveDeep)).error.code).toBe('depth_exceeded');
    // Under its own subitem.
    const loop = await edit({ subitems: sub({ rows: [{ item_id: s1.id, parent_item_id: s2.id, cells: {} }] }) });
    expect(loop.status).toBe(400);
    // Nothing was written.
    expect(await getItem(s1.id)).toMatchObject({ parent_item_id: p.id, depth: 1 });
  });

  it('refuses new subitems without a parent, unknown refs and parents of other boards', async () => {
    const noParent = await edit({ subitems: sub({ rows: [{ name: 'orphan', cells: {} }] }) });
    expect(noParent.status).toBe(400);
    expect((await body(noParent)).error.message).toContain('subitems_need_a_parent');
    const badRef = await edit({ subitems: sub({ rows: [{ name: 'x', parent_ref: '__row_m99', cells: {} }] }) });
    expect(badRef.status).toBe(400);
    const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const otherBoard = (await body(await as(admin).post('/boards', { name: 'Other', workspace_id: wsId }))).id;
    const foreign = await body(await as(admin).post(`/boards/${otherBoard}/items`, { name: 'foreign' }));
    const res = await edit({ subitems: sub({ rows: [{ name: 'x', parent_item_id: foreign.id, cells: {} }] }) });
    expect(res.status).toBe(404);
    // A board without a sub-board has no subitems sheet.
    const none = await as(admin).post(`/boards/${otherBoard}/items/bulk-edit`, {
      labels: [],
      tags: [],
      rows: [],
      subitems: sub({ rows: [{ name: 'x', parent_item_id: foreign.id, cells: {} }] }),
    });
    expect(none.status).toBe(404);
  });

  it('writes many new subitems as a batch insert', async () => {
    const parents = await Promise.all([newItem('bulk p1'), newItem('bulk p2')]);
    const rows = Array.from({ length: 400 }, (_, i) => ({
      name: `bulk sub ${i}`,
      parent_item_id: parents[i % 2]!.id,
      cells: { [subStatus.id]: { index: subStatus.settings.labels[0]!.id } },
    }));
    const started = Date.now();
    const out = await body(await edit({ subitems: sub({ rows }) }));
    expect(out.sub_created).toBe(400);
    expect(Date.now() - started).toBeLessThan(15_000);
    const items = (await body(await as(admin).get(`/boards/${subBoardId}/items`))).data as Json[];
    const under = items.filter((i) => i.parent_item_id === parents[0]!.id);
    expect(under).toHaveLength(200);
    // In request order.
    expect(under.sort((x, y) => (x.position < y.position ? -1 : 1)).map((i) => i.name)[1]).toBe('bulk sub 2');
  });
});
