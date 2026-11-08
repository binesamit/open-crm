// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import { t, type QueryEnv, type ViewSettings } from '@bines/shared';
import type { BoardDetail, Item, Member, useBoardMutations } from '../board-api';
import { ItemTile } from './ItemTile';
import { chosenFields, defaultCardFields } from './KanbanView';

/** Cards (11-UI §4): a gallery of the filtered items, each with the fields the view chose. */
export const CardsView = ({
  board,
  items,
  settings,
  env,
  members,
  mutations,
  more,
}: {
  /** A windowed board: `items` are the loaded first cards; `total` = all matches, `load` shows more. */
  more?: { total: number; load: () => void };
  board: BoardDetail;
  items: Item[];
  settings: ViewSettings;
  env: QueryEnv;
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
}) => {
  const fields = useMemo(() => {
    const chosen = settings.cards?.fields;
    const picked = chosen?.length ? chosenFields(board, chosen) : [];
    return picked.length ? picked : defaultCardFields(board);
  }, [settings.cards?.fields, board]);
  if (!items.length && !more?.total)
    return <p className="py-16 text-center text-sm text-muted">{t('filter.noResults')}</p>;
  return (
    <>
      <div className="grid grid-cols-3 gap-4 pb-6 max-lg:grid-cols-2 max-md:grid-cols-1" data-testid="cards">
        {items.map((it) => (
          <ItemTile
            key={it.id}
            item={it}
            fields={fields}
            env={env}
            members={members}
            boardId={board.id}
            menu={{ board, mutations }}
          />
        ))}
      </div>
      {more && more.total > items.length ? (
        <button
          type="button"
          data-testid="show-more"
          className="mb-6 h-10 w-full rounded-[10px] text-sm text-primary hover:bg-surface-2"
          onClick={more.load}
        >
          {t('windowed.showMore', { n: more.total - items.length })}
        </button>
      ) : null}
    </>
  );
};
