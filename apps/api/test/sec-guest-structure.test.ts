// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * a guest changed a connect-boards column to link to a board they are not a guest in.
 * (1) A board's structure — its columns (add, settings, order, delete) and groups — is closed to guests (unless the
 * account's `guests_edit_structure` is on) and to viewers, through every path. (2) For everyone: a connect-boards
 * column links only to boards its editor reads — on create, on update, in a bulk edit, and a duplicate drops the rest.
 */
let t: TestContext;
let admin: string;
let bob: string; // a member
let vic: string; // an account viewer
let g1: string; // a guest
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Ids by name (boards, users, columns); `Json` so lookups are plain strings in the calls below. */
const id: Json = {};
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const relation = (board_ids: string[]) => ({ title: 'Linked', type: 'board_relation', settings: { board_ids } });
const guestsEditStructure = (on: boolean) =>
  as(admin).patch('/accounts/me', { settings: { permissions: { guests_edit_structure: on } } });

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await as(admin).post('/users/invite', { emails: ['vic@acme.test'], role: 'viewer' });
  vic = await join('vic@acme.test');
  await as(admin).post('/users/invite', { emails: ['g1@outside.test'], role: 'guest' });
  g1 = await join('g1@outside.test');
  for (const u of (await body(await as(admin).get('/users'))).data as Json[]) id[u.email.split('@')[0]] = u.user_id;

  id.ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  const board = async (cookie: string, name: string, kind: string) =>
    (await body(await as(cookie).post('/boards', { name, workspace_id: id.ws, kind }))).id as string;
  // Shared: a shareable board (edit everything) with the guest, the member and the viewer on it.
  id.shared = await board(admin, 'Shared', 'shareable');
  for (const u of [id.g1, id.bob, id.vic]) await as(admin).put(`/boards/${id.shared}/members/${u}`, {});
  // Main: every member reads it, the guest does not. Secret: the admin's private board. Bobs: bob's private board.
  id.main = await board(admin, 'Main', 'main');
  id.secret = await board(admin, 'Secret', 'private');
  id.bobs = await board(bob, 'Bobs', 'private');
  id.group = (await body(await as(admin).get(`/boards/${id.shared}`))).groups[0].id;
  id.text = (await body(await as(admin).post(`/boards/${id.shared}/columns`, { title: 'Notes', type: 'text' }))).id;
  id.rel = (await body(await as(admin).post(`/boards/${id.shared}/columns`, relation([id.shared])))).id;
});
afterAll(() => t.close());

const structureCalls = (cookie: string) => [
  as(cookie).post(`/boards/${id.shared}/columns`, { title: 'X', type: 'text' }),
  as(cookie).post(`/boards/${id.shared}/columns`, relation([id.shared])),
  as(cookie).patch(`/boards/${id.shared}/columns/${id.rel}`, { settings: { board_ids: [id.main] } }),
  as(cookie).patch(`/boards/${id.shared}/columns/${id.rel}`, { settings: { board_ids: [id.secret] } }),
  as(cookie).patch(`/boards/${id.shared}/columns/${id.text}`, { title: 'Renamed' }),
  as(cookie).post(`/boards/${id.shared}/columns/${id.text}/reorder`, { position: 'bottom' }),
  as(cookie).del(`/boards/${id.shared}/columns/${id.text}`),
  as(cookie).post(`/boards/${id.shared}/groups`, { title: 'New group' }),
  as(cookie).patch(`/boards/${id.shared}/groups/${id.group}`, { title: 'Renamed' }),
  as(cookie).patch(`/boards/${id.shared}`, { name: 'Renamed board' }),
];

