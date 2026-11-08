// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo, useState, type FormEvent } from 'react';
import { t, type Column, type QueryEnv, queryColumnOf } from '@bines/shared';
import { cn, Skeleton } from '@bines/ui';
import type { BoardDetail, Item, Member } from '../board-api';
import { useOpenItem } from '../open-item';
import { FieldValue } from '../views/ItemTile';
import { SelectAllBox, SubitemsContext } from './BoardTable';
import { SelectionContext } from '../selection';
import { MobileGridRow, MobileHeaderRow, SUB_STEP, SubRail, SubToggle } from './MobileRow';
import { subRowKey, subtreeRows } from './mobile-subitems';
import { computedNameInfo } from '../name-source/name-source-api';
import { revealNewItem } from './reveal-new-item';

/** The sub-board's columns a view shows (its hidden ones and the name column left out), like the desktop table. */
const useSubColumns = () => {
  const sub = useContext(SubitemsContext);
  const subBoard = sub?.board;
  const hidden = sub?.hiddenColumns;
  return useMemo(
    () => subBoard?.columns.filter((c) => c.type !== 'name' && !hidden?.includes(c.id)) ?? [],
    [subBoard, hidden],
  );
};

/**
 * r16mobsub — an open item's subitems inline in the phone table, as on the desktop (D14): the sub-board's own
 * header row, the subitems (indented; an open one nests its own one level further in, up to the board's depth),
 * then "+ add subitem". The rows are the table's own: tap the name for the subitem's card, a cell for its editor.
 * Which subitems show and which parents open come from `SubitemsContext` (the view's filter and subitem sort).
 */
export const MobileSubtree = ({
  parent,
  board,
  color,
  members,
}: {
  parent: Item;
  /** The board on screen (the root of the subitems). */
  board: BoardDetail;
  color: string;
  members: Member[];
}) => {
  const sub = useContext(SubitemsContext);
  const columns = useSubColumns();
  const open = useOpenItem(board.id);
  if (!sub) return null;
  const subBoard = sub.board;
  const rows = subtreeRows(parent, sub.childrenOf, sub.expanded, {
    depthMax: board.hierarchy_depth_max,
    canCreate: !!board.capabilities['item.create'],
  });
  const nameTitle = subBoard?.columns.find((c) => c.type === 'name')?.title || subBoard?.name || '';
  // subitems (any level) are checked in the subitems' own selection, as on the desktop — their batch
  // bar acts on the sub-board; each header's box checks every subitem of its parent.
  return (
    <SelectionContext.Provider value={sub.selection}>
      <div role="rowgroup" data-testid="mobile-subitems" data-parent={parent.id}>
        {rows.map((r) => {
          const key = subRowKey(r);
          if (r.kind === 'add') return <SubAdd key={key} parent={r.parent} depth={r.depth} color={color} />;
          if (!subBoard)
            // The sub-board is still loading (a board without one yet shows only "+ add subitem").
            return r.kind === 'head' && board.subitems_board_id ? (
              <div
                key={key}
                className="sticky start-0 flex h-8 max-w-[calc(100vw-2rem)] items-center border-s-4 border-b border-line-soft px-3"
                style={{ borderInlineStartColor: color, paddingInlineStart: r.depth * SUB_STEP + 12 }}
                data-testid="subitems-loading"
              >
                <Skeleton className="h-3 w-32" />
              </div>
            ) : null;
          if (r.kind === 'head')
            return (
              <MobileHeaderRow
                key={key}
                testId="mobile-subhead"
                nameTitle={nameTitle}
                columns={columns}
                color={color}
                depth={r.depth}
                lead={
                  <span className="grid shrink-0 place-items-center ps-2 pe-1">
                    <SelectAllBox
                      ids={(sub.childrenOf.get(r.parent.id) ?? []).map((c) => c.id)}
                      label={t('r15.select.subitems', { name: r.parent.name })}
                      testId="mobile-select-subitems"
                    />
                  </span>
                }
                className="h-7 border-line-soft bg-surface-2 text-[0.6875rem]"
              />
            );
          return (
            <MobileGridRow
              key={key}
              board={subBoard}
              item={r.item}
              columns={columns}
              members={members}
              mutations={sub.mutations}
              color={color}
              depth={r.depth}
              depthMax={board.hierarchy_depth_max}
              onOpen={() => open(r.item.id)}
            />
          );
        })}
      </div>
    </SelectionContext.Provider>
  );
};

