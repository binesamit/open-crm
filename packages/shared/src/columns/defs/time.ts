// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { ColumnTypeDef } from '../types';

/**
 * 03 §3.3 — time tracking (M1.1 #11). The truth is the `time_entries` table; the cell is a cache the service
 * rewrites with every change, so the column is written only through the time endpoints (engine 'time').
 */
export const timeSettingsSchema = z.object({
  display: z.enum(['hms', 'decimal_hours']).optional(),
  show_seconds: z.boolean().optional(),
  billable_default: z.boolean().optional(),
  allow_manual: z.boolean().optional(),
  allow_other_users: z.enum(['owners', 'all', 'none']).optional(),
  rounding: z.enum(['none', '5m', '15m']).optional(),
});
export type TimeSettings = z.infer<typeof timeSettingsSchema>;

export const timeValueSchema = z.object({
  /** Seconds of closed entries. */
  duration: z.number().int().min(0),
  running: z.boolean(),
  /** Every running timer on this cell — several people (and several items per person) may run at once. */
  runners: z.array(z.object({ user_id: z.string().nullable(), since: z.string() })).optional(),
  entries_count: z.number().int().min(0),
});
export type TimeValue = z.infer<typeof timeValueSchema>;

const pad = (n: number) => String(n).padStart(2, '0');

/** 9015 → "02:30:15" (or "02:30" without seconds); "decimal_hours" → "2.5h". */
export const formatDuration = (seconds: number, settings: TimeSettings = {}) => {
  const s = Math.max(0, Math.floor(seconds));
  if (settings.display === 'decimal_hours') return `${(s / 3600).toFixed(1).replace(/\.0$/, '')}h`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return settings.show_seconds === false ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
};

/**
 * Manual durations (03 §3.3 "1:30" or "1.5h"): "1:30" = 1h30m, "1:30:15", "1.5h"/"1.5", "90m", "45 דק".
 * Returns seconds, or null when it can't be read.
 */
export const parseDuration = (input: string): number | null => {
  const s = input.trim().toLowerCase().replace(',', '.');
  let m = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  m = /^(\d+(?:\.\d+)?)\s*(h|ש|שעות|שעה)?$/.exec(s);
  if (m) return Math.round(Number(m[1]) * 3600);
  m = /^(\d+)\s*(m|min|ד|דק|דקות)$/.exec(s);
  if (m) return Number(m[1]) * 60;
  return null;
};

export const MAX_ENTRY_SECONDS = 24 * 3600;

/** Manual entry rules (03 §3.3): not in the future, ends after it starts, at most 24 hours. */
export const validateEntryRange = (startedAt: Date, endedAt: Date, now = new Date()): string | null => {
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) return 'invalid_time';
  if (endedAt.getTime() > now.getTime() + 60_000) return 'time_in_future';
  if (endedAt <= startedAt) return 'time_end_before_start';
  if ((endedAt.getTime() - startedAt.getTime()) / 1000 > MAX_ENTRY_SECONDS) return 'time_too_long';
  return null;
};

export const timeTrackingColumn: ColumnTypeDef<TimeSettings, TimeValue> = {
  type: 'time_tracking',
  labelHe: 'מעקב זמן',
  category: 'super_useful',
  priority: 'P0',
  storage: 'cell',
  engine: 'time',
  readOnly: false, // written through /items/:id/time/* and /time/entries/* (engine 'time'), never PUT /cells
  settingsSchema: timeSettingsSchema,
  valueSchema: timeValueSchema,
  defaultSettings: { display: 'hms', show_seconds: true, billable_default: true, allow_manual: true },
  toText: (v, s) => (v.duration || v.running ? formatDuration(v.duration, s) : ''),
  toNumber: (v) => v.duration,
  formatNumber: (n, s) => formatDuration(n, s),
  filterOperators: ['greater_than', 'lower_than', 'is_empty', 'is_not_empty', 'is_running', 'is_not_running'],
  filterModel: 'number',
  sortKey: 'number',
  aggregates: ['sum'],
  toFormula: (v) => v.duration,
};
