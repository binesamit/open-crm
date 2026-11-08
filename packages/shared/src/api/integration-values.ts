// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { BoardSchema, IntegrationColumn } from './integrations';

/**
 * Integration conveniences that no-code platforms cannot compute on their side (Make runs no custom code without
 * a support ticket): plain column values → stored cell values, the column-values form of a board, simple filter
 * rules, and an item's cells as text by column title. Pure functions; nothing here knows a specific board.
 */

/** A member as the conversion needs it (`GET /users`). */
export type IntegrationMember = { user_id: string; name: string; email: string };

/** A value that does not fit its column — the message names the column and, for labels, the choices. */
export class CellValueError extends Error {
  constructor(
    message: string,
    readonly columnId: string,
  ) {
    super(message);
  }
}

const norm = (s: string) => s.trim().toLocaleLowerCase();
const listOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v).split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);
const isEmpty = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
/** A tag id (ULID); anything else is a tag name. */
const TAG_ID = /^[0-9A-Z]{26}$/;

/** A JSON object given as text (`{"…": …}`) — passed through as the raw stored value. */
const parsedObject = (v: unknown): Record<string, unknown> | undefined => {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) return v as Record<string, unknown>;
  if (typeof v === 'string' && /^\s*\{[\s\S]*\}\s*$/.test(v)) {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** `2026-10-19T21:00:00.000Z` in `timeZone` → `2026-10-20T00:00` (a mapped date is read where the person is). */
const localDateTime = (iso: string, timeZone: string): string | undefined => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return undefined;
  }
};

export type CellsFromValuesOptions = {
  /** Dates with an offset (`…Z`, `…+03:00`) are read in this zone first; a date written without one is taken as is. */
  timeZone?: string;
};

/**
 * One plain value → the column's stored value (03-COLUMN-TYPES): a status by label (any case) or id, a dropdown
 * by labels or ids, people by user id, email or unique name, dates `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, a timeline
 * `from - to`, numbers, a checkbox, an hour `HH:MM`, email / phone / link, tags by id or name, connected items by
 * id, any other type from its JSON Schema. A JSON object is always the raw stored value. `undefined` = empty input.
 */
