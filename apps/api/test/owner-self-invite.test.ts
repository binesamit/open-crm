// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { accountInvitations, accountMembers, users } from '../src/db/schema';
import { newSecretToken, sha256 } from '../src/lib/tokens';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * S-51 ("I invited myself into someone else's account"): a platform owner never gains a membership
 * in an account he is not already in — by any path, support grants included (support access is temporary access,
 * never a membership). The one check runs when an invitation is accepted (whoever issued it, from wherever); the
 * owner console refuses to issue such links; a support session never invites new people (board / doc / dashboard /
 * workspace shares included); the account's own admin may still invite the owner; the owner may be the first admin
 * of an account he created while it is empty.
 */
let t: TestContext;
let owner: string;
let ownerId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const tokenOf = (url: string) => /\/invite\/([\w-]+)$/.exec(url)![1]!;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};
const createAccount = async (slug: string, firstAdmin: string) =>
  body(
    await t
      .api(owner)
      .post('/platform/accounts', { name: slug, slug, first_admin_email: firstAdmin, template_set: 'empty' }),
  );
const ownerAccept = (token: string) => t.api(owner).post('/invitations/accept', { token });
const ownerMembership = async (accountId: string) =>
  (
    await t.db
      .select()
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, ownerId)))
  )[0];
const myInvitationAccounts = async () =>
  ((await body(await t.api(owner).get('/me/invitations'))).data as Json[]).map((i) => i.account.id as string);

/** An account with a customer admin who allows edit grants; `grant(mode)` lets the platform in. */
const customerAccount = async (slug: string) => {
  const id = (await createAccount(slug, `admin@${slug}.test`)).account.id as string;
  const admin = await join(`admin@${slug}.test`);
  const as = (cookie: string) => t.api(cookie, id);
  await as(admin).patch('/security', { support_access: { allow_edit: true } });
  const grant = async (mode: 'view' | 'edit') => {
    const res = await as(admin).post('/support-access', { duration_hours: 24, reason: 'Ticket', mode });
    expect(res.status).toBe(201);
    return (await body(res)).id as string;
  };
  const revoke = async (grantId: string) =>
    expect((await as(admin).del(`/support-access/${grantId}`)).status).toBe(200);
  return { id, admin, as, grant, revoke };
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  ownerId = (await t.db.select().from(users).where(eq(users.email, OWNER_EMAIL)))[0]!.id;
});
afterAll(() => t.close());

