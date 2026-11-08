// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * 12-ROADMAP "עריכה גדולה" B3: a file import is a bulk edit that may create columns and thousands of items — new
 * items are one batch insert (positions, cells, followers, activity), and the activity log's undo of the batch
 * takes everything back (items and columns to the trash, labels off, cells of existing items back).
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let groups: { id: string }[];
let status: { id: string; settings: { labels: { id: number; label: string }[] } };
let text: { id: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const edit = (payload: Json) =>
  as(admin).post(`/boards/${boardId}/items/bulk-edit`, { labels: [], tags: [], ...payload });
const board = async () => body(await as(admin).get(`/boards/${boardId}`));
const rows = async <T>(q: ReturnType<typeof sql>) => ((await t.db.execute(q)) as unknown as { rows: T[] }).rows;

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
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Import', workspace_id: wsId }))).id;
  await as(admin).post(`/boards/${boardId}/groups`, { title: 'Second', position: 'bottom' });
  groups = (await board()).groups;
  status = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'S', type: 'status' }))) as never;
  text = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'T', type: 'text' }))) as never;
});
afterAll(() => t.close());

describe('bulk import', () => {
  it('inserts 10,000 new rows as one batch: positions in order, cells, followers, one activity set', async () => {
    const first = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'existing' }));
    const done = status.settings.labels[0]!;
    const N = 10_000;
    const started = Date.now();
    const res = await edit({
      columns: [{ ref: '__new_1', title: 'Amount', type: 'numbers' }],
      rows: Array.from({ length: N }, (_, i) => ({
        name: `row ${i}`,
        ...(i % 2 ? { group_id: groups[1]!.id } : {}),
        cells: { [text.id]: `t${i}`, __new_1: i, ...(i % 3 ? {} : { [status.id]: { index: done.id } }) },
      })),
    });
    const ms = Date.now() - started;
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ ok: true, created: N, updated: 0, columns_added: 1 });
    expect(out.item_ids).toHaveLength(N);
    // PGlite (WASM, one thread) is several times slower than Postgres; the bar here only catches row-by-row
    // (minutes), with room for a shared, loaded machine.
    console.warn(`bulk import: ${N} rows in ${ms} ms (PGlite)`);
    expect(ms).toBeLessThan(120_000);

    const amount = (await board()).columns.find((c: Json) => c.title === 'Amount');
    expect(amount).toMatchObject({ type: 'numbers' });
    const items = await rows<{ id: string; group_id: string; position: string; name: string }>(
      sql`select id, group_id, position, name from items where board_id = ${boardId} and deleted_at is null`,
    );
    expect(items).toHaveLength(N + 1);
    // Each group: the new items after the existing one, in request order.
    for (const g of groups) {
      const mine = items.filter((i) => i.group_id === g.id).sort((x, y) => (x.position < y.position ? -1 : 1));
      const names = mine.map((i) => i.name).filter((n) => n !== 'existing');
      const expected = Array.from({ length: N }, (_, i) => i)
        .filter((i) => (g.id === groups[1]!.id ? i % 2 === 1 : i % 2 === 0))
        .map((i) => `row ${i}`);
      expect(names).toEqual(expected);
      if (g.id === first.group_id) expect(mine[0]!.name).toBe('existing');
    }
    const cellCount = await rows<{ n: number }>(sql`select count(*)::int as n from cells where board_id = ${boardId}`);
    expect(cellCount[0]!.n).toBe(N * 2 + Math.ceil(N / 3));
    const sample = await getItem(out.item_ids[3]);
    expect(sample).toMatchObject({ name: 'row 3' });
    expect(sample.cells[text.id].value).toBe('t3');
    expect(sample.cells[amount.id].value).toBe(3);
    expect(sample.cells[status.id].text).toBe(done.label);

    const events = await rows<{ type: string; n: number }>(
      sql`select type, count(*)::int as n from activity_log where batch_id = ${out.batch_id} group by type`,
    );
    const count = Object.fromEntries(events.map((e) => [e.type, e.n]));
    expect(count).toMatchObject({
      'item.created': N,
      'cell.changed': N * 2 + Math.ceil(N / 3),
      'column.created': 1,
      'batch.executed': 1,
    });
    const followers = await rows<{ n: number }>(
      sql`select count(*)::int as n from item_followers where item_id = any(${sql.param(out.item_ids)}::varchar[])`,
    );
    expect(followers[0]!.n).toBe(N);

    // The activity log's undo of the batch: every new item and the new column to the trash, once.
    const undoStarted = Date.now();
    const undone = await as(admin).post(`/activity/${out.event_id}/undo`, {});
    console.warn(`bulk import undo: ${N} rows in ${Date.now() - undoStarted} ms (PGlite)`);
    expect(undone.status).toBe(200);
    const left = await rows<{ n: number }>(
      sql`select count(*)::int as n from items where board_id = ${boardId} and deleted_at is null`,
    );
    expect(left[0]!.n).toBe(1);
    expect((await board()).columns.some((c: Json) => c.title === 'Amount')).toBe(false);
    const trash = await rows<{ object_type: string; n: number }>(
      sql`select object_type, count(*)::int as n from trash_entries where board_id = ${boardId} and restored_at is null group by object_type`,
    );
    expect(Object.fromEntries(trash.map((x) => [x.object_type, x.n]))).toMatchObject({ item: N, column: 1 });
    const open = await rows<{ n: number }>(
      sql`select count(*)::int as n from activity_log where batch_id = ${out.batch_id} and undone_at is null`,
    );
    expect(open[0]!.n).toBe(0);
    expect((await as(admin).post(`/activity/${out.event_id}/undo`, {})).status).toBe(409);
  }, 600_000);

  it('activity-log undo of a bulk edit reverts cells, renames, new items, new labels and new columns', async () => {
    const a = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'keep me' }));
    await as(admin).put(`/items/${a.id}/cells/${text.id}`, { value: 'before' });
    const statusNow = (await board()).columns.find((c: Json) => c.id === status.id);
    const fresh = Math.max(...statusNow.settings.labels.map((l: Json) => l.id)) + 1;
    const out = await body(
      await edit({
        columns: [{ ref: '__new_2', title: 'Kind', type: 'dropdown', settings: { labels: [] } }],
        labels: [
          { column_id: status.id, id: fresh, label: 'Imported', color: 'blue' },
          { column_id: '__new_2', id: 0, label: 'Gold' },
        ],
        rows: [
          { item_id: a.id, name: 'renamed', cells: { [text.id]: 'after', __new_2: { ids: [0] } } },
          { name: 'new one', cells: { [status.id]: { index: fresh }, __new_2: { ids: [0] } } },
        ],
      }),
    );
    expect(out).toMatchObject({ updated: 1, created: 1, labels_added: 2, columns_added: 1 });
    const kind = (await board()).columns.find((c: Json) => c.title === 'Kind');
    expect((await getItem(a.id)).cells[kind.id].text).toBe('Gold');

    // The log shows the batch as one undoable row.
    const log = (await body(await as(admin).get(`/boards/${boardId}/activity`))).data as Json[];
    const row = log.find((r) => r.batch_id === out.batch_id);
    expect(row).toMatchObject({ undoable: true });
    expect((await as(admin).post(`/activity/${row!.id}/undo`, {})).status).toBe(200);

    const back = await getItem(a.id);
    expect(back.name).toBe('keep me');
    expect(back.cells[text.id].value).toBe('before');
    expect((await as(admin).get(`/items/${out.item_ids[0]}`)).status).toBe(404);
    const after = await board();
    expect(after.columns.some((c: Json) => c.title === 'Kind')).toBe(false);
    // Still used by the trashed new item → kept, deactivated (a restore from the trash finds it).
    const label = after.columns.find((c: Json) => c.id === status.id).settings.labels.find((l: Json) => l.id === fresh);
    expect(label?.is_deactivated).toBe(true);
    // The bulk-edit undo endpoint agrees it is done.
    expect((await as(admin).post(`/boards/${boardId}/items/bulk-edit/${out.batch_id}/undo`, {})).status).toBe(409);
  });

  it('refuses a cell for an unknown new column ref, and a bad value in a new row, as a whole', async () => {
    const before = (await board()).columns.length;
    const missing = await edit({ rows: [{ name: 'x', cells: { __new_9: 'v' } }] });
    expect(missing.status).toBe(404);
    const bad = await edit({
      columns: [{ ref: '__new_3', title: 'Num', type: 'numbers' }],
      rows: [{ name: 'y', cells: { __new_3: 'not a number' } }],
    });
    expect(bad.status).toBe(422);
    expect((await board()).columns.length).toBe(before);
  });
});
