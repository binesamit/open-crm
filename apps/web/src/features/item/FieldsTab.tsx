// SPDX-License-Identifier: AGPL-3.0-only
import { cardFieldsPerRowFor, cardSubitemsOf, t, type CardFieldsPerRow, type EditedItem } from '@bines/shared';
import { cn } from '@bines/ui';
import { cellFor } from '../board/cells';
import type { BoardDetail, Column, Item, Member, useBoardMutations } from '../board/board-api';
import { FailedMark, useConversionMarks } from '../board/convert/marks';
import { SubitemsTable } from './SubitemsTab';

/**
 * "Fields" tab of the item card (N19א, 11-UI §3 "Columns"): the board's columns as a form — a label and the same
 * cell editor as the table (the `CELLS` registry), so every column type edits here exactly as in a row. Which
 * columns show and in what order is the tab's setting (`CardTab.columns`; missing = every column in board order).
 * On phones this is the main way to edit an item.
 */
export const cardFieldColumns = (board: BoardDetail, columns: string[] | undefined): Column[] => {
  const all = board.columns.filter((c) => c.type !== 'name');
  if (!columns) return all;
  return columns.map((id) => all.find((c) => c.id === id)).filter((c): c is Column => !!c);
};

/**
 * r15: the fields' grid per the card's "fields per row" (`boards.settings.card.fields_per_row`). The grid answers
 * the card's own width (a container query), so a narrow side panel steps down by itself; a phone shows one per row.
 */
const GRID: Record<CardFieldsPerRow, string> = {
  1: 'flex flex-col gap-2.5',
  2: 'grid grid-cols-1 gap-x-4 gap-y-3 @sm:grid-cols-2 max-md:grid-cols-1!',
  3: 'grid grid-cols-1 gap-x-4 gap-y-3 @sm:grid-cols-2 @lg:grid-cols-3 max-md:grid-cols-1!',
  auto: 'grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-3 max-md:grid-cols-1!',
};

export const FieldsTab = ({
  accountId,
  board,
  item,
  columns,
  members,
  m,
  onItem,
  subitems,
  parentCard,
}: {
  accountId: string;
  board: BoardDetail;
  /** A subitems board's parent board's card settings: its fields per row apply unless this board sets its own. */
  parentCard?: unknown;
  item: Item;
  columns: string[] | undefined;
  members: Member[];
  m: ReturnType<typeof useBoardMutations>;
  /** The edited item as the server returned it (the card shows it at once). */
  onItem: (item: EditedItem) => void;
  /**
   * cardsub: the item's subitems as a table under its fields (the main "Fields" tab, unless the card's settings
   * turn it off) — with the subitems tab's columns, opening a subitem's card.
   */
  subitems?: { columns: string[] | undefined; onOpen: (itemId: string) => void };
}) => {
  const list = cardFieldColumns(board, columns);
  const perRow = cardFieldsPerRowFor(board.card, parentCard);
  // One per row keeps the label beside its field; side by side, the label sits above.
  const beside = perRow === 1;
  const canEdit = !!board.capabilities['item.update'];
  // D28: a field that failed in a column type conversion shows its original value (from the backup).
  const marks = useConversionMarks(accountId, board.id).marks;
  const sub =
    subitems && cardSubitemsOf(board.card).in_fields ? (
      <SubitemsTable
        accountId={accountId}
        board={board}
        item={item}
        columns={subitems.columns}
        members={members}
        onOpen={subitems.onOpen}
        embedded
      />
    ) : null;
  if (!list.length)
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted">{t('item.fields.empty')}</p>
        {sub}
      </div>
    );
  return (
    <div className="flex flex-col gap-5">
      <div className="@container">
        <div className={GRID[perRow]} data-testid="card-fields" data-tour="item.columns" data-per-row={perRow}>
          {list.map((c) => {
            const Cell = cellFor(c);
            const cell = item.cells[c.id];
            const failed = cell ? undefined : marks?.get(c.id)?.get(item.id);
            return (
              <div
                key={c.id}
                data-testid="card-field"
                data-column={c.id}
                className={cn(
                  'min-w-0',
                  beside
                    ? 'grid grid-cols-[150px_minmax(0,1fr)] items-center gap-3 max-md:grid-cols-1 max-md:gap-1'
                    : 'flex flex-col gap-1',
                )}
              >
                <span className="truncate text-xs font-semibold text-muted" title={c.description ?? c.title}>
                  {c.title}
                </span>
                <div
                  className="relative h-9 min-w-0 overflow-hidden rounded-[var(--radius-sm)] border border-line bg-surface"
                  data-column-type={c.type}
                >
                  {failed !== undefined ? <FailedMark text={failed} /> : null}
                  <Cell
                    column={c}
                    value={cell?.value ?? null}
                    text={cell?.text ?? null}
                    names={cell?.names}
                    editable={canEdit && !c.read_only && !c.restricted_edit}
                    members={members}
                    accountId={accountId}
                    itemId={item.id}
                    boardId={board.id}
                    rowCells={item.cells}
                    onChange={(value, opts) =>
                      m.setCell.mutate(
                        {
                          itemId: item.id,
                          columnId: c.id,
                          value,
                          ...(opts?.workflowOverride ? { workflowOverride: true } : {}),
                        },
                        { onSuccess: (it) => onItem(it) },
                      )
                    }
                    canEditSettings={!!board.capabilities['column.update']}
                    canManageBoard={!!board.capabilities['board.update']}
                    onSettingsChange={(settings) => m.updateColumn.mutateAsync({ columnId: c.id, settings })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {sub}
    </div>
  );
};
