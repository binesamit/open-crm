// SPDX-License-Identifier: AGPL-3.0-only
import {
  columnTypes,
  type FormAnswer,
  formInputOf,
  locationFromText,
  parseCellValue,
  SECRET_CHECKED,
  SECRET_LIMITS,
  SECRET_UNCHECKED,
  secretSettingsOf,
  secretValueFor,
} from '@bines/shared';

/** A board column as the form needs it. */
export type FormColumn = { key: string; type: string; title: string; settings: unknown };

/**
 * What an answer becomes on the new item: the item's name, a cell value (null = leave empty), people (checked
 * against the account's members by the caller) or uploads to attach to a file column.
 */
export type Converted =
  | { ok: true; kind: 'name'; value: string }
  | { ok: true; kind: 'cell'; value: unknown }
  | { ok: true; kind: 'people'; ids: string[] }
  | { ok: true; kind: 'files'; ids: string[] }
  /** Connect boards (hidden questions only): item ids, checked against the column's boards by the caller. */
  | { ok: true; kind: 'links'; ids: string[] }
  /** a secret's value, written encrypted after the item is created (never into `cells`). */
  | { ok: true; kind: 'secret'; value: string }
  | { ok: false; error: 'invalid' };

const bad = { ok: false, error: 'invalid' } as const;
const ULID = /^[0-9A-Z]{26}$/;
const text = (a: FormAnswer) => (typeof a === 'string' ? a.trim() : typeof a === 'number' ? String(a) : null);
const list = (a: FormAnswer) => (Array.isArray(a) ? a : a === null || a === '' ? [] : [a]);

type Labels = { labels?: { id: number; label: string; is_deactivated?: boolean }[] };
/** A choice by its label id (what the page sends), or — for prefilled defaults — its label text. */
const labelId = (settings: unknown, v: string | number): number | null => {
  const labels = ((settings as Labels | null)?.labels ?? []).filter((l) => !l.is_deactivated);
  const n = typeof v === 'number' ? v : /^\d+$/.test(v) ? Number(v) : NaN;
  const byId = labels.find((l) => l.id === n);
  if (byId) return byId.id;
  const s = String(v).trim().toLocaleLowerCase();
  return labels.find((l) => l.label.trim().toLocaleLowerCase() === s)?.id ?? null;
};

/** The raw cell value for an answer, before the column type's own validation (`parseCellValue`). */
const rawCell = (column: FormColumn, a: FormAnswer): unknown | typeof bad => {
  switch (column.type) {
    case 'text':
      return text(a) ?? bad;
    case 'long_text': {
      const s = text(a);
      return s === null ? bad : { text: s };
    }
    case 'numbers': {
      const n = typeof a === 'number' ? a : typeof a === 'string' && a.trim() ? Number(a.trim()) : NaN;
      return Number.isFinite(n) ? n : bad;
    }
    case 'status': {
      if (Array.isArray(a) || typeof a === 'boolean' || a === null) return bad;
      const id = labelId(column.settings, a);
      return id === null ? bad : { index: id };
    }
    case 'dropdown': {
      const ids = list(a).map((v) => (typeof v === 'boolean' || v === null ? null : labelId(column.settings, v)));
      return ids.some((id) => id === null) ? bad : { ids: [...new Set(ids as number[])] };
    }
    case 'date': {
      const s = text(a);
      return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? { date: s } : bad;
    }
    case 'email': {
      const s = text(a);
      return s ? { email: s, text: s } : bad;
    }
    case 'phone': {
      const s = text(a);
      // The phone type's own pattern checks it (`parseCellValue`).
      return s ? { phone: s } : bad;
    }
    case 'link': {
      const s = text(a);
      return s ? { url: s, text: s } : bad;
    }
    case 'checkbox':
      return a === true || a === 'true' ? { checked: true } : bad;
    case 'rating': {
      const n = typeof a === 'number' ? a : typeof a === 'string' ? Number(a) : NaN;
      const max = (column.settings as { max?: number } | null)?.max ?? 5;
      return Number.isInteger(n) && n >= 1 && n <= max ? { rating: n } : bad;
    }
    case 'location': {
      const s = text(a);
      return s ? (locationFromText(s) ?? bad) : bad;
    }
    default:
      return bad;
  }
};

