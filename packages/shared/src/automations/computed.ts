// SPDX-License-Identifier: AGPL-3.0-only
import {
  type EvalContext,
  evaluateFormula,
  FORMULA_FUNCTIONS,
  FormulaError,
  type FormulaProblem,
  type FormulaValue,
  type Node,
  parseFormula,
  type RefValue,
} from '../formula';

/**
 * Prod — the `set_computed` action's expression: the formula column's language (same parser, functions and
 * evaluation, so there is one language) over references the run can reach:
 *
 *   `{qty}`                     a column of the run's item (`name` = its name)
 *   `{parent.qty}`              a column of its parent item (a subitem's)
 *   `{service.min_per_unit}`    a column of the item linked in the relation column `service` (the first one)
 *   `{service.price#sum}`       … of all linked items, aggregated (sum / avg / min / max / count / first)
 *   `{qty|1}`                   a default when the value is empty (a number, or "text")
 *   `{timeline#end}`            a timeline's end (`#start` is the default), as in the formula column
 *
 * Stored with column keys (rename-safe); people read and type it with column names (`computedToNames` /
 * `computedToKeys`). `parent` stays a keyword in both forms.
 */

export const COMPUTED_ON_EMPTY = ['skip', 'clear', 'zero'] as const;
export type ComputedOnEmpty = (typeof COMPUTED_ON_EMPTY)[number];
export const COMPUTED_AGGREGATES = ['first', 'sum', 'avg', 'min', 'max', 'count'] as const;
export type ComputedAggregate = (typeof COMPUTED_AGGREGATES)[number];
/** Column types `set_computed` writes: a number, a text, a date or an hour (people can still edit them by hand). */
export const COMPUTED_TARGET_TYPES = ['numbers', 'text', 'long_text', 'date', 'hour'];
export const COMPUTED_EXPRESSION_MAX = 2000;
/** The word for the parent item in a reference: `{parent.<column>}`. */
export const COMPUTED_PARENT = 'parent';

export type ComputedRef = {
  /** The reference as written inside the braces (the key the evaluator asks for). */
  raw: string;
  /** `self` = the run's item, `parent` = its parent, `relation` = items linked in the relation column `relation`. */
  scope: 'self' | 'parent' | 'relation';
  relation?: string;
  column: string;
  /** `start` / `end` of a timeline, or how a relation's items are combined. */
  attr?: string;
  /** The value used when the cell is empty. */
  fallback?: FormulaValue;
};

const AGGREGATE_SET = new Set<string>(COMPUTED_AGGREGATES);

/** `service.price#sum|0` → its parts; null when there is no column. */
export const parseComputedRef = (raw: string): ComputedRef | null => {
  let body = raw.trim();
  let fallback: FormulaValue | undefined;
  const bar = body.indexOf('|');
  if (bar >= 0) {
    const text = body.slice(bar + 1).trim();
    body = body.slice(0, bar).trim();
    if (/^".*"$/.test(text)) fallback = text.slice(1, -1);
    else if (text !== '' && Number.isFinite(Number(text))) fallback = Number(text);
    else fallback = text;
  }
  let attr: string | undefined;
  const hash = body.indexOf('#');
  if (hash >= 0) {
    attr = body
      .slice(hash + 1)
      .trim()
      .toLowerCase();
    body = body.slice(0, hash).trim();
  }
  const dot = body.indexOf('.');
  const head = dot < 0 ? body : body.slice(0, dot).trim();
  const column = dot < 0 ? body : body.slice(dot + 1).trim();
  if (!column) return null;
  const base = { raw, column, ...(attr ? { attr } : {}), ...(fallback !== undefined ? { fallback } : {}) };
  if (dot < 0) return { ...base, scope: 'self' };
  if (head === COMPUTED_PARENT) return { ...base, scope: 'parent' };
  return { ...base, scope: 'relation', relation: head };
};

/** Every `{…}` outside "strings", in order: [start, end (exclusive), inner text]. */
const refSpans = (src: string): [number, number, string][] => {
  const out: [number, number, string][] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      i = j < 0 ? src.length : j + 1;
    } else if (ch === '{') {
      const j = src.indexOf('}', i + 1);
      if (j < 0) break;
      out.push([i, j + 1, src.slice(i + 1, j)]);
      i = j + 1;
    } else i++;
  }
  return out;
};

