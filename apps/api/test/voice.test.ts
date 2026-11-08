// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { type AiClientFactory, createAiClient, type FetchLike, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiUsage } from '../src/db/schema';
import { clearModelCache } from '../src/modules/ai/models.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Voice in updates against a mocked Soniox and OpenAI (no network, no money): what the composer is told
 * (GET /voice), transcribing a recording only with the connection the admin chose (none assumed), the file's own
 * read rule, AI off / not configured refusals, a speech-only connection kept out of the chat pickers, and the
 * cost in AI usage (per minute from the price, source `transcription`).
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const sent: { url: string; body: string }[] = [];
const decoder = new TextDecoder();
const providerFetch: FetchLike = async (url, init) => {
  const reply = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  sent.push({ url, body: typeof init.body === 'string' ? init.body : init.body ? decoder.decode(init.body) : '' });
  if (url === 'https://api.soniox.com/v1/models')
    return reply({
      models: [
        { id: 'stt-async-old', transcription_mode: 'async' },
        { id: 'stt-async-new', transcription_mode: 'async' },
      ],
    });
  if (url === 'https://api.soniox.com/v1/files' && init.method === 'POST') return reply({ id: 'f1' });
  if (url === 'https://api.soniox.com/v1/transcriptions' && init.method === 'POST')
    return reply({ id: 't1', status: 'completed', audio_duration_ms: 120_000 });
  if (url === 'https://api.soniox.com/v1/transcriptions/t1/transcript') return reply({ text: 'שלום, זו הודעה קולית' });
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  if (url === 'https://api.openai.com/v1/models') return reply({ data: [{ id: 'gpt-5' }] });
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
const upload = async (name: string, mime: string, cookie = admin) => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size: 3, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, 3, mime, Buffer.from([1, 2, 3]));
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};
const setVoice = async (voice: Json) => {
  const current = (await body(await as().get('/ai/settings'))).voice as Json;
  const res = await as().patch('/ai/settings', { voice: { ...current, ...voice } });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
};

let soniox: string;
let recording: string;

beforeAll(async () => {
  clearModelCache();
  t = await createTestContext({ aiClient });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  const wsId = (await body(await as().get('/workspaces'))).data[0].id as string;
  const boardId = (await body(await as().post('/boards', { name: 'Voice', workspace_id: wsId }))).id as string;
  itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'A' }))).id as string;
  recording = await upload('הקלטה 2026-10-14 10-00.webm', 'audio/webm');
  await as().post(`/items/${itemId}/updates`, { body: 'הקלטה', file_ids: [recording] });
});

afterAll(async () => {
  await t?.close();
});

describe('voice settings', () => {
  it('by default: recording on (10 minutes), transcription off, and on request when on', async () => {
    expect(await body(await as().get('/voice'))).toEqual({
      recording: true,
      max_seconds: 600,
      transcription: false,
      auto: false,
    });
  });

  it('transcribing before anything is set up is refused (AI off, then no connection)', async () => {
    expect((await body(await as().post(`/files/${recording}/transcribe`, {}))).error.message).toBe('ai_disabled');
    expect((await as().patch('/ai/settings', { enabled: true })).status).toBe(200);
    await setVoice({ transcription: true });
    expect((await body(await as().post(`/files/${recording}/transcribe`, {}))).error.message).toBe(
      'voice_not_configured',
    );
    expect((await body(await as().get('/voice'))).transcription).toBe(false);
  });

  it('a Soniox connection: transcription models listed, kept out of the chat pickers', async () => {
    const created = await as().post('/ai/connections', {
      name: 'Soniox',
      provider: 'soniox',
      api_key: 'soniox-key-1234567',
    });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    soniox = (await body(created)).id as string;
    const models = await body(await as().get(`/ai/connections/${soniox}/transcription-models`));
    expect(models.data.map((m: Json) => m.id)).toEqual(['stt-async-new', 'stt-async-old']);
    const forColumns = await body(await as().get('/ai-columns/connections'));
    expect(forColumns.data.map((c: Json) => c.id)).not.toContain(soniox);
    const forAgents = await body(await as().get('/agents/connections'));
    expect(forAgents.data.map((c: Json) => c.id)).not.toContain(soniox);
  });
});

