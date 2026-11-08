// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { activityLog, automationRuns } from '../src/db/schema';
import { dispatchEvent, executeRun, RUNS_PER_ITEM_MINUTE } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod — "set a computed value": a service line (a subitem) gets planned minutes = quantity × the linked
 * service's minutes per unit, and a line price = quantity × its base price, written to plain number columns people
 * can still edit; the trigger hears the service and the quantity. The acceptance list of the item, in order.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let jobsId: string;
let servicesId: string;
let job: string;
let line: string;
let qty: string;
let service: string;
let minutes: string;
let linePrice: string;
let minPerUnit: string;
let price: string;
let svcTen: string;
let svcNoPrice: string;
let minutesAuto: string;
let priceAuto: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const seen = new Set<string>();
const drain = async () => {
  const runs: string[] = [];
  for (let round = 0; round < 20; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.id);
      for (const runId of await dispatchEvent(t.deps, r.id)) {
        runs.push(runId);
        await executeRun(t.deps, runId);
      }
    }
  }
  return runs;
};
const runsOf = (automationId: string, itemId?: string) =>
  t.db
    .select()
    .from(automationRuns)
    .where(
      itemId
        ? and(eq(automationRuns.automationId, automationId), eq(automationRuns.itemId, itemId))
        : eq(automationRuns.automationId, automationId),
    )
    .orderBy(asc(automationRuns.createdAt));
const cell = async (id: string, key: string) => (await body(await as().get(`/items/${id}`))).cells[key]?.value ?? null;
const setCell = (id: string, key: string, value: unknown) => as().put(`/items/${id}/cells/${key}`, { value });
const column = async (boardId: string, title: string, type: string, settings?: Json) =>
  (await body(await as().post(`/boards/${boardId}/columns`, { title, type, ...(settings ? { settings } : {}) }))).id;
const create = (boardId: string, recipe: Json, title = 'Computed') =>
  as().post(`/boards/${boardId}/automations`, { title, recipe, is_active: true });

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
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  servicesId = (await body(await as().post('/boards', { name: 'Services', workspace_id: wsId }))).id;
  minPerUnit = await column(servicesId, 'Minutes per unit', 'numbers');
  price = await column(servicesId, 'Base price', 'numbers');
  svcTen = (await body(await as().post(`/boards/${servicesId}/items`, { name: 'Washing' }))).id;
  await setCell(svcTen, minPerUnit, 10);
  await setCell(svcTen, price, 12.5);
  svcNoPrice = (await body(await as().post(`/boards/${servicesId}/items`, { name: 'Free check' }))).id;
  await setCell(svcNoPrice, minPerUnit, 4);

  jobsId = (await body(await as().post('/boards', { name: 'Jobs', workspace_id: wsId }))).id;
  job = (await body(await as().post(`/boards/${jobsId}/items`, { name: 'Job 1' }))).id;
  line = (await body(await as().post(`/items/${job}/subitems`, { name: 'Line 1' }))).id;
  const subBoardId = (await body(await as().get(`/items/${line}`))).board_id;
  qty = await column(subBoardId, 'Quantity', 'numbers');
  service = await column(subBoardId, 'Service', 'board_relation', { board_ids: [servicesId] });
  minutes = await column(subBoardId, 'Planned minutes', 'numbers');
  linePrice = await column(subBoardId, 'Line price', 'numbers');
  await drain(); // setup events: nothing listens yet
});
afterAll(() => t.close());

