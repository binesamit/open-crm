// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

/**
 * Fixed-window request counter per key, in process memory (01-ARCHITECTURE: "rate limit per actor; stricter per token").
 * The api runs as one instance; with more replicas each would count on its own, so the effective limit grows with them.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts one hit for `key`. Returns 0 when allowed, else the ms until the window resets. */
  hit(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.sweep(now);
      this.windows.set(key, { start: now, count: 1 });
      return 0;
    }
    if (w.count >= this.limit) return this.windowMs - (now - w.start);
    w.count += 1;
    return 0;
  }

  /** Like `hit`, with a per-key limit (API tokens carry their own); also reports what is left. */
  take(key: string, limit: number, now = Date.now()): { waitMs: number; remaining: number; resetMs: number } {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.sweep(now);
      this.windows.set(key, { start: now, count: 1 });
      return { waitMs: 0, remaining: limit - 1, resetMs: this.windowMs };
    }
    const resetMs = this.windowMs - (now - w.start);
    if (w.count >= limit) return { waitMs: resetMs, remaining: 0, resetMs };
    w.count += 1;
    return { waitMs: 0, remaining: limit - w.count, resetMs };
  }

  /** The wait `hit` would report, without counting a hit (e.g. counting failures only). */
  peek(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs || w.count < this.limit) return 0;
    return this.windowMs - (now - w.start);
  }

  /** Like `peek`, with a per-key limit (`take`'s): the wait without counting. */
  waitFor(key: string, limit: number, now = Date.now()): number {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs || w.count < limit) return 0;
    return this.windowMs - (now - w.start);
  }

  /** Forgets every window (tests). */
  clear() {
    this.windows.clear();
  }

  private sweep(now: number) {
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}

/** Middleware: 429 `rate_limited` with `Retry-After` (seconds) once `key(c)` used up its window. */
export const rateLimit =
  (limiter: RateLimiter, key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const waitMs = limiter.hit(key(c));
    if (waitMs > 0) {
      c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
      throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: waitMs });
    }
    await next();
  };
