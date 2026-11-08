// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFlowFailures } from '../src/modules/flows/flows.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Integration of sync tracks 4: plans next to shared dashboards and external flows.
 * A capped account (boards / items / storage at zero, every seat taken) still creates, edits and shares dashboards
 * with guests (guests take no seat); its flows read and their check job runs. A read-only subscription still reads
 * dashboards and flows. A legacy account (no subscription) has no limits at all.
 */
let t: TestContext;
let owner: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const mk = async (name: string, slug: string, email: string) => {
  const id = (
    await body(
      await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
    )
  ).account.id as string;
  const cookie = await join(email);
  const ws = (await body(await t.api(cookie, id).get('/workspaces'))).data[0].id as string;
  const board = (await body(await t.api(cookie, id).post('/boards', { name: 'Leads', workspace_id: ws }))).id as string;
  return { id, cookie, ws, board };
};
let capped: Awaited<ReturnType<typeof mk>>;
let legacy: Awaited<ReturnType<typeof mk>>;
let versionId: string;
let cappedDash: string;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  capped = await mk('Capped', 'capped', 'admin@capped.test');
  legacy = await mk('Legacy', 'legacy', 'admin@legacy.test');
  const plan = await body(
    await t.api(owner).post('/platform/plans', {
      name: 'Tiny',
      version: { price_monthly: 0, limits: { seats: 1, boards: 0, items: 0, storage_gb: 0 } },
    }),
  );
  versionId = plan.current_version_id;
  const res = await t.api(owner).put(`/platform/accounts/${capped.id}/subscription`, { plan_version_id: versionId });
  expect(res.status).toBe(200);
});
afterAll(() => t.close());

const shareFlow = async (a: typeof capped, guestEmail: string, memberEmail: string) => {
  const as = () => t.api(a.cookie, a.id);
  const dash = await as().post(`/workspaces/${a.ws}/dashboards`, {
    name: 'Client view',
    kind: 'shareable',
    board_ids: [a.board],
  });
  expect(dash.status).toBe(201);
  const id = (await body(dash)).id as string;
  expect((await as().post(`/dashboards/${id}/widgets`, { type: 'text' })).status).toBe(201);
  expect((await as().patch(`/dashboards/${id}`, { name: 'Client view 2' })).status).toBe(200);
  const guest = await as().post(`/dashboards/${id}/invite`, { emails: [guestEmail], role: 'guest' });
  expect(guest.status).toBe(200);
  const member = await as().post(`/dashboards/${id}/invite`, { emails: [memberEmail], role: 'member' });
  const board = await as().post('/boards', { name: 'Another', workspace_id: a.ws });
  const item = await as().post(`/boards/${a.board}/items`, { name: 'Dana' });
  expect((await as().get('/flow-connections')).status).toBe(200);
  return { dashboardId: id, member, board, item };
};

describe('plans × shared dashboards × flows', () => {
  it('a capped account still shares dashboards with guests; members, boards and items hit the plan', async () => {
    const r = await shareFlow(capped, 'gus@guest.test', 'bob@capped.test');
    cappedDash = r.dashboardId;
    for (const [res, kind] of [
      [r.member, 'seats'],
      [r.board, 'boards'],
      [r.item, 'items'],
    ] as const) {
      expect(res.status).toBe(402);
      expect((await body(res)).error).toMatchObject({ code: 'plan_limit_reached', details: { kind } });
    }
    // The guest accepts and sees the dashboard; no seat was taken.
    const gus = await join('gus@guest.test');
    expect((await t.api(gus, capped.id).get(`/dashboards/${r.dashboardId}`)).status).toBe(200);
    const view = await body(await t.api(owner).get(`/platform/accounts/${capped.id}/subscription`));
    expect((view.usage as Json[]).find((u) => u.kind === 'seats')).toMatchObject({ used: 1, limit: 1 });
    // The flows' failure check runs regardless of plans.
    expect(await checkFlowFailures(t.deps)).toBe(0);
  });

  it('a read-only subscription keeps reading dashboards and flows; new dashboards wait', async () => {
    const res = await t
      .api(owner)
      .put(`/platform/accounts/${capped.id}/subscription`, { plan_version_id: versionId, status: 'read_only' });
    expect(res.status).toBe(200);
    const as = () => t.api(capped.cookie, capped.id);
    expect((await as().get(`/dashboards/${cappedDash}`)).status).toBe(200);
    expect((await as().get('/flow-connections')).status).toBe(200);
    const blocked = await as().post(`/workspaces/${capped.ws}/dashboards`, { name: 'Later', kind: 'private' });
    expect(blocked.status).toBe(423);
    expect((await body(blocked)).error.code).toBe('plan_read_only');
  });

  it('a legacy account (no subscription) stays unlimited', async () => {
    const view = await body(await t.api(owner).get(`/platform/accounts/${legacy.id}/subscription`));
    expect(view.subscription).toBeNull();
    expect(view.entitlements).toMatchObject({ unlimited: true, status: null });
    const r = await shareFlow(legacy, 'gil@guest.test', 'dan@legacy.test');
    expect(r.member.status).toBe(200);
    expect(r.board.status).toBe(201);
    expect(r.item.status).toBe(201);
  });
});
