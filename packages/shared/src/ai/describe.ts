// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { AiToolDef } from './tools/types';

/**
 * "Describe an action" (sync-ai, product fix list: "approvals show JSON a person cannot read"). Whatever an AI wants to
 * do — an agent's approval request, an agent's run step, the assistant's proposed change — is shown as a sentence in
 * the reader's language with real names ("Change Status of "Lead X" on board "Leads" to "Won"") plus a few
 * "field: value" lines; the raw JSON stays behind a "technical details" toggle.
 *
 * Generic, never per board: the tool's input schema says which fields there are, and the input's id fields are
 * resolved by their name — `board_id` → the board's name, `item_id` / `parent_item_id` → the item's, `group_id`,
 * `column_id`, `update_id`, `automation_id`, `workspace_id`, `folder_id`, `file_id`, `user_id`, `dashboard_id`,
 * `widget_id` — and the cells by the
 * board's own columns (title + the value as the column type writes it). The server resolves (as the reader, with
 * their access); this file is pure: which refs an input has, and the description from the resolved names. The web
 * turns it into words with i18n: `ai.describe.<tool>[.<variant>]` (params = the names below), else a generic
 * sentence with the tool's label; detail labels `ai.field.<field>`; enum values `ai.enum.<value>`.
 */

export const DESC_REF_KINDS = [
  'board',
  'item',
  'group',
  'column',
  'update',
  'automation',
  'workspace',
  'folder',
  'file',
  'user',
  'dashboard',
  'widget',
  'item_template',
] as const;
export type DescRefKind = (typeof DESC_REF_KINDS)[number];

/** Input fields that point at something, by name — the same names every tool schema uses. */
export const DESC_REF_FIELDS: Readonly<Record<string, DescRefKind>> = {
  board_id: 'board',
  item_id: 'item',
  parent_item_id: 'item',
  group_id: 'group',
  column_id: 'column',
  after_column_id: 'column',
  before_column_id: 'column',
  update_id: 'update',
  automation_id: 'automation',
  workspace_id: 'workspace',
  folder_id: 'folder',
  file_id: 'file',
  user_id: 'user',
  dashboard_id: 'dashboard',
  widget_id: 'widget',
  template_id: 'item_template',
};

/** Plain-text fields that read as part of the sentence (a name, a title) rather than a detail line. */
const SENTENCE_TEXT = new Set(['name', 'title']);
/** A name / title next to one of these ids renames that thing. */
const RENAMED_BY = ['item_id', 'group_id', 'column_id', 'automation_id', 'widget_id'];
/** Cell maps (column id → value). */
const CELL_FIELDS = new Set(['cells', 'column_values']);

export const descValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('number'), value: z.number() }),
  z.object({ kind: z.literal('bool'), value: z.boolean() }),
  /** One value of a fixed list in the schema (`top`, `asc`, `succeeded` …) — translated as `ai.enum.<value>`. */
  z.object({ kind: z.literal('enum'), value: z.string() }),
  z.object({ kind: z.literal('date'), value: z.string() }),
  z.object({ kind: z.literal('datetime'), value: z.string() }),
  /** A cell value set to empty. */
  z.object({ kind: z.literal('clear') }),
]);
export type DescValue = z.infer<typeof descValueSchema>;

export const actionDescriptionSchema = z
  .object({
    tool: z.string(),
    /** A finer sentence when the input allows one: `one_cell` (a single cell set), `clear_cell` (one cleared). */
    variant: z.string().nullable(),
    /** Names for the sentence (`board`, `item`, `group`, `column`, `value`, `name`, `title` …); null = not found / not visible. */
    params: z.record(z.string(), z.string().nullable()),
    /** Lines under the sentence: a cell (`field: "cell"`, `label` = the column's title) or another input field. */
    details: z.array(z.object({ field: z.string(), label: z.string().nullable(), value: descValueSchema })),
  })
  .meta({ id: 'ActionDescription' });
export type ActionDescription = z.infer<typeof actionDescriptionSchema>;

