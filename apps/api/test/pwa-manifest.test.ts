// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { PNG } from 'pngjs';
import { newId, PUSH_DEFAULT_CATEGORIES } from '@bines/shared';
import { localTime } from '../../worker/src/notifications';
import { dispatchPush, type PushSender, type Vapid } from '../../worker/src/push';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import {
  accountMembers,
  accounts,
  assets,
  notifications,
  notificationSettings,
  pushSubscriptions,
} from '../src/db/schema';
import { spaCsp } from '../src/middleware/security-headers';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/** r19pwa (the planning notes "PWA"): manifest per account, icons, no-store, VAPID, devices, the phone channel, dispatch. */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let bobId: string;
let boardId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const db = () => t.pg as unknown as SqlClient;
const as = (cookie: string) => t.api(cookie, acmeId);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const KEYS = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** A fake push service: records what it got, answers with `status`. */
const fakeSender = (status = 201) => {
  const sent: { endpoint: string; payload: Json }[] = [];
  const sender: PushSender = async (target, payload) => {
    sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as Json });
    return { statusCode: status };
  };
  return { sent, sender };
};
const VAPID: Vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:push@example.com' };
const pushDeps = (sender: PushSender) => ({ sender, appUrl: 'https://app.test', vapid: async () => VAPID });

const mentionBob = async (text = 'תבדוק') => {
  await as(admin).post(`/items/${itemId}/updates`, { body: `[@Bob](user:${bobId}) ${text}` });
  const [n] = await t.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, bobId), eq(notifications.type, 'mention')))
    .orderBy(desc(notifications.id))
    .limit(1);
  return n!.id;
};
const subscribeBob = (endpoint = ENDPOINT) => as(bob).post('/me/push-subscriptions', { endpoint, keys: KEYS });

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
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
    (u) => u.email === 'bob@acme.test',
  )!.user_id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: ws.id }))).id;
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Deal X' }))).id;
});
beforeEach(async () => {
  await t.db.delete(notificationSettings);
  await t.db.delete(pushSubscriptions);
});
afterAll(() => t.close());

describe('manifest and icons (פ1)', () => {
  it("serves the account's manifest from its settings, and the platform's without one", async () => {
    await as(admin).patch('/accounts/me', {
      settings: { pwa: { app_name: 'Acme App', theme_color: '#112233', start_page: 'inbox' } },
    });
    const res = await t.app.request(`/api/v1/public/pwa/a/${acmeId}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const m = await body(res);
    expect(m).toMatchObject({
      id: '/a/acme/',
      name: 'Acme App',
      start_url: '/a/acme/inbox',
      scope: '/',
      display: 'standalone',
      theme_color: '#112233',
      background_color: '#112233',
      dir: 'rtl',
      lang: 'he',
    });
    expect((m.icons as Json[]).map((i) => [i.sizes, i.purpose])).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ]);
    expect(m.icons[0].src).toMatch(new RegExp(`^/api/v1/public/pwa/a/${acmeId}/icon/192\\.png\\?v=`));

    // Back to the defaults: the account's name, my work, the built-in colour.
    await as(admin).patch('/accounts/me', {
      settings: { pwa: { app_name: null, theme_color: null, start_page: 'my_work' } },
    });
    const d = await body(await t.app.request(`/api/v1/public/pwa/a/${acmeId}/manifest.webmanifest`));
    expect(d).toMatchObject({ name: 'Acme', start_url: '/a/acme/my-work', theme_color: '#0d3b35' });

    const platform = await body(await t.app.request('/api/v1/public/pwa/manifest.webmanifest'));
    expect(platform).toMatchObject({ id: '/', start_url: '/', theme_color: '#0d3b35' });
    expect((await t.app.request(`/api/v1/public/pwa/a/${newId()}/manifest.webmanifest`)).status).toBe(404);
  });

  it("follows the owner's default colour and name when the account chose none", async () => {
    await t.api(owner).patch('/platform/settings', { pwa: { theme_color: '#aa0000', app_name: 'Work OS' } });
    try {
      const m = await body(await t.app.request(`/api/v1/public/pwa/a/${acmeId}/manifest.webmanifest`));
      expect(m.theme_color).toBe('#aa0000');
      const p = await body(await t.app.request('/api/v1/public/pwa/manifest.webmanifest'));
      expect(p).toMatchObject({ name: 'Work OS', theme_color: '#aa0000' });
    } finally {
      await t.api(owner).patch('/platform/settings', { pwa: { theme_color: null, app_name: null } });
    }
  });

  it('draws PNG icons in every size: the neutral mark without a logo, the logo when there is one', async () => {
    for (const [file, size] of [
      ['192', 192],
      ['512', 512],
      ['maskable-512', 512],
      ['apple-180', 180],
    ] as const) {
      const res = await t.app.request(`/api/v1/public/pwa/a/${acmeId}/icon/${file}.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      expect([png.width, png.height]).toEqual([size, size]);
    }
    const plain = PNG.sync.read(
      Buffer.from(await (await t.app.request(`/api/v1/public/pwa/a/${acmeId}/icon/192.png`)).arrayBuffer()),
    );
    // Corner = the brand colour (#0d3b35).
    expect([...plain.data.subarray(0, 3)]).toEqual([0x0d, 0x3b, 0x35]);

    // A red 40×20 logo: the icon is white around it and red in the middle.
    const logo = new PNG({ width: 40, height: 20 });
    for (let i = 0; i < 40 * 20; i++) logo.data.set([220, 20, 20, 255], i * 4);
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
      const icon = PNG.sync.read(
        Buffer.from(await (await t.app.request(`/api/v1/public/pwa/a/${acmeId}/icon/512.png`)).arrayBuffer()),
      );
      const px = (x: number, y: number) => [...icon.data.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 3)];
      expect(px(2, 2)).toEqual([255, 255, 255]);
      expect(px(256, 256)).toEqual([220, 20, 20]);
    } finally {
      await t.db.update(accounts).set({ logoAssetId: null }).where(eq(accounts.id, acmeId));
    }
    expect((await t.app.request(`/api/v1/public/pwa/a/${acmeId}/icon/77.png`)).status).toBe(400);
  });
});

