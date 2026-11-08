// SPDX-License-Identifier: AGPL-3.0-only
import { STATUS_COLORS, type ColorKey } from '../colors';
import type { Region } from '../locale/format';
import { dateOrderOf, parseDateText, parseNumberText, type DateOrder } from './date-text';
import { cellFromText, type TextPerson } from './from-text';
import { columnTypes, ownWriter, parseCellValue, withNewColumnDefaults } from './index';
import type { AnyColumnTypeDef, ColumnCtx, NewColumnDefaults } from './types';

/**
 * Column type conversion (D28, the planning notes "COLUMN-CONVERSION"): every cell goes `old value → text (the old type's
 * toText) → new value (the paste parser, cellFromText)`, except pairs with a direct rule that keeps more
 * (status ↔ dropdown by label id, date ↔ timeline, numbers ↔ rating, text ↔ long text, contact types → their
 * address). Pure: the API runs the same code for the preview (dry run) and for the conversion, so the counts the
 * preview shows are the counts the conversion writes. Nothing here writes; failures keep their source in the
 * backup (the API's `column_conversion_cells`).
 */

/** Why a pair cannot be converted (the column menu explains it; a new column + copy is the way out). */
export const CONVERT_UNSUPPORTED = [
  'same_type',
  'unknown_type',
  /** The name column (every board has exactly one). */
  'name_column',
  /** Formula, mirror, progress, item id, creation log, last updated — values computed, nothing of its own. */
  'computed',
  /** Files, time tracking, votes, cell docs, buttons — written by their own endpoints. */
  'own_writer',
  /** Connect boards / dependency — links between items, not values. */
  'relations',
  /** AI columns are filled by the model: a new column, not a conversion. */
  'ai',
] as const;
export type ConvertUnsupported = (typeof CONVERT_UNSUPPORTED)[number];

/** Options a pair may ask about in the preview (`conversionOptionsFor`). */
export type ConvertOptions = {
  /** text → date / timeline: day first (Israel) or month first. Default: the account's date format. */
  date_order?: DateOrder;
  /** timeline → date: which end becomes the date (the other end stays in the backup). */
  timeline_side?: 'start' | 'end';
  /** people → text: names or emails. */
  people_as?: 'name' | 'email';
  /** numbers → text: keep the column's unit / currency and thousands separator (default) or the bare number. */
  number_unit?: boolean;
  /** → rating: the scale (default: 5, or 10 when a value is above 5). */
  rating_max?: 3 | 4 | 5 | 10;
  /** New status / dropdown labels and tags the user removed from the list (lower-cased names): their cells fail. */
  skip_labels?: string[];
  /** Colour of a new status label (lower-cased name → palette key). */
  label_colors?: Record<string, ColorKey>;
};
export type ConvertOptionKey = 'date_order' | 'timeline_side' | 'people_as' | 'number_unit' | 'rating_max';

export type ConvertEnv = {
  /** Members and teams of the account (people ↔ text). */
  people?: TextPerson[];
  /** Account tags (tags → text; which tags would be new). */
  tags?: { id: string; name: string }[];
  /** The account's region: dates as text in its format, its day/month order. */
  region?: Region;
  /** The account's defaults for new columns: the converted column starts with them. */
  newColumnDefaults?: NewColumnDefaults;
};

const LABEL_TYPES = new Set(['status', 'dropdown']);
const TEXT_TYPES = new Set(['text', 'long_text']);

const reasonOf = (def: AnyColumnTypeDef | undefined): ConvertUnsupported | null => {
  if (!def) return 'unknown_type';
  if (def.type === 'name') return 'name_column';
  if (def.type === 'ai') return 'ai';
  if (def.engine === 'links') return 'relations';
  if (ownWriter(def)) return 'own_writer';
  if (def.storage !== 'cell' || def.readOnly) return 'computed';
  return null;
};

export type ConvertSupport =
  { ok: true; direct: boolean; options: ConvertOptionKey[] } | { ok: false; reason: ConvertUnsupported };

