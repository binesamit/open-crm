// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type RecipeInput } from '@bines/shared';
import { activityLog, automationRuns, automations } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { accountOrigins, configuredMapOrigins, forgetMapOrigins } from '../src/modules/geo/geo.csp';
import { nominatimGeocoder, resetGeocoderThrottle, type Geocoder } from '../src/modules/geo/geocoder';
import { pendingLocationCells } from '../src/modules/geo/geo.repo';
import { runGeocode } from '../src/modules/geo/geo.service';
import { spaCsp } from '../src/middleware/security-headers';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * M8 ד9–ד11 (views2): the P1 columns through the API (validation, progress, button + automation), the geocoding
 * queue with a fake geocoder and a fake Nominatim, map settings and the CSP, the Files view and chart data.
 */
let owner: string;
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let adminId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie = admin) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const newItem = async (name: string) => body(await as().post(`/boards/${boardId}/items`, { name }));
const getItem = async (id: string, cookie = admin) => body(await as(cookie).get(`/items/${id}`));
const setCell = (id: string, key: string, value: unknown, cookie = admin) =>
  as(cookie).put(`/items/${id}/cells/${key}`, { value });
const addColumn = async (id: string, type: string, settings?: unknown, board = boardId) =>
  body(await as().post(`/boards/${board}/columns`, { id, title: id, type, ...(settings ? { settings } : {}) }));

/** Dispatches every new activity row and runs what it causes (as automations-engine.test does). */
const seen = new Set<string>();
const drain = async () => {
  for (let round = 0; round < 10; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.id);
      for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
    }
  }
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const account = async (slug: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: slug,
          slug,
          first_admin_email: `admin@${slug}.test`,
          template_set: 'empty',
        }),
      )
    ).account.id as string;
  acmeId = await account('acme');
  betaId = await account('beta');
  admin = await join('admin@acme.test');
  betaAdmin = await join('admin@beta.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Field work', workspace_id: ws }))).id;
  for (const [id, type] of [
    ['at', 'hour'],
    ['wk', 'week'],
    ['tz', 'world_clock'],
    ['paint', 'color_picker'],
    ['land', 'country'],
    ['place', 'location'],
    ['st1', 'status'],
    ['st2', 'status'],
    ['amount', 'numbers'],
    ['note', 'text'],
  ] as const)
    await addColumn(id, type);
  await drain();
});
afterAll(() => t.close());

describe('P1 columns through the API', () => {
  it('validates values per type (400/422) and derives the text', async () => {
    const item = await newItem('Values');
    const ok = async (key: string, value: unknown, text: string) => {
      const res = await setCell(item.id, key, value);
      expect(res.status, key).toBe(200);
      expect((await getItem(item.id)).cells[key].text).toBe(text);
    };
    await ok('at', { hour: 9, minute: 5 }, '09:05');
    await ok('wk', { start: '2026-10-04', end: '2026-10-10' }, '04/10/2026 – 10/10/2026');
    await ok('tz', { timezone: 'Europe/London' }, 'Europe/London');
    await ok('paint', { color: '#00AAFF' }, '#00AAFF');
    await ok('land', { code: 'IL' }, 'ישראל');
    await ok('place', { address: 'Herzl 1, Haifa', lat: 32.8, lng: 35 }, 'Herzl 1, Haifa');
    for (const [key, bad] of [
      ['at', { hour: 25, minute: 0 }],
      ['wk', { start: '2026-10-04', end: '2026-10-05' }],
      ['tz', { timezone: 'Nowhere/City' }],
      ['paint', { color: 'blue' }],
      ['land', { code: 'ZZ' }],
      ['place', { address: 'x', lat: 95, lng: 0 }],
    ] as const) {
      const res = await setCell(item.id, key, bad);
      expect([400, 422], key).toContain(res.status);
    }
  });

  it('filters and sorts P1 columns on the server like the board', async () => {
    const a = await newItem('Early');
    const b = await newItem('Late');
    await setCell(a.id, 'at', { hour: 7, minute: 0 });
    await setCell(b.id, 'at', { hour: 22, minute: 30 });
    const res = await body(
      await as().post(`/boards/${boardId}/items/query`, {
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ kind: 'rule', column_id: 'at', operator: 'is_not_empty' }],
        },
        sort: [{ column_id: 'at', direction: 'asc' }],
      }),
    );
    const names = (res.data as Json[]).map((i) => i.name);
    expect(names.indexOf('Early')).toBeLessThan(names.indexOf('Late'));
  });
});

