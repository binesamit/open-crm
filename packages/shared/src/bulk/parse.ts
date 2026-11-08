// SPDX-License-Identifier: AGPL-3.0-only
import type { Region } from '../locale/format';
import { cellFromText, nextLabelId, type TextPerson } from '../columns';
import { SECRET_LIMITS } from '../columns/defs/secret';
import { nextLabelColor, normalizeLabelColor, STATUS_COLORS, type ColorKey, type GroupColor } from '../colors';
import { tagColorFor } from '../api/tags';
import type { BulkEditRequest } from './api';
import type { ParentRef } from './subitems';
import { type Draft, type DraftChange, draftChanges, type SheetColumn, type SheetRow } from './sheet';

/**
 * Sheet text → cell value, per column type (B2 "finish"). Unlike a paste in the table, nothing is dropped
 * silently: an unknown status / dropdown label or tag is a *new value* the user may add, an unknown person is
 * reported, and a text that is not a valid date / number / email… is *invalid* and flagged for fixing.
 */
export type BulkEnv = {
  /** Account members and teams (people cells match by name or email). */
  people: TextPerson[];
  /** Account tags (a name not here is a new tag). */
  tags: { id: string; name: string }[];
  /** The board's groups (new rows: the group column matches a title). */
  groups: { id: string; title: string }[];
  /** Subitems sheet (B4): the parent column of a row, as `planParents` resolved it. */
  parents?: (row: number) => CellParse;
  /** The account's region: a date typed with a time is wall-clock in its zone (audit 2026-10-10 A1). */
  region?: Region;
};

/** Why a cell is invalid, when the type alone does not say (the parent column of the subitems sheet). */
export type InvalidReason = 'parent_missing' | 'parent_ambiguous' | 'parent_required' | 'parent_depth' | 'parent_cycle';

export type CellParse =
  | { kind: 'clear' }
  | { kind: 'value'; value: unknown }
  /** status / dropdown: label ids found + names that are not labels of the column yet. */
  | { kind: 'labels'; known: number[]; fresh: string[] }
  /** tags: every name (`fresh` = not an account tag yet). */
  | { kind: 'tags'; names: string[]; fresh: string[] }
  /** people: the ones found, and the names / emails that are no member or team. */
  | { kind: 'people'; found: { id: string; kind: 'person' | 'team' }[]; missing: string[] }
  | { kind: 'invalid'; reason?: InvalidReason };

type Label = { id: number; label: string; is_deactivated?: boolean; index?: number };

const norm = (s: string) => s.trim().toLocaleLowerCase();
const parts = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const uniq = (list: string[]) => [...new Map(list.map((x) => [norm(x), x])).values()];
const labelsOf = (column: SheetColumn) => ((column.settings.labels as Label[] | undefined) ?? []).filter(Boolean);
const active = (column: SheetColumn) => labelsOf(column).filter((l) => !l.is_deactivated);

/** Max label length per type (labels.ts settings schemas). */
const LABEL_MAX: Record<string, number> = { status: 30, dropdown: 100 };
const NAME_MAX = 255;
const TAG_MAX = 60;

