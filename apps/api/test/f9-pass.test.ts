// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * The minimum password length is a setting (product owner: "הסיסמה לא צריכה להיות עם 10 תווים, שתהיה עד 8
 * תווים"): the platform owner's default (8), an account's own override (6–64, empty = the platform's), the strictest
 * of a person's accounts for their own password, and passwords already set keep working.
 */
let t: TestContext;
let owner: string;
let acmeId: string;
let otherId: string;
let admin: string;
let otherAdmin: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const auth = (path: string, payload: unknown, opts: { cookie?: string; headers?: Record<string, string> } = {}) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: WEB_ORIGIN,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(payload),
  });
const signUp = (email: string, password: string) =>
  auth(
    '/sign-up/email',
    { email, password, name: email.split('@')[0] },
    { headers: { 'x-invite-token': t.inviteTokenFor(email) } },
  );
const signIn = (email: string, password: string) => auth('/sign-in/email', { email, password });
const as = (cookie: string, accountId: string) => t.api(cookie, accountId);

/** Invited by `inviter` into `accountId`, signs up with `password` and joins. */
const join = async (inviterCookie: string, accountId: string, email: string, password: string) => {
  await as(inviterCookie, accountId).post('/users/invite', { emails: [email], role: 'member' });
  const token = t.inviteTokenFor(email);
  const res = await signUp(email, password);
  expect(res.status).toBe(200);
  const cookie = t.cookieFrom(res)!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const make = async (slug: string, email: string) => {
    const created = await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: slug, slug, first_admin_email: email, template_set: 'empty' }),
    );
    const id = created.account.id as string;
    const token = t.inviteTokenFor(email);
    const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
    await t.api(cookie).post('/invitations/accept', { token });
    return { id, cookie };
  };
  ({ id: acmeId, cookie: admin } = await make('acme', 'admin@acme.test'));
  ({ id: otherId, cookie: otherAdmin } = await make('other', 'admin@other.test'));
});
afterAll(() => t.close());

describe('the platform default (8)', () => {
  it('is public, shown on the invitation, and 8 is accepted while 7 is refused', async () => {
    expect((await body(await t.api(undefined).get('/auth/config'))).password_min_length).toBe(8);
    await as(admin, acmeId).post('/users/invite', { emails: ['eight@acme.test'], role: 'member' });
    const token = t.inviteTokenFor('eight@acme.test');
    expect((await body(await t.api(undefined).post('/invitations/preview', { token }))).password_min_length).toBe(8);

    const short = await signUp('eight@acme.test', '1234567');
    expect(short.status).toBe(400);
    expect(await body(short)).toMatchObject({ code: 'PASSWORD_TOO_SHORT', message: 'password_min_length' });
    const ok = await signUp('eight@acme.test', '12345678');
    expect(ok.status).toBe(200);
    expect((await signIn('eight@acme.test', '12345678')).status).toBe(200);
  });

  it('a first password in the profile follows it too', async () => {
    await as(admin, acmeId).post('/users/invite', { emails: ['link@acme.test'], role: 'member' });
    const cookie = (await t.signInWithMagicLink('link@acme.test')).cookie!;
    const inv = (await body(await t.api(cookie).get('/me/invitations'))).data[0];
    await t.api(cookie).post(`/me/invitations/${inv.id}/accept`);
    expect((await body(await t.api(cookie).get('/me/security'))).password_min_length).toBe(8);
    const short = await t.api(cookie).post('/me/password', { new_password: '1234567' });
    expect(short.status).toBe(422);
    expect((await body(short)).error).toMatchObject({ message: 'password_min_length', details: { min_length: 8 } });
    expect((await t.api(cookie).post('/me/password', { new_password: '12345678' })).status).toBe(200);
  });
});

