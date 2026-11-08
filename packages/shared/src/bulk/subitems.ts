// SPDX-License-Identifier: AGPL-3.0-only
import { NEW_ROW_PREFIX, type BulkEditSubitems } from './api';
import {
  type BulkDecisions,
  type BulkEnv,
  type BulkReview,
  buildBulkEdit,
  type CellParse,
  type InvalidReason,
  reviewDraft,
} from './parse';
import {
  type Draft,
  draftRowCount,
  draftText,
  isEdited,
  PARENT_COLUMN,
  rowHasText,
  type SheetColumn,
  type SheetColumnInput,
  sheetColumns,
  type SheetRow,
} from './sheet';

/**
 * "ייבוא ועריכה" B4 — the subitems sheet (12-ROADMAP, product decision 2): a second tab beside the items sheet with
 * the sub-board's columns and a "parent item" column. The parent is typed by name and matched to a row of the
 * items sheet (or, on boards deeper than one level, of the subitems sheet) — new rows of this draft included, so a
 * new subitem can hang under an item created in the same batch. Not found / ambiguous / too deep are invalid
 * cells the review lists. Both sheets go in one request and one batch (one undo).
 */

/** The subitems sheet's column ids carry this prefix, so they never collide with the items sheet's (`status`…). */
export const SUB_COLUMN_PREFIX = 's:';
/** A sub-board column's key from its subitems-sheet id (new columns of an import keep their `__new_` id). */
export const subColumnKey = (id: string) =>
  id.startsWith(SUB_COLUMN_PREFIX) ? id.slice(SUB_COLUMN_PREFIX.length) : id;

/** The ref of a new row in the request (the parent of new subitems of the same batch). */
export const mainRowRef = (row: number) => `${NEW_ROW_PREFIX}m${row}`;
export const subRowRef = (row: number) => `${NEW_ROW_PREFIX}s${row}`;

/** A parent: an existing item / subitem, or a new row of this batch. */
export type ParentRef = { item_id: string } | { ref: string };

/** The subitems sheet's columns: the sub-board's (ids prefixed) and the parent column last. */
export const subSheetColumns = (cols: SheetColumnInput[], parentTitle: string): SheetColumn[] =>
  sheetColumns([
    ...cols.map((c) => ({ ...c, id: `${SUB_COLUMN_PREFIX}${c.id}` })),
    { id: PARENT_COLUMN, type: 'parent', title: parentTitle, settings: {} },
  ]);

/** One sheet as the dialog holds it. */
export type SheetState = { base: SheetRow[]; draft: Draft; columns: SheetColumn[] };

type Target = { sheet: 'main' | 'sub'; row: number };

/** Where every row of the subitems sheet hangs, at which level, and what is wrong with typed parents. */
export type ParentPlan = {
  /** Per row of the subitems sheet: its parent row (items or subitems sheet), when known. */
  parent: (Target | null)[];
  /** Per row: its level after the draft (1 = under an item), null when unknown. */
  depth: (number | null)[];
  /** Rows whose parent cell is invalid, and why. */
  issues: Map<number, InvalidReason>;
  /** The parent column, as the sheet and the review read it. */
  resolve: (row: number) => CellParse;
};

const norm = (s: string) => s.trim().toLocaleLowerCase();
const nameColumn = (columns: SheetColumn[]) => columns.find((c) => c.mode === 'name')?.id ?? 'name';
const live = (s: SheetState, row: number) => row < s.base.length || rowHasText(s.draft.edits[row]);

/**
 * Resolves the parent column of the subitems sheet against both drafts. An existing row whose parent cell is
 * untouched keeps its parent; a typed one is matched by name (case- and space-insensitive) to the rows of the
 * items sheet and — when the board has more than one level of subitems — the other rows of the subitems sheet.
 * None → `parent_missing`, more than one → `parent_ambiguous`, empty → `parent_required`; a parent among its own
 * subitems → `parent_cycle`; a level past `maxDepth` (the moved branch included) → `parent_depth`, on the row whose
 * parent was typed.
 */
