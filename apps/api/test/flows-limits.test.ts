// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flowConnections, flowFailureAlerts } from '../src/db/schema';
import type { FlowHttpRequest, FlowHttpResponse } from '../src/modules/flows/adapters/types';
import {
  flowBackoff,
  flowSlowedTo,
  noteFlowQuota,
  noteFlowRateLimited,
  resetFromHeaders,
  setFlowClockForTests,
  setFlowSleepForTests,
  takeFlowCall,
} from '../src/modules/flows/flows.limits';
import { checkFlowFailures, setFlowHttpForTests } from '../src/modules/flows/flows.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * frugal Make calls ("Requests limit for organization exceeded"): the flows list is one call and kept
 * the per-flow stats load lazily (paced, kept), a 429 pauses every path (list, stats, drawer, failure check) until
 * Make's reset, and a per-minute budget per connection meters them all. Time is a fake clock; Make is a fake transport.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

// ---- the clock (every limit reads it) ----
let now = Date.now();
const advance = (ms: number) => {
  now += ms;
};

// ---- a fake Make ----
const MAKE_TOKEN = 'make-token-000000-limits';
const target = { platform: 'make', zone: 'eu1', team_id: 77, api_token: MAKE_TOKEN };
type Call = { at: number; path: string; query: URLSearchParams };
const calls: Call[] = [];
/** Make answers 429 (with these headers) to every call while set. */
let limited: Record<string, string> | null = null;
let failedRun: Json | null = null;
/** Headers on Make's successful answers while set (how many calls are left). */
let okHeaders: Record<string, string> | null = null;

const reply = (status: number, json: unknown, headers?: Record<string, string>): FlowHttpResponse => {
  const sent = headers ?? (status < 400 ? okHeaders : null);
  return { status, ok: status < 400, body: JSON.stringify(json), ...(sent ? { headers: sent } : {}) };
};

const fakeMake = async (req: FlowHttpRequest): Promise<FlowHttpResponse> => {
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/v2', '');
  calls.push({ at: now, path, query: url.searchParams });
  if (limited)
    return reply(429, { message: 'Requests limit for organization exceeded, please try again later.' }, limited);
  if (path === '/scenarios')
    return reply(200, {
      scenarios: [
        { id: 1, name: 'One', isActive: true },
        { id: 2, name: 'Two', isActive: true },
        { id: 3, name: 'Three', isActive: true },
        { id: 4, name: 'Off', isActive: false },
      ],
    });
  const logs = /^\/scenarios\/(\d+)\/logs$/.exec(path);
  if (logs) {
    const rows: Json[] = [{ id: `ok-${logs[1]}`, status: 1, timestamp: new Date(now - 60_000).toISOString() }];
    if (failedRun && logs[1] === '1') rows.unshift(failedRun);
    const status = url.searchParams.get('status');
    return reply(200, { scenarioLogs: rows.filter((r) => !status || String(r.status) === status) });
  }
  const one = /^\/scenarios\/(\d+)$/.exec(path);
  if (one) return reply(200, { scenario: { id: Number(one[1]), name: 'One', isActive: true } });
  return reply(404, { message: 'no route' });
};
const logCalls = () => calls.filter((c) => c.path.endsWith('/logs'));

const connect = async (name: string, settings: Json = {}) => {
  const res = await as(admin).post('/flow-connections', { name, target, settings });
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  calls.length = 0;
  return json.id as string;
};

beforeAll(async () => {
  setFlowHttpForTests(fakeMake);
  setFlowClockForTests(() => now);
  // Pacing waits move the fake clock instead of the real one.
  setFlowSleepForTests(async (ms) => advance(ms));
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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
});
afterAll(async () => {
  setFlowHttpForTests(null);
  setFlowClockForTests(null);
  setFlowSleepForTests(null);
  await t.close();
});
beforeEach(() => {
  calls.length = 0;
  limited = null;
  failedRun = null;
  okHeaders = null;
  advance(10 * 60_000);
});

