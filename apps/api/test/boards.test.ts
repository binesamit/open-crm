// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Phase 1 slice: the Bines kit, structure CRUD, cells through the registry, board permissions, isolation. */
let t: TestContext;
let admin: string;
let bob: string; // member
let vera: string; // viewer
let acmeId: string;
let betaAdmin: string;
let betaId: string;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const res = await t.signUpWithPassword(email, token);
  const cookie = t.cookieFrom(res)!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const acme = await body(
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'bines',
    }),
  );
  acmeId = acme.account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  const beta = await body(
    await t.api(owner).post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
  );
  betaId = beta.account.id;
  betaAdmin = await join('admin@beta.test');
});
afterAll(() => t.close());

const tree = async (cookie: string) => {
  const ws = await body(await t.api(cookie, acmeId).get('/workspaces'));
  return body(await t.api(cookie, acmeId).get(`/workspaces/${ws.data[0].id}/tree`));
};
const boardByName = async (name: string) => (await tree(admin)).boards.find((b: Json) => b.name === name);

describe('Bines opening kit', () => {
  it('creates folders 01–07 and the 19 kit boards', async () => {
    const t1 = await tree(admin);
    // The kit names no workspace (M11 stage 3): the first one is named after the account.
    expect(t1.workspace.name).toBe('Acme');
    expect(t1.folders).toHaveLength(7);
    expect(t1.boards).toHaveLength(19);
    expect(t1.boards.every((b: Json) => b.folder_id)).toBe(true);
  });

  it('imports columns through the registry and wires relations between kit boards', async () => {
    const leads = (await tree(admin)).boards.find((b: Json) => b.item_terminology === 'item' && /ליד/.test(b.name));
    const detail = await body(await t.api(admin, acmeId).get(`/boards/${leads.id}`));
    expect(detail.columns[0]).toMatchObject({ id: 'name', type: 'name' });
    const status = detail.columns.find((c: Json) => c.type === 'status');
    expect(status.settings.labels.length).toBeGreaterThan(2);
    const contactRef = detail.columns.find((c: Json) => c.id === 'contact_ref');
    expect(contactRef.settings.board_ids).toHaveLength(1);
    expect(detail.groups.length).toBeGreaterThan(1);
  });

  it('numbers items with the template custom key (L-0001, L-0002)', async () => {
    const leads = (await tree(admin)).boards.find((b: Json) => /ליד/.test(b.name));
    const a = await body(await t.api(admin, acmeId).post(`/boards/${leads.id}/items`, { name: 'ליד ראשון' }));
    const b = await body(await t.api(admin, acmeId).post(`/boards/${leads.id}/items`, { name: 'ליד שני' }));
    expect([a.key, b.key]).toEqual(['L-0001', 'L-0002']);
    expect(a.cells.lead_key.text).toBe('L-0001');
  });
});