/** Answer → what to write. Unanswered answers never reach here (the caller skips them). */
/** `ctx.country`: the account's country — a phone answer without a country code is read with it. */
export const convertAnswer = (column: FormColumn, a: FormAnswer, ctx: { country?: string } = {}): Converted => {
  if (column.type === 'board_relation') {
    const ids = list(a).map((v) => String(v).trim());
    const multiple = (column.settings as { allow_multiple?: boolean } | null)?.allow_multiple !== false;
    return ids.every((id) => ULID.test(id)) && ids.length <= (multiple ? 50 : 1)
      ? { ok: true, kind: 'links', ids: [...new Set(ids)] }
      : bad;
  }
  const input = formInputOf(column.type);
  if (!input) return bad;
  if (input === 'secret') {
    const settings = secretSettingsOf(column.settings);
    // A check box: checked or not (an unchecked one is a value too — whether it is checked stays secret).
    const raw = typeof a === 'boolean' ? (a ? SECRET_CHECKED : SECRET_UNCHECKED) : typeof a === 'string' ? a : null;
    if (raw === null || raw.length > SECRET_LIMITS.maxLength) return bad;
    const value = secretValueFor(settings, settings.multiline ? raw.replace(/\r\n/g, '\n') : raw.trim());
    return value ? { ok: true, kind: 'secret', value } : bad;
  }
  if (column.type === 'name') {
    const s = text(a);
    return s ? { ok: true, kind: 'name', value: s.slice(0, 255) } : bad;
  }
  if (input === 'people') {
    const ids = list(a).map(String);
    return ids.every((id) => /^[0-9A-Z]{26}$/.test(id)) && ids.length <= 50
      ? { ok: true, kind: 'people', ids: [...new Set(ids)] }
      : bad;
  }
  if (input === 'files') {
    const ids = list(a).map(String);
    return ids.every((id) => /^[0-9A-Z]{26}$/.test(id)) ? { ok: true, kind: 'files', ids: [...new Set(ids)] } : bad;
  }
  // An unchecked checkbox is simply no value.
  if (column.type === 'checkbox' && (a === false || a === 'false')) return { ok: true, kind: 'cell', value: null };
  const raw = rawCell(column, a);
  if (raw === bad) return bad;
  const def = columnTypes.get(column.type);
  if (!def) return bad;
  const parsed = parseCellValue(def, column.settings, raw, ctx);
  return parsed.ok ? { ok: true, kind: 'cell', value: parsed.value } : bad;
};

/** Types whose answer is a list (a comma list in a link parameter or a cell's text). */
const LIST_TYPES = new Set(['dropdown', 'people', 'board_relation']);
const splitList = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const YES = ['1', 'true', 'yes', 'on', 'v', 'כן'];
const NO = ['0', 'false', 'no', 'off', 'לא'];

/**
 * A link parameter → an answer for the column, before the same validation as a visible answer (`convertAnswer`):
 * lists are comma separated, a checkbox reads yes/no words, people may be given by e-mail (`emails`: e-mail → id).
 */
export const answerFromParam = (
  column: FormColumn,
  raw: string,
  emails: Map<string, string> = new Map(),
): FormAnswer => {
  const s = raw.trim();
  if (column.type === 'checkbox') {
    const v = s.toLocaleLowerCase();
    return YES.includes(v) ? true : NO.includes(v) ? false : s;
  }
  if (column.type === 'people')
    return splitList(s).map((p) => (p.includes('@') ? (emails.get(p.toLowerCase()) ?? p) : p));
  if (LIST_TYPES.has(column.type)) return splitList(s);
  return s;
};

/** One cell of a source item as `getItem` shows it (`value` + display `text`), or the item's name. */
export type SourceCell = { type: string; value: unknown; text: string | null };

/**
 * A source item's value → an answer for the target column (then validated like any answer): the same kind of value
 * where it has one (people ids, linked item ids, a date, a number, a checkbox), otherwise the source's display text
 * (labels match by their text, so a status of another board fills a status here when the label names match).
 */
export const answerFromCell = (target: FormColumn, src: SourceCell): FormAnswer | undefined => {
  const v = (src.value && typeof src.value === 'object' ? src.value : null) as Record<string, unknown> | null;
  const text = (src.text ?? '').trim();
  if (target.type === 'people') {
    if (src.type !== 'people') return undefined;
    const ids = ((v?.persons_and_teams as { id: string; kind: string }[] | undefined) ?? [])
      .filter((p) => p.kind === 'person')
      .map((p) => p.id);
    return ids.length ? ids : undefined;
  }
  if (target.type === 'board_relation') {
    if (src.type !== 'board_relation') return undefined;
    const ids = ((v?.item_ids as unknown[] | undefined) ?? []).map(String);
    return ids.length ? ids : undefined;
  }
  if (src.type === 'date' && target.type === 'date' && typeof v?.date === 'string') return v.date;
  if (src.type === 'checkbox') return target.type === 'checkbox' ? v?.checked === true : text || undefined;
  if ((src.type === 'numbers' || src.type === 'rating') && (target.type === 'numbers' || target.type === 'rating')) {
    const n = typeof src.value === 'number' ? src.value : typeof v?.rating === 'number' ? v.rating : Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  if (src.type === 'long_text' && typeof v?.text === 'string') return v.text.trim() || undefined;
  if (!text) return undefined;
  return target.type === 'dropdown' ? splitList(text).map((x) => x.slice(0, 64)) : text.slice(0, 20000);
};
