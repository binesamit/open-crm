// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AnyColumnTypeDef,
  columnTypes,
  computeProgress,
  labelColor,
  MIRROR_SUBITEMS,
  type MirrorEach,
  type MirrorLabel,
  type ProgressNode,
  type ProgressSettings,
  progressSettingsSchema,
  subitemsProgress,
  evaluateFormula,
  type FormulaInput,
  formatFormulaResult,
  formulaRefs,
  type LastUpdatedSettings,
  type Node,
  parseFormula,
  type Region,
  type CalendarConfig,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountCalendar } from '../../lib/account-calendar';
import { accountRegion } from '../accounts/region';
import { listTeamRows } from '../teams/teams.repo';
import { lastColumnChanges } from './column-changes.repo';
import { type ColumnRow, columnsByBoardIds, itemKeyFormats } from '../boards/boards.repo';
import {
  type CellValueRow,
  cellValuesByBoard,
  cellValuesByItemIds,
  childItemsOf,
  type ItemRow,
  itemsByIds,
  linksFromItems,
  memberNames,
} from './items.repo';

/** `names`: a relation / dependency cell's linked names, aligned with `value.item_ids` (a name may hold ", "). */
export type CellDto = { value: unknown; text: string | null; names?: string[] };
/** A stored cell's formula input is computed on first use (see `formulaOf`). */
const LAZY = Symbol('lazy');
/** `format`: how a number of this column is shown — a mirror of it (or of a mirror of it) shows its sums the same way. */
type Computed = CellDto & {
  formula: FormulaInput | typeof LAZY;
  format?: (n: number) => string;
  /** Hidden from the actor, or derived from a column that is (05 §6.1): a formula / mirror over it is hidden too. */
  hidden?: true;
};
const HIDDEN: Computed = { value: null, text: null, formula: null, hidden: true };

const MAX_DEPTH = 5; // mirror → formula → mirror … chains (03 §2.17: two mirror levels; formulas ≤5)
const PREFETCH_LEVELS = 3;
/** How deep a recursive progress column follows sub-subitems (the hierarchy limit is far lower). */
const MAX_PROGRESS_DEPTH = 10;

const AGGREGATES: Record<string, (xs: number[]) => number | null> = {
  sum: (xs) => xs.reduce((s, x) => s + x, 0),
  avg: (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null),
  median: (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  },
  min: (xs) => (xs.length ? Math.min(...xs) : null),
  max: (xs) => (xs.length ? Math.max(...xs) : null),
  count: (xs) => xs.length,
};

/**
 * Computes relation / mirror / formula / meta values on read (03 §2.16–2.22).
 * prefetch() loads items, cells, links and columns in batches (following links a few levels deep);
 * value() is then synchronous and memoised. Items the actor cannot see — on a board they cannot read, or hidden
 * by the board's `view_items` (05 §6) — are invisible to it, so a mirror never leaks their values.
 */
export class Calculator {
  private items = new Map<string, ItemRow>();
  private cells = new Map<string, Map<string, CellValueRow>>();
  private links = new Map<string, string[]>(); // `${columnId}:${fromItemId}` → to item ids
  private linkedFrom = new Map<string, string[]>(); // fromItemId → all to item ids (any relation column)
  private linkMeta = new Map<string, Record<string, unknown>>(); // `${columnId}:${from}:${to}` → dependency kind / lag
  /** r23ui: item id → watched column id ('' = the name) → its last change (see `loadColumnChanges`). */
  private changes = new Map<string, Map<string, { at: Date; by: string | null }>>();
  private children = new Map<string, string[]>(); // parent item id → subitem ids, in order (D14)
  private columns = new Map<string, ColumnRow[]>(); // boardId → columns
  private keyFormats = new Map<string, { prefix: string; padding: number }>();
  private names = new Map<string, string>();
  private formulas = new Map<string, Node | null>();
  private formulaKeys = new Map<string, string[]>(); // formula column id → the column keys it reads
  private byKey = new Map<string, Map<string, ColumnRow>>(); // boardId → columns by key
  private memo = new Map<string, Map<string, Computed>>(); // column id → item id → value
  /** Items whose cells, links and children are loaded (an id may be absent from `items`: deleted / foreign). */
  private loaded = new Set<string>();