describe('boards, groups, columns, items, cells', () => {
  let boardId: string;
  let groupId: string;

  it('creates an empty board with one group and the name column; creator is owner', async () => {
    const ws = await body(await t.api(bob, acmeId).get('/workspaces'));
    const res = await t.api(bob, acmeId).post('/boards', { name: 'משימות שלי', workspace_id: ws.data[0].id });
    expect(res.status).toBe(201);
    const b = await body(res);
    boardId = b.id;
    groupId = b.groups[0].id;
    expect(b.columns.map((c: Json) => c.id)).toEqual(['name']);
    expect(b.capabilities['board.update']).toBe(true);
  });

  it('adds typed columns and writes validated cells with derived text', async () => {
    const api = t.api(bob, acmeId);
    expect((await api.post(`/boards/${boardId}/columns`, { title: 'סטטוס', type: 'status' })).status).toBe(201);
    expect(
      (
        await api.post(`/boards/${boardId}/columns`, {
          title: 'סכום',
          type: 'numbers',
          settings: { unit: { symbol: '₪', direction: 'left' } },
        })
      ).status,
    ).toBe(201);
    expect((await api.post(`/boards/${boardId}/columns`, { title: 'אחראי', type: 'people' })).status).toBe(201);
    expect((await api.post(`/boards/${boardId}/columns`, { title: 'X', type: 'nonsense' })).status).toBe(422);

    const item = await body(
      await api.post(`/boards/${boardId}/items`, { name: 'משימה', cells: { status: { index: 0 }, numbers: '250' } }),
    );
    expect(item.cells.status).toEqual({ value: { index: 0 }, text: 'בתהליך' });
    expect(item.cells.numbers).toEqual({ value: 250, text: '₪250' });

    const bobId = (await body(await api.get('/auth/me'))).user.id;
    const assigned = await body(
      await api.put(`/items/${item.id}/cells/people`, {
        value: { persons_and_teams: [{ id: bobId, kind: 'person' }] },
      }),
    );
    expect(assigned.cells.people.text).toBe('bob');

    expect((await api.put(`/items/${item.id}/cells/status`, { value: { index: 42 } })).status).toBe(422);
    expect(
      (
        await api.put(`/items/${item.id}/cells/people`, {
          value: { persons_and_teams: [{ id: '01J000000000000000000000ZZ', kind: 'person' }] },
        })
      ).status,
    ).toBe(422);
    const cleared = await body(await api.del(`/items/${item.id}/cells/numbers`));
    expect(cleared.cells.numbers).toBeUndefined();
  });

  it('edits labels: renames re-derive cells, used labels are deactivated, duplicates rejected (03 §2.5)', async () => {
    const api = t.api(bob, acmeId);
    const col = await body(await api.post(`/boards/${boardId}/columns`, { id: 'stage', title: 'שלב', type: 'status' }));
    const item = await body(
      await api.post(`/boards/${boardId}/items`, { name: 'תוויות', cells: { stage: { index: 1 } } }),
    );
    const labels = col.settings.labels as Json[];
    const used = labels.find((l) => l.id === 1)!;
    const unused = labels.find((l) => l.id !== 1)!;
    const kept = labels.filter((l) => l.id !== used.id && l.id !== unused.id);

    // Rename the used label and move it first; the cell's text follows.
    const renamed = { ...used, label: 'בבדיקה', color: 'blue', index: 0 };
    const res = await api.patch(`/boards/${boardId}/columns/stage`, {
      settings: { labels: [renamed, unused, ...kept].map((l, i) => ({ ...l, index: i })) },
    });
    expect(res.status).toBe(200);
    const items = await body(await api.get(`/boards/${boardId}/items`));
    expect(items.data.find((i: Json) => i.id === item.id).cells.stage.text).toBe('בבדיקה');

    // Removing both: the unused one disappears, the used one stays deactivated.
    const after = await body(await api.patch(`/boards/${boardId}/columns/stage`, { settings: { labels: kept } }));
    expect(after.settings.labels.find((l: Json) => l.id === unused.id)).toBeUndefined();
    expect(after.settings.labels.find((l: Json) => l.id === used.id)).toMatchObject({
      label: 'בבדיקה',
      is_deactivated: true,
    });
    expect((await api.put(`/items/${item.id}/cells/stage`, { value: { index: used.id } })).status).toBe(422);

    const dup = await api.patch(`/boards/${boardId}/columns/stage`, {
      settings: { labels: [kept[0], { ...kept[0], label: 'כפול' }] },
    });
    expect(dup.status).toBe(400);
  });

  it('dropdown labels can be added and removed; used ones are kept deactivated (03 §2.6)', async () => {
    const api = t.api(bob, acmeId);
    await api.post(`/boards/${boardId}/columns`, { id: 'tags_dd', title: 'תגיות', type: 'dropdown' });
    const added = await body(
      await api.patch(`/boards/${boardId}/columns/tags_dd`, {
        settings: {
          labels: [
            { id: 0, label: 'VIP' },
            { id: 1, label: 'חדש' },
          ],
        },
      }),
    );
    expect(added.settings.labels).toHaveLength(2);
    const item = await body(
      await api.post(`/boards/${boardId}/items`, { name: 'dd', cells: { tags_dd: { ids: [0, 1] } } }),
    );
    expect(item.cells.tags_dd.text).toBe('VIP, חדש');
    const removed = await body(
      await api.patch(`/boards/${boardId}/columns/tags_dd`, { settings: { labels: [{ id: 1, label: 'חדשים' }] } }),
    );
    expect(removed.settings.labels).toEqual([
      { id: 1, label: 'חדשים' },
      { id: 0, label: 'VIP', is_deactivated: true },
    ]);
    const items = await body(await api.get(`/boards/${boardId}/items`));
    expect(items.data.find((i: Json) => i.id === item.id).cells.tags_dd.text).toBe('VIP, חדשים');
  });

  it('inserts a column before or after another; the name column stays first (14 §4)', async () => {
    const api = t.api(bob, acmeId);
    const keys = async () => (await body(await api.get(`/boards/${boardId}`))).columns.map((c: Json) => c.id);
    const [, first] = await keys();
    await api.post(`/boards/${boardId}/columns`, {
      id: 'before_first',
      title: 'לפני',
      type: 'text',
      before_column_id: first,
    });
    await api.post(`/boards/${boardId}/columns`, {
      id: 'after_first',
      title: 'אחרי',
      type: 'text',
      after_column_id: first,
    });
    const order = await keys();
    expect(order.slice(0, 4)).toEqual(['name', 'before_first', first, 'after_first']);
    const bad = await api.post(`/boards/${boardId}/columns`, { title: 'x', type: 'text', before_column_id: 'name' });
    expect(bad.status).toBe(400);
  });

  it('suggests the existing values of a column, most used first (03 §2.2)', async () => {
    const api = t.api(bob, acmeId);
    await api.post(`/boards/${boardId}/columns`, { id: 'city', title: 'עיר', type: 'text' });
    for (const city of ['תל אביב', 'חיפה', 'תל אביב', '100%_off']) {
      await api.post(`/boards/${boardId}/items`, { name: city, cells: { city } });
    }
    const all = await body(await api.get(`/boards/${boardId}/columns/city/values`));
    expect(all.data[0]).toEqual({ value: 'תל אביב', count: 2 });
    expect(all.data).toHaveLength(3);
    const tel = await body(await api.get(`/boards/${boardId}/columns/city/values?q=${encodeURIComponent('תל')}`));
    expect(tel.data).toEqual([{ value: 'תל אביב', count: 2 }]);
    const literal = await body(await api.get(`/boards/${boardId}/columns/city/values?q=${encodeURIComponent('%_')}`));
    expect(literal.data.map((v: Json) => v.value)).toEqual(['100%_off']);
    expect((await api.get(`/boards/${boardId}/columns/nope/values`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).get(`/boards/${boardId}/columns/city/values`)).status).toBe(404);
  });

  it('saves the item card tabs per board (N19); viewers may not; bad tabs are rejected', async () => {
    const before = await body(await t.api(bob, acmeId).get(`/boards/${boardId}`));
    expect(before.card).toEqual({ tabs: [] });
    const card = {
      tabs: [
        { id: 'activity', type: 'activity', hidden: true },
        { id: 'fields', type: 'fields', title: 'פרטים', columns: ['name'] },
      ],
    };
    const res = await t.api(bob, acmeId).patch(`/boards/${boardId}`, { card });
    expect(res.status).toBe(200);
    expect((await body(res)).card.tabs[1]).toMatchObject({ id: 'fields', title: 'פרטים', columns: ['name'] });
    expect((await t.api(vera, acmeId).patch(`/boards/${boardId}`, { card })).status).toBe(403);
    const bad = await t.api(bob, acmeId).patch(`/boards/${boardId}`, { card: { tabs: [{ id: 'X', type: 'nope' }] } });
    expect(bad.status).toBe(400);
  });

  it('saves how the card shows subitems (cardsub): view, filter, sort, summaries; bad ones are rejected', async () => {
    const subitems = {
      in_fields: false,
      view_id: 'v1',
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [{ column_id: 'qty', operator: 'greater_than', values: [1] }],
      },
      sort: [{ column_id: 'qty', direction: 'desc' }],
      summaries: { qty: 'avg' },
    };
    const res = await t.api(bob, acmeId).patch(`/boards/${boardId}`, { card: { tabs: [], subitems } });
    expect(res.status).toBe(200);
    const saved = (await body(await t.api(bob, acmeId).get(`/boards/${boardId}`))).card.subitems;
    expect(saved).toMatchObject({ in_fields: false, view_id: 'v1', summaries: { qty: 'avg' }, show_summary: true });
    expect(saved.sort[0]).toMatchObject({ column_id: 'qty', direction: 'desc' });
    const bad = await t
      .api(bob, acmeId)
      .patch(`/boards/${boardId}`, { card: { tabs: [], subitems: { summaries: { qty: 'nope' } } } });
    expect(bad.status).toBe(400);
  });

  it('saves the card fields per row (r15); a bad value is rejected', async () => {
    const res = await t.api(bob, acmeId).patch(`/boards/${boardId}`, { card: { tabs: [], fields_per_row: 3 } });
    expect(res.status).toBe(200);
    expect((await body(await t.api(bob, acmeId).get(`/boards/${boardId}`))).card.fields_per_row).toBe(3);
    const auto = await t.api(bob, acmeId).patch(`/boards/${boardId}`, { card: { tabs: [], fields_per_row: 'auto' } });
    expect((await body(auto)).card.fields_per_row).toBe('auto');
    const bad = await t.api(bob, acmeId).patch(`/boards/${boardId}`, { card: { tabs: [], fields_per_row: 9 } });
    expect(bad.status).toBe(400);
  });

  it('a subitems board takes its own card settings, nothing else', async () => {
    const item = await body(await t.api(bob, acmeId).post(`/boards/${boardId}/items`, { name: 'with a subitem' }));
    await t.api(bob, acmeId).post(`/items/${item.id}/subitems`, { name: 'sub' });
    const subId = (await body(await t.api(bob, acmeId).get(`/boards/${boardId}`))).subitems_board_id as string;
    const res = await t.api(bob, acmeId).patch(`/boards/${subId}`, { card: { tabs: [], fields_per_row: 1 } });
    expect(res.status).toBe(200);
    expect((await body(await t.api(bob, acmeId).get(`/boards/${subId}`))).card.fields_per_row).toBe(1);
    const rename = await t.api(bob, acmeId).patch(`/boards/${subId}`, { name: 'x', card: { tabs: [] } });
    expect(rename.status).toBe(400);
    expect((await t.api(vera, acmeId).patch(`/boards/${subId}`, { card: { tabs: [] } })).status).toBe(403);
  });

  it('records every mutation in activity_log', async () => {
    const rows = await t.db.execute<{ type: string }>(sql`select type from activity_log where board_id = ${boardId}`);
    const types = rows.rows.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['board.created', 'column.created', 'item.created', 'cell.changed']));
  });

  it('never reuses a deleted column id and keeps the last group', async () => {
    const api = t.api(bob, acmeId);
    expect((await api.del(`/boards/${boardId}/columns/numbers`)).status).toBe(200);
    expect(
      (await api.post(`/boards/${boardId}/columns`, { id: 'numbers', title: 'שוב', type: 'numbers' })).status,
    ).toBe(409);
    expect((await api.del(`/boards/${boardId}/groups/${groupId}`)).status).toBe(409);
    const g2 = await body(await api.post(`/boards/${boardId}/groups`, { title: 'הושלמו' }));
    const items = await body(await api.get(`/boards/${boardId}/items`));
    const moved = await body(await api.post(`/items/${items.data[0].id}/move-to-group`, { group_id: g2.id }));
    expect(moved.group_id).toBe(g2.id);
  });

  it('read-only columns reject writes', async () => {
    const leads = (await tree(admin)).boards.find((b: Json) => /ליד/.test(b.name));
    const detail = await body(await t.api(admin, acmeId).get(`/boards/${leads.id}`));
    const formula = detail.columns.find((c: Json) => c.type === 'formula' || c.type === 'item_id');
    const items = await body(await t.api(admin, acmeId).get(`/boards/${leads.id}/items`));
    const res = await t
      .api(admin, acmeId)
      .put(`/items/${items.data[0].id}/cells/${formula.id}`, { value: { result: 1 } });
    expect(res.status).toBe(422);
    expect(await body(res)).toMatchObject({ error: { code: 'column_read_only' } });
  });
});

