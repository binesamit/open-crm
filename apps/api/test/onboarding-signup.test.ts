// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boards, workspaces } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { body, mockTurnstile, openSignup, pub, startBody, verifyTokenFor } from './signup-fixture';

/**
 * "How to start?" × self sign-up: with something to offer (a gallery kit), a new account opens
 * empty and its admin starts at the start screen; "skip" then builds the owner's sign-up kit after all.
 */
let t: TestContext;
let owner: string;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  mockTurnstile();
  await openSignup(t, owner, { starter_kit: 'crm-starter' });
});
afterAll(() => t.close());

const signUp = async (email: string) => {
  mockTurnstile();
  expect((await pub(t, 'POST', '/public/signup/start', await startBody(t, email))).status).toBe(200);
  const res = await pub(t, 'POST', '/public/signup/verify', { token: verifyTokenFor(t, email) });
  expect(res.status).toBe(200);
  const out = await body(res);
  return { accountId: out.account.id as string, cookie: t.cookieFrom(res)! };
};

describe('sign-up with the start screen', () => {
  it('no gallery kit and no AI: the sign-up kit is built at once (as before)', async () => {
    const { accountId, cookie } = await signUp('first@alpha-labs.io');
    expect((await t.db.select().from(boards).where(eq(boards.accountId, accountId))).length).toBeGreaterThanOrEqual(4);
    expect((await body(await t.api(cookie, accountId).get('/onboarding'))).pending).toBe(false);
  });

  it('with a gallery kit: the account opens empty, pending; "skip" builds the sign-up kit into its workspace', async () => {
    expect((await t.api(owner).patch('/platform/starter-kits/bines', { gallery: { show: true } })).status).toBe(200);
    const { accountId, cookie } = await signUp('second@beta-labs.io');
    expect(await t.db.select().from(boards).where(eq(boards.accountId, accountId))).toHaveLength(0);
    const api = t.api(cookie, accountId);
    const state = await body(await api.get('/onboarding'));
    expect(state).toMatchObject({ pending: true, can_build: true });
    expect(state.kits.map((k: { key: string }) => k.key)).toEqual(['bines']);
    expect((await api.post('/onboarding/skip', {})).status).toBe(200);
    const [ws] = await t.db.select().from(workspaces).where(eq(workspaces.accountId, accountId));
    const made = await t.db.select().from(boards).where(eq(boards.accountId, accountId));
    expect(made.length).toBeGreaterThanOrEqual(4);
    expect(made.every((b) => b.workspaceId === ws!.id)).toBe(true);
    expect((await body(await api.get('/onboarding'))).pending).toBe(false);
  });

  it('the owner can turn the start screen off: sign-ups build their kit at once again', async () => {
    expect((await t.api(owner).patch('/platform/signup-settings', { onboarding: { enabled: false } })).status).toBe(
      200,
    );
    const { accountId } = await signUp('third@gamma-labs.io');
    expect((await t.db.select().from(boards).where(eq(boards.accountId, accountId))).length).toBeGreaterThanOrEqual(4);
  });
});