const DIRECT = new Set([
  'status>dropdown',
  'dropdown>status',
  'date>timeline',
  'timeline>date',
  'numbers>rating',
  'rating>numbers',
  'text>long_text',
  'long_text>text',
]);

/** Which preview options a pair asks about (only the relevant ones are shown). */
export const conversionOptionsFor = (from: string, to: string): ConvertOptionKey[] => {
  const out: ConvertOptionKey[] = [];
  if ((to === 'date' || to === 'timeline') && from !== 'date' && from !== 'timeline') out.push('date_order');
  if (from === 'timeline' && to === 'date') out.push('timeline_side');
  if (from === 'people') out.push('people_as');
  if (from === 'numbers' && TEXT_TYPES.has(to)) out.push('number_unit');
  if (to === 'rating') out.push('rating_max');
  return out;
};

/** Can a column of `from` become `to`? (The column menu lists only the targets that can.) */
export const conversionSupport = (from: string, to: string): ConvertSupport => {
  if (from === to) return { ok: false, reason: 'same_type' };
  const a = reasonOf(columnTypes.get(from));
  if (a) return { ok: false, reason: a };
  const b = reasonOf(columnTypes.get(to));
  if (b) return { ok: false, reason: b };
  return { ok: true, direct: DIRECT.has(`${from}>${to}`), options: conversionOptionsFor(from, to) };
};

/** The types a column of `from` can become, registry order (empty: the column cannot be converted). */
export const conversionTargets = (from: string): string[] =>
  columnTypes
    .all()
    .map((d) => d.type)
    .filter((to) => conversionSupport(from, to).ok);

// ---- the conversion ----

type Label = { id: number; label: string; color?: string; index?: number; is_done?: boolean; is_deactivated?: boolean };

/** A label / tag the conversion adds (status: with its colour); `count` = cells that use it. */
export type NewLabel = { id?: number; name: string; color?: string; count: number };

export type PreparedConversion = {
  from: { type: string; settings: Record<string, unknown> };
  to: { type: string; settings: Record<string, unknown> };
  options: ConvertOptions;
  ctx: ColumnCtx;
  env: ConvertEnv;
  /** New labels of the target (status / dropdown), already in `to.settings`. */
  newLabels: NewLabel[];
  /** Account tags the conversion creates (tags target). */
  newTags: NewLabel[];
  /** New labels / tags the user removed (their cells fail) or over the status limit. */
  skippedLabels: NewLabel[];
};

const norm = (s: string) => s.trim().toLocaleLowerCase();
const parts = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const LABEL_MAX: Record<string, number> = { status: 30, dropdown: 100 };
const STATUS_LABELS_MAX = 40;
const TAG_MAX = 60;

const settingsOf = (def: AnyColumnTypeDef, settings: unknown): Record<string, unknown> => {
  const parsed = def.settingsSchema.safeParse(settings ?? def.defaultSettings);
  return (parsed.success ? parsed.data : def.defaultSettings) as Record<string, unknown>;
};

const ctxOf = (env: ConvertEnv): ColumnCtx => {
  const names = new Map((env.people ?? []).map((p) => [p.id, p.name]));
  const tags = new Map((env.tags ?? []).map((x) => [x.id, x.name]));
  return {
    userName: (id) => names.get(id),
    tagName: (id) => tags.get(id),
    ...(env.region ? { region: env.region, locale: env.region.language } : {}),
  };
};

/** A text cell read back as a number (`"7"` through a JSON layer) is still the text it was. */
const storedValue = (def: AnyColumnTypeDef, raw: unknown) =>
  def.type === 'text' && (typeof raw === 'number' || typeof raw === 'boolean') ? String(raw) : raw;

const yesWord = (env: ConvertEnv) => (env.region?.language === 'en' ? 'Yes' : 'כן');

/**
 * The text a stored value converts through (`null` = the value cannot be read as its type — it fails and stays in
 * the backup). Contact types give their address, not their display text; people may give emails; numbers may drop
 * their unit; a checkbox is "כן" or nothing.
 */