describe('security (פ2)', () => {
  it('every API answer is no-store unless the route chose its own caching', async () => {
    expect((await as(bob).get('/pwa/config')).headers.get('cache-control')).toBe('no-store');
    expect((await t.api(bob).get('/auth/me')).headers.get('cache-control')).toBe('no-store');
    expect((await t.app.request('/api/v1/health')).headers.get('cache-control')).toBe('no-store');
    expect((await t.app.request('/api/v1/public/pwa/icon/192.png')).headers.get('cache-control')).toContain('max-age');
  });

  it("the page's CSP allows the manifest and the service worker from our origin only", () => {
    const csp = spaCsp({ NODE_ENV: 'production', S3_ENDPOINT: undefined });
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("worker-src 'self'");
  });

  it('the kill switch is the owner’s (public status)', async () => {
    expect(await body(await t.app.request('/api/v1/public/pwa/status'))).toMatchObject({ sw_enabled: true });
    await t.api(owner).patch('/platform/settings', { pwa: { sw_enabled: false } });
    try {
      // Cached for up to 30s per database handle: read the saved row instead of waiting.
      const s = await body(await t.api(owner).get('/platform/settings'));
      expect(s.settings.pwa.sw_enabled).toBe(false);
    } finally {
      await t.api(owner).patch('/platform/settings', { pwa: { sw_enabled: true } });
    }
  });
});

