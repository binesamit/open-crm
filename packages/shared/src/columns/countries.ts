// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ISO 3166-1 alpha-2 codes (the `country` column, 03 §3.5). Names are never stored here: they come from
 * `Intl.DisplayNames` in the reader's language, so the list is just the codes.
 */
export const COUNTRY_CODES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
).split(' ');

const CODE_SET = new Set(COUNTRY_CODES);
export const isCountryCode = (code: unknown): code is string => typeof code === 'string' && CODE_SET.has(code);

const names = new Map<string, Intl.DisplayNames | null>();
const displayNames = (language: string) => {
  let d = names.get(language);
  if (d === undefined) {
    try {
      d = new Intl.DisplayNames([language], { type: 'region' });
    } catch {
      d = null;
    }
    names.set(language, d);
  }
  return d;
};

/** A country's name in a language (`he` / `en` …); the code itself when the runtime has no name for it. */
export const countryName = (code: string, language = 'he'): string => {
  try {
    return displayNames(language)?.of(code) ?? code;
  } catch {
    return code;
  }
};

const norm = (s: string) =>
  s
    .trim()
    .toLocaleLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[.'’"]/g, '');

/** Other common ways to write a country (other tools' exports, everyday speech). */
const ALIASES: Record<string, string> = {
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  usa: 'US',
  america: 'US',
  'united states of america': 'US',
  ארהב: 'US',
  'ארצות הברית': 'US',
  אנגליה: 'GB',
  בריטניה: 'GB',
  holland: 'NL',
  'south korea': 'KR',
  russia: 'RU',
};

let index: Map<string, string> | null = null;
/** Code ← its name in Hebrew and English (and the code itself), built once. */
const nameIndex = () => {
  if (index) return index;
  index = new Map();
  for (const code of COUNTRY_CODES) {
    index.set(norm(code), code);
    for (const lang of ['en', 'he']) index.set(norm(countryName(code, lang)), code);
  }
  for (const [k, v] of Object.entries(ALIASES)) index.set(norm(k), v);
  return index;
};

/** A typed / pasted country — an ISO code, or its Hebrew / English name — as its code, else null. */
export const parseCountry = (text: string): string | null => {
  const t = text.trim();
  if (!t) return null;
  if (/^[A-Za-z]{2}$/.test(t) && CODE_SET.has(t.toUpperCase())) return t.toUpperCase();
  return nameIndex().get(norm(t)) ?? null;
};

/** The flag emoji of a code (regional indicator letters); the web draws an image where emoji flags are missing. */
export const flagEmoji = (code: string) =>
  /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
