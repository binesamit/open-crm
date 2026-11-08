// SPDX-License-Identifier: MIT
import type { FieldType, IDataObject, INodePropertyOptions, ResourceMapperField } from 'n8n-workflow';

/**
 * Column values: the board schema (`GET /boards/{id}/schema`) → n8n fields, and what a person typed or mapped →
 * the JSON value the API stores. Pure functions (unit-tested); nothing here knows a specific board.
 */
export type ColumnOption = { id: number; label: string; color: string | null };
export type IntegrationColumn = {
  id: string;
  title: string;
  type: string;
  description: string | null;
  writable: boolean;
  value_model: string;
  options: ColumnOption[] | null;
  value_schema: IDataObject | null;
  /** Connect-boards columns: the boards they link (older instances leave it out). */
  linked_board_ids?: string[] | null;
};
export type BoardSchema = {
  id: string;
  name: string;
  kind: string;
  groups: { id: string; title: string; color: string }[];
  columns: IntegrationColumn[];
  subitems: { board_id: string; columns: IntegrationColumn[] } | null;
};
/** A member as `GET /users` returns it. */
export type Member = { user_id: string; name: string; email: string; status?: string };

/** One value of a column, as `GET /boards/{id}/columns/{col}/choices` returns it. */
export type ColumnChoice = { id: string | null; text: string; hint: string | null };

/** What a picked value is used for: a write (mapper), find-by-value (compares the text) or a filter rule. */
export type ChoicePurpose = 'write' | 'find' | 'filter';

/** Choices the mapper loads from the instance (status and dropdown labels are already in the schema). */
export const needsChoiceLoad = (c: IntegrationColumn) =>
  c.writable && ['people', 'tags', 'links'].includes(c.value_model);

/** The value a picked choice stands for: find compares the cell text; a write or a filter takes the id. */
export const choiceValue = (choice: ColumnChoice, purpose: ChoicePurpose): string =>
  purpose === 'find' ? choice.text : (choice.id ?? choice.text);

/** A choice as an n8n option. */
export const choiceOption = (choice: ColumnChoice, purpose: ChoicePurpose): INodePropertyOptions => ({
  name: choice.hint ? `${choice.text} (${choice.hint})` : choice.text,
  value: choiceValue(choice, purpose),
});

/** A resource locator's value (`{__rl, mode, value}`) or a plain value (saved before the locator) → the value. */
export const locatorValue = (v: unknown): string => {
  if (v && typeof v === 'object' && 'value' in (v as IDataObject)) return String((v as IDataObject).value ?? '');
  return v === undefined || v === null ? '' : String(v);
};

/** The n8n field type a column renders as. */
export const fieldTypeOf = (c: IntegrationColumn): FieldType => {
  if (c.type === 'status') return 'options';
  if (c.type === 'checkbox') return 'boolean';
  if (c.type === 'date') return 'dateTime';
  if (c.type === 'numbers' || c.type === 'rating') return 'number';
  if (c.type === 'link') return 'url';
  const t = c.value_schema?.type;
  if (t === 'number' || t === 'integer') return 'number';
  return 'string';
};

/**
 * Fields of the "Column Values" mapper: the writable columns, each with its type. Columns with predefined values
 * get a picker: status / dropdown labels from the schema, people / tags / linked items from `choices` (loaded per
 * column). Several values (people, dropdown, tags, links) go in as an expression, comma-separated.
 */
export const mapperFields = (
  columns: IntegrationColumn[],
  choices: Record<string, ColumnChoice[]> = {},
): ResourceMapperField[] =>
  columns
    .filter((c) => c.writable)
    .map((c) => {
      const labels =
        c.value_model === 'label' || c.value_model === 'labels'
          ? (c.options ?? []).map((o): INodePropertyOptions => ({ name: o.label, value: o.id }))
          : undefined;
      const loaded = choices[c.id]?.map((x) => choiceOption(x, 'write'));
      const options = labels ?? (loaded?.length ? loaded : undefined);
      return {
        id: c.id,
        displayName: `${c.title} (${c.type})`,
        required: false,
        defaultMatch: false,
        canBeUsedToMatch: true,
        display: true,
        type: options ? 'options' : fieldTypeOf(c),
        ...(options ? { options } : {}),
      };
    });

