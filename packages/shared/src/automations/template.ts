// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 04 §4.3 — `{path}` / `{path|helper:arg|helper}` templates. The values come from a lookup the runner builds
 * from the fresh item snapshot (item.*, parent.*, created.*, board.*, actor, previous_value, payload.*, today…);
 * this module only parses and formats. Unknown paths render empty and add a warning. `{{` is a literal `{`.
 */

import { DEFAULT_REGION, localDateOf, localTimeOf, type Region } from '../locale/format';
import { parseNumberText } from '../columns/date-text';

export type TemplateLookup = (path: string) => unknown;
export type RenderOptions = {
  /** HTML contexts (email body, update body): values are escaped unless `|raw`. */
  html?: boolean;
  /** The account's region: `|date` without a pattern uses its date format and zone, `|currency` its currency. */
  region?: Region;
};
export type Rendered = { text: string; warnings: string[] };

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
/** A full instant with a zone (`…T10:00:00Z`, `…T10:00+03:00`); a bare `…T10:00` is not moved. */
const INSTANT_RE = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * `DD/MM/YYYY`-style tokens over a `YYYY-MM-DD…` string; anything else is returned as is. With a region, an
 * instant (`…T10:00:00Z`) is first moved to the region's timezone (a plain date never moves).
 */
export const formatDateTokens = (value: string, fmt: string, region?: Region) => {
  if (region && INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value))) {
    const at = new Date(value);
    value = `${localDateOf(at, region)}T${localTimeOf(at, region)}`;
  }
  const m = ISO_DATE_RE.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m;
  const time = /T(\d{2}):(\d{2})/.exec(value);
  return fmt
    .replace(/YYYY/g, y!)
    .replace(/YY/g, y!.slice(2))
    .replace(/MM/g, mo!)
    .replace(/DD/g, d!)
    .replace(/HH/g, time?.[1] ?? '00')
    .replace(/mm/g, time?.[2] ?? '00');
};

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
  return JSON.stringify(v);
};

/** A value as a number for `|number` / `|currency`: a column's text may carry a thousands separator (1,234.5). */
const numberOf = (v: unknown): number => {
  const text = asText(v);
  const plain = Number(text);
  return Number.isFinite(plain) ? plain : (parseNumberText(text) ?? Number.NaN);
};

type Helper = (value: unknown, arg: string | undefined, region: Region | undefined) => unknown;
const HELPERS: Record<string, Helper> = {
  upper: (v) => asText(v).toUpperCase(),
  lower: (v) => asText(v).toLowerCase(),
  trim: (v) => asText(v).trim(),
  truncate: (v, n) => {
    const s = asText(v);
    const max = Number(n ?? 80);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  },
  default: (v, d) => (asText(v) === '' ? (d ?? '') : v),
  number: (v, n) => {
    const x = numberOf(v);
    return Number.isFinite(x) ? x.toFixed(Number(n ?? 0)) : asText(v);
  },
  currency: (v, code, region) => {
    const x = numberOf(v);
    if (!Number.isFinite(x)) return asText(v);
    const r = region ?? DEFAULT_REGION;
    try {
      return new Intl.NumberFormat(r.language === 'en' ? 'en-US' : 'he-IL', {
        style: 'currency',
        currency: code?.trim() || r.currency,
      }).format(x);
    } catch {
      return x.toFixed(2);
    }
  },
  date: (v, fmt, region) => formatDateTokens(asText(v), fmt?.trim() || (region ?? DEFAULT_REGION).date_format, region),
  json: (v) => JSON.stringify(v ?? null),
  url: (v) => encodeURIComponent(asText(v)),
  first: (v) => (Array.isArray(v) ? v[0] : asText(v).split(', ')[0]),
  join: (v, sep) => (Array.isArray(v) ? v.map(asText).join(sep ?? ', ') : asText(v)),
};

/** Splits `path|a:1|b` (a helper arg may itself contain `:`). */
const parseExpr = (expr: string) => {
  const [path, ...helpers] = expr.split('|');
  return {
    path: (path ?? '').trim(),
    // An argument keeps its spaces (`|join: · `).
    helpers: helpers.map((h) => {
      const i = h.indexOf(':');
      return i < 0 ? { name: h.trim(), arg: undefined } : { name: h.slice(0, i).trim(), arg: h.slice(i + 1) };
    }),
  };
};

/** Evaluates one `{…}` expression to a raw value (before stringification). */
export const evaluateExpr = (expr: string, lookup: TemplateLookup, warnings: string[], region?: Region): unknown => {
  const { path, helpers } = parseExpr(expr);
  let value = lookup(path);
  if (value === undefined) {
    warnings.push(`unknown:${path}`);
    value = '';
  }
  for (const h of helpers) {
    if (h.name === 'html' || h.name === 'raw') continue;
    const fn = HELPERS[h.name];
    if (!fn) {
      warnings.push(`helper:${h.name}`);
      continue;
    }
    value = fn(value, h.arg, region);
  }
  return value;
};

export const renderTemplate = (template: string, lookup: TemplateLookup, opts: RenderOptions = {}): Rendered => {
  const warnings: string[] = [];
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (ch === '{' && template[i + 1] === '{') {
      out += '{';
      i++;
      continue;
    }
    if (ch !== '{') {
      out += ch;
      continue;
    }
    const end = template.indexOf('}', i + 1);
    if (end < 0) {
      out += template.slice(i);
      break;
    }
    const expr = template.slice(i + 1, end);
    const text = asText(evaluateExpr(expr, lookup, warnings, opts.region));
    const raw = parseExpr(expr).helpers.some((h) => h.name === 'raw');
    out += opts.html && !raw ? escapeHtml(text) : text;
    i = end;
  }
  return { text: out, warnings };
};

/** Renders every string inside a JSON-like value (webhook object payloads, `fixed` values). */
export const renderDeep = (value: unknown, lookup: TemplateLookup, warnings: string[], region?: Region): unknown => {
  if (typeof value === 'string') {
    // A whole-string `{x|json}` keeps the JSON type instead of a string.
    const whole = /^\{([^{}]+)\}$/.exec(value);
    if (whole && parseExpr(whole[1]!).helpers.some((h) => h.name === 'json'))
      return JSON.parse(String(evaluateExpr(whole[1]!, lookup, warnings, region)));
    const r = renderTemplate(value, lookup, { region });
    warnings.push(...r.warnings);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, lookup, warnings, region));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, lookup, warnings, region)]));
  return value;
};

/** Template paths used in a string — the builder's validation and `{` autocomplete read them. */
export const templatePaths = (template: string): string[] => {
  const out: string[] = [];
  const re = /(?<!\{)\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) out.push(parseExpr(m[1]!).path);
  return out;
};
