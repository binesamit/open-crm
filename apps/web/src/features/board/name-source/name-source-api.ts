// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isComputedName,
  nameSourceOfColumns,
  nameSourceRefs,
  t,
  type NameDuplicates,
  type NameSource,
  type NameSourceOut,
} from '@bines/shared';
import { api } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { boardKeys, type BoardDetail } from '../board-api';

/**
 * Computed item names ("way 2") — the client side of GET/PUT /boards/:id/name-source and
 * GET /boards/:id/name-duplicates. Keys live under the board's key, so the board's live channel
 * (`board.names_recompute_progress` and column events invalidate the board) refreshes them too.
 */
export const nameSourceKey = (accountId: string, boardId: string) =>
  [...boardKeys.board(accountId, boardId), 'name-source'] as const;
export const nameDuplicatesKey = (accountId: string, boardId: string) =>
  [...boardKeys.board(accountId, boardId), 'name-duplicates'] as const;

/** The board's name source as its columns carry it (`GET /boards/:id` already has it). */
export const boardNameSource = (board: Pick<BoardDetail, 'columns'> | undefined): NameSource =>
  nameSourceOfColumns(board?.columns ?? []);

/** Is this board's item name computed, and from which columns (titles in source order)? */
export const computedNameInfo = (board: Pick<BoardDetail, 'columns'> | undefined) => {
  const source = boardNameSource(board);
  const refs = nameSourceRefs(source);
  const columns = refs.map((key) => board?.columns.find((c) => c.id === key)).filter((c) => !!c);
  return { source, computed: isComputedName(source), refs, columns };
};

/** A rename on a computed board: the server's 409 `item_name_computed`, said before even asking. */
export const showNameComputedToast = () => showToast({ message: t('error.item_name_computed'), tone: 'error' });

/** A background recompute is running (big boards: a job; NAME-API §3). */
export const recomputeRunning = (out: NameSourceOut | undefined) =>
  out?.recompute?.status === 'running' && out.recompute.mode === 'background';

export const useNameSource = (accountId: string, boardId: string, enabled = true) =>
  useQuery({
    queryKey: nameSourceKey(accountId, boardId),
    queryFn: () => api(accountId).get<NameSourceOut>(`/boards/${boardId}/name-source`),
    enabled,
    // A background recompute: progress also comes on the live channel; polling every 2s is the fallback.
    refetchInterval: (q) => (recomputeRunning(q.state.data) ? 2000 : false),
  });

export const useSaveNameSource = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: NameSource) => api(accountId).put<NameSourceOut>(`/boards/${boardId}/name-source`, source),
    onSuccess: (out) => {
      qc.setQueryData(nameSourceKey(accountId, boardId), out);
      // The name column's settings and (sync recompute) every name changed.
      void qc.invalidateQueries({ queryKey: boardKeys.board(accountId, boardId) });
      void qc.invalidateQueries({ queryKey: ['account', accountId, 'item'] });
    },
  });
};

export const useNameDuplicates = (accountId: string, boardId: string, enabled: boolean) =>
  useQuery({
    queryKey: nameDuplicatesKey(accountId, boardId),
    queryFn: () => api(accountId).get<NameDuplicates>(`/boards/${boardId}/name-duplicates`),
    enabled,
    staleTime: 5_000,
  });
