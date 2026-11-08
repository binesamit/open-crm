// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t as i18n, type MessageKey } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * ANSWERS 6א.3/4/8/9 — nothing branded or limited in code, everything a setting with a sensible default:
 * - owner console: product name (white-label), platform email sender, SMS sender, API-token budgets;
 * - account admin: email sender name / Reply-To / email logo, SMS sender, API budgets of its tokens;
 * - a token: its own budgets (the token dialog);
 * - emails in the recipient's language; server-written names in the account's language.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let enId: string;
let enAdmin: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const tr = (key: string, vars?: Record<string, string | number>, locale: 'he' | 'en' = 'he') =>
  i18n(key as MessageKey, vars, locale);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, account = acmeId) => t.api(cookie, account);
const withToken = (token: string, path: string) =>
  t.app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });

const upload = async (cookie: string, name: string, size: number, mime: string) => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, size, mime);
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  // S-46: custom senders apply at once here (sec2-senders.test.ts covers the owner's approval).
  await t.api(owner).patch('/platform/settings', { senders: { require_approval: false } });
  const create = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await create('Acme', 'acme', 'admin@acme.test');
  enId = await create('Globex', 'globex', 'admin@globex.test');
  admin = await join('admin@acme.test');
  enAdmin = await join('admin@globex.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  expect((await as(enAdmin, enId).patch('/accounts/me', { settings: { locale: { language: 'en' } } })).status).toBe(
    200,
  );
});
afterAll(() => t.close());

describe('platform settings (owner console)', () => {
  it('only the platform owner reads and changes them (404 to anyone else)', async () => {
    expect((await t.api(admin).get('/platform/settings')).status).toBe(404);
    expect((await t.api(admin).patch('/platform/settings', { product_name: 'X' })).status).toBe(404);
    const res = await t.api(owner).get('/platform/settings');
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(s.settings.api_limits).toEqual({
      token_per_minute: 600,
      service_token_per_minute: 1200,
      personal_daily: 10_000,
      service_daily: 50_000,
    });
    expect(s.settings.product_name).toBeUndefined();
    expect(s.fallbacks.product_name).toBe(tr('app.name'));
  });

  it('validates sane bounds and header-safe names; null goes back to the default', async () => {
    const bad = [
      { api_limits: { token_per_minute: 0 } },
      { api_limits: { personal_daily: 10_000_000 } },
      { email: { sender_name: 'a"b<c>' } },
      { email: { reply_to: 'not-an-email' } },
      { sms: { sender_id: 'way too long sender id' } },
    ];
    for (const patch of bad) expect((await t.api(owner).patch('/platform/settings', patch)).status).toBe(400);
    const saved = await body(
      await t.api(owner).patch('/platform/settings', {
        product_name: 'WorkHub',
        email: { sender_name: 'WorkHub Team', reply_to: 'help@workhub.test' },
        sms: { sender_id: 'WorkHub' },
      }),
    );
    expect(saved.settings).toMatchObject({
      product_name: 'WorkHub',
      email: { sender_name: 'WorkHub Team', reply_to: 'help@workhub.test' },
      sms: { sender_id: 'WorkHub' },
    });
    const cleared = await body(await t.api(owner).patch('/platform/settings', { email: { reply_to: null } }));
    expect(cleared.settings.email).toEqual({ sender_name: 'WorkHub Team' });
    expect(cleared.settings.product_name).toBe('WorkHub');
  });
});

