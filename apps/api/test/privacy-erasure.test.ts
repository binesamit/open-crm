// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountMembers, auditLog, users } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Privacy, phase B: a person asks for their details to be deleted (GDPR art. 17; Israel Privacy Law
 * §14). In an account the request is recorded, admins are emailed and see it in the member list; it can be
 * withdrawn. With no account the details are deleted at once. Platform owners cannot use it.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let bobId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const bobInList = async () =>
  ((await body(await t.api(admin, acmeId).get('/users'))).data as Json[]).find((m) => m.user_id === bobId)!;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;
});
afterAll(() => t.close());

describe('/me/erasure-request', () => {
  it('nothing pending at first', async () => {
    expect(await body(await t.api(bob).get('/me/erasure-request'))).toEqual({
      pending: false,
      accounts: [],
      has_accounts: true,
    });
    expect((await bobInList()).erasure_requested_at).toBeNull();
  });

  it('the email must be my own', async () => {
    const res = await t.api(bob).post('/me/erasure-request', { confirm_email: 'admin@acme.test' });
    expect(res.status).toBe(400);
    expect((await body(res)).error.message).toBe('confirm_email_mismatch');
  });

  it('in an account: recorded, admins emailed, shown to admins only, audited', async () => {
    const before = t.mailer.sent.length;
    const res = await t.api(bob).post('/me/erasure-request', { confirm_email: ' BOB@acme.test ' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ status: 'requested', accounts: [acmeId] });
    const mails = t.mailer.sent.slice(before);
    expect(mails.map((m) => m.to)).toEqual(['admin@acme.test']);
    expect(mails[0]!.text).toContain('bob@acme.test');

    expect(await body(await t.api(bob).get('/me/erasure-request'))).toMatchObject({
      pending: true,
      accounts: [acmeId],
    });
    expect(typeof (await bobInList()).erasure_requested_at).toBe('string');
    // A member does not see it.
    const self = ((await body(await t.api(bob, acmeId).get('/users'))).data as Json[]).find(
      (m) => m.user_id === bobId,
    )!;
    expect(self.erasure_requested_at).toBeNull();
    const logged = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'user.erasure_requested')));
    expect(logged).toHaveLength(1);

    // Asking again does not email the admins again.
    const again = t.mailer.sent.length;
    await t.api(bob).post('/me/erasure-request', { confirm_email: 'bob@acme.test' });
    expect(t.mailer.sent.length).toBe(again);
  });

  it('withdrawn', async () => {
    expect((await t.api(bob).del('/me/erasure-request')).status).toBe(200);
    expect((await body(await t.api(bob).get('/me/erasure-request'))).pending).toBe(false);
    expect((await bobInList()).erasure_requested_at).toBeNull();
    // The rest of the member's settings are kept.
    const [m] = await t.db
      .select({ settings: accountMembers.settings })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, acmeId), eq(accountMembers.userId, bobId)));
    expect(m!.settings).not.toHaveProperty('erasure_requested_at');
  });

  it('with no account: deleted at once and signed out', async () => {
    const carol = await join('carol@acme.test');
    const carolId = (await body(await t.api(carol).get('/auth/me'))).user.id as string;
    // Carol has left every account.
    await t.db.delete(accountMembers).where(eq(accountMembers.userId, carolId));
    expect((await body(await t.api(carol).get('/me/erasure-request'))).has_accounts).toBe(false);
    const res = await t.api(carol).post('/me/erasure-request', { confirm_email: 'carol@acme.test' });
    expect(await body(res)).toEqual({ status: 'erased', accounts: [] });
    const [u] = await t.db.select().from(users).where(eq(users.id, carolId));
    expect(u!.email).toMatch(/@anon\.invalid$/);
    expect(u!.email).not.toContain('carol');
    expect((await t.api(carol).get('/auth/me')).status).toBe(401);
  });

  it('not for the platform owner', async () => {
    const res = await t.api(owner).post('/me/erasure-request', { confirm_email: OWNER_EMAIL });
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('staff_write_to_privacy');
  });
});