export const cellValueFrom = (
  c: IntegrationColumn,
  input: unknown,
  members: IntegrationMember[] = [],
  opts: CellsFromValuesOptions = {},
): unknown => {
  if (isEmpty(input)) return undefined;
  const raw = parsedObject(input);
  if (raw) return raw;
  const fail = (message: string): never => {
    throw new CellValueError(message, c.id);
  };
  const optionId = (v: unknown): number => {
    const options = c.options ?? [];
    if (typeof v === 'number' && options.some((o) => o.id === v)) return v;
    const s = String(v).trim();
    const byLabel = options.find((o) => norm(o.label) === norm(s));
    if (byLabel) return byLabel.id;
    if (/^\d+$/.test(s) && options.some((o) => o.id === Number(s))) return Number(s);
    return fail(`"${s}" is not a label of "${c.title}". Labels: ${options.map((o) => o.label).join(', ') || '(none)'}`);
  };
  const personId = (v: string): string => {
    const hit = members.find((m) => m.user_id === v) ?? members.find((m) => norm(m.email) === norm(v));
    if (hit) return hit.user_id;
    const byName = members.filter((m) => norm(m.name) === norm(v));
    if (byName.length > 1) fail(`"${v}" matches several people for "${c.title}" — use the email`);
    return byName[0]?.user_id ?? fail(`No member "${v}" for "${c.title}" (use a user id, an email or a unique name)`);
  };
  const dateOf = (v: unknown): { date: string; time?: string } => {
    let s = v instanceof Date ? v.toISOString() : String(v).trim();
    if (opts.timeZone && /T\d\d:\d\d.*(Z|[+-]\d\d:?\d\d)$/.test(s)) s = localDateTime(s, opts.timeZone) ?? s;
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
    if (!m) return fail(`"${s}" is not a date for "${c.title}" (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)`);
    return m[2] && !(m[2] === '00' && m[3] === '00') ? { date: m[1]!, time: `${m[2]}:${m[3]}` } : { date: m[1]! };
  };
  switch (c.type) {
    case 'text':
      return String(input);
    case 'long_text':
      return { text: String(input) };
    case 'numbers': {
      const n = typeof input === 'number' ? input : Number(String(input).replace(/,/g, ''));
      return Number.isFinite(n) ? n : fail(`"${String(input)}" is not a number for "${c.title}"`);
    }
    case 'rating':
      return { rating: Math.round(Number(input)) };
    case 'checkbox': {
      const on = typeof input === 'boolean' ? input : ['true', '1', 'yes', 'v', 'x'].includes(norm(String(input)));
      return on ? { checked: true } : null;
    }
    case 'status':
      return { index: optionId(input) };
    case 'dropdown':
      return { ids: [...new Set(listOf(input).map(optionId))] };
    case 'people':
      return {
        persons_and_teams: [...new Set(listOf(input).map(personId))].map((id) => ({ id, kind: 'person' })),
      };
    case 'tags': {
      const list = [...new Set(listOf(input))];
      const names = list.filter((x) => !TAG_ID.test(x));
      return names.length ? { tag_ids: list.filter((x) => TAG_ID.test(x)), tags: names } : { tag_ids: list };
    }
    case 'board_relation':
    case 'dependency':
      return { item_ids: [...new Set(listOf(input))] };
    case 'date':
      return dateOf(input);
    case 'timeline': {
      const [from, to] = String(input).split(/\s+[–—-]\s+|\s*\/\s*/);
      const a = dateOf(from ?? '').date;
      return { from: a, to: to ? dateOf(to).date : a };
    }
    case 'email':
      return { email: String(input).trim() };
    case 'phone':
      return { phone: String(input).trim() };
    case 'link': {
      const url = String(input).trim();
      return { url: /^https?:\/\//i.test(url) ? url : `https://${url}` };
    }
    case 'hour': {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(input).trim());
      return m
        ? { hour: Number(m[1]), minute: Number(m[2]) }
        : fail(`"${String(input)}" is not an hour for "${c.title}" (use HH:MM)`);
    }
    default: {
      const s = c.value_schema as {
        type?: string;
        required?: string[];
        properties?: Record<string, { type?: string }>;
      } | null;
      if (s?.type === 'string') return String(input);
      if (s?.type === 'number' || s?.type === 'integer') return Number(input);
      const required = s?.required ?? [];
      const p = s?.properties?.[required[0] ?? ''] ?? {};
      if (s?.type === 'object' && required.length === 1) {
        const key = required[0]!;
        if (p.type === 'array') return { [key]: listOf(input) };
        if (p.type === 'number' || p.type === 'integer') return { [key]: Number(input) };
        if (p.type === 'string') return { [key]: String(input) };
      }
      return fail(`"${c.title}" (${c.type}) needs a JSON value`);
    }
  }
};

/** Does this mapping need the member list (a people column given by name or email)? */
export const valuesNeedMembers = (columns: IntegrationColumn[], values: Record<string, unknown>) =>
  columns.some((c) => c.type === 'people' && !isEmpty(values[c.id]) && !parsedObject(values[c.id]));

/** A whole mapping (column id → plain value) → the `cells` of a create / update call; empty values are skipped. */
export const cellsFromValues = (
  columns: IntegrationColumn[],
  values: Record<string, unknown>,
  members: IntegrationMember[] = [],
  opts: CellsFromValuesOptions = {},
): Record<string, unknown> => {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const out: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(values)) {
    const c = byId.get(id);
    if (!c) throw new CellValueError(`The board has no column "${id}"`, id);
    if (isEmpty(v)) continue;
    if (!c.writable) throw new CellValueError(`"${c.title}" cannot be written (${c.type})`, id);
    const value = cellValueFrom(c, v, members, opts);
    if (value !== undefined) out[id] = value;
  }
  return out;
};