describe('progress column', () => {
  it('is computed on read from the status columns and the subitems, and is read-only', async () => {
    const board = await body(await as().get(`/boards/${boardId}`));
    const done = (key: string) =>
      board.columns.find((c: Json) => c.id === key).settings.labels.find((l: Json) => l.is_done).id;
    await addColumn('prog', 'progress', { columns: [] }); // the older rule: every status column
    const item = await newItem('Progress');
    expect((await getItem(item.id)).cells.prog.text).toBe('0%');
    await setCell(item.id, 'st1', { index: done('st1') });
    expect((await getItem(item.id)).cells.prog).toMatchObject({ text: '50%', value: { percent: 50 } });
    expect((await setCell(item.id, 'prog', { percent: 10 })).status).toBe(422);

    // Weights + subitems: the subitems' status counts by its share of done subitems.
    const sub1 = await body(await as().post(`/items/${item.id}/subitems`, { name: 's1' }));
    await as().post(`/items/${item.id}/subitems`, { name: 's2' });
    const subBoard = sub1.board_id as string;
    const subStatus = await body(
      await as().post(`/boards/${subBoard}/columns`, { title: 'Sub status', type: 'status' }),
    );
    const subDone = subStatus.settings.labels.find((l: Json) => l.is_done).id;
    await as().put(`/items/${sub1.id}/cells/${subStatus.id}`, { value: { index: subDone } });
    await addColumn('prog2', 'progress', {
      columns: [{ column_id: 'st1', weight: 1 }],
      subitems: { column_id: subStatus.id, weight: 1 },
    });
    // st1 done (1) and half of the subitems (0.5) → 75%.
    expect((await getItem(item.id)).cells.prog2.text).toBe('75%');
    const q = await body(
      await as().post(`/boards/${boardId}/items/query`, {
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ kind: 'rule', column_id: 'prog2', operator: 'greater_than', values: [70] }],
        },
      }),
    );
    expect((q.data as Json[]).map((i) => i.name)).toEqual(['Progress']);
  });
});

