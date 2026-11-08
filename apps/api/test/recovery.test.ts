// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Signing in without email (fix8, product owner: "מה הגיבוי שלי אם המיילים לא עובדים לי להתחברות?"): invitation links to
 * copy, a first password in the profile, admin / owner one-time sign-in links, and "forgot password".
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let ids: Record<string, string>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery'; // helpers.signUpWithPassword

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const auth = (path: string, payload: unknown, cookie?: string) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
const signIn = (email: string, password: string) => auth('/sign-in/email', { email, password });
const tokenOf = (url: string) => /#reset=([\w-]+)$/.exec(url)![1]!;
const audits = (action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));

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
  // The owner console gets the first admin's link to copy too.
  expect(created.invitation.url).toMatch(new RegExp(`^${WEB_ORIGIN}/invite/[\\w-]+$`));
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await t.api(owner).post('/platform/accounts', {
    name: 'Other',
    slug: 'other',
    first_admin_email: 'boss@other.test',
    template_set: 'empty',
  });
  await join('boss@other.test');
  const list = (await body(await as(admin).get('/users'))).data as Json[];
  ids = Object.fromEntries(list.map((u) => [u.email, u.user_id]));
});
afterAll(() => t.close());

describe('invitation links to copy', () => {
  it('the invite answer carries the link; "copy link" makes a fresh one without email, the old one dies', async () => {
    const res = await body(await as(admin).post('/users/invite', { emails: ['link@acme.test'], role: 'member' }));
    const first = res.invited[0];
    expect(first.url).toBe(`${WEB_ORIGIN}/invite/${t.inviteTokenFor('link@acme.test')}`);
    // Lists never show it (only the hash is stored).
    const list = (await body(await as(admin).get('/users/invitations'))).data as Json[];
    expect(list.find((i) => i.email === 'link@acme.test')!.url).toBeUndefined();

    const mails = t.mailer.sent.length;
    const copied = await as(admin).post(`/users/invitations/${first.id}/link`);
    expect(copied.status).toBe(200);
    const { invitation, emailed } = await body(copied);
    expect(emailed).toBe(false);
    expect(t.mailer.sent.length).toBe(mails); // nothing emailed
    const token = /\/invite\/([\w-]+)$/.exec(invitation.url)![1]!;
    expect((await t.api(undefined).post('/invitations/preview', { token })).status).toBe(200);
    const oldToken = /\/invite\/([\w-]+)$/.exec(first.url)![1]!;
    expect((await t.api(undefined).post('/invitations/preview', { token: oldToken })).status).toBe(404);
    // Accepting it is the usual sign-up (single use).
    const cookie = t.cookieFrom(await t.signUpWithPassword('link@acme.test', token))!;
    expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
    expect((await t.api(undefined).post('/invitations/preview', { token })).status).toBe(404);
    expect((await audits('invitation.link_copied')).length).toBe(1);
  });

  it('resend answers with the link too; members cannot copy links', async () => {
    const inv = (await body(await as(admin).post('/users/invite', { emails: ['re@acme.test'], role: 'viewer' })))
      .invited[0];
    const res = await body(await as(admin).post(`/users/invitations/${inv.id}/resend`));
    expect(res.emailed).toBe(true);
    expect(res.invitation.url).toBe(`${WEB_ORIGIN}/invite/${t.inviteTokenFor('re@acme.test')}`);
    const fresh = res.invitation.id;
    expect((await as(bob).post(`/users/invitations/${fresh}/link`)).status).toBe(403);
  });

  it('an email that failed still leaves the link to copy', async () => {
    const send = t.mailer.send;
    t.mailer.send = async () => {
      throw new Error('smtp down');
    };
    try {
      const res = await body(await as(admin).post('/users/invite', { emails: ['nomail@acme.test'], role: 'member' }));
      expect(res.errors).toEqual([{ email: 'nomail@acme.test', code: 'email_failed' }]);
      expect(res.invited[0].url).toMatch(/\/invite\/[\w-]+$/);
    } finally {
      t.mailer.send = send;
    }
  });
});