describe('account email & SMS settings', () => {
  it('admins set the sender name, Reply-To and SMS sender; members cannot; bad values are refused', async () => {
    expect((await as(bob).patch('/accounts/me', { settings: { branding: { email_sender_name: 'Bob' } } })).status).toBe(
      403,
    );
    expect(
      (await as(admin).patch('/accounts/me', { settings: { branding: { email_sender_name: 'A\r\nBcc: x' } } })).status,
    ).toBe(400);
    const res = await as(admin).patch('/accounts/me', {
      settings: {
        branding: { email_sender_name: 'Acme Support', email_reply_to: 'support@acme.test' },
        sms: { sender_id: 'AcmeCo' },
      },
    });
    expect(res.status).toBe(200);
    const a = await body(res);
    expect(a.settings.branding).toMatchObject({
      email_sender_name: 'Acme Support',
      email_reply_to: 'support@acme.test',
    });
    expect(a.settings.sms).toMatchObject({ sender_id: 'AcmeCo' });
    // Admins see what an empty field falls back to (the owner's platform settings).
    expect(a.platform_defaults).toMatchObject({ product_name: 'WorkHub', sms_sender_id: 'WorkHub' });
    expect((await body(await as(bob).get('/accounts/me'))).platform_defaults ?? null).toBeNull();
  });

  it("an invitation goes out with the account's sender name and Reply-To, the platform's product name", async () => {
    await as(admin).post('/users/invite', { emails: ['carol@acme.test'], role: 'member' });
    const mail = t.lastMailTo('carol@acme.test');
    expect(mail).toMatchObject({ fromName: 'Acme Support', replyTo: 'support@acme.test' });
    expect(mail.subject).toBe(tr('mail.invite.subject', { account: 'Acme', product: 'WorkHub' }));
    expect(mail.html).toContain('dir="rtl"');
  });

  it("without a sender name: the account's name; the recipient's language decides the email's", async () => {
    await as(enAdmin, enId).post('/users/invite', { emails: ['dave@globex.test'], role: 'member' });
    const mail = t.lastMailTo('dave@globex.test');
    expect(mail.fromName).toBe('Globex');
    expect(mail.replyTo).toBeUndefined();
    // Not a user yet: the account's language (en).
    expect(mail.subject).toBe(tr('mail.invite.subject', { account: 'Globex', product: 'WorkHub' }, 'en'));
    expect(mail.html).toContain('dir="ltr"');
    // An existing user reads in their own language (he) even when invited by an English account.
    await as(enAdmin, enId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
    expect(t.lastMailTo('bob@acme.test').html).toContain('dir="rtl"');
  });

  it('the authenticator app shows the platform product name (white-label)', async () => {
    const res = await t.app.request('/api/auth/two-factor/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie: bob },
      body: JSON.stringify({ password: 'correct-horse-battery' }),
    });
    expect(res.status).toBe(200);
    expect((await body(res)).totpURI).toMatch(/^otpauth:\/\/totp\/WorkHub:bob%40acme\.test\?/);
  });

  it("sign-in emails (no account) carry the platform's sender name", async () => {
    await t.signInWithMagicLink('admin@acme.test');
    const mail = t.lastMailTo('admin@acme.test');
    expect(mail.fromName).toBe('WorkHub Team');
    expect(mail.subject).toBe(tr('mail.magic.subject', { product: 'WorkHub' }));
  });

  it('the email logo: an image the admin uploads, served by a public redirect; emails link it', async () => {
    expect((await t.api(undefined).get(`/public/email-logo/${acmeId}`)).status).toBe(404);
    const png = await upload(admin, 'mail-logo.png', 1500, 'image/png');
    expect((await as(bob).put('/accounts/me/email-logo', { file_id: png })).status).toBe(403);
    const svg = await upload(admin, 'mail-logo.svg', 300, 'image/svg+xml');
    expect((await as(admin).put('/accounts/me/email-logo', { file_id: svg })).status).toBe(422);
    const set = await as(admin).put('/accounts/me/email-logo', { file_id: png });
    expect(set.status).toBe(200);
    expect((await body(set)).email_logo_url).toContain('storage.test');
    const img = await t.api(undefined).get(`/public/email-logo/${acmeId}?v=${png}`);
    expect(img.status).toBe(302);
    expect(img.headers.get('location')).toContain('storage.test');
    await as(admin).post('/users/invite', { emails: ['erin@acme.test'], role: 'member' });
    expect(t.lastMailTo('erin@acme.test').html).toContain(`/api/v1/public/email-logo/${acmeId}?v=${png}`);
    const removed = await body(await as(admin).del('/accounts/me/email-logo'));
    expect(removed.email_logo_url).toBeNull();
    expect((await t.api(undefined).get(`/public/email-logo/${acmeId}`)).status).toBe(404);
  });

  it("the owner's SMS test goes out with the account's sender id, else the platform's", async () => {
    const send = (extra: Json = {}) =>
      t.api(owner).post('/platform/diagnostics/notify', { channel: 'sms', to: '0521234567', ...extra });
    expect((await send({ account_id: acmeId })).status).toBe(200);
    expect(t.sms.sent.at(-1)).toMatchObject({ senderId: 'AcmeCo' });
    expect((await send({ account_id: enId })).status).toBe(200);
    expect(t.sms.sent.at(-1)).toMatchObject({ senderId: 'WorkHub' });
    expect((await send()).status).toBe(200);
    expect(t.sms.sent.at(-1)).toMatchObject({ senderId: 'WorkHub' });
  });
});