export type ParsedComputed = { tree: Node; refs: ComputedRef[] };

/**
 * Parses an expression: each reference becomes an opaque `{rN}` for the formula parser (so `.`, `|` and `#` inside
 * braces mean what this module says), then the formula column's parser does the rest. Throws `FormulaError`.
 */
export const parseComputed = (src: string): ParsedComputed => {
  const refs: ComputedRef[] = [];
  let rewritten = '';
  let last = 0;
  for (const [start, end, inner] of refSpans(src)) {
    const ref = parseComputedRef(inner);
    if (!ref) throw new FormulaError({ code: 'unknown_column', column: inner.trim() });
    rewritten += `${src.slice(last, start)}{r${refs.length}}`;
    refs.push(ref);
    last = end;
  }
  rewritten += src.slice(last);
  const tree = parseFormula(rewritten);
  const check = (n: Node): void => {
    if (n.kind === 'call') {
      if (!FORMULA_FUNCTIONS.includes(n.name)) throw new FormulaError({ code: 'unknown_function', token: n.name });
      n.args.forEach(check);
    } else if (n.kind === 'unary') check(n.arg);
    else if (n.kind === 'binary') {
      check(n.left);
      check(n.right);
    }
  };
  check(tree);
  return { tree, refs };
};

/** The expression's problem (syntax, an unknown function) or null. */
export const computedProblem = (src: string): FormulaProblem | null => {
  try {
    parseComputed(src);
    return null;
  } catch (e) {
    return e instanceof FormulaError ? e.problem : { code: 'unexpected', token: '?' };
  }
};

/** The value one reference reads: a single value, or (a relation) the values of each linked item. */
export type ComputedInput = RefValue | { many: RefValue[] };