describe('r15cols: progress from subitems (done labels, recursive, weighted) and label mirrors', () => {
  it('counts chosen done labels, sub-subitems by their share, and weights by a numbers column', async () => {
    const parent = await newItem('Rollup');
    const a = await body(await as().post(`/items/${parent.id}/subitems`, { name: 'A' }));
    const b = await body(await as().post(`/items/${parent.id}/subitems`, { name: 'B' }));
    const subBoard = a.board_id as string;
    const st = await body(await as().post(`/boards/${subBoard}/columns`, { title: 'Phase', type: 'status' }));
    const hours = await body(await as().post(`/boards/${subBoard}/columns`, { title: 'Hours', type: 'numbers' }));
    const labels = st.settings.labels as Json[];
    const working = labels.find((l) => !l.is_done)!.id as number;
    const done = labels.find((l) => l.is_done)!.id as number;
    // A has two sub-subitems, one done; B is "working" — which this column counts as done.
    const a1 = await body(await as().post(`/items/${a.id}/subitems`, { name: 'A1' }));
    await as().post(`/items/${a.id}/subitems`, { name: 'A2' });
    await as().put(`/items/${a1.id}/cells/${st.id}`, { value: { index: done } });
    await as().put(`/items/${b.id}/cells/${st.id}`, { value: { index: working } });

    const sub = { column_id: st.id, weight: 1, done_labels: [done, working] };
    await addColumn('pflat', 'progress', { source: 'subitems', subitems: sub });
    await addColumn('prec', 'progress', { source: 'subitems', subitems: { ...sub, recursive: true } });
    await addColumn('pweight', 'progress', {
      source: 'subitems',
      subitems: { ...sub, recursive: true, weight_column_id: hours.id },
    });
    await addColumn('punset', 'progress', { source: 'columns' });
    // Flat: B done, A not (A has no label) → 50%. Recursive: A = ½ (A1 of A1/A2), B = 1 → 75%.
    let cells = (await getItem(parent.id)).cells;
    expect(cells.pflat.text).toBe('50%');
    expect(cells.prec.text).toBe('75%');
    expect(cells.pweight.text).toBe('75%'); // no hours yet: equal weights
    expect(cells.punset ?? null).toBeNull(); // not set up: no value
    await as().put(`/items/${a.id}/cells/${hours.id}`, { value: 3 });
    await as().put(`/items/${b.id}/cells/${hours.id}`, { value: 1 });
    // A (½) weighs 3, B (1) weighs 1 → (1.5 + 1) / 4 = 62.5 → 63%.
    cells = (await getItem(parent.id)).cells;
    expect(cells.pweight.text).toBe('63%');
  });

  it('a mirror of a status column carries its labels with colours and counts', async () => {
    const parent = await newItem('Mirror labels');
    const s1 = await body(await as().post(`/items/${parent.id}/subitems`, { name: 's1' }));
    const s2 = await body(await as().post(`/items/${parent.id}/subitems`, { name: 's2' }));
    const s3 = await body(await as().post(`/items/${parent.id}/subitems`, { name: 's3' }));
    const subBoard = s1.board_id as string;
    const st = await body(await as().post(`/boards/${subBoard}/columns`, { title: 'Mirror st', type: 'status' }));
    const [l0, l1] = st.settings.labels as Json[];
    await as().put(`/items/${s1.id}/cells/${st.id}`, { value: { index: l0!.id } });
    await as().put(`/items/${s2.id}/cells/${st.id}`, { value: { index: l1!.id } });
    await as().put(`/items/${s3.id}/cells/${st.id}`, { value: { index: l1!.id } });
    await addColumn('mst', 'mirror', { relation_column_id: '__subitems__', source_column_id: st.id, display: 'bar' });
    const cell = (await getItem(parent.id)).cells.mst;
    expect(cell.value.labels).toEqual([
      { label: l0!.label, color: l0!.color, count: 1 },
      { label: l1!.label, color: l1!.color, count: 2 },
    ]);
    expect(cell.text).toBe(`${l0!.label}, ${l1!.label}, ${l1!.label}`);
  });
});

describe('button column', () => {
  let item: Json;
  beforeAll(async () => {
    item = await newItem('Clicky');
    await addColumn('approve', 'button', {
      label: 'Approve',
      action: {
        kind: 'set_values',
        values: [
          { column_id: 'note', text: 'approved {item.name}' },
          { column_id: 'at', text: '14:30' },
          { column_id: 'paint', text: 'not a colour' },
        ],
      },
    });
    await addColumn('open', 'button', { action: { kind: 'open_url', url: 'https://example.com/q?i={item.name}' } });
    await addColumn('fire', 'button');
  });

  it('set_values writes through the cell service in one batch; bad text is reported, not written', async () => {
    const res = await as(bob).post(`/items/${item.id}/buttons/approve`);
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.written).toEqual(['note', 'at']);
    expect(out.skipped).toEqual([{ column_id: 'paint', reason: 'invalid_value' }]);
    const after = await getItem(item.id);
    expect(after.cells.note.text).toBe('approved Clicky');
    expect(after.cells.at.value).toEqual({ hour: 14, minute: 30 });
    // One Ctrl+Z undoes the whole click.
    expect((await as(bob).post(`/activity/batches/${out.batch_id}/undo`)).status).toBeLessThan(300);
    expect((await getItem(item.id)).cells.note).toBeUndefined();
  });

  it('open_url renders the link from the item (encoded); a viewer may not click; other accounts get 404', async () => {
    const out = await body(await as(bob).post(`/items/${item.id}/buttons/open`));
    expect(out.url).toBe('https://example.com/q?i=Clicky');
    expect((await as(vera).post(`/items/${item.id}/buttons/open`)).status).toBe(403);
    expect((await t.api(betaAdmin, betaId).post(`/items/${item.id}/buttons/open`)).status).toBe(404);
    expect((await as().post(`/items/${item.id}/buttons/note`)).status).toBe(404); // not a button
    expect((await setCell(item.id, 'fire', {})).status).toBe(422); // no value to write
  });

  it('a column edit restriction blocks the click', async () => {
    await as().put(`/boards/${boardId}/columns/fire/restriction`, { kind: 'edit', users: [adminId] });
    expect((await as(bob).post(`/items/${item.id}/buttons/fire`)).status).toBe(403);
    await as().put(`/boards/${boardId}/columns/fire/restriction`, { kind: 'none' });
  });

  it('"when the button is clicked" runs an automation', async () => {
    await drain();
    const id = newId();
    const recipe: RecipeInput = {
      trigger: { type: 'button_clicked', column: 'fire' },
      actions: [{ type: 'set_column', column: 'note', value: 'fired' }],
    } as RecipeInput;
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 'Fire',
      recipe: recipe as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    expect((await as().post(`/items/${item.id}/buttons/fire`)).status).toBe(200);
    await drain();
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, id));
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
    expect((await getItem(item.id)).cells.note.text).toBe('fired');
    await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
  });

  it('the automation builder refuses the trigger on a column that is not a button', async () => {
    const res = await as().post(`/boards/${boardId}/automations`, {
      title: 'Bad',
      recipe: {
        trigger: { type: 'button_clicked', column: 'note' },
        actions: [{ type: 'notify', to: '@creator', message: 'x' }],
      },
    });
    expect(res.status).toBe(422);
  });
});

