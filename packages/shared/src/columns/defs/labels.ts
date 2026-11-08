// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DEFAULT_STATUS_LABELS, labelColorKey, labelColorSchema } from '../../colors';
import type { ColumnTypeDef } from '../types';
import { activeLabelsOf, normText, textParts } from '../text-ctx';
import { statusWorkflowSchema } from '../../workflows/status-workflow';

export const statusLabelSchema = z.object({
  id: z.number().int().min(0),
  label: z.string().max(30),
  /** A palette key (`colors.ts`); a hex (old data, an old client) is read as the nearest key. */
  color: labelColorSchema,
  index: z.number().int().min(0),
  is_done: z.boolean().optional(),
  is_deactivated: z.boolean().optional(),
  description: z.string().max(300).optional(),
});
export type StatusLabel = z.infer<typeof statusLabelSchema>;

const statusSettings = z.object({
  labels: z.array(statusLabelSchema).max(40),
  post_update_on_change: z.boolean().optional(),
  /** the optional workflow (allowed moves between labels). */
  workflow: statusWorkflowSchema.optional(),
});
const statusValue = z.object({ index: z.number().int().min(0) });

/** 03 §2.5 — value `{index}` is the stable label id; label colours are palette keys (imports map hex to the nearest). */
export const statusColumn: ColumnTypeDef<z.infer<typeof statusSettings>, z.infer<typeof statusValue>> = {
  type: 'status',
  labelHe: 'סטטוס',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: statusSettings,
  valueSchema: statusValue,
  defaultSettings: { labels: DEFAULT_STATUS_LABELS },
  toText: (v, s) => s.labels.find((l) => l.id === v.index)?.label ?? '',
  // One label, by name (active labels only).
  fromText: (text, s) => {
    const l = activeLabelsOf(s).find((x) => normText(x.label) === normText(text));
    return l ? { index: l.id } : undefined;
  },
  toNumber: (v, s) => s.labels.find((l) => l.id === v.index)?.index ?? null,
  validate: (v, s) => (s.labels.some((l) => l.id === v.index && !l.is_deactivated) ? null : 'label_not_found'),
  labelIds: (v) => [v.index],
  filterOperators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty', 'is_done', 'is_not_done'],
  filterModel: 'label',
  sortKey: 'number',
  aggregates: ['labels', 'done_pct', 'count_done'],
};

const dropdownSettings = z.object({
  labels: z
    .array(
      z.object({ id: z.number().int().min(0), label: z.string().max(100), is_deactivated: z.boolean().optional() }),
    )
    .max(1000),
  limit_select: z.boolean().optional(),
  label_limit_count: z.number().int().min(1).optional(),
  allow_create: z.enum(['owners', 'editors', 'none']).optional(),
});
const dropdownValue = z.object({ ids: z.array(z.number().int().min(0)).max(1000) });

/** 03 §2.6 — multi-select labels without colour. */
export const dropdownColumn: ColumnTypeDef<z.infer<typeof dropdownSettings>, z.infer<typeof dropdownValue>> = {
  type: 'dropdown',
  labelHe: 'רשימה נפתחת',
  category: 'essentials',
  priority: 'P0',
  storage: 'cell',
  readOnly: false,
  settingsSchema: dropdownSettings,
  valueSchema: dropdownValue,
  defaultSettings: { labels: [] },
  toText: (v, s) =>
    v.ids
      .map((id) => s.labels.find((l) => l.id === id)?.label)
      .filter(Boolean)
      .join(', '),
  // A comma list of label names (active labels only), each once.
  fromText: (text, s) => {
    const labels = activeLabelsOf(s);
    const ids = textParts(text).flatMap((p) =>
      labels.filter((l) => normText(l.label) === normText(p)).map((l) => l.id),
    );
    return ids.length ? { ids: [...new Set(ids)] } : undefined;
  },
  labelIds: (v) => v.ids,
  validate: (v, s) => {
    if (v.ids.some((id) => !s.labels.some((l) => l.id === id))) return 'label_not_found';
    if (s.limit_select && s.label_limit_count && v.ids.length > s.label_limit_count) return 'too_many_labels';
    return null;
  },
  filterOperators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty'],
  filterModel: 'labels',
  sortKey: 'text',
  aggregates: ['count'],
};

type LabelLike = { id: number; is_deactivated?: boolean };

/**
 * Applies an edited label list (03 §2.5–2.6): ids must be unique; a label that was removed but is still used
 * by a cell stays, deactivated, so values never point at a missing label. Removed unused labels are dropped.
 */
export const reconcileLabels = <L extends LabelLike>(
  prev: L[],
  next: L[],
  used: ReadonlySet<number>,
): { ok: true; labels: L[] } | { ok: false; error: 'duplicate_label_id' } => {
  const ids = new Set<number>();
  for (const l of next) {
    if (ids.has(l.id)) return { ok: false, error: 'duplicate_label_id' };
    ids.add(l.id);
  }
  const kept = prev.filter((l) => !ids.has(l.id) && used.has(l.id)).map((l) => ({ ...l, is_deactivated: true }));
  return { ok: true, labels: [...next, ...kept] };
};

/** Next free label id: never reuses an id still present (active or deactivated). */
export const nextLabelId = (labels: LabelLike[]) => labels.reduce((max, l) => Math.max(max, l.id), -1) + 1;

const tagsValue = z.object({ tag_ids: z.array(z.string().min(1).max(26)).max(100) });

/**
 * 03 §3.1 — account-wide tags (the `tags` table: name + group colour). The cell holds the tag ids; writes may also
 * send `{tags: [names]}`, which the service resolves (creating missing tags) before validation.
 */
export const tagsColumn: ColumnTypeDef<Record<string, unknown>, z.infer<typeof tagsValue>> = {
  type: 'tags',
  labelHe: 'תגיות',
  category: 'super_useful',
  priority: 'P1',
  storage: 'cell',
  readOnly: false,
  settingsSchema: z.object({}).loose(),
  valueSchema: tagsValue,
  defaultSettings: {},
  toText: (v, _s, ctx) =>
    v.tag_ids
      .map((id) => ctx.tagName?.(id))
      .filter(Boolean)
      .join(', '),
  // By name (`#` optional); the service finds or creates each tag (`{tags: [names]}`, resolved before validation).
  fromText: (text) => {
    const names = [...new Set(textParts(text).map((p) => p.replace(/^#+/, '').trim().slice(0, 60)))].filter(Boolean);
    return names.length ? ({ tags: names } as unknown as z.infer<typeof tagsValue>) : undefined;
  },
  filterOperators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty'],
  filterModel: 'tags',
  sortKey: 'text',
  aggregates: ['count'],
};

/**
 * Column settings with every label colour as a palette key (a hex from an older template or snapshot → the nearest
 * key); settings without labels are returned as they are.
 */
export const withLabelColorKeys = <S>(settings: S): S => {
  const labels = (settings as { labels?: unknown } | null)?.labels;
  if (!Array.isArray(labels)) return settings;
  return {
    ...settings,
    labels: labels.map((l: unknown) =>
      l && typeof l === 'object' && typeof (l as { color?: unknown }).color === 'string'
        ? { ...l, color: labelColorKey((l as { color: string }).color) }
        : l,
    ),
  };
};
