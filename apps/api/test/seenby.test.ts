// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { deviceOf, summaryOf } from '../src/modules/updates/device';

/** "Seen by" on updates and replies: device detection, idempotent upsert, permissions, the account switch. */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let boardId: string;
let itemId: string;
let updateId: string;
let replyId: string;
let bobId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const see = (cookie: string, ids: string[], headers: Record<string, string> = { 'user-agent': CHROME_WIN }) =>
  t.api(cookie, acmeId).call('POST', '/updates/views', { update_ids: ids }, headers);

const thread = async (cookie: string) =>
  (await body(await t.api(cookie, acmeId).get(`/items/${itemId}/updates`))).data as Json[];

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;
  betaId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
    )
  ).account.id;
  betaAdmin = await join('admin@beta.test');

  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'פניות', workspace_id: ws }))).id;
  itemId = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'פנייה 1' }))).id;
  updateId = (await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { body: 'שלום' }))).id;
  replyId = (await body(await t.api(admin, acmeId).post(`/updates/${updateId}/replies`, { body: 'תשובה' }))).id;
});
afterAll(() => t.close());

describe('device detection (from headers only)', () => {
  it('tells desktop, phone and tablet apart and keeps only browser + OS', () => {
    expect(deviceOf(CHROME_WIN)).toEqual({ device: 'desktop', summary: 'Chrome · Windows' });
    expect(deviceOf(SAFARI_IPHONE)).toEqual({ device: 'mobile', summary: 'Safari · iOS' });
    expect(deviceOf(ANDROID_TABLET)).toEqual({ device: 'tablet', summary: 'Chrome · Android' });
    // Chromium's client hint marks a phone even with a reduced UA string.
    expect(deviceOf(CHROME_WIN, '?1').device).toBe('mobile');
    expect(deviceOf(undefined)).toEqual({ device: 'desktop', summary: '' });
    expect(summaryOf('Mozilla/5.0 (Macintosh) AppleWebKit Chrome/1 Safari/1 Edg/140')).toBe('Edge · macOS');
  });
});

describe('POST /updates/views', () => {
  it("does not count the author's own view", async () => {
    const res = await see(admin, [updateId, replyId]);
    expect(res.status).toBe(200);
    expect((await body(res)).recorded).toBe(0);
    expect((await thread(admin))[0]!.seen).toEqual({ count: 0, users: [] });
  });

  it('records a view per device, idempotently, and shows it on updates and replies', async () => {
    expect((await body(await see(bob, [updateId, replyId]))).recorded).toBe(2);
    // Again from the same device: still one row (upsert), nothing new.
    expect((await body(await see(bob, [updateId, updateId]))).recorded).toBe(1);
    // A body field naming a device is ignored — the phone comes from the User-Agent.
    const phone = await t
      .api(bob, acmeId)
      .call('POST', '/updates/views', { update_ids: [updateId], device: 'desktop' }, { 'user-agent': SAFARI_IPHONE });
    expect(phone.status).toBe(200);

    const [top] = await thread(admin);
    expect(top!.seen.count).toBe(1);
    const viewer = top!.seen.users[0];
    expect(viewer.id).toBe(bobId);
    expect(viewer.devices.map((d: Json) => d.device).sort()).toEqual(['desktop', 'mobile']);
    expect(viewer.devices.find((d: Json) => d.device === 'mobile').user_agent).toBe('Safari · iOS');
    expect(viewer).toHaveProperty('avatar_url');
    expect(top!.replies[0].seen.count).toBe(1);
    expect(top!.replies[0].seen.users[0].devices).toHaveLength(1);

    const full = await body(await t.api(admin, acmeId).get(`/updates/${updateId}/views`));
    expect(full.data).toHaveLength(1);
    expect(full.data[0].devices).toHaveLength(2);
  });

  it('skips updates the reader cannot see: another account, a hidden board, unknown ids', async () => {
    const beta = await t
      .api(betaAdmin, betaId)
      .call('POST', '/updates/views', { update_ids: [updateId] }, { 'user-agent': CHROME_WIN });
    expect((await body(beta)).recorded).toBe(0);
    // Cross-account: the full list is a 404 too.
    expect((await t.api(betaAdmin, betaId).get(`/updates/${updateId}/views`)).status).toBe(404);

    const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
    const priv = await body(
      await t.api(admin, acmeId).post('/boards', { name: 'Private', workspace_id: ws, kind: 'private' }),
    );
    const hiddenItem = (await body(await t.api(admin, acmeId).post(`/boards/${priv.id}/items`, { name: 'x' }))).id;
    const hidden = (await body(await t.api(admin, acmeId).post(`/items/${hiddenItem}/updates`, { body: 'סוד' }))).id;
    expect((await body(await see(bob, [hidden, '01ARZ3NDEKTSV4RRFFQ69G5FAV']))).recorded).toBe(0);
    expect((await t.api(bob, acmeId).get(`/updates/${hidden}/views`)).status).toBe(404);
    expect((await body(await t.api(admin, acmeId).get(`/updates/${hidden}/views`))).data).toEqual([]);
  });

  it('validates the batch', async () => {
    expect((await see(bob, [])).status).toBe(400);
  });

  it('stops recording and showing when the account turns it off', async () => {
    const off = await t
      .api(admin, acmeId)
      .patch('/accounts/me', { settings: { permissions: { show_update_views: false } } });
    expect(off.status).toBe(200);
    expect((await body(off)).settings.permissions.show_update_views).toBe(false);
    expect((await body(await see(bob, [replyId], { 'user-agent': ANDROID_TABLET }))).recorded).toBe(0);
    expect((await thread(admin))[0]!.seen).toBeNull();
    expect((await body(await t.api(admin, acmeId).get(`/updates/${updateId}/views`))).data).toEqual([]);

    await t.api(admin, acmeId).patch('/accounts/me', { settings: { permissions: { show_update_views: true } } });
    // The tablet view was never stored while it was off.
    const [top] = await thread(admin);
    expect(top!.replies[0].seen.users[0].devices).toHaveLength(1);
  });
});