describe('S-51: the platform owner never lets himself in', () => {
  it('no grant opens the door: the console refuses; an invitation he holds is refused, grant or not', async () => {
    const acc = await customerAccount('beta');
    // The console: no grant, a view grant, an edit grant — always refused (invite, invite-admin).
    const tryConsole = async (label: string) => {
      for (const path of ['invitations', 'invite-admin']) {
        const res = await t
          .api(owner)
          .post(`/platform/accounts/${acc.id}/${path}`, { email: OWNER_EMAIL, send_email: false });
        expect(res.status, `${label} ${path}`).toBe(403);
        expect((await body(res)).error.message).toBe('support_grant_required');
      }
    };
    await tryConsole('no grant');
    const view = await acc.grant('view');
    await tryConsole('view');
    await acc.revoke(view);
    const edit = await acc.grant('edit');
    await tryConsole('edit');

    // An invitation to the owner that he gave himself (e.g. issued before this fix): never accepted — not even while
    // an edit grant is active — and the account picker does not offer it.
    const token = newSecretToken();
    await t.db.insert(accountInvitations).values({
      id: newId(),
      accountId: acc.id,
      email: OWNER_EMAIL,
      role: 'admin',
      tokenHash: sha256(token),
      payload: {},
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(await myInvitationAccounts()).not.toContain(acc.id);
    const res = await ownerAccept(token);
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('support_grant_required');
    await acc.revoke(edit);
    expect((await ownerAccept(token)).status).toBe(403);
    expect(await ownerMembership(acc.id)).toBeUndefined();
  });

  it('a support session never invites new people — board share included; members are still added', async () => {
    const acc = await customerAccount('gamma');
    await acc.as(acc.admin).post('/users/invite', { emails: ['bob@gamma.test'], role: 'member' });
    await join('bob@gamma.test');
    const wsId = (await body(await acc.as(acc.admin).get('/workspaces'))).data[0].id as string;
    const boardId = (await body(await acc.as(acc.admin).post('/boards', { name: 'Leads', workspace_id: wsId })))
      .id as string;
    const edit = await acc.grant('edit');
    const res = await acc.as(owner).post(`/boards/${boardId}/invite`, {
      emails: [OWNER_EMAIL, 'stranger@else.test', 'bob@gamma.test'],
      role: 'member',
      send_email: false,
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.invited).toEqual([]);
    expect(out.errors).toEqual(
      expect.arrayContaining([
        { email: OWNER_EMAIL, code: 'support_not_allowed' },
        { email: 'stranger@else.test', code: 'support_not_allowed' },
      ]),
    );
    // The account's own people page stays closed to support too.
    expect(
      (await acc.as(owner).post('/users/invite', { emails: [OWNER_EMAIL], role: 'admin', send_email: false })).status,
    ).toBe(403);
    await acc.revoke(edit);
    expect(await ownerMembership(acc.id)).toBeUndefined();
  });

  it('the account’s own admin may invite the owner; a member (even allowed to invite) may not', async () => {
    const acc = await customerAccount('delta');
    await acc.as(acc.admin).post('/users/invite', { emails: ['carol@delta.test'], role: 'member' });
    const carol = await join('carol@delta.test');
    await acc.as(acc.admin).patch('/accounts/me', { settings: { permissions: { invite_members: true } } });
    const byMember = await body(
      await acc.as(carol).post('/users/invite', { emails: [OWNER_EMAIL], role: 'member', send_email: false }),
    );
    const memberToken = tokenOf(byMember.invited[0].url);
    expect((await ownerAccept(memberToken)).status).toBe(403);
    expect(await myInvitationAccounts()).not.toContain(acc.id);
    // The admin re-invites (replaces the invitation): the account's own decision — accepted.
    const byAdmin = await body(
      await acc.as(acc.admin).post('/users/invite', { emails: [OWNER_EMAIL], role: 'member', send_email: false }),
    );
    expect(await myInvitationAccounts()).toContain(acc.id);
    expect((await ownerAccept(tokenOf(byAdmin.invited[0].url))).status).toBe(200);
    expect((await ownerMembership(acc.id))?.role).toBe('member');
  });

  it('first admin of a new account: the owner’s own address works only while the account is empty', async () => {
    // Own account, nobody else in it: the link can be re-issued and accepted.
    const mine = await createAccount('mine', OWNER_EMAIL);
    expect(mine.invitation.url).toBeTruthy();
    const relinked = await t
      .api(owner)
      .post(`/platform/accounts/${mine.account.id}/invitations/${mine.invitation.id}/link`);
    expect(relinked.status).toBe(200);
    expect((await ownerAccept(tokenOf((await body(relinked)).invitation.url))).status).toBe(200);
    expect((await ownerMembership(mine.account.id))?.role).toBe('admin');

    // The owner as first admin AND the customer invited; the customer is in first → the owner's link is dead.
    const theirs = await createAccount('theirs', OWNER_EMAIL);
    expect(
      (await t.api(owner).post(`/platform/accounts/${theirs.account.id}/invitations`, { email: 'boss@theirs.test' }))
        .status,
    ).toBe(200);
    await join('boss@theirs.test');
    const res = await ownerAccept(tokenOf(theirs.invitation.url));
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('support_grant_required');
    expect(
      (await t.api(owner).post(`/platform/accounts/${theirs.account.id}/invitations/${theirs.invitation.id}/link`))
        .status,
    ).toBe(403);
    expect(await ownerMembership(theirs.account.id)).toBeUndefined();
  });

  it('the customer’s first-admin invitation stays usable by the customer only', async () => {
    const acc = await createAccount('epsilon', 'admin@epsilon.test');
    // The owner holds the customer's link (copy link) — accepting it signed in as himself is a mismatch, as before.
    const res = await ownerAccept(tokenOf(acc.invitation.url));
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe('invitation_email_mismatch');
    expect(await ownerMembership(acc.account.id)).toBeUndefined();
    await join('admin@epsilon.test');
  });
});
