// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Hierarchy moves: the batch bar's "under an item" / "one level up" (bulk actions
 * `move_under` / `move_up`) and the row menu's "move up one level" (POST /items/:id/outdent) — one service, one
 * batch per request, one undo. Children come along; the board's hierarchy depth holds; no cycles; rights on both
 * the board and its sub-board.
 */
let t: TestContext;
let admin: string;
let carol: string; // viewer
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

/** A board with items P, Q, A, B; P has subitems S (with S1 under it) and T; A has A1. */
const setup = async (name: string) => {
  const board = await body(await as(admin).post('/boards', { name, workspace_id: wsId }));
  const item = async (n: string) => body(await as(admin).post(`/boards/${board.id}/items`, { name: n }));
  const sub = async (parentId: string, n: string) =>
    body(await as(admin).post(`/items/${parentId}/subitems`, { name: n }));
  const p = await item('P');
  const q = await item('Q');
  const s = await sub(p.id, 'S');
  const s1 = await sub(s.id, 'S1');
  const tt = await sub(p.id, 'T');
  // A status column on the board titled like the sub-board's: the automatic mapping pairs them.
  const subId = s.board_id as string;
  const subStatus = (await body(await as(admin).get(`/boards/${subId}`))).columns.find(
    (c: Json) => c.type === 'status',
  );
  const status = await body(
    await as(admin).post(`/boards/${board.id}/columns`, { title: subStatus.title, type: 'status' }),
  );
  const a = await body(
    await as(admin).post(`/boards/${board.id}/items`, { name: 'A', cells: { [status.id]: { index: 1 } } }),
  );
  const b = await item('B');
  const a1 = await sub(a.id, 'A1');
  const subs = async () => (await body(await as(admin).get(`/boards/${subId}/items`))).data as Json[];
  const tops = async () =>
    ((await body(await as(admin).get(`/boards/${board.id}/items`))).data as Json[]).map((i) => i.name as string);
  const under = async (id: string) =>
    (await subs()).filter((i) => i.parent_item_id === id).map((i) => i.name as string);
  const bulk = (cookie: string, boardId: string, ids: string[], action: Json) =>
    as(cookie).post(`/boards/${boardId}/items/bulk`, { item_ids: ids, action });
  return { board, subId, p, q, s, s1, tt, a, b, a1, status, subStatus, subs, tops, under, bulk };
};