describe('sidebar structure (14 §6–8)', () => {
  it('moves a board between folders and to the root; rejects a folder of another workspace', async () => {
    const api = t.api(admin, acmeId);
    const ws = (await body(await api.get('/workspaces'))).data[0];
    const f = await body(await api.post('/folders', { workspace_id: ws.id, name: 'יעד' }));
    const b = await body(await api.post('/boards', { name: 'להעברה', workspace_id: ws.id }));
    expect((await api.patch(`/boards/${b.id}`, { folder_id: f.id })).status).toBe(200);
    expect((await tree(admin)).boards.find((x: Json) => x.id === b.id).folder_id).toBe(f.id);
    expect((await api.patch(`/boards/${b.id}`, { folder_id: null })).status).toBe(200);
    expect((await tree(admin)).boards.find((x: Json) => x.id === b.id).folder_id).toBeNull();

    const other = await body(await api.post('/workspaces', { name: 'אחר' }));
    const foreign = await body(await api.post('/folders', { workspace_id: other.id, name: 'זר' }));
    expect((await api.patch(`/boards/${b.id}`, { folder_id: foreign.id })).status).toBe(404);
  });

  it('reorders boards by position, within a folder and into another folder (fix3); viewers cannot', async () => {
    const api = t.api(admin, acmeId);
    const ws = (await body(await api.get('/workspaces'))).data[0];
    const f = await body(await api.post('/folders', { workspace_id: ws.id, name: 'סדר' }));
    const g = await body(await api.post('/folders', { workspace_id: ws.id, name: 'סדר 2' }));
    const mk = async (name: string, folder: string) =>
      body(await api.post('/boards', { name, workspace_id: ws.id, folder_id: folder }));
    const a = await mk('A', f.id);
    const b = await mk('B', f.id);
    const c = await mk('C', f.id);
    const x = await mk('X', g.id);
    const order = async (folder: string) =>
      (await tree(admin)).boards.filter((y: Json) => y.folder_id === folder).map((y: Json) => y.name);
    expect(await order(f.id)).toEqual(['A', 'B', 'C']);
    expect((await api.patch(`/boards/${c.id}`, { position: { before_id: a.id } })).status).toBe(200);
    expect(await order(f.id)).toEqual(['C', 'A', 'B']);
    expect((await api.patch(`/boards/${c.id}`, { position: { after_id: a.id } })).status).toBe(200);
    expect(await order(f.id)).toEqual(['A', 'C', 'B']);
    // Into another folder, at a place among its boards.
    expect((await api.patch(`/boards/${b.id}`, { folder_id: g.id, position: { before_id: x.id } })).status).toBe(200);
    expect(await order(f.id)).toEqual(['A', 'C']);
    expect(await order(g.id)).toEqual(['B', 'X']);
    // The anchor must be a board of that folder.
    expect((await api.patch(`/boards/${a.id}`, { position: { after_id: x.id } })).status).toBe(400);
    expect((await t.api(vera, acmeId).patch(`/boards/${a.id}`, { position: 'top' })).status).toBe(403);
  });

  it('deleting a folder moves its boards (also from sub-folders) to the root', async () => {
    const api = t.api(admin, acmeId);
    const ws = (await body(await api.get('/workspaces'))).data[0];
    const f = await body(await api.post('/folders', { workspace_id: ws.id, name: 'זמני' }));
    const sub = await body(await api.post('/folders', { workspace_id: ws.id, name: 'תת', parent_folder_id: f.id }));
    const b1 = await body(await api.post('/boards', { name: 'בתיקייה', workspace_id: ws.id, folder_id: f.id }));
    const b2 = await body(await api.post('/boards', { name: 'בתת', workspace_id: ws.id, folder_id: sub.id }));
    expect((await api.del(`/folders/${f.id}`)).status).toBe(200);
    const after = await tree(admin);
    expect(after.folders.map((x: Json) => x.id)).not.toContain(f.id);
    expect(after.folders.map((x: Json) => x.id)).not.toContain(sub.id);
    for (const id of [b1.id, b2.id]) expect(after.boards.find((x: Json) => x.id === id).folder_id).toBeNull();
  });

  it('the tree tells each viewer what they may do', async () => {
    const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0];
    const f = await body(await t.api(admin, acmeId).post('/folders', { workspace_id: ws.id, name: 'של המנהל' }));
    const asAdmin = await tree(admin);
    expect(asAdmin.workspace).toMatchObject({ can_edit: true, can_delete: true, can_create: true });
    expect(asAdmin.folders.find((x: Json) => x.id === f.id).can_edit).toBe(true);
    const asBob = await tree(bob);
    expect(asBob.workspace).toMatchObject({ can_delete: false, can_create: true });
    expect(asBob.folders.find((x: Json) => x.id === f.id).can_edit).toBe(false);
    const asVera = await tree(vera);
    expect(asVera.workspace.can_create).toBe(false);
    expect(asVera.boards.every((b: Json) => !b.can_update && !b.can_delete)).toBe(true);
  });

  it('renames workspaces; deletes only empty ones and never the last', async () => {
    const api = t.api(admin, acmeId);
    const ws = await body(await api.post('/workspaces', { name: 'לניסוי' }));
    const renamed = await body(await api.patch(`/workspaces/${ws.id}`, { name: 'שם חדש' }));
    expect(renamed.name).toBe('שם חדש');
    expect((await t.api(bob, acmeId).patch(`/workspaces/${ws.id}`, { name: 'x' })).status).toBe(403);

    // The workspace page: a description, cleared by an empty text; the tree carries it.
    expect(ws.description).toBeNull();
    const described = await body(await api.patch(`/workspaces/${ws.id}`, { description: ' מרחב לניסויים ' }));
    expect(described.description).toBe('מרחב לניסויים');
    expect((await body(await api.get(`/workspaces/${ws.id}/tree`))).workspace.description).toBe('מרחב לניסויים');
    expect((await body(await api.patch(`/workspaces/${ws.id}`, { description: '' }))).description).toBeNull();
    expect((await t.api(bob, acmeId).patch(`/workspaces/${ws.id}`, { description: 'x' })).status).toBe(403);

    const b = await body(await api.post('/boards', { name: 'חוסם', workspace_id: ws.id }));
    expect((await api.del(`/workspaces/${ws.id}`)).status).toBe(409);
    await api.del(`/boards/${b.id}`);
    expect((await t.api(bob, acmeId).del(`/workspaces/${ws.id}`)).status).toBe(403);
    expect((await api.del(`/workspaces/${ws.id}`)).status).toBe(200);
    expect((await body(await api.get('/workspaces'))).data.map((w: Json) => w.id)).not.toContain(ws.id);

    // Beta has a single workspace: it stays.
    const only = (await body(await t.api(betaAdmin, betaId).get('/workspaces'))).data[0];
    const last = await t.api(betaAdmin, betaId).del(`/workspaces/${only.id}`);
    expect(last.status).toBe(409);
    expect((await body(last)).error.code).toBe('last_workspace');
  });
});

