// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  columnTypes,
  isComputedName,
  NAME_RECOMPUTE_SYNC_MAX,
  NAME_RECOMPUTE_WINDOW,
  type NameRecompute,
  type NameSource,
  nameSourceOfColumns,
  nameSourceOfSettings,
  nameSourceProblem,
  nameSourceRefs,
  renderNameSource,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { enqueueJob } from '../../lib/jobs';
import { accountRegion } from '../accounts/region';
import { type ActivityEvent, recordEvents } from '../activity/activity.repo';
import { type ColumnRow, columnsByBoardIds, findBoard, findColumnById } from '../boards/boards.repo';
import { Calculator } from './computed';
import { type ItemRow, itemsByIds } from './items.repo';
import {
  announceNameRecompute,
  boardItemIdsPage,
  computedNameColumns,
  countBoardLiveItems,
  linkersOf,
  setCellText,
  setEventAfterNames,
  setItemNames,
  setNameRecomputeState,
} from './names.repo';
import { itemsAnyState, linkTargetsOf } from './relations.repo';
import { refreshRelationCells } from './relations.service';

/**
 * Computed item names ("way 2"). A board's name column may say `settings.name_source` = column /
 * template: the server then writes `items.name` itself, from the columns' display text in the account's region,
 * whenever something it reads changes — a cell of the item, the name or cells of an item it links to (any board,
 * a few levels), a subitem (mirrors / progress over subitems), or the setting itself (a recompute of the board,
 * in the background on big boards). The id never changes; everything that reads `items.name` stays as it is.
 */

export type NameWho = { accountId: string; actorId: string | null; requestId?: string | null };

/** How many link hops a change follows to other items' computed names (mirror of a mirror …). */
const MAX_CASCADE = 3;
/** Column engines whose text depends on other items (a name built on them follows changes elsewhere). */
const REMOTE_ENGINES = new Set(['links', 'mirror', 'formula', 'progress']);

type BoardSource = { source: NameSource; columnId: string; remote: boolean };
type Sources = Map<string, BoardSource>;

/** Tunables (tests lower them to exercise the background path). */
export const nameRecomputeLimits = { syncMax: NAME_RECOMPUTE_SYNC_MAX, window: NAME_RECOMPUTE_WINDOW };

/** The account's boards whose names are computed, with whether their source reads other items. */
const loadSources = async (db: Db, accountId: string): Promise<Sources> => {
  const rows = await computedNameColumns(db, accountId);
  const out: Sources = new Map();
  if (!rows.length) return out;
  const cols = await columnsByBoardIds(
    db,
    rows.map((r) => r.boardId),
  );
  for (const r of rows) {
    const source = nameSourceOfSettings(r.settings);
    if (!isComputedName(source)) continue;
    const boardCols = cols.filter((c) => c.boardId === r.boardId);
    const remote = nameSourceRefs(source).some((k) => {
      const engine = columnTypes.get(boardCols.find((c) => c.key === k)?.type ?? '')?.engine;
      return !!engine && REMOTE_ENGINES.has(engine);
    });
    out.set(r.boardId, { source, columnId: r.columnId, remote });
  }
  return out;
};

/** Names of these items by their boards' sources (account region, every linked item readable: names are shared). */
const computeNames = async (db: Db, accountId: string, rows: ItemRow[], sources: Sources) => {
  const out = new Map<string, string>();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const calc = new Calculator(db, accountId, await accountRegion(db, accountId));
  await calc.prefetch(ids, undefined, rows);
  await calc.authorize(ids, async (items) => new Set(items.map((i) => i.id)));
  // A name is one value everyone who opens the board reads: no column restricted to `view` goes into it — nor a
  // formula or a mirror over one, on any board (05 §6.1; audit 2026-10-10 follow-up).
  await calc.hideColumns(async (_boardId, columns) => columns.filter((c) => c.restrictedView).map((c) => c.id));
  const byKey = new Map<string, Map<string, ColumnRow>>();
  for (const item of rows) {
    const src = sources.get(item.boardId);
    if (!src) continue;
    let keys = byKey.get(item.boardId);
    if (!keys) byKey.set(item.boardId, (keys = new Map(calc.columnsOf(item.boardId).map((c) => [c.key, c]))));
    const name = renderNameSource(src.source, (key) => {
      const col = keys.get(key);
      const def = col && columnTypes.get(col.type);
      if (!col || !def || def.storage === 'item') return null;
      return calc.display(item.id, col, def)?.text ?? null;
    });
    if (name !== null) out.set(item.id, name);
  }
  return out;
};

type ApplyOpts = {
  /** Record `item.renamed` (meta.computed) for changed names; false = a silent recompute (setting change). */
  events?: boolean;
  /** Items created in this transaction: no rename event — their `item.created` event (if given) gets the name. */
  silent?: Map<string, string | null>;
};

