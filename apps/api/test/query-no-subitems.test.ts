// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Owner fix6-server 1: an item without subitems is not excluded by subitem (`sub:`) rules. */
let t: TestContext;
let admin: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('subitem rules and items without subitems', () => {
  it('keeps items without subitems for every operator; Person stays by own columns only', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }));
    const item = async (name: string) => body(await as(admin).post(`/boards/${board.id}/items`, { name }));
    const allDone = await item('All done');
    const open = await item('Open');
    await item('No subitems');
    await as(admin).post(`/items/${allDone.id}/subitems`, { name: 'p1', cells: { status: { index: 1 } } });
    await as(admin).post(`/items/${open.id}/subitems`, { name: 'p2', cells: { status: { index: 0 } } });
    const sub = (await body(await as(admin).get(`/boards/${board.id}`))).subitems_board_id as string;
    const labels = (await body(await as(admin).get(`/boards/${sub}`))).columns.find((c: Json) => c.type === 'status')
      .settings.labels as Json[];
    const done = labels.find((l) => l.id === 1)!.label as string;
    const query = async (q: Json) => {
      const res = await as(admin).post(`/boards/${board.id}/items/query`, q);
      expect(res.status).toBe(200);
      return ((await body(res)).data as Json[]).map((i) => i.name);
    };
    const rule = (operator: string, values: unknown[] = []) => ({
      filter: { kind: 'group', operator: 'and', rules: [{ column_id: 'sub:status', operator, values }] },
    });
    // The reported case: "sub-status is not Done" keeps the item that has no subitems at all.
    expect(await query(rule('not_any_of', [done]))).toEqual(['Open', 'No subitems']);
    expect(await query(rule('is_not_done'))).toEqual(['Open', 'No subitems']);
    expect(await query(rule('any_of', [done]))).toEqual(['All done', 'No subitems']);
    expect(await query(rule('is_empty'))).toEqual(['No subitems']);
    // The total agrees with the list, and paging works over it.
    const page = await body(
      await as(admin).post(`/boards/${board.id}/items/query`, { ...rule('is_not_done'), limit: 1 }),
    );
    expect(page.total).toBe(2);
    expect(page.data).toHaveLength(1);
    // Together with an own condition (the search): the item without subitems is judged by it.
    expect(await query({ ...rule('is_not_done'), search: 'no sub' })).toEqual(['No subitems']);
    // Person with match_children: nobody is assigned anywhere → nothing (not every item without subitems).
    const me = ((await body(await as(admin).get('/users'))).data as Json[]).find((u) => u.email === 'admin@acme.test')!
      .user_id as string;
    expect(await query({ person: me, match_children: true })).toEqual([]);
  });
});
