// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Formula engine (03 §2.18) — spreadsheet-style syntax, so formulas written for common spreadsheet-style tools run unchanged:
 *   IF(OR({lookup_a}>0,{lookup_b}>0),"🔴 אדום","🟢 ירוק")      ROUND({a}/{b}*100,1)      {date}<TODAY()
 * parse() once per column, collect refs(), resolve them (async, by the caller), then evaluate() synchronously.
 */
import { addDays as addIsoDays, dateInZone, type DateEnv } from '../query/dates';
import { holidaysOfYear } from '../workdays/holidays';
import type { CalendarConfig } from '../workdays/settings';
import { addCountedDays, dayWeight } from '../workdays/workdays';

export type FormulaValue = number | string | boolean | null;

export type Node =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'ref'; key: string; attr?: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'unary'; op: '-'; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node };

/**
 * Why a formula does not parse (the editor says it in the reader's language, with column names)
 * `token` = what was found (an operator, a name, a function), `column` = the column reference it was at.
 */
export type FormulaProblem =
  | { code: 'empty' }
  | { code: 'unterminated_string' }
  | { code: 'unterminated_ref' }
  | { code: 'bad_number' }
  | { code: 'unexpected_char'; token: string }
  | { code: 'unexpected_end' }
  | { code: 'unexpected'; token: string }
  /** A column right after a complete value: a missing comma or operator (or it sits after a function's ")"). */
  | { code: 'unexpected_column'; column: string; afterCall?: string }
  | { code: 'missing_paren' }
  | { code: 'missing_paren_after'; token: string }
  | { code: 'unknown_name'; token: string }
  | { code: 'unknown_function'; token: string }
  | { code: 'unknown_column'; column: string };

const problemMessage = (p: FormulaProblem): string => {
  switch (p.code) {
    case 'empty':
      return 'Empty formula';
    case 'unterminated_string':
      return 'Unterminated string';
    case 'unterminated_ref':
      return 'Unterminated column reference';
    case 'bad_number':
      return 'Bad number';
    case 'unexpected_char':
    case 'unexpected':
      return `Unexpected "${p.token}"`;
    case 'unexpected_end':
      return 'Unexpected end of formula';
    case 'unexpected_column':
      return `Unexpected "${p.column}"`;
    case 'missing_paren':
      return 'Missing ")"';
    case 'missing_paren_after':
      return `Missing ")" after ${p.token}(`;
    case 'unknown_name':
      return `Unknown name "${p.token}"`;
    case 'unknown_function':
      return `Unknown function ${p.token}`;
    case 'unknown_column':
      return `Unknown column {${p.column}}`;
  }
};

