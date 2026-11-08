// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { richDocSchema } from '../rich';

/**
 * Item templates: an item and its subitems at every depth, saved on a
 * board with a value per column, updates and files at every level, and variables asked when it is applied. One
 * model for every way in: save from an item, the editor, the "new item" menu, subitems under an item, the API and
 * the AI tools (MCP, the assistant, agents) — automations and forms come next on the same model.
 *
 * A value is one of:
 * - `value`: a cell value as the column stores it (re-validated against the column when applied);
 * - `date`: a date / timeline moved with a date variable — `from` (and a timeline's `to`) are working days after
 *   it on the account's calendar (weekend + holidays), so the whole tree moves together;
 * - `var`: the variable's answer (a person into a people column, text into a text column, a date as is);
 * - `text`: text with `{variable}` fields (text / long text columns);
 * - `files`: files the template holds (its own copies), copied into the new item's file column.
 * Names and updates may carry `{variable}` fields too.
 */
export const ITEM_TEMPLATE_NAME_MAX = 120;
export const ITEM_TEMPLATE_NODES_MAX = 500;
export const ITEM_TEMPLATE_VARS_MAX = 12;
export const ITEM_TEMPLATE_UPDATES_MAX = 20;
export const ITEM_TEMPLATE_FILES_MAX = 20;

export const ITEM_TEMPLATE_VAR_TYPES = ['text', 'date', 'person'] as const;
export type ItemTemplateVarType = (typeof ITEM_TEMPLATE_VAR_TYPES)[number];

export const itemTemplateVarKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'a-z, 0-9 and _');

export const itemTemplateVariableSchema = z.object({
  key: itemTemplateVarKeySchema,
  label: z.string().trim().min(1).max(60),
  type: z.enum(ITEM_TEMPLATE_VAR_TYPES),
  required: z.boolean().default(false),
  /** A text variable's default, or `today` for a date one. */
  default: z.string().max(255).nullable().default(null),
});
export type ItemTemplateVariable = z.infer<typeof itemTemplateVariableSchema>;

export const itemTemplateFileSchema = z.object({
  /** The template's own copy of the file (an asset of the account). */
  asset_id: z.string().max(64),
  name: z.string().max(255),
});
export type ItemTemplateFile = z.infer<typeof itemTemplateFileSchema>;

const offset = z.number().min(-3650).max(3650);
export const itemTemplateCellSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.unknown() }),
  z.object({
    kind: z.literal('date'),
    var: itemTemplateVarKeySchema,
    from: offset,
    to: offset.nullable().default(null),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .default(null),
  }),
  z.object({ kind: z.literal('var'), var: itemTemplateVarKeySchema }),
  z.object({ kind: z.literal('text'), text: z.string().max(10_000) }),
  z.object({ kind: z.literal('files'), files: z.array(itemTemplateFileSchema).max(ITEM_TEMPLATE_FILES_MAX) }),
]);
export type ItemTemplateCell = z.infer<typeof itemTemplateCellSchema>;

export const itemTemplateUpdateSchema = z.object({
  /** Plain text with `{variable}` fields (line breaks kept); `doc` wins when sent. */
  text: z.string().max(20_000).default(''),
  /** Rich text (the update editor's document), `{variable}` fields in its text too. */
  doc: richDocSchema.nullable().default(null),
  pinned: z.boolean().default(false),
  files: z.array(itemTemplateFileSchema).max(ITEM_TEMPLATE_FILES_MAX).default([]),
});
export type ItemTemplateUpdate = z.infer<typeof itemTemplateUpdateSchema>;

export type ItemTemplateNode = {
  /** Stable within the template (the editor's selection, conditions later). */
  id: string;
  name: string;
  /** By column key: the item's board (depth 0) or its subitems board (deeper). */
  cells: Record<string, ItemTemplateCell>;
  updates: ItemTemplateUpdate[];
  children: ItemTemplateNode[];
};
// Recursive via a getter (zod 4), which JSON Schema / OpenAPI generation understands, unlike z.lazy (as richNodeSchema).
export const itemTemplateNodeSchema = z
  .object({
    id: z.string().min(1).max(40).describe('Stable within the template (any short text)'),
    name: z.string().max(255).describe('The item name; may hold {variable} fields'),
    cells: z
      .record(z.string().max(64), itemTemplateCellSchema)
      .default({})
      .describe('By column key: the board columns for the top item, the subitems columns below it'),
    updates: z.array(itemTemplateUpdateSchema).max(ITEM_TEMPLATE_UPDATES_MAX).default([]),
    get children() {
      return z.array(itemTemplateNodeSchema).max(ITEM_TEMPLATE_NODES_MAX).default([]);
    },
  })
  .meta({ id: 'ItemTemplateNode' });