describe('hierarchy moves', () => {
  it('move_under: items become subitems with their own subitems, cells mapped; one undo puts them back', async () => {
    const x = await setup('Under');
    const res = await x.bulk(admin, x.board.id, [x.a.id, x.b.id], { type: 'move_under', parent_item_id: x.q.id });
    expect(res.status).toBe(200);
    const r = await body(res);
    expect(r).toMatchObject({ ok: true, done: 2, skipped: 0 });
    expect(await x.tops()).toEqual(['P', 'Q']);
    expect(await x.under(x.q.id)).toEqual(['A', 'B']);
    const rows = await x.subs();
    expect(rows.find((i) => i.id === x.a.id)).toMatchObject({ depth: 1, board_id: x.subId, parent_item_id: x.q.id });
    // Its own subitem came along, one level deeper.
    expect(rows.find((i) => i.id === x.a1.id)).toMatchObject({ depth: 2, parent_item_id: x.a.id });
    // The status went to the sub-board's status column (same type + title), by its label text.
    const label = x.status.settings.labels.find((l: Json) => l.id === 1).label;
    expect(rows.find((i) => i.id === x.a.id)!.cells[x.subStatus.id].text).toBe(label);

    expect((await as(admin).post(`/activity/${r.event_id}/undo`, {})).status).toBe(200);
    expect(await x.tops()).toEqual(['P', 'Q', 'A', 'B']);
    const back = await x.subs();
    expect(back.find((i) => i.id === x.a1.id)).toMatchObject({ depth: 1, parent_item_id: x.a.id });
    const items = (await body(await as(admin).get(`/boards/${x.board.id}/items`))).data as Json[];
    expect(items.find((i) => i.id === x.a.id)!.cells[x.status.id].text).toBe(label);
  });

  it('move_under on the sub-board: subitems change parent (also under a subitem); the depth holds', async () => {
    const x = await setup('Reparent');
    // T under S: a sub-subitem now.
    const ok = await x.bulk(admin, x.subId, [x.tt.id], { type: 'move_under', parent_item_id: x.s.id });
    expect(ok.status).toBe(200);
    expect(await x.under(x.s.id)).toEqual(['S1', 'T']);
    // S (with S1) under A1 would be 3 levels deep — the board allows 2: refused, nothing moved.
    const deep = await x.bulk(admin, x.subId, [x.s.id], { type: 'move_under', parent_item_id: x.a1.id });
    expect(deep.status).toBe(422);
    expect((await body(deep)).error).toMatchObject({ code: 'depth_exceeded', message: 'tree_too_deep' });
    expect(await x.under(x.p.id)).toEqual(['S']);
    // An item with subitems under a subitem: same rule.
    const deepItem = await x.bulk(admin, x.board.id, [x.a.id], { type: 'move_under', parent_item_id: x.s.id });
    expect(deepItem.status).toBe(422);
    expect(await x.tops()).toContain('A');
  });

  it('never under itself or one of its own subitems; never under another board', async () => {
    const x = await setup('Cycles');
    const self = await x.bulk(admin, x.subId, [x.s.id], { type: 'move_under', parent_item_id: x.s.id });
    expect(self.status).toBe(400);
    expect((await body(self)).error.message).toBe('tree_cycle');
    const own = await x.bulk(admin, x.subId, [x.s.id], { type: 'move_under', parent_item_id: x.s1.id });
    expect(own.status).toBe(400);
    expect((await body(own)).error.message).toBe('tree_cycle');
    const item = await x.bulk(admin, x.board.id, [x.p.id], { type: 'move_under', parent_item_id: x.s.id });
    expect(item.status).toBe(400);
    expect((await body(item)).error.message).toBe('tree_cycle');
    expect(await x.under(x.p.id)).toEqual(['S', 'T']);

    const other = await setup('Elsewhere');
    const cross = await x.bulk(admin, x.board.id, [x.b.id], { type: 'move_under', parent_item_id: other.q.id });
    expect(cross.status).toBe(400);
    expect((await body(cross)).error.message).toBe('bad_parent');
  });

  it('move_up: sub-subitems under their grandparent, subitems to items after their parent, in order', async () => {
    const x = await setup('Up');
    const res = await x.bulk(admin, x.subId, [x.s1.id], { type: 'move_up' });
    expect(res.status).toBe(200);
    expect(await x.under(x.p.id)).toEqual(['S', 'S1', 'T']);
    // Two subitems of P become items right after P, in the selection's order.
    const two = await body(await x.bulk(admin, x.subId, [x.s.id, x.tt.id], { type: 'move_up' }));
    expect(two).toMatchObject({ done: 2, skipped: 0 });
    expect(await x.tops()).toEqual(['P', 'S', 'T', 'Q', 'A', 'B']);
    const items = (await body(await as(admin).get(`/boards/${x.board.id}/items`))).data as Json[];
    expect(items.find((i) => i.id === x.s.id)).toMatchObject({ depth: 0, group_id: x.p.group_id });
    // One undo for the batch: both are subitems of P again.
    expect((await as(admin).post(`/activity/${two.event_id}/undo`, {})).status).toBe(200);
    expect(await x.under(x.p.id)).toEqual(['S', 'S1', 'T']);
  });

  it('a checked subitem moves with its checked parent; top-level items are skipped', async () => {
    const x = await setup('Carried');
    const r = await body(await x.bulk(admin, x.subId, [x.s1.id, x.s.id], { type: 'move_up' }));
    expect(r).toMatchObject({ done: 2, skipped: 0 });
    expect(await x.tops()).toEqual(['P', 'S', 'Q', 'A', 'B']);
    expect((await x.subs()).find((i) => i.id === x.s1.id)).toMatchObject({ parent_item_id: x.s.id, depth: 1 });
    // Items of the board have no level above: skipped and counted.
    const items = await body(await x.bulk(admin, x.board.id, [x.q.id], { type: 'move_up' }));
    expect(items).toMatchObject({ done: 0, skipped: 1 });
  });

  it('the row menu (outdent) runs the same service; a viewer may not move', async () => {
    const x = await setup('Rights');
    const one = await as(admin).post(`/items/${x.tt.id}/outdent`, {});
    expect(one.status).toBe(200);
    expect(await x.tops()).toEqual(['P', 'T', 'Q', 'A', 'B']);
    expect((await as(admin).post(`/items/${x.q.id}/outdent`, {})).status).toBe(400);
    expect((await x.bulk(carol, x.subId, [x.s.id], { type: 'move_up' })).status).toBe(403);
    expect((await x.bulk(carol, x.board.id, [x.b.id], { type: 'move_under', parent_item_id: x.q.id })).status).toBe(
      403,
    );
    expect((await as(carol).post(`/items/${x.s1.id}/outdent`, {})).status).toBe(403);
  });

  it('a board without subitems yet gets its sub-board on the first move under an item', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Fresh', workspace_id: wsId }));
    const one = await body(await as(admin).post(`/boards/${board.id}/items`, { name: 'One' }));
    const two = await body(await as(admin).post(`/boards/${board.id}/items`, { name: 'Two' }));
    expect((await body(await as(admin).get(`/boards/${board.id}`))).subitems_board_id).toBeNull();
    const res = await as(admin).post(`/boards/${board.id}/items/bulk`, {
      item_ids: [two.id],
      action: { type: 'move_under', parent_item_id: one.id },
    });
    expect(res.status).toBe(200);
    const subId = (await body(await as(admin).get(`/boards/${board.id}`))).subitems_board_id;
    expect(subId).toBeTruthy();
    const subs = (await body(await as(admin).get(`/boards/${subId}/items`))).data as Json[];
    expect(subs.map((i) => [i.name, i.parent_item_id])).toEqual([['Two', one.id]]);
  });
});
