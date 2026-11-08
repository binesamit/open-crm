// SPDX-License-Identifier: AGPL-3.0-only
import {
  FAVORITE_BOARDS_MAX,
  FAVORITES_MAX,
  type Favorite,
  type FavoriteBoards,
  type FavoriteType,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { readableBoardIds } from '../boards/boards.access';
import { boardsByIds } from '../boards/boards.repo';
import { readableDashboards } from '../dashboards/dashboards.access';
import { dashboardsByIds } from '../dashboards/dashboards.repo';
import { readableDocs } from '../docs/docs.access';
import { docsByIds } from '../docs/docs.repo';
import { memberSettings, setMemberSettings } from '../mywork/mywork.repo';

type Ref = { type: FavoriteType; id: string };

/**
 * My favourites in this account (fix2 boards, M8 docs, Fix: dashboards, all in ONE order) —
 * `account_members.settings.favorites` = `[{type, id}]`. The older per-type lists (`favorite_boards`,
 * `favorite_docs`, still written by PUT /me/favorite-boards and /me/favorite-docs) stay the truth of WHICH boards
 * and docs are starred; the combined list gives the order, and anything starred only through an older list joins
 * at its end. Every write here keeps the older lists in step.
 */
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const storedRefs = (settings: Record<string, unknown>): Ref[] => {
  const boards = ids(settings.favorite_boards);
  const docs = ids(settings.favorite_docs);
  const starred = { board: new Set(boards), doc: new Set(docs) };
  const out: Ref[] = [];
  const seen = new Set<string>();
  const push = (r: Ref) => {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  const combined = Array.isArray(settings.favorites) ? (settings.favorites as unknown[]) : [];
  for (const x of combined) {
    const r = x as Partial<Ref>;
    if (typeof r?.id !== 'string' || (r.type !== 'board' && r.type !== 'doc' && r.type !== 'dashboard')) continue;
    // Un-starred through an older per-type endpoint.
    if (r.type !== 'dashboard' && !starred[r.type].has(r.id)) continue;
    push({ type: r.type, id: r.id });
  }
  boards.forEach((id) => push({ type: 'board', id }));
  docs.forEach((id) => push({ type: 'doc', id }));
  return out;
};

/** The starred things that still exist and that I may still open, in my order. */
const resolveAll = async (db: Db, a: Actor, refs: Ref[]): Promise<Favorite[]> => {
  if (!refs.length) return [];
  const of = (type: FavoriteType) => refs.filter((r) => r.type === type).map((r) => r.id);
  const found = new Map<string, Favorite>();

  const boardIds = of('board');
  if (boardIds.length) {
    const rows = (await boardsByIds(db, a.ctx.accountId, boardIds)).filter((b) => !b.archivedAt && !b.parentBoardId);
    const readable = await readableBoardIds(
      db,
      a.ctx,
      a.user,
      rows.map((b) => b.id),
    );
    for (const b of rows)
      if (readable.has(b.id))
        found.set(`board:${b.id}`, { type: 'board', id: b.id, name: b.name, workspace_id: b.workspaceId });
  }
  const docIds = of('doc');
  if (docIds.length) {
    for (const { doc } of await readableDocs(db, a.ctx, a.user, await docsByIds(db, a.ctx.accountId, docIds)))
      found.set(`doc:${doc.id}`, {
        type: 'doc',
        id: doc.id,
        name: doc.name,
        workspace_id: doc.workspaceId,
        icon: doc.icon ?? null,
      });
  }
  const dashIds = of('dashboard');
  if (dashIds.length) {
    const rows = await dashboardsByIds(db, a.ctx.accountId, dashIds);
    for (const { dashboard: d } of await readableDashboards(db, a.ctx, a.user, rows))
      found.set(`dashboard:${d.id}`, { type: 'dashboard', id: d.id, name: d.name, workspace_id: d.workspaceId });
  }
  return refs.flatMap((r) => {
    const f = found.get(`${r.type}:${r.id}`);
    return f ? [f] : [];
  });
};

const settingsOf = async (db: Db, a: Actor) =>
  (await memberSettings(db, a.ctx.accountId, a.user.id)) as Record<string, unknown>;

/** GET /me/favorites — boards, docs and dashboards, in my order. */
export const favorites = async (db: Db, a: Actor) => ({
  data: await resolveAll(db, a, storedRefs(await settingsOf(db, a))),
});

/** Saves the combined order and the older per-type lists with it. */
const save = async (db: Db, a: Actor, settings: Record<string, unknown>, list: Favorite[]) =>
  setMemberSettings(db, a.ctx.accountId, a.user.id, {
    ...settings,
    favorites: list.map((f) => ({ type: f.type, id: f.id })),
    favorite_boards: list.filter((f) => f.type === 'board').map((f) => f.id),
    favorite_docs: list.filter((f) => f.type === 'doc').map((f) => f.id),
  });

/**
 * PUT /me/favorites — the whole list, in order (star, un-star, drag to reorder). Only what I may open is kept; the
 * list is personal (like recent searches), so no activity event.
 */
export const setFavorites = async (db: Db, a: Actor, items: Ref[]) => {
  const seen = new Set<string>();
  const unique = items
    .filter((r) => {
      const key = `${r.type}:${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, FAVORITES_MAX);
  const data = await resolveAll(db, a, unique);
  await save(db, a, await settingsOf(db, a), data);
  return { data };
};

/** GET /me/favorite-boards (fix2) — the boards of my favourites. */
export const favoriteBoards = async (db: Db, a: Actor): Promise<{ data: FavoriteBoards['data'] }> => ({
  data: (await favorites(db, a)).data
    .filter((f) => f.type === 'board')
    .map((f) => ({ id: f.id, name: f.name, workspace_id: f.workspace_id })),
});

/**
 * PUT /me/favorite-boards — the boards, in order (older clients); docs and dashboards keep their places, the
 * boards take the board slots in the new order (new ones at the end).
 */
export const setFavoriteBoards = async (db: Db, a: Actor, boardIds: string[]) => {
  const wanted = [...new Set(boardIds)].slice(0, FAVORITE_BOARDS_MAX);
  const settings = await settingsOf(db, a);
  const current = storedRefs(settings);
  const queue = [...wanted];
  const merged: Ref[] = [];
  for (const r of current) {
    if (r.type !== 'board') merged.push(r);
    else if (queue.length) merged.push({ type: 'board', id: queue.shift()! });
  }
  queue.forEach((id) => merged.push({ type: 'board', id }));
  const keep = merged.filter((r) => r.type !== 'board' || wanted.includes(r.id));
  const data = await resolveAll(db, a, keep);
  await save(db, a, settings, data);
  return {
    data: data.filter((f) => f.type === 'board').map((f) => ({ id: f.id, name: f.name, workspace_id: f.workspace_id })),
  };
};
