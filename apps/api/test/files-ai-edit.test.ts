// SPDX-License-Identifier: AGPL-3.0-only
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, eq, sql } from 'drizzle-orm';
import {
  type AiClientFactory,
  createAiClient,
  type FetchLike,
  scriptedAnthropic,
  TINY_PNG_BASE64,
} from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activityLog, aiUsage } from '../src/db/schema';
import { clearModelCache } from '../src/modules/ai/models.service';
import { aiWriteLimiter } from '../src/modules/ai/tools/guard';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * "Ask the AI for a change" on an image in the file viewer, against a mocked OpenAI (no network, no
 * money): the picture shown (the current version, or an older one by `version_id`) goes to `/images/edits` with the
 * instruction; the result is the file's next, current version (the edited bytes, the name kept — its extension
 * follows the new type); the cost lands in AI usage as `image`; the item's activity says the AI made it. Guardrails:
 * read + edit rights before anything is spent (viewers, a column edit restriction, another account), AI on / budget /
 * plan, only the account's own image connection AND model, images only (type and size like every input picture),
 * the shared AI change rate, a model that cannot edit pictures refused unpaid. The same through MCP
 * (`edit_file_image`).
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let vera: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let openai: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const PNG = Buffer.from(TINY_PNG_BASE64, 'base64');
/** A PNG told apart by a marker after its end (the type is read from its first bytes). */
const marked = (tag: string) => Buffer.concat([PNG, Buffer.from(`#${tag}#`)]);
const EDITED = marked('edited');

