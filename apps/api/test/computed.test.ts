// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** E4: relations (item_links), mirrors and formulas on the real Bines templates (invoices → accounts health). */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

let boards: Json[];
const board = (name: string) => boards.find((b) => b.name === name)!;

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'bines',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0];
  boards = (await body(await t.api(admin, acmeId).get(`/workspaces/${ws.id}/tree`))).boards;
});
afterAll(() => t.close());

const labelId = async (boardId: string, columnKey: string, label: string) => {
  const detail = await body(await t.api(admin, acmeId).get(`/boards/${boardId}`));
  return detail.columns.find((c: Json) => c.id === columnKey).settings.labels.find((l: Json) => l.label === label).id;
};

describe('formulas', () => {
  it('computes the invoice balance from its numbers', async () => {
    const inv = board('חשבוניות');
    const item = await body(
      await t.api(admin, acmeId).post(`/boards/${inv.id}/items`, {
        name: 'חשבונית 1001',
        cells: { numeric_mm6xh4pq: 1000, numeric_mm6xg399: 400 },
      }),
    );
    expect(item.cells.formula_mm6x9sy8).toEqual({ value: { result: 600 }, text: '600' });
    expect(item.cells.formula_mm6xhchq.text).toBe('0'); // not overdue
  });

  it('rejects formulas with unknown functions or columns', async () => {
    const inv = board('חשבוניות');
    const bad = await t.api(admin, acmeId).post(`/boards/${inv.id}/columns`, {
      title: 'x',
      type: 'formula',
      settings: { formula: '{nope}+1' },
    });
    expect(bad.status).toBe(400);
    const ok = await t.api(admin, acmeId).post(`/boards/${inv.id}/columns`, {
      title: 'כפול',
      type: 'formula',
      settings: { formula: '{numeric_mm6xh4pq}*2' },
    });
    expect(ok.status).toBe(201);
    const items = await body(await t.api(admin, acmeId).get(`/boards/${inv.id}/items`));
    expect(items.data[0].cells[(await body(ok)).id].text).toBe('2000');
  });
});

describe('relations and mirrors', () => {
  let invoiceId: string;
  let clientId: string;

  it('links a client to an invoice and mirrors the invoice balance', async () => {
    const inv = board('חשבוניות');
    const acc = board('לקוחות');
    invoiceId = (await body(await t.api(admin, acmeId).get(`/boards/${inv.id}/items`))).data[0].id;
    const client = await body(await t.api(admin, acmeId).post(`/boards/${acc.id}/items`, { name: 'לקוח א' }));
    clientId = client.id;
    expect(client.cells.formula_mm6x19ze.text).toBe('🟢 ירוק');

    const linked = await body(
      await t
        .api(admin, acmeId)
        .put(`/items/${clientId}/cells/board_relation_mm6xmz03`, { value: { item_ids: [invoiceId] } }),
    );
    expect(linked.cells.board_relation_mm6xmz03).toEqual({
      value: { item_ids: [invoiceId] },
      text: 'חשבונית 1001',
      names: ['חשבונית 1001'],
    });
    expect(linked.cells.lookup_mm6xec8j.text).toBe('600');
    expect(linked.cells.lookup_mm6xf1br.text).toBe('0');
  });

  it('turns client health red when a linked invoice becomes overdue (mirror of formula of status)', async () => {
    const inv = board('חשבוניות');
    const overdue = await labelId(inv.id, 'color_mm6x124z', 'באיחור');
    await t.api(admin, acmeId).put(`/items/${invoiceId}/cells/color_mm6x124z`, { value: { index: overdue } });
    const clients = await body(await t.api(admin, acmeId).get(`/boards/${board('לקוחות').id}/items`));
    const client = clients.data.find((i: Json) => i.id === clientId);
    expect(client.cells.lookup_mm6xf1br.text).toBe('600');
    expect(client.cells.formula_mm6x19ze.text).toBe('🔴 אדום');
  });

  it('only links items from the column’s boards', async () => {
    const leadsItem = await body(
      await t.api(admin, acmeId).post(`/boards/${board('לידים').id}/items`, { name: 'ליד' }),
    );
    const res = await t.api(admin, acmeId).put(`/items/${clientId}/cells/board_relation_mm6xmz03`, {
      value: { item_ids: [leadsItem.id] },
    });
    expect(res.status).toBe(422);
    const cleared = await body(await t.api(admin, acmeId).del(`/items/${clientId}/cells/board_relation_mm6xmz03`));
    expect(cleared.cells.board_relation_mm6xmz03).toBeUndefined();
    expect(cleared.cells.lookup_mm6xec8j).toBeUndefined();
  });

  it('finds items by name for the relation picker', async () => {
    const res = await body(await t.api(bob, acmeId).get(`/boards/${board('חשבוניות').id}/items/search?q=1001`));
    expect(res.data.map((i: Json) => i.name)).toEqual(['חשבונית 1001']);
  });
});