/** An item's cells as text, keyed by column title (the column id when the title is unknown). */
export const columnValuesOf = (
  cells: Record<string, { text?: string | null } | null | undefined>,
  titles: Map<string, string>,
): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  for (const [id, cell] of Object.entries(cells)) out[titles.get(id) ?? id] = cell?.text ?? null;
  return out;
};

// ── the column-values form ──────────────────────────────────────────────────────────────────────────────────────

/** One input field of the column-values form (the parameter format of Make custom apps, which n8n-style UIs map 1:1). */
export const integrationFieldSchema = z
  .object({
    name: z.string().describe('the column id'),
    label: z.string(),
    type: z.enum(['text', 'number', 'boolean', 'select', 'url']),
    help: z.string().optional(),
    multiple: z.boolean().optional(),
    multiline: z.boolean().optional(),
    /**
     * Fixed options (status / dropdown labels, value = label id), or where to load them: `rpc://listUsers` (the
     * active members) or `rpc://listValues?…` — the column's values from `GET /boards/{id}/columns/{col}/choices`
     * (tags, connected items).
     */
    options: z.union([z.array(z.object({ label: z.string(), value: z.number() })), z.string()]).optional(),
  })
  .meta({ id: 'IntegrationField' });
export type IntegrationField = z.infer<typeof integrationFieldSchema>;

/** `?format=flat` on the item endpoints integrations call: items also carry `column_values` (text by column title). */
export const itemFormatQuerySchema = z.object({
  format: z
    .enum(['flat'])
    .optional()
    .describe('`flat`: each item also carries `column_values` — its cells’ text keyed by column title'),
});

/** `GET /boards/{id}/fields` query. */
export const boardFieldsQuerySchema = z.object({
  /** `true`: the fields of the board's sub-board (subitems). */
  subitems: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** The writable columns of a board (or of its sub-board) as input fields, each in its type. */
export const integrationFields = (schema: BoardSchema, subitems = false): IntegrationField[] => {
  const columns = (subitems ? schema.subitems?.columns : schema.columns) ?? [];
  const choices = (c: IntegrationColumn) =>
    `rpc://listValues?boardId=${encodeURIComponent(schema.id)}&column_id=${encodeURIComponent(c.id)}&purpose=write${subitems ? '&subitems=true' : ''}`;
  return columns
    .filter((c) => c.writable)
    .map((c): IntegrationField => {
      const f: IntegrationField = { name: c.id, label: c.title, type: 'text' };
      if (c.description) f.help = c.description;
      const labels = (c.options ?? []).map((o) => ({ label: o.label, value: o.id }));
      switch (c.type) {
        case 'status':
          return { ...f, type: 'select', options: labels };
        case 'dropdown':
          return { ...f, type: 'select', multiple: true, options: labels };
        case 'people':
          return { ...f, type: 'select', multiple: true, options: 'rpc://listUsers' };
        case 'tags':
        case 'board_relation':
        case 'dependency':
          return { ...f, type: 'select', multiple: true, options: choices(c) };
        case 'checkbox':
          return { ...f, type: 'boolean' };
        case 'numbers':
        case 'rating':
          return { ...f, type: 'number' };
        case 'long_text':
          return { ...f, multiline: true };
        case 'link':
          return { ...f, type: 'url' };
        case 'date':
          return { ...f, help: 'YYYY-MM-DD or YYYY-MM-DD HH:MM (taken as written)' };
        case 'timeline':
          return { ...f, help: 'YYYY-MM-DD - YYYY-MM-DD' };
        case 'hour':
          return { ...f, help: 'HH:MM' };
        default: {
          const t = (c.value_schema as { type?: string } | null)?.type;
          if (t === 'number' || t === 'integer') return { ...f, type: 'number' };
          return { ...f, help: f.help ?? 'Text, or the column value as JSON' };
        }
      }
    });
};