describe('API token budgets', () => {
  const newToken = async (cookie: string, extra: Json = {}) => {
    const res = await as(cookie).post('/auth/tokens', { name: `t${Math.random()}`, scopes: ['boards:read'], ...extra });
    expect(res.status).toBe(201);
    return body(res);
  };
  const hit = async (token: string, n: number) => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) statuses.push((await withToken(token, '/workspaces')).status);
    return statuses;
  };

  it('platform default ← account override ← token override; headers show what applies', async () => {
    const plain = await newToken(bob);
    expect(plain.limits).toMatchObject({ per_minute: 600, daily: 10_000, default_per_minute: 600 });
    expect((await withToken(plain.token, '/workspaces')).headers.get('ratelimit-limit')).toBe('600');

    await t.api(owner).patch('/platform/settings', { api_limits: { token_per_minute: 500 } });
    const fromPlatform = await newToken(bob);
    expect(fromPlatform.limits.per_minute).toBe(500);

    expect((await as(bob).patch('/accounts/me', { settings: { api_limits: { token_per_minute: 3 } } })).status).toBe(
      403,
    );
    const acc = await as(admin).patch('/accounts/me', { settings: { api_limits: { token_per_minute: 3 } } });
    expect(acc.status).toBe(200);
    const limited = await newToken(bob);
    expect(limited.limits).toMatchObject({ per_minute: 3, default_per_minute: 3 });
    expect(await hit(limited.token, 4)).toEqual([200, 200, 200, 429]);

    // Back to the platform's when the account clears its own.
    await as(admin).patch('/accounts/me', { settings: { api_limits: { token_per_minute: null } } });
    expect((await newToken(bob)).limits.per_minute).toBe(500);
  });

  it('a token sets its own budget; a member never above the account default, an admin within the bounds', async () => {
    await as(admin).patch('/accounts/me', { settings: { api_limits: { token_per_minute: 50, personal_daily: 100 } } });
    expect(
      (await as(bob).post('/auth/tokens', { name: 'x', scopes: ['boards:read'], rate_limit_per_minute: 51 })).status,
    ).toBe(403);
    const own = await newToken(bob, { rate_limit_per_minute: 2, daily_quota: 5 });
    expect(own).toMatchObject({ rate_limit_per_minute: 2, daily_quota: 5, limits: { per_minute: 2, daily: 5 } });
    expect(await hit(own.token, 3)).toEqual([200, 200, 429]);

    // PATCH: the owner lowers / clears; raising above the account's default is for admins.
    expect((await as(bob).patch(`/auth/tokens/${own.id}`, { daily_quota: 101 })).status).toBe(403);
    expect((await as(bob).patch(`/auth/tokens/${own.id}`, { rate_limit_per_minute: 0 })).status).toBe(400);
    const cleared = await body(await as(bob).patch(`/auth/tokens/${own.id}`, { rate_limit_per_minute: null }));
    expect(cleared).toMatchObject({ rate_limit_per_minute: null, limits: { per_minute: 50, daily: 5 } });
    const raised = await as(admin).patch(`/auth/tokens/${own.id}`, { rate_limit_per_minute: 5000 });
    expect(raised.status).toBe(200);
    expect((await body(raised)).limits.per_minute).toBe(5000);
    expect((await as(admin).patch(`/auth/tokens/${own.id}`, { rate_limit_per_minute: 50_000 })).status).toBe(400);
    // Someone else's token is not there for a member.
    const admins = await newToken(admin);
    expect((await as(bob).patch(`/auth/tokens/${admins.id}`, { rate_limit_per_minute: 1 })).status).toBe(404);
  });

  it('the daily quota is the account default unless the token has its own', async () => {
    await as(admin).patch('/accounts/me', { settings: { api_limits: { token_per_minute: null, personal_daily: 2 } } });
    const daily = await newToken(bob);
    expect(daily.limits.daily).toBe(2);
    const statuses = await hit(daily.token, 3);
    expect(statuses).toEqual([200, 200, 429]);
    await as(admin).patch('/accounts/me', { settings: { api_limits: { personal_daily: null } } });
  });
});

describe("server-written names follow the account's language", () => {
  it('a new board, its group and name column, a duplicate and a sub-board — in English for an English account', async () => {
    const ws = (await body(await as(enAdmin, enId).get('/workspaces'))).data[0].id;
    expect(ws).toBeTruthy();
    const [workspace] = (await body(await as(enAdmin, enId).get('/workspaces'))).data;
    // The first workspace was named when the account was created - before it switched to English.
    expect(workspace.name).toBe(tr('server.mainWorkspace', undefined, 'he'));
    const board = await body(await as(enAdmin, enId).post('/boards', { workspace_id: ws }));
    expect(board.name).toBe(tr('server.newBoard', undefined, 'en'));
    expect(board.groups.map((g: Json) => g.title)).toEqual([tr('server.newGroup', undefined, 'en')]);
    expect(board.columns.find((c: Json) => c.id === 'name').title).toBe(tr('server.nameColumn', undefined, 'en'));
    const copy = await body(await as(enAdmin, enId).post(`/boards/${board.id}/duplicate`, { mode: 'structure' }));
    expect(copy.name).toBe(tr('server.boardCopy', { name: board.name }, 'en'));
    // Hebrew (the default) for the Hebrew account.
    const heWs = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const heBoard = await body(await as(admin).post('/boards', { workspace_id: heWs }));
    expect(heBoard.name).toBe(tr('server.newBoard'));
  });
});