export class FormulaError extends Error {
  readonly problem: FormulaProblem;
  constructor(problem: FormulaProblem) {
    super(problemMessage(problem));
    this.name = 'FormulaError';
    this.problem = problem;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: '('; v: '(' }
  | { t: ')'; v: ')' }
  | { t: ','; v: ',' };

const tokenize = (src: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') s += src[j++];
      if (j >= src.length) throw new FormulaError({ code: 'unterminated_string' });
      out.push({ t: 'str', v: s });
      i = j + 1;
    } else if (ch === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new FormulaError({ code: 'unterminated_ref' });
      out.push({ t: 'ref', v: src.slice(i + 1, j).trim() });
      i = j + 1;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError({ code: 'bad_number' });
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0].toUpperCase() });
      i += m[0].length;
    } else if (ch === '(' || ch === ')' || ch === ',') {
      out.push({ t: ch, v: ch } as Token);
      i++;
    } else {
      const two = src.slice(i, i + 2);
      if (['<>', '<=', '>=', '!='].includes(two)) {
        out.push({ t: 'op', v: two === '!=' ? '<>' : two });
        i += 2;
      } else if ('+-*/&=<>^%'.includes(ch)) {
        out.push({ t: 'op', v: ch });
        i++;
      } else {
        throw new FormulaError({ code: 'unexpected_char', token: ch });
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Parser (precedence climbing): comparison < & < + - < * / % < ^ < unary
// ---------------------------------------------------------------------------
const PRECEDENCE: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '%': 4,
  '^': 5,
};

export const parseFormula = (src: string): Node => {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const primary = (): Node => {
    const tok = next();
    if (!tok) throw new FormulaError({ code: 'unexpected_end' });
    switch (tok.t) {
      case 'num':
        return { kind: 'num', value: tok.v };
      case 'str':
        return { kind: 'str', value: tok.v };
      case 'ref': {
        const [key, attr] = tok.v.split('#');
        return { kind: 'ref', key: key!.trim(), ...(attr ? { attr: attr.trim().toLowerCase() } : {}) };
      }
      case 'op':
        if (tok.v === '-') return { kind: 'unary', op: '-', arg: unaryOperand() };
        if (tok.v === '+') return unaryOperand();
        throw new FormulaError({ code: 'unexpected', token: tok.v });
      case '(': {
        const inner = expr(0);
        if (next()?.t !== ')') throw new FormulaError({ code: 'missing_paren' });
        return inner;
      }
      case 'id': {
        if (peek()?.t !== '(') {
          if (tok.v === 'TRUE' || tok.v === 'FALSE') return { kind: 'bool', value: tok.v === 'TRUE' };
          throw new FormulaError({ code: 'unknown_name', token: tok.v });
        }
        next();
        const args: Node[] = [];
        if (peek()?.t !== ')') {
          for (;;) {
            args.push(expr(0));
            if (peek()?.t === ',') {
              next();
              continue;
            }
            break;
          }
        }
        if (next()?.t !== ')') throw new FormulaError({ code: 'missing_paren_after', token: tok.v });
        return { kind: 'call', name: tok.v, args };
      }
      default:
        throw new FormulaError({ code: 'unexpected', token: String(tok.v) });
    }
  };
  const unaryOperand = (): Node => {
    const node = primary();
    return node;
  };

  const expr = (minPrec: number): Node => {
    let left = primary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== 'op') break;
      const prec = PRECEDENCE[tok.v];
      if (prec === undefined || prec < minPrec || prec === 0) break;
      next();
      const right = expr(tok.v === '^' ? prec : prec + 1);
      left = { kind: 'binary', op: tok.v, left, right };
    }
    return left;
  };

  if (!tokens.length) throw new FormulaError({ code: 'empty' });
  const tree = expr(1);
  const extra = tokens[pos];
  if (extra) throw new FormulaError(leftover(extra, tokens[pos - 1]));
  return tree;
};

/** A token after a complete formula: a column there usually lacks a comma / operator, or sits after `NAME()`. */
const leftover = (tok: Token, prev: Token | undefined): FormulaProblem => {
  if (tok.t !== 'ref') return { code: 'unexpected', token: String(tok.v) };
  const column = tok.v.split('#')[0]!.trim();
  return prev?.t === ')'
    ? { code: 'unexpected_column', column, afterCall: ')' }
    : { code: 'unexpected_column', column };
};

/** Column keys a formula reads (with `#start`/`#end` attributes folded into the key). */
export const formulaRefs = (node: Node, out = new Set<string>()): Set<string> => {
  if (node.kind === 'ref') out.add(node.key);
  if (node.kind === 'call') node.args.forEach((a) => formulaRefs(a, out));
  if (node.kind === 'unary') formulaRefs(node.arg, out);
  if (node.kind === 'binary') {
    formulaRefs(node.left, out);
    formulaRefs(node.right, out);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
export type RefValue = FormulaValue | { start: FormulaValue; end: FormulaValue };
export type EvalContext = {
  ref: (key: string) => RefValue;
  now?: Date;
  /**
   * The account's IANA timezone: TODAY() is the calendar date there, and the calendar parts of a date with a time
   * (YEAR, DAY, HOUR, ADD_DAYS, FORMAT_DATE …) are read there. UTC when absent. NOW() stays an instant (ISO, UTC).
   */
  timeZone?: string;
  /** The account weekend (WORKDAYS, ADD_WORKDAYS); Friday+Saturday when absent. */
  weekend?: DateEnv['weekend'];
  /**
   * The account calendar: with it, WORKDAYS / ADD_WORKDAYS also skip its holidays and days off
   * (and count a half day as the account says); without it, only the weekend.
   */
  calendar?: CalendarConfig;
};

const isBlank = (v: FormulaValue) => v === null || v === '';
const num = (v: FormulaValue): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: FormulaValue): string =>
  v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);

