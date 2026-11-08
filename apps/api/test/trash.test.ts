// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeOrphanFiles, purgeTrash } from '../../worker/src/tasks';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 07 §5.2–5.3: trash, restore, undo (toast + activity), purge. */
let t: TestContext;
let admin: string;
let bob: string; // member: board editor
let carol: string; // another member
let acmeId: string;
let wsId: string;
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
const itemNames = async () =>
  (await body(await as(admin).get(`/boards/${boardId}/items`))).data.map((i: Json) => i.name);
const trashNames = async (cookie: string) => (await body(await as(cookie).get('/trash'))).data.map((e: Json) => e.name);
const newItem = async (name: string, cookie = admin, group = groupId) =>
  body(await as(cookie).post(`/boards/${boardId}/items`, { name, group_id: group }));
const undo = (cookie: string, eventId: string, force?: boolean) =>
  as(cookie).post(`/activity/${eventId}/undo`, force ? { force } : {});

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  const board = await body(await as(admin).post('/boards', { name: 'Trash', workspace_id: wsId }));
  boardId = board.id;
  groupId = board.groups[0].id;
});
afterAll(() => t.close());

describe('trash', () => {
  it('a deleted item is in my trash (and the admin’s), not in other members’ — and restores in place', async () => {
    const item = await newItem('Bob item', bob);
    const del = await body(await as(bob).del(`/items/${item.id}`));
    expect(del).toMatchObject({ ok: true, event_id: expect.any(String) });
    expect(await itemNames()).not.toContain('Bob item');
    expect(await trashNames(bob)).toContain('Bob item');
    expect(await trashNames(admin)).toContain('Bob item');
    expect(await trashNames(carol)).not.toContain('Bob item');

    const entry = (await body(await as(bob).get('/trash'))).data.find((e: Json) => e.name === 'Bob item');
    expect(entry).toMatchObject({ object_type: 'item', board_name: 'Trash', deleted_by: { name: 'bob' } });
    expect((await as(carol).post(`/trash/${entry.id}/restore`)).status).toBe(404);
    expect(await body(await as(bob).post(`/trash/${entry.id}/restore`))).toMatchObject({
      ok: true,
      object_type: 'item',
      board_id: boardId,
    });
    expect(await itemNames()).toContain('Bob item');
    expect(await trashNames(bob)).not.toContain('Bob item');
  });

  it('a group goes to trash with its items; restoring brings back only those', async () => {
    const group = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'G2' }));
    await newItem('in G2 a', admin, group.id);
    const early = await newItem('in G2 deleted first', admin, group.id);
    await as(admin).del(`/items/${early.id}`);
    const del = await body(await as(admin).del(`/boards/${boardId}/groups/${group.id}`));
    expect(await itemNames()).not.toContain('in G2 a');

    expect((await undo(admin, del.event_id)).status).toBe(200);
    const names = await itemNames();
    expect(names).toContain('in G2 a');
    expect(names).not.toContain('in G2 deleted first'); // has its own trash entry
    expect(await trashNames(admin)).toContain('in G2 deleted first');
  });

  it('an item whose group is gone comes back in the first group', async () => {
    const group = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'G3' }));
    const item = await newItem('orphan', admin, group.id);
    const delItem = await body(await as(admin).del(`/items/${item.id}`));
    await as(admin).del(`/boards/${boardId}/groups/${group.id}`);
    expect((await undo(admin, delItem.event_id)).status).toBe(200);
    const back = (await body(await as(admin).get(`/items/${item.id}`))) as Json;
    expect(back.group_id).not.toBe(group.id);
  });

  it('deleting a group takes the items’ subitems with it; the undo brings them back (audit 2026-10-10 C1)', async () => {
    const group = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'G4' }));
    const parent = await newItem('parent in G4', admin, group.id);
    const sub = await body(await as(admin).post(`/items/${parent.id}/subitems`, { name: 'sub of G4' }));
    expect((await as(admin).get(`/items/${sub.id}`)).status).toBe(200);
    const del = await body(await as(admin).del(`/boards/${boardId}/groups/${group.id}`));
    // The subitem is gone with its parent (it used to stay live: My Work, search, relation pickers).
    expect((await as(admin).get(`/items/${parent.id}`)).status).toBe(404);
    expect((await as(admin).get(`/items/${sub.id}`)).status).toBe(404);
    expect((await undo(admin, del.event_id)).status).toBe(200);
    expect((await as(admin).get(`/items/${parent.id}`)).status).toBe(200);
    expect((await as(admin).get(`/items/${sub.id}`)).status).toBe(200);
  });

  it('an item with subitems whose group is gone restores too; the subitems keep no group (audit 2026-10-10 C3)', async () => {
    const group = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'G5' }));
    const item = await newItem('orphan parent', admin, group.id);
    const sub = await body(await as(admin).post(`/items/${item.id}/subitems`, { name: 'orphan sub' }));
    const delItem = await body(await as(admin).del(`/items/${item.id}`));
    await as(admin).del(`/boards/${boardId}/groups/${group.id}`);
    // Used to fail the whole restore: the subitem was given the first group, which `ck_items_tree` forbids.
    expect((await undo(admin, delItem.event_id)).status).toBe(200);
    const back = (await body(await as(admin).get(`/items/${item.id}`))) as Json;
    expect(back.group_id).not.toBe(group.id);
    const subBack = (await body(await as(admin).get(`/items/${sub.id}`))) as Json;
    expect(subBack.parent_item_id).toBe(item.id);
    expect(subBack.group_id ?? null).toBeNull();
  });

  it('restoring an item of a board in trash asks for the board first', async () => {
    const other = await body(await as(admin).post('/boards', { name: 'Doomed', workspace_id: wsId }));
    const item = await body(
      await as(admin).post(`/boards/${other.id}/items`, { name: 'x', group_id: other.groups[0].id }),
    );
    await as(admin).del(`/items/${item.id}`);
    await as(admin).del(`/boards/${other.id}`);
    const entries = (await body(await as(admin).get('/trash'))).data as Json[];
    const itemEntry = entries.find((e) => e.object_id === item.id)!;
    const boardEntry = entries.find((e) => e.object_id === other.id)!;
    const res = await as(admin).post(`/trash/${itemEntry.id}/restore`);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toMatchObject({
      code: 'parent_in_trash',
      details: { parent_type: 'board', parent_entry_id: boardEntry.id },
    });
    expect((await as(admin).post(`/trash/${boardEntry.id}/restore`)).status).toBe(200);
    expect((await as(admin).post(`/trash/${itemEntry.id}/restore`)).status).toBe(200);
    expect((await as(admin).get(`/items/${item.id}`)).status).toBe(200);
  });

  it('a folder restores with its subfolders and puts the boards back', async () => {
    const f = await body(await as(admin).post('/folders', { workspace_id: wsId, name: 'F' }));
    const sub = await body(
      await as(admin).post('/folders', { workspace_id: wsId, name: 'Sub', parent_folder_id: f.id }),
    );
    const b = await body(await as(admin).post('/boards', { name: 'In sub', workspace_id: wsId, folder_id: sub.id }));
    const del = await body(await as(admin).del(`/folders/${f.id}`));
    const tree = async () => body(await as(admin).get(`/workspaces/${wsId}/tree`));
    expect((await tree()).boards.find((x: Json) => x.id === b.id).folder_id).toBeNull();
    expect((await undo(admin, del.event_id)).status).toBe(200);
    const after = await tree();
    expect(after.folders.map((x: Json) => x.id)).toEqual(expect.arrayContaining([f.id, sub.id]));
    expect(after.boards.find((x: Json) => x.id === b.id).folder_id).toBe(sub.id);
  });

  it('a folder can take its boards to trash with it; restoring the folder brings them back', async () => {
    const tree = async () => body(await as(admin).get(`/workspaces/${wsId}/tree`));
    const f = await body(await as(admin).post('/folders', { workspace_id: wsId, name: 'With boards' }));
    const sub = await body(
      await as(admin).post('/folders', { workspace_id: wsId, name: 'Inner', parent_folder_id: f.id }),
    );
    const b1 = await body(await as(admin).post('/boards', { name: 'Top board', workspace_id: wsId, folder_id: f.id }));
    const b2 = await body(
      await as(admin).post('/boards', { name: 'Inner board', workspace_id: wsId, folder_id: sub.id }),
    );

    // Without the right to delete its boards: refused, nothing changes.
    expect((await as(bob).del(`/folders/${f.id}?boards=trash`)).status).toBe(403);
    expect((await tree()).folders.map((x: Json) => x.id)).toContain(f.id);

    const del = await body(await as(admin).del(`/folders/${f.id}?boards=trash`));
    const gone = await tree();
    expect(gone.folders.map((x: Json) => x.id)).not.toContain(f.id);
    expect(gone.boards.map((x: Json) => x.id)).not.toContain(b1.id);
    expect(gone.boards.map((x: Json) => x.id)).not.toContain(b2.id);
    expect((await as(admin).get(`/boards/${b1.id}`)).status).toBe(404);
    expect(await trashNames(admin)).toEqual(expect.arrayContaining(['With boards', 'Top board', 'Inner board']));

    // Restoring the folder (here: undo) brings both boards back into their folders.
    expect((await undo(admin, del.event_id)).status).toBe(200);
    const back = await tree();
    expect(back.boards.find((x: Json) => x.id === b1.id).folder_id).toBe(f.id);
    expect(back.boards.find((x: Json) => x.id === b2.id).folder_id).toBe(sub.id);
    expect(await trashNames(admin)).not.toContain('Top board');
  });

  it('a board trashed with its folder restores alone to the root; the folder then comes back without it', async () => {
    const tree = async () => body(await as(admin).get(`/workspaces/${wsId}/tree`));
    const f = await body(await as(admin).post('/folders', { workspace_id: wsId, name: 'Two boards' }));
    const keep = await body(
      await as(admin).post('/boards', { name: 'Restored first', workspace_id: wsId, folder_id: f.id }),
    );
    const other = await body(
      await as(admin).post('/boards', { name: 'With folder', workspace_id: wsId, folder_id: f.id }),
    );
    expect((await as(admin).del(`/folders/${f.id}?boards=trash`)).status).toBe(200);
    const entries = (await body(await as(admin).get('/trash'))).data as Json[];
    const boardEntry = entries.find((e) => e.name === 'Restored first')!;
    expect((await as(admin).post(`/trash/${boardEntry.id}/restore`)).status).toBe(200);
    expect((await tree()).boards.find((x: Json) => x.id === keep.id).folder_id).toBeNull();
    const folderEntry = ((await body(await as(admin).get('/trash'))).data as Json[]).find(
      (e) => e.name === 'Two boards',
    )!;
    expect((await as(admin).post(`/trash/${folderEntry.id}/restore`)).status).toBe(200);
    const after = await tree();
    expect(after.boards.find((x: Json) => x.id === other.id).folder_id).toBe(f.id);
    expect(after.boards.find((x: Json) => x.id === keep.id).folder_id).toBeNull();
  });

  it('columns, views and updates restore too', async () => {
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Num', type: 'numbers' }));
    const delCol = await body(await as(admin).del(`/boards/${boardId}/columns/${col.id}`));
    expect((await undo(admin, delCol.event_id)).status).toBe(200);
    expect((await body(await as(admin).get(`/boards/${boardId}`))).columns.map((c: Json) => c.id)).toContain(col.id);

    const view = await body(await as(admin).post(`/boards/${boardId}/views`, { name: 'V' }));
    const delView = await body(await as(admin).del(`/views/${view.id}`));
    expect((await undo(admin, delView.event_id)).status).toBe(200);
    const views = (await body(await as(admin).get(`/boards/${boardId}/views`))).data as Json[];
    expect(views.map((v) => v.id)).toContain(view.id);

    const item = await newItem('with update');
    const up = await body(await as(admin).post(`/items/${item.id}/updates`, { body: 'hello' }));
    const delUp = await body(await as(admin).del(`/updates/${up.id}`));
    expect((await undo(admin, delUp.event_id)).status).toBe(200);
    expect((await body(await as(admin).get(`/items/${item.id}/updates`))).data).toHaveLength(1);
  });

  it('only admins empty the trash; "delete permanently" takes it out of the list', async () => {
    expect((await as(bob).del('/trash')).status).toBe(403);
    const item = await newItem('forever', bob);
    await as(bob).del(`/items/${item.id}`);
    const entry = (await body(await as(bob).get('/trash'))).data.find((e: Json) => e.name === 'forever');
    expect((await as(bob).del(`/trash/${entry.id}`)).status).toBe(200);
    expect(await trashNames(bob)).not.toContain('forever');
    expect((await as(bob).post(`/trash/${entry.id}/restore`)).status).toBe(404);
  });
});

