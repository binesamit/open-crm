// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_CHANGED_EVENT, PLAN_LIVE_EVENTS } from '@bines/shared';
import type { Db } from '../src/db/client';
import { accountSubscriptions, activityLog } from '../src/db/schema';
import { sweepPlanTransitions } from '../src/modules/billing/plan-status';
import { meStream } from '../src/modules/realtime/realtime.service';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * The plan status members see (plans, sync follow-up): `plan_status` on GET /me/accounts and /auth/me
 * (null = legacy), the schedule applied (grace → read_only), and `account.plan_changed` on /me/events — type only —
 * when the owner changes the subscription or a scheduled step happens, so the app recovers without a reload.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
let v1: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const DAY = 86_400_000;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const mk = async (name: string, slug: string, email: string) =>
  (
    await body(
      await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
    )
  ).account.id as string;
const set = async (accountId: string, patch: Json) => {
  const res = await t.api(owner).put(`/platform/accounts/${accountId}/subscription`, { plan_version_id: v1, ...patch });
  expect(res.status).toBe(200);
};
const mine = async (cookie: string, accountId: string) =>
  ((await body(await t.api(cookie).get('/me/accounts'))).data as Json[]).find((a) => a.id === accountId)!;
const meAccount = async (cookie: string, accountId: string) =>
  (await body(await t.api(cookie, accountId).get('/auth/me'))).account as Json;
const backdate = async (accountId: string, since: Date) =>
  t.db
    .update(accountSubscriptions)
    .set({ statusSince: since })
    .where(and(eq(accountSubscriptions.accountId, accountId)));

/** A personal SSE stream, as EventSource opens it; collects events. */
const openMe = async (cookie: string, account: string) => {
  const res = await t.app.request(`/api/v1/me/events?account_id=${account}`, {
    headers: { origin: WEB_ORIGIN, cookie },
  });
  expect(res.status).toBe(200);
  const got: Json[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let buf = '';
  void (async () => {
    while (!done) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) got.push(JSON.parse(data) as Json);
      }
    }
  })();
  const waitFor = async (pred: (e: Json) => boolean, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = got.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no matching event; got ${JSON.stringify(got.map((e) => e.type))}`);
  };
  await waitFor((e) => e.type === 'ready');
  return {
    got,
    waitFor,
    close: async () => {
      done = true;
      await reader.cancel().catch(() => {});
    },
  };
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const plan = await body(
    await t.api(owner).post('/platform/plans', {
      name: 'Team',
      version: { price_monthly: 10, currency: 'ILS', pricing: 'flat', limits: {} },
    }),
  );
  v1 = plan.current_version_id;
  await t.api(owner).patch('/platform/billing-settings', { past_due_grace_days: 7, read_only_days: 30 });
});
afterAll(() => t.close());

describe('plan_status on /me/accounts and /auth/me', () => {
  it('is null for a legacy account (no subscription)', async () => {
    expect(await mine(admin, acmeId)).toMatchObject({ plan_status: null, plan_status_since: null, read_only_at: null });
    expect(await meAccount(admin, acmeId)).toMatchObject({ plan_status: null, read_only_at: null });
  });

  it('follows the subscription: active, then past_due within the grace, then read_only after it', async () => {
    await set(acmeId, { status: 'active' });
    const active = await mine(bob, acmeId);
    expect(active).toMatchObject({ plan_status: 'active', read_only_at: null });
    expect(typeof active.plan_status_since).toBe('string');

    await set(acmeId, { status: 'past_due' });
    const since = new Date(Date.now() - 2 * DAY);
    await backdate(acmeId, since);
    const graceEnd = new Date(since.getTime() + 7 * DAY).toISOString();
    expect(await mine(bob, acmeId)).toMatchObject({
      plan_status: 'past_due',
      plan_status_since: since.toISOString(),
      read_only_at: graceEnd,
    });

    // The grace ran out (no write — the status is computed): read-only since the grace's end.
    const longAgo = new Date(Date.now() - 9 * DAY);
    await backdate(acmeId, longAgo);
    const roAt = new Date(longAgo.getTime() + 7 * DAY).toISOString();
    expect(await mine(bob, acmeId)).toMatchObject({
      plan_status: 'read_only',
      plan_status_since: roAt,
      read_only_at: roAt,
    });
    expect(await meAccount(bob, acmeId)).toMatchObject({ plan_status: 'read_only', read_only_at: roAt });
    // Another account is untouched.
    expect((await mine(otherAdmin, otherId)).plan_status).toBeNull();
  });

  it('the minute sweep announces a scheduled step (grace → read_only) to the account only', async () => {
    await set(acmeId, { status: 'past_due' });
    const since = new Date(Date.now() - 7 * DAY + 30_000); // the grace ends in 30 seconds
    await backdate(acmeId, since);
    const graceEnd = since.getTime() + 7 * DAY;
    // A minute that does not contain the step: nothing.
    expect(
      await sweepPlanTransitions(t.db as unknown as Db, new Date(graceEnd - 120_000), new Date(graceEnd - 60_000)),
    ).toEqual([]);
    // The minute that does.
    expect(
      await sweepPlanTransitions(t.db as unknown as Db, new Date(graceEnd - 1000), new Date(graceEnd + 59_000)),
    ).toEqual([acmeId]);
    const rows = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, PLAN_CHANGED_EVENT)));
    expect(rows.some((r) => r.actorType === 'system' && (r.payload as Json).meta?.reason === 'schedule')).toBe(true);
  });
});

describe('account.plan_changed on /me/events', () => {
  it('the personal channel passes it to everyone in the account', async () => {
    const stream = meStream(t.db as unknown as Db, { ctx: { accountId: acmeId } as never, user: { id: 'U' } as never });
    for (const type of PLAN_LIVE_EVENTS)
      expect(await stream.accept({ id: 'E', account_id: acmeId, type } as never)).toBe('send');
  });

  it('reaches a member when the owner changes the subscription — type only — and not another account', async () => {
    const bobStream = await openMe(bob, acmeId);
    const otherStream = await openMe(otherAdmin, otherId);
    await set(acmeId, { status: 'active', overrides: { boards: 5 } });
    const ev = await bobStream.waitFor((e) => e.type === PLAN_CHANGED_EVENT);
    expect(Object.keys(ev).every((k) => !/plan|status|price|override|key/.test(k))).toBe(true);
    // The refetch sees the change at once.
    expect((await mine(bob, acmeId)).plan_status).toBe('active');

    // Ending the subscription (back to legacy) too.
    const before = bobStream.got.filter((e) => e.type === PLAN_CHANGED_EVENT).length;
    expect((await t.api(owner).del(`/platform/accounts/${acmeId}/subscription`)).status).toBe(200);
    await bobStream.waitFor(() => bobStream.got.filter((e) => e.type === PLAN_CHANGED_EVENT).length > before);
    expect((await mine(bob, acmeId)).plan_status).toBeNull();

    await new Promise((r) => setTimeout(r, 150));
    expect(otherStream.got.some((e) => e.type === PLAN_CHANGED_EVENT)).toBe(false);
    await bobStream.close();
    await otherStream.close();
  });
});
