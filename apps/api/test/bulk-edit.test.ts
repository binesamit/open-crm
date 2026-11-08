// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 12-ROADMAP "עריכה גדולה" B2: the sheet's draft as one batch (labels, tags, rows) and its one-step undo. */
let t: TestContext;
let admin: string;
let bob: string; // member, not a board owner
let acmeId: string;
let boardId: string;
let groups: { id: string }[];
let status: { id: string; settings: { labels: { id: number; label: string }[] } };
let text: { id: string };
let tags: { id: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newItem = async (name: string) =>
  (await body(await as(admin).post(`/boards/${boardId}/items`, { name }))) as Json;
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const edit = (cookie: string, payload: Json) =>
  as(cookie).post(`/boards/${boardId}/items/bulk-edit`, { labels: [], tags: [], ...payload });
const undo = (cookie: string, batchId: string, force = false) =>
  as(cookie).post(`/boards/${boardId}/items/bulk-edit/${batchId}/undo`, force ? { force } : {});
const columnOf = async (id: string) =>
  (await body(await as(admin).get(`/boards/${boardId}`))).columns.find((c: Json) => c.id === id) as Json;

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
  boardId = (await body(await as(admin).post('/boards', { name: 'Sheet', workspace_id: wsId }))).id;
  await as(admin).post(`/boards/${boardId}/groups`, { title: 'Second', position: 'bottom' });
  groups = (await body(await as(admin).get(`/boards/${boardId}`))).groups;
  status = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'S', type: 'status' }))) as never;
  text = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'T', type: 'text' }))) as never;
  tags = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'G', type: 'tags' }))) as never;
});
afterAll(() => t.close());

describe('bulk edit', () => {
  it('writes labels, renames, cells and new items as one batch; one undo takes all of it back', async () => {
    const a = await newItem('row a');
    const b = await newItem('row b');
    await as(admin).put(`/items/${b.id}/cells/${text.id}`, { value: 'old b' });
    const freshId = Math.max(...status.settings.labels.map((l) => l.id)) + 1;

    const res = await edit(admin, {
      labels: [{ column_id: status.id, id: freshId, label: 'Waiting', color: 'blue', index: 9 }],
      tags: [{ name: 'vip-bulk', color: 'bright_blue' }],
      rows: [
        { item_id: a.id, name: 'row a2', cells: { [status.id]: { index: freshId }, [text.id]: 'new a' } },
        { item_id: b.id, cells: { [text.id]: null, [tags.id]: { tags: ['vip-bulk'] } } },
        { name: 'brand new', group_id: groups[1]!.id, cells: { [status.id]: { index: freshId }, [text.id]: 'n' } },
        { name: 'brand new 2', cells: {} },
      ],
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ ok: true, updated: 2, created: 2, labels_added: 1, skipped: 0 });
    expect(out.item_ids).toHaveLength(2);

    const label = (await columnOf(status.id)).settings.labels.find((l: Json) => l.id === freshId);
    expect(label).toMatchObject({ label: 'Waiting', color: 'blue' });
    const a2 = await getItem(a.id);
    expect(a2.name).toBe('row a2');
    expect(a2.cells[status.id]).toMatchObject({ value: { index: freshId }, text: 'Waiting' });
    expect(a2.cells[text.id].value).toBe('new a');
    const b2 = await getItem(b.id);
    expect(b2.cells[text.id]).toBeUndefined();
    expect(b2.cells[tags.id].text).toBe('vip-bulk');
    const created = await getItem(out.item_ids[0]);
    expect(created).toMatchObject({ name: 'brand new', group_id: groups[1]!.id });
    expect(created.cells[status.id].text).toBe('Waiting');
    expect((await getItem(out.item_ids[1])).group_id).toBe(groups[0]!.id);

    expect(await body(await undo(admin, out.batch_id))).toMatchObject({ ok: true });
    const a3 = await getItem(a.id);
    expect(a3.name).toBe('row a');
    expect(a3.cells[status.id]).toBeUndefined();
    expect(a3.cells[text.id]).toBeUndefined();
    const b3 = await getItem(b.id);
    expect(b3.cells[text.id].value).toBe('old b');
    expect(b3.cells[tags.id]).toBeUndefined();
    for (const id of out.item_ids) expect((await as(admin).get(`/items/${id}`)).status).toBe(404);
    // The new label is off the column: still used by the trashed new item, so it stays deactivated.
    const after = (await columnOf(status.id)).settings.labels.find((l: Json) => l.id === freshId);
    expect(after?.is_deactivated ?? true).toBe(true);
    // Once.
    expect((await undo(admin, out.batch_id)).status).toBe(409);
  });

  it('removes a new label nobody uses on undo', async () => {
    const a = await newItem('label only');
    const before = await columnOf(status.id);
    const freshId = Math.max(...before.settings.labels.map((l: Json) => l.id)) + 1;
    const out = await body(
      await edit(admin, {
        labels: [{ column_id: status.id, id: freshId, label: 'Unused soon', color: 'forest' }],
        rows: [{ item_id: a.id, cells: { [status.id]: { index: freshId } } }],
      }),
    );
    await undo(admin, out.batch_id);
    const labels = (await columnOf(status.id)).settings.labels as Json[];
    expect(labels.some((l) => l.id === freshId)).toBe(false);
  });

  it('asks before undoing over a newer edit (changed_since), and does it with force', async () => {
    const a = await newItem('changed');
    const out = await body(await edit(admin, { rows: [{ item_id: a.id, cells: { [text.id]: 'mine' } }] }));
    await as(admin).put(`/items/${a.id}/cells/${text.id}`, { value: 'someone else' });
    const res = await undo(admin, out.batch_id);
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe('changed_since');
    expect((await undo(admin, out.batch_id, true)).status).toBe(200);
    expect((await getItem(a.id)).cells[text.id]).toBeUndefined();
  });

  it('refuses taken label ids (labels_changed), bad values (whole request), and non-owners', async () => {
    const a = await newItem('guarded');
    const taken = await edit(admin, {
      labels: [{ column_id: status.id, id: 0, label: 'Clash', color: 'forest' }],
      rows: [{ item_id: a.id, cells: {} }],
    });
    expect(taken.status).toBe(409);
    const numbers = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'N', type: 'numbers' }));
    const bad = await edit(admin, {
      rows: [
        { item_id: a.id, cells: { [text.id]: 'kept?' } },
        { item_id: a.id, cells: { [numbers.id]: 'not a number' } },
      ],
    });
    expect(bad.status).toBe(422);
    expect((await getItem(a.id)).cells[text.id]).toBeUndefined();
    expect((await edit(bob, { rows: [{ item_id: a.id, cells: { [text.id]: 'x' } }] })).status).toBe(403);
    expect((await edit(admin, { rows: [{ cells: {} }] })).status).toBe(400);
  });

  it('skips items that are gone or on another board', async () => {
    const a = await newItem('alive');
    const res = await body(
      await edit(admin, {
        rows: [
          { item_id: a.id, cells: { [text.id]: 'ok' } },
          { item_id: 'nope', cells: { [text.id]: 'x' } },
        ],
      }),
    );
    expect(res).toMatchObject({ updated: 1, skipped: 1 });
  });
});
