// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encodeQuery,
  renderNameTemplate,
  nameTemplateFromTitles,
  nameTemplateToTitles,
  nameTemplateRefs,
} from '@bines/shared';
import type { Db } from '../src/db/client';
import { nameRecomputeLimits, nameTasks, NAME_RECOMPUTE_TASK } from '../src/modules/items/names.service';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * ("way 2"): computed item names. One stable id per item; a board (and each sub-board) names its items
 * freely, from one column or from a template; the server stores the name in items.name and follows every change
 * it reads (cells, linked items across boards, the setting itself — big boards in the background). Plus the two
 * relation-name fixes: a rename refreshes the relation cells showing it, and names with ", " survive in cells.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = () => t.api(admin, acmeId);
const newBoard = async (name: string) => body(await as().post('/boards', { name, workspace_id: wsId }));
const addColumn = async (boardId: string, col: Json) => {
  const res = await as().post(`/boards/${boardId}/columns`, col);
  expect(res.status).toBe(201);
  return body(res);
};
const addItem = (boardId: string, payload: Json) => as().post(`/boards/${boardId}/items`, payload);
const getItem = async (id: string) => body(await as().get(`/items/${id}`));
const setCell = (id: string, key: string, value: unknown) => as().put(`/items/${id}/cells/${key}`, { value });
const setSource = (boardId: string, source: Json) => as().put(`/boards/${boardId}/name-source`, source);
const rows = async <T>(q: ReturnType<typeof sql>) => ((await t.db.execute(q)) as unknown as { rows: T[] }).rows;
const storedText = async (itemId: string, columnKey: string, boardId: string) =>
  (
    await rows<{ text_value: string | null }>(sql`
      select c.text_value from cells c join columns col on col.id = c.column_id
      where c.item_id = ${itemId} and col.key = ${columnKey} and col.board_id = ${boardId}`)
  )[0]?.text_value ?? null;

let clients: Json;
let projects: Json;

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
  wsId = (await body(await as().get('/workspaces'))).data[0].id;
  clients = await newBoard('Clients');
  await addColumn(clients.id, { id: 'city', title: 'City', type: 'text' });
  projects = await newBoard('Projects');
  await addColumn(projects.id, { id: 'code', title: 'Code', type: 'text' });
  await addColumn(projects.id, { id: 'when', title: 'When', type: 'date' });
  await addColumn(projects.id, {
    id: 'client',
    title: 'Client',
    type: 'board_relation',
    settings: { board_ids: [clients.id], allow_multiple: true },
  });
  await addColumn(projects.id, {
    id: 'ccity',
    title: 'Client city',
    type: 'mirror',
    settings: { relation_column_id: 'client', source_column_id: 'city' },
  });
});
afterAll(() => t.close());

describe('shared helpers', () => {
  it('renders templates: placeholders, escaped braces, dangling separators, the empty text', () => {
    const text = (m: Record<string, string>) => (k: string) => m[k] ?? null;
    expect(nameTemplateRefs('{a} – {b} {{x}} {a}')).toEqual(['a', 'b']);
    expect(renderNameTemplate('{a} – {b}', text({ a: 'Dani', b: '2026-10-07' }))).toBe('Dani – 2026-10-07');
    expect(renderNameTemplate('{a} – {b}', text({ a: 'Dani' }))).toBe('Dani');
    expect(renderNameTemplate('{a} – {b}', text({ b: 'x' }))).toBe('x');
    expect(renderNameTemplate('{{lit}} {a}', text({ a: 'v' }))).toBe('{lit} v');
    expect(renderNameTemplate('{a} – {b}', text({}), 'New item')).toBe('New item');
    const cols = [
      { id: 'client', title: 'Client' },
      { id: 'when', title: 'When' },
    ];
    expect(nameTemplateToTitles('{client} – {when}', cols)).toBe('{Client} – {When}');
    expect(nameTemplateFromTitles('{Client} – {When}', cols)).toBe('{client} – {when}');
  });
});