/**
 * S-70: the longest text a formula builds (REPT, SUBSTITUTE, CONCATENATE, `&`, REPLACE). Formulas run inside the
 * shared API process — `REPT("ab", 250000000)` would take it down for every account.
 */
export const FORMULA_TEXT_MAX = 10_000;
const capText = (s: string) => (s.length > FORMULA_TEXT_MAX ? s.slice(0, FORMULA_TEXT_MAX) : s);
const joinCapped = (parts: string[]) => {
  let out = '';
  for (const p of parts) {
    out += p.length > FORMULA_TEXT_MAX - out.length ? p.slice(0, FORMULA_TEXT_MAX - out.length) : p;
    if (out.length >= FORMULA_TEXT_MAX) break;
  }
  return out;
};
/** SUBSTITUTE without building more than the cap (each match may grow by the replacement's length). */
const substituteCapped = (s: string, find: string, by: string) => {
  const pieces = s.split(find);
  if (pieces.length === 1) return capText(s);
  const parts: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i) parts.push(by);
    parts.push(pieces[i]!);
  }
  return joinCapped(parts);
};
/** Days from..to (inclusive) off the account weekend — whole weeks at once (S-70: no loop per day). */
const weekdaysBetween = (from: Date, to: Date, weekend: DateEnv['weekend']) => {
  const total = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (total <= 0) return 0;
  const off = weekend === 'sat_sun' ? [6, 0] : [5, 6];
  const weeks = Math.floor(total / 7);
  let n = weeks * 5;
  const startDay = from.getUTCDay();
  for (let i = 0; i < total % 7; i++) {
    const day = (startDay + weeks * 7 + i) % 7;
    if (!off.includes(day)) n++;
  }
  return n;
};
/** Longest span (in years) whose holidays WORKDAYS looks at; a longer one counts only the weekend. */
const HOLIDAY_YEARS_MAX = 40;
/**
 * Working days from..to (inclusive) in the account calendar: the weekday count, corrected only on the days that
 * carry a holiday or an account day — each weighed by the shared working-days engine (`dayWeight`), so the result
 * equals `countDays(…, 'workdays')` without a loop over every day of a long span.
 */
const workdaysBetween = (from: Date, to: Date, weekend: DateEnv['weekend'], calendar?: CalendarConfig) => {
  const base = weekdaysBetween(from, to, weekend);
  if (!calendar || base <= 0) return base;
  const a = isoDay(from);
  const b = isoDay(to);
  const y0 = from.getUTCFullYear();
  const y1 = to.getUTCFullYear();
  if (y1 - y0 > HOLIDAY_YEARS_MAX) return base;
  const marked = new Set<string>();
  for (let y = y0; y <= y1; y++) for (const iso of holidaysOfYear(calendar.holiday_set, y).keys()) marked.add(iso);
  for (const c of calendar.custom_days) {
    const last = c.to && c.to >= c.date ? c.to : c.date;
    for (let d = c.date < a ? a : c.date, i = 0; d <= last && d <= b && i < 1000; d = addIsoDays(d, 1), i++)
      marked.add(d);
  }
  let n = base;
  for (const d of marked)
    if (d >= a && d <= b)
      n += dayWeight(d, 'workdays', calendar, weekend) - dayWeight(d, 'weekdays', calendar, weekend);
  return n;
};
const truthy = (v: FormulaValue): boolean =>
  typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : !isBlank(v) && v !== 'FALSE' && v !== '0';

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const toDate = (v: FormulaValue): Date | null => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The calendar date of a value: a plain date as is; a date with a time in the context's timezone. */
const dayOf = (v: FormulaValue, ctx: EvalContext): Date | null => {
  const d = toDate(v);
  if (!d || (v as string).length === 10) return d;
  return ctx.timeZone ? new Date(`${dateInZone(d, ctx.timeZone)}T00:00:00Z`) : d;
};

const clocks = new Map<string, Intl.DateTimeFormat>();
/** Hour and minute of a date with a time, on the context timezone's clock (UTC when absent). */
const clockOf = (v: FormulaValue, ctx: EvalContext): { hour: number; minute: number } | null => {
  const d = toDate(v);
  if (!d) return null;
  if (!ctx.timeZone) return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  let f = clocks.get(ctx.timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: ctx.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    clocks.set(ctx.timeZone, f);
  }
  const parts = f.formatToParts(d);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: n('hour'), minute: n('minute') };
};

