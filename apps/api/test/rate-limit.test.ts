// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/rate-limit';

describe('RateLimiter', () => {
  it('allows `limit` hits per window and key, then reports the wait until the window resets', () => {
    const l = new RateLimiter(3, 1000);
    expect([l.hit('a', 0), l.hit('a', 100), l.hit('a', 200)]).toEqual([0, 0, 0]);
    expect(l.hit('a', 400)).toBe(600);
    expect(l.hit('b', 400)).toBe(0);
    expect(l.hit('a', 1000)).toBe(0);
  });
});