describe('set_computed on a service line', () => {
  it('saves the two automations of the case, the trigger hearing the service and the quantity', async () => {
    const trigger = { type: 'subitem_column_changed', columns: [service, qty] };
    const a = await create(jobsId, {
      trigger,
      actions: [
        { type: 'set_computed', column: minutes, expression: `{${qty}|1} * {${service}.${minPerUnit}}`, round: 2 },
      ],
    });
    expect(a.status).toBe(201);
    const saved = await body(a);
    minutesAuto = saved.id;
    // `columns` alone: the first is `column` (the API shows both).
    expect(saved.recipe.trigger).toMatchObject({ column: service, columns: [service, qty] });
    const b = await create(jobsId, {
      trigger,
      actions: [{ type: 'set_computed', column: linePrice, expression: `{${qty}} * {${service}.${price}}` }],
    });
    expect(b.status).toBe(201);
    priceAuto = (await body(b)).id;
  });

  it('1–2: quantity 3, then a service of 10 minutes → 30; quantity 5 → 50', async () => {
    await setCell(line, qty, 3);
    await drain();
    // No service yet: nothing to compute (skip), nothing written.
    expect(await cell(line, minutes)).toBeNull();
    await setCell(line, service, { item_ids: [svcTen] });
    await drain();
    expect(await cell(line, minutes)).toBe(30);
    expect(await cell(line, linePrice)).toBe(37.5);
    await setCell(line, qty, 5);
    await drain();
    expect(await cell(line, minutes)).toBe(50);
    expect(await cell(line, linePrice)).toBe(62.5);
  });

  it('3: an empty quantity takes its default (1)', async () => {
    await setCell(line, qty, null);
    await drain();
    expect(await cell(line, minutes)).toBe(10);
    // The price has no default: a missing quantity leaves it (skip).
    expect(await cell(line, linePrice)).toBe(62.5);
    const last = (await runsOf(priceAuto, line)).at(-1)!;
    expect(last.actionsLog).toMatchObject([{ type: 'set_computed', status: 'skipped', reason: 'missing_value' }]);
  });

  it('4: a service without a base price leaves the line price (skip)', async () => {
    await setCell(line, qty, 2);
    await drain();
    expect(await cell(line, linePrice)).toBe(25);
    await setCell(line, service, { item_ids: [svcNoPrice] });
    await drain();
    expect(await cell(line, minutes)).toBe(8);
    expect(await cell(line, linePrice)).toBe(25); // unchanged: the new service has no price
  });

  it('5–6: a hand edit stays and runs nothing; a later quantity change computes again', async () => {
    const before = (await runsOf(minutesAuto, line)).length;
    await setCell(line, minutes, 45);
    await drain();
    expect(await cell(line, minutes)).toBe(45);
    expect((await runsOf(minutesAuto, line)).length).toBe(before);
    await setCell(line, qty, 3);
    await drain();
    expect(await cell(line, minutes)).toBe(12);
  });

  it('8: 50 changes in a row — no loop, one run per change', async () => {
    const before = (await runsOf(minutesAuto, line)).length;
    for (let i = 1; i <= 50; i++) await setCell(line, qty, 100 + i);
    await drain();
    const runs = (await runsOf(minutesAuto, line)).slice(before);
    expect(runs).toHaveLength(50);
    expect(runs.every((r) => r.depth === 1)).toBe(true);
    expect(await cell(line, minutes)).toBe(600);
    // 50 writes and 100 runs (both automations hear the quantity): slow on a busy machine.
  }, 120_000);

  it('the per-minute brake stops the same automation on one item, as an error', async () => {
    const other = (await body(await as().post(`/items/${job}/subitems`, { name: 'Line 2' }))).id;
    await setCell(other, service, { item_ids: [svcTen] });
    await drain();
    // As if it had already run its full minute on this line.
    for (let i = 0; i < RUNS_PER_ITEM_MINUTE; i++)
      await t.db.insert(automationRuns).values({
        id: newId(),
        accountId: acmeId,
        automationId: minutesAuto,
        itemId: other,
        status: 'succeeded',
        depth: 1,
        chain: [],
        eventType: 'cell.changed',
      });
    await setCell(other, qty, 7);
    await drain();
    const last = (await runsOf(minutesAuto, other)).at(-1)!;
    expect(last).toMatchObject({ status: 'failed', error: 'run_limit' });
    expect(await cell(other, minutes)).toBe(10); // from the service pick, before the brake
  });

  it('9: on a board item, a relation to another board', async () => {
    const svc = await column(jobsId, 'Main service', 'board_relation', { board_ids: [servicesId] });
    const total = await column(jobsId, 'Minutes', 'numbers');
    const res = await create(jobsId, {
      trigger: { type: 'column_changed', column: svc },
      actions: [{ type: 'set_computed', column: total, expression: `{${svc}.${minPerUnit}#sum} * 2` }],
    });
    expect(res.status).toBe(201);
    await setCell(job, svc, { item_ids: [svcTen, svcNoPrice] });
    await drain();
    expect(await cell(job, total)).toBe(28);
  });

  it('a parent column, a date and on_empty: zero / clear', async () => {
    const rate = await column(jobsId, 'Rate', 'numbers');
    const due = await column(jobsId, 'Due', 'date');
    const subBoardId = (await body(await as().get(`/items/${line}`))).board_id;
    const cost = await column(subBoardId, 'Cost', 'numbers');
    const ready = await column(subBoardId, 'Ready by', 'date');
    await setCell(job, rate, 4);
    await setCell(job, due, { date: '2026-11-01' });
    await drain();
    const res = await create(jobsId, {
      trigger: { type: 'subitem_column_changed', column: qty },
      actions: [
        { type: 'set_computed', column: cost, expression: `{${qty}} * {parent.${rate}}`, on_empty: 'zero' },
        { type: 'set_computed', column: ready, expression: `ADD_DAYS({parent.${due}}, 3)`, on_empty: 'clear' },
      ],
    });
    expect(res.status).toBe(201);
    await setCell(line, qty, 2);
    await drain();
    expect(await cell(line, cost)).toBe(8);
    expect(await cell(line, ready)).toMatchObject({ date: '2026-11-04' });
    await setCell(job, due, null);
    await setCell(line, qty, null);
    await drain();
    expect(await cell(line, cost)).toBe(0);
    expect(await cell(line, ready)).toBeNull();
  });

  it('preview: the result on items of the sub-board, or the problem', async () => {
    const res = await as().post(`/boards/${jobsId}/automations/computed-preview`, {
      expression: `{${qty}|1} * {${service}.${minPerUnit}}`,
      level: 'sub',
      column: minutes,
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.samples[0]).toMatchObject({ item_id: line, ok: true, text: '4' });
    const bad = await body(
      await as().post(`/boards/${jobsId}/automations/computed-preview`, {
        expression: `{${qty}} * {${service}.nope}`,
        level: 'sub',
      }),
    );
    expect(bad.error).toEqual({ code: 'column_not_found', detail: `${service}.nope` });
  });

  it('7: a deleted column — refused on save with its path; a saved automation stops', async () => {
    expect((await as().del(`/boards/${servicesId}/columns/${minPerUnit}`)).status).toBeLessThan(300);
    const bad = await create(jobsId, {
      trigger: { type: 'subitem_column_changed', column: qty },
      actions: [{ type: 'set_computed', column: minutes, expression: `{${qty}} * {${service}.${minPerUnit}}` }],
    });
    expect(bad.status).toBe(422);
    expect((await body(bad)).error.details.issues[0]).toMatchObject({
      path: 'actions.0.expression',
      code: 'column_not_found',
      detail: `${service}.${minPerUnit}`,
    });
    await setCell(line, qty, 9);
    await drain();
    const last = (await runsOf(minutesAuto, line)).at(-1)!;
    expect(last.status).toBe('failed');
    const auto = await body(await as().get(`/automations/${minutesAuto}`));
    expect(auto.is_active).toBe(false);
  });
});
