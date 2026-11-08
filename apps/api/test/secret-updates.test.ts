// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, notifications, secretRevealGrants, secretUpdateBodies, updates } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Secret updates: an update / reply whose text is encrypted like a secret column's value. Writing
 * (2FA, the board's settings, no files), the reveal with the two-factor step-up and its audit, replies in a secret
 * thread, edit / delete with a fresh code, the account's default and a board's override (subitems follow it) — and
 * every path the text could leak through, ending with a scan of every table.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery'; // helpers.signUpWithPassword
const PLAIN = 'Wifi-Pa55-QZX-9917';
const MASTER = 'b2'.repeat(32);

let t: TestContext;
let acmeId: string;
let admin: string;
let bob: string;
let carol: string;
let adminUri: string;
let bobUri: string;
let bobId: string;
let carolId: string;
let boardId: string;
let itemId: string;

// ---- TOTP (RFC 6238), as in secrets.test.ts ----
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
const verify = (cookie: string, uri: string) => as(cookie).post('/secrets/verify', { code: totp(uri) });
/** Every grant is old: the next reveal / change needs a fresh code again. */
const expireGrants = () => t.db.update(secretRevealGrants).set({ verifiedAt: new Date(Date.now() - 61 * 60_000) });
const post = (cookie: string, text: string, opts: Json = {}, item = itemId) =>
  as(cookie).post(`/items/${item}/updates`, { body: text, ...opts });
const reveal = (cookie: string, id: string) => as(cookie).post(`/updates/${id}/reveal`);
const errOf = async (res: Response) => (await body(res)).error as Json;
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
  bobId = await userId(bob);
  carolId = await userId(carol);
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Client office' }))).id;
});
afterAll(() => t.close());

describe('writing', () => {
  it('stores the text encrypted; the thread shows only a locked update; audited without the text', async () => {
    const res = await post(bob, `${PLAIN} @here`, { secret: true });
    expect(res.status).toBe(200);
    const dto = await body(res);
    expect(dto).toMatchObject({ secret: true, body_html: '', body_text: '', body_json: null, files: [] });
    const row = (await t.db.select().from(updates).where(eq(updates.id, dto.id)))[0]!;
    expect(row).toMatchObject({ isSecret: true, bodyHtml: '', bodyText: '', bodyJson: null });
    const sealed = (await t.db.select().from(secretUpdateBodies).where(eq(secretUpdateBodies.updateId, dto.id)))[0]!;
    expect(sealed.ciphertext).not.toContain(PLAIN);
    const thread = await body(await as(carol).get(`/items/${itemId}/updates`));
    expect(thread.data[0]).toMatchObject({ id: dto.id, secret: true, body_text: '' });
    expect(JSON.stringify(thread)).not.toContain(PLAIN);
    const set = await audits('secret.set');
    expect(set).toHaveLength(1);
    expect(set[0]!.payload).toMatchObject({ update_id: dto.id, kind: 'update', replaced: false });
    expect(JSON.stringify(set)).not.toContain(PLAIN);
  });

  it('needs 2FA (else the writer could not read it back); no files; a plain update stays plain', async () => {
    const no2fa = await post(carol, 'x', { secret: true });
    expect(no2fa.status).toBe(403);
    expect((await errOf(no2fa)).code).toBe('secret_two_factor_required');
    const files = await post(bob, 'x', { secret: true, file_ids: ['01HZZZZZZZZZZZZZZZZZZZZZZZ'] });
    expect(files.status).toBe(422);
    const plain = await body(await post(carol, 'just a note'));
    expect(plain).toMatchObject({ secret: false, body_text: 'just a note' });
  });
});