export const itemTemplateDtoSchema = z
  .object({
    id: z.string(),
    board_id: z.string(),
    name: z.string(),
    category: z.string(),
    description: z.string(),
    variables: z.array(itemTemplateVariableSchema),
    root: itemTemplateNodeSchema,
    /** Items in the tree (the root included) and its depth (0 = the item alone). */
    nodes: z.number().int(),
    depth: z.number().int(),
    version: z.number().int(),
    source_item_id: z.string().nullable(),
    created_by: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: 'ItemTemplate' });
export type ItemTemplateDto = z.infer<typeof itemTemplateDtoSchema>;

/** The list: everything but the tree. */
export const itemTemplateSummarySchema = itemTemplateDtoSchema.omit({ root: true }).meta({ id: 'ItemTemplateSummary' });
export type ItemTemplateSummary = z.infer<typeof itemTemplateSummarySchema>;
export const itemTemplateListSchema = z
  .object({ data: z.array(itemTemplateSummarySchema) })
  .meta({ id: 'ItemTemplateList' });

/**
 * POST /items/{id}/save-as-template — the item (and its subitems) as a template. Suggested variables are made from
 * what the tree holds: `start` (the earliest date: every date moves with it, in working days), `owner` (the item's
 * first people column: the same people anywhere in the tree), `name` (the item's name: its new name, and wherever
 * the old one appears in the tree's names and updates). Each can be left out.
 */
export const saveItemAsTemplateSchema = z.object({
  name: z.string().trim().min(1).max(ITEM_TEMPLATE_NAME_MAX),
  category: z.string().trim().max(60).default(''),
  description: z.string().trim().max(500).default(''),
  with_subitems: z.boolean().default(true),
  with_updates: z.boolean().default(true),
  with_files: z.boolean().default(true),
  variables: z
    .object({ start: z.boolean().default(true), owner: z.boolean().default(true), name: z.boolean().default(true) })
    .default({ start: true, owner: true, name: true }),
});
export type SaveItemAsTemplate = z.infer<typeof saveItemAsTemplateSchema>;

/** POST /boards/{id}/item-templates — a template built from scratch (the editor, the API, the AI tools). */
export const createItemTemplateSchema = z.object({
  name: z.string().trim().min(1).max(ITEM_TEMPLATE_NAME_MAX),
  category: z.string().trim().max(60).default(''),
  description: z.string().trim().max(500).default(''),
  variables: z.array(itemTemplateVariableSchema).max(ITEM_TEMPLATE_VARS_MAX).default([]),
  root: itemTemplateNodeSchema,
});
export type CreateItemTemplate = z.infer<typeof createItemTemplateSchema>;

/** PATCH /item-templates/{id} — any of these; a new tree or variables is a new version. */
export const updateItemTemplateSchema = createItemTemplateSchema.partial();
export type UpdateItemTemplate = z.infer<typeof updateItemTemplateSchema>;

/** A variable's answer: text, a date (YYYY-MM-DD), or people (user ids). */
export const itemTemplateAnswerSchema = z.union([z.string().max(1000), z.array(z.string().max(64)).max(50)]);

/**
 * POST /item-templates/{id}/apply — a new item from the template (in a group of its board, the first one by default),
 * or (`parent_item_id`) the template's subitems under an existing item, whose empty cells take the template's
 * values (filled values are never overwritten). One call = one undoable batch.
 */
