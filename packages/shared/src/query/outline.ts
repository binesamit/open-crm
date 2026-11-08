// SPDX-License-Identifier: AGPL-3.0-only
import type { OutlineSection } from '../api/windowed';
import type { DateEnv } from './dates';
import type { QueryRow } from './evaluate';
import { type BucketNode, GROUP_PATH_SEP, type GroupLevel, groupRows, groupTree } from './group';
import type { GroupDateUnit, GroupMode } from './filter';
import type { Field } from './plan';
import { summarize, type SummaryFn } from './summary';

export type OutlineSummary = { field: Field; fn?: SummaryFn };

/**
 * The sections of a windowed board's outline (perf review §7.1), from its matching rows already in view order:
 * by board group (in `groupOrder`), or bucketed by a column with the same engine the browser groups with
 * (`groupRows`). Each section carries its ids and the footer / group-title summaries over all its rows — so the
 * browser shows the right counts and totals without loading the rows. Rows only need the cells those read.
 */
export const outlineSections = <R extends QueryRow>(
  rows: R[],
  opts: {
    timezone: string;
    groupOrder: string[];
    groupBy?: {
      field: Field;
      direction?: 'asc' | 'desc';
      dateUnit?: GroupDateUnit;
      pastDetail?: boolean;
      dateEdge?: 'start' | 'end';
      mode?: GroupMode;
      rangeSize?: number;
      showEmpty?: boolean;
      teams?: { id: string; member_ids: string[] }[];
    };
    nameOf?: (id: string) => string | undefined;
    dates?: DateEnv;
    summaries: OutlineSummary[];
    groupSummary?: OutlineSummary | null;
    /**
     * Prod ק3: a nested grouping (2–3 levels, built by the caller). Each node is a section in tree order
     * — a parent (`level` < the last) with its `count` and summaries over all its rows but no ids, then its
     * children; keys are the bucket keys down to it joined by `GROUP_PATH_SEP`.
     */
    levels?: GroupLevel[];
  },
): OutlineSection[] => {
  const sum = (s: OutlineSummary, list: R[]) => {
    try {
      return summarize(s.field, list, opts.timezone, s.fn);
    } catch {
      return null;
    }
  };
  const section = (key: string, list: R[], extra: { label?: string; color?: string } = {}): OutlineSection => ({
    key,
    ...extra,
    ids: list.map((r) => r.id),
    summaries: Object.fromEntries(opts.summaries.map((s) => [s.field.id, sum(s, list)])),
    ...(opts.groupSummary ? { group_summary: sum(opts.groupSummary, list) } : {}),
  });

  if (opts.levels && opts.levels.length > 1) {
    const out: OutlineSection[] = [];
    const last = opts.levels.length - 1;
    const walk = (nodes: BucketNode<R>[]) => {
      for (const n of nodes) {
        const s = section(n.path.join(GROUP_PATH_SEP), n.rows, {
          label: n.label,
          ...(n.color ? { color: n.color } : {}),
        });
        out.push(n.level < last ? { ...s, ids: [], level: n.level, count: n.rows.length } : { ...s, level: n.level });
        walk(n.children);
      }
    };
    walk(groupTree(rows, opts.levels));
    return out;
  }

  if (opts.groupBy) {
    return groupRows(rows, opts.groupBy.field, {
      timezone: opts.timezone,
      direction: opts.groupBy.direction,
      nameOf: opts.nameOf,
      emptyLabel: '',
      checkedLabel: '',
      mode: opts.groupBy.mode,
      rangeSize: opts.groupBy.rangeSize,
      showEmpty: opts.groupBy.showEmpty,
      teams: opts.groupBy.teams,
      ...(opts.dates
        ? {
            dates: {
              env: opts.dates,
              label: (key: string) => key,
              unit: opts.groupBy.dateUnit,
              pastDetail: opts.groupBy.pastDetail,
              edge: opts.groupBy.dateEdge,
            },
          }
        : {}),
    }).map((b) => section(b.key, b.rows, { label: b.label, ...(b.color ? { color: b.color } : {}) }));
  }
  const byGroup = new Map<string, R[]>();
  for (const r of rows) {
    const key = r.group_id ?? '';
    const list = byGroup.get(key);
    if (list) list.push(r);
    else byGroup.set(key, [r]);
  }
  const rank = new Map(opts.groupOrder.map((id, i) => [id, i]));
  return [...byGroup]
    .filter(([key]) => rank.has(key))
    .sort(([a], [b]) => rank.get(a)! - rank.get(b)!)
    .map(([key, list]) => section(key, list));
};
