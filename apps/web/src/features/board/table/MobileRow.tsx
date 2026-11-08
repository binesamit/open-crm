// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, type ReactNode } from 'react';
import { t, type Column } from '@bines/shared';
import { cn, Menu, MenuTrigger } from '@bines/ui';
import type { BoardDetail, Item, Member, useBoardMutations } from '../board-api';
import { useItemMenu } from '../item-menu';
import { BoardAccountContext } from '../board-context';
import { cellFor, hasCellComponent } from '../cells';
import { SubitemsContext } from './BoardTable';
import { ComputedNameMark } from '../name-source/ComputedName';
import { canNestUnder } from './mobile-subitems';
import { SelectionContext } from '../selection';

/**
 * Phone table widths: the name column (sticky) and every other column — compact. r23ui (prod
 * "scrolling right, the name shows too little"): the name keeps 45% of the screen (at least 140px, at
 * most 260px on a tablet) and wraps to two lines inside the fixed row height — no row grows, nothing jumps.
 * r25 (sent back): the width follows the sideways scroll — wide at the start
 * narrowing as the columns scroll under it and widening again on the way back (`--m-name-w`, set by
 * `useScrollNameWidth`; the fallback is the width at the start). Narrow, the name is one truncated line.
 */
export const NAME_W = 'var(--m-name-w, clamp(140px, 65vw, 320px))';
export const COL_W = 116;
/** Each subitem level steps the name in by this much (D14 stairs, phone-sized). */
export const SUB_STEP = 14;

export const gridTemplate = (columns: number) => `${NAME_W} repeat(${columns}, ${COL_W}px)`;

type Mutations = ReturnType<typeof useBoardMutations>;

/**
 * r16mobsub: the subitems toggle of a phone row — the count, then a chevron (closed it points along the reading
 * direction, open it points down), like the desktop table's. Shown when the row has subitems (or is open); a phone
 * has no hover, so an empty row adds its first subitem from the item menu ("add subitem" opens the list here).
 */
export const SubToggle = ({ item, className }: { item: Item; className?: string }) => {
  const sub = useContext(SubitemsContext);
  if (!sub) return null;
  const n = sub.childrenOf.get(item.id)?.length ?? 0;
  const open = sub.expanded.has(item.id);
  if (!n && !open) return null;
  return (
    <button
      type="button"
      data-testid="subitems-toggle"
      aria-expanded={open}
      aria-label={t('subitems.toggle', { name: item.name })}
      title={t('subitems.count', { n })}
      onClick={(e) => {
        e.stopPropagation();
        sub.setExpanded(item.id, !open);
      }}
      className={cn(
        'flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-xs font-normal text-muted tabular-nums active:bg-surface-2',
        open && 'text-fg',
        className,
      )}
    >
      {n ? <span data-testid="subitems-count">{n}</span> : null}
      <svg
        aria-hidden
        data-testid="subitems-chevron"
        data-open={open || undefined}
        viewBox="0 0 24 24"
        width={12}
        height={12}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('shrink-0 transition-transform', open ? 'rotate-90' : 'rtl:rotate-180')}
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
};

/**
 * The sticky name cell of a phone row: a tap on the name opens the item card; ⋯ (always shown — a phone has no
 * hover) and a long press / right click open the item menu, as on the cards and the desktop table. Subitem rows
 * (`depth` ≥ 1) step in, with a rail in the group's colour.
 */
export const MobileRowName = ({
  board,
  item,
  color,
  mutations,
  onOpen,
  depth = 0,
  depthMax,
  addCells,
}: {
  board: BoardDetail;
  item: Item;
  color: string;
  mutations: Mutations;
  onOpen: () => void;
  depth?: number;
  /** The root board's `hierarchy_depth_max` (the server checks the root's limit for every level). */
  depthMax: number;
  /** the row's section value in a view grouped by a column ("add item below" gets it). */
  addCells?: Record<string, unknown>;
}) => {
  const sub = useContext(SubitemsContext);
  const selection = useContext(SelectionContext);
  const canAddSub = !!sub && canNestUnder(item, depthMax, !!board.capabilities['item.create']);
  const { menu, entries, label, dialogs } = useItemMenu(
    board,
    item,
    mutations,
    undefined,
    canAddSub ? () => sub.requestAdd(item.id) : undefined,
    undefined,
    addCells,
  );
  return (
    <div
      role="rowheader"
      onContextMenu={menu.onContextMenu}
      className="sticky start-0 z-[2] flex min-w-0 items-center border-s-4 border-e border-line bg-surface"
      style={{ borderInlineStartColor: color }}
    >
      {depth ? <SubRail depth={depth} color={color} /> : null}
      {/* select on a phone like on the desktop (the batch bar follows); a finger-sized target. */}
      {selection ? (
        <label className="grid h-full shrink-0 cursor-pointer place-items-center ps-2 pe-1">
          <input
            type="checkbox"
            data-testid="row-select"
            aria-label={t('select.item', { name: item.name })}
            checked={selection.has(item.id)}
            onChange={() => selection.toggle(item.id, false)}
            className="size-[1.125rem] cursor-pointer accent-[var(--check)]"
          />
        </label>
      ) : null}
      <SubToggle item={item} className="ms-0.5" />
      {item.name_computed ? <ComputedNameMark board={board} className="ms-1" /> : null}
      <button
        type="button"
        data-testid="mobile-item-name"
        onClick={onOpen}
        onKeyDown={menu.onKeyDown}
        className={cn(
          'flex h-full min-w-0 flex-1 items-center gap-1.5 text-start text-[0.8125rem] text-fg active:bg-surface-2',
          // a computed name in the secondary ink.
          item.name_computed && 'text-fg-2',
          sub?.childrenOf.get(item.id)?.length || sub?.expanded.has(item.id) ? 'ps-0.5' : 'ps-2.5',
        )}
      >
        <span
          data-testid="mobile-item-name-text"
          className="line-clamp-2 min-w-0 leading-[1.2] break-words group-data-[narrow]/mtable:line-clamp-1"
        >
          {item.name}
        </span>
      </button>
      <MenuTrigger label={label} onClick={menu.fromTrigger} className="me-1 opacity-100" />
      <Menu at={menu.at} onClose={menu.close} items={entries} label={label} />
      {dialogs}
    </div>
  );
};

