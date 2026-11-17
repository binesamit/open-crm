// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { type AiClientFactory, type AnthropicLike, createAiClient, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unusedAssets } from '../src/modules/files/files.repo';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod — files in the AI chat ("paste images, files… like the updates composer"): a message carries files
 * the person uploaded; the model sees an image (when it reads images) and reads a document's text; the stored
 * transcript keeps only a mark per file (never its bytes); the message lists its files; the files stay in use (the
 * orphan sweep keeps them); someone else's file is refused; a model without vision gets a note, never the image.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let connectionId: string;
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

const upload = async (cookie: string, name: string, bytes: Uint8Array, mime: string) => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size: bytes.length, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, bytes.length, mime, Buffer.from(bytes));
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};

/** A tiny PNG (its signature is what the server checks). */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2]);
const docx = (text: string) =>
  zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });

const chat = async (cookie = admin) =>
  (await body(await as(cookie).post('/ai/assistant/conversations', {}))).id as string;
/** Sends a message and reads its whole stream (so its model calls are over before the next step). */
const send = async (conv: string, payload: Json, cookie = admin) => {
  const res = await as(cookie).post(`/ai/assistant/conversations/${conv}/messages`, payload);
  return { status: res.status, evs: res.status === 200 ? await events(res) : [] };
};

/** The blocks of the last user turn the model got (the context block first). */
const lastUserBlocks = () => {
  const msgs = requests.at(-1)!.messages;
  const user = [...msgs].reverse().find((m) => m.role === 'user' && Array.isArray(m.content))!;
  return user.content as Anthropic.ContentBlockParam[];
};
const textOf = (blocks: Anthropic.ContentBlockParam[]) =>
  blocks
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

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
  connectionId = (
    await body(
      await as(admin).post('/ai/connections', {
        name: 'Claude',
        provider: 'anthropic',
        api_key: 'sk-ant-test-0000000000',
      }),
    )
  ).id;
  await as(admin).patch('/ai/settings', {
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

describe('files in the AI chat', () => {
  it('an image: the model sees it; the transcript keeps only a mark; the message lists it; it stays in use', async () => {
    const image = await upload(admin, 'screenshot.png', PNG, 'image/png');
    const conv = await chat();
    const res = await send(conv, { text: 'What is in this screenshot?', file_ids: [image] });
    expect(res.status).toBe(200);
    const user = res.evs.find((e) => e.type === 'user')!.message;
    expect(user.files).toEqual([{ id: image, name: 'screenshot.png', mime: 'image/png', size: PNG.length }]);
    const blocks = lastUserBlocks();
    const img = blocks.find((b) => b.type === 'image') as Anthropic.ImageBlockParam;
    expect(img.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(PNG).toString('base64'),
    });
    expect(textOf(blocks)).toContain('What is in this screenshot?');
    // The stored transcript: a mark, never the bytes.
    const stored = await t.db.execute<{ content: unknown }>(
      sql`select content from ai_messages where conversation_id = ${conv} and role = 'user'`,
    );
    const json = JSON.stringify(stored.rows[0]!.content);
    expect(json).toContain('"bines_file"');
    expect(json).not.toContain(Buffer.from(PNG).toString('base64'));
    // The conversation shows the file on its message.
    const got = await body(await as(admin).get(`/ai/assistant/conversations/${conv}`));
    expect(got.messages[0].files[0].id).toBe(image);
    expect(got.messages[1].files).toEqual([]);
    // In use: the orphan sweep keeps it.
    expect(await unusedAssets(t.db, acmeId, [image])).toEqual([]);
    // A later message resends the image with the history (read again from storage).
    requests.length = 0;
    expect((await send(conv, { text: 'and now?' })).status).toBe(200);
    const all = requests.at(-1)!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(all.some((b) => b.type === 'image')).toBe(true);
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('"bines_file"');
  });

  it('documents: a Word file and a text file are read as text, as data (not instructions)', async () => {
    const word = await upload(admin, 'brief.docx', docx('Budget is 40000 NIS'), 'application/octet-stream');
    const notes = await upload(admin, 'notes.txt', strToU8('Call Dana on Sunday'), 'text/plain');
    const conv = await chat();
    expect((await send(conv, { text: 'Summarise', file_ids: [word, notes] })).status).toBe(200);
    const text = textOf(lastUserBlocks());
    expect(text).toContain('Budget is 40000 NIS');
    expect(text).toContain('Call Dana on Sunday');
    expect(text).toMatch(/<untrusted_content source="attachment">[\s\S]*brief\.docx/);
  });

  it('files alone are a message; neither text nor files is refused; a file of unknown type is named', async () => {
    const zip = await upload(admin, 'archive.zip', new Uint8Array([0x50, 0x4b, 3, 4]), 'application/zip');
    const conv = await chat();
    const res = await send(conv, { file_ids: [zip] });
    expect(res.status).toBe(200);
    expect(textOf(lastUserBlocks())).toContain('"archive.zip"');
    expect((await send(conv, {})).status).toBe(400);
    expect((await send(conv, { text: '   ' })).status).toBe(400);
  });

  it("someone else's file, or an unfinished upload, is refused before the stream", async () => {
    const mine = await upload(admin, 'mine.png', PNG, 'image/png');
    const conv = await chat(bob);
    const res = await send(conv, { text: 'look', file_ids: [mine] }, bob);
    expect(res.status).toBe(422);
    const pending = await body(await as(bob).post('/files/presign', { name: 'x.png', size: 10, mime: 'image/png' }));
    expect((await send(conv, { text: 'look', file_ids: [pending.file_id] }, bob)).status).toBe(422);
    expect(requests).toHaveLength(0);
  });

  it('a model that cannot see images gets a note instead of the image (and the chat goes on)', async () => {
    // The connection marks the assistant's model as not reading images.
    expect(
      (
        await as(admin).patch(`/ai/connections/${connectionId}`, {
          manual_models: [{ id: 'claude-sonnet-5-5', capabilities: { vision: false } }],
        })
      ).status,
    ).toBe(200);
    try {
      const image = await upload(admin, 'photo.png', PNG, 'image/png');
      const conv = await chat();
      const res = await send(conv, { text: 'see?', file_ids: [image] });
      expect(res.status).toBe(200);
      const blocks = lastUserBlocks();
      expect(blocks.some((b) => b.type === 'image')).toBe(false);
      expect(textOf(blocks)).toContain('cannot see images');
      expect(res.evs.at(-1)!.type).toBe('done');
    } finally {
      await as(admin).patch(`/ai/connections/${connectionId}`, { manual_models: [] });
    }
  });
});