export const parseSheetCell = (column: SheetColumn, text: string, env: BulkEnv, row = -1): CellParse => {
  const t = text.trim();
  if (column.mode === 'parent') return env.parents ? env.parents(row) : { kind: 'invalid' };
  if (column.mode === 'name') return t && t.length <= NAME_MAX ? { kind: 'value', value: t } : { kind: 'invalid' };
  if (column.mode === 'group') {
    if (!t) return { kind: 'clear' };
    const g = env.groups.find((x) => norm(x.title) === norm(t));
    return g ? { kind: 'value', value: g.id } : { kind: 'invalid' };
  }
  // A secret goes as typed — never trimmed, never shown back.
  if (column.mode === 'secret')
    return text && text.length <= SECRET_LIMITS.maxLength ? { kind: 'value', value: text } : { kind: 'invalid' };
  if (column.mode !== 'edit') return { kind: 'invalid' };
  if (!t) return { kind: 'clear' };
  switch (column.type) {
    case 'status':
    case 'dropdown': {
      const names = column.type === 'status' ? [t] : uniq(parts(t));
      const labels = active(column);
      const known: number[] = [];
      const fresh: string[] = [];
      for (const n of names) {
        const l = labels.find((x) => norm(x.label) === norm(n));
        if (l) known.push(l.id);
        else if (n.length > LABEL_MAX[column.type]!) return { kind: 'invalid' };
        else fresh.push(n);
      }
      return fresh.length
        ? { kind: 'labels', known: [...new Set(known)], fresh }
        : { kind: 'value', value: column.type === 'status' ? { index: known[0] } : { ids: [...new Set(known)] } };
    }
    case 'tags': {
      const names = uniq(parts(t).map((p) => p.replace(/^#+/, '').trim())).filter(Boolean);
      if (!names.length) return { kind: 'clear' };
      if (names.some((n) => n.length > TAG_MAX)) return { kind: 'invalid' };
      const have = new Set(env.tags.map((x) => norm(x.name)));
      const fresh = names.filter((n) => !have.has(norm(n)));
      return fresh.length ? { kind: 'tags', names, fresh } : { kind: 'value', value: { tags: names } };
    }
    case 'people': {
      const found = new Map<string, { id: string; kind: 'person' | 'team' }>();
      const missing: string[] = [];
      for (const p of uniq(parts(t))) {
        const x = env.people.find((m) => norm(m.name) === norm(p) || (!!m.email && norm(m.email) === norm(p)));
        if (x) found.set(x.id, { id: x.id, kind: x.kind });
        else missing.push(p);
      }
      const list = [...found.values()];
      return missing.length
        ? { kind: 'people', found: list, missing }
        : { kind: 'value', value: { persons_and_teams: list } };
    }
    default: {
      const v = cellFromText(column.type, text, column.settings, env.people, { region: env.region });
      return v === undefined ? { kind: 'invalid' } : v === null ? { kind: 'clear' } : { kind: 'value', value: v };
    }
  }
};

/** A new label / tag the review asks about: add it (with a colour) or not. */
export type NewValue = { columnId: string; name: string; count: number };
export type InvalidCell = {
  row: number;
  columnId: string;
  text: string;
  /** The subitems sheet's (B4); else the items sheet's. */
  sheet?: 'sub';
  reason?: InvalidReason;
};
export type MissingPerson = { name: string; count: number };

export type BulkReview = {
  /** status / dropdown labels that do not exist yet, per column, in first-seen order. */
  labels: NewValue[];
  /** Tags that do not exist yet (account-wide: `columnId` is the first column that uses it). */
  tags: NewValue[];
  invalid: InvalidCell[];
  people: MissingPerson[];
  /** Existing rows with a change, new rows with text, changed cells. */
  updated: number;
  created: number;
  cells: number;
  /**
   * secret cells the draft sets — into an empty cell, and over a value the cell already has (written
   * only when the user picks "replace existing values"; those can not come back with an undo).
   */
  secrets: { set: number; replace: number };
};

const bump = (list: NewValue[], columnId: string | null, name: string) => {
  const hit = list.find((x) => (columnId === null || x.columnId === columnId) && norm(x.name) === norm(name));
  if (hit) hit.count++;
  else list.push({ columnId: columnId ?? '', name, count: 1 });
};

export const reviewDraft = (base: SheetRow[], d: Draft, columns: SheetColumn[], env: BulkEnv): BulkReview => {
  const changes = draftChanges(base, d, columns);
  const labels: NewValue[] = [];
  const tags: NewValue[] = [];
  const invalid: InvalidCell[] = [];
  const people: MissingPerson[] = [];
  const secrets = { set: 0, replace: 0 };
  for (const c of changes) {
    const p = parseSheetCell(c.column, c.text, env, c.row);
    // A secret's text never reaches the review (an invalid one is listed without it).
    const shown = c.column.mode === 'secret' ? '' : c.text;
    if (p.kind === 'invalid')
      invalid.push({ row: c.row, columnId: c.column.id, text: shown, ...(p.reason ? { reason: p.reason } : {}) });
    else if (c.column.mode === 'secret') {
      if (base[c.row]?.secrets?.includes(c.column.id)) secrets.replace++;
      else secrets.set++;
    } else if (p.kind === 'labels') for (const n of p.fresh) bump(labels, c.column.id, n);
    else if (p.kind === 'tags')
      for (const n of p.fresh) {
        const hit = tags.find((x) => norm(x.name) === norm(n));
        if (hit) hit.count++;
        else tags.push({ columnId: c.column.id, name: n, count: 1 });
      }
    else if (p.kind === 'people')
      for (const n of p.missing) {
        const hit = people.find((x) => norm(x.name) === norm(n));
        if (hit) hit.count++;
        else people.push({ name: n, count: 1 });
      }
  }
  const rows = new Set(changes.map((c) => c.row));
  const created = [...rows].filter((r) => r >= base.length).length;
  return { labels, tags, invalid, people, updated: rows.size - created, created, cells: changes.length, secrets };
};

/** The user's answers on the review screen. A new value that is not added leaves its cells out. */
export type BulkDecisions = {
  /** `${columnId}\u0000${name lowercased}` → add it, with this colour (status: a palette key). */
  labels: Record<string, { add: boolean; color?: ColorKey }>;
  /** name lowercased → add it, with this group colour. */
  tags: Record<string, { add: boolean; color?: GroupColor }>;
};
export const labelDecisionKey = (columnId: string, name: string) => `${columnId}\u0000${norm(name)}`;

/** Default answers: add every new value; status labels get the next unused palette colours, tags their own. */
export const defaultDecisions = (review: BulkReview, columns: SheetColumn[]): BulkDecisions => {
  const labels: BulkDecisions['labels'] = {};
  const usedByColumn = new Map<string, Set<string>>();
  for (const v of review.labels) {
    const column = columns.find((c) => c.id === v.columnId);
    if (column?.type !== 'status') {
      labels[labelDecisionKey(v.columnId, v.name)] = { add: true };
      continue;
    }
    if (!usedByColumn.has(v.columnId))
      usedByColumn.set(
        v.columnId,
        new Set(labelsOf(column).map((l) => String(normalizeLabelColor((l as { color?: string }).color ?? '')))),
      );
    const used = usedByColumn.get(v.columnId)!;
    const color = nextLabelColor(used); // pal40: an unused vivid colour first, then the other families
    used.add(color);
    labels[labelDecisionKey(v.columnId, v.name)] = { add: true, color };
  }
  const tags: BulkDecisions['tags'] = {};
  for (const v of review.tags) tags[norm(v.name)] = { add: true, color: tagColorFor(v.name) };
  return { labels, tags };
};

/**
 * The batch request for the draft and the answers (B2). New labels get the next free ids of their column (the
 * server refuses with 409 if the column changed meanwhile); cells that are invalid, or whose only values were
 * not added / not found, are left out (counted in `skipped`). New rows take the group column, else `defaultGroupId`,
 * and their name, else `defaultName`.
 */
export const buildBulkEdit = (
  base: SheetRow[],
  d: Draft,
  columns: SheetColumn[],
  env: BulkEnv,
  decisions: BulkDecisions,
  defaults: { groupId: string | null; name: string; ref?: (row: number) => string },
): { request: BulkEditRequest; skipped: number } => {
  const changes = draftChanges(base, d, columns);
  const newLabels: BulkEditRequest['labels'] = [];
  const labelIds = new Map<string, number>(); // decision key → assigned id
  const nextId = new Map<string, number>();
  const nextIndex = new Map<string, number>();
  const labelId = (column: SheetColumn, name: string): number | null => {
    const key = labelDecisionKey(column.id, name);
    const decision = decisions.labels[key];
    if (!decision?.add) return null;
    if (labelIds.has(key)) return labelIds.get(key)!;
    const all = labelsOf(column);
    const id = nextId.get(column.id) ?? nextLabelId(all);
    nextId.set(column.id, id + 1);
    labelIds.set(key, id);
    const index = nextIndex.get(column.id) ?? all.reduce((m, l) => Math.max(m, l.index ?? l.id), -1) + 1;
    nextIndex.set(column.id, index + 1);
    newLabels.push({
      column_id: column.id,
      id,
      label: name.trim(),
      ...(column.type === 'status' ? { color: decision.color ?? STATUS_COLORS[0], index } : {}),
    });
    return id;
  };
  const newTags = new Map<string, { name: string; color: GroupColor }>();

  // The subitems sheet's rows also carry their parent (B4).
  type Row = BulkEditRequest['rows'][number] & { parent_item_id?: string; parent_ref?: string };
  const rows = new Map<number, Row>();
  const rowOf = (c: DraftChange): Row => {
    let r = rows.get(c.row);
    if (!r) {
      r = c.itemId
        ? { item_id: c.itemId, cells: {} }
        : defaults.ref
          ? { ref: defaults.ref(c.row), cells: {} }
          : { cells: {} };
      rows.set(c.row, r);
    }
    return r;
  };
  let skipped = 0;
  for (const c of changes) {
    const p = parseSheetCell(c.column, c.text, env, c.row);
    let value: unknown;
    switch (p.kind) {
      case 'invalid':
        skipped++;
        continue;
      case 'clear':
        value = null;
        break;
      case 'value':
        value = p.value;
        break;
      case 'labels': {
        const ids = [...p.known, ...p.fresh.map((n) => labelId(c.column, n)).filter((x): x is number => x !== null)];
        if (!ids.length || (c.column.type === 'status' && ids.length !== 1)) {
          skipped++;
          continue;
        }
        value = c.column.type === 'status' ? { index: ids[0] } : { ids: [...new Set(ids)] };
        break;
      }
      case 'tags': {
        const freshKeys = new Set(p.fresh.map(norm));
        const names = p.names.filter((n) => !freshKeys.has(norm(n)) || decisions.tags[norm(n)]?.add);
        for (const n of p.fresh)
          if (decisions.tags[norm(n)]?.add)
            newTags.set(norm(n), { name: n, color: decisions.tags[norm(n)]!.color ?? tagColorFor(n) });
        if (!names.length) {
          skipped++;
          continue;
        }
        value = { tags: names };
        break;
      }
      case 'people':
        if (!p.found.length) {
          skipped++;
          continue;
        }
        value = { persons_and_teams: p.found };
        break;
    }
    const r = rowOf(c);
    if (c.column.mode === 'name') r.name = value as string;
    else if (c.column.mode === 'group') {
      if (value) r.group_id = value as string;
    } else if (c.column.mode === 'parent') {
      const ref = value as ParentRef;
      if ('item_id' in ref) r.parent_item_id = ref.item_id;
      else r.parent_ref = ref.ref;
    } else if (c.column.mode === 'secret') (r.secrets ??= {})[c.column.id] = value as string;
    else r.cells[c.column.id] = value;
  }
  for (const r of rows.values()) {
    if (r.item_id) continue;
    r.name ??= defaults.name;
    if (!r.group_id && defaults.groupId) r.group_id = defaults.groupId;
  }
  // An existing row whose only change was skipped sends nothing.
  const list = [...rows.values()].filter(
    (r) =>
      !r.item_id ||
      r.name !== undefined ||
      r.parent_item_id ||
      r.parent_ref ||
      Object.keys(r.cells).length ||
      Object.keys(r.secrets ?? {}).length,
  );
  return {
    request: { labels: newLabels, tags: [...newTags.values()], rows: list },
    skipped,
  };
};