/** `=` / `<>` / `<` …: numeric when both sides look numeric, else text (dates as ISO strings compare correctly). */
const compare = (op: string, a: FormulaValue, b: FormulaValue): boolean => {
  const numeric = (v: FormulaValue) =>
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
  let c: number;
  if (isBlank(a) && isBlank(b)) c = 0;
  else if (numeric(a) && numeric(b)) c = num(a) - num(b);
  else c = str(a).localeCompare(str(b));
  switch (op) {
    case '=':
      return c === 0;
    case '<>':
      return c !== 0;
    case '<':
      return c < 0;
    case '>':
      return c > 0;
    case '<=':
      return c <= 0;
    default:
      return c >= 0;
  }
};

const round = (x: number, digits: number, mode: 'round' | 'up' | 'down') => {
  const f = 10 ** digits;
  const v = x * f;
  const r = mode === 'round' ? Math.round(v) : mode === 'up' ? Math.sign(v) * Math.ceil(Math.abs(v)) : Math.trunc(v);
  return r / f;
};

type Fn = (args: FormulaValue[], ctx: EvalContext) => FormulaValue;
const flat = (args: FormulaValue[]) => args.filter((a) => !isBlank(a)).map(num);

const FUNCTIONS: Record<string, Fn> = {
  AND: (a) => a.every(truthy),
  OR: (a) => a.some(truthy),
  NOT: (a) => !truthy(a[0] ?? null),
  SUM: (a) => flat(a).reduce((s, x) => s + x, 0),
  AVERAGE: (a) => {
    const xs = flat(a);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  },
  MIN: (a) => (flat(a).length ? Math.min(...flat(a)) : 0),
  MAX: (a) => (flat(a).length ? Math.max(...flat(a)) : 0),
  COUNT: (a) => a.filter((x) => !isBlank(x)).length,
  ROUND: (a) => round(num(a[0] ?? 0), num(a[1] ?? 0), 'round'),
  ROUNDUP: (a) => round(num(a[0] ?? 0), num(a[1] ?? 0), 'up'),
  ROUNDDOWN: (a) => round(num(a[0] ?? 0), num(a[1] ?? 0), 'down'),
  ABS: (a) => Math.abs(num(a[0] ?? 0)),
  MOD: (a) => {
    const d = num(a[1] ?? 0);
    return d === 0 ? null : num(a[0] ?? 0) % d;
  },
  DIVIDE: (a) => {
    const d = num(a[1] ?? 0);
    return d === 0 ? null : num(a[0] ?? 0) / d;
  },
  MULTIPLY: (a) => flat(a).reduce((s, x) => s * x, 1),
  MINUS: (a) => num(a[0] ?? 0) - num(a[1] ?? 0),
  POWER: (a) => num(a[0] ?? 0) ** num(a[1] ?? 0),
  SQRT: (a) => Math.sqrt(num(a[0] ?? 0)),
  CONCATENATE: (a) => joinCapped(a.map(str)),
  LEN: (a) => str(a[0] ?? '').length,
  LEFT: (a) => str(a[0] ?? '').slice(0, a[1] === undefined ? 1 : num(a[1])),
  RIGHT: (a) => {
    const s = str(a[0] ?? '');
    const n = a[1] === undefined ? 1 : num(a[1]);
    return n <= 0 ? '' : s.slice(-n);
  },
  TRIM: (a) => str(a[0] ?? '').trim(),
  UPPER: (a) => str(a[0] ?? '').toUpperCase(),
  LOWER: (a) => str(a[0] ?? '').toLowerCase(),
  REPLACE: (a) => {
    const s = str(a[0] ?? '');
    const start = num(a[1] ?? 1) - 1;
    return joinCapped([s.slice(0, start), str(a[3] ?? ''), s.slice(start + num(a[2] ?? 0))]);
  },
  SUBSTITUTE: (a) => substituteCapped(str(a[0] ?? ''), str(a[1] ?? ''), str(a[2] ?? '')),
  SEARCH: (a) => {
    const i = str(a[1] ?? '')
      .toLowerCase()
      .indexOf(str(a[0] ?? '').toLowerCase(), num(a[2] ?? 1) - 1);
    return i < 0 ? 0 : i + 1;
  },
  REPT: (a) => {
    const s = str(a[0] ?? '');
    const n = Math.max(0, Math.floor(num(a[1] ?? 0)));
    if (!s || !n) return '';
    return capText(s.repeat(Math.min(n, Math.ceil(FORMULA_TEXT_MAX / s.length))));
  },
  TEXT: (a) => str(a[0] ?? ''),
  VALUE: (a) => num(a[0] ?? 0),
  ISBLANK: (a) => isBlank(a[0] ?? null),
  TODAY: (_a, ctx) => (ctx.timeZone ? dateInZone(ctx.now ?? new Date(), ctx.timeZone) : isoDay(ctx.now ?? new Date())),
  NOW: (_a, ctx) => (ctx.now ?? new Date()).toISOString(),
  DATE: (a) => isoDay(new Date(Date.UTC(num(a[0] ?? 1970), num(a[1] ?? 1) - 1, num(a[2] ?? 1)))),
  DAYS: (a) => {
    const end = toDate(a[0] ?? null);
    const start = toDate(a[1] ?? null);
    return end && start ? Math.round((end.getTime() - start.getTime()) / 86_400_000) : null;
  },
  HOURS_DIFF: (a) => {
    const end = toDate(a[0] ?? null);
    const start = toDate(a[1] ?? null);
    return end && start ? (end.getTime() - start.getTime()) / 3_600_000 : null;
  },
  ADD_DAYS: (a, ctx) => {
    const d = dayOf(a[0] ?? null, ctx);
    return d ? isoDay(new Date(d.getTime() + num(a[1] ?? 0) * 86_400_000)) : null;
  },
  SUBTRACT_DAYS: (a, ctx) => {
    const d = dayOf(a[0] ?? null, ctx);
    return d ? isoDay(new Date(d.getTime() - num(a[1] ?? 0) * 86_400_000)) : null;
  },
  WORKDAYS: (a, ctx) => {
    // The account's weekend (Friday+Saturday by default) and, given its calendar, its holidays and days off.
    const end = dayOf(a[0] ?? null, ctx);
    const start = dayOf(a[1] ?? null, ctx);
    if (!end || !start) return null;
    const [from, to, sign] = start <= end ? [start, end, 1] : [end, start, -1];
    return workdaysBetween(from, to, ctx.weekend ?? 'fri_sat', ctx.calendar) * sign;
  },
  ADD_WORKDAYS: (a, ctx) => {
    const d = dayOf(a[0] ?? null, ctx);
    if (!d) return null;
    const n = Math.trunc(num(a[1] ?? 0));
    return addCountedDays(isoDay(d), n, ctx.calendar ? 'workdays' : 'weekdays', ctx.calendar, ctx.weekend ?? 'fri_sat');
  },
  FORMAT_DATE: (a, ctx) => {
    const d = dayOf(a[0] ?? null, ctx);
    if (!d) return null;
    const pattern = str(a[1] ?? 'DD/MM/YYYY');
    const parts: Record<string, string> = {
      YYYY: String(d.getUTCFullYear()),
      MM: String(d.getUTCMonth() + 1).padStart(2, '0'),
      DD: String(d.getUTCDate()).padStart(2, '0'),
    };
    return pattern.replace(/YYYY|MM|DD/g, (m) => parts[m]!);
  },
  YEAR: (a, ctx) => dayOf(a[0] ?? null, ctx)?.getUTCFullYear() ?? null,
  MONTH: (a, ctx) => {
    const d = dayOf(a[0] ?? null, ctx);
    return d ? d.getUTCMonth() + 1 : null;
  },
  DAY: (a, ctx) => dayOf(a[0] ?? null, ctx)?.getUTCDate() ?? null,
  WEEKNUM: (a, ctx) => {
    const d = dayOf(a[0] ?? null, ctx);
    if (!d) return null;
    const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.ceil(((d.getTime() - jan1) / 86_400_000 + new Date(jan1).getUTCDay() + 1) / 7);
  },
  HOUR: (a, ctx) => clockOf(a[0] ?? null, ctx)?.hour ?? null,
  MINUTE: (a, ctx) => clockOf(a[0] ?? null, ctx)?.minute ?? null,
};