export type DescRef = { kind: DescRefKind; id: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The ids an input points at (deduplicated) — what the server resolves before describing. */
export const descriptionRefs = (input: unknown): DescRef[] => {
  if (!isRecord(input)) return [];
  const out = new Map<string, DescRef>();
  const add = (kind: DescRefKind, id: unknown) => {
    if (typeof id === 'string' && id) out.set(`${kind}:${id}`, { kind, id });
  };
  for (const [key, value] of Object.entries(input)) {
    const kind = DESC_REF_FIELDS[key];
    if (kind) add(kind, value);
    // A position next to another item.
    if (key === 'position' && isRecord(value)) {
      add('item', value.after_id);
      add('item', value.before_id);
    }
  }
  return [...out.values()];
};

/** The column ids of the input's cells. */
export const descriptionCellKeys = (input: unknown): string[] => {
  if (!isRecord(input)) return [];
  return Object.entries(input).flatMap(([k, v]) => (CELL_FIELDS.has(k) && isRecord(v) ? Object.keys(v) : []));
};

/**
 * What the server knows: a name per ref, a cell's column title + value as text (null = cleared), and the board the
 * input is about when it names none itself (an item's board — "… on board "Leads"").
 */
export type DescNames = {
  board?: string | null;
  name: (ref: DescRef) => string | null | undefined;
  cell?: (columnId: string, raw: unknown) => { title: string | null; text: string | null } | undefined;
};

type AnySchema = { def?: { type?: string; innerType?: AnySchema; entries?: unknown } };
/** The schema under optional / default / nullable wrappers. */
const core = (s: unknown): AnySchema | undefined => {
  let cur = s as AnySchema | undefined;
  for (
    let i = 0;
    i < 6 && cur?.def?.innerType && ['optional', 'default', 'nullable', 'prefault'].includes(cur.def.type ?? '');
    i++
  )
    cur = cur.def.innerType;
  return cur;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MAX_TEXT = 300;
const short = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

const scalarValue = (value: unknown, schema: unknown): DescValue | null => {
  if (value === null) return { kind: 'clear' };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value !== 'string') return null;
  if (core(schema)?.def?.type === 'enum') return { kind: 'enum', value };
  if (ISO_DATE.test(value)) return { kind: 'date', value };
  if (ISO_DATETIME.test(value)) return { kind: 'datetime', value };
  return { kind: 'text', text: short(value) };
};

/**
 * The description of one tool call. `tool` may be a remote MCP tool (no schema here): its scalars still become
 * detail lines, its ids are still resolved by name.
 */
export const describeAction = (
  tool: Pick<AiToolDef, 'name'> & { input?: AiToolDef['input'] },
  input: unknown,
  names: DescNames,
): ActionDescription => {
  const shape = (tool.input as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
  const params: Record<string, string | null> = {};
  const details: ActionDescription['details'] = [];
  const cells: { title: string | null; text: string | null }[] = [];
  const data = isRecord(input) ? input : {};
  for (const [key, value] of Object.entries(data)) {
    const kind = DESC_REF_FIELDS[key];
    if (kind && typeof value === 'string') {
      params[key.replace(/_id$/, '')] = names.name({ kind, id: value }) ?? null;
      continue;
    }
    if (CELL_FIELDS.has(key) && isRecord(value)) {
      for (const [col, raw] of Object.entries(value)) {
        const c = names.cell?.(col, raw);
        const text = c ? c.text : raw === null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw);
        const title = c?.title ?? null;
        cells.push({ title, text });
        details.push({
          field: 'cell',
          label: title ?? col,
          value: text === null || text === '' ? { kind: 'clear' } : { kind: 'text', text: short(text) },
        });
      }
      continue;
    }
    if (key === 'position') {
      if (typeof value === 'string') details.push({ field: 'position', label: null, value: { kind: 'enum', value } });
      else if (isRecord(value)) {
        const side =
          typeof value.after_id === 'string' ? 'after' : typeof value.before_id === 'string' ? 'before' : null;
        if (side) {
          const name = names.name({ kind: 'item', id: String(value[`${side}_id`]) });
          details.push({ field: `position_${side}`, label: null, value: { kind: 'text', text: name ?? '—' } });
        }
      }
      continue;
    }
    if (SENTENCE_TEXT.has(key) && typeof value === 'string') {
      params[key] = short(value);
      // Next to the id of what it names, it is a rename: also a line ("New name: …").
      if (RENAMED_BY.some((k) => typeof data[k] === 'string'))
        details.push({ field: key, label: null, value: { kind: 'text', text: short(value) } });
      continue;
    }
    // Nested objects (a recipe, settings, a mapping, a filter) are for the technical details only.
    const v = scalarValue(value, shape[key]);
    if (v) details.push({ field: key, label: null, value: v });
  }
  let variant: string | null = params.parent_item !== undefined && params.board === undefined ? 'subitem' : null;
  // One cell and nothing else to say: "Change Status of "X" to "Won"".
  if (cells.length === 1 && params.name === undefined) {
    params.column = cells[0]!.title;
    params.value = cells[0]!.text;
    variant = cells[0]!.text === null || cells[0]!.text === '' ? 'clear_cell' : 'one_cell';
    details.splice(
      details.findIndex((d) => d.field === 'cell'),
      1,
    );
  }
  // An image made onto a new update (no file column): its own sentence (AI images).
  if (tool.name === 'generate_image' && params.column === undefined) variant = 'to_update';
  // A widget added without a title: "Add a widget to dashboard "Sales"".
  if (tool.name === 'add_dashboard_widget' && !params.title) variant = 'untitled';
  if (params.board === undefined && names.board !== undefined && params.parent_item === undefined)
    params.board = names.board;
  return { tool: tool.name, variant, params, details };
};

/**
 * A language-neutral line for places without i18n (a notification excerpt, the stored preview): the tool's title,
 * the names in quotes and the cells as "Column: value".
 */
export const plainDescription = (title: string, d: ActionDescription) => {
  const names = Object.entries(d.params)
    .filter(([k, v]) => v && k !== 'value' && k !== 'column')
    .map(([, v]) => `"${v}"`);
  const cell = d.variant && d.params.column ? [`${d.params.column}: ${d.params.value ?? '—'}`] : [];
  const lines = d.details
    .filter((x) => x.field === 'cell')
    .map((x) => `${x.label}: ${x.value.kind === 'text' ? x.value.text : '—'}`);
  const rest = [...names, ...cell, ...lines].join(' · ');
  const out = rest ? `${title}: ${rest}` : title;
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
};
