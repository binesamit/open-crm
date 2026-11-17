// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * M8 ד12 — two-factor authentication (D25): enrolment with an authenticator app + backup codes, the code step after
 * every way in (password, magic link, recovery link), "trust this device", the account policy with its grace period,
 * the admin reset and the audit log; plus the IP allowlist and its self-lockout guard.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
let ids: Record<string, string>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery'; // helpers.signUpWithPassword

// ---- TOTP (RFC 6238), computed here from the secret in the otpauth:// URI ----
const base32 = (s: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
const totp = (uri: string, offset = 0) => {
  const secret = base32(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
};

const cookiesOf = (res: Response) =>
  Object.fromEntries(
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .map((c) => [c.slice(0, c.indexOf('=')), c] as const)
      .filter(([, c]) => !c.endsWith('=')),
  );
const authCall = (path: string, payload: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(payload),
  });
const signIn = (email: string, cookie?: string) => authCall('/sign-in/email', { email, password: PASSWORD }, cookie);
const me = async (cookie: string | undefined) => t.api(cookie).get('/auth/me');
const as = (cookie: string) => t.api(cookie, acmeId);
const audits = (action: string, accountId = acmeId) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action)));

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const invite = async (email: string, role = 'member') => {
  await as(admin).post('/users/invite', { emails: [email], role });
  return join(email);
};

/** Turns 2FA on for a signed-in person: enable (password when they have one) → first code. */
const enroll = async (cookie: string, password: string | undefined = PASSWORD) => {
  const res = await authCall('/two-factor/enable', password ? { password } : {}, cookie);
  expect(res.status).toBe(200);
  const { totpURI, backupCodes } = await body(res);
  const verify = await authCall('/two-factor/verify-totp', { code: totp(totpURI) }, cookie);
  expect(verify.status).toBe(200);
  // Enrolment replaces the session: the new cookie is the one to use.
  const next = cookiesOf(verify)['bos.session_token'] ?? cookie;
  return { uri: totpURI as string, backupCodes: backupCodes as string[], cookie: next };
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const created = await body(
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'empty',
    }),
  );
  acmeId = created.account.id;
  admin = await join('admin@acme.test');
  await t.api(owner).post('/platform/accounts', {
    name: 'Other',
    slug: 'other',
    first_admin_email: 'boss@other.test',
    template_set: 'empty',
  });
  await join('boss@other.test');
});
afterAll(() => t.close());

const refreshIds = async () => {
  const list = (await body(await as(admin).get('/users'))).data as Json[];
  ids = Object.fromEntries(list.map((u) => [u.email, u.user_id]));
  return list;
};

describe('enrolment', () => {
  it('a password user turns it on with the password and a first code; 10 backup codes; audited', async () => {
    const bob = await invite('bob@acme.test');
    expect((await body(await t.api(bob).get('/me/security'))).two_factor).toEqual({
      enabled: false,
      required: false,
      deadline: null,
      must_enroll: false,
    });
    // The password is required for someone who has one.
    expect((await authCall('/two-factor/enable', {}, bob)).status).toBe(400);
    const res = await authCall('/two-factor/enable', { password: PASSWORD }, bob);
    const { totpURI, backupCodes } = await body(res);
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Bines%20OS:bob%40acme\.test\?secret=/);
    expect(backupCodes).toHaveLength(10);
    // Not on until the first code is right.
    expect((await body(await t.api(bob).get('/me/security'))).two_factor.enabled).toBe(false);
    expect((await authCall('/two-factor/verify-totp', { code: '000000' }, bob)).status).toBe(401);
    const verify = await authCall('/two-factor/verify-totp', { code: totp(totpURI) }, bob);
    expect(verify.status).toBe(200);
    const cookie = cookiesOf(verify)['bos.session_token']!;
    expect((await body(await t.api(cookie).get('/me/security'))).two_factor.enabled).toBe(true);
    expect((await body(await me(cookie))).user.two_factor.enabled).toBe(true);
    expect((await audits('auth.2fa.enabled')).length).toBe(1);
    // Admins see who has it.
    const list = await refreshIds();
    expect(list.find((u) => u.email === 'bob@acme.test')!.two_factor_enabled).toBe(true);
    expect(list.find((u) => u.email === 'admin@acme.test')!.two_factor_enabled).toBe(false);
  });

  it('someone who signs in by link only turns it on without a password', async () => {
    await as(admin).post('/users/invite', { emails: ['carol@acme.test'], role: 'member' });
    const token = t.inviteTokenFor('carol@acme.test');
    const carol = (await t.signInWithMagicLink('carol@acme.test')).cookie!;
    await t.api(carol).post('/invitations/accept', { token });
    const { cookie } = await enroll(carol, undefined);
    expect((await body(await t.api(cookie).get('/me/security'))).two_factor.enabled).toBe(true);
  });
});

