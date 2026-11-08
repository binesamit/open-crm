// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '../errors';
import {
  batteryWidget,
  boardViewWidget,
  calendarWidget,
  chartWidget,
  extensionWidget,
  numbersWidget,
  tableWidget,
  textWidget,
  timelineWidget,
  timeReportWidget,
  workloadWidget,
} from './defs';
import type { AnyWidgetDef } from './types';

export * from './types';
export * from './common';
export * from './defs';
export * from './layout';

/** Every widget type (M8 ד4–ד5), in the "add widget" order. A new widget = a new def here (M9: extensions). */
const DEFS: AnyWidgetDef[] = [
  numbersWidget,
  chartWidget,
  batteryWidget,
  tableWidget,
  calendarWidget,
  timelineWidget,
  workloadWidget,
  timeReportWidget,
  boardViewWidget,
  textWidget,
  // D27 ת5: added per installed extension (the "add widget" menu lists each extension's widgets by name).
  extensionWidget,
];

export const widgetTypes = new Map<string, AnyWidgetDef>(DEFS.map((d) => [d.type, d]));
export const WIDGET_TYPES = DEFS.map((d) => d.type);

export const getWidgetDef = (type: string): AnyWidgetDef => {
  const def = widgetTypes.get(type);
  if (!def) throw new AppError('validation_failed', 'Unknown widget type', { type });
  return def;
};

/** A widget's settings, validated and filled with defaults (422 on bad input). */
export const parseWidgetSettings = (type: string, settings: unknown): Record<string, unknown> => {
  const def = getWidgetDef(type);
  const r = def.settingsSchema.safeParse(settings ?? def.defaultSettings);
  if (!r.success)
    throw new AppError('validation_failed', 'Invalid widget settings', {
      type,
      issues: r.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  return r.data as Record<string, unknown>;
};

/** A board Dashboard view's widgets on save (round 15): each one's settings validated (400) and filled. */
export const parseViewWidgets = <W extends { type: string; settings: Record<string, unknown> }>(widgets: W[]): W[] =>
  widgets.map((w) => ({ ...w, settings: parseWidgetSettings(w.type, w.settings) }));

/** Stored settings read back leniently: whatever no longer parses falls back to the defaults. */
export const readWidgetSettings = (type: string, settings: unknown): Record<string, unknown> => {
  const def = widgetTypes.get(type);
  if (!def) return {};
  const r = def.settingsSchema.safeParse(settings);
  return (r.success ? r.data : def.settingsSchema.parse(def.defaultSettings)) as Record<string, unknown>;
};