describe('undo', () => {
  it('undoes a cell change; refuses when the value changed since unless forced', async () => {
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Amount', type: 'numbers' }));
    const item = await newItem('valued');
    const value = async () => (await body(await as(admin).get(`/items/${item.id}`))).cells[col.id]?.value ?? null;
    await as(admin).put(`/items/${item.id}/cells/${col.id}`, { value: 1 });
    await as(admin).put(`/items/${item.id}/cells/${col.id}`, { value: 2 });
    const log = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where item_id = ${item.id} and type = 'cell.changed' order by created_at, id`,
      )
    ).rows;
    expect(log).toHaveLength(2);

    expect((await undo(admin, log[1]!.id)).status).toBe(200);
    expect(await value()).toEqual(1);
    expect((await undo(admin, log[1]!.id)).status).toBe(409); // already undone

    // The first change (→1) was followed by others: the value now is 1 again but the event after is 1 → ok;
    // change it to 3 so it differs from what the first event produced.
    await as(admin).put(`/items/${item.id}/cells/${col.id}`, { value: 3 });
    const conflict = await undo(admin, log[0]!.id);
    expect(conflict.status).toBe(409);
    expect((await body(conflict)).error.code).toBe('changed_since');
    expect((await undo(admin, log[0]!.id, true)).status).toBe(200);
    expect(await value()).toBeNull();
  });

  it('undoes a rename and a move between groups', async () => {
    const item = await newItem('before');
    await as(admin).patch(`/items/${item.id}`, { name: 'after' });
    const renamed = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where item_id = ${item.id} and type = 'item.renamed'`,
      )
    ).rows[0]!;
    expect((await undo(admin, renamed.id)).status).toBe(200);
    expect((await body(await as(admin).get(`/items/${item.id}`))).name).toBe('before');

    const g = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'Target' }));
    await as(admin).post(`/items/${item.id}/move-to-group`, { group_id: g.id });
    const moved = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where item_id = ${item.id} and type = 'item.moved_to_group'`,
      )
    ).rows[0]!;
    expect((await undo(admin, moved.id)).status).toBe(200);
    expect((await body(await as(admin).get(`/items/${item.id}`))).group_id).toBe(groupId);
  });

  it('the actor or an admin may undo, nobody else; unknown types are not undoable', async () => {
    const item = await newItem('bobs', bob);
    const del = await body(await as(bob).del(`/items/${item.id}`));
    expect((await undo(carol, del.event_id)).status).toBe(403);
    expect((await undo(admin, del.event_id)).status).toBe(200);

    const created = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where item_id = ${item.id} and type = 'item.created'`,
      )
    ).rows[0]!;
    expect((await undo(bob, created.id)).status).toBe(422);
  });

  it('a batch is undone as one (multi-cell update)', async () => {
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'B', type: 'numbers' }));
    const item = await newItem('batch');
    await as(admin).patch(`/items/${item.id}`, { name: 'batch 2', cells: { [col.id]: 7 } });
    const ev = (
      await t.db.execute<{ id: string; batch_id: string }>(
        sql`select id, batch_id from activity_log where item_id = ${item.id} and type = 'item.renamed'`,
      )
    ).rows[0]!;
    expect(ev.batch_id).toBeTruthy();
    expect(await body(await undo(admin, ev.id))).toMatchObject({ ok: true, undone: 2 });
    const back = await body(await as(admin).get(`/items/${item.id}`));
    expect(back.name).toBe('batch');
    expect(back.cells[col.id]).toBeUndefined();
  });

  it('an edit returns its event; undo, redo, and undo the redo (Ctrl+Z / Ctrl+Shift+Z, 07 §10)', async () => {
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'R', type: 'numbers' }));
    const item = await newItem('redo');
    const value = async () => (await body(await as(admin).get(`/items/${item.id}`))).cells[col.id]?.value ?? null;
    const edited = await body(await as(admin).put(`/items/${item.id}/cells/${col.id}`, { value: 5 }));
    expect(edited.event_id).toEqual(expect.any(String));
    expect((await body(await as(admin).patch(`/items/${item.id}`, { name: 'redo 2' }))).event_id).toEqual(
      expect.any(String),
    );

    const undone = await body(await undo(admin, edited.event_id));
    expect(undone.event_ids).toHaveLength(1);
    expect(await value()).toBeNull();
    expect((await as(bob).post(`/activity/${edited.event_id}/redo`, {})).status).toBe(403); // not his action
    const redone = await body(await as(admin).post(`/activity/${edited.event_id}/redo`, {}));
    expect(redone).toMatchObject({ ok: true, undone: 1 });
    expect(await value()).toBe(5);
    expect((await as(admin).post(`/activity/${edited.event_id}/redo`, {})).status).toBe(422); // nothing left
    // Ctrl+Z after a redo undoes what the redo wrote.
    await undo(admin, redone.event_ids[0]);
    expect(await value()).toBeNull();
  });
});

