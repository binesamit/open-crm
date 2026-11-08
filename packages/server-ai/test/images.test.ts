// SPDX-License-Identifier: AGPL-3.0-only
import { aiImageCost, defaultCapabilities, perImagePrice } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import {
  AiContentPolicyError,
  buildGeminiImageBody,
  buildImagenBody,
  buildOpenAiImageBody,
  buildOpenAiImageEditFields,
  createAiClient,
  type FetchLike,
  fitInputImages,
  imagenAspect,
  inputImageLimit,
  multipartBody,
  aiRetryReason,
  safeAiError,
  scriptedAnthropic,
  scriptedImage,
  sniffImageMime,
  TINY_PNG_BASE64,
} from '../src';

describe('the scripted image maker (E2E)', () => {
  it('RATE_LIMIT_ONCE: a 429 with Retry-After 1 s the first time a prompt comes, an image the next time', async () => {
    const req = { model: 'gpt-image-e2e', prompt: 'A sketch RATE_LIMIT_ONCE #1', size: null, quality: null, n: 1 };
    const err = await scriptedImage(req).catch((e: unknown) => e);
    expect(aiRetryReason(err)).toEqual({ reason: 'rate_limited', retryAfterMs: 1000 });
    expect((await scriptedImage(req)).images).toHaveLength(1);
    expect((await scriptedImage({ ...req, prompt: 'A plain sketch' })).images).toHaveLength(1);
  });
});

/**
 * AI images over a mocked fetch — no network, no money: OpenAI's Images API (gpt-image base64, DALL·E
 * links fetched only from OpenAI's own storage), OpenAI-compatible, Gemini (image parts) and Imagen; safety refusals
 * as `AiContentPolicyError`; image models' capabilities and the per-image price.
 */
type Seen = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  /** A multipart body (image edits), as latin1 text. */
  form: string | null;
};
const PNG = Buffer.from(TINY_PNG_BASE64, 'base64');
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = (answer: (url: string, body: Record<string, unknown> | null) => Response) => {
  const seen: Seen[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const form = init.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : null;
    seen.push({ url, method: init.method, headers: init.headers, body, form });
    return answer(url, body);
  };
  return { fetchFn, seen };
};

