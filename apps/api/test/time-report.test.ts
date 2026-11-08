// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flagForgottenTimers } from '../../worker/src/tasks';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/** 03 §3.3: the board time report (by user / item / day, subitems included), CSV, "forgot your timer?". */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let boardId: string;
let a: Json;
let b: Json;
let sub: Json;
let bobId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const log = (cookie: string, itemId: string, startedAt: string, minutes: number, extra: Json = {}) =>
  as(cookie).post(`/items/${itemId}/time/entries`, {
    column_id: 'time',
    started_at: startedAt,
    duration_s: minutes * 60,
    ...extra,
  });
const report = async (q: string) => body(await as(admin).get(`/boards/${boardId}/time/report?${q}`));

beforeAll(async () => {
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
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
    (u) => u.email === 'bob@acme.test',
  )!.user_id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Hours', workspace_id: ws.id }))).id;
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'time', title: 'זמן', type: 'time_tracking' });
  a = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Alpha' }));
  b = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Beta' }));
  sub = await body(await as(admin).post(`/items/${a.id}/subitems`, { name: 'Alpha step' }));
  const subBoard = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id;
  await as(admin).post(`/boards/${subBoard}/columns`, { id: 'time', title: 'זמן', type: 'time_tracking' });

  // Sep 1 (local): bob 60m on Alpha, 120m on its subitem; Sep 2: admin 30m on Beta, not billable.
  expect((await log(bob, a.id, '2026-09-01T06:00:00Z', 60)).status).toBe(201);
  expect((await log(bob, sub.id, '2026-09-01T09:00:00Z', 120, { note: 'שלב, ראשון' })).status).toBe(201);
  expect((await log(admin, b.id, '2026-09-02T10:00:00Z', 30, { billable: false })).status).toBe(201);
});
afterAll(() => t.close());

describe('time report', () => {
  it('by user: totals, billable, subitems included', async () => {
    const r = await report('group_by=user');
    expect(r).toMatchObject({ total_s: 3.5 * 3600, billable_s: 3 * 3600, running: 0 });
    expect(r.rows.map((x: Json) => [x.label, x.duration_s, x.entries])).toEqual([
      ['bob', 3 * 3600, 2],
      ['admin', 1800, 1],
    ]);
  });

  it('by item and by day (in order); a day range and a user filter', async () => {
    const byItem = await report('group_by=item');
    expect(byItem.rows.map((x: Json) => x.label)).toEqual(['Alpha step', 'Alpha', 'Beta']);
    const byDay = await report('group_by=day');
    expect(byDay.rows.map((x: Json) => [x.key, x.duration_s])).toEqual([
      ['2026-09-01', 3 * 3600],
      ['2026-09-02', 1800],
    ]);
    expect((await report('group_by=day&from=2026-09-02')).total_s).toBe(1800);
    expect((await report(`group_by=item&user_id=${bobId}`)).rows).toHaveLength(2);
    expect((await as(admin).get(`/boards/${boardId}/time/report?from=2026-09-03&to=2026-09-01`)).status).toBe(422);
  });

  it('CSV of the entries (Excel-friendly) and of one item log', async () => {
    const res = await as(admin).get(`/boards/${boardId}/time/report.csv?group_by=user`);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM: Excel reads Hebrew
    const lines = new TextDecoder().decode(bytes).trim().split('\r\n'); // decoding drops the BOM
    expect(lines[0]).toBe(
      ['date', 'start', 'end', 'hours', 'duration', 'user', 'item', 'note', 'billable', 'source']
        .map((k) => he(`server.csv.time.${k}`))
        .join(','),
    );
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('"שלב, ראשון"');
    expect(lines[2]).toContain(',2,02:00:00,bob,Alpha step,');
    const item = await (await as(admin).get(`/items/${b.id}/time/entries.csv`)).text();
    expect(item.trim().split('\r\n')).toHaveLength(2);
    expect(item).toContain(`,${he('server.csv.no')},manual`);
  });

  it('hidden items stay out of the report (05 §6)', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'assigned_or_created' } });
    const r = await body(await as(bob).get(`/boards/${boardId}/time/report?group_by=item`));
    expect(r.rows).toEqual([]); // bob logged time but neither created nor is assigned to these items
    await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'all' } });
  });
});

describe('mirror of time', () => {
  it('a mirror over the subitems time column shows hours, not seconds', async () => {
    const mirror = await body(
      await as(admin).post(`/boards/${boardId}/columns`, {
        title: 'Sub time',
        type: 'mirror',
        settings: { relation_column_id: '__subitems__', source_column_id: 'time', aggregate: 'sum' },
      }),
    );
    const parent = await body(await as(admin).get(`/items/${a.id}`));
    expect(parent.cells[mirror.id]).toMatchObject({ text: '02:00:00', value: { number: 7200 } });
  });
});

describe('forgot your timer?', () => {
  it('a timer running for over 12 hours is flagged once', async () => {
    const started = await body(await as(bob).post(`/items/${b.id}/time/start`, { column_id: 'time' }));
    await t.db.execute(sql`update time_entries set started_at = now() - interval '13 hours' where id = ${started.id}`);
    expect(await flagForgottenTimers(t.pg)).toBe(1);
    expect(await flagForgottenTimers(t.pg)).toBe(0);
    const rows = (
      await t.db.execute<{ user_id: string; type: string }>(
        sql`select user_id, type from notifications where payload->>'entry_id' = ${started.id}`,
      )
    ).rows;
    expect(rows).toEqual([{ user_id: bobId, type: 'time.forgotten' }]);
    expect((await report('group_by=user')).running).toBe(1);
  });
});
