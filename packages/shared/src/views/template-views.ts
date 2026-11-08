// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { remapViewSettings, VIEW_TYPES, type ViewSettings, viewSettingsSchema } from './settings';

/**
 * A board template's views (phase B): kept in a template / kit and made with every board from it. Our own
 * view settings (a saved board, a kit) — or the older seed shape (`settings.column` for a kanban, top-level `sort` /
 * `group_by`), read as far as it maps. Column references are the template's column ids (= the new board's keys).
 */
export const templateViewSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(VIEW_TYPES).default('table'),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export type TemplateView = z.infer<typeof templateViewSchema>;

/** Template views a board's views may hold (forms and extension views stay with their own board). */
export const TEMPLATE_VIEW_TYPES = VIEW_TYPES.filter((v) => v !== 'form' && v !== 'extension');

type Legacy = { settings?: Record<string, unknown>; sort?: unknown; group_by?: unknown };

type FilterNode = NonNullable<ViewSettings['query']['filter']>;

/** A filter's group rules (`__group__`) pointed at the new board's groups; a rule left with no group is dropped. */
const remapGroupRules = (node: FilterNode, groups: Map<string, string>): FilterNode | null => {
  const rules = node.rules.flatMap((r): FilterNode['rules'] => {
    if ('kind' in r && r.kind === 'group') {
      const sub = remapGroupRules(r as FilterNode, groups);
      return sub ? [sub] : [];
    }
    const rule = r as Extract<FilterNode['rules'][number], { column_id: string }>;
    if (rule.column_id !== '__group__') return [rule];
    const values = (rule.values ?? []).flatMap((v) => (typeof v === 'string' && groups.has(v) ? [groups.get(v)!] : []));
    return values.length ? [{ ...rule, values }] : [];
  });
  return rules.length ? { ...node, rules } : null;
};

/**
 * The view's settings on a new board with these column keys (references to other columns are dropped) and these
 * groups (template group id → the new group's id); null = not a view a template carries.
 */
export const templateViewSettings = (
  view: TemplateView,
  keys: Set<string>,
  groups: Map<string, string> = new Map(),
): ViewSettings | null => {
  if (!(TEMPLATE_VIEW_TYPES as readonly string[]).includes(view.type)) return null;
  const raw = view as TemplateView & Legacy;
  const own = viewSettingsSchema.safeParse(raw.settings ?? {});
  let settings: ViewSettings;
  if (own.success && !('column' in (raw.settings ?? {}))) settings = own.data;
  else {
    // The seed shape: a kanban's lanes column, a list of sort levels, a grouping column.
    const column = typeof raw.settings?.column === 'string' ? raw.settings.column : undefined;
    const sort = Array.isArray(raw.sort)
      ? (raw.sort as { column_id?: unknown; direction?: unknown }[]).flatMap((s) =>
          typeof s.column_id === 'string'
            ? [{ column_id: s.column_id, direction: s.direction === 'desc' ? 'desc' : 'asc' }]
            : [],
        )
      : [];
    const groupBy = typeof raw.group_by === 'string' ? { column_id: raw.group_by } : undefined;
    const parsed = viewSettingsSchema.safeParse({
      query: { sort, ...(groupBy ? { group_by: groupBy } : {}) },
      ...(view.type === 'kanban' && column ? { kanban: { column_id: column } } : {}),
    });
    if (!parsed.success) return viewSettingsSchema.parse({});
    settings = parsed.data;
  }
  const out = remapViewSettings(settings, (key) => (keys.has(key) ? key : null));
  const filter = out.query.filter ? remapGroupRules(out.query.filter, groups) : null;
  return { ...out, query: { ...out.query, filter: filter ?? undefined } };
};