const norm = (s: string) => s.trim().toLocaleLowerCase();
const listOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v).split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);

export class ValueError extends Error {}

/** A tag id (ULID); anything else is a tag name. */
const TAG_ID = /^[0-9A-Z]{26}$/;

const optionId = (c: IntegrationColumn, v: unknown): number => {
  const options = c.options ?? [];
  if (typeof v === 'number' && options.some((o) => o.id === v)) return v;
  const s = String(v).trim();
  const byLabel = options.find((o) => norm(o.label) === norm(s));
  if (byLabel) return byLabel.id;
  if (/^\d+$/.test(s) && options.some((o) => o.id === Number(s))) return Number(s);
  throw new ValueError(
    `"${s}" is not a label of "${c.title}". Labels: ${options.map((o) => o.label).join(', ') || '(none)'}`,
  );
};

const personId = (c: IntegrationColumn, v: string, members: Member[]): string => {
  const hit =
    members.find((m) => m.user_id === v) ??
    members.find((m) => norm(m.email) === norm(v)) ??
    (() => {
      const byName = members.filter((m) => norm(m.name) === norm(v));
      if (byName.length > 1) throw new ValueError(`"${v}" matches several people for "${c.title}" — use the email`);
      return byName[0];
    })();
  if (!hit) throw new ValueError(`No member "${v}" for "${c.title}" (use a user id, an email or a unique name)`);
  return hit.user_id;
};

/** `2026-10-06`, `2026-10-06T14:30`, `2026-10-06 14:30:00` or a Date → `{date, time?}` (no time-zone shift). */
const dateValue = (c: IntegrationColumn, v: unknown): IDataObject => {
  const s = v instanceof Date ? v.toISOString() : String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) throw new ValueError(`"${s}" is not a date for "${c.title}" (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)`);
  const time = m[2] && !(m[2] === '00' && m[3] === '00') ? `${m[2]}:${m[3]}` : undefined;
  return time ? { date: m[1]!, time } : { date: m[1]! };
};

const isEmpty = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

