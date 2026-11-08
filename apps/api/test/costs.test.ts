// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { aiUsage, costEntries } from '../src/db/schema';
import {
  allocate,
  monthForecast,
  numberFrom,
  pickRule,
  priceEntries,
  type PriceRule,
  valueAtPath,
} from '../src/modules/costs/costs.math';
import { bumpMeter, METER } from '../src/modules/costs/meter';
import { costTick, sendCostAlerts, setCostRequestForTests, today } from '../src/modules/costs/costs.service';
import type { CostRequest } from '../src/modules/costs/adapters';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Platform costs: sources (the platform's own measurements, Railway, Cloudflare R2, any JSON API, a
 * fixed fee), the unit-price table with free allowances, exchange rates, the reports and the alerts. Every provider
 * call is answered here — no test reaches Railway, Cloudflare or a rates service.
 */
let t: TestContext;
let owner: string;
let member: string;
let accountId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const day = today();
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** Provider calls: each test sets what the providers answer; calls are recorded. */
let calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
let answer: (url: string, body?: string) => { status?: number; json: unknown } = () => ({ status: 500, json: {} });
const fake: CostRequest = async (url, init) => {
  calls.push({ url, body: init.body, headers: init.headers });
  const a = answer(url, init.body);
  return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, body: JSON.stringify(a.json) };
};

const sources = async () => (await body(await t.api(owner).get('/platform/costs/sources'))).data as Json[];
const summary = async (from = yesterday, to = day) =>
  body(await t.api(owner).get(`/platform/costs/summary?from=${from}&to=${to}`));
const rows = async (sourceId: string) =>
  (await t.db
    .select()
    .from(costEntries)
    .where(sql`${costEntries.sourceId} = ${sourceId}`)) as Json[];

beforeAll(async () => {
  t = await createTestContext();
  setCostRequestForTests(fake);
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const acc = await body(
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'empty',
    }),
  );
  accountId = acc.account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  member = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(member).post('/invitations/accept', { token });
  // Amounts in dollars unless a test says otherwise (no exchange rate needed).
  await t.api(owner).patch('/platform/costs/settings', { display_currency: 'USD', fx_source: 'manual' });
});
afterEach(() => {
  calls = [];
});
afterAll(async () => {
  setCostRequestForTests(null);
  await t.close();
});

describe('pricing math', () => {
  const rule = (p: Partial<PriceRule>): PriceRule => ({
    id: 'r',
    metric: 'm',
    service: '*',
    price: 1,
    currency: 'USD',
    freePerMonth: 0,
    effectiveFrom: '2030-01-01',
    ...p,
  });

  it('an exact service beats *, a later start beats an earlier, nothing before its start', () => {
    const rules = [
      rule({ id: 'any' }),
      rule({ id: 'api', service: 'api' }),
      rule({ id: 'later', effectiveFrom: '2030-02-01' }),
    ];
    expect(pickRule(rules, 'm', 'api', '2030-03-01')?.id).toBe('api');
    expect(pickRule(rules, 'm', 'web', '2030-03-01')?.id).toBe('later');
    expect(pickRule(rules, 'm', 'web', '2030-01-15')?.id).toBe('any');
    expect(pickRule(rules, 'm', 'web', '2029-12-31')).toBeUndefined();
    expect(pickRule(rules, 'other', 'web', '2030-03-01')).toBeUndefined();
  });

  it('free units go to the month’s first days, across services; a new month starts again', () => {
    const rules = [rule({ price: 2, freePerMonth: 10 })];
    const priced = priceEntries(
      [
        { key: 'a', day: '2030-01-01', metric: 'm', service: 'x', quantity: 6 },
        { key: 'b', day: '2030-01-01', metric: 'm', service: 'y', quantity: 6 },
        { key: 'c', day: '2030-01-02', metric: 'm', service: 'x', quantity: 5 },
        { key: 'd', day: '2030-02-01', metric: 'm', service: 'x', quantity: 12 },
        { key: 'e', day: '2030-02-01', metric: 'none', service: 'x', quantity: 12 },
      ],
      rules,
    );
    expect(priced.get('a')).toEqual({ cost: 0, currency: 'USD' });
    expect(priced.get('b')).toEqual({ cost: 4, currency: 'USD' });
    expect(priced.get('c')).toEqual({ cost: 10, currency: 'USD' });
    expect(priced.get('d')).toEqual({ cost: 4, currency: 'USD' });
    expect(priced.get('e')).toEqual({ cost: null, currency: null });
  });

  it('forecast: the days before today plus the week’s average for the days left', () => {
    const byDay = new Map<string, number>();
    for (let d = 1; d <= 9; d++) byDay.set(`2030-04-${String(d).padStart(2, '0')}`, 10);
    // April has 30 days: 9 days before the 10th (90) + 10/day × 21 days left (210).
    expect(monthForecast(byDay, '2030-04-10')).toBe(300);
  });

  it('shared costs split by use, equally (when nobody used anything) and by seats', () => {
    const accounts = [
      { id: 'a', direct: 30, seats: 1 },
      { id: 'b', direct: 10, seats: 3 },
    ];
    expect(Object.fromEntries(allocate(100, accounts, 'usage'))).toEqual({ a: 75, b: 25 });
    expect(Object.fromEntries(allocate(100, accounts, 'seats'))).toEqual({ a: 25, b: 75 });
    expect(Object.fromEntries(allocate(100, accounts, 'equal'))).toEqual({ a: 50, b: 50 });
    expect(
      Object.fromEntries(
        allocate(
          10,
          accounts.map((a) => ({ ...a, direct: 0 })),
          'usage',
        ),
      ),
    ).toEqual({ a: 5, b: 5 });
  });

  it('reads an amount at a path', () => {
    expect(valueAtPath({ data: { items: [{ cost: '$12.50' }] } }, 'data.items[0].cost')).toBe('$12.50');
    expect(numberFrom('$1,234.50')).toBe(1234.5);
    expect(valueAtPath({ a: 1 }, 'b.c')).toBeUndefined();
    expect(valueAtPath({ a: 1 }, '__proto__')).toBeUndefined();
    expect(numberFrom('n/a')).toBeNull();
  });
});