describe('signing in with a second factor', () => {
  let uri: string;
  let backup: string[];
  beforeAll(async () => {
    const dan = await invite('dan@acme.test');
    ({ uri, backupCodes: backup } = await enroll(dan));
    await refreshIds();
  });

  it('password → code step (no session yet) → wrong code refused and audited → right code signs in', async () => {
    const res = await signIn('dan@acme.test');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    const jar = cookiesOf(res);
    expect(jar['bos.session_token']).toBeUndefined();
    const challenge = jar['bos.two_factor']!;
    expect(challenge).toBeDefined();
    expect((await me(challenge)).status).toBe(401);

    const wrong = await authCall('/two-factor/verify-totp', { code: '123456' }, challenge);
    expect(wrong.status).toBe(401);
    expect((await audits('auth.2fa.failed')).some((a) => a.targetId === ids['dan@acme.test'])).toBe(true);

    const ok = await authCall('/two-factor/verify-totp', { code: totp(uri) }, challenge);
    expect(ok.status).toBe(200);
    const session = cookiesOf(ok)['bos.session_token']!;
    expect((await me(session)).status).toBe(200);
    const verified = (await audits('auth.2fa.verified')).filter((a) => a.targetId === ids['dan@acme.test']);
    expect(verified.length).toBeGreaterThan(0);
  });

  it('"trust this device" skips the code next time on this device only', async () => {
    const challenge = cookiesOf(await signIn('dan@acme.test'))['bos.two_factor']!;
    const ok = await authCall('/two-factor/verify-totp', { code: totp(uri), trustDevice: true }, challenge);
    const trust = cookiesOf(ok)['bos.trust_device']!;
    expect(trust).toBeDefined();
    const again = await signIn('dan@acme.test', trust);
    expect((await body(again)).twoFactorRedirect).toBeUndefined();
    expect(cookiesOf(again)['bos.session_token']).toBeDefined();
    // Another device (no cookie) still gets the code step.
    expect((await body(await signIn('dan@acme.test'))).twoFactorRedirect).toBe(true);
  });

  it('a backup code signs in once', async () => {
    const challenge = cookiesOf(await signIn('dan@acme.test'))['bos.two_factor']!;
    const ok = await authCall('/two-factor/verify-backup-code', { code: backup[0] }, challenge);
    expect(ok.status).toBe(200);
    expect(cookiesOf(ok)['bos.session_token']).toBeDefined();
    expect((await audits('auth.2fa.backup_code_used')).length).toBeGreaterThan(0);
    const next = cookiesOf(await signIn('dan@acme.test'))['bos.two_factor']!;
    expect((await authCall('/two-factor/verify-backup-code', { code: backup[0] }, next)).status).toBe(401);
    expect((await authCall('/two-factor/verify-backup-code', { code: backup[1] }, next)).status).toBe(200);
  });

  it('the magic link does not skip it: no session, the code step on /login', async () => {
    const res = (await t.signInWithMagicLink('dan@acme.test')).res;
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toBe(`${WEB_ORIGIN}/login?two_factor=1`);
    const jar = cookiesOf(res);
    // Whatever session cookie the link set is no longer a session.
    expect((await me(jar['bos.session_token'])).status).toBe(401);
    const ok = await authCall('/two-factor/verify-totp', { code: totp(uri) }, jar['bos.two_factor']);
    expect(ok.status).toBe(200);
    expect((await me(cookiesOf(ok)['bos.session_token'])).status).toBe(200);
  });

  it('the recovery link (new password) still asks for the code', async () => {
    await refreshIds();
    const link = await body(await as(admin).post(`/users/${ids['dan@acme.test']}/recovery-link`));
    const token = /#reset=([\w-]+)$/.exec(link.url)![1]!;
    expect((await authCall('/reset-password', { newPassword: 'another-good-password', token })).status).toBe(200);
    const res = await authCall('/sign-in/email', { email: 'dan@acme.test', password: 'another-good-password' });
    expect((await body(res)).twoFactorRedirect).toBe(true);
  });
});

