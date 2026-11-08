// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/** 07 §4.1, §4.3: duplicate a board (structure / items / updates) and save it as a template. */
let t: TestContext;
let admin: string;
let carol: string; // viewer
let acmeId: string;
let wsId: string;
let src: Json;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const items = async (boardId: string) => (await body(await as(admin).get(`/boards/${boardId}/items`))).data as Json[];

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
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;

  // A source board: a numbers column, a self-relation, two groups, items, a subitem with its own column, an update.
  src = await body(await as(admin).post('/boards', { name: 'Pipeline', workspace_id: wsId }));
  const num = await body(await as(admin).post(`/boards/${src.id}/columns`, { title: 'Amount', type: 'numbers' }));
  const rel = await body(
    await as(admin).post(`/boards/${src.id}/columns`, {
      title: 'Related',
      type: 'board_relation',
      settings: { board_ids: [src.id] },
    }),
  );
  await as(admin).post(`/boards/${src.id}/groups`, { title: 'Later', position: 'bottom' });
  const a = await body(await as(admin).post(`/boards/${src.id}/items`, { name: 'A', cells: { [num.id]: 10 } }));
  const b = await body(await as(admin).post(`/boards/${src.id}/items`, { name: 'B' }));
  await as(admin).put(`/items/${b.id}/cells/${rel.id}`, { value: { item_ids: [a.id] } });
  await as(admin).post(`/items/${a.id}/subitems`, { name: 'A.1' });
  await as(admin).post(`/items/${a.id}/updates`, { body: 'hello' });
  src = await body(await as(admin).get(`/boards/${src.id}`));
});
afterAll(() => t.close());

