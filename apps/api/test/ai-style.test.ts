// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { asc, eq, sql } from 'drizzle-orm';
import {
  type AiClientFactory,
  createAiClient,
  type FetchLike,
  scriptedAnthropic,
  TINY_PNG_BASE64,
} from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityLog, automationRuns, columns as columnsTable } from '../src/db/schema';
import { clearModelCache } from '../src/modules/ai/models.service';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * Style examples (the product owner's, round 3) against a mocked OpenAI: approved images of OTHER items of the board
 * (a file column + the board filter + the newest N) go first, before the item's own photos, with a line saying they
 * are the style to follow — from filtered items only, the newest N, never the item being processed, sharing the
 * provider's cap ("sent X of Y", examples counted), read with the runner's rights (items / a column they can't read
 * are left out), in the AI column (image and text output), the `generate_image` automation action and the MCP tool;
 * no match = run as before.
 */
let t: TestContext;
let admin: string;
let member: string;
let acmeId: string;
let openai: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const PNG = Buffer.from(TINY_PNG_BASE64, 'base64');
type Call = { url: string; json: Json | null; form: string | null };
let calls: Call[] = [];
const providerFetch: FetchLike = async (url, init) => {
  const reply = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const json = typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : null;
  const form = init.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : null;
  if (url === 'https://api.openai.com/v1/models')
    return reply({ data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }, { id: 'dall-e-2' }] });
  calls.push({ url, json, form });
  if (url === 'https://api.openai.com/v1/images/edits' || url === 'https://api.openai.com/v1/images/generations')
    return reply({ data: [{ b64_json: TINY_PNG_BASE64 }], usage: { input_tokens: 300, output_tokens: 4160 } });
  if (url === 'https://api.openai.com/v1/chat/completions')
    return reply({
      choices: [{ message: { content: 'A bright room with a sofa' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 8 },
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
const as = (cookie = admin) => t.api(cookie, acmeId);

/** A board: Photos (the item's own), Sketches (the AI's output), Approved (style examples), Stage (text). */
const newBoard = async (name: string) => {
  const id = (await body(await as().post('/boards', { name, workspace_id: wsId }))).id as string;
  const col = async (title: string, type: string) =>
    (await body(await as().post(`/boards/${id}/columns`, { title, type }))).id as string;
  return {
    id,
    photos: await col('Photos', 'file'),
    sketches: await col('Sketches', 'file'),
    approved: await col('Approved sketch', 'file'),
    stage: await col('Stage', 'text'),
  };
};
type Board = Awaited<ReturnType<typeof newBoard>>;
const newItem = async (boardId: string, name: string, cookie = admin) =>
  (await body(await as(cookie).post(`/boards/${boardId}/items`, { name }))).id as string;
const setStage = async (b: Board, itemId: string, stage: string, cookie = admin) =>
  expect((await as(cookie).put(`/items/${itemId}/cells/${b.stage}`, { value: stage })).status).toBe(200);
const approvedOnly = (b: Board) => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id: b.stage, operator: 'any_of', values: ['Approved'], negate: false }],
});

/** A PNG told apart by a marker after its end (the type is read from its first bytes). */
const marked = (tag: string) => Buffer.concat([PNG, Buffer.from(`#${tag}#`)]);
let clock = Date.parse('2026-01-01T00:00:00Z');
/** Simulates the browser: presign, "PUT" to storage, complete; then attaches it (each one a second later). */
const addImage = async (itemId: string, columnKey: string, tag: string, cookie = admin) => {
  const data = marked(tag);
  const pre = await body(
    await as(cookie).post('/files/presign', { name: `${tag}.png`, size: data.length, mime: 'image/png' }),
  );
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, data.length, 'image/png', data);
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  expect((await as(cookie).post(`/items/${itemId}/cells/${columnKey}/files`, { file_ids: [pre.file_id] })).status).toBe(
    200,
  );
  // "When it was added" decides the newest: spread them apart (the test runs faster than the clock ticks).
  clock += 1000;
  await t.db.execute(
    sql`update cell_files set created_at = ${new Date(clock).toISOString()}::timestamptz where asset_id = ${pre.file_id}`,
  );
  return pre.file_id as string;
};
const cellOf = async (itemId: string, key: string) =>
  (await body(await as().get(`/items/${itemId}`))).cells[key]?.value as Json | undefined;
const aiColumn = async (boardId: string, settings: Json) => {
  const res = await as().post(`/boards/${boardId}/columns`, { title: 'AI', type: 'ai', settings });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await body(res)).id as string;
};
const run = async (boardId: string, col: string, itemIds: string[], cookie = admin) =>
  body(await as(cookie).post(`/boards/${boardId}/ai-columns/${col}/run`, { mode: 'items', item_ids: itemIds }));
