// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { aiCost, type AiUsage, newestFirst, type ProviderModel } from '@bines/shared';
import { AiContentPolicyError, safeAiError } from './errors';
import { checkInputImages, imageFromBase64, inputImageLimit } from './images';
import {
  callJson,
  parseArgs,
  send,
  sseEvents,
  systemText,
  textBlock,
  toolNames,
  toolResultText,
  toolUseBlock,
  trimBase,
} from './http';
import type {
  AiClient,
  AiCompletion,
  AiCompletionRequest,
  AiConnectionSecret,
  AiImage,
  AiImageRequest,
  AiImageResult,
  AiInputImage,
  FetchLike,
} from './types';

/**
 * Google Gemini over its REST API (`generateContent` / `streamGenerateContent?alt=sse`, `GET /models`) with plain
 * fetch — no SDK in the deps. Tool calls are `functionCall` / `functionResponse` parts; Gemini answers a tool call
 * by the tool's name, so the names are looked up from the conversation. A call's `thoughtSignature` (Gemini 3) is
 * kept on the tool_use block and sent back with it, as Gemini requires.
 */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const CALL_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 8000;

type GPart = {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
};
type GContent = { role: 'user' | 'model'; parts: GPart[] };
type GUsage = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
};
type GResponse = {
  candidates?: { content?: { parts?: GPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GUsage;
  modelVersion?: string;
};

/** Anthropic-shaped messages → Gemini contents (thinking blocks dropped; tool results answered by tool name). */
export const toGeminiContents = (messages: Anthropic.MessageParam[]): GContent[] => {
  const names = toolNames(messages);
  const out: GContent[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    const parts: GPart[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b.type === 'image') {
        if (b.source.type === 'base64')
          parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
        else if (b.source.type === 'url') parts.push({ fileData: { fileUri: b.source.url } });
      } else if (b.type === 'tool_use') {
        const sig = (b as unknown as { thought_signature?: string }).thought_signature;
        parts.push({
          functionCall: {
            ...(b.id.startsWith('gemini_') ? {} : { id: b.id }),
            name: b.name,
            args: (b.input ?? {}) as Record<string, unknown>,
          },
          ...(sig ? { thoughtSignature: sig } : {}),
        });
      } else if (b.type === 'tool_result') {
        const text = toolResultText(b.content);
        parts.push({
          functionResponse: {
            ...(b.tool_use_id.startsWith('gemini_') ? {} : { id: b.tool_use_id }),
            name: names.get(b.tool_use_id) ?? 'tool',
            response: b.is_error ? { error: text } : { result: text },
          },
        });
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
};

export const buildGeminiBody = (req: AiCompletionRequest) => {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(req.messages),
    generationConfig: { maxOutputTokens: req.maxTokens ?? 16000 },
  };
  const sys = systemText(req.system);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (req.tools?.length) {
    // `parametersJsonSchema` takes a full JSON Schema (the OpenAPI-subset `parameters` refuses several keywords).
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parametersJsonSchema: t.input_schema,
        })),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return body;
};

/** Gemini usage → the neutral usage (cached prompt tokens are cache reads; thinking tokens are output). */
export const geminiUsage = (u: GUsage | undefined): AiUsage => {
  const cached = u?.cachedContentTokenCount ?? 0;
  return {
    input_tokens: Math.max(0, (u?.promptTokenCount ?? 0) - cached),
    output_tokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
};

const REFUSED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

const stopOf = (finish: string | undefined, hasCalls: boolean, blocked: boolean) => {
  if (blocked || (finish && REFUSED.has(finish))) return 'refusal';
  if (hasCalls) return 'tool_use';
  if (finish === 'MAX_TOKENS') return 'max_tokens';
  if (!finish || finish === 'STOP' || finish === 'FINISH_REASON_UNSPECIFIED') return 'end_turn';
  return finish.toLowerCase();
};

const toCompletion = (
  req: AiCompletionRequest,
  r: { model?: string; parts: GPart[]; finish?: string; blocked: boolean; usage: AiUsage },
): AiCompletion => {
  const text = r.parts.flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join('');
  const calls = r.parts.filter((p) => p.functionCall);
  const stopReason = stopOf(r.finish, calls.length > 0, r.blocked);
  const content: Anthropic.ContentBlock[] = [];
  if (text && stopReason !== 'refusal') content.push(textBlock(text));
  calls.forEach((p, i) =>
    content.push(
      toolUseBlock(
        p.functionCall!.id || `gemini_${i}_${p.functionCall!.name}`,
        p.functionCall!.name,
        parseArgs(p.functionCall!.args),
        p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {},
      ),
    ),
  );
  return {
    model: r.model || req.model,
    text: stopReason === 'refusal' ? '' : text,
    stopReason,
    usage: r.usage,
    costUsd: aiCost(r.usage, req.price),
    content,
  };
};

// --- images (AI images) ----

type ImagenResponse = {
  predictions?: { bytesBase64Encoded?: string; mimeType?: string; raiFilteredReason?: string }[];
};

/** The aspect ratios Imagen takes; a size `WxH` maps to the nearest one. */
const IMAGEN_RATIOS: [string, number][] = [
  ['1:1', 1],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9],
];

export const imagenAspect = (size: string | null | undefined): string | null => {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '');
  if (!m) return null;
  const r = Number(m[1]) / Number(m[2]);
  return IMAGEN_RATIOS.reduce((best, cur) => (Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best))[0];
};

