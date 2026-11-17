// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import { type AiClientFactory, type AnthropicLike, createAiClient, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod — "@" references in the AI chat (product owner: "choose items or boards… to be specific, from anywhere"): a
 * message points at an item, a board, a document or a dashboard the person can open; the model gets its exact ids
 * (outside the data) and the read tool, its name as untrusted data; the message lists its references; something the
 * person cannot open is a 404 before the stream; the stored transcript keeps a mark (no extra reads).
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let wsId: string;
let leadsId: string;
let privateId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
const scripted = scriptedAnthropic();
const fake: AnthropicLike = {
  ...scripted,
  messages: {
    create: async (params, options) => {
      requests.push(structuredClone(params));
      return scripted.messages.create(params, options);
    },
  },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fake });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as Json);

const chat = async (ctx: Json = {}, cookie = admin) =>
  (await body(await as(cookie).post('/ai/assistant/conversations', ctx))).id as string;
/** Sends a message and reads its whole stream (its model calls are over before the next step). */
const send = async (conv: string, payload: Json, cookie = admin) => {
  const res = await as(cookie).post(`/ai/assistant/conversations/${conv}/messages`, payload);
  return { status: res.status, evs: res.status === 200 ? await events(res) : [] };
};
/** The text of the last user turn the model got. */
const lastUserText = () => {
  const msgs = requests.at(-1)!.messages;
  const user = [...msgs].reverse().find((m) => m.role === 'user' && Array.isArray(m.content))!;
  return (user.content as Anthropic.ContentBlockParam[])
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
};

beforeAll(async () => {
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
  ).account.id;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const a = as(admin);
  const connectionId = (
    await body(
      await a.post('/ai/connections', { name: 'Claude', provider: 'anthropic', api_key: 'sk-ant-test-0000000000' }),
    )
  ).id;
  wsId = (await body(await a.get('/workspaces'))).data[0].id;
  leadsId = (await body(await a.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  privateId = (await body(await a.post('/boards', { name: 'Admin only', workspace_id: wsId, kind: 'private' }))).id;
  itemId = (await body(await a.post(`/boards/${leadsId}/items`, { name: 'Dana Levi' }))).id;
  await a.patch('/ai/settings', {
    enabled: true,
    assistant: {
      enabled: true,
      connection_id: connectionId,
      model: 'claude-sonnet-5-5',
      roles: ['member', 'viewer'],
      max_steps: 4,
      max_usd_per_message: 0.5,
      daily_messages_per_user: 100,
    },
  });
});
afterAll(() => t.close());
beforeEach(() => {
  requests.length = 0;
});

describe('"@" references in the AI chat', () => {
  it('an item from anywhere: its ids and read tool to the model, its name as data; the message lists it', async () => {
    const conv = await chat();
    const res = await send(conv, { text: 'What is the status of @Dana Levi?', refs: [{ type: 'item', id: itemId }] });
    expect(res.status).toBe(200);
    const user = res.evs.find((e) => e.type === 'user')!.message;
    expect(user.refs).toEqual([{ type: 'item', id: itemId, name: 'Dana Levi', board_id: leadsId }]);
    const text = lastUserText();
    expect(text).toMatch(new RegExp(`<reference>[\\s\\S]*item_id: ${itemId}[\\s\\S]*board_id: ${leadsId}`));
    expect(text).toContain('read it with: get_item');
    expect(text).toMatch(/<untrusted_content source="reference">\nitem: Dana Levi/);
    // The stored transcript keeps a mark; the conversation shows the reference on its message.
    const stored = await t.db.execute<{ content: unknown }>(
      sql`select content from ai_messages where conversation_id = ${conv} and role = 'user'`,
    );
    expect(JSON.stringify(stored.rows[0]!.content)).toContain('"bines_ref"');
    const got = await body(await as(admin).get(`/ai/assistant/conversations/${conv}`));
    expect(got.messages[0].refs[0]).toMatchObject({ type: 'item', id: itemId });
    expect(got.messages[1].refs).toEqual([]);
    // The next message replays it, still resolved (never a raw mark to the model).
    expect((await send(conv, { text: 'and its owner?' })).status).toBe(200);
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('"bines_ref"');
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(`item_id: ${itemId}`);
  });

  it('a board and a document; references alone are a message; repeats count once', async () => {
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Q4 plan' }));
    const conv = await chat();
    const res = await send(conv, {
      refs: [
        { type: 'board', id: leadsId },
        { type: 'doc', id: doc.id },
        { type: 'board', id: leadsId },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.evs.find((e) => e.type === 'user')!.message.refs.map((r: Json) => r.type)).toEqual(['board', 'doc']);
    const text = lastUserText();
    expect(text).toContain(`board_id: ${leadsId}`);
    expect(text).toContain(`doc_id: ${doc.id}`);
    expect(text).toContain('read it with: get_doc');
  });

  it('something the person cannot open does not exist for them: 404 before the stream', async () => {
    const conv = await chat({}, bob);
    expect((await send(conv, { text: 'look', refs: [{ type: 'board', id: privateId }] }, bob)).status).toBe(404);
    expect((await send(conv, { text: 'look', refs: [{ type: 'item', id: 'nope' }] }, bob)).status).toBe(404);
    expect(requests).toHaveLength(0);
    // The same board is fine for its admin.
    expect((await send(await chat(), { text: 'look', refs: [{ type: 'board', id: privateId }] })).status).toBe(200);
  });

  it('neither text, files nor references is refused', async () => {
    expect((await send(await chat(), { refs: [] })).status).toBe(400);
  });
});
