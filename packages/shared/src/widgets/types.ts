// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from 'zod';

/**
 * A dashboard widget type (M8 ד4, plan §3.4) — a registry module like a column type (rule 4): its settings
 * schema and defaults, its size on the 12-column grid, whether it reads boards, and the shape of its data.
 * Nothing switches on a widget's `type` outside the registry; the API's data handlers and the web's renderers
 * are maps keyed by it.
 */
export type WidgetSize = { w: number; h: number };

export type WidgetCategory = 'data' | 'content';

export interface WidgetDef<S = unknown> {
  type: string;
  category: WidgetCategory;
  settingsSchema: z.ZodType<S>;
  /** What a new widget of this type starts with (parsed through `settingsSchema`). */
  defaultSettings: unknown;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  /** Reads items of the dashboard's boards (has a data endpoint); else it renders its settings only. */
  readsBoards: boolean;
  /** The `data` of `POST /dashboards/:id/widgets/:wid/data` for this type. */
  dataSchema: z.ZodType;
  /**
   * which values a click lists the items of (`POST …/widgets/:wid/items` with a `WidgetPick`)
   * `all` (the whole widget), `x` / `series` (a chart's bucket and series), `segment` (a battery's label),
   * `person` (+ `series`, a workload row). Types that list items themselves (table, calendar…) open them directly.
   */
  drill?: readonly WidgetPickKind[];
}

export type WidgetPickKind = 'all' | 'x' | 'series' | 'segment' | 'person';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWidgetDef = WidgetDef<any>;
