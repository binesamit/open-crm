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
import { activityLog, aiColumnPending, aiUsage, automationRuns } from '../src/db/schema';
import { clearModelCache } from '../src/modules/ai/models.service';
import { runDueAutoCells } from '../src/modules/ai2/columns.service';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * Photos as input (the product owner's) against a mocked OpenAI (no network, no money): an AI column that designs
 * from the item's newest photo of a file column (`/images/edits`, the photo's bytes from storage), the "no source
 * image" state (no call, no charge), replace / add on a re-run (never a file a person added), text from a photo
 * (vision models only), auto-run when a person adds a photo, the `file_added` automation trigger with
 * `generate_image` from a photo, and the `generate_image` tool's source file / column. Round 2: no photo = from the
 * description (default) or skip, several source columns in order with a line naming them, every photo up to the
 * provider's limit ("sent X of Y"), the old single-column keys still read.
 */
let t: TestContext;
let admin: string;
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
    return reply({ data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }] });
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
const as = () => t.api(admin, acmeId);

/** A board with a photos column and a sketches column. */
const newBoard = async (name: string) => {
  const id = (await body(await as().post('/boards', { name, workspace_id: wsId }))).id as string;
  const photos = (await body(await as().post(`/boards/${id}/columns`, { title: 'Photos', type: 'file' }))).id as string;
  const sketches = (await body(await as().post(`/boards/${id}/columns`, { title: 'Sketches', type: 'file' })))
    .id as string;
  return { id, photos, sketches };
};
const addFileColumn = async (boardId: string, title: string) =>
  (await body(await as().post(`/boards/${boardId}/columns`, { title, type: 'file' }))).id as string;
const newItem = async (boardId: string, name: string) =>
  (await body(await as().post(`/boards/${boardId}/items`, { name }))).id as string;

/** A PNG told apart by a marker after its end (the type is read from its first bytes). */
const marked = (tag: string) => Buffer.concat([PNG, Buffer.from(`#${tag}#`)]);
/** Simulates the browser: presign, "PUT" to storage (the bytes), complete. */
const upload = async (name: string, data: Buffer = PNG, mime = 'image/png') => {
  const pre = await body(await as().post('/files/presign', { name, size: data.length, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, data.length, mime, data);
  expect((await as().post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};
const attach = async (itemId: string, columnKey: string, fileId: string) =>
  expect((await as().post(`/items/${itemId}/cells/${columnKey}/files`, { file_ids: [fileId] })).status).toBe(200);
const filesOf = async (itemId: string, key: string) =>
  ((await body(await as().get(`/items/${itemId}`))).cells[key]?.value?.files ?? []) as Json[];
const cellOf = async (itemId: string, key: string) =>
  (await body(await as().get(`/items/${itemId}`))).cells[key]?.value as Json | undefined;
const aiColumn = async (boardId: string, settings: Json) => {
  const res = await as().post(`/boards/${boardId}/columns`, { title: 'AI', type: 'ai', settings });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await body(res)).id as string;
};
const run = async (boardId: string, col: string, itemIds: string[]) =>
  body(await as().post(`/boards/${boardId}/ai-columns/${col}/run`, { mode: 'items', item_ids: itemIds }));
const usageRows = async () => (await t.db.select().from(aiUsage).where(eq(aiUsage.accountId, acmeId))).length;
/** The account's AI spend so far (usage rows add up per day, connection and model). */
const spent = async () =>
  (await t.db.select().from(aiUsage).where(eq(aiUsage.accountId, acmeId))).reduce((n, r) => n + Number(r.costUsd), 0);
/** A multipart form (read as latin1) as UTF-8 text — the prompt's « » quotes. */
const utf8 = (form: string) => Buffer.from(form, 'latin1').toString('utf8');

const seen = new Set<string>();
/** Every new activity row → the dispatcher (AI auto-run, automations), and the automation runs it caused. */
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

// MCP: an SDK client on the in-process app.
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
        // A text model that does not see images (an admin's correction).
        manual_models: [{ id: 'gpt-blind', capabilities: { vision: false } }],
      }),
    )
  ).id as string;
  expect((await as().patch('/ai/settings', { images: { connection_id: openai, model: 'gpt-image-1' } })).status).toBe(
    200,
  );
  const token = (await body(await as().post('/auth/tokens', { name: 'Claude Code', scopes: ['admin'] })))
    .token as string;
  client = new Client({ name: 'photos', version: '1.0.0' });
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

