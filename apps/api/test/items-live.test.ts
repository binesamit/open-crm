// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * `GET /boards/:id/items?ids=` (perf review): a live board refreshes only the rows an event named. The rows must be
 * exactly what the whole-board list shows for them (computed columns included); ids that are gone, archived, on
 * another board or hidden are left out — that is how the client knows to drop them.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let boardId: string;
let otherBoardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const byIds = async (cookie: string, ids: string[], board = boardId) =>
  as(cookie).get(`/boards/${board}/items?ids=${ids.join(',')}`);

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
  otherBoardId = (await body(await as(admin).post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
  await as(admin).post(`/boards/${otherBoardId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
  await as(admin).post(`/boards/${boardId}/columns`, {
    id: 'total',
    title: 'Total',
    type: 'formula',
    settings: { formula: '{amount}*2' },
  });
  await as(admin).post(`/boards/${boardId}/columns`, {
    id: 'client',
    title: 'Client',
    type: 'board_relation',
    settings: { board_ids: [otherBoardId] },
  });
  await as(admin).post(`/boards/${boardId}/columns`, {
    id: 'client_amount',
    title: 'Client amount',
    type: 'mirror',
    settings: { relation_column_id: 'client', source_column_id: 'amount' },
  });
});
afterAll(() => t.close());

describe('GET /boards/:id/items?ids= (live row refresh)', () => {
  it('returns just those rows, identical to the whole-board list, computed columns included', async () => {
    const client = await body(
      await as(admin).post(`/boards/${otherBoardId}/items`, { name: 'Client A', cells: { amount: 7 } }),
    );
    const ids: string[] = [];
    for (const [i, name] of ['One', 'Two', 'Three'].entries()) {
      const item = await body(
        await as(admin).post(`/boards/${boardId}/items`, {
          name,
          cells: { amount: i + 1, client: { item_ids: [client.id] } },
        }),
      );
      ids.push(item.id);
    }
    const all = (await body(await as(bob).get(`/boards/${boardId}/items`))).data as Json[];
    const res = await byIds(bob, [ids[2]!, ids[0]!]);
    expect(res.status).toBe(200);
    const some = (await body(res)).data as Json[];
    // Board order, not request order.
    expect(some.map((i) => i.name)).toEqual(['One', 'Three']);
    expect(some).toEqual(all.filter((i) => i.id === ids[0] || i.id === ids[2]));
    expect(some[1]!.cells.total.value).toEqual({ result: 6 });
    expect(some[1]!.cells.client_amount.value).toMatchObject({ number: 7 });
  });

  it('leaves out deleted, archived, foreign and unknown ids; empty list → no rows', async () => {
    const [a, b, c] = await Promise.all(
      ['Keep', 'Gone', 'Shelved'].map(async (name) => body(await as(admin).post(`/boards/${boardId}/items`, { name }))),
    );
    const foreign = await body(await as(admin).post(`/boards/${otherBoardId}/items`, { name: 'Elsewhere' }));
    expect((await as(admin).del(`/items/${b!.id}`)).status).toBe(200);
    expect((await as(admin).post(`/items/${c!.id}/archive`)).status).toBe(200);
    const rows = (await body(await byIds(bob, [a!.id, b!.id, c!.id, foreign.id, 'nope']))).data as Json[];
    expect(rows.map((i) => i.name)).toEqual(['Keep']);
    expect((await body(await byIds(bob, []))).data).toEqual([]);
  });

  it('respects board access and the 200-id limit', async () => {
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Private?' }));
    const tooMany = Array.from({ length: 201 }, (_, i) => `${item.id.slice(0, 20)}${String(i).padStart(6, '0')}`);
    expect((await byIds(bob, tooMany)).status).toBe(400);
    const stranger = await t.api(admin, acmeId).get(`/boards/01ZZZZZZZZZZZZZZZZZZZZZZZZ/items?ids=${item.id}`);
    expect(stranger.status).toBe(404);
  });
});

describe('compression (perf review)', () => {
  it('gzips JSON when the client accepts it; small and streaming answers stay plain', async () => {
    for (let i = 0; i < 30; i++)
      await as(admin).post(`/boards/${boardId}/items`, { name: `Row ${i} ${'x'.repeat(40)}` });
    const big = await as(bob).call('GET', `/boards/${boardId}/items`, undefined, { 'accept-encoding': 'gzip' });
    expect(big.headers.get('content-encoding')).toBe('gzip');
    const unzipped = await new Response(big.body!.pipeThrough(new DecompressionStream('gzip'))).json();
    expect((unzipped as Json).data.length).toBeGreaterThan(30);
    const plain = await as(bob).get(`/boards/${boardId}/items`);
    expect(plain.headers.get('content-encoding')).toBeNull();
    const small = await t.app.request('/api/v1/health', { headers: { 'accept-encoding': 'gzip' } });
    expect(small.headers.get('content-encoding')).toBeNull();
  });
});
