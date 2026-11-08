// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 03 §3.3 time tracking (M1.1 #11): timers (several at once), manual entries, edit/delete, cell cache, permissions. */
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let boardId: string;
let item1: string;
let item2: string;
let bobId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const cell = async (itemId: string) =>
  (await body(await t.api(admin, acmeId).get(`/items/${itemId}`))).cells.time as Json | undefined;

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;
  betaId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
    )
  ).account.id;
  betaAdmin = await join('admin@beta.test');

  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0];
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'משימות', workspace_id: ws.id }))).id;
  await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, { id: 'time', title: 'זמן', type: 'time_tracking' });
  item1 = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'א' }))).id;
  item2 = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'ב' }))).id;
});
afterAll(() => t.close());

describe('timer', () => {
  it('starts, caches the runner in the cell, and is idempotent per cell', async () => {
    const started = await body(await t.api(bob, acmeId).post(`/items/${item1}/time/start`, { column_id: 'time' }));
    expect(started).toMatchObject({ source: 'timer', ended_at: null, user: { id: bobId } });
    const again = await body(await t.api(bob, acmeId).post(`/items/${item1}/time/start`, { column_id: 'time' }));
    expect(again.id).toBe(started.id);
    const v = (await cell(item1))?.value;
    expect(v).toMatchObject({ running: true, entries_count: 1 });
    expect(v.runners).toEqual([{ user_id: bobId, since: started.started_at }]);
  });

  it('a running timer’s start may move back, never past now (audit 2026-10-10 A6)', async () => {
    const log = (await body(await t.api(bob, acmeId).get(`/items/${item1}/time/entries`))).data as Json[];
    const running = log.find((e) => e.user?.id === bobId && e.ended_at === null)!;
    const future = await t.api(bob, acmeId).patch(`/time/entries/${running.id}`, {
      started_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(future.status).toBe(422);
    expect((await body(future)).error.message).toBe('start_in_future');
    const earlier = await body(await t.api(bob, acmeId).patch(`/time/entries/${running.id}`, { started_at: ago(5) }));
    expect(earlier).toMatchObject({ id: running.id, ended_at: null });
  });

  it('several timers run at once — mine on two items, and someone else on the same item', async () => {
    await t.api(bob, acmeId).post(`/items/${item2}/time/start`, { column_id: 'time' });
    await t.api(admin, acmeId).post(`/items/${item2}/time/start`, { column_id: 'time' });
    expect((await cell(item1))?.value.running).toBe(true); // not stopped by starting item2
    expect((await cell(item2))?.value.runners).toHaveLength(2);
    const mine = (await body(await t.api(bob, acmeId).get('/me/time/running'))).data as Json[];
    expect(mine.map((r) => r.item.id).sort()).toEqual([item1, item2].sort());
  });

  it('stops mine only; stopping again is a conflict', async () => {
    const stopped = await body(await t.api(bob, acmeId).post(`/items/${item2}/time/stop`, {}));
    expect(stopped.ended_at).not.toBeNull();
    expect(stopped.duration_s).toBeGreaterThanOrEqual(0);
    expect((await cell(item2))?.value.runners).toHaveLength(1); // admin's still runs
    expect((await t.api(bob, acmeId).post(`/items/${item2}/time/stop`, {})).status).toBe(409);
    await t.api(admin, acmeId).post(`/items/${item2}/time/stop`, {});
    await t.api(bob, acmeId).post(`/items/${item1}/time/stop`, { column_id: 'time' });
    expect((await body(await t.api(bob, acmeId).get('/me/time/running'))).data).toEqual([]);
    expect((await cell(item1))?.value).toMatchObject({ running: false, entries_count: 1 });
  });

  it('the cell is written only through the time endpoints', async () => {
    const res = await t.api(admin, acmeId).put(`/items/${item1}/cells/time`, {
      value: { duration: 99999, running: false, entries_count: 9 },
    });
    expect(res.status).toBe(422);
  });
});

describe('manual entries', () => {
  it('validates the range and sums into the cell', async () => {
    const api = t.api(bob, acmeId);
    const before = (await cell(item1))!.value.duration as number;
    const added = await body(
      await api.post(`/items/${item1}/time/entries`, {
        column_id: 'time',
        started_at: ago(120),
        ended_at: ago(30),
        note: 'פגישה',
      }),
    );
    expect(added).toMatchObject({ source: 'manual', duration_s: 5400, note: 'פגישה', billable: true });
    const byDuration = await api.post(`/items/${item1}/time/entries`, {
      column_id: 'time',
      started_at: ago(300),
      duration_s: 1800,
    });
    expect(byDuration.status).toBe(201);
    const c = await cell(item1);
    expect(c!.value.duration).toBe(before + 7200);
    expect(c!.value.entries_count).toBe(3);

    const bad = async (started_at: string, ended_at: string) =>
      (await body(await api.post(`/items/${item1}/time/entries`, { column_id: 'time', started_at, ended_at }))).error
        .code;
    expect(await bad(ago(10), ago(20))).toBe('time_end_before_start');
    expect(await bad(ago(10), new Date(Date.now() + 3_600_000).toISOString())).toBe('time_in_future');
    expect(await bad(ago(60 * 30), ago(10))).toBe('time_too_long');
  });

  it('only board owners / admins log time for someone else', async () => {
    const forAdmin = await t.api(bob, acmeId).post(`/items/${item1}/time/entries`, {
      column_id: 'time',
      started_at: ago(90),
      ended_at: ago(60),
      user_id: (await body(await t.api(admin).get('/auth/me'))).user.id,
    });
    expect(forAdmin.status).toBe(403);
    const forBob = await body(
      await t.api(admin, acmeId).post(`/items/${item1}/time/entries`, {
        column_id: 'time',
        started_at: ago(90),
        ended_at: ago(60),
        user_id: bobId,
      }),
    );
    expect(forBob.user.id).toBe(bobId);
    expect(forBob.edited_by).not.toBeNull();
  });

  it('edits (marked as edited) and deletes own entries; others only as owner/admin', async () => {
    const log = (await body(await t.api(bob, acmeId).get(`/items/${item1}/time/entries`))).data as Json[];
    const mine = log.find((e) => e.user?.id === bobId && e.note === 'פגישה')!;
    const adminEntry = log.find((e) => e.user?.id !== bobId);

    const edited = await body(
      // Exactly an hour after its stored start (an `ago()` taken now could be a second later than the start's).
      await t.api(bob, acmeId).patch(`/time/entries/${mine.id}`, {
        note: 'פגישת לקוח',
        ended_at: new Date(Date.parse(mine.started_at) + 3_600_000).toISOString(),
      }),
    );
    expect(edited).toMatchObject({ note: 'פגישת לקוח', duration_s: 3600, edited_by: { id: bobId } });
    if (adminEntry) {
      expect((await t.api(bob, acmeId).patch(`/time/entries/${adminEntry.id}`, { note: 'x' })).status).toBe(403);
    }
    const total = (await cell(item1))!.value.duration as number;
    expect((await t.api(bob, acmeId).del(`/time/entries/${mine.id}`)).status).toBe(200);
    expect((await cell(item1))!.value.duration).toBe(total - 3600);
    expect((await t.api(bob, acmeId).del(`/time/entries/${mine.id}`)).status).toBe(404);
  });

  it('viewers read the log but cannot track; other accounts see nothing', async () => {
    expect((await t.api(vera, acmeId).get(`/items/${item1}/time/entries`)).status).toBe(200);
    expect((await t.api(vera, acmeId).post(`/items/${item1}/time/start`, { column_id: 'time' })).status).toBe(403);
    expect((await t.api(betaAdmin, betaId).get(`/items/${item1}/time/entries`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).post(`/items/${item1}/time/start`, { column_id: 'time' })).status).toBe(404);
  });
});
