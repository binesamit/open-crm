// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 15-VIEWS §10: default table, shared/private views, locking, If-Match, personal prefs, last view. */
let t: TestContext;
let admin: string;
let bob: string; // member — editor on a main board
let carol: string; // account viewer — read-only
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0];
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Views', workspace_id: ws.id }))).id;
});
afterAll(() => t.close());

const views = async (cookie: string) => body(await t.api(cookie, acmeId).get(`/boards/${boardId}/views`));
const sortByName = { query: { sort: [{ column_id: 'name', direction: 'asc' }] } };

describe('default table', () => {
  it('every board has one, created on first open, default and undeletable', async () => {
    const first = await views(admin);
    expect(first.data).toHaveLength(1);
    const main = first.data[0];
    expect(main).toMatchObject({ name: 'טבלה', type: 'table', is_system: true, is_default: true, revision: 1 });
    expect(main.settings).toMatchObject({ hidden_columns: [], query: { sort: [], scope: 'all' } });
    expect(first.current_view_id).toBe(main.id);
    expect((await views(bob)).data.map((v: Json) => v.id)).toEqual([main.id]); // no second default table
    const del = await t.api(admin, acmeId).del(`/views/${main.id}`);
    expect(del.status).toBe(400);
  });
});

describe('shared and private views', () => {
  it('editors create shared views; viewers only private ones, invisible to others', async () => {
    const shared = await t.api(bob, acmeId).post(`/boards/${boardId}/views`, { name: 'Bob', settings: sortByName });
    expect(shared.status).toBe(201);
    expect(await body(shared)).toMatchObject({ visibility: 'shared', can_save: true, settings: sortByName });

    expect((await t.api(carol, acmeId).post(`/boards/${boardId}/views`, { name: 'Carol' })).status).toBe(403);
    const mine = await body(
      await t.api(carol, acmeId).post(`/boards/${boardId}/views`, { name: 'Mine', visibility: 'private' }),
    );
    expect(mine).toMatchObject({ visibility: 'private', can_save: true, can_delete: true });
    expect((await views(admin)).data.map((v: Json) => v.name)).not.toContain('Mine');
    expect((await views(carol)).data.map((v: Json) => v.name)).toContain('Mine');
    expect((await t.api(admin, acmeId).patch(`/views/${mine.id}`, { name: 'x' })).status).toBe(404);
    // A freshly created view is the one I land on next time.
    expect((await views(carol)).current_view_id).toBe(mine.id);
  });

  it('a viewer cannot save shared views (draft only)', async () => {
    const main = (await views(carol)).data.find((v: Json) => v.is_system);
    expect(main.can_save).toBe(false);
    const res = await t.api(carol, acmeId).patch(`/views/${main.id}`, { settings: sortByName });
    expect(res.status).toBe(403);
  });
});

describe('saving', () => {
  it('If-Match: the second of two saves on the same revision gets 409', async () => {
    const v = await body(await t.api(admin, acmeId).post(`/boards/${boardId}/views`, { name: 'Race' }));
    const save = (cookie: string, settings: Json) =>
      t.api(cookie, acmeId).call('PATCH', `/views/${v.id}`, { settings }, { 'if-match': String(v.revision) });
    const first = await save(admin, sortByName);
    expect(first.status).toBe(200);
    expect((await body(first)).revision).toBe(v.revision + 1);
    const second = await save(bob, { hidden_columns: ['x'] });
    expect(second.status).toBe(409);
    expect((await body(second)).error.code).toBe('revision_mismatch');
  });

  it('a locked view saves only for owners/admins; others may save as a new view', async () => {
    const v = await body(await t.api(bob, acmeId).post(`/boards/${boardId}/views`, { name: 'Lockme' }));
    expect((await t.api(bob, acmeId).patch(`/views/${v.id}`, { is_locked: true })).status).toBe(403);
    expect((await t.api(admin, acmeId).patch(`/views/${v.id}`, { is_locked: true })).status).toBe(200);
    const asBob = (await views(bob)).data.find((x: Json) => x.id === v.id);
    expect(asBob).toMatchObject({ is_locked: true, can_save: false });
    const denied = await t.api(bob, acmeId).patch(`/views/${v.id}`, { settings: sortByName });
    expect(denied.status).toBe(403);
    expect((await body(denied)).error.message).toBe('view_locked');
    expect((await t.api(admin, acmeId).patch(`/views/${v.id}`, { settings: sortByName })).status).toBe(200);
  });

  it('the default table is fixed: no one saves settings on it (changes become a new view)', async () => {
    const main = (await views(admin)).data.find((x: Json) => x.is_system);
    expect(main.can_save).toBe(false);
    const res = await t.api(admin, acmeId).patch(`/views/${main.id}`, { settings: sortByName });
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('main_table_is_fixed');
    // Its name stays editable for those who manage views.
    expect((await t.api(admin, acmeId).patch(`/views/${main.id}`, { name: 'ראשית' })).status).toBe(200);
  });

  it('personal prefs never touch the view or its revision', async () => {
    const v = (await views(bob)).data.find((x: Json) => x.is_system);
    const res = await body(
      await t.api(bob, acmeId).put(`/views/${v.id}/prefs`, { column_widths: { status: 220 }, wrap_text: true }),
    );
    expect(res).toMatchObject({ revision: v.revision, prefs: { column_widths: { status: 220 }, wrap_text: true } });
    const merged = await body(await t.api(bob, acmeId).put(`/views/${v.id}/prefs`, { collapsed_groups: ['g'] }));
    expect(merged.prefs).toEqual({ column_widths: { status: 220 }, wrap_text: true, collapsed_groups: ['g'] });
    // Admin sees no prefs of Bob's.
    expect((await views(admin)).data.find((x: Json) => x.id === v.id).prefs).toEqual({});
    expect((await body(await t.api(bob, acmeId).del(`/views/${v.id}/prefs`))).prefs).toEqual({});
  });
});