describe('reveal', () => {
  it('needs a fresh code; the text comes once, uncached, audited; copy is audited; the admins’ log names the update', async () => {
    const id = (await body(await post(bob, PLAIN, { secret: true }))).id as string;
    await expireGrants();
    const first = await reveal(bob, id);
    expect(first.status).toBe(403);
    expect((await errOf(first)).code).toBe('secret_step_up_required');
    expect((await verify(bob, bobUri)).status).toBe(200);
    const res = await reveal(bob, id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await body(res)).toMatchObject({ body_text: PLAIN, reveal_seconds: 30, copy_allowed: true });
    // S-86: an Idempotency-Key never keeps the revealed text (the scan of every table below would find it).
    const keyed = await as(bob).call('POST', `/updates/${id}/reveal`, {}, { 'idempotency-key': 'reveal-once-1' });
    expect((await body(keyed)).body_text).toBe(PLAIN);
    expect((await as(bob).post(`/updates/${id}/secret-copy`)).status).toBe(200);
    const reveals = await audits('secret.reveal');
    expect(reveals.at(-1)!.payload).toMatchObject({ update_id: id, kind: 'update' });
    expect(JSON.stringify(reveals)).not.toContain(PLAIN);
    expect(await audits('secret.copy')).toHaveLength(1);
    const log = await body(await as(admin).get(`/secrets/log?action=reveal&actor_id=${bobId}`));
    expect(log.data[0]).toMatchObject({ update_id: id, item_name: 'Client office', column_title: null });
  });

  it('someone without 2FA sees the locked update but cannot reveal it; a plain update cannot be "revealed"', async () => {
    const id = (await body(await post(bob, PLAIN, { secret: true }))).id as string;
    const res = await reveal(carol, id);
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe('secret_two_factor_required');
    const plain = (await body(await post(bob, 'hello'))).id as string;
    expect((await reveal(bob, plain)).status).toBe(404);
  });

  it('API tokens: only an explicit secrets:read reveals', async () => {
    const id = (await body(await post(bob, PLAIN, { secret: true }))).id as string;
    expect((await verify(admin, adminUri)).status).toBe(200);
    const plainToken = (
      await body(await as(admin).post('/auth/tokens', { name: 'plain', scopes: ['admin'], expires_in_days: 30 }))
    ).token as string;
    const viaToken = (token: string) =>
      t.app.request(`/api/v1/updates/${id}/reveal`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    const refused = await viaToken(plainToken);
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).code).toBe('insufficient_scope');
    const readToken = (
      await body(
        await as(admin).post('/auth/tokens', {
          name: 'reader',
          scopes: ['secrets:read', 'boards:read'],
          expires_in_days: 30,
        }),
      )
    ).token as string;
    const ok = await viaToken(readToken);
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    expect((await body(ok)).body_text).toBe(PLAIN);
  });
});

describe('threads', () => {
  it('a reply in a secret thread is secret (also a reply to a reply); a secret reply under a plain update', async () => {
    const top = (await body(await post(bob, PLAIN, { secret: true }))).id as string;
    const reply = await body(await as(admin).post(`/updates/${top}/replies`, { body: 'reply text QQ1' }));
    expect(reply).toMatchObject({ secret: true, body_text: '', parent_update_id: top });
    const deeper = await body(await as(bob).post(`/updates/${reply.id}/replies`, { body: 'deeper QQ2' }));
    expect(deeper.secret).toBe(true);
    // Someone without 2FA cannot answer inside a secret thread (they could not read it either).
    const carolReply = await as(carol).post(`/updates/${top}/replies`, { body: 'no' });
    expect(carolReply.status).toBe(403);

    const plain = (await body(await post(carol, 'plain top'))).id as string;
    const secretReply = await body(await as(bob).post(`/updates/${plain}/replies`, { body: PLAIN, secret: true }));
    expect(secretReply).toMatchObject({ secret: true, parent_update_id: plain });
    const normalReply = await body(await as(carol).post(`/updates/${plain}/replies`, { body: 'normal' }));
    expect(normalReply.secret).toBe(false);
    await verify(bob, bobUri);
    expect((await body(await reveal(bob, reply.id))).body_text).toBe('reply text QQ1');
  });
});