export const planParents = (main: SheetState, sub: SheetState, maxDepth: number): ParentPlan => {
  const mainName = nameColumn(main.columns);
  const subName = nameColumn(sub.columns);
  const subCount = draftRowCount(sub.base, sub.draft);
  const byName = new Map<string, Target[]>();
  const add = (key: string, t: Target) => {
    if (!key) return;
    byName.set(key, [...(byName.get(key) ?? []), t]);
  };
  for (let row = 0; row < draftRowCount(main.base, main.draft); row++)
    if (live(main, row)) add(norm(draftText(main.base, main.draft, row, mainName)), { sheet: 'main', row });
  if (maxDepth > 1)
    for (let row = 0; row < subCount; row++)
      if (live(sub, row)) add(norm(draftText(sub.base, sub.draft, row, subName)), { sheet: 'sub', row });
  const mainByItem = new Map(main.base.map((r, i) => [r.itemId, i]));
  const subByItem = new Map(sub.base.map((r, i) => [r.itemId, i]));

  const parent: (Target | null)[] = [];
  const typed: boolean[] = [];
  const issues = new Map<number, InvalidReason>();
  for (let row = 0; row < subCount; row++) {
    const fresh = row >= sub.base.length;
    const edited = fresh || isEdited(sub.base, sub.draft, row, PARENT_COLUMN);
    typed.push(edited);
    if (!live(sub, row)) {
      parent.push(null);
      continue;
    }
    if (!edited) {
      const pid = sub.base[row]!.parentId ?? null;
      const m = pid === null ? undefined : mainByItem.get(pid);
      const s = pid === null ? undefined : subByItem.get(pid);
      parent.push(m !== undefined ? { sheet: 'main', row: m } : s !== undefined ? { sheet: 'sub', row: s } : null);
      continue;
    }
    const text = norm(draftText(sub.base, sub.draft, row, PARENT_COLUMN));
    const hits = text ? (byName.get(text) ?? []).filter((t) => !(t.sheet === 'sub' && t.row === row)) : [];
    if (!text) issues.set(row, 'parent_required');
    else if (!hits.length) issues.set(row, 'parent_missing');
    else if (hits.length > 1) issues.set(row, 'parent_ambiguous');
    parent.push(hits.length === 1 && text ? hits[0]! : null);
  }

  // Levels: under an item 1, under a subitem its level + 1; a loop has none.
  const depth: (number | null)[] = Array.from({ length: subCount }, () => null);
  const state: (0 | 1 | 2)[] = Array.from({ length: subCount }, () => 0); // 0 new, 1 visiting, 2 done
  const levelOf = (row: number): number | null => {
    if (state[row] === 2) return depth[row]!;
    if (state[row] === 1) return null;
    state[row] = 1;
    const p = parent[row];
    let d: number | null;
    if (p?.sheet === 'main') d = 1;
    else if (p?.sheet === 'sub') {
      const up = levelOf(p.row);
      d = up === null ? null : up + 1;
    } else d = typed[row] ? null : (sub.base[row]?.depth ?? null);
    state[row] = 2;
    depth[row] = d;
    return d;
  };
  for (let row = 0; row < subCount; row++) levelOf(row);
  // A typed parent among the row's own subitems: the chain up comes back to it.
  for (let row = 0; row < subCount; row++) {
    if (!typed[row] || issues.has(row) || parent[row]?.sheet !== 'sub') continue;
    const seen = new Set<number>();
    for (let at: Target | null = parent[row]!; at?.sheet === 'sub' && !seen.has(at.row); at = parent[at.row] ?? null) {
      if (at.row === row) {
        issues.set(row, 'parent_cycle');
        break;
      }
      seen.add(at.row);
    }
  }
  // Too deep: blame the nearest row (itself or above) whose parent was typed.
  for (let row = 0; row < subCount; row++) {
    if ((depth[row] ?? 0) <= maxDepth) continue;
    let at: number | null = row;
    const seen = new Set<number>();
    while (at !== null && !typed[at] && !seen.has(at)) {
      seen.add(at);
      const p: Target | null = parent[at] ?? null;
      at = p?.sheet === 'sub' ? p.row : null;
    }
    if (at !== null && typed[at] && !issues.has(at)) issues.set(at, 'parent_depth');
  }

  const resolve = (row: number): CellParse => {
    const reason = issues.get(row);
    if (reason) return { kind: 'invalid', reason };
    const p = parent[row];
    if (!p) return { kind: 'invalid', reason: 'parent_missing' };
    const s = p.sheet === 'main' ? main : sub;
    const itemId = s.base[p.row]?.itemId ?? null;
    const value: ParentRef = itemId
      ? { item_id: itemId }
      : { ref: (p.sheet === 'main' ? mainRowRef : subRowRef)(p.row) };
    return { kind: 'value', value };
  };
  return { parent, depth, issues, resolve };
};

/** The subitems sheet's env: the items sheet's, with the parent column resolved. */
export const subEnv = (env: BulkEnv, plan: ParentPlan): BulkEnv => ({ ...env, parents: plan.resolve });

/**
 * The review of the subitems sheet (B4): `reviewDraft` of it, with new rows that have no parent at all flagged
 * (their empty parent cell is no change), every invalid cell marked as the subitems sheet's.
 */
