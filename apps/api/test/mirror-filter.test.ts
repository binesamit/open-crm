// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod (product owner: "a mirror should filter like the column it mirrors"): the server filters a mirror of a status /
 * people / date column as that type — any linked item matching is a match — and a relation to two boards offers the
 * labels of both, once per text.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let clientsId: string;
let dealIds: string[] = [];
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
        slug: 'acme-mirror-filter',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const me = (await body(await t.api(admin).get('/auth/me'))).user.id as string;
  const ws = (await body(await as().get('/workspaces'))).data[0].id;

  const deals = await body(await as().post('/boards', { name: 'Deals', workspace_id: ws }));
  await as().post(`/boards/${deals.id}/columns`, { id: 'stage', title: 'Stage', type: 'status' });
  await as().post(`/boards/${deals.id}/columns`, { id: 'owner', title: 'Owner', type: 'people' });
  await as().post(`/boards/${deals.id}/columns`, { id: 'due', title: 'Due', type: 'date' });
  const labels = (await body(await as().get(`/boards/${deals.id}`))).columns.find((c: Json) => c.id === 'stage')
    .settings.labels as Json[];
  const done = labels.find((l) => l.is_done)!;
  const notDone = labels.find((l) => !l.is_done)!;
  (globalThis as { names?: Json }).names = { done: done.label, notDone: notDone.label };
  // A second linked board: the same done label, and one of its own.
  const leads = await body(await as().post('/boards', { name: 'Leads', workspace_id: ws }));
  const stage = await as().post(`/boards/${leads.id}/columns`, {
    id: 'stage',
    title: 'Stage',
    type: 'status',
    settings: {
      labels: [
        { id: 0, index: 0, label: 'Fresh lead', color: done.color === 'blue' ? 'yellow' : 'blue' },
        { id: 1, index: 1, label: done.label, color: done.color, is_done: true },
      ],
    },
  });
  expect(stage.status, JSON.stringify(await stage.clone().json())).toBe(201);

  /** Creates an item and returns its id (failing with the answer when it was refused). */
  const item = async (boardId: string, name: string, cells: Json) => {
    const b = await body(await as().post(`/boards/${boardId}/items`, { name, cells }));
    expect(b.id, JSON.stringify(b)).toBeTruthy();
    return b.id as string;
  };
  const d1 = await item(deals.id, 'D1', {
    stage: { index: done.id },
    owner: { persons_and_teams: [{ id: me, kind: 'person' }] },
  });
  const d2 = await item(deals.id, 'D2', { stage: { index: notDone.id }, due: { date: '2026-12-01' } });
  dealIds = [d1, d2];
  const lead = await item(leads.id, 'L1', { stage: { index: 0 } });

  const clients = await body(await as().post('/boards', { name: 'Clients', workspace_id: ws }));
  clientsId = clients.id;
  await as().post(`/boards/${clientsId}/columns`, {
    id: 'rel',
    title: 'Deals & leads',
    type: 'board_relation',
    settings: { board_ids: [deals.id, leads.id], allow_multiple: true },
  });
  for (const [id, source] of [
    ['stages', 'stage'],
    ['owners', 'owner'],
    ['dues', 'due'],
  ] as const)
    await as().post(`/boards/${clientsId}/columns`, {
      id,
      title: id,
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: source },
    });
  const client = (name: string, ids: string[]) => item(clientsId, name, ids.length ? { rel: { item_ids: ids } } : {});
  await client('A', [d1]);
  await client('B', [d2, lead]);
  await client('C', []);
});
afterAll(() => t.close());

const query = async (rules: Json[]) => {
  const res = await as().post(`/boards/${clientsId}/items/query`, {
    filter: { kind: 'group', operator: 'and', rules: rules.map((r) => ({ negate: false, ...r })) },
  });
  expect(res.status).toBe(200);
  return ((await body(res)).data as Json[]).map((i) => i.name).sort();
};
const names = () => (globalThis as { names?: Json }).names!;

describe('filtering a mirror like its source', () => {
  it('a relation to two boards offers both boards’ labels once per text', async () => {
    const col = (await body(await as().get(`/boards/${clientsId}`))).columns.find((c: Json) => c.id === 'stages');
    const texts = (col.mirror_source.settings.labels as Json[]).map((l) => l.label);
    expect(texts).toContain('Fresh lead');
    expect(texts.filter((x) => x === names().done)).toHaveLength(1);
    expect(new Set((col.mirror_source.settings.labels as Json[]).map((l) => l.id)).size).toBe(texts.length);
  });

  it('status: by label (any linked item), done / not done, empty', async () => {
    expect(await query([{ column_id: 'stages', operator: 'any_of', values: [names().done] }])).toEqual(['A']);
    expect(await query([{ column_id: 'stages', operator: 'any_of', values: ['Fresh lead'] }])).toEqual(['B']);
    expect(await query([{ column_id: 'stages', operator: 'not_any_of', values: ['Fresh lead'] }])).toEqual(['A', 'C']);
    expect(await query([{ column_id: 'stages', operator: 'is_done', values: [] }])).toEqual(['A']);
    expect(await query([{ column_id: 'stages', operator: 'is_empty', values: [] }])).toEqual(['C']);
  });

  it('people: "me"; dates: a range', async () => {
    expect(await query([{ column_id: 'owners', operator: 'any_of', values: ['me'] }])).toEqual(['A']);
    expect(await query([{ column_id: 'dues', operator: 'between', values: ['2026-11-01', '2026-12-31'] }])).toEqual([
      'B',
    ]);
    expect(await query([{ column_id: 'dues', operator: 'is_empty', values: [] }])).toEqual(['A', 'C']);
  });

  it('the mirror value carries the people ids and dates it filters by', async () => {
    const items = (await body(await as().get(`/boards/${clientsId}/items`))).data as Json[];
    const a = items.find((i) => i.name === 'A')!;
    const b = items.find((i) => i.name === 'B')!;
    expect(a.cells.owners.value.people).toHaveLength(1);
    expect(b.cells.dues.value.dates).toEqual([{ start: '2026-12-01', end: '2026-12-01' }]);
  });
  it('"all linked items": every linked deal done; a client with one open deal is left out', async () => {
    const d = await as().post(`/boards/${clientsId}/items`, { name: 'D', cells: { rel: { item_ids: dealIds } } });
    expect(d.status).toBe(201);
    const isDone = { column_id: 'stages', operator: 'any_of', values: [names().done] };
    expect(await query([isDone])).toEqual(['A', 'D']);
    expect(await query([{ ...isDone, match: 'all' }])).toEqual(['A']);
    expect(await query([{ column_id: 'stages', operator: 'is_done', values: [], match: 'all' }])).toEqual(['A']);
    // "is empty" reads the cell as a whole, whatever the choice.
    expect(await query([{ column_id: 'stages', operator: 'is_empty', values: [], match: 'all' }])).toEqual(['C']);
  });
});