describe('the account policy', () => {
  let erin: string;
  beforeAll(async () => {
    // The admin setting the policy is covered by it too: they have 2FA already here.
    admin = (await enroll(admin)).cookie;
    erin = await invite('erin@acme.test');
  });
  afterAll(async () => {
    await as(admin).patch('/security', { two_factor: { mode: 'optional' } });
  });

  it('required for everyone with no grace: the account answers 403 until enrolment; /auth/me says must_enroll', async () => {
    const res = await as(admin).patch('/security', { two_factor: { mode: 'required_all', grace_days: 0 } });
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(s.two_factor.mode).toBe('required_all');
    expect(s.two_factor.required_since).toBeTruthy();
    expect((await audits('auth.2fa.policy_changed')).length).toBe(1);

    const blocked = await as(erin).get('/accounts/me');
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error.message).toBe('two_factor_required');
    expect((await body(await me(erin))).user.two_factor).toMatchObject({ required: true, must_enroll: true });
    // Outside the account (profile, enrolment) still works.
    expect((await t.api(erin).get('/me/security')).status).toBe(200);
    const { cookie } = await enroll(erin);
    erin = cookie;
    expect((await as(erin).get('/accounts/me')).status).toBe(200);
    // Turning it off is refused while the account requires it.
    const off = await authCall('/two-factor/disable', { password: PASSWORD }, erin);
    expect(off.status).toBe(403);
    expect((await body(off)).message).toBe('two_factor_required_by_policy');
  });

  it('a grace period: required, with a deadline, not yet enforced', async () => {
    await as(admin).patch('/security', { two_factor: { mode: 'optional' } });
    await as(admin).patch('/security', { two_factor: { mode: 'required_all', grace_days: 7 } });
    const fred = await invite('fred@acme.test');
    const state = (await body(await me(fred))).user.two_factor;
    expect(state.required).toBe(true);
    expect(state.must_enroll).toBe(false);
    expect(Date.parse(state.deadline) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect((await as(fred).get('/accounts/me')).status).toBe(200);
  });

  it('required for admins only: members are not asked; an admin without it is', async () => {
    await as(admin).patch('/security', { two_factor: { mode: 'optional' } });
    await as(admin).patch('/security', { two_factor: { mode: 'required_admins', grace_days: 0 } });
    const gina = await invite('gina@acme.test');
    expect((await body(await me(gina))).user.two_factor.required).toBe(false);
    expect((await as(gina).get('/accounts/me')).status).toBe(200);
    let kim = await invite('kim@acme.test', 'admin');
    expect((await body(await me(kim))).user.two_factor.must_enroll).toBe(true);
    expect((await as(kim).get('/accounts/me')).status).toBe(403);
    kim = (await enroll(kim)).cookie;
    expect((await as(kim).get('/accounts/me')).status).toBe(200);
  });
});

describe('admin reset', () => {
  it('turns a member’s 2FA off — audited; then the password alone signs in', async () => {
    const hank = await invite('hank@acme.test');
    await enroll(hank);
    await refreshIds();
    expect((await body(await signIn('hank@acme.test'))).twoFactorRedirect).toBe(true);
    const res = await as(admin).post(`/users/${ids['hank@acme.test']}/reset-2fa`);
    expect(res.status).toBe(200);
    const rows = await audits('auth.2fa.reset');
    expect(rows.at(-1)).toMatchObject({ targetId: ids['hank@acme.test'], actorId: ids['admin@acme.test'] });
    const again = await signIn('hank@acme.test');
    expect((await body(again)).twoFactorRedirect).toBeUndefined();
    expect(cookiesOf(again)['bos.session_token']).toBeDefined();
    // Nothing left to reset.
    expect((await as(admin).post(`/users/${ids['hank@acme.test']}/reset-2fa`)).status).toBe(409);
  });

  it('never yourself, never by a member, never someone active in another account', async () => {
    await refreshIds();
    expect((await as(admin).post(`/users/${ids['admin@acme.test']}/reset-2fa`)).status).toBe(403);
    const ivy = await invite('ivy@acme.test');
    expect((await as(ivy).post(`/users/${ids['admin@acme.test']}/reset-2fa`)).status).toBe(403);
    // boss@other.test joins acme too: their factor guards the other account as well.
    const otherAdmin = await body(await t.api(owner).get('/platform/accounts'));
    expect(otherAdmin.data.length).toBeGreaterThan(1);
    await as(admin).post('/users/invite', { emails: ['boss@other.test'], role: 'member' });
    const bossCookie = t.cookieFrom(await signIn('boss@other.test'))!;
    await t.api(bossCookie).post('/invitations/accept', { token: t.inviteTokenFor('boss@other.test') });
    await enroll(bossCookie);
    await refreshIds();
    const res = await as(admin).post(`/users/${ids['boss@other.test']}/reset-2fa`);
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('member_of_other_accounts');
  });

  it('never the platform owner, unless it is them', async () => {
    await as(admin).post('/users/invite', { emails: [OWNER_EMAIL], role: 'member' });
    await t.api(owner).post('/invitations/accept', { token: t.inviteTokenFor(OWNER_EMAIL) });
    await refreshIds();
    const res = await as(admin).post(`/users/${ids[OWNER_EMAIL]}/reset-2fa`);
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('platform_owner');
  });
});

