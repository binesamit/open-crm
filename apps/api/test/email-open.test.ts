// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * what a click on an email address does — the user's own on GET / PUT /me/appearance (jsonb, every device)
 * else the account's default in `settings.defaults.email_open` (admins set it), else `ask` (the menu).
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id as string;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
});
afterAll(() => t.close());

describe('email click', () => {
  it('the menu by default; the account default applies to who never chose; mine wins; null goes back', async () => {
    expect(await body(await as(bob).get('/me/appearance'))).toMatchObject({ email_open: 'ask', user: {} });

    const patched = await as(admin).patch('/accounts/me', { settings: { defaults: { email_open: 'gmail' } } });
    expect(patched.status).toBe(200);
    expect((await body(patched)).settings.defaults.email_open).toBe('gmail');
    expect(await body(await as(bob).get('/me/appearance'))).toMatchObject({
      email_open: 'gmail',
      account_default: { email_open: 'gmail' },
    });

    const mine = await as(bob).put('/me/appearance', { email_open: 'outlook' });
    expect(mine.status).toBe(200);
    expect(await body(mine)).toMatchObject({ email_open: 'outlook', user: { email_open: 'outlook' } });
    expect(await body(await as(admin).get('/me/appearance'))).toMatchObject({ email_open: 'gmail' });

    const reset = await body(await as(bob).put('/me/appearance', { email_open: null }));
    expect(reset).toMatchObject({ email_open: 'gmail' });
    expect(reset.user.email_open).toBeUndefined();
  });
  it('rejects an unknown choice, and only admins set the default', async () => {
    expect((await as(bob).put('/me/appearance', { email_open: 'yahoo' })).status).toBe(400);
    expect((await as(admin).patch('/accounts/me', { settings: { defaults: { email_open: 'yahoo' } } })).status).toBe(
      400,
    );
    expect((await as(bob).patch('/accounts/me', { settings: { defaults: { email_open: 'ask' } } })).status).toBe(403);
  });
});