describe('managing', () => {
  it('default view, duplicate, delete, last opened', async () => {
    const v = await body(await t.api(admin, acmeId).post(`/boards/${boardId}/views`, { name: 'Default me' }));
    expect((await t.api(admin, acmeId).patch(`/views/${v.id}`, { is_default: true })).status).toBe(200);
    const list = (await views(admin)).data;
    expect(list.filter((x: Json) => x.is_default).map((x: Json) => x.id)).toEqual([v.id]);

    const copy = await body(await t.api(bob, acmeId).post(`/views/${v.id}/duplicate`, {}));
    expect(copy).toMatchObject({ name: 'עותק של Default me', visibility: 'shared' });

    const main = list.find((x: Json) => x.is_system);
    await t.api(bob, acmeId).post(`/views/${main.id}/open`);
    expect((await views(bob)).current_view_id).toBe(main.id);

    expect((await t.api(admin, acmeId).del(`/views/${v.id}`)).status).toBe(200);
    const after = (await views(admin)).data;
    expect(after.map((x: Json) => x.id)).not.toContain(v.id);
    expect(after.find((x: Json) => x.is_default).id).toBe(main.id); // default falls back to the default table
  });

  it('views of another account are 404', async () => {
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const other = (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: 'Other',
          slug: 'other',
          first_admin_email: 'admin@other.test',
          template_set: 'empty',
        }),
      )
    ).account.id;
    const otherAdmin = await join('admin@other.test');
    const main = (await views(admin)).data.find((x: Json) => x.is_system);
    expect((await t.api(otherAdmin, other).get(`/boards/${boardId}/views`)).status).toBe(404);
    expect((await t.api(otherAdmin, other).patch(`/views/${main.id}`, { name: 'x' })).status).toBe(404);
  });
});

describe('my tab layout (pins + order)', () => {
  it('pinned views come first in my order; nobody else is affected', async () => {
    const list = (await views(admin)).data as Json[];
    const ids = list.map((v) => v.id);
    const [a, b, c] = ids.slice(-3);
    const res = await t.api(admin, acmeId).put(`/boards/${boardId}/views/layout`, {
      pinned: [c, a],
      order: [c, a, ...ids.filter((x) => x !== a && x !== c)],
    });
    expect(res.status).toBe(200);
    const mine = await body(res);
    expect(mine.data.slice(0, 2).map((v: Json) => v.id)).toEqual([c, a]);
    expect(mine.data.slice(0, 2).every((v: Json) => v.pinned)).toBe(true);
    expect(mine.data.slice(2).some((v: Json) => v.pinned)).toBe(false);
    expect(mine.layout).toMatchObject({ pinned: [c, a] });
    // Pins win over order: a pinned view listed last still comes first.
    const reordered = await body(
      await t.api(admin, acmeId).put(`/boards/${boardId}/views/layout`, { pinned: [a], order: [b, c, a] }),
    );
    expect(reordered.data[0].id).toBe(a);
    expect(reordered.data.map((v: Json) => v.id).indexOf(b)).toBeLessThan(
      reordered.data.map((v: Json) => v.id).indexOf(c),
    );
    // Bob's tabs are unchanged and unpinned.
    const bobs = (await views(bob)).data as Json[];
    expect(bobs.some((v) => v.pinned)).toBe(false);
    // A viewer arranges their own tabs too; unknown ids are dropped.
    const carols = await t
      .api(carol, acmeId)
      .put(`/boards/${boardId}/views/layout`, { pinned: ['nope', b], order: [] });
    expect(carols.status).toBe(200);
    expect((await body(carols)).layout.pinned).toEqual([b]);
  });
});

describe('copy a view to another board (15 §9)', () => {
  it('maps columns by key/title and type, drops the rest', async () => {
    const api = t.api(admin, acmeId);
    const ws = (await body(await api.get('/workspaces'))).data[0];
    const from = (await body(await api.post('/boards', { name: 'From', workspace_id: ws.id }))).id;
    const to = (await body(await api.post('/boards', { name: 'To', workspace_id: ws.id }))).id;
    const stage = await body(await api.post(`/boards/${from}/columns`, { title: 'Stage', type: 'status' }));
    const extra = await body(await api.post(`/boards/${from}/columns`, { title: 'Only here', type: 'numbers' }));
    const target = await body(await api.post(`/boards/${to}/columns`, { id: 'phase', title: 'stage', type: 'status' }));
    const view = await body(
      await api.post(`/boards/${from}/views`, {
        type: 'table',
        name: 'Board view',
        settings: {
          query: {
            filter: {
              kind: 'group',
              operator: 'and',
              rules: [
                { column_id: stage.id, operator: 'is_not_empty' },
                { column_id: extra.id, operator: 'is_empty' },
              ],
            },
            sort: [{ column_id: extra.id, direction: 'asc' }],
          },
          hidden_columns: [extra.id],
        },
      }),
    );
    const res = await api.post(`/views/${view.id}/duplicate`, { board_id: to });
    expect(res.status).toBe(201);
    const copy = await body(res);
    expect(copy).toMatchObject({ board_id: to, name: 'Board view' });
    expect(copy.settings.query.filter.rules.map((r: Json) => r.column_id)).toEqual([target.id]);
    expect(copy.settings.query.sort).toEqual([]);
    expect(copy.settings.hidden_columns).toEqual([]);
  });
});