/** A JSON object given as text (`{"…": …}`) — passed through as the raw value. */
const parsedObject = (v: unknown): IDataObject | undefined => {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) return v as IDataObject;
  if (typeof v === 'string' && /^\s*\{[\s\S]*\}\s*$/.test(v)) {
    try {
      return JSON.parse(v) as IDataObject;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * A typed or mapped value → the column's stored value. `undefined` = leave the column alone (empty input).
 * A JSON object is always taken as the raw value (any column type, for advanced use).
 */
export const toCellValue = (c: IntegrationColumn, input: unknown, members: Member[] = []): unknown => {
  if (isEmpty(input)) return undefined;
  const raw = parsedObject(input);
  if (raw) return raw;
  switch (c.type) {
    case 'text':
      return String(input);
    case 'long_text':
      return { text: String(input) };
    case 'numbers': {
      const n = typeof input === 'number' ? input : Number(String(input).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new ValueError(`"${String(input)}" is not a number for "${c.title}"`);
      return n;
    }
    case 'rating':
      return { rating: Math.round(Number(input)) };
    case 'checkbox': {
      const on = typeof input === 'boolean' ? input : ['true', '1', 'yes', 'v', 'x'].includes(norm(String(input)));
      return on ? { checked: true } : null;
    }
    case 'status':
      return { index: optionId(c, input) };
    case 'dropdown':
      return { ids: [...new Set(listOf(input).map((x) => optionId(c, x)))] };
    case 'people':
      return {
        persons_and_teams: [...new Set(listOf(input).map((x) => personId(c, x, members)))].map((id) => ({
          id,
          kind: 'person',
        })),
      };
    case 'tags': {
      // Tag ids (from the picker) or names (missing names are created by the platform).
      const list = [...new Set(listOf(input))];
      const names = list.filter((x) => !TAG_ID.test(x));
      return names.length ? { tag_ids: list.filter((x) => TAG_ID.test(x)), tags: names } : { tag_ids: list };
    }
    case 'board_relation':
    case 'dependency':
      return { item_ids: [...new Set(listOf(input))] };
    case 'date':
      return dateValue(c, input);
    case 'timeline': {
      const [from, to] = String(input).split(/\s+[–—-]\s+|\s*\/\s*/);
      const a = dateValue(c, from ?? '').date as string;
      return { from: a, to: to ? (dateValue(c, to).date as string) : a };
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
      if (!m) throw new ValueError(`"${String(input)}" is not an hour for "${c.title}" (use HH:MM)`);
      return { hour: Number(m[1]), minute: Number(m[2]) };
    }
    default:
      return fromSchema(c, input);
  }
};

/** Any other type, from its JSON Schema: a plain string / number, or an object with one required field. */
const fromSchema = (c: IntegrationColumn, input: unknown): unknown => {
  const s = c.value_schema;
  if (s?.type === 'string') return String(input);
  if (s?.type === 'number' || s?.type === 'integer') return Number(input);
  const required = (s?.required as string[] | undefined) ?? [];
  const props = (s?.properties as Record<string, IDataObject> | undefined) ?? {};
  if (s?.type === 'object' && required.length === 1) {
    const key = required[0]!;
    const p = props[key] ?? {};
    if (p.type === 'array') return { [key]: listOf(input) };
    if (p.type === 'number' || p.type === 'integer') return { [key]: Number(input) };
    if (p.type === 'string') return { [key]: String(input) };
  }
  throw new ValueError(`"${c.title}" (${c.type}) needs a JSON value, e.g. ${JSON.stringify(exampleOf(c))}`);
};

const exampleOf = (c: IntegrationColumn) => {
  const props = (c.value_schema?.properties as Record<string, IDataObject> | undefined) ?? {};
  return Object.fromEntries(
    ((c.value_schema?.required as string[] | undefined) ?? []).map((k) => [
      k,
      props[k]?.type === 'array' ? [] : props[k]?.type === 'number' || props[k]?.type === 'integer' ? 0 : '…',
    ]),
  );
};

/** A whole mapping (column id → input) → the `cells` object of a create / update call. */
export const toCells = (
  columns: IntegrationColumn[],
  values: Record<string, unknown>,
  members: Member[] = [],
): IDataObject => {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const out: IDataObject = {};
  for (const [id, v] of Object.entries(values)) {
    const c = byId.get(id);
    if (!c) throw new ValueError(`The board has no column "${id}"`);
    if (!c.writable) throw new ValueError(`"${c.title}" cannot be written (${c.type})`);
    const value = toCellValue(c, v, members);
    if (value !== undefined) out[id] = value as IDataObject;
  }
  return out;
};

/** Do these cells need the member list (a people column given by name or email)? */
export const needsMembers = (columns: IntegrationColumn[], values: Record<string, unknown>) =>
  columns.some((c) => c.type === 'people' && !isEmpty(values[c.id]) && !parsedObject(values[c.id]));

/**
 * The column mapping for moving an item to another board: the same column id with the same type, else the same
 * title (case-insensitive) with the same type. Columns with no counterpart are dropped (`null`).
 */
export const autoMapping = (from: IntegrationColumn[], to: IntegrationColumn[]): Record<string, string | null> =>
  Object.fromEntries(
    from
      .filter((c) => c.type !== 'name')
      .map((c) => {
        const hit =
          to.find((t) => t.id === c.id && t.type === c.type) ??
          to.find((t) => norm(t.title) === norm(c.title) && t.type === c.type);
        return [c.id, hit?.id ?? null];
      }),
  );

/** An item as the API returns it → a flat n8n item: fields + `column_values` (text) + `cells` (raw). */
export const simplifyItem = (item: IDataObject, columns?: IntegrationColumn[]): IDataObject => {
  const cells = (item.cells as Record<string, { value: unknown; text: string | null }> | undefined) ?? {};
  const titles = new Map((columns ?? []).map((c) => [c.id, c.title]));
  const columnValues: IDataObject = {};
  for (const [id, cell] of Object.entries(cells)) columnValues[titles.get(id) ?? id] = cell?.text ?? null;
  return { ...item, column_values: columnValues };
};