describe('the per-minute budget (a token bucket per connection)', () => {
  const budget = {
    max_calls_per_minute: 6,
    background_share_percent: 50,
    stats_pacing_ms: 0,
    backoff_default_seconds: 60,
  };

  it('allows N calls per minute, then says how long until the next; refills over time', () => {
    const at = 1_000_000;
    for (let i = 0; i < 6; i++) expect(takeFlowCall('bucket-a', budget, false, at)).toBe(0);
    const wait = takeFlowCall('bucket-a', budget, false, at);
    expect(wait).toBe(10_000);
    expect(takeFlowCall('bucket-a', budget, false, at + 10_000)).toBe(0);
    expect(takeFlowCall('bucket-a', budget, false, at + 10_000)).toBeGreaterThan(0);
  });

  it("background work leaves the person's share untouched", () => {
    const at = 2_000_000;
    // 50%: background takes 3 of 6, then waits; a person still gets the other 3.
    for (let i = 0; i < 3; i++) expect(takeFlowCall('bucket-b', budget, true, at)).toBe(0);
    expect(takeFlowCall('bucket-b', budget, true, at)).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) expect(takeFlowCall('bucket-b', budget, false, at)).toBe(0);
    expect(takeFlowCall('bucket-b', budget, false, at)).toBeGreaterThan(0);
  });

  it("reads Make's reset from Retry-After / X-RateLimit-Reset (seconds, epoch, date)", () => {
    const at = 1_700_000_000_000;
    expect(resetFromHeaders({ 'Retry-After': '90' }, at)).toBe(at + 90_000);
    expect(resetFromHeaders({ 'retry-after': new Date(at + 30_000).toUTCString() }, at)).toBe(at + 30_000);
    expect(resetFromHeaders({ 'x-ratelimit-reset': String((at + 45_000) / 1000) }, at)).toBe(at + 45_000);
    expect(resetFromHeaders({ 'ratelimit-reset': '20' }, at)).toBe(at + 20_000);
    expect(resetFromHeaders({}, at)).toBeNull();
    // Never longer than an hour.
    expect(resetFromHeaders({ 'retry-after': '999999' }, at)).toBe(at + 60 * 60_000);
  });

  it('meters every path of a connection: background stats stop at their share, the drawer gets the rest', async () => {
    const id = await connect('Make budget', {
      max_calls_per_minute: 4,
      background_share_percent: 50,
      stats_pacing_ms: 0,
      alert_on_failure: false,
    });
    advance(60_000); // the connection test's calls are refilled
    expect((await as(admin).get(`/flow-connections/${id}/flows`)).status).toBe(200); // 1 call (a person)
    const stats = await body(
      await as(admin).post(`/flow-connections/${id}/flows/stats`, { flow_ids: ['1', '2', '3'] }),
    );
    // 3 tokens left, the background may leave 2: one call — not even one scenario's two logs calls.
    expect(logCalls()).toHaveLength(1);
    expect(stats.pending).toEqual(['1', '2', '3']);
    expect(stats.limited).toMatchObject({ by: 'budget' });
    // A person's call still gets through.
    calls.length = 0;
    const runs = await body(await as(admin).get(`/flow-connections/${id}/runs?flow_id=2&status=all`));
    expect(runs.warning).toBeUndefined();
    expect(logCalls()).toHaveLength(1);
    // A minute later the budget is back: the stats load.
    advance(60_000);
    calls.length = 0;
    const later = await body(await as(admin).post(`/flow-connections/${id}/flows/stats`, { flow_ids: ['1'] }));
    expect(later.pending).toEqual([]);
    expect(later.data['1']).toMatchObject({ errors_7d: 0, last_run_status: 'success' });
    await as(admin).del(`/flow-connections/${id}`);
  });
});