describe('edit and delete', () => {
  it('the author edits with a fresh code; others cannot; no files; the event and the audit hold no text', async () => {
    const id = (await body(await post(bob, 'old text ZZ', { secret: true }))).id as string;
    await expireGrants();
    const blocked = await as(bob).patch(`/updates/${id}`, { body: PLAIN });
    expect(blocked.status).toBe(403);
    expect((await errOf(blocked)).code).toBe('secret_step_up_required');
    await verify(bob, bobUri);
    const edited = await as(bob).patch(`/updates/${id}`, { body: PLAIN });
    expect(edited.status).toBe(200);
    expect(await body(edited)).toMatchObject({ secret: true, body_text: '' });
    expect((await body(await reveal(bob, id))).body_text).toBe(PLAIN);
    expect((await as(admin).patch(`/updates/${id}`, { body: 'x' })).status).toBe(403);
    expect((await as(bob).patch(`/updates/${id}`, { file_ids: ['01HZZZZZZZZZZZZZZZZZZZZZZZ'] })).status).toBe(422);
    const activity = await body(await as(admin).get(`/items/${itemId}/activity`));
    const ev = (activity.data as Json[]).find((e) => e.type === 'update.edited')!;
    expect(ev.before).toEqual({ update_id: id, secret: true });
    expect(JSON.stringify(activity)).not.toContain('old text ZZ');
  });

  it('deleting takes a fresh code; the trash shows only the lock; restored, it reveals again', async () => {
    const id = (await body(await post(bob, PLAIN, { secret: true }))).id as string;
    await expireGrants();
    const blocked = await as(bob).del(`/updates/${id}`);
    expect(blocked.status).toBe(403);
    await verify(bob, bobUri);
    expect((await as(bob).del(`/updates/${id}`)).status).toBe(200);
    expect((await audits('secret.cleared')).at(-1)!.payload).toMatchObject({ update_id: id, kind: 'update' });
    const trash = await body(await as(bob).get('/trash'));
    const entry = (trash.data as Json[]).find((e) => e.object_id === id || e.id === id || e.name === '🔒')!;
    expect(entry).toBeTruthy();
    expect(JSON.stringify(trash)).not.toContain(PLAIN);
    expect((await as(bob).post(`/trash/${entry.id}/restore`, {})).status).toBeLessThan(300);
    expect((await body(await reveal(bob, id))).body_text).toBe(PLAIN);
  });

  it('“changing needs a code” off: edit and delete without a fresh code', async () => {
    await verify(admin, adminUri);
    const put = await as(admin).put(`/boards/${boardId}/secret-updates`, {
      settings: { change_requires_code: false },
    });
    expect(put.status).toBe(200);
    const id = (await body(await post(bob, 'aa', { secret: true }))).id as string;
    await expireGrants();
    expect((await as(bob).patch(`/updates/${id}`, { body: 'bb' })).status).toBe(200);
    expect((await as(bob).del(`/updates/${id}`)).status).toBe(200);
    await verify(admin, adminUri);
    expect((await as(admin).put(`/boards/${boardId}/secret-updates`, { settings: null })).status).toBe(200);
  });
});