describe('transcribing', () => {
  it('with the chosen connection (its newest model, the language hint): the text, the cost per minute in usage', async () => {
    await setVoice({ connection_id: soniox, language: 'he' });
    // A per-minute price in the platform's price table (the `minute` unit price).
    const priced = await t.api(owner).post('/platform/ai-prices', {
      provider: 'soniox',
      model: 'stt-async-*',
      input: 0,
      output: 0,
      image_prices: { minute: 0.01 },
    });
    expect(priced.status, JSON.stringify(await priced.clone().json())).toBeLessThan(300);
    expect((await body(await as().get('/voice'))).transcription).toBe(true);
    const res = await as().post(`/files/${recording}/transcribe`, {});
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await body(res)).toEqual({ text: 'שלום, זו הודעה קולית', model: 'stt-async-new', cost_usd: 0.02 });
    const start = sent.find((s) => s.url === 'https://api.soniox.com/v1/transcriptions')!;
    expect(JSON.parse(start.body)).toMatchObject({ model: 'stt-async-new', file_id: 'f1', language_hints: ['he'] });
    const usage = (await t.db.select().from(aiUsage)).filter((u) => u.source === 'transcription');
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]!.costUsd)).toBe(0.02);
  });

  it('the text is kept on the file: shown to readers, asked again = no new run and no charge; force runs it again', async () => {
    const before = sent.length;
    expect(await body(await as().get(`/files/${recording}/transcript`))).toMatchObject({
      transcript: { text: 'שלום, זו הודעה קולית', model: 'stt-async-new', edited_at: null },
      can_edit: true,
    });
    expect(await body(await as().post(`/files/${recording}/transcribe`, {}))).toEqual({
      text: 'שלום, זו הודעה קולית',
      model: 'stt-async-new',
      cost_usd: 0,
      reused: true,
    });
    expect(sent.length).toBe(before); // the provider was not called
    expect((await t.db.select().from(aiUsage)).filter((u) => u.source === 'transcription')).toHaveLength(1);
    const again = await body(await as().post(`/files/${recording}/transcribe`, { force: true }));
    expect(again).toMatchObject({ text: 'שלום, זו הודעה קולית', cost_usd: 0.02 });
    expect(again.reused).toBeUndefined();
    expect((await t.db.select().from(aiUsage)).filter((u) => u.source === 'transcription')[0]!.costUsd).toBeDefined();
  });

  it("the update's author corrects the text (in the item's activity); another member reads it but may not edit", async () => {
    const res = await as().patch(`/files/${recording}/transcript`, { text: 'שלום, זו הודעה קולית מתוקנת' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const fixed = await body(res);
    expect(fixed.transcript).toMatchObject({ text: 'שלום, זו הודעה קולית מתוקנת' });
    expect(fixed.transcript.edited_at).not.toBeNull();
    const events = await t.db.execute<{ type: string }>(
      sql`select type from activity_log where item_id = ${itemId} and type = 'file.transcript_edited'`,
    );
    expect(events.rows).toHaveLength(1);
    await as().post('/users/invite', { emails: ['reader@acme.test'], role: 'member' });
    const reader = await join('reader@acme.test');
    const seen = await body(await as(reader).get(`/files/${recording}/transcript`));
    expect(seen).toMatchObject({ transcript: { text: 'שלום, זו הודעה קולית מתוקנת' }, can_edit: false });
    expect((await as(reader).patch(`/files/${recording}/transcript`, { text: 'x' })).status).toBe(403);
    // Empty text removes it.
    await as().patch(`/files/${recording}/transcript`, { text: '  ' });
    expect((await body(await as().get(`/files/${recording}/transcript`))).transcript).toBeNull();
  });

  it('only audio / video, and only a file this person may read', async () => {
    const doc = await upload('notes.pdf', 'application/pdf');
    await as().post(`/items/${itemId}/updates`, { body: 'מסמך', file_ids: [doc] });
    expect((await body(await as().post(`/files/${doc}/transcribe`, {}))).error.message).toBe('voice_not_audio');
    await as().post('/users/invite', { emails: ['member@acme.test'], role: 'member' });
    const member = await join('member@acme.test');
    const mine = await upload('mine.webm', 'audio/webm');
    // Not attached anywhere: only its uploader reads it.
    expect((await as(member).post(`/files/${mine}/transcribe`, {})).status).toBe(404);
  });

  it('an admin may turn recording off and shorten it; the composer is told', async () => {
    await setVoice({ recording: false, max_seconds: 120 });
    expect(await body(await as().get('/voice'))).toMatchObject({ recording: false, max_seconds: 120 });
    expect((await as().patch('/ai/settings', { voice: { max_seconds: 5 } })).status).toBe(400);
  });
});