/** The indent of a subitem level inside the sticky name cell, ending in a short rail in the group's colour. */
export const SubRail = ({ depth, color }: { depth: number; color: string }) => (
  <span aria-hidden className="flex h-full shrink-0 justify-end" style={{ width: depth * SUB_STEP }}>
    <span className="h-full w-0.5 opacity-60" style={{ backgroundColor: color }} />
  </span>
);

/**
 * One row of the phone table (an item, or a subitem with `depth`): the sticky name cell, then each column's own
 * cell — a tap opens that column's editor as a bottom sheet (`PopoverSheetContext`).
 */
export const MobileGridRow = ({
  board,
  item,
  columns,
  members,
  mutations: m,
  color,
  onOpen,
  depth = 0,
  depthMax,
  addCells,
}: {
  board: BoardDetail;
  item: Item;
  columns: Column[];
  members: Member[];
  mutations: Mutations;
  color: string;
  onOpen: () => void;
  depth?: number;
  depthMax: number;
  addCells?: Record<string, unknown>;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const canEdit = !!board.capabilities['item.update'];
  // r18board 1: a subitem shown only as the path to a deeper filter match — dimmed, with a tooltip saying why.
  const paths = useContext(SubitemsContext)?.pathOnly;
  const pathOnly = !!depth && !!paths?.has(item.id);
  return (
    <div
      role="row"
      data-testid="item-row"
      data-item-name={item.name}
      data-item-id={item.id}
      data-depth={depth || undefined}
      data-path-only={pathOnly || undefined}
      data-tip={pathOnly ? t('r18.board.pathOnly') : undefined}
      className={cn('grid h-10 border-b border-line-soft', !depth && 'last:border-b-0', pathOnly && 'opacity-55')}
      style={{ gridTemplateColumns: gridTemplate(columns.length) }}
    >
      <MobileRowName
        board={board}
        item={item}
        color={color}
        mutations={m}
        onOpen={onOpen}
        depth={depth}
        depthMax={depthMax}
        addCells={addCells}
      />
      {columns.map((c) => {
        const Cell = cellFor(c);
        const cell = item.cells[c.id];
        return (
          <div
            key={c.id}
            role="cell"
            data-column={c.id}
            data-column-type={c.type}
            className="relative min-w-0 border-e border-line-soft text-[0.8125rem] [&_button:enabled]:cursor-pointer"
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
                onChange={(value) => m.setCell.mutate({ itemId: item.id, columnId: c.id, value })}
                canEditSettings={false}
                onSettingsChange={() => Promise.resolve()}
              />
            ) : (
              <div className="flex h-full items-center px-2 text-muted">
                <span className="truncate" dir="auto">
                  {cell?.text ?? null}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/** A header row of the phone table (the board's, or a subitem list's): the name column, then the columns. */
export const MobileHeaderRow = ({
  nameTitle,
  columns,
  color,
  depth = 0,
  className,
  testId,
  lead,
}: {
  nameTitle: string;
  columns: Column[];
  color: string;
  depth?: number;
  className?: string;
  testId: string;
  lead?: ReactNode;
}) => (
  <div
    role="row"
    data-testid={testId}
    data-depth={depth || undefined}
    className={cn('grid h-8 border-b border-line text-[0.6875rem] font-semibold text-muted', className)}
    style={{ gridTemplateColumns: gridTemplate(columns.length) }}
  >
    <div
      role="columnheader"
      className="sticky start-0 z-[1] flex min-w-0 items-center border-s-4 border-e border-line bg-inherit"
      style={{ borderInlineStartColor: color }}
    >
      {depth ? <SubRail depth={depth} color={color} /> : null}
      {lead}
      <span className="truncate px-2.5">{nameTitle}</span>
    </div>
    {columns.map((c) => (
      <div
        key={c.id}
        role="columnheader"
        data-header={c.id}
        className="flex items-center justify-center border-e border-line px-1.5 text-center"
      >
        <span className="truncate">{c.title}</span>
      </div>
    ))}
  </div>
);