describe('config, VAPID and devices (פ4)', () => {
  it('creates one VAPID pair, kept out of the platform settings answer', async () => {
    const a = await body(await as(bob).get('/pwa/config'));
    expect(a).toMatchObject({ push_enabled: true, install_prompt: true, install_prompt_after: 3 });
    expect(Buffer.from(a.vapid_public_key, 'base64url')).toHaveLength(65);
    expect(a.manifest_url).toBe(`/api/v1/public/pwa/a/${acmeId}/manifest.webmanifest`);
    const b = await body(await as(admin).get('/pwa/config'));
    expect(b.vapid_public_key).toBe(a.vapid_public_key);
    const platform = JSON.stringify(await body(await t.api(owner).get('/platform/settings')));
    expect(platform).not.toContain(a.vapid_public_key);
  });

  it('registers, lists (current marked), re-registers in place and removes my devices', async () => {
    const created = await subscribeBob();
    expect(created.status).toBe(201);
    const row = await body(created);
    expect(row).toMatchObject({ current: true });
    expect((await subscribeBob()).status).toBe(201);
    await subscribeBob('https://fcm.googleapis.com/fcm/send/other');
    const list = await body(await as(bob).get(`/me/push-subscriptions?endpoint=${encodeURIComponent(ENDPOINT)}`));
    expect(list.data).toHaveLength(2);
    expect((list.data as Json[]).filter((d) => d.current)).toHaveLength(1);

    // Someone else's device: 404; mine: removed.
    expect((await as(admin).del(`/me/push-subscriptions/${row.id}`)).status).toBe(404);
    expect((await as(bob).del(`/me/push-subscriptions/${row.id}`)).status).toBe(200);
    expect((await body(await as(bob).get('/me/push-subscriptions'))).data).toHaveLength(1);

    // Sign-out on this browser: the endpoint leaves every account.
    const out = await body(
      await t
        .api(bob)
        .post('/me/push-subscriptions/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/other' }),
    );
    expect(out).toEqual({ ok: true, removed: 1 });
    expect((await body(await as(bob).get('/me/push-subscriptions'))).data).toHaveLength(0);
  });

  it('refuses a non-https endpoint, and push where the admin switched it off', async () => {
    // Audit 2026-10-10 #4: only the known push services — never an internal or any other host.
    for (const endpoint of [
      'https://10.0.0.5:8443/admin',
      'https://evil.example/push',
      'https://fcm.googleapis.com.evil.example/x',
    ])
      expect((await as(bob).post('/me/push-subscriptions', { endpoint, keys: KEYS })).status, endpoint).toBe(400);
    expect((await as(bob).post('/me/push-subscriptions', { endpoint: 'http://x.test/a', keys: KEYS })).status).toBe(
      400,
    );
    await as(admin).patch('/accounts/me', { settings: { pwa: { push_enabled: false } } });
    try {
      const c = await body(await as(bob).get('/pwa/config'));
      expect(c).toMatchObject({ push_enabled: false, vapid_public_key: null });
      expect((await subscribeBob()).status).toBe(403);
    } finally {
      await as(admin).patch('/accounts/me', { settings: { pwa: { push_enabled: true } } });
    }
  });

  it('a device ends with its sign-in session', async () => {
    const { cookie } = await t.signInWithMagicLink('bob@acme.test');
    await t.api(cookie!, acmeId).post('/me/push-subscriptions', { endpoint: ENDPOINT, keys: KEYS });
    expect(await t.db.select().from(pushSubscriptions)).toHaveLength(1);
    const res = await t.app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { cookie: cookie!, origin: WEB_ORIGIN, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await t.db.select().from(pushSubscriptions)).toHaveLength(0);
  });
});

describe('the phone channel in the settings', () => {
  it('starts with assignment and mention only; categories, quiet hours and the badge are mine to change', async () => {
    const s = await body(await as(bob).get('/me/notifications/settings'));
    const pushOn = (s.categories as Json[]).filter((c) => c.push).map((c) => c.key);
    expect(pushOn).toEqual([...PUSH_DEFAULT_CATEGORIES]);
    expect((s.categories as Json[]).every((c) => c.bell && c.email)).toBe(true);
    expect(s).toMatchObject({ quiet: { enabled: false }, badge: true });

    const next = await body(
      await as(bob).patch('/me/notifications/settings', {
        categories: [
          { key: 'item_updates', push: true },
          { key: 'mentioned', push: false },
        ],
        quiet: { enabled: true, from: 22, to: 7 },
        badge: false,
      }),
    );
    const cats = Object.fromEntries((next.categories as Json[]).map((c) => [c.key, c.push]));
    expect(cats).toEqual({ assigned: true, mentioned: false, item_updates: true, reminders: false });
    expect(next).toMatchObject({ quiet: { enabled: true, from: 22, to: 7 }, badge: false });
  });

  it('the account default decides for members who have not chosen', async () => {
    await as(admin).patch('/accounts/me', {
      settings: {
        notifications: {
          categories: [
            { key: 'assigned', bell: true, email: true, push: false },
            { key: 'reminders', bell: true, email: true, push: true },
          ],
        },
      },
    });
    try {
      const s = await body(await as(bob).get('/me/notifications/settings'));
      const cats = Object.fromEntries((s.categories as Json[]).map((c) => [c.key, c.push]));
      expect(cats).toEqual({ assigned: false, mentioned: true, item_updates: false, reminders: true });
    } finally {
      await as(admin).patch('/accounts/me', { settings: { notifications: { categories: [] } } });
    }
  });
});