/** Computes and stores names of these rows; returns the ids whose name changed. */
const applyNames = async (tx: Db, who: NameWho, rows: ItemRow[], sources: Sources, opts: ApplyOpts) => {
  const names = await computeNames(tx, who.accountId, rows, sources);
  const changed = rows.filter((r) => names.has(r.id) && names.get(r.id) !== r.name);
  if (!changed.length) return [];
  await setItemNames(
    tx,
    changed.map((r) => ({ id: r.id, name: names.get(r.id)! })),
  );
  const patch: { eventId: string; name: string }[] = [];
  const events: ActivityEvent[] = [];
  for (const r of changed) {
    const name = names.get(r.id)!;
    if (opts.silent?.has(r.id)) {
      const eventId = opts.silent.get(r.id);
      if (eventId) patch.push({ eventId, name });
    } else if (opts.events !== false) {
      events.push({
        accountId: who.accountId,
        type: 'item.renamed',
        actorId: who.actorId,
        requestId: who.requestId ?? null,
        boardId: r.boardId,
        itemId: r.id,
        batchId: null,
        before: { name: r.name },
        after: { name },
        meta: { computed: true, name_source: sources.get(r.boardId)?.source.mode },
      });
    }
  }
  await setEventAfterNames(tx, patch);
  if (events.length) await recordEvents(tx, events);
  return changed.map((r) => r.id);
};

/**
 * Link cells that show these (renamed) items: their stored text (search, sort, filters, exports) follows the new
 * names. board_relation cells go through `refreshRelationCells`; a dependency cell keeps its value (kinds, lags)
 * and only gets its text rewritten. Fixes "a rename leaves connect-boards cells with the old name".
 */
export const refreshLinkTexts = async (tx: Db, who: NameWho, renamedIds: string[]) => {
  const links = await linkersOf(tx, renamedIds);
  if (!links.length) return;
  const byColumn = new Map<string, Set<string>>();
  for (const l of links) byColumn.set(l.columnId, (byColumn.get(l.columnId) ?? new Set()).add(l.from));
  for (const [columnId, from] of byColumn) {
    const column = await findColumnById(tx, columnId);
    if (!column) continue;
    const fromIds = [...from];
    if (column.type === 'board_relation') {
      await refreshRelationCells(tx, {
        accountId: who.accountId,
        column,
        itemIds: fromIds,
        actorId: who.actorId,
      });
      continue;
    }
    if (columnTypes.get(column.type)?.engine !== 'links') continue;
    const targets = await linkTargetsOf(tx, column.id, fromIds);
    const rows = await itemsAnyState(tx, who.accountId, [...new Set([...targets.values()].flat().map((t) => t.to))]);
    const names = new Map(rows.filter((r) => !r.deletedAt).map((r) => [r.id, r.name]));
    for (const id of fromIds) {
      const text = (targets.get(id) ?? []).flatMap((t) => (names.has(t.to) ? [names.get(t.to)!] : [])).join(', ');
      await setCellText(tx, id, column.id, text);
    }
  }
};

/**
 * Something about these items changed (a cell, a link, their name): recompute their computed names, refresh the
 * link cells that show renamed ones, and follow the items that read them (items linking to them, parents) — a few
 * levels, across boards. A no-op (one cheap query) in an account without computed names. Returns renamed ids.
 */
export const itemsChanged = async (tx: Db, who: NameWho, ids: string[], opts: ApplyOpts = {}) => {
  if (!ids.length) return [];
  const sources = await loadSources(tx, who.accountId);
  if (!sources.size) return [];
  return cascade(tx, who, ids, sources, opts);
};

const cascade = async (tx: Db, who: NameWho, ids: string[], sources: Sources, opts: ApplyOpts) => {
  const remote = [...sources.values()].some((s) => s.remote);
  const visited = new Set<string>();
  const renamedAll: string[] = [];
  let frontier = [...new Set(ids)];
  for (let depth = 0; frontier.length && depth <= MAX_CASCADE; depth++) {
    for (const id of frontier) visited.add(id);
    const rows = await itemsByIds(tx, who.accountId, frontier);
    const computed = rows.filter((r) => sources.has(r.boardId));
    const renamed = computed.length
      ? await applyNames(tx, who, computed, sources, depth === 0 ? opts : { events: opts.events })
      : [];
    if (renamed.length) {
      renamedAll.push(...renamed);
      await refreshLinkTexts(tx, who, renamed);
    }
    if (!remote) break;
    const linkers = await linkersOf(tx, frontier);
    const next = new Set<string>([...linkers.map((l) => l.from), ...rows.flatMap((r) => r.parentItemId ?? [])]);
    frontier = [...next].filter((id) => !visited.has(id));
  }
  return renamedAll;
};

