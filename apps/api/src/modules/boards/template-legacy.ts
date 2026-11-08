// SPDX-License-Identifier: AGPL-3.0-only
import {
  buttonSettingsSchema,
  colorKeyFromHex,
  DEFAULT_STATUS_LABELS,
  labelColorKey,
  progressSettingsSchema,
  type AnyColumnTypeDef,
} from '@bines/shared';

/**
 * Template snapshots in the earlier (format 1) shape: copies of the built-in templates an account saved before the
 * built-in files moved to format 2, and packs written then. Read here so they still make the same boards; nothing
 * writes this shape any more.
 */

/** Earlier names of the board permission sets. */
export const LEGACY_PERMISSION_SETS: Record<string, string> = {
  view_and_comment: 'view_comment',
  only_edit_content: 'edit_content',
  only_edit_assigned: 'edit_assigned',
  only_edit_items_assigned: 'edit_assigned',
};

/** A format 1 "column" that only marked the board as having subitems (03 §2.23). */
export const LEGACY_SUBITEMS_TYPE = 'subtasks';

type Raw = Record<string, unknown>;

const statusLabels = (m: Raw) => {
  const raw = Array.isArray(m.labels) ? (m.labels as Raw[]) : [];
  const labels = raw
    .filter((l) => typeof l.id === 'number')
    .map((l) => ({
      id: l.id as number,
      label: String(l.label ?? '').slice(0, 30),
      // A palette key in `color_key`, else a hex in `hex`, else gray (format 1 never read `color`).
      color:
        typeof l.color_key === 'string'
          ? labelColorKey(l.color_key)
          : typeof l.hex === 'string' && /^#[0-9a-f]{6}$/i.test(l.hex)
            ? colorKeyFromHex(l.hex)
            : ('gray' as const),
      index: typeof l.index === 'number' ? l.index : (l.id as number),
      ...(l.is_done ? { is_done: true } : {}),
      ...(l.is_deactivated ? { is_deactivated: true } : {}),
    }));
  return { labels: labels.length ? labels : DEFAULT_STATUS_LABELS };
};

const AGGREGATES = ['sum', 'avg', 'median', 'min', 'max', 'count', 'earliest', 'latest'] as const;

/** Format 1 settings → today's, per type; a type not listed keeps its settings when valid, else its defaults. */
const CONVERT: Record<string, (m: Raw, def: AnyColumnTypeDef) => unknown> = {
  name: () => ({}),
  numbers: (m) => {
    const unit = m.unit as { symbol?: string } | undefined;
    return unit?.symbol ? { unit: { symbol: unit.symbol, direction: 'left' }, footer: 'sum' } : { footer: 'sum' };
  },
  rating: (m) => ({ max: ([3, 4, 5, 10] as const).find((n) => n === Number(m.limit)) ?? 5, symbol: 'stars' }),
  vote: () => ({}),
  doc: () => ({}),
  status: statusLabels,
  dropdown: (m) => ({
    labels: (Array.isArray(m.labels)
      ? (m.labels as { id: number; label: string; is_deactivated?: boolean }[])
      : []
    ).map((l) => ({
      id: l.id,
      label: String(l.label).slice(0, 100),
      ...(l.is_deactivated ? { is_deactivated: true } : {}),
    })),
  }),
  tags: () => ({}),
  date: () => ({}),
  timeline: () => ({}),
  people: () => ({ max_people: 0, notify_on_assign: true }),
  email: () => ({}),
  phone: () => ({ default_country: 'IL' }),
  link: () => ({}),
  // Target boards by template ref (`@contacts`) or by a template's `existing_board_id`; resolved by the kit.
  board_relation: (m) => ({
    board_ids: [],
    board_refs: Array.isArray(m.boardIds) ? m.boardIds.map(String) : [],
    allow_multiple: m.allowMultipleItems !== false,
  }),
  dependency: (m) => ({
    mode: m.dependencyMode === 'strict' || m.mode === 'strict' ? 'strict' : 'flexible',
    allow_multiple: true,
  }),
  mirror: (m) => {
    // relation_column {"<key>": true}; displayed_linked_columns [{board_id, column_ids}] (older: {board: [ids]}).
    const rel = m.relation_column as Record<string, boolean> | undefined;
    const shown = m.displayed_linked_columns as
      { board_id: string; column_ids: string[] }[] | Record<string, string[]> | undefined;
    const source = Array.isArray(shown) ? shown[0]?.column_ids?.[0] : shown ? Object.values(shown)[0]?.[0] : undefined;
    const fn = String(m.function ?? m.sumType ?? '').toLowerCase();
    const aggregate = AGGREGATES.find((a) => a === fn);
    return {
      relation_column_id: rel ? Object.keys(rel)[0] : undefined,
      source_column_id: source,
      ...(aggregate ? { aggregate } : {}),
    };
  },
  formula: (m) => ({ formula: String(m.formula ?? '') }),
  item_id: (m) => {
    const custom = m.customKeySettings as { prefix?: string; padding?: number } | undefined;
    return m.displayType === 'customKey' && custom?.prefix
      ? { display: 'custom_key', prefix: custom.prefix.replace(/[^A-Za-z0-9-]/g, ''), padding: custom.padding ?? 4 }
      : { display: 'id' };
  },
  creation_log: () => ({ mode: 'both' }),
  last_updated: () => ({ mode: 'ago' }),
  file: () => ({}),
  time_tracking: () => ({ display: 'hms', show_seconds: true, billable_default: true, allow_manual: true }),
  progress: (m) => {
    const cols = (m.statusColumns ?? m.related_columns ?? {}) as Raw;
    const weights = (m.weights ?? {}) as Raw;
    return progressSettingsSchema.parse({
      columns: Object.keys(cols)
        .filter((k) => cols[k])
        .slice(0, 40)
        .map((column_id) => ({
          column_id,
          weight: Math.min(100, Math.max(0, Number(weights[column_id] ?? 1) || 1)),
        })),
    });
  },
  button: (m) =>
    buttonSettingsSchema.parse({
      label: typeof m.label === 'string' ? m.label.slice(0, 40) : '',
      ...(typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? { color: m.color } : {}),
    }),
  hour: (m) => ({ format: String(m.hour_format ?? '').startsWith('12') ? '12h' : 'auto' }),
  week: () => ({}),
  world_clock: (_m, def) => def.settingsSchema.parse({}),
  color_picker: () => ({ format: 'hex' }),
  country: () => ({}),
  location: () => ({}),
  ai: (_m, def) => def.settingsSchema.parse({}),
  secret: (_m, def) => def.settingsSchema.parse({}),
  signature: (_m, def) => def.settingsSchema.parse({}),
};

/** A format 1 column's settings in today's shape. */
export const legacyColumnSettings = (def: AnyColumnTypeDef, settings: Raw): unknown => {
  const convert = CONVERT[def.type];
  if (convert) return convert(settings, def);
  const parsed = def.settingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : def.defaultSettings;
};

/** A format 1 board's depth: multi-level boards 6, boards with the subitems marker 2, else 1. */
export const legacyDepthMax = (t: { hierarchy_type: string; columns: { type: string }[] }) =>
  t.hierarchy_type === 'multi_level' ? 6 : t.columns.some((c) => c.type === LEGACY_SUBITEMS_TYPE) ? 2 : 1;
