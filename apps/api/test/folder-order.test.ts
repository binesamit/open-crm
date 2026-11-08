// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod (product owner: "drag folders like everything else, and put one between boards — not always at the top")
 * folders stand in one order with the boards, docs and dashboards of their parent; a folder moves to a place among
 * them, into another folder or out to the root.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);
let ws: string;

/** The sidebar's order of one parent (null = the root): folders and boards by position, as names. */
const order = async (parent: string | null) => {
  const tr = await body(await as().get(`/workspaces/${ws}/tree`));
  return [
    ...(tr.folders as Json[]).filter((f) => f.parent_folder_id === parent),
    ...(tr.boards as Json[]).filter((b) => b.folder_id === parent),
    ...((tr.entities ?? []) as Json[]).filter((e) => e.folder_id === parent),
  ]
    .sort((p, q) => (p.position < q.position ? -1 : p.position > q.position ? 1 : 0))
    .map((x) => x.name as string);
};
const folder = async (name: string, parent: string | null = null) =>
  (await body(await as().post('/folders', { workspace_id: ws, parent_folder_id: parent, name }))).id as string;
const board = async (name: string, folderId: string | null = null) =>
  (await body(await as().post('/boards', { name, workspace_id: ws, folder_id: folderId }))).id as string;
const move = (id: string, patch: Json) => as().patch(`/folders/${id}`, patch);

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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  ws = (await body(await as().post('/workspaces', { name: 'Order' }))).id;
});
afterAll(() => t.close());

describe('folders in one order with boards', () => {
  it('a new folder goes after the folders, a new board last; a folder moves between boards and back', async () => {
    const b1 = await board('B1');
    const f1 = await folder('F1');
    const b2 = await board('B2');
    const f2 = await folder('F2');
    // As before: the folders first, then the boards.
    expect(await order(null)).toEqual(['F1', 'F2', 'B1', 'B2']);

    // F1 between the two boards.
    const res = await move(f1, { position: { after_id: b1 } });
    expect(res.status).toBe(200);
    expect(await order(null)).toEqual(['F2', 'B1', 'F1', 'B2']);
    // A new folder still joins the folders' block (after the last folder: F1 now)… and a new board goes last.
    await folder('F3');
    await board('B3');
    expect(await order(null)).toEqual(['F2', 'B1', 'F1', 'F3', 'B2', 'B3']);
    // A board dropped before a folder lands there (boards / docs / folders share one order).
    expect((await as().patch(`/boards/${b2}`, { folder_id: null, position: { before_id: f2 } })).status).toBe(200);
    expect(await order(null)).toEqual(['B2', 'F2', 'B1', 'F1', 'F3', 'B3']);
    // Back to the top.
    expect((await move(f1, { position: { before_id: b2 } })).status).toBe(200);
    expect(await order(null)).toEqual(['F1', 'B2', 'F2', 'B1', 'F3', 'B3']);
  });

  it('into another folder (with all that is in it) and out to the root; never into itself; three levels at most', async () => {
    const outer = await folder('Outer');
    const inner = await folder('Inner');
    const deep = await folder('Deep', inner);
    await board('In deep', deep);
    const target = await board('Target', outer);

    // Inner (with Deep and its board) into Outer, after its board.
    expect((await move(inner, { parent_folder_id: outer, position: { after_id: target } })).status).toBe(200);
    expect(await order(outer)).toEqual(['Target', 'Inner']);
    expect(await order(inner)).toEqual(['Deep']);
    expect(await order(deep)).toEqual(['In deep']);

    // Not into itself or a folder inside it.
    expect((await move(inner, { parent_folder_id: deep })).status).toBe(400);
    expect((await move(outer, { parent_folder_id: inner })).status).toBe(400);
    // Outer › Inner › Deep is three levels: nothing more under Deep, and Inner can not take a folder with a sub-folder.
    const x = await folder('X');
    await folder('X sub', x);
    expect((await move(x, { parent_folder_id: inner })).status).toBe(422);
    expect((await move(x, { parent_folder_id: outer })).status).toBe(200);

    // Out to the root (no place given: after the root's folders); its sub-folders come along.
    expect((await move(inner, { parent_folder_id: null })).status).toBe(200);
    expect(await order(outer)).toEqual(['Target', 'X']);
    expect(await order(null)).toContain('Inner');
    expect(await order(inner)).toEqual(['Deep']);
    // Deep is one level up now: it takes a sub-folder again.
    expect((await as().post('/folders', { workspace_id: ws, parent_folder_id: deep, name: 'Deeper' })).status).toBe(
      201,
    );
  });
});
