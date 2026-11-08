// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type DateEnv } from '../query/dates';
import type { CalendarConfig, DurationMode } from '../workdays/settings';
import { addCountedDays, countDays, endAfter } from '../workdays/workdays';
import { daysBetween, type Span } from './axis';

/**
 * Dependencies (M8 ד7, 03 §3.2, D25): an item's `dependency` cell lists the items it depends on (its
 * predecessors). Each link has a kind (FS / SS / FF / SF) and a lag in days. When a predecessor's dates change, the
 * column's mode decides what happens to its dependents:
 * - `strict`: dependents shift by the same amount (forward and back), keeping the gap;
 * - `flexible`: a dependent shifts forward only when the change makes it overlap (break the constraint);
 * - `visual`: nothing moves — arrows only.
 * Pure functions here; the server applies the result in the same transaction (one batch → one Ctrl+Z).
 */

export const DEP_KINDS = ['FS', 'SS', 'FF', 'SF'] as const;
export type DepKind = (typeof DEP_KINDS)[number];
export const DEP_MODES = ['strict', 'flexible', 'visual'] as const;
export type DepMode = (typeof DEP_MODES)[number];

/** One link: `item` depends on `on` (item_links: from = item, to = on). */
export type DepLink = { item: string; on: string; kind: DepKind; lag: number };

/** The most items one change may shift (a loop guard on top of the cycle check). */
export const MAX_SHIFTED = 1000;

/**
 * How a date column counts days when its dates move: a lag and a shift are counted in `mode`
 * (working days skip the weekend — and, in 'workdays', the account's holidays); `keepWorkdays` = a moved span keeps
 * its counted length (`endAfter`) instead of its calendar days. Absent / 'calendar' = plain days, as before.
 */
export type DayCount = {
  mode: DurationMode;
  calendar?: CalendarConfig;
  weekend?: DateEnv['weekend'];
  keepWorkdays?: boolean;
};

/** A date / timeline column's day count: its own `duration` (unset / 'account' = the account's) and `keep_workdays`. */
export const dayCountOf = (
  settings: { duration?: string; keep_workdays?: boolean } | null | undefined,
  calendar: CalendarConfig,
  weekend: DateEnv['weekend'],
): DayCount => {
  const own = settings?.duration;
  const mode = own === 'calendar' || own === 'weekdays' || own === 'workdays' ? own : calendar.duration;
  return { mode, calendar, weekend, keepWorkdays: settings?.keep_workdays === true };
};

const counted = (c?: DayCount): c is DayCount => !!c && c.mode !== 'calendar';

/** Counted days from `a` to `b` (b after a = positive; `a` itself not counted): how far an anchor moved. */
const countedDelta = (a: string, b: string, c: DayCount) =>
  b === a
    ? 0
    : b > a
      ? countDays(addDays(a, 1), b, c.mode, c.calendar, c.weekend)
      : -countDays(b, addDays(a, -1), c.mode, c.calendar, c.weekend);

/** The span's end after its start moved to `from`: its counted length when kept, else its calendar length. */
const endFor = (s: Span, from: string, c?: DayCount) =>
  counted(c) && c.keepWorkdays
    ? endAfter(from, countDays(s.from, s.to, c.mode, c.calendar, c.weekend), c.mode, c.calendar, c.weekend)
    : addDays(from, daysBetween(s.from, s.to));

/** A span moved by `days` calendar days (its end per `endFor` — a kept counted length may change its calendar days). */
export const moveSpanBy = (s: Span, days: number, c?: DayCount): Span => {
  const from = addDays(s.from, days);
  return { from, to: endFor(s, from, c) };
};

/**
 * A span shifted by `n` days counted in the column's mode (a bulk "shift dates", a strict dependency): the start
 * moves `n` counted days, the end follows (`endFor`). Plain days without a count / in calendar mode.
 */
export const shiftSpanCounted = (s: Span, n: number, c?: DayCount): Span => {
  if (!counted(c)) return { from: addDays(s.from, n), to: addDays(s.to, n) };
  const from = addCountedDays(s.from, n, c.mode, c.calendar, c.weekend);
  return { from, to: endFor(s, from, c) };
};

/**
 * Whether linking `item` to depend on `targets` closes a loop: some target already depends (directly or through
 * others) on `item`, or a target is `item` itself.
 */