export const sourceText = (
  def: AnyColumnTypeDef,
  settings: Record<string, unknown>,
  raw: unknown,
  options: ConvertOptions,
  env: ConvertEnv,
  ctx: ColumnCtx = ctxOf(env),
): string | null => {
  if (raw === null || raw === undefined) return '';
  const parsed = def.valueSchema.safeParse(storedValue(def, raw));
  if (!parsed.success) return null;
  const v = parsed.data as Record<string, unknown>;
  switch (def.type) {
    case 'link':
      return String(v.url ?? '');
    case 'email':
      return String(v.email ?? '');
    case 'phone':
      return String(v.phone ?? '');
    case 'checkbox':
      return v.checked ? yesWord(env) : '';
    case 'numbers':
      return options.number_unit === false ? String(parsed.data) : def.toText(parsed.data, settings, ctx);
    case 'long_text':
      return String(v.text ?? '');
    case 'people':
      if (options.people_as === 'email') {
        const emails = new Map((env.people ?? []).map((p) => [p.id, p.email ?? p.name]));
        return ((v.persons_and_teams as { id: string }[] | undefined) ?? [])
          .map((p) => emails.get(p.id) ?? '')
          .filter(Boolean)
          .join(', ');
      }
      return def.toText(parsed.data, settings, ctx);
    default:
      try {
        return def.toText(parsed.data, settings, ctx);
      } catch {
        return null;
      }
  }
};

const ratingOf = (n: number | undefined, max: number) =>
  n !== undefined && Number.isInteger(n) && n >= 1 && n <= max ? { rating: n } : undefined;

/** The status / dropdown labels of the target, and which cells' names become new labels. */
const prepareLabels = (
  fromDef: AnyColumnTypeDef,
  fromSettings: Record<string, unknown>,
  toType: string,
  values: unknown[],
  texts: (string | null)[],
  options: ConvertOptions,
) => {
  const skip = new Set((options.skip_labels ?? []).map(norm));
  const colorOf = (name: string, i: number) =>
    options.label_colors?.[norm(name)] ?? STATUS_COLORS[i % STATUS_COLORS.length]!;
  const sourceLabels = ((fromSettings.labels as Label[] | undefined) ?? []).filter(Boolean);

  // status → dropdown: the same labels (ids kept, so saved filters and automations still match).
  if (fromDef.type === 'status' && toType === 'dropdown') {
    const labels = sourceLabels.map((l) => ({
      id: l.id,
      label: l.label,
      ...(l.is_deactivated ? { is_deactivated: true } : {}),
    }));
    return { labels, newLabels: [] as NewLabel[], skipped: [] as NewLabel[] };
  }
  // dropdown → status: the same labels (ids kept) with palette colours; the ones in use first, at most 40.
  if (fromDef.type === 'dropdown' && toType === 'status') {
    const uses = new Map<number, number>();
    for (const v of values)
      for (const id of ((v as { ids?: number[] } | null)?.ids ?? []).slice(0, 1)) uses.set(id, (uses.get(id) ?? 0) + 1);
    const fit = sourceLabels.filter((l) => l.label.trim() && l.label.length <= LABEL_MAX.status!);
    const ranked = [...fit].sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
    const kept = new Set(ranked.slice(0, STATUS_LABELS_MAX).map((l) => l.id));
    const labels = fit
      .filter((l) => kept.has(l.id))
      .map((l, i) => ({
        id: l.id,
        label: l.label,
        color: colorOf(l.label, i),
        index: i,
        ...(l.is_deactivated ? { is_deactivated: true } : {}),
      }));
    const skipped = sourceLabels
      .filter((l) => !kept.has(l.id) && uses.get(l.id))
      .map((l) => ({ name: l.label, count: uses.get(l.id)! }));
    return { labels, newLabels: [] as NewLabel[], skipped };
  }

  // Anything else: every distinct name in the cells becomes a label, most used first, in first-seen order.
  const counts = new Map<string, { name: string; count: number; first: number }>();
  texts.forEach((text, i) => {
    if (!text) return;
    const names = toType === 'status' ? [text.trim()] : parts(text);
    for (const name of new Set(names.map((n) => n.trim()))) {
      if (!name || name.length > LABEL_MAX[toType]!) continue;
      const key = norm(name);
      const hit = counts.get(key);
      if (hit) hit.count++;
      else counts.set(key, { name, count: 1, first: i });
    }
  });
  const all = [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first);
  const wanted = all.filter((x) => !skip.has(norm(x.name)));
  const max = toType === 'status' ? STATUS_LABELS_MAX : 1000;
  const keep = wanted.slice(0, max);
  const skipped = [...all.filter((x) => skip.has(norm(x.name))), ...wanted.slice(max)].map((x) => ({
    name: x.name,
    count: x.count,
  }));
  const ordered = [...keep].sort((a, b) => a.first - b.first);
  const labels = ordered.map((x, i) =>
    toType === 'status' ? { id: i, label: x.name, color: colorOf(x.name, i), index: i } : { id: i, label: x.name },
  );
  const newLabels = labels.map((l) => ({
    id: l.id,
    name: l.label,
    ...('color' in l ? { color: l.color } : {}),
    count: counts.get(norm(l.label))!.count,
  }));
  return { labels, newLabels, skipped };
};

