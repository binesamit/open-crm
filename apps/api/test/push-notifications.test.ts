// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { PWA_BREAKING_EPOCH, VAPID_ROW_ID } from '@bines/shared';
import { swMarkRead } from '../../web/src/pwa/precache';
import { dispatchPush, type PushSender, vapidFrom } from '../../worker/src/push';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import { notifications, platformSettings, pushSubscriptions } from '../src/db/schema';
import { setServedBuild } from '../src/modules/pwa/build';
import { loadVapid, resetVapidCache } from '../src/modules/pwa/vapid';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * s4f-pwa (the planning notes "PWA", the leftovers): a clicked push marks its notification read, leaving / removal from an
 * account ends push there at once, the VAPID private key is sealed at rest with SECRET_MASTER_KEY, and the public
 * status carries the build + breaking epoch the pages compare with.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let betaId: string;
let bobId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const db = () => t.pg as unknown as SqlClient;
const as = (cookie: string, account = acmeId) => t.api(cookie, account);
const KEYS = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};
const subscribe = (cookie: string, account: string, endpoint: string) =>
  as(cookie, account).post('/me/push-subscriptions', { endpoint, keys: KEYS });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const create = async (name: string, slug: string, firstAdmin: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name,
          slug,
          first_admin_email: firstAdmin,
          template_set: 'empty',
        }),
      )
    ).account.id as string;
  acmeId = await create('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  // Bob is also in a second account: his session outlives a removal from Acme.
  betaId = await create('Beta', 'beta', 'bob@acme.test');
  await t.api(bob).post('/invitations/accept', { token: t.inviteTokenFor('bob@acme.test') });
  bobId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
    (u) => u.email === 'bob@acme.test',
  )!.user_id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  const boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: ws.id }))).id;
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Deal X' }))).id;
});
beforeEach(async () => {
  await t.db.delete(pushSubscriptions);
});
afterAll(() => t.close());

const mentionBob = async () => {
  await as(admin).post(`/items/${itemId}/updates`, { body: `[@Bob](user:${bobId}) תבדוק` });
  const [n] = await t.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, bobId), eq(notifications.type, 'mention')))
    .orderBy(desc(notifications.id))
    .limit(1);
  return n!.id;
};

describe('a clicked push marks its notification read (a)', () => {
  it('the push carries the ids; the service worker request marks exactly that one read with the session cookie', async () => {
    await subscribe(bob, acmeId, 'https://fcm.googleapis.com/fcm/send/a1');
    const id = await mentionBob();
    const other = await mentionBob();
    const sent: Json[] = [];
    const sender: PushSender = async (_target, payload) => {
      sent.push(JSON.parse(payload) as Json);
      return { statusCode: 201 };
    };
    const deps = {
      sender,
      appUrl: '',
      vapid: async () => ({ publicKey: 'p', privateKey: 'k', subject: 'mailto:x@y.z' }),
    };
    expect(await dispatchPush(db(), deps, id)).toBe('sent');
    const payload = sent[0]!;
    expect(payload).toMatchObject({ tag: id, account_id: acmeId });

    // What sw.js stores on the notification and sends on click (src/pwa/sw.template.js).
    const req = swMarkRead({ url: payload.url, id: payload.tag, account_id: payload.account_id })!;
    expect(req.url.startsWith('/api/')).toBe(true);
    const res = await t.app.request(req.url, {
      method: req.init.method,
      headers: { ...req.init.headers, cookie: bob, origin: WEB_ORIGIN },
      body: req.init.body,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const out = await body(res);
    expect(out.ok).toBe(true);
    expect(typeof out.unread_count).toBe('number');
    const read = await t.db.select().from(notifications).where(eq(notifications.id, id));
    expect(read[0]!.readAt).not.toBeNull();
    const untouched = await t.db.select().from(notifications).where(eq(notifications.id, other));
    expect(untouched[0]!.readAt).toBeNull();
  });

  it('nobody else can mark it: another member, or no session, changes nothing', async () => {
    const id = await mentionBob();
    const req = swMarkRead({ id, account_id: acmeId })!;
    const anon = await t.app.request(req.url, { method: 'POST', headers: req.init.headers, body: req.init.body });
    expect(anon.status).toBe(401);
    const asAdmin = await t.app.request(req.url, {
      method: 'POST',
      headers: { ...req.init.headers, cookie: admin },
      body: req.init.body,
    });
    expect(asAdmin.status).toBe(200);
    const [n] = await t.db.select().from(notifications).where(eq(notifications.id, id));
    expect(n!.readAt).toBeNull();
  });
});

describe('leaving / removal ends push in that account at once (b)', () => {
  const countIn = async (account: string) =>
    (
      await t.db
        .select()
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.accountId, account), eq(pushSubscriptions.userId, bobId)))
    ).length;

  it('deactivation removes his devices in this account only, while his session lives on', async () => {
    await subscribe(bob, acmeId, 'https://fcm.googleapis.com/fcm/send/b1');
    await subscribe(bob, acmeId, 'https://fcm.googleapis.com/fcm/send/b2');
    await subscribe(bob, betaId, 'https://fcm.googleapis.com/fcm/send/b1');
    expect(await countIn(acmeId)).toBe(2);
    const res = await as(admin).post(`/users/${bobId}/deactivate`, {});
    expect(res.status).toBe(200);
    try {
      expect(await countIn(acmeId)).toBe(0);
      expect(await countIn(betaId)).toBe(1);
      // Still signed in (active in Beta): the session did not take the devices with it.
      expect((await t.api(bob).get('/auth/me')).status).toBe(200);
    } finally {
      await as(admin).post(`/users/${bobId}/activate`, {});
    }
  });

  it('the bulk "deactivate" does the same', async () => {
    await subscribe(bob, acmeId, 'https://fcm.googleapis.com/fcm/send/b3');
    const res = await as(admin).post('/users/bulk', { op: 'deactivate', ids: [bobId] });
    expect(res.status).toBe(200);
    try {
      expect(await countIn(acmeId)).toBe(0);
    } finally {
      await as(admin).post('/users/bulk', { op: 'activate', ids: [bobId] });
    }
  });
});