describe('name sources', () => {
  it('free boards keep typed names; a name is required there', async () => {
    const res = await addItem(clients.id, {});
    expect(res.status).toBe(400);
    const dani = await body(await addItem(clients.id, { name: 'Dani' }));
    expect(dani).toMatchObject({ name: 'Dani', name_computed: false, name_source: 'free' });
  });

  it('refuses a source on unknown columns or the name itself (422), and invalid shapes (400)', async () => {
    const unknown = await setSource(projects.id, { mode: 'column', column_id: 'nope' });
    expect(unknown.status).toBe(422);
    expect((await body(unknown)).error.code).toBe('name_source_invalid');
    expect((await setSource(projects.id, { mode: 'column', column_id: 'name' })).status).toBe(422);
    expect((await setSource(projects.id, { mode: 'template', template: 'no placeholders' })).status).toBe(400);
  });

  it('column mode: a new item needs no name and gets the column text; the created event carries it', async () => {
    const out = await body(await setSource(projects.id, { mode: 'column', column_id: 'code', empty_text: 'New' }));
    expect(out).toMatchObject({ computed: true, refs: ['code'], name_source: { mode: 'column', column_id: 'code' } });
    const created = await addItem(projects.id, { cells: { code: 'P-100' } });
    expect(created.status).toBe(201);
    const item = await body(created);
    expect(item).toMatchObject({ name: 'P-100', name_computed: true, name_source: 'column' });
    // A given name is ignored.
    const other = await body(await addItem(projects.id, { name: 'typed', cells: { code: 'P-101' } }));
    expect(other.name).toBe('P-101');
    const events = await rows<{ type: string; payload: Json }>(
      sql`select type, payload from activity_log where item_id = ${item.id} order by id`,
    );
    expect(events.find((e) => e.type === 'item.created')!.payload.after.name).toBe('P-100');
    expect(events.some((e) => e.type === 'item.renamed')).toBe(false);
    // Empty → the empty text.
    expect((await body(await addItem(projects.id, {}))).name).toBe('New');
  });

  it('follows a change of the source column (a computed rename event), and undo of the cell brings it back', async () => {
    const item = await body(await addItem(projects.id, { cells: { code: 'A-1' } }));
    const res = await setCell(item.id, 'code', 'A-2');
    expect(res.status).toBe(200);
    const edited = await body(res);
    expect(edited.name).toBe('A-2');
    const renamed = await rows<{ payload: Json }>(
      sql`select payload from activity_log where item_id = ${item.id} and type = 'item.renamed'`,
    );
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.payload).toMatchObject({
      before: { name: 'A-1' },
      after: { name: 'A-2' },
      meta: { computed: true },
    });
    expect((await as().post(`/activity/${edited.event_id}/undo`, {})).status).toBe(200);
    expect((await getItem(item.id)).name).toBe('A-1');
  });

  it('a rename of a computed name answers 409 item_name_computed; the same name is fine', async () => {
    const item = await body(await addItem(projects.id, { cells: { code: 'R-1' } }));
    const res = await as().patch(`/items/${item.id}`, { name: 'manual' });
    expect(res.status).toBe(409);
    const err = (await body(res)).error;
    expect(err.code).toBe('item_name_computed');
    expect(err.details.refs).toEqual(['code']);
    expect((await as().patch(`/items/${item.id}`, { name: 'R-1' })).status).toBe(200);
  });

  it('template mode over a relation and a date: names follow the linked item across boards', async () => {
    const dani = await body(await addItem(clients.id, { name: 'Dani', cells: { city: 'Haifa' } }));
    const out = await setSource(projects.id, { mode: 'template', template: '{client} – {when}', empty_text: 'New' });
    expect(out.status).toBe(200);
    const item = await body(
      await addItem(projects.id, { cells: { client: { item_ids: [dani.id] }, when: { date: '2026-10-07' } } }),
    );
    const dateText = item.cells.when.text as string;
    expect(item.name).toBe(`Dani – ${dateText}`);
    // Without the date: no dangling separator.
    await setCell(item.id, 'when', null);
    expect((await getItem(item.id)).name).toBe('Dani');
    // The client is renamed on its own board → the project's name follows.
    expect((await as().patch(`/items/${dani.id}`, { name: 'Dani Cohen' })).status).toBe(200);
    expect((await getItem(item.id)).name).toBe('Dani Cohen');
  });

  it('mirror sources follow a cell change on the other board', async () => {
    const ron = await body(await addItem(clients.id, { name: 'Ron', cells: { city: 'Eilat' } }));
    await setSource(projects.id, { mode: 'template', template: '{code} @ {ccity}' });
    const item = await body(await addItem(projects.id, { cells: { code: 'M-1', client: { item_ids: [ron.id] } } }));
    expect(item.name).toBe('M-1 @ Eilat');
    await setCell(ron.id, 'city', 'Acre');
    expect((await getItem(item.id)).name).toBe('M-1 @ Acre');
  });

  it('changing the setting recomputes the board; back to free keeps the names and allows renames', async () => {
    const board = await newBoard('Leads');
    await addColumn(board.id, { id: 'mail', title: 'Mail', type: 'text' });
    const a = await body(await addItem(board.id, { name: 'typed a', cells: { mail: 'a@x.test' } }));
    const b = await body(await addItem(board.id, { name: 'typed b' }));
    const out = await body(await setSource(board.id, { mode: 'column', column_id: 'mail', empty_text: '—' }));
    expect(out.recompute).toMatchObject({ status: 'done', mode: 'sync', total: 2, done: 2, renamed: 2 });
    expect((await getItem(a.id)).name).toBe('a@x.test');
    expect((await getItem(b.id)).name).toBe('—');
    // The column feeding the name cannot be deleted meanwhile.
    const del = await as().del(`/boards/${board.id}/columns/mail`);
    expect(del.status).toBe(409);
    expect((await body(del)).error.code).toBe('column_in_name_source');

    const free = await body(await setSource(board.id, { mode: 'free' }));
    expect(free.computed).toBe(false);
    expect((await getItem(a.id)).name).toBe('a@x.test');
    expect((await as().patch(`/items/${a.id}`, { name: 'typed again' })).status).toBe(200);
    // The generic column endpoint carries the same setting.
    const res = await as().patch(`/boards/${board.id}/columns/name`, {
      settings: { name_source: { mode: 'column', column_id: 'mail' } },
    });
    expect(res.status).toBe(200);
    expect((await getItem(a.id)).name).toBe('a@x.test');
    expect((await body(await as().get(`/boards/${board.id}/name-source`))).recompute.status).toBe('done');
  });

  it('a big board recomputes in the background, in windows, with progress', async () => {
    const board = await newBoard('Big');
    await addColumn(board.id, { id: 'code', title: 'Code', type: 'text' });
    const edit = await as().post(`/boards/${board.id}/items/bulk-edit`, {
      labels: [],
      tags: [],
      rows: Array.from({ length: 12 }, (_, i) => ({ name: `n${i}`, cells: { code: `C${i}` } })),
    });
    expect(edit.status).toBe(200);
    const saved = { ...nameRecomputeLimits };
    nameRecomputeLimits.syncMax = 5;
    nameRecomputeLimits.window = 4;
    try {
      const out = await body(await setSource(board.id, { mode: 'column', column_id: 'code' }));
      // No job runner in tests: the background windows run in the request, the state says background.
      expect(out.recompute).toMatchObject({ mode: 'background', status: 'done', total: 12, done: 12, renamed: 12 });
      const items = (await body(await as().get(`/boards/${board.id}/items`))).data as Json[];
      expect(items.map((i) => i.name).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `C${i}`).sort());
      // The job entry point (what the worker runs) picks up a queued run.
      await t.db.execute(sql`update items set name = 'stale' where board_id = ${board.id}`);
      await t.db.execute(
        sql`update boards set settings = settings || '{"name_recompute":{"status":"running","mode":"background","total":12,"done":0,"renamed":0,"started_at":"2026-10-07T00:00:00.000Z","finished_at":null,"error":null}}'::jsonb where id = ${board.id}`,
      );
      await nameTasks({ db: t.db as unknown as Db })[NAME_RECOMPUTE_TASK]({ board_id: board.id, account_id: acmeId });
      const state = (await body(await as().get(`/boards/${board.id}/name-source`))).recompute;
      expect(state).toMatchObject({ status: 'done', done: 12, renamed: 12, started_at: '2026-10-07T00:00:00.000Z' });
    } finally {
      Object.assign(nameRecomputeLimits, saved);
    }
  });

  it('bulk edit / import: new rows need no name, sheet renames are ignored on computed boards', async () => {
    const board = await newBoard('Imported');
    await addColumn(board.id, { id: 'code', title: 'Code', type: 'text' });
    await setSource(board.id, { mode: 'column', column_id: 'code' });
    const res = await as().post(`/boards/${board.id}/items/bulk-edit`, {
      labels: [],
      tags: [],
      rows: [{ cells: { code: 'I-1' } }, { name: 'ignored', cells: { code: 'I-2' } }],
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    const names = await Promise.all(out.item_ids.map(async (id: string) => (await getItem(id)).name));
    expect(names).toEqual(['I-1', 'I-2']);
    const created = await rows<{ payload: Json }>(
      sql`select payload from activity_log where item_id = ${out.item_ids[0]} and type = 'item.created'`,
    );
    expect(created[0]!.payload.after.name).toBe('I-1');
    const upd = await as().post(`/boards/${board.id}/items/bulk-edit`, {
      labels: [],
      tags: [],
      rows: [{ item_id: out.item_ids[0], name: 'manual', cells: { code: 'I-9' } }],
    });
    expect(upd.status).toBe(200);
    expect((await getItem(out.item_ids[0])).name).toBe('I-9');
    // Bulk set_cell over several items.
    const bulk = await as().post(`/boards/${board.id}/items/bulk`, {
      item_ids: out.item_ids,
      action: { type: 'set_cell', column_id: 'code', value: 'same' },
    });
    expect(bulk.status).toBe(200);
    expect((await getItem(out.item_ids[1])).name).toBe('same');
  });

  it('forms: a submission without a name question gets the computed name', async () => {
    const board = await newBoard('Requests');
    await addColumn(board.id, { id: 'company', title: 'Company', type: 'text' });
    await setSource(board.id, { mode: 'template', template: 'Request · {company}' });
    const view = await body(await as().post(`/boards/${board.id}/views`, { type: 'form', name: 'Form' }));
    expect((await as().get(`/views/${view.id}/form`)).status).toBe(200); // opens the form (defaults)
    const saved = await as().patch(`/views/${view.id}/form`, {
      questions: [{ id: 'qcomp001', column_key: 'company', required: true }],
    });
    expect(saved.status).toBe(200);
    const token = (await body(saved)).token as string;
    const res = await t.app.request(`/api/v1/public/forms/${token}/submit`, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, 'x-forwarded-for': '10.9.9.9', 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { qcomp001: 'Globex' } }),
    });
    expect(res.status).toBe(200);
    const items = (await body(await as().get(`/boards/${board.id}/items`))).data as Json[];
    expect(items.map((i) => i.name)).toEqual(['Request · Globex']);
  });

  it('sub-boards have their own source', async () => {
    const parent = await body(await addItem(clients.id, { name: 'Parent' }));
    const sub = await body(await as().post(`/items/${parent.id}/subitems`, { name: 'first' }));
    expect(sub.name_computed).toBe(false);
    await setSource(sub.board_id, { mode: 'column', column_id: 'status', empty_text: 'No status' });
    const next = await body(await as().post(`/items/${parent.id}/subitems`, {}));
    expect(next).toMatchObject({ name: 'No status', name_computed: true });
    expect((await getItem(parent.id)).name_computed).toBe(false);
    expect((await addItem(clients.id, {})).status).toBe(400);
  });

  it('duplicates: listed (never blocked), the warning flag is the setting', async () => {
    const board = await newBoard('Dups');
    await addColumn(board.id, { id: 'code', title: 'Code', type: 'text' });
    await setSource(board.id, { mode: 'column', column_id: 'code', warn_duplicates: true });
    for (const code of ['X', 'X', 'Y', 'X', 'Y', 'Z'])
      expect((await addItem(board.id, { cells: { code } })).status).toBe(201);
    const d = await body(await as().get(`/boards/${board.id}/name-duplicates`));
    expect(d).toMatchObject({ warn: true, count: 2, items: 5 });
    expect(d.groups.map((g: Json) => [g.name, g.count])).toEqual([
      ['X', 3],
      ['Y', 2],
    ]);
    expect(d.groups[0].item_ids).toHaveLength(3);
  });
});

