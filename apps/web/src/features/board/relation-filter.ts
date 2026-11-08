// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  STREAM_RESYNC,
  choiceFilters,
  hasChoiceFilter,
  isRelationMatchOp,
  flattenRules,
  t,
  type Column,
  type FilterGroup,
  type RelationMatches,
  type StreamEvent,
} from '@bines/shared';
import { api } from '../../lib/api';
import { useEventStreams } from '../../lib/realtime';

/**
 * Relation filters on the web (the planning notes "RELATION-FILTERS", r19relfilter): which linked items no longer match
 * a relation column's filter, for me — one request per column (every cell of the column shares it), refreshed
 * every few seconds of use and after my own link changes.
 */
export const relationMatchesKey = (accountId: string, boardId: string, columnKey?: string) =>
  ['account', accountId, 'board', boardId, 'relation-matches', ...(columnKey ? [columnKey] : [])] as const;

const fetchMatches = (accountId: string, boardId: string, columnKey: string) =>
  api(accountId).get<RelationMatches>(`/boards/${boardId}/columns/${columnKey}/relation-matches`);

export const useRelationMatches = (accountId: string, boardId: string, column: Pick<Column, 'id' | 'settings'>) => {
  const enabled = !!boardId && hasChoiceFilter(column.settings);
  return useQuery({
    queryKey: relationMatchesKey(accountId, boardId, column.id),
    queryFn: () => fetchMatches(accountId, boardId, column.id),
    enabled,
    staleTime: 15_000,
    // r25: back on the tab, the marks are checked again (a change made elsewhere).
    refetchOnWindowFocus: 'always' as const,
  }).data;
};

/** After a link change on this board: the marks are checked again. */
export const refreshRelationMatches = (qc: QueryClient, accountId: string, boardId: string) =>
  qc.invalidateQueries({ queryKey: relationMatchesKey(accountId, boardId) });

/**
 * r25 (product owner: "the ⚠ should update live, without a refresh"): the boards whose changes can change a
 * column's marks — the linked boards it filters on — and this board's relation columns that have marks.
 */
export const relationLiveScope = (boardId: string, columns: Pick<Column, 'id' | 'type' | 'settings'>[]) => {
  const marked = columns.filter((c) => c.type === 'board_relation' && hasChoiceFilter(c.settings));
  return {
    columns: marked.map((c) => c.id),
    boards: [...new Set(marked.flatMap((c) => Object.keys(choiceFilters(c.settings))))].sort(),
  };
};

/**
 * Whether a live event can change the marks: an item or a cell of a linked board changed (its status may no longer
 * match), a link of this board changed (someone else's edit — my own refreshes in `setCell`), or the stream
 * missed events (`resync`).
 */
export const touchesRelationMatches = (
  e: Pick<StreamEvent, 'type' | 'board_id' | 'column_id'>,
  boardId: string,
  scope: { columns: string[]; boards: string[] },
) => {
  if (e.type === STREAM_RESYNC) return true;
  const kind = e.type.split('.')[0];
  if (kind !== 'item' && kind !== 'cell') return false;
  if (e.board_id && scope.boards.includes(e.board_id)) return true;
  return e.board_id === boardId && kind === 'cell' && !!e.column_id && scope.columns.includes(e.column_id);
};

/** Live marks: events come in bursts (a bulk edit, an automation) — one refetch per quiet half second. */
export const RELATION_LIVE_DEBOUNCE_MS = 500;

/**
 * Keeps the board's relation marks live while it is open: one subscription per linked board (shared with any
 * other listener of that board's stream — never one per cell), and this board's own stream. Matching events
 * refetch the marks, debounced. Only the relation columns on screen (`visible`) or read by the view's filter count.
 */
export const useRelationMatchesLive = (
  accountId: string,
  boardId: string,
  visible: Pick<Column, 'id' | 'type' | 'settings'>[],
  all: Pick<Column, 'id' | 'type' | 'settings'>[],
  filter: FilterGroup | undefined,
) => {
  const qc = useQueryClient();
  const read = new Set(matchColumns(filter));
  const scope = relationLiveScope(boardId, [...visible, ...all.filter((c) => read.has(c.id))]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const paths = scope.columns.length ? [boardId, ...scope.boards].map((b) => `/boards/${b}/events`) : [];
  useEventStreams(paths, accountId, (e) => {
    if (!touchesRelationMatches(e, boardId, scope)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void refreshRelationMatches(qc, accountId, boardId), RELATION_LIVE_DEBOUNCE_MS);
  });
};

/** Relation columns the board's filter reads with "has a link that does not match". */
const matchColumns = (filter: FilterGroup | undefined) => [
  ...new Set(
    flattenRules(filter)
      .filter((r) => isRelationMatchOp(r.operator) && !r.disabled)
      .map((r) => r.column_id),
  ),
];

/**
 * `QueryEnv.relationUnmatched` for the board's in-memory filter: column key → unmatched linked items, for the
 * columns the filter reads (a windowed board filters on the server, which computes the same).
 */
export const useRelationUnmatchedEnv = (
  accountId: string,
  boardId: string,
  columns: Column[],
  filter: FilterGroup | undefined,
) => {
  const keys = matchColumns(filter).filter((k) => {
    const c = columns.find((x) => x.id === k);
    return c?.type === 'board_relation' && hasChoiceFilter(c.settings);
  });
  // `combine` keeps the result stable while the answers do not change (the board's env memo depends on it).
  return useQueries({
    queries: keys.map((key) => ({
      queryKey: relationMatchesKey(accountId, boardId, key),
      queryFn: () => fetchMatches(accountId, boardId, key),
      staleTime: 15_000,
      // r25: back on the tab, the marks are checked again (a change made elsewhere).
      refetchOnWindowFocus: 'always' as const,
    })),
    combine: (results) => {
      if (!keys.length) return undefined;
      const out: Record<string, string[]> = {};
      keys.forEach((key, i) => (out[key] = results[i]?.data?.unmatched ?? []));
      return out;
    },
  });
};

/** The picker's caption: the column's text, the view's name, "by filter" — or that the view is gone. */
export const choiceCaption = (
  f: { label: string | null; source: string; invalid: string | null } | null | undefined,
) => {
  if (!f) return null;
  if (f.invalid) return t('relfilter.viewMissing');
  if (f.label) return t('relfilter.byView', { name: f.label });
  return t('relfilter.byFilter');
};

/** The ⚠ chip's tip: which filter it no longer matches. */
export const unmatchedTip = (label: string | null | undefined) =>
  label ? t('relfilter.unmatchedNamed', { name: label }) : t('relfilter.unmatched');