describe('geocoding queue (location column)', () => {
  const fake = (answers: Record<string, { lat: number; lng: number } | null>) => {
    const calls: string[] = [];
    const g: Geocoder = {
      provider: 'fake',
      geocode: async (address) => {
        calls.push(address);
        return answers[address] ?? null;
      },
    };
    return { g, calls };
  };
  const job = (item: string, address: string) => ({ account_id: acmeId, item_id: item, column_id: '', address });
  const columnIdOf = async (key: string) =>
    (await t.db.execute<{ id: string }>(sql`select id from columns where board_id = ${boardId} and key = ${key}`))
      .rows[0]!.id;

  it('fills lat/lng once per address, records cell.geocoded, and caches (found or not)', async () => {
    const col = await columnIdOf('place');
    const a = await newItem('Office');
    const b = await newItem('Branch');
    await setCell(a.id, 'place', { address: 'Rothschild 1, Tel Aviv' });
    await setCell(b.id, 'place', { address: '  rothschild 1,  TEL AVIV ' });
    expect((await pendingLocationCells(t.db, 100)).map((c) => c.item_id)).toEqual(expect.arrayContaining([a.id, b.id]));
    const { g, calls } = fake({ 'Rothschild 1, Tel Aviv': { lat: 32.06, lng: 34.77 } });
    expect(await runGeocode(t.deps, { ...job(a.id, 'Rothschild 1, Tel Aviv'), column_id: col }, g)).toBe('found');
    expect((await getItem(a.id)).cells.place.value).toMatchObject({ lat: 32.06, lng: 34.77 });
    // The same address (normalised) comes from the cache.
    expect(await runGeocode(t.deps, { ...job(b.id, 'rothschild 1,  TEL AVIV'), column_id: col }, g)).toBe('found');
    expect(calls).toEqual(['Rothschild 1, Tel Aviv']);
    const ev = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.itemId, a.id), eq(activityLog.type, 'cell.geocoded')));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actorType).toBe('system');
  });

  it('marks addresses it cannot find, and skips a cell whose address changed meanwhile', async () => {
    const col = await columnIdOf('place');
    const c = await newItem('Nowhere');
    await setCell(c.id, 'place', { address: 'Qwerty 999' });
    const { g } = fake({});
    expect(await runGeocode(t.deps, { ...job(c.id, 'Qwerty 999'), column_id: col }, g)).toBe('not_found');
    expect((await getItem(c.id)).cells.place.value.geocode_failed).toBe(true);
    expect((await pendingLocationCells(t.db, 100)).map((x) => x.item_id)).not.toContain(c.id);
    await setCell(c.id, 'place', { address: 'Somewhere else' });
    expect(await runGeocode(t.deps, { ...job(c.id, 'Qwerty 999'), column_id: col }, g)).toBe('stale');
  });

  it('talks to Nominatim politely: identified, one request per interval', async () => {
    const seenReqs: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seenReqs.push({ url: req.url ?? '', headers: req.headers });
      res.setHeader('content-type', 'application/json');
      res.end(
        req.url?.includes('Haifa')
          ? JSON.stringify([{ lat: '32.79', lon: '34.99', address: { country_code: 'il' } }])
          : '[]',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      resetGeocoderThrottle();
      const g = nominatimGeocoder({
        GEOCODER_URL: `http://127.0.0.1:${port}`,
        GEOCODER_EMAIL: 'ops@bines.test',
        GEOCODER_MIN_INTERVAL_MS: 300,
        WEB_ORIGIN: 'https://app.bines.test',
        GOOGLE_PLACES_URL: 'http://unused',
        GOOGLE_GEOCODE_URL: 'http://unused',
      });
      const started = Date.now();
      const [x, y] = await Promise.all([g.geocode('Haifa port'), g.geocode('Atlantis')]);
      // The second request waited for the first one's slot.
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      expect(x).toEqual({ lat: 32.79, lng: 34.99, country_code: 'IL' });
      expect(y).toBeNull();
      expect(seenReqs).toHaveLength(2);
      expect(seenReqs[0]!.headers['user-agent']).toContain('BinesOS');
      expect(seenReqs[0]!.url).toContain('format=jsonv2');
      expect(seenReqs[0]!.url).toContain('email=ops%40bines.test');
    } finally {
      server.close();
    }
  });
});

