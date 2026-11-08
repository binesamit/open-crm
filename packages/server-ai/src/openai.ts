// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { aiCost, type AiUsage, isImageModelId, newestFirst, type ProviderModel } from '@bines/shared';
import {
  callJson,
  type FormField,
  multipartBody,
  parseArgs,
  ProviderHttpError,
  send,
  sseEvents,
  systemText,
  textBlock,
  toolResultText,
  toolUseBlock,
  trimBase,
} from './http';
import { AiContentPolicyError, safeAiError } from './errors';
import { checkInputImages, downloadImage, imageFromBase64, inputImageLimit, isProviderResultUrl } from './images';
import type {
  AiClient,
  AiCompletion,
  AiCompletionRequest,
  AiConnectionSecret,
  AiImage,
  AiImageRequest,
  AiInputImage,
  AiImageResult,
  AiTranscribeRequest,
  AiTranscription,
  FetchLike,
} from './types';

/**
 * OpenAI and OpenAI-compatible servers (Mistral, Groq, OpenRouter, DeepSeek, Ollama, LM Studio …) over the Chat
 * Completions API (`POST {base}/chat/completions`, `GET {base}/models`), with plain fetch — no SDK in the deps.
 * The neutral (Anthropic-shaped) request is mapped onto it and the answer back: text, tool calls, stop reason, usage.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const CALL_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 8000;

type OaMessage =
  | { role: 'system' | 'user'; content: string | OaPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OaToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type OaPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OaToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type OaUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};
type OaResponse = {
  model?: string;
  choices?: {
    message?: { content?: string | null; refusal?: string | null; tool_calls?: OaToolCall[] | null };
    finish_reason?: string | null;
  }[];
  usage?: OaUsage | null;
};

const imageUrl = (b: Anthropic.ImageBlockParam) =>
  b.source.type === 'base64'
    ? `data:${b.source.media_type};base64,${b.source.data}`
    : b.source.type === 'url'
      ? b.source.url
      : null;

/** Anthropic-shaped messages → Chat Completions messages (thinking blocks are the Anthropic model's own: dropped). */
export const toOpenAiMessages = (
  system: AiCompletionRequest['system'],
  messages: Anthropic.MessageParam[],
): OaMessage[] => {
  const out: OaMessage[] = [];
  const sys = systemText(system);
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls: OaToolCall[] = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      );
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results first (they must follow the assistant's tool calls), then what the person wrote.
    const parts: OaPart[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result')
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: (b.is_error ? 'ERROR: ' : '') + toolResultText(b.content),
        });
      else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        const url = imageUrl(b);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length)
      out.push({
        role: 'user',
        content: parts.every((p) => p.type === 'text')
          ? parts.map((p) => (p as { text: string }).text).join('\n')
          : parts,
      });
  }
  return out;
};

/** Reasoning models take `reasoning_effort` (low / medium / high); the others refuse it. */
const reasoningModel = (model: string) => /^(o\d|gpt-5)/i.test(model);
const effortOf = (e: NonNullable<AiCompletionRequest['effort']>) => (e === 'low' || e === 'medium' ? e : 'high');

export const buildOpenAiBody = (req: AiCompletionRequest, opts: { compatible: boolean; stream: boolean }) => {
  const body: Record<string, unknown> = { model: req.model, messages: toOpenAiMessages(req.system, req.messages) };
  // OpenAI's own API wants `max_completion_tokens` (reasoning models refuse `max_tokens`); most compatible servers
  // still read `max_tokens`.
  body[opts.compatible ? 'max_tokens' : 'max_completion_tokens'] = req.maxTokens ?? 16000;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema },
    }));
    body.tool_choice = 'auto';
  }
  if (req.effort && !opts.compatible && reasoningModel(req.model)) body.reasoning_effort = effortOf(req.effort);
  if (opts.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
};

/** Chat Completions usage → the neutral usage (cached prompt tokens are cache reads, the rest input). */
export const openAiUsage = (u: OaUsage | null | undefined): AiUsage => {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
};

const stopOf = (finish: string | null | undefined, hasCalls: boolean, refused: boolean) => {
  if (refused || finish === 'content_filter') return 'refusal';
  if (hasCalls || finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'stop' || !finish) return 'end_turn';
  return finish;
};

