// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeQuery } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * `GET /boards/:id/items?columns=` (06-API §1.7): field selection — each item's `cells` holds only the listed columns,
 * the item's own fields always come, unknown ids are left out, restricted columns stay hidden, caps → 400.
 */
let t: TestContext;
let admin: string;
let bob: string;
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
const as = (cookie: string) => t.api(cookie, acmeId);
const list = async (cookie: string, query: string) =>
  (await body(await as(cookie).get(`/boards/${boardId}/items${query}`))).data as Json[];

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
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: wsId }))).id;
  await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'all' } });
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'note', title: 'Note', type: 'text' });
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'price', title: 'Price', type: 'numbers' });
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Deal 1' }))).id;
  await as(admin).put(`/items/${itemId}/cells/amount`, { value: 10 });
  await as(admin).put(`/items/${itemId}/cells/note`, { value: 'hi' });
  await as(admin).put(`/items/${itemId}/cells/price`, { value: 99 });
});
afterAll(() => t.close());

describe('GET /boards/:id/items?columns= (field selection)', () => {
  it('without columns every cell comes; with columns only those (the item fields stay)', async () => {
    const all = (await list(admin, '')).find((i) => i.id === itemId)!;
    expect(Object.keys(all.cells)).toEqual(expect.arrayContaining(['amount', 'note', 'price']));

    const [one] = await list(admin, '?columns=amount, note');
    expect(Object.keys(one!.cells).sort()).toEqual(['amount', 'note']);
    expect(one!.cells.amount.value).toBe(10);
    expect(one).toMatchObject({ id: itemId, name: 'Deal 1', board_id: boardId });
    expect(one!.created_at).toBeTruthy();
  });

  it('unknown ids are left out, an empty selection gives no cells', async () => {
    const [one] = await list(admin, '?columns=amount,nope,does_not_exist');
    expect(Object.keys(one!.cells)).toEqual(['amount']);
    const [none] = await list(admin, '?columns=');
    expect(none!.cells).toEqual({});
  });

  it('combines with ids= and q=', async () => {
    const [byId] = await list(admin, `?ids=${itemId}&columns=note`);
    expect(Object.keys(byId!.cells)).toEqual(['note']);
    const q = encodeQuery({
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [{ column_id: 'amount', operator: 'greater_than', values: [5] }],
      },
    } as never);
    const [byQ] = await list(admin, `?q=${q}&columns=price`);
    expect(Object.keys(byQ!.cells)).toEqual(['price']);
  });

  it('a column the caller may not see stays hidden even when asked for', async () => {
    await as(admin).put(`/boards/${boardId}/columns/price/restriction`, { kind: 'view' });
    const [mine] = await list(bob, '?columns=price,amount');
    expect(Object.keys(mine!.cells)).toEqual(['amount']);
    const [owner] = await list(admin, '?columns=price,amount');
    expect(Object.keys(owner!.cells).sort()).toEqual(['amount', 'price']);
    await as(admin).put(`/boards/${boardId}/columns/price/restriction`, { kind: null });
  });

  it('too many ids or a too long id → 400 validation_failed', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `c${i}`).join(',');
    const res = await as(admin).get(`/boards/${boardId}/items?columns=${many}`);
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe('validation_failed');
    const long = await as(admin).get(`/boards/${boardId}/items?columns=${'x'.repeat(65)}`);
    expect(long.status).toBe(400);
  });

  it('is in the OpenAPI document', async () => {
    const doc = (await (await t.app.request('/api/docs/openapi.json')).json()) as Json;
    const params = doc.paths['/boards/{boardId}/items'].get.parameters as Json[];
    expect(params.map((p) => p.name)).toContain('columns');
  });
});