// ---- deferring inside one transaction (create / update with several cells: one recompute at the end) ----

const pending = new WeakMap<object, Set<string>>();

/** `writeCell` & co: recompute now, or note the item when the transaction collects changes. */
export const noteItemsChanged = async (tx: Db, who: NameWho, ids: string[]) => {
  const p = pending.get(tx);
  if (p) {
    for (const id of ids) p.add(id);
    return;
  }
  await itemsChanged(tx, who, ids);
};

/** Runs `fn` collecting the items its writes changed (an outer collector keeps collecting instead). */
export const collectItemChanges = async <T>(tx: Db, fn: () => Promise<T>): Promise<[T, string[]]> => {
  if (pending.has(tx)) return [await fn(), []];
  const set = new Set<string>();
  pending.set(tx, set);
  try {
    return [await fn(), [...set]];
  } finally {
    pending.delete(tx);
  }
};

/** A rename of a free-named item: link cells showing it, and computed names reading it, follow. */
export const afterItemsRenamed = async (tx: Db, who: NameWho, ids: string[]) => {
  if (!ids.length) return;
  await refreshLinkTexts(tx, who, ids);
  await noteItemsChanged(tx, who, ids);
};

// ---- the rules services apply ----

/** The name a new item starts with: the typed one (free boards — required), else the empty text until computed. */
export const initialItemName = (columns: { type: string; settings: unknown }[], given: string | undefined) => {
  const source = nameSourceOfColumns(columns);
  if (isComputedName(source)) return { name: (source.empty_text ?? '').trim().slice(0, 255), computed: true };
  if (!given?.trim()) throw new AppError('validation_failed', 'name_required', { field: 'name' });
  return { name: given, computed: false };
};

/** 409 when the board computes names (a no-op rename to the current name is fine). */
export const assertNameEditable = (
  columns: { type: string; settings: unknown }[],
  current: string,
  next: string | undefined,
) => {
  if (next === undefined || next === current) return;
  const source = nameSourceOfColumns(columns);
  if (isComputedName(source))
    throw new AppError('item_name_computed', 'This board computes item names from columns — change those columns', {
      name_source: source.mode,
      refs: nameSourceRefs(source),
    });
};

// ---- recomputing a whole board (the setting changed) ----

export const NAME_RECOMPUTE_TASK = 'board.names_recompute';

const recomputeStateOf = (settings: unknown): NameRecompute | null =>
  ((settings as { name_recompute?: NameRecompute } | null)?.name_recompute ?? null) as NameRecompute | null;
export { recomputeStateOf as nameRecomputeState };

/**
 * Recomputes every live item of the board (after its name source changed): in the request up to
 * `syncMax` items, else as a background job in windows (progress on the board's live channel and in
 * `boards.settings.name_recompute`). Without a job runner (tests, worker-less dev) the windows run here.
 */
export const startNameRecompute = async (db: Db, who: NameWho, boardId: string): Promise<NameRecompute> => {
  const total = await countBoardLiveItems(db, boardId);
  const background = total > nameRecomputeLimits.syncMax;
  const state: NameRecompute = {
    status: 'running',
    mode: background ? 'background' : 'sync',
    total,
    done: 0,
    renamed: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
  };
  await setNameRecomputeState(db, boardId, state);
  const payload = { board_id: boardId, account_id: who.accountId, actor_id: who.actorId };
  if (background && (await enqueueJob(db, NAME_RECOMPUTE_TASK, payload, { maxAttempts: 1 }))) return state;
  return runNameRecompute(db, { ...who, boardId }, state);
};

