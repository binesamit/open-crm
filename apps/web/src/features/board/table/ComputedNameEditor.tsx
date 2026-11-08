// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode, SyntheticEvent } from 'react';
import { nameSourceOfColumns, nameSourceRefs, t } from '@bines/shared';
import type { BoardDetail, Column, Item, Member } from '../board-api';
import { cellFor, hasCellComponent } from '../cells';
import { Popover } from '../cells/Popover';

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** What editing a computed name's source columns needs: the item, its board's people and how a cell is written. */
export type ComputedNameEdit = {
  item: Item;
  members: Member[];
  accountId: string;
  canEdit: boolean;
  onWrite: (c: Column, value: unknown) => void;
};

/**
 * The columns a computed name is made of, each as its own editable cell — changing one changes the name. Shared by
 * the row's editor and the ƒ mark (in the item card too, wherever it was opened from).
 */
export const ComputedNameFields = ({
  board,
  item,
  members,
  accountId,
  canEdit,
  onWrite,
}: ComputedNameEdit & { board: BoardDetail }) => {
  const keys = nameSourceRefs(nameSourceOfColumns(board.columns));
  const sources = keys.flatMap((k) => {
    const c = board.columns.find((col) => col.id === k);
    return c ? [c] : [];
  });
  return (
    <>
      <p className="px-1 text-xs text-muted">{t('name.computed.editHint')}</p>
      <div className="divide-y divide-[var(--line-soft)] rounded-[var(--radius-sm)] border border-line">
        {sources.map((c) => {
          const Cell = cellFor(c);
          const cell = item.cells[c.id];
          return (
            <div key={c.id} className="flex min-h-9 items-stretch" data-testid="computed-name-field">
              <span className="flex w-28 shrink-0 items-center truncate border-e border-line px-2 text-xs text-fg-2">
                {c.title}
              </span>
              <div className="relative min-w-0 flex-1">
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
                    onChange={(value) => onWrite(c, value)}
                    canEditSettings={false}
                    onSettingsChange={async () => undefined}
                  />
                ) : (
                  <span className="flex h-full items-center px-2 text-sm text-muted">{cell?.text ?? ''}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};

/**
 * Prod (product owner: "a templated name opens the side panel — I want it to open in its row and decide there")
 * a click on a computed name opens, in the row, the columns the name is made of — each as its own editable cell, so
 * changing one changes the name — and "open the item" for the full card (left out where the card is already open).
 */
export const ComputedNameEditor = ({
  open,
  onClose,
  board,
  onOpenItem,
  children,
  ...edit
}: ComputedNameEdit & {
  open: boolean;
  onClose: () => void;
  board: BoardDetail;
  onOpenItem?: () => void;
  /** The name itself (it opens the editor); the editor is placed against it. */
  children: ReactNode;
}) => (
  <span className="relative flex min-w-0">
    {children}
    {/* React events bubble out of portals: the row under it (open, drag, grid keys) must not see the editor's.
        A layer of the name's size anchors it and stops them, without taking the name's own clicks. */}
    <span
      className="pointer-events-none absolute inset-0"
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onContextMenu={stop}
    >
      <Popover open={open} onClose={onClose} className="w-80 space-y-2">
        <ComputedNameFields board={board} {...edit} />
        {onOpenItem ? (
          <button
            type="button"
            data-testid="computed-name-open-item"
            onClick={() => {
              onClose();
              onOpenItem();
            }}
            className="w-full rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm text-primary hover:bg-surface-2"
          >
            {t('name.computed.openItem')}
          </button>
        ) : null}
      </Popover>
    </span>
  </span>
);
