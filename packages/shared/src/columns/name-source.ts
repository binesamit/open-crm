// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Item name source ("way 2"): every item keeps ONE stable id; a board (and, separately, each sub-board)
 * chooses what its items' names are:
 * - `free`     — typed by people (the default, today's behaviour);
 * - `column`   — the display text of one column (`column_id` = its key);
 * - `template` — text with column placeholders, e.g. `{client} – {date_1}` (`{key}`; `{{` / `}}` are literal braces).
 * A computed name is stored in `items.name` by the server, so search, filters, notifications, webhooks, export, MCP
 * and AI read it as before. Stored on the board's name column: `columns[type=name].settings.name_source`.
 */
export const NAME_SOURCE_MODES = ['free', 'column', 'template'] as const;
export type NameSourceMode = (typeof NAME_SOURCE_MODES)[number];

/** Column types that cannot feed a name (the name itself; a button has no text). */
export const NAME_SOURCE_EXCLUDED_TYPES: readonly string[] = ['name', 'button'];

export const NAME_TEMPLATE_MAX = 500;

export const nameSourceSchema = z
  .object({
    mode: z.enum(NAME_SOURCE_MODES).default('free'),
    /** `column` mode: the source column's key. */
    column_id: z.string().min(1).max(64).optional(),
    /** `template` mode: text with `{column_key}` placeholders. */
    template: z.string().max(NAME_TEMPLATE_MAX).optional(),
    /** Shown (and stored) when the computed text is empty — e.g. no client chosen yet. Empty = an empty name. */
    empty_text: z.string().max(255).optional(),
    /** Warn (never block) when two items of the board compute the same name — see GET /boards/:id/name-duplicates. */
    warn_duplicates: z.boolean().optional(),
    /**
     * a new item on a computed board stays in its row, its first source column active (default); true =
     * the item card opens instead (the earlier behaviour).
     */
    open_on_create: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'column' && !v.column_id)
      ctx.addIssue({ code: 'custom', path: ['column_id'], message: 'column mode needs column_id' });
    if (v.mode === 'template') {
      if (!v.template?.trim())
        ctx.addIssue({ code: 'custom', path: ['template'], message: 'template mode needs a template' });
      else if (!nameTemplateRefs(v.template).length)
        ctx.addIssue({ code: 'custom', path: ['template'], message: 'the template needs at least one {column}' });
    }
  });
export type NameSource = z.infer<typeof nameSourceSchema>;

export const FREE_NAME_SOURCE: NameSource = { mode: 'free' };

/** The name source of a board from its columns (its name column's settings); `free` when unset or invalid. */
export const nameSourceOfColumns = (columns: readonly { type: string; settings: unknown }[]): NameSource => {
  const col = columns.find((c) => c.type === 'name');
  return nameSourceOfSettings(col?.settings);
};

export const nameSourceOfSettings = (settings: unknown): NameSource => {
  const raw = (settings as { name_source?: unknown } | null | undefined)?.name_source;
  if (!raw) return FREE_NAME_SOURCE;
  const parsed = nameSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : FREE_NAME_SOURCE;
};

export const isComputedName = (s: NameSource) => s.mode === 'column' || s.mode === 'template';

type Part = { text: string } | { key: string };

/** A template as literal text and `{key}` parts (`{{` / `}}` are literal braces; an unclosed `{` is text). */
export const parseNameTemplate = (template: string): Part[] => {
  const parts: Part[] = [];
  let text = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if ((ch === '{' || ch === '}') && template[i + 1] === ch) {
      text += ch;
      i++;
      continue;
    }
    if (ch === '{') {
      const end = template.indexOf('}', i + 1);
      const key = end > i ? template.slice(i + 1, end).trim() : '';
      if (end > i && key && !key.includes('{')) {
        if (text) parts.push({ text });
        text = '';
        parts.push({ key });
        i = end;
        continue;
      }
    }
    text += ch;
  }
  if (text) parts.push({ text });
  return parts;
};

/** Column keys a template reads, in order, without repeats. */
export const nameTemplateRefs = (template: string): string[] => [
  ...new Set(parseNameTemplate(template).flatMap((p) => ('key' in p ? [p.key] : []))),
];

/** Column keys a name source reads (none for `free`). */
export const nameSourceRefs = (s: NameSource): string[] =>
  s.mode === 'column' && s.column_id
    ? [s.column_id]
    : s.mode === 'template' && s.template
      ? nameTemplateRefs(s.template)
      : [];

/** Separators left dangling at the ends when a placeholder is empty (`{client} – {date}` without a date). */
const DANGLING = /^[\s\-–—,;:|/·•]+|[\s\-–—,;:|/·•]+$/gu;