describe('access', () => {
  it('is the platform owner’s only', async () => {
    expect((await t.api(member).get('/platform/costs/sources')).status).toBe(404);
    expect((await t.api(member).get(`/platform/costs/summary?from=${day}&to=${day}`)).status).toBe(404);
    expect((await t.api('').get('/platform/costs/settings')).status).toBe(401);
  });
});

describe('the platform’s own measurements', () => {
  it('is a source from the start, cannot be removed or added again', async () => {
    const list = await sources();
    const internal = list.find((s) => s.adapter === 'internal')!;
    expect(internal).toMatchObject({ enabled: true, secret_set: false });
    expect((await t.api(owner).del(`/platform/costs/sources/${internal.id}`)).status).toBe(409);
    expect((await t.api(owner).post('/platform/costs/sources', { adapter: 'internal' })).status).toBe(409);
  });

  it('counts emails, SMS parts, searches and AI; prices them from the table', async () => {
    const internal = (await sources()).find((s) => s.adapter === 'internal')!;
    await t.db.execute(sql`delete from usage_meter`);
    // Sending through the app's own mailer and SMS sender counts them (the platform's / the account's).
    await t.deps.mailer.send({ to: 'x@acme.test', subject: 's', html: '<p>h</p>', text: 'h' });
    await t.deps.sms.send({ to: '0501234567', text: 'שלום', accountId });
    await bumpMeter(t.db as unknown as Db, METER.webSearch, 3, accountId);
    await t.db.insert(aiUsage).values({
      accountId,
      day,
      source: 'agent',
      connectionId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      model: 'm',
      calls: 4,
      costUsd: 1.25,
    });

    expect((await t.api(owner).post('/platform/costs/sync', { source_id: internal.id })).status).toBe(200);
    const mine = await rows(internal.id);
    const of = (metric: string) => mine.filter((r) => r.metric === metric);
    expect(of('email_sent')[0]).toMatchObject({ quantity: 1, accountRef: '', cost: null });
    expect(of('sms_segments')[0]).toMatchObject({ quantity: 1, accountRef: accountId });
    expect(of('web_search_calls')[0]).toMatchObject({ quantity: 3 });
    // AI on a connection the account doesn't own = the platform's key; its money is the source's own.
    expect(of('ai')[0]).toMatchObject({ service: 'platform_key', quantity: 4, amount: 1.25, cost: 1.25 });

    let s = await summary();
    expect(s.total).toBe(1.25);
    expect(s.services.find((x: Json) => x.metric === 'email_sent')).toMatchObject({ unpriced: true, total: 0 });

    // A price for emails: the rows already read are priced at once.
    const price = await t.api(owner).post('/platform/costs/prices', {
      metric: 'email_sent',
      price: 0.5,
      currency: 'USD',
      effective_from: '2020-01-01',
    });
    expect(price.status).toBe(201);
    s = await summary();
    expect(s.total).toBe(1.75);
    expect(s.services.find((x: Json) => x.metric === 'email_sent')).toMatchObject({ unpriced: false, total: 0.5 });

    // A free allowance that covers it → free again; removing the price → unpriced.
    const p = await body(price);
    await t.api(owner).patch(`/platform/costs/prices/${p.id}`, { free_per_month: 5 });
    expect((await summary()).total).toBe(1.25);
    await t.api(owner).del(`/platform/costs/prices/${p.id}`);
    expect((await summary()).services.find((x: Json) => x.metric === 'email_sent').unpriced).toBe(true);

    // Only the platform's key: an account's own AI key is the account's spend.
    await t.api(owner).patch(`/platform/costs/sources/${internal.id}`, { config: { ai_scope: 'platform' } });
    await t.db.execute(sql`delete from ai_usage`);
    await t.db
      .insert(aiUsage)
      .values({ accountId, day, source: 'agent', connectionId: 'x', model: 'm', calls: 1, costUsd: 2 });
    await t.api(owner).post('/platform/costs/sync', { source_id: internal.id });
    expect((await rows(internal.id)).filter((r) => r.metric === 'ai')).toHaveLength(1);
  });
});