export const applyItemTemplateSchema = z.object({
  group_id: z.string().max(64).optional(),
  parent_item_id: z.string().max(64).optional(),
  position: z.enum(['top', 'bottom']).default('bottom'),
  variables: z.record(itemTemplateVarKeySchema, itemTemplateAnswerSchema).default({}),
});
export type ApplyItemTemplate = z.infer<typeof applyItemTemplateSchema>;

export const applyItemTemplateResultSchema = z
  .object({
    /** The new item (a new item), or the item the subitems went under. */
    item_id: z.string(),
    /** Items made (the new item and its subitems, or the subitems). */
    created: z.number().int(),
    /** One undo for everything (POST /activity/batches/{id}/undo). */
    batch_id: z.string(),
    /** Values that could not be set (a column the board no longer has, a value it no longer accepts). */
    skipped: z.array(z.object({ column: z.string(), reason: z.string() })),
  })
  .meta({ id: 'ApplyItemTemplateResult' });
export type ApplyItemTemplateResult = z.infer<typeof applyItemTemplateResultSchema>;

/** Items and depth of a tree (the root counts; depth 0 = the item alone). */
export const itemTemplateStats = (root: ItemTemplateNode) => {
  let nodes = 0;
  let depth = 0;
  const walk = (n: ItemTemplateNode, d: number) => {
    nodes++;
    depth = Math.max(depth, d);
    for (const c of n.children) walk(c, d + 1);
  };
  walk(root, 0);
  return { nodes, depth };
};

/** `{key}` fields of known variables replaced by their text; anything else stays as written. */
export const fillItemTemplateText = (text: string, values: Record<string, string>) =>
  text.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (m, key: string) => (key in values ? values[key]! : m));

// ---- phase 2: answers taken from an item (automations) or a form's answers ----

/** The column types a variable of each type takes its answer from (a text variable: any column). */
export const ITEM_TEMPLATE_VAR_SOURCE_TYPES: Record<ItemTemplateVarType, readonly string[] | null> = {
  date: ['date', 'timeline'],
  person: ['people'],
  text: null,
};

/** May a variable of this type take its answer from a column of this type (`name` = the item's name)? */
export const itemTemplateVarFits = (type: ItemTemplateVarType, columnType: string) => {
  const fits = ITEM_TEMPLATE_VAR_SOURCE_TYPES[type];
  return columnType === 'name' ? type === 'text' : !fits || fits.includes(columnType);
};

/**
 * A variable's answer from a cell: a date column's day (a timeline's start), a people column's people (persons; teams
 * are not people to assign), any column's text for a text variable. Undefined = nothing to answer with.
 */
export const itemTemplateAnswerFromCell = (
  type: ItemTemplateVarType,
  cell: { type: string; value: unknown; text?: string | null },
): string | string[] | undefined => {
  if (cell.value === null || cell.value === undefined) return undefined;
  if (type === 'person') {
    if (cell.type !== 'people') return undefined;
    const ids = ((cell.value as { persons_and_teams?: { id: string; kind: string }[] }).persons_and_teams ?? [])
      .filter((p) => p.kind === 'person')
      .map((p) => p.id);
    return ids.length ? ids.slice(0, 50) : undefined;
  }
  if (type === 'date') {
    const v = cell.value as { date?: unknown; from?: unknown };
    const day = cell.type === 'date' ? v.date : cell.type === 'timeline' ? v.from : undefined;
    return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(0, 10) : undefined;
  }
  const text = (cell.text ?? '').trim();
  return text ? text.slice(0, 1000) : undefined;
};

/**
 * A first proposal of where each variable's answer comes from, out of the columns there are (an automation's
 * trigger item, a form's questions): a text variable keyed `name` → the name; a date one → the first date / timeline
 * column; a person one → the first people column. Only a proposal: every choice is the person's to change.
 */
export const proposeItemTemplateSources = <C extends { key: string; type: string }>(
  vars: Pick<ItemTemplateVariable, 'key' | 'type'>[],
  columns: C[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const v of vars) {
    if (v.type === 'text') {
      const name = columns.find((c) => c.type === 'name');
      if (v.key === 'name' && name) out[v.key] = name.key;
      continue;
    }
    const c = columns.find((x) => x.type !== 'name' && itemTemplateVarFits(v.type, x.type));
    if (c) out[v.key] = c.key;
  }
  return out;
};
