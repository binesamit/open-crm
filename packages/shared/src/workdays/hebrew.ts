// SPDX-License-Identifier: AGPL-3.0-only
import { parseIso, type IsoDate } from '../calendar';

/**
 * The Hebrew (Jewish) calendar date of a calendar day. Read from the runtime's own calendar
 * (Intl `u-ca-hebrew`, in every browser and in Node), so nothing is downloaded and a self-hosted install without
 * internet works the same. Dates are plain 'YYYY-MM-DD' and read at noon UTC: no timezone can move a day.
 */
export const HEBREW_MONTHS = [
  'tishri',
  'heshvan',
  'kislev',
  'tevet',
  'shevat',
  'adar1',
  'adar',
  'adar2',
  'nisan',
  'iyar',
  'sivan',
  'tamuz',
  'av',
  'elul',
] as const;
export type HebrewMonth = (typeof HEBREW_MONTHS)[number];

/** Intl's English month names → our keys (a leap year has Adar I + Adar II, a common year one Adar). */
const INTL_MONTH: Record<string, HebrewMonth> = {
  Tishri: 'tishri',
  Heshvan: 'heshvan',
  Kislev: 'kislev',
  Tevet: 'tevet',
  Shevat: 'shevat',
  'Adar I': 'adar1',
  Adar: 'adar',
  'Adar II': 'adar2',
  Nisan: 'nisan',
  Iyar: 'iyar',
  Sivan: 'sivan',
  Tamuz: 'tamuz',
  Av: 'av',
  Elul: 'elul',
};

const MONTH_HE: Record<HebrewMonth, string> = {
  tishri: 'תשרי',
  heshvan: 'חשוון',
  kislev: 'כסלו',
  tevet: 'טבת',
  shevat: 'שבט',
  adar1: 'אדר א׳',
  adar: 'אדר',
  adar2: 'אדר ב׳',
  nisan: 'ניסן',
  iyar: 'אייר',
  sivan: 'סיוון',
  tamuz: 'תמוז',
  av: 'אב',
  elul: 'אלול',
};
const MONTH_EN: Record<HebrewMonth, string> = {
  tishri: 'Tishrei',
  heshvan: 'Cheshvan',
  kislev: 'Kislev',
  tevet: 'Tevet',
  shevat: 'Shevat',
  adar1: 'Adar I',
  adar: 'Adar',
  adar2: 'Adar II',
  nisan: 'Nisan',
  iyar: 'Iyar',
  sivan: 'Sivan',
  tamuz: 'Tammuz',
  av: 'Av',
  elul: 'Elul',
};

export type HebrewDate = {
  day: number;
  month: HebrewMonth;
  /** e.g. 5787. A leap year has the months adar1 + adar2 where a common year has adar. */
  year: number;
};

let fmt: Intl.DateTimeFormat | null = null;
const formatter = () =>
  (fmt ??= new Intl.DateTimeFormat('en-u-ca-hebrew', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }));

const cache = new Map<IsoDate, HebrewDate>();

/** The Hebrew date of a calendar day ('YYYY-MM-DD'). */
export const hebrewDate = (iso: IsoDate): HebrewDate => {
  let h = cache.get(iso);
  if (h) return h;
  const { year, month, day } = parseIso(iso);
  const parts: Record<string, string> = {};
  for (const p of formatter().formatToParts(Date.UTC(year, month, day, 12))) parts[p.type] = p.value;
  const m = INTL_MONTH[parts.month ?? ''] ?? 'tishri';
  h = { day: Number(parts.day), month: m, year: Number(parts.year) };
  if (cache.size > 20_000) cache.clear();
  cache.set(iso, h);
  return h;
};

const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];

/** A number in Hebrew letters with geresh / gershayim: 9 → ט׳, 15 → ט״ו, 787 → תשפ״ז. */
export const gematria = (n: number): string => {
  let rest = Math.floor(Math.abs(n));
  let s = '';
  while (rest >= 400) {
    s += 'ת';
    rest -= 400;
  }
  if (rest >= 100) {
    s += HUNDREDS[Math.floor(rest / 100)];
    rest %= 100;
  }
  // 15 and 16 are written ט״ו and ט״ז, never as a name of God.
  if (rest === 15) s += 'טו';
  else if (rest === 16) s += 'טז';
  else s += TENS[Math.floor(rest / 10)]! + ONES[rest % 10]!;
  if (!s) return '';
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
};

export const hebrewMonthName = (month: HebrewMonth, lang: 'he' | 'en' = 'he') =>
  (lang === 'he' ? MONTH_HE : MONTH_EN)[month];

export type HebrewDateStyle =
  /** ט׳ (a day cell under the Gregorian number). */
  | 'day'
  /** ט׳ בתשרי. */
  | 'day_month'
  /** ט׳ בתשרי תשפ״ז. */
  | 'full';

/**
 * A Hebrew date as text. In Hebrew: letters (ט׳ בתשרי תשפ״ז); in English: numbers with the transliterated month
 * (9 Tishrei 5787).
 */
export const formatHebrewDate = (iso: IsoDate, style: HebrewDateStyle = 'full', lang: 'he' | 'en' = 'he'): string => {
  const h = hebrewDate(iso);
  if (lang !== 'he') {
    if (style === 'day') return String(h.day);
    const dm = `${h.day} ${MONTH_EN[h.month]}`;
    return style === 'day_month' ? dm : `${dm} ${h.year}`;
  }
  const day = gematria(h.day);
  if (style === 'day') return day;
  const dm = `${day} ב${MONTH_HE[h.month]}`;
  return style === 'day_month' ? dm : `${dm} ${gematria(h.year % 1000)}`;
};

/**
 * The Hebrew months a run of Gregorian days spans, as a calendar subtitle: "אלול תשפ״ו – תשרי תשפ״ז" /
 * "Elul 5786 – Tishrei 5787" (one month = one name; the year once when both share it).
 */
export const formatHebrewSpan = (from: IsoDate, to: IsoDate, lang: 'he' | 'en' = 'he'): string => {
  const a = hebrewDate(from);
  const b = hebrewDate(to);
  const name = (h: HebrewDate) => hebrewMonthName(h.month, lang);
  const year = (h: HebrewDate) => (lang === 'he' ? gematria(h.year % 1000) : String(h.year));
  if (a.month === b.month && a.year === b.year) return `${name(a)} ${year(a)}`;
  return a.year === b.year ? `${name(a)} – ${name(b)} ${year(b)}` : `${name(a)} ${year(a)} – ${name(b)} ${year(b)}`;
};
