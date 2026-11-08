// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import { aiRetryReason, type AiRetryReason } from '@bines/server-ai';

/**
 * Trying an AI call again ("the system doesn't create all my images"): a provider that rate limits
 * (429), times out, is down for a moment (5xx) or a dropped connection is tried again after a wait that doubles
 * each time (with jitter, so parallel runs do not retry together), or after the provider's own `Retry-After`. A
 * content-policy refusal, a bad key or another 4xx is never tried again. Used by the AI image column's queue (one
 * job per design, the wait between jobs) and in-process by the `generate_image` tool and automation action.
 */
export type RetryPolicy = {
  /** Calls in all (the first one included). */
  attempts: number;
  /** The first wait; doubled after each failure, up to `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** The longest `Retry-After` honoured; a longer one is cut to this. */
  maxAfterMs: number;
};

/** The AI column's designs (queued — nothing waits in a request): 5 tries over a few minutes. */
export const UNIT_RETRY: RetryPolicy = { attempts: 5, baseMs: 10_000, maxMs: 120_000, maxAfterMs: 10 * 60_000 };
/** In-process (the tool, the automation action): 3 tries within about half a minute. */
export const CALL_RETRY: RetryPolicy = { attempts: 3, baseMs: 2_000, maxMs: 15_000, maxAfterMs: 30_000 };

/** Time and chance, replaceable in tests (fake waits, no jitter). */
export const aiRetryClock = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  now: () => Date.now(),
};

export type RetryInfo = { reason: AiRetryReason; retryAfterMs: number | null };

/** Whether an error may succeed when tried again: a provider error, or one `imageError` wrapped (`details.retry`). */
export const retryOf = (err: unknown): RetryInfo | null => {
  if (err instanceof AppError) {
    const r = err.details?.retry as { reason?: AiRetryReason; after_ms?: number | null } | undefined;
    return r?.reason ? { reason: r.reason, retryAfterMs: r.after_ms ?? null } : null;
  }
  return aiRetryReason(err);
};

/** The wait after the `attempt`-th failed try (1 = the first): the provider's own when it said, else backoff. */
export const retryDelayMs = (policy: RetryPolicy, attempt: number, retryAfterMs: number | null) => {
  // Up to a second of jitter after the provider's wait; ±25% around the doubled wait otherwise.
  if (retryAfterMs !== null)
    return Math.min(retryAfterMs, policy.maxAfterMs) + Math.round(aiRetryClock.random() * 1000);
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.75 + aiRetryClock.random() * 0.5));
};

/** `fn` tried again on a retryable error within `policy` (in this process — for callers that wait anyway). */
export const withAiRetry = async <T>(fn: () => Promise<T>, policy: RetryPolicy = CALL_RETRY): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const r = retryOf(err);
      if (!r || attempt >= policy.attempts) throw err;
      await aiRetryClock.sleep(retryDelayMs(policy, attempt, r.retryAfterMs));
    }
  }
};
