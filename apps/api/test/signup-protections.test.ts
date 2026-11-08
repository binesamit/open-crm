// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, type MockInstance } from 'vitest';
import { signupEmailProblem, signupSettingsSchema } from '@bines/shared';
import { signupRequests } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { body, errorOf, mockTurnstile, nextIp, openSignup, pub, startBody } from './signup-fixture';

/**
 * Self sign-up protections (D32, stage ה3): Turnstile is mandatory, the honeypot, the owner's address rules
 * (throw-away inboxes, block / allow lists, work email), consent, the per-address and per-email limits and the
 * platform's daily cap — all before anything is stored or sent.
 */
let t: TestContext;
let owner: string;
let verify: MockInstance | undefined;
beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  await openSignup(t, owner);
});
afterAll(() => t.close());
afterEach(() => verify?.mockRestore());

const start = (payload: Record<string, unknown>, ip = nextIp()) => pub(t, 'POST', '/public/signup/start', payload, ip);
const rowsOf = (email: string) => t.db.select().from(signupRequests).where(eq(signupRequests.email, email));
const settings = (patch: Record<string, unknown>) => t.api(owner).patch('/platform/signup-settings', patch);

describe('Turnstile is mandatory', () => {
  it('no token = 400 captcha_required; a bad one = captcha_failed; nothing stored', async () => {
    verify = mockTurnstile();
    const none = await start(await startBody(t, 'c1@prot.io', { captcha_token: undefined }));
    expect(none.status).toBe(400);
    expect((await errorOf(none)).code).toBe('captcha_required');
    const bad = await start(await startBody(t, 'c1@prot.io', { captcha_token: 'bad' }));
    expect((await errorOf(bad)).code).toBe('captcha_failed');
    expect(await rowsOf('c1@prot.io')).toHaveLength(0);
    expect((await start(await startBody(t, 'c1@prot.io'))).status).toBe(200);
  });

  it('cannot be turned on without the platform keys; removing them closes sign-up (503)', async () => {
    const removed = await t.api(owner).patch('/platform/captcha', { secret: null });
    expect(removed.status).toBe(200);
    const s = await body(await t.api(owner).get('/platform/signup-settings'));
    expect(s).toMatchObject({ open: false, ready: false, missing: ['captcha'] });
    const res = await start(await startBody(t, 'c2@prot.io'));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('signup_unavailable');
    expect((await settings({ enabled: true })).status).toBe(422);
    // Optional when the owner says so (then the platform's sign-up place decides — off here, so no check).
    expect((await settings({ require_captcha: false })).status).toBe(200);
    expect((await start(await startBody(t, 'c2@prot.io', { captcha_token: undefined }))).status).toBe(200);
    await t.api(owner).patch('/platform/captcha', { secret: 'signup-secret' });
    expect((await settings({ require_captcha: true })).status).toBe(200);
  });
});

describe('the form', () => {
  it('the honeypot: the same answer, nothing stored or sent', async () => {
    verify = mockTurnstile();
    const res = await start(await startBody(t, 'bot@prot.io', { website: 'http://spam.example' }));
    expect(await body(res)).toEqual({ ok: true });
    expect(await rowsOf('bot@prot.io')).toHaveLength(0);
    expect(t.mailer.sent.some((m) => m.to === 'bot@prot.io')).toBe(false);
  });

  it('joining needs the current version of every document that asks for consent', async () => {
    verify = mockTurnstile();
    const res = await start(await startBody(t, 'legal@prot.io', { accept_legal: [{ slug: 'terms', version: 1 }] }));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: 'legal_consent_required', details: { slugs: ['privacy'] } });
    const stale = await start(
      await startBody(t, 'legal@prot.io', {
        accept_legal: [
          { slug: 'terms', version: 9 },
          { slug: 'privacy', version: 1 },
        ],
      }),
    );
    expect((await errorOf(stale)).code).toBe('legal_consent_required');
  });

  it('a method the owner turned off is refused', async () => {
    verify = mockTurnstile();
    expect((await settings({ methods: ['google'] })).status).toBe(200);
    const res = await start(await startBody(t, 'm@prot.io'));
    expect((await errorOf(res)).code).toBe('signup_method_unavailable');
    expect((await body(await pub(t, 'GET', '/public/signup/config'))).methods).toEqual(['google']);
    expect((await settings({ methods: ['password', 'google', 'microsoft'] })).status).toBe(200);
  });
});