export const wouldCycle = (links: Pick<DepLink, 'item' | 'on'>[], item: string, targets: string[]): boolean => {
  if (targets.includes(item)) return true;
  const dependsOn = new Map<string, string[]>();
  for (const l of links) {
    if (l.item === item) continue; // the item's own links are being replaced
    dependsOn.set(l.item, [...(dependsOn.get(l.item) ?? []), l.on]);
  }
  const seen = new Set<string>();
  const stack = [...targets];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === item) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(dependsOn.get(cur) ?? []));
  }
  return false;
};

/**
 * Days `succ` must move forward so the link holds (0 = it holds):
 * FS: starts after the predecessor ends (+lag) · SS: starts on/after its start (+lag) · FF: ends on/after its end
 * (+lag) · SF: ends on/after its start (+lag). With a counted `count` (working days), "after" is the next working
 * day and the lag counts working days; the result is still in calendar days.
 */
export const requiredShift = (pred: Span, succ: Span, kind: DepKind, lag: number, count?: DayCount): number => {
  if (counted(count)) {
    const plus = (iso: string, n: number) => addCountedDays(iso, n, count.mode, count.calendar, count.weekend);
    switch (kind) {
      case 'FS':
        return Math.max(0, daysBetween(succ.from, plus(pred.to, 1 + lag)));
      case 'SS':
        return Math.max(0, daysBetween(succ.from, plus(pred.from, lag)));
      case 'FF':
        return Math.max(0, daysBetween(succ.to, plus(pred.to, lag)));
      case 'SF':
        return Math.max(0, daysBetween(succ.to, plus(pred.from, lag)));
    }
  }
  switch (kind) {
    case 'FS':
      return Math.max(0, daysBetween(succ.from, addDays(pred.to, 1 + lag)));
    case 'SS':
      return Math.max(0, daysBetween(succ.from, addDays(pred.from, lag)));
    case 'FF':
      return Math.max(0, daysBetween(succ.to, addDays(pred.to, lag)));
    case 'SF':
      return Math.max(0, daysBetween(succ.to, addDays(pred.from, lag)));
  }
};

/** The span a flexible link pushes `cur` to: forward by `need` days, then on until every rule of the link holds. */
const pushed = (pred: Span, cur: Span, link: DepLink, need: number, count?: DayCount): Span => {
  let next = moveSpanBy(cur, need, count);
  // A kept counted length can end earlier than the calendar shift did (FF / SF): push on (bounded).
  for (let i = 0, more = 0; i < 10 && (more = requiredShift(pred, next, link.kind, link.lag, count)) > 0; i++)
    next = moveSpanBy(next, more, count);
  return next;
};

/** The day of a predecessor a strict link follows: its end (FS / FF) or its start (SS / SF). */
const anchorOf = (s: Span, kind: DepKind) => (kind === 'FS' || kind === 'FF' ? s.to : s.from);

/**
 * The dependents to move after `moved` items changed dates, per the mode. `spans`: every item's current span
 * (before the change for the moved ones — their new spans come in `moved`). Returns the new span of each item that
 * must move (never the moved ones themselves); follows chains (a shifted dependent shifts its own dependents),
 * at most `MAX_SHIFTED` items, and never loops (each item settles once per wave; a cycle stops at the guard).
 */
