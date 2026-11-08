// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import { turnstile } from '../src/modules/forms/forms.turnstile';

/**
 * Turnstile in layers: the account's keys + master switch + "public forms" mode, each form's own
 * mode, and the platform's sign-in screens. Cloudflare is never called — `turnstile.verify` is mocked.
 */
let t: TestContext;
let owner: string;
let admin: string;
let vera: string;
let acmeId: string;
let viewId: string;
let token: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const inviteToken = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, inviteToken))!;
  await t.api(cookie).post('/invitations/accept', { token: inviteToken });
  return cookie;
};

let ipSeq = 0;
const nextIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const pub = (method: string, path: string, data?: unknown) =>
  t.app.request(`/api/v1/public/forms/${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      'x-forwarded-for': nextIp(),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const submit = (extra: Record<string, unknown> = {}) =>
  pub('POST', `${token}/submit`, { answers: { [NAME_Q]: 'פנייה' }, ...extra });
const NAME_Q = 'qname001';

const accountCaptcha = (patch?: Json) =>
  patch ? t.api(admin, acmeId).patch('/security/captcha', patch) : t.api(admin, acmeId).get('/security/captcha');
const saveForm = (patch: Json) => t.api(admin, acmeId).patch(`/views/${viewId}/form`, patch);

let verify: MockInstance<typeof turnstile.verify> | undefined;
const mockCloudflare = () => {
  verify = vi.spyOn(turnstile, 'verify').mockImplementation(async (_secret, tok) => tok === 'good');
};
afterEach(() => verify?.mockRestore());

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'member' });
  vera = await join('vera@acme.test');
  const api = t.api(admin, acmeId);
  const ws = (await body(await api.get('/workspaces'))).data[0].id;
  const board = await body(await api.post('/boards', { name: 'פניות', workspace_id: ws }));
  viewId = (await body(await api.post(`/boards/${board.id}/views`, { type: 'form', name: 'טופס' }))).id;
  const form = await body(await api.get(`/views/${viewId}/form`));
  token = form.token;
  expect(
    (await saveForm({ questions: [{ id: NAME_Q, column_key: 'name', label: 'שם', required: true }] })).status,
  ).toBe(200);
});
afterAll(() => t.close());

describe('account Turnstile (Administration → Security)', () => {
  it('starts off with no keys; admins only', async () => {
    const c = await body(await accountCaptcha());
    expect(c).toMatchObject({ enabled: false, site_key: '', secret_set: false, keys_ready: false });
    expect(c.surfaces).toEqual({ forms: 'inherit' });
    expect((await t.api(vera, acmeId).get('/security/captcha')).status).toBe(403);
    expect((await t.api(vera, acmeId).patch('/security/captcha', { enabled: true })).status).toBe(403);
  });

  it('cannot be switched on without both keys', async () => {
    const res = await accountCaptcha({ enabled: true });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toMatchObject({ code: 'invalid_value', message: 'captcha_keys_missing' });
    expect((await body(await accountCaptcha())).enabled).toBe(false);
    expect((await accountCaptcha({ surfaces: { forms: 'on' } })).status).toBe(422);
  });

  it('keeps the secret write-only and sealed; audits the change', async () => {
    const res = await accountCaptcha({ site_key: '0xACCOUNTSITE', secret: 'account-secret-value' });
    expect(res.status).toBe(200);
    const c = await body(res);
    expect(c).toMatchObject({ site_key: '0xACCOUNTSITE', secret_set: true, keys_ready: true, enabled: false });
    expect(JSON.stringify(c)).not.toContain('account-secret-value');
    const stored = (
      await t.db.execute<{ s: string }>(
        sql`select settings::text as s from account_settings where account_id = ${acmeId}`,
      )
    ).rows[0]!.s;
    expect(stored).not.toContain('account-secret-value');
    const audit = (
      await t.db.execute<{ p: string }>(
        sql`select payload::text as p from audit_log where account_id = ${acmeId} and action = 'security.captcha_changed'`,
      )
    ).rows;
    expect(audit.length).toBe(1);
    expect(audit[0]!.p).not.toContain('account-secret-value');
  });
});

describe('forms follow the account unless they choose', () => {
  it('account off + form inherit: no check', async () => {
    mockCloudflare();
    expect((await body(await pub('GET', token))).turnstile_site_key).toBeNull();
    expect((await submit()).status).toBe(200);
    expect(verify!).not.toHaveBeenCalled();
  });

  it('account on + form inherit: the check with the account keys (400 when missing or invalid)', async () => {
    expect((await accountCaptcha({ enabled: true })).status).toBe(200);
    const form = await body(await t.api(admin, acmeId).get(`/views/${viewId}/form`));
    expect(form.settings.captcha_mode).toBe('inherit');
    expect(form.account_captcha).toEqual({ keys_ready: true, inherited: true });
    mockCloudflare();
    expect((await body(await pub('GET', token))).turnstile_site_key).toBe('0xACCOUNTSITE');
    const missing = await submit();
    expect(missing.status).toBe(400);
    expect((await body(missing)).error.code).toBe('captcha_required');
    const bad = await submit({ turnstile_token: 'bad' });
    expect(bad.status).toBe(400);
    expect((await body(bad)).error.code).toBe('captcha_failed');
    expect((await submit({ turnstile_token: 'good' })).status).toBe(200);
    expect(verify!).toHaveBeenLastCalledWith('account-secret-value', 'good', expect.any(String));
  });

  it('form off overrides the account; honeypot still on', async () => {
    expect((await saveForm({ settings: { captcha_mode: 'off' } })).status).toBe(200);
    mockCloudflare();
    expect((await body(await pub('GET', token))).turnstile_site_key).toBeNull();
    expect((await submit()).status).toBe(200);
    // The honeypot answers ok and creates nothing — unchanged.
    expect((await submit({ website: 'spam.example' })).status).toBe(200);
    expect(verify!).not.toHaveBeenCalled();
  });

  it('account "public forms" off: inherit forms are not checked, an "on" form is', async () => {
    expect((await accountCaptcha({ surfaces: { forms: 'off' } })).status).toBe(200);
    expect((await saveForm({ settings: { captcha_mode: 'inherit' } })).status).toBe(200);
    mockCloudflare();
    expect((await submit()).status).toBe(200);
    expect((await saveForm({ settings: { captcha_mode: 'on' } })).status).toBe(200);
    expect((await body(await submit())).error.code).toBe('captcha_required');
    expect((await submit({ turnstile_token: 'good' })).status).toBe(200);
  });

  it('a form with its own keys uses them', async () => {
    expect(
      (await saveForm({ settings: { turnstile_site_key: '0xFORMSITE' }, turnstile_secret: 'form-secret' })).status,
    ).toBe(200);
    mockCloudflare();
    expect((await body(await pub('GET', token))).turnstile_site_key).toBe('0xFORMSITE');
    expect((await submit({ turnstile_token: 'good' })).status).toBe(200);
    expect(verify!).toHaveBeenLastCalledWith('form-secret', 'good', expect.any(String));
    await saveForm({ turnstile_secret: null, settings: { turnstile_site_key: '' } });
  });

  it('"on" cannot be chosen when neither the form nor the account has keys', async () => {
    await saveForm({ settings: { captcha_mode: 'inherit' } });
    expect((await accountCaptcha({ enabled: false, surfaces: { forms: 'inherit' } })).status).toBe(200);
    expect((await accountCaptcha({ secret: null })).status).toBe(200);
    const res = await saveForm({ settings: { captcha_mode: 'on' } });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toContain('captcha_keys_missing');
    // Switching the account on without keys is refused too.
    expect((await accountCaptcha({ enabled: true })).status).toBe(422);
  });

  it('a form saved before modes existed keeps "own keys = on" even with the account off', async () => {
    const sealed = t.deps.secrets.seal('legacy-secret');
    await t.db.execute(
      sql`update forms set settings = ${JSON.stringify({ turnstile_site_key: '0xLEGACY', turnstile_secret_sealed: sealed })}::jsonb where view_id = ${viewId}`,
    );
    mockCloudflare();
    expect((await body(await pub('GET', token))).turnstile_site_key).toBe('0xLEGACY');
    expect((await body(await submit())).error.code).toBe('captcha_required');
    expect((await submit({ turnstile_token: 'good' })).status).toBe(200);
    expect(verify!).toHaveBeenLastCalledWith('legacy-secret', 'good', expect.any(String));
    const form = await body(await t.api(admin, acmeId).get(`/views/${viewId}/form`));
    expect(form.settings.captcha_mode).toBe('on');
  });
});

describe('platform Turnstile (owner console): sign-in, sign-up, forgot password', () => {
  const ownerApi = () => t.api(owner);
  const signIn = (headers: Record<string, string> = {}) =>
    t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'x-forwarded-for': nextIp(), ...headers },
      body: JSON.stringify({ email: 'admin@acme.test', password: 'correct-horse-battery' }),
    });
  const forgot = (headers: Record<string, string> = {}) =>
    t.app.request('/api/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'x-forwarded-for': nextIp(), ...headers },
      body: JSON.stringify({ email: 'admin@acme.test' }),
    });

  it('owner only; off by default and the sign-in screen is told so', async () => {
    expect((await t.api(admin).get('/platform/captcha')).status).toBe(404);
    expect((await t.api(admin).patch('/platform/captcha', { enabled: true })).status).toBe(404);
    const c = await body(await ownerApi().get('/platform/captcha'));
    expect(c).toMatchObject({ enabled: false, keys_ready: false });
    expect(c.surfaces).toEqual({
      sign_in: 'inherit',
      sign_up: 'inherit',
      forgot_password: 'inherit',
      registration: 'inherit',
    });
    const cfg = await body(await t.api(undefined).get('/auth/config'));
    expect(cfg.captcha).toEqual({ site_key: null, sign_in: false, sign_up: false, forgot_password: false });
    expect((await signIn()).status).toBe(200);
    expect((await ownerApi().patch('/platform/captcha', { enabled: true })).status).toBe(422);
  });

  it('on: sign-in and forgot password need a valid token; a place set to off does not', async () => {
    const res = await ownerApi().patch('/platform/captcha', {
      site_key: '0xPLATFORM',
      secret: 'platform-secret',
      enabled: true,
      surfaces: { sign_up: 'off' },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await body(res))).not.toContain('platform-secret');
    const cfg = await body(await t.api(undefined).get('/auth/config'));
    expect(cfg.captcha).toEqual({ site_key: '0xPLATFORM', sign_in: true, sign_up: false, forgot_password: true });

    mockCloudflare();
    const missing = await signIn();
    expect(missing.status).toBe(400);
    expect((await body(missing)).error.code).toBe('captcha_required');
    expect((await body(await signIn({ 'x-captcha-token': 'bad' }))).error.code).toBe('captcha_failed');
    expect((await signIn({ 'x-captcha-token': 'good' })).status).toBe(200);
    expect(verify!).toHaveBeenLastCalledWith('platform-secret', 'good', expect.any(String));

    expect((await body(await forgot())).error.code).toBe('captcha_required');
    expect((await forgot({ 'x-captcha-token': 'good' })).status).toBe(200);

    // The sign-in screen is client-side: every SPA page may load Turnstile's script while it is on.
    const csp = (await t.app.request('/login')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain('https://challenges.cloudflare.com');

    // sign_up is off: the guard never asks (the invitation rules answer as before).
    const signUp = await t.signUpWithPassword('nobody@else.test');
    expect(await signUp.text()).not.toContain('captcha');
  });

  it('the sign-in right after a password reset needs no token: a one-use pass, same user only', async () => {
    mockCloudflare();
    const post = (path: string, data: Json, headers: Record<string, string> = {}) =>
      t.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'x-forwarded-for': nextIp(), ...headers },
        body: JSON.stringify(data),
      });
    expect(
      (await post('/api/v1/auth/forgot-password', { email: 'vera@acme.test' }, { 'x-captcha-token': 'good' })).status,
    ).toBe(200);
    const resetToken = /\/login#reset=([\w-]+)/.exec(t.lastMailTo('vera@acme.test').text)![1]!;
    const reset = await post('/api/auth/reset-password', { token: resetToken, newPassword: 'veras-new-password' });
    expect(reset.status).toBe(200);
    const pass = reset.headers.get('x-captcha-exempt');
    expect(pass).toMatch(/^[a-f0-9]{48}$/);
    const signInAs = (email: string, password: string, headers: Record<string, string>) =>
      post('/api/auth/sign-in/email', { email, password }, headers);

    // Not for someone else: the pass is spent and the check is asked for.
    const other = await signInAs('admin@acme.test', 'correct-horse-battery', { 'x-captcha-exempt': pass! });
    expect((await body(other)).error.code).toBe('captcha_required');
    // A fresh reset, then the same user signs in without a Turnstile token — once.
    expect(
      (await post('/api/v1/auth/forgot-password', { email: 'vera@acme.test' }, { 'x-captcha-token': 'good' })).status,
    ).toBe(200);
    const second = /\/login#reset=([\w-]+)/.exec(t.lastMailTo('vera@acme.test').text)![1]!;
    const again = await post('/api/auth/reset-password', { token: second, newPassword: 'veras-newer-password' });
    const pass2 = again.headers.get('x-captcha-exempt')!;
    expect((await signInAs('vera@acme.test', 'veras-newer-password', { 'x-captcha-exempt': pass2 })).status).toBe(200);
    const reused = await signInAs('vera@acme.test', 'veras-newer-password', { 'x-captcha-exempt': pass2 });
    expect((await body(reused)).error.code).toBe('captcha_required');
    // No pass is handed out while sign-in does not ask for Turnstile.
    expect(verify!).toHaveBeenCalledTimes(2);
  });

  it('off again: everything open', async () => {
    expect((await ownerApi().patch('/platform/captcha', { enabled: false })).status).toBe(200);
    mockCloudflare();
    expect((await signIn()).status).toBe(200);
    expect(verify!).not.toHaveBeenCalled();
    const csp = (await t.app.request('/login')).headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('https://challenges.cloudflare.com');
  });
});
