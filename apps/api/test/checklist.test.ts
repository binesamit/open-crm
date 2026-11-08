// SPDX-License-Identifier: AGPL-3.0-only
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * "First steps": each person's checklist ticks itself from what they really did in the account (their
 * own events — never someone else's), the app reports what the log does not record, a tour step can wait for an
 * action ("seen since"), "show me" points at the step's tour, and the platform owner / the account's admins control
 * it. Steps are the owner's data; until saved, the built-in ones in the reader's language.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const mine = async (cookie: string) => body(await as(cookie).get('/me/first-steps'));
const doneOf = (s: Json) => Object.fromEntries((s.steps as Json[]).map((x) => [x.id, x.done]));

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: ws }))).id;
});
afterAll(() => t.close());

describe('first steps', () => {
  it('the built-in steps: joined from the start, admin-only steps only for admins, open for the newly joined', async () => {
    const s = await mine(bob);
    expect(s).toMatchObject({ available: true, open: true, dismissed: false, completed: false });
    expect(s.steps.map((x: Json) => x.id)).toEqual([
      'joined',
      'board',
      'item',
      'edit',
      'view',
      'update',
      'file',
      'link',
      'timer',
    ]);
    expect(doneOf(s)).toMatchObject({ joined: true, board: false, item: false });
    expect(s.steps[0].title).toBe('הצטרפות');
    // The admin invited bob already: their "invite" step is done; bob's own list has no such step.
    const a = await mine(admin);
    expect(a.steps.map((x: Json) => x.id)).toContain('automation');
    expect(doneOf(a).invite).toBe(true);
  });

  it('ticks from the person’s own actions only; the app reports a board opened / a view switched', async () => {
    const item = await body(await as(bob).post(`/boards/${boardId}/items`, { name: 'Dana' }));
    await as(admin).patch(`/items/${item.id}`, { name: 'Dana Levi' });
    let s = await mine(bob);
    expect(doneOf(s)).toMatchObject({ item: true, edit: false });
    await as(bob).patch(`/items/${item.id}`, { name: 'Dana L.' });
    expect((await as(bob).post('/me/first-steps/mark', { event: 'board_opened' })).status).toBe(200);
    expect((await as(bob).post('/me/first-steps/mark', { event: 'item_created' })).status).toBe(400);
    s = await mine(bob);
    expect(doneOf(s)).toMatchObject({ item: true, edit: true, board: true, view: false });
    // The admin's own list did not tick from bob's item.
    expect(doneOf(await mine(admin)).item).toBe(false);
  });

  it('"seen since": a tour step waiting for an action goes on only for what happens after it opened', async () => {
    const since = new Date().toISOString();
    const seen = async (event: string) =>
      (await body(await as(bob).get(`/me/first-steps/seen?event=${event}&since=${encodeURIComponent(since)}`))).seen;
    expect(await seen('item_created')).toBe(false);
    await as(bob).post(`/boards/${boardId}/items`, { name: 'Another' });
    expect(await seen('item_created')).toBe(true);
    expect(await seen('view_switched')).toBe(false);
    await as(bob).post('/me/first-steps/mark', { event: 'view_switched' });
    expect(await seen('view_switched')).toBe(true);
  });

  it('"show me": a step points at its published tour (by the step’s slug)', async () => {
    expect((await mine(bob)).steps.find((x: Json) => x.id === 'item').tour_id).toBeNull();
    const tour = await body(
      await t.api(owner).post('/platform/support/help/tours', {
        title: 'יצירת פריט',
        slug: 'first-steps-item',
        route: 'board',
        steps: [{ id: 'a', anchor: 'board.new-item', title: 'לחצו כאן', wait_event: 'item_created' }],
      }),
    );
    expect(tour.steps[0].wait_event).toBe('item_created');
    expect((await mine(bob)).steps.find((x: Json) => x.id === 'item').tour_id).toBeNull();
    await t.api(owner).patch(`/platform/support/help/tours/${tour.id}`, { status: 'published' });
    expect((await mine(bob)).steps.find((x: Json) => x.id === 'item').tour_id).toBe(tour.id);
  });

  it('closing it keeps it closed (and "?" opens it again); the account’s admins can turn it off', async () => {
    // Folded into its pill after its first showing: remembered, and it stays open (not dismissed).
    expect((await mine(bob)).collapsed).toBe(false);
    expect((await as(bob).post('/me/first-steps/dismiss', { collapsed: true })).status).toBe(200);
    expect(await mine(bob)).toMatchObject({ open: true, collapsed: true, dismissed: false });
    expect((await as(bob).post('/me/first-steps/dismiss', {})).status).toBe(400);
    await as(bob).post('/me/first-steps/dismiss', { dismissed: true });
    expect(await mine(bob)).toMatchObject({ open: false, dismissed: true });
    await as(bob).post('/me/first-steps/dismiss', { dismissed: false });
    expect(await mine(bob)).toMatchObject({ open: true, dismissed: false });
    expect((await as(admin).patch('/accounts/me', { settings: { tours: { first_steps: false } } })).status).toBe(200);
    expect(await mine(bob)).toMatchObject({ available: false, steps: [] });
    await as(admin).patch('/accounts/me', { settings: { tours: { first_steps: true } } });
  });

  it('the owner’s own steps replace the built-in ones; finishing them all completes the list', async () => {
    const before = await body(await t.api(owner).get('/platform/support/help/first-steps'));
    expect(before.custom).toBe(false);
    expect(before.steps).toHaveLength(11);
    const res = await t.api(owner).patch('/platform/support/help/settings', {
      first_steps: {
        steps: [
          { id: 'hello', event: 'joined', title: 'שלום' },
          { id: 'doc', event: 'doc_created', title: 'מסמך ראשון', audience: 'all' },
        ],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    let s = await mine(bob);
    expect(s.steps.map((x: Json) => x.title)).toEqual(['שלום', 'מסמך ראשון']);
    expect(s.completed).toBe(false);
    const ws = (await body(await as(bob).get('/workspaces'))).data[0].id;
    expect((await as(bob).post(`/workspaces/${ws}/docs`, { name: 'Notes' })).status).toBe(201);
    s = await mine(bob);
    expect(s).toMatchObject({ completed: true, open: false });
    expect((await body(await t.api(owner).get('/platform/support/help/first-steps'))).custom).toBe(true);
    // Off for the whole platform.
    await t.api(owner).patch('/platform/support/help/settings', { first_steps: { enabled: false, steps: null } });
    expect((await mine(bob)).available).toBe(false);
  });
  it('a help-center package brings tours whose steps wait for an action (and exports them back)', async () => {
    const tours = [
      {
        slug: 'first-steps-update',
        title: 'כתיבת עדכון',
        route: 'item',
        start: 'menu',
        publish: true,
        steps: [{ id: 'a', anchor: 'item.composer', title: 'כתבו ושלחו', wait_event: 'update_written' }],
      },
    ];
    const form = new FormData();
    const zip = zipSync({ 'tours.json': strToU8(JSON.stringify(tours)) });
    form.append('files', new File([zip as Uint8Array<ArrayBuffer>], 'pkg.zip'));
    const res = await t.app.request('/api/v1/platform/support/help/import', {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, cookie: owner },
      body: form,
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const list = (await body(await t.api(owner).get('/platform/support/help/tours'))).data as Json[];
    const imported = list.find((x) => x.slug === 'first-steps-update')!;
    const one = await body(await t.api(owner).get(`/platform/support/help/tours/${imported.id}`));
    expect(one.steps[0]).toMatchObject({ anchor: 'item.composer', wait_event: 'update_written' });
  });
});