describe('Railway', () => {
  const railwayAnswer = (url: string, raw?: string) => {
    expect(url).toBe('https://backboard.railway.com/graphql/v2');
    const q = JSON.parse(raw!) as { query: string; variables: Json };
    if (q.query.includes('project(id'))
      return {
        json: {
          data: {
            project: {
              services: { edges: [{ node: { id: 's1', name: 'api' } }] },
              environments: { edges: [{ node: { id: 'e1', name: 'production' } }] },
            },
          },
        },
      };
    return {
      json: {
        data: {
          usage: [
            { measurement: 'CPU_USAGE', value: 100, tags: { serviceId: 's1', environmentId: 'e1' } },
            { measurement: 'MEMORY_USAGE_GB', value: 1000, tags: { serviceId: 's1', environmentId: 'e1' } },
            { measurement: 'NETWORK_TX_GB', value: 0, tags: { serviceId: 's1', environmentId: 'e1' } },
          ],
        },
      },
    };
  };

  it('needs a key and a project; never shows the key; reads usage per service and environment', async () => {
    expect((await t.api(owner).post('/platform/costs/sources', { adapter: 'railway', config: {} })).status).toBe(422);
    expect(
      (await t.api(owner).post('/platform/costs/sources', { adapter: 'railway', config: { project_id: 'p1' } })).status,
    ).toBe(422);
    answer = railwayAnswer;
    const res = await t.api(owner).post('/platform/costs/sources', {
      adapter: 'railway',
      name: 'Servers',
      config: { project_id: 'p1' },
      secret: 'rw-secret-token-1234',
    });
    expect(res.status).toBe(201);
    const src = await body(res);
    expect(src).toMatchObject({ secret_set: true, secret_hint: '…1234' });
    expect(JSON.stringify(src)).not.toContain('rw-secret');
    // A new source reads its past days at once (30 by default), with the key as a bearer token.
    expect(calls.some((c) => c.headers.authorization === 'Bearer rw-secret-token-1234')).toBe(true);
    const mine = await rows(src.id);
    expect(new Set(mine.map((r) => r.day)).size).toBe(30);
    expect(mine.find((r) => r.day === day && r.metric === 'railway.cpu')).toMatchObject({
      service: 'api · production',
      quantity: 100,
      unit: 'vcpu_minute',
      cost: null,
    });
    // Zero usage is not stored.
    expect(mine.some((r) => r.metric === 'railway.egress')).toBe(false);

    await t.api(owner).post('/platform/costs/prices', {
      metric: 'railway.cpu',
      price: 0.01,
      currency: 'USD',
      effective_from: '2020-01-01',
    });
    const s = await summary(day, day);
    expect(s.sources.find((x: Json) => x.id === src.id).total).toBe(1);
    expect(s.days[0].by_source[src.id]).toBe(1);
    const listed = (await sources()).find((x) => x.id === src.id)!;
    expect(listed).toMatchObject({ last_sync_ok: true, name: 'Servers' });
  });

  it('a provider error is kept on the source and shown by the test', async () => {
    const src = (await sources()).find((s) => s.adapter === 'railway')!;
    answer = () => ({ json: { errors: [{ message: 'Not Authorized' }] } });
    const test = await body(await t.api(owner).post(`/platform/costs/sources/${src.id}/test`));
    expect(test.ok).toBe(false);
    expect(JSON.parse(test.error)).toMatchObject({
      reason: 'cost_source_provider',
      details: { message: 'Not Authorized' },
    });
    await t.api(owner).post('/platform/costs/sync', { source_id: src.id });
    const after = (await sources()).find((s) => s.id === src.id)!;
    expect(after.last_sync_ok).toBe(false);
    expect(after.last_error).toContain('Not Authorized');
    // The rows it had stay (a failed read replaces nothing).
    expect((await rows(src.id)).length).toBeGreaterThan(0);
  });
});