describe('OpenAI images', () => {
  it('gpt-image: the request (size, quality, n; no response_format) and the base64 answer with its token usage', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({
        data: [{ b64_json: TINY_PNG_BASE64 }, { b64_json: TINY_PNG_BASE64 }],
        usage: { input_tokens: 50, output_tokens: 4160 },
      }),
    );
    const client = createAiClient({ provider: 'openai', apiKey: 'sk-x' }, { fetch: fetchFn });
    const out = await client.generateImage!({
      model: 'gpt-image-1',
      prompt: 'A red fox',
      size: '1024x1024',
      quality: 'high',
      n: 2,
    });
    expect(seen[0]).toMatchObject({
      url: 'https://api.openai.com/v1/images/generations',
      method: 'POST',
      headers: { authorization: 'Bearer sk-x' },
      body: { model: 'gpt-image-1', prompt: 'A red fox', n: 2, size: '1024x1024', quality: 'high' },
    });
    expect(seen[0]!.body).not.toHaveProperty('response_format');
    expect(out.images).toHaveLength(2);
    expect(out.images[0]!.mime).toBe('image/png');
    expect(Buffer.from(out.images[0]!.data).equals(PNG)).toBe(true);
    expect(out.usage).toMatchObject({ input_tokens: 50, output_tokens: 4160 });
  });

  it('DALL·E asks for base64; `auto` sizes / qualities are left to the provider', () => {
    expect(
      buildOpenAiImageBody({ model: 'dall-e-3', prompt: 'x', size: 'auto', quality: 'auto' }, { compatible: false }),
    ).toEqual({
      model: 'dall-e-3',
      prompt: 'x',
      n: 1,
      response_format: 'b64_json',
    });
    expect(buildOpenAiImageBody({ model: 'dall-e-3', prompt: 'x' }, { compatible: true })).not.toHaveProperty(
      'response_format',
    );
  });

  it("a result link is fetched only from OpenAI's own storage — never a link elsewhere", async () => {
    const { fetchFn, seen } = mockFetch((url) => {
      if (url.endsWith('/images/generations'))
        return json({
          data: [
            {
              url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/img.png?sig=1',
              revised_prompt: 'A fox.',
            },
            { url: 'https://evil.example.com/steal.png' },
            { url: 'http://169.254.169.254/latest/meta-data' },
          ],
        });
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const client = createAiClient({ provider: 'openai', apiKey: 'sk-x' }, { fetch: fetchFn });
    const out = await client.generateImage!({ model: 'dall-e-2', prompt: 'fox', n: 3 });
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.openai.com/v1/images/generations',
      'https://oaidalleapiprodscus.blob.core.windows.net/private/img.png?sig=1',
    ]);
    // The storage link carries its own signature: the key is never sent there.
    expect(seen[1]!.headers.authorization).toBeUndefined();
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.revisedPrompt).toBe('A fox.');
  });

  it('OpenAI-compatible: its own server only, with its key', async () => {
    const { fetchFn, seen } = mockFetch((url) =>
      url.endsWith('/images/generations')
        ? json({ data: [{ url: 'https://img.local.example/v1/files/1.png' }, { url: 'https://other.example/2.png' }] })
        : new Response(PNG, { status: 200 }),
    );
    const client = createAiClient(
      { provider: 'openai_compatible', apiKey: 'k-1', baseUrl: 'https://img.local.example/v1' },
      { fetch: fetchFn },
    );
    const out = await client.generateImage!({ model: 'flux', prompt: 'x' });
    expect(seen.map((s) => s.url)).toEqual([
      'https://img.local.example/v1/images/generations',
      'https://img.local.example/v1/files/1.png',
    ]);
    expect(seen[1]!.headers.authorization).toBe('Bearer k-1');
    expect(out.images).toHaveLength(1);
  });

  it('a safety refusal is an AiContentPolicyError with the provider reason; other errors stay HTTP errors', async () => {
    const refuse = mockFetch(() =>
      json(
        {
          error: {
            message: 'Your request was rejected as a result of our safety system.',
            code: 'moderation_blocked',
          },
        },
        400,
      ),
    );
    const client = createAiClient({ provider: 'openai', apiKey: 'sk-x' }, { fetch: refuse.fetchFn });
    const err = await client.generateImage!({ model: 'gpt-image-1', prompt: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiContentPolicyError);
    expect((err as AiContentPolicyError).providerMessage).toContain('safety system');
    expect(safeAiError(err)).toBe('ai_content_policy');
    const bad = mockFetch(() => json({ error: { message: 'Invalid size', code: 'invalid_value' } }, 400));
    const other = await createAiClient({ provider: 'openai', apiKey: 'sk-x' }, { fetch: bad.fetchFn }).generateImage!({
      model: 'gpt-image-1',
      prompt: 'x',
      size: '7x7',
    }).catch((e: unknown) => e);
    expect(other).not.toBeInstanceOf(AiContentPolicyError);
    expect(safeAiError(other)).toBe('api_error_400');
  });

  it('what is not an image (HTML, a script) is dropped', async () => {
    const { fetchFn } = mockFetch(() => json({ data: [{ b64_json: Buffer.from('<html>').toString('base64') }] }));
    const out = await createAiClient({ provider: 'openai', apiKey: 'sk-x' }, { fetch: fetchFn }).generateImage!({
      model: 'gpt-image-1',
      prompt: 'x',
    });
    expect(out.images).toEqual([]);
    expect(sniffImageMime(new Uint8Array(PNG))).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array(Buffer.from('<svg>')))).toBeNull();
  });

  it('the live list keeps the image models (and still leaves out speech, embeddings …)', async () => {
    const { fetchFn } = mockFetch(() =>
      json({
        data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }, { id: 'tts-1' }, { id: 'text-embedding-3' }],
      }),
    );
    const list = await createAiClient({ provider: 'openai', apiKey: 'sk-x' }, { fetch: fetchFn }).listModels!();
    expect(list.map((m) => m.id).sort()).toEqual(['dall-e-3', 'gpt-5', 'gpt-image-1']);
  });
});