/** "+ add subitem" under a parent's subitems (phone table and cards list). */
const SubAdd = ({
  parent,
  depth,
  color,
  compact,
}: {
  parent: Item;
  depth: number;
  color: string;
  compact?: boolean;
}) => {
  const sub = useContext(SubitemsContext)!;
  const [name, setName] = useState('');
  // r26: the sub-board computes names — one tap adds (no field, no keyboard); the server names it.
  // r27: the card is not opened; the new row is shown (scrolled to, lit briefly) instead.
  const computed = computedNameInfo(sub.board).computed;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (computed) {
      if (sub.mutations.createSubitem.isPending) return;
      sub.mutations.createSubitem.mutate(
        { parentId: parent.id },
        { onSuccess: (it) => revealNewItem(it.id, 'subitem') },
      );
      return;
    }
    const value = name.trim();
    if (!value) return;
    setName('');
    sub.mutations.createSubitem.mutate(
      { parentId: parent.id, name: value },
      { onError: () => setName((cur) => cur || value) },
    );
  };
  return (
    <form
      onSubmit={onSubmit}
      data-testid="mobile-subadd"
      data-parent={parent.id}
      className={cn(
        'flex items-center',
        compact
          ? 'h-9'
          : 'sticky start-0 h-10 max-w-[calc(100vw-2rem)] border-s-4 border-b border-line-soft bg-surface',
      )}
      style={compact ? { paddingInlineStart: (depth - 1) * SUB_STEP } : { borderInlineStartColor: color }}
    >
      {compact ? null : <SubRail depth={depth} color={color} />}
      {computed ? (
        <button
          type="submit"
          data-testid="mobile-add-computed-subitem"
          disabled={sub.mutations.createSubitem.isPending}
          className="flex h-full min-w-0 flex-1 items-center px-2.5 text-start text-[0.8125rem] text-muted active:bg-surface-3 disabled:opacity-50"
        >
          + {t('subitems.add')}
        </button>
      ) : (
        <input
          autoFocus={sub.focusAdd === parent.id}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('subitems.add')}
          aria-label={t('subitems.add')}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-[0.8125rem] outline-none placeholder:text-muted focus:bg-surface-3"
        />
      )}
    </form>
  );
};

/**
 * r16mobsub — the cards layout (`mobile_layout: 'cards'`): a card with subitems gets a count chip; a tap opens a
 * compact list of them under the card — name (tap = the subitem's card) and its first status, open ones nesting
 * their own, then "+ add subitem".
 */