describe('map settings and the CSP', () => {
  it('members read the config; only admins change it; the Google key is write-only', async () => {
    const cfg = await body(await as(bob).get('/geo/config'));
    // Fix: without a key, addresses complete through Photon.
    expect(cfg).toMatchObject({
      style_url: 'https://tiles.openfreemap.org/styles/liberty',
      autocomplete: true,
      autocomplete_provider: 'photon',
    });
    expect((await as(bob).put('/geo/settings', { geocoder: 'off' })).status).toBe(403);
    expect((await as().put('/geo/settings', { extra_origins: ['http://insecure.test'] })).status).toBe(400);
    const saved = await body(
      await as().put('/geo/settings', {
        style_url: 'https://api.maptiler.com/maps/streets/style.json?key=abc',
        extra_origins: ['https://tiles.maptiler.com'],
        google_key: 'AIzaSyTestKey123456',
      }),
    );
    expect(saved).toMatchObject({ autocomplete: true, autocomplete_provider: 'google', google_key_hint: '…3456' });
    expect(JSON.stringify(saved)).not.toContain('AIzaSyTestKey123456');
    const asBob = await body(await as(bob).get('/geo/config'));
    expect(asBob.google_key_hint).toBeNull();
    expect(asBob.style_url).toContain('maptiler');
    const account = await body(await as(bob).get('/accounts/me'));
    expect(JSON.stringify(account)).not.toContain('AIzaSy');
  });

  it("the page's CSP lets the map load from the configured and the accounts' origins", async () => {
    const connectSrc = async () => {
      forgetMapOrigins();
      const csp = (await t.app.request('/some/page')).headers.get('content-security-policy') ?? '';
      return csp.split('; ').find((d) => d.startsWith('connect-src')) ?? '';
    };
    // Audit 2026-10-10 #8: the account's origins wait for the platform owner's approval.
    expect(await connectSrc()).not.toContain('https://api.maptiler.com');
    await t.api(owner).patch('/platform/settings', { maps: { approved_origins: ['https://api.maptiler.com'] } });
    const connect = await connectSrc();
    expect(connect).toContain('https://tiles.openfreemap.org');
    expect(connect).toContain('https://api.maptiler.com');
    expect(connect).not.toContain('https://tiles.maptiler.com');
    await t.api(owner).patch('/platform/settings', {
      maps: { approved_origins: ['https://api.maptiler.com', 'https://tiles.maptiler.com'] },
    });
    expect(await connectSrc()).toContain('https://tiles.maptiler.com');
    // API answers keep their own closed policy.
    expect((await t.app.request('/api/v1/health')).headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
  });

  it('origins come from configuration, never hard-coded', () => {
    expect(
      configuredMapOrigins({ MAP_STYLE_URL: 'https://maps.example.com/s.json', MAP_ORIGINS: 'https://a.test, bad' }),
    ).toEqual(['https://maps.example.com', 'https://a.test']);
    expect(accountOrigins([{ style_url: null, extra_origins: [] }, { nonsense: true }, null], new Set())).toEqual([]);
    // Audit 2026-10-10 #8: an account's origin joins the shared CSP only when the platform owner approved it.
    const acct = [{ style_url: 'https://tiles.acct.test/style.json', extra_origins: ['https://attacker.example'] }];
    expect(accountOrigins(acct, new Set(['https://tiles.acct.test']))).toEqual(['https://tiles.acct.test']);
    expect(accountOrigins(acct, new Set())).toEqual([]);
    const csp = spaCsp({ S3_ENDPOINT: undefined, NODE_ENV: 'production', MAP_STYLE_URL: 'https://m.test/x' }, [
      'https://acct.test',
    ]);
    expect(csp).toContain("connect-src 'self' https://m.test https://acct.test");
  });

  it('address completion goes through the server with the account key (no key, no calls)', async () => {
    await as().put('/geo/settings', { google_key: null });
    expect((await body(await as(bob).get('/geo/autocomplete?q=Herzl'))).data).toEqual([]);
    expect((await as(bob).get('/geo/places/abc')).status).toBe(404);
  });
});

describe('Files view', () => {
  const upload = async (cookie: string, name: string, mime = 'application/pdf') => {
    const pre = await body(await as(cookie).post('/files/presign', { name, size: 10, mime }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 10, mime);
    await as(cookie).post(`/files/${pre.file_id}/complete`);
    return pre.file_id as string;
  };

  it('lists file-column and update files of the board, newest first, as the reader may see them', async () => {
    await addColumn('docs', 'file');
    const item = await newItem('With files');
    const f1 = await upload(admin, 'contract.pdf');
    await as().post(`/items/${item.id}/cells/docs/files`, { file_ids: [f1] });
    const f2 = await upload(bob, 'photo.png', 'image/png');
    await as(bob).post(`/items/${item.id}/updates`, { body: 'pic', file_ids: [f2] });
    const list = await body(await as(bob).get(`/boards/${boardId}/files`));
    expect(list.data.map((f: Json) => [f.name, f.source, f.column_id, f.item_name])).toEqual([
      ['photo.png', 'update', null, 'With files'],
      ['contract.pdf', 'cell', 'docs', 'With files'],
    ]);
    expect(list.data[1].uploaded_by).toBe(adminId);
    expect((await t.api(betaAdmin, betaId).get(`/boards/${boardId}/files`)).status).toBe(404);
    // A restricted file column hides its files.
    await as().put(`/boards/${boardId}/columns/docs/restriction`, { kind: 'view', users: [adminId] });
    const hidden = await body(await as(bob).get(`/boards/${boardId}/files`));
    expect(hidden.data.map((f: Json) => f.name)).toEqual(['photo.png']);
    await as().put(`/boards/${boardId}/columns/docs/restriction`, { kind: 'none' });
  });
});

describe('chart data (large boards)', () => {
  it('counts items per status label and sums a number column, under the view query', async () => {
    const res = await as(bob).post(`/boards/${boardId}/chart`, {
      query: { search: 'Chart' },
      chart: { x: { kind: 'column', column_id: 'st2' }, measure: { fn: 'sum', column_id: 'amount' } },
    });
    expect(res.status).toBe(200);
    const board = await body(await as().get(`/boards/${boardId}`));
    const label = board.columns.find((c: Json) => c.id === 'st2').settings.labels[0];
    const a = await newItem('Chart A');
    const b = await newItem('Chart B');
    await setCell(a.id, 'st2', { index: label.id });
    await setCell(b.id, 'st2', { index: label.id });
    await setCell(a.id, 'amount', 5);
    await setCell(b.id, 'amount', 7);
    const data = await body(
      await as(bob).post(`/boards/${boardId}/chart`, {
        query: { search: 'Chart' },
        chart: { x: { kind: 'column', column_id: 'st2' }, measure: { fn: 'sum', column_id: 'amount' } },
      }),
    );
    expect(data.rows).toEqual([
      { key: String(label.id), label: label.label, color: label.color, values: { value: 12 } },
    ]);
    expect(data).toMatchObject({ items: 2, truncated: false });
  });
});