describe('kept answers', () => {
  it('reopening the screen hits the kept list and runs; "refresh" asks again, at most once per its interval', async () => {
    const id = await connect('Make cache', { alert_on_failure: false });
    const list = async (q = '') => (await as(admin).get(`/flow-connections/${id}/flows${q}`)).status;
    expect(await list()).toBe(200);
    expect(calls.map((c) => c.path)).toEqual(['/scenarios']);
    // Opened again (and again): kept.
    expect(await list()).toBe(200);
    advance(60_000);
    expect(await list()).toBe(200);
    expect(calls).toHaveLength(1);
    // Refresh: asked now — a second refresh right after is answered from what was kept.
    expect(await list('?refresh=1')).toBe(200);
    expect(await list('?refresh=1')).toBe(200);
    expect(calls).toHaveLength(2);
    advance(31_000);
    expect(await list('?refresh=1')).toBe(200);
    expect(calls).toHaveLength(3);
    // After `cache_list_seconds` (120 by default) it is asked again.
    advance(121_000);
    expect(await list()).toBe(200);
    expect(calls).toHaveLength(4);

    // One flow's runs: kept for `cache_runs_seconds` (60).
    calls.length = 0;
    const runs = await body(await as(admin).get(`/flow-connections/${id}/runs?flow_id=1&status=all`));
    expect(runs.data.map((r: Json) => r.id)).toEqual(['ok-1']);
    expect(runs.fetched_at).toBeTruthy();
    await as(admin).get(`/flow-connections/${id}/runs?flow_id=1&status=all`);
    expect(logCalls()).toHaveLength(1);
    advance(61_000);
    await as(admin).get(`/flow-connections/${id}/runs?flow_id=1&status=all`);
    expect(logCalls()).toHaveLength(2);
    await as(admin).del(`/flow-connections/${id}`);
  });

  it('the cache windows are the admin settings (0 = always ask)', async () => {
    const id = await connect('Make no cache', { alert_on_failure: false, cache_list_seconds: 0 });
    await as(admin).get(`/flow-connections/${id}/flows`);
    await as(admin).get(`/flow-connections/${id}/flows`);
    expect(calls).toHaveLength(2);
    await as(admin).del(`/flow-connections/${id}`);
  });
});

describe('lazy stats', () => {
  it('the list asks no logs; stats load for the flows asked, paced and kept; inactive flows need none', async () => {
    const id = await connect('Make lazy', { alert_on_failure: false, stats_pacing_ms: 500, stats_concurrency: 2 });
    const { data } = await body(await as(admin).get(`/flow-connections/${id}/flows`));
    expect(logCalls()).toHaveLength(0);
    expect(data.map((f: Json) => [f.id, f.stats_pending ?? false])).toEqual([
      ['1', true],
      ['2', true],
      ['3', true],
      ['4', false],
    ]);
    const stats = await body(
      await as(admin).post(`/flow-connections/${id}/flows/stats`, { flow_ids: ['1', '2', '3'] }),
    );
    expect(Object.keys(stats.data).sort()).toEqual(['1', '2', '3']);
    expect(stats.pending).toEqual([]);
    // Two logs calls per scenario, each at least `stats_pacing_ms` after the one before (even with 2 at a time).
    const at = logCalls().map((c) => c.at);
    expect(at).toHaveLength(6);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(500);
    // Kept: asked again → no call; the list carries them.
    calls.length = 0;
    await as(admin).post(`/flow-connections/${id}/flows/stats`, { flow_ids: ['1', '2', '3'] });
    const again = await body(await as(admin).get(`/flow-connections/${id}/flows`));
    expect(calls).toHaveLength(0);
    expect(again.data[0]).toMatchObject({ id: '1', errors_7d: 0, last_run_status: 'success' });
    expect(again.data[0].stats_pending).toBeUndefined();
    await as(admin).del(`/flow-connections/${id}`);
  });
});

