// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { platformSettings, users } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/** First-run setup (standalone install): "Create the owner account" while no user exists — once, race-proof. */
let t: TestContext | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const PASSWORD = 'correct-horse-battery';

const post = (ctx: TestContext, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ctx.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

const status = async (ctx: TestContext) => (await ctx.app.request('/api/v1/setup')).json();

describe('first-run setup', () => {
  it('creates the platform owner, the first account and a session — then closes for good', async () => {
    t = await createTestContext({ env: { SEED_ADMIN_EMAIL: '' } });
    expect(await status(t)).toEqual({ required: true, email_enabled: true, password_min_length: 8 });

    const res = await post(t, { email: 'Founder@Example.com', password: PASSWORD, name: 'Founder', locale: 'en' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { id: string; slug: string } };
    expect(body.account.slug).toBe('main');
    const cookie = t.cookieFrom(res);
    expect(cookie).toBeDefined();

    // Signed in as the platform owner, admin of the first account, in the language chosen.
    const me = (await (await t.api(cookie).get('/auth/me')).json()) as {
      user: { email: string; is_platform_owner: boolean; locale: string };
    };
    expect(me.user).toMatchObject({ email: 'founder@example.com', is_platform_owner: true, locale: 'en' });
    const accounts = (await (await t.api(cookie).get('/me/accounts')).json()) as { data: { role: string }[] };
    expect(accounts.data).toEqual([expect.objectContaining({ id: body.account.id, role: 'admin' })]);

    // The password works on the ordinary sign-in.
    const signIn = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email: 'founder@example.com', password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);

    // Closed: no second owner, whatever the address.
    expect(await status(t)).toMatchObject({ required: false });
    const again = await post(t, { email: 'other@example.com', password: PASSWORD, name: 'Other' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('setup_done');
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it('is single even when requests race', async () => {
    t = await createTestContext({ env: { SEED_ADMIN_EMAIL: '' } });
    const ctx = t;
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((x) => post(ctx, { email: `${x}@example.com`, password: PASSWORD, name: x })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const all = await t.db.select().from(users);
    expect(all).toHaveLength(1);
    expect(all[0]!.isPlatformOwner).toBe(true);
  });

  it('a refused attempt (password too short) leaves the setup open', async () => {
    t = await createTestContext({ env: { SEED_ADMIN_EMAIL: '' } });
    const short = await post(t, { email: 'owner@example.com', password: 'abc1234', name: 'Owner' });
    expect(short.status).toBe(422);
    expect(((await short.json()) as { error: { message: string } }).error.message).toBe('password_min_length');
    expect(await t.db.select().from(platformSettings).where(eq(platformSettings.id, 'setup'))).toHaveLength(0);
    expect((await post(t, { email: 'owner@example.com', password: PASSWORD, name: 'Owner' })).status).toBe(200);
  });

  it('when the installation names its owner (SEED_ADMIN_EMAIL), only that address may set up', async () => {
    t = await createTestContext();
    const wrong = await post(t, { email: 'someone@example.com', password: PASSWORD, name: 'Someone' });
    expect(wrong.status).toBe(403);
    const right = await post(t, { email: OWNER_EMAIL, password: PASSWORD, name: 'Owner' });
    expect(right.status).toBe(200);
  });

  it('saves the product name, and the address it was opened at when the install left that to it', async () => {
    t = await createTestContext({ env: { SEED_ADMIN_EMAIL: '', AUTO_PUBLIC_ADDRESS: 'true' } });
    const res = await post(
      t,
      { email: 'owner@example.com', password: PASSWORD, name: 'Owner', product_name: 'Acme Work' },
      { origin: 'http://localhost:8080', host: 'localhost:8080' },
    );
    expect(res.status).toBe(200);
    const config = (await (await t.app.request('/api/v1/auth/config')).json()) as {
      branding: { product_name: { en: string } };
    };
    expect(config.branding.product_name.en).toBe('Acme Work');
    const settings = (await (await t.api(t.cookieFrom(res)).get('/platform/settings')).json()) as {
      public_address: { web: string };
    };
    expect(settings.public_address.web).toBe('http://localhost:8080');
  });

  it('never takes an address from a cross-site request', async () => {
    t = await createTestContext({ env: { SEED_ADMIN_EMAIL: '', AUTO_PUBLIC_ADDRESS: 'true' } });
    const res = await post(
      t,
      { email: 'owner@example.com', password: PASSWORD, name: 'Owner' },
      { origin: 'https://evil.example', host: 'localhost:3000' },
    );
    expect(res.status).toBe(200);
    const settings = (await (await t.api(t.cookieFrom(res)).get('/platform/settings')).json()) as {
      public_address: { web: string };
    };
    expect(settings.public_address.web).toBe(WEB_ORIGIN);
  });
});

describe('email off', () => {
  it('the sign-in screen offers no email link and the owner console says email is off', async () => {
    t = await createTestContext({ env: { SEED_ADMIN_EMAIL: '' } });
    // The test context injects a mailer (email on); a deployment without a transport has emailEnabled false.
    t.deps.emailEnabled = false;
    const config = (await (await t.app.request('/api/v1/auth/config')).json()) as { magic_link: boolean };
    expect(config.magic_link).toBe(false);
    expect(await status(t)).toMatchObject({ email_enabled: false });
    const res = await post(t, { email: 'owner@example.com', password: PASSWORD, name: 'Owner' });
    const settings = (await (await t.api(t.cookieFrom(res)).get('/platform/settings')).json()) as {
      email_enabled: boolean;
    };
    expect(settings.email_enabled).toBe(false);
  });
});
