// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legalDocuments, platformAuditLog, platformSettings } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { body, openSignup, pub } from './signup-fixture';

/**
 * The owner console's "first steps" card (SIGNUP plan, decision 12) and what the sign-up card says about the
 * installation (`edition`): every step is read from the real settings, so it ticks itself as the owner sets things
 * up; closing the card is stored once; only the platform owner reaches it.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const doneOf = (r: Json) => Object.fromEntries((r.steps as Json[]).map((s) => [s.key, s.done]));

describe('first steps', () => {
  let t: TestContext;
  let owner: string;
  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  }, 180_000);
  afterAll(() => t.close());

  const steps = async () => {
    const res = await t.api(owner).get('/platform/first-steps');
    expect(res.status).toBe(200);
    return body(res);
  };

  it('lists the steps in order; each flips to done as the setting is put in place', async () => {
    const first = await steps();
    expect(first.steps.map((s: Json) => s.key)).toEqual(['email', 'legal', 'plan', 'signup']);
    expect(first.dismissed).toBe(false);
    // The built-in legal documents ask for consent; no plan yet; sign-up off.
    expect(doneOf(first)).toEqual({ email: true, legal: true, plan: false, signup: false });

    // No document asking for consent → the legal step is open again.
    await t.db.update(legalDocuments).set({ requiresConsent: false });
    expect(doneOf(await steps()).legal).toBe(false);
    await t.db.update(legalDocuments).set({ requiresConsent: true });

    // No outbound email.
    t.deps.emailEnabled = false;
    try {
      expect(doneOf(await steps()).email).toBe(false);
    } finally {
      t.deps.emailEnabled = undefined;
    }

    // A public plan, then sign-up on and ready.
    await openSignup(t, owner);
    expect(doneOf(await steps())).toEqual({ email: true, legal: true, plan: true, signup: true });
  });

  it('dismiss: stored once, the card stays closed; logged in the platform audit', async () => {
    const res = await t.api(owner).post('/platform/first-steps/dismiss');
    expect(res.status).toBe(200);
    expect((await body(res)).dismissed).toBe(true);
    expect((await steps()).dismissed).toBe(true);
    const [row] = await t.db.select().from(platformSettings).where(eq(platformSettings.id, 'first_steps'));
    expect(typeof (row!.settings as Json).dismissed_at).toBe('string');
    const audit = await t.db
      .select()
      .from(platformAuditLog)
      .where(eq(platformAuditLog.action, 'first_steps.dismissed'));
    expect(audit).toHaveLength(1);
  });

  it('only the platform owner: 401 without a session, 404 to a member', async () => {
    expect((await pub(t, 'GET', '/platform/first-steps')).status).toBe(401);
    expect((await pub(t, 'POST', '/platform/first-steps/dismiss', {})).status).toBe(401);
    const created = await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'empty',
    });
    expect(created.status).toBe(201);
    const token = t.inviteTokenFor('admin@acme.test');
    const member = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
    expect(member).toBeTruthy();
    await t.api(member).post('/invitations/accept', { token });
    expect((await t.api(member).get('/platform/first-steps')).status).toBe(404);
    expect((await t.api(member).post('/platform/first-steps/dismiss')).status).toBe(404);
  });
});
