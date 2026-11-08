// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Integration helpers for no-code platforms (n8n, Make, Zapier-style apps): a flat board list for pickers, a board
 * "schema" that tells a client how to render a field per column type (options, JSON Schema of the value), and a
 * find-by-column-value search (phone / email aware). Generic: nothing here knows a specific board or account.
 */

export const boardListEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    workspace_id: z.string(),
    workspace_name: z.string(),
    folder_id: z.string().nullable(),
  })
  .meta({ id: 'BoardListEntry' });
export type BoardListEntry = z.infer<typeof boardListEntrySchema>;

export const boardListQuerySchema = z.object({
  /** Part of the board name (case-insensitive). */
  q: z.string().max(100).optional(),
  workspace_id: z.string().max(40).optional(),
});

/** One choice of a status / dropdown column (its `id` is what the cell value stores). */
export const columnOptionSchema = z.object({ id: z.number().int(), label: z.string(), color: z.string().nullable() });
export type ColumnOption = z.infer<typeof columnOptionSchema>;

export const integrationColumnSchema = z
  .object({
    id: z.string().describe('column key — the key of `cells` when creating or updating an item'),
    title: z.string(),
    type: z.string(),
    description: z.string().nullable(),
    /** A client may write this column's value through `cells` (not computed, not read-only, not a files column). */
    writable: z.boolean(),
    /**
     * How the value reads (the filter model of the type): text, number, date, label (one option), labels (several
     * options), people, checkbox, links, files, tags.
     */
    value_model: z.string(),
    /** status / dropdown: the active options; else null. */
    options: z.array(columnOptionSchema).nullable(),
    /** JSON Schema of the cell value (what `cells.<id>` accepts); null when the type has none to offer. */
    value_schema: z.record(z.string(), z.unknown()).nullable(),
    /**
     * Connect-boards columns: the boards whose items the column links (pick values with
     * `GET /boards/{id}/items/search`); else null.
     */
    linked_board_ids: z.array(z.string()).nullable(),
  })
  .meta({ id: 'IntegrationColumn' });
export type IntegrationColumn = z.infer<typeof integrationColumnSchema>;

export const boardSchemaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    groups: z.array(z.object({ id: z.string(), title: z.string(), color: z.string() })),
    columns: z.array(integrationColumnSchema),
    /** The board's sub-board (subitems), once it exists. */
    subitems: z.object({ board_id: z.string(), columns: z.array(integrationColumnSchema) }).nullable(),
  })
  .meta({ id: 'BoardSchema' });
export type BoardSchema = z.infer<typeof boardSchemaSchema>;

export const COLUMN_CHOICES_MAX = 100;

export const columnChoicesQuerySchema = z.object({
  /** Part of the value (case-insensitive); empty = the first ones. */
  q: z.string().max(100).default(''),
  /** `true`: `columnId` is a column of the board's sub-board (subitems). */
  subitems: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/**
 * One value a column can hold, for a value picker. `id` is what a filter / a write takes (label id, user id, tag
 * id, item id); null for free-text columns, where `text` is the value itself. `text` is what the cell reads (and
 * what find-by-value compares).
 */
export const columnChoiceSchema = z.object({
  id: z.string().nullable(),
  text: z.string(),
  /** People: the email (when the token may read users); linked items: the board name. */
  hint: z.string().nullable(),
});
export type ColumnChoice = z.infer<typeof columnChoiceSchema>;

export const columnChoicesSchema = z
  .object({
    /** labels (status, dropdown), people, tags, items (connect boards, item name) or values (existing text). */
    kind: z.enum(['labels', 'people', 'tags', 'items', 'values']),
    data: z.array(columnChoiceSchema),
  })
  .meta({ id: 'ColumnChoices' });
export type ColumnChoices = z.infer<typeof columnChoicesSchema>;

export const FIND_ITEMS_MAX = 50;

export const findItemsSchema = z.object({
  /** A column key of the board, or `name` for the item name. */
  column_id: z.string().min(1).max(64),
  value: z.string().trim().min(1).max(500),
  /**
   * `exact` (default): the same value — phone numbers compare by digits (formatting, a leading 0 or a country
   * prefix do not matter), emails case-insensitively, everything else by its text, case-insensitively. `contains`:
   * the text contains the value.
   */
  match: z.enum(['exact', 'contains']).default('exact'),
  limit: z.number().int().min(1).max(FIND_ITEMS_MAX).default(10),
});
export type FindItemsInput = z.infer<typeof findItemsSchema>;

const PHONE_MIN_DIGITS = 7;
const digitsOf = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');

/** Two phone numbers are the same when their digits (without leading zeros) match, or one ends with the other. */
export const samePhone = (a: string, b: string): boolean => {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= PHONE_MIN_DIGITS && long.endsWith(short);
};

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * Does a stored cell match the searched value? `type` is the column type, `value` the stored JSON value and `text`
 * its derived text.
 */
export const cellMatches = (
  type: string,
  stored: { value: unknown; text: string | null },
  searched: string,
  match: 'exact' | 'contains',
): boolean => {
  const v = stored.value as Record<string, unknown> | null;
  const candidates: string[] = [];
  if (type === 'email' && v && typeof v === 'object' && typeof v.email === 'string') candidates.push(v.email);
  if (type === 'phone' && v && typeof v === 'object' && typeof v.phone === 'string') {
    if (match === 'exact') return samePhone(v.phone, searched);
    candidates.push(v.phone);
  }
  if (stored.text) candidates.push(stored.text);
  const q = norm(searched);
  return candidates.some((c) => (match === 'exact' ? norm(c) === q : norm(c).includes(q)));
};
