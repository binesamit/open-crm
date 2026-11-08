// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { accountMembers, accounts, accountSubscriptions, signupRequests, users } from '../src/db/schema';
import { domainResolver } from '../src/modules/signup/signup.domain';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { body, errorOf, mockTurnstile, openSignup, pub, startBody, verifyTokenFor } from './signup-fixture';

/**
 * Self sign-up ה7, domain join (D32 decision 11): an account's admins verify their domain (their own verified
 * address, or a DNS TXT record), switch joining on with a role, and people at that domain join the account through
 * the sign-up page — no new account, no plan, no trial. A verified domain belongs to one account; free mailboxes
 * never qualify. The platform's `domain_join` mode allows only that.
 */
let t: TestContext;
let owner: string;
let admin: string; // admin@acme.io, address verified (magic link)
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let verify: MockInstance;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const dj = (cookie: string, account = acmeId) => t.api(cookie, account);

const newAccount = async (name: string, slug: string, email: string) => {
  const res = await body(
    await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
  );
  const token = t.inviteTokenFor(email);
  const cookie = (await t.signInWithMagicLink(email)).cookie!;
  await t.api(cookie).post('/invitations/accept', { token });
  return { id: res.account.id as string, cookie };
};
const join = async (email: string, extra: Json = {}) => {
  verify = mockTurnstile();
  const start = await pub(t, 'POST', '/public/signup/start', await startBody(t, email, { org_name: '', ...extra }));
  if (start.status !== 200) return { start, verify: null };
  const res = await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, email) });
  return { start, verify: res };
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  await openSignup(t, owner);
  ({ id: acmeId, cookie: admin } = await newAccount('Acme', 'acme', 'admin@acme.io'));
  ({ id: betaId, cookie: betaAdmin } = await newAccount('Beta', 'beta', 'boss@beta.io'));
});
afterAll(() => {
  verify?.mockRestore();
  return t.close();
});

describe('the admin side (admin → security)', () => {
  it('nothing until the account lists domains; the sign-up page is the join link; members cannot see it', async () => {
    const res = await body(await dj(admin).get('/security/domain-join'));
    expect(res).toMatchObject({ enabled: false, role: 'member', domains: [], available: true });
    expect(res.join_url).toContain('/signup');
    await dj(admin).post('/users/invite', { emails: ['mem@acme.io'], role: 'member' });
    const invite = t.inviteTokenFor('mem@acme.io');
    const mem = (await t.signInWithMagicLink('mem@acme.io')).cookie!;
    await t.api(mem).post('/invitations/accept', { token: invite });
    expect((await dj(mem).get('/security/domain-join')).status).toBe(403);
  });

  it("the account's domains: free mailboxes never; the admin's own address verifies; another by its DNS record", async () => {
    expect((await dj(admin).patch('/security', { domains: ['acme.io', 'acme-labs.com', 'gmail.com'] })).status).toBe(
      200,
    );
    const listed = await body(await dj(admin).get('/security/domain-join'));
    expect(listed.domains.map((d: Json) => d.domain)).toEqual(['acme.io', 'acme-labs.com', 'gmail.com']);
    expect(listed.domains.find((d: Json) => d.domain === 'gmail.com')).toMatchObject({
      free_mail: true,
      verified: false,
    });
    const free = await dj(admin).post('/security/domain-join/domains/gmail.com/verify');
    expect(free.status).toBe(422);
    expect((await errorOf(free)).message).toBe('domain_free_mail');

    const own = await body(await dj(admin).post('/security/domain-join/domains/acme.io/verify'));
    expect(own.domains[0]).toMatchObject({ domain: 'acme.io', verified: true, method: 'email' });

    const pending = listed.domains.find((d: Json) => d.domain === 'acme-labs.com');
    expect(pending).toMatchObject({ verified: false, record: { type: 'TXT', name: 'acme-labs.com' } });
    expect(pending.record.value).toMatch(/^bines-domain-verification=[0-9a-f]{32}$/);
    const spy = vi.spyOn(domainResolver, 'resolveTxt').mockResolvedValue([['v=spf1 -all']]);
    const missing = await dj(admin).post('/security/domain-join/domains/acme-labs.com/verify');
    expect(missing.status).toBe(422);
    expect((await errorOf(missing)).message).toBe('domain_record_not_found');
    spy.mockResolvedValue([['v=spf1 -all'], [pending.record.value]]);
    const ok = await body(await dj(admin).post('/security/domain-join/domains/acme-labs.com/verify'));
    expect(ok.domains.find((d: Json) => d.domain === 'acme-labs.com')).toMatchObject({ verified: true, method: 'dns' });
    expect((await dj(admin).post('/security/domain-join/domains/nope.io/verify')).status).toBe(404);

    // Another account cannot take a domain that is verified here.
    await dj(betaAdmin, betaId).patch('/security', { domains: ['acme.io'] });
    const theirs = await body(await dj(betaAdmin, betaId).get('/security/domain-join'));
    spy.mockResolvedValue([[theirs.domains[0].record.value]]);
    const taken = await dj(betaAdmin, betaId).post('/security/domain-join/domains/acme.io/verify');
    expect(taken.status).toBe(409);
    expect((await errorOf(taken)).message).toBe('domain_taken');
    spy.mockRestore();
  });
});