describe('an AI column that designs from a photo', () => {
  it('sends the newest photo of the source column to /images/edits; no photo + skip = not run, not charged', async () => {
    const b = await newBoard('Rooms');
    // Saved with the first version's single key: read as a list of one.
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_column: b.photos,
      source_image_count: 1,
      when_no_source_image: 'skip',
      instructions: 'A pencil sketch of {Name}',
    });
    const empty = await newItem(b.id, 'Kitchen');
    const usage = await usageRows();
    const none = await run(b.id, col, [empty]);
    expect(none).toMatchObject({
      done: 0,
      failed: 1,
      cost_usd: 0,
      errors: [{ item_id: empty, error: 'no_source_image' }],
    });
    expect(calls).toHaveLength(0);
    expect(await usageRows()).toBe(usage);

    const item = await newItem(b.id, 'Living room');
    // An older photo and a PDF: only the newest image goes.
    await attach(item, b.photos, await upload('old.png'));
    await attach(item, b.photos, await upload('plan.pdf', Buffer.from('%PDF-1.4'), 'application/pdf'));
    await attach(item, b.photos, await upload('new.png'));
    const out = await run(b.id, col, [item]);
    expect(out, JSON.stringify(out)).toMatchObject({ done: 1, failed: 0 });
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    const form = calls[0]!.form!;
    expect(form).toContain('name="prompt"\r\n\r\nA pencil sketch of Living room\r\n');
    expect(form.match(/name="image"; filename=/g)).toHaveLength(1);
    expect(form).toContain(PNG.toString('latin1'));
    const sketches = await filesOf(item, b.sketches);
    expect(sketches).toHaveLength(1);
    expect(await filesOf(item, b.photos)).toHaveLength(3);
    expect(await cellOf(item, col)).toMatchObject({
      file_id: sketches[0]!.asset_id,
      ai: { output: 'image', source_images: { sent: 1, total: 1 } },
    });
  });

  it('no photo: made from the description only by default (text to image at /images/generations)', async () => {
    const b = await newBoard('No photo');
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      instructions: 'A pencil sketch of {Name}',
    });
    const item = await newItem(b.id, 'Attic');
    const before = await spent();
    expect(await run(b.id, col, [item])).toMatchObject({ done: 1, failed: 0 });
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/generations']);
    expect(calls[0]!.json).toMatchObject({ model: 'gpt-image-1', prompt: 'A pencil sketch of Attic' });
    expect(await spent()).toBeGreaterThan(before);
    expect(await filesOf(item, b.sketches)).toHaveLength(1);
    const cell = (await cellOf(item, col))!;
    expect(cell.ai).toMatchObject({ output: 'image' });
    expect(cell.ai.source_images).toBeUndefined();
  });

  it('several source columns: their photos in column order, and a line naming which came from which', async () => {
    const b = await newBoard('Two sources');
    const designs = await addFileColumn(b.id, 'Designs');
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: designs,
      source_image_columns: [b.sketches, b.photos],
      // All photos in one call (round 4: the default for a new column is one design per photo).
      photo_mode: 'together',
      instructions: 'A finished design',
    });
    const item = await newItem(b.id, 'Lobby');
    await attach(item, b.photos, await upload('p1.png', marked('p1')));
    await attach(item, b.sketches, await upload('s1.png', marked('s1')));
    await attach(item, b.photos, await upload('p2.png', marked('p2')));
    expect(await run(b.id, col, [item])).toMatchObject({ done: 1 });
    const form = calls[0]!.form!;
    expect(form.match(/name="image\[\]"; filename=/g)).toHaveLength(3);
    // Sketches first (the order picked), then Photos oldest first.
    const at = (tag: string) => form.indexOf(`#${tag}#`);
    expect(at('s1')).toBeGreaterThan(0);
    expect(at('s1')).toBeLessThan(at('p1'));
    expect(at('p1')).toBeLessThan(at('p2'));
    expect(utf8(form)).toContain(
      'name="prompt"\r\n\r\nA finished design\n\nImage 1: «Sketches». Images 2–3: «Photos».\r\n',
    );
    expect((await cellOf(item, col))!.ai.source_images).toEqual({ sent: 3, total: 3 });

    // The output column may not be one of them.
    const same = await aiColumn(b.id, {
      connection_id: openai,
      output: 'image',
      image_column: b.photos,
      source_image_columns: [b.sketches, b.photos],
    });
    expect(await body(await as().get(`/boards/${b.id}/ai-columns/${same}`))).toMatchObject({
      reason: 'same_image_columns',
    });
  });

  it("all photos up to the provider's limit: the newest go (gpt-image 16), the cell says sent X of Y", async () => {
    const b = await newBoard('Many photos');
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_columns: [b.photos],
      photo_mode: 'together',
    });
    const item = await newItem(b.id, 'Gallery');
    for (let i = 1; i <= 18; i++) await attach(item, b.photos, await upload(`g${i}.png`, marked(`g${i}`)));
    const before = await spent();
    const out = await run(b.id, col, [item]);
    expect(out).toMatchObject({ done: 1 });
    expect(calls).toHaveLength(1);
    const form = calls[0]!.form!;
    expect(form.match(/name="image\[\]"; filename=/g)).toHaveLength(16);
    // The two oldest stayed behind; the rest went oldest first.
    expect(form).not.toContain('#g1#');
    expect(form).not.toContain('#g2#');
    expect(form.indexOf('#g3#')).toBeLessThan(form.indexOf('#g18#'));
    expect((await cellOf(item, col))!.ai.source_images).toEqual({ sent: 16, total: 18 });
    // One call, priced and logged once.
    expect(out.cost_usd).toBeGreaterThan(0);
    expect(await spent()).toBeCloseTo(before + out.cost_usd, 6);

    // The newest N of each column instead of all.
    calls = [];
    expect(
      (
        await as().patch(`/boards/${b.id}/columns/${col}`, {
          settings: {
            connection_id: openai,
            model: 'gpt-image-1',
            output: 'image',
            image_column: b.sketches,
            source_image_columns: [b.photos],
            source_image_count: 2,
            photo_mode: 'together',
          },
        })
      ).status,
    ).toBe(200);
    expect(await run(b.id, col, [item])).toMatchObject({ done: 1 });
    expect(calls[0]!.form!.match(/name="image\[\]"; filename=/g)).toHaveLength(2);
    expect(calls[0]!.form).toContain('#g17#');
    expect((await cellOf(item, col))!.ai.source_images).toEqual({ sent: 2, total: 2 });
  });

  it('several photos when asked (the newest N, oldest first, as image[])', async () => {
    const b = await newBoard('Rooms 2');
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_column: b.photos,
      source_image_count: 2,
      photo_mode: 'together',
    });
    const item = await newItem(b.id, 'Hall');
    for (const n of ['a.png', 'b.png', 'c.png']) await attach(item, b.photos, await upload(n));
    expect(await run(b.id, col, [item])).toMatchObject({ done: 1 });
    expect(calls[0]!.form!.match(/name="image\[\]"; filename=/g)).toHaveLength(2);
  });

  it("an old 'replace' re-run is read as a new version of the design (nothing deleted); never a person's file", async () => {
    const b = await newBoard('Rooms 3');
    const settings = {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_column: b.photos,
      image_on_rerun: 'add',
    };
    const col = await aiColumn(b.id, settings);
    const item = await newItem(b.id, 'Bedroom');
    await attach(item, b.photos, await upload('room.png'));
    const human = await upload('my-sketch.png');
    await attach(item, b.sketches, human);
    // add: every run adds a file.
    await run(b.id, col, [item]);
    await run(b.id, col, [item]);
    const before = (await filesOf(item, b.sketches)).map((f) => f.asset_id as string);
    expect(before).toHaveLength(3);
    const [, first, second] = before;
    expect((await cellOf(item, col))!.file_id).toBe(second);

    // Saved before round 4 as `replace`: read as `version` — the new design is version 2 of the last one.
    expect(
      (await as().patch(`/boards/${b.id}/columns/${col}`, { settings: { ...settings, image_on_rerun: 'replace' } }))
        .status,
    ).toBe(200);
    expect(
      (await body(await as().get(`/boards/${b.id}`))).columns.find((c: Json) => c.id === col).settings,
    ).toMatchObject({ image_on_rerun: 'version', photo_mode: 'together' });
    expect(await run(b.id, col, [item])).toMatchObject({ done: 1 });
    const after = (await filesOf(item, b.sketches)).map((f) => f.asset_id as string);
    expect(after).toEqual([human, first, second]);
    expect((await cellOf(item, col))!.file_id).toBe(second);
    const versions = (await body(await as().get(`/files/${second}/versions`))).data as Json[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    // Nothing left storage.
    const kept = (await t.db.execute<{ n: number }>(sql`select count(*)::int as n from assets where id = ${second!}`))
      .rows[0]!.n;
    expect(kept).toBe(1);

    // A cell a person typed (no AI marker) versions nothing: a new file is added.
    expect((await as().put(`/items/${item}/cells/${col}`, { value: { text: 'mine', file_id: human } })).status).toBe(
      200,
    );
    await run(b.id, col, [item]);
    const last = (await filesOf(item, b.sketches)).map((f) => f.asset_id as string);
    expect(last).toHaveLength(4);
    expect(last.slice(0, 3)).toEqual([human, first, second]);
    expect((await body(await as().get(`/files/${human}/versions`))).data).toHaveLength(1);
  });

  it('the source and the output may not be the same column', async () => {
    const b = await newBoard('Rooms 4');
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.photos,
      source_image_column: b.photos,
    });
    expect(await body(await as().get(`/boards/${b.id}/ai-columns/${col}`))).toMatchObject({
      ready: false,
      reason: 'same_image_columns',
    });
  });

  it('a model that cannot edit pictures fails the cell with a readable reason, unpaid', async () => {
    const b = await newBoard('Rooms 5');
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'dall-e-3',
      output: 'image',
      image_column: b.sketches,
      source_image_column: b.photos,
    });
    const item = await newItem(b.id, 'Office');
    await attach(item, b.photos, await upload('office.png'));
    expect(await run(b.id, col, [item])).toMatchObject({
      done: 0,
      errors: [{ item_id: item, error: 'ai_model_no_image_edit' }],
    });
    expect(calls).toHaveLength(0);
  });
});

