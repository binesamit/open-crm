// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * D12 release gate (05-PERMISSIONS §11 `account-isolation.test.ts`): sign-up rules, owner console,
 * invitations and cross-account isolation, end to end through HTTP against real migrations (PGlite).
 */
let t: TestContext;
let owner: string;
let acmeAdmin: string;
let betaAdmin: string;
let acmeId: string;
let betaId: string;

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

const createAccount = async (slug: string, firstAdmin: string) => {
  const res = await t.api(owner).post('/platform/accounts', {
    name: slug.toUpperCase(),
    slug,
    first_admin_email: firstAdmin,
    template_set: 'bines',
  });
  expect(res.status).toBe(201);
  return (await json<{ account: { id: string } }>(res)).account.id;
};

/** Invited user signs up with email+password using the token from the email, then accepts. */
const joinByInvitation = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const signUp = await t.signUpWithPassword(email, token);
  expect(signUp.status).toBe(200);
  const cookie = t.cookieFrom(signUp)!;
  expect(cookie).toBeDefined();
  const accept = await t.api(cookie).post('/invitations/accept', { token });
  expect(accept.status).toBe(200);
  return cookie;
};

beforeAll(async () => {
  t = await createTestContext();
  const signIn = await t.signInWithMagicLink(OWNER_EMAIL);
  owner = signIn.cookie!;
  acmeId = await createAccount('acme', 'admin@acme.test');
  betaId = await createAccount('beta', 'admin@beta.test');
  acmeAdmin = await joinByInvitation('admin@acme.test');
  betaAdmin = await joinByInvitation('admin@beta.test');
});
afterAll(() => t.close());

describe('sign-up is invitation-only (D12)', () => {
  it('the platform owner signs in with a magic link and is flagged as owner', async () => {
    expect(owner).toBeDefined();
    const me = await json<{ user: { is_platform_owner: boolean; email_verified: boolean } }>(
      await t.api(owner).get('/auth/me'),
    );
    expect(me.user).toMatchObject({ is_platform_owner: true, email_verified: true });
  });

  it('a stranger gets no magic link (and the response does not reveal it)', async () => {
    const before = t.mailer.sent.length;
    const res = await t.app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'stranger@evil.test', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    expect(t.mailer.sent.length).toBe(before);
  });

  it('password sign-up without the invitation token is refused, even for an invited email', async () => {
    await t.api(acmeAdmin, acmeId).post('/users/invite', { emails: ['nolink@acme.test'], role: 'viewer' });
    const res = await t.signUpWithPassword('nolink@acme.test');
    expect(res.status).toBe(403);
    expect(t.cookieFrom(res)).toBeUndefined();
  });

  it('a token for one email cannot sign up another email', async () => {
    const token = t.inviteTokenFor('nolink@acme.test');
    const res = await t.signUpWithPassword('attacker@evil.test', token);
    expect(res.status).toBe(403);
  });

  it('non-owners do not see the owner console', async () => {
    expect((await t.api(acmeAdmin).get('/platform/accounts')).status).toBe(404);
    expect((await t.api(undefined).get('/platform/accounts')).status).toBe(401);
  });
});

describe('owner console', () => {
  it('lists accounts with member counts', async () => {
    const body = await json<{ data: { slug: string; members: { admin: number } }[] }>(
      await t.api(owner).get('/platform/accounts'),
    );
    expect(body.data.map((a) => a.slug).sort()).toEqual(['acme', 'beta']);
    expect(body.data.find((a) => a.slug === 'acme')!.members.admin).toBe(1);
  });

  it('rejects taken and reserved slugs', async () => {
    const taken = await t
      .api(owner)
      .post('/platform/accounts', { name: 'X', slug: 'acme', first_admin_email: 'x@x.test' });
    expect(taken.status).toBe(409);
    const reserved = await t.api(owner).post('/platform/accounts', {
      name: 'X',
      slug: 'owner',
      first_admin_email: 'x@x.test',
    });
    expect(reserved.status).toBe(400);
  });

  it('the owner bypasses nothing inside an account', async () => {
    expect((await t.api(owner, acmeId).get('/accounts/me')).status).toBe(404);
    expect((await t.api(owner, acmeId).get('/users')).status).toBe(404);
  });

  it('sends the first admin an invitation email with a link to the web app', () => {
    expect(t.lastMailTo('admin@acme.test').text).toContain('http://localhost:5173/invite/');
  });
});