export const CardSubitems = ({
  parent,
  board,
  env,
  members,
  color,
}: {
  parent: Item;
  board: BoardDetail;
  env: QueryEnv;
  members: Member[];
  color: string;
}) => {
  const sub = useContext(SubitemsContext);
  const open = useOpenItem(board.id);
  const subBoard = sub?.board;
  const status = useMemo(() => subBoard?.columns.find((c) => c.type === 'status'), [subBoard]);
  const subEnv = useMemo<QueryEnv>(
    () => ({
      ...env,
      columns: (subBoard?.columns ?? []).map(queryColumnOf),
    }),
    [env, subBoard],
  );
  if (!sub) return null;
  const n = sub.childrenOf.get(parent.id)?.length ?? 0;
  const expanded = sub.expanded.has(parent.id);
  if (!n && !expanded) return null;
  const rows = expanded
    ? subtreeRows(parent, sub.childrenOf, sub.expanded, {
        depthMax: board.hierarchy_depth_max,
        canCreate: !!board.capabilities['item.create'],
        head: false,
      })
    : [];
  return (
    <div className="px-3 pb-2.5" data-testid="card-subitems" data-parent={parent.id}>
      <button
        type="button"
        data-testid="card-subitems-chip"
        aria-expanded={expanded}
        aria-label={t('subitems.toggle', { name: parent.name })}
        onClick={() => sub.setExpanded(parent.id, !expanded)}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-full border border-line px-2 text-xs font-normal text-fg-2 tabular-nums active:bg-surface-2',
          expanded && 'border-line-strong bg-surface-2',
        )}
      >
        <span>{t('subitems.count', { n })}</span>
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          width={11}
          height={11}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn('shrink-0 transition-transform', expanded ? 'rotate-90' : 'rtl:rotate-180')}
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {rows.length ? (
        <SelectionContext.Provider value={sub.selection}>
          <div className="mt-1.5 border-s-2 ps-1.5" style={{ borderInlineStartColor: color }}>
            {/* one box checks every subitem of this item (their own selection and batch bar). */}
            <div className="flex h-8 items-center gap-2 border-b border-line-soft ps-1 text-xs text-muted">
              <SelectAllBox
                ids={(sub.childrenOf.get(parent.id) ?? []).map((c) => c.id)}
                label={t('r15.select.subitems', { name: parent.name })}
                testId="card-select-subitems"
              />
              <span aria-hidden>{t('mobile.select.all')}</span>
            </div>
            {rows.map((r) =>
              r.kind === 'add' ? (
                <SubAdd key={subRowKey(r)} parent={r.parent} depth={r.depth} color={color} compact />
              ) : r.kind === 'item' ? (
                <CardSubLine
                  key={subRowKey(r)}
                  item={r.item}
                  depth={r.depth}
                  status={status}
                  env={subEnv}
                  members={members}
                  onOpen={() => open(r.item.id)}
                />
              ) : null,
            )}
          </div>
        </SelectionContext.Provider>
      ) : null}
    </div>
  );
};

const CardSubLine = ({
  item,
  depth,
  status,
  env,
  members,
  onOpen,
}: {
  item: Item;
  depth: number;
  status: Column | undefined;
  env: QueryEnv;
  members: Member[];
  onOpen: () => void;
}) => {
  // r18board 1: shown only as the path to a deeper filter match — dimmed, with a tooltip saying why.
  const pathOnly = !!useContext(SubitemsContext)?.pathOnly?.has(item.id);
  const selection = useContext(SelectionContext);
  return (
    <div
      className={cn(
        'flex h-9 min-w-0 items-center gap-1 border-b border-line-soft last:border-b-0',
        pathOnly && 'opacity-55',
      )}
      style={{ paddingInlineStart: (depth - 1) * SUB_STEP }}
      data-testid="card-subitem"
      data-item-name={item.name}
      data-item-id={item.id}
      data-depth={depth}
      data-path-only={pathOnly || undefined}
      data-tip={pathOnly ? t('r18.board.pathOnly') : undefined}
    >
      {/* a subitem (any level) is checked like an item; a finger-sized target. */}
      {selection ? (
        <label className="grid h-full shrink-0 cursor-pointer place-items-center px-1.5">
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
      <SubToggle item={item} />
      <button
        type="button"
        data-testid="mobile-item-name"
        onClick={onOpen}
        className="flex h-full min-w-0 flex-1 items-center text-start text-[0.8125rem] text-fg active:bg-surface-2"
      >
        <span className="truncate">{item.name}</span>
      </button>
      {status && item.cells[status.id] ? (
        <span className="flex max-w-[45%] shrink-0 items-center">
          <FieldValue item={item} column={status} env={env} members={members} />
        </span>
      ) : null}
    </div>
  );
};
