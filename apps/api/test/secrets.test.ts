// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  columnTypes,
  formQuestionAllowed,
  formUnsupportedReason,
  newId,
  ownWriter,
  scopeAllows,
  webhookEventsOf,
} from '@bines/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  accountSecretKeys,
  activityLog,
  automations,
  auditLog,
  boardMembers,
  cells,
  columns,
  notifications,
  secretRevealGrants,
  secretValues,
} from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import {
  accountDataKey,
  decryptSecret,
  encryptSecret,
  masterKeyOf,
  secretKeyProblem,
} from '../src/modules/secrets/secret-crypto';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Secret columns: envelope encryption, the two-factor step-up and its grant, reveal / copy and
 * their audit, the permission matrix, the admins' alert — and a regression test for every path a secret could leak
 * through (exports, search, MCP / AI tools, webhooks, automation variables, activity, undo, duplicate, templates,
 * the public API, forms, mirror and formula), ending with a scan of every table.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery'; // helpers.signUpWithPassword
const PLAIN = 'Pl41n-S3cret-ZQX-7731';
const MASTER = 'a1'.repeat(32); // 32 bytes, hex

let t: TestContext;
let acmeId: string;
let admin: string;
let bob: string;
let carol: string;
let adminId: string;
let bobId: string;
let adminUri: string;
let bobUri: string;
let wsId: string;
let boardId: string;
let itemId: string;
const SECRET = 'pwd';
const TEXT = 'note';

// ---- TOTP (RFC 6238) from the otpauth:// URI, as in sec2-two-factor.test.ts ----
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

const as = (cookie: string) => t.api(cookie, acmeId);
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const invite = async (email: string) => {
  await as(admin).post('/users/invite', { emails: [email], role: 'member' });
  return join(email);
};
const userId = async (cookie: string) => (await body(await t.api(cookie).get('/auth/me'))).user.id as string;

const cellPath = (item = itemId, key = SECRET) => `/items/${item}/cells/${key}/secret`;
const setSecret = (cookie: string, value: string | null, item = itemId, key = SECRET) =>
  as(cookie).put(cellPath(item, key), { value });
const reveal = (cookie: string, item = itemId, key = SECRET) => as(cookie).post(`${cellPath(item, key)}/reveal`);
const verify = (cookie: string, uri: string) => as(cookie).post('/secrets/verify', { code: totp(uri) });
const settingsOf = async (key = SECRET) =>
  (await body(await as(admin).get(`/boards/${boardId}`))).columns.find((c: Json) => c.id === key).settings as Json;
/** A settings change takes a fresh code: the admin enters one first. */
const patchSettings = async (patch: Json, key = SECRET) => {
  expect((await verify(admin, adminUri)).status).toBe(200);
  const res = await as(admin).patch(`/boards/${boardId}/columns/${key}`, {
    settings: { ...(await settingsOf(key)), ...patch },
  });
  expect(res.status).toBe(200);
};
const audits = (action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));

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
  bob = await invite('bob@acme.test');
  carol = await invite('carol@acme.test');
  const a = await enroll(admin);
  admin = a.cookie;
  adminUri = a.uri;
  const b = await enroll(bob);
  bob = b.cookie;
  bobUri = b.uri;
  adminId = await userId(admin);
  bobId = await userId(bob);
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
  const col = await as(admin).post(`/boards/${boardId}/columns`, { id: SECRET, title: 'Password', type: 'secret' });
  expect(col.status).toBe(201);
  await as(admin).post(`/boards/${boardId}/columns`, { id: TEXT, title: 'Note', type: 'text' });
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Client site' }))).id;
});
afterAll(() => t.close());

describe('encryption', () => {
  it('round-trips with the account data key; bound to its cell; the master key is required in production', async () => {
    const db = t.db as never;
    const env = { SECRET_MASTER_KEY: MASTER, NODE_ENV: 'test' as const };
    const key = await accountDataKey(db, env, acmeId);
    expect(key).toHaveLength(32);
    // The same key next time (stored wrapped, never in the clear).
    expect((await accountDataKey(db, env, acmeId)).equals(key)).toBe(true);
    const [row] = await t.db.select().from(accountSecretKeys).where(eq(accountSecretKeys.accountId, acmeId));
    expect(row!.wrappedKey.startsWith('v1.')).toBe(true);
    expect(row!.wrappedKey).not.toContain(key.toString('base64url'));

    const ref = { accountId: acmeId, itemId: 'I1', columnId: 'C1' };
    const sealed = encryptSecret(key, ref, PLAIN);
    expect(sealed).not.toContain(PLAIN);
    expect(encryptSecret(key, ref, PLAIN)).not.toBe(sealed); // a fresh IV every time
    expect(decryptSecret(key, ref, sealed)).toBe(PLAIN);
    // Moved to another cell or account: refused (AES-GCM additional data).
    expect(() => decryptSecret(key, { ...ref, columnId: 'C2' }, sealed)).toThrow();
    expect(() => decryptSecret(key, { ...ref, accountId: 'other' }, sealed)).toThrow();
    // Another master key cannot open the account's data key.
    await expect(accountDataKey(db, { SECRET_MASTER_KEY: 'b2'.repeat(32), NODE_ENV: 'test' }, acmeId)).rejects.toThrow(
      AppError,
    );

    // A clear error when it is missing in production or malformed; a development key elsewhere.
    expect(() => masterKeyOf({ SECRET_MASTER_KEY: undefined, NODE_ENV: 'production' })).toThrow(
      /SECRET_MASTER_KEY is not set/,
    );
    try {
      masterKeyOf({ SECRET_MASTER_KEY: undefined, NODE_ENV: 'production' });
    } catch (e) {
      expect((e as AppError).code).toBe('secret_master_key_missing');
      expect((e as AppError).status).toBe(503);
    }
    expect(() => masterKeyOf({ SECRET_MASTER_KEY: 'short', NODE_ENV: 'production' })).toThrow(/32 bytes/);
    expect(masterKeyOf({ SECRET_MASTER_KEY: undefined, NODE_ENV: 'development' })).toHaveLength(32);
    expect(secretKeyProblem({ SECRET_MASTER_KEY: MASTER, NODE_ENV: 'production' })).toBeNull();
    // The base64 form works as well (openssl rand -base64 32).
    expect(masterKeyOf({ SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), NODE_ENV: 'production' })).toEqual(
      Buffer.alloc(32, 7),
    );
  });

  it('the production API answers 503 secret_master_key_missing without the key, and writes nothing', async () => {
    const prod = await createTestContext({ env: { SECRET_MASTER_KEY: 'not-a-key' } });
    try {
      const owner = (await prod.signInWithMagicLink(OWNER_EMAIL)).cookie!;
      const acc = (
        await body(
          await prod.api(owner).post('/platform/accounts', {
            name: 'Prod',
            slug: 'prodco',
            first_admin_email: 'boss@prod.test',
            template_set: 'empty',
          }),
        )
      ).account.id as string;
      const token = prod.inviteTokenFor('boss@prod.test');
      const cookie = prod.cookieFrom(await prod.signUpWithPassword('boss@prod.test', token))!;
      await prod.api(cookie).post('/invitations/accept', { token });
      const api = prod.api(cookie, acc);
      const ws = (await body(await api.get('/workspaces'))).data[0].id;
      const b = (await body(await api.post('/boards', { name: 'B', workspace_id: ws }))).id;
      await api.post(`/boards/${b}/columns`, { id: 's', title: 'S', type: 'secret' });
      const it = (await body(await api.post(`/boards/${b}/items`, { name: 'x' }))).id;
      const res = await api.put(`/items/${it}/cells/s/secret`, { value: PLAIN });
      expect(res.status).toBe(503);
      expect((await body(res)).error.code).toBe('secret_master_key_missing');
      expect(await prod.db.select().from(secretValues)).toHaveLength(0);
    } finally {
      await prod.close();
    }
  });
});