describe('my password (profile)', () => {
  it('a link-only user sets a first password, then changes it only with the current one', async () => {
    await as(admin).post('/users/invite', { emails: ['dan@acme.test'], role: 'member' });
    const dan = (await t.signInWithMagicLink('dan@acme.test')).cookie!;
    await t
      .api(dan)
      .post('/me/invitations/' + ((await body(await t.api(dan).get('/me/invitations'))).data[0].id + '/accept'));
    expect(await body(await t.api(dan).get('/me/security'))).toMatchObject({ has_password: false, providers: [] });

    expect((await t.api(dan).post('/me/password', { new_password: 'short' })).status).toBe(400);
    expect((await t.api(dan).post('/me/password', { new_password: 'first-password-1' })).status).toBe(200);
    expect((await body(await t.api(dan).get('/me/security'))).has_password).toBe(true);
    expect((await signIn('dan@acme.test', 'first-password-1')).status).toBe(200);
    // Never replaces one.
    expect((await t.api(dan).post('/me/password', { new_password: 'second-password-2' })).status).toBe(409);

    const wrong = await auth(
      '/change-password',
      { currentPassword: 'nope-nope-nope', newPassword: 'second-password-2' },
      dan,
    );
    expect(wrong.status).toBe(400);
    const ok = await auth(
      '/change-password',
      { currentPassword: 'first-password-1', newPassword: 'second-password-2' },
      dan,
    );
    expect(ok.status).toBe(200);
    expect((await signIn('dan@acme.test', 'second-password-2')).status).toBe(200);
    expect((await t.api(undefined).get('/me/security')).status).toBe(401);
  });
});

describe('admin one-time sign-in links', () => {
  it('makes a 1-hour single-use link, audited without the token; using it sets a password and ends old sessions', async () => {
    const mails = t.mailer.sent.length;
    const res = await as(admin).post(`/users/${ids['bob@acme.test']}/recovery-link`);
    expect(res.status).toBe(200);
    const link = await body(res);
    expect(link.url).toMatch(new RegExp(`^${WEB_ORIGIN}/login#reset=[\\w-]+$`));
    expect(new Date(link.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(t.mailer.sent.length).toBe(mails); // copied, not emailed
    const token = tokenOf(link.url);

    const [row] = await audits('user.recovery_link_created');
    expect(row!.targetId).toBe(ids['bob@acme.test']);
    expect(JSON.stringify(row!.payload)).not.toContain(token);

    // A second link replaces the first.
    const second = tokenOf((await body(await as(admin).post(`/users/${ids['bob@acme.test']}/recovery-link`))).url);
    expect((await t.api(undefined).post('/auth/recovery/preview', { token })).status).toBe(404);
    expect(await body(await t.api(undefined).post('/auth/recovery/preview', { token: second }))).toMatchObject({
      email: 'bob@acme.test',
    });

    expect((await auth('/reset-password', { token: second, newPassword: 'short' })).status).toBe(400);
    expect((await auth('/reset-password', { token: second, newPassword: 'bobs-new-password' })).status).toBe(200);
    expect((await signIn('bob@acme.test', 'bobs-new-password')).status).toBe(200);
    expect((await signIn('bob@acme.test', PASSWORD)).status).toBe(401);
    // Single use; and the session from before is gone.
    expect((await auth('/reset-password', { token: second, newPassword: 'another-password' })).status).toBe(400);
    expect((await t.api(bob).get('/auth/me')).status).toBe(401);
    bob = t.cookieFrom(await signIn('bob@acme.test', 'bobs-new-password'))!;
  });

  it('refuses members, yourself, deactivated people, the platform owner and people of other accounts', async () => {
    expect((await as(bob).post(`/users/${ids['admin@acme.test']}/recovery-link`)).status).toBe(403);
    const self = await as(admin).post(`/users/${ids['admin@acme.test']}/recovery-link`);
    expect(self.status).toBe(403);

    // Someone also active in another account: their password opens it too — only the owner does that.
    await as(admin).post('/users/invite', { emails: ['boss@other.test'], role: 'member' });
    const boss = t.cookieFrom(await signIn('boss@other.test', PASSWORD))!;
    const inv = (await body(await t.api(boss).get('/me/invitations'))).data[0];
    await t.api(boss).post(`/me/invitations/${inv.id}/accept`);
    const bossId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
      (u) => u.email === 'boss@other.test',
    )!.user_id;
    const elsewhere = await as(admin).post(`/users/${bossId}/recovery-link`);
    expect(elsewhere.status).toBe(403);
    expect((await body(elsewhere)).error.message).toBe('member_of_other_accounts');

    // The platform owner as a member of Acme: an admin cannot.
    await as(admin).post('/users/invite', { emails: [OWNER_EMAIL], role: 'member' });
    const ownerInv = (await body(await t.api(owner).get('/me/invitations'))).data[0];
    await t.api(owner).post(`/me/invitations/${ownerInv.id}/accept`);
    const ownerId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
      (u) => u.email === OWNER_EMAIL,
    )!.user_id;
    const po = await as(admin).post(`/users/${ownerId}/recovery-link`);
    expect(po.status).toBe(403);

    // Deactivated.
    await as(admin).post('/users/invite', { emails: ['gone@acme.test'], role: 'member' });
    await join('gone@acme.test');
    const goneId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
      (u) => u.email === 'gone@acme.test',
    )!.user_id;
    await as(admin).post(`/users/${goneId}/deactivate`, {});
    expect((await as(admin).post(`/users/${goneId}/recovery-link`)).status).toBe(403);

    // Another account's person does not exist here.
    expect((await as(admin).post(`/users/01NOTAREALUSER0000000000000/recovery-link`)).status).toBe(404);
  });

  it('the owner console makes one for anyone in an account; nobody else may', async () => {
    // Only with an edit grant of the account's admin (support-access.test.ts covers the rest).
    const closed = await t.api(owner).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'bob@acme.test' });
    expect(closed.status).toBe(403);
    await as(admin).patch('/security', { support_access: { allow_edit: true } });
    await as(admin).post('/support-access', { mode: 'edit', duration_hours: 24, reason: 'recovery' });
    const res = await t.api(owner).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'bob@acme.test' });
    expect(res.status).toBe(200);
    expect((await body(res)).url).toMatch(/#reset=[\w-]+$/);
    const rows = await audits('user.recovery_link_created');
    expect(rows.some((r) => (r.payload as Json).via === 'platform_owner')).toBe(true);
    expect(
      (await t.api(admin).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'bob@acme.test' })).status,
    ).toBe(404);
    expect(
      (await t.api(owner).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'nobody@acme.test' })).status,
    ).toBe(404);
  });
});