export const FORMULA_FUNCTIONS = [...Object.keys(FUNCTIONS), 'IF', 'SWITCH', 'IFERROR'].sort();

const evalNode = (node: Node, ctx: EvalContext): FormulaValue => {
  switch (node.kind) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value;
    case 'ref': {
      const v = ctx.ref(node.key);
      if (v !== null && typeof v === 'object') return node.attr === 'end' ? v.end : v.start;
      return v;
    }
    case 'unary':
      return -num(evalNode(node.arg, ctx));
    case 'binary': {
      const a = evalNode(node.left, ctx);
      const b = evalNode(node.right, ctx);
      switch (node.op) {
        case '+':
          return num(a) + num(b);
        case '-':
          return num(a) - num(b);
        case '*':
          return num(a) * num(b);
        case '/':
          return num(b) === 0 ? null : num(a) / num(b);
        case '%':
          return num(b) === 0 ? null : num(a) % num(b);
        case '^':
          return num(a) ** num(b);
        case '&':
          return joinCapped([str(a), str(b)]);
        default:
          return compare(node.op, a, b);
      }
    }
    case 'call': {
      // Lazy functions first: only the chosen branch is evaluated.
      if (node.name === 'IF') {
        return truthy(evalNode(node.args[0] ?? { kind: 'bool', value: false }, ctx))
          ? node.args[1]
            ? evalNode(node.args[1], ctx)
            : true
          : node.args[2]
            ? evalNode(node.args[2], ctx)
            : false;
      }
      if (node.name === 'IFERROR') {
        try {
          const v = evalNode(node.args[0]!, ctx);
          return v === null ? (node.args[1] ? evalNode(node.args[1], ctx) : null) : v;
        } catch {
          return node.args[1] ? evalNode(node.args[1], ctx) : null;
        }
      }
      if (node.name === 'SWITCH') {
        const subject = evalNode(node.args[0]!, ctx);
        for (let i = 1; i + 1 < node.args.length; i += 2) {
          if (compare('=', subject, evalNode(node.args[i]!, ctx))) return evalNode(node.args[i + 1]!, ctx);
        }
        return node.args.length % 2 === 0 ? evalNode(node.args[node.args.length - 1]!, ctx) : null;
      }
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new FormulaError({ code: 'unknown_function', token: node.name });
      return fn(
        node.args.map((a) => evalNode(a, ctx)),
        ctx,
      );
    }
  }
};

