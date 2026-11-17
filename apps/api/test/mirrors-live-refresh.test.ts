// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportRange } from '../src/modules/dashboards/dashboards.data';
import { photonAddress, resetPhoton } from '../src/modules/geo/geocoder';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * Fix: (board): mirrors refresh live across boards (the board channel derives `item.linked_changed` for the
 * rows that link to a changed item), relative dashboard ranges, and Photon address completion.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let dealsId: string;
let clientsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

/** A fake Photon: answers GeoJSON for "herzl", nothing else; records the requests. */
const photonCalls: string[] = [];
const photon = createServer((req, res) => {
  photonCalls.push(req.url ?? '');
  res.setHeader('content-type', 'application/json');
  const hit = (req.url ?? '').toLowerCase().includes('herzl');
  res.end(
    JSON.stringify({
      features: hit
        ? [
            {
              geometry: { type: 'Point', coordinates: [34.7745, 32.0636] },
              properties: {
                osm_type: 'W',
                osm_id: 123,
                name: 'הרצל',
                street: 'הרצל',
                housenumber: '1',
                city: 'תל אביב-יפו',
                country: 'ישראל',
                countrycode: 'IL',
              },
            },
            { geometry: { type: 'Point', coordinates: ['bad', 1] }, properties: { name: 'broken' } },
          ]
        : [],
    }),
  );
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** Opens an SSE route like EventSource and collects the parsed messages (with their SSE id, if any). */
const open = async (cookie: string, path: string) => {
  const res = await t.app.request(`/api/v1${path}?account_id=${acmeId}`, { headers: { origin: WEB_ORIGIN, cookie } });
  expect(res.status).toBe(200);
  const events: Json[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;
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
        if (!data) continue;
        events.push({ ...JSON.parse(data), sse_id: /^id: ?(.*)$/m.exec(block)?.[1] });
      }
    }
  })();
  const next = async (pred: (e: Json) => boolean, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.type))}`);
  };
  await next((e) => e.type === 'ready');
  return {
    events,
    next,
    close: async () => {
      done = true;
      await reader.cancel().catch(() => {});
    },
  };
};
const settle = () => new Promise((r) => setTimeout(r, 200));

beforeAll(async () => {
  await new Promise<void>((r) => photon.listen(0, '127.0.0.1', () => r()));
  t = await createTestContext({
    env: { PHOTON_URL: `http://127.0.0.1:${(photon.address() as AddressInfo).port}`, PHOTON_MIN_INTERVAL_MS: '0' },
  });
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
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  clientsId = (await body(await as(admin).post('/boards', { name: 'Clients', workspace_id: wsId }))).id;
  dealsId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: wsId }))).id;
  await as(admin).post(`/boards/${clientsId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
  await as(admin).post(`/boards/${dealsId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
  await as(admin).post(`/boards/${dealsId}/columns`, {
    id: 'client',
    title: 'Client',
    type: 'board_relation',
    settings: { board_ids: [clientsId, dealsId] },
  });
  await as(admin).post(`/boards/${dealsId}/columns`, {
    id: 'client_amount',
    title: 'Client amount',
    type: 'mirror',
    settings: { relation_column_id: 'client', source_column_id: 'amount' },
  });
});
afterAll(async () => {
  photon.close();
  await t.close();
});