/** A multipart form (read as latin1) as UTF-8 text — the prompt's « » quotes. */
const utf8 = (form: string) => Buffer.from(form, 'latin1').toString('utf8');
/** The image markers of a request, in the order sent. */
const tagsOf = (form: string) => [...form.matchAll(/#(\w+)#/g)].map((m) => m[1]);
const visionTags = (json: Json) => {
  const user = (json.messages as Json[]).find((m) => m.role === 'user')!;
  return (user.content as Json[])
    .filter((c) => c.type === 'image_url')
    .map(
      (c) => /#(\w+)#/.exec(Buffer.from((c.image_url.url as string).split(',')[1]!, 'base64').toString('latin1'))![1],
    );
};

/**
 * The usual scene: approved items A (a1) and B (b1, later b2), a draft C (c1), and the item processed (D: its own
 * approved image d1 and a photo p). Uploaded b1, a1, c1, b2, d1 — so the newest two approved of others are a1, b2.
 */
const scene = async (b: Board) => {
  const A = await newItem(b.id, 'Alpha');
  const B = await newItem(b.id, 'Beta');
  const C = await newItem(b.id, 'Gamma');
  const D = await newItem(b.id, 'Delta');
  for (const x of [A, B, D]) await setStage(b, x, 'Approved');
  await setStage(b, C, 'Draft');
  await addImage(B, b.approved, 'b1');
  await addImage(A, b.approved, 'a1');
  await addImage(C, b.approved, 'c1');
  await addImage(B, b.approved, 'b2');
  await addImage(D, b.approved, 'd1');
  await addImage(D, b.photos, 'p');
  return { A, B, C, D };
};

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
  expect((await as().post('/users/invite', { emails: ['member@acme.test'], role: 'member' })).status).toBeLessThan(300);
  member = await join('member@acme.test');
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
  expect((await as().patch('/ai/settings', { images: { connection_id: openai, model: 'gpt-image-1' } })).status).toBe(
    200,
  );
  const token = (await body(await as().post('/auth/tokens', { name: 'Claude Code', scopes: ['admin'] })))
    .token as string;
  client = new Client({ name: 'style', version: '1.0.0' });
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

const LINE2 = 'Images 1–2 are approved examples of the required style (from «Approved sketch»). Follow their style.';

describe('an AI column with style examples', () => {
  it('image output: the newest N approved images of other items go first, with the line; then the own photo', async () => {
    const b = await newBoard('Style 1');
    const { D } = await scene(b);
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      style_examples: { column: b.approved, filter: approvedOnly(b), count: 2 },
      instructions: 'A sketch of {Name}',
    });
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1 });
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    const form = calls[0]!.form!;
    // Filtered (no c1), newest two (no b1), never the item itself (no d1); examples before the own photo.
    expect(tagsOf(form)).toEqual(['a1', 'b2', 'p']);
    expect(utf8(form)).toContain(`A sketch of Delta\n\n${LINE2}\nImage 3: «Photos».`);
    // Nothing about the other items is said.
    expect(utf8(form)).not.toMatch(/Alpha|Beta|Gamma/);
    expect((await cellOf(D, col))!.ai.source_images).toEqual({ sent: 3, total: 3, examples: 2 });
  });

  it('an example with a newer version is sent at its current version', async () => {
    const b = await newBoard('Style versions');
    const { A, D } = await scene(b);
    const root = ((await cellOf(A, b.approved))!.files as Json[])[0]!.asset_id as string;
    const data = marked('a1v2');
    const pre = await body(await as().post('/files/presign', { name: 'a1.png', size: data.length, mime: 'image/png' }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, data.length, 'image/png', data);
    expect((await as().post(`/files/${pre.file_id}/complete`)).status).toBe(200);
    expect((await as().post(`/files/${root}/versions`, { file_id: pre.file_id })).status).toBe(200);
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      style_examples: { column: b.approved, filter: approvedOnly(b), count: 2 },
      instructions: 'A sketch of {Name}',
    });
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['a1v2', 'b2', 'p']);
  });

  it('a filter that needs the in-memory engine (a formula) chooses the same', async () => {
    const b = await newBoard('Style memory');
    // A formula that is never empty: AND-ing it forces the in-memory path without changing the result.
    const calc = (
      await body(
        await as().post(`/boards/${b.id}/columns`, { title: 'calc', type: 'formula', settings: { formula: '1' } }),
      )
    ).id as string;
    const { D } = await scene(b);
    const filter = approvedOnly(b);
    filter.rules.push({ kind: 'rule', column_id: calc, operator: 'is_not_empty', values: [], negate: false });
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      style_examples: { column: b.approved, filter, count: 2 },
      instructions: 'A sketch',
    });
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['a1', 'b2', 'p']);
  });

  it('no filter = any item with an image there; the default count is 3', async () => {
    const b = await newBoard('Style 2');
    const { D } = await scene(b);
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      style_examples: { column: b.approved },
      instructions: 'A sketch',
    });
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['a1', 'c1', 'b2']);
    expect(utf8(calls[0]!.form!)).toContain(
      'Images 1–3 are approved examples of the required style (from «Approved sketch»). Follow their style.',
    );
    expect((await cellOf(D, col))!.ai.source_images).toEqual({ sent: 3, total: 3, examples: 3 });
  });

  it("the provider's cap: examples first, the item's photos fill the rest — sent X of Y counts both", async () => {
    const b = await newBoard('Style cap');
    const { D } = await scene(b);
    await addImage(D, b.photos, 'q');
    // DALL·E 2 edits one picture: the newest example takes it.
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'dall-e-2',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      photo_mode: 'together',
      style_examples: { column: b.approved, filter: approvedOnly(b), count: 2 },
      instructions: 'A sketch',
    });
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['b2']);
    expect(utf8(calls[0]!.form!)).toContain(
      'Image 1 is an approved example of the required style (from «Approved sketch»). Follow its style.',
    );
    expect((await cellOf(D, col))!.ai.source_images).toEqual({ sent: 1, total: 4, examples: 1 });
  });

  it('text output (vision): the examples are the first image blocks, the line in the text', async () => {
    const b = await newBoard('Style text');
    const { D } = await scene(b);
    const col = await aiColumn(b.id, {
      kind: 'custom',
      connection_id: openai,
      model: 'gpt-5',
      instructions: 'Describe the room',
      source_image_columns: [b.photos],
      style_examples: { column: b.approved, filter: approvedOnly(b), count: 2 },
    });
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1 });
    expect(visionTags(calls[0]!.json!)).toEqual(['a1', 'b2', 'p']);
    const user = (calls[0]!.json!.messages as Json[]).find((m) => m.role === 'user')!;
    const text = (user.content as Json[]).find((c) => c.type === 'text')!.text as string;
    expect(text).toContain(`${LINE2}\nImage 3: «Photos».`);
    expect((await cellOf(D, col))!.ai.source_images).toEqual({ sent: 3, total: 3, examples: 2 });
  });

  it('no example matches: runs as before (no error, nothing recorded about examples)', async () => {
    const b = await newBoard('Style none');
    const { D } = await scene(b);
    const none = {
      kind: 'group',
      operator: 'and',
      negate: false,
      rules: [{ kind: 'rule', column_id: b.stage, operator: 'any_of', values: ['Published'], negate: false }],
    };
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      style_examples: { column: b.approved, filter: none, count: 3 },
      instructions: 'A sketch',
    });
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1, errors: [] });
    expect(tagsOf(calls[0]!.form!)).toEqual(['p']);
    expect(utf8(calls[0]!.form!)).not.toContain('approved example');
    expect((await cellOf(D, col))!.ai.source_images).toEqual({ sent: 1, total: 1 });
    // No own source either: a plain text-to-image call.
    calls = [];
    const bare = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      style_examples: { column: b.approved, filter: none, count: 3 },
      instructions: 'A sketch',
    });
    expect(await run(b.id, bare, [D])).toMatchObject({ done: 1 });
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/generations']);
    expect((await cellOf(D, bare))!.ai.source_images).toBeUndefined();
  });

  it('a missing column / a filter on a missing column fail the cell with a reason, nothing spent', async () => {
    const b = await newBoard('Style broken');
    const { D } = await scene(b);
    const ghost = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      style_examples: { column: b.stage, count: 3 },
      instructions: 'A sketch',
    });
    expect(await run(b.id, ghost, [D])).toMatchObject({
      done: 0,
      errors: [{ item_id: D, error: 'style_column_unavailable' }],
    });
    const badFilter = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      style_examples: {
        column: b.approved,
        filter: {
          kind: 'group',
          operator: 'and',
          negate: false,
          rules: [{ kind: 'rule', column_id: 'gone_col', operator: 'is_not_empty', values: [], negate: false }],
        },
      },
      instructions: 'A sketch',
    });
    expect(await run(b.id, badFilter, [D])).toMatchObject({
      done: 0,
      errors: [{ item_id: D, error: 'style_filter_invalid' }],
    });
    expect(calls).toHaveLength(0);
  });
});