describe('an AI column that reads a photo (text output)', () => {
  it('a model that sees images gets the photo as an image block; one that does not is refused before any call', async () => {
    const b = await newBoard('Listings');
    const col = await aiColumn(b.id, {
      kind: 'custom',
      connection_id: openai,
      model: 'gpt-5',
      instructions: 'Describe the photo in one sentence',
      source_image_column: b.photos,
    });
    const item = await newItem(b.id, 'Flat 4');
    await attach(item, b.photos, await upload('flat.png'));
    expect(await run(b.id, col, [item])).toMatchObject({ done: 1 });
    expect(calls).toHaveLength(1);
    const user = (calls[0]!.json!.messages as Json[]).find((m) => m.role === 'user')!;
    expect(user.content[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
    expect(user.content[1].type).toBe('text');
    expect((await cellOf(item, col))!.text).toBe('A bright room with a sofa');

    calls = [];
    const blind = await aiColumn(b.id, {
      kind: 'custom',
      connection_id: openai,
      model: 'gpt-blind',
      instructions: 'Describe',
      source_image_column: b.photos,
    });
    expect(await run(b.id, blind, [item])).toMatchObject({
      done: 0,
      errors: [{ item_id: item, error: 'ai_model_no_vision' }],
    });
    expect(calls).toHaveLength(0);

    // No photo, `text` (the default): the prompt alone — no image blocks.
    calls = [];
    const bare = await newItem(b.id, 'Flat 5');
    expect(await run(b.id, col, [bare])).toMatchObject({ done: 1 });
    const plain = (calls[0]!.json!.messages as Json[]).find((m) => m.role === 'user')!;
    expect(typeof plain.content === 'string' || plain.content.every((c: Json) => c.type === 'text')).toBe(true);
    expect((await cellOf(bare, col))!.ai.source_images).toBeUndefined();

    // `skip`: not run, nothing spent.
    calls = [];
    const skip = await aiColumn(b.id, {
      kind: 'custom',
      connection_id: openai,
      model: 'gpt-5',
      instructions: 'Describe',
      source_image_columns: [b.photos],
      when_no_source_image: 'skip',
    });
    expect(await run(b.id, skip, [bare])).toMatchObject({
      done: 0,
      errors: [{ item_id: bare, error: 'no_source_image' }],
    });
    expect(calls).toHaveLength(0);
  });

  it('photos of two columns as image blocks in column order, the line naming them after the text', async () => {
    const b = await newBoard('Listings 2');
    const col = await aiColumn(b.id, {
      kind: 'custom',
      connection_id: openai,
      model: 'gpt-5',
      instructions: 'Compare the photos',
      source_image_columns: [b.photos, b.sketches],
    });
    const item = await newItem(b.id, 'Flat 6');
    await attach(item, b.sketches, await upload('s.png', marked('s')));
    await attach(item, b.photos, await upload('p.png', marked('p')));
    expect(await run(b.id, col, [item])).toMatchObject({ done: 1 });
    const user = (calls[0]!.json!.messages as Json[]).find((m) => m.role === 'user')!;
    const urls = (user.content as Json[]).filter((c) => c.type === 'image_url').map((c) => c.image_url.url as string);
    expect(urls.map((u) => Buffer.from(u.split(',')[1]!, 'base64').toString('latin1').slice(-3))).toEqual([
      '#p#',
      '#s#',
    ]);
    const text = (user.content as Json[]).find((c) => c.type === 'text')!.text as string;
    expect(text).toContain('Image 1: «Photos». Image 2: «Sketches».');
    expect((await cellOf(item, col))!.ai.source_images).toEqual({ sent: 2, total: 2 });
  });
});

describe('auto-run when a person adds a photo', () => {
  it('a file added to the source column schedules the cell; the AI-made image schedules nothing', async () => {
    const b = await newBoard('Auto rooms');
    const col = await aiColumn(b.id, {
      connection_id: openai,
      model: 'gpt-image-1',
      output: 'image',
      image_column: b.sketches,
      source_image_column: b.photos,
      auto_run: true,
    });
    const item = await newItem(b.id, 'Studio');
    await drain();
    // (A new item is heard as before — dropped here to watch the files alone.)
    await t.db.delete(aiColumnPending).where(eq(aiColumnPending.itemId, item));
    // A file in another column is not heard.
    await attach(item, b.sketches, await upload('other.png'));
    await drain();
    expect(await t.db.select().from(aiColumnPending).where(eq(aiColumnPending.itemId, item))).toHaveLength(0);
    await attach(item, b.photos, await upload('studio.png'));
    await drain();
    expect(await t.db.select().from(aiColumnPending).where(eq(aiColumnPending.itemId, item))).toHaveLength(1);
    expect(await runDueAutoCells(t.deps, new Date(Date.now() + 60_000))).toBe(1);
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    expect(await filesOf(item, b.sketches)).toHaveLength(2);
    expect((await cellOf(item, col))!.ai).toMatchObject({ output: 'image' });
    // The AI's own file is dispatched too, but schedules nothing.
    await drain();
    expect(await t.db.select().from(aiColumnPending).where(eq(aiColumnPending.itemId, item))).toHaveLength(0);
  });
});

describe('automations: "when a file is added" → an image from the photo', () => {
  it('fires on its column only, and generate_image starts from the newest photo', async () => {
    const b = await newBoard('Auto sketches');
    const res = await as().post(`/boards/${b.id}/automations`, {
      recipe: {
        trigger: { type: 'file_added', column: b.photos },
        actions: [
          {
            type: 'generate_image',
            column: b.sketches,
            source_column: b.photos,
            prompt: 'A watercolour of {item.name}',
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const automationId = (await body(res)).id as string;
    const item = await newItem(b.id, 'Garden');
    await drain();
    expect(calls).toHaveLength(0);
    await attach(item, b.photos, await upload('garden.png'));
    await drain();
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    expect(calls[0]!.form).toContain('A watercolour of Garden');
    expect(await filesOf(item, b.sketches)).toHaveLength(1);
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
    expect(runs).toHaveLength(1);
    expect((runs[0]!.actionsLog as Json[])[0]).toMatchObject({ type: 'generate_image', status: 'ok' });
    // The image it added to Sketches does not fire it (another column), nor does it loop.
    await drain();
    expect(await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId))).toHaveLength(
      1,
    );
    await as().patch(`/automations/${automationId}`, { is_active: false });
  });

  it('any file column when none is set; no photo in the source column + skip = the action is skipped, nothing spent', async () => {
    const b = await newBoard('Any file');
    const res = await as().post(`/boards/${b.id}/automations`, {
      recipe: {
        trigger: { type: 'file_added' },
        actions: [
          {
            type: 'generate_image',
            column: b.photos,
            source_column: b.photos,
            when_no_source_image: 'skip',
            prompt: 'x',
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const automationId = (await body(res)).id as string;
    const item = await newItem(b.id, 'Doc');
    await drain();
    // A PDF in Sketches: heard (any file column); no image in Photos → skipped.
    await attach(item, b.sketches, await upload('a.pdf', Buffer.from('%PDF-1.4'), 'application/pdf'));
    await drain();
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
    expect(runs).toHaveLength(1);
    expect((runs[0]!.actionsLog as Json[])[0]).toMatchObject({ type: 'generate_image', status: 'skipped' });
    expect(calls).toHaveLength(0);
    await as().patch(`/automations/${automationId}`, { is_active: false });
  });

  it('source_columns: all their photos in order; no photo = from the description (the default)', async () => {
    const b = await newBoard('Auto two');
    const designs = await addFileColumn(b.id, 'Designs');
    const res = await as().post(`/boards/${b.id}/automations`, {
      recipe: {
        trigger: { type: 'file_added', column: b.sketches },
        actions: [
          {
            type: 'generate_image',
            column: designs,
            source_columns: [b.photos, b.sketches],
            prompt: 'A render of {item.name}',
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const automationId = (await body(res)).id as string;
    const item = await newItem(b.id, 'Deck');
    await attach(item, b.photos, await upload('p.png', marked('p')));
    await drain();
    expect(calls).toHaveLength(0);
    await attach(item, b.sketches, await upload('s.png', marked('s')));
    await drain();
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    const form = calls[0]!.form!;
    expect(form.indexOf('#p#')).toBeLessThan(form.indexOf('#s#'));
    expect(utf8(form)).toContain('A render of Deck\n\nImage 1: «Photos». Image 2: «Sketches».');
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
    expect((runs[0]!.actionsLog as Json[])[0]).toMatchObject({ type: 'generate_image', status: 'ok' });

    // An item without photos: the picture is made from the description alone.
    calls = [];
    const bare = await newItem(b.id, 'Roof');
    await attach(bare, b.sketches, await upload('notes.pdf', Buffer.from('%PDF-1.4'), 'application/pdf'));
    await drain();
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/generations']);
    expect(calls[0]!.json).toMatchObject({ prompt: 'A render of Roof' });
    expect(await filesOf(bare, designs)).toHaveLength(1);
    await as().patch(`/automations/${automationId}`, { is_active: false });
  });

  it('an image into the column it listens to: one image, its own file does not fire it again', async () => {
    const b = await newBoard('Same column');
    const res = await as().post(`/boards/${b.id}/automations`, {
      recipe: {
        trigger: { type: 'file_added', column: b.photos },
        actions: [{ type: 'generate_image', column: b.photos, source_column: b.photos, prompt: 'Again' }],
      },
    });
    expect(res.status).toBe(201);
    const automationId = (await body(res)).id as string;
    const item = await newItem(b.id, 'Loop');
    await drain();
    await attach(item, b.photos, await upload('loop.png'));
    await drain();
    await drain();
    expect(calls).toHaveLength(1);
    expect(await filesOf(item, b.photos)).toHaveLength(2);
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
    // An automation never hears its own writes (runner), so the image it added starts no second run at all.
    expect(runs.map((r) => [r.depth, r.status, r.skipReason])).toEqual([[1, 'succeeded', null]]);
    await as().patch(`/automations/${automationId}`, { is_active: false });
  });
});

describe('the generate_image tool from a photo (MCP)', () => {
  it('a source column (its newest image) or a source file the caller may read', async () => {
    const b = await newBoard('Tool');
    const item = await newItem(b.id, 'Porch');
    let r = await call('generate_image', {
      item_id: item,
      prompt: 'A sketch',
      column_id: b.sketches,
      source_column_id: b.photos,
    });
    expect(r.error).toMatchObject({ message: 'ai_no_source_image' });
    expect(calls).toHaveLength(0);

    const photo = await upload('porch.png');
    await attach(item, b.photos, photo);
    r = await call('generate_image', {
      item_id: item,
      prompt: 'A sketch',
      column_id: b.sketches,
      source_column_id: b.photos,
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    expect(await filesOf(item, b.sketches)).toHaveLength(1);

    calls = [];
    r = await call('generate_image', { item_id: item, prompt: 'Again', column_id: b.sketches, source_file_id: photo });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(calls[0]!.form).toContain(PNG.toString('latin1'));

    const pdf = await upload('notes.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
    await attach(item, b.photos, pdf);
    r = await call('generate_image', { item_id: item, prompt: 'x', column_id: b.sketches, source_file_id: pdf });
    expect(r.error).toMatchObject({ message: 'ai_source_not_image' });
    r = await call('generate_image', {
      item_id: item,
      prompt: 'x',
      column_id: b.sketches,
      source_file_id: '01J000000000000000000NOPE0',
    });
    expect(r.error).toMatchObject({ code: 'not_found' });
  });

  it('source_column_ids: all their images in column order (the single fields keep working)', async () => {
    const b = await newBoard('Tool 2');
    const designs = await addFileColumn(b.id, 'Designs');
    const item = await newItem(b.id, 'Patio');
    let r = await call('generate_image', {
      item_id: item,
      prompt: 'A sketch',
      column_id: designs,
      source_column_ids: [b.sketches, b.photos],
    });
    expect(r.error).toMatchObject({ message: 'ai_no_source_image' });
    await attach(item, b.photos, await upload('p1.png', marked('p1')));
    await attach(item, b.photos, await upload('p2.png', marked('p2')));
    await attach(item, b.sketches, await upload('s1.png', marked('s1')));
    r = await call('generate_image', {
      item_id: item,
      prompt: 'A sketch',
      column_id: designs,
      source_column_ids: [b.sketches, b.photos],
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    const form = calls[0]!.form!;
    expect(form.match(/name="image\[\]"; filename=/g)).toHaveLength(3);
    expect(form.indexOf('#s1#')).toBeLessThan(form.indexOf('#p1#'));
    expect(form.indexOf('#p1#')).toBeLessThan(form.indexOf('#p2#'));
    expect(utf8(form)).toContain('A sketch\n\nImage 1: «Sketches». Images 2–3: «Photos».');
    // A column the caller cannot use is refused with its key.
    r = await call('generate_image', {
      item_id: item,
      prompt: 'x',
      column_id: designs,
      source_column_ids: ['ghost_col'],
    });
    expect(r.error).toMatchObject({ message: 'ai_source_column_unavailable' });
  });
});