describe('cross-account isolation', () => {
  it('members only see their own accounts', async () => {
    const mine = await json<{ data: { slug: string; role: string }[] }>(await t.api(acmeAdmin).get('/me/accounts'));
    expect(mine.data).toEqual([expect.objectContaining({ slug: 'acme', role: 'admin' })]);
  });

  it('another account’s id answers 404 for every scoped route', async () => {
    for (const path of [
      '/accounts/me',
      '/users',
      '/users/invitations',
      '/ai/settings',
      '/ai/connections',
      '/ai/mcp',
      '/extensions',
      '/extensions/board-views',
      '/extensions/features',
      '/extensions/automation-blocks',
      '/ext/storage/user',
      '/mcp-servers',
      '/mcp-servers/tools',
    ]) {
      expect((await t.api(acmeAdmin, betaId).get(path)).status, path).toBe(404);
    }
    expect(
      (await t.api(acmeAdmin, betaId).post('/users/invite', { emails: ['x@x.test'], role: 'member' })).status,
    ).toBe(404);
    expect((await t.api(acmeAdmin, betaId).patch('/accounts/me', { name: 'pwned' })).status).toBe(404);
  });

  it('member lists never mix accounts', async () => {
    const acme = await json<{ data: { email: string }[] }>(await t.api(acmeAdmin, acmeId).get('/users'));
    const beta = await json<{ data: { email: string }[] }>(await t.api(betaAdmin, betaId).get('/users'));
    expect(acme.data.map((m) => m.email)).toEqual(['admin@acme.test']);
    expect(beta.data.map((m) => m.email)).toEqual(['admin@beta.test']);
  });

  it('a malformed or missing account header is rejected', async () => {
    expect((await t.api(acmeAdmin, 'not-an-id').get('/accounts/me')).status).toBe(404);
    expect((await t.api(acmeAdmin).get('/accounts/me')).status).toBe(400);
  });

  it('one user can belong to two accounts and switch between them', async () => {
    await t.api(betaAdmin, betaId).post('/users/invite', { emails: ['admin@acme.test'], role: 'viewer' });
    const invites = await json<{ data: { id: string; account: { slug: string } }[] }>(
      await t.api(acmeAdmin).get('/me/invitations'),
    );
    const betaInvite = invites.data.find((i) => i.account.slug === 'beta')!;
    expect((await t.api(acmeAdmin).post(`/me/invitations/${betaInvite.id}/accept`)).status).toBe(200);

    const mine = await json<{ data: { slug: string; role: string }[] }>(await t.api(acmeAdmin).get('/me/accounts'));
    expect(mine.data.map((a) => [a.slug, a.role])).toEqual([
      ['acme', 'admin'],
      ['beta', 'viewer'],
    ]);
    // Same session, different role per account; viewers cannot change the account.
    expect((await t.api(acmeAdmin, betaId).patch('/accounts/me', { name: 'x' })).status).toBe(403);
    expect((await t.api(acmeAdmin, acmeId).patch('/accounts/me', { name: 'ACME Ltd' })).status).toBe(200);

    expect((await t.api(acmeAdmin).put('/me/last-account', { account_id: betaId })).status).toBe(200);
    const me = await json<{ last_account_id: string; account: { slug: string } }>(
      await t.api(acmeAdmin, betaId).get('/auth/me'),
    );
    expect(me).toMatchObject({ last_account_id: betaId, account: { slug: 'beta' } });
  });
});

describe('invitations', () => {
  it('members invite per 05 §2 defaults', async () => {
    await t.api(acmeAdmin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
    const bob = await joinByInvitation('bob@acme.test');
    expect((await t.api(bob, acmeId).post('/users/invite', { emails: ['m@acme.test'], role: 'member' })).status).toBe(
      403,
    );
    const viewer = await t.api(bob, acmeId).post('/users/invite', { emails: ['v@acme.test'], role: 'viewer' });
    expect(viewer.status).toBe(200);
    expect((await t.api(bob, acmeId).patch('/accounts/me', { name: 'x' })).status).toBe(403);
    expect((await t.api(bob, acmeId).get('/users/invitations')).status).toBe(403);
  });

  it('guests are invited by email alone (M7)', async () => {
    const res = await t.api(acmeAdmin, acmeId).post('/users/invite', { emails: ['g@client.test'], role: 'guest' });
    expect(res.status).toBe(200);
    expect((await json(res)).invited).toHaveLength(1);
  });

  it('an invitation link only works for the invited email', async () => {
    await t.api(acmeAdmin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
    const carolToken = t.inviteTokenFor('carol@acme.test');
    const res = await t.api(betaAdmin).post('/invitations/accept', { token: carolToken });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: { code: 'invitation_email_mismatch' } });
  });

  it('previews are public and revoked invitations die', async () => {
    await t.api(acmeAdmin, acmeId).post('/users/invite', { emails: ['dan@acme.test'], role: 'viewer' });
    const token = t.inviteTokenFor('dan@acme.test');
    const preview = await t.api(undefined).post('/invitations/preview', { token });
    expect(await json(preview)).toMatchObject({ account: { slug: 'acme' }, email: 'dan@acme.test', role: 'viewer' });

    const list = await json<{ data: { id: string; email: string }[] }>(
      await t.api(acmeAdmin, acmeId).get('/users/invitations'),
    );
    const dan = list.data.find((i) => i.email === 'dan@acme.test')!;
    expect((await t.api(acmeAdmin, acmeId).del(`/users/invitations/${dan.id}`)).status).toBe(200);
    expect((await t.api(undefined).post('/invitations/preview', { token })).status).toBe(404);
    expect((await t.signUpWithPassword('dan@acme.test', token)).status).toBe(403);
  });

  it('existing members cannot be re-invited', async () => {
    const res = await json<{ errors: { code: string }[] }>(
      await t.api(acmeAdmin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'viewer' }),
    );
    expect(res.errors).toEqual([{ email: 'bob@acme.test', code: 'already_member' }]);
  });
});

describe('suspension and deletion', () => {
  it('a suspended account answers 423 until restored', async () => {
    expect((await t.api(owner).post(`/platform/accounts/${betaId}/suspend`, { reason: 'test' })).status).toBe(200);
    const res = await t.api(betaAdmin, betaId).get('/accounts/me');
    expect(res.status).toBe(423);
    expect((await t.api(owner).post(`/platform/accounts/${betaId}/restore`)).status).toBe(200);
    expect((await t.api(betaAdmin, betaId).get('/accounts/me')).status).toBe(200);
  });

  it('deleting needs the slug and then hides the account', async () => {
    expect((await t.api(owner).del(`/platform/accounts/${betaId}`, { confirm_slug: 'nope' })).status).toBe(422);
    expect((await t.api(owner).del(`/platform/accounts/${betaId}`, { confirm_slug: 'beta' })).status).toBe(200);
    expect((await t.api(betaAdmin, betaId).get('/accounts/me')).status).toBe(404);
    const mine = await json<{ data: { slug: string }[] }>(await t.api(betaAdmin).get('/me/accounts'));
    expect(mine.data).toEqual([]);
  });
});
