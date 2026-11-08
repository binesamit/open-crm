// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type SyntheticEvent } from 'react';
import { cn, scrollBehavior } from '@bines/ui';
import type { BoardDetail } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { Popover } from '../cells/Popover';
import { ComputedNameFields, type ComputedNameEdit } from '../table/ComputedNameEditor';
import { ColumnTypeGlyph } from '../table/type-glyphs';
import { computedNameInfo } from './name-source-api';
import { NameSourceDialog } from './NameSourceDialog';
import { t } from '@bines/shared';

/** Scrolls to a column of the table (its header) or the item card's field, and lights it briefly. */
const focusColumn = (key: string) => {
  const el =
    document.querySelector<HTMLElement>(
      `[data-testid="item-card"] [data-testid="card-field"][data-column="${CSS.escape(key)}"]`,
    ) ?? document.querySelector<HTMLElement>(`[data-header="${CSS.escape(key)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: scrollBehavior() });
  el.classList.add('ring-2', 'ring-primary');
  setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1200);
};

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * The "computed" mark beside a computed item name (NAME-API §6.3): a small ƒ at inline-start whose tooltip
 * names the source columns; a click lists them (a click on one scrolls to it) and, for those who may change
 * columns, "שינוי מקור השם" opens the name source dialog. given `edit` (the item card), the columns
 * are editable right there instead — a value is picked in the popover, not by scrolling to a field. `open` /
 * `onOpenChange` let the name beside it open the same popover.
 */
export const ComputedNameMark = ({
  board,
  className,
  edit,
  open: openProp,
  onOpenChange,
}: {
  board: BoardDetail;
  className?: string;
  edit?: ComputedNameEdit;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setOpenOwn(v));
  const [editing, setEditing] = useState(false);
  const info = computedNameInfo(board);
  const titles = info.columns.map((c) => c.title).join(', ');
  const tip = t('name.computed.tip', { columns: titles });
  return (
    // React events bubble out of portals: the row under it (drag, long press, open, grid keys) must not see the
    // mark's popover or dialog.
    <span
      className={cn('relative inline-flex shrink-0', className)}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onContextMenu={stop}
    >
      <button
        type="button"
        data-testid="computed-name-mark"
        aria-label={tip}
        data-tip={tip}
        title={tip}
        onClick={() => setOpen(true)}
        className="grid size-5 place-items-center rounded-[6px] font-serif text-[0.8125rem] leading-none text-muted italic hover:bg-surface-2 hover:text-primary"
      >
        ƒ
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className={edit ? 'w-80 p-2' : 'w-64 p-2'}>
        <div className="flex flex-col gap-1" data-testid="computed-name-popover">
          {edit ? (
            <div className="space-y-2">
              <ComputedNameFields board={board} {...edit} />
            </div>
          ) : (
            <>
              <p className="px-1 text-xs text-muted">{t('name.computed.locked', { columns: titles })}</p>
              <ul className="flex flex-col gap-0.5">
                {info.columns.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      data-testid="computed-name-source"
                      data-key={c.id}
                      onClick={() => {
                        setOpen(false);
                        focusColumn(c.id);
                      }}
                      className="flex w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-start text-sm hover:bg-surface-2"
                    >
                      <ColumnTypeGlyph type={c.type} />
                      <span className="truncate">{c.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {board.capabilities['column.update'] ? (
            <button
              type="button"
              data-testid="computed-name-change"
              onClick={() => {
                setOpen(false);
                setEditing(true);
              }}
              className="mt-1 rounded-[8px] px-1.5 py-1 text-start text-sm text-primary hover:bg-surface-2"
            >
              {t('name.computed.change')}
            </button>
          ) : null}
        </div>
      </Popover>
      {editing ? <NameSourceDialog accountId={accountId} board={board} onClose={() => setEditing(false)} /> : null}
    </span>
  );
};
