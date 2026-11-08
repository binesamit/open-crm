// SPDX-License-Identifier: AGPL-3.0-only
import { type AnthropicLike, createAnthropicClient } from './anthropic';
import { createGeminiClient } from './gemini';
import { createOpenAiClient } from './openai';
import { createSonioxClient } from './soniox';
import type { AiClient, AiConnectionSecret, FetchLike } from './types';

/**
 * Server-only AI clients (the planning notes "AGENTS-MCP" §3.2, D26; "AI to any provider"): one adapter per
 * provider behind one interface — complete (with streaming and tool calls), test, list models — each answering in
 * the same neutral shape (text, tool_use blocks, stop reason, usage → cost). Kept out of @bines/shared, which also
 * runs in the browser — like @bines/server-mail. Transports are injectable so tests never reach a provider:
 * `anthropic` (the SDK client) and `fetch` (OpenAI, Gemini, OpenAI-compatible; the api passes an SSRF-guarded one).
 */
export const createAiClient = (
  conn: AiConnectionSecret,
  opts: { anthropic?: AnthropicLike; fetch?: FetchLike } = {},
): AiClient => {
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  switch (conn.provider) {
    case 'anthropic':
      return createAnthropicClient(conn, opts.anthropic);
    case 'openai':
      return createOpenAiClient(conn, fetchFn, { compatible: false });
    case 'openai_compatible':
      return createOpenAiClient(conn, fetchFn, { compatible: true });
    case 'gemini':
      return createGeminiClient(conn, fetchFn);
    case 'soniox':
      return createSonioxClient(conn, fetchFn);
    default:
      throw new Error(`Unknown AI provider ${conn.provider as string}`);
  }
};

export * from './types';
export { type AnthropicLike, buildParams, FALLBACK_BETA } from './anthropic';
export { createSonioxClient, SONIOX_BASE_URL, SONIOX_WAIT_MS } from './soniox';
export {
  buildOpenAiBody,
  buildOpenAiTranscribeFields,
  buildOpenAiImageBody,
  buildOpenAiImageEditFields,
  openAiImageUsage,
  openAiUsage,
  OPENAI_BASE_URL,
  toOpenAiMessages,
} from './openai';
export {
  buildGeminiBody,
  buildGeminiImageBody,
  buildImagenBody,
  GEMINI_BASE_URL,
  geminiUsage,
  imagenAspect,
  toGeminiContents,
} from './gemini';
export { multipartBody, ProviderHttpError, retryAfterOf, sseEvents } from './http';
export { AiContentPolicyError, aiRetryReason, type AiRetryReason, safeAiError } from './errors';
export {
  AI_INPUT_IMAGE_MIMES,
  checkInputImages,
  fitInputImages,
  imageFromBase64,
  inputImageLimit,
  type InputImageLimit,
  isProviderResultUrl,
  MAX_AI_IMAGE_BYTES,
  sniffImageMime,
} from './images';
export {
  scriptedAnswer,
  scriptedAnthropic,
  scriptedCalls,
  scriptedImage,
  scriptedModels,
  TINY_PNG_BASE64,
} from './scripted';
