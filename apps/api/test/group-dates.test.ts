// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * a view grouped by a date keeps its unit (when / day / week / month / quarter / year, a timeline's
 * edge) and the server's outline (windowed boards) groups the same way as the browser.
 */
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
        slug: 'acme-group-dates',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Dates', workspace_id: ws }))).id;
  await as().post(`/boards/${boardId}/columns`, { id: 'due', title: 'Due', type: 'date' });
  await as().post(`/boards/${boardId}/columns`, { id: 'span', title: 'Span', type: 'timeline' });
  for (const [name, date, from, to] of [
    ['A', '2026-01-15', '2026-01-30', '2026-02-02'],
    ['B', '2026-01-20', '2026-02-10', '2026-02-11'],
    ['C', '2026-04-02', null, null],
    ['D', null, null, null],
  ] as const)
    await as().post(`/boards/${boardId}/items`, {
      name,
      cells: { ...(date ? { due: { date } } : {}), ...(from ? { span: { from, to } } : {}) },
    });
});
afterAll(() => t.close());

const outline = async (group_by: Json) => {
  const res = await as().post(`/boards/${boardId}/items/outline`, { query: { group_by }, summaries: [] });
  expect(res.status).toBe(200);
  return ((await body(res)).sections as Json[]).map((s) => [s.key, s.ids.length]);
};

describe('group by a date — unit', () => {
  it('month, quarter and year buckets in order, no date last', async () => {
    expect(await outline({ column_id: 'due', date_unit: 'month' })).toEqual([
      ['2026-01', 2],
      ['2026-04', 1],
      ['__empty__', 1],
    ]);
    expect(await outline({ column_id: 'due', date_unit: 'quarter', direction: 'desc' })).toEqual([
      ['2026-Q2', 1],
      ['2026-Q1', 2],
      ['__empty__', 1],
    ]);
    expect((await outline({ column_id: 'due', date_unit: 'year' }))[0]).toEqual(['2026', 3]);
  });

  it('a timeline by its start or its end', async () => {
    expect(await outline({ column_id: 'span', date_unit: 'month' })).toEqual([
      ['2026-01', 1],
      ['2026-02', 1],
      ['__empty__', 2],
    ]);
    expect(await outline({ column_id: 'span', date_unit: 'month', date_edge: 'end' })).toEqual([
      ['2026-02', 2],
      ['__empty__', 2],
    ]);
  });

  it('the view keeps the unit', async () => {
    const view = await body(
      await as().post(`/boards/${boardId}/views`, {
        name: 'By month',
        type: 'table',
        settings: { query: { group_by: { column_id: 'due', date_unit: 'month', past_detail: true } } },
      }),
    );
    const list = (await body(await as().get(`/boards/${boardId}/views`))) as Json;
    const saved = ((list.data ?? list) as Json[]).find((v) => v.id === view.id)!;
    expect(saved.settings.query.group_by).toMatchObject({ column_id: 'due', date_unit: 'month', past_detail: true });
  });
});