describe('Cloudflare R2', () => {
  it('stored bytes as GB-months and operations by class, per bucket', async () => {
    answer = () => ({
      json: {
        data: {
          viewer: {
            accounts: [
              {
                storage: [
                  { max: { payloadSize: 2 * 1024 ** 3, metadataSize: 0 }, dimensions: { bucketName: 'files' } },
                ],
                ops: [
                  { sum: { requests: 1000 }, dimensions: { actionType: 'PutObject', bucketName: 'files' } },
                  { sum: { requests: 5000 }, dimensions: { actionType: 'GetObject', bucketName: 'files' } },
                  { sum: { requests: 70 }, dimensions: { actionType: 'DeleteObject', bucketName: 'files' } },
                ],
              },
            ],
          },
        },
      },
    });
    await t.api(owner).patch('/platform/costs/settings', { backfill_days: 1 });
    const src = await body(
      await t.api(owner).post('/platform/costs/sources', {
        adapter: 'cloudflare_r2',
        config: { account_id: 'acc' },
        secret: 'cf-token-abcd',
      }),
    );
    const sent = JSON.parse(calls[0]!.body!) as { variables: Json };
    expect(sent.variables.a).toBe('acc');
    const mine = await rows(src.id);
    const days = Number(new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate());
    expect(mine.find((r) => r.metric === 'r2.storage')!.quantity).toBeCloseTo(2 / days, 6);
    expect(mine.find((r) => r.metric === 'r2.class_a')).toMatchObject({ quantity: 1000, service: 'files' });
    expect(mine.find((r) => r.metric === 'r2.class_b')).toMatchObject({ quantity: 5000 });
    expect(mine.some((r) => r.metric === 'DeleteObject')).toBe(false);
    await t.api(owner).patch('/platform/costs/settings', { backfill_days: 30 });
  });
});

describe('any JSON API and a fixed fee', () => {
  it('month-to-date: today holds what grew since the month’s earlier days', async () => {
    answer = (url) => {
      expect(url).toBe('https://api.example.com/usage');
      return { json: { data: { total: '$40.00' } } };
    };
    const src = await body(
      await t.api(owner).post('/platform/costs/sources', {
        adapter: 'http_json',
        config: {
          url: 'https://api.example.com/usage',
          amount_path: 'data.total',
          amount_mode: 'month_to_date',
          currency: 'usd',
        },
        secret: 'k-123',
      }),
    );
    expect(calls[0]!.headers.Authorization).toBe('k-123');
    let mine = await rows(src.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ day, amount: 40, currency: 'USD' });
    // An earlier day of the month already held 15 → today is 25 (unless today is the 1st).
    if (day.slice(8) !== '01') {
      await t.db.insert(costEntries).values({
        sourceId: src.id,
        day: `${day.slice(0, 7)}-01`,
        metric: 'http_json',
        unit: 'amount',
        quantity: 1,
        amount: 15,
        cost: 15,
        currency: 'USD',
      });
      await t.api(owner).post('/platform/costs/sync', { source_id: src.id });
      mine = await rows(src.id);
      expect(mine.find((r) => r.day === day)!.amount).toBe(25);
    }
    // A wrong path says so.
    await t.api(owner).patch(`/platform/costs/sources/${src.id}`, {
      config: { url: 'https://api.example.com/usage', amount_path: 'nope', amount_mode: 'day', currency: 'USD' },
    });
    const test = await body(await t.api(owner).post(`/platform/costs/sources/${src.id}/test`));
    expect(JSON.parse(test.error).reason).toBe('cost_source_amount_missing');
    await t.api(owner).del(`/platform/costs/sources/${src.id}`);
    expect((await sources()).some((s) => s.id === src.id)).toBe(false);
  });

  it('a fixed monthly fee is spread over the month’s days', async () => {
    const src = await body(
      await t.api(owner).post('/platform/costs/sources', {
        adapter: 'recurring',
        name: 'Domain',
        config: { amount: 31, currency: 'USD', period: 'month' },
      }),
    );
    const mine = await rows(src.id);
    const days = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
    expect(mine.find((r) => r.day === day)!.amount).toBeCloseTo(31 / days, 6);
    await t.api(owner).del(`/platform/costs/sources/${src.id}`);
  });
});

