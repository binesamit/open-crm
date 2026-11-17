// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * F9 cardw: the item card's width — the user's own (dragged) width on GET / PUT /me/appearance (jsonb, every
 * device), and the account's default width + limits in `settings.defaults` (admins set them; members read them).
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

describe('my card width', () => {
  it('none until dragged; saved beside the text size; null goes back to the default', async () => {
    expect(await body(await as(bob).get('/me/appearance'))).toMatchObject({ card_width: null, user: {} });
    await as(bob).put('/me/appearance', { text_size: 'large' });
    const put = await as(bob).put('/me/appearance', { card_width: 720 });
    expect(put.status).toBe(200);
    expect(await body(put)).toMatchObject({
      card_width: 720,
      text_size: 'large',
      user: { card_width: 720, text_size: 'large' },
    });
    // Another device (a fresh read) gets it.
    expect(await body(await as(bob).get('/me/appearance'))).toMatchObject({ card_width: 720 });
    // Per user: the admin's stays the default.
    expect(await body(await as(admin).get('/me/appearance'))).toMatchObject({ card_width: null });
    const reset = await body(await as(bob).put('/me/appearance', { card_width: null }));
    expect(reset).toMatchObject({ card_width: null, text_size: 'large' });
    expect(reset.user.card_width).toBeUndefined();
  });
  it('rejects a nonsense width', async () => {
    for (const card_width of [10, 99999, 300.5, '600'])
      expect((await as(bob).put('/me/appearance', { card_width })).status, String(card_width)).toBe(400);
  });
});

describe('the account default and limits', () => {
  it('start at 40% / 380px / 90%; an admin changes one without touching the others', async () => {
    expect((await body(await as(bob).get('/accounts/me'))).settings.defaults).toMatchObject({
      card_width_pct: 40,
      card_min_px: 380,
      card_max_pct: 90,
    });
    const res = await as(admin).patch('/accounts/me', { settings: { defaults: { card_width_pct: 55 } } });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.defaults).toMatchObject({
      card_width_pct: 55,
      card_min_px: 380,
      card_max_pct: 90,
    });
    await as(admin).patch('/accounts/me', { settings: { defaults: { card_min_px: 420, card_max_pct: 75 } } });
    // Every member reads them (the card needs them).
    expect((await body(await as(bob).get('/accounts/me'))).settings.defaults).toMatchObject({
      card_width_pct: 55,
      card_min_px: 420,
      card_max_pct: 75,
      item_terminology: 'item',
    });
  });
  it('out of range is refused; members cannot change them', async () => {
    for (const d of [{ card_width_pct: 5 }, { card_min_px: 50 }, { card_max_pct: 100 }, { card_min_px: 400.5 }])
      expect((await as(admin).patch('/accounts/me', { settings: { defaults: d } })).status).toBe(400);
    expect((await as(bob).patch('/accounts/me', { settings: { defaults: { card_width_pct: 30 } } })).status).toBe(403);
  });
});