describe('joining through the sign-up page', () => {
  it('switched on: an address at the domain (or under it) joins the account with the chosen role', async () => {
    // Off: an Acme address cannot join yet — without an organisation name nothing is created.
    const off = await join('dana@acme.io');
    expect(off.start.status).toBe(422);
    expect((await errorOf(off.start)).message).toBe('org_name_required');

    expect((await dj(admin).patch('/security', { auto_join: true, auto_join_role: 'viewer' })).status).toBe(200);
    const accountsBefore = (await t.db.select().from(accounts)).length;
    const { start, verify: done } = await join('dana@acme.io');
    expect(start.status).toBe(200);
    expect(done!.status).toBe(200);
    const result = await body(done!);
    expect(result).toMatchObject({ status: 'provisioned', joined: true, account: { id: acmeId, slug: 'acme' } });
    expect(t.cookieFrom(done!)).toBeTruthy();
    expect((await t.db.select().from(accounts)).length).toBe(accountsBefore);
    const [dana] = await t.db.select().from(users).where(eq(users.email, 'dana@acme.io'));
    const [member] = await t.db.select().from(accountMembers).where(eq(accountMembers.userId, dana!.id));
    expect(member).toMatchObject({ accountId: acmeId, role: 'viewer', status: 'active' });
    // No plan, no trial for a joiner.
    expect(
      await t.db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, acmeId)),
    ).toHaveLength(0);
    const [req] = await t.db.select().from(signupRequests).where(eq(signupRequests.email, 'dana@acme.io'));
    expect(req).toMatchObject({ joinAccountId: acmeId, accountId: acmeId, status: 'provisioned', passwordHash: null });

    const sub = await join('eli@eng.acme-labs.com');
    expect((await body(sub.verify!)).joined).toBe(true);
  });

  it('the platform in domain_join mode: only joining, an unknown domain is refused; switched off later = refused', async () => {
    expect((await t.api(owner).patch('/platform/signup-settings', { mode: 'domain_join' })).status).toBe(200);
    expect((await body(await pub(t, 'GET', '/public/signup/config'))).mode).toBe('domain_join');
    const stranger = await join('someone@nowhere.io', { org_name: 'Nowhere' });
    expect(stranger.start.status).toBe(422);
    expect((await errorOf(stranger.start)).code).toBe('signup_domain_not_joinable');

    // A link opened after the admins switched joining off creates nothing.
    verify = mockTurnstile();
    await pub(t, 'POST', '/public/signup/start', await startBody(t, 'late@acme.io', { org_name: '' }));
    const token = verifyTokenFor(t, 'late@acme.io');
    await dj(admin).patch('/security', { auto_join: false });
    const late = await pub(t, 'POST', '/public/signup/verify', { token });
    expect(late.status).toBe(422);
    expect(await t.db.select().from(users).where(eq(users.email, 'late@acme.io'))).toHaveLength(0);
    await t.api(owner).patch('/platform/signup-settings', { mode: 'open' });
  });
});
