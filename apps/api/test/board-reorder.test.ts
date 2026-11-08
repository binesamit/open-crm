// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod (drag groups) and (drag columns on the default table): the table saves both through the
 * board's own order — groups by `POST …/groups/{id}/reorder`, the default table's columns by `POST …/columns/{id}/reorder`
 * (the default table never keeps its own `column_order`, so it shows the board's). Viewers may do neither.
 */
let t: TestContext;
let admin: string;
let vera: string;
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie = admin) => t.api(cookie, acmeId);
const board = async () => body(await as().get(`/boards/${boardId}`));

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
  boardId = (await body(await as().post('/boards', { name: 'סדר', workspace_id: ws }))).id;
  for (const title of ['ב', 'ג']) await as().post(`/boards/${boardId}/groups`, { title, position: 'bottom' });
  for (const [id, type] of [
    ['a', 'text'],
    ['b', 'numbers'],
    ['c', 'status'],
  ])
    await as().post(`/boards/${boardId}/columns`, { id, title: id, type });
});
afterAll(() => t.close());

describe('dragging a group', () => {
  it('moves it before / after another group, and the order stays', async () => {
    const [first, , last] = (await board()).groups as [Json, Json, Json];
    const res = await as().post(`/boards/${boardId}/groups/${last.id}/reorder`, {
      position: { before_id: first.id },
    });
    expect(res.status).toBe(200);
    expect((await board()).groups.map((g: Json) => g.id)[0]).toBe(last.id);
    await as().post(`/boards/${boardId}/groups/${last.id}/reorder`, { position: { after_id: first.id } });
    expect((await board()).groups.map((g: Json) => g.id).slice(0, 2)).toEqual([first.id, last.id]);
  });

  it('a viewer cannot move groups', async () => {
    const [first, second] = (await board()).groups as [Json, Json];
    const res = await as(vera).post(`/boards/${boardId}/groups/${second.id}/reorder`, {
      position: { before_id: first.id },
    });
    expect(res.status).toBe(403);
    expect((await board()).capabilities['group.reorder']).toBe(true);
  });
});

describe('dragging a column on the default table', () => {
  it('reorders the board’s columns, which the default table shows (it keeps no order of its own)', async () => {
    const res = await as().post(`/boards/${boardId}/columns/c/reorder`, { position: { before_id: 'a' } });
    expect(res.status).toBe(200);
    const keys = (await board()).columns.map((c: Json) => c.id).filter((k: string) => ['a', 'b', 'c'].includes(k));
    expect(keys).toEqual(['c', 'a', 'b']);
    const views = await body(await as().get(`/boards/${boardId}/views`));
    const main = views.data.find((v: Json) => v.is_system);
    expect(main.settings.column_order).toEqual([]);
    // The default table itself never takes settings (its changes become a new view).
    expect((await as().patch(`/views/${main.id}`, { settings: { column_order: ['b'] } })).status).toBe(403);
  });

  it('a viewer cannot reorder the board’s columns', async () => {
    expect((await as(vera).post(`/boards/${boardId}/columns/a/reorder`, { position: 'top' })).status).toBe(403);
  });
});

describe('the default table’s column order: shared or personal', () => {
  it('is shared by default; board.update switches it, a viewer cannot', async () => {
    expect((await board()).main_table_column_order).toBe('shared');
    expect((await as(vera).patch(`/boards/${boardId}`, { main_table_column_order: 'personal' })).status).toBe(403);
    const res = await as().patch(`/boards/${boardId}`, { main_table_column_order: 'personal' });
    expect(res.status).toBe(200);
    expect((await body(res)).main_table_column_order).toBe('personal');
    expect((await as().patch(`/boards/${boardId}`, { main_table_column_order: 'mine' })).status).toBe(400);
  });

  it('personal: each person’s order is kept in their own prefs of the default table (a viewer too)', async () => {
    const main = (await body(await as().get(`/boards/${boardId}/views`))).data.find((v: Json) => v.is_system);
    expect((await as(vera).put(`/views/${main.id}/prefs`, { column_order: ['b', 'a', 'c'] })).status).toBe(200);
    await as().put(`/views/${main.id}/prefs`, { column_order: ['a', 'b', 'c'] });
    const mine = async (cookie: string) =>
      (await body(await as(cookie).get(`/boards/${boardId}/views`))).data.find((v: Json) => v.is_system).prefs;
    expect((await mine(vera)).column_order).toEqual(['b', 'a', 'c']);
    expect((await mine(admin)).column_order).toEqual(['a', 'b', 'c']);
    // The board's own order is untouched.
    const keys = (await board()).columns.map((c: Json) => c.id).filter((k: string) => ['a', 'b', 'c'].includes(k));
    expect(keys).toEqual(['c', 'a', 'b']);
  });
});