describe("style examples are read with the runner's rights", () => {
  it("a member's run: items they can't see and a column hidden from them are left out silently", async () => {
    const b = await newBoard('Style own items');
    expect(
      (await as().put(`/boards/${b.id}/permissions`, { view_items: { mode: 'assigned_or_created' } })).status,
    ).toBeLessThan(300);
    // The admin's approved items (hidden from the member).
    const A = await newItem(b.id, 'Secret Alpha');
    await setStage(b, A, 'Approved');
    await addImage(A, b.approved, 'a1');
    // The member's own approved item and the one they run.
    const M = await newItem(b.id, 'Mine', member);
    await setStage(b, M, 'Approved', member);
    await addImage(M, b.approved, 'm1', member);
    const D = await newItem(b.id, 'Mine 2', member);
    await addImage(D, b.photos, 'p', member);
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      style_examples: { column: b.approved, filter: approvedOnly(b), count: 3 },
      instructions: 'A sketch',
    });
    expect(await run(b.id, col, [D], member)).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['m1', 'p']);
    expect(utf8(calls[0]!.form!)).not.toContain('Secret');
    expect(utf8(calls[0]!.form!)).toContain('Image 1 is an approved example');
    // The admin sees both.
    calls = [];
    expect(await run(b.id, col, [D])).toMatchObject({ done: 1 });
    expect(tagsOf(calls[0]!.form!)).toEqual(['a1', 'm1', 'p']);

    // The examples column hidden from the member: none for them (no error), the admin still gets them.
    await t.db
      .update(columnsTable)
      .set({ restrictedView: { users: [], teams: [] } })
      .where(sql`board_id = ${b.id} and key = ${b.approved}`);
    calls = [];
    expect(await run(b.id, col, [D], member)).toMatchObject({ done: 1, errors: [] });
    expect(tagsOf(calls[0]!.form!)).toEqual(['p']);
    expect(utf8(calls[0]!.form!)).not.toContain('approved example');
  });
});