describe('relation names (fixes)', () => {
  it('a rename refreshes the stored text of relation cells pointing at the item (free boards too)', async () => {
    const board = await newBoard('Deals');
    await addColumn(board.id, {
      id: 'who',
      title: 'Who',
      type: 'board_relation',
      settings: { board_ids: [clients.id] },
    });
    const c = await body(await addItem(clients.id, { name: 'Old Name' }));
    const deal = await body(await addItem(board.id, { name: 'Deal', cells: { who: { item_ids: [c.id] } } }));
    expect(await storedText(deal.id, 'who', board.id)).toBe('Old Name');
    await as().patch(`/items/${c.id}`, { name: 'New Name' });
    expect(await storedText(deal.id, 'who', board.id)).toBe('New Name');
    // Search / filters over the stored text see the new name.
    const q = encodeQuery({ search: 'New Name' });
    const found = (await body(await as().get(`/boards/${board.id}/items?q=${q}`))).data as Json[];
    expect(found.map((i) => i.id)).toContain(deal.id);
  });

  it('a linked name with ", " stays one name: cells carry names aligned with item_ids', async () => {
    const board = await newBoard('Orders');
    await addColumn(board.id, {
      id: 'who',
      title: 'Who',
      type: 'board_relation',
      settings: { board_ids: [clients.id] },
    });
    const a = await body(await addItem(clients.id, { name: 'Cohen, Dani' }));
    const b = await body(await addItem(clients.id, { name: 'Levi' }));
    const order = await body(await addItem(board.id, { name: 'O-1', cells: { who: { item_ids: [a.id, b.id] } } }));
    expect(order.cells.who).toMatchObject({
      value: { item_ids: [a.id, b.id] },
      text: 'Cohen, Dani, Levi',
      names: ['Cohen, Dani', 'Levi'],
    });
  });
});
