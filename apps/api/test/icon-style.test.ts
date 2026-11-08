// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * the icon style — the user's own on GET / PUT /me/appearance (jsonb, every device), else the account's
 * default in `settings.defaults.icon_style` (admins set it), else `duo`.
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

describe('icon style', () => {
  it('two-tone by default; the account default applies to who never chose; mine wins; null goes back', async () => {
    expect(await body(await as(bob).get('/me/appearance'))).toMatchObject({ icon_style: 'duo', user: {} });

    const patched = await as(admin).patch('/accounts/me', { settings: { defaults: { icon_style: 'line' } } });
    expect(patched.status).toBe(200);
    expect((await body(patched)).settings.defaults.icon_style).toBe('line');
    expect(await body(await as(bob).get('/me/appearance'))).toMatchObject({
      icon_style: 'line',
      account_default: { icon_style: 'line' },
    });
    // Without an account the default is not known.
    expect(await body(await t.api(bob).get('/me/appearance'))).toMatchObject({ icon_style: 'duo' });

    const mine = await as(bob).put('/me/appearance', { icon_style: 'sharp' });
    expect(mine.status).toBe(200);
    expect(await body(mine)).toMatchObject({ icon_style: 'sharp', user: { icon_style: 'sharp' } });
    // Per user: the admin still follows the account's default.
    expect(await body(await as(admin).get('/me/appearance'))).toMatchObject({ icon_style: 'line' });

    const reset = await body(await as(bob).put('/me/appearance', { icon_style: null }));
    expect(reset).toMatchObject({ icon_style: 'line' });
    expect(reset.user.icon_style).toBeUndefined();
  });
  it('rejects an unknown style, and only admins set the default', async () => {
    expect((await as(bob).put('/me/appearance', { icon_style: 'neon' })).status).toBe(400);
    expect((await as(admin).patch('/accounts/me', { settings: { defaults: { icon_style: 'neon' } } })).status).toBe(
      400,
    );
    expect((await as(bob).patch('/accounts/me', { settings: { defaults: { icon_style: 'duo' } } })).status).toBe(403);
  });
});