describe('activity log (07 §12)', () => {
  it('each row says whether the viewer may undo it; a batch is one row on the board log', async () => {
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Log', type: 'numbers' }));
    const one = await newItem('log one');
    const two = await newItem('log two');
    await as(admin).put(`/items/${one.id}/cells/${col.id}`, { value: 3 });
    const mine = (await body(await as(admin).get(`/items/${one.id}/activity`))).data[0];
    expect(mine).toMatchObject({ type: 'cell.changed', undoable: true, undone: false, item_name: 'log one' });
    expect((await body(await as(bob).get(`/items/${one.id}/activity`))).data[0].undoable).toBe(false);

    await body(
      await as(admin).post(`/boards/${boardId}/items/bulk`, {
        item_ids: [one.id, two.id],
        action: { type: 'set_cell', column_id: col.id, value: 9 },
      }),
    );
    const log = (await body(await as(admin).get(`/boards/${boardId}/activity`))).data as Json[];
    const row = log.find((e) => e.count === 2 && String(e.item_name).includes('log'))!;
    expect(row).toMatchObject({ type: 'cell.changed', undoable: true });
    expect((await as(admin).post(`/activity/${row.id}/undo`, {})).status).toBe(200);
    const after = (await body(await as(admin).get(`/boards/${boardId}/activity`))).data as Json[];
    expect(after.find((e) => e.id === row.id)).toMatchObject({
      undone: true,
      undoable: false,
    });
    expect(after[0]).toMatchObject({ is_undo: true });
    expect((await as(carol).get(`/boards/${boardId}/activity`)).status).toBe(200);
  });
});

