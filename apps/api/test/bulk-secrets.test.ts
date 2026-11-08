// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, auditLog, cells, secretRevealGrants, secretValues } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * secrets through "ייבוא ועריכה" (the bulk edit / file import batch). A secret is encrypted per cell
 * like a single write; an empty cell is filled, a cell with a value is left alone unless `secrets_mode: replace`
 * (then the column's fresh-code rule applies once); undo clears what went into empty cells and can not bring a
 * replaced value back; and the plain value is in no response, event, audit row, cell or error.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery'; // helpers.signUpWithPassword
const MASTER = 'c3'.repeat(32);
const P1 = 'Imp0rt-S3cret-AAA-1111';
const P2 = 'Imp0rt-S3cret-BBB-2222';
const P3 = 'Imp0rt-S3cret-CCC-3333';
const SECRET = 'pwd';

let t: TestContext;
let acmeId: string;
let admin: string;
let adminUri: string;
let boardId: string;
let filled: string; // has a secret before the import
let empty: string; // has none

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
const enroll = async (cookie: string) => {
  const res = await authCall('/two-factor/enable', { password: PASSWORD }, cookie);
  expect(res.status).toBe(200);
  const { totpURI } = await body(res);
  const verify = await authCall('/two-factor/verify-totp', { code: totp(totpURI) }, cookie);
  expect(verify.status).toBe(200);
  return { uri: totpURI as string, cookie: sessionCookieOf(verify) ?? cookie };
};
const as = () => t.api(admin, acmeId);
const verify = () => as().post('/secrets/verify', { code: totp(adminUri) });
const bulk = (payload: Json) => as().post(`/boards/${boardId}/items/bulk-edit`, { labels: [], tags: [], ...payload });
const reveal = async (item: string) => {
  const res = await as().post(`/items/${item}/cells/${SECRET}/secret/reveal`);
  return res.status === 200 ? ((await body(res)).value as string) : null;
};
/** Every stored row a secret could leak into, as text. */
const everywhere = async () =>
  JSON.stringify([
    await t.db.select().from(activityLog).where(eq(activityLog.accountId, acmeId)),
    await t.db.select().from(auditLog).where(eq(auditLog.accountId, acmeId)),
    await t.db.select().from(cells).where(eq(cells.accountId, acmeId)),
    await t.db.select().from(secretValues).where(eq(secretValues.accountId, acmeId)),
  ]);

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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const a = await enroll(admin);
  admin = a.cookie;
  adminUri = a.uri;
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Clients', workspace_id: ws }))).id;
  expect(
    (await as().post(`/boards/${boardId}/columns`, { id: SECRET, title: 'Password', type: 'secret' })).status,
  ).toBe(201);
  await as().post(`/boards/${boardId}/columns`, { id: 'note', title: 'Note', type: 'text' });
  filled = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Filled' }))).id;
  empty = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Empty' }))).id;
  // A value set into an empty cell needs no code.
  expect((await as().put(`/items/${filled}/cells/${SECRET}/secret`, { value: P1 })).status).toBe(200);
});
afterAll(() => t.close());

describe('secrets in a bulk edit / file import', () => {
  it('fills empty cells and new rows; a cell with a value is left alone by default; no value leaks', async () => {
    const res = await bulk({
      rows: [
        { item_id: filled, cells: {}, secrets: { [SECRET]: P2 } },
        { item_id: empty, cells: { note: 'x' }, secrets: { [SECRET]: P2 } },
        { name: 'New one', cells: {}, secrets: { [SECRET]: P3 } },
      ],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const p of [P2, P3]) expect(text).not.toContain(p);
    const out = JSON.parse(text) as Json;
    expect(out).toMatchObject({ secrets_set: 2, secrets_replaced: 0, secrets_skipped: 1, created: 1 });
    // The marker only, in cells; the values open with a fresh code.
    expect((await verify()).status).toBe(200);
    expect(await reveal(filled)).toBe(P1);
    expect(await reveal(empty)).toBe(P2);
    expect(await reveal(out.item_ids[0])).toBe(P3);
    const stored = await everywhere();
    for (const p of [P1, P2, P3]) expect(stored).not.toContain(p);
    // One "secret.changed" per written cell, in the batch, without a value.
    const events = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.batchId, out.batch_id), eq(activityLog.type, 'secret.changed')));
    expect(events).toHaveLength(2);
    expect(
      (await t.db.select().from(auditLog).where(eq(auditLog.action, 'secret.set'))).some(
        (r) => (r.payload as Json).bulk === true,
      ),
    ).toBe(true);
  });

  it('undo clears the secrets set into empty cells (and takes the new row away)', async () => {
    // Fresh state: clear `empty`, then a batch that fills it again.
    await as().put(`/items/${empty}/cells/${SECRET}/secret`, { value: null });
    const batch = await body(await bulk({ rows: [{ item_id: empty, cells: {}, secrets: { [SECRET]: P3 } }] }));
    expect(batch).toMatchObject({ secrets_set: 1 });
    expect(await reveal(empty)).toBe(P3);
    const undo = await as().post(`/boards/${boardId}/items/bulk-edit/${batch.batch_id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(await reveal(empty)).toBeNull();
    const cell = await t.db
      .select()
      .from(secretValues)
      .where(and(eq(secretValues.itemId, empty)));
    expect(cell).toHaveLength(0);
  });

  it('replace needs the fresh code (the column asks for one) and can not be undone', async () => {
    // No fresh code (the grant gone): the whole batch is refused, nothing written.
    await t.db.delete(secretRevealGrants);
    const refused = await bulk({
      secrets_mode: 'replace',
      rows: [{ item_id: filled, cells: { note: 'changed' }, secrets: { [SECRET]: P2 } }],
    });
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.code).toBe('secret_step_up_required');
    expect((await verify()).status).toBe(200);
    expect(await reveal(filled)).toBe(P1);
    // With the code: replaced, and the undo can not bring P1 back.
    const res = await bulk({
      secrets_mode: 'replace',
      rows: [{ item_id: filled, cells: {}, secrets: { [SECRET]: P2 } }],
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ secrets_replaced: 1, secrets_set: 0 });
    expect(await reveal(filled)).toBe(P2);
    expect((await as().post(`/boards/${boardId}/items/bulk-edit/${out.batch_id}/undo`, {})).status).toBe(422);
    expect(await reveal(filled)).toBe(P2);
  });

  it('refuses a secret for a column that is not secret, and a too long value without echoing it', async () => {
    const wrong = await bulk({ rows: [{ item_id: empty, cells: {}, secrets: { note: P1 } }] });
    expect(wrong.status).toBe(422);
    expect(await wrong.text()).not.toContain(P1);
    const long = `${P1}${'x'.repeat(10_001)}`;
    const tooLong = await bulk({ rows: [{ item_id: empty, cells: {}, secrets: { [SECRET]: long } }] });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).not.toContain(P1);
    // Never through `cells` (the secret engine writes them).
    const viaCells = await bulk({ rows: [{ item_id: empty, cells: { [SECRET]: P1 } }] });
    expect(viaCells.status).toBeGreaterThanOrEqual(400);
    expect(await viaCells.text()).not.toContain(P1);
    expect(await everywhere()).not.toContain(P1);
  });
});