describe('settings', () => {
  it('the account default: admins only, with a fresh code; off = no new secret updates, old ones still reveal', async () => {
    const old = (await body(await post(bob, PLAIN, { secret: true }))).id as string;
    const current = (await body(await as(admin).get('/secrets/update-settings'))).settings as Json;
    expect(current).toMatchObject({ enabled: true, reveal_seconds: 30, verify_minutes: 15, copy_allowed: true });
    expect((await as(bob).get('/secrets/update-settings')).status).toBe(403);
    await expireGrants();
    const blocked = await as(admin).put('/secrets/update-settings', { settings: { ...current, enabled: false } });
    expect(blocked.status).toBe(403);
    expect((await errOf(blocked)).code).toBe('secret_step_up_required');
    await verify(admin, adminUri);
    expect((await as(admin).put('/secrets/update-settings', { settings: { ...current, enabled: false } })).status).toBe(
      200,
    );
    const off = await post(bob, 'x', { secret: true });
    expect(off.status).toBe(403);
    expect((await errOf(off)).message ?? '').toContain('secret_updates_off');
    await verify(bob, bobUri);
    expect((await body(await reveal(bob, old))).body_text).toBe(PLAIN);
    // The board's own override switches it back on for that board only.
    const board = await body(
      await as(admin).put(`/boards/${boardId}/secret-updates`, { settings: { ...current, enabled: true } }),
    );
    expect(board).toMatchObject({ effective: { enabled: true }, account: { enabled: false }, can_manage: true });
    expect((await post(bob, 'on here', { secret: true })).status).toBe(200);
    await verify(admin, adminUri);
    await as(admin).put(`/boards/${boardId}/secret-updates`, { settings: null });
    await as(admin).put('/secrets/update-settings', { settings: current });
    const audit = await audits('secret.settings');
    expect(audit.some((r) => (r.payload as Json).scope === 'account')).toBe(true);
    expect(audit.some((r) => (r.payload as Json).scope === 'board')).toBe(true);
  });

  it('a board override: owners / admins only; "only these people" refuses others; subitems follow the board', async () => {
    const mine = await body(await as(bob).get(`/boards/${boardId}/secret-updates`));
    expect(mine).toMatchObject({ board: null, can_manage: false, effective: { enabled: true } });
    expect((await as(bob).put(`/boards/${boardId}/secret-updates`, { settings: null })).status).toBe(403);
    await verify(admin, adminUri);
    const adminId = await userId(admin);
    const set = await as(admin).put(`/boards/${boardId}/secret-updates`, {
      settings: { reveal_mode: 'people', reveal_user_ids: [adminId], reveal_seconds: 10 },
    });
    expect(set.status).toBe(200);
    const id = (await body(await post(bob, PLAIN, { secret: true }))).id as string;
    await verify(bob, bobUri);
    const refused = await reveal(bob, id);
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).message ?? '').toContain('secret_reveal_not_allowed');
    const ok = await body(await reveal(admin, id));
    expect(ok).toMatchObject({ body_text: PLAIN, reveal_seconds: 10 });

    const sub = await body(await as(admin).post(`/items/${itemId}/subitems`, { name: 'Sub' }));
    const subBoard = sub.board_id as string;
    const viaSub = await body(await as(bob).get(`/boards/${subBoard}/secret-updates`));
    expect(viaSub.effective).toMatchObject({ reveal_mode: 'people', reveal_seconds: 10 });
    const subUpdate = (await body(await post(bob, PLAIN, { secret: true }, sub.id))).id as string;
    expect((await reveal(bob, subUpdate)).status).toBe(403);
    expect((await body(await reveal(admin, subUpdate))).body_text).toBe(PLAIN);
    await verify(admin, adminUri);
    expect((await as(admin).put(`/boards/${boardId}/secret-updates`, { settings: null })).status).toBe(200);
  });
});

describe('never leaks', () => {
  it('search, notifications, activity, duplicate, the personal export and AI / MCP', async () => {
    const id = (await body(await post(bob, `${PLAIN} [@Carol](user:${carolId})`, { secret: true }))).id as string;
    expect(JSON.stringify(await body(await as(admin).get(`/search?q=${encodeURIComponent(PLAIN)}`)))).not.toContain(id);
    const bell = await t.db.select().from(notifications).where(eq(notifications.userId, carolId));
    expect(bell.length).toBeGreaterThan(0);
    expect(JSON.stringify(bell)).not.toContain(PLAIN);
    expect(JSON.stringify(await body(await as(admin).get(`/boards/${boardId}/activity`)))).not.toContain(PLAIN);
    const copy = await body(await as(admin).post(`/items/${itemId}/duplicate`, { with_updates: true }));
    const copied = await body(await as(admin).get(`/items/${copy.id}/updates`));
    expect((copied.data as Json[]).some((u) => u.secret)).toBe(false);
    const mine = await (await t.api(bob).get('/me/export')).text();
    expect(mine).toContain('🔒');
    expect(mine).not.toContain(PLAIN);
    const token = (
      await body(await as(admin).post('/auth/tokens', { name: 'AI', scopes: ['admin'], expires_in_days: 30 }))
    ).token as string;
    const viaApi = await t.app.request(`/api/v1/items/${itemId}/updates`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaApi.status).toBe(200);
    expect(JSON.stringify(await body(viaApi))).not.toContain(PLAIN);
  });

  it('no table holds the text in the clear (scan of every table)', async () => {
    const tables = (
      await t.pg.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.table_name);
    expect(tables).toContain('secret_update_bodies');
    const hits: string[] = [];
    for (const name of tables) {
      const res = await t.pg.query<{ n: number }>(
        `select count(*)::int as n from "${name}" x where row_to_json(x)::text like $1`,
        [`%${PLAIN}%`],
      );
      if (res.rows[0]!.n) hits.push(name);
    }
    expect(hits).toEqual([]);
    expect((await t.db.select().from(secretUpdateBodies)).length).toBeGreaterThan(0);
  });
});
