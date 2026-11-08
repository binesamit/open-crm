// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/** 07 §4.2: duplicate items (cells, links, subitems, updates) and groups; undo trashes the copy. */
let t: TestContext;
let admin: string;
let carol: string; // viewer
let acmeId: string;
let boardId: string;
let groupId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const items = async () => (await body(await as(admin).get(`/boards/${boardId}/items`))).data as Json[];

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  const board = await body(await as(admin).post('/boards', { name: 'Dup', workspace_id: ws.id }));
  boardId = board.id;
  groupId = board.groups[0].id;
});
afterAll(() => t.close());

describe('duplicate', () => {
  let original: Json;
  let num: Json;

  it('an item copy sits right below, with cells and subitems; updates only when asked', async () => {
    num = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'N', type: 'numbers' }));
    original = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Orig', cells: { [num.id]: 3 } }));
    await as(admin).post(`/boards/${boardId}/items`, { name: 'Next' });
    await as(admin).post(`/items/${original.id}/subitems`, { name: 'Sub A' });
    await as(admin).post(`/items/${original.id}/updates`, { body: 'note' });

    const res = await as(admin).post(`/items/${original.id}/duplicate`, {});
    expect(res.status).toBe(201);
    const copy = await body(res);
    expect(copy).toMatchObject({ name: he('server.copyOf', { name: 'Orig' }), group_id: groupId });
    expect(copy.cells[num.id].value).toEqual(3);
    expect((await items()).map((i) => i.name)).toEqual(['Orig', he('server.copyOf', { name: 'Orig' }), 'Next']);

    const sub = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id;
    const subs = (await body(await as(admin).get(`/boards/${sub}/items`))).data as Json[];
    expect(subs.filter((s) => s.parent_item_id === copy.id).map((s) => s.name)).toEqual(['Sub A']);
    expect((await body(await as(admin).get(`/items/${copy.id}/updates`))).data).toHaveLength(0);

    const withUpdates = await body(await as(admin).post(`/items/${original.id}/duplicate`, { with_updates: true }));
    expect((await body(await as(admin).get(`/items/${withUpdates.id}/updates`))).data).toHaveLength(1);
  });

  it('undo of a duplicate trashes the copy; viewers cannot duplicate', async () => {
    const copy = await body(await as(admin).post(`/items/${original.id}/duplicate`, {}));
    const ev = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where item_id = ${copy.id} and type = 'item.duplicated'`,
      )
    ).rows[0]!;
    expect((await as(admin).post(`/activity/${ev.id}/undo`, {})).status).toBe(200);
    expect((await as(admin).get(`/items/${copy.id}`)).status).toBe(404);
    expect((await as(carol).post(`/items/${original.id}/duplicate`, {})).status).toBe(403);
  });

  it('a group copy comes right below with copies of its items (or empty)', async () => {
    const res = await as(admin).post(`/boards/${boardId}/groups/${groupId}/duplicate`, {});
    expect(res.status).toBe(201);
    const copy = await body(res);
    expect(copy.title).toBe(he('server.copyOf', { name: he('server.newGroup') }));
    const board = await body(await as(admin).get(`/boards/${boardId}`));
    expect(board.groups.map((g: Json) => g.id).indexOf(copy.id)).toBe(1);
    const inCopy = (await items()).filter((i) => i.group_id === copy.id);
    expect(inCopy.map((i) => i.name)).toContain('Orig');
    expect(inCopy.find((i) => i.name === 'Orig')!.cells[num.id].value).toEqual(3);

    const empty = await body(
      await as(admin).post(`/boards/${boardId}/groups/${groupId}/duplicate`, { with_items: false }),
    );
    expect((await items()).filter((i) => i.group_id === empty.id)).toEqual([]);
  });

  it('bulk duplicate copies each selected item once, as one batch', async () => {
    const before = (await items()).length;
    const pick = (await items())
      .filter((i) => i.group_id === groupId)
      .slice(0, 2)
      .map((i) => i.id);
    const res = await body(
      await as(admin).post(`/boards/${boardId}/items/bulk`, { item_ids: pick, action: { type: 'duplicate' } }),
    );
    expect(res.done).toBe(2);
    expect((await items()).length).toBe(before + 2);
    await as(admin).post(`/activity/${res.event_id}/undo`, {});
    expect((await items()).length).toBe(before);
  });
});