  /** Items the actor may see; set by `authorize()` after prefetching. */
  private readable: Set<string> | null = null;
  /** The account's weekend and calendar (WORKDAYS / ADD_WORKDAYS in formulas); read on prefetch. */
  private work: { weekend: Region['weekend']; calendar: CalendarConfig } | null = null;
  /**
   * Columns hidden from the actor (05 §6.1 `view`), on any board the calculator reads: they read as empty, so a
   * formula or a mirror over one never shows its values (audit 2026-10-10 #2). Set by `hideColumns()`.
   */
  private hidden = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly accountId: string,
    /** The reader's region (A3): dates in DTO texts follow it; without it, the stored (canonical) text. */
    private readonly region?: Region,
    /**
     * The account's timezone: TODAY() in formulas is the date there (not the reader's, not UTC). Read from the
     * account settings on the first prefetch when not given.
     */
    private timeZone?: string,
  ) {}

  /**
   * Restricts linked items and subitems to those the actor may see (once everything is prefetched). `trusted`:
   * the items asked for, which the caller already checked; `resolve` decides for the rest.
   */
  async authorize(trusted: string[], resolve: (items: ItemRow[]) => Promise<Set<string>>) {
    const ok = new Set(trusted.filter((id) => this.items.has(id)));
    for (const id of await resolve([...this.items.values()].filter((i) => !ok.has(i.id)))) ok.add(id);
    this.readable = ok;
  }

  /**
   * Hides these columns from every value read from now on (05 §6.1: a formula or a mirror derived from a column
   * the actor may not see shows nothing to them). `restricted(boardId, columns)` returns the ids to hide on a board;
   * it is asked for every board whose columns were loaded.
   */
  async hideColumns(restricted: (boardId: string, columns: ColumnRow[]) => Promise<Iterable<string>>) {
    for (const [boardId, columns] of this.columns)
      for (const id of await restricted(boardId, columns)) this.hidden.add(id);
    this.memo.clear();
  }

  private canRead(item: ItemRow) {
    return this.readable?.has(item.id) ?? false;
  }

  /**
   * `known`: rows the caller already loaded (a board's items), so they are not read again — only their cells,
   * links and children are (perf review: a 30k-item board read its items twice). `boardId`: `itemIds` are (about)
   * all of this board's items — its cells are read by board, not by 30k ids.
   */
  async prefetch(itemIds: string[], levels = PREFETCH_LEVELS, known?: ItemRow[], boardId?: string): Promise<void> {
    if (!this.work) {
      const [region, calendar] = await Promise.all([
        accountRegion(this.db, this.accountId),
        accountCalendar(this.db, this.accountId),
      ]);
      this.timeZone ??= region.timezone;
      this.work = { weekend: region.weekend, calendar };
    }
    const missing = [...new Set(itemIds)].filter((id) => !this.loaded.has(id));
    if (missing.length) {
      const given = new Map((known ?? []).map((r) => [r.id, r]));
      const [fetched, cellRows, linkRows, childRows] = await Promise.all([
        itemsByIds(
          this.db,
          this.accountId,
          missing.filter((id) => !given.has(id)),
        ),
        boardId
          ? cellValuesByBoard(this.db, boardId).then((rows) => {
              const want = new Set(missing);
              return rows.filter((c) => want.has(c.itemId));
            })
          : cellValuesByItemIds(this.db, missing),
        linksFromItems(this.db, missing),
        childItemsOf(this.db, missing),
      ]);
      const rows = [...missing.flatMap((id) => given.get(id) ?? []), ...fetched];
      for (const id of missing) this.loaded.add(id);
      for (const r of rows) this.items.set(r.id, r);
      for (const id of missing) this.children.set(id, []);
      for (const c of childRows) this.children.get(c.parentItemId!)?.push(c.id);
      for (const c of cellRows) {
        const m = this.cells.get(c.itemId) ?? new Map<string, CellValueRow>();
        m.set(c.columnId, c);
        this.cells.set(c.itemId, m);
      }
      for (const l of linkRows) {
        const k = `${l.columnId}:${l.fromItemId}`;
        if (l.meta && Object.keys(l.meta).length) this.linkMeta.set(`${k}:${l.toItemId}`, l.meta);
        const list = this.links.get(k);
        if (list) list.push(l.toItemId);
        else this.links.set(k, [l.toItemId]);
        const from = this.linkedFrom.get(l.fromItemId);
        if (from) from.push(l.toItemId);
        else this.linkedFrom.set(l.fromItemId, [l.toItemId]);
      }
      const newBoards = [...new Set(rows.map((r) => r.boardId))].filter((b) => !this.columns.has(b));
      const [cols, fmts] = await Promise.all([
        columnsByBoardIds(this.db, newBoards),
        itemKeyFormats(this.db, newBoards),
      ]);
      for (const b of newBoards) this.columns.set(b, []);
      for (const c of cols) this.columns.get(c.boardId)!.push(c);
      for (const f of fmts) this.keyFormats.set(f.boardId, { prefix: f.prefix, padding: f.padding });

      const changedBy = await this.loadColumnChanges(rows, missing, boardId);

      const people = new Set<string>(changedBy);
      // Creators and last editors too: the "created" / "last updated" columns show who (03 §2.21–2.22).
      for (const r of rows) {
        if (r.createdBy) people.add(r.createdBy);
        if (r.lastCellChangeBy) people.add(r.lastCellChangeBy);
      }
      for (const c of cellRows) {
        for (const p of (c.value as { persons_and_teams?: { id: string }[] }).persons_and_teams ?? []) people.add(p.id);
      }
      const unknown = [...people].filter((id) => !this.names.has(id));
      if (unknown.length) {
        for (const [id, n] of await memberNames(this.db, this.accountId, unknown)) this.names.set(id, n);
        // Ids that are not members are teams.
        if (unknown.some((id) => !this.names.has(id))) {
          for (const t of await listTeamRows(this.db, this.accountId)) this.names.set(t.id, t.name);
        }
      }
    }
    if (levels > 0) {
      const targets = itemIds.flatMap((id) => [...(this.linkedFrom.get(id) ?? []), ...(this.children.get(id) ?? [])]);
      if (targets.length) await this.prefetch(targets, levels - 1);
    }
  }

  /**
   * r23ui: when a board of `rows` has a "last updated" column that watches chosen columns, the last change of each
   * watched (item, column) — see `lastColumnChanges`. Returns who made them (their names are loaded with the rest).
   */
  private async loadColumnChanges(rows: ItemRow[], missing: string[], boardId?: string): Promise<string[]> {
    const boards = new Set<string>();
    const columnIds = new Set<string>();
    let withName = false;
    for (const b of new Set(rows.map((r) => r.boardId))) {
      const cols = this.columnsOf(b);
      for (const c of cols) {
        if (c.type !== 'last_updated') continue;
        const keys = (c.settings as LastUpdatedSettings | null)?.columns ?? [];
        for (const key of keys) {
          const watched = cols.find((x) => x.key === key);
          if (!watched) continue;
          boards.add(b);
          if (watched.type === 'name') withName = true;
          else columnIds.add(watched.id);
        }
      }
    }
    if (!boards.size) return [];
    const found = await lastColumnChanges(this.db, this.accountId, {
      boardIds: [...boards],
      columnIds: [...columnIds],
      withName,
      // A whole-board load reads the board's range; otherwise only the items asked for.
      ...(boardId && boards.size === 1 && boards.has(boardId) ? {} : { itemIds: missing }),
    });
    const by = new Set<string>();
    for (const c of found) {
      const key = c.columnId ?? '';
      const m = this.changes.get(c.itemId) ?? new Map<string, { at: Date; by: string | null }>();
      const hit = m.get(key);
      if (!hit || c.at > hit.at) m.set(key, { at: c.at, by: c.by });
      this.changes.set(c.itemId, m);
      if (c.by) by.add(c.by);
    }
    return [...by];
  }

  /** The last change of a column (by key) on an item, for a "last updated" column of chosen columns (r23ui). */
  private columnChange(item: ItemRow, key: string): { at: string; by: string | null } | undefined {
    const column = this.columnsOf(item.boardId).find((c) => c.key === key);
    if (!column) return undefined;
    const mine = this.changes.get(item.id);
    if (column.type === 'name') {
      // The name is set when the item is made; a rename is an `item.renamed` event.
      const renamed = mine?.get('');
      return renamed && renamed.at > item.createdAt
        ? { at: renamed.at.toISOString(), by: renamed.by }
        : { at: item.createdAt.toISOString(), by: item.createdBy };
    }
    const hit = mine?.get(column.id);
    return hit ? { at: hit.at.toISOString(), by: hit.by } : undefined;
  }

  item(id: string) {
    return this.items.get(id);
  }

  columnsOf(boardId: string) {
    return this.columns.get(boardId) ?? [];
  }

  /**
   * Prod (the `set_computed` action): a cell as a formula reads it, by column key (`name` = the item's
   * name). `missing` = no such item / column; `hidden` = the actor may not read the column (05 §6.1).
   */
  formulaRead(itemId: string, key: string): { value: FormulaInput } | 'missing' | 'hidden' {
    const item = this.items.get(itemId);
    if (!item || !this.canRead(item)) return 'missing';
    const column = this.columnsOf(item.boardId).find((c) => c.key === key);
    if (!column) return key === 'name' ? { value: item.name } : 'missing';
    if (this.hidden.has(column.id) || this.value(itemId, column).hidden) return 'hidden';
    return { value: this.formulaOf(itemId, column, 0) };
  }

  /** The items an item links to in a relation column (by key), those the actor may see; null = not a relation. */
  linkedIds(itemId: string, key: string): string[] | null {
    const item = this.items.get(itemId);
    const column = item && this.columnsOf(item.boardId).find((c) => c.key === key);
    if (!column || column.type !== 'board_relation') return null;
    return this.linked(itemId, column).map((i) => i.id);
  }

  keyOf(item: ItemRow): string | null {
    const fmt = this.keyFormats.get(item.boardId);
    return fmt && item.keySeq != null ? `${fmt.prefix}${String(item.keySeq).padStart(fmt.padding, '0')}` : null;
  }

  /** Linked items for a relation cell, in order, restricted to those the actor can see. */
  private linked(itemId: string, relationColumn: ColumnRow): ItemRow[] {
    return (this.links.get(`${relationColumn.id}:${itemId}`) ?? [])
      .map((id) => this.items.get(id))
      .filter((i): i is ItemRow => !!i && this.canRead(i));
  }

  /** A dependency cell (M8 ד7): the linked ids plus their non-default kinds and lags (item_links.meta). */
  private dependencyValue(itemId: string, column: ColumnRow, linked: ItemRow[]) {
    const kind: Record<string, unknown> = {};
    const lag: Record<string, unknown> = {};
    for (const t of linked) {
      const m = this.linkMeta.get(`${column.id}:${itemId}:${t.id}`);
      if (m?.kind) kind[t.id] = m.kind;
      if (m?.lag_days) lag[t.id] = m.lag_days;
    }
    return {
      item_ids: linked.map((i) => i.id),
      ...(Object.keys(kind).length ? { kind } : {}),
      ...(Object.keys(lag).length ? { lag_days: lag } : {}),
    };
  }

  private ctx() {
    return {
      userName: (id: string) => this.names.get(id),
      itemName: (id: string) => this.items.get(id)?.name,
      region: this.region,
    };
  }

  /** A stored cell's text: dates are re-written in the reader's region (A3); the rest is the stored text. */
  private storedText(def: AnyColumnTypeDef | undefined, column: ColumnRow, cell: CellValueRow): string | null {
    if (!this.region || !def?.localizedText || cell.value === null || cell.value === undefined) return cell.textValue;
    try {
      return def.toText(cell.value, column.settings, this.ctx()) || null;
    } catch {
      return cell.textValue;
    }
  }

  /**
   * What a row shows for a cell (item DTOs). A plain stored cell is read straight from the loaded rows — no memo
   * entry, no Computed object (a 30k-item board has ~200k of them); computed columns go through `value`.
   */
  display(itemId: string, column: ColumnRow, def: AnyColumnTypeDef): CellDto | null {
    if (this.hidden.has(column.id)) return null;
    if (def.storage === 'cell' && !def.engine && !def.fromItem) {
      const cell = this.cells.get(itemId)?.get(column.id);
      return cell ? { value: cell.value, text: this.storedText(def, column, cell) } : null;
    }
    const v = this.value(itemId, column);
    if (v.value === null && v.text === null) return null;
    return v.names ? { value: v.value, text: v.text, names: v.names } : { value: v.value, text: v.text };
  }

  value(itemId: string, column: ColumnRow, depth = 0): Computed {
    let memo = this.memo.get(column.id);
    if (!memo) this.memo.set(column.id, (memo = new Map()));
    const hit = memo.get(itemId);
    if (hit) return hit;
    const empty: Computed = { value: null, text: null, formula: null };
    const item = this.items.get(itemId);
    const def = columnTypes.get(column.type);
    if (this.hidden.has(column.id)) return HIDDEN;
    if (!item || !def || depth > MAX_DEPTH) return empty;

    let out: Computed;
    if (def.fromItem) {
      const value = def.fromItem(
        {
          id: item.id,
          key: this.keyOf(item),
          createdAt: item.createdAt.toISOString(),
          createdBy: item.createdBy,
          lastChangeAt: (item.lastCellChangeAt ?? item.updatedAt).toISOString(),
          lastChangeBy: item.lastCellChangeBy,
          columnChange: (key) => this.columnChange(item, key),
        },
        column.settings ?? {},
      );
      out = value === null ? empty : this.wrap(def, column, value);
    } else if (def.storage === 'item') {
      out = { value: item.name, text: item.name, formula: item.name };
    } else if (def.engine === 'links') {
      const linked = this.linked(itemId, column);
      out = linked.length
        ? {
            value:
              column.type === 'dependency'
                ? this.dependencyValue(itemId, column, linked)
                : { item_ids: linked.map((i) => i.id) },
            text: linked.map((i) => i.name).join(', '),
            formula: linked.map((i) => i.name).join(', '),
            names: linked.map((i) => i.name),
          }
        : empty;
    } else if (def.engine === 'mirror') {
      out = this.mirror(item, column, depth);
    } else if (def.engine === 'formula') {
      out = this.formula(item, column, depth);
    } else if (def.engine === 'progress') {
      out = this.progress(item, column, def);
    } else {
      const cell = this.cells.get(itemId)?.get(column.id);
      out = cell ? { value: cell.value, text: this.storedText(def, column, cell), formula: LAZY } : empty;
    }
    memo.set(itemId, out);
    return out;
  }

  /**
   * The value a formula / mirror reads (03 §2.18). A stored cell's is computed on first use: a board load asks
   * every cell for value + text only (perf review: ~250k needless toFormula calls on a 30k-item board).
   */
  private formulaOf(itemId: string, column: ColumnRow, depth: number): FormulaInput {
    const v = this.value(itemId, column, depth);
    if (v.formula === LAZY) {
      const def = columnTypes.get(column.type)!;
      v.formula = this.toFormula(def, column, v.value);
    }
    return v.formula;
  }

  private toFormula(def: AnyColumnTypeDef, column: ColumnRow, value: unknown): FormulaInput {
    return def.toFormula
      ? def.toFormula(value, column.settings, this.ctx())
      : def.toText(value, column.settings, this.ctx()) || null;
  }

  private wrap(def: AnyColumnTypeDef, column: ColumnRow, value: unknown): Computed {
    return {
      value,
      text: def.toText(value, column.settings, this.ctx()) || null,
      formula: this.toFormula(def, column, value),
    };
  }

  /** Subitems of an item (D14), restricted to those the actor can see. */
  private subitems(itemId: string): ItemRow[] {
    return (this.children.get(itemId) ?? [])
      .map((id) => this.items.get(id))
      .filter((i): i is ItemRow => !!i && this.canRead(i));
  }

  private mirror(item: ItemRow, column: ColumnRow, depth: number): Computed {
    const s = column.settings as { relation_column_id?: string; source_column_id?: string; aggregate?: string };
    if (!s.source_column_id) return { value: null, text: null, formula: null };
    let targets: ItemRow[];
    if (s.relation_column_id === MIRROR_SUBITEMS) {
      targets = this.subitems(item.id);
    } else {
      const relation = this.columnsOf(item.boardId).find(
        (c) => c.key === s.relation_column_id && columnTypes.get(c.type)?.engine === 'links',
      );
      if (!relation) return { value: null, text: null, formula: null };
      targets = this.linked(item.id, relation);
    }
    let sourceColumn: ColumnRow | undefined;
    let sourceFormat: ((n: number) => string) | undefined;
    const present: { text: string; formula: FormulaInput }[] = [];
    // r15cols: a mirror of labels (status / dropdown, or a mirror of them) also carries them with colours and
    // counts — shown as chips or as the footer's distribution bar.
    const labels = new Map<string, MirrorLabel>();
    let labelSource = false;
    // a people / date source keeps its ids / dates too, so the mirror filters as that type does.
    const people = new Set<string>();
    const dates: { start: string; end: string }[] = [];
    // …and per linked item, for rules that need every linked item to match ("all").
    const each: MirrorEach[] = [];
    let facet = false;
    const countLabel = (label: string, color: string, count = 1) => {
      const hit = labels.get(`${label}\u0000${color}`);
      if (hit) hit.count += count;
      else labels.set(`${label}\u0000${color}`, { label, color, count });
    };
    for (const target of targets) {
      const source = this.columnsOf(target.boardId).find((c) => c.key === s.source_column_id);
      sourceColumn ??= source;
      if (!source) continue;
      const v = this.value(target.id, source, depth + 1);
      if (v.hidden) return HIDDEN;
      sourceFormat ??= v.format;
      const entry: MirrorEach = {};
      if (source.type === 'status' || source.type === 'dropdown') {
        labelSource = true;
        facet = true;
        const def = columnTypes.get(source.type);
        const all = (source.settings as { labels?: { id: number; label: string; color?: string }[] }).labels ?? [];
        const ids = v.value !== null && def?.labelIds ? def.labelIds(v.value) : [];
        for (const id of ids) {
          const l = all.find((x) => x.id === id);
          if (!l) continue;
          countLabel(l.label, labelColor(l));
          (entry.labels ??= []).push(l.label);
        }
      } else if (source.type === 'mirror') {
        const nested = v.value as {
          labels?: MirrorLabel[];
          people?: string[];
          dates?: { start: string; end: string }[];
        } | null;
        if (nested?.labels) {
          labelSource = true;
          facet = true;
          for (const l of nested.labels) countLabel(l.label, l.color, l.count);
          entry.labels = nested.labels.map((l) => l.label);
        }
        for (const p of nested?.people ?? []) people.add(p);
        if (nested?.dates) dates.push(...nested.dates);
        if (nested?.people || nested?.dates) facet = true;
        if (nested?.people) entry.people = nested.people;
        if (nested?.dates) entry.dates = nested.dates;
      } else {
        const def = columnTypes.get(source.type);
        if (def?.filterModel === 'people') {
          facet = true;
          for (const p of (v.value as { persons_and_teams?: { id: string }[] } | null)?.persons_and_teams ?? []) {
            people.add(p.id);
            (entry.people ??= []).push(p.id);
          }
        } else if (def?.filterModel === 'date' && def.toDate) {
          facet = true;
          const start = v.value === null ? null : def.toDate(v.value as never, source.settings as never);
          if (start) {
            const d = { start, end: def.toDateEnd?.(v.value as never, source.settings as never) ?? start };
            dates.push(d);
            entry.dates = [d];
          }
        }
      }
      each.push(entry);
      if (v.text !== null) present.push({ text: v.text, formula: this.formulaOf(target.id, source, depth + 1) });
    }
    if (!present.length) return { value: null, text: null, formula: null };
    const extra = {
      ...(people.size ? { people: [...people] } : {}),
      ...(dates.length ? { dates } : {}),
      ...(facet ? { each } : {}),
    };
    if (labelSource) {
      const display = present.map((v) => v.text).join(', ');
      return {
        value: { display_value: display, number: null, labels: [...labels.values()], each },
        text: display,
        formula: display,
      };
    }
    const numbers = present.map((v) => (typeof v.formula === 'number' ? v.formula : Number(v.text)));
    if (numbers.every((n) => Number.isFinite(n))) {
      const agg = AGGREGATES[s.aggregate ?? 'sum'] ?? AGGREGATES.sum!;
      const number = agg(numbers);
      // Shown the way the source column shows numbers (time → 01:00:13, currency, a formula's ₪ …) — through a
      // mirror of a mirror too; a count stays a count.
      const sourceDef = sourceColumn ? columnTypes.get(sourceColumn.type) : undefined;
      const format =
        s.aggregate === 'count'
          ? undefined
          : sourceDef?.formatNumber
            ? (n: number) => sourceDef.formatNumber!(n, sourceColumn!.settings as never)
            : sourceFormat;
      const display = number === null ? '' : format ? format(number) : formatFormulaResult(number, 2);
      return { value: { display_value: display, number }, text: display || null, formula: number, format };
    }
    const display = present.map((v) => v.text).join(', ');
    return { value: { display_value: display, number: null, ...extra }, text: display, formula: display };
  }

  /**
   * A status cell of an item is on a "done" label: one of `doneLabels`, or — when none are given — a label marked
   * done in the column.
   */
  private isDone(itemId: string, column: ColumnRow | undefined, doneLabels: number[] = []): boolean {
    if (!column) return false;
    const index = (this.cells.get(itemId)?.get(column.id)?.value as { index?: number } | null)?.index;
    if (index === undefined) return false;
    if (doneLabels.length) return doneLabels.includes(index);
    const labels = (column.settings as { labels?: { id: number; is_done?: boolean }[] }).labels ?? [];
    return labels.some((l) => l.id === index && !!l.is_done);
  }

  /**
   * Progress (03 §3.4, M8 ד11, r15cols): weighted done status columns of the item and/or its subitems' done share
   * — by chosen done labels, weighted by a numbers column, and with sub-subitems counted when recursive.
   */
  private progress(item: ItemRow, column: ColumnRow, def: AnyColumnTypeDef): Computed {
    const parsed = progressSettingsSchema.safeParse(column.settings ?? {});
    if (!parsed.success) return { value: null, text: null, formula: null };
    const s: ProgressSettings = parsed.data;
    const status = this.columnsOf(item.boardId).filter((c) => c.type === 'status');
    const byKey = new Map(status.map((c) => [c.key, c]));
    let subitems: number | null = null;
    const sub = s.subitems;
    if (sub && s.source !== 'columns') {
      const columnsOn = new Map<string, { status?: ColumnRow; weight?: ColumnRow }>();
      const columnsFor = (boardId: string) => {
        let hit = columnsOn.get(boardId);
        if (!hit) {
          const cols = this.columnsOf(boardId);
          hit = {
            status: cols.find((c) => c.key === sub.column_id && c.type === 'status'),
            weight: sub.weight_column_id ? cols.find((c) => c.key === sub.weight_column_id) : undefined,
          };
          columnsOn.set(boardId, hit);
        }
        return hit;
      };
      const node = (x: ItemRow, depth: number): ProgressNode => {
        const cols = columnsFor(x.boardId);
        let weight: number | null = null;
        if (cols.weight) {
          const f = this.formulaOf(x.id, cols.weight, 1);
          weight = typeof f === 'number' ? f : null;
        }
        return {
          done: cols.status ? this.isDone(x.id, cols.status, sub.done_labels) : null,
          weight,
          children:
            sub.recursive && depth < MAX_PROGRESS_DEPTH ? this.subitems(x.id).map((c) => node(c, depth + 1)) : [],
        };
      };
      subitems = subitemsProgress(
        this.subitems(item.id).map((x) => node(x, 1)),
        sub.recursive,
      );
    }
    const percent = computeProgress(s, {
      statusColumns: status.map((c) => c.key),
      isDone: (key, labels) => this.isDone(item.id, byKey.get(key), labels),
      subitems,
    });
    return percent === null ? { value: null, text: null, formula: null } : this.wrap(def, column, { percent });
  }

  private formula(item: ItemRow, column: ColumnRow, depth: number): Computed {
    const s = column.settings as { formula?: string };
    let tree = this.formulas.get(column.id);
    if (tree === undefined) {
      try {
        tree = s.formula ? parseFormula(s.formula) : null;
      } catch {
        tree = null;
      }
      this.formulas.set(column.id, tree);
    }
    if (!tree) return { value: null, text: null, formula: null };
    let byKey = this.byKey.get(item.boardId);
    if (!byKey) this.byKey.set(item.boardId, (byKey = new Map(this.columnsOf(item.boardId).map((c) => [c.key, c]))));
    let refs = this.formulaKeys.get(column.id);
    if (!refs) this.formulaKeys.set(column.id, (refs = [...formulaRefs(tree)]));
    const resolved = new Map<string, FormulaInput>();
    for (const key of refs) {
      const col = byKey.get(key);
      if (col && col.id !== column.id && this.value(item.id, col, depth + 1).hidden) return HIDDEN;
      resolved.set(key, col && col.id !== column.id ? this.formulaOf(item.id, col, depth + 1) : null);
    }
    const result = evaluateFormula(tree, {
      ref: (k) => resolved.get(k) ?? null,
      timeZone: this.timeZone,
      weekend: this.work?.weekend,
      calendar: this.work?.calendar,
    });
    // A number in the column's format (unit, decimals, 1,000s — 03 §2.18); other results as before.
    const def = columnTypes.get(column.type)!;
    const format = def.formatNumber ? (n: number) => def.formatNumber!(n, column.settings as never) : undefined;
    const text = typeof result === 'number' && format ? format(result) : formatFormulaResult(result);
    return { value: { result }, text: text || null, formula: result, format };
  }
}
