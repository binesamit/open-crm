// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * A relation column over several boards:
 *: the picker's search carries each item's group and pages ("load more") by 30
 *: a board taken off the column takes the links to its items along, one undo brings both back.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let projects: string;
let clients: string;
let vendors: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const board = async (ws: string, name: string) =>
  (await body(await as().post('/boards', { name, workspace_id: ws }))).id;
const item = async (b: string, name: string, group_id?: string) =>
  (await body(await as().post(`/boards/${b}/items`, { name, ...(group_id ? { group_id } : {}) }))).id as string;
const cell = async (itemId: string) => (await body(await as().get(`/items/${itemId}`))).cells?.rel?.value ?? null;
const links = async () =>
  Number(
    (
      await t.db.execute<{ n: string }>(
        sql`select count(*) as n from item_links l join columns c on c.id = l.column_id where c.key = 'rel' and c.board_id = ${projects}`,
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  projects = await board(ws, 'פרויקטים');
  clients = await board(ws, 'לקוחות');
  vendors = await board(ws, 'ספקים');
  await as().post(`/boards/${projects}/columns`, {
    id: 'rel',
    title: 'לקוח / ספק',
    type: 'board_relation',
    settings: { board_ids: [clients, vendors] },
  });
});
afterAll(() => t.close());

describe('relation picker search', () => {
  it("carries each item's group and pages by 30", async () => {
    const groups = (await body(await as().get(`/boards/${clients}`))).groups as Json[];
    const g = groups[0]!.id;
    for (let i = 0; i < 31; i++) await item(clients, `לקוח ${String(i).padStart(2, '0')}`, g);
    const first = await body(await as().get(`/boards/${clients}/items/search?q=`));
    expect(first.data).toHaveLength(30);
    expect(first.data[0]).toMatchObject({ name: 'לקוח 00', board_id: clients, group_id: g });
    expect(first.next_offset).toBe(30);
    const second = await body(await as().get(`/boards/${clients}/items/search?q=&offset=30`));
    expect(second.data.map((d: Json) => d.name)).toEqual(['לקוח 30']);
    expect(second.next_offset).toBeNull();
  });
});

describe('a board taken off a relation column', () => {
  it('removes the links to its items, keeps the others; one undo brings back the board and the links', async () => {
    const c1 = await item(clients, 'Client A');
    const v1 = await item(vendors, 'Vendor A');
    const p1 = await item(projects, 'Project 1');
    const p2 = await item(projects, 'Project 2');
    expect((await as().put(`/items/${p1}/cells/rel`, { value: { item_ids: [c1, v1] } })).status).toBe(200);
    expect((await as().put(`/items/${p2}/cells/rel`, { value: { item_ids: [v1] } })).status).toBe(200);
    expect(await links()).toBe(3);

    const res = await as().patch(`/boards/${projects}/columns/rel`, { settings: { board_ids: [clients] } });
    expect(res.status).toBe(200);
    expect(await cell(p1)).toEqual({ item_ids: [c1] });
    expect(await cell(p2)).toBeNull();
    expect(await links()).toBe(1);

    const ev = (
      await t.db.execute<{ id: string; batch_id: string; payload: Json }>(
        sql`select id, batch_id, payload from activity_log where type = 'column.settings_changed' and board_id = ${projects} order by id desc limit 1`,
      )
    ).rows[0]!;
    expect(ev.payload.meta).toMatchObject({ removed_relation_boards: [vendors], removed_links: 2 });
    const changed = (
      await t.db.execute<{ n: string }>(
        sql`select count(*) as n from activity_log where type = 'cell.changed' and batch_id = ${ev.batch_id}`,
      )
    ).rows[0]!.n;
    expect(Number(changed)).toBe(2);

    expect((await as().post(`/activity/${ev.id}/undo`, {})).status).toBe(200);
    const col = (await body(await as().get(`/boards/${projects}`))).columns.find((c: Json) => c.id === 'rel');
    expect(col.settings.board_ids).toEqual([clients, vendors]);
    expect(await cell(p1)).toEqual({ item_ids: [c1, v1] });
    expect(await cell(p2)).toEqual({ item_ids: [v1] });
    expect(await links()).toBe(3);
  });

  it('a settings change that keeps every board touches no link', async () => {
    const before = await links();
    expect(
      (
        await as().patch(`/boards/${projects}/columns/rel`, {
          settings: { board_ids: [clients, vendors], chip_max_chars: 10 },
        })
      ).status,
    ).toBe(200);
    expect(await links()).toBe(before);
    const ev = (
      await t.db.execute<{ batch_id: string | null }>(
        sql`select batch_id from activity_log where type = 'column.settings_changed' and board_id = ${projects} order by id desc limit 1`,
      )
    ).rows[0]!;
    expect(ev.batch_id).toBeNull();
  });
});
