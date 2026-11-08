// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeTrash } from '../../worker/src/tasks';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** D14: subitems live on the board's sub-board, with its own columns and the parent board's rights. */
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // viewer
let acmeId: string;
let wsId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newItem = async (name: string, board = boardId) => body(await as(admin).post(`/boards/${board}/items`, { name }));
const addSub = (cookie: string, parentId: string, payload: Json) =>
  as(cookie).post(`/items/${parentId}/subitems`, payload);

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Projects', workspace_id: wsId }))).id;
});
afterAll(() => t.close());

describe('subitems (D14)', () => {
  let parent: Json;
  let subBoardId: string;

  it('the first subitem creates a hidden sub-board with its own default columns', async () => {
    parent = await newItem('Parent');
    expect((await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id).toBeNull();
    const res = await addSub(bob, parent.id, { name: 'Child 1', cells: { status: { index: 1 } } });
    expect(res.status).toBe(201);
    const child = await body(res);
    expect(child).toMatchObject({ name: 'Child 1', parent_item_id: parent.id, depth: 1 });

    const board = await body(await as(admin).get(`/boards/${boardId}`));
    subBoardId = board.subitems_board_id;
    expect(subBoardId).toBe(child.board_id);
    const sub = await body(await as(bob).get(`/boards/${subBoardId}`));
    expect(sub.parent_board_id).toBe(boardId);
    expect(sub.columns.map((c: Json) => c.type)).toEqual(['name', 'people', 'status', 'date']);
    expect(child.cells.status.text).toBeTruthy();
    // Not a board of its own in the sidebar.
    const tree = await body(await as(admin).get(`/workspaces/${wsId}/tree`));
    expect(tree.boards.map((b: Json) => b.id)).not.toContain(subBoardId);
  });

  it('a second subitem reuses the sub-board; the sub-board lists them; its columns are its own', async () => {
    await addSub(admin, parent.id, { name: 'Child 2' });
    const items = (await body(await as(bob).get(`/boards/${subBoardId}/items`))).data as Json[];
    expect(items.map((i) => i.name)).toEqual(['Child 1', 'Child 2']);
    // Main-board items stay top-level only.
    expect((await body(await as(admin).get(`/boards/${boardId}/items`))).data.map((i: Json) => i.name)).toEqual([
      'Parent',
    ]);

    const col = await as(admin).post(`/boards/${subBoardId}/columns`, { title: 'Hours', type: 'numbers' });
    expect(col.status).toBe(201);
    const main = await body(await as(admin).get(`/boards/${boardId}`));
    expect(main.columns.map((c: Json) => c.title)).not.toContain('Hours');
  });

  it('sub-subitems go one level deeper on the same sub-board, up to the board limit', async () => {
    const child = (await body(await as(admin).get(`/boards/${subBoardId}/items`))).data[0];
    const grand = await body(await addSub(admin, child.id, { name: 'Grandchild' }));
    expect(grand).toMatchObject({ depth: 2, board_id: subBoardId, parent_item_id: child.id });
    // New boards allow 2 levels.
    expect((await addSub(admin, grand.id, { name: 'Too deep' })).status).toBe(422);
  });

  it('rights are the parent board’s: viewers read but cannot add; the sub-board is not managed on its own', async () => {
    expect((await as(carol).get(`/boards/${subBoardId}/items`)).status).toBe(200);
    expect((await addSub(carol, parent.id, { name: 'nope' })).status).toBe(403);
    expect((await as(admin).post(`/boards/${subBoardId}/items`, { name: 'orphan' })).status).toBe(400);
    expect((await as(admin).patch(`/boards/${subBoardId}`, { name: 'x' })).status).toBe(400);
    expect((await as(admin).del(`/boards/${subBoardId}`)).status).toBe(400);
  });

  it('a mirror on the parent reads the subitems', async () => {
    const hours = (await body(await as(admin).get(`/boards/${subBoardId}`))).columns.find(
      (c: Json) => c.title === 'Hours',
    );
    const subs = (await body(await as(admin).get(`/boards/${subBoardId}/items`))).data as Json[];
    await as(admin).put(`/items/${subs[0]!.id}/cells/${hours.id}`, { value: 3 });
    await as(admin).put(`/items/${subs[1]!.id}/cells/${hours.id}`, { value: 4.5 });
    const mirror = await body(
      await as(admin).post(`/boards/${boardId}/columns`, {
        title: 'Total hours',
        type: 'mirror',
        settings: { relation_column_id: '__subitems__', source_column_id: hours.id, aggregate: 'sum' },
      }),
    );
    const p = await body(await as(admin).get(`/items/${parent.id}`));
    expect(p.cells[mirror.id]).toMatchObject({ text: '7.5' });
  });

  it('deleting the parent takes its subitems to trash and restore brings them back; purge removes all', async () => {
    const del = await body(await as(admin).del(`/items/${parent.id}`));
    expect((await body(await as(admin).get(`/boards/${subBoardId}/items`))).data).toEqual([]);
    await as(admin).post(`/activity/${del.event_id}/undo`, {});
    expect((await body(await as(admin).get(`/boards/${subBoardId}/items`))).data).toHaveLength(3);

    // Deleting the whole board and purging it removes the sub-board and its items too.
    await as(admin).del(`/boards/${boardId}`);
    expect((await as(admin).get(`/boards/${subBoardId}`)).status).toBe(404);
    await as(admin).del('/trash');
    const errors: string[] = [];
    await purgeTrash(t.pg, 1000, (m) => errors.push(m));
    expect(errors).toEqual([]);
    const left = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from boards where id = ${subBoardId} or parent_board_id = ${boardId}`,
    );
    expect(Number(left.rows[0]!.n)).toBe(0);
  });
});

describe('subitem order (M4.5)', () => {
  it('"add below" lands right after the subitem; reorder moves among siblings; undo puts it back', async () => {
    // The tests above purge their board: this one has its own.
    const board = await body(await as(admin).post('/boards', { name: 'Order', workspace_id: wsId }));
    const p = await newItem('Ordered', board.id);
    const a = await body(await addSub(admin, p.id, { name: 'A' }));
    await addSub(admin, p.id, { name: 'B' });
    const c = await body(await addSub(admin, p.id, { name: 'C' }));
    const order = async () =>
      ((await body(await as(admin).get(`/boards/${a.board_id}/items`))).data as Json[])
        .filter((i) => i.parent_item_id === p.id)
        .map((i) => i.name);
    expect((await addSub(admin, p.id, { name: 'D', position: { after_id: a.id } })).status).toBe(201);
    expect(await order()).toEqual(['A', 'D', 'B', 'C']);

    const reordered = await as(admin).post(`/items/${c.id}/reorder`, { position: 'top' });
    expect(reordered.status).toBe(200);
    // The move's event comes back, so Ctrl+Z can undo the drag (Fix: ).
    const reorderEvent = (await body(reordered)).event_id;
    expect(reorderEvent).toEqual(expect.any(String));
    expect(await order()).toEqual(['C', 'A', 'D', 'B']);
    expect((await as(carol).post(`/items/${c.id}/reorder`, { position: 'bottom' })).status).toBe(403); // viewer
    expect((await as(admin).post(`/items/${p.id}/reorder`, { position: 'top' })).status).toBe(400); // not a subitem

    const ev = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where item_id = ${c.id} and type = 'item.reordered' order by id desc limit 1`,
      )
    ).rows[0]!;
    expect(ev.id).toBe(reorderEvent);
    expect((await as(admin).post(`/activity/${ev.id}/undo`, {})).status).toBe(200);
    expect(await order()).toEqual(['A', 'D', 'B', 'C']);
  });

  it('reparent (fix6-table 5): a subitem moves under another item or subitem, at a position; undo puts it back', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Reparent', workspace_id: wsId }));
    const p1 = await newItem('P1', board.id);
    const p2 = await newItem('P2', board.id);
    const a = await body(await addSub(admin, p1.id, { name: 'A' }));
    const b = await body(await addSub(admin, p1.id, { name: 'B' }));
    const x = await body(await addSub(admin, p2.id, { name: 'X' }));
    const y = await body(await addSub(admin, p2.id, { name: 'Y' }));
    const all = async () => (await body(await as(admin).get(`/boards/${a.board_id}/items`))).data as Json[];
    const under = async (id: string) =>
      (await all()).filter((i) => i.parent_item_id === id).map((i) => i.name as string);
    const reparent = (cookie: string, id: string, payload: Json) => as(cookie).post(`/items/${id}/reparent`, payload);

    // Under another top-level item, between its subitems.
    const res = await reparent(admin, a.id, { parent_item_id: p2.id, position: { after_id: x.id } });
    expect(res.status).toBe(200);
    const moved = await body(res);
    expect(moved).toMatchObject({ ok: true, dropped: 0 });
    expect(await under(p2.id)).toEqual(['X', 'A', 'Y']);
    expect(await under(p1.id)).toEqual(['B']);

    // Under another subitem (one level deeper); default = last.
    expect((await reparent(admin, b.id, { parent_item_id: x.id })).status).toBe(200);
    const bNow = (await all()).find((i) => i.id === b.id)!;
    expect(bNow).toMatchObject({ parent_item_id: x.id, depth: 2 });

    // The depth limit (2 levels) covers the whole branch: X (with B under it) cannot go under Y.
    expect((await reparent(admin, x.id, { parent_item_id: y.id })).status).toBe(422);
    // No cycles: not under itself or its own subitem.
    expect((await reparent(admin, x.id, { parent_item_id: x.id })).status).toBe(400);
    expect((await reparent(admin, x.id, { parent_item_id: b.id })).status).toBe(400);
    // Not a subitem / another board's item / a viewer.
    expect((await reparent(admin, p1.id, { parent_item_id: p2.id })).status).toBe(400);
    const elsewhere = await body(await as(admin).post('/boards', { name: 'Elsewhere', workspace_id: wsId }));
    const other = await newItem('Elsewhere', elsewhere.id);
    expect((await reparent(admin, y.id, { parent_item_id: other.id })).status).toBe(400);
    expect((await reparent(carol, y.id, { parent_item_id: p1.id })).status).toBe(403);

    // The event is recorded, and undo brings A back under P1 (its old place).
    const ev = (await t.db.execute<{ type: string }>(sql`select type from activity_log where id = ${moved.event_id}`))
      .rows[0]!;
    expect(ev.type).toBe('item.converted');
    expect((await as(admin).post(`/activity/${moved.event_id}/undo`, {})).status).toBe(200);
    expect(await under(p1.id)).toEqual(['A']);
    expect(await under(p2.id)).toEqual(['X', 'Y']);
  });

  it('outdent (Fix: ): one level up — sub-subitem under its grandparent, subitem to an item; undo', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Outdent', workspace_id: wsId }));
    const p1 = await newItem('P1', board.id);
    const p2 = await newItem('P2', board.id);
    const a = await body(await addSub(admin, p1.id, { name: 'A', cells: { status: { index: 1 } } }));
    const b = await body(await addSub(admin, p1.id, { name: 'B' }));
    const a1 = await body(await addSub(admin, a.id, { name: 'A1' }));
    const a2 = await body(await addSub(admin, a.id, { name: 'A2' }));
    const subId = a.board_id as string;
    const subs = async () => (await body(await as(admin).get(`/boards/${subId}/items`))).data as Json[];
    const tops = async () =>
      ((await body(await as(admin).get(`/boards/${board.id}/items`))).data as Json[])
        .filter((i) => !i.parent_item_id)
        .map((i) => i.name as string);
    const under = async (id: string) =>
      (await subs()).filter((i) => i.parent_item_id === id).map((i) => i.name as string);
    const outdent = (cookie: string, id: string) => as(cookie).post(`/items/${id}/outdent`, {});

    // A sub-subitem → a subitem of its grandparent, right after its old parent.
    const r1 = await outdent(admin, a1.id);
    expect(r1.status).toBe(200);
    const m1 = await body(r1);
    expect(m1).toMatchObject({ ok: true, dropped: 0 });
    expect(await under(p1.id)).toEqual(['A', 'A1', 'B']);
    expect((await subs()).find((i) => i.id === a1.id)).toMatchObject({ parent_item_id: p1.id, depth: 1 });
    expect(await under(a.id)).toEqual(['A2']);
    // Undo puts it back under A.
    expect((await as(admin).post(`/activity/${m1.event_id}/undo`, {})).status).toBe(200);
    expect(await under(a.id)).toEqual(['A1', 'A2']);

    // A subitem (with its own subitems) → an item in its parent's group, right after its parent; status mapped.
    const r2 = await outdent(admin, a.id);
    expect(r2.status).toBe(200);
    const m2 = await body(r2);
    expect(await tops()).toEqual(['P1', 'A', 'P2']);
    const items = (await body(await as(admin).get(`/boards/${board.id}/items`))).data as Json[];
    const aNow = items.find((i) => i.id === a.id)!;
    expect(aNow).toMatchObject({ parent_item_id: null, depth: 0, group_id: p1.group_id });
    expect((await subs()).filter((i) => i.parent_item_id === a.id).map((i) => [i.name, i.depth])).toEqual([
      ['A1', 1],
      ['A2', 1],
    ]);
    // Undo: A is a subitem of P1 again, A1/A2 under it at depth 2.
    expect((await as(admin).post(`/activity/${m2.event_id}/undo`, {})).status).toBe(200);
    expect(await under(p1.id)).toEqual(['A', 'B']);
    expect((await subs()).find((i) => i.id === a2.id)).toMatchObject({ parent_item_id: a.id, depth: 2 });

    // A top-level item cannot go up; a viewer may not.
    expect((await outdent(admin, p2.id)).status).toBe(400);
    expect((await outdent(carol, b.id)).status).toBe(403);
  });

  it('filters read the subitems: a sub: rule, and match_children for search (13 §1)', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Filtered', workspace_id: wsId }));
    const withDone = await newItem('With done', board.id);
    const without = await newItem('Without', board.id);
    await addSub(admin, withDone.id, { name: 'finished part', cells: { status: { index: 1 } } });
    await addSub(admin, without.id, { name: 'open part' });
    const sub = (await body(await as(admin).get(`/boards/${board.id}`))).subitems_board_id as string;
    const done = (await body(await as(admin).get(`/boards/${sub}`))).columns
      .find((c: Json) => c.type === 'status')
      .settings.labels.find((l: Json) => l.id === 1).label as string;
    const query = async (q: Json) =>
      ((await body(await as(admin).post(`/boards/${board.id}/items/query`, q))).data as Json[]).map((i) => i.name);
    expect(
      await query({
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ column_id: 'sub:status', operator: 'any_of', values: [done] }],
        },
      }),
    ).toEqual(['With done']);
    // The search always reads the subitems (owner fix), with or without match_children.
    expect(await query({ search: 'open part' })).toEqual(['Without']);
    expect(await query({ search: 'open part', match_children: true })).toEqual(['Without']);
  });
});