describe('address rules', () => {
  const refused = async (email: string, reason: string) => {
    verify = mockTurnstile();
    const res = await start(await startBody(t, email));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: 'signup_email_not_allowed', details: { reason } });
    expect(await rowsOf(email)).toHaveLength(0);
  };

  it('throw-away inboxes (built-in list and the owner’s additions, subdomains too)', async () => {
    await refused('x@mailinator.com', 'disposable');
    await refused('x@inbox.yopmail.com', 'disposable');
    expect((await settings({ disposable_domains: ['burner.example'] })).status).toBe(200);
    await refused('x@burner.example', 'disposable');
    expect((await settings({ block_disposable: false })).status).toBe(200);
    verify = mockTurnstile();
    expect((await start(await startBody(t, 'x@mailinator.com'))).status).toBe(200);
    expect((await settings({ block_disposable: true })).status).toBe(200);
  });

  it('block list, allow list, work email only', async () => {
    expect((await settings({ domain_block: ['blocked.io'] })).status).toBe(200);
    await refused('a@blocked.io', 'domain_blocked');
    await refused('a@eu.blocked.io', 'domain_blocked');
    expect((await settings({ domain_allow: ['corp.io'] })).status).toBe(200);
    await refused('a@other.io', 'domain_not_allowed');
    verify = mockTurnstile();
    expect((await start(await startBody(t, 'a@corp.io'))).status).toBe(200);
    expect((await settings({ domain_allow: [], domain_block: [], require_work_email: true })).status).toBe(200);
    await refused('someone@gmail.com', 'work_email_required');
    expect((await settings({ require_work_email: false })).status).toBe(200);
  });

  it('the rules are pure data (packages/shared)', () => {
    const rules = signupSettingsSchema.parse({});
    expect(signupEmailProblem('a@mailinator.com', rules)).toBe('disposable');
    expect(signupEmailProblem('a@acme.co.il', rules)).toBeNull();
    expect(signupEmailProblem('no-at-sign', rules)).toBe('domain_not_allowed');
    expect(signupEmailProblem('a@gmail.com', { ...rules, require_work_email: true })).toBe('work_email_required');
    expect(signupEmailProblem('a@x.io', { ...rules, domain_allow: ['x.io'], domain_block: ['x.io'] })).toBe(
      'domain_blocked',
    );
  });
});

describe('limits', () => {
  it('per client address per hour: 429 past `rate_ip_hour`', async () => {
    expect((await settings({ rate_ip_hour: 2 })).status).toBe(200);
    const ip = nextIp();
    for (const n of [1, 2]) {
      verify = mockTurnstile();
      expect((await start(await startBody(t, `ip${n}@prot.io`), ip)).status).toBe(200);
      verify.mockRestore();
    }
    verify = mockTurnstile();
    const third = await start(await startBody(t, 'ip3@prot.io'), ip);
    expect(third.status).toBe(429);
    expect((await errorOf(third)).code).toBe('rate_limited');
    // Another address is not affected.
    expect((await start(await startBody(t, 'ip3@prot.io'))).status).toBe(200);
    expect((await settings({ rate_ip_hour: 5 })).status).toBe(200);
  });

  it('per email per day: 429 past `rate_email_day`', async () => {
    expect((await settings({ rate_email_day: 2 })).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      verify = mockTurnstile();
      expect((await start(await startBody(t, 'same@prot.io'))).status).toBe(200);
      verify.mockRestore();
    }
    verify = mockTurnstile();
    const third = await start(await startBody(t, 'same@prot.io'));
    expect(third.status).toBe(429);
    // Only the newest link is live: starting again expired the earlier one.
    const rows = await rowsOf('same@prot.io');
    expect(rows.map((r) => r.status).sort()).toEqual(['expired', 'pending_email']);
    expect((await settings({ rate_email_day: 3 })).status).toBe(200);
  });

  it('the platform daily cap: 429 signup_daily_cap ("try tomorrow")', async () => {
    const used = (await t.db.select().from(signupRequests)).length;
    expect((await settings({ daily_cap: used })).status).toBe(200);
    verify = mockTurnstile();
    const res = await start(await startBody(t, 'cap@prot.io'));
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('signup_daily_cap');
    expect((await settings({ daily_cap: 50 })).status).toBe(200);
  });

  it('the daily sweep expires old links (with their password hash) and removes old ended requests', async () => {
    const { sweepSignup, SIGNUP_KEEP_DAYS } = await import('../src/modules/signup/signup.service');
    await t.db
      .update(signupRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(signupRequests.email, 'c1@prot.io'));
    const later = new Date(Date.now() + (SIGNUP_KEEP_DAYS + 1) * 86_400_000);
    const first = await sweepSignup(t.db as never);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const [row] = await rowsOf('c1@prot.io');
    expect(row).toMatchObject({ status: 'expired', passwordHash: null, tokenHash: null });
    const second = await sweepSignup(t.db as never, later);
    expect(second.deleted).toBeGreaterThanOrEqual(1);
    expect(await rowsOf('c1@prot.io')).toHaveLength(0);
  });
});