describe('forgot password and email failures', () => {
  it('emails a /login#reset= link that works', async () => {
    const res = await t.api(undefined).post('/auth/forgot-password', { email: 'bob@acme.test' });
    expect(res.status).toBe(200);
    const text = t.lastMailTo('bob@acme.test').text;
    const token = /\/login#reset=([\w-]+)/.exec(text)![1]!;
    expect(text).not.toContain('/api/auth/reset-password');
    expect((await auth('/reset-password', { token, newPassword: 'forgot-flow-pass' })).status).toBe(200);
    expect((await signIn('bob@acme.test', 'forgot-flow-pass')).status).toBe(200);
  });

  it('says so when the email could not be sent (reset and magic link)', async () => {
    const send = t.mailer.send;
    t.mailer.send = async () => {
      throw new Error('smtp down');
    };
    try {
      // A known address answers like an unknown one, at once (audit 2026-10-10 security #10): the send runs after
      // the answer, so a slow or failing transport does not say who is registered.
      const reset = await t.api(undefined).post('/auth/forgot-password', { email: 'bob@acme.test' });
      expect(reset.status).toBe(200);
      expect((await t.api(undefined).post('/auth/forgot-password', { email: 'nobody@x.test' })).status).toBe(200);
      const magic = await auth('/sign-in/magic-link', { email: 'bob@acme.test', callbackURL: '/' });
      expect(magic.status).toBe(500);
      expect((await body(magic)).message).toBe('email_not_sent');
    } finally {
      t.mailer.send = send;
    }
    // Email switched off altogether is the transport's state: 503 for every address, before any lookup.
    const deps = t.deps as { emailEnabled?: boolean };
    const was = deps.emailEnabled;
    deps.emailEnabled = false;
    try {
      for (const email of ['bob@acme.test', 'nobody@x.test']) {
        const res = await t.api(undefined).post('/auth/forgot-password', { email });
        expect(res.status).toBe(503);
        expect((await body(res)).error.message).toBe('email_not_sent');
      }
    } finally {
      deps.emailEnabled = was;
    }
  });
});