describe('IP allowlist', () => {
  const from = (cookie: string, ip?: string) => {
    const api = as(cookie);
    const headers: Record<string, string> = ip ? { 'x-forwarded-for': ip } : {};
    return {
      get: (path: string) => api.call('GET', path, undefined, headers),
      patch: (path: string, b: unknown) => api.call('PATCH', path, b, headers),
    };
  };
  let member: string;
  beforeAll(async () => {
    member = await invite('jack@acme.test');
  });
  afterAll(async () => {
    await from(admin, '203.0.113.5').patch('/security', { ip_allowlist: { enabled: false } });
  });

  it('off by default; GET /security shows my address', async () => {
    const s = await body(await from(admin, '203.0.113.5').get('/security'));
    expect(s.ip_allowlist).toEqual({ enabled: false, ranges: [], exempt_user_ids: [] });
    expect(s.current_ip).toBe('203.0.113.5');
  });

  it('cannot be saved on without the saver’s own address (no self-lockout)', async () => {
    const out = await from(admin, '203.0.113.5').patch('/security', {
      ip_allowlist: { enabled: true, ranges: ['198.51.100.0/24'] },
    });
    expect(out.status).toBe(422);
    expect((await body(out)).error.message).toBe('ip_allowlist_excludes_you');
    const empty = await from(admin, '203.0.113.5').patch('/security', { ip_allowlist: { enabled: true, ranges: [] } });
    expect(empty.status).toBe(422);
    const unknown = await from(admin).patch('/security', {
      ip_allowlist: { enabled: true, ranges: ['203.0.113.0/24'] },
    });
    expect(unknown.status).toBe(422);
    expect((await body(unknown)).error.message).toBe('ip_unknown');
    // Invalid ranges are a 400.
    expect(
      (await from(admin, '203.0.113.5').patch('/security', { ip_allowlist: { ranges: ['not-an-ip'] } })).status,
    ).toBe(400);
  });

  it('on: only from the listed addresses; a refusal is audited; IPv6 ranges work', async () => {
    const res = await from(admin, '203.0.113.5').patch('/security', {
      ip_allowlist: { enabled: true, ranges: ['203.0.113.0/24', '2001:db8::/32'] },
    });
    expect(res.status).toBe(200);
    expect((await audits('security.ip_allowlist_changed')).length).toBe(1);
    expect((await from(member, '203.0.113.77').get('/accounts/me')).status).toBe(200);
    expect((await from(member, '2001:db8::1').get('/accounts/me')).status).toBe(200);
    const blocked = await from(member, '198.51.100.7').get('/accounts/me');
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error.message).toBe('ip_not_allowed');
    expect((await from(member).get('/accounts/me')).status).toBe(403);
    const rows = await audits('security.ip_blocked');
    expect(rows.some((r) => (r.payload as Json).ip === '198.51.100.7')).toBe(true);
    // Repeats within minutes do not flood the log.
    await from(member, '198.51.100.7').get('/accounts/me');
    expect((await audits('security.ip_blocked')).filter((r) => (r.payload as Json).ip === '198.51.100.7').length).toBe(
      1,
    );
    // The platform owner is the way back in.
    expect((await from(owner, '198.51.100.7').get('/accounts/me')).status).toBe(200);
  });
});