export const reviewSubitems = (sub: SheetState, env: BulkEnv): BulkReview => {
  const r = reviewDraft(sub.base, sub.draft, sub.columns, env);
  const listed = new Set(r.invalid.filter((x) => x.columnId === PARENT_COLUMN).map((x) => x.row));
  for (let row = sub.base.length; row < draftRowCount(sub.base, sub.draft); row++) {
    if (listed.has(row) || !rowHasText(sub.draft.edits[row])) continue;
    if (draftText(sub.base, sub.draft, row, PARENT_COLUMN).trim()) continue;
    r.invalid.push({ row, columnId: PARENT_COLUMN, text: '', reason: 'parent_required' });
  }
  r.invalid.sort((a, b) => a.row - b.row);
  for (const x of r.invalid) x.sheet = 'sub';
  return r;
};

const normKey = (s: string) => s.trim().toLocaleLowerCase();

/** Both sheets' reviews as one (labels per column, tags and people by name, counts summed). */
export const mergeReviews = (a: BulkReview, b: BulkReview): BulkReview => {
  const tags = [...a.tags];
  for (const v of b.tags) {
    const hit = tags.find((x) => normKey(x.name) === normKey(v.name));
    if (hit) hit.count += v.count;
    else tags.push({ ...v });
  }
  const people = [...a.people];
  for (const p of b.people) {
    const hit = people.find((x) => normKey(x.name) === normKey(p.name));
    if (hit) hit.count += p.count;
    else people.push({ ...p });
  }
  return {
    labels: [...a.labels, ...b.labels],
    tags,
    invalid: [...a.invalid, ...b.invalid],
    people,
    updated: a.updated + b.updated,
    created: a.created + b.created,
    cells: a.cells + b.cells,
    secrets: { set: a.secrets.set + b.secrets.set, replace: a.secrets.replace + b.secrets.replace },
  };
};

/**
 * The `subitems` part of the request (B4): `buildBulkEdit` of the subitems sheet with sub-board keys, new rows named
 * by `subRowRef`. A new row without a parent, or whose parent row is not in the request (`refs`: the items sheet's
 * new rows that are; its own are added), is left out and counted, as are the rows under it; a parent typed back to
 * the one the subitem has is no move.
 */
export const buildSubitems = (
  sub: SheetState,
  env: BulkEnv,
  decisions: BulkDecisions,
  defaults: { name: string },
  refs: Set<string>,
): { subitems: BulkEditSubitems; skipped: number } => {
  const out = buildBulkEdit(sub.base, sub.draft, sub.columns, env, decisions, {
    groupId: null,
    name: defaults.name,
    ref: subRowRef,
  });
  let skipped = out.skipped;
  const parentOf = new Map(sub.base.map((r) => [r.itemId, r.parentId ?? null]));
  type Row = BulkEditSubitems['rows'][number];
  let rows: Row[] = out.request.rows.map(({ group_id: _, ...r }) => {
    const row: Row = {
      ...r,
      cells: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [subColumnKey(k), v])),
      ...(r.secrets
        ? { secrets: Object.fromEntries(Object.entries(r.secrets).map(([k, v]) => [subColumnKey(k), v])) }
        : {}),
    };
    if (row.item_id && row.parent_item_id && parentOf.get(row.item_id) === row.parent_item_id)
      delete row.parent_item_id;
    return row;
  });
  // Parents that are not written take their new subitems with them (until nothing changes).
  const known = new Set(refs);
  for (const r of rows) if (r.ref) known.add(r.ref);
  for (;;) {
    const dangling = (r: Row) => !!r.parent_ref && !known.has(r.parent_ref);
    // An existing subitem only stays where it is.
    for (const r of rows)
      if (r.item_id && dangling(r)) {
        delete r.parent_ref;
        skipped++;
      }
    const drop = rows.filter((r) => !r.item_id && ((!r.parent_item_id && !r.parent_ref) || dangling(r)));
    if (!drop.length) break;
    for (const r of drop) if (r.ref) known.delete(r.ref);
    skipped += drop.length;
    const gone = new Set(drop);
    rows = rows.filter((r) => !gone.has(r));
  }
  rows = rows.filter(
    (r) =>
      !r.item_id ||
      r.name !== undefined ||
      r.parent_item_id ||
      r.parent_ref ||
      Object.keys(r.cells).length ||
      Object.keys(r.secrets ?? {}).length,
  );
  const subitems: BulkEditSubitems = {
    labels: out.request.labels.map((l) => ({ ...l, column_id: subColumnKey(l.column_id) })),
    rows,
  };
  return { subitems, skipped };
};