/** A unit / currency the source texts carry (most of the numbers that read): the new numbers column shows it. */
const unitOf = (texts: (string | null)[]) => {
  const seen = new Map<string, number>();
  let numbers = 0;
  for (const t of texts) {
    if (!t || parseNumberText(t) === undefined) continue;
    numbers++;
    const sym = /[₪$€£%]/.exec(t)?.[0] ?? (/ש["״']?ח|nis|ils/i.test(t) ? '₪' : null);
    if (sym) seen.set(sym, (seen.get(sym) ?? 0) + 1);
  }
  const top = [...seen].sort((a, b) => b[1] - a[1])[0];
  return top && numbers && top[1] * 2 >= numbers ? top[0] : null;
};

/**
 * Everything decided once for the whole column: the target's settings (its labels from every cell's names, the
 * unit numbers carried, the rating scale, whether dates have a time), the new labels and tags. `values` = every
 * stored value of the column (the preview and each window of a large conversion share this).
 */
export const prepareConversion = (input: {
  from: { type: string; settings: unknown };
  toType: string;
  options?: ConvertOptions;
  env?: ConvertEnv;
  values: unknown[];
}): PreparedConversion => {
  const options = input.options ?? {};
  const env = input.env ?? {};
  const fromDef = columnTypes.get(input.from.type)!;
  const toDef = columnTypes.get(input.toType)!;
  const fromSettings = settingsOf(fromDef, input.from.settings);
  const ctx = ctxOf(env);
  const texts = input.values.map((v) => sourceText(fromDef, fromSettings, v, options, env, ctx));
  // The converted column is a new one of its type: the account's defaults for new columns.
  let toSettings = settingsOf(toDef, withNewColumnDefaults(toDef, undefined, env.newColumnDefaults));
  let newLabels: NewLabel[] = [];
  let newTags: NewLabel[] = [];
  let skippedLabels: NewLabel[] = [];

  if (LABEL_TYPES.has(toDef.type)) {
    const p = prepareLabels(fromDef, fromSettings, toDef.type, input.values, texts, options);
    toSettings = { ...toSettings, labels: p.labels };
    newLabels = p.newLabels;
    skippedLabels = p.skipped;
  } else if (toDef.type === 'tags') {
    const have = new Set((env.tags ?? []).map((x) => norm(x.name)));
    const skip = new Set((options.skip_labels ?? []).map(norm));
    const counts = new Map<string, NewLabel>();
    for (const text of texts)
      for (const name of new Set(parts(text ?? '').map((p) => p.replace(/^#+/, '').trim()))) {
        if (!name || name.length > TAG_MAX || have.has(norm(name))) continue;
        const hit = counts.get(norm(name));
        if (hit) hit.count++;
        else counts.set(norm(name), { name, count: 1 });
      }
    newTags = [...counts.values()].filter((x) => !skip.has(norm(x.name)));
    skippedLabels = [...counts.values()].filter((x) => skip.has(norm(x.name)));
  } else if (toDef.type === 'numbers') {
    const unit = fromDef.type === 'rating' ? null : unitOf(texts);
    if (unit) toSettings = { ...toSettings, unit: { symbol: unit, direction: unit === '%' ? 'right' : 'left' } };
    if (fromDef.type === 'rating') toSettings = { ...toSettings, footer: 'avg' };
  } else if (toDef.type === 'rating') {
    let max = options.rating_max;
    if (!max) {
      const top = Math.max(
        0,
        ...input.values.map((v) => (typeof v === 'number' ? v : (parseNumberText(String(v ?? '')) ?? 0))),
        ...texts.map((t) => parseNumberText(t ?? '') ?? 0),
      );
      max = top > 5 ? 10 : 5;
    }
    toSettings = { ...toSettings, max, symbol: 'stars' };
  } else if (toDef.type === 'date') {
    const anyTime = fromDef.type !== 'timeline' && texts.some((t) => !!t && /\s\d{1,2}:\d{2}$/.test(t.trim()));
    if (anyTime) toSettings = { ...toSettings, show_time: true };
  }

  return {
    from: { type: fromDef.type, settings: fromSettings },
    to: { type: toDef.type, settings: toSettings },
    options,
    ctx,
    env,
    newLabels,
    newTags,
    skippedLabels,
  };
};

/**
 * A conversion decided earlier (a background job's windows, a restore): the stored target settings, so every
 * window converts against the same labels.
 */
export const resumeConversion = (input: {
  from: { type: string; settings: unknown };
  to: { type: string; settings: Record<string, unknown> };
  options?: ConvertOptions;
  env?: ConvertEnv;
}): PreparedConversion => {
  const env = input.env ?? {};
  const fromDef = columnTypes.get(input.from.type)!;
  return {
    from: { type: fromDef.type, settings: settingsOf(fromDef, input.from.settings) },
    to: input.to,
    options: input.options ?? {},
    ctx: ctxOf(env),
    env,
    newLabels: [],
    newTags: [],
    skippedLabels: [],
  };
};

export type CellOutcome = 'converted' | 'empty' | 'failed';

/** Why a cell failed (shown with the examples in the preview). */
export type FailReason = 'unreadable' | 'not_parsed' | 'label_skipped' | 'person_not_found' | 'person_ambiguous';

export type CellConversion = {
  outcome: CellOutcome;
  /** The new stored value (`null`: no cell — empty, failed, or converted to "nothing", like an unchecked box). */
  value: unknown;
  /** The cell as text before / after. */
  before: string;
  after: string;
  /** Something of the old value did not fit (the rest of a dropdown, the other end of a timeline, a time…). */
  partial?: boolean;
  reason?: FailReason;
};

const fail = (before: string, reason: FailReason): CellConversion => ({
  outcome: 'failed',
  value: null,
  before,
  after: '',
  reason,
});

const rawText = (raw: unknown) => {
  try {
    return typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 200);
  } catch {
    return '';
  }
};

/** Direct rules (more exact than through text); `undefined` = no direct rule for this pair. */
const direct = (
  p: PreparedConversion,
  v: Record<string, unknown> & { [k: string]: unknown },
  raw: unknown,
): { value: unknown; partial?: boolean } | 'fail' | null | undefined => {
  const pair = `${p.from.type}>${p.to.type}`;
  const toLabels = (p.to.settings.labels as Label[] | undefined) ?? [];
  switch (pair) {
    case 'status>dropdown': {
      const id = v.index as number;
      return toLabels.some((l) => l.id === id) ? { value: { ids: [id] } } : 'fail';
    }
    case 'dropdown>status': {
      const ids = (v.ids as number[] | undefined) ?? [];
      if (!ids.length) return null;
      const id = ids[0]!;
      return toLabels.some((l) => l.id === id) ? { value: { index: id }, partial: ids.length > 1 } : 'fail';
    }
    case 'date>timeline':
      return { value: { from: v.date, to: v.date }, partial: !!v.time };
    case 'timeline>date':
      return {
        value: { date: p.options.timeline_side === 'end' ? v.to : v.from },
        partial: v.from !== v.to,
      };
    case 'numbers>rating': {
      const r = ratingOf(raw as number, Number(p.to.settings.max ?? 5));
      return r ? { value: r } : 'fail';
    }
    case 'rating>numbers':
      return { value: v.rating };
    case 'text>long_text':
      return { value: { text: String(raw) } };
    case 'long_text>text': {
      const text = String(v.text ?? '');
      if (!text.trim()) return null;
      return { value: text.slice(0, 2000), partial: text.length > 2000 };
    }
    default:
      return undefined;
  }
};

/** Text → the target's value (labels by name in the prepared labels, people by unique name / email). */
const fromText = (
  p: PreparedConversion,
  text: string,
): { value: unknown; partial?: boolean } | { fail: FailReason } | null => {
  const t = text.trim();
  if (!t) return null;
  const s = p.to.settings;
  const labels = ((s.labels as Label[] | undefined) ?? []).filter((l) => !l.is_deactivated);
  const order = p.options.date_order ?? dateOrderOf(p.env.region?.date_format);
  switch (p.to.type) {
    case 'status': {
      const l = labels.find((x) => norm(x.label) === norm(t));
      return l ? { value: { index: l.id } } : { fail: 'label_skipped' };
    }
    case 'dropdown': {
      const names = parts(t);
      const ids = [...new Set(names.flatMap((n) => labels.filter((l) => norm(l.label) === norm(n)).map((l) => l.id)))];
      if (!ids.length) return { fail: 'label_skipped' };
      return { value: { ids }, partial: ids.length < new Set(names.map(norm)).size };
    }
    case 'tags': {
      const skip = new Set((p.options.skip_labels ?? []).map(norm));
      const names = [
        ...new Map(
          parts(t)
            .map((x) => x.replace(/^#+/, '').trim())
            .map((n) => [norm(n), n]),
        ).values(),
      ];
      const kept = names.filter((n) => n && n.length <= TAG_MAX && !skip.has(norm(n)));
      if (!kept.length) return { fail: 'label_skipped' };
      return { value: { tags: kept }, partial: kept.length < names.length };
    }
    case 'people': {
      const found = new Map<string, { id: string; kind: 'person' | 'team' }>();
      for (const name of parts(t)) {
        const hits = (p.env.people ?? []).filter(
          (x) => norm(x.name) === norm(name) || (!!x.email && norm(x.email) === norm(name)),
        );
        if (!hits.length) return { fail: 'person_not_found' };
        if (new Set(hits.map((h) => h.id)).size > 1) return { fail: 'person_ambiguous' };
        found.set(hits[0]!.id, { id: hits[0]!.id, kind: hits[0]!.kind });
      }
      return { value: { persons_and_teams: [...found.values()] } };
    }
    case 'numbers': {
      const n = parseNumberText(t);
      return n === undefined ? { fail: 'not_parsed' } : { value: n };
    }
    case 'rating': {
      const r = ratingOf(parseNumberText(t), Number(s.max ?? 5));
      return r ? { value: r } : { fail: 'not_parsed' };
    }
    case 'date': {
      const m = /^(.+?)(?:\s+(\d{1,2}):(\d{2}))?$/.exec(t);
      const date = m ? parseDateText(m[1]!, order) : null;
      if (!date) return { fail: 'not_parsed' };
      return { value: m![2] ? { date, time: `${m![2].padStart(2, '0')}:${m![3]}` } : { date } };
    }
    case 'timeline': {
      const [a, b] = t.split(/\s+[–—-]\s+/);
      const from = parseDateText(a ?? '', order);
      const to = b ? parseDateText(b, order) : from;
      return from && to && from <= to ? { value: { from, to } } : { fail: 'not_parsed' };
    }
    case 'long_text':
      return { value: { text } };
    case 'text':
      return { value: t.slice(0, 2000), partial: t.length > 2000 };
    default: {
      const v = cellFromText(p.to.type, t, s, p.env.people ?? [], { region: p.env.region });
      if (v === undefined) return { fail: 'not_parsed' };
      return { value: v };
    }
  }
};

/** One stored value → its conversion. Same code for the preview and the conversion. */
export const convertCell = (p: PreparedConversion, raw: unknown): CellConversion => {
  const fromDef = columnTypes.get(p.from.type)!;
  const toDef = columnTypes.get(p.to.type)!;
  const text = sourceText(fromDef, p.from.settings, raw, p.options, p.env, p.ctx);
  if (text === null) return fail(rawText(raw), 'unreadable');
  const before = text;
  if (raw === null || raw === undefined || !text.trim())
    return { outcome: 'empty', value: null, before: '', after: '' };

  let out: { value: unknown; partial?: boolean } | null;
  const parsed = fromDef.valueSchema.safeParse(storedValue(fromDef, raw));
  const d = parsed.success ? direct(p, parsed.data as Record<string, unknown>, parsed.data) : undefined;
  if (d === 'fail') return fail(before, 'not_parsed');
  if (d !== undefined) out = d;
  else {
    const r = fromText(p, text);
    if (r && 'fail' in r) return fail(before, r.fail);
    out = r;
  }
  if (!out) return { outcome: 'empty', value: null, before: '', after: '' };
  if (out.value === null) return { outcome: 'converted', value: null, before, after: '', partial: !!out.partial };

  // Tags are names until the service resolves them; everything else validates against the target now.
  if (toDef.type === 'tags') {
    const names = (out.value as { tags: string[] }).tags;
    return { outcome: 'converted', value: out.value, before, after: names.join(', '), partial: !!out.partial };
  }
  const checked = parseCellValue(toDef, p.to.settings, out.value, p.ctx);
  if (!checked.ok) return fail(before, 'not_parsed');
  const after = toDef.toText(checked.value, p.to.settings, p.ctx);
  return { outcome: 'converted', value: checked.value, before, after, partial: !!out.partial };
};

export type ConversionCounts = {
  /** Items considered (the board's, archived and trashed included). */
  items: number;
  converted: number;
  /** Items with nothing in the column (no cell, or an empty one) — they stay empty. */
  empty: number;
  failed: number;
  /** Converted, but part of the old value did not fit (kept in the backup). */
  partial: number;
};

export type ConversionSample = {
  item_id: string;
  before: string;
  after: string;
  partial?: boolean;
  reason?: FailReason;
};

/** Preview of a whole column (the API's dry run): counts, examples, new labels and tags. */
export const planConversion = (input: {
  from: { type: string; settings: unknown };
  toType: string;
  options?: ConvertOptions;
  env?: ConvertEnv;
  cells: { itemId: string; value: unknown }[];
  /** Items considered (≥ cells); default = the cells. */
  itemCount?: number;
  samples?: number;
}) => {
  const prepared = prepareConversion({ ...input, values: input.cells.map((c) => c.value) });
  const counts: ConversionCounts = {
    items: Math.max(input.itemCount ?? input.cells.length, input.cells.length),
    converted: 0,
    empty: 0,
    failed: 0,
    partial: 0,
  };
  const max = input.samples ?? 10;
  const converted: ConversionSample[] = [];
  const failed: ConversionSample[] = [];
  const results = input.cells.map((c) => {
    const r = convertCell(prepared, c.value);
    if (r.outcome === 'converted') {
      counts.converted++;
      if (r.partial) counts.partial++;
      if (converted.length < max)
        converted.push({
          item_id: c.itemId,
          before: r.before,
          after: r.after,
          ...(r.partial ? { partial: true } : {}),
        });
    } else if (r.outcome === 'failed') {
      counts.failed++;
      if (failed.length < max) failed.push({ item_id: c.itemId, before: r.before, after: '', reason: r.reason });
    } else counts.empty++;
    return { itemId: c.itemId, ...r };
  });
  counts.empty += counts.items - input.cells.length;
  return { prepared, counts, samples: { converted, failed }, results };
};
