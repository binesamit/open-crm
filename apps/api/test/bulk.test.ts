// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 07 §6: batch actions — one batch_id, skipped items counted, the whole batch undone at once. */
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // viewer
let acmeId: string;
let wsId: string;
let boardId: string;
let groups: { id: string }[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newItem = async (name: string, cookie = admin, board = boardId) =>
  (await body(await as(cookie).post(`/boards/${board}/items`, { name }))) as Json;
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const bulk = (cookie: string, item_ids: string[], action: Json, board = boardId) =>
  as(cookie).post(`/boards/${board}/items/bulk`, { item_ids, action });

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
  const board = await body(await as(admin).post('/boards', { name: 'Bulk', workspace_id: wsId }));
  boardId = board.id;
  await as(admin).post(`/boards/${boardId}/groups`, { title: 'Second', position: 'bottom' });
  groups = (await body(await as(admin).get(`/boards/${boardId}`))).groups;
});
afterAll(() => t.close());

describe('bulk', () => {
  it('deletes many as one batch; undoing the summary brings them all back', async () => {
    const ids = [(await newItem('d1')).id, (await newItem('d2')).id, (await newItem('d3')).id];
    const res = await body(await bulk(admin, ids, { type: 'delete' }));
    expect(res).toMatchObject({ ok: true, done: 3, skipped: 0, batch_id: expect.any(String) });
    for (const id of ids) expect((await as(admin).get(`/items/${id}`)).status).toBe(404);
    expect(await body(await as(admin).post(`/activity/${res.event_id}/undo`, {}))).toMatchObject({
      ok: true,
      undone: 3,
    });
    for (const id of ids) expect((await as(admin).get(`/items/${id}`)).status).toBe(200);
  });

  it('moves to a group (bottom, in selection order) and undoes', async () => {
    const a = await newItem('m1');
    const b = await newItem('m2');
    const target = groups[1]!.id;
    const res = await body(await bulk(admin, [b.id, a.id], { type: 'move_to_group', group_id: target }));
    expect(res.done).toBe(2);
    const [ma, mb] = [await getItem(a.id), await getItem(b.id)];
    expect([ma.group_id, mb.group_id]).toEqual([target, target]);
    expect(mb.position < ma.position).toBe(true);
    await as(admin).post(`/activity/${res.event_id}/undo`, {});
    expect((await getItem(a.id)).group_id).toBe(groups[0]!.id);
  });

  it('sets and clears a cell on many items; a bad value fails the whole request', async () => {
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'N', type: 'numbers' }));
    const ids = [(await newItem('s1')).id, (await newItem('s2')).id];
    expect((await body(await bulk(admin, ids, { type: 'set_cell', column_id: col.id, value: 5 }))).done).toBe(2);
    for (const id of ids) expect((await getItem(id)).cells[col.id].value).toEqual(5);
    expect((await bulk(admin, ids, { type: 'set_cell', column_id: col.id, value: 'x' })).status).toBe(422);
    await bulk(admin, ids, { type: 'set_cell', column_id: col.id, value: null });
    for (const id of ids) expect((await getItem(id)).cells[col.id]).toBeUndefined();
  });

  it('shifts date and timeline columns by days; other columns are refused', async () => {
    const date = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'D', type: 'date' }));
    const tl = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'T', type: 'timeline' }));
    const a = await newItem('dates a');
    const empty = await newItem('dates empty');
    await as(admin).put(`/items/${a.id}/cells/${date.id}`, { value: { date: '2026-12-30' } });
    await as(admin).put(`/items/${a.id}/cells/${tl.id}`, { value: { from: '2026-10-01', to: '2026-10-05' } });

    expect(
      (await body(await bulk(admin, [a.id, empty.id], { type: 'shift_dates', column_id: date.id, days: 3 }))).done,
    ).toBe(2);
    await bulk(admin, [a.id], { type: 'shift_dates', column_id: tl.id, days: -1 });
    const after = await getItem(a.id);
    expect(after.cells[date.id].value).toMatchObject({ date: '2027-01-02' });
    expect(after.cells[tl.id].value).toMatchObject({ from: '2026-09-30', to: '2026-10-04' });
    expect((await getItem(empty.id)).cells[date.id]).toBeUndefined();

    const num = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'X', type: 'numbers' }));
    expect((await bulk(admin, [a.id], { type: 'shift_dates', column_id: num.id, days: 1 })).status).toBe(422);
  });

  it('skips unknown items, items of another board and items an edit_assigned member may not touch', async () => {
    const other = await body(await as(admin).post('/boards', { name: 'Other', workspace_id: wsId }));
    const foreign = await newItem('foreign', admin, other.id);
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'P', type: 'numbers' }));
    await as(admin).patch(`/boards/${boardId}`, { permission_set: 'edit_assigned' });
    const mine = await newItem('bob own', bob);
    const notMine = await newItem('admin own');
    const res = await body(
      await bulk(bob, [mine.id, notMine.id, foreign.id, 'nope'], { type: 'set_cell', column_id: col.id, value: 1 }),
    );
    expect(res).toMatchObject({ done: 1, skipped: 3 });
    expect((await getItem(mine.id)).cells[col.id].value).toEqual(1);
    expect((await getItem(notMine.id)).cells[col.id]).toBeUndefined();
    await as(admin).patch(`/boards/${boardId}`, { permission_set: 'edit_everything' });
  });

  it('needs the right for the action; viewers get 403', async () => {
    const a = await newItem('v');
    expect((await bulk(carol, [a.id], { type: 'delete' })).status).toBe(403);
    expect((await bulk(admin, [], { type: 'delete' })).status).toBe(400);
  });
});