describe('duplicate board', () => {
  it('structure: same columns (keys), groups, sub-board columns; no items; the duplicator owns it', async () => {
    const res = await as(admin).post(`/boards/${src.id}/duplicate`, { mode: 'structure' });
    expect(res.status).toBe(201);
    const copy = await body(res);
    expect(copy.name).toBe(he('server.boardCopy', { name: 'Pipeline' }));
    expect(copy.columns.map((c: Json) => [c.id, c.type])).toEqual(src.columns.map((c: Json) => [c.id, c.type]));
    expect(copy.groups.map((g: Json) => g.title)).toEqual(src.groups.map((g: Json) => g.title));
    expect(copy.capabilities['board.delete']).toBe(true);
    expect(await items(copy.id)).toEqual([]);
    const sub = await body(await as(admin).get(`/boards/${copy.subitems_board_id}`));
    expect(sub.columns.map((c: Json) => c.type)).toEqual(['name', 'people', 'status', 'date']);
    // The copy is on the sidebar; the source is untouched.
    const tree = await body(await as(admin).get(`/workspaces/${wsId}/tree`));
    expect(tree.boards.map((x: Json) => x.id)).toContain(copy.id);
    expect((await items(src.id)).map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('items: cells, subitems and links within the board point at the copies; updates only in that mode', async () => {
    const copy = await body(await as(admin).post(`/boards/${src.id}/duplicate`, { mode: 'items', name: 'Copy 2' }));
    const list = await items(copy.id);
    const a2 = list.find((i) => i.name === 'A')!;
    const b2 = list.find((i) => i.name === 'B')!;
    const num = src.columns.find((c: Json) => c.title === 'Amount');
    const rel = src.columns.find((c: Json) => c.title === 'Related');
    expect(a2.cells[num.id].value).toEqual(10);
    expect(b2.cells[rel.id].value).toEqual({ item_ids: [a2.id] }); // the copy, not the original A
    const subs = await items(copy.subitems_board_id);
    expect(subs.map((s) => [s.name, s.parent_item_id])).toEqual([['A.1', a2.id]]);
    expect((await body(await as(admin).get(`/items/${a2.id}/updates`))).data).toHaveLength(0);

    const withUpdates = await body(
      await as(admin).post(`/boards/${src.id}/duplicate`, { mode: 'items_updates', name: 'Copy 3' }),
    );
    const a3 = (await items(withUpdates.id)).find((i) => i.name === 'A')!;
    expect((await body(await as(admin).get(`/items/${a3.id}/updates`))).data).toHaveLength(1);
  });

  it('viewers cannot duplicate; sub-boards are not duplicated on their own', async () => {
    expect((await as(carol).post(`/boards/${src.id}/duplicate`, {})).status).toBe(403);
    expect((await as(admin).post(`/boards/${src.subitems_board_id}/duplicate`, {})).status).toBe(400);
  });
});

describe('save as template', () => {
  it('saves the structure; a new board from it has the same columns, groups and subitem columns', async () => {
    const res = await as(admin).post(`/boards/${src.id}/save-as-template`, { name: 'Sales pipeline' });
    expect(res.status).toBe(201);
    const tpl = await body(res);
    const list = (await body(await as(admin).get('/templates'))).data as Json[];
    expect(list.find((x) => x.key === tpl.key)).toMatchObject({ name: 'Sales pipeline' });

    const board = await body(
      await as(admin).post('/boards', { name: 'From template', workspace_id: wsId, template_key: tpl.key }),
    );
    expect(board.columns.map((c: Json) => [c.id, c.type, c.title])).toEqual(
      src.columns.map((c: Json) => [c.id, c.type, c.title]),
    );
    expect(board.groups.map((g: Json) => [g.title, g.color])).toEqual(src.groups.map((g: Json) => [g.title, g.color]));
    expect(board.subitems_board_id).toBeTruthy();
    expect(await items(board.id)).toEqual([]);
    expect((await as(carol).post(`/boards/${src.id}/save-as-template`, { name: 'x' })).status).toBe(403);
  });
});

describe('templates with items, editing, another Workspace (M4.5)', () => {
  it('a "with items" template brings its items, values and subitems', async () => {
    const tpl = await body(
      await as(admin).post(`/boards/${src.id}/save-as-template`, { name: 'With items', with_items: true }),
    );
    const listed = ((await body(await as(admin).get('/templates'))).data as Json[]).find((x) => x.key === tpl.key);
    expect(listed).toMatchObject({ account: true, can_edit: true, item_count: 2 });
    expect(
      ((await body(await as(carol).get('/templates'))).data as Json[]).find((x) => x.key === tpl.key),
    ).toMatchObject({ can_edit: false });
    const board = await body(
      await as(admin).post('/boards', { name: 'Seeded', workspace_id: wsId, template_key: tpl.key }),
    );
    const rows = (await body(await as(admin).get(`/boards/${board.id}/items`))).data as Json[];
    expect(rows.map((r) => r.name)).toEqual(['A', 'B']);
    const amount = board.columns.find((c: Json) => c.title === 'Amount').id;
    expect(rows[0]!.cells[amount].value).toBe(10);
    const subs = (await body(await as(admin).get(`/boards/${board.subitems_board_id}/items`))).data as Json[];
    expect(subs.map((s) => [s.name, s.parent_item_id])).toEqual([['A.1', rows[0]!.id]]);
  });

  it('the creator or an admin renames and deletes an account template', async () => {
    const tpl = await body(await as(admin).post(`/boards/${src.id}/save-as-template`, { name: 'Temp' }));
    expect((await as(carol).patch(`/templates/${tpl.key}`, { name: 'Hack' })).status).toBe(403);
    expect(await body(await as(admin).patch(`/templates/${tpl.key}`, { name: 'Renamed' }))).toMatchObject({
      name: 'Renamed',
    });
    expect((await as(admin).del(`/templates/${tpl.key}`)).status).toBe(200);
    const keys = ((await body(await as(admin).get('/templates'))).data as Json[]).map((x) => x.key);
    expect(keys).not.toContain(tpl.key);
    expect((await as(admin).del('/templates/real_estate_x')).status).toBe(404);
  });

  it('duplicates a board into another Workspace', async () => {
    const other = await body(await as(admin).post('/workspaces', { name: 'Other' }));
    const copy = await body(
      await as(admin).post(`/boards/${src.id}/duplicate`, { mode: 'structure', workspace_id: other.id }),
    );
    expect(copy.workspace_id).toBe(other.id);
    expect((await as(admin).post(`/boards/${src.id}/duplicate`, { workspace_id: 'nope' })).status).toBe(404);
  });

  it('admins remove or edit built-in templates for the account; a board can be saved over a template', async () => {
    const list = async (who = admin) => (await body(await as(who).get('/templates'))).data as Json[];
    const [first, second] = (await list()).filter((x) => !x.account);
    expect(first).toMatchObject({ can_edit: true });
    expect((await list(carol)).find((x) => x.key === first!.key)).toMatchObject({ can_edit: false });
    expect((await as(carol).del(`/templates/${first!.key}`)).status).toBe(403);

    // Remove: hidden from this account's list.
    expect((await as(admin).del(`/templates/${first!.key}`)).status).toBe(200);
    expect((await list()).map((x) => x.key)).not.toContain(first!.key);

    // Edit: an account copy takes its place.
    const renamed = await body(await as(admin).patch(`/templates/${second!.key}`, { name: 'My version' }));
    expect(renamed).toMatchObject({ name: 'My version', account: true });
    const keys = (await list()).map((x) => x.key);
    expect(keys).not.toContain(second!.key);
    expect(keys).toContain(renamed.key);

    // Save a board over it: same key, the board's structure and items now.
    const res = await as(admin).post(`/boards/${src.id}/save-as-template`, {
      name: 'My version 2',
      with_items: true,
      replace_key: renamed.key,
    });
    expect(await body(res)).toMatchObject({ key: renamed.key });
    expect((await list()).find((x) => x.key === renamed.key)).toMatchObject({ name: 'My version 2', item_count: 2 });
  });
});

describe('template management (fix2)', () => {
  const list = async (who = admin) => (await body(await as(who).get('/templates'))).data as Json[];

  it('duplicates any template as an account template the duplicator can edit; viewers cannot', async () => {
    const builtin = (await list()).find((x) => !x.account)!;
    const res = await as(admin).post(`/templates/${builtin.key}/duplicate`, {});
    expect(res.status).toBe(201);
    const copy = await body(res);
    expect(copy).toMatchObject({ name: he('server.copyOf', { name: builtin.name }), account: true, can_edit: true });
    expect(copy.key).not.toBe(builtin.key);
    // The original stays in the list.
    expect((await list()).map((x) => x.key)).toEqual(expect.arrayContaining([builtin.key, copy.key]));
    const named = await body(await as(admin).post(`/templates/${copy.key}/duplicate`, { name: 'Second copy' }));
    expect(named).toMatchObject({ name: 'Second copy', account: true });
    // A board made from the copy works like one made from the original.
    const board = await as(admin).post('/boards', { name: 'From copy', workspace_id: wsId, template_key: named.key });
    expect(board.status).toBe(201);
    expect((await as(carol).post(`/templates/${builtin.key}/duplicate`, {})).status).toBe(403);
    expect((await as(admin).post('/templates/nope_nope/duplicate', {})).status).toBe(404);
  });

  it('admins list and restore removed built-in templates; saving over a template is recorded', async () => {
    const builtin = (await list()).find((x) => !x.account)!;
    await as(admin).del(`/templates/${builtin.key}`);
    const hidden = (await body(await as(admin).get('/templates/hidden'))).data as Json[];
    expect(hidden.map((x) => x.key)).toContain(builtin.key);
    expect((await as(carol).get('/templates/hidden')).status).toBe(403);
    expect((await as(carol).post(`/templates/${builtin.key}/restore`)).status).toBe(403);
    const restored = await as(admin).post(`/templates/${builtin.key}/restore`);
    expect(restored.status).toBe(200);
    expect((await list()).map((x) => x.key)).toContain(builtin.key);
    expect((await as(admin).post(`/templates/${builtin.key}/restore`)).status).toBe(404);

    const mine = await body(await as(admin).post(`/boards/${src.id}/save-as-template`, { name: 'Tracked' }));
    await as(admin).post(`/boards/${src.id}/save-as-template`, { name: 'Tracked 2', replace_key: mine.key });
    const events = await t.db
      .select({ type: activityLog.type, payload: activityLog.payload })
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'template.updated')));
    expect(events.map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ after: expect.objectContaining({ key: mine.key, name: 'Tracked 2' }) }),
    );
  });
});

