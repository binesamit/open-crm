// SPDX-License-Identifier: AGPL-3.0-only
import Anthropic from '@anthropic-ai/sdk';
import { ProviderHttpError } from './http';

/**
 * The provider refused to make an image for safety reasons (AI images): OpenAI's `content_policy_violation` /
 * `moderation_blocked`, Gemini's `IMAGE_SAFETY` / blocked prompt, Imagen's filtered answer. `providerMessage` is the
 * provider's own short explanation (no key, no request) — shown to the person, who can then change the description.
 */
export class AiContentPolicyError extends Error {
  constructor(readonly providerMessage: string | null) {
    super('ai_content_policy');
    this.name = 'AiContentPolicyError';
  }
}

/** An error message safe to store and show: no key, no request body — the API's own status, as a short code. */
export const safeAiError = (err: unknown): string => {
  if (err instanceof AiContentPolicyError) return 'ai_content_policy';
  if (err instanceof Anthropic.AuthenticationError) return 'invalid_api_key';
  if (err instanceof Anthropic.PermissionDeniedError) return 'permission_denied';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (err instanceof Anthropic.APIError) return `api_error_${err.status ?? 'network'}`;
  if (err instanceof ProviderHttpError) {
    if (err.status === 401) return 'invalid_api_key';
    if (err.status === 403) return 'permission_denied';
    if (err.status === 429) return 'rate_limited';
    return `api_error_${err.status}`;
  }
  if (err instanceof Error && /^ai_[a-z_]+$/.test(err.message)) return err.message;
  return 'unreachable';
};

/**
 * Why a failed call may succeed when tried again ("not all my images are made"): the provider rate
 * limits (429), timed out (408, our own timeout), is down for a moment (5xx, Anthropic's 529) or the network failed.
 * null = trying again would fail the same way (a content-policy refusal, a bad key, a 4xx validation error, an
 * address the guard blocks). `retryAfterMs` = the provider's own wait, when it sent one.
 */
export type AiRetryReason = 'rate_limited' | 'timeout' | 'provider_unavailable' | 'network';
export const aiRetryReason = (err: unknown): { reason: AiRetryReason; retryAfterMs: number | null } | null => {
  if (err instanceof AiContentPolicyError) return null;
  if (err instanceof ProviderHttpError) {
    const after = err.retryAfterMs;
    // OpenAI answers 429 also when the account has no credit left: waiting does not help.
    if (err.status === 429 && err.providerCode === 'insufficient_quota') return null;
    if (err.status === 429) return { reason: 'rate_limited', retryAfterMs: after };
    if (err.status === 408) return { reason: 'timeout', retryAfterMs: after };
    if (err.status >= 500) return { reason: 'provider_unavailable', retryAfterMs: after };
    return null;
  }
  if (err instanceof Anthropic.RateLimitError) return { reason: 'rate_limited', retryAfterMs: null };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { reason: 'timeout', retryAfterMs: null };
  if (err instanceof Anthropic.APIConnectionError) return { reason: 'network', retryAfterMs: null };
  if (err instanceof Anthropic.APIError)
    return (err.status ?? 0) >= 500 ? { reason: 'provider_unavailable', retryAfterMs: null } : null;
  if (!(err instanceof Error)) return null;
  // AbortSignal.timeout → TimeoutError; an aborted fetch → AbortError.
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return { reason: 'timeout', retryAfterMs: null };
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && TIMEOUT_CODES.has(code)) return { reason: 'timeout', retryAfterMs: null };
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return { reason: 'network', retryAfterMs: null };
  // undici: `TypeError: fetch failed` (its cause says why; none known = a dropped connection).
  if (err instanceof TypeError && err.message === 'fetch failed') return { reason: 'network', retryAfterMs: null };
  return null;
};

const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
]);