describe('Gemini images', () => {
  it('Gemini image models: image parts of generateContent, one call per image, usage summed', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({
        candidates: [
          {
            content: {
              parts: [{ text: 'Here it is' }, { inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 },
      }),
    );
    const client = createAiClient({ provider: 'gemini', apiKey: 'g-1' }, { fetch: fetchFn });
    const out = await client.generateImage!({ model: 'gemini-2.5-flash-image', prompt: 'A cat', n: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      headers: { 'x-goog-api-key': 'g-1' },
      body: { generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
    });
    expect(out.images).toHaveLength(2);
    expect(out.usage).toMatchObject({ input_tokens: 20, output_tokens: 2580 });
  });

  it('a blocked prompt / IMAGE_SAFETY is a content-policy error', async () => {
    const { fetchFn } = mockFetch(() =>
      json({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }),
    );
    const err = await createAiClient({ provider: 'gemini', apiKey: 'g' }, { fetch: fetchFn }).generateImage!({
      model: 'gemini-2.5-flash-image',
      prompt: 'x',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiContentPolicyError);
    expect((err as AiContentPolicyError).providerMessage).toBe('IMAGE_SAFETY');
  });

  it('Imagen: predict with the nearest aspect ratio; a filtered answer is a content-policy error', async () => {
    expect(imagenAspect('1536x1024')).toBe('4:3');
    expect(imagenAspect('1024x1792')).toBe('9:16');
    expect(imagenAspect('auto')).toBeNull();
    expect(buildImagenBody({ model: 'imagen-4', prompt: 'p', n: 2, size: '1024x1024' })).toEqual({
      instances: [{ prompt: 'p' }],
      parameters: { sampleCount: 2, aspectRatio: '1:1' },
    });
    const ok = mockFetch(() => json({ predictions: [{ bytesBase64Encoded: TINY_PNG_BASE64, mimeType: 'image/png' }] }));
    const out = await createAiClient({ provider: 'gemini', apiKey: 'g' }, { fetch: ok.fetchFn }).generateImage!({
      model: 'imagen-4.0-generate-001',
      prompt: 'p',
    });
    expect(ok.seen[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict',
    );
    expect(out.images).toHaveLength(1);
    const filtered = mockFetch(() => json({ predictions: [{ raiFilteredReason: 'Unsafe content' }] }));
    const err = await createAiClient({ provider: 'gemini', apiKey: 'g' }, { fetch: filtered.fetchFn }).generateImage!({
      model: 'imagen-4.0-generate-001',
      prompt: 'p',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiContentPolicyError);
  });
});

describe('capabilities and prices', () => {
  it('Anthropic makes no images; image models are marked by name (an admin corrects any)', () => {
    expect(
      createAiClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: scriptedAnthropic() }).generateImage,
    ).toBeUndefined();
    expect(defaultCapabilities('openai', 'gpt-image-1')).toMatchObject({ image_generation: true, tools: false });
    expect(defaultCapabilities('openai', 'dall-e-3').image_generation).toBe(true);
    expect(defaultCapabilities('openai', 'gpt-5').image_generation).toBe(false);
    expect(defaultCapabilities('gemini', 'gemini-2.5-flash-image')).toMatchObject({
      image_generation: true,
      vision: true,
      tools: false,
    });
    expect(defaultCapabilities('gemini', 'imagen-4.0-generate-001').image_generation).toBe(true);
    expect(defaultCapabilities('gemini', 'gemini-2.5-pro').image_generation).toBe(false);
    expect(defaultCapabilities('openai_compatible', 'flux').image_generation).toBe(false);
  });

  it('per image by size / quality (most specific first), else per image, else by tokens', () => {
    const price = {
      input: 5,
      output: 40,
      cacheRead: 5,
      cacheWrite: 5,
      perImage: 0.04,
      imagePrices: { '1024x1024/hd': 0.08, '1792x1024': 0.08, low: 0.01 },
    };
    expect(perImagePrice(price, '1024x1024', 'hd')).toBe(0.08);
    expect(perImagePrice(price, '1792x1024', 'standard')).toBe(0.08);
    expect(perImagePrice(price, '1024x1024', 'low')).toBe(0.01);
    expect(perImagePrice(price, '1024x1024', 'standard')).toBe(0.04);
    expect(aiImageCost(price, { size: '1024x1024', quality: 'hd', count: 3 })).toBe(0.24);
    // No per-image price: the tokens the provider reported.
    const tokens = { input: 5, output: 40, cacheRead: 5, cacheWrite: 5 };
    expect(
      aiImageCost(tokens, { size: '1024x1024', quality: 'high', count: 1 }, { input_tokens: 100, output_tokens: 4000 }),
    ).toBe((100 * 5 + 4000 * 40) / 1_000_000);
    expect(aiImageCost(null, { count: 1 })).toBe(0);
  });
});

describe('image to image', () => {
  const photo = { mime: 'image/png', data: new Uint8Array(PNG) };
  const jpeg = { mime: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) };

  it('OpenAI: pictures go to /images/edits as a multipart form (gpt-image several, as image[])', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({ data: [{ b64_json: TINY_PNG_BASE64 }], usage: { input_tokens: 300, output_tokens: 4160 } }),
    );
    const client = createAiClient({ provider: 'openai', apiKey: 'sk-x' }, { fetch: fetchFn });
    const out = await client.generateImage!({
      model: 'gpt-image-1',
      prompt: 'A pencil sketch of this room',
      size: '1024x1024',
      quality: 'auto',
      images: [photo, jpeg],
    });
    expect(seen[0]).toMatchObject({
      url: 'https://api.openai.com/v1/images/edits',
      method: 'POST',
      headers: { authorization: 'Bearer sk-x' },
      body: null,
    });
    expect(seen[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const form = seen[0]!.form!;
    expect(form).toContain('name="model"\r\n\r\ngpt-image-1\r\n');
    expect(form).toContain('name="prompt"\r\n\r\nA pencil sketch of this room\r\n');
    expect(form).toContain('name="size"\r\n\r\n1024x1024\r\n');
    expect(form).not.toContain('name="quality"');
    expect(form).not.toContain('response_format');
    expect(form).toContain('name="image[]"; filename="image-1.png"\r\nContent-Type: image/png');
    expect(form).toContain('name="image[]"; filename="image-2.jpg"\r\nContent-Type: image/jpeg');
    // The picture's bytes travel as they are.
    expect(form).toContain(PNG.toString('latin1'));
    expect(out.images).toHaveLength(1);
    expect(out.usage).toMatchObject({ input_tokens: 300 });
  });

  it('one picture is sent as `image`; DALL·E 2 takes one PNG, DALL·E 3 none — a clear error, no call', async () => {
    const fields = buildOpenAiImageEditFields({ model: 'dall-e-2', prompt: 'p' }, [photo], { compatible: false });
    expect(fields.map((f) => f[0])).toEqual(['model', 'prompt', 'n', 'response_format', 'image']);
    expect(() => buildOpenAiImageEditFields({ model: 'dall-e-2', prompt: 'p' }, [jpeg], { compatible: false })).toThrow(
      'ai_image_edit_one_png',
    );
    expect(() =>
      buildOpenAiImageEditFields({ model: 'dall-e-2', prompt: 'p' }, [photo, photo], { compatible: false }),
    ).toThrow('ai_image_edit_one_png');
    const { fetchFn, seen } = mockFetch(() => json({ data: [] }));
    const err = await createAiClient({ provider: 'openai', apiKey: 'k' }, { fetch: fetchFn }).generateImage!({
      model: 'dall-e-3',
      prompt: 'p',
      images: [photo],
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('ai_model_no_image_edit');
    expect(safeAiError(err)).toBe('ai_model_no_image_edit');
    expect(seen).toHaveLength(0);
  });

  it('a compatible server gets the form on its own base URL; what is not a picture is refused before any call', async () => {
    const { fetchFn, seen } = mockFetch(() => json({ data: [{ b64_json: TINY_PNG_BASE64 }] }));
    const client = createAiClient(
      { provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://llm.example.com/v1/' },
      { fetch: fetchFn },
    );
    await client.generateImage!({ model: 'flux', prompt: 'p', images: [photo] });
    expect(seen[0]!.url).toBe('https://llm.example.com/v1/images/edits');
    expect(seen[0]!.form).toContain('name="image"; filename="image-1.png"');
    const html = { mime: 'image/png', data: new Uint8Array(Buffer.from('<html>no</html>')) };
    await expect(client.generateImage!({ model: 'flux', prompt: 'p', images: [html] })).rejects.toThrow(
      'ai_image_input_invalid',
    );
    await expect(
      client.generateImage!({ model: 'flux', prompt: 'p', images: Array.from({ length: 17 }, () => photo) }),
    ).rejects.toThrow('ai_image_input_invalid');
    expect(seen).toHaveLength(1);
  });

  it('round 2 — no cap of 4: gpt-image takes 16 pictures in one form, a 17th is refused before any call', async () => {
    const { fetchFn, seen } = mockFetch(() => json({ data: [{ b64_json: TINY_PNG_BASE64 }] }));
    const client = createAiClient({ provider: 'openai', apiKey: 'k' }, { fetch: fetchFn });
    await client.generateImage!({ model: 'gpt-image-1', prompt: 'p', images: Array.from({ length: 16 }, () => photo) });
    expect(seen[0]!.form!.match(/name="image\[\]"/g)).toHaveLength(16);
    await expect(
      client.generateImage!({ model: 'gpt-image-1', prompt: 'p', images: Array.from({ length: 17 }, () => photo) }),
    ).rejects.toThrow('ai_image_input_invalid');
    expect(seen).toHaveLength(1);
  });

  it('round 2 — Gemini: a Gemini 3 image model takes 14 pictures, 2.5 Flash Image 3', async () => {
    const { fetchFn, seen } = mockFetch(() =>
      json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }] } }],
      }),
    );
    const client = createAiClient({ provider: 'gemini', apiKey: 'g' }, { fetch: fetchFn });
    await client.generateImage!({
      model: 'gemini-3-pro-image-preview',
      prompt: 'p',
      images: Array.from({ length: 14 }, () => photo),
    });
    expect((seen[0]!.body!.contents as { parts: unknown[] }[])[0]!.parts).toHaveLength(15);
    await expect(
      client.generateImage!({ model: 'gemini-2.5-flash-image', prompt: 'p', images: [photo, photo, photo, photo] }),
    ).rejects.toThrow('ai_image_input_invalid');
    expect(seen).toHaveLength(1);
  });

  it('round 2 — the limits per provider / model, image output and reading (vision)', () => {
    const MB = 1024 * 1024;
    expect(inputImageLimit('openai', 'gpt-image-1')).toEqual({ maxImages: 16, maxTotalBytes: 50 * MB });
    expect(inputImageLimit('openai_compatible', 'flux')).toEqual({ maxImages: 16, maxTotalBytes: 50 * MB });
    expect(inputImageLimit('openai', 'dall-e-2').maxImages).toBe(1);
    expect(inputImageLimit('gemini', 'models/gemini-3-pro-image-preview')).toEqual({
      maxImages: 14,
      maxTotalBytes: 15 * MB,
    });
    expect(inputImageLimit('gemini', 'gemini-2.5-flash-image').maxImages).toBe(3);
    expect(inputImageLimit('gemini', 'imagen-4.0-generate-001').maxImages).toBe(1);
    expect(inputImageLimit('anthropic', 'claude-x', 'vision')).toEqual({ maxImages: 20, maxTotalBytes: 20 * MB });
    expect(inputImageLimit('openai', 'gpt-x', 'vision').maxTotalBytes).toBe(35 * MB);
    expect(inputImageLimit('gemini', 'gemini-x', 'vision').maxTotalBytes).toBe(15 * MB);
  });

  it('round 2 — more pictures than a call takes: the newest that fit (count, then bytes), in their own order', () => {
    const list = [
      { id: 'a', at: 1, bytes: 10 },
      { id: 'b', at: 5, bytes: 10 },
      { id: 'c', at: 3, bytes: 10 },
      { id: 'd', at: 4, bytes: 30 },
    ];
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    expect(ids(fitInputImages(list, { maxImages: 2, maxTotalBytes: 1000 }))).toEqual(['b', 'd']);
    // d (newer, 30) does not fit next to b within 35 bytes: the next newest that do.
    expect(ids(fitInputImages(list, { maxImages: 3, maxTotalBytes: 35 }))).toEqual(['a', 'b', 'c']);
    expect(ids(fitInputImages(list, { maxImages: 16, maxTotalBytes: 1000 }))).toEqual(['a', 'b', 'c', 'd']);
    // The newest always goes, whatever its size.
    expect(ids(fitInputImages([{ id: 'big', at: 9, bytes: 99 }], { maxImages: 3, maxTotalBytes: 10 }))).toEqual([
      'big',
    ]);
  });

  it('Gemini: the pictures are inline image parts after the text', async () => {
    expect(buildGeminiImageBody({ model: 'm', prompt: 'Sketch it' }, [photo])).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Sketch it' }, { inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }],
        },
      ],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    const { fetchFn, seen } = mockFetch(() =>
      json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }] } }],
      }),
    );
    const out = await createAiClient({ provider: 'gemini', apiKey: 'g' }, { fetch: fetchFn }).generateImage!({
      model: 'gemini-2.5-flash-image',
      prompt: 'Sketch it',
      images: [photo],
    });
    const parts = (seen[0]!.body!.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } });
    expect(out.images).toHaveLength(1);
  });

  it('Imagen does not start from a picture: a clear error, no call', async () => {
    const { fetchFn, seen } = mockFetch(() => json({ predictions: [] }));
    const err = await createAiClient({ provider: 'gemini', apiKey: 'g' }, { fetch: fetchFn }).generateImage!({
      model: 'imagen-4.0-generate-001',
      prompt: 'p',
      images: [photo],
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('ai_model_no_image_edit');
    expect(seen).toHaveLength(0);
  });

  it('a multipart body: text fields and files, CRLF-separated, closed by the boundary', () => {
    const m = multipartBody(
      [
        ['a', '1'],
        ['f', { data: new Uint8Array([65, 66]), mime: 'image/png', filename: 'x"y.png' }],
      ],
      'B',
    );
    expect(m.contentType).toBe('multipart/form-data; boundary=B');
    expect(Buffer.from(m.body).toString('latin1')).toBe(
      '--B\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n' +
        '--B\r\nContent-Disposition: form-data; name="f"; filename="x_y.png"\r\nContent-Type: image/png\r\n\r\nAB\r\n' +
        '--B--\r\n',
    );
  });
});
