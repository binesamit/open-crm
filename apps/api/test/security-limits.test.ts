// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, authSessions } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Security review S-10, S-12, S-15 and 06 §1.10: the real client address behind the proxy (audit log, sessions,
 * per-IP limit), invitation email budget, per-account token budget, and sessions of admins of other accounts.
 * One trusted proxy hop (TRUST_PROXY=1): the client is the last X-Forwarded-For entry; whatever it prepends is noise.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let betaId: string;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const newAccount = async (name: string, slug: string, email: string) =>
  (
    await body(
      await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
    )
  ).account.id as string;

beforeAll(async () => {
  t = await createTestContext({
    env: { TRUST_PROXY: '1', RATE_LIMIT_ACCOUNT_PER_MIN: '4', INVITE_EMAILS_PER_HOUR: '3' },
  });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await newAccount('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' }); // admin: 1 of 3 emails
  bob = await join('bob@acme.test');
});
afterAll(() => t.close());

describe('S-10 — the client address comes from the trusted proxy, not from the client', () => {
  it('the audit log records the address the proxy saw, not a forged first entry', async () => {
    const res = await as(admin).call(
      'PATCH',
      '/security',
      { auto_join: true },
      { 'x-forwarded-for': '6.6.6.6, 198.51.100.40' },
    );
    expect(res.status).toBe(200);
    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'security.settings_changed')));
    expect(row!.ip).toBe('198.51.100.40');
  });

  it("a sign-in's session keeps the resolved address; the internal header cannot be forged", async () => {
    const email = 'admin@acme.test';
    await t.app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email, callbackURL: '/' }),
    });
    const url = new URL(/https?:\/\/[^\s"]+magic-link\/verify[^\s"<]+/.exec(t.lastMailTo(email).text)![0]);
    const verify = await t.app.request(`${url.pathname}${url.search}`, {
      headers: {
        origin: WEB_ORIGIN,
        'x-forwarded-for': '1.1.1.1, 198.51.100.41',
        'x-bines-client-ip': '6.6.6.6',
      },
    });
    const token = t.cookieFrom(verify)!.split('=')[1]!.split('.')[0]!;
    const [session] = await t.db.select().from(authSessions).where(eq(authSessions.token, token));
    expect(session!.ipAddress).toBe('198.51.100.41');
  });
});

describe('06 §1.10 — per-account budget for API tokens', () => {
  it('all tokens of an account share one budget per minute; 429 says which quota', async () => {
    const mint = async (cookie: string) =>
      (await body(await as(cookie).post('/auth/tokens', { name: 'Make', scopes: ['boards:read'] }))).token as string;
    const [a, b] = [await mint(admin), await mint(bob)];
    const call = (token: string) => t.app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } });
    for (const token of [a, b, a, b]) expect((await call(token)).status).toBe(200);
    const over = await call(a);
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
    expect((await body(over)).error.details.quota).toBe('account');
    // sessions (the web app) are not counted
    expect((await as(admin).get('/accounts/me')).status).toBe(200);
  });
});

describe('S-12 — invitation emails per inviter per hour', () => {
  it('over the budget: the rest are reported, then refused with 429; a copied link is not an email', async () => {
    const first = await body(
      await as(admin).post('/users/invite', {
        emails: ['c1@acme.test', 'c2@acme.test', 'c3@acme.test'],
        role: 'member',
      }),
    );
    expect(first.invited.map((i: Json) => i.email)).toEqual(['c1@acme.test', 'c2@acme.test']);
    expect(first.errors).toEqual([{ email: 'c3@acme.test', code: 'rate_limited' }]);
    expect(t.mailer.sent.some((m) => m.to === 'c3@acme.test')).toBe(false);
    const again = await as(admin).post('/users/invite', { emails: ['c4@acme.test'], role: 'member' });
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toBeTruthy();
    const resend = await as(admin).post(`/users/invitations/${first.invited[0].id}/resend`);
    expect(resend.status).toBe(429);
    const link = await as(admin).post(`/users/invitations/${first.invited[0].id}/link`);
    expect(link.status).toBe(200);
    expect((await body(link)).invitation.url).toMatch(/\/invite\//);
  });
});

describe('S-15 — an admin of another account is not signed out from here', () => {
  it('flagged in the list; DELETE refused; sign-out-all leaves their sessions and counts them', async () => {
    betaId = await newAccount('Beta', 'beta', 'bob@acme.test');
    await t.api(bob).post('/invitations/accept', { token: t.inviteTokenFor('bob@acme.test') });

    const list = (await body(await as(admin).get('/security/sessions'))).data as Json[];
    const bobs = list.find((s) => s.user_email === 'bob@acme.test')!;
    expect(bobs).toMatchObject({ admin_elsewhere: true, other_accounts: true });
    expect(list.find((s) => s.current)!.admin_elsewhere).toBe(false);

    const del = await as(admin).del(`/security/sessions/${bobs.id}`);
    expect(del.status).toBe(403);
    expect((await body(del)).error.message).toBe('admin_of_other_account');

    const all = await body(await as(admin).post('/security/sessions/sign-out-all'));
    expect(all.skipped).toBeGreaterThanOrEqual(1);
    expect((await t.api(bob, acmeId).get('/accounts/me')).status).toBe(200);
    // Beta's own admin view is unaffected
    expect((await t.api(bob, betaId).get('/security/sessions')).status).toBe(200);
  });
});

describe('06 §1.10 — per client address, every API route', () => {
  // Boots its own PGlite (all migrations) inside the test, which under a loaded runner exceeds the 30s test timeout.
  it('counts by the address the proxy saw; forged prefixes do not open a new bucket', async () => {
    const t2 = await createTestContext({ env: { TRUST_PROXY: '1', RATE_LIMIT_IP_PER_10S: '5' } });
    try {
      const hit = (xff: string) => t2.app.request('/api/v1/health', { headers: { 'x-forwarded-for': xff } });
      for (let i = 0; i < 5; i++) expect((await hit(`10.0.0.${i}, 198.51.100.50`)).status).toBe(200);
      const over = await hit('9.9.9.9, 198.51.100.50');
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await hit('198.51.100.51')).status).toBe(200);
    } finally {
      await t2.close();
    }
  }, 120_000);
});
