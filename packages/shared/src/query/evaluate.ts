// SPDX-License-Identifier: AGPL-3.0-only
import { comparesNumbers } from '../columns/types';
import type { MirrorEach } from '../columns/defs/computed';
import { localDate, overlaps, type DateSpan } from './dates';
import type { Field, Plan, PlanNode, PlanRule } from './plan';

/**
 * The in-memory query engine (13-FILTERS): runs a Plan over item rows (the Item DTO). The board UI filters its
 * loaded items with it, and the API falls back to it when a query touches values computed on read.
 * Semantics must match the SQL compiler (apps/api/src/modules/items/query.repo.ts) — a parity test keeps them equal.
 */
export type QueryRow = {
  id: string;
  group_id: string | null;
  parent_item_id: string | null;
  depth: number;
  name: string;
  position: string;
  key: string | null;
  cells: Record<string, { value: unknown; text: string | null } | undefined>;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  /** The item's subitems (D14), attached when the plan reads them (`planUsesSubitems`). */
  subitems?: QueryRow[];
};

const cellOf = (row: QueryRow, f: Field) => (f.source === 'column' ? row.cells[f.id] : undefined);

export const readText = (row: QueryRow, f: Field): string => {
  if (f.source === 'system') return f.id === '__key__' ? (row.key ?? '') : '';
  if (f.def.storage === 'item') return row.name;
  return cellOf(row, f)?.text ?? '';
};