describe('mirrors never leak boards the reader cannot see', () => {
  it('a member sees the link and mirror only when the target board is readable', async () => {
    const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
    const secret = await body(
      await t.api(admin, acmeId).post('/boards', { name: 'סודי', workspace_id: ws, kind: 'private' }),
    );
    await t.api(admin, acmeId).post(`/boards/${secret.id}/columns`, { id: 'amount', title: 'סכום', type: 'numbers' });
    const secretItem = await body(
      await t.api(admin, acmeId).post(`/boards/${secret.id}/items`, { name: 'שכר', cells: { amount: 99999 } }),
    );

    const open = await body(await t.api(admin, acmeId).post('/boards', { name: 'פתוח', workspace_id: ws }));
    await t.api(admin, acmeId).post(`/boards/${open.id}/columns`, {
      id: 'rel',
      title: 'קישור',
      type: 'board_relation',
      settings: { board_ids: [secret.id], allow_multiple: true },
    });
    await t.api(admin, acmeId).post(`/boards/${open.id}/columns`, {
      id: 'mir',
      title: 'מראה',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'amount' },
    });
    const row = await body(
      await t
        .api(admin, acmeId)
        .post(`/boards/${open.id}/items`, { name: 'שורה', cells: { rel: { item_ids: [secretItem.id] } } }),
    );
    expect(row.cells.mir.text).toBe('99,999');

    const asBob = (await body(await t.api(bob, acmeId).get(`/boards/${open.id}/items`))).data[0];
    expect(asBob.cells.mir).toBeUndefined();
    expect(asBob.cells.rel).toBeUndefined();
    // And Bob cannot link to it either.
    expect(
      (await t.api(bob, acmeId).put(`/items/${row.id}/cells/rel`, { value: { item_ids: [secretItem.id] } })).status,
    ).toBe(422);
  });

  it('nor items hidden from the reader by view_items on a board they can read (05 §6)', async () => {
    const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
    const deals = await body(await t.api(admin, acmeId).post('/boards', { name: 'עסקאות', workspace_id: ws }));
    await t.api(admin, acmeId).post(`/boards/${deals.id}/columns`, { id: 'amount', title: 'סכום', type: 'numbers' });
    await t.api(admin, acmeId).put(`/boards/${deals.id}/permissions`, {
      view_items: { mode: 'assigned_or_created', column_ids: 'any_people' },
    });
    const hidden = await body(
      await t.api(admin, acmeId).post(`/boards/${deals.id}/items`, { name: 'עסקה סודית', cells: { amount: 777 } }),
    );
    const mine = await body(
      await t.api(bob, acmeId).post(`/boards/${deals.id}/items`, { name: 'עסקה שלי', cells: { amount: 5 } }),
    );

    const summary = await body(await t.api(admin, acmeId).post('/boards', { name: 'סיכום', workspace_id: ws }));
    await t.api(admin, acmeId).post(`/boards/${summary.id}/columns`, {
      id: 'rel',
      title: 'עסקאות',
      type: 'board_relation',
      settings: { board_ids: [deals.id], allow_multiple: true },
    });
    await t.api(admin, acmeId).post(`/boards/${summary.id}/columns`, {
      id: 'total',
      title: 'סה"כ',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'amount', aggregate: 'sum' },
    });
    const row = await body(
      await t.api(admin, acmeId).post(`/boards/${summary.id}/items`, {
        name: 'רבעון',
        cells: { rel: { item_ids: [hidden.id, mine.id] } },
      }),
    );
    expect(row.cells.total.text).toBe('782');

    const asBob = (await body(await t.api(bob, acmeId).get(`/boards/${summary.id}/items`))).data[0];
    expect(asBob.cells.total.text).toBe('5'); // only the deal Bob sees
    expect(asBob.cells.rel.value.item_ids).toEqual([mine.id]);
    expect(
      (await t.api(bob, acmeId).put(`/items/${row.id}/cells/rel`, { value: { item_ids: [hidden.id] } })).status,
    ).toBe(422);
  });
});