describe('set and clear', () => {
  it('stores ciphertext outside cells; the cell is only a marker; PUT /cells refuses the column', async () => {
    const res = await setSecret(bob, PLAIN);
    expect(res.status).toBe(200);
    const item = await body(res);
    expect(item.cells[SECRET].value).toMatchObject({ set: true, updated_by: bobId });
    expect(item.cells[SECRET].text ?? '').toBe('');
    expect(JSON.stringify(item)).not.toContain(PLAIN);

    const [stored] = await t.db.select().from(secretValues).where(eq(secretValues.itemId, itemId));
    expect(stored!.ciphertext).not.toContain(PLAIN);
    const [cell] = await t.db
      .select()
      .from(cells)
      .where(and(eq(cells.itemId, itemId)));
    expect(cell!.textValue).toBeNull();
    expect(JSON.stringify(cell!.value)).not.toContain(PLAIN);

    // The generic cell write and item create never take a secret.
    expect((await as(admin).put(`/items/${itemId}/cells/${SECRET}`, { value: PLAIN })).status).toBe(422);
    const created = await as(admin).post(`/boards/${boardId}/items`, { name: 'x', cells: { [SECRET]: PLAIN } });
    expect(created.status).toBeGreaterThanOrEqual(400);

    // Clear (an existing value: the column asks for a fresh code first — on by default) and set again.
    const refused = await setSecret(admin, null);
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.code).toBe('secret_step_up_required');
    expect((await verify(admin, adminUri)).status).toBe(200);
    expect((await setSecret(admin, null)).status).toBe(200);
    expect(await t.db.select().from(secretValues).where(eq(secretValues.itemId, itemId))).toHaveLength(0);
    expect((await body(await as(admin).get(`/items/${itemId}`))).cells[SECRET]).toBeUndefined();
    expect((await setSecret(admin, PLAIN)).status).toBe(200);
    expect((await audits('secret.set')).length).toBe(2);
    expect((await audits('secret.cleared')).length).toBe(1);
  });

  // Prod ("the secret column doesn't let me enter a value"): setting an empty cell is an edit, never a
  // reveal — an editor without 2FA and without a fresh code sets it. Replacing / clearing asks for the code unless the
  // column's `change_requires_code` is off; then the same editor replaces and clears without one.
  it('an editor without 2FA sets an empty cell; replaces and clears only when the column asks for no code', async () => {
    const fresh = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'No 2FA' }))).id as string;
    const carolId = await userId(carol);
    const set = await setSecret(carol, 'first', fresh);
    expect(set.status).toBe(200);
    expect((await body(set)).cells[SECRET].value).toMatchObject({ set: true });
    // On (the default): replacing needs the code — Carol has no 2FA, so she cannot.
    const denied = await setSecret(carol, 'second', fresh);
    expect(denied.status).toBe(403);
    expect((await body(denied)).error.code).toBe('secret_two_factor_required');
    expect((await setSecret(carol, null, fresh)).status).toBe(403);
    await patchSettings({ change_requires_code: false });
    expect((await setSecret(carol, 'second', fresh)).status).toBe(200);
    // Carol cannot reveal (no 2FA); the stored value is the replaced one.
    expect((await reveal(carol, fresh)).status).toBe(403);
    const [stored] = await t.db.select().from(secretValues).where(eq(secretValues.itemId, fresh));
    const key = await accountDataKey(t.db as never, { SECRET_MASTER_KEY: MASTER, NODE_ENV: 'test' }, acmeId);
    expect(
      decryptSecret(key, { accountId: acmeId, itemId: fresh, columnId: stored!.columnId }, stored!.ciphertext),
    ).toBe('second');
    expect((await setSecret(carol, '', fresh)).status).toBe(200); // empty = clear
    expect((await body(await as(carol).get(`/items/${fresh}`))).cells[SECRET]).toBeUndefined();
    // Setting created no reveal grant for Carol.
    expect(await t.db.select().from(secretRevealGrants).where(eq(secretRevealGrants.userId, carolId))).toHaveLength(0);
    await patchSettings({ change_requires_code: true });
    await as(admin).del(`/items/${fresh}`);
  });

  // Product decision ("deleting a secret — a code, or anyone?", "replacing a value needs a code too, no?").
  it('replacing or clearing needs a fresh code (the reveal grant); setting an empty cell does not; audited', async () => {
    const dropBobGrants = () => t.db.delete(secretRevealGrants).where(eq(secretRevealGrants.userId, bobId));
    await dropBobGrants();
    const fresh = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Step-up' }))).id as string;
    const stored = async () => {
      const [row] = await t.db.select().from(secretValues).where(eq(secretValues.itemId, fresh));
      if (!row) return null;
      const key = await accountDataKey(t.db as never, { SECRET_MASTER_KEY: MASTER, NODE_ENV: 'test' }, acmeId);
      return decryptSecret(key, { accountId: acmeId, itemId: fresh, columnId: row.columnId }, row.ciphertext);
    };
    const auditsOfFresh = async (action: string) => (await audits(action)).filter((r) => r.targetId === fresh);

    // An empty cell: no code.
    expect((await setSecret(bob, 'first', fresh)).status).toBe(200);
    expect((await auditsOfFresh('secret.set'))[0]!.payload).toMatchObject({ replaced: false, step_up: false });
    // Replace and clear: refused without a fresh code, nothing changes.
    for (const next of ['second', null, '']) {
      const res = await setSecret(bob, next, fresh);
      expect(res.status).toBe(403);
      expect((await body(res)).error).toMatchObject({
        code: 'secret_step_up_required',
        details: { verify_minutes: 15 },
      });
    }
    expect(await stored()).toBe('first');
    // A fresh code (the reveal's step-up) → replace.
    expect((await verify(bob, bobUri)).status).toBe(200);
    expect((await setSecret(bob, 'second', fresh)).status).toBe(200);
    expect(await stored()).toBe('second');
    const sets = await auditsOfFresh('secret.set');
    expect(sets).toHaveLength(2);
    expect(sets.map((r) => (r.payload as Json).replaced).sort()).toEqual([false, true]);
    expect(JSON.stringify(sets)).not.toContain('second');
    // The grant runs out after the column's minutes → clearing asks again.
    await t.db
      .update(secretRevealGrants)
      .set({ verifiedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(secretRevealGrants.userId, bobId));
    expect((await body(await setSecret(bob, null, fresh))).error.code).toBe('secret_step_up_required');
    expect((await verify(bob, bobUri)).status).toBe(200);
    expect((await setSecret(bob, null, fresh)).status).toBe(200);
    expect(await stored()).toBeNull();
    expect((await auditsOfFresh('secret.cleared')).map((r) => r.payload)).toContainEqual(
      expect.objectContaining({ replaced: true, step_up: true }),
    );
    // Clearing an empty cell changes nothing and asks for nothing.
    await dropBobGrants();
    expect((await setSecret(bob, null, fresh)).status).toBe(200);

    // Edit rights come first: a person who may not edit the column gets "forbidden", never the code.
    expect((await setSecret(bob, 'again', fresh)).status).toBe(200);
    await t.db
      .update(columns)
      .set({ restrictedEdit: { users: [adminId], teams: [] } })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, SECRET)));
    expect((await body(await setSecret(bob, 'x', fresh))).error.code).toBe('forbidden');
    await t.db
      .update(columns)
      .set({ restrictedEdit: null })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, SECRET)));

    // API tokens: replacing needs the explicit secrets:read scope (a script's step-up); setting does not.
    const adminToken = (
      await body(await as(admin).post('/auth/tokens', { name: 'script', scopes: ['admin'], expires_in_days: 30 }))
    ).token as string;
    const viaToken = (value: string | null) =>
      t.app.request(`/api/v1${cellPath(fresh)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    const replaced = await viaToken('by-token');
    expect(replaced.status).toBe(403);
    expect((await body(replaced)).error.code).toBe('insufficient_scope');
    expect(await stored()).toBe('again');

    // The column's setting off: edit rights are enough again.
    await patchSettings({ change_requires_code: false });
    expect((await viaToken('by-token')).status).toBe(200);
    expect(await stored()).toBe('by-token');
    expect((await setSecret(bob, null, fresh)).status).toBe(200);
    expect((await auditsOfFresh('secret.cleared')).map((r) => r.payload)).toContainEqual(
      expect.objectContaining({ replaced: true, step_up: false }),
    );
    await patchSettings({ change_requires_code: true });
    await dropBobGrants();
    await as(admin).del(`/items/${fresh}`);
  });

  it('a 44-character base64 master key (the production form) is a valid key, with stray spaces too', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64');
    expect(b64).toHaveLength(44);
    for (const v of [b64, `${b64}\n`, ` ${b64} `])
      expect(masterKeyOf({ SECRET_MASTER_KEY: v, NODE_ENV: 'production' })).toHaveLength(32);
  });

  it('needs edit rights on the column', async () => {
    await t.db
      .update(columns)
      .set({ restrictedEdit: { users: [adminId], teams: [] } })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, SECRET)));
    const res = await setSecret(bob, 'other');
    expect(res.status).toBe(403);
    await t.db
      .update(columns)
      .set({ restrictedEdit: null })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, SECRET)));
  });
});

describe('reveal', () => {
  it('needs a fresh code; a wrong code is refused and audited; the value comes once, uncached, audited', async () => {
    const first = await reveal(bob);
    expect(first.status).toBe(403);
    expect((await body(first)).error).toMatchObject({
      code: 'secret_step_up_required',
      details: { verify_minutes: 15 },
    });
    expect((await body(await as(bob).get('/secrets/status'))).verified_at).toBeNull();

    const wrong = await as(bob).post('/secrets/verify', { code: '000000' });
    expect(wrong.status).toBe(422);
    expect((await body(wrong)).error.code).toBe('secret_code_invalid');
    expect((await audits('secret.verify_failed')).length).toBe(1);

    const ok = await verify(bob, bobUri);
    expect(ok.status).toBe(200);
    expect((await body(ok)).verified_at).toBeTruthy();
    const res = await reveal(bob);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await body(res)).toEqual({ value: PLAIN, reveal_seconds: 30, copy_allowed: true });
    const rows = await audits('secret.reveal');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: bobId, targetType: 'item', targetId: itemId });
    expect(JSON.stringify(rows[0])).not.toContain(PLAIN);

    expect((await as(bob).post(`${cellPath()}/copy`)).status).toBe(200);
    expect(await audits('secret.copy')).toHaveLength(1);

    // The admins' log, with filters.
    const log = await body(await as(admin).get(`/secrets/log?action=reveal&actor_id=${bobId}`));
    expect(log.total).toBe(1);
    expect(log.data[0]).toMatchObject({
      action: 'reveal',
      actor_id: bobId,
      board_id: boardId,
      board_name: 'Clients',
      item_name: 'Client site',
      column_title: 'Password',
      via_token: false,
    });
    expect((await body(await as(admin).get(`/secrets/log?board_id=${boardId}`))).total).toBeGreaterThan(3);
    expect((await body(await as(admin).get('/secrets/log?board_id=NOPE'))).total).toBe(0);
    expect((await as(bob).get('/secrets/log')).status).toBe(403);
  });

  it('the grant expires after the column’s verification minutes (and is per session)', async () => {
    await t.db
      .update(secretRevealGrants)
      .set({ verifiedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(secretRevealGrants.userId, bobId));
    expect((await body(await reveal(bob))).error.code).toBe('secret_step_up_required');
    await patchSettings({ verify_minutes: 30 });
    expect((await reveal(bob)).status).toBe(200);
    await patchSettings({ verify_minutes: 15 });
    expect((await reveal(bob)).status).toBe(403);
    expect((await verify(bob, bobUri)).status).toBe(200);
    expect((await reveal(bob)).status).toBe(200);
  });

  it('the column’s reveal seconds and copy setting reach the app; copy off is refused', async () => {
    await patchSettings({ reveal_seconds: 45, copy_allowed: false });
    expect(await body(await reveal(bob))).toMatchObject({ reveal_seconds: 45, copy_allowed: false });
    const copy = await as(bob).post(`${cellPath()}/copy`);
    expect(copy.status).toBe(403);
    await patchSettings({ reveal_seconds: 30, copy_allowed: true });
    // Out-of-range settings are refused.
    const bad = await as(admin).patch(`/boards/${boardId}/columns/${SECRET}`, {
      settings: { ...(await settingsOf()), reveal_seconds: 1 },
    });
    expect(bad.status).toBe(400);
  });

  it('the long-text setting is kept, and a value of several lines comes back exactly', async () => {
    expect((await settingsOf()).multiline).toBe(false);
    await patchSettings({ multiline: true });
    expect((await settingsOf()).multiline).toBe(true);
    const long = 'host: db.example\nuser: admin\npass: s3cr3t\n\n-- rotate monthly';
    await t.db.update(secretRevealGrants).set({ verifiedAt: new Date() }).where(eq(secretRevealGrants.userId, bobId));
    expect((await verify(bob, bobUri)).status).toBe(200);
    expect((await setSecret(bob, long)).status).toBe(200);
    expect((await body(await reveal(bob))).value).toBe(long);
    await setSecret(bob, PLAIN);
    await patchSettings({ multiline: false });
  });
});

describe('the permission matrix', () => {
  it('no 2FA → no reveal (the marker is still visible), and no step-up', async () => {
    const item = await body(await as(carol).get(`/items/${itemId}`));
    expect(item.cells[SECRET].value.set).toBe(true);
    const res = await reveal(carol);
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe('secret_two_factor_required');
    expect((await body(await as(carol).post('/secrets/verify', { code: '123456' }))).error.code).toBe(
      'secret_two_factor_required',
    );
    expect(await body(await as(carol).get('/secrets/status'))).toEqual({
      two_factor_enabled: false,
      verified_at: null,
    });
  });

  it('“only these people”: others with 2FA are refused, admins included', async () => {
    expect((await verify(admin, adminUri)).status).toBe(200);
    expect((await reveal(admin)).status).toBe(200);
    await patchSettings({ reveal_mode: 'people', reveal_user_ids: [bobId] });
    const res = await reveal(admin);
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('secret_reveal_not_allowed');
    expect((await reveal(bob)).status).toBe(200);
    await patchSettings({ reveal_mode: 'board_members', reveal_user_ids: [] });
  });

  it('a column hidden from someone does not exist for them; another account cannot see it', async () => {
    await t.db
      .update(columns)
      .set({ restrictedView: { users: [adminId], teams: [] } })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, SECRET)));
    expect((await reveal(bob)).status).toBe(404);
    expect((await setSecret(bob, 'x')).status).toBe(404);
    expect((await body(await as(bob).get(`/items/${itemId}`))).cells[SECRET]).toBeUndefined();
    await t.db
      .update(columns)
      .set({ restrictedView: null })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, SECRET)));
    // Bob in an account he is not in.
    const res = await t.api(bob, 'NOT-AN-ACCOUNT').post(`${cellPath()}/reveal`);
    expect([403, 404]).toContain(res.status);
  });

  it('S-85: minting a secrets:read token takes a fresh two-factor code (a stolen session alone cannot)', async () => {
    const adminUser = await userId(admin);
    await t.db.delete(secretRevealGrants).where(eq(secretRevealGrants.userId, adminUser));
    const refused = await as(admin).post('/auth/tokens', { name: 'x', scopes: ['secrets:read'], expires_in_days: 30 });
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.code).toBe('secret_step_up_required');
    // Other scopes: no code needed.
    expect((await as(admin).post('/auth/tokens', { name: 'y', scopes: ['boards:read'] })).status).toBe(201);
    expect((await verify(admin, adminUri)).status).toBe(200);
    expect(
      (await as(admin).post('/auth/tokens', { name: 'z', scopes: ['secrets:read'], expires_in_days: 30 })).status,
    ).toBe(201);
  });

  it('API tokens: only an explicit secrets:read (admins only, not implied by admin); never the step-up', async () => {
    expect(scopeAllows(['admin'], 'secrets:read')).toBe(false);
    expect(scopeAllows(['secrets:read'], 'secrets:read')).toBe(true);
    const mint = async (cookie: string, scopes: string[]) => {
      // S-85: minting secrets:read takes a fresh two-factor code (it stands in for one).
      if (cookie === admin && scopes.includes('secrets:read')) await verify(admin, adminUri);
      return as(cookie).post('/auth/tokens', { name: 'script', scopes, expires_in_days: 30 });
    };
    // A member cannot give a token the scope.
    expect((await mint(bob, ['secrets:read'])).status).toBe(403);
    const adminToken = (await body(await mint(admin, ['admin']))).token as string;
    const readerToken = (await body(await mint(admin, ['secrets:read', 'boards:read']))).token as string;
    const viaToken = (token: string, method: string, path: string, payload?: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      });

    const refused = await viaToken(adminToken, 'POST', `${cellPath()}/reveal`);
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.code).toBe('insufficient_scope');
    // The item through the API: the marker only.
    const item = await viaToken(adminToken, 'GET', `/items/${itemId}`);
    expect(await item.text()).not.toContain(PLAIN);
    // The step-up and the status are a person's session only.
    expect((await viaToken(adminToken, 'POST', '/secrets/verify', { code: '123456' })).status).toBe(403);

    const ok = await viaToken(readerToken, 'POST', `${cellPath()}/reveal`);
    expect(ok.status).toBe(200);
    expect((await body(ok)).value).toBe(PLAIN);
    const log = await body(await as(admin).get('/secrets/log?action=reveal'));
    expect(log.data[0]).toMatchObject({ via_token: true, actor_id: adminId });
  });

  it('the registry: its own writer (never PUT /cells, duplicate, bulk or import)', () => {
    expect(columnTypes.get('secret')?.engine).toBe('secret');
    expect(ownWriter(columnTypes.get('secret'))).toBe(true);
  });
});

describe('the admins’ alert', () => {
  it('more reveals in an hour than the threshold → one alert to the admins (0 = off)', async () => {
    await t.db.delete(auditLog).where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'secret.reveal')));
    await patchSettings({ alert_threshold: 0 });
    for (let i = 0; i < 3; i++) expect((await reveal(bob)).status).toBe(200);
    const none = await t.db.select().from(notifications).where(eq(notifications.type, 'secret_reveals'));
    expect(none).toHaveLength(0);

    await patchSettings({ alert_threshold: 3 });
    expect((await reveal(bob)).status).toBe(200); // the 4th this hour
    const alerts = await t.db.select().from(notifications).where(eq(notifications.type, 'secret_reveals'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ userId: adminId, actorId: bobId });
    expect(alerts[0]!.payload).toMatchObject({ count: 4, threshold: 3 });
    expect(await audits('secret.alert')).toHaveLength(1);
    // Not again within the hour.
    expect((await reveal(bob)).status).toBe(200);
    expect(await t.db.select().from(notifications).where(eq(notifications.type, 'secret_reveals'))).toHaveLength(1);
    await patchSettings({ alert_threshold: 10 });
  });
});

// Prod bug (found testing as a guest without 2FA on a shareable board): the guest changed the secret column's
// settings, replaced the value, and edited a column only the board's owner and one more person could edit.
describe('a guest without 2FA, settings, replace and the column edit restriction', () => {
  const PW = 'vault';
  let gus: string;
  let gusId: string;
  let shared: string;
  let item: string;
  const colPath = () => `/boards/${shared}/columns/${PW}`;
  const settingsHere = async () =>
    (await body(await as(admin).get(`/boards/${shared}`))).columns.find((c: Json) => c.id === PW).settings as Json;
  const storedHere = async (id = item) => {
    const [row] = await t.db.select().from(secretValues).where(eq(secretValues.itemId, id));
    if (!row) return null;
    const key = await accountDataKey(t.db as never, { SECRET_MASTER_KEY: MASTER, NODE_ENV: 'test' }, acmeId);
    return decryptSecret(key, { accountId: acmeId, itemId: id, columnId: row.columnId }, row.ciphertext);
  };
  const dropGrants = (id: string) => t.db.delete(secretRevealGrants).where(eq(secretRevealGrants.userId, id));
  const guestStructure = (on: boolean) =>
    as(admin).patch('/accounts/me', { settings: { permissions: { guests_edit_structure: on } } });

  beforeAll(async () => {
    await as(admin).post('/users/invite', { emails: ['gus@guest.test'], role: 'guest' });
    gus = await join('gus@guest.test');
    gusId = await userId(gus);
    shared = (
      await body(await as(admin).post('/boards', { name: 'Client vault', workspace_id: wsId, kind: 'shareable' }))
    ).id as string;
    expect((await as(admin).post(`/boards/${shared}/columns`, { id: PW, title: 'Vault', type: 'secret' })).status).toBe(
      201,
    );
    item = (await body(await as(admin).post(`/boards/${shared}/items`, { name: 'Client login' }))).id as string;
    expect((await setSecret(admin, 'original', item, PW)).status).toBe(200);
    // The guest is a plain subscriber; the board's set is "edit everything" (the default) → an editor.
    expect((await as(admin).put(`/boards/${shared}/members/${gusId}`, { role: 'subscriber' })).status).toBe(200);
    expect((await as(admin).put(`/boards/${shared}/members/${bobId}`, { role: 'subscriber' })).status).toBe(200);
    // guests change columns only when the account allows it — on here, so the secret's own guards
    // (code / 2FA, the edit restriction) are what refuses below.
    expect((await as(gus).patch(colPath(), { title: 'Vault (client)' })).status).toBe(403);
    expect((await guestStructure(true)).status).toBe(200);
  });
  afterAll(() => guestStructure(false));

  it('1. settings: any change needs a fresh code — a guest without 2FA never; renaming needs none', async () => {
    const before = await settingsHere();
    // The guest is an editor here, so column.update allows the rename …
    expect((await as(gus).patch(colPath(), { title: 'Vault (client)' })).status).toBe(200);
    // … but not a settings change: no 2FA, no code — whichever setting.
    for (const patch of [
      { change_requires_code: false },
      { reveal_mode: 'people', reveal_user_ids: [gusId] },
      { verify_minutes: 60 },
      { copy_allowed: false },
      { alert_threshold: 0 },
    ]) {
      const res = await as(gus).patch(colPath(), { settings: { ...before, ...patch } });
      expect(res.status).toBe(403);
      expect((await body(res)).error.code).toBe('secret_two_factor_required');
    }
    // Settings with a title together: refused as a whole (nothing renamed either).
    expect((await as(gus).patch(colPath(), { title: 'X', settings: { ...before, copy_allowed: false } })).status).toBe(
      403,
    );
    const after = await body(await as(admin).get(`/boards/${shared}`));
    expect(after.columns.find((c: Json) => c.id === PW)).toMatchObject({ title: 'Vault (client)', settings: before });

    // Where the normal rules forbid column changes (edit content only → a contributor), the guest cannot even rename.
    expect((await as(admin).put(`/boards/${shared}/permissions`, { permission_set: 'edit_content' })).status).toBe(200);
    const denied = await as(gus).patch(colPath(), { title: 'Nope' });
    expect(denied.status).toBe(403);
    expect((await body(denied)).error.message).toBe('role_ceiling');
    expect((await as(admin).put(`/boards/${shared}/permissions`, { permission_set: 'edit_everything' })).status).toBe(
      200,
    );

    // A member with 2FA and the board's rights: a code first, then it saves — audited (which settings, not values).
    await dropGrants(bobId);
    const ask = await as(bob).patch(colPath(), { settings: { ...before, copy_allowed: false } });
    expect(ask.status).toBe(403);
    expect((await body(ask)).error.code).toBe('secret_step_up_required');
    expect((await verify(bob, bobUri)).status).toBe(200);
    expect((await as(bob).patch(colPath(), { settings: { ...before, copy_allowed: false } })).status).toBe(200);
    expect(await settingsHere()).toMatchObject({ copy_allowed: false });
    const logged = (await audits('secret.settings')).filter((r) => (r.payload as Json).board_id === shared);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actorId: bobId });
    expect(logged[0]!.payload).toMatchObject({ column_key: PW, changed: ['copy_allowed'], via: 'session' });
    const log = await body(await as(admin).get(`/secrets/log?action=settings&board_id=${shared}`));
    expect(log.data[0]).toMatchObject({ action: 'settings', actor_id: bobId, board_id: shared });
    // The same settings again (the dialog saving only the description): no change → no code asked.
    await dropGrants(bobId);
    expect((await as(bob).patch(colPath(), { description: 'Logins', settings: await settingsHere() })).status).toBe(
      200,
    );
    // Admins too: the code, not the role, unlocks it.
    await dropGrants(adminId);
    expect((await body(await as(admin).patch(colPath(), { settings: before }))).error.code).toBe(
      'secret_step_up_required',
    );
    expect((await verify(admin, adminUri)).status).toBe(200);
    expect((await as(admin).patch(colPath(), { settings: before })).status).toBe(200);

    // API tokens: only with the explicit secrets:read scope (the step-up of a script).
    const mint = async (scopes: string[]) => {
      if (scopes.includes('secrets:read')) await verify(admin, adminUri); // S-85
      return (await body(await as(admin).post('/auth/tokens', { name: 'cfg', scopes, expires_in_days: 30 })))
        .token as string;
    };
    const viaToken = (token: string, settings: Json) =>
      t.app.request(`/api/v1${colPath()}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
    const plain = await viaToken(await mint(['admin']), { ...before, alert_threshold: 0 });
    expect(plain.status).toBe(403);
    expect((await body(plain)).error.code).toBe('insufficient_scope');
    expect(
      (await viaToken(await mint(['boards:write', 'secrets:read']), { ...before, alert_threshold: 0 })).status,
    ).toBe(200);
    expect(await settingsHere()).toMatchObject({ alert_threshold: 0 });

    // AI apps over MCP (and the assistant / agents, the same tool) cannot: no person, no code.
    const client = new Client({ name: 'bines-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${WEB_ORIGIN}/mcp`), {
        fetch: (url, init) => t.app.request(String(url instanceof Request ? url.url : url), init) as Promise<Response>,
        requestInit: { headers: { authorization: `Bearer ${await mint(['admin'])}` } },
      }),
    );
    const viaMcp = await client.callTool({
      name: 'update_column',
      arguments: { board_id: shared, column_id: PW, settings: { ...before, change_requires_code: false } },
    });
    await client.close();
    expect(viaMcp.isError).toBe(true);
    expect(await settingsHere()).toMatchObject({ change_requires_code: true, alert_threshold: 0 });
    expect((await viaToken(await mint(['boards:write', 'secrets:read']), before)).status).toBe(200);
  });

  it('2. a guest without 2FA cannot replace or clear the secret (and cannot turn the code off first)', async () => {
    for (const next of ['guest-was-here', null, '']) {
      const res = await setSecret(gus, next, item, PW);
      expect(res.status).toBe(403);
      expect((await body(res)).error.code).toBe('secret_two_factor_required');
    }
    expect(await storedHere()).toBe('original');
    expect((await reveal(gus, item, PW)).status).toBe(403);
    // The guest may still set an EMPTY cell (edit rights) — that reveals and replaces nothing.
    const empty = (await body(await as(admin).post(`/boards/${shared}/items`, { name: 'New login' }))).id as string;
    expect((await setSecret(gus, 'first', empty, PW)).status).toBe(200);
    expect((await setSecret(gus, 'second', empty, PW)).status).toBe(403);
    expect(await storedHere(empty)).toBe('first');
    // A member with 2FA and a fresh code still replaces.
    expect((await verify(bob, bobUri)).status).toBe(200);
    expect((await setSecret(bob, 'rotated', item, PW)).status).toBe(200);
    expect(await storedHere()).toBe('rotated');
  });

  it('3. "only these people edit": enforced for the guest on every write path, also when saved as a board owner', async () => {
    const NOTE = 'memo';
    await as(admin).post(`/boards/${shared}/columns`, { id: NOTE, title: 'Memo', type: 'text' });
    const empty = (await body(await as(admin).post(`/boards/${shared}/items`, { name: 'Restricted' }))).id as string;
    for (const key of [PW, NOTE])
      expect(
        (
          await as(admin).put(`/boards/${shared}/columns/${key}/restriction`, {
            kind: 'edit',
            users: [bobId],
            teams: [],
          })
        ).status,
      ).toBe(200);
    const guestTries = async () => {
      // The secret endpoint (an empty cell: no code involved, the restriction alone decides).
      const secret = await setSecret(gus, 'nope', empty, PW);
      expect(secret.status).toBe(403);
      expect((await body(secret)).error.message).toBe(`column_restricted:${PW}`);
      // PUT /cells, the bulk update and the board's columns as the guest sees them.
      expect((await as(gus).put(`/items/${empty}/cells/${NOTE}`, { value: 'x' })).status).toBe(403);
      const board = await body(await as(gus).get(`/boards/${shared}`));
      for (const key of [PW, NOTE])
        expect(board.columns.find((c: Json) => c.id === key)).toMatchObject({ restricted_edit: true });
      expect(await storedHere(empty)).toBeNull();
    };
    await guestTries();

    // A guest can no longer be made a board owner (05 §2) …
    const owner = await as(admin).put(`/boards/${shared}/members/${gusId}`, { role: 'owner' });
    expect(owner.status).toBe(422);
    expect((await body(owner)).error.message).toBe('board_owner_must_be_member');
    // … and one saved as owner before (old data) is not treated as an owner: the restriction still holds.
    await t.db
      .update(boardMembers)
      .set({ role: 'owner' })
      .where(and(eq(boardMembers.boardId, shared), eq(boardMembers.userId, gusId)));
    await guestTries();
    // Nor does it give them the owners' powers on the column (settings still need the code / 2FA).
    expect((await body(await as(gus).patch(colPath(), { settings: { change_requires_code: false } }))).error.code).toBe(
      'secret_two_factor_required',
    );
    await t.db
      .update(boardMembers)
      .set({ role: 'subscriber' })
      .where(and(eq(boardMembers.boardId, shared), eq(boardMembers.userId, gusId)));

    // The listed member and the admin (board owner) still edit.
    expect((await setSecret(bob, 'by-bob', empty, PW)).status).toBe(200);
    expect((await as(bob).put(`/items/${empty}/cells/${NOTE}`, { value: 'ok' })).status).toBe(200);
    expect((await as(admin).put(`/items/${empty}/cells/${NOTE}`, { value: 'ok too' })).status).toBe(200);
    expect(await storedHere(empty)).toBe('by-bob');
  });
});

