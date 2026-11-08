// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellsFromValues, rulesToFilter, type IntegrationColumn } from '@bines/shared';
import { activityLog } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * What lets the Make app run without custom IML functions: plain `values` converted on the server
 * `?format=flat` items (`column_values` by title), the column-values form (`GET /boards/{id}/fields`), flat query
 * `rules`, a move without a mapping, and `flat` webhook subscriptions (`deliveryId` + `item.column_values`).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Hit = { path: string; headers: Record<string, string>; raw: string; body: Json };

let server: Server;
let base: string;
const hits: Hit[] = [];
let t: TestContext;
let acmeId: string;
let admin: string;
let token: string;
let boardId: string;
let otherBoardId: string;
let statusKey: string;
let peopleKey: string;
let dateKey: string;
let checkKey: string;
let adminId: string;
let labels: { id: number; label: string }[];

const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const call = (method: string, path: string, payload?: unknown) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

const seen = new Set<string>();
const drain = async () => {
  for (let round = 0; round < 10; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) return;
    for (const r of fresh) {
      seen.add(r.id);
      for (const run of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, run);
    }
  }
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parsed = raw ? (JSON.parse(raw) as Json) : {};
      hits.push({ path: req.url ?? '', headers: req.headers as Record<string, string>, raw, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(parsed.challenge ? { challenge: parsed.challenge } : { ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

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
  const invite = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', invite))!;
  await t.api(admin).post('/invitations/accept', { token: invite });
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  otherBoardId = (await body(await as(admin).post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
  const column = async (board: string, title: string, type: string) =>
    (await body(await as(admin).post(`/boards/${board}/columns`, { title, type }))).id as string;
  statusKey = await column(boardId, 'Status', 'status');
  peopleKey = await column(boardId, 'Owner', 'people');
  dateKey = await column(boardId, 'Due', 'date');
  checkKey = await column(boardId, 'Done', 'checkbox');
  await column(otherBoardId, 'Status', 'status');
  const board = await body(await as(admin).get(`/boards/${boardId}`));
  labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels.filter((l: Json) => l.label);
  adminId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
    (u) => u.email === 'admin@acme.test',
  )!.user_id;
  token = (
    await body(
      await as(admin).post('/auth/tokens', {
        name: 'make',
        scopes: ['boards:read', 'items:write', 'webhooks', 'users:read'],
      }),
    )
  ).token;
  await drain();
});
afterAll(async () => {
  await t.close();
  await new Promise((r) => server.close(r));
});

describe('plain values → cells (shared)', () => {
  const col = (id: string, type: string, extra: Partial<IntegrationColumn> = {}): IntegrationColumn => ({
    id,
    title: id,
    type,
    description: null,
    writable: true,
    value_model: 'text',
    options: null,
    value_schema: null,
    linked_board_ids: null,
    ...extra,
  });
  it('reads a date with an offset in the given zone, and one without as written', () => {
    const due = col('due', 'date');
    expect(cellsFromValues([due], { due: '2026-10-19T21:00:00.000Z' }, [], { timeZone: 'Asia/Jerusalem' })).toEqual({
      due: { date: '2026-10-20' },
    });
    expect(cellsFromValues([due], { due: '2026-10-20T14:30' }, [], { timeZone: 'Asia/Jerusalem' })).toEqual({
      due: { date: '2026-10-20', time: '14:30' },
    });
  });
  it('flat rules become one AND group; a picked value wins over the typed one', () => {
    expect(
      rulesToFilter([
        { column_id: 'status', operator: 'any_of', value: 'New, Done' },
        { column_id: 'owner', operator: 'any_of', value: 'x', choice: 'u1' },
        { column_id: 'phone', operator: 'is_empty', value: 'ignored' },
      ]),
    ).toEqual({
      kind: 'group',
      operator: 'and',
      negate: false,
      rules: [
        { kind: 'rule', column_id: 'status', operator: 'any_of', values: ['New', 'Done'], negate: false },
        { kind: 'rule', column_id: 'owner', operator: 'any_of', values: ['u1'], negate: false },
        { kind: 'rule', column_id: 'phone', operator: 'is_empty', values: [], negate: false },
      ],
    });
  });
});

describe('items with plain values and ?format=flat', () => {
  let itemId: string;

  it('creates an item from labels, an email and a date; answers column_values by title', async () => {
    const res = await call('POST', `/boards/${boardId}/items?format=flat`, {
      name: 'Dana',
      values: {
        [statusKey]: labels[1]!.label.toUpperCase(),
        [peopleKey]: 'admin@acme.test',
        [dateKey]: '2026-10-20',
        [checkKey]: 'yes',
      },
    });
    expect(res.status).toBe(201);
    const item = await body(res);
    itemId = item.id;
    expect(item.cells[statusKey].value).toEqual({ index: labels[1]!.id });
    expect(item.cells[peopleKey].value.persons_and_teams[0]).toMatchObject({ id: adminId, kind: 'person' });
    expect(item.cells[dateKey].value).toMatchObject({ date: '2026-10-20' });
    expect(item.column_values).toMatchObject({ Status: labels[1]!.label, Due: expect.any(String) });
    // Without the flag nothing changes.
    expect(await body(await call('GET', `/items/${itemId}`))).not.toHaveProperty('column_values');
    expect((await body(await call('GET', `/items/${itemId}?format=flat`))).column_values.Status).toBe(labels[1]!.label);
  });

  it('refuses a label that is not on the column, naming the choices (422)', async () => {
    const res = await call('POST', `/boards/${boardId}/items`, { name: 'X', values: { [statusKey]: 'Maybe' } });
    expect(res.status).toBe(422);
    const err = (await body(res)).error;
    expect(err.message).toContain('"Maybe" is not a label of "Status"');
    expect(err.message).toContain(labels[0]!.label);
    expect((await call('POST', `/boards/${boardId}/items`, { name: 'X', values: { nope: 'x' } })).status).toBe(422);
  });

  it('updates with plain values; empty values leave the column alone', async () => {
    const res = await call('PATCH', `/items/${itemId}?format=flat`, {
      values: { [statusKey]: labels[0]!.label, [dateKey]: '' },
    });
    expect(res.status).toBe(200);
    const item = await body(res);
    expect(item.cells[statusKey].value).toEqual({ index: labels[0]!.id });
    expect(item.cells[dateKey].value).toMatchObject({ date: '2026-10-20' });
    expect(item.column_values.Status).toBe(labels[0]!.label);
  });

  it('queries with flat rules (picked value first) and finds, both flat', async () => {
    await call('POST', `/boards/${boardId}/items`, { name: 'Yossi', values: { [statusKey]: labels[1]!.label } });
    const page = await body(
      await call('POST', `/boards/${boardId}/items/query?format=flat`, {
        limit: 100,
        rules: [{ column_id: statusKey, operator: 'any_of', value: 'nothing', choice: String(labels[1]!.id) }],
      }),
    );
    expect((page.data as Json[]).map((i) => i.name)).toEqual(['Yossi']);
    expect(page.data[0].column_values.Status).toBe(labels[1]!.label);
    const found = await body(
      await call('POST', `/boards/${boardId}/items/find?format=flat`, { column_id: 'name', value: 'dana' }),
    );
    expect(found.data[0]).toMatchObject({ id: itemId, column_values: { Status: labels[0]!.label } });
  });

  it('duplicates and moves to a group, flat', async () => {
    const copy = await body(await call('POST', `/items/${itemId}/duplicate?format=flat`, { with_updates: false }));
    expect(copy.column_values.Status).toBe(labels[0]!.label);
    const groupId = (await body(await call('GET', `/boards/${boardId}/schema`))).groups[0].id;
    const moved = await body(await call('POST', `/items/${copy.id}/move-to-group?format=flat`, { group_id: groupId }));
    expect(moved.column_values.Status).toBe(labels[0]!.label);
  });

  it('moves to another board without a mapping (same type and title)', async () => {
    const res = await call('POST', `/items/${itemId}/move-to-board`, { board_id: otherBoardId });
    expect(res.status).toBe(200);
    const moved = await body(await call('GET', `/items/${itemId}?format=flat`));
    expect(moved.board_id).toBe(otherBoardId);
    expect(moved.column_values.Status).toBe(labels[0]!.label);
  });
});

describe('subitems with plain values', () => {
  it('creates and lists subitems on the sub-board, flat', async () => {
    const parent = (await body(await call('POST', `/boards/${boardId}/items`, { name: 'Parent' }))).id;
    await call('POST', `/items/${parent}/subitems`, { name: 'First' });
    const subBoardId = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id;
    const stage = (
      await body(await as(admin).post(`/boards/${subBoardId}/columns`, { title: 'Stage', type: 'status' }))
    ).id;
    const subLabels = (await body(await as(admin).get(`/boards/${subBoardId}`))).columns
      .find((c: Json) => c.id === stage)
      .settings.labels.filter((l: Json) => l.label);
    const res = await call('POST', `/items/${parent}/subitems?format=flat`, {
      name: 'Second',
      values: { [stage]: subLabels[0].label },
    });
    expect(res.status).toBe(201);
    const sub = await body(res);
    expect(sub.cells[stage].value).toEqual({ index: subLabels[0].id });
    expect(sub.column_values.Stage).toBe(subLabels[0].label);
    const list = await body(await call('GET', `/items/${parent}/subitems?format=flat`));
    expect((list.data as Json[]).map((i) => i.name)).toEqual(['First', 'Second']);
    expect(list.data[1].column_values.Stage).toBe(subLabels[0].label);

    // The column-values form of the sub-board.
    const fields = await body(await call('GET', `/boards/${boardId}/fields?subitems=true`));
    expect((fields.data as Json[]).find((f) => f.name === stage)).toMatchObject({
      type: 'select',
      options: subLabels.map((l: Json) => ({ label: l.label, value: l.id })),
    });
  });
});

describe('the column-values form', () => {
  it('renders each writable column in its type', async () => {
    const res = await call('GET', `/boards/${boardId}/fields`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(((await body(res)).data as Json[]).map((f) => [f.name, f]));
    expect(byName[statusKey]).toEqual({
      name: statusKey,
      label: 'Status',
      type: 'select',
      options: labels.map((l) => ({ label: l.label, value: l.id })),
    });
    expect(byName[peopleKey]).toMatchObject({ type: 'select', multiple: true, options: 'rpc://listUsers' });
    expect(byName[checkKey]).toMatchObject({ type: 'boolean' });
    expect(byName[dateKey]).toMatchObject({ type: 'text', help: expect.stringContaining('YYYY-MM-DD') });
    expect(byName.name).toBeUndefined();
  });
});

describe('flat webhook subscriptions', () => {
  it('carry deliveryId (the header’s) and the item’s column_values by title', async () => {
    const hook = await call('POST', `/boards/${boardId}/webhooks`, {
      url: `${base}/make/created`,
      event: 'item_created',
      config: { include_item: true, format: 'flat', column_id: '', label: '' },
      description: 'Make: item_created',
    });
    expect(hook.status).toBe(201);
    await call('POST', `/boards/${boardId}/items`, { name: 'Rina', values: { [statusKey]: labels[1]!.label } });
    await drain();
    const h = hits.filter((x) => x.path === '/make/created' && !x.body.challenge).at(-1)!;
    expect(h.body.event.deliveryId).toBe(h.headers['x-bines-delivery']);
    expect(h.body.event.item.column_values.Status).toBe(labels[1]!.label);
    expect(h.body.event.itemName).toBe('Rina');
  });

  const hmac = (secret: string, text: string) => `sha256=${createHmac('sha256', secret).update(text).digest('hex')}`;

  it('carry a lite signature (timestamp + "." + deliveryId) in the headers and the body, next to the full one', async () => {
    const res = await call('POST', `/boards/${boardId}/webhooks`, {
      url: `${base}/make/lite`,
      event: 'item_created',
      config: { include_item: true, format: 'flat' },
      description: 'Make: item_created',
    });
    const { secret } = await body(res);
    expect(secret).toBeTruthy();
    // Hebrew, emoji and a number: what Make's createJSON(body) does not reproduce byte for byte.
    await call('POST', `/boards/${boardId}/items`, { name: 'דנה לוי 🚀 "1.50"' });
    await drain();
    const h = hits.filter((x) => x.path === '/make/lite' && !x.body.challenge).at(-1)!;
    const ts = h.headers['x-bines-timestamp']!;
    const deliveryId = h.headers['x-bines-delivery']!;
    expect(h.body.event.itemName).toBe('דנה לוי 🚀 "1.50"');
    // The full signature covers the raw bytes sent, the lite fields included.
    expect(h.headers['x-bines-signature']).toBe(hmac(secret, `${ts}.${h.raw}`));
    // The lite signature needs no body bytes.
    expect(h.headers['x-bines-signature-lite']).toBe(hmac(secret, `${ts}.${deliveryId}`));
    // A flat subscription has the same values in the body (Make may not see the headers).
    expect(h.body.timestamp).toBe(ts);
    expect(h.body.signatureLite).toBe(h.headers['x-bines-signature-lite']);
    expect(h.body.event.deliveryId).toBe(deliveryId);
    expect(h.body.signatureLite).toBe(hmac(secret, `${h.body.timestamp}.${h.body.event.deliveryId}`));
    expect(h.body.signatureLite).not.toBe(hmac('x'.repeat(48), `${ts}.${deliveryId}`));
  });

  it('leaves other subscriptions as they were (the lite signature in the headers only)', async () => {
    const res = await call('POST', `/boards/${boardId}/webhooks`, {
      url: `${base}/plain/created`,
      event: 'item_created',
      config: { include_item: true },
    });
    const { secret } = await body(res);
    await call('POST', `/boards/${boardId}/items`, { name: 'Avi' });
    await drain();
    const h = hits.filter((x) => x.path === '/plain/created' && !x.body.challenge).at(-1)!;
    expect(h.body.event).not.toHaveProperty('deliveryId');
    expect(h.body.event.item).not.toHaveProperty('column_values');
    expect(Object.keys(h.body)).toEqual(['event']);
    expect(h.headers['x-bines-signature-lite']).toBe(
      hmac(secret, `${h.headers['x-bines-timestamp']}.${h.headers['x-bines-delivery']}`),
    );
  });
});