describe('board permissions (05 §4–5)', () => {
  it('viewers read but never write', async () => {
    const leads = await boardByName((await tree(admin)).boards.find((b: Json) => /ליד/.test(b.name)).name);
    expect((await t.api(vera, acmeId).get(`/boards/${leads.id}/items`)).status).toBe(200);
    expect((await t.api(vera, acmeId).post(`/boards/${leads.id}/items`, { name: 'x' })).status).toBe(403);
    expect(
      (await t.api(vera, acmeId).post('/boards', { name: 'x', workspace_id: (await tree(vera)).workspace.id })).status,
    ).toBe(403);
  });

  it('the permission set limits members; owners and admins are unaffected', async () => {
    const ws = (await tree(admin)).workspace.id;
    const board = await body(await t.api(admin, acmeId).post('/boards', { name: 'רק צפייה', workspace_id: ws }));
    expect((await t.api(bob, acmeId).post(`/boards/${board.id}/items`, { name: 'ok' })).status).toBe(201);
    expect((await t.api(bob, acmeId).patch(`/boards/${board.id}`, { permission_set: 'view_comment' })).status).toBe(
      403,
    );
    expect((await t.api(admin, acmeId).patch(`/boards/${board.id}`, { permission_set: 'view_comment' })).status).toBe(
      200,
    );
    expect((await t.api(bob, acmeId).post(`/boards/${board.id}/items`, { name: 'no' })).status).toBe(403);
    expect((await t.api(admin, acmeId).post(`/boards/${board.id}/items`, { name: 'yes' })).status).toBe(201);
  });

  it('private boards are invisible to non-subscribers (404, not in the tree)', async () => {
    const ws = (await tree(admin)).workspace.id;
    const priv = await body(
      await t.api(admin, acmeId).post('/boards', { name: 'פרטי', workspace_id: ws, kind: 'private' }),
    );
    expect((await t.api(bob, acmeId).get(`/boards/${priv.id}`)).status).toBe(404);
    expect((await tree(bob)).boards.some((b: Json) => b.id === priv.id)).toBe(false);
    expect((await tree(admin)).boards.some((b: Json) => b.id === priv.id)).toBe(true);
  });

  it('owner-only columns from the template reject member edits', async () => {
    const leads = (await tree(admin)).boards.find((b: Json) => /ליד/.test(b.name));
    // `restricted_edit` is per viewer: locked for bob, not for the admin.
    const detail = await body(await t.api(bob, acmeId).get(`/boards/${leads.id}`));
    const restricted = detail.columns.find((c: Json) => c.restricted_edit && c.type === 'numbers');
    const forAdmin = (await body(await t.api(admin, acmeId).get(`/boards/${leads.id}`))).columns;
    expect(forAdmin.find((c: Json) => c.id === restricted.id).restricted_edit).toBe(false);
    const item = (await body(await t.api(admin, acmeId).get(`/boards/${leads.id}/items`))).data[0];
    expect((await t.api(bob, acmeId).put(`/items/${item.id}/cells/${restricted.id}`, { value: 5 })).status).toBe(403);
    expect((await t.api(admin, acmeId).put(`/items/${item.id}/cells/${restricted.id}`, { value: 5 })).status).toBe(200);
  });
});

describe('cross-account isolation for boards and items (D12)', () => {
  it('ids from another account answer 404', async () => {
    const leads = (await tree(admin)).boards.find((b: Json) => /ליד/.test(b.name));
    const item = (await body(await t.api(admin, acmeId).get(`/boards/${leads.id}/items`))).data[0];
    expect((await t.api(betaAdmin, betaId).get(`/boards/${leads.id}`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).get(`/boards/${leads.id}/items`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).patch(`/items/${item.id}`, { name: 'pwned' })).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).put(`/items/${item.id}/cells/status`, { value: { index: 0 } })).status).toBe(
      404,
    );
    expect((await t.api(betaAdmin, betaId).del(`/items/${item.id}`)).status).toBe(404);
  });

  it('an empty account gets an empty workspace', async () => {
    const ws = await body(await t.api(betaAdmin, betaId).get('/workspaces'));
    const tr = await body(await t.api(betaAdmin, betaId).get(`/workspaces/${ws.data[0].id}/tree`));
    expect(tr.folders).toEqual([]);
    expect(tr.boards).toEqual([]);
  });
});
