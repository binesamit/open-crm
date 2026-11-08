// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sortable position keys (02 §0, 07 §3): `0|<key>` where <key> is a base-36 fractional string.
 * Inserting between two neighbours never renumbers; keys only grow when inserting repeatedly at one spot.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BUCKET = '0|';

const digit = (ch: string | undefined): number => (ch === undefined ? 0 : DIGITS.indexOf(ch));

/** Returns a key strictly between a and b (b = null means +∞). Preconditions: a < b, no trailing '0'. */
const midpoint = (a: string, b: string | null): string => {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0]) : 0;
  const db = b !== null ? digit(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
};

const strip = (rank: string | null | undefined): string | null => {
  if (rank == null) return null;
  if (!rank.startsWith(BUCKET)) throw new Error(`invalid rank: ${rank}`);
  return rank.slice(BUCKET.length);
};

/**
 * A key just after `a` (appending to the end of a list): `a` read as a base-36 fraction plus one unit at a depth
 * that leaves room for ~36³ more appends — so keys grow by one character per ~36× more appends. Halving the
 * distance to +∞ (`midpoint(a, null)`) grew them by one character every ~5 appends: 30k items added at the
 * bottom of a group carried ~6 KB positions (perf review). Never ends in '0'.
 */
const after = (a: string): string => {
  let k = 0;
  while (a[k] === 'z') k++;
  const depth = Math.max(a.length, k + 3);
  const d = [...a.padEnd(depth, '0')].map(digit);
  let i = depth - 1;
  while (d[i] === DIGITS.length - 1) d[i--] = 0; // stops at or after k: a[k] is not 'z'
  d[i]! += 1;
  return d
    .slice(0, i + 1)
    .map((x) => DIGITS[x])
    .join('');
};

/** Position between `before` and `after` (either may be null for list start/end). */
export const rankBetween = (before?: string | null, after_?: string | null): string => {
  const a = strip(before) ?? '';
  const b = strip(after_);
  if (b !== null && a >= b) throw new Error(`rankBetween: ${before} must sort before ${after_}`);
  return BUCKET + (b === null && a ? after(a) : midpoint(a, b));
};

/** `count` evenly growing positions for seeding a fresh list. */
export const initialRanks = (count: number): string[] => {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
};
