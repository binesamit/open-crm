// SPDX-License-Identifier: AGPL-3.0-only
const pad = (n: string) => n.padStart(2, '0');

/** Day / month order of a written date: Israel and most of the world write the day first; the US the month. */
export type DateOrder = 'dmy' | 'mdy';

/** The order an account's date format writes (A3 `locale.date_format`): `MM/DD/YYYY` → month first. */
export const dateOrderOf = (dateFormat: string | undefined | null): DateOrder =>
  dateFormat && /^M/.test(dateFormat.trim()) ? 'mdy' : 'dmy';

/**
 * `YYYY-MM-DD` (also `YYYY/MM/DD`), `DD/MM/YYYY`, `D.M.YY` (day first, as in Israel — or month first with
 * `order: 'mdy'`) → ISO date, else null.
 */
export const parseDateText = (s: string, order: DateOrder = 'dmy'): string | null => {
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  let iso: string | null = null;
  if (m) iso = `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const [day, month] = order === 'mdy' ? [m[2]!, m[1]!] : [m[1]!, m[2]!];
    iso = `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${pad(month)}-${pad(day)}`;
  }
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
};

/** Direction marks and no-break spaces that text copied from right-to-left pages carries around numbers. */
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u00a0\u202f]/g;
/** Currency signs and words a written amount may carry (they are dropped, the number stays). */
const CURRENCY_RE = /(ש["״']?ח|nis|ils|usd|eur|gbp|[₪$€£%])/giu;

/**
 * A written number → number, else undefined (paste, bulk edit, column conversion): spaces, thousands commas,
 * currency signs and words (₪ $ € £ %, ש"ח, NIS…) and RTL direction marks are dropped; `(1,250)` and a trailing
 * minus (`1250-`, as RTL text often shows a negative) are negative.
 */
export const parseNumberText = (text: string): number | undefined => {
  let t = text.replace(BIDI_RE, '').replace(CURRENCY_RE, '').replace(/[\s,]/g, '');
  let sign = 1;
  const paren = /^\((.+)\)$/.exec(t);
  if (paren) {
    t = paren[1]!;
    sign = -1;
  } else if (/^[^-].*-$/.test(t)) {
    t = t.slice(0, -1);
    sign = -1;
  }
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return undefined;
  const n = Number(t) * sign;
  return Number.isFinite(n) ? n : undefined;
};