describe('purge (worker)', () => {
  const count = async (table: string, id: string) =>
    Number(
      (await t.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where id = ${id}`))
        .rows[0]!.n,
    );

  it('removes due entries for good; a purged column keeps its row (key reserved), its cells go', async () => {
    const item = await newItem('to purge');
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'P', type: 'numbers' }));
    await as(admin).put(`/items/${item.id}/cells/${col.id}`, { value: 9 });
    await as(admin).del(`/boards/${boardId}/columns/${col.id}`);
    const kept = await newItem('kept in trash');
    await as(admin).del(`/items/${kept.id}`);
    await as(admin).del(`/items/${item.id}`);

    const entries = (await body(await as(admin).get('/trash'))).data as Json[];
    const due = entries.filter((e) => e.name === 'to purge' || e.name === 'P');
    for (const e of due) await as(admin).del(`/trash/${e.id}`);

    const errors: string[] = [];
    expect(await purgeTrash(t.pg, 100, (m) => errors.push(m))).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    expect(await count('items', item.id)).toBe(0);
    expect(await count('items', kept.id)).toBe(1); // not due yet
    const colRow = (
      await t.db.execute<{ n: number }>(
        sql`select count(*)::int as n from columns where board_id = ${boardId} and key = ${col.id}`,
      )
    ).rows[0]!;
    expect(Number(colRow.n)).toBe(1);
    // The key stays taken.
    expect(
      (await as(admin).post(`/boards/${boardId}/columns`, { title: 'P2', type: 'numbers', id: col.id })).status,
    ).toBe(409);
  });

  it('purges a group with its items and a board with everything in it', async () => {
    const g = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'Gone' }));
    const inG = await newItem('in gone', admin, g.id);
    await as(admin).del(`/boards/${boardId}/groups/${g.id}`);
    const b = await body(await as(admin).post('/boards', { name: 'Gone board', workspace_id: wsId }));
    const inB = await body(await as(admin).post(`/boards/${b.id}/items`, { name: 'in b', group_id: b.groups[0].id }));
    await as(admin).del(`/boards/${b.id}`);
    expect((await as(admin).del('/trash')).status).toBe(200);
    expect(await trashNames(admin)).toEqual([]);
    await purgeTrash(t.pg, 1000, (m) => {
      throw new Error(m);
    });
    expect(await count('groups', g.id)).toBe(0);
    expect(await count('items', inG.id)).toBe(0);
    expect(await count('boards', b.id)).toBe(0);
    expect(await count('items', inB.id)).toBe(0);
  });

  it('files nothing uses for 24 hours leave storage, then the database; used or recent ones stay', async () => {
    const client = t.pg;
    const asset = async (key: string, hoursOld: number) => {
      const id = `01ORPHAN${key.toUpperCase().padEnd(18, '0')}`.slice(0, 26);
      await t.db.execute(sql`insert into assets (id, account_id, storage_key, file_name, upload_status, created_at)
        values (${id}, ${acmeId}, ${key}, ${key}, 'done', now() - make_interval(hours => ${hoursOld}))`);
      return id;
    };
    const orphan = await asset('old', 25);
    const recent = await asset('new', 23);
    const avatar = await asset('face', 240);
    await t.db.execute(sql`update users set avatar_asset_id = ${avatar} where email = 'admin@acme.test'`);

    const removed: string[] = [];
    const n = await purgeOrphanFiles(
      client,
      async (key) => void removed.push(key),
      100,
      () => undefined,
    );
    expect(n).toBe(1);
    expect(removed).toEqual(['old']);
    expect(await count('assets', orphan)).toBe(0);
    expect(await count('assets', recent)).toBe(1);
    expect(await count('assets', avatar)).toBe(1);

    // Storage down: the row stays for the next run.
    const again = await asset('later', 25);
    const failed = await purgeOrphanFiles(
      client,
      async () => Promise.reject(new Error('down')),
      100,
      () => undefined,
    );
    expect(failed).toBe(0);
    expect(await count('assets', again)).toBe(1);
  });
});