const blank = (v: unknown) => v === null || v === undefined || v === '';
const numeric = (v: RefValue): number | null => {
  const x = v !== null && typeof v === 'object' ? v.start : v;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (blank(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** One relation's linked values combined (`first` = the first item's value as is). */
const aggregate = (values: RefValue[], how: string | undefined): RefValue => {
  if (how === 'count') return values.filter((v) => !blank(v)).length;
  if (!how || !AGGREGATE_SET.has(how) || how === 'first') return values[0] ?? null;
  const ns = values.map(numeric).filter((n): n is number => n !== null);
  if (!ns.length) return null;
  if (how === 'sum') return ns.reduce((s, n) => s + n, 0);
  if (how === 'avg') return ns.reduce((s, n) => s + n, 0) / ns.length;
  return how === 'min' ? Math.min(...ns) : Math.max(...ns);
};

export type ComputedResult =
  /** `missing`: a reference with no value and no default (`on_empty` decides), or a result that is not a value. */
  { ok: true; value: FormulaValue } | { ok: false; reason: 'missing_value' | 'no_result' };

/**
 * Evaluates a parsed expression. `read` answers each reference (undefined = no value). An empty reference without a
 * default makes the result missing — "quantity × minutes" with no minutes is not 0.
 */
export const evaluateComputed = (
  parsed: ParsedComputed,
  read: (ref: ComputedRef) => ComputedInput | undefined,
  env: Omit<EvalContext, 'ref'> = {},
): ComputedResult => {
  const values = parsed.refs.map((ref): FormulaValue | undefined => {
    const got = read(ref);
    const v: RefValue | undefined =
      got !== null && typeof got === 'object' && 'many' in got ? aggregate(got.many, ref.attr) : got;
    // A timeline (or a relation's first timeline): its start, or its end with `#end`.
    const flat = v !== null && typeof v === 'object' ? (ref.attr === 'end' ? v.end : v.start) : v;
    return flat === undefined || blank(flat) ? ref.fallback : flat;
  });
  if (values.some((v) => v === undefined)) return { ok: false, reason: 'missing_value' };
  const result = evaluateFormula(parsed.tree, { ...env, ref: (key) => values[Number(key.slice(1))] ?? null });
  if (result === null || result === '' || (typeof result === 'number' && !Number.isFinite(result)))
    return { ok: false, reason: 'no_result' };
  return { ok: true, value: result };
};

/** Rounds a number result to `digits` after the point (unset = as computed). */
export const roundComputed = (v: FormulaValue, digits: number | undefined): FormulaValue =>
  typeof v === 'number' && digits !== undefined ? Math.round(v * 10 ** digits) / 10 ** digits : v;

// ---------------------------------------------------------------------------
// Names ↔ keys (what people read and type ↔ what is stored)
// ---------------------------------------------------------------------------
export type ComputedColumns = { id: string; title: string }[];
export type ComputedEnv = {
  /** The run item's columns. */
  item: ComputedColumns;
  /** Its parent's columns (empty when the run's item has no parent). */
  parent?: ComputedColumns;
  /** The item's relation columns and the columns of the board each links to (undefined while loading). */
  relations?: { id: string; title: string; columns?: ComputedColumns }[];
};

const norm = (s: string) => s.trim().toLowerCase();
/** A column is written by its name only when the name leads back to it alone (as in the formula column). */
const nameOf = (cols: ComputedColumns, id: string) => {
  const c = cols.find((x) => x.id === id);
  if (!c) return id;
  const title = c.title.trim();
  const ok =
    !!title &&
    !/[{}#|."\n\r]/.test(title) &&
    cols.filter((x) => norm(x.title) === norm(title)).length === 1 &&
    !cols.some((x) => x.id !== id && norm(x.id) === norm(title)) &&
    norm(title) !== COMPUTED_PARENT;
  return ok ? title : id;
};
const idOf = (cols: ComputedColumns | undefined, typed: string) => {
  if (!cols) return undefined;
  const byId = cols.find((c) => c.id === typed);
  if (byId) return byId.id;
  const hits = cols.filter((c) => norm(c.title) === norm(typed));
  return hits.length === 1 ? hits[0]!.id : undefined;
};

/** Splits a reference into its path and its tail (`#attr|default`), keeping the tail as written. */
const splitTail = (inner: string) => {
  const at = inner.search(/[#|]/);
  return at < 0 ? { path: inner, tail: '' } : { path: inner.slice(0, at), tail: inner.slice(at) };
};

const rewrite = (src: string, map: (path: string) => string | undefined) => {
  let out = '';
  let last = 0;
  for (const [start, end, inner] of refSpans(src)) {
    const { path, tail } = splitTail(inner);
    const next = map(path.trim());
    out += src.slice(last, start) + (next === undefined ? src.slice(start, end) : `{${next}${tail}}`);
    last = end;
  }
  return out + src.slice(last);
};

/** Stored → shown: `{qty} * {service.min_per_unit}` → `{Quantity} * {Service.Minutes per unit}`. */
export const computedToNames = (src: string, env: ComputedEnv): string =>
  rewrite(src, (path) => {
    const dot = path.indexOf('.');
    if (dot < 0) return nameOf(env.item, path);
    const head = path.slice(0, dot);
    const col = path.slice(dot + 1);
    if (head === COMPUTED_PARENT) return `${COMPUTED_PARENT}.${nameOf(env.parent ?? [], col)}`;
    const rel = env.relations?.find((r) => r.id === head);
    if (!rel) return undefined;
    const relName = nameOf(
      env.relations!.map((r) => ({ id: r.id, title: r.title })),
      head,
    );
    return `${relName}.${rel.columns ? nameOf(rel.columns, col) : col}`;
  });

/** Shown → stored: names back to keys; a name that leads nowhere is left as typed (validation names it). */
export const computedToKeys = (src: string, env: ComputedEnv): string =>
  rewrite(src, (path) => {
    const self = idOf(env.item, path);
    if (self) return self;
    const dot = path.indexOf('.');
    if (dot < 0) return undefined;
    const head = path.slice(0, dot).trim();
    const col = path.slice(dot + 1).trim();
    if (norm(head) === COMPUTED_PARENT) return `${COMPUTED_PARENT}.${idOf(env.parent, col) ?? col}`;
    const relations = env.relations ?? [];
    const rel = idOf(
      relations.map((r) => ({ id: r.id, title: r.title })),
      head,
    );
    if (!rel) return undefined;
    return `${rel}.${idOf(relations.find((r) => r.id === rel)?.columns, col) ?? col}`;
  });
