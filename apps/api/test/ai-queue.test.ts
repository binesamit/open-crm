// SPDX-License-Identifier: AGPL-3.0-only
import { eq, sql } from 'drizzle-orm';
import {
  type AiClientFactory,
  aiRetryReason,
  createAiClient,
  type FetchLike,
  ProviderHttpError,
  retryAfterOf,
  scriptedAnthropic,
  TINY_PNG_BASE64,
} from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiColumnRuns } from '../src/db/schema';
import { enqueueJob, jobKeyLive } from '../src/lib/jobs';
import type * as Jobs from '../src/lib/jobs';

// The queue helper keeps its behaviour (no graphile schema here → false: the designs are made right here, one after
// the other) and records its calls; a test may make it "queue" the designs to drive the jobs by hand.
vi.mock('../src/lib/jobs', async (importOriginal) => {
  const m = await importOriginal<typeof Jobs>();
  return { ...m, enqueueJob: vi.fn(m.enqueueJob), jobKeyLive: vi.fn(m.jobKeyLive) };
});
import { aiRetryClock, CALL_RETRY, retryDelayMs, UNIT_RETRY, withAiRetry } from '../src/modules/ai/retry';
import { generateImageSet } from '../src/modules/ai/images.service';
import { clearModelCache } from '../src/modules/ai/models.service';
import { IMAGE_UNIT_TASK, type ImageUnit, imageUnitJob } from '../src/modules/ai2/image-queue';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * The AI images queue ("the system doesn't create all my images… there should be a loop that runs
 * and waits to send each image"): a run plans one design per photo × variation (`pending` on the cell) and one job
 * per design makes them one after the other; a busy provider (429 / 5xx / timeout) is tried again with backoff (its
 * Retry-After honoured) and charged once; a refusal fails only that design; the run's / month's dollar limits mark
 * the designs left as failed; "complete the missing images" makes only those, never a made one again. Text output is
 * unchanged (in the request). Against a mocked OpenAI whose image answers a test can script.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let openai: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const PNG = Buffer.from(TINY_PNG_BASE64, 'base64');
type Call = { url: string; form: string | null };
let calls: Call[] = [];
/** The next image answers (status + body + headers); empty = a good image. */
let script: { status: number; body: unknown; headers?: Record<string, string> }[] = [];
const reply = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
const providerFetch: FetchLike = async (url, init) => {
  if (url === 'https://api.openai.com/v1/models') return reply({ data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }] });
  if (url === 'https://api.openai.com/v1/chat/completions')
    return reply({
      model: 'gpt-5',
      choices: [{ message: { content: 'A short summary' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });
  const form = init.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : null;
  calls.push({ url, form });
  const next = script.shift();
  if (next) return reply(next.body, next.status, next.headers);
  return reply({ data: [{ b64_json: TINY_PNG_BASE64 }], usage: { input_tokens: 300, output_tokens: 4160 } });
};
const aiClient: AiClientFactory = (conn) =>
  createAiClient(conn, { anthropic: scriptedAnthropic(), fetch: providerFetch });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = () => t.api(admin, acmeId);

const newBoard = async (name: string) => {
  const id = (await body(await as().post('/boards', { name, workspace_id: wsId }))).id as string;
  const col = async (title: string) =>
    (await body(await as().post(`/boards/${id}/columns`, { title, type: 'file' }))).id as string;
  return { id, photos: await col('Photos'), designs: await col('Designs') };
};
type Board = Awaited<ReturnType<typeof newBoard>>;
const newItem = async (boardId: string, name: string) =>
  (await body(await as().post(`/boards/${boardId}/items`, { name }))).id as string;
let clock = Date.parse('2026-02-01T00:00:00Z');
const addImage = async (itemId: string, columnKey: string, tag: string) => {
  const data = Buffer.concat([PNG, Buffer.from(`#${tag}#`)]);
  const pre = await body(
    await as().post('/files/presign', { name: `${tag}.png`, size: data.length, mime: 'image/png' }),
  );
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, data.length, 'image/png', data);
  expect((await as().post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  expect((await as().post(`/items/${itemId}/cells/${columnKey}/files`, { file_ids: [pre.file_id] })).status).toBe(200);
  clock += 1000;
  await t.db.execute(
    sql`update cell_files set created_at = ${new Date(clock).toISOString()}::timestamptz where asset_id = ${pre.file_id}`,
  );
  return pre.file_id as string;
};
const filesOf = async (itemId: string, key: string) =>
  ((await body(await as().get(`/items/${itemId}`))).cells[key]?.value?.files ?? []).map(
    (f: Json) => f.asset_id as string,
  ) as string[];
const cellOf = async (itemId: string, key: string) =>
  (await body(await as().get(`/items/${itemId}`))).cells[key]?.value as Json | undefined;
const aiColumn = async (b: Board, settings: Json) => {
  const res = await as().post(`/boards/${b.id}/columns`, {
    title: 'AI',
    type: 'ai',
    settings: {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.designs,
      source_image_columns: [b.photos],
      instructions: 'A sketch of {Name}',
      ...settings,
    },
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await body(res)).id as string;
};
const run = async (b: Board, col: string, itemIds: string[], extra: Json = {}) =>
  body(await as().post(`/boards/${b.id}/ai-columns/${col}/run`, { mode: 'items', item_ids: itemIds, ...extra }));
const retryMissing = async (b: Board, col: string, item: string) =>
  as().post(`/boards/${b.id}/ai-columns/${col}/items/${item}/retry-missing`, {});
const runRow = async (id: string) => (await t.db.select().from(aiColumnRuns).where(eq(aiColumnRuns.id, id)))[0]!;
const imageSpend = async () =>
  (
    await t.db.execute<{ s: number }>(
      sql`select coalesce(sum(cost_usd), 0)::float as s from ai_usage where account_id = ${acmeId} and source = 'image'`,
    )
  ).rows[0]!.s;
const statusOf = (cell: Json | undefined) =>
  (cell?.ai?.outputs ?? []).map((o: Json) => [o.status, o.error ?? null, o.attempts ?? null]);

/** Waits the queue asked for, recorded instead of slept. */
let waits: number[] = [];
const realClock = { ...aiRetryClock };

beforeAll(async () => {
  clearModelCache();
  t = await createTestContext({ aiClient });
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
  admin = await join('admin@acme.test');
  expect((await as().patch('/ai/settings', { enabled: true })).status).toBe(200);
  wsId = (await body(await as().get('/workspaces'))).data[0].id as string;
  openai = (
    await body(
      await as().post('/ai/connections', {
        name: 'OpenAI',
        provider: 'openai',
        api_key: 'sk-openai-test-000000',
        default_model: 'gpt-5',
      }),
    )
  ).id as string;
  expect(
    (await as().patch('/ai/settings', { images: { connection_id: openai, model: 'gpt-image-1', max_images: 1 } }))
      .status,
  ).toBe(200);
});
afterAll(async () => {
  Object.assign(aiRetryClock, realClock);
  await t.close();
});
beforeEach(() => {
  calls = [];
  script = [];
  waits = [];
  aiRetryClock.sleep = async (ms: number) => {
    waits.push(ms);
  };
  aiRetryClock.random = () => 0.5;
  // No job runner (as without the graphile schema): the designs are made right here, one after the other.
  vi.mocked(enqueueJob).mockReset();
  vi.mocked(enqueueJob).mockResolvedValue(false);
  vi.mocked(jobKeyLive).mockReset();
  vi.mocked(jobKeyLive).mockResolvedValue(false);
});

describe('the retry policy', () => {
  it('reads Retry-After (seconds, a date, retry-after-ms) and tells retryable errors from the others', () => {
    expect(retryAfterOf(new Headers({ 'retry-after': '7' }))).toBe(7000);
    expect(retryAfterOf(new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' }))).toBe(1500);
    const now = Date.parse('2026-02-01T00:00:00Z');
    expect(retryAfterOf(new Headers({ 'retry-after': 'Sun, 01 Feb 2026 00:00:30 GMT' }), now)).toBe(30_000);
    expect(retryAfterOf(new Headers({}))).toBeNull();
    expect(aiRetryReason(new ProviderHttpError(429, null, null, 2000))).toEqual({
      reason: 'rate_limited',
      retryAfterMs: 2000,
    });
    expect(aiRetryReason(new ProviderHttpError(503, null))).toMatchObject({ reason: 'provider_unavailable' });
    expect(aiRetryReason(new ProviderHttpError(408, null))).toMatchObject({ reason: 'timeout' });
    expect(aiRetryReason(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toMatchObject({ reason: 'timeout' });
    expect(aiRetryReason(new TypeError('fetch failed'))).toMatchObject({ reason: 'network' });
    // No credit left / a bad request / a refusal: waiting does not help.
    expect(aiRetryReason(new ProviderHttpError(429, null, 'insufficient_quota'))).toBeNull();
    expect(aiRetryReason(new ProviderHttpError(400, null))).toBeNull();
    expect(aiRetryReason(new Error('ai_content_policy'))).toBeNull();
  });

  it('backs off with doubling waits (jitter around them), honours the provider’s wait up to a cap', async () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(UNIT_RETRY, n, null))).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(retryDelayMs(UNIT_RETRY, 9, null)).toBe(120_000);
    expect(retryDelayMs(UNIT_RETRY, 1, 7000)).toBe(7500);
    expect(retryDelayMs(CALL_RETRY, 1, 10 * 60_000)).toBe(30_500);
    let n = 0;
    const out = await withAiRetry(async () => {
      n += 1;
      if (n < 3) throw new ProviderHttpError(503, null);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(waits).toEqual([2000, 4000]);
    await expect(
      withAiRetry(async () => {
        throw new ProviderHttpError(400, null);
      }),
    ).rejects.toThrow('provider_http_400');
  });
});

describe('a run plans one design per photo × variation and makes them one after the other', () => {
  it('never in the request: one job per design, each made in turn, the next queued after it', async () => {
    const queued: { payload: ImageUnit; opts: Json }[] = [];
    vi.mocked(enqueueJob).mockImplementation(async (_db, task, payload, opts) => {
      if (task !== IMAGE_UNIT_TASK) return false;
      queued.push({ payload: payload as ImageUnit, opts: opts ?? {} });
      return true;
    });
    const b = await newBoard('Queued');
    const col = await aiColumn(b, { variations: 2 });
    const item = await newItem(b.id, 'Dana');
    const p1 = await addImage(item, b.photos, 'p1');
    const p2 = await addImage(item, b.photos, 'p2');
    const out = await run(b, col, [item]);
    // Answered at once: planned, nothing made yet.
    expect(out).toMatchObject({ unit: 'image', status: 'running', total: 4, done: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    let cell = (await cellOf(item, col))!;
    expect(cell.ai.run_id).toBe(out.id);
    expect(cell.ai.outputs.map((o: Json) => [o.source_asset_id, o.variation, o.status])).toEqual([
      [p1, 1, 'pending'],
      [p1, 2, 'pending'],
      [p2, 1, 'pending'],
      [p2, 2, 'pending'],
    ]);
    // One job at a time: the run's key, the account's slot (concurrency 1 → slot 0).
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ run_id: out.id, item_id: item, source: p1, variation: 1 });
    expect(queued[0]!.opts).toMatchObject({ jobKey: `ai.image:${out.id}`, queueName: `ai.images:${acmeId}:0` });

    // Each job makes its design and saves it right away, then queues the next one.
    for (let i = 1; i <= 4; i++) {
      await imageUnitJob(t.deps, queued.shift()!.payload);
      expect(calls).toHaveLength(i);
      expect(await filesOf(item, b.designs)).toHaveLength(i);
      cell = (await cellOf(item, col))!;
      expect(cell.ai.outputs.filter((o: Json) => o.status === 'done')).toHaveLength(i);
      expect(queued).toHaveLength(i < 4 ? 1 : 0);
      expect((await runRow(out.id)).done).toBe(i);
    }
    const row = await runRow(out.id);
    expect(row).toMatchObject({ status: 'done', total: 4, done: 4, failed: 0 });
    expect(row.finishedAt).not.toBeNull();
    expect(row.costUsd).toBeCloseTo(cell.ai.cost_usd, 6);
    expect(cell.ai.calls).toBe(4);
    // Photo by photo, in order.
    expect(calls.map((c) => /#(\w+)#/.exec(c.form!)?.[1])).toEqual(['p1', 'p1', 'p2', 'p2']);
  });

  it('a cell whose designs a live run is making is not planned again (no double charge)', async () => {
    vi.mocked(enqueueJob).mockImplementation(async (_db, task) => task === IMAGE_UNIT_TASK);
    const b = await newBoard('Live');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Eli');
    await addImage(item, b.photos, 'p');
    const first = await run(b, col, [item]);
    expect(first).toMatchObject({ status: 'running', total: 1 });
    vi.mocked(jobKeyLive).mockResolvedValue(true);
    const again = await run(b, col, [item]);
    expect(again).toMatchObject({ total: 1, failed: 1, errors: [{ item_id: item, error: 'ai_run_in_progress' }] });
    expect((await retryMissing(b, col, item)).status).toBe(200);
    expect((await cellOf(item, col))!.ai.run_id).toBe(first.id);
    expect(calls).toHaveLength(0);
  });

  it('images.concurrency spreads an account’s runs over that many queues', async () => {
    const opts: Json[] = [];
    vi.mocked(enqueueJob).mockImplementation(async (_db, task, _payload, o) => {
      if (task === IMAGE_UNIT_TASK) opts.push(o ?? {});
      return task === IMAGE_UNIT_TASK;
    });
    const images = { connection_id: openai, model: 'gpt-image-1', max_images: 1 };
    expect((await as().patch('/ai/settings', { images: { ...images, concurrency: 3 } })).status).toBe(200);
    const b = await newBoard('Concurrency');
    const col = await aiColumn(b, {});
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const item = await newItem(b.id, name);
      await addImage(item, b.photos, name);
      await run(b, col, [item]);
    }
    expect((await as().patch('/ai/settings', { images: { ...images, concurrency: 1 } })).status).toBe(200);
    expect(opts).toHaveLength(5);
    for (const o of opts) expect(o.queueName).toMatch(new RegExp(`^ai\\.images:${acmeId}:[0-2]$`));
  });
});

describe('retries', () => {
  it('429 then success: waits the provider’s Retry-After, tries again, charged once', async () => {
    const b = await newBoard('Rate limit');
    const col = await aiColumn(b, {});
    const one = await newItem(b.id, 'One');
    await addImage(one, b.photos, 'o');
    const before = await imageSpend();
    await run(b, col, [one]);
    const unitCost = (await imageSpend()) - before;
    expect(unitCost).toBeGreaterThan(0);

    const item = await newItem(b.id, 'Gil');
    await addImage(item, b.photos, 'p');
    calls = [];
    script = [{ status: 429, body: { error: { message: 'Rate limit reached' } }, headers: { 'retry-after': '7' } }];
    const spent = await imageSpend();
    const out = await run(b, col, [item]);
    expect(out).toMatchObject({ status: 'done', total: 1, done: 1, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([7500]);
    expect((await imageSpend()) - spent).toBeCloseTo(unitCost, 6);
    expect(out.cost_usd).toBeCloseTo(unitCost, 6);
    expect(statusOf(await cellOf(item, col))).toEqual([['done', null, 2]]);
    expect(await filesOf(item, b.designs)).toHaveLength(1);
  });

  it('queued: a retry waits on the queue (pending, the reason and when), the same design next', async () => {
    const queued: { payload: ImageUnit; opts: Json }[] = [];
    vi.mocked(enqueueJob).mockImplementation(async (_db, task, payload, opts) => {
      if (task !== IMAGE_UNIT_TASK) return false;
      queued.push({ payload: payload as ImageUnit, opts: opts ?? {} });
      return true;
    });
    const b = await newBoard('Queued retry');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Hila');
    await addImage(item, b.photos, 'p');
    await run(b, col, [item]);
    script = [{ status: 503, body: { error: { message: 'Overloaded' } } }];
    const first = queued.shift()!;
    const startedAt = Date.now();
    await imageUnitJob(t.deps, first.payload);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual(first.payload);
    // No Retry-After: the first backoff (10 s, jitter fixed here).
    const at = (queued[0]!.opts.runAt as Date).getTime();
    expect(at - startedAt).toBeGreaterThanOrEqual(9_000);
    expect(at - startedAt).toBeLessThan(12_000);
    const cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs[0]).toMatchObject({ status: 'pending', error: 'provider_unavailable', attempts: 1 });
    expect(cell.ai.outputs[0].retry_at).toBeTruthy();
    await imageUnitJob(t.deps, queued.shift()!.payload);
    expect(statusOf(await cellOf(item, col))).toEqual([['done', null, 2]]);
    expect(waits).toEqual([]);
  });

  it('a provider that stays down: 5 tries over a few minutes, then that design fails with the reason', async () => {
    const b = await newBoard('Down');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Ido');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    script = Array.from({ length: 5 }, () => ({ status: 503, body: { error: { message: 'Overloaded' } } }));
    const spent = await imageSpend();
    const out = await run(b, col, [item]);
    // p1: five calls, then failed; p2: made.
    expect(calls).toHaveLength(6);
    expect(waits).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(out).toMatchObject({ status: 'done', total: 2, done: 1, failed: 1 });
    expect(out.errors).toEqual([{ item_id: item, error: 'provider_unavailable' }]);
    expect(statusOf(await cellOf(item, col))).toEqual([
      ['failed', 'provider_unavailable', 5],
      ['done', null, 1],
    ]);
    // Only the made design was charged.
    expect(out.cost_usd).toBeCloseTo((await imageSpend()) - spent, 6);
  });

  it('a refusal is not tried again: that design fails with the reason, the others are made', async () => {
    const b = await newBoard('Refusal');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Kfir');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    script = [
      { status: 400, body: { error: { message: 'Blocked by the safety system', code: 'content_policy_violation' } } },
    ];
    const out = await run(b, col, [item]);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([]);
    expect(out).toMatchObject({ done: 1, failed: 1 });
    expect(statusOf(await cellOf(item, col))).toEqual([
      ['failed', 'ai_image_content_policy', 1],
      ['done', null, 1],
    ]);
  });
});

describe('the generate_image tool and action (in their own job / request)', () => {
  it('their loop of designs tries a busy provider again instead of stopping part-way', async () => {
    script = [
      { status: 429, body: { error: { message: 'Slow down' } }, headers: { 'retry-after': '1' } },
      { status: 502, body: { error: { message: 'Bad gateway' } } },
    ];
    const made = await generateImageSet(t.deps, acmeId, {
      prompt: 'Two sketches',
      photoMode: 'together',
      variations: 2,
      repeat: true,
    });
    expect(made.stopped).toBeNull();
    expect(made.outputs).toHaveLength(2);
    expect(calls).toHaveLength(4);
    // The same design's tries: the provider's second, then the second (doubled) wait (jitter fixed here).
    expect(waits).toEqual([1500, 4000]);
  });
});

describe('cost limits before every design', () => {
  it('max_usd_per_month: the designs left are marked limit_month_usd, the run stops (limit_column_usd)', async () => {
    const b = await newBoard('Month');
    const col = await aiColumn(b, { variations: 3, max_usd_per_month: 0.01 });
    const item = await newItem(b.id, 'Lior');
    await addImage(item, b.photos, 'p');
    const out = await run(b, col, [item]);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ done: 1, failed: 2, stopped: 'limit_column_usd' });
    expect(statusOf(await cellOf(item, col))).toEqual([
      ['done', null, 1],
      ['failed', 'limit_month_usd', null],
      ['failed', 'limit_month_usd', null],
    ]);
  });
});

describe('complete the missing images', () => {
  it('makes only the failed designs — the made ones are neither made nor charged again', async () => {
    const b = await newBoard('Missing');
    const col = await aiColumn(b, { max_usd_per_run: 0.01 });
    const item = await newItem(b.id, 'Maya');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    await addImage(item, b.photos, 'p3');
    await run(b, col, [item]);
    const made = await filesOf(item, b.designs);
    expect(made).toHaveLength(1);
    const first = (await cellOf(item, col))!;
    expect(statusOf(first).map((s: unknown[]) => s[0])).toEqual(['done', 'failed', 'failed']);

    // The run's limit up, then only the missing two.
    const columns = (await body(await as().get(`/boards/${b.id}`))).columns as Json[];
    const settings = columns.find((c) => c.id === col)!.settings as Json;
    expect(
      (await as().patch(`/boards/${b.id}/columns/${col}`, { settings: { ...settings, max_usd_per_run: 5 } })).status,
    ).toBe(200);
    calls = [];
    const spent = await imageSpend();
    const res = await retryMissing(b, col, item);
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ unit: 'image', status: 'done', total: 2, done: 2, failed: 0 });
    expect(calls.map((c) => /#(\w+)#/.exec(c.form!)?.[1])).toEqual(['p2', 'p3']);
    expect((await imageSpend()) - spent).toBeCloseTo(out.cost_usd, 6);
    const after = (await cellOf(item, col))!;
    expect(statusOf(after).map((s: unknown[]) => s[0])).toEqual(['done', 'done', 'done']);
    // The made design is the same file at the same version.
    expect(after.ai.outputs[0].file_id).toBe(first.ai.outputs[0].file_id);
    expect(after.ai.outputs[0].version).toBeUndefined();
    expect(await filesOf(item, b.designs)).toHaveLength(3);
    // The cell's cost adds up both runs.
    expect(after.ai.cost_usd).toBeCloseTo(first.ai.cost_usd + out.cost_usd, 6);

    // Nothing missing: nothing made.
    calls = [];
    expect(await body(await retryMissing(b, col, item))).toMatchObject({ total: 0, skipped: 1, done: 0 });
    expect(calls).toHaveLength(0);
  });

  it('also from the run endpoint (only_missing) — and a text column has none (422)', async () => {
    const b = await newBoard('Missing run');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Noa');
    await addImage(item, b.photos, 'p');
    script = [{ status: 400, body: { error: { message: 'Invalid size' } } }];
    expect(await run(b, col, [item])).toMatchObject({ done: 0, failed: 1, status: 'failed' });
    expect(statusOf(await cellOf(item, col))).toEqual([['failed', 'ai_image_failed', 1]]);
    expect(await run(b, col, [item], { only_missing: true })).toMatchObject({ done: 1, total: 1 });
    // "Only the missing" rides on the run's mode.
    const modes = (await t.db.select().from(aiColumnRuns).where(eq(aiColumnRuns.boardId, b.id))).map((r) => r.mode);
    expect(modes.sort()).toEqual(['items', 'items:missing']);

    const text = await as().post(`/boards/${b.id}/columns`, {
      title: 'Summary',
      type: 'ai',
      settings: { connection_id: openai, model: 'gpt-5', kind: 'summarize' },
    });
    const textCol = (await body(text)).id as string;
    const res = await retryMissing(b, textCol, item);
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('ai_column_not_image');
  });
});

describe('text output is unchanged', () => {
  it('filled in the request, counted in cells, no queue', async () => {
    const b = await newBoard('Text');
    const res = await as().post(`/boards/${b.id}/columns`, {
      title: 'Summary',
      type: 'ai',
      settings: { connection_id: openai, model: 'gpt-5', kind: 'summarize' },
    });
    const col = (await body(res)).id as string;
    const item = await newItem(b.id, 'Omer');
    const out = await run(b, col, [item]);
    expect(out).toMatchObject({ unit: 'cell', status: 'done', total: 1, done: 1 });
    expect((await cellOf(item, col))!.text).toBe('A short summary');
    expect(vi.mocked(enqueueJob).mock.calls.filter((c) => c[1] === IMAGE_UNIT_TASK)).toEqual([]);
  });
});
