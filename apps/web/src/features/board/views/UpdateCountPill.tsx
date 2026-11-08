// SPDX-License-Identifier: AGPL-3.0-only
import { useContext } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import { BoardAccountContext } from '../board-context';
import { useUpdateCounts } from '../update-counts';
import { Icon } from '../../../lib/icons';

/** The item's number of updates (N4): 0 hides the pill. */
export const useUpdateCount = (boardId: string, itemId: string) => {
  const { id: accountId } = useContext(BoardAccountContext);
  return useUpdateCounts(accountId, boardId).data?.[itemId] ?? 0;
};

/**
 * N4 (F4 `.upd`): a speech bubble and the number of updates on a tile; a click opens the item's card on its
 * Updates tab (keeping the board's view and draft in the URL). Never starts a drag or the tile's own click.
 */
export const UpdateCountPill = ({
  boardId,
  itemId,
  count,
  className,
}: {
  boardId: string;
  itemId: string;
  count: number;
  className?: string;
}) => {
  const navigate = useNavigate();
  const { slug } = useContext(BoardAccountContext);
  if (count <= 0) return null;
  const label = t('tile.updateCount', { n: count });
  return (
    <button
      type="button"
      data-testid="tile-update-count"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void navigate({
          to: '/a/$accountSlug/b/$boardId/i/$itemId',
          params: { accountSlug: slug, boardId, itemId },
          search: (prev: Record<string, unknown>) => ({ ...prev, tab: 'updates' }),
        } as never);
      }}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-[0.1875rem] rounded-[6px] bg-surface-2 px-1.5 text-[0.6875rem] text-fg-2 tabular-nums hover:bg-surface-3 hover:text-fg',
        className,
      )}
    >
      <Icon name="chat" size={11} strokeWidth={2.2} />
      {count}
    </button>
  );
};
