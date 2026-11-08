// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { accountSettings, activityLog, tags } from '../src/db/schema';
import { accountRegion } from '../src/modules/accounts/region';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Account admin A3 (08 §2): account settings — name, logo, locale, defaults for new boards / groups / columns and the
 * system announcement. Admins change them (PATCH /accounts/me); new boards and columns pick the defaults up.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let guest: string;
let betaAdmin: string;
let acmeId: string;
let betaId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

/** Simulates the browser: presign, "PUT" to storage, complete. */
const upload = async (cookie: string, name: string, size: number, mime: string) => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, size, mime);
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};

const events = () =>
  t.db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'account.updated')));

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const create = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name,
          slug,
          first_admin_email: email,
          template_set: 'empty',
        }),
      )
    ).account.id as string;
  acmeId = await create('Acme', 'acme', 'admin@acme.test');
  betaId = await create('Beta', 'beta', 'admin@beta.test');
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await as(admin).post('/users/invite', { emails: ['gina@guest.test'], role: 'guest' });
  guest = await join('gina@guest.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('account settings (A3)', () => {
  it('starts with the documented defaults', async () => {
    const res = await as(bob).get('/accounts/me');
    expect(res.status).toBe(200);
    const a = await body(res);
    expect(a.logo_url).toBeNull();
    expect(a.settings.locale).toMatchObject({
      weekend: 'fri_sat',
      first_day: 0,
      date_format: 'DD/MM/YYYY',
      time_format: '24h',
      currency: 'ILS',
    });
    expect(a.settings.defaults).toEqual({
      status_labels: [
        { label: 'בתהליך', color: 'yellow' },
        { label: 'הושלם', color: 'forest', is_done: true },
        { label: 'חסום', color: 'crimson' },
      ],
      item_terminology: 'item',
      group_colors: [],
      // F9 cardw: the item card's default width and limits.
      card_width_pct: 40,
      card_min_px: 380,
      card_max_pct: 90,
      // new numbers columns show a thousands separator.
      number_thousands: true,
      // the members' icon style until they choose their own.
      icon_style: 'duo',
      email_open: 'ask',
    });
    expect(a.settings.announcement).toBeNull();
  });

  it('admins change the name and locale; only what was sent changes; one event with what moved', async () => {
    const before = (await events()).length;
    const res = await as(admin).patch('/accounts/me', {
      name: 'Acme Ltd',
      settings: { locale: { weekend: 'sat_sun', currency: 'usd', date_format: 'YYYY-MM-DD' } },
    });
    expect(res.status).toBe(200);
    const a = await body(res);
    expect(a.name).toBe('Acme Ltd');
    expect(a.settings.locale).toMatchObject({
      weekend: 'sat_sun',
      currency: 'USD',
      date_format: 'YYYY-MM-DD',
      first_day: 0,
      time_format: '24h',
      timezone: 'Asia/Jerusalem',
    });
    // A later patch of one field keeps the others (no defaults sneak back in).
    const again = await body(await as(admin).patch('/accounts/me', { settings: { locale: { first_day: 1 } } }));
    expect(again.settings.locale).toMatchObject({ weekend: 'sat_sun', currency: 'USD', first_day: 1 });
    // The account switcher shows the new name.
    const mine = (await body(await t.api(bob).get('/me/accounts'))).data as Json[];
    expect(mine.find((x) => x.id === acmeId)!.name).toBe('Acme Ltd');

    const rows = await events();
    expect(rows.length).toBe(before + 2);
    const first = rows.find((r) => (r.payload as Json).after?.name === 'Acme Ltd')!;
    expect((first.payload as Json).before.name).toBe('Acme');
    expect(Object.keys((first.payload as Json).after).sort()).toEqual(['locale', 'name']);
  });

  it('validates every field', async () => {
    const bad = [
      { settings: { locale: { weekend: 'sun_mon' } } },
      { settings: { locale: { first_day: 7 } } },
      { settings: { locale: { date_format: 'DD-MM' } } },
      { settings: { locale: { currency: 'shekel' } } },
      { settings: { locale: { time_format: '25h' } } },
      { settings: { defaults: { status_labels: [] } } },
      { settings: { defaults: { status_labels: [{ label: 'x'.repeat(31), color: '#000000' }] } } },
      { settings: { defaults: { status_labels: [{ label: 'x', color: 'hot_pink' }] } } },
      { settings: { defaults: { group_colors: ['hot_pink'] } } },
      { settings: { defaults: { item_terminology: '' } } },
      { settings: { announcement: { text: 'x'.repeat(151) } } },
      { settings: { announcement: { text: 'hi', url: 'javascript:alert(1)' } } },
      { settings: { announcement: { text: 'hi', until: 'tomorrow' } } },
      { name: '' },
    ];
    for (const b of bad) expect((await as(admin).patch('/accounts/me', b)).status, JSON.stringify(b)).toBe(400);
  });

  it('only admins change settings', async () => {
    expect((await as(bob).patch('/accounts/me', { name: 'Bob Corp' })).status).toBe(403);
    expect((await as(guest).patch('/accounts/me', { settings: { locale: { weekend: 'fri_sat' } } })).status).toBe(403);
    // Another account's admin cannot reach this one.
    betaAdmin = await join('admin@beta.test');
    expect((await t.api(betaAdmin, acmeId).patch('/accounts/me', { name: 'x' })).status).toBe(404);
    expect((await body(await t.api(betaAdmin, betaId).get('/accounts/me'))).name).toBe('Beta');
  });

  it('new boards, groups and status columns use the account defaults', async () => {
    const labels = [
      { label: 'פתוח', color: 'blue' },
      { label: 'סגור', color: 'forest', is_done: true },
    ];
    const res = await as(admin).patch('/accounts/me', {
      settings: {
        // A legacy (pre-F9) key is read as ours.
        defaults: { status_labels: labels, item_terminology: 'ליד', group_colors: ['done_green', 'purple'] },
      },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.defaults).toEqual({
      status_labels: labels,
      item_terminology: 'ליד',
      group_colors: ['green', 'purple'],
      card_width_pct: 40,
      card_min_px: 380,
      card_max_pct: 90,
      number_thousands: true,
      icon_style: 'duo',
      email_open: 'ask',
    });

    const board = await body(await as(bob).post('/boards', { name: 'ברירות מחדל', workspace_id: wsId }));
    expect(board.item_terminology).toBe('ליד');
    expect(board.groups.map((g: Json) => g.color)).toEqual(['green']);
    const g2 = await body(await as(bob).post(`/boards/${board.id}/groups`, { title: 'שנייה' }));
    expect(g2.color).toBe('purple');
    // Then our palette order (brand colours first), skipping colours in use.
    const g3 = await body(await as(bob).post(`/boards/${board.id}/groups`, { title: 'שלישית' }));
    expect(g3.color).toBe('forest');
    // A legacy key in API input is read as ours.
    const legacy = await body(await as(bob).post(`/boards/${board.id}/groups`, { title: 'ישנה', color: 'stuck_red' }));
    expect(legacy.color).toBe('red');
    // An explicit colour wins.
    const g4 = await body(await as(bob).post(`/boards/${board.id}/groups`, { title: 'רביעית', color: 'navy' }));
    expect(g4.color).toBe('navy');

    const col = await body(await as(bob).post(`/boards/${board.id}/columns`, { title: 'שלב', type: 'status' }));
    expect(col.settings.labels).toEqual([
      { id: 0, label: 'פתוח', color: 'blue', index: 0 },
      { id: 1, label: 'סגור', color: 'forest', index: 1, is_done: true },
    ]);
    // Settings sent with the column win.
    const own = await body(
      await as(bob).post(`/boards/${board.id}/columns`, {
        title: 'אחר',
        type: 'status',
        settings: { labels: [{ id: 0, label: 'א', color: '#000000', index: 0 }] },
      }),
    );
    expect(own.settings.labels).toHaveLength(1);

    // A sub-board's status column too.
    const item = await body(await as(bob).post(`/boards/${board.id}/items`, { name: 'הורה' }));
    const child = await body(await as(bob).post(`/items/${item.id}/subitems`, { name: 'ילד' }));
    const sub = await body(await as(bob).get(`/boards/${child.board_id}`));
    expect(sub.columns.find((c: Json) => c.type === 'status').settings.labels.map((l: Json) => l.label)).toEqual([
      'פתוח',
      'סגור',
    ]);
  });

  it('the announcement: set, kept when unchanged, new id when changed, removed with null; guests see it', async () => {
    const set = await body(
      await as(admin).patch('/accounts/me', {
        settings: {
          announcement: { text: 'תחזוקה ביום שישי', url: 'https://status.example.com', until: '2099-12-31' },
        },
      }),
    );
    const a1 = set.settings.announcement;
    expect(a1).toMatchObject({ text: 'תחזוקה ביום שישי', url: 'https://status.example.com', until: '2099-12-31' });
    expect(a1.id).toBeTruthy();

    const same = await body(
      await as(admin).patch('/accounts/me', {
        settings: {
          announcement: { text: 'תחזוקה ביום שישי', url: 'https://status.example.com', until: '2099-12-31' },
        },
      }),
    );
    expect(same.settings.announcement.id).toBe(a1.id);
    const changed = await body(
      await as(admin).patch('/accounts/me', { settings: { announcement: { text: 'תחזוקה ביום ראשון' } } }),
    );
    expect(changed.settings.announcement.id).not.toBe(a1.id);
    expect(changed.settings.announcement.url).toBeUndefined();

    // Members and guests read it; guests see no other settings.
    expect((await body(await as(bob).get('/accounts/me'))).settings.announcement.text).toBe('תחזוקה ביום ראשון');
    const g = await body(await as(guest).get('/accounts/me'));
    expect(g.settings.announcement.text).toBe('תחזוקה ביום ראשון');
    expect(g.settings.defaults.item_terminology).toBe('item');

    const off = await body(await as(admin).patch('/accounts/me', { settings: { announcement: null } }));
    expect(off.settings.announcement).toBeNull();
  });

  it('the logo: an uploaded image ≤2 MB; served through a redirect; removed', async () => {
    const pdf = await upload(admin, 'a.pdf', 1000, 'application/pdf');
    expect((await as(admin).put('/accounts/me/logo', { file_id: pdf })).status).toBe(422);
    // S-14: an SVG can carry script — never a logo
    const svg = await upload(admin, 'logo.svg', 500, 'image/svg+xml');
    expect((await as(admin).put('/accounts/me/logo', { file_id: svg })).status).toBe(422);
    const big = await upload(admin, 'big.png', 3 * 1024 * 1024, 'image/png');
    expect((await as(admin).put('/accounts/me/logo', { file_id: big })).status).toBe(413);
    const png = await upload(admin, 'logo.png', 2000, 'image/png');
    expect((await as(bob).put('/accounts/me/logo', { file_id: png })).status).toBe(403);
    // Someone else's upload cannot be used.
    const bobs = await upload(bob, 'bob.png', 2000, 'image/png');
    expect((await as(admin).put('/accounts/me/logo', { file_id: bobs })).status).toBe(422);

    const res = await as(admin).put('/accounts/me/logo', { file_id: png });
    expect(res.status).toBe(200);
    expect((await body(res)).logo_url).toContain('storage.test');
    // The switcher knows there is one; <img> loads it with ?account_id= (no header).
    const mine = (await body(await t.api(bob).get('/me/accounts'))).data as Json[];
    expect(mine.find((x) => x.id === acmeId)!.logo_asset_id).toBe(png);
    const img = await t.api(bob).get(`/accounts/me/logo?account_id=${acmeId}`);
    expect(img.status).toBe(302);
    expect(img.headers.get('location')).toContain('storage.test');
    // Not a member → 404.
    expect((await t.api(betaAdmin).get(`/accounts/me/logo?account_id=${acmeId}`)).status).toBe(404);

    const removed = await body(await as(admin).del('/accounts/me/logo'));
    expect(removed.logo_url).toBeNull();
    expect((await t.api(bob).get(`/accounts/me/logo?account_id=${acmeId}`)).status).toBe(404);
    const logoEvents = (await events()).filter((e) => 'logo_asset_id' in ((e.payload as Json).after ?? {}));
    expect(logoEvents.map((e) => (e.payload as Json).after.logo_asset_id)).toEqual(expect.arrayContaining([png, null]));
    expect(logoEvents).toHaveLength(2);
  });

  it('patching notification defaults keeps the fields that were not sent', async () => {
    await as(admin).patch('/accounts/me', { settings: { notifications: { digest: 'daily', digest_hour: 17 } } });
    const a = await body(
      await as(admin).patch('/accounts/me', {
        settings: { notifications: { categories: [{ key: 'reminders', bell: true, email: false }] } },
      }),
    );
    expect(a.settings.notifications).toMatchObject({ digest: 'daily', digest_hour: 17 });
  });

  it('outside work sessions (): off by default; admins switch them on and set the interval (5–1440)', async () => {
    expect((await body(await as(admin).get('/accounts/me'))).settings.session_checks).toEqual({
      enabled: false,
      interval_minutes: 15,
    });
    const on = await body(await as(admin).patch('/accounts/me', { settings: { session_checks: { enabled: true } } }));
    expect(on.settings.session_checks).toEqual({ enabled: true, interval_minutes: 15 });
    const slower = await body(
      await as(admin).patch('/accounts/me', { settings: { session_checks: { interval_minutes: 30 } } }),
    );
    expect(slower.settings.session_checks).toEqual({ enabled: true, interval_minutes: 30 });
    for (const interval_minutes of [4, 1441, 7.5])
      expect(
        (await as(admin).patch('/accounts/me', { settings: { session_checks: { interval_minutes } } })).status,
      ).toBe(400);
    expect((await as(bob).patch('/accounts/me', { settings: { session_checks: { enabled: false } } })).status).toBe(
      403,
    );
    // The check script reads it with an admin's API token (GET /accounts/me).
    expect((await body(await as(admin).get('/accounts/me'))).settings.session_checks.enabled).toBe(true);
    await as(admin).patch('/accounts/me', { settings: { session_checks: { enabled: false, interval_minutes: 15 } } });
  });

  it('members read what the app needs, never module blobs; admins get everything but sealed secrets (audit #2)', async () => {
    await t.db
      .update(accountSettings)
      .set({
        settings: sql`${accountSettings.settings} || '{"security":{"ip_allowlist":{"ranges":["10.0.0.0/8"]}},"captcha":{"secret_sealed":"abc","site_key":"k"}}'::jsonb`,
      })
      .where(eq(accountSettings.accountId, acmeId));
    const mine = (await body(await as(bob).get('/accounts/me'))).settings;
    expect(mine.security).toBeUndefined();
    expect(mine.captcha).toBeUndefined();
    expect(mine.locale.currency).toBeDefined();
    expect(mine.permissions).toBeDefined();
    expect(mine.defaults).toBeDefined();
    const full = (await body(await as(admin).get('/accounts/me'))).settings;
    expect(full.security.ip_allowlist.ranges).toEqual(['10.0.0.0/8']);
    expect(full.captcha).toEqual({ site_key: 'k' });
  });

  it('colour data saved with the legacy (pre-F9) keys still reads; migration 0071 rewrites it to ours', async () => {
    // As stored before Release D: account defaults and a tag with the old keys.
    await t.db
      .update(accountSettings)
      .set({
        settings: sql`jsonb_set(${accountSettings.settings}, '{defaults,group_colors}', '["dark_blue","sofia_pink","navy"]'::jsonb)`,
      })
      .where(eq(accountSettings.accountId, acmeId));
    const [tag] = await t.db
      .insert(tags)
      .values({ id: newId(), accountId: acmeId, name: 'legacy-colour', color: 'egg_yolk' })
      .returning();
    // Read before the migration ran: the defaults come out as our keys.
    expect((await body(await as(admin).get('/accounts/me'))).settings.defaults.group_colors).toEqual([
      'azure',
      'pink',
      'navy',
    ]);
    const steps = readFileSync(
      fileURLToPath(new URL('../drizzle/0071_f9_colour_keys.sql', import.meta.url)),
      'utf8',
    ).split('--> statement-breakpoint');
    for (const s of steps.filter((s) => s.includes('UPDATE "tags"') || s.includes('UPDATE "account_settings"')))
      await t.pg.exec(s);
    const stored = (await t.db.select().from(accountSettings).where(eq(accountSettings.accountId, acmeId)))[0]!;
    expect((stored.settings as Json).defaults.group_colors).toEqual(['azure', 'pink', 'navy']);
    expect((await t.db.select().from(tags).where(eq(tags.id, tag!.id)))[0]!.color).toBe('yellow');
    await t.db.delete(tags).where(eq(tags.id, tag!.id));
  });
});

