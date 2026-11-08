// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes } from '../columns';
import type { FilterGroup, FilterRule } from '../query/filter';
import { recipeSchema, type Recipe } from './schema';

/**
 * 04 §1.4 — seed / legacy shorthands → the canonical recipe. Board-specific references (column titles inside
 * templates, board keys) are resolved through the `board` passed in, never hard-coded (D21).
 */

export type NormalizeBoard = {
  /** The board's columns: key, title and type. */
  columns: { key: string; title: string; type: string }[];
  /** Resolves a board reference of a cross-board action (seed key, `@portal:{client}`); null = unresolved. */
  resolveBoard?: (ref: string) => string | null;
};

export type NormalizeResult =
  { ok: true; recipe: Recipe; unresolved: string[] } | { ok: false; error: string; unresolved: string[] };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Removes the display-only `text` field of seed objects (04 §1.1). */
const strip = (o: Json): Json => {
  const { text: _text, ...rest } = o;
  return rest;
};

/** `{item name}`, `{item_id}`, `{<column title>}` → canonical template paths. */
export const normalizeTemplate = (s: string, board: NormalizeBoard, unresolved: string[]): string =>
  s.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (whole, raw: string) => {
    const inner = raw.trim();
    if (inner === 'item name') return '{item.name}';
    if (inner === 'item_id') return '{item.id}';
    if (/^[a-z_]+(\.[\w.*]+)?(\|.*)?$/.test(inner)) return whole; // already a path
    const col = board.columns.find((c) => c.title.trim() === inner);
    if (col) return `{item.${col.key}}`;
    unresolved.push(`template:${inner}`);
    return whole;
  });

const normalizeValue = (v: unknown, board: NormalizeBoard, unresolved: string[]): unknown =>
  typeof v === 'string'
    ? normalizeTemplate(v, board, unresolved)
    : Array.isArray(v)
      ? v.map((x) => normalizeValue(x, board, unresolved))
      : isObj(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeValue(x, board, unresolved)]))
        : v;

const peopleAlias = (r: unknown) => (r === '@owner' ? '@board_owners' : r);

export const normalizeAction = (raw: Json, board: NormalizeBoard, unresolved: string[]): Json => {
  const a = strip(raw);
  switch (a.type) {
    case 'assign_creator':
      return { type: 'assign', column: a.column, who: '@creator', mode: 'add' };
    case 'gmail_send': {
      const { body, ...rest } = a;
      return normalizeAction({ ...rest, type: 'send_email', body_html: a.body_html ?? body }, board, unresolved);
    }
    case 'time_tracking_start':
      return {
        type: 'start_time_tracking',
        column: a.column,
        ...(a.who !== undefined ? { who: a.who } : {}),
        ...(a.fallback !== undefined ? { fallback: a.fallback } : {}),
      };
    case 'time_tracking_stop':
      return {
        type: 'stop_time_tracking',
        column: a.column,
        ...(a.who !== undefined ? { who: a.who } : {}),
        ...(a.fallback !== undefined ? { fallback: a.fallback } : {}),
      };
    case 'mcp':
      return { type: 'run_extension', block: `mcp:${String(a.tool)}`, ...(a.input ? { input: a.input } : {}) };
  }
  const out: Json = { ...a };
  if ('to' in out) out.to = Array.isArray(out.to) ? out.to.map(peopleAlias) : peopleAlias(out.to);
  if ('who' in out) out.who = peopleAlias(out.who);
  for (const k of ['message', 'subject', 'body_html', 'body', 'name', 'url', 'item_id', 'prompt'] as const)
    if (typeof out[k] === 'string') out[k] = normalizeTemplate(out[k], board, unresolved);
  if (isObj(out.fixed)) out.fixed = normalizeValue(out.fixed, board, unresolved);
  if (isObj(out.payload)) out.payload = normalizeValue(out.payload, board, unresolved);
  if (typeof out.board === 'string' && board.resolveBoard && out.board !== '@self') {
    const id = board.resolveBoard(out.board);
    if (id) out.board = id;
    else unresolved.push(`board:${out.board}`);
  }
  return out;
};

const SYSTEM_COLUMNS: Record<string, string> = {
  group: '__group__',
  __creation_log__: '__created_at__',
  __last_updated__: '__updated_at__',
};
/**
 * A creation log reads the item's creation date. A last-updated column stays itself (s4f): its value is the last
 * cell change — or of its chosen columns — as the board shows it, never the row's `updated_at`.
 */
const META_DATE_FIELDS: Record<string, string> = { creation_log: '__created_at__' };
const DATE_SUGAR: Record<string, string> = {
  is_overdue: 'OVERDUE',
  is_today: 'TODAY',
  is_past: 'PAST',
  is_future: 'FUTURE',
};