type Call = { url: string; form: string | null };
let calls: Call[] = [];
const providerFetch: FetchLike = async (url, init) => {
  const reply = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const form = init.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : null;
  if (url === 'https://api.openai.com/v1/models')
    return reply({ data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }] });
  calls.push({ url, form });
  if (url === 'https://api.openai.com/v1/images/edits')
    return reply({
      data: [{ b64_json: EDITED.toString('base64') }],
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
const as = (cookie: string) => t.api(cookie, acmeId);
const settings = (patch: Json) => as(admin).patch('/ai/settings', patch);

const keyOf = async (id: string) =>
  (await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${id}`)).rows[0]!
    .storage_key;
/** presign → "PUT" (the bytes) → complete. */
const upload = async (name: string, data: Buffer = PNG, mime = 'image/png') => {
  const pre = await body(await as(admin).post('/files/presign', { name, size: data.length, mime }));
  t.storage.markUploaded(await keyOf(pre.file_id), data.length, mime, data);
  expect((await as(admin).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};
/** An item whose files cell holds one file (version 1). */
const fileOnItem = async (name: string, data: Buffer = marked('v1'), mime = 'image/png') => {
  const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name }));
  const id = await upload(name, data, mime);
  expect((await as(admin).post(`/items/${item.id}/cells/docs/files`, { file_ids: [id] })).status).toBe(200);
  return { itemId: item.id as string, rootId: id };
};
const aiEdit = (cookie: string, rootId: string, payload: Json) => as(cookie).post(`/files/${rootId}/ai-edit`, payload);
const imageCalls = async () =>
  (
    await t.db
      .select({ n: aiUsage.calls })
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.source, 'image')))
  ).reduce((s, r) => s + r.n, 0);
const errorOf = async (res: Response) => (await body(res)).error as Json;

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
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  betaId = await mk('Beta', 'beta', 'admin@beta.test');
  betaAdmin = await join('admin@beta.test');
  expect((await settings({ enabled: true })).status).toBe(200);
  openai = (
    await body(
      await as(admin).post('/ai/connections', {
        name: 'OpenAI',
        provider: 'openai',
        api_key: 'sk-openai-test-000000',
        default_model: 'gpt-5',
      }),
    )
  ).id as string;
  expect((await settings({ images: { connection_id: openai, model: 'gpt-image-1' } })).status).toBe(200);
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Designs', workspace_id: ws }))).id;
  await as(admin).post(`/boards/${boardId}/columns`, { id: 'docs', title: 'Designs', type: 'file' });
  const token = (await body(await as(admin).post('/auth/tokens', { name: 'Claude Code', scopes: ['admin'] })))
    .token as string;
  client = new Client({ name: 'ai-edit', version: '1.0.0' });
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
  aiWriteLimiter.clear();
});

describe('POST /files/{id}/ai-edit', () => {
  it('sends the current version with the instruction; the result is version 2, current, the edited bytes', async () => {
    const { itemId, rootId } = await fileOnItem('poster.png');
    const before = await imageCalls();
    expect(await body(await as(admin).get(`/files/${rootId}/ai-edit`))).toEqual({ available: true, reason: null });

    const res = await aiEdit(admin, rootId, { instruction: 'Remove the background' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const v2 = await body(res);
    expect(v2).toMatchObject({
      version: 2,
      current: true,
      from_version: 1,
      name: 'poster.png',
      mime: 'image/png',
      size: EDITED.length,
      model: 'gpt-image-1',
      created_by: { name: 'admin' },
    });
    expect(typeof v2.cost_usd).toBe('number');
    // One call to /images/edits: the instruction and version 1's bytes.
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    expect(calls[0]!.form).toContain('name="prompt"\r\n\r\nRemove the background\r\n');
    expect(calls[0]!.form).toContain(marked('v1').toString('latin1'));
    // Stored: the provider's bytes.
    expect(t.storage.objects.get(await keyOf(v2.id))!.body!.equals(EDITED)).toBe(true);
    // The versions list and the cell: v2 current.
    const list = (await body(await as(bob).get(`/files/${rootId}/versions`))).data as Json[];
    expect(list.map((v) => [v.version, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    const cell = (await body(await as(admin).get(`/items/${itemId}`))).cells.docs.value.files;
    expect(cell).toHaveLength(1);
    expect(cell[0]).toMatchObject({ asset_id: rootId, version: 2 });
    // Usage: one image call more, as every image call.
    expect(await imageCalls()).toBe(before + 1);
    // The item's activity: a version added by the AI, with the instruction.
    const [ev] = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.itemId, itemId), eq(activityLog.type, 'file.version_added')));
    expect(ev!.payload).toMatchObject({
      after: { file_id: rootId, version_id: v2.id, version: 2, ai: true, instruction: 'Remove the background' },
      meta: { ai: true, instruction: 'Remove the background', model: 'gpt-image-1', column_key: 'docs' },
    });
    const entries = (await body(await as(admin).get(`/items/${itemId}/activity`))).data as Json[];
    expect(entries.find((e) => e.type === 'file.version_added')?.after).toMatchObject({ ai: true });

    // Undo: make version 1 current again (a new version 3 with version 1's bytes).
    const undo = await body(await as(admin).post(`/files/${rootId}/versions/${rootId}/make-current`));
    expect(undo).toMatchObject({ version: 3, current: true });
    expect(t.storage.objects.get(await keyOf(undo.id))!.body!.equals(marked('v1'))).toBe(true);
  });

  it('version_id: the older version being viewed is the one sent; a JPEG name follows the new type', async () => {
    const { rootId } = await fileOnItem('room.jpg', marked('v1'), 'image/jpeg');
    const v2 = await upload('room-2.jpg', marked('v2'), 'image/jpeg');
    expect((await as(admin).post(`/files/${rootId}/versions`, { file_id: v2 })).status).toBe(200);

    const res = await aiEdit(admin, rootId, { instruction: 'Make the sofa blue', version_id: rootId });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await body(res)).toMatchObject({ version: 3, from_version: 1, current: true, name: 'room.png' });
    expect(calls[0]!.form).toContain(marked('v1').toString('latin1'));
    expect(calls[0]!.form).not.toContain('#v2#');

    // Without version_id: the current one (now version 3, the AI's).
    calls = [];
    expect((await aiEdit(admin, rootId, { instruction: 'Brighter' })).status).toBe(200);
    expect(calls[0]!.form).toContain('#edited#');
    // A version of another file, or none: 404, nothing sent.
    calls = [];
    const other = await fileOnItem('other.png');
    expect((await aiEdit(admin, rootId, { instruction: 'x', version_id: other.rootId })).status).toBe(404);
    expect((await aiEdit(admin, rootId, { instruction: 'x', version_id: '01J000000000000000000NOPE0' })).status).toBe(
      404,
    );
    expect(calls).toHaveLength(0);
  });

  it('rights first: a viewer, a column edit restriction, another account — refused, nothing sent or charged', async () => {
    const { rootId } = await fileOnItem('rights.png');
    const before = await imageCalls();
    // A viewer may read the file but not change it.
    expect((await as(vera).get(`/files/${rootId}`)).status).toBe(200);
    const res = await aiEdit(vera, rootId, { instruction: 'x' });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe('role_ceiling');
    expect(await body(await as(vera).get(`/files/${rootId}/ai-edit`))).toEqual({
      available: false,
      reason: 'role_ceiling',
    });
    // The column's edit restriction applies as when uploading a version.
    expect((await as(admin).put(`/boards/${boardId}/columns/docs/restriction`, { kind: 'edit' })).status).toBe(200);
    try {
      expect((await aiEdit(bob, rootId, { instruction: 'x' })).status).toBe(403);
      expect((await body(await as(bob).get(`/files/${rootId}/ai-edit`))).available).toBe(false);
    } finally {
      await as(admin).put(`/boards/${boardId}/columns/docs/restriction`, { kind: null });
    }
    // Another account: 404 (status too).
    expect((await t.api(betaAdmin, betaId).post(`/files/${rootId}/ai-edit`, { instruction: 'x' })).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).get(`/files/${rootId}/ai-edit`)).status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(await imageCalls()).toBe(before);
    // A member with edit rights may.
    expect((await aiEdit(bob, rootId, { instruction: 'Add a frame' })).status).toBe(200);
  });

  it('images only: a PDF, or a file whose bytes are not an image, is 422 ai_source_not_image, unpaid', async () => {
    const before = await imageCalls();
    const pdf = await fileOnItem('plan.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
    let res = await aiEdit(admin, pdf.rootId, { instruction: 'x' });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toBe('ai_source_not_image');
    // Said to be a PNG, but its bytes are not: read from the bytes, as every input picture.
    const fake = await fileOnItem('fake.png', Buffer.from('not an image at all'), 'image/png');
    res = await aiEdit(admin, fake.rootId, { instruction: 'x' });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toBe('ai_source_not_image');
    // An empty instruction or one over 2000 characters: 400.
    expect((await aiEdit(admin, fake.rootId, { instruction: '  ' })).status).toBe(400);
    expect((await aiEdit(admin, fake.rootId, { instruction: 'x'.repeat(2001) })).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await imageCalls()).toBe(before);
  });

  it('AI off, the budget used up, no image model chosen: refused before any call', async () => {
    const { rootId } = await fileOnItem('gated.png');
    const before = await imageCalls();
    try {
      await settings({ enabled: false });
      let res = await aiEdit(admin, rootId, { instruction: 'x' });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).message).toBe('ai_disabled');
      expect(await body(await as(admin).get(`/files/${rootId}/ai-edit`))).toEqual({
        available: false,
        reason: 'ai_disabled',
      });
      await settings({ enabled: true, monthly_budget_usd: 0 });
      res = await aiEdit(admin, rootId, { instruction: 'x' });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).message).toBe('ai_budget_exceeded');
      await settings({ monthly_budget_usd: null, images: { connection_id: openai, model: null } });
      // No model chosen for images: no default picked for the account.
      res = await aiEdit(admin, rootId, { instruction: 'x' });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).message).toBe('ai_image_no_model');
      await settings({ images: { connection_id: null, model: null } });
      res = await aiEdit(admin, rootId, { instruction: 'x' });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).message).toBe('ai_images_not_configured');
    } finally {
      await settings({
        enabled: true,
        monthly_budget_usd: null,
        images: { connection_id: openai, model: 'gpt-image-1' },
      });
    }
    expect(calls).toHaveLength(0);
    expect(await imageCalls()).toBe(before);
  });

  it('a model that cannot edit pictures: 422 ai_model_no_image_edit, no call, no charge, no version', async () => {
    const { rootId } = await fileOnItem('dalle.png');
    const before = await imageCalls();
    try {
      await settings({ images: { connection_id: openai, model: 'dall-e-3' } });
      const res = await aiEdit(admin, rootId, { instruction: 'x' });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).message).toBe('ai_model_no_image_edit');
    } finally {
      await settings({ images: { connection_id: openai, model: 'gpt-image-1' } });
    }
    expect(calls).toHaveLength(0);
    expect(await imageCalls()).toBe(before);
    expect((await body(await as(admin).get(`/files/${rootId}/versions`))).data).toHaveLength(1);
  });

  it('the shared AI change rate: over the per-person limit → 429, nothing sent', async () => {
    const { rootId } = await fileOnItem('rate.png');
    try {
      await settings({ write_rate_per_minute: 1 });
      expect((await aiEdit(admin, rootId, { instruction: 'One' })).status).toBe(200);
      calls = [];
      const res = await aiEdit(admin, rootId, { instruction: 'Two' });
      expect(res.status).toBe(429);
      expect(calls).toHaveLength(0);
    } finally {
      await settings({ write_rate_per_minute: 60 });
    }
  });
});

describe('the edit_file_image tool (MCP)', () => {
  it('makes a new current version from the instruction; a non-image is refused', async () => {
    const { rootId } = await fileOnItem('mcp.png');
    const r = await call('edit_file_image', { file_id: rootId, instruction: 'Remove the background' });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data).toMatchObject({ file_id: rootId, version: 2, from_version: 1, name: 'mcp.png' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/images/edits']);
    const pdf = await fileOnItem('mcp.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
    const bad = await call('edit_file_image', { file_id: pdf.rootId, instruction: 'x' });
    expect(bad.error).toMatchObject({ message: 'ai_source_not_image' });
  });
});

describe('after an AI change', () => {
  it('the board can still be deleted (to the trash) after an AI change and a make-current', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0].id as string;
    const b = (await body(await as(admin).post('/boards', { name: 'To delete', workspace_id: ws }))).id as string;
    await as(admin).post(`/boards/${b}/columns`, { id: 'pics', title: 'Pics', type: 'file' });
    const item = await body(await as(admin).post(`/boards/${b}/items`, { name: 'x' }));
    const root = await upload('a.png', marked('v1'));
    expect((await as(admin).post(`/items/${item.id}/cells/pics/files`, { file_ids: [root] })).status).toBe(200);
    expect((await aiEdit(admin, root, { instruction: 'brighter' })).status).toBe(200);
    expect((await as(admin).post(`/files/${root}/versions/${root}/make-current`)).status).toBe(200);
    const started = Date.now();
    const res = await as(admin).del(`/boards/${b}`);
    expect(
      res.status,
      JSON.stringify(
        await res
          .clone()
          .json()
          .catch(() => null),
      ),
    ).toBeLessThan(300);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("the plan's ai feature", () => {
  it('a plan without AI refuses the change (and the status says so)', async () => {
    const { rootId } = await fileOnItem('plan.png');
    const plan = await body(
      await t.api(owner).post('/platform/plans', { name: 'No AI', version: { features: ['guests', 'api'] } }),
    );
    expect(
      (await t.api(owner).put(`/platform/accounts/${acmeId}/subscription`, { plan_version_id: plan.versions[0].id }))
        .status,
    ).toBe(200);
    const res = await aiEdit(admin, rootId, { instruction: 'x' });
    expect(res.status).toBe(402);
    expect((await errorOf(res)).details).toMatchObject({ feature: 'ai' });
    expect((await body(await as(admin).get(`/files/${rootId}/ai-edit`))).available).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