describe("a template's working board (fix3)", () => {
  const list = async (who = admin) => (await body(await as(who).get('/templates'))).data as Json[];

  it('is hidden from every list, one per template per user, saved back over the template and then gone', async () => {
    const tpl = await body(await as(admin).post(`/boards/${src.id}/save-as-template`, { name: 'Drafted' }));
    const start = await as(admin).post(`/templates/${tpl.key}/draft`, { name: 'Drafted · edit' });
    expect(start.status).toBe(200);
    const { board_id: draftId } = await body(start);
    // The same draft again; listed on the template row.
    expect(await body(await as(admin).post(`/templates/${tpl.key}/draft`, {}))).toEqual({ board_id: draftId });
    expect((await list()).find((x) => x.key === tpl.key)!.draft_board_id).toBe(draftId);

    // Opens by id, carries the mark; not in the tree, search or favourites.
    const detail = await body(await as(admin).get(`/boards/${draftId}`));
    expect(detail.template_edit).toEqual({ key: tpl.key, name: 'Drafted', with_items: false });
    const tree = await body(await as(admin).get(`/workspaces/${wsId}/tree`));
    expect(tree.boards.map((b: Json) => b.id)).not.toContain(draftId);
    const found = await body(await as(admin).get(`/search?q=${encodeURIComponent('Drafted · edit')}`));
    expect(found.boards.map((b: Json) => b.id)).not.toContain(draftId);
    const favs = await body(await as(admin).put('/me/favorite-boards', { board_ids: [draftId] }));
    expect(favs.data).toEqual([]);

    // Not someone else's to save.
    expect((await as(carol).post(`/boards/${draftId}/template-draft/save`, {})).status).toBe(404);

    // A change on the working board goes back to the template.
    await as(admin).post(`/boards/${draftId}/columns`, { title: 'Added in draft', type: 'text' });
    const saved = await as(admin).post(`/boards/${draftId}/template-draft/save`, {});
    expect(saved.status).toBe(200);
    expect(await body(saved)).toMatchObject({ key: tpl.key, name: 'Drafted' });
    expect((await as(admin).get(`/boards/${draftId}`)).status).toBe(404);
    expect((await list()).find((x) => x.key === tpl.key)!.draft_board_id).toBeNull();
    const trash = await body(await as(admin).get('/trash'));
    expect(JSON.stringify(trash)).not.toContain(draftId);
    const fresh = await body(
      await as(admin).post('/boards', { name: 'From drafted', workspace_id: wsId, template_key: tpl.key }),
    );
    expect(fresh.columns.map((c: Json) => c.title)).toContain('Added in draft');
  });

  it('discarding leaves the template as it was; viewers cannot start one', async () => {
    const tpl = await body(await as(admin).post(`/boards/${src.id}/save-as-template`, { name: 'Discarded' }));
    const { board_id: draftId } = await body(await as(admin).post(`/templates/${tpl.key}/draft`, {}));
    await as(admin).post(`/boards/${draftId}/columns`, { title: 'Never saved', type: 'text' });
    expect((await as(admin).del(`/boards/${draftId}/template-draft`)).status).toBe(200);
    expect((await as(admin).get(`/boards/${draftId}`)).status).toBe(404);
    expect((await list()).find((x) => x.key === tpl.key)!.draft_board_id).toBeNull();
    const fresh = await body(
      await as(admin).post('/boards', { name: 'From discarded', workspace_id: wsId, template_key: tpl.key }),
    );
    expect(fresh.columns.map((c: Json) => c.title)).not.toContain('Never saved');
    expect((await as(carol).post(`/templates/${tpl.key}/draft`, {})).status).toBe(403);
    // A normal board has no draft to save or discard.
    expect((await as(admin).del(`/boards/${src.id}/template-draft`)).status).toBe(404);
  });
});
