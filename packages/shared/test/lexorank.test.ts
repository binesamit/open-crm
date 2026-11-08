// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { initialRanks, rankBetween } from '../src';

describe('rankBetween', () => {
  it('orders inserts at start, middle and end', () => {
    const first = rankBetween(null, null);
    const end = rankBetween(first, null);
    const start = rankBetween(null, first);
    const mid = rankBetween(first, end);
    expect([end, mid, start, first].sort()).toEqual([start, first, mid, end]);
  });

  it('keeps finding room when inserting repeatedly at the same spot', () => {
    let lo = rankBetween(null, null);
    const hi = rankBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const next = rankBetween(lo, hi);
      expect(next > lo && next < hi).toBe(true);
      lo = next;
    }
    expect(lo.length).toBeLessThan(64);
  });

  it('appending keeps keys short (perf review: they grew one character every ~5 appends)', () => {
    let p: string | null = null;
    for (let i = 0; i < 50_000; i++) {
      const next = rankBetween(p, null);
      if (p) expect(next > p).toBe(true);
      expect(next.endsWith('0')).toBe(false);
      p = next;
    }
    expect(p!.length).toBeLessThanOrEqual(8);
    // Legacy long keys (made before) still get a short successor.
    expect(rankBetween('0|zzzzzzzzzzzzi', null).length).toBeLessThan(20);
  });

  it('stays ordered under random inserts at the end, the start and in between', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const list: string[] = [rankBetween(null, null)];
    for (let i = 0; i < 3000; i++) {
      const r = rnd();
      if (r < 0.4) list.push(rankBetween(list.at(-1), null));
      else if (r < 0.6) list.unshift(rankBetween(null, list[0]));
      else {
        const at = Math.floor(rnd() * (list.length - 1));
        list.splice(at + 1, 0, rankBetween(list[at], list[at + 1]));
      }
    }
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });

  it('rejects inverted neighbours', () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    expect(() => rankBetween(b, a)).toThrow();
  });

  it('seeds increasing ranks', () => {
    const ranks = initialRanks(7);
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(7);
  });
});