const toCompletion = (
  req: AiCompletionRequest,
  r: {
    model?: string;
    text: string;
    refusal: string | null;
    calls: OaToolCall[];
    finish: string | null;
    usage: AiUsage;
  },
): AiCompletion => {
  const stopReason = stopOf(r.finish, r.calls.length > 0, !!r.refusal);
  const content: Anthropic.ContentBlock[] = [];
  if (r.text && stopReason !== 'refusal') content.push(textBlock(r.text));
  r.calls.forEach((c, i) =>
    content.push(toolUseBlock(c.id || `call_${i}`, c.function.name, parseArgs(c.function.arguments))),
  );
  return {
    model: r.model || req.model,
    text: stopReason === 'refusal' ? '' : r.text,
    stopReason,
    usage: r.usage,
    costUsd: aiCost(r.usage, req.price),
    content,
  };
};

// --- images (AI images): `POST {base}/images/generations`, `/images/edits` from pictures ----

type OaImageResponse = {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

/** Where OpenAI keeps the images it answers with by link (DALL·E's `url` answers). */
const OPENAI_RESULT_HOSTS = ['.blob.core.windows.net', '.openai.com'];

/**
 * The Images API request. DALL·E answers with a link unless asked for base64; gpt-image always answers in base64
 * and refuses `response_format`. `auto` size / quality = left to the provider (DALL·E does not take `auto`).
 */
export const buildOpenAiImageBody = (req: AiImageRequest, opts: { compatible: boolean }) => {
  const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, n: Math.max(1, req.n ?? 1) };
  if (req.size && req.size !== 'auto') body.size = req.size;
  if (req.quality && req.quality !== 'auto') body.quality = req.quality;
  if (!opts.compatible && /^dall-e/i.test(req.model)) body.response_format = 'b64_json';
  return body;
};

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Image to image: the `POST {base}/images/edits` form — the fields of a generation plus the
 * pictures. gpt-image takes several (`image[]`; one is sent as `image`, which every compatible server reads),
 * DALL·E 2 one square PNG, DALL·E 3 none (`ai_model_no_image_edit`). A compatible server decides for itself.
 */
export const buildOpenAiImageEditFields = (
  req: AiImageRequest,
  images: AiInputImage[],
  opts: { compatible: boolean },
): FormField[] => {
  if (!opts.compatible && /^dall-e-3/i.test(req.model)) throw new Error('ai_model_no_image_edit');
  const dalle2 = !opts.compatible && /^dall-e-2/i.test(req.model);
  if (dalle2 && (images.length !== 1 || images[0]!.mime !== 'image/png')) throw new Error('ai_image_edit_one_png');
  const fields: FormField[] = [
    ['model', req.model],
    ['prompt', req.prompt],
    ['n', String(Math.max(1, req.n ?? 1))],
  ];
  if (req.size && req.size !== 'auto') fields.push(['size', req.size]);
  if (req.quality && req.quality !== 'auto' && !dalle2) fields.push(['quality', req.quality]);
  if (!opts.compatible && /^dall-e/i.test(req.model)) fields.push(['response_format', 'b64_json']);
  const key = images.length > 1 ? 'image[]' : 'image';
  images.forEach((img, i) =>
    fields.push([key, { data: img.data, mime: img.mime, filename: `image-${i + 1}.${EXT[img.mime] ?? 'png'}` }]),
  );
  return fields;
};

/** gpt-image bills tokens: its usage → the neutral usage. */
export const openAiImageUsage = (u: NonNullable<OaImageResponse['usage']>): AiUsage => ({
  input_tokens: u.input_tokens ?? 0,
  output_tokens: u.output_tokens ?? 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/** OpenAI's safety refusals: `content_policy_violation` (DALL·E), `moderation_blocked` (gpt-image), or the wording. */
const isOpenAiPolicyError = (err: ProviderHttpError) =>
  err.status === 400 &&
  (err.providerCode === 'content_policy_violation' ||
    err.providerCode === 'moderation_blocked' ||
    /safety system|content policy/i.test(err.providerMessage ?? ''));

/** Models that are not chat models (OpenAI's list has them all): embeddings, speech, images, moderation … */
/** Speech-to-text models by name (OpenAI's `whisper-1`, `gpt-4o-transcribe`; Groq's `whisper-large-v3` …). */
const TRANSCRIBE_MODEL = /whisper|transcribe/i;

type OaTranscription = {
  text?: string;
  duration?: number;
  usage?: { type?: 'tokens' | 'duration'; input_tokens?: number; output_tokens?: number; seconds?: number };
};

/** The form of a transcription call: the file, the model, JSON back, and the language hint when there is one. */
export const buildOpenAiTranscribeFields = (req: AiTranscribeRequest): FormField[] => [
  ['file', { data: req.audio, mime: req.mime || 'application/octet-stream', filename: req.fileName || 'audio' }],
  ['model', req.model],
  ['response_format', 'json'],
  ...(req.language ? ([['language', req.language]] as FormField[]) : []),
];

const NOT_CHAT = /embedding|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|davinci|babbage|search|sora/i;

/**
 * A model's price as some servers list it (OpenRouter): USD per token as decimal strings
 * (`prompt` / `completion` / `input_cache_read` / `input_cache_write`) → USD per 1M tokens. A negative or missing
 * input / output price (OpenRouter's "auto" router says -1 = varies) is no price.
 */
export const listedPrice = (raw: unknown): ProviderModel['price'] | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const perM = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
  };
  const input = perM(p.prompt);
  const output = perM(p.completion);
  if (input === null || output === null) return undefined;
  return { input, output, cache_read: perM(p.input_cache_read), cache_write: perM(p.input_cache_write) };
};