export const runNameRecompute = async (
  db: Db,
  p: NameWho & { boardId: string },
  initial?: NameRecompute,
): Promise<NameRecompute> => {
  // A job picks up the state its request wrote (started_at, total).
  const queued = initial ? null : recomputeStateOf((await findBoard(db, p.accountId, p.boardId))?.settings);
  const state: NameRecompute = initial ??
    (queued?.status === 'running' ? { ...queued, mode: 'background' } : null) ?? {
      status: 'running',
      mode: 'background',
      total: await countBoardLiveItems(db, p.boardId),
      done: 0,
      renamed: 0,
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
    };
  const sync = state.mode === 'sync';
  const sources = await loadSources(db, p.accountId);
  const src = sources.get(p.boardId);
  const announce = async () => {
    await setNameRecomputeState(db, p.boardId, state);
    if (src) await announceNameRecompute(db, { accountId: p.accountId, boardId: p.boardId, columnId: src.columnId });
  };
  try {
    if (src) {
      const window = async (tx: Db, ids: string[]) => {
        const rows = await itemsByIds(tx, p.accountId, ids);
        const renamed = await applyNames(tx, p, rows, sources, { events: false });
        if (renamed.length) {
          await refreshLinkTexts(tx, p, renamed);
          // Computed names elsewhere that read these items (cross-board).
          if ([...sources.values()].some((s) => s.remote)) {
            const linkers = await linkersOf(tx, renamed);
            await cascade(
              tx,
              p,
              [...new Set(linkers.map((l) => l.from))].filter((id) => !ids.includes(id)),
              sources,
              {},
            );
          }
        }
        return renamed.length;
      };
      const loop = async (tx: Db | null) => {
        for (let after: string | null = null; ;) {
          const ids = await boardItemIdsPage(tx ?? db, p.boardId, after, nameRecomputeLimits.window);
          if (!ids.length) break;
          state.renamed += tx ? await window(tx, ids) : await db.transaction((t) => window(t, ids));
          state.done += ids.length;
          after = ids.at(-1)!;
          if (!tx) await announce();
          if (ids.length < nameRecomputeLimits.window) break;
        }
      };
      if (sync) await db.transaction((tx) => loop(tx));
      else await loop(null);
    }
    state.status = 'done';
    state.finished_at = new Date().toISOString();
    await announce();
  } catch (err) {
    state.status = 'failed';
    state.error = err instanceof Error ? err.message.slice(0, 500) : 'failed';
    state.finished_at = new Date().toISOString();
    await announce();
    if (sync) throw err;
  }
  return state;
};

// ---- the setting ----

/** The fields whose change needs a recompute (not `warn_duplicates`). */
const recomputeKey = (s: NameSource) =>
  JSON.stringify(isComputedName(s) ? [s.mode, s.column_id ?? null, s.template ?? null, s.empty_text ?? ''] : 'free');

/**
 * A name column's new settings (`PATCH /boards/:id/columns/:name` or `PUT /boards/:id/name-source`): the source
 * must read existing columns that have text (422 name_source_invalid). Returns whether names must be recomputed.
 */
export const checkNameSourceSettings = (
  before: unknown,
  after: Record<string, unknown>,
  columns: { key: string; type: string }[],
) => {
  const raw = after.name_source;
  const next = nameSourceOfSettings(after);
  if (raw !== undefined && raw !== null && !isComputedName(next) && (raw as { mode?: string }).mode !== 'free')
    throw new AppError('name_source_invalid', 'Invalid name source', { reason: 'invalid' });
  const problem = nameSourceProblem(
    next,
    columns.map((c) => ({ id: c.key, type: c.type })),
  );
  if (problem) throw new AppError('name_source_invalid', `Invalid name source: ${problem.reason}`, problem);
  return isComputedName(next) && recomputeKey(next) !== recomputeKey(nameSourceOfSettings(before));
};

/** 409 when a column the board's name reads is about to go (delete it after changing the name source). */
export const assertNotNameSource = (columns: { type: string; settings: unknown }[], key: string) => {
  const source = nameSourceOfColumns(columns);
  if (nameSourceRefs(source).includes(key))
    throw new AppError('column_in_name_source', 'The item name is built from this column', {
      column_id: key,
      name_source: source.mode,
    });
};

/** A column of the board changed wholesale (a type conversion): recompute when the name reads it. */
export const recomputeNamesReading = async (db: Db, who: NameWho, boardId: string, columnId: string) => {
  const columns = await columnsByBoardIds(db, [boardId]);
  const source = nameSourceOfColumns(columns);
  const column = columns.find((c) => c.id === columnId);
  if (column && nameSourceRefs(source).includes(column.key)) await startNameRecompute(db, who, boardId);
};

/**
 * A column of `boardId` became hidden (`view`) or visible again: computed names that may read it — the board's own,
 * and every board whose name reads other items (links, mirrors, formulas) — are recomputed.
 */
export const recomputeNamesAfterRestriction = async (db: Db, who: NameWho, boardId: string) => {
  for (const [id, src] of await loadSources(db, who.accountId))
    if (id === boardId || src.remote) await startNameRecompute(db, who, id);
};

/** The background recompute (api job runner), with the same services as the request. */
export const nameTasks = (deps: { db: Db }) => ({
  [NAME_RECOMPUTE_TASK]: async (payload: unknown) => {
    const p = (payload ?? {}) as { board_id?: unknown; account_id?: unknown; actor_id?: unknown };
    if (typeof p.board_id !== 'string' || typeof p.account_id !== 'string') return;
    await runNameRecompute(deps.db, {
      boardId: p.board_id,
      accountId: p.account_id,
      actorId: typeof p.actor_id === 'string' ? p.actor_id : null,
      requestId: null,
    });
  },
});