const rule = (
  column_id: string,
  operator: FilterRule['operator'],
  values: unknown[] = [],
  negate = false,
): FilterRule => ({
  kind: 'rule',
  column_id,
  operator,
  values,
  negate,
});

/** `["EXACT", "2026-10-15"]` → `["EXACT:2026-10-15"]` (13 §2). */
const dateValues = (values: unknown[]) => {
  const out: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 'EXACT' && typeof values[i + 1] === 'string') out.push(`EXACT:${String(values[++i])}`);
    else out.push(values[i]);
  }
  return out;
};

/** One 04 §1.2 condition → a filter rule (or a small group for the sugar operators). */
export const normalizeCondition = (raw: Json, board?: NormalizeBoard): FilterRule | FilterGroup => {
  const c = strip(raw);
  const key = String(c.column);
  // A creation log column reads the item's own date — the system field carries every date operator.
  const type = board?.columns.find((col) => col.key === key)?.type;
  const column = SYSTEM_COLUMNS[key] ?? (type && META_DATE_FIELDS[type]) ?? key;
  const values = Array.isArray(c.values) ? dateValues(c.values) : [];
  const op = String(c.operator);
  const attribute =
    c.compare_attribute === 'START_DATE' ? 'start' : c.compare_attribute === 'END_DATE' ? 'end' : undefined;
  const withAttr = (r: FilterRule): FilterRule => (attribute ? { ...r, attribute } : r);
  if (op in DATE_SUGAR) return withAttr(rule(column, 'any_of', [DATE_SUGAR[op]]));
  switch (op) {
    case 'greater_than_or_equals':
      return withAttr(rule(column, 'greater_than_or_equal', values));
    case 'contains_terms':
      return rule(column, 'contains_text', values);
    case 'is_checked':
      return rule(column, 'is_not_empty');
    case 'is_not_checked':
      return rule(column, 'is_empty');
    case 'newer_than_days':
      return withAttr(rule(column, 'within_the_last', [Number(values[0]), 'days']));
    case 'older_than_days': {
      // "more than N days ago": not within the last N days — and has a date, unless the column always has one
      // (creation log, last updated).
      const older = withAttr(rule(column, 'within_the_last', [Number(values[0]), 'days'], true));
      const canBeEmpty =
        !column.startsWith('__') && (!type || columnTypes.get(type)?.filterOperators.includes('is_not_empty'));
      return canBeEmpty
        ? { kind: 'group', operator: 'and', negate: false, rules: [withAttr(rule(column, 'is_not_empty')), older] }
        : older;
    }
    default:
      return withAttr(rule(column, op as FilterRule['operator'], values));
  }
};

/** The seed's condition list (top level AND, one level of `{operator:"or", rules}`) → one filter group. */
export const normalizeConditions = (raw: unknown, board?: NormalizeBoard): FilterGroup | undefined => {
  if (isObj(raw) && raw.kind === 'group') return raw as unknown as FilterGroup; // already canonical
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const rules = raw.filter(isObj).map((c) =>
    Array.isArray(c.rules)
      ? ({
          kind: 'group',
          operator: c.operator === 'or' ? 'or' : 'and',
          negate: false,
          rules: c.rules.filter(isObj).map((r) => normalizeCondition(r, board)),
        } satisfies FilterGroup)
      : normalizeCondition(c, board),
  );
  return { kind: 'group', operator: 'and', negate: false, rules };
};

const normalizeTrigger = (raw: Json): Json => {
  const t = strip(raw);
  if (t.type === 'item_name_changed') return { type: 'column_changed', column: 'name' };
  // "when any of these columns changes" may be sent as `columns` alone — the first is `column`.
  if (
    (t.type === 'column_changed' || t.type === 'subitem_column_changed') &&
    t.column === undefined &&
    Array.isArray(t.columns) &&
    typeof t.columns[0] === 'string'
  )
    return { ...t, column: t.columns[0] };
  return t;
};

/** A seed automation (or an API body that may use the shorthands) → a validated canonical recipe. */
export const normalizeRecipe = (raw: unknown, board: NormalizeBoard): NormalizeResult => {
  const unresolved: string[] = [];
  if (!isObj(raw)) return { ok: false, error: 'not_an_object', unresolved };
  const candidate = {
    trigger: isObj(raw.trigger) ? normalizeTrigger(raw.trigger) : raw.trigger,
    conditions: normalizeConditions(raw.conditions, board),
    actions: Array.isArray(raw.actions)
      ? raw.actions.filter(isObj).map((a) => normalizeAction(a, board, unresolved))
      : [],
  };
  const parsed = recipeSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`, unresolved };
  }
  return { ok: true, recipe: parsed.data, unresolved };
};
