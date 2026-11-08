// SPDX-License-Identifier: AGPL-3.0-only
import { aiTranscriptionCost, isChatProvider, isTranscriptionProvider } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import { buildOpenAiTranscribeFields, createAiClient, createSonioxClient, type FetchLike } from '../src';

/**
 * Speech to text over a mocked fetch — no network, no money: OpenAI's `/audio/transcriptions` (and
 * compatible servers), Soniox's async flow (upload → start → wait → text → clean up), and the per-minute price.
 */
type Call = { url: string; method: string; body: string };
const decoder = new TextDecoder();
const recorder = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : init.body ? decoder.decode(init.body) : '';
    const c = { url, method: init.method, body };
    calls.push(c);
    return answer(c);
  };
  return { calls, fetchFn };
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const audio = new Uint8Array([1, 2, 3]);

describe('providers', () => {
  it('Soniox transcribes but has no chat; OpenAI and compatible servers do both; Anthropic / Gemini chat only', () => {
    expect(isChatProvider('soniox')).toBe(false);
    expect(isTranscriptionProvider('soniox')).toBe(true);
    expect(isTranscriptionProvider('openai')).toBe(true);
    expect(isTranscriptionProvider('openai_compatible')).toBe(true);
    expect(isTranscriptionProvider('anthropic')).toBe(false);
    expect(isChatProvider('gemini')).toBe(true);
  });
});

describe('OpenAI transcription', () => {
  it('the form: file, model, JSON, and the language only when given', () => {
    const fields = buildOpenAiTranscribeFields({
      model: 'm',
      audio,
      fileName: 'a.webm',
      mime: 'audio/webm',
      language: 'he',
    });
    expect(fields.map(([k]) => k)).toEqual(['file', 'model', 'response_format', 'language']);
    expect(
      buildOpenAiTranscribeFields({ model: 'm', audio, fileName: 'a.webm', mime: 'audio/webm' }).map(([k]) => k),
    ).not.toContain('language');
  });

  it('posts the recording and reads the text, tokens or duration', async () => {
    const { calls, fetchFn } = recorder(() =>
      json({ text: ' שלום עולם ', usage: { type: 'tokens', input_tokens: 10, output_tokens: 4 } }),
    );
    const client = createAiClient({ provider: 'openai', apiKey: 'sk-test-123456' }, { fetch: fetchFn });
    const out = await client.transcribe!({ model: 'gpt-4o-transcribe', audio, fileName: 'a.webm', mime: 'audio/webm' });
    expect(out).toEqual({
      text: 'שלום עולם',
      model: 'gpt-4o-transcribe',
      durationSeconds: null,
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0]!.body).toContain('name="model"');
  });

  it('lists only the speech-to-text models, newest first', async () => {
    const { fetchFn } = recorder(() =>
      json({
        data: [
          { id: 'gpt-4o', created: 3 },
          { id: 'whisper-1', created: 1 },
          { id: 'gpt-4o-transcribe', created: 2 },
        ],
      }),
    );
    const client = createAiClient({ provider: 'openai', apiKey: 'sk-test-123456' }, { fetch: fetchFn });
    expect((await client.listTranscriptionModels!()).map((m) => m.id)).toEqual(['gpt-4o-transcribe', 'whisper-1']);
  });
});

describe('Soniox', () => {
  it('upload → start (with the language hint) → wait → text, then deletes both at the provider', async () => {
    let polls = 0;
    const { calls, fetchFn } = recorder((c) => {
      if (c.url.endsWith('/v1/files') && c.method === 'POST') return json({ id: 'f1' });
      if (c.url.endsWith('/v1/transcriptions') && c.method === 'POST') return json({ id: 't1', status: 'queued' });
      if (c.url.endsWith('/v1/transcriptions/t1') && c.method === 'GET')
        return json(
          ++polls < 2
            ? { id: 't1', status: 'processing' }
            : { id: 't1', status: 'completed', audio_duration_ms: 90_000 },
        );
      if (c.url.endsWith('/v1/transcriptions/t1/transcript')) return json({ text: 'בדיקה אחת שתיים' });
      return new Response(null, { status: 204 });
    });
    const client = createSonioxClient({ provider: 'soniox', apiKey: 'key-123456789' }, fetchFn, {
      sleep: async () => undefined,
    });
    const out = await client.transcribe!({
      model: 'stt-async-x',
      audio,
      fileName: 'a.webm',
      mime: 'audio/webm',
      language: 'he',
    });
    expect(out).toEqual({ text: 'בדיקה אחת שתיים', model: 'stt-async-x', durationSeconds: 90, usage: null });
    const start = calls.find((c) => c.url.endsWith('/v1/transcriptions') && c.method === 'POST')!;
    expect(JSON.parse(start.body)).toEqual({ model: 'stt-async-x', file_id: 'f1', language_hints: ['he'] });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.replace('https://api.soniox.com', ''))).toEqual([
      '/v1/transcriptions/t1',
      '/v1/files/f1',
    ]);
  });

  it('a failed transcription throws, and still cleans up', async () => {
    const { calls, fetchFn } = recorder((c) => {
      if (c.url.endsWith('/v1/files') && c.method === 'POST') return json({ id: 'f1' });
      if (c.url.endsWith('/v1/transcriptions') && c.method === 'POST')
        return json({ id: 't1', status: 'error', error_message: 'bad audio' });
      return new Response(null, { status: 204 });
    });
    const client = createSonioxClient({ provider: 'soniox', apiKey: 'key-123456789' }, fetchFn, {
      sleep: async () => undefined,
    });
    await expect(client.transcribe!({ model: 'm', audio, fileName: 'a', mime: '' })).rejects.toThrow(/bad audio/);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('no chat; its models are the async ones, newest first; the key test reads them', async () => {
    const { fetchFn } = recorder(() =>
      json({
        models: [
          { id: 'stt-async-v1', transcription_mode: 'async' },
          { id: 'stt-rt-v2', transcription_mode: 'real_time' },
          { id: 'stt-async-v2', transcription_mode: 'async' },
        ],
      }),
    );
    const client = createAiClient({ provider: 'soniox', apiKey: 'key-123456789' }, { fetch: fetchFn });
    await expect(client.complete({ model: 'x', messages: [] } as never)).rejects.toThrow('ai_provider_no_chat');
    expect((await client.listTranscriptionModels!()).map((m) => m.id)).toEqual(['stt-async-v2', 'stt-async-v1']);
    expect(await client.listModels!()).toEqual([]);
    expect(await client.test()).toEqual({ ok: true, error: null });
  });
});

describe('aiTranscriptionCost', () => {
  const price = { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 };
  it('per minute when the price has a `minute` unit price, else by tokens, else 0', () => {
    expect(
      aiTranscriptionCost({ ...price, imagePrices: { minute: 0.006 } }, { durationSeconds: 90, usage: null }),
    ).toBe(0.009);
    expect(
      aiTranscriptionCost(price, { durationSeconds: null, usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
    ).toBe(2.5);
    expect(aiTranscriptionCost(null, { durationSeconds: 60, usage: null })).toBe(0);
    expect(aiTranscriptionCost(price, { durationSeconds: 60, usage: null })).toBe(0);
  });
});