// Prod bug after Release B (product owner: "I am the board's owner — how come I can't view the secret?"). The column was
// set to "only some people" with one other person listed. That list is the column's own rule and binds owners and
// admins too (by design since edd164c6); the column's view restriction is a different list, and owners / admins pass
// that one. An owner or admin can always put themselves back on the list (settings, with a fresh code).
describe('board owners and admins revealing', () => {
  const KEY = 'ownerpw';
  let own: string;
  let ownItem: string;
  const ownCol = () => `/boards/${own}/columns/${KEY}`;
  const ownSettings = async () =>
    (await body(await as(admin).get(`/boards/${own}`))).columns.find((c: Json) => c.id === KEY).settings as Json;
  const revealHere = (cookie: string) => reveal(cookie, ownItem, KEY);
  let carolId: string;
  const dropGrants = () => t.db.delete(secretRevealGrants).where(inArray(secretRevealGrants.userId, [adminId, bobId]));

  beforeAll(async () => {
    carolId = await userId(carol);
    // The admin creates the board (its owner) and makes Bob — a plain member, not an admin — an owner too.
    own = (await body(await as(admin).post('/boards', { name: 'Owners vault', workspace_id: wsId }))).id as string;
    expect((await as(admin).post(`/boards/${own}/columns`, { id: KEY, title: 'Login', type: 'secret' })).status).toBe(
      201,
    );
    ownItem = (await body(await as(admin).post(`/boards/${own}/items`, { name: 'Site' }))).id as string;
    expect((await setSecret(admin, PLAIN, ownItem, KEY)).status).toBe(200);
    expect((await as(admin).put(`/boards/${own}/members/${bobId}`, { role: 'owner' })).status).toBe(200);
    const board = await body(await as(bob).get(`/boards/${own}`));
    expect(board.capabilities['board.manage_permissions']).toBe(true); // Bob counts as an owner
  });

  it('default settings: the admin who owns the board and a member owner reveal with a fresh code', async () => {
    await dropGrants();
    for (const [cookie, uri] of [
      [admin, adminUri],
      [bob, bobUri],
    ] as const) {
      const first = await revealHere(cookie);
      expect((await body(first)).error.code).toBe('secret_step_up_required');
      expect((await verify(cookie, uri)).status).toBe(200);
      const res = await revealHere(cookie);
      expect(res.status).toBe(200);
      expect((await body(res)).value).toBe(PLAIN);
    }
  });

  it('the column view restriction: owners and admins pass it without being listed', async () => {
    await t.db
      .update(columns)
      .set({ restrictedView: { users: [carolId], teams: [] } })
      .where(and(eq(columns.boardId, own), eq(columns.key, KEY)));
    expect((await revealHere(admin)).status).toBe(200);
    expect((await revealHere(bob)).status).toBe(200);
    await t.db
      .update(columns)
      .set({ restrictedView: null })
      .where(and(eq(columns.boardId, own), eq(columns.key, KEY)));
  });

  it('"only some people" without them: owner and admin are refused (by design) and can add themselves back', async () => {
    expect((await verify(admin, adminUri)).status).toBe(200);
    const settings = { ...(await ownSettings()), reveal_mode: 'people', reveal_user_ids: [carolId] };
    expect((await as(admin).patch(ownCol(), { settings })).status).toBe(200);
    for (const cookie of [admin, bob]) {
      const res = await revealHere(cookie);
      expect(res.status).toBe(403);
      expect((await body(res)).error.message).toBe('secret_reveal_not_allowed');
    }
    // The member owner fixes it from the column settings (column.update + a fresh code) and reveals.
    expect((await verify(bob, bobUri)).status).toBe(200);
    const fixed = { ...(await ownSettings()), reveal_user_ids: [carolId, bobId] };
    expect((await as(bob).patch(ownCol(), { settings: fixed })).status).toBe(200);
    expect((await revealHere(bob)).status).toBe(200);
    expect((await revealHere(admin)).status).toBe(403);
    // The admin switches back to "everyone who sees the column".
    const open = { ...(await ownSettings()), reveal_mode: 'board_members', reveal_user_ids: [] };
    expect((await as(admin).patch(ownCol(), { settings: open })).status).toBe(200);
    expect((await revealHere(admin)).status).toBe(200);
  });
});

