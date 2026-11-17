// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  type AiClientFactory,
  createAiClient,
  type FetchLike,
  scriptedAnthropic,
  TINY_PNG_BASE64,
} from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityLog, aiColumnRuns, automationRuns, trashEntries } from '../src/db/schema';
import {
  FIDELITY_CLOSE_LINE,
  FIDELITY_LOCKED_LINE,
  FIDELITY_LOCKED_NO_PHOTO_LINE,
} from '../src/modules/ai/images.service';
import { clearModelCache } from '../src/modules/ai/models.service';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * AI photos round 4 (the product owner's) against a mocked OpenAI that makes as many images as asked (`n`): one
 * design per photo (`each`) or one from all (`together`), variations (the provider's `n`, else repeated calls), a
 * re-run as a new VERSION of the design for the same photo + variation (history kept) or another design (column
 * setting and the run-time `on_existing`), fidelity close / locked (the base first, the swap-the-figure line, the
 * fallback to close with a note), rejecting a design (to the trash, marked, a later run makes a new file — also when
 * removed from the files column itself), and the run / account limits checked between a cell's calls.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let openai: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const PNG = Buffer.from(TINY_PNG_BASE64, 'base64');
type Call = { url: string; json: Json | null; form: string | null; n: number };
let calls: Call[] = [];
const providerFetch: FetchLike = async (url, init) => {
  const reply = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const json = typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : null;
  const form = init.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : null;
  if (url === 'https://api.openai.com/v1/models') return reply({ data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }] });
  const n = Number(json?.n ?? /name="n"\r\n\r\n(\d+)/.exec(form ?? '')?.[1] ?? 1);
  calls.push({ url, json, form, n });
  if (url === 'https://api.openai.com/v1/images/edits' || url === 'https://api.openai.com/v1/images/generations')
    return reply({
      data: Array.from({ length: n }, () => ({ b64_json: TINY_PNG_BASE64 })),
      usage: { input_tokens: 300, output_tokens: 4160 },
    });
  return reply({ error: { message: 'not found' } }, 404);
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

/** A board: Photos (the item's), Designs (the AI's output), Base (the approved sketch), Approved (style examples). */
const newBoard = async (name: string) => {
  const id = (await body(await as().post('/boards', { name, workspace_id: wsId }))).id as string;
  const col = async (title: string) =>
    (await body(await as().post(`/boards/${id}/columns`, { title, type: 'file' }))).id as string;
  return { id, photos: await col('Photos'), designs: await col('Designs'), base: await col('Base') };
};
type Board = Awaited<ReturnType<typeof newBoard>>;
const newItem = async (boardId: string, name: string) =>
  (await body(await as().post(`/boards/${boardId}/items`, { name }))).id as string;
const marked = (tag: string) => Buffer.concat([PNG, Buffer.from(`#${tag}#`)]);
let clock = Date.parse('2026-01-01T00:00:00Z');
/** Upload + attach (each a second later, so "newest" is well defined). */
const addImage = async (itemId: string, columnKey: string, tag: string) => {
  const data = marked(tag);
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
const versionsOf = async (fileId: string) =>
  ((await body(await as().get(`/files/${fileId}/versions`))).data as Json[]).map((v) => v.version as number);
const tagsOf = (form: string) => [...form.matchAll(/#(\w+)#/g)].map((m) => m[1]);
const utf8 = (form: string) => Buffer.from(form, 'latin1').toString('utf8');
const setMaxImages = async (n: number) =>
  expect(
    (await as().patch('/ai/settings', { images: { connection_id: openai, model: 'gpt-image-1', max_images: n } }))
      .status,
  ).toBe(200);

const seen = new Set<string>();
const drain = async () => {
  const rows = await t.db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(eq(activityLog.accountId, acmeId))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
  }
};

const fetchApp = (url: string | URL | Request, init?: RequestInit) =>
  t.app.request(url instanceof Request ? url : String(url), init) as Promise<Response>;
let client: Client;
const call = async (name: string, args: Json) => {
  const res = (await client.callTool({ name, arguments: args })) as Json;
  const parsed = JSON.parse(res.content?.[0]?.text ?? '{}') as Json;
  return { isError: !!res.isError, data: parsed, error: parsed.error as Json | undefined };
};

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
  await setMaxImages(1);
  const token = (await body(await as().post('/auth/tokens', { name: 'Claude Code', scopes: ['admin'] })))
    .token as string;
  client = new Client({ name: 'round4', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${WEB_ORIGIN}/mcp`), {
      fetch: fetchApp,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
});
afterAll(async () => {
  await client?.close();
  await t.close();
});
beforeEach(() => {
  calls = [];
});

describe('several photos: each separately or all together', () => {
  it('each (the default of a new column): one call per photo, one design each, recorded with its photo', async () => {
    const b = await newBoard('Each');
    const col = await aiColumn(b, {});
    const settings = (await body(await as().get(`/boards/${b.id}`))).columns.find((c: Json) => c.id === col).settings;
    expect(settings).toMatchObject({ photo_mode: 'each', variations: 1, image_on_rerun: 'version', fidelity: 'free' });
    const item = await newItem(b.id, 'Dana');
    const p1 = await addImage(item, b.photos, 'p1');
    const p2 = await addImage(item, b.photos, 'p2');
    const out = await run(b, col, [item]);
    // The images queue: the run counts designs (two photos = two designs, one job each).
    expect(out).toMatchObject({ unit: 'image', status: 'done', total: 2, done: 2, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => tagsOf(c.form!))).toEqual([['p1'], ['p2']]);
    const designs = await filesOf(item, b.designs);
    expect(designs).toHaveLength(2);
    const cell = (await cellOf(item, col))!;
    expect(cell.file_id).toBe(designs[0]);
    expect(cell.ai).toMatchObject({ output: 'image', calls: 2, source_images: { sent: 2, total: 2 } });
    expect(cell.ai.outputs).toEqual([
      expect.objectContaining({ file_id: designs[0], source_asset_id: p1, variation: 1, status: 'done', attempts: 1 }),
      expect.objectContaining({ file_id: designs[1], source_asset_id: p2, variation: 1, status: 'done', attempts: 1 }),
    ]);
    expect(cell.ai.outputs[0].source_images).toEqual({ sent: 1, total: 1 });
    // Both calls priced: the run's cost is their sum.
    expect(out.cost_usd).toBeCloseTo(cell.ai.cost_usd, 6);
  });

  it('together: one call with every photo, one design (as rounds 2–3)', async () => {
    const b = await newBoard('Together');
    const col = await aiColumn(b, { photo_mode: 'together' });
    const item = await newItem(b.id, 'Eli');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    expect(await run(b, col, [item])).toMatchObject({ done: 1 });
    expect(calls).toHaveLength(1);
    expect(tagsOf(calls[0]!.form!)).toEqual(['p1', 'p2']);
    const cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs).toEqual([expect.objectContaining({ source_asset_id: null, variation: 1 })]);
    expect(cell.ai.calls).toBeUndefined();
  });

  it('a column saved before round 4 (image_on_rerun, no photo_mode) keeps sending its photos together', async () => {
    const b = await newBoard('Old column');
    const col = await aiColumn(b, { image_on_rerun: 'add' });
    const item = await newItem(b.id, 'Old');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    expect(await run(b, col, [item])).toMatchObject({ done: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe('variations', () => {
  it('each variation is its own design (its own call, one after the other), whatever the per-call cap', async () => {
    const b = await newBoard('Variations');
    const col = await aiColumn(b, { variations: 3 });
    const item = await newItem(b.id, 'Gil');
    const p = await addImage(item, b.photos, 'p');
    // Three designs: three calls of one image.
    expect(await run(b, col, [item])).toMatchObject({ total: 3, done: 3 });
    expect(calls.map((c) => c.n)).toEqual([1, 1, 1]);
    let cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs.map((o: Json) => [o.source_asset_id, o.variation])).toEqual([
      [p, 1],
      [p, 2],
      [p, 3],
    ]);
    expect(await filesOf(item, b.designs)).toHaveLength(3);

    // Four per call allowed: still one design per call (each its own job, retried on its own); another design each.
    calls = [];
    await setMaxImages(4);
    expect(await run(b, col, [item], { on_existing: 'add' })).toMatchObject({ done: 3 });
    expect(calls.map((c) => c.n)).toEqual([1, 1, 1]);
    cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs).toHaveLength(3);
    expect(cell.ai.calls).toBe(3);
    expect(await filesOf(item, b.designs)).toHaveLength(6);
    await setMaxImages(1);
  });
});

describe('re-run: a new version of the design, or another design', () => {
  it('version (default): the same file per photo + variation gets version 2; the history is kept', async () => {
    const b = await newBoard('Versions');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Hila');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    await run(b, col, [item]);
    const first = await filesOf(item, b.designs);
    expect(first).toHaveLength(2);
    await run(b, col, [item]);
    expect(await filesOf(item, b.designs)).toEqual(first);
    for (const f of first) expect(await versionsOf(f)).toEqual([2, 1]);
    const cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs.map((o: Json) => [o.file_id, o.version])).toEqual([
      [first[0], 2],
      [first[1], 2],
    ]);
    // A version-added event in the run's batch, marked as AI.
    const events = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'file.version_added')));
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('the run-time choice overrides the column: on_existing add on a version column, version on an add column', async () => {
    const b = await newBoard('Choice');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Ido');
    await addImage(item, b.photos, 'p');
    await run(b, col, [item]);
    const [design] = await filesOf(item, b.designs);
    const r = await run(b, col, [item], { on_existing: 'add' });
    expect(r).toMatchObject({ done: 1 });
    const after = await filesOf(item, b.designs);
    expect(after).toHaveLength(2);
    expect(await versionsOf(design!)).toEqual([1]);
    // The choice rides on the run (also for a queued run).
    const row = (
      await t.db
        .select()
        .from(aiColumnRuns)
        .where(eq(aiColumnRuns.id, r.id as string))
    )[0]!;
    expect(row.mode).toBe('items:add');

    const addCol = await aiColumn(b, { image_on_rerun: 'add', photo_mode: 'each' });
    await run(b, addCol, [item]);
    const made = (await cellOf(item, addCol))!.file_id as string;
    await run(b, addCol, [item], { on_existing: 'version' });
    expect((await cellOf(item, addCol))!.file_id).toBe(made);
    expect(await versionsOf(made)).toEqual([2, 1]);
  });
});

describe('fidelity', () => {
  it('close: the line to keep the composition and colours of the starting picture', async () => {
    const b = await newBoard('Close');
    const col = await aiColumn(b, { fidelity: 'close' });
    const item = await newItem(b.id, 'Kfir');
    await addImage(item, b.photos, 'p');
    await run(b, col, [item]);
    expect(utf8(calls[0]!.form!)).toContain(FIDELITY_CLOSE_LINE);
  });

  it('locked: the base column’s newest image first, then the photo, with the swap-the-figure line', async () => {
    const b = await newBoard('Locked');
    const col = await aiColumn(b, { fidelity: 'locked', fidelity_base_column: b.base });
    const item = await newItem(b.id, 'Lior');
    await addImage(item, b.base, 'old');
    await addImage(item, b.base, 'base');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    expect(await run(b, col, [item])).toMatchObject({ done: 2 });
    // Each photo: the base first, then that photo.
    expect(calls.map((c) => tagsOf(c.form!))).toEqual([
      ['base', 'p1'],
      ['base', 'p2'],
    ]);
    const prompt = utf8(calls[0]!.form!);
    expect(prompt).toContain('Image 1: the approved base design (from «Base»). Image 2: the reference photo.');
    expect(prompt).toContain(FIDELITY_LOCKED_LINE);
    const cell = (await cellOf(item, col))!;
    expect(cell.ai.note).toBeUndefined();
    expect(cell.ai.outputs[0].source_images).toEqual({ sent: 2, total: 2 });
  });

  it('locked without a base column: the newest style example is the base (no other example goes)', async () => {
    const b = await newBoard('Locked style');
    const col = await aiColumn(b, { fidelity: 'locked', style_examples: { column: b.base, count: 3 } });
    const other = await newItem(b.id, 'Other');
    await addImage(other, b.base, 's1');
    await addImage(other, b.base, 's2');
    const item = await newItem(b.id, 'Maya');
    await addImage(item, b.photos, 'p');
    expect(await run(b, col, [item])).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['s2', 'p']);
    expect(utf8(calls[0]!.form!)).toContain(FIDELITY_LOCKED_LINE);
  });

  it('locked with a base but no photo: keep the base, change only what the description asks', async () => {
    const b = await newBoard('Locked no photo');
    const col = await aiColumn(b, { fidelity: 'locked', fidelity_base_column: b.base });
    const item = await newItem(b.id, 'Noa');
    await addImage(item, b.base, 'base');
    expect(await run(b, col, [item])).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['base']);
    expect(utf8(calls[0]!.form!)).toContain(FIDELITY_LOCKED_NO_PHOTO_LINE);
  });

  it('locked with no base anywhere: made as close, with a note on the cell (no error)', async () => {
    const b = await newBoard('Locked none');
    const col = await aiColumn(b, { fidelity: 'locked', fidelity_base_column: b.base });
    const item = await newItem(b.id, 'Omer');
    await addImage(item, b.photos, 'p');
    expect(await run(b, col, [item])).toMatchObject({ done: 1, failed: 0 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['p']);
    expect(utf8(calls[0]!.form!)).toContain(FIDELITY_CLOSE_LINE);
    expect((await cellOf(item, col))!.ai.note).toBe('fidelity_no_base');
  });
});

describe('rejecting a design', () => {
  it('✕ on the AI cell: the file goes to the trash, the design is marked rejected, the next run makes a new file', async () => {
    const b = await newBoard('Reject');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Paz');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    await run(b, col, [item]);
    const [d1, d2] = await filesOf(item, b.designs);
    const res = await as().post(`/boards/${b.id}/ai-columns/${col}/items/${item}/outputs/${d1}/reject`, {});
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ item_id: item, file_id: d1, rejected: true });
    expect(await filesOf(item, b.designs)).toEqual([d2]);
    const trash = await t.db.select().from(trashEntries).where(eq(trashEntries.objectId, d1!));
    expect(trash).toHaveLength(1);
    let cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs.map((o: Json) => [o.file_id, o.rejected ?? false])).toEqual([
      [d1, true],
      [d2, false],
    ]);
    // Not a design of this cell: 404.
    expect((await as().post(`/boards/${b.id}/ai-columns/${col}/items/${item}/outputs/${d2}x/reject`, {})).status).toBe(
      404,
    );

    // The next run: a new file for the rejected photo, a new version of the other.
    await run(b, col, [item]);
    const after = await filesOf(item, b.designs);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(d2);
    expect(after[1]).not.toBe(d1);
    expect(await versionsOf(d2!)).toEqual([2, 1]);
    expect(await versionsOf(after[1]!)).toEqual([1]);
    cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs.every((o: Json) => !o.rejected)).toBe(true);
  });

  it('removing an AI-made file from the output files column itself works and marks it rejected', async () => {
    const b = await newBoard('Reject from column');
    const col = await aiColumn(b, {});
    const item = await newItem(b.id, 'Ran');
    await addImage(item, b.photos, 'p');
    await run(b, col, [item]);
    const [d] = await filesOf(item, b.designs);
    expect((await as().del(`/items/${item}/cells/${b.designs}/files/${d}`)).status).toBe(200);
    expect(await filesOf(item, b.designs)).toEqual([]);
    expect((await cellOf(item, col))!.ai.outputs[0]).toMatchObject({ file_id: d, rejected: true });
    // The next run makes a new design (it never versions a removed one).
    await run(b, col, [item]);
    const after = await filesOf(item, b.designs);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(d);
  });
});

describe('limits before every design', () => {
  it('max_usd_per_run: the first design is kept, the designs left are marked failed (limit_run_usd)', async () => {
    const b = await newBoard('Run limit');
    const col = await aiColumn(b, { max_usd_per_run: 0.01 });
    const item = await newItem(b.id, 'Shir');
    const p1 = await addImage(item, b.photos, 'p1');
    const p2 = await addImage(item, b.photos, 'p2');
    await addImage(item, b.photos, 'p3');
    const second = await newItem(b.id, 'Tal');
    const q = await addImage(second, b.photos, 'q');
    const out = await run(b, col, [item, second]);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ total: 4, done: 1, failed: 3, stopped: 'limit_run_usd', status: 'done' });
    const cell = (await cellOf(item, col))!;
    expect(cell.ai.outputs).toEqual([
      expect.objectContaining({ source_asset_id: p1, status: 'done' }),
      expect.objectContaining({ source_asset_id: p2, status: 'failed', error: 'limit_run_usd' }),
      expect.objectContaining({ status: 'failed', error: 'limit_run_usd' }),
    ]);
    // Not silently dropped: the other item says so too (nothing made, nothing charged).
    expect((await cellOf(second, col))!.ai.outputs).toEqual([
      expect.objectContaining({ source_asset_id: q, status: 'failed', error: 'limit_run_usd' }),
    ]);
    expect(await filesOf(second, b.designs)).toEqual([]);
  });

  it("the account's AI budget: a later call is refused, what was made is kept, the run stops", async () => {
    const b = await newBoard('Budget');
    const col = await aiColumn(b, { variations: 3 });
    const item = await newItem(b.id, 'Uri');
    await addImage(item, b.photos, 'p');
    const status = await body(await as().get('/ai/settings'));
    const spentSoFar = (
      await t.db.execute<{ s: number }>(
        sql`select coalesce(sum(cost_usd), 0)::float as s from ai_usage where account_id = ${acmeId}`,
      )
    ).rows[0]!.s;
    expect(status).toBeTruthy();
    expect((await as().patch('/ai/settings', { monthly_budget_usd: spentSoFar + 0.01 })).status).toBe(200);
    const out = await run(b, col, [item]);
    expect((await as().patch('/ai/settings', { monthly_budget_usd: null })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ done: 1, failed: 2, stopped: 'ai_budget_exceeded' });
    expect((await cellOf(item, col))!.ai.outputs.map((o: Json) => [o.status, o.error ?? null])).toEqual([
      ['done', null],
      ['failed', 'ai_budget_exceeded'],
      ['failed', 'ai_budget_exceeded'],
    ]);
  });
});

describe('the generate_image tool and action', () => {
  it('MCP: photo_mode each makes one image per photo; fidelity locked sends the base first', async () => {
    const b = await newBoard('Tool');
    const item = await newItem(b.id, 'Vered');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    await addImage(item, b.base, 'base');
    const r = await call('generate_image', {
      item_id: item,
      prompt: 'A sketch',
      column_id: b.designs,
      source_column_ids: [b.photos],
      photo_mode: 'each',
      fidelity: 'locked',
      fidelity_base_column_id: b.base,
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(calls.map((c) => tagsOf(c.form!))).toEqual([
      ['base', 'p1'],
      ['base', 'p2'],
    ]);
    expect(r.data.files).toHaveLength(2);
    expect(await filesOf(item, b.designs)).toHaveLength(2);
  });

  it('the automation action: each photo, two variations', async () => {
    const b = await newBoard('Action');
    const res = await as().post(`/boards/${b.id}/automations`, {
      recipe: {
        trigger: { type: 'file_added', column: b.base },
        actions: [
          {
            type: 'generate_image',
            column: b.designs,
            source_columns: [b.photos],
            photo_mode: 'each',
            variations: 2,
            prompt: 'A render of {item.name}',
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const automationId = (await body(res)).id as string;
    const item = await newItem(b.id, 'Yael');
    await addImage(item, b.photos, 'p1');
    await addImage(item, b.photos, 'p2');
    await drain();
    calls = [];
    await addImage(item, b.base, 'go');
    await drain();
    // Two photos × two variations, one image per call (the account's per-call cap).
    expect(calls.map((c) => tagsOf(c.form!))).toEqual([['p1'], ['p1'], ['p2'], ['p2']]);
    expect(await filesOf(item, b.designs)).toHaveLength(4);
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
    expect((runs[0]!.actionsLog as Json[])[0]).toMatchObject({ type: 'generate_image', status: 'ok' });
    await as().patch(`/automations/${automationId}`, { is_active: false });
  });
});
