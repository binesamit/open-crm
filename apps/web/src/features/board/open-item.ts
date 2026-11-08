// SPDX-License-Identifier: AGPL-3.0-only
import { useContext } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BoardAccountContext } from './board-context';

/** Opens an item's card over the board, keeping the board's view and draft in the URL. */
export const useOpenItem = (boardId: string) => {
  const navigate = useNavigate();
  const { slug } = useContext(BoardAccountContext);
  return (itemId: string) =>
    void navigate({
      to: '/a/$accountSlug/b/$boardId/i/$itemId',
      params: { accountSlug: slug, boardId, itemId },
      search: (prev: Record<string, unknown>) => prev,
    } as never);
};
