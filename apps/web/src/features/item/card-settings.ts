// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardSubitems, CardTab, View, ViewLayout } from '@bines/shared';
import { api } from '../../lib/api';
import { boardKeys, type BoardDetail } from '../board/board-api';
import { viewKeys } from '../board/views/views-api';

/**
 * Saves how the card shows subitems (`boards.settings.card.subitems`, cardsub) from inside the card — the
 * default view / filter / sort and the footer choices. The rest of the card setting (its tabs, fields per row)
 * goes along unchanged (the PATCH replaces the whole card setting).
 */
export const useSaveCardSubitems = (accountId: string, board: BoardDetail) => {
  const qc = useQueryClient();
  return useMutation({
    /** `tabs`: changed tabs (the subitems tab's columns, saved with "save as default"); default: as they are. */
    mutationFn: (v: { subitems: CardSubitems; tabs?: CardTab[] }) =>
      api(accountId).patch(`/boards/${board.id}`, {
        card: { ...board.card, tabs: v.tabs ?? board.card.tabs, subitems: v.subitems },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) }),
  });
};

/** The saved views of the sub-board (the views engine, 15-VIEWS); none until the sub-board exists. */
export const useSubBoardViews = (accountId: string, subBoardId: string) =>
  useQuery({
    queryKey: viewKeys.list(accountId, subBoardId),
    queryFn: () =>
      api(accountId).get<{ data: View[]; layout: ViewLayout; current_view_id: string }>(`/boards/${subBoardId}/views`),
    enabled: !!subBoardId,
    select: (d) => d.data.filter((v) => v.type === 'table'),
  });