describe('the generate_image automation action with style_examples', () => {
  it('as the owner: the newest approved images of other items first, then the photo', async () => {
    const b = await newBoard('Style auto');
    const res = await as().post(`/boards/${b.id}/automations`, {
      recipe: {
        trigger: { type: 'file_added', column: b.photos },
        actions: [
          {
            type: 'generate_image',
            column: b.sketches,
            source_columns: [b.photos],
            style_examples: { column: b.approved, filter: approvedOnly(b), count: 2 },
            prompt: 'A sketch of {item.name}',
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const automationId = (await body(res)).id as string;
    await scene(b);
    await drain();
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    expect(tagsOf(calls[0]!.form!)).toEqual(['a1', 'b2', 'p']);
    expect(utf8(calls[0]!.form!)).toContain(`A sketch of Delta\n\n${LINE2}\nImage 3: «Photos».`);
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
    expect((runs[0]!.actionsLog as Json[])[0]).toMatchObject({
      type: 'generate_image',
      status: 'ok',
      output: { source_images: { sent: 3, total: 3, examples: 2 } },
    });
    await as().patch(`/automations/${automationId}`, { is_active: false });
  });

  it('refuses a style column that is not a file column', async () => {
    const b = await newBoard('Style auto bad');
    const res = await as().post(`/boards/${b.id}/automations`, {
      recipe: {
        trigger: { type: 'file_added', column: b.photos },
        actions: [{ type: 'generate_image', column: b.sketches, style_examples: { column: b.stage }, prompt: 'x' }],
      },
    });
    expect(res.status).toBe(422);
  });
});

describe('the generate_image tool with style examples (MCP)', () => {
  it('style_column_id + style_filter + style_count', async () => {
    const b = await newBoard('Style tool');
    const { D } = await scene(b);
    const r = await call('generate_image', {
      item_id: D,
      prompt: 'A sketch',
      column_id: b.sketches,
      source_column_ids: [b.photos],
      style_column_id: b.approved,
      style_filter: {
        operator: 'and',
        rules: [{ column_id: b.stage, operator: 'any_of', values: ['Approved'] }],
      },
      style_count: 2,
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(tagsOf(calls[0]!.form!)).toEqual(['a1', 'b2', 'p']);
    expect(utf8(calls[0]!.form!)).toContain(`A sketch\n\n${LINE2}\nImage 3: «Photos».`);

    // Without a filter (default count 3) and without own photos.
    calls = [];
    const r2 = await call('generate_image', {
      item_id: D,
      prompt: 'Again',
      column_id: b.sketches,
      style_column_id: b.approved,
    });
    expect(r2.isError, JSON.stringify(r2.data)).toBe(false);
    expect(tagsOf(calls[0]!.form!)).toEqual(['a1', 'c1', 'b2']);

    // A column that is not a file column.
    const r3 = await call('generate_image', {
      item_id: D,
      prompt: 'x',
      column_id: b.sketches,
      style_column_id: b.stage,
    });
    expect(r3.error).toMatchObject({ message: 'ai_style_column_unavailable' });
  });
});
