// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, boards } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Moving boards and folders to another workspace (fix8, product owner: "אפשרות להעביר בורדים בין ווארקספייס"). */
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // member
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const workspace = async (name: string, kind: 'open' | 'closed' = 'open') =>
  body(await as(admin).post('/workspaces', { name, kind }));
const tree = async (cookie: string, id: string) => body(await as(cookie).get(`/workspaces/${id}/tree`));

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
});
afterAll(() => t.close());

describe('PATCH /boards/:id { workspace_id }', () => {
  it('moves a board (and its sub-board) to another workspace root or folder, with an activity entry', async () => {
    const w1 = await workspace('Sales');
    const w2 = await workspace('Ops');
    const board = await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: w1.id }));
    const item = await body(await as(admin).post(`/boards/${board.id}/items`, { name: 'Deal' }));
    expect((await as(admin).post(`/items/${item.id}/subitems`, { name: 'Step' })).status).toBe(201);

    const res = await as(admin).patch(`/boards/${board.id}`, { workspace_id: w2.id });
    expect(res.status).toBe(200);
    expect((await body(res)).workspace_id).toBe(w2.id);
    expect((await tree(admin, w2.id)).boards.map((b: Json) => b.id)).toContain(board.id);
    expect((await tree(admin, w1.id)).boards.map((b: Json) => b.id)).not.toContain(board.id);
    const sub = await t.db.select().from(boards).where(eq(boards.parentBoardId, board.id));
    expect(sub.map((s) => s.workspaceId)).toEqual([w2.id]);
    const [event] = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.boardId, board.id), eq(activityLog.type, 'board.moved')));
    expect(event!.payload.before).toEqual({ workspace_id: w1.id, folder_id: null });
    expect(event!.payload.after).toEqual({ workspace_id: w2.id, folder_id: null });

    // Into a folder of the target; a folder of another workspace is refused.
    const f2 = await body(await as(admin).post('/folders', { workspace_id: w1.id, name: 'Archive' }));
    expect((await as(admin).patch(`/boards/${board.id}`, { workspace_id: w1.id, folder_id: f2.id })).status).toBe(200);
    expect((await tree(admin, w1.id)).boards.find((b: Json) => b.id === board.id).folder_id).toBe(f2.id);
    const other = await body(await as(admin).post('/folders', { workspace_id: w2.id, name: 'X' }));
    expect((await as(admin).patch(`/boards/${board.id}`, { workspace_id: w1.id, folder_id: other.id })).status).toBe(
      404, // already there: a plain folder move, and that folder is not in this workspace
    );
    expect((await as(admin).patch(`/boards/${board.id}`, { workspace_id: w2.id, folder_id: f2.id })).status).toBe(404);
  });

  it('needs management rights on the board and the right to create in the target', async () => {
    const w1 = await workspace('A1');
    const w2 = await workspace('A2');
    const closed = await workspace('Board room', 'closed');
    const adminBoard = await body(await as(admin).post('/boards', { name: 'Admins', workspace_id: w1.id }));
    // Bob may edit it (main board) but not manage it.
    expect((await as(bob).patch(`/boards/${adminBoard.id}`, { workspace_id: w2.id })).status).toBe(403);

    const bobBoard = await body(await as(bob).post('/boards', { name: 'Mine', workspace_id: w1.id }));
    expect((await as(bob).patch(`/boards/${bobBoard.id}`, { workspace_id: w2.id })).status).toBe(200);
    // A closed workspace he is not in does not exist for him.
    expect((await as(bob).patch(`/boards/${bobBoard.id}`, { workspace_id: closed.id })).status).toBe(404);
    expect((await as(bob).patch(`/boards/${bobBoard.id}`, { workspace_id: 'nope' })).status).toBe(404);
  });

  it('a private board from a closed workspace keeps its own permissions in an open one', async () => {
    const closed = await workspace('Finance', 'closed');
    const open = await workspace('Everyone');
    const board = await body(
      await as(admin).post('/boards', { name: 'Salaries', workspace_id: closed.id, kind: 'private' }),
    );
    expect((await as(admin).patch(`/boards/${board.id}`, { workspace_id: open.id })).status).toBe(200);
    const moved = await body(await as(admin).get(`/boards/${board.id}`));
    expect(moved.kind).toBe('private');
    expect((await as(carol).get(`/boards/${board.id}`)).status).toBe(404);
    expect((await tree(carol, open.id)).boards.map((b: Json) => b.id)).not.toContain(board.id);
  });
});

describe('PATCH /folders/:id { workspace_id }', () => {
  it('moves a folder with its sub-folders and boards to the target root', async () => {
    const w1 = await workspace('F1');
    const w2 = await workspace('F2');
    const top = await body(await as(admin).post('/folders', { workspace_id: w1.id, name: 'Clients' }));
    const nested = await body(
      await as(admin).post('/folders', { workspace_id: w1.id, parent_folder_id: top.id, name: 'VIP' }),
    );
    const b1 = await body(await as(admin).post('/boards', { name: 'C1', workspace_id: w1.id, folder_id: top.id }));
    const b2 = await body(await as(admin).post('/boards', { name: 'C2', workspace_id: w1.id, folder_id: nested.id }));

    const res = await as(admin).patch(`/folders/${top.id}`, { workspace_id: w2.id });
    expect(res.status).toBe(200);
    expect((await body(res)).workspace_id).toBe(w2.id);
    const t2 = await tree(admin, w2.id);
    expect(t2.folders.map((f: Json) => [f.name, f.parent_folder_id])).toEqual(
      expect.arrayContaining([
        ['Clients', null],
        ['VIP', top.id],
      ]),
    );
    expect(t2.boards.map((b: Json) => [b.id, b.folder_id])).toEqual(
      expect.arrayContaining([
        [b1.id, top.id],
        [b2.id, nested.id],
      ]),
    );
    const t1 = await tree(admin, w1.id);
    expect(t1.folders).toEqual([]);
    expect(t1.boards).toEqual([]);
    const events = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'folder.moved')));
    expect(events.length).toBe(1);
  });

  it("refuses someone else's folder, and a folder holding boards one cannot manage", async () => {
    const w1 = await workspace('G1');
    const w2 = await workspace('G2');
    const adminFolder = await body(await as(admin).post('/folders', { workspace_id: w1.id, name: 'Admin' }));
    expect((await as(bob).patch(`/folders/${adminFolder.id}`, { workspace_id: w2.id })).status).toBe(403);

    const bobFolder = await body(await as(bob).post('/folders', { workspace_id: w1.id, name: 'Bob' }));
    await as(admin).post('/boards', { name: 'Not his', workspace_id: w1.id, folder_id: bobFolder.id });
    const res = await as(bob).patch(`/folders/${bobFolder.id}`, { workspace_id: w2.id });
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('folder_has_unmanaged_boards');
  });
});
