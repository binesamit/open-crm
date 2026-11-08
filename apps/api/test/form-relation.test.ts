// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * A visible connect-boards question on a form: the person picks item(s) of the linked board.
 * `relation_list`: `everyone` (anyone sees the names) or `members` (only a signed-in member who may read the board).
 * A submission may link only items its list offers.
 */
let t: TestContext;
let admin: string;
let mia: string;
let acmeId: string;
let boardId: string;
let clientsId: string;
let vipId: string;
let viewId: string;
let token: string;
let clientA: string;
let clientB: string;
let vipItem: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const inviteToken = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, inviteToken))!;
  await t.api(cookie).post('/invitations/accept', { token: inviteToken });
  return cookie;
};

let ipSeq = 0;
const pub = (method: string, path: string, data?: unknown, cookie?: string) =>
  t.app.request(`/api/v1/public/forms/${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      'x-forwarded-for': `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
      ...(cookie ? { cookie } : {}),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const submit = (name: string, answers: Json, cookie?: string) =>
  pub('POST', `${token}/submit`, { answers: { qname001: name, ...answers } }, cookie);
const options = (qid: string, query = '', cookie?: string) =>
  pub('GET', `${token}/questions/${qid}/options${query ? `?${query}` : ''}`, undefined, cookie);

const save = async (patch: Json) => t.api(admin, acmeId).patch(`/views/${viewId}/form`, patch);
const itemNamed = async (name: string) =>
  ((await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items`))).data as Json[]).find(
    (i) => i.name === name,
  );

const nameQ = { id: 'qname001', column_key: 'name', required: true };
const clientQ = (list: 'everyone' | 'members', extra: Json = {}) => ({
  id: 'qcli0001',
  column_key: 'client',
  relation_list: list,
  ...extra,
});
const vipQ = { id: 'qvip0001', column_key: 'vip', relation_list: 'members' };

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['mia@acme.test'], role: 'member' });
  mia = await join('mia@acme.test');

  const api = t.api(admin, acmeId);
  const ws = (await body(await api.get('/workspaces'))).data[0].id;
  clientsId = (await body(await api.post('/boards', { name: 'לקוחות', workspace_id: ws }))).id;
  clientA = (await body(await api.post(`/boards/${clientsId}/items`, { name: 'אלפא בע"מ' }))).id;
  clientB = (await body(await api.post(`/boards/${clientsId}/items`, { name: 'בטא' }))).id;
  // A private board of the admin: Mia cannot read it.
  vipId = (await body(await api.post('/boards', { name: 'VIP', workspace_id: ws, kind: 'private' }))).id;
  vipItem = (await body(await api.post(`/boards/${vipId}/items`, { name: 'לקוח סודי' }))).id;

  boardId = (await body(await api.post('/boards', { name: 'פניות', workspace_id: ws }))).id;
  for (const col of [
    {
      id: 'client',
      title: 'לקוח',
      type: 'board_relation',
      settings: { board_ids: [clientsId], allow_multiple: false },
    },
    { id: 'vip', title: 'VIP', type: 'board_relation', settings: { board_ids: [vipId] } },
  ])
    expect((await api.post(`/boards/${boardId}/columns`, col)).status).toBe(201);
  // The admin creates the form: it reads lists and creates items with the admin's rights.
  const view = await body(
    await api.post(`/boards/${boardId}/views`, { type: 'form', name: 'טופס', visibility: 'shared' }),
  );
  viewId = view.id;
  token = (await body(await api.get(`/views/${viewId}/form`))).token;
});
afterAll(() => t.close());

describe('who sees the list: everyone', () => {
  it('shows the question to anyone, lists names by search and links a picked item', async () => {
    expect((await save({ questions: [nameQ, clientQ('everyone')] })).status).toBe(200);
    const page = await body(await pub('GET', token));
    const q = (page.questions as Json[]).find((x) => x.id === 'qcli0001')!;
    expect(q.input).toBe('relation');
    expect(q.multiple).toBe(false);
    expect(q.relation).toEqual({ boards: [] });
    // Nothing of the linked board beyond the question itself.
    expect(JSON.stringify(page)).not.toContain(clientsId);

    const all = await body(await options('qcli0001'));
    expect((all.data as Json[]).map((d) => d.label).sort()).toEqual(['אלפא בע"מ', 'בטא'].sort());
    expect(Object.keys(all.data[0]).sort()).toEqual(['label', 'value']);
    const found = await body(await options('qcli0001', `q=${encodeURIComponent('בטא')}`));
    expect(found.data).toEqual([{ value: clientB, label: 'בטא' }]);

    expect((await submit('לכולם', { qcli0001: [clientA] })).status).toBe(200);
    expect((await itemNamed('לכולם'))!.cells.client.value.item_ids).toEqual([clientA]);
  });

  it('refuses an item the list does not offer, and more than one when the column takes one', async () => {
    const other = await submit('לא ברשימה', { qcli0001: [vipItem] });
    expect(other.status).toBe(400);
    expect((await body(other)).error.details.questions.qcli0001).toBe('invalid');
    expect((await submit('שניים', { qcli0001: [clientA, clientB] })).status).toBe(400);
    expect(await itemNamed('לא ברשימה')).toBeUndefined();
  });

  it('a required relation question must be answered; an unknown question has no options', async () => {
    await save({ questions: [nameQ, clientQ('everyone', { required: true })] });
    const res = await submit('בלי לקוח', {});
    expect((await body(res)).error.details.questions.qcli0001).toBe('required');
    expect((await options('qzzz0001')).status).toBe(404);
  });
});

describe('who sees the list: members', () => {
  it('hides the question from anonymous visitors and from members who cannot read the board', async () => {
    expect((await save({ questions: [nameQ, clientQ('members'), vipQ] })).status).toBe(200);
    const anon = await body(await pub('GET', token));
    expect((anon.questions as Json[]).map((q) => q.id)).toEqual(['qname001']);
    expect((await options('qcli0001')).status).toBe(404);

    const asMia = await body(await pub('GET', token, undefined, mia));
    expect((asMia.questions as Json[]).map((q) => q.id)).toEqual(['qname001', 'qcli0001']);
    expect((await options('qvip0001', '', mia)).status).toBe(404);

    const asAdmin = await body(await pub('GET', token, undefined, admin));
    expect((asAdmin.questions as Json[]).map((q) => q.id)).toEqual(['qname001', 'qcli0001', 'qvip0001']);
    expect((await body(await options('qvip0001', '', admin))).data).toEqual([{ value: vipItem, label: 'לקוח סודי' }]);
  });

  it("links a signed-in member's pick; an anonymous answer to it is ignored", async () => {
    expect((await submit('של מיה', { qcli0001: [clientB] }, mia)).status).toBe(200);
    expect((await itemNamed('של מיה'))!.cells.client.value.item_ids).toEqual([clientB]);
    // Mia cannot send an item of a board she cannot read (the question is not hers).
    expect((await submit('מיה VIP', { qvip0001: [vipItem] }, mia)).status).toBe(200);
    expect((await itemNamed('מיה VIP'))!.cells.vip).toBeUndefined();
    // Anonymous: the question does not apply — nothing is linked.
    expect((await submit('אנונימי', { qcli0001: [clientA] })).status).toBe(200);
    expect((await itemNamed('אנונימי'))!.cells.client).toBeUndefined();
  });

  it('a hidden relation question still links its fixed item', async () => {
    const res = await save({
      questions: [
        nameQ,
        {
          id: 'qcli0001',
          column_key: 'client',
          hidden: true,
          hidden_source: 'item',
          hidden_item: { board_id: clientsId, item_id: clientA, column_key: null },
        },
      ],
    });
    expect(res.status).toBe(200);
    const page = await body(await pub('GET', token));
    expect((page.questions as Json[]).map((q) => q.id)).toEqual(['qname001']);
    expect((await submit('מוסתר', {})).status).toBe(200);
    expect((await itemNamed('מוסתר'))!.cells.client.value.item_ids).toEqual([clientA]);
    // "Who sees the list" belongs to a visible question only.
    const bad = await save({
      questions: [nameQ, { id: 'qcli0001', column_key: 'client', hidden: true, relation_list: 'everyone' }],
    });
    expect((await body(bad)).error.details.reason).toBe('invalid_relation_list');
  });
});
