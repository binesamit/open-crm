// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_N8N_PACKAGE } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * the n8n package and the Make app's invitation link are Platform settings (owner console); every
 * account member reads them with the instance URL (GET /auth/integrations) for the "n8n and Make" steps.
 */
let t: TestContext;
let owner: string;
let admin: string;
let accountId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const MAKE_LINK = 'https://www.make.com/en/hq/app-invitation/0123456789abcdef';

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  accountId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id as string;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
});
afterAll(() => t.close());

describe('n8n and Make — Platform settings and GET /auth/integrations', () => {
  it("the built-in package name is the n8n package's real name", () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../integrations/n8n-nodes-bines-os/package.json', import.meta.url), 'utf8'),
    ) as { name: string };
    expect(DEFAULT_N8N_PACKAGE).toBe(pkg.name);
  });

  it('defaults: the built-in package, no Make link, the instance URL', async () => {
    const settings = await body(await t.api(owner).get('/platform/settings'));
    expect(settings.settings.integrations).toEqual({});
    expect(settings.fallbacks.n8n_package).toBe(DEFAULT_N8N_PACKAGE);
    const res = await t.api(admin, accountId).get('/auth/integrations');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      base_url: WEB_ORIGIN,
      api_base: `${WEB_ORIGIN}/api/v1`,
      n8n_package: DEFAULT_N8N_PACKAGE,
      make_invitation_url: null,
    });
  });

  it('the owner sets and clears them; bad values are refused; members read them', async () => {
    const saved = await t.api(owner).patch('/platform/settings', {
      integrations: { n8n_package: '@acme/n8n-nodes-work', make_invitation_url: MAKE_LINK },
    });
    expect(saved.status).toBe(200);
    expect((await body(saved)).settings.integrations).toEqual({
      n8n_package: '@acme/n8n-nodes-work',
      make_invitation_url: MAKE_LINK,
    });
    expect(await body(await t.api(admin, accountId).get('/auth/integrations'))).toMatchObject({
      n8n_package: '@acme/n8n-nodes-work',
      make_invitation_url: MAKE_LINK,
    });
    // Only the owner changes them; a plain http link or an invalid package name is refused.
    expect((await t.api(admin).patch('/platform/settings', { integrations: { n8n_package: 'x' } })).status).not.toBe(
      200,
    );
    for (const bad of [{ make_invitation_url: 'http://make.example/x' }, { n8n_package: 'Not A Package' }])
      expect((await t.api(owner).patch('/platform/settings', { integrations: bad })).status).toBe(400);
    // Changing one leaves the other; null = back to the default.
    await t.api(owner).patch('/platform/settings', { integrations: { n8n_package: null } });
    expect(await body(await t.api(admin, accountId).get('/auth/integrations'))).toMatchObject({
      n8n_package: DEFAULT_N8N_PACKAGE,
      make_invitation_url: MAKE_LINK,
    });
    await t.api(owner).patch('/platform/settings', { integrations: { make_invitation_url: null } });
    expect((await body(await t.api(admin, accountId).get('/auth/integrations'))).make_invitation_url).toBeNull();
  });

  it('needs a session — not an API token, not anonymous', async () => {
    expect((await t.api(undefined, accountId).get('/auth/integrations')).status).toBe(401);
    const tok = await body(await t.api(admin, accountId).post('/auth/tokens', { name: 'n8n', scopes: ['admin'] }));
    const res = await t.app.request('/api/v1/auth/integrations', {
      headers: { authorization: `Bearer ${tok.token}`, origin: WEB_ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});