describe('the VAPID private key at rest (d)', () => {
  const MASTER = randomBytes(32).toString('base64');
  const env = (key?: string) => ({
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
    WEB_ORIGIN: 'https://app.test',
    SECRET_MASTER_KEY: key,
  });
  const row = async () =>
    (await t.db.select().from(platformSettings).where(eq(platformSettings.id, VAPID_ROW_ID)))[0]?.settings as
      Json | undefined;
  const fresh = async () => {
    await t.db.delete(platformSettings).where(eq(platformSettings.id, VAPID_ROW_ID));
    resetVapidCache();
  };
  afterAll(fresh);

  it('without SECRET_MASTER_KEY: kept as before (plain), and the worker reads it', async () => {
    await fresh();
    const pair = await loadVapid(t.db, env());
    const r = await row();
    expect(r).toEqual({ public_key: pair.publicKey, private_key: pair.privateKey });
    expect(await vapidFrom(db(), { WEB_ORIGIN: 'https://app.test' })()).toMatchObject({
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
    });
  });

  it('an old plain row is sealed the first time it is read with a key; the worker opens it with the same key', async () => {
    await fresh();
    const plain = await loadVapid(t.db, env());
    resetVapidCache();
    const again = await loadVapid(t.db, env(MASTER));
    expect(again).toMatchObject({ publicKey: plain.publicKey, privateKey: plain.privateKey });
    const r = (await row())!;
    expect(r.private_key).toBeUndefined();
    expect(r.public_key).toBe(plain.publicKey);
    expect(String(r.private_key_enc)).toMatch(/^v1\./);
    expect(JSON.stringify(r)).not.toContain(plain.privateKey!);

    expect(await vapidFrom(db(), { WEB_ORIGIN: 'https://app.test', SECRET_MASTER_KEY: MASTER })()).toMatchObject({
      publicKey: plain.publicKey,
      privateKey: plain.privateKey,
    });
    // A worker without the key (or another key) has nothing to sign with: no_keys, one warning, never the key.
    const warnings: string[] = [];
    expect(await vapidFrom(db(), { WEB_ORIGIN: 'https://app.test' }, (m) => warnings.push(m))()).toBeNull();
    expect(
      await vapidFrom(db(), { SECRET_MASTER_KEY: randomBytes(32).toString('hex') }, (m) => warnings.push(m))(),
    ).toBeNull();
    expect(warnings.join(' ')).not.toContain(MASTER);
  });

  it('a new pair is sealed from the start; the app still gets the public key without the master key', async () => {
    await fresh();
    const pair = await loadVapid(t.db, env(MASTER));
    const r = (await row())!;
    expect(r.private_key).toBeUndefined();
    expect(r.private_key_enc).toBeTruthy();
    resetVapidCache();
    // The test app has no SECRET_MASTER_KEY: GET /pwa/config still answers the (public) key.
    const config = await body(await as(admin).get('/pwa/config'));
    expect(config.vapid_public_key).toBe(pair.publicKey);
    resetVapidCache();
    expect(await loadVapid(t.db, env())).toMatchObject({ publicKey: pair.publicKey, privateKey: null });
  });
});

describe('the build the pages compare with (c, server side)', () => {
  it('the public status answers the served build and the breaking epoch', async () => {
    setServedBuild('b-test-1');
    try {
      const s = await body(await t.app.request('/api/v1/public/pwa/status'));
      expect(s).toMatchObject({ sw_enabled: true, build: 'b-test-1', breaking_epoch: PWA_BREAKING_EPOCH });
    } finally {
      setServedBuild(null);
    }
    const dev = await body(await t.app.request('/api/v1/public/pwa/status'));
    expect(typeof dev.build).toBe('string');
  });
});
