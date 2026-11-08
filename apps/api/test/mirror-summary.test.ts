// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * a mirror column carries its source's type and number display (`mirror_source`), so its group
 * footer offers the source's summaries — and the server's outline (windowed boards) sums it the same way.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let summaryId: string;
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
        slug: 'acme-mirror-sum',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const ws = (await body(await as().get('/workspaces'))).data[0].id;

  const deals = await body(await as().post('/boards', { name: 'Deals', workspace_id: ws }));
  await as().post(`/boards/${deals.id}/columns`, {
    id: 'amount',
    title: 'Amount',
    type: 'numbers',
    settings: { unit: { symbol: '₪', direction: 'left' }, thousands: true },
  });
  await as().post(`/boards/${deals.id}/columns`, { id: 'stage', title: 'Stage', type: 'status' });
  const a = await body(
    await as().post(`/boards/${deals.id}/items`, { name: 'A', cells: { amount: 1200, stage: { index: 1 } } }),
  );
  const b = await body(
    await as().post(`/boards/${deals.id}/items`, { name: 'B', cells: { amount: 300, stage: { index: 1 } } }),
  );

  const summary = await body(await as().post('/boards', { name: 'Clients', workspace_id: ws }));
  summaryId = summary.id;
  await as().post(`/boards/${summaryId}/columns`, {
    id: 'rel',
    title: 'Deals',
    type: 'board_relation',
    settings: { board_ids: [deals.id], allow_multiple: true },
  });
  for (const [id, source, aggregate] of [
    ['total', 'amount', 'sum'],
    ['stages', 'stage', undefined],
    ['deals', 'amount', 'count'],
  ] as const)
    await as().post(`/boards/${summaryId}/columns`, {
      id,
      title: id,
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: source, ...(aggregate ? { aggregate } : {}) },
    });
  // A mirror of a mirror resolves to the source at the end of the chain.
  const top = await body(await as().post('/boards', { name: 'Regions', workspace_id: ws }));
  await as().post(`/boards/${top.id}/columns`, {
    id: 'rel2',
    title: 'Clients',
    type: 'board_relation',
    settings: { board_ids: [summaryId], allow_multiple: true },
  });
  await as().post(`/boards/${top.id}/columns`, {
    id: 'm2',
    title: 'm2',
    type: 'mirror',
    settings: { relation_column_id: 'rel2', source_column_id: 'total' },
  });
  (globalThis as { topId?: string }).topId = top.id;

  await as().post(`/boards/${summaryId}/items`, { name: 'X', cells: { rel: { item_ids: [a.id] } } });
  await as().post(`/boards/${summaryId}/items`, { name: 'Y', cells: { rel: { item_ids: [b.id] } } });
});
afterAll(() => t.close());

describe('mirror footer summaries', () => {
  it("a mirror column carries its source's type and number display (a label source: its labels)", async () => {
    const cols = (await body(await as().get(`/boards/${summaryId}`))).columns as Json[];
    const col = (id: string) => cols.find((c) => c.id === id)!;
    expect(col('total').mirror_source).toEqual({
      type: 'numbers',
      settings: { unit: { symbol: '₪', direction: 'left' }, thousands: true },
    });
    // a status source brings its labels (text, colour, done) — the filter offers them.
    expect(col('stages').mirror_source.type).toBe('status');
    expect(Object.keys(col('stages').mirror_source.settings)).toEqual(['labels']);
    for (const l of col('stages').mirror_source.settings.labels as Json[])
      expect(Object.keys(l).every((k) => ['id', 'label', 'color', 'is_done', 'is_deactivated'].includes(k))).toBe(true);
    expect(col('deals').mirror_source.type).toBe('numbers');
    expect(col('rel').mirror_source).toBeUndefined();
    const top = await body(await as().get(`/boards/${(globalThis as { topId?: string }).topId}`));
    expect(top.columns.find((c: Json) => c.id === 'm2').mirror_source.type).toBe('numbers');
  });

  it('a viewer who cannot read the source board, or the source column, gets no source', async () => {
    await as().post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
    const token = t.inviteTokenFor('bob@acme.test');
    const bob = t.cookieFrom(await t.signUpWithPassword('bob@acme.test', token))!;
    await t.api(bob).post('/invitations/accept', { token });
    const asBob = () => t.api(bob, acmeId);
    const ws = (await body(await as().get('/workspaces'))).data[0].id;

    const secret = await body(await as().post('/boards', { name: 'Payroll', workspace_id: ws, kind: 'private' }));
    await as().post(`/boards/${secret.id}/columns`, {
      id: 'salary',
      title: 'Salary',
      type: 'numbers',
      settings: { unit: { symbol: '$', direction: 'left' } },
    });
    // A readable board whose source column is restricted from members.
    const open = await body(await as().post('/boards', { name: 'Costs', workspace_id: ws }));
    await as().post(`/boards/${open.id}/columns`, { id: 'cost', title: 'Cost', type: 'numbers' });
    await as().post(`/boards/${open.id}/columns`, { id: 'price', title: 'Price', type: 'numbers' });
    expect((await as().put(`/boards/${open.id}/columns/cost/restriction`, { kind: 'view' })).status).toBe(200);

    const view = await body(await as().post('/boards', { name: 'Overview', workspace_id: ws }));
    for (const [id, target] of [
      ['rs', secret.id],
      ['ro', open.id],
    ] as const)
      await as().post(`/boards/${view.id}/columns`, {
        id,
        title: id,
        type: 'board_relation',
        settings: { board_ids: [target], allow_multiple: true },
      });
    for (const [id, rel, source] of [
      ['m_secret', 'rs', 'salary'],
      ['m_cost', 'ro', 'cost'],
      ['m_price', 'ro', 'price'],
    ] as const)
      await as().post(`/boards/${view.id}/columns`, {
        id,
        title: id,
        type: 'mirror',
        settings: { relation_column_id: rel, source_column_id: source },
      });

    const source = async (cookie: () => ReturnType<typeof as>, id: string) =>
      ((await body(await cookie().get(`/boards/${view.id}`))).columns as Json[]).find((c) => c.id === id)
        ?.mirror_source;
    // The admin reads everything.
    expect((await source(as, 'm_secret')).settings.unit.symbol).toBe('$');
    expect((await source(as, 'm_cost')).type).toBe('numbers');
    // Bob: not the private board, not the restricted column — only the column he may see.
    expect(await source(asBob, 'm_secret')).toBeNull();
    expect(await source(asBob, 'm_cost')).toBeNull();
    expect((await source(asBob, 'm_price')).type).toBe('numbers');
  });

  it('the server outline sums a mirror the source way and shows the battery of its labels', async () => {
    const outline = async (summaries: Json[]) => {
      const res = await as().post(`/boards/${summaryId}/items/outline`, { query: {}, summaries });
      expect(res.status).toBe(200);
      return (await body(res)).sections[0].summaries as Json;
    };
    const first = await outline([{ column_id: 'total' }, { column_id: 'stages' }, { column_id: 'deals' }]);
    expect(first.total).toEqual({ kind: 'value', fn: 'sum', text: '₪1,500' });
    expect(first.stages).toMatchObject({ kind: 'battery', total: 2 });
    // Counting mirrors sum plain counts.
    expect(first.deals).toEqual({ kind: 'value', fn: 'sum', text: '2' });
    expect((await outline([{ column_id: 'total', fn: 'avg' }])).total).toEqual({
      kind: 'value',
      fn: 'avg',
      text: '₪750',
    });
  });
});
