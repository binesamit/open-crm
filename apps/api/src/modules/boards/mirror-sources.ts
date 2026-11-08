// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes, MIRROR_SUBITEMS, type MirrorSource, mirrorSourceOf } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import { columnAllowed, loadBoardAccess, readableBoardIds } from './boards.access';
import { columnsByBoardIds, type ColumnRow, findSubBoard } from './boards.repo';

/** A mirror of a mirror of … — followed this deep (03 §2.17: two mirror levels; one spare). */
const MAX_LEVELS = 3;

type Label = { id: number; label: string; color?: string; is_done?: boolean; is_deactivated?: boolean };

/**
 * a relation to several boards reads the same-keyed source column on each — the filter offers their
 * labels together, once per text (the first board's colour; done on any board counts as done, active on any as
 * active). Ids only tell the labels apart here — the filter matches mirrored values by their text.
 */
const mergedLabels = (sources: ColumnRow[]): { labels?: Label[] } => {
  const all = sources.flatMap((s) => {
    const labels = (s.settings as { labels?: Label[] }).labels;
    return Array.isArray(labels) ? labels : [];
  });
  const out = new Map<string, Label>();
  const used = new Set<number>();
  let next = Math.max(0, ...all.map((l) => l.id + 1));
  for (const l of all) {
    const key = l.label.trim().toLowerCase();
    const hit = out.get(key);
    if (hit) {
      if (l.is_done) hit.is_done = true;
      if (!l.is_deactivated) delete hit.is_deactivated;
      continue;
    }
    const id = used.has(l.id) ? next++ : l.id;
    used.add(id);
    out.set(key, { ...l, id });
  }
  return out.size ? { labels: [...out.values()] } : {};
};

/**
 * each mirror column's source — the column it reads on the linked boards (a mirror of a mirror: the
 * one at the end of the chain) — as its type and number display only (`mirrorSourceOf`). The group footers offer
 * that type's summaries over the mirrored values. Only through what the viewer may see: boards they can read and
 * columns not restricted from them; anything else — or a relation, linked board or source column that is gone —
 * resolves to null (its footer offers "filled", as before).
 */
export const mirrorSources = async (
  db: Db,
  viewer: { ctx: AccountContext; user: SessionUser },
  cols: ColumnRow[],
): Promise<Map<string, MirrorSource | null>> => {
  const out = new Map<string, MirrorSource | null>();
  const mirrors = cols.filter((c) => c.type === 'mirror');
  if (!mirrors.length) return out;
  // The columns given are the ones the viewer sees on boards they read (the board in view, its sub-board).
  const columnsOf = new Map<string, ColumnRow[]>();
  for (const c of cols) columnsOf.set(c.boardId, [...(columnsOf.get(c.boardId) ?? []), c]);
  const subBoards = new Map<string, string | null>();

  /** Loads (once) the columns the viewer may see of the boards they can read; other boards stay empty. */
  const load = async (boardIds: string[]) => {
    const missing = [...new Set(boardIds)].filter((id) => !columnsOf.has(id));
    if (!missing.length) return;
    for (const id of missing) columnsOf.set(id, []);
    const readable = [...(await readableBoardIds(db, viewer.ctx, viewer.user, missing))];
    const access = new Map(
      await Promise.all(
        readable.map(async (id) => [id, await loadBoardAccess(db, viewer.ctx, viewer.user, id)] as const),
      ),
    );
    for (const c of await columnsByBoardIds(db, readable)) {
      const a = access.get(c.boardId);
      if (a && columnAllowed(a, c.restrictedView)) columnsOf.get(c.boardId)!.push(c);
    }
  };

  /** The boards a mirror reads: its board's sub-board, or the boards its relation column links to. */
  const targetBoards = async (mirror: ColumnRow): Promise<string[]> => {
    const s = mirror.settings as { relation_column_id?: string };
    if (s.relation_column_id === MIRROR_SUBITEMS) {
      if (!subBoards.has(mirror.boardId))
        subBoards.set(mirror.boardId, (await findSubBoard(db, mirror.boardId))?.id ?? null);
      const sub = subBoards.get(mirror.boardId);
      return sub ? [sub] : [];
    }
    await load([mirror.boardId]);
    const relation = columnsOf
      .get(mirror.boardId)!
      .find((c) => c.key === s.relation_column_id && columnTypes.get(c.type)?.engine === 'links');
    if (!relation) return [];
    // A board relation names its boards; a dependency links items of its own board.
    const ids = (relation.settings as { board_ids?: unknown }).board_ids;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [mirror.boardId];
  };

  const resolve = async (mirror: ColumnRow, level: number): Promise<MirrorSource | null> => {
    const key = (mirror.settings as { source_column_id?: string }).source_column_id;
    if (!key) return null;
    const boards = await targetBoards(mirror);
    await load(boards);
    const sources = boards.flatMap((id) => columnsOf.get(id) ?? []).filter((c) => c.key === key);
    const source = sources[0];
    if (!source) return null;
    if (source.type !== 'mirror') {
      const withLabels = !!columnTypes.get(source.type)?.labelIds;
      return mirrorSourceOf(
        source.type,
        {
          ...(source.settings as Record<string, unknown>),
          ...(withLabels ? mergedLabels(sources.filter((c) => c.type === source.type)) : {}),
        },
        { withLabels },
      );
    }
    // A mirror counting its items holds plain counts, whatever it counts.
    if ((source.settings as { aggregate?: string }).aggregate === 'count') return mirrorSourceOf('numbers', {});
    return level < MAX_LEVELS ? resolve(source, level + 1) : null;
  };

  for (const m of mirrors) out.set(m.id, await resolve(m, 1));
  return out;
};
