// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formHiddenOnly, formParamUrl, formQuestionAllowed } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import { answerFromCell, answerFromParam } from '../src/modules/forms/forms.values';

/**
 * r16forms — hidden values from a source: typed (manual), picked from the column's options (choice), read from an
 * item of a board at submit time (item, with the form creator's access), or taken from a link parameter (url).
 */
let t: TestContext;
let admin: string;
let mia: string;
let acmeId: string;
let miaId: string;
let adminId: string;
let boardId: string;
let clientsId: string;
let privateId: string;
let viewId: string;
let token: string;
let clientA: string;
let clientB: string;
let secretItem: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const inviteToken = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, inviteToken))!;
  await t.api(cookie).post('/invitations/accept', { token: inviteToken });
  return cookie;
};

let ipSeq = 0;
const pub = (method: string, path: string, data?: unknown) =>
  t.app.request(`/api/v1/public/forms/${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      'x-forwarded-for': `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const submit = (name: string, params?: Record<string, string>) =>
  pub('POST', `${token}/submit`, { answers: { qname001: name }, ...(params ? { params } : {}) });

const save = async (patch: Json, cookie = mia) => t.api(cookie, acmeId).patch(`/views/${viewId}/form`, patch);
const itemNamed = async (name: string) =>
  ((await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items`))).data as Json[]).find(
    (i) => i.name === name,
  )!;

const nameQ = { id: 'qname001', column_key: 'name', required: true };
const LABELS = [
  { id: 0, label: 'חדש', color: 'yellow', index: 0 },
  { id: 1, label: 'דחוף', color: 'crimson', index: 1 },
];

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
  const members = (await body(await t.api(admin, acmeId).get('/users'))).data as Json[];
  miaId = members.find((m) => m.email === 'mia@acme.test')!.user_id;
  adminId = members.find((m) => m.email === 'admin@acme.test')!.user_id;

  const api = t.api(admin, acmeId);
  const ws = (await body(await api.get('/workspaces'))).data[0].id;
  // The source board: clients, with a tier (status), a city and a manager.
  clientsId = (await body(await api.post('/boards', { name: 'לקוחות', workspace_id: ws }))).id;
  for (const col of [
    { id: 'tier', title: 'דרג', type: 'status', settings: { labels: LABELS } },
    { id: 'city', title: 'עיר', type: 'text' },
    { id: 'manager', title: 'מנהל', type: 'people' },
  ])
    expect((await api.post(`/boards/${clientsId}/columns`, col)).status).toBe(201);
  clientA = (
    await body(
      await api.post(`/boards/${clientsId}/items`, {
        name: 'לקוח א',
        cells: { tier: { index: 1 }, city: 'חיפה', manager: { persons_and_teams: [{ id: adminId, kind: 'person' }] } },
      }),
    )
  ).id;
  clientB = (await body(await api.post(`/boards/${clientsId}/items`, { name: 'לקוח ב', cells: { city: 'אילת' } }))).id;
  // A private board of the admin: Mia (a member) cannot see it.
  privateId = (await body(await api.post('/boards', { name: 'סודי', workspace_id: ws, kind: 'private' }))).id;
  await api.post(`/boards/${privateId}/columns`, { id: 'secret', title: 'סוד', type: 'text' });
  secretItem = (await body(await api.post(`/boards/${privateId}/items`, { name: 'סוד', cells: { secret: 'XYZZY' } })))
    .id;

  // The form's board: the target columns.
  boardId = (await body(await api.post('/boards', { name: 'פניות', workspace_id: ws }))).id;
  for (const col of [
    { id: 'ref', title: 'מקור', type: 'text' },
    { id: 'stage', title: 'שלב', type: 'status', settings: { labels: LABELS } },
    { id: 'owner', title: 'אחראי', type: 'people' },
    { id: 'amount', title: 'סכום', type: 'numbers' },
    { id: 'agree', title: 'מאשר', type: 'checkbox' },
    { id: 'client', title: 'לקוח', type: 'board_relation', settings: { board_ids: [clientsId] } },
  ])
    expect((await api.post(`/boards/${boardId}/columns`, col)).status).toBe(201);
  // Mia creates the form: it acts as her (her rights read the sources and create the items).
  const view = await body(
    await t.api(mia, acmeId).post(`/boards/${boardId}/views`, { type: 'form', name: 'טופס', visibility: 'shared' }),
  );
  viewId = view.id;
  token = (await body(await t.api(mia, acmeId).get(`/views/${viewId}/form`))).token;
});
afterAll(() => t.close());

describe('helpers', () => {
  it('connect boards is a hidden-only question; link params and source cells become answers', () => {
    expect(formHiddenOnly('board_relation')).toBe(true);
    expect(formQuestionAllowed('board_relation')).toBe(true);
    expect(formQuestionAllowed('formula')).toBe(false);
    expect(formParamUrl('https://x.test/f/abc', 'ref', 'a b')).toBe('https://x.test/f/abc?ref=a%20b');
    const col = (type: string) => ({ key: 'k', type, title: 'k', settings: {} });
    expect(answerFromParam(col('checkbox'), 'yes')).toBe(true);
    expect(answerFromParam(col('dropdown'), 'a, b')).toEqual(['a', 'b']);
    expect(answerFromParam(col('people'), 'x@y.test', new Map([['x@y.test', 'U1']]))).toEqual(['U1']);
    expect(answerFromCell(col('text'), { type: 'status', value: { index: 1 }, text: 'דחוף' })).toBe('דחוף');
    expect(answerFromCell(col('date'), { type: 'date', value: { date: '2026-10-07' }, text: '07/10/2026' })).toBe(
      '2026-10-07',
    );
    // People and links come only from a column of the same kind.
    expect(answerFromCell(col('people'), { type: 'text', value: 'x', text: 'x' })).toBeUndefined();
  });
});

describe('manual and picked values', () => {
  it('saves a typed text, a picked label and a picked person; submits them on a public form', async () => {
    const res = await save({
      questions: [
        nameQ,
        { id: 'qref0001', column_key: 'ref', hidden: true, hidden_source: 'manual', default_value: 'אתר' },
        { id: 'qstg0001', column_key: 'stage', hidden: true, hidden_source: 'choice', default_value: 1 },
        { id: 'qown0001', column_key: 'owner', hidden: true, hidden_source: 'choice', default_value: [miaId] },
      ],
    });
    expect(res.status).toBe(200);
    expect((await submit('ידני')).status).toBe(200);
    const item = await itemNamed('ידני');
    expect(item.cells.ref.value).toBe('אתר');
    expect(item.cells.stage.value).toEqual({ index: 1 });
    expect(item.cells.owner.value.persons_and_teams).toEqual([{ id: miaId, kind: 'person' }]);
  });

  it('refuses a person who is not in the account, a typed connect-boards value and a visible one', async () => {
    const bad = await save({
      questions: [
        nameQ,
        { id: 'qown0001', column_key: 'owner', hidden: true, default_value: ['01ZZZZZZZZZZZZZZZZZZZZZZZZ'] },
      ],
    });
    expect((await body(bad)).error.details.reason).toBe('invalid_default');
    const typed = await save({ questions: [nameQ, { id: 'qcli0001', column_key: 'client', hidden: true }] });
    expect((await body(typed)).error.details.reason).toBe('invalid_source');
    const shown = await save({ questions: [nameQ, { id: 'qcli0001', column_key: 'client' }] });
    expect((await body(shown)).error.details.reason).toBe('hidden_only');
    const missing = await save({
      questions: [nameQ, { id: 'qref0001', column_key: 'ref', hidden: true, hidden_source: 'url' }],
    });
    expect((await body(missing)).error.details.reason).toBe('missing_source');
  });
});

describe('a value from an item', () => {
  it('links the picked item and reads its column values at submit time (changes flow in)', async () => {
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
        {
          id: 'qref0001',
          column_key: 'ref',
          hidden: true,
          hidden_source: 'item',
          hidden_item: { board_id: clientsId, item_id: clientA, column_key: 'city' },
        },
        {
          id: 'qstg0001',
          column_key: 'stage',
          hidden: true,
          hidden_source: 'item',
          hidden_item: { board_id: clientsId, item_id: clientA, column_key: 'tier' },
        },
        {
          id: 'qown0001',
          column_key: 'owner',
          hidden: true,
          hidden_source: 'item',
          hidden_item: { board_id: clientsId, item_id: clientA, column_key: 'manager' },
        },
      ],
    });
    expect(res.status).toBe(200);
    // Nothing of the source reaches the public page.
    const page = JSON.stringify(await body(await pub('GET', token)));
    for (const leak of [clientA, clientsId, 'חיפה', 'qref0001', 'qcli0001', 'city']) expect(page).not.toContain(leak);

    expect((await submit('מפריט')).status).toBe(200);
    let item = await itemNamed('מפריט');
    expect(item.cells.client.value.item_ids).toEqual([clientA]);
    expect(item.cells.ref.value).toBe('חיפה');
    expect(item.cells.stage.value).toEqual({ index: 1 });
    expect(item.cells.owner.value.persons_and_teams).toEqual([{ id: adminId, kind: 'person' }]);

    // The source item changes: the next submission takes the new values.
    await t.api(admin, acmeId).put(`/items/${clientA}/cells/city`, { value: 'עכו' });
    await t.api(admin, acmeId).put(`/items/${clientA}/cells/tier`, { value: { index: 0 } });
    expect((await submit('מפריט 2')).status).toBe(200);
    item = await itemNamed('מפריט 2');
    expect(item.cells.ref.value).toBe('עכו');
    expect(item.cells.stage.value).toEqual({ index: 0 });
  });

  it('a source item that is gone leaves the cell empty without blocking the person', async () => {
    await save({
      questions: [
        nameQ,
        {
          id: 'qref0001',
          column_key: 'ref',
          hidden: true,
          hidden_source: 'item',
          hidden_item: { board_id: clientsId, item_id: clientB, column_key: 'city' },
        },
      ],
    });
    expect((await t.api(admin, acmeId).del(`/items/${clientB}`)).status).toBe(200);
    expect((await submit('בלי מקור')).status).toBe(200);
    expect((await itemNamed('בלי מקור')).cells.ref).toBeUndefined();
  });

  it('refuses a column that is not on the item, or a connect-boards item of another board', async () => {
    const wrongCol = await save({
      questions: [
        nameQ,
        {
          id: 'qref0001',
          column_key: 'ref',
          hidden: true,
          hidden_source: 'item',
          hidden_item: { board_id: clientsId, item_id: clientA, column_key: 'nope' },
        },
      ],
    });
    expect((await body(wrongCol)).error.details.reason).toBe('invalid_source');
    const ownItem = (await itemNamed('ידני')).id;
    const wrongBoard = await save({
      questions: [
        nameQ,
        {
          id: 'qcli0001',
          column_key: 'client',
          hidden: true,
          hidden_source: 'item',
          hidden_item: { board_id: boardId, item_id: ownItem, column_key: null },
        },
      ],
    });
    expect((await body(wrongBoard)).error.details.reason).toBe('invalid_source');
  });
});

describe('permissions', () => {
  const secretQ = {
    id: 'qref0001',
    column_key: 'ref',
    hidden: true,
    hidden_source: 'item',
    hidden_item: { board_id: '', item_id: '', column_key: 'secret' },
  };
  it("a source the saver cannot read is refused; so is one the form's creator cannot read", async () => {
    const q = { ...secretQ, hidden_item: { board_id: privateId, item_id: secretItem, column_key: 'secret' } };
    // Mia cannot see the private board: to her it does not exist.
    expect((await body(await save({ questions: [nameQ, q] }))).error.details.reason).toBe('invalid_source');
    // The admin can, but the form acts as Mia — her rights read the source on submit.
    expect((await body(await save({ questions: [nameQ, q] }, admin))).error.details.reason).toBe('source_no_access');
  });

  it("at submit time the source is read with the creator's rights: no access, no value (and no leak)", async () => {
    // A form saved before access was lost (written straight into the row).
    await save({ questions: [nameQ] });
    const q = { ...secretQ, hidden_item: { board_id: privateId, item_id: secretItem, column_key: 'secret' } };
    await t.db.execute(
      sql`update forms set questions = ${JSON.stringify([nameQ, q])}::jsonb where view_id = ${viewId}`,
    );
    const res = await submit('בלי הרשאה');
    expect(res.status).toBe(200);
    expect(JSON.stringify(await body(res))).not.toContain('XYZZY');
    expect((await itemNamed('בלי הרשאה')).cells.ref).toBeUndefined();
  });
});

describe('a value from the link', () => {
  beforeAll(async () => {
    const res = await save({
      questions: [
        nameQ,
        {
          id: 'qref0001',
          column_key: 'ref',
          hidden: true,
          hidden_source: 'url',
          hidden_param: { name: 'ref', fallback: true },
          default_value: 'ישיר',
        },
        {
          id: 'qamt0001',
          column_key: 'amount',
          hidden: true,
          hidden_source: 'url',
          hidden_param: { name: 'amt', fallback: false },
          default_value: 5,
        },
        {
          id: 'qstg0001',
          column_key: 'stage',
          hidden: true,
          hidden_source: 'url',
          hidden_param: { name: 'stage', fallback: false },
        },
        {
          id: 'qown0001',
          column_key: 'owner',
          hidden: true,
          hidden_source: 'url',
          hidden_param: { name: 'owner', fallback: false },
        },
        { id: 'qagr0001', column_key: 'agree', hidden: true, hidden_source: 'url', hidden_param: { name: 'ok' } },
        {
          id: 'qcli0001',
          column_key: 'client',
          hidden: true,
          hidden_source: 'url',
          hidden_param: { name: 'client', fallback: false },
        },
      ],
    });
    expect(res.status).toBe(200);
  });

  it('fills each question from its parameter, validated against the column', async () => {
    const res = await submit('מקישור', {
      ref: 'newsletter',
      amt: '12.5',
      stage: 'דחוף',
      owner: 'mia@acme.test',
      ok: 'yes',
      client: clientA,
      other: 'ignored',
    });
    expect(res.status).toBe(200);
    const item = await itemNamed('מקישור');
    expect(item.cells.ref.value).toBe('newsletter');
    expect(item.cells.amount.value).toBe(12.5);
    expect(item.cells.stage.value).toEqual({ index: 1 });
    expect(item.cells.owner.value.persons_and_teams).toEqual([{ id: miaId, kind: 'person' }]);
    expect(item.cells.agree.value).toMatchObject({ checked: true });
    expect(item.cells.client.value.item_ids).toEqual([clientA]);
  });

  it('a missing parameter falls back to the fixed value only when the question says so', async () => {
    expect((await submit('בלי פרמטרים')).status).toBe(200);
    const item = await itemNamed('בלי פרמטרים');
    expect(item.cells.ref.value).toBe('ישיר');
    expect(item.cells.amount).toBeUndefined();
  });

  it('a parameter that does not fit is refused like an answer, and the page is told the link is not valid', async () => {
    for (const params of <Record<string, string>[]>[
      { amt: 'abc' },
      { stage: 'לא קיים' },
      { owner: 'stranger@x.test' },
      { client: secretItem }, // an item Mia (the form's creator) cannot read
      { client: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
    ]) {
      const res = await submit('שגוי', params);
      expect(res.status).toBe(400);
      const err = (await body(res)).error;
      expect(err.code).toBe('validation_failed');
      expect(err.details.link).toBe(true);
      expect(Object.values(err.details.questions)).toEqual(['invalid']);
    }
    expect(await itemNamed('שגוי')).toBeUndefined();
  });

  it('refuses a bad parameter name and too many parameters', async () => {
    const badName = await save({
      questions: [
        nameQ,
        { id: 'qref0001', column_key: 'ref', hidden: true, hidden_source: 'url', hidden_param: { name: '1 bad' } },
      ],
    });
    expect(badName.status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, 'x']));
    expect((await submit('הרבה', many)).status).toBe(400);
  });
});