describe('currency', () => {
  it('converts with the owner’s rates, and lists a currency with none', async () => {
    const before = (await summary(day, day)).total as number;
    await t
      .api(owner)
      .patch('/platform/costs/settings', { display_currency: 'ILS', fx_source: 'manual', fx_manual: {} });
    const s = await summary(day, day);
    expect(s.currency).toBe('ILS');
    expect(s.missing_rates).toContain('USD');
    await t.api(owner).patch('/platform/costs/settings', { fx_manual: { USD: 3 } });
    expect((await summary(day, day)).total).toBeCloseTo(before * 3, 2);
  });

  it('Bank of Israel rates: stored per day and used', async () => {
    answer = (url) => {
      expect(url).toBe('https://boi.org.il/PublicApi/GetExchangeRates');
      return { json: { exchangeRates: [{ key: 'USD', currentExchangeRate: 4, unit: 1 }] } };
    };
    const before = (await summary(day, day)).total as number;
    const res = await body(await t.api(owner).patch('/platform/costs/settings', { fx_source: 'boi' }));
    expect(res.fx_rates).toMatchObject({ USD: 4 });
    expect((await summary(day, day)).total).toBeCloseTo((before / 3) * 4, 2);
    await t.api(owner).patch('/platform/costs/settings', { display_currency: 'USD', fx_source: 'manual' });
  });
});

describe('by account', () => {
  it('own costs and a share of the shared ones', async () => {
    await t.api(owner).patch('/platform/costs/settings', { allocation: 'equal' });
    const r = await body(await t.api(owner).get(`/platform/costs/accounts?from=${day}&to=${day}`));
    const acme = (r.data as Json[]).find((a) => a.account_id === accountId)!;
    expect(r.allocation).toBe('equal');
    expect(acme.total).toBeCloseTo(acme.direct + acme.shared, 2);
    const shares = (r.data as Json[]).reduce((s, a) => s + a.shared, 0);
    expect(shares).toBeCloseTo(r.shared_total, 1);
    expect(acme.revenue).toBeNull();
  });
});

describe('alerts and the daily tick', () => {
  it('a forecast over the budget emails the owners once a month', async () => {
    await t.api(owner).patch('/platform/costs/settings', { budget_monthly: 0.01, alerts: true, spike_factor: null });
    const sent = await sendCostAlerts(t.deps, new Date());
    expect(sent.some((k) => k.startsWith('budget:all:'))).toBe(true);
    expect(t.lastMailTo(OWNER_EMAIL).subject).toContain('התראת עלויות');
    expect(await sendCostAlerts(t.deps, new Date())).not.toContain(sent.find((k) => k.startsWith('budget:all:')));
  });

  it('runs once a day, at or after the owner’s hour', async () => {
    await t.api(owner).patch('/platform/costs/settings', { sync_hour: 5, budget_monthly: null });
    answer = () => ({ json: { errors: [{ message: 'down' }] } });
    const morning = new Date(`${day}T04:00:00Z`);
    expect(await costTick(t.deps, morning)).toBe(false);
    expect(await costTick(t.deps, new Date(`${day}T05:30:00Z`))).toBe(true);
    expect(await costTick(t.deps, new Date(`${day}T09:00:00Z`))).toBe(false);
  });
});
