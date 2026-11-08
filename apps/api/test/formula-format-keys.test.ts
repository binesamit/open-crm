// SPDX-License-Identifier: AGPL-3.0-only
import { dateInZone } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * W2: formulas formatted like numbers (unit, decimals, 1,000s) and mirrors of them;
 * TODAY() in the account's timezone; item numbers without a prefix, their sequence and the next number.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let ws: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const newBoard = async (name: string) => body(await as(admin).post('/boards', { name, workspace_id: ws }));
const col = async (board: Json, payload: Json) => body(await as(admin).post(`/boards/${board.id}/columns`, payload));
const item = async (board: Json, name: string, cells?: Json) =>
  body(await as(admin).post(`/boards/${board.id}/items`, { name, ...(cells ? { cells } : {}) }));
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));

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
  ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('formula number format', () => {
  let orders: Json;
  let clients: Json;
  let total: Json;
  let orderId: string;

  it('shows a number result with the unit, fixed decimals and 1,000s; text results unchanged', async () => {
    orders = await newBoard('Orders');
    const qty = await col(orders, { title: 'Qty', type: 'numbers' });
    const price = await col(orders, { title: 'Price', type: 'numbers' });
    total = await col(orders, {
      title: 'Total',
      type: 'formula',
      settings: {
        formula: `{${qty.id}}*{${price.id}}`,
        unit: { symbol: '₪', direction: 'left' },
        precision: 2,
        thousands: true,
      },
    });
    const label = await col(orders, {
      title: 'Label',
      type: 'formula',
      settings: { formula: `IF({${qty.id}}>1,"many","one")`, precision: 2 },
    });
    const ratio = await col(orders, { title: 'Ratio', type: 'formula', settings: { formula: `{${qty.id}}/3` } });
    const o = await item(orders, 'Order 1', { [qty.id]: 2, [price.id]: 1000.5 });
    orderId = o.id;
    expect(o.cells[total.id]).toEqual({ value: { result: 2001 }, text: '₪2,001.00' });
    expect(o.cells[label.id].text).toBe('many');
    expect(o.cells[ratio.id].text).toBe('0.67'); // no format: 2 decimals at most, as before

    // A settings change applies on the next read (computed on read).
    await as(admin).patch(`/boards/${orders.id}/columns/${total.id}`, {
      settings: { ...total.settings, unit: { symbol: '%', direction: 'right' }, precision: 0, thousands: false },
    });
    expect((await getItem(orderId)).cells[total.id].text).toBe('2001%');
    await as(admin).patch(`/boards/${orders.id}/columns/${total.id}`, { settings: total.settings });
  });

  it('a mirror of the formula, and a mirror of that mirror, show the formula’s format', async () => {
    clients = await newBoard('Clients');
    const rel = await col(clients, { title: 'Orders', type: 'board_relation', settings: { board_ids: [orders.id] } });
    const sum = await col(clients, {
      title: 'Sum',
      type: 'mirror',
      settings: { relation_column_id: rel.id, source_column_id: total.id, aggregate: 'sum' },
    });
    const count = await col(clients, {
      title: 'Count',
      type: 'mirror',
      settings: { relation_column_id: rel.id, source_column_id: total.id, aggregate: 'count' },
    });
    const qty = (await body(await as(admin).get(`/boards/${orders.id}`))).columns.find((c: Json) => c.title === 'Qty');
    const second = await item(orders, 'Order 2', { [qty.id]: 1 });
    void second;
    const client = await item(clients, 'Client', { [rel.id]: { item_ids: [orderId, second.id] } });
    expect(client.cells[sum.id].text).toBe('₪2,001.00');
    expect(client.cells[count.id].text).toBe('2');

    const regions = await newBoard('Regions');
    const rel2 = await col(regions, {
      title: 'Clients',
      type: 'board_relation',
      settings: { board_ids: [clients.id] },
    });
    const deep = await col(regions, {
      title: 'Deep',
      type: 'mirror',
      settings: { relation_column_id: rel2.id, source_column_id: sum.id, aggregate: 'sum' },
    });
    const region = await item(regions, 'North', { [rel2.id]: { item_ids: [client.id] } });
    expect(region.cells[deep.id].text).toBe('₪2,001.00');
  });

  it('exports the formatted text', async () => {
    const res = await as(admin).post(`/boards/${orders.id}/export`, { format: 'csv' });
    expect(res.status).toBe(200);
    const csv = Buffer.from(await res.arrayBuffer()).toString('utf8');
    expect(csv).toContain('"₪2,001.00"');
  });
});

