// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { syncReflection } from '../src/modules/items/relations.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 03 §2.16: two-way board relations — pairing, reflection on every write path, backfill, unpair, trash. */
let t: TestContext;
let admin: string;
let bob: string;
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
const as = (cookie: string) => t.api(cookie, acmeId);
const newBoard = async (name: string) => body(await as(admin).post('/boards', { name, workspace_id: wsId }));
const addItem = async (boardId: string, name: string, cells?: Json) =>
  body(await as(admin).post(`/boards/${boardId}/items`, { name, ...(cells ? { cells } : {}) }));
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const linked = async (id: string, key: string) => ((await getItem(id)).cells[key]?.value?.item_ids ?? []) as string[];
const link = (id: string, key: string, ids: string[], cookie = admin) =>
  as(cookie).put(`/items/${id}/cells/${key}`, { value: { item_ids: ids } });
const relation = async (boardId: string, to: string, title = 'rel') =>
  body(
    await as(admin).post(`/boards/${boardId}/columns`, {
      title,
      type: 'board_relation',
      settings: { board_ids: [to], allow_multiple: true },
    }),
  );
const twoWay = (boardId: string, key: string, input: Json) =>
  as(admin).put(`/boards/${boardId}/columns/${key}/two-way`, input);
const column = async (boardId: string, key: string) =>
  (await body(await as(admin).get(`/boards/${boardId}`))).columns.find((c: Json) => c.id === key);

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
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('two-way relation', () => {
  let projects: Json;
  let clients: Json;
  let rel: Json; // projects → clients
  let back: string; // its partner key on clients
  let p1: Json;
  let p2: Json;
  let c1: Json;
  let c2: Json;

  it('refuses two-way through plain settings and when the column links to several boards', async () => {
    projects = await newBoard('Projects');
    clients = await newBoard('Clients');
    const other = await newBoard('Other');
    const many = await body(
      await as(admin).post(`/boards/${projects.id}/columns`, {
        title: 'many',
        type: 'board_relation',
        settings: { board_ids: [clients.id, other.id], two_way: true, reflection_column_id: 'x' },
      }),
    );
    expect(many.settings.two_way).toBeUndefined(); // stripped: pairs are made by the endpoint only
    const res = await twoWay(projects.id, many.id, { enabled: true });
    expect(res.status).toBe(422);
    expect((await body(res)).error.details.reason).toBe('one_target_board');
  });

  it('enabling creates the partner on the target board and backfills existing links', async () => {
    rel = await relation(projects.id, clients.id, 'Client');
    c1 = await addItem(clients.id, 'C1');
    c2 = await addItem(clients.id, 'C2');
    p1 = await addItem(projects.id, 'P1', { [rel.id]: { item_ids: [c1.id] } });
    p2 = await addItem(projects.id, 'P2');

    const res = await twoWay(projects.id, rel.id, { enabled: true });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.backfilled).toBe(1);
    expect(out.partner.board_id).toBe(clients.id);
    expect(out.partner.column.title).toBe('Projects'); // default title = this board's name
    back = out.partner.column.id;
    expect(out.column.settings).toMatchObject({ two_way: true, reflection_column_id: back });
    expect(out.partner.column.settings).toMatchObject({
      two_way: true,
      reflection_column_id: rel.id,
      board_ids: [projects.id],
    });
    expect(await linked(c1.id, back)).toEqual([p1.id]);
    expect((await getItem(c1.id)).cells[back].text).toBe('P1');
  });

  it('a link written on either side shows on the other, with an event for the other item', async () => {
    expect((await link(p2.id, rel.id, [c1.id, c2.id])).status).toBe(200);
    expect(await linked(c1.id, back)).toEqual([p1.id, p2.id]);
    expect(await linked(c2.id, back)).toEqual([p2.id]);

    const ev = (
      await t.db.execute<{ payload: Json; board_id: string }>(
        sql`select payload, board_id from activity_log where item_id = ${c2.id} and type = 'cell.changed'
            order by id desc limit 1`,
      )
    ).rows[0]!;
    expect(ev.board_id).toBe(clients.id);
    expect(ev.payload.after.value).toEqual({ item_ids: [p2.id] });
    expect(ev.payload.meta.reflected_from).toEqual({ board_id: projects.id, item_id: p2.id, column_key: rel.id });

    // From the other side: unlink P1 from C1 → P1 loses C1.
    expect((await link(c1.id, back, [p2.id])).status).toBe(200);
    expect(await linked(p1.id, rel.id)).toEqual([]);
    expect(await linked(p2.id, rel.id)).toEqual([c1.id, c2.id]);
    // Clearing a cell removes every reverse link.
    expect((await as(admin).del(`/items/${p2.id}/cells/${rel.id}`)).status).toBe(200);
    expect(await linked(c1.id, back)).toEqual([]);
    expect(await linked(c2.id, back)).toEqual([]);
  });

  it('the reflection needs no rights on the partner board', async () => {
    await as(admin).put(`/boards/${clients.id}/permissions`, { permission_set: 'view_comment' });
    expect((await link(c1.id, back, [p1.id], bob)).status).toBe(403);
    expect((await link(p1.id, rel.id, [c2.id], bob)).status).toBe(200);
    expect(await linked(c2.id, back)).toEqual([p1.id]);
    await as(admin).put(`/boards/${clients.id}/permissions`, { permission_set: 'edit_everything' });
  });

  it('bulk set_cell and duplicate reflect too', async () => {
    const res = await as(admin).post(`/boards/${projects.id}/items/bulk`, {
      item_ids: [p1.id, p2.id],
      action: { type: 'set_cell', column_id: rel.id, value: { item_ids: [c1.id] } },
    });
    expect(res.status).toBe(200);
    expect(await linked(c1.id, back)).toEqual([p1.id, p2.id]);
    expect(await linked(c2.id, back)).toEqual([]);

    const copy = await body(await as(admin).post(`/items/${p1.id}/duplicate`, {}));
    expect(await linked(copy.id, rel.id)).toEqual([c1.id]);
    expect(await linked(c1.id, back)).toEqual([p1.id, p2.id, copy.id]);
    await as(admin).del(`/items/${copy.id}`);
  });

  it('a trashed item drops out of the other side and comes back with its restore', async () => {
    await as(admin).del(`/items/${p2.id}`);
    expect(await linked(c1.id, back)).toEqual([p1.id]); // a trashed item does not show …
    const entry = (await body(await as(admin).get('/trash'))).data.find((e: Json) => e.name === 'P2');
    expect((await as(admin).post(`/trash/${entry.id}/restore`)).status).toBe(200);
    expect(await linked(c1.id, back)).toEqual([p1.id, p2.id]); // … and comes back with it: the links were kept
  });

  it('moving an item to another board takes its reverse links off the partner; undo puts them back', async () => {
    const archive = await newBoard('Archive');
    const res = await body(
      await as(admin).post(`/items/${p2.id}/move-to-board`, { board_id: archive.id, mapping: { [rel.id]: null } }),
    );
    expect(res.ok).toBe(true);
    expect(await linked(c1.id, back)).not.toContain(p2.id);
    expect((await as(admin).post(`/activity/${res.event_id}/undo`)).status).toBe(200);
    expect(await linked(c1.id, back)).toContain(p2.id);
    expect(await linked(p2.id, rel.id)).toEqual([c1.id]);
  });

  it('importers reflect through syncReflection', async () => {
    const before = await linked(p1.id, rel.id);
    const relRow = (
      await t.db.execute<{ id: string }>(
        sql`select id from columns where board_id = ${projects.id} and key = ${rel.id}`,
      )
    ).rows[0]!;
    await t.db.execute(
      sql`insert into item_links (id, account_id, column_id, from_item_id, to_item_id, position)
          values ('01JTESTL1NK000000000000001', ${acmeId}, ${relRow.id}, ${p1.id}, ${c2.id}, '0009')`,
    );
    const changed = await (t.db as unknown as Db).transaction((tx) =>
      syncReflection(tx, {
        accountId: acmeId,
        columnId: relRow.id,
        fromItemId: p1.id,
        before,
        after: [...before, c2.id],
        actorId: null,
      }),
    );
    expect(changed).toEqual([c2.id]);
    expect(await linked(c2.id, back)).toEqual([p1.id]);
  });

  it('disabling makes both sides one-way and keeps the links', async () => {
    const res = await twoWay(projects.id, rel.id, { enabled: false });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.column.settings.two_way).toBeUndefined();
    expect(out.partner.column.settings.two_way).toBeUndefined();
    expect(await linked(c1.id, back)).toContain(p1.id);
    await link(p1.id, rel.id, []);
    expect(await linked(c1.id, back)).toContain(p1.id); // one-way now: the other side stays as it is
  });

  it('pairs with an existing column that links back; backfill is a union of both sides', async () => {
    // One-way meanwhile: c2 → p2 exists only on the clients side; c1 → p1 too (p1 → c1 was removed).
    await link(c2.id, back, [p2.id]);
    expect(await linked(p2.id, rel.id)).toEqual([c1.id]);
    const res = await twoWay(projects.id, rel.id, { enabled: true, partner_column_id: back });
    expect(res.status).toBe(200);
    expect((await body(res)).backfilled).toBe(2);
    expect(await linked(p2.id, rel.id)).toEqual([c1.id, c2.id]);
    expect(await linked(p1.id, rel.id)).toEqual([c1.id]);
    expect(await linked(c1.id, back)).toEqual([p1.id, p2.id]);
  });

  it('refuses a partner that does not link back and locks the target board while paired', async () => {
    const stray = await relation(clients.id, clients.id, 'stray');
    const other = await relation(projects.id, clients.id, 'other');
    const res = await twoWay(projects.id, other.id, { enabled: true, partner_column_id: stray.id });
    expect((await body(res)).error.details.reason).toBe('partner_must_point_back');
    const taken = await twoWay(projects.id, other.id, { enabled: true, partner_column_id: back });
    expect((await body(taken)).error.details.reason).toBe('partner_already_paired');

    const locked = await as(admin).patch(`/boards/${projects.id}/columns/${rel.id}`, {
      settings: { board_ids: [projects.id], allow_multiple: true },
    });
    expect(locked.status).toBe(422);
    // Plain settings keep the pair.
    const kept = await body(
      await as(admin).patch(`/boards/${projects.id}/columns/${rel.id}`, {
        settings: { board_ids: [clients.id], allow_multiple: false },
      }),
    );
    expect(kept.settings).toMatchObject({ two_way: true, reflection_column_id: back, allow_multiple: false });
  });

  it('deleting one side unpairs the other; restoring pairs them again', async () => {
    await as(admin).del(`/boards/${clients.id}/columns/${back}`);
    expect((await column(projects.id, rel.id)).settings.two_way).toBeUndefined();
    await link(p1.id, rel.id, [c1.id]); // one-way meanwhile

    const entry = (await body(await as(admin).get('/trash'))).data.find((e: Json) => e.name === 'Projects');
    expect((await as(admin).post(`/trash/${entry.id}/restore`)).status).toBe(200);
    expect((await column(projects.id, rel.id)).settings).toMatchObject({ two_way: true, reflection_column_id: back });
    expect((await column(clients.id, back)).settings).toMatchObject({ two_way: true, reflection_column_id: rel.id });
    expect(await linked(c1.id, back)).toContain(p1.id);
  });

  it('a same-board relation pairs with a distinct column on the same board', async () => {
    const people = await newBoard('People');
    const mentor = await relation(people.id, people.id, 'Mentor');
    expect((await twoWay(people.id, mentor.id, { enabled: true, partner_column_id: mentor.id })).status).toBe(422);
    const out = await body(await twoWay(people.id, mentor.id, { enabled: true, partner_title: 'Mentees' }));
    const mentees = out.partner.column.id;
    expect(out.partner.board_id).toBe(people.id);
    const a = await addItem(people.id, 'A');
    const b = await addItem(people.id, 'B');
    await link(b.id, mentor.id, [a.id]);
    expect(await linked(a.id, mentees)).toEqual([b.id]);
    expect(await linked(a.id, mentor.id)).toEqual([]);
  });

  it('a duplicated board keeps its relation one-way', async () => {
    const res = await body(await as(admin).post(`/boards/${projects.id}/duplicate`, { mode: 'items' }));
    const copyId = res.id ?? res.board?.id;
    const copied = await column(copyId, rel.id);
    expect(copied.settings.two_way).toBeUndefined();
  });
});