/**
 * The name a source gives, from each column's display text (`textOf(key)`, null / '' = empty). Whitespace runs
 * collapse, separators left at the ends by empty placeholders go, the result is cut to 255; all empty →
 * `empty_text` (or ''). `free` sources return null (the name is typed).
 */
export const renderNameSource = (s: NameSource, textOf: (key: string) => string | null | undefined): string | null => {
  if (!isComputedName(s)) return null;
  let out: string;
  if (s.mode === 'column') {
    out = (textOf(s.column_id!) ?? '').replace(/\s+/g, ' ').trim();
  } else {
    const parts = parseNameTemplate(s.template ?? '');
    const values = parts.map((p) => ('key' in p ? (textOf(p.key) ?? '').replace(/\s+/g, ' ').trim() : p.text));
    const anyValue = parts.some((p, i) => 'key' in p && values[i]);
    out = anyValue ? values.join('').replace(/\s+/g, ' ').replace(DANGLING, '').trim() : '';
  }
  if (!out) out = (s.empty_text ?? '').trim();
  return out.slice(0, 255);
};

/** `renderNameSource` for a template string alone (previews in the settings dialog). */
export const renderNameTemplate = (
  template: string,
  textOf: (key: string) => string | null | undefined,
  emptyText?: string,
): string => renderNameSource({ mode: 'template', template, empty_text: emptyText }, textOf) ?? '';

/** A template with titles instead of keys (`{Client} – {Date}`) — what the settings dialog shows. */
export const nameTemplateToTitles = (template: string, columns: readonly { id: string; title: string }[]) =>
  parseNameTemplate(template)
    .map((p) =>
      'key' in p
        ? `{${columns.find((c) => c.id === p.key)?.title ?? p.key}}`
        : p.text.replace(/\{/g, '{{').replace(/\}/g, '}}'),
    )
    .join('');

/** The reverse: `{Client}` → `{client_key}` (by title, first match; a placeholder that is already a key stays). */
export const nameTemplateFromTitles = (text: string, columns: readonly { id: string; title: string }[]) =>
  parseNameTemplate(text)
    .map((p) => {
      if (!('key' in p)) return p.text.replace(/\{/g, '{{').replace(/\}/g, '}}');
      const byKey = columns.find((c) => c.id === p.key);
      const byTitle = columns.find((c) => c.title.trim() === p.key);
      return `{${byKey?.id ?? byTitle?.id ?? p.key}}`;
    })
    .join('');

/**
 * Why a source cannot be saved on a board with these columns, or null: unknown / excluded columns. `columns` uses
 * the API's shape (`id` = key).
 */
export const nameSourceProblem = (
  s: NameSource,
  columns: readonly { id: string; type: string }[],
): { reason: 'unknown_column' | 'column_not_allowed'; column_id: string } | null => {
  for (const key of nameSourceRefs(s)) {
    const col = columns.find((c) => c.id === key);
    if (!col) return { reason: 'unknown_column', column_id: key };
    if (NAME_SOURCE_EXCLUDED_TYPES.includes(col.type)) return { reason: 'column_not_allowed', column_id: key };
  }
  return null;
};

// ---- API shapes ----

/** GET/PUT /boards/:id/name-source — the recompute run a change started (big boards: in the background). */
export const nameRecomputeSchema = z.object({
  status: z.enum(['running', 'done', 'failed']),
  /** `sync`: done in the request; `background`: a job (progress on the board's live channel). */
  mode: z.enum(['sync', 'background']),
  total: z.number().int(),
  done: z.number().int(),
  /** Items whose name changed. */
  renamed: z.number().int(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type NameRecompute = z.infer<typeof nameRecomputeSchema>;

export const nameSourceOutSchema = z.object({
  board_id: z.string(),
  name_source: nameSourceSchema,
  /** True when names are computed (`column` / `template`). */
  computed: z.boolean(),
  /** Column keys the name reads. */
  refs: z.array(z.string()),
  /** The last recompute (null: never ran). */
  recompute: nameRecomputeSchema.nullable(),
});
export type NameSourceOut = z.infer<typeof nameSourceOutSchema>;

export const nameDuplicatesSchema = z.object({
  board_id: z.string(),
  /** The board's `warn_duplicates` setting (the list is computed either way). */
  warn: z.boolean(),
  /** How many names are shared by more than one item, and how many items share them. */
  count: z.number().int(),
  items: z.number().int(),
  /** Up to 100 names, the most shared first, with up to 20 item ids each. */
  groups: z.array(z.object({ name: z.string(), count: z.number().int(), item_ids: z.array(z.string()) })),
});
export type NameDuplicates = z.infer<typeof nameDuplicatesSchema>;

/** Above this many items a recompute runs as a background job (sync below it). */
export const NAME_RECOMPUTE_SYNC_MAX = 2000;
/** Items per recompute window (a background job commits and reports progress per window). */
export const NAME_RECOMPUTE_WINDOW = 500;
