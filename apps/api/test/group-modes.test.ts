// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Prod ק2: the server's outline groups by the view's mode (ranges, combination, first letter …). */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme-group-modes',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Modes', workspace_id: ws }))).id;
  await as().post(`/boards/${boardId}/columns`, { id: 'amt', title: 'Amount', type: 'numbers' });
  await as().post(`/boards/${boardId}/columns`, {
    id: 'dd',
    title: 'Tags',
    type: 'dropdown',
    settings: {
      labels: [
        { id: 1, label: 'Urgent' },
        { id: 2, label: 'Client' },
      ],
    },
  });
  for (const [name, amt, ids] of [
    ['Alpha', 120, [1, 2]],
    ['Avi', 450, [2]],
    ['Beta', 980, [2]],
  ] as const)
    await as().post(`/boards/${boardId}/items`, { name, cells: { amt, dd: { ids } } });
});
afterAll(() => t.close());

const outline = async (group_by: Json) => {
  const res = await as().post(`/boards/${boardId}/items/outline`, { query: { group_by }, summaries: [] });
  expect(res.status).toBe(200);
  return ((await body(res)).sections as Json[]).map((s) => [s.key, s.ids.length]);
};

describe('group modes on the server ( ק2)', () => {
  it('numbers: ranges by default (a round size), a size from the view, or exact', async () => {
    expect(await outline({ column_id: 'amt' })).toEqual([
      ['0', 1],
      ['400', 1],
      ['800', 1],
    ]);
    expect(await outline({ column_id: 'amt', range_size: 500 })).toEqual([
      ['0', 2],
      ['500', 1],
    ]);
    expect((await outline({ column_id: 'amt', mode: 'exact' })).map(([k]) => k)).toEqual(['120', '450', '980']);
  });

  it('a dropdown by each label or by the combination', async () => {
    expect(await outline({ column_id: 'dd' })).toEqual([
      ['1', 1],
      ['2', 3],
    ]);
    // Combinations sort by their names: "Client" before "Urgent + Client".
    expect(await outline({ column_id: 'dd', mode: 'combo' })).toEqual([
      ['combo:2', 2],
      ['combo:1|2', 1],
    ]);
  });
});