/** Evaluates a parsed formula; runtime problems yield null (an empty cell). */
export const evaluateFormula = (node: Node, ctx: EvalContext): FormulaValue => {
  try {
    const v = evalNode(node, ctx);
    return typeof v === 'number' && !Number.isFinite(v) ? null : v;
  } catch {
    return null;
  }
};

/** Parse-time validation for column settings: syntax + known functions + (optionally) known refs. */
export const validateFormula = (src: string, knownKeys?: Set<string>): string | null => {
  const p = formulaProblem(src, knownKeys);
  return p ? problemMessage(p) : null;
};

/** What is wrong with a formula (the first problem), or null — `validateFormula`'s answer as data. */
export const formulaProblem = (src: string, knownKeys?: Set<string>): FormulaProblem | null => {
  let tree: Node;
  try {
    tree = parseFormula(src);
  } catch (e) {
    return e instanceof FormulaError ? e.problem : { code: 'unexpected', token: '?' };
  }
  const check = (n: Node): FormulaProblem | null => {
    if (n.kind === 'call' && !FORMULA_FUNCTIONS.includes(n.name)) return { code: 'unknown_function', token: n.name };
    if (n.kind === 'call')
      for (const a of n.args) {
        const e = check(a);
        if (e) return e;
      }
    if (n.kind === 'unary') return check(n.arg);
    if (n.kind === 'binary') return check(n.left) ?? check(n.right);
    if (n.kind === 'ref' && knownKeys && !knownKeys.has(n.key)) return { code: 'unknown_column', column: n.key };
    return null;
  };
  return check(tree);
};

/** Formats a result for display (numbers: up to `precision` decimals, trailing zeros trimmed). */
export const formatFormulaResult = (v: FormulaValue, precision?: number): string => {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    const p = precision ?? 2;
    return String(Math.round(v * 10 ** p) / 10 ** p);
  }
  return v;
};

export * from './catalog';
export * from './refs';