describe('notifications.push (fake push service)', () => {
  it('sends the bell sentence, a link to the update and the unread count to each phone', async () => {
    await subscribeBob();
    const id = await mentionBob('מה המצב עם ההצעה?');
    const fake = fakeSender();
    expect(await dispatchPush(db(), pushDeps(fake.sender), id)).toBe('sent');
    expect(fake.sent).toHaveLength(1);
    const p = fake.sent[0]!.payload;
    expect(p.title).toBe('Acme');
    expect(p.body).toContain('Deal X');
    expect(p.body).toContain('מה המצב עם ההצעה?');
    // s37reply: the link opens the mentioning update's own thread.
    expect(p.url).toMatch(new RegExp(`^/a/acme/b/${boardId}/i/${itemId}\\?tab=updates&update=[0-9A-Z]{26}$`));
    expect(p.tag).toBe(id);
    expect(p.badge).toBeGreaterThanOrEqual(1);
    const [row] = await t.db.select().from(pushSubscriptions);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('"just a notification" on the lock screen: no text leaves the server', async () => {
    await subscribeBob();
    await as(admin).patch('/accounts/me', { settings: { pwa: { lock_screen: 'generic' } } });
    try {
      const fake = fakeSender();
      expect(await dispatchPush(db(), pushDeps(fake.sender), await mentionBob('סוד גדול'))).toBe('sent');
      const p = fake.sent[0]!.payload;
      expect(JSON.stringify(p)).not.toContain('סוד גדול');
      expect(p.body).not.toContain('Deal X');
    } finally {
      await as(admin).patch('/accounts/me', { settings: { pwa: { lock_screen: 'full' } } });
    }
  });

  it('removes a subscription the push service no longer knows (410), counts other failures', async () => {
    await subscribeBob();
    const gone = fakeSender(410);
    expect(await dispatchPush(db(), pushDeps(gone.sender), await mentionBob())).toBe('failed');
    expect(await t.db.select().from(pushSubscriptions)).toHaveLength(0);

    await subscribeBob();
    const down = fakeSender(503);
    expect(await dispatchPush(db(), pushDeps(down.sender), await mentionBob())).toBe('failed');
    const [row] = await t.db.select().from(pushSubscriptions);
    expect(row!.failures).toBe(1);
  });

  it('honours read state, categories, quiet hours, the switches and membership', async () => {
    const fake = fakeSender();
    const deps = pushDeps(fake.sender);
    expect(await dispatchPush(db(), deps, await mentionBob())).toBe('no_devices');
    await subscribeBob();

    const read = await mentionBob();
    await as(bob).post('/me/notifications/read', { ids: [read] });
    expect(await dispatchPush(db(), deps, read)).toBe('read');

    await as(bob).patch('/me/notifications/settings', { categories: [{ key: 'mentioned', push: false }] });
    expect(await dispatchPush(db(), deps, await mentionBob())).toBe('disabled');
    await t.db.delete(notificationSettings);

    // A board silenced in my bell is silent on the phone.
    await as(bob).put(`/boards/${boardId}/notifications`, { muted: true });
    const mutedId = newId();
    await t.db.insert(notifications).values({
      id: mutedId,
      accountId: acmeId,
      userId: bobId,
      type: 'mention',
      boardId,
      itemId,
      payload: {},
    });
    expect(await dispatchPush(db(), deps, mutedId)).toBe('disabled');
    await t.db.delete(notificationSettings);

    const now = new Date();
    const hour = localTime(now, null, 'Asia/Jerusalem').hour;
    await as(bob).patch('/me/notifications/settings', { quiet: { enabled: true, from: hour, to: (hour + 1) % 24 } });
    expect(await dispatchPush(db(), deps, await mentionBob(), now)).toBe('quiet');
    await t.db.delete(notificationSettings);

    await t.api(owner).patch('/platform/settings', { pwa: { push_enabled: false } });
    try {
      // The owner's switch is read through a 30s cache in the API; the worker reads the row.
      expect(await dispatchPush(db(), deps, await mentionBob())).toBe('platform_off');
    } finally {
      await t.api(owner).patch('/platform/settings', { pwa: { push_enabled: true } });
    }

    await as(admin).patch('/accounts/me', { settings: { pwa: { push_enabled: false } } });
    expect(await dispatchPush(db(), deps, await mentionBob())).toBe('account_off');
    await as(admin).patch('/accounts/me', { settings: { pwa: { push_enabled: true } } });

    const id = await mentionBob();
    await t.db
      .update(accountMembers)
      .set({ status: 'deactivated' })
      .where(and(eq(accountMembers.accountId, acmeId), eq(accountMembers.userId, bobId)));
    try {
      expect(await dispatchPush(db(), deps, id)).toBe('not_member');
      expect(await t.db.select().from(pushSubscriptions)).toHaveLength(0);
    } finally {
      await t.db
        .update(accountMembers)
        .set({ status: 'active' })
        .where(and(eq(accountMembers.accountId, acmeId), eq(accountMembers.userId, bobId)));
    }
    expect(fake.sent).toHaveLength(0);
  });

  it('a phone-only category still writes the notification (hidden from the bell) for the push', async () => {
    await as(bob).patch('/me/notifications/settings', {
      categories: [{ key: 'mentioned', bell: false, email: false, push: true }],
    });
    await subscribeBob();
    const id = await mentionBob('רק לטלפון');
    const [n] = await t.db.select().from(notifications).where(eq(notifications.id, id));
    expect(n!.payload).toMatchObject({ bell: false });
    const fake = fakeSender();
    expect(await dispatchPush(db(), pushDeps(fake.sender), id)).toBe('sent');
  });
});
