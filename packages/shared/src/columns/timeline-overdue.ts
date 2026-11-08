// SPDX-License-Identifier: AGPL-3.0-only
/**
 * r26: a timeline that has run out turns red — its end date is before "today" (the account's
 * calendar day, `todayIn()`), unless the item is done. "Done" comes from an optional linked status column: its
 * chosen done labels (`done_label_ids`), or — none chosen — the status labels marked done (`is_done`). Without a
 * linked status, overdue = the end date has passed. The column's `overdue_red: false` turns the red off.
 */

/** The overdue red — the palette's "blocked" colour (`DEFAULT_STATUS_LABELS`), a key: render with `paint()`. */
export const OVERDUE_RED = 'crimson';

export type TimelineSettings = {
  show_weekends?: boolean;
  allow_milestone?: boolean;
  /** "with hours" — a start and an end time (wall-clock, the account's zone) besides the days. */
  show_time?: boolean;
  /** Red when overdue (default on). */
  overdue_red?: boolean;
  /** The status column whose done labels stop the red. */
  status_column_id?: string;
  /** The linked status's labels that count as done; absent/empty = its `is_done` labels. */
  done_label_ids?: number[];
  /** How the span's length is counted; unset / 'account' = the account's calendar setting. */
  duration?: 'account' | 'calendar' | 'weekdays' | 'workdays';
  /** Show the counted length next to the dates in the cell (and on the bar). */
  show_duration?: boolean;
  /** Moving the span (drag, shifts, dependencies) keeps its counted length instead of its calendar days. */
  keep_workdays?: boolean;
  /** The Hebrew date in the cell: unset / 'account' = the account's setting. */
  hebrew_date?: 'account' | 'on' | 'off';
  /** Dots for days off / half days in the picker: unset / 'account' = the account's setting. */
  day_marks?: 'account' | 'on' | 'off';
};

type StatusColumnLike = { id: string; type: string; settings: Record<string, unknown> };

/** The labels of a status column that count as done for this timeline. */
export const timelineDoneLabels = (settings: TimelineSettings, status: StatusColumnLike | undefined): number[] => {
  if (settings.done_label_ids?.length) return settings.done_label_ids;
  const labels = (status?.settings.labels ?? []) as { id: number; is_done?: boolean }[];
  return labels.filter((l) => l.is_done).map((l) => l.id);
};

/**
 * Is this timeline overdue (red)? `cells` = the item's cells by column id (values as stored, or `{value}` wrappers);
 * `columns` = the board's columns (to find the linked status); `today` = 'YYYY-MM-DD' in the account's zone.
 */
export const timelineOverdue = (
  value: { from: string; to: string } | null | undefined,
  settings: TimelineSettings | null | undefined,
  opts: {
    today: string;
    cells?: Record<string, unknown>;
    columns?: readonly StatusColumnLike[];
  },
): boolean => {
  if (!value?.to) return false;
  const s = settings ?? {};
  if (s.overdue_red === false) return false;
  if (value.to >= opts.today) return false;
  if (!s.status_column_id) return true;
  const status = opts.columns?.find((c) => c.id === s.status_column_id && c.type === 'status');
  // A linked status column that no longer exists: the red goes by the date alone.
  if (!status && opts.columns) return true;
  const raw = opts.cells?.[s.status_column_id];
  const cell = raw && typeof raw === 'object' && 'value' in raw ? (raw as { value: unknown }).value : raw;
  const index = (cell as { index?: unknown } | null | undefined)?.index;
  if (typeof index !== 'number') return true;
  return !timelineDoneLabels(s, status).includes(index);
};
