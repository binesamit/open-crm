// SPDX-License-Identifier: AGPL-3.0-only
import { useContext } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import { BoardAccountContext } from '../board-context';
import { useUpdateCounts } from '../update-counts';
import { Icon } from '../../../lib/icons';

/**
 * N4: how many updates an item has — a speech bubble and the number next to its name in a table row (F4 `.upd`).
 * Only when there are any; a click opens the item card on its Updates tab. (Tiles and phone rows: views/UpdateCountPill.)
 */
export const UpdateCountPill = ({
  boardId,
  cardBoardId = boardId,
  itemId,
  className,
}: {
  /** The board the item lives on (a sub-board for subitems): where the counts come from. */
  boardId: string;
  /** The board whose route opens the card (the main board for subitems). */
  cardBoardId?: string;
  itemId: string;
  className?: string;
}) => {
  const { id: accountId, slug } = useContext(BoardAccountContext);
  const n = useUpdateCounts(accountId, boardId).data?.[itemId] ?? 0;
  const navigate = useNavigate();
  if (!n) return null;
  const label = t('board.updateCount', { n });
  return (
    <button
      type="button"
      data-testid="row-update-count"
      aria-label={label}
      title={label}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void navigate({
          to: '/a/$accountSlug/b/$boardId/i/$itemId',
          params: { accountSlug: slug, boardId: cardBoardId, itemId },
          search: (prev: Record<string, unknown>) => ({ ...prev, tab: 'updates' }),
        } as never);
      }}
      className={cn(
        'inline-flex h-[1.125rem] shrink-0 items-center gap-[0.1875rem] rounded-[6px] bg-surface-2 px-1.5 text-[0.6875rem] text-fg-2 tabular-nums hover:text-heading hover:ring-1 hover:ring-line-strong',
        className,
      )}
    >
      <Icon name="chat" size={11} strokeWidth={2.2} />
      {n}
    </button>
  );
};
