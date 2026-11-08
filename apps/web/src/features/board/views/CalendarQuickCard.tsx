// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '@bines/shared';
import { Button } from '@bines/ui';
import type { BoardDetail, Column, Item, Member } from '../board-api';
import { cellFor, hasCellComponent } from '../cells';
import { Popover } from '../cells/Popover';

/** The quick card shows the view's chosen fields, else the first few columns that say something about an item. */
export const quickCardFields = (board: BoardDetail, chosen: string[], skip: (string | undefined)[]): Column[] => {
  if (chosen.length) return chosen.map((id) => board.columns.find((c) => c.id === id)).filter((c): c is Column => !!c);
  return board.columns.filter((c) => c.type !== 'name' && !skip.includes(c.id)).slice(0, 5);
};

/**
 * Prod (canvas board 2): a click on an item of the calendar — its name, when, the view's fields and "open
 * item"; "delete" for whoever may delete. Each field is the board's own cell (the table's renderer and editor), so it
 * is edited right here, as in the table.
 */
export const CalendarQuickCard = ({
  board,
  item,
  members,
  accountId,
  fields,
  when,
  onCell,
  onOpen,
  onDelete,
  onClose,
}: {
  board: BoardDetail;
  item: Item;
  members: Member[];
  accountId: string;
  fields: Column[];
  when: string;
  onCell: (column: Column, value: unknown, opts?: { workflowOverride?: boolean }) => void;
  onOpen: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) => {
  const canEdit = !!board.capabilities['item.update'];
  return (
    <Popover open onClose={onClose} className="w-[19rem] p-3.5">
      <div data-testid="calendar-quick-card" onPointerDown={(e) => e.stopPropagation()}>
        <h4 className="font-display text-base leading-snug font-bold text-heading">{item.name}</h4>
        <p className="mb-2.5 text-sm text-muted" data-testid="calendar-quick-when">
          {when}
        </p>
        <dl className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1 text-sm">
          {fields.map((c) => {
            const cell = item.cells[c.id];
            const Cell = cellFor(c);
            return (
              <div key={c.id} className="contents">
                <dt className="truncate text-muted">{c.title}</dt>
                <dd
                  className="relative m-0 h-8 min-w-0 overflow-hidden rounded-md [&_button:enabled]:cursor-pointer"
                  data-column={c.id}
                  data-column-type={c.type}
                  data-testid="calendar-quick-field"
                >
                  {hasCellComponent(c) ? (
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
                      onChange={(value, opts) => onCell(c, value, opts)}
                      canEditSettings={false}
                      canManageBoard={!!board.capabilities['board.update']}
                      onSettingsChange={() => Promise.resolve()}
                    />
                  ) : (
                    <span className="flex h-full items-center px-2 text-muted">
                      <span className="truncate" dir="auto">
                        {cell?.text || '—'}
                      </span>
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        <div className="mt-3 flex justify-end gap-2">
          {onDelete ? (
            <Button size="sm" variant="secondary" onClick={onDelete} data-testid="calendar-quick-delete">
              {t('calendar.card.delete')}
            </Button>
          ) : null}
          <Button size="sm" onClick={onOpen} data-testid="calendar-quick-open">
            {t('calendar.card.open')}
          </Button>
        </div>
      </div>
    </Popover>
  );
};