export const buildImagenBody = (req: AiImageRequest) => {
  const aspect = imagenAspect(req.size);
  return {
    instances: [{ prompt: req.prompt }],
    parameters: { sampleCount: Math.max(1, req.n ?? 1), ...(aspect ? { aspectRatio: aspect } : {}) },
  };
};

/**
 * A Gemini image model's request: the description, and (image to image) the pictures it starts
 * from as inline image parts after it.
 */
export const buildGeminiImageBody = (req: AiImageRequest, images: AiInputImage[] = []) => ({
  contents: [
    {
      role: 'user',
      parts: [
        { text: req.prompt },
        ...images.map((img) => ({
          inlineData: { mimeType: img.mime, data: Buffer.from(img.data).toString('base64') },
        })),
      ],
    },
  ],
  generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
});

const isImagen = (model: string) => /^imagen/i.test(model.replace(/^models\//, ''));

const modelPath = (model: string) => (model.startsWith('models/') ? model : `models/${model}`);

export const createGeminiClient = (conn: AiConnectionSecret, fetchFn: FetchLike): AiClient => {
  const base = trimBase(conn.baseUrl || GEMINI_BASE_URL);
  const headers = { 'x-goog-api-key': conn.apiKey };
  const listModels = async (): Promise<ProviderModel[]> => {
    const out: ProviderModel[] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await callJson<{
        models?: {
          name?: string;
          displayName?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }[];
        nextPageToken?: string;
      }>(fetchFn, `${base}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, {
        method: 'GET',
        headers,
        timeoutMs: LIST_TIMEOUT_MS,
      });
      for (const m of res.models ?? []) {
        const methods = m.supportedGenerationMethods ?? [];
        // Imagen makes images (AI images) through `predict`; every other model must answer `generateContent`.
        const imagen = /imagen/i.test(m.name ?? '') && methods.includes('predict');
        if (!m.name || (!imagen && !methods.includes('generateContent'))) continue;
        if (!imagen && /embedding|aqa|imagen|veo/i.test(m.name)) continue;
        const id = m.name.replace(/^models\//, '');
        out.push({
          id,
          display_name: m.displayName || id,
          created_at: null,
          ...(m.inputTokenLimit ? { capabilities: { max_context: m.inputTokenLimit } } : {}),
        });
      }
      if (!res.nextPageToken) break;
      token = res.nextPageToken;
    }
    return newestFirst(out);
  };
  const generateImage = async (req: AiImageRequest): Promise<AiImageResult> => {
    const n = Math.max(1, req.n ?? 1);
    const inputs = checkInputImages(req.images, inputImageLimit('gemini', req.model));
    // Imagen (`predict`) makes pictures from text only.
    if (inputs.length && isImagen(req.model)) throw new Error('ai_model_no_image_edit');
    if (isImagen(req.model)) {
      const res = await callJson<ImagenResponse>(fetchFn, `${base}/${modelPath(req.model)}:predict`, {
        method: 'POST',
        headers,
        body: buildImagenBody(req),
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const images: AiImage[] = [];
      let filtered: string | null = null;
      for (const p of res.predictions ?? []) {
        if (p.raiFilteredReason) filtered = p.raiFilteredReason;
        const img = p.bytesBase64Encoded ? imageFromBase64(p.bytesBase64Encoded) : null;
        if (img) images.push(img);
      }
      // Imagen leaves out (or marks) what its safety filter dropped.
      if (!images.length && (filtered || !res.predictions?.length)) throw new AiContentPolicyError(filtered);
      return { model: req.model, images: images.slice(0, n), usage: null };
    }
    // Gemini's image models answer `generateContent` with image parts — one image per call.
    const images: AiImage[] = [];
    const usage: AiUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    for (let i = 0; i < n; i += 1) {
      const res = await callJson<GResponse>(fetchFn, `${base}/${modelPath(req.model)}:generateContent`, {
        method: 'POST',
        headers,
        body: buildGeminiImageBody(req, inputs),
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const u = geminiUsage(res.usageMetadata);
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      const cand = res.candidates?.[0];
      const made = (cand?.content?.parts ?? []).flatMap((p) =>
        p.inlineData?.data && /^image\//.test(p.inlineData.mimeType) ? [imageFromBase64(p.inlineData.data)] : [],
      );
      for (const img of made) if (img) images.push(img);
      const refused = !!res.promptFeedback?.blockReason || (!!cand?.finishReason && REFUSED.has(cand.finishReason));
      if (!made.length && refused) {
        const text = (cand?.content?.parts ?? []).flatMap((p) => (p.text ? [p.text] : [])).join(' ');
        throw new AiContentPolicyError(
          text.slice(0, 300) || res.promptFeedback?.blockReason || cand?.finishReason || null,
        );
      }
    }
    return { model: req.model, images, usage };
  };
  return {
    provider: conn.provider,
    generateImage,
    complete: async (req) => {
      const body = buildGeminiBody(req);
      const stream = !!req.onText && req.stream !== false;
      if (!stream) {
        const res = await callJson<GResponse>(fetchFn, `${base}/${modelPath(req.model)}:generateContent`, {
          method: 'POST',
          headers,
          body,
          timeoutMs: CALL_TIMEOUT_MS,
        });
        const cand = res.candidates?.[0];
        const out = toCompletion(req, {
          model: res.modelVersion,
          parts: cand?.content?.parts ?? [],
          finish: cand?.finishReason,
          blocked: !!res.promptFeedback?.blockReason,
          usage: geminiUsage(res.usageMetadata),
        });
        if (req.onText && out.text) req.onText(out.text);
        return out;
      }
      const res = await send(fetchFn, `${base}/${modelPath(req.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers,
        body,
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const parts: GPart[] = [];
      let finish: string | undefined;
      let blocked = false;
      let usage: GUsage | undefined;
      let model: string | undefined;
      for await (const raw of sseEvents(res)) {
        const ev = raw as GResponse;
        if (ev.modelVersion) model = ev.modelVersion;
        if (ev.usageMetadata) usage = ev.usageMetadata;
        if (ev.promptFeedback?.blockReason) blocked = true;
        const cand = ev.candidates?.[0];
        if (cand?.finishReason) finish = cand.finishReason;
        for (const p of cand?.content?.parts ?? []) {
          parts.push(p);
          if (p.text && !p.thought) req.onText?.(p.text);
        }
      }
      return toCompletion(req, { model, parts, finish, blocked, usage: geminiUsage(usage) });
    },
    test: async () => {
      try {
        await listModels();
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: safeAiError(err) };
      }
    },
    listModels,
  };
};
