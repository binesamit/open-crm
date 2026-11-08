// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PNG } from 'pngjs';
import { newId } from '@bines/shared';
import { accounts, assets } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** f9-icon: the browser tab's icon = the account's home-screen icon drawn at 32×32 (same pipeline, same logo). */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const read = async (res: Response) => PNG.sync.read(Buffer.from(await res.arrayBuffer()));

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
});
afterAll(() => t.close());

describe('the tab icon (favicon)', () => {
  it('renders 32×32 for the platform and for an account, cached like the other icons', async () => {
    for (const url of [
      '/api/v1/public/pwa/icon/favicon-32.png',
      `/api/v1/public/pwa/a/${acmeId}/icon/favicon-32.png`,
    ]) {
      const res = await t.app.request(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
      const png = await read(res);
      expect([png.width, png.height]).toEqual([32, 32]);
      // Corner = the built-in colour (#0d3b35), like the home-screen icon.
      expect([...png.data.subarray(0, 3)]).toEqual([0x0d, 0x3b, 0x35]);
    }
    expect((await t.app.request(`/api/v1/public/pwa/a/${acmeId}/icon/favicon-16.png`)).status).toBe(400);
  });

  it("the account's config points at it, versioned like the home-screen icon; it follows the colour and the logo", async () => {
    const config = await body(await t.api(admin, acmeId).get('/pwa/config'));
    expect(config.favicon_url).toMatch(new RegExp(`^/api/v1/public/pwa/a/${acmeId}/icon/favicon-32\\.png\\?v=`));
    expect(config.favicon_url.split('?v=')[1]).toBe(config.apple_icon_url.split('?v=')[1]);

    // The admin's colour.
    expect(
      (await t.api(admin, acmeId).patch('/accounts/me', { settings: { pwa: { theme_color: '#123456' } } })).status,
    ).toBe(200);
    const recoloured = await body(await t.api(admin, acmeId).get('/pwa/config'));
    expect(recoloured.favicon_url).not.toBe(config.favicon_url);
    const tinted = await read(await t.app.request(`/api/v1/public/pwa/a/${acmeId}/icon/favicon-32.png`));
    expect([...tinted.data.subarray(0, 3)]).toEqual([0x12, 0x34, 0x56]);

    // The account's logo: white tile, the logo in the middle.
    const logo = new PNG({ width: 20, height: 20 });
    for (let i = 0; i < 20 * 20; i++) logo.data.set([220, 20, 20, 255], i * 4);
    const bytes = PNG.sync.write(logo);
    const assetId = newId();
    await t.db.insert(assets).values({
      id: assetId,
      accountId: acmeId,
      storageKey: `logos/${assetId}`,
      fileName: 'logo.png',
      mime: 'image/png',
      size: bytes.length,
      uploadStatus: 'uploaded',
    });
    t.storage.markUploaded(`logos/${assetId}`, bytes.length, 'image/png', bytes);
    await t.db.update(accounts).set({ logoAssetId: assetId }).where(eq(accounts.id, acmeId));
    try {
      const withLogo = await body(await t.api(admin, acmeId).get('/pwa/config'));
      expect(withLogo.favicon_url).toContain(assetId);
      const icon = await read(await t.app.request(withLogo.favicon_url));
      const px = (x: number, y: number) => [...icon.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3)];
      expect(px(0, 0)).toEqual([255, 255, 255]);
      expect(px(16, 16)).toEqual([220, 20, 20]);
    } finally {
      await t.db.update(accounts).set({ logoAssetId: null }).where(eq(accounts.id, acmeId));
    }
  });
});