describe('TODAY() in the account timezone', () => {
  const zone = async (timezone: string) =>
    expect((await as(admin).patch('/accounts/me', { settings: { locale: { timezone } } })).status).toBe(200);

  it('is the date in the account’s zone, whatever the reader’s own zone', async () => {
    const b = await newBoard('Today');
    const today = await col(b, { title: 'Today', type: 'formula', settings: { formula: 'TODAY()' } });
    const it1 = await item(b, 'x');
    // UTC+14 and UTC-11: at any moment at least one of them is on another date than UTC.
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Jerusalem']) {
      await zone(tz);
      const before = dateInZone(new Date(), tz);
      const text = (await getItem(it1.id)).cells[today.id].text;
      const after = dateInZone(new Date(), tz);
      expect([before, after]).toContain(text);
    }
    // The reader's own zone does not change a formula (everyone sees the same value).
    expect((await as(admin).patch('/users/me', { timezone: 'Pacific/Kiritimati' })).status).toBe(200);
    const text = (await getItem(it1.id)).cells[today.id].text;
    expect([
      dateInZone(new Date(Date.now() - 5000), 'Asia/Jerusalem'),
      dateInZone(new Date(), 'Asia/Jerusalem'),
    ]).toContain(text);
    await as(admin).patch('/users/me', { timezone: 'Asia/Jerusalem' });
  });
});

describe('item numbers', () => {
  const seq = async (board: Json, key: string) =>
    body(await as(admin).get(`/boards/${board.id}/columns/${key}/sequence`));

  it('a new item-number column numbers the existing items 1, 2, … and new items continue', async () => {
    const b = await newBoard('Numbered');
    const first = await item(b, 'first');
    const second = await item(b, 'second');
    const num = await col(b, { title: '#', type: 'item_id' });
    expect(num.settings).toEqual({ display: 'custom_key', prefix: '', padding: 1 });
    expect((await getItem(first.id)).cells[num.id].text).toBe('1');
    expect((await getItem(second.id)).cells[num.id].text).toBe('2');
    const third = await item(b, 'third');
    expect(third.cells[num.id].text).toBe('3');
    expect(third.key).toBe('3');
    expect((await seq(b, num.id)).sequence).toEqual({ prefix: '', padding: 1, next_seq: 4, max_seq: 3 });

    // Continue from another system: the next item is 324.
    const low = await as(admin).put(`/boards/${b.id}/columns/${num.id}/sequence`, { next_seq: 3 });
    expect(low.status).toBe(400);
    const set = await body(await as(admin).put(`/boards/${b.id}/columns/${num.id}/sequence`, { next_seq: 324 }));
    expect(set.sequence.next_seq).toBe(324);
    expect((await item(b, 'fourth')).cells[num.id].text).toBe('324');

    // The board list shows the same numbers.
    const list = await body(await as(admin).get(`/boards/${b.id}/items`));
    expect((list.data as Json[]).map((i) => i.cells[num.id].text).sort()).toEqual(['1', '2', '3', '324']);
  });

  it('an empty prefix on many boards; a prefix stays unique per account; padding', async () => {
    const one = await newBoard('One');
    const two = await newBoard('Two');
    const n1 = await col(one, { title: '#', type: 'item_id' });
    const n2 = await col(two, { title: '#', type: 'item_id' });
    expect((await item(one, 'a')).cells[n1.id].text).toBe('1');
    expect((await item(two, 'b')).cells[n2.id].text).toBe('1');

    const prj = await as(admin).patch(`/boards/${one.id}/columns/${n1.id}`, {
      settings: { display: 'custom_key', prefix: 'PRJ-', padding: 3 },
    });
    expect(prj.status).toBe(200);
    expect((await item(one, 'c')).cells[n1.id].text).toBe('PRJ-002');
    const taken = await as(admin).patch(`/boards/${two.id}/columns/${n2.id}`, {
      settings: { display: 'custom_key', prefix: 'PRJ-', padding: 3 },
    });
    expect(taken.status).toBe(409);
    // A third board with a template-like prefix column via the API (custom key at creation).
    const three = await newBoard('Three');
    const n3 = await col(three, {
      title: 'ID',
      type: 'item_id',
      settings: { display: 'custom_key', prefix: 'T', padding: 4 },
    });
    expect((await item(three, 'd')).cells[n3.id].text).toBe('T0001');
  });

  it('a moved item takes the target board’s next number (and gets its own back on undo)', async () => {
    const from = await newBoard('From');
    const to = await newBoard('To');
    const nf = await col(from, { title: '#', type: 'item_id' });
    const nt = await col(to, { title: '#', type: 'item_id' });
    await item(to, 'there');
    const moving = await item(from, 'moving');
    expect(moving.cells[nf.id].text).toBe('1');
    const res = await as(admin).post(`/items/${moving.id}/move-to-board`, { board_id: to.id, mapping: {} });
    expect(res.status).toBe(200);
    const moved = await getItem(moving.id);
    expect(moved.cells[nt.id].text).toBe('2');
    expect((await as(admin).post(`/activity/${(await body(res)).event_id}/undo`, {})).status).toBe(200);
    expect((await getItem(moving.id)).cells[nf.id].text).toBe('1');
  });
});