describe("Make's 429: one backoff for every path until its reset", () => {
  it('after a 429 nothing calls Make (list, stats, drawer, one flow, failure check) until Retry-After passes', async () => {
    const id = await connect('Make 429', { alert_on_failure: true, check_every_minutes: 5 });
    await as(admin).get(`/flow-connections/${id}/flows`);
    calls.length = 0;
    limited = { 'Retry-After': '120' };
    const stats = await body(await as(admin).post(`/flow-connections/${id}/flows/stats`, { flow_ids: ['1', '2'] }));
    expect(calls).toHaveLength(1);
    expect(stats.pending).toEqual(['1', '2']);
    expect(stats.limited.by).toBe('platform');
    expect(new Date(stats.limited.until).getTime()).toBe(now + 120_000);
    expect(stats.limited.reason).toContain('Requests limit for organization exceeded');

    // Every path, during the backoff: no call at all.
    calls.length = 0;
    advance(40_000);
    const list = await body(await as(admin).get(`/flow-connections/${id}/flows?refresh=1`));
    expect(list.data).toHaveLength(4); // the kept list
    expect(list.limited).toMatchObject({ by: 'platform' });
    const runs = await body(await as(admin).get(`/flow-connections/${id}/runs?flow_id=1&status=all`));
    expect(runs).toMatchObject({ warning: 'flow_platform_limited', limited: { by: 'platform' } });
    expect((await as(admin).get(`/flow-connections/${id}/runs?status=error`)).status).toBe(200);
    expect((await as(admin).get(`/flow-connections/${id}/flows/1`)).status).toBe(429);
    const connections = await body(await as(admin).get('/flow-connections'));
    expect(connections.data.find((c: Json) => c.id === id).limited).toMatchObject({ by: 'platform' });
    // The failure check skips the connection (and asks on its next pass after the reset).
    const polledBefore = (await t.db.select().from(flowConnections).where(eq(flowConnections.id, id)))[0]!.lastPolledAt;
    expect(await checkFlowFailures(t.deps, new Date(now))).toBe(0);
    const row = (await t.db.select().from(flowConnections).where(eq(flowConnections.id, id)))[0]!;
    expect(row.lastPolledAt).toEqual(polledBefore);
    expect(row.status).toBe('ok');
    expect(calls).toHaveLength(0);

    // After the reset: calls go out again, and the check finds the failure.
    limited = null;
    advance(81_000);
    failedRun = { id: 'bad-1', status: 3, timestamp: new Date(now).toISOString(), error: { message: 'Boom' } };
    expect(await checkFlowFailures(t.deps, new Date(now))).toBe(1);
    expect(logCalls().length).toBeGreaterThan(0);
    const alerts = await t.db.select().from(flowFailureAlerts).where(eq(flowFailureAlerts.connectionId, id));
    expect(alerts.map((a) => a.runId)).toEqual(['bad-1']);
    expect((await body(await as(admin).get('/flow-connections'))).data.find((c: Json) => c.id === id).limited).toBe(
      null,
    );
    await as(admin).del(`/flow-connections/${id}`);
  });

  it('without Retry-After: the connection setting `backoff_default_seconds`', async () => {
    const id = await connect('Make 429 default', { alert_on_failure: false, backoff_default_seconds: 300 });
    limited = {};
    const runs = await body(await as(admin).get(`/flow-connections/${id}/runs?flow_id=1&status=all`));
    expect(runs.warning).toBe('flow_platform_limited');
    expect(new Date(runs.limited.until).getTime()).toBe(now + 300_000);
    await as(admin).del(`/flow-connections/${id}`);
  });

  it('the failure check walks the kept list, active scenarios only, and skips a connection in backoff', async () => {
    const id = await connect('Make job', { alert_on_failure: true, check_every_minutes: 5 });
    await as(admin).get(`/flow-connections/${id}/flows`);
    calls.length = 0;
    await checkFlowFailures(t.deps, new Date(now));
    // No second scenarios list (kept), one logs call per active scenario (1, 2, 3 — not 4) for the failures; then the
    // kept stats of the screen's list, two logs calls per active scenario.
    expect(calls.filter((c) => c.path === '/scenarios')).toHaveLength(0);
    const paths = logCalls().map((c) => c.path);
    expect(paths.slice(0, 3)).toEqual(['/scenarios/1/logs', '/scenarios/2/logs', '/scenarios/3/logs']);
    expect(paths.slice(3).sort()).toEqual([
      '/scenarios/1/logs',
      '/scenarios/1/logs',
      '/scenarios/2/logs',
      '/scenarios/2/logs',
      '/scenarios/3/logs',
      '/scenarios/3/logs',
    ]);
    // A 429 elsewhere (the drawer) → the next passes ask nothing until the reset.
    limited = { 'Retry-After': '600' };
    await as(admin).get(`/flow-connections/${id}/runs?flow_id=2&status=all`);
    calls.length = 0;
    advance(6 * 60_000);
    expect(await checkFlowFailures(t.deps, new Date(now))).toBe(0);
    expect(calls.map((c) => c.path)).toEqual([]);
    await as(admin).del(`/flow-connections/${id}`);
  });
});

