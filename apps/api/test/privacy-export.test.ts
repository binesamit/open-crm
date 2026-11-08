// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { forgetPersonalExportLimits } from '../src/modules/users/personal-export';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Privacy, phase A: a person downloads what is held about them (GDPR art. 15 / 20; Israel Privacy Law
 * §13); an account admin exports a member's data in that account only; no secret is ever in it; both are audited.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let betaId: string;
let bobId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const account = async (name: string, slug: string, email: string) =>
  (
    await body(
      await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
    )
  ).account.id as string;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await account('Acme', 'acme', 'admin@acme.test');
  betaId = await account('Beta', 'beta', 'admin@beta.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;
  // Bob in a second account too.
  const betaAdmin = await join('admin@beta.test');
  await t.api(betaAdmin, betaId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  const token = t.inviteTokenFor('bob@acme.test');
  await t.api(bob).post('/invitations/accept', { token });
  // Something Bob wrote in Acme.
  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  const board = await body(await t.api(admin, acmeId).post('/boards', { name: 'Leads', workspace_id: ws }));
  const item = await body(await t.api(admin, acmeId).post(`/boards/${board.id}/items`, { name: 'Dana' }));
  await t.api(bob, acmeId).post(`/items/${item.id}/updates`, { body: 'Called her back' });
});
afterAll(() => t.close());
beforeEach(() => forgetPersonalExportLimits());

describe('GET /me/export', () => {
  it('my profile, both my accounts, my update, my sign-ins — and no secret', async () => {
    const res = await t.api(bob).get('/me/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="my-data-\d{4}-\d{2}-\d{2}\.json"$/);
    const data = await body(res);
    expect(data).toMatchObject({
      format: 'bines-personal-export',
      version: 1,
      scope: 'all_accounts',
      truncated: false,
    });
    expect(data.profile).toMatchObject({ id: bobId, email: 'bob@acme.test' });
    expect((data.memberships as Json[]).map((m) => m.account.slug).sort()).toEqual(['acme', 'beta']);
    expect((data.updates as Json[]).map((u) => u.text)).toContain('Called her back');
    expect((data.sign_in.sessions as Json[]).length).toBeGreaterThan(0);
    const raw = JSON.stringify(data);
    for (const secret of [
      'token_hash',
      'tokenHash',
      'password_hash',
      'passwordHash',
      'secret',
      'access_token',
      'refresh_token',
    ])
      expect(raw).not.toContain(secret);
  });

  it('is audited in every account I am in', async () => {
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.data_exported'), eq(auditLog.targetId, bobId)));
    expect(new Set(rows.map((r) => r.accountId))).toEqual(new Set([acmeId, betaId]));
  });

  it('needs sign-in and is rate limited', async () => {
    expect((await t.api('').get('/me/export')).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await t.api(bob).get('/me/export')).status).toBe(200);
    expect((await t.api(bob).get('/me/export')).status).toBe(429);
  });
});

describe('GET /users/{id}/export (admin)', () => {
  it("an admin exports a member's data in this account only", async () => {
    const res = await t.api(admin, acmeId).get(`/users/${bobId}/export`);
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.scope).toBe('account');
    expect((data.memberships as Json[]).map((m) => m.account.slug)).toEqual(['acme']);
    // Account-level export carries no sessions or consents (those are the person's, not the account's).
    expect(data.sign_in.sessions).toEqual([]);
    expect(data.legal_consents).toEqual([]);
  });

  it('a member cannot; another account cannot see someone who is not theirs', async () => {
    expect((await t.api(bob, acmeId).get(`/users/${bobId}/export`)).status).toBe(403);
    const adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
    expect((await t.api(admin, betaId).get(`/users/${adminId}/export`)).status).toBe(404);
  });
});