export const planShifts = (p: {
  spans: Map<string, Span>;
  links: DepLink[];
  moved: Map<string, { before: Span; after: Span }>;
  mode: DepMode;
  limit?: number;
  /** How the date column counts days (working days, a kept counted length); calendar days when absent. */
  count?: DayCount;
}): Map<string, Span> => {
  const out = new Map<string, Span>();
  if (p.mode === 'visual') return out;
  const limit = p.limit ?? MAX_SHIFTED;
  const dependents = new Map<string, DepLink[]>();
  for (const l of p.links) dependents.set(l.on, [...(dependents.get(l.on) ?? []), l]);
  const current = (id: string) => out.get(id) ?? p.moved.get(id)?.after ?? p.spans.get(id) ?? null;
  // Strict: each item moves by the largest delta any of its predecessors asks for (from its original span).
  const strictDelta = new Map<string, number>();
  const queue: { id: string; before: Span; after: Span }[] = [...p.moved].map(([id, v]) => ({ id, ...v }));
  const visits = new Map<string, number>();
  let steps = 0;
  while (queue.length) {
    const { id, before, after } = queue.shift()!;
    for (const link of dependents.get(id) ?? []) {
      if (p.moved.has(link.item)) continue; // the user placed it: never overridden
      const cur = current(link.item);
      if (!cur) continue;
      if (++steps > limit * 10) return out; // loop guard
      let next: Span | null = null;
      if (p.mode === 'strict') {
        // Counted mode: the dependent moves as many working days as the predecessor's anchor did.
        const a0 = anchorOf(before, link.kind);
        const a1 = anchorOf(after, link.kind);
        const delta = counted(p.count) ? countedDelta(a0, a1, p.count) : daysBetween(a0, a1);
        if (!delta) continue;
        const had = strictDelta.get(link.item);
        if (had !== undefined && Math.abs(had) >= Math.abs(delta)) continue;
        strictDelta.set(link.item, delta);
        const original = p.spans.get(link.item) ?? cur;
        next = shiftSpanCounted(original, delta, p.count);
      } else {
        const need = requiredShift(after, cur, link.kind, link.lag, p.count);
        if (!need) continue;
        next = pushed(after, cur, link, need, p.count);
      }
      if (next.from === cur.from && next.to === cur.to) continue;
      const n = (visits.get(link.item) ?? 0) + 1;
      if (n > p.links.length + 1) continue; // a cycle that slipped through
      visits.set(link.item, n);
      if (!out.has(link.item) && out.size >= limit) return out;
      out.set(link.item, next);
      queue.push({ id: link.item, before: cur, after: next });
    }
  }
  // Only real changes against the stored spans.
  for (const [id, s] of out) {
    const orig = p.spans.get(id);
    if (orig && orig.from === s.from && orig.to === s.to) out.delete(id);
  }
  return out;
};

/**
 * Items on the critical path (optional in the Gantt): zero slack against the latest end, treating every link as
 * finish-to-start with its lag. Null when the graph is too big (the caller hides the option) or has a cycle.
 */
export const criticalPath = (spans: Map<string, Span>, links: DepLink[], max = 2000): Set<string> | null => {
  if (spans.size > max) return null;
  const ids = [...spans.keys()];
  const succ = new Map<string, DepLink[]>();
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const usable = links.filter((l) => spans.has(l.item) && spans.has(l.on));
  for (const l of usable) {
    succ.set(l.on, [...(succ.get(l.on) ?? []), l]);
    indeg.set(l.item, (indeg.get(l.item) ?? 0) + 1);
  }
  // Topological order (Kahn); a cycle leaves items out → null.
  const order: string[] = [];
  const ready = ids.filter((id) => !indeg.get(id));
  while (ready.length) {
    const id = ready.pop()!;
    order.push(id);
    for (const l of succ.get(id) ?? []) {
      const d = indeg.get(l.item)! - 1;
      indeg.set(l.item, d);
      if (!d) ready.push(l.item);
    }
  }
  if (order.length !== ids.length) return null;
  let projectEnd = '';
  for (const s of spans.values()) if (s.to > projectEnd) projectEnd = s.to;
  // Backward pass: the latest each item may end without delaying the project.
  const latestEnd = new Map<string, string>();
  for (const id of [...order].reverse()) {
    let le = projectEnd;
    for (const l of succ.get(id) ?? []) {
      const s = spans.get(l.item)!;
      const succLatestStart = addDays(latestEnd.get(l.item)!, -daysBetween(s.from, s.to));
      const bound = addDays(succLatestStart, -1 - l.lag);
      if (bound < le) le = bound;
    }
    latestEnd.set(id, le);
  }
  const out = new Set<string>();
  // Critical = no slack, and part of a chain (a lone item counts only when it ends the project).
  for (const id of ids) if (latestEnd.get(id)! <= spans.get(id)!.to) out.add(id);
  return out;
};

/** The links a dependency cell value describes (`{item_ids, kind?, lag_days?}` — FS / 0 by default). */
export const linksOfValue = (item: string, value: unknown): DepLink[] => {
  const v = (value ?? {}) as { item_ids?: string[]; kind?: Record<string, DepKind>; lag_days?: Record<string, number> };
  return (v.item_ids ?? []).map((on) => ({
    item,
    on,
    kind: v.kind?.[on] ?? 'FS',
    lag: v.lag_days?.[on] ?? 0,
  }));
};
