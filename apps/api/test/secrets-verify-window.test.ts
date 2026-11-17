// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cells, columns, secretRevealGrants, secretValues } from '../src/db/schema';
import { accountDataKey, decryptSecret } from '../src/modules/secrets/secret-crypto';
import { deleteItem } from '../src/modules/items/items.service';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * PRJ-015, 2026-10-27: a fresh code counts up to 12 hours under the account's ceiling; a check box secret
 * (checking an empty one takes a code too); a board whose deletes take a verification code; a form's secret answers, encrypted onto the
 * new item only.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery'; // helpers.signUpWithPassword
const MASTER = 'c3'.repeat(32);
const FORM_SECRET = 'Fr0m-F0rm-S3cret-QQ71';

let t: TestContext;
let acmeId: string;
let admin: string;
let adminUri: string;
let adminId: string;
let wsId: string;
let boardId: string;

const base32 = (s: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
const totp = (uri: string) => {
  const secret = base32(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
};
const authCall = (path: string, payload: unknown, cookie?: string) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
const sessionCookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('bos.session_token=') && !c.endsWith('='));
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const verify = () => as(admin).post('/secrets/verify', { code: totp(adminUri) });
/** The admin's code was entered `minutes` ago (the grant's time, moved back). */
const codeAgo = async (minutes: number) => {
  await t.db
    .update(secretRevealGrants)
    .set({ verifiedAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(secretRevealGrants.userId, adminId));
};
const columnRow = async (key: string) =>
  (
    await t.db
      .select()
      .from(columns)
      .where(and(eq(columns.boardId, boardId), eq(columns.key, key)))
  )[0]!;
const markerOf = async (itemId: string, key: string) => {
  const col = await columnRow(key);
  return (
    await t.db
      .select()
      .from(cells)
      .where(and(eq(cells.itemId, itemId), eq(cells.columnId, col.id)))
  )[0]?.value as Json | undefined;
};
const plainOf = async (itemId: string, key: string) => {
  const col = await columnRow(key);
  const row = (
    await t.db
      .select()
      .from(secretValues)
      .where(and(eq(secretValues.itemId, itemId), eq(secretValues.columnId, col.id)))
  )[0];
  if (!row) return null;
  const dataKey = await accountDataKey(t.db as never, { SECRET_MASTER_KEY: MASTER, NODE_ENV: 'test' }, acmeId);
  return decryptSecret(dataKey, { accountId: acmeId, itemId, columnId: col.id }, row.ciphertext);
};
const newItem = async (name: string) => (await body(await as(admin).post(`/boards/${boardId}/items`, { name }))).id;

beforeAll(async () => {
  t = await createTestContext({ env: { SECRET_MASTER_KEY: MASTER } });
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
  const enable = await authCall('/two-factor/enable', { password: PASSWORD }, admin);
  adminUri = (await body(enable)).totpURI;
  const done = await authCall('/two-factor/verify-totp', { code: totp(adminUri) }, admin);
  expect(done.status).toBe(200);
  admin = sessionCookieOf(done) ?? admin;
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Access', workspace_id: wsId }))).id;
  for (const col of [
    { id: 'pwd', title: 'Password', type: 'secret' },
    { id: 'ok', title: 'Approved', type: 'secret', settings: { kind: 'checkbox' } },
  ])
    expect((await as(admin).post(`/boards/${boardId}/columns`, col)).status).toBe(201);
});
afterAll(() => t.close());

describe('the verify window', () => {
  it('a column counts a code up to 12 hours; the account ceiling caps every column', async () => {
    const item = await newItem('Window');
    expect((await as(admin).put(`/items/${item}/cells/pwd/secret`, { value: 'abc' })).status).toBe(200);
    expect((await verify()).status).toBe(200);
    const settings = (await columnRow('pwd')).settings as Json;
    const res = await as(admin).patch(`/boards/${boardId}/columns/pwd`, {
      settings: { ...settings, verify_minutes: 720 },
    });
    expect(res.status).toBe(200);
    expect(
      (await as(admin).patch(`/boards/${boardId}/columns/pwd`, { settings: { verify_minutes: 721 } })).status,
    ).toBe(400);
    // Ten hours ago still counts.
    await codeAgo(600);
    expect((await as(admin).post(`/items/${item}/cells/pwd/secret/reveal`)).status).toBe(200);

    // The admin lowers the ceiling to an hour: the same code no longer counts, and the error says how long one does.
    const sec = await as(admin).patch('/security', { secret_max_verify_minutes: 60 });
    expect(sec.status).toBe(200);
    expect((await body(sec)).secret_max_verify_minutes).toBe(60);
    const refused = await as(admin).post(`/items/${item}/cells/pwd/secret/reveal`);
    expect(refused.status).toBe(403);
    expect((await body(refused)).error).toMatchObject({
      code: 'secret_step_up_required',
      details: { verify_minutes: 60 },
    });
    expect((await as(admin).patch('/security', { secret_max_verify_minutes: 721 })).status).toBe(400);
    expect((await as(admin).patch('/security', { secret_max_verify_minutes: 720 })).status).toBe(200);
  });
});

describe('a check box secret', () => {
  it('stores checked / not checked encrypted; hidden by default; no copy; other values refused', async () => {
    const item = await newItem('Box');
    // an empty box is "not checked" — checking it is a change and takes a fresh code (a text cell's
    // first value still does not).
    await codeAgo(24 * 60);
    const refused = await as(admin).put(`/items/${item}/cells/ok/secret`, { value: 'כן' });
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.code).toBe('secret_step_up_required');
    expect(await plainOf(item, 'ok')).toBeNull();
    expect((await as(admin).put(`/items/${item}/cells/pwd/secret`, { value: 'first' })).status).toBe(200);
    // A bulk edit into the empty box asks for it too.
    const bulk = await as(admin).post(`/boards/${boardId}/items/bulk-edit`, {
      labels: [],
      tags: [],
      rows: [{ item_id: item, cells: {}, secrets: { ok: '1' } }],
    });
    expect(bulk.status).toBe(403);
    expect(await plainOf(item, 'ok')).toBeNull();
    // A new row of an import starts checked without one (nothing anyone saw changes).
    const created = await as(admin).post(`/boards/${boardId}/items/bulk-edit`, {
      labels: [],
      tags: [],
      rows: [{ name: 'Imported box', cells: {}, secrets: { ok: '1' } }],
    });
    expect(created.status).toBe(200);
    expect(await plainOf((await body(created)).item_ids[0], 'ok')).toBe('1');
    await verify();
    expect((await as(admin).put(`/items/${item}/cells/ok/secret`, { value: 'כן' })).status).toBe(200);
    expect(await plainOf(item, 'ok')).toBe('1');
    // Hidden: the cell says a value exists, never whether it is checked.
    expect(await markerOf(item, 'ok')).not.toHaveProperty('checked');
    const bad = await as(admin).put(`/items/${item}/cells/ok/secret`, { value: 'maybe' });
    expect(bad.status).toBe(422);
    await verify();
    const shown = await body(await as(admin).post(`/items/${item}/cells/ok/secret/reveal`));
    expect(shown).toMatchObject({ value: '1', copy_allowed: false });
    expect((await as(admin).post(`/items/${item}/cells/ok/secret/copy`)).status).toBe(403);
    // Unchecked is a value too (its state stays hidden).
    expect((await as(admin).put(`/items/${item}/cells/ok/secret`, { value: false as never })).status).toBe(400); // not a string
    expect((await as(admin).put(`/items/${item}/cells/ok/secret`, { value: '0' })).status).toBe(200);
    expect(await plainOf(item, 'ok')).toBe('0');
  });

  it('"show without a code": every marker says whether it is checked, and stops when turned off', async () => {
    const item = await newItem('Shown');
    await as(admin).put(`/items/${item}/cells/ok/secret`, { value: '1' });
    await verify();
    const settings = (await columnRow('ok')).settings as Json;
    expect(
      (await as(admin).patch(`/boards/${boardId}/columns/ok`, { settings: { ...settings, checkbox_visible: true } }))
        .status,
    ).toBe(200);
    expect((await markerOf(item, 'ok'))?.checked).toBe(true);
    await as(admin).put(`/items/${item}/cells/ok/secret`, { value: '0' });
    expect((await markerOf(item, 'ok'))?.checked).toBe(false);
    // The board's items show it too (the marker is the cell's value).
    const rows = (await body(await as(admin).get(`/boards/${boardId}/items`))).data as Json[];
    expect(rows.find((r) => r.id === item)!.cells.ok.value.checked).toBe(false);
    await as(admin).patch(`/boards/${boardId}/columns/ok`, { settings: { ...settings, checkbox_visible: false } });
    expect(await markerOf(item, 'ok')).not.toHaveProperty('checked');
  });

  it('a column that holds values keeps its kind', async () => {
    await verify();
    const settings = (await columnRow('ok')).settings as Json;
    const res = await as(admin).patch(`/boards/${boardId}/columns/ok`, { settings: { ...settings, kind: 'text' } });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('secret_kind_has_values');
  });
});

describe('a board whose deletes take a code', () => {
  const perms = () => `/boards/${boardId}/permissions`;

  it('off by default; on: delete, archive and a batch ask for a fresh code; turning it off takes one too', async () => {
    expect((await body(await as(admin).get(perms()))).delete_guard).toEqual({ enabled: false, verify_minutes: 15 });
    const on = await as(admin).put(perms(), { delete_guard: { enabled: true, verify_minutes: 5 } });
    expect(on.status).toBe(200);
    expect((await body(on)).delete_guard).toEqual({ enabled: true, verify_minutes: 5 });

    const a = await newItem('Gone A');
    const b = await newItem('Gone B');
    const c = await newItem('Gone C');
    await codeAgo(10); // older than the board's 5 minutes
    for (const res of [
      await as(admin).del(`/items/${a}`),
      await as(admin).post(`/items/${a}/archive`, {}),
      await as(admin).post(`/boards/${boardId}/items/bulk`, { item_ids: [b, c], action: { type: 'delete' } }),
    ]) {
      expect(res.status).toBe(403);
      expect((await body(res)).error.code).toBe('secret_step_up_required');
    }
    // Turning it off without a fresh code: refused.
    expect((await as(admin).put(perms(), { delete_guard: { enabled: false, verify_minutes: 5 } })).status).toBe(403);

    await verify();
    expect((await as(admin).del(`/items/${a}`)).status).toBe(200);
    const bulk = await as(admin).post(`/boards/${boardId}/items/bulk`, {
      item_ids: [b, c],
      action: { type: 'delete' },
    });
    expect(bulk.status).toBe(200);
  });

  it('a tool or a run without a person never passes; an automation still deletes', async () => {
    const item = await newItem('Tool');
    const account = (await t.db.execute<Json>(sql`select * from accounts where id = ${acmeId}`)).rows[0]!;
    const membership = (
      await t.db.execute<Json>(sql`select * from account_members where account_id = ${acmeId} and user_id = ${adminId}`)
    ).rows[0]!;
    const ctx = { account, accountId: acmeId, role: 'admin', membershipId: membership.id } as never;
    const user = { id: adminId, email: 'admin@acme.test', name: 'Admin' } as never;
    await verify();
    // The AI / MCP: no sign-in on the actor (runners strip it) — refused even right after the person's code.
    await expect(deleteItem(t.db as never, { ctx, user, sessionId: null, token: null }, item)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      deleteItem(t.db as never, { ctx, user, agent: { id: 'A1' } as never, sessionId: 'x' }, item),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // An automation of the board's people: deletes.
    await deleteItem(t.db as never, { ctx, user, automation: { id: 'R1', title: 'Clean', runId: 'run1' } }, item);
    expect((await as(admin).get(`/items/${item}`)).status).toBe(404);
  });

  it('turned off with a fresh code: deletes need none again', async () => {
    await verify();
    expect((await as(admin).put(perms(), { delete_guard: { enabled: false, verify_minutes: 5 } })).status).toBe(200);
    await codeAgo(60 * 24);
    expect((await as(admin).del(`/items/${await newItem('Free')}`)).status).toBe(200);
  });
});

describe("a form's secret answers", () => {
  let viewId: string;
  let token: string;
  const submit = (answers: Json) =>
    t.app.request(`/api/v1/public/forms/${token}/submit`, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
      body: JSON.stringify({ answers }),
    });

  beforeAll(async () => {
    viewId = (await body(await as(admin).post(`/boards/${boardId}/views`, { type: 'form', name: 'Access form' }))).id;
    token = (await body(await as(admin).get(`/views/${viewId}/form`))).token;
  });

  it('a secret question: visible only, no prefill, no condition on it', async () => {
    const name = { id: 'qname001', column_key: 'name', required: true };
    const pwd = { id: 'qpwd0001', column_key: 'pwd', required: true };
    const hidden = await as(admin).patch(`/views/${viewId}/form`, { questions: [name, { ...pwd, hidden: true }] });
    expect(hidden.status).toBe(422);
    const prefill = await as(admin).patch(`/views/${viewId}/form`, {
      questions: [name, { ...pwd, default_value: 'x' }],
    });
    expect(prefill.status).toBe(422);
    const cond = await as(admin).patch(`/views/${viewId}/form`, {
      questions: [name, pwd, { id: 'qok00001', column_key: 'ok', condition: { question_id: 'qpwd0001', equals: 'x' } }],
    });
    expect(cond.status).toBe(422);
    const ok = await as(admin).patch(`/views/${viewId}/form`, {
      questions: [name, pwd, { id: 'qok00001', column_key: 'ok' }],
    });
    expect(ok.status).toBe(200);
    const page = await body(await t.app.request(`/api/v1/public/forms/${token}`, { headers: { origin: WEB_ORIGIN } }));
    const qs = page.questions as Json[];
    expect(qs.find((q) => q.id === 'qpwd0001')).toMatchObject({ input: 'secret', secret: 'text' });
    expect(qs.find((q) => q.id === 'qok00001')).toMatchObject({ input: 'secret', secret: 'checkbox' });
  });

  it('the answer is encrypted onto the new item and kept nowhere else', async () => {
    const res = await submit({ qname001: 'New client', qpwd0001: FORM_SECRET, qok00001: true });
    expect(res.status).toBe(200);
    const item = ((await body(await as(admin).get(`/boards/${boardId}/items`))).data as Json[]).find(
      (i) => i.name === 'New client',
    )!;
    expect(await plainOf(item.id, 'pwd')).toBe(FORM_SECRET);
    expect(await plainOf(item.id, 'ok')).toBe('1');
    expect((await markerOf(item.id, 'pwd'))?.set).toBe(true);
    const sub = (await t.db.execute<Json>(sql`select answers from form_submissions where item_id = ${item.id}`))
      .rows[0]!;
    expect(sub.answers.qpwd0001).toBe('••••');
    expect(sub.answers.qok00001).toBe('••••');
    // A scan of every table: the value is nowhere in the clear.
    const tables = (
      await t.pg.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.table_name);
    for (const name of tables) {
      const hit = await t.pg.query<{ n: number }>(
        `select count(*)::int as n from "${name}" x where row_to_json(x)::text like $1`,
        [`%${FORM_SECRET}%`],
      );
      expect(`${name}:${hit.rows[0]!.n}`).toBe(`${name}:0`);
    }
  });

  it('a check box answer that is not one is refused', async () => {
    const res = await submit({ qname001: 'Bad', qpwd0001: 'x', qok00001: 'maybe' });
    expect(res.status).toBe(400);
  });
});