describe('a guest and a viewer do not change a board structure', () => {
  it('a guest: every column / group / board change is refused, and the board says so; items still work', async () => {
    for (const res of await Promise.all(structureCalls(g1))) expect(res.status).toBe(403);
    const caps = (await body(await as(g1).get(`/boards/${id.shared}`))).capabilities as Json;
    for (const a of ['column.create', 'column.update', 'column.reorder', 'column.delete', 'group.create'])
      expect(caps[a]).toBe(false);
    expect(caps['item.create']).toBe(true);
    // The column still links where the admin set it.
    const col = ((await body(await as(admin).get(`/boards/${id.shared}`))).columns as Json[]).find(
      (c) => c.id === id.rel,
    )!;
    expect(col.settings.board_ids).toEqual([id.shared]);
    expect((await as(g1).post(`/boards/${id.shared}/items`, { name: 'from the guest' })).status).toBe(201);
  });

  it('a guest: a new column through a bulk edit / import is refused too', async () => {
    const res = await as(g1).post(`/boards/${id.shared}/items/bulk-edit`, {
      labels: [],
      tags: [],
      columns: [{ ref: '__new_1', ...relation([id.secret]) }],
      rows: [{ name: 'row', cells: {} }],
    });
    expect(res.status).toBe(403);
  });

  it('an account viewer: refused the same way', async () => {
    for (const res of await Promise.all(structureCalls(vic))) expect(res.status).toBe(403);
    const caps = (await body(await as(vic).get(`/boards/${id.shared}`))).capabilities as Json;
    expect(caps['column.update']).toBe(false);
  });

  it('the account switch lets guests change structure — but never link a board they cannot read', async () => {
    expect((await guestsEditStructure(true)).status).toBe(200);
    try {
      expect((await body(await as(g1).get(`/boards/${id.shared}`))).capabilities['column.update']).toBe(true);
      const add = await as(g1).post(`/boards/${id.shared}/columns`, { title: 'Guest col', type: 'text' });
      expect(add.status).toBe(201);
      // Main exists and every member reads it — not the guest.
      const bad = await as(g1).patch(`/boards/${id.shared}/columns/${id.rel}`, { settings: { board_ids: [id.main] } });
      expect(bad.status).toBe(400);
      expect((await body(bad)).error.details).toMatchObject({ reason: 'board_not_readable', board_ids: [id.main] });
      expect((await as(g1).post(`/boards/${id.shared}/columns`, relation([id.secret]))).status).toBe(400);
      // Board settings stay owner-only.
      expect((await as(g1).patch(`/boards/${id.shared}`, { name: 'Renamed board' })).status).toBe(403);
      await as(admin).del(`/boards/${id.shared}/columns/${(await body(add)).id}`);
    } finally {
      await guestsEditStructure(false);
    }
    expect((await as(g1).post(`/boards/${id.shared}/columns`, { title: 'Again', type: 'text' })).status).toBe(403);
  });
});

describe('a connect-boards column links only to boards its editor reads', () => {
  it('a member: a readable board yes; a private board they are not on, or an unknown id, no', async () => {
    const ok = await as(bob).post(`/boards/${id.shared}/columns`, relation([id.main, id.bobs]));
    expect(ok.status).toBe(201);
    for (const target of [id.secret, 'no_such_board']) {
      const res = await as(bob).post(`/boards/${id.shared}/columns`, relation([id.main, target]));
      expect(res.status).toBe(400);
      expect((await body(res)).error.details).toMatchObject({ reason: 'board_not_readable', board_ids: [target] });
    }
    const col = (await body(ok)).id;
    const upd = await as(bob).patch(`/boards/${id.shared}/columns/${col}`, {
      settings: { board_ids: [id.main, id.bobs, id.secret] },
    });
    expect(upd.status).toBe(400);
    expect((await as(admin).get(`/boards/${id.shared}`)).status).toBe(200);
  });

  it('a board already linked by someone who reads it stays when a member edits the column', async () => {
    const col = (await body(await as(admin).post(`/boards/${id.shared}/columns`, relation([id.secret])))).id;
    const res = await as(bob).patch(`/boards/${id.shared}/columns/${col}`, {
      title: 'Renamed',
      settings: { board_ids: [id.secret, id.main], allow_multiple: false },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.board_ids).toEqual([id.secret, id.main]);
  });

  it('an admin: any board they read; not a private board they are not subscribed to', async () => {
    expect((await as(admin).post(`/boards/${id.shared}/columns`, relation([id.secret, id.main]))).status).toBe(201);
    const res = await as(admin).post(`/boards/${id.shared}/columns`, relation([id.bobs]));
    expect(res.status).toBe(400);
  });

  it('a bulk edit / import adds a relation column only to readable boards', async () => {
    const edit = (board_ids: string[]) =>
      as(bob).post(`/boards/${id.bobs}/items/bulk-edit`, {
        labels: [],
        tags: [],
        columns: [{ ref: '__new_1', ...relation(board_ids) }],
        rows: [{ name: 'row', cells: {} }],
      });
    expect((await edit([id.secret])).status).toBe(400);
    expect((await edit([id.main])).status).toBe(200);
  });

  it('a duplicate keeps only the boards its maker reads', async () => {
    const src = (await body(await as(admin).post('/boards', { name: 'Hub', workspace_id: id.ws, kind: 'main' }))).id;
    await as(admin).post(`/boards/${src}/columns`, relation([id.secret, id.main, src]));
    const copy = await as(bob).post(`/boards/${src}/duplicate`, { mode: 'structure' });
    expect(copy.status).toBe(201);
    const copyId = (await body(copy)).id as string;
    const cols = (await body(await as(bob).get(`/boards/${copyId}`))).columns as Json[];
    // The self-link follows the copy; the private board bob does not read is dropped.
    expect(cols.find((c) => c.type === 'board_relation')!.settings.board_ids).toEqual([id.main, copyId]);
    // The admin's own copy keeps every board.
    const own = (await body(await as(admin).post(`/boards/${src}/duplicate`, { mode: 'structure' }))).id as string;
    const ownCols = (await body(await as(admin).get(`/boards/${own}`))).columns as Json[];
    expect(ownCols.find((c) => c.type === 'board_relation')!.settings.board_ids).toEqual([id.secret, id.main, own]);
  });
});