describe('an account shared with other systems', () => {
  const budget = {
    max_calls_per_minute: 30,
    background_share_percent: 75,
    stats_pacing_ms: 0,
    backoff_default_seconds: 60,
  };
  const tooMany = (headers: Record<string, string> = {}): FlowHttpResponse => ({
    status: 429,
    ok: false,
    body: '{}',
    headers,
  });

  it('a 429 halves the pace once per episode; each quiet minute after the reset gives a tenth back', () => {
    const id = 'pace-a';
    expect(takeFlowCall(id, budget, false, now)).toBe(0);
    expect(flowSlowedTo(id)).toBeNull();
    noteFlowRateLimited(id, budget, tooMany({ 'Retry-After': '60' }));
    expect(flowSlowedTo(id)).toBe(15);
    // Another call that was already on its way meets the same 429: not halved again.
    noteFlowRateLimited(id, budget, tooMany({ 'Retry-After': '60' }));
    expect(flowSlowedTo(id)).toBe(15);
    // The reset passes; the first quiet minute after it gives 3 back (a tenth of 30) …
    advance(60_000);
    expect(flowSlowedTo(id)).toBe(15);
    advance(60_000);
    expect(flowSlowedTo(id)).toBe(18);
    // … and after five more the full pace is back.
    advance(4 * 60_000);
    expect(flowSlowedTo(id)).toBeNull();
    // Slowed down, the bucket holds and refills at the slower pace.
    noteFlowRateLimited(id, budget, tooMany({ 'Retry-After': '1' }));
    advance(1000);
    // 15 a minute (one every 4 s), the bucket emptied at the 429: a quarter of a slot back after 1 s.
    expect(takeFlowCall(id, budget, false, now)).toBe(3000);
  });

  it('a second 429 later halves again, never below a tenth', () => {
    const id = 'pace-b';
    for (let i = 0; i < 6; i++) {
      noteFlowRateLimited(id, budget, tooMany({ 'Retry-After': '5' }));
      advance(6000);
    }
    expect(flowSlowedTo(id)).toBe(3);
  });

  it('an answer saying the quota is used up: nobody calls until its reset, and the pace stays', () => {
    const id = 'quota-a';
    expect(takeFlowCall(id, budget, false, now)).toBe(0);
    const ok = (headers: Record<string, string>): FlowHttpResponse => ({ status: 200, ok: true, body: '{}', headers });
    noteFlowQuota(id, budget, ok({ 'X-RateLimit-Remaining': '7', 'X-RateLimit-Reset': '30' }));
    expect(flowBackoff(id)).toBeNull();
    // No reset time given: nothing to wait for.
    noteFlowQuota(id, budget, ok({ 'RateLimit-Remaining': '0' }));
    expect(flowBackoff(id)).toBeNull();
    noteFlowQuota(id, budget, ok({ 'RateLimit-Remaining': '1', 'RateLimit-Reset': '30' }));
    expect(flowBackoff(id)).toEqual({ until: now + 30_000, reason: 'flow_platform_quota_used' });
    expect(flowSlowedTo(id)).toBeNull();
  });

  it('through the screen: a used-up quota stops the calls until the reset', async () => {
    const id = await connect('Make quota', { alert_on_failure: false });
    okHeaders = { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '120' };
    await as(admin).get(`/flow-connections/${id}/flows`);
    okHeaders = null;
    calls.length = 0;
    const list = await body(await as(admin).get(`/flow-connections/${id}/flows?refresh=1`));
    expect(calls).toHaveLength(0);
    expect(list.limited).toMatchObject({ by: 'platform', reason: 'flow_platform_quota_used' });
    await as(admin).del(`/flow-connections/${id}`);
  });

  it('a 429 on the screen: the limit says how slow we go now', async () => {
    const id = await connect('Make slowed', { alert_on_failure: false });
    limited = { 'Retry-After': '120' };
    const list = await body(await as(admin).get(`/flow-connections/${id}/flows`));
    expect(list.limited).toMatchObject({ by: 'platform', slowed_to: 15 });
    await as(admin).del(`/flow-connections/${id}`);
  });

  it('the screen shows kept stats whatever their age; the background check refreshes them; opening asks the list only', async () => {
    const id = await connect('Make kept stats', { alert_on_failure: false, check_every_minutes: 5 });
    const first = await body(await as(admin).get(`/flow-connections/${id}/flows`));
    expect(first.data.filter((f: Json) => f.stats_pending).map((f: Json) => f.id)).toEqual(['1', '2', '3']);
    const readFrom = now;
    const stats = await body(
      await as(admin).post(`/flow-connections/${id}/flows/stats`, { flow_ids: ['1', '2', '3'] }),
    );
    expect(Object.keys(stats.data).sort()).toEqual(['1', '2', '3']);
    const readTo = now; // the pacing between the calls moves the clock

    // Long after the stats' and the list's keep times: the list is asked again, the stats are not.
    advance(30 * 60_000);
    calls.length = 0;
    const later = await body(await as(admin).get(`/flow-connections/${id}/flows`));
    expect(calls.map((c) => c.path)).toEqual(['/scenarios']);
    const one = later.data.find((f: Json) => f.id === '1');
    expect(one.stats_pending).toBeUndefined();
    expect(one.last_run_status).toBe('success');
    expect(new Date(one.stats_at).getTime()).toBeGreaterThanOrEqual(readFrom);
    expect(new Date(one.stats_at).getTime()).toBeLessThanOrEqual(readTo);

    // The background pass (no alerts, no automations — still refreshes what the screen shows).
    const passAt = now;
    await checkFlowFailures(t.deps, new Date(now));
    calls.length = 0;
    const statsAt = async () =>
      Object.fromEntries(
        ((await body(await as(admin).get(`/flow-connections/${id}/flows`))).data as Json[])
          .filter((f) => f.active)
          .map((f) => [f.id, new Date(f.stats_at).getTime()]),
      ) as Record<string, number>;
    const after = await statsAt();
    expect(calls).toHaveLength(0);
    for (const at of Object.values(after)) expect(at).toBeGreaterThanOrEqual(passAt);
    // Within its interval, the next pass leaves them be.
    advance(60_000);
    await checkFlowFailures(t.deps, new Date(now));
    expect(await statsAt()).toEqual(after);
    await as(admin).del(`/flow-connections/${id}`);
  });

  it('the background refresh stops at our budget and goes on next time, never refusing a person', async () => {
    const id = await connect('Make small budget', {
      alert_on_failure: false,
      check_every_minutes: 5,
      max_calls_per_minute: 4,
      background_share_percent: 50,
      stats_pacing_ms: 0,
    });
    await as(admin).get(`/flow-connections/${id}/flows`);
    advance(60_000);
    await checkFlowFailures(t.deps, new Date(now));
    // Half of 4 for the background: one flow's two logs calls, then it stops; the others wait for the next pass.
    const flows = (await body(await as(admin).get(`/flow-connections/${id}/flows`))).data as Json[];
    expect(flows.filter((f) => f.stats_at).map((f) => f.id)).toEqual(['1']);
    expect(flows.filter((f) => f.stats_pending).map((f) => f.id)).toEqual(['2', '3']);
    // The person's share is untouched: the screen's list still gets through.
    calls.length = 0;
    const list = await body(await as(admin).get(`/flow-connections/${id}/flows?refresh=1`));
    expect(calls.map((c) => c.path)).toEqual(['/scenarios']);
    expect(list.limited).toBeNull();
    await as(admin).del(`/flow-connections/${id}`);
  });
});