export const readNumber = (row: QueryRow, f: Field): number | null => {
  if (f.source === 'system') return f.id === '__depth__' ? row.depth : null;
  const cell = cellOf(row, f);
  if (!cell || cell.value === null || cell.value === undefined) return null;
  try {
    const n = f.def.toNumber
      ? f.def.toNumber(cell.value, f.settings)
      : typeof cell.value === 'number'
        ? cell.value
        : null;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

/** The stored date(s) as they sort: plain dates or full ISO instants. */
const readDateRaw = (row: QueryRow, f: Field): { start: string; end: string } | null => {
  if (f.source === 'system') {
    const at = f.id === '__created_at__' ? row.created_at : f.id === '__updated_at__' ? row.updated_at : null;
    return at ? { start: at, end: at } : null;
  }
  const cell = cellOf(row, f);
  if (!cell || cell.value === null || cell.value === undefined || !f.def.toDate) return null;
  try {
    const start = f.def.toDate(cell.value, f.settings);
    if (!start) return null;
    return { start, end: f.def.toDateEnd?.(cell.value, f.settings) ?? start };
  } catch {
    return null;
  }
};

export const readDateSpan = (
  row: QueryRow,
  f: Field,
  timezone: string,
  attribute?: 'start' | 'end',
): DateSpan | null => {
  const raw = readDateRaw(row, f);
  if (!raw) return null;
  const from = localDate(raw.start, timezone);
  const to = localDate(raw.end, timezone);
  if (attribute === 'start') return { from, to: from };
  if (attribute === 'end') return { from: to, to };
  return { from, to };
};

type V = Record<string, unknown> | null | undefined;

export const readIds = (row: QueryRow, f: Field): string[] => {
  if (f.source === 'system') {
    const id = f.id === '__group__' ? row.group_id : f.id === '__parent__' ? row.parent_item_id : row.created_by;
    return id ? [id] : [];
  }
  const v = cellOf(row, f)?.value as V;
  if (!v) return [];
  if (f.mirrored) return mirroredIds(v, f);
  switch (f.model) {
    case 'label':
    case 'labels':
      return (f.def.labelIds?.(v) ?? []).map(String);
    case 'people':
      return ((v.persons_and_teams as { id: string }[] | undefined) ?? []).map((p) => p.id);
    case 'links':
      return ((v.item_ids as string[] | undefined) ?? []).map(String);
    case 'tags':
      return ((v.tag_ids as string[] | undefined) ?? []).map(String);
    default:
      return [];
  }
};

/**
 * A mirror filtered as its source: the ids of the values of every linked item — label ids by their
 * text (the field's labels are the source's), people as kept on the mirror's value.
 */
const mirroredIds = (v: Record<string, unknown>, f: Field & { source: 'column' }): string[] => {
  if (f.model === 'people') return ((v.people as string[] | undefined) ?? []).map(String);
  if (f.model !== 'label' && f.model !== 'labels') return [];
  const labels = (Array.isArray(f.settings.labels) ? f.settings.labels : []) as { id: number; label: string }[];
  const key = (s: string) => s.trim().toLowerCase();
  const texts = new Set(((v.labels as { label: string }[] | undefined) ?? []).map((l) => key(l.label)));
  return labels.filter((l) => texts.has(key(l.label))).map((l) => String(l.id));
};

/** A mirror's dates: one span per linked item that has one. */
const mirroredSpans = (row: QueryRow, f: Field, timezone: string, attribute?: 'start' | 'end'): DateSpan[] => {
  const dates = (cellOf(row, f)?.value as V)?.dates as { start: string; end: string }[] | undefined;
  return (dates ?? []).map((d) => {
    const from = localDate(d.start, timezone);
    const to = localDate(d.end, timezone);
    return attribute === 'start' ? { from, to: from } : attribute === 'end' ? { from: to, to } : { from, to };
  });
};

const readChecked = (row: QueryRow, f: Field) => (cellOf(row, f)?.value as V)?.checked === true;

const anyIn = (have: string[], want: string[]) => have.some((x) => want.includes(x));

/**
 * "Every linked item" (`PlanRule.matchAll`): the rule is checked on each linked item's own values
 * (`each` on the mirror's value) and must hold for all of them; a mirror with no linked item does not match.
 */
const everyLinkedItem = (r: PlanRule, row: QueryRow, timezone: string): boolean => {
  const f = r.field;
  if (f.source !== 'column') return false;
  const each = ((cellOf(row, f)?.value as V)?.each as MirrorEach[] | undefined) ?? [];
  if (!each.length) return false;
  const one: PlanRule = { ...r, matchAll: false };
  return each.every((e) => {
    const value = {
      display_value: '',
      ...(e.labels ? { labels: e.labels.map((label) => ({ label, color: '', count: 1 })) } : {}),
      ...(e.people ? { people: e.people } : {}),
      ...(e.dates ? { dates: e.dates } : {}),
    };
    return ruleMatches(one, { ...row, cells: { ...row.cells, [f.id]: { value, text: null } } }, timezone);
  });
};

const ruleMatches = (r: PlanRule, row: QueryRow, timezone: string): boolean => {
  if (r.matchAll) return everyLinkedItem(r, row, timezone);
  const op = r.operator;
  const f = r.field;
  const m = f.model;

  if (m === 'checkbox') return op === 'is_not_empty' ? readChecked(row, f) : !readChecked(row, f);
  // a timer column — some timer runs on the cell now.
  if (op === 'is_running' || op === 'is_not_running')
    return ((cellOf(row, f)?.value as V)?.running === true) === (op === 'is_running');

  const textOp = op === 'contains_text' || op === 'not_contains_text' || op === 'starts_with' || op === 'ends_with';
  const numeric = comparesNumbers(m, op);
  if (!numeric && (textOp || m === 'text' || m === 'files')) {
    const t = readText(row, f).trim().toLowerCase();
    switch (op) {
      case 'is_empty':
        return t === '';
      case 'is_not_empty':
        return t !== '';
      case 'any_of':
        return (r.wantsEmpty && t === '') || r.texts.includes(t);
      case 'not_any_of':
        return !((r.wantsEmpty && t === '') || r.texts.includes(t));
      case 'contains_text':
        return r.texts.some((v) => t.includes(v));
      case 'not_contains_text':
        return !r.texts.some((v) => t.includes(v));
      case 'starts_with':
        return r.texts.some((v) => t.startsWith(v));
      case 'ends_with':
        return r.texts.some((v) => t.endsWith(v));
      default:
        return false;
    }
  }

  if (numeric) {
    const n = readNumber(row, f);
    const [a, b] = r.numbers;
    switch (op) {
      case 'is_empty':
        return n === null;
      case 'is_not_empty':
        return n !== null;
      case 'any_of':
        return n === null ? r.wantsEmpty : r.numbers.includes(n);
      case 'not_any_of':
        return n === null ? !r.wantsEmpty : !r.numbers.includes(n);
      case 'greater_than':
        return n !== null && n > a!;
      case 'greater_than_or_equal':
        return n !== null && n >= a!;
      case 'lower_than':
        return n !== null && n < a!;
      case 'lower_than_or_equal':
        return n !== null && n <= a!;
      case 'between':
        return n !== null && n >= Math.min(a!, b!) && n <= Math.max(a!, b!);
      default:
        return false;
    }
  }

  if (m === 'date') {
    // A column's one date — or a mirror's dates, one per linked item: any of them matching is a match.
    let ds: DateSpan[];
    if (f.source === 'column' && f.mirrored) ds = mirroredSpans(row, f, timezone, r.attribute);
    else {
      const d = readDateSpan(row, f, timezone, r.attribute);
      ds = d ? [d] : [];
    }
    switch (op) {
      case 'is_empty':
        return !ds.length;
      case 'is_not_empty':
        return ds.length > 0;
      case 'any_of':
        return !ds.length ? r.wantsEmpty : ds.some((d) => dateAnyOf(r, row, d));
      case 'not_any_of':
        return !ds.length ? !r.wantsEmpty : !ds.some((d) => dateAnyOf(r, row, d));
      case 'greater_than': {
        const s = r.spans[0]!;
        return s.to !== null && ds.some((d) => d.from! > s.to!);
      }
      case 'lower_than': {
        const s = r.spans[0]!;
        return s.from !== null && ds.some((d) => d.to! < s.from!);
      }
      case 'between':
      case 'within_the_last':
      case 'within_the_next':
        return ds.some((d) => overlaps(d, r.spans[0]!));
      default:
        return false;
    }
  }

  // id models: label, labels, people, links, ids
  const ids = readIds(row, f);
  switch (op) {
    case 'is_empty':
      return ids.length === 0;
    case 'is_not_empty':
      return ids.length > 0;
    case 'any_of':
      return (r.wantsEmpty && ids.length === 0) || anyIn(ids, r.ids);
    case 'not_any_of':
      return !((r.wantsEmpty && ids.length === 0) || anyIn(ids, r.ids));
    case 'is_done':
      return anyIn(ids, r.ids);
    case 'is_not_done':
      return !anyIn(ids, r.ids);
    case 'has_unmatched_link':
      return anyIn(ids, r.ids);
    case 'no_unmatched_link':
      return !anyIn(ids, r.ids);
    default:
      return false;
  }
};

const dateAnyOf = (r: PlanRule, row: QueryRow, d: DateSpan) =>
  r.spans.some(
    (s) =>
      overlaps(d, s) && (!s.overdue || !r.overdue || !anyIn(readIds(row, r.overdue.statusField), r.overdue.doneIds)),
  );

/**
 * How a `sub:` rule treats an item that has no subitems (owner fix6-server 1). `'pass'` (filters, the default):
 * the rule does not apply to it — it is left out of its group, whatever the operator or negation, so the item is
 * judged by its other rules only (and kept when every rule is a subitem rule). `'fail'`: the rule reads "has a
 * subitem where …", which an item without subitems never has (conditional coloring paints only real matches).
 */
export type MissingSubitems = 'pass' | 'fail';

/** true / false, or null = not applicable (only subitem rules on an item without subitems). */
const nodeEval = (n: PlanNode, row: QueryRow, timezone: string, missing: MissingSubitems): boolean | null => {
  let hit: boolean;
  if (n.kind === 'rule') {
    if (n.sub) {
      const subs = row.subitems ?? [];
      if (!subs.length && missing === 'pass') return null;
      hit = subs.some((c) => ruleMatches(n, c, timezone));
    } else hit = ruleMatches(n, row, timezone);
  } else {
    const parts = n.nodes.map((c) => nodeEval(c, row, timezone, missing)).filter((x): x is boolean => x !== null);
    // Every rule of the group is not applicable: so is the group — unless it is strict (the Person filter: an
    // item without subitems is "theirs" only by its own people columns).
    if (!parts.length && n.nodes.length) return n.strict ? false : null;
    hit = n.operator === 'and' ? parts.every(Boolean) : parts.some(Boolean);
  }
  return n.negate ? !hit : hit;
};

export const nodeMatches = (n: PlanNode, row: QueryRow, timezone: string, missing: MissingSubitems = 'pass') =>
  nodeEval(n, row, timezone, missing) ?? true;

const searchMatches = (plan: Plan, row: QueryRow) => {
  const q = plan.search!;
  if (row.name.toLowerCase().includes(q)) return true;
  if (plan.searchFields.some((f) => readText(row, f).toLowerCase().includes(q))) return true;
  // A subitem's (any depth) name or stored values count too.
  return plan.searchSubitems && (row.subitems ?? []).some((c) => searchHitsSubitem(plan, c));
};

/** Whether the plan's search matches this subitem by its own name or stored values (not its children's). */
export const searchHitsSubitem = (plan: Plan, sub: QueryRow): boolean => {
  const q = plan.search;
  if (!q || !plan.searchSubitems) return false;
  return (
    sub.name.toLowerCase().includes(q) || plan.subSearchFields.some((f) => readText(sub, f).toLowerCase().includes(q))
  );
};

/** Filter only (search, person, filter tree) — no scope/sort. */
export const rowMatches = (plan: Plan, row: QueryRow, timezone: string, missing: MissingSubitems = 'pass') =>
  (!plan.search || searchMatches(plan, row)) && (!plan.filter || nodeMatches(plan.filter, row, timezone, missing));

/**
 * `rowMatches`, and with `subitems_strict`: an item that does not match by its own values stays only
 * when a chain of its subitems — each matching by its own values — reaches a match; a subitem that fails cuts off
 * everything under it. Rows without attached subitems are judged as before.
 */
export const rowMatchesStrictly = (plan: Plan, row: QueryRow, timezone: string): boolean => {
  if (!plan.subitemsStrict || !row.subitems?.length) return rowMatches(plan, row, timezone);
  if (!rowMatches(plan, row, timezone)) return false;
  if (rowMatches(plan, { ...row, subitems: [] }, timezone, 'fail')) return true;
  const byParent = new Map<string, QueryRow[]>();
  for (const s of row.subitems) {
    const list = byParent.get(s.parent_item_id ?? '') ?? [];
    list.push(s);
    byParent.set(s.parent_item_id ?? '', list);
  }
  return (matchingSubtreeWithPaths(plan, row, timezone, byParent).tree.get(row.id) ?? []).length > 0;
};

/**
 * Which subitems to show under a matching item when the plan reads subitems: those that would keep the item in
 * the result on their own. An item that matches by its own values keeps all of them.
 */
export const matchingSubitems = <R extends QueryRow>(plan: Plan, row: QueryRow, timezone: string, children: R[]) =>
  children.filter((c) => rowMatches(plan, { ...row, subitems: [c] }, timezone));

/** Every descendant of `id` (subitems of subitems too, D14), depth first, from a parent → children map. */
export const descendantsOf = <R extends { id: string }>(byParent: ReadonlyMap<string, R[]>, id: string): R[] =>
  (byParent.get(id) ?? []).flatMap((c) => [c, ...descendantsOf(byParent, c.id)]);

/** The subtree under a matching item, plus the kept subitems shown only as the path to a deeper match. */
export type MatchedSubtree<R> = {
  /** Parent id → kept children (for the item and each kept child). */
  tree: Map<string, R[]>;
  /**
   * Kept subitems that do not match by their own values: shown only because something under them matches
   * (product decision, option א — the table dims them and says why).
   */
  pathOnly: Set<string>;
};

/**
 * The subtree to show under a matching item, at every depth: a child stays when it — or one of its own
 * descendants — keeps the item in the result, so a match two levels down keeps (and opens) the path to it.
 * A child kept only for what lies under it is listed in `pathOnly`.
 */
export const matchingSubtreeWithPaths = <R extends QueryRow>(
  plan: Plan,
  row: QueryRow,
  timezone: string,
  byParent: ReadonlyMap<string, R[]>,
): MatchedSubtree<R> => {
  const tree = new Map<string, R[]>();
  const pathOnly = new Set<string>();
  const visit = (parentId: string) => {
    const kept: R[] = [];
    for (const c of byParent.get(parentId) ?? []) {
      if (rowMatches(plan, { ...row, subitems: [c] }, timezone)) kept.push(c);
      // Strict: a subitem that does not match itself takes its whole subtree with it.
      else if (plan.subitemsStrict) continue;
      else if (rowMatches(plan, { ...row, subitems: [c, ...descendantsOf(byParent, c.id)] }, timezone)) {
        kept.push(c);
        pathOnly.add(c.id);
      }
    }
    tree.set(parentId, kept);
    for (const c of kept) visit(c.id);
  };
  visit(row.id);
  return { tree, pathOnly };
};

/** `matchingSubtreeWithPaths` without the path flags: parent id → kept children. */
export const matchingSubtree = <R extends QueryRow>(
  plan: Plan,
  row: QueryRow,
  timezone: string,
  byParent: ReadonlyMap<string, R[]>,
): Map<string, R[]> => matchingSubtreeWithPaths(plan, row, timezone, byParent).tree;

type SortValue = number | string | null;

const sortValue = (row: QueryRow, f: Field): SortValue => {
  switch (f.sortKey) {
    case 'number':
      return readNumber(row, f);
    case 'date': {
      const raw = readDateRaw(row, f);
      if (!raw) return null;
      const ms = Date.parse(raw.start.length === 10 ? `${raw.start}T00:00:00Z` : raw.start);
      return Number.isFinite(ms) ? ms : null;
    }
    case 'text': {
      const t = (f.source === 'system' && f.id !== '__key__' ? readIds(row, f)[0] : readText(row, f)) ?? '';
      return t.trim() === '' ? null : t.trim().toLowerCase();
    }
    default:
      return null;
  }
};

/** Codepoint order — the same as Postgres `COLLATE "C"` on lower(text), so paging in SQL and here agree. */
const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Comparator for a plan's sort levels; ties fall back to group order (when given), then position, then id —
 * the board's natural order.
 */
export const rowComparator = (plan: Plan, groupRank?: Map<string, number>) => {
  const levels = plan.sort;
  return (a: QueryRow, b: QueryRow): number => {
    if (groupRank) {
      // Subitems have no group; they sort before every group, like NULL-first in SQL.
      const ga = a.group_id ? (groupRank.get(a.group_id) ?? -1) : -1;
      const gb = b.group_id ? (groupRank.get(b.group_id) ?? -1) : -1;
      if (ga !== gb) return ga - gb;
    }
    for (const s of levels) {
      const va = sortValue(a, s.field);
      const vb = sortValue(b, s.field);
      if (va === null && vb === null) continue;
      if (va === null || vb === null) return (va === null ? 1 : -1) * (s.nulls === 'last' ? 1 : -1);
      const c = cmp(va, vb);
      if (c) return s.direction === 'asc' ? c : -c;
    }
    return cmp(a.position, b.position) || cmp(a.id, b.id);
  };
};

/**
 * Filters and orders rows: scope (parents/subitems), match_children (a parent stays when a descendant
 * matches), then sort. `groupRank` orders by board group first (the table; Kanban/Calendar pass none).
 */
export const applyPlan = <R extends QueryRow>(
  rows: R[],
  plan: Plan,
  timezone: string,
  groupRank?: Map<string, number>,
): R[] => {
  const inScope = (r: R) => plan.scope === 'all' || (plan.scope === 'parents' ? r.depth === 0 : r.depth > 0);
  let matched = new Set(rows.filter((r) => rowMatchesStrictly(plan, r, timezone)).map((r) => r.id));
  if (plan.matchChildren && plan.scope === 'parents') {
    const parentOf = new Map(rows.map((r) => [r.id, r.parent_item_id]));
    const withAncestors = new Set(matched);
    for (const id of matched) {
      let p = parentOf.get(id);
      while (p && !withAncestors.has(p)) {
        withAncestors.add(p);
        p = parentOf.get(p);
      }
    }
    matched = withAncestors;
  }
  return rows.filter((r) => matched.has(r.id) && inScope(r)).sort(rowComparator(plan, groupRank));
};
