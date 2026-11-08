// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * A3 — the account's region settings applied by the server (ANSWERS §6 #5–7): item texts (date, timeline,
 * creation log), the board export, time reports, the audit CSV and automation templates follow the account's date /
 * time format, timezone and currency; a member's own timezone and language come on top.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const region = (locale: Json) => as(admin).patch('/accounts/me', { settings: { locale } });
const cells = async () => (await body(await as(admin).get(`/items/${itemId}`))).cells as Json;

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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });

  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Dates', workspace_id: ws.id }))).id;
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'due', title: 'Due', type: 'date' });
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'when', title: 'When', type: 'timeline' });
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'time', title: 'Time', type: 'time_tracking' });
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Alpha' }))).id;
  // 22:30 UTC on Oct 5 = 01:30 on Oct 6 in Jerusalem (summer time, +3).
  await as(admin).put(`/items/${itemId}/cells/due`, { value: { date: '2026-10-05', time: '22:30' } });
  await as(admin).put(`/items/${itemId}/cells/when`, { value: { from: '2026-10-05', to: '2026-10-07' } });
  await as(admin).put(`/items/${itemId}/cells/amount`, { value: 1234.5 });
});

afterAll(async () => {
  await t?.close();
});

describe('item texts follow the region', () => {
  it('defaults: DD/MM/YYYY, 24h, Asia/Jerusalem (the day moves with the zone)', async () => {
    const c = await cells();
    expect(c.due.value).toEqual({ date: '2026-10-05', time: '22:30' }); // the value never changes
    expect(c.due.text).toBe('06/10/2026 01:30');
    expect(c.when.text).toBe('05/10/2026 – 07/10/2026');
  });

  it('an account change applies on the next read — items, lists and My Work', async () => {
    expect((await region({ date_format: 'MM/DD/YYYY', time_format: '12h' })).status).toBe(200);
    const c = await cells();
    expect(c.due.text).toBe('10/06/2026 1:30 AM');
    expect(c.when.text).toBe('10/05/2026 – 10/07/2026');
    const list = await body(await as(admin).get(`/boards/${boardId}/items`));
    expect((list.data as Json[]).find((i) => i.id === itemId)!.cells.due.text).toBe('10/06/2026 1:30 AM');
    await region({ date_format: 'YYYY-MM-DD', time_format: '24h' });
    expect((await cells()).due.text).toBe('2026-10-06 01:30');
  });

  it("a member who never chose a timezone follows the account's change", async () => {
    expect((await body(await as(admin).get('/users/me'))).timezone).toBeNull();
    expect((await body(await as(admin).get('/auth/me'))).user.timezone).toBeNull();
    await region({ timezone: 'Asia/Tokyo' });
    expect((await cells()).due.text).toBe('2026-10-06 07:30'); // 22:30 UTC = 07:30 next day in Tokyo
  });

  it("the member's own timezone wins over the account's; null goes back to the account's", async () => {
    expect((await as(admin).patch('/users/me', { timezone: 'America/New_York' })).status).toBe(200);
    expect((await cells()).due.text).toBe('2026-10-05 18:30');
    await region({ timezone: 'Europe/London' });
    expect((await cells()).due.text).toBe('2026-10-05 18:30'); // still theirs
    const cleared = await as(admin).patch('/users/me', { timezone: null });
    expect(cleared.status).toBe(200);
    expect((await body(cleared)).timezone).toBeNull();
    expect((await cells()).due.text).toBe('2026-10-05 23:30'); // London (summer time, +1)
    await region({ timezone: 'Asia/Jerusalem', date_format: 'DD/MM/YYYY' });
    expect((await cells()).due.text).toBe('06/10/2026 01:30');
  });

  it('an unknown account timezone is refused', async () => {
    expect((await region({ timezone: 'Mars/Base' })).status).toBe(400);
  });

  it('search text (the stored canonical text) is not rewritten', async () => {
    await region({ date_format: 'MM/DD/YYYY' });
    const stored = await t.pg.query<{ text_value: string }>(
      `select c.text_value from cells c join columns col on col.id = c.column_id where col.key = 'due' and c.item_id = $1`,
      [itemId],
    );
    expect(stored.rows[0]!.text_value).toBe('05/10/2026 22:30');
    await region({ date_format: 'DD/MM/YYYY' });
  });
});

describe('exports and reports', () => {
  it('the board CSV writes dates in the region', async () => {
    await region({ date_format: 'DD.MM.YYYY' });
    const csv = await (await as(admin).post(`/boards/${boardId}/export`, { format: 'csv' })).text();
    expect(csv).toContain('06.10.2026 01:30');
    expect(csv).toContain('05.10.2026 – 07.10.2026');
    await region({ date_format: 'DD/MM/YYYY' });
  });

  it('time report CSV and its "by day" labels use the account format and zone', async () => {
    await as(admin).post(`/items/${itemId}/time/entries`, {
      column_id: 'time',
      started_at: '2026-09-01T06:00:00Z', // 09:00 in Jerusalem
      duration_s: 3600,
    });
    await region({ date_format: 'MM/DD/YYYY', time_format: '12h' });
    const lines = (await (await as(admin).get(`/boards/${boardId}/time/report.csv`)).text()).trim().split('\r\n');
    expect(lines[1]).toContain('09/01/2026,9:00 AM,10:00 AM,');
    const byDay = await body(await as(admin).get(`/boards/${boardId}/time/report?group_by=day`));
    expect(byDay.rows[0]).toMatchObject({ key: '2026-09-01', label: '09/01/2026' });
    const log = (await (await as(admin).get(`/items/${itemId}/time/entries.csv`)).text()).trim().split('\r\n');
    expect(log[1]).toContain('09/01/2026,9:00 AM,');
    await region({ date_format: 'DD/MM/YYYY', time_format: '24h' });
  });

  it('the audit CSV writes times in the reader region', async () => {
    await region({ timezone: 'Asia/Jerusalem' }); // writes an audit row? not necessarily — only check the format
    const csv = (await (await as(admin).get('/audit/export.csv')).text()).trim().split('\r\n');
    for (const line of csv.slice(1)) expect(line).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2},/);
  });
});

describe('automations write in the account region', () => {
  it('item dates, |date and |currency in a rendered action', async () => {
    await region({ date_format: 'MM/DD/YYYY', currency: 'USD', language: 'en' });
    const created = await body(
      await as(admin).post(`/boards/${boardId}/automations`, {
        is_active: false,
        recipe: {
          trigger: { type: 'item_created' },
          actions: [
            {
              type: 'notify',
              to: '@owner',
              message: 'Due {item.due} · {item.when.from|date} · {item.amount|currency} · {item.when.from|date:YYYY}',
            },
          ],
        },
      }),
    );
    expect(created.id).toBeTruthy();
    const dry = await body(await as(admin).post(`/automations/${created.id}/test`, { item_id: itemId }));
    expect(dry.actions[0].rendered.message).toBe('Due 10/06/2026 01:30 · 10/05/2026 · $1,234.50 · 2026');
    await region({ date_format: 'DD/MM/YYYY', currency: 'ILS', language: 'he' });
  });
});
