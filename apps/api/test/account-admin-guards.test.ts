// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertAccountAdmin, isAccountAdmin } from '../src/lib/account-admin';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * dedup-1: every admin-only service checks "is the user an account admin" with the one helper
 * (`assertAccountAdmin` / `isAccountAdmin`, by `canAccount`). For each call site: a member is refused with the
 * reason its clients know; an admin passes; remote support access (an edit grant) acts as an admin where support
 * may act; the platform owner without a membership bypasses nothing (the account does not exist for him).
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string; // member
let helper: string; // no membership in Acme: in by a support grant
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
const as = (cookie: string) => t.api(cookie, acmeId);
const MISSING = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

type Call = (cookie: string) => Response | Promise<Response>;
/** One admin-only call per module that used to have its own "is admin" helper, and the reason a member gets. */
const SITES: { name: string; call: Call; reason: string; admin: number; support?: number }[] = [
  {
    name: 'accounts: PATCH /accounts/me',
    call: (c) => as(c).patch('/accounts/me', { name: 'Acme' }),
    reason: 'admin_only',
    admin: 200,
    support: 200,
  },
  {
    name: 'email preview: GET /accounts/me/email-preview',
    call: (c) => as(c).get('/accounts/me/email-preview?template=invitation&locale=he'),
    reason: 'admin_only',
    admin: 200,
    support: 200,
  },
  {
    name: 'security: GET /security',
    call: (c) => as(c).get('/security'),
    reason: 'admin_only',
    admin: 200,
    support: 200,
  },
  {
    name: 'extensions: GET /extensions',
    call: (c) => as(c).get('/extensions'),
    reason: 'extensions_admins_only',
    admin: 200,
  },
  {
    name: 'flows: DELETE /flow-connections/:id',
    call: (c) => as(c).del(`/flow-connections/${MISSING}`),
    reason: 'admin_only',
    admin: 404,
    // Session-only routes (lib/scopes): support is refused before the service, like a token.
    support: 403,
  },
  {
    name: 'MCP servers: GET /mcp-servers',
    call: (c) => as(c).get('/mcp-servers'),
    reason: 'admin_only',
    admin: 200,
    support: 200,
  },
  {
    name: 'teams: POST /teams',
    call: (c) => as(c).post('/teams', { name: `T ${Math.random().toString(36).slice(2, 8)}` }),
    reason: 'admin_only',
    admin: 201,
    support: 201,
  },
  {
    name: 'users admin: PATCH /users/:id',
    call: (c) => as(c).patch(`/users/${MISSING}`, { role: 'viewer' }),
    reason: 'admin_only',
    admin: 404,
  },
  {
    name: 'geo: PUT /geo/settings',
    call: (c) => as(c).put('/geo/settings', { geocoder: 'auto' }),
    reason: 'account.update',
    admin: 200,
    // Audit 2026-10-10 #9: the map settings (and their Google key) are not support's to change.
    support: 403,
  },
];

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  await mk('Helpers', 'helpers', 'helper@support.test');
  admin = await join('admin@acme.test');
  helper = await join('helper@support.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
    (u) => u.email === 'bob@acme.test',
  )!.user_id;
});
afterAll(() => t.close());

describe('the one account-admin check, per call site', () => {
  for (const s of SITES)
    it(`${s.name}: member refused, admin passes`, async () => {
      const refused = await s.call(bob);
      expect(refused.status).toBe(403);
      expect((await body(refused)).error.message).toBe(s.reason);
      expect((await s.call(admin)).status).toBe(s.admin);
    });

  it('the platform owner without a membership bypasses nothing (the account is not his: 404)', async () => {
    for (const s of SITES) expect([403, 404]).toContain((await s.call(owner)).status);
    expect((await as(owner).get('/security')).status).toBe(404);
  });

  it('remote support access (edit grant) acts as an admin where support may act', async () => {
    await as(admin).patch('/security', { support_access: { allow_edit: true } });
    const res = await as(admin).post('/support-access', {
      duration_hours: 24,
      reason: 'Ticket #1',
      grantee: 'email',
      email: 'helper@support.test',
      mode: 'edit',
    });
    expect(res.status).toBe(201);
    for (const s of SITES.filter((x) => x.support)) expect((await s.call(helper)).status, s.name).toBe(s.support);
  });

  it('users admin: a member cannot change another member either (users.manage)', async () => {
    const refused = await as(bob).patch(`/users/${bobId}`, { role: 'admin' });
    expect(refused.status).toBe(403);
  });
});

describe('isAccountAdmin / assertAccountAdmin', () => {
  it('admins only, by canAccount; the reason is the module’s when it has one', () => {
    expect(isAccountAdmin({ role: 'admin' })).toBe(true);
    for (const role of ['member', 'viewer', 'guest'] as const) {
      expect(isAccountAdmin({ role })).toBe(false);
      expect(isAccountAdmin({ role }, 'users.manage')).toBe(false);
      expect(() => assertAccountAdmin({ role })).toThrow('admin_only');
      expect(() => assertAccountAdmin({ role }, { reason: 'extensions_admins_only' })).toThrow(
        'extensions_admins_only',
      );
    }
    expect(() => assertAccountAdmin({ role: 'admin' }, { action: 'audit.read' })).not.toThrow();
  });
});