describe("an account's own minimum", () => {
  let carol: string;
  beforeAll(async () => {
    carol = await join(admin, acmeId, 'carol@acme.test', 'carol-pass-1');
  });

  it('only admins set it, within 6–64; null = back to the platform default', async () => {
    expect((await as(carol, acmeId).patch('/security', { password_min_length: 12 })).status).toBe(403);
    expect((await as(admin, acmeId).patch('/security', { password_min_length: 5 })).status).toBe(400);
    expect((await as(admin, acmeId).patch('/security', { password_min_length: 65 })).status).toBe(400);
    const saved = await body(await as(admin, acmeId).patch('/security', { password_min_length: 12 }));
    expect(saved).toMatchObject({ password_min_length: 12, platform_password_min_length: 8 });
    expect((await body(await as(admin, acmeId).get('/security'))).password_min_length).toBe(12);
  });

  it('applies on password change (12 enforced), and the old password keeps working', async () => {
    // Set before the rule: 12 characters, still signs in.
    expect((await signIn('carol@acme.test', 'carol-pass-1')).status).toBe(200);
    expect((await body(await t.api(carol).get('/me/security'))).password_min_length).toBe(12);
    const short = await auth(
      '/change-password',
      { currentPassword: 'carol-pass-1', newPassword: '12345678901' },
      { cookie: carol },
    );
    expect(short.status).toBe(400);
    expect(await body(short)).toMatchObject({ code: 'PASSWORD_TOO_SHORT', min_length: 12 });
    const ok = await auth(
      '/change-password',
      { currentPassword: 'carol-pass-1', newPassword: '123456789012' },
      { cookie: carol },
    );
    expect(ok.status).toBe(200);
    expect((await signIn('carol@acme.test', '123456789012')).status).toBe(200);
  });

  it('applies on reset and on the invitation sign-up of that account', async () => {
    expect((await t.api(undefined).post('/auth/forgot-password', { email: 'carol@acme.test' })).status).toBe(200);
    const token = /\/login#reset=([\w-]+)/.exec(t.lastMailTo('carol@acme.test').text)![1]!;
    expect((await body(await t.api(undefined).post('/auth/recovery/preview', { token }))).password_min_length).toBe(12);
    expect((await auth('/reset-password', { token, newPassword: '1234567890' })).status).toBe(400);
    expect((await auth('/reset-password', { token, newPassword: 'reset-pass-12' })).status).toBe(200);

    await as(admin, acmeId).post('/users/invite', { emails: ['dave@acme.test'], role: 'member' });
    expect((await signUp('dave@acme.test', '12345678901')).status).toBe(400);
    expect((await signUp('dave@acme.test', '123456789012')).status).toBe(200);
  });

  it('someone in several accounts gets the strictest of them', async () => {
    // Erin joins "other" (no own setting → 8), then acme (12).
    const erin = await join(otherAdmin, otherId, 'erin@other.test', 'erin-pass');
    expect((await body(await t.api(erin).get('/me/security'))).password_min_length).toBe(8);
    await as(admin, acmeId).post('/users/invite', { emails: ['erin@other.test'], role: 'member' });
    const inv = (await body(await t.api(erin).get('/me/invitations'))).data[0];
    expect((await t.api(erin).post(`/me/invitations/${inv.id}/accept`)).status).toBe(200);
    expect((await body(await t.api(erin).get('/me/security'))).password_min_length).toBe(12);
    expect(
      (await auth('/change-password', { currentPassword: 'erin-pass', newPassword: 'ten-chars!' }, { cookie: erin }))
        .status,
    ).toBe(400);
  });

  it('cleared, the account follows the platform default again', async () => {
    const res = await body(await as(admin, acmeId).patch('/security', { password_min_length: null }));
    expect(res.password_min_length).toBeNull();
    // (Carol's sessions ended with the reset; the admin is in acme only.)
    expect((await body(await t.api(admin).get('/me/security'))).password_min_length).toBe(8);
  });
});

describe('the platform owner changes the default', () => {
  it('applies to every account without its own, shown everywhere', async () => {
    // Not the owner: the platform routes do not exist for them.
    expect((await t.api(admin).patch('/platform/settings', { password: { min_length: 10 } })).status).toBe(404);
    expect((await t.api(owner).patch('/platform/settings', { password: { min_length: 5 } })).status).toBe(400);
    const saved = await body(await t.api(owner).patch('/platform/settings', { password: { min_length: 10 } }));
    expect(saved.settings.password).toEqual({ min_length: 10 });
    expect((await body(await t.api(undefined).get('/auth/config'))).password_min_length).toBe(10);
    expect((await body(await as(admin, acmeId).get('/security'))).platform_password_min_length).toBe(10);

    await as(admin, acmeId).post('/users/invite', { emails: ['frank@acme.test'], role: 'member' });
    expect((await signUp('frank@acme.test', '123456789')).status).toBe(400);
    expect((await signUp('frank@acme.test', '1234567890')).status).toBe(200);
    // Passwords chosen under the old default keep working.
    expect((await signIn('eight@acme.test', '12345678')).status).toBe(200);

    // An account's own setting may also be lower than the platform's.
    await as(otherAdmin, otherId).patch('/security', { password_min_length: 6 });
    await as(otherAdmin, otherId).post('/users/invite', { emails: ['gil@other.test'], role: 'member' });
    expect((await signUp('gil@other.test', '123456')).status).toBe(200);
  });
});