describe('calendar & working days', () => {
  it('every member gets the resolved calendar; admins also the platform defaults', async () => {
    const a = await body(await as(bob).get('/accounts/me'));
    expect(a.calendar).toMatchObject({ holiday_set: 'israel', hebrew_dates: 'off', duration: 'calendar', locked: [] });
    expect(a.calendar.holidays.yom_kippur).toBe('off');
    expect(a.platform_defaults).toBeNull();
    const g = await body(await as(guest).get('/accounts/me'));
    expect(g.calendar.holiday_set).toBe('israel');
    const ad = await body(await as(admin).get('/accounts/me'));
    expect(ad.platform_defaults.calendar).toMatchObject({ holiday_set: 'israel', hebrew_dates: 'off' });
  });

  it('the owner changes the defaults (merged); accounts that never chose follow them', async () => {
    let res = await t.api(owner).patch('/platform/settings', {
      calendar: { hebrew_dates: 'calendars', holidays: { purim: { state: 'off' }, yom_kippur: { locked: true } } },
    });
    expect(res.status).toBe(200);
    res = await t.api(owner).patch('/platform/settings', { calendar: { duration: 'workdays' } });
    expect((await body(res)).settings.calendar).toMatchObject({
      holiday_set: 'israel',
      hebrew_dates: 'calendars',
      duration: 'workdays',
      holidays: { purim: { state: 'off' }, yom_kippur: { locked: true } },
    });
    const a = await body(await as(bob).get('/accounts/me'));
    expect(a.calendar).toMatchObject({ hebrew_dates: 'calendars', duration: 'workdays', locked: ['yom_kippur'] });
    expect(a.calendar.holidays.purim).toBe('off');
    expect((await t.api(owner).patch('/platform/settings', { calendar: { duration: 'weeks' } })).status).toBe(400);
  });

  it('an admin overrides fields, holidays and own days; null goes back to the platform; locked holidays stay', async () => {
    let res = await as(admin).patch('/accounts/me', {
      settings: {
        calendar: {
          hebrew_dates: 'cells',
          half_day: 'off',
          holidays: { purim: 'work', yom_kippur: 'work' },
          custom_days: [{ date: '2026-12-31', name: 'Closing', state: 'off' }],
        },
      },
    });
    expect(res.status).toBe(200);
    let a = await body(res);
    expect(a.calendar).toMatchObject({ hebrew_dates: 'cells', half_day: 'off', duration: 'workdays' });
    expect(a.calendar.holidays).toMatchObject({ purim: 'work', yom_kippur: 'off' });
    expect(a.calendar.custom_days).toEqual([{ date: '2026-12-31', name: 'Closing', state: 'off' }]);
    // The locked holiday was never stored for the account.
    expect(a.settings.calendar.holidays).toEqual({ purim: 'work' });
    // Members see the same calendar, and so does the region the server writes in.
    expect((await body(await as(bob).get('/accounts/me'))).calendar.hebrew_dates).toBe('cells');
    expect((await accountRegion(t.db, acmeId)).calendar).toMatchObject({ hebrew_dates: 'cells', half_day: 'off' });

    res = await as(admin).patch('/accounts/me', { settings: { calendar: { hebrew_dates: null, holidays: {} } } });
    a = await body(res);
    expect(a.calendar.hebrew_dates).toBe('calendars');
    expect(a.calendar.half_day).toBe('off');
    expect(a.calendar.holidays.purim).toBe('off');
    expect(a.calendar.custom_days).toHaveLength(1);

    // Marks in the date picker: the platform's default, the account's own, and null back to the platform's.
    expect(a.calendar.picker_marks).toBe('dot');
    res = await t.api(owner).patch('/platform/settings', { calendar: { picker_marks: 'none' } });
    expect((await body(res)).settings.calendar.picker_marks).toBe('none');
    expect((await body(await as(bob).get('/accounts/me'))).calendar.picker_marks).toBe('none');
    res = await as(admin).patch('/accounts/me', { settings: { calendar: { picker_marks: 'dot' } } });
    a = await body(res);
    expect(a.settings.calendar.picker_marks).toBe('dot');
    expect(a.calendar.picker_marks).toBe('dot');
    expect(a.calendar.hebrew_dates).toBe('calendars');
    res = await as(admin).patch('/accounts/me', { settings: { calendar: { picker_marks: null } } });
    a = await body(res);
    expect(a.settings.calendar.picker_marks).toBeUndefined();
    expect(a.calendar.picker_marks).toBe('none');
    expect((await as(admin).patch('/accounts/me', { settings: { calendar: { picker_marks: 'stars' } } })).status).toBe(
      400,
    );

    expect((await as(bob).patch('/accounts/me', { settings: { calendar: { duration: 'calendar' } } })).status).toBe(
      403,
    );
    expect(
      (await as(admin).patch('/accounts/me', { settings: { calendar: { custom_days: [{ date: 'x', name: 'y' }] } } }))
        .status,
    ).toBe(400);
    await t.api(owner).patch('/platform/settings', {
      calendar: { hebrew_dates: 'off', duration: 'calendar', picker_marks: 'dot', holidays: {} },
    });
  });
});