describe('mirrors refresh live across boards', () => {
  it('a change on the source board reaches the rows that link to it — only those, without an event id', async () => {
    const clientA = await body(await as(admin).post(`/boards/${clientsId}/items`, { name: 'A', cells: { amount: 1 } }));
    const clientB = await body(await as(admin).post(`/boards/${clientsId}/items`, { name: 'B', cells: { amount: 2 } }));
    const linked = await body(
      await as(admin).post(`/boards/${dealsId}/items`, {
        name: 'Deal A',
        cells: { client: { item_ids: [clientA.id] } },
      }),
    );
    const other = await body(
      await as(admin).post(`/boards/${dealsId}/items`, {
        name: 'Deal B',
        cells: { client: { item_ids: [clientB.id] } },
      }),
    );
    const s = await open(bob, `/boards/${dealsId}/events`);
    try {
      expect((await as(admin).put(`/items/${clientA.id}/cells/amount`, { value: 9 })).status).toBe(200);
      const e = await s.next((x) => x.type === 'item.linked_changed');
      expect(e).toMatchObject({ board_id: dealsId, item_id: linked.id, request_id: null });
      expect(e.sse_id).toBeUndefined(); // never part of a Last-Event-ID replay
      // The row it names now shows the new value.
      const rows = (await body(await as(bob).get(`/boards/${dealsId}/items?ids=${linked.id}`))).data as Json[];
      expect(rows[0]!.cells.client_amount.text).toContain('9');
      await settle();
      expect(s.events.filter((x) => x.type === 'item.linked_changed').map((x) => x.item_id)).toEqual([linked.id]);
      expect(s.events.some((x) => x.item_id === other.id)).toBe(false);
      // The source board's own event is not sent here (another board).
      expect(s.events.some((x) => x.item_id === clientA.id)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('renaming the linked item refreshes the relation cell too; unrelated boards stay quiet', async () => {
    const client = await body(await as(admin).post(`/boards/${clientsId}/items`, { name: 'Old name' }));
    const deal = await body(
      await as(admin).post(`/boards/${dealsId}/items`, {
        name: 'Deal R',
        cells: { client: { item_ids: [client.id] } },
      }),
    );
    const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const unrelated = (await body(await as(admin).post('/boards', { name: 'Unrelated', workspace_id: wsId }))).id;
    const quiet = await open(admin, `/boards/${unrelated}/events`);
    const s = await open(admin, `/boards/${dealsId}/events`);
    try {
      await as(admin).patch(`/items/${client.id}`, { name: 'New name' });
      expect(await s.next((x) => x.type === 'item.linked_changed')).toMatchObject({ item_id: deal.id });
      await settle();
      expect(quiet.events.some((x) => x.type === 'item.linked_changed')).toBe(false);
    } finally {
      await s.close();
      await quiet.close();
    }
  });

  it('a relation to items of the same board refreshes the other row', async () => {
    const target = await body(
      await as(admin).post(`/boards/${dealsId}/items`, { name: 'Target', cells: { amount: 1 } }),
    );
    const pointing = await body(
      await as(admin).post(`/boards/${dealsId}/items`, {
        name: 'Pointing',
        cells: { client: { item_ids: [target.id] } },
      }),
    );
    const s = await open(admin, `/boards/${dealsId}/events`);
    try {
      await as(admin).put(`/items/${target.id}/cells/amount`, { value: 5 });
      expect(await s.next((x) => x.type === 'item.linked_changed')).toMatchObject({ item_id: pointing.id });
      await settle();
      expect(s.events.some((x) => x.type === 'item.linked_changed' && x.item_id === target.id)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('a relation column added later starts the fan-out without reconnecting', async () => {
    const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const later = (await body(await as(admin).post('/boards', { name: 'Later', workspace_id: wsId }))).id;
    const s = await open(admin, `/boards/${later}/events`);
    try {
      await as(admin).post(`/boards/${later}/columns`, {
        id: 'rel',
        title: 'Rel',
        type: 'board_relation',
        settings: { board_ids: [clientsId] },
      });
      await s.next((x) => x.type.startsWith('column.'));
      const client = await body(await as(admin).post(`/boards/${clientsId}/items`, { name: 'C' }));
      const row = await body(
        await as(admin).post(`/boards/${later}/items`, { name: 'Row', cells: { rel: { item_ids: [client.id] } } }),
      );
      await as(admin).patch(`/items/${client.id}`, { name: 'C2' });
      expect(await s.next((x) => x.type === 'item.linked_changed')).toMatchObject({ item_id: row.id });
    } finally {
      await s.close();
    }
  });
});

describe('dashboard time ranges stay relative', () => {
  const env = { today: '2026-10-07', firstDay: 0 };
  const none = { from: null, to: null };
  it('resolves each range in the account calendar', () => {
    expect(reportRange('today', env, none)).toEqual({ from: '2026-10-07', to: '2026-10-07' });
    expect(reportRange('yesterday', env, none)).toEqual({ from: '2026-10-06', to: '2026-10-06' });
    expect(reportRange('this_week', env, none)).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(reportRange('this_week', { ...env, firstDay: 1 }, none)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(reportRange('last_week', env, none)).toEqual({ from: '2026-09-27', to: '2026-10-03' });
    expect(reportRange('last_month', env, none)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(reportRange('last_7', env, none)).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(reportRange('last_30', env, none)).toEqual({ from: '2026-09-08', to: '2026-10-07' });
    expect(reportRange('this_quarter', env, none)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(reportRange('last_year', env, none)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(reportRange('custom', env, { from: '2026-01-01', to: null })).toEqual({ from: '2026-01-01' });
    expect(reportRange('all', env, none)).toEqual({});
  });
});

describe('address completion with Photon', () => {
  it('is the default without a Google key, with coordinates in the suggestion', async () => {
    resetPhoton();
    const cfg = await body(await as(bob).get('/geo/config'));
    expect(cfg).toMatchObject({ autocomplete: true, autocomplete_provider: 'photon' });
    const res = await body(await as(bob).get(`/geo/autocomplete?q=${encodeURIComponent('Herzl 1 Tel Aviv')}`));
    expect(res.data).toEqual([
      {
        place_id: 'photon:W123',
        text: 'הרצל 1, תל אביב-יפו, ישראל',
        address: 'הרצל 1, תל אביב-יפו, ישראל',
        lat: 32.0636,
        lng: 34.7745,
        country_code: 'IL',
      },
    ]);
    expect(photonCalls.at(-1)).toContain('lang=default');
    expect(photonCalls.at(-1)).toContain('limit=8');
    // The same text again comes from the cache; short text never asks.
    const before = photonCalls.length;
    await as(bob).get(`/geo/autocomplete?q=${encodeURIComponent('herzl 1 tel aviv')}`);
    await as(bob).get('/geo/autocomplete?q=he');
    expect(photonCalls.length).toBe(before);
    expect((await as(bob).get('/geo/places/photon:W123')).status).toBe(404);
  });

  it('admins choose the provider: off, or Google only with a key', async () => {
    expect((await as(bob).put('/geo/settings', { autocomplete: 'off' })).status).toBe(403);
    expect(await body(await as(admin).put('/geo/settings', { autocomplete: 'off' }))).toMatchObject({
      autocomplete: false,
      autocomplete_provider: null,
    });
    const before = photonCalls.length;
    expect((await body(await as(bob).get('/geo/autocomplete?q=Herzl'))).data).toEqual([]);
    expect(photonCalls.length).toBe(before);
    expect(await body(await as(admin).put('/geo/settings', { autocomplete: 'google' }))).toMatchObject({
      autocomplete: false,
    });
    expect(
      await body(await as(admin).put('/geo/settings', { autocomplete: 'auto', google_key: 'AIzaSyTestKey123456' })),
    ).toMatchObject({ autocomplete: true, autocomplete_provider: 'google' });
    await as(admin).put('/geo/settings', { google_key: null });
  });

  it('builds one readable line from the parts, without repeats', () => {
    expect(photonAddress({ name: 'Azrieli', street: 'Menachem Begin', housenumber: '132', city: 'Tel Aviv' })).toBe(
      'Azrieli, Menachem Begin 132, Tel Aviv',
    );
    expect(photonAddress({ name: 'Haifa', city: 'Haifa', country: 'Israel' })).toBe('Haifa, Israel');
    expect(photonAddress({})).toBe('');
  });
});