export const createOpenAiClient = (
  conn: AiConnectionSecret,
  fetchFn: FetchLike,
  opts: { compatible: boolean },
): AiClient => {
  const base = trimBase(opts.compatible ? (conn.baseUrl ?? '') : conn.baseUrl || OPENAI_BASE_URL);
  const headers: Record<string, string> = conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {};
  const listModels = async (): Promise<ProviderModel[]> => {
    const res = await callJson<{ data?: Record<string, unknown>[] }>(fetchFn, `${base}/models`, {
      method: 'GET',
      headers,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const out: ProviderModel[] = [];
    for (const m of res.data ?? []) {
      const id = typeof m.id === 'string' ? m.id : '';
      // Image models (gpt-image, DALL·E) are listed too: they make images (AI images), not chat.
      if (!id || (!opts.compatible && NOT_CHAT.test(id) && !isImageModelId('openai', id))) continue;
      const created = typeof m.created === 'number' && m.created > 0 ? new Date(m.created * 1000).toISOString() : null;
      // Some servers (OpenRouter) say more: the context window and whether the model takes tools / images.
      const caps: ProviderModel['capabilities'] = {};
      const ctx = m.context_length ?? (m as { context_window?: unknown }).context_window;
      if (typeof ctx === 'number' && ctx > 0) caps.max_context = ctx;
      if (Array.isArray(m.supported_parameters)) caps.tools = (m.supported_parameters as unknown[]).includes('tools');
      const modalities = (m.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
      if (Array.isArray(modalities)) caps.vision = modalities.includes('image');
      const price = listedPrice(m.pricing);
      out.push({
        id,
        display_name: typeof m.name === 'string' && m.name ? m.name : id,
        created_at: created,
        ...(Object.keys(caps).length ? { capabilities: caps } : {}),
        ...(price ? { price } : {}),
      });
    }
    return newestFirst(out);
  };
  // Result links are fetched only from OpenAI's own storage, or from the connection's own server (compatible).
  const baseHost = (() => {
    try {
      return new URL(base).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const resultHost = (host: string) =>
    opts.compatible ? !!baseHost && host === baseHost : OPENAI_RESULT_HOSTS.some((h) => host.endsWith(h));
  const generateImage = async (req: AiImageRequest): Promise<AiImageResult> => {
    if (!base) throw new Error('ai_base_url_required');
    const inputs = checkInputImages(
      req.images,
      inputImageLimit(opts.compatible ? 'openai_compatible' : 'openai', req.model),
    );
    let res: OaImageResponse;
    try {
      res = inputs.length
        ? await callJson<OaImageResponse>(fetchFn, `${base}/images/edits`, {
            method: 'POST',
            headers,
            raw: multipartBody(buildOpenAiImageEditFields(req, inputs, { compatible: opts.compatible })),
            timeoutMs: CALL_TIMEOUT_MS,
          })
        : await callJson<OaImageResponse>(fetchFn, `${base}/images/generations`, {
            method: 'POST',
            headers,
            body: buildOpenAiImageBody(req, { compatible: opts.compatible }),
            timeoutMs: CALL_TIMEOUT_MS,
          });
    } catch (err) {
      if (err instanceof ProviderHttpError && isOpenAiPolicyError(err))
        throw new AiContentPolicyError(err.providerMessage);
      throw err;
    }
    const images: AiImage[] = [];
    for (const d of res.data ?? []) {
      if (typeof d.b64_json === 'string') {
        const img = imageFromBase64(d.b64_json, d.revised_prompt);
        if (img) images.push(img);
      } else if (typeof d.url === 'string' && isProviderResultUrl(d.url, resultHost)) {
        // The connection's own server may need its key; OpenAI's storage links carry their own signature.
        const img = await downloadImage(fetchFn, d.url, opts.compatible ? headers : {});
        if (img) images.push({ ...img, revisedPrompt: d.revised_prompt ?? null });
      }
    }
    return {
      model: req.model,
      images,
      usage: res.usage ? openAiImageUsage(res.usage) : null,
    };
  };
  // Speech to text: OpenAI's `/audio/transcriptions` — also Groq and other compatible servers.
  const transcribe = async (req: AiTranscribeRequest): Promise<AiTranscription> => {
    if (!base) throw new Error('ai_base_url_required');
    const res = await callJson<OaTranscription>(fetchFn, `${base}/audio/transcriptions`, {
      method: 'POST',
      headers,
      raw: multipartBody(buildOpenAiTranscribeFields(req)),
      timeoutMs: CALL_TIMEOUT_MS,
    });
    return {
      text: typeof res.text === 'string' ? res.text.trim() : '',
      model: req.model,
      durationSeconds:
        typeof res.duration === 'number'
          ? res.duration
          : res.usage?.type === 'duration' && typeof res.usage.seconds === 'number'
            ? res.usage.seconds
            : null,
      usage:
        res.usage?.type === 'tokens'
          ? { input_tokens: res.usage.input_tokens ?? 0, output_tokens: res.usage.output_tokens ?? 0 }
          : null,
    };
  };
  const listTranscriptionModels = async () => {
    const res = await callJson<{ data?: { id?: unknown; created?: unknown }[] }>(fetchFn, `${base}/models`, {
      method: 'GET',
      headers,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    return (res.data ?? [])
      .filter((m): m is { id: string; created?: unknown } => typeof m.id === 'string' && TRANSCRIBE_MODEL.test(m.id))
      .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
      .map((m) => ({ id: m.id, display_name: m.id }));
  };
  return {
    provider: conn.provider,
    generateImage,
    transcribe,
    listTranscriptionModels,
    complete: async (req) => {
      if (!base) throw new Error('ai_base_url_required');
      const stream = !!req.onText && req.stream !== false;
      const body = buildOpenAiBody(req, { compatible: opts.compatible, stream });
      const url = `${base}/chat/completions`;
      if (!stream) {
        const res = await callJson<OaResponse>(fetchFn, url, {
          method: 'POST',
          headers,
          body,
          timeoutMs: CALL_TIMEOUT_MS,
        });
        const choice = res.choices?.[0];
        const out = toCompletion(req, {
          model: res.model,
          text: choice?.message?.content ?? '',
          refusal: choice?.message?.refusal ?? null,
          calls: choice?.message?.tool_calls ?? [],
          finish: choice?.finish_reason ?? null,
          usage: openAiUsage(res.usage),
        });
        if (req.onText && out.text) req.onText(out.text);
        return out;
      }
      const res = await send(fetchFn, url, { method: 'POST', headers, body, timeoutMs: CALL_TIMEOUT_MS });
      let text = '';
      let refusal = '';
      let finish: string | null = null;
      let model: string | undefined;
      let usage: OaUsage | null = null;
      const calls: OaToolCall[] = [];
      for await (const raw of sseEvents(res)) {
        const ev = raw as {
          model?: string;
          usage?: OaUsage | null;
          choices?: {
            delta?: {
              content?: string | null;
              refusal?: string | null;
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
            finish_reason?: string | null;
          }[];
        };
        if (ev.model) model = ev.model;
        if (ev.usage) usage = ev.usage;
        const choice = ev.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta;
        if (d?.content) {
          text += d.content;
          req.onText?.(d.content);
        }
        if (d?.refusal) refusal += d.refusal;
        for (const tc of d?.tool_calls ?? []) {
          const i = tc.index ?? calls.length;
          const call = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.function.name += tc.function.name;
          if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
        }
      }
      return toCompletion(req, {
        model,
        text,
        refusal: refusal || null,
        calls: calls.filter(Boolean),
        finish,
        usage: openAiUsage(usage),
      });
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