describe('never leaks', () => {
  it('CSV and XLSX exports', async () => {
    const csv = await as(admin).post(`/boards/${boardId}/export`, { format: 'csv' });
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain('Password'); // the column is there, empty
    expect(text).not.toContain(PLAIN);
    const xlsx = await as(admin).post(`/boards/${boardId}/export`, { format: 'xlsx' });
    expect(xlsx.status).toBe(200);
    const buf = Buffer.from(await xlsx.arrayBuffer());
    let all = '';
    for (let i = 0; buf.readUInt32LE(i) === 0x04034b50;) {
      const size = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      all += inflateRawSync(buf.subarray(i + 30 + nameLen, i + 30 + nameLen + size)).toString('utf8');
      i += 30 + nameLen + size;
    }
    expect(all).toContain('Password');
    expect(all).not.toContain(PLAIN);
  });

  it('search and filters', async () => {
    const found = await body(await as(admin).get(`/search?q=${encodeURIComponent(PLAIN)}`));
    expect(JSON.stringify(found)).not.toContain(itemId);
    const items = await body(await as(admin).get(`/boards/${boardId}/items`));
    expect(JSON.stringify(items)).not.toContain(PLAIN);
    // Empty / not empty works on the marker.
    const def = columnTypes.get('secret')!;
    expect(def.filterOperators).toEqual(['is_empty', 'is_not_empty']);
    expect(def.toText({ set: true, updated_at: '', updated_by: null }, {}, {})).toBe('');
  });

  it('MCP / AI tools', async () => {
    const token = (
      await body(await as(admin).post('/auth/tokens', { name: 'Claude', scopes: ['admin'], expires_in_days: 30 }))
    ).token as string;
    const client = new Client({ name: 'bines-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${WEB_ORIGIN}/mcp`), {
        fetch: (url, init) => t.app.request(String(url instanceof Request ? url.url : url), init) as Promise<Response>,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const outputs: string[] = [];
    for (const [name, args] of [
      ['get_board', { board_id: boardId }],
      ['get_item', { item_id: itemId }],
      ['query_items', { board_id: boardId }],
      ['search', { query: PLAIN }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      outputs.push(JSON.stringify(res));
    }
    await client.close();
    expect(outputs.join('\n')).toContain('Client site');
    expect(outputs.join('\n')).not.toContain(PLAIN);
  });

  it('webhooks (with the whole item) and automation variables', async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const parsed = raw ? (JSON.parse(raw) as Json) : {};
        hits.push(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(parsed.challenge ? JSON.stringify({ challenge: parsed.challenge }) : 'ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const hook = await as(admin).post(`/boards/${boardId}/webhooks`, {
        url: `${base}/any`,
        event: 'column_changed',
        config: { include_item: true },
      });
      expect(hook.status).toBe(201);
      // An automation that echoes the secret column's text and raw value into a notification.
      await t.db.insert(automations).values({
        id: newId(),
        accountId: acmeId,
        boardId,
        title: 'Echo',
        recipe: {
          trigger: { type: 'column_changed', column: TEXT },
          actions: [{ type: 'notify', to: '@board_owners', message: `S={item.${SECRET}} R={item.${SECRET}.raw}` }],
        } as never,
        isActive: true,
        ownerId: adminId,
        createdBy: adminId,
      });
      // The secret changes (no webhook event, no automation); then another column (both fire).
      await setSecret(admin, PLAIN);
      await as(admin).put(`/items/${itemId}/cells/${TEXT}`, { value: 'hello' });
      const seen = new Set<string>();
      for (let round = 0; round < 5; round++) {
        const rows = await t.db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(eq(activityLog.accountId, acmeId))
          .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
        const fresh = rows.filter((r) => !seen.has(r.id));
        if (!fresh.length) break;
        for (const r of fresh) {
          seen.add(r.id);
          for (const run of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, run);
        }
      }
      const deliveries = hits.filter((h) => !h.includes('"challenge"'));
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries.join('\n')).toContain('"set":true'); // the item's marker is there
      expect(deliveries.join('\n')).not.toContain(PLAIN);
      const notes = await t.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.itemId, itemId), eq(notifications.type, 'automation')));
      expect(notes.length).toBeGreaterThan(0);
      expect(JSON.stringify(notes)).not.toContain(PLAIN);
      expect(String((notes[0]!.payload as Json).excerpt)).toContain('S= R=');
      expect(webhookEventsOf({ type: 'secret.changed', sub: false } as never)).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('activity shows "changed" only; the change cannot be undone', async () => {
    const res = await setSecret(admin, PLAIN);
    expect((await body(res)).event_id).toBeNull();
    const activity = await body(await as(admin).get(`/boards/${boardId}/activity`));
    const rows = (activity.data as Json[]).filter((e) => e.type === 'secret.changed');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.before ?? null).toBeNull();
    expect(rows[0]!.after ?? null).toBeNull();
    expect(JSON.stringify(activity)).not.toContain(PLAIN);
    const undo = await as(admin).post(`/activity/${rows[0]!.id}/undo`, {});
    expect(undo.status).toBe(422);
  });

  it('duplicate item, duplicate board and templates do not copy it', async () => {
    const before = (await t.db.select().from(secretValues)).length;
    const copy = await body(await as(admin).post(`/items/${itemId}/duplicate`, {}));
    expect(copy.cells?.[SECRET]).toBeUndefined();
    const board = await body(await as(admin).post(`/boards/${boardId}/duplicate`, { mode: 'items', name: 'Copy' }));
    const copied = await body(await as(admin).get(`/boards/${board.id}/items`));
    expect((copied.data as Json[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(copied)).not.toContain('"set":true');
    const tpl = await as(admin).post(`/boards/${boardId}/save-as-template`, { name: 'T', with_items: true });
    expect(tpl.status).toBeLessThan(300);
    expect(JSON.stringify(await body(tpl))).not.toContain(PLAIN);
    expect((await t.db.select().from(secretValues)).length).toBe(before);
  });

  it('forms, mirror and formula', async () => {
    // a form may ask for a secret (written encrypted onto the new item only — secrets-oct27.test.ts).
    expect(formQuestionAllowed('secret')).toBe(true);
    expect(formUnsupportedReason('secret')).toBeNull();
    await as(admin).post(`/boards/${boardId}/columns`, {
      id: 'f',
      title: 'F',
      type: 'formula',
      settings: { formula: `CONCATENATE("x", {${SECRET}})` },
    });
    const other = (await body(await as(admin).post('/boards', { name: 'Projects', workspace_id: wsId }))).id;
    await as(admin).post(`/boards/${other}/columns`, {
      id: 'rel',
      title: 'Client',
      type: 'board_relation',
      settings: { board_ids: [boardId] },
    });
    const mirror = await as(admin).post(`/boards/${other}/columns`, {
      id: 'mir',
      title: 'Password',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: SECRET },
    });
    expect(mirror.status).toBe(201);
    await as(admin).post(`/boards/${other}/items`, { name: 'Prod', cells: { rel: { item_ids: [itemId] } } });
    const rows = JSON.stringify(await body(await as(admin).get(`/boards/${other}/items`)));
    const own = JSON.stringify(await body(await as(admin).get(`/boards/${boardId}/items`)));
    expect(rows).toContain('"Prod"');
    expect(rows).not.toContain(PLAIN);
    expect(own).not.toContain(PLAIN);
    // The formula sees nothing of the secret; the mirror shows nothing.
    const mine = (JSON.parse(own).data as Json[]).find((i) => i.id === itemId)!;
    expect(mine.cells.f?.text ?? 'x').toBe('x');
    expect(((JSON.parse(rows).data as Json[])[0]!.cells.mir?.text ?? '') as string).toBe('');
  });

  it('no table holds the value in the clear (scan of every table)', async () => {
    const tables = (
      await t.pg.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.table_name);
    expect(tables).toContain('secret_values');
    const hits: string[] = [];
    for (const name of tables) {
      const res = await t.pg.query<{ n: number }>(
        `select count(*)::int as n from "${name}" x where row_to_json(x)::text like $1`,
        [`%${PLAIN}%`],
      );
      if (res.rows[0]!.n) hits.push(name);
    }
    expect(hits).toEqual([]);
    // And the values are there, encrypted.
    expect((await t.db.select().from(secretValues)).length).toBeGreaterThan(0);
  });
});
