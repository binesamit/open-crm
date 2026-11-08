// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Moving items between boards (07 §3.4) and converting item ↔ subitem (§3.7): the cells follow a column mapping
 * `source column id → target column id | null` (null = not moved; the value is kept for undo).
 */
export const columnMappingSchema = z.record(z.string(), z.string().nullable());
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const moveToBoardSchema = z.object({
  board_id: z.string(),
  /** Target group; default: the target board's first group. */
  group_id: z.string().optional(),
  /** Omitted → mapped automatically (same type and title, else the only column of that type), like the move dialog. */
  mapping: columnMappingSchema.optional(),
});

export const moveGroupToBoardSchema = z.object({ board_id: z.string(), mapping: columnMappingSchema });

/** To a subitem of `parent_item_id` (same board), or back to a top-level item in `group_id`. */
export const convertItemSchema = z
  .object({
    parent_item_id: z.string().optional(),
    group_id: z.string().optional(),
    /** Omitted → mapped automatically by type + title (e.g. the sub-board does not exist yet). */
    mapping: columnMappingSchema.optional(),
  })
  .refine((v) => !!v.parent_item_id !== !!v.group_id, { message: 'parent_item_id or group_id' });

export const movedSchema = z.object({ ok: z.literal(true), event_id: z.string(), dropped: z.number().int() });
export type Moved = z.infer<typeof movedSchema>;

type Col = { id: string; type: string; title: string };

/** Titles compare trimmed, case- and niqqud-insensitive (07 §3.4.1). */
export const normalizeTitle = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[֑-ׇ̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/**
 * Pairs of different types a move converts (04 §6.2), through the value's text (`convertCellValue`). Labels
 * (status, dropdown) always go by label text — their ids belong to the board.
 */
export const CONVERTIBLE: Record<string, string[]> = {
  text: ['long_text'],
  long_text: ['text'],
  numbers: ['text', 'rating'],
  rating: ['numbers', 'text'],
  status: ['text', 'dropdown'],
  dropdown: ['text', 'status'],
  date: ['timeline', 'text'],
  timeline: ['date', 'text'],
  email: ['text'],
  phone: ['text'],
  link: ['text'],
  people: ['text'],
  checkbox: ['text'],
};

/** Which target columns a source column may go to: the same type, or a type it converts to. */
export const mappingCandidates = (source: Col, targets: Col[]) =>
  targets.filter((t) => t.type === source.type || (CONVERTIBLE[source.type] ?? []).includes(t.type));

/**
 * The proposal of the mapping dialog: same type + same title first; otherwise the only unused column of that
 * type on the target; otherwise not moved. The name column always maps to the name column.
 */
export const proposeMapping = (sources: Col[], targets: Col[]): ColumnMapping => {
  const out: ColumnMapping = {};
  const used = new Set<string>();
  const sorted = [...sources].sort((a, b) => Number(a.type !== 'name') - Number(b.type !== 'name'));
  // Pass 1: exact type + title.
  for (const s of sorted) {
    const hit = targets.find(
      (t) => !used.has(t.id) && t.type === s.type && normalizeTitle(t.title) === normalizeTitle(s.title),
    );
    if (hit || s.type === 'name') {
      const target = hit ?? targets.find((t) => t.type === 'name');
      out[s.id] = target?.id ?? null;
      if (target) used.add(target.id);
    }
  }
  // Pass 2: the one remaining column of the same type.
  for (const s of sorted) {
    if (s.id in out) continue;
    const free = targets.filter((t) => !used.has(t.id) && t.type === s.type);
    const sameTypeLeft = sorted.filter((x) => !(x.id in out) && x.type === s.type).length;
    out[s.id] = free.length === 1 && sameTypeLeft === 1 ? free[0]!.id : null;
    if (out[s.id]) used.add(out[s.id]!);
  }
  return out;
};

/** A settings value that points at other columns of the source board (e.g. a date's `deadline`). */
const refersToColumns = (key: string, value: unknown) =>
  key.endsWith('_column_id') ||
  key.endsWith('_column_ids') ||
  (!!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).some((k) => k.endsWith('_column_id') || k.endsWith('_column_ids')));

/**
 * "+ New column" in the mapping dialog (fix3): the column a source column makes on the target board — the same
 * type, title, description and settings (labels, unit, format…), minus settings that point at other columns of the
 * source board (they mean nothing on the target). The body of POST /boards/:id/columns.
 */
export const columnCopyFor = (source: {
  type: string;
  title: string;
  description?: string | null;
  settings?: Record<string, unknown> | null;
}) => ({
  title: source.title,
  type: source.type,
  ...(source.description ? { description: source.description } : {}),
  settings: Object.fromEntries(Object.entries(source.settings ?? {}).filter(([k, v]) => !refersToColumns(k, v))),
});
