// SPDX-License-Identifier: AGPL-3.0-only
import {
  Fragment,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { t, type Column, type QueryEnv } from '@bines/shared';
import { Skeleton } from '@bines/ui';
import type { BoardDetail, Item, Member, useBoardMutations } from '../board-api';
import { isStub } from '../windowed';
import { ItemTile } from '../views/ItemTile';
import { useOpenItem } from '../open-item';
import { Icon } from '../../../lib/icons';
import { inkFor } from '../../../lib/label-color';
import { GroupSummary, SelectAllBox, SubitemsContext, type GroupSummarySetting, type Section } from './BoardTable';
import { PopoverSheetContext } from '../cells/Popover';
import { MobileGridRow, MobileHeaderRow } from './MobileRow';
import { CardSubitems, MobileSubtree } from './MobileSubitems';
import { useScrollNameWidth } from './mobile-name-width';
import { computedNameInfo } from '../name-source/name-source-api';
import { revealNewItem } from './reveal-new-item';
import { visibleSections } from '../nested-sections';
import { BoardAccountContext } from '../board-context';
import { useItemTemplates } from '../../item-templates/item-templates-api';
import { openItemTemplates } from '../../item-templates/store';

/** Where "+ item" creates: the grouping's seed, or the board group itself. */
const seedOf = (s: Section) => s.seed ?? (s.group ? { groupId: s.group.id, cells: {} } : undefined);

/**
 * The glance line of a phone row (F4): the view's first status, date (or timeline), number and people columns —
 * status + date at the start, number + avatar at the end; shown when the item has any of them.
 */
const GLANCE: string[][] = [['status'], ['date', 'timeline'], ['numbers'], ['people']];

type MobileProps = {
  /** A windowed board: rows shown are reported so they load (see `Paged`). */
  onRange?: (ids: string[], source?: string) => void;
  board: BoardDetail;
  sections: Section[];
  columns: Column[];
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  env: QueryEnv;
  /** N3: the view's one field summarised next to each group's name (off = null). */
  groupSummary?: GroupSummarySetting | null;
};

/**
 * The table view on a phone. Round 12 (product owner: "on mobile it behaves like cards, not like a board table"): a real
 * table by default (`MobileGrid`); the view's settings can switch it back to the cards
 * (`mobile_layout: 'cards'`).
 */
export const MobileTable = ({ layout = 'table', ...props }: MobileProps & { layout?: 'table' | 'cards' }) =>
  layout === 'cards' ? <MobileCards {...props} /> : <MobileGrid {...props} />;

/**
 * The cards layout (F4 canvas): the same sections and items as cards — name, then the first few glanceable
 * columns of the view. A tap opens the item card; its ⋯ / long-press menu is the item menu.
 */
const MobileCards = ({
  board,
  sections,
  columns,
  members,
  mutations,
  collapsed,
  onToggle,
  env,
  groupSummary = null,
  onRange,
}: MobileProps) => {
  const fields = useMemo(
    () =>
      GLANCE.map((types) => types.map((type) => columns.find((c) => c.type === type)).find(Boolean)).filter(
        (c): c is Column => !!c,
      ),
    [columns],
  );
  const term = board.item_terminology === 'item' ? t('board.itemDefault') : board.item_terminology;
  // r26: a board that computes names adds with one tap — no name field, no keyboard.
  const computed = computedNameInfo(board).computed;
  return (
    <div className="flex flex-col gap-3.5 pb-6" data-testid="mobile-table" data-layout="cards">
      {visibleSections(sections, collapsed).map((s) => {
        const open = !collapsed.has(s.key);
        return (
          <section key={s.key} className="flex flex-col gap-1.5" data-testid="board-section" data-section={s.key}>
            <button
              type="button"
              onClick={() => onToggle(s.key)}
              aria-expanded={open}
              aria-label={open ? t('board.collapseGroup') : t('board.expandGroup')}
              className="flex h-[1.875rem] items-center gap-2"
            >
              <span className="text-muted">
                <Icon name={open ? 'chevronDown' : 'chevronEnd'} size={13} strokeWidth={2.4} />
              </span>
              <span aria-hidden className="h-5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="font-display text-base font-extrabold" style={{ color: inkFor(s.color) }}>
                {s.title}
              </span>
              <span
                className="rounded-full bg-surface-2 px-2 py-px text-xs font-normal text-fg-2 tabular-nums"
                title={t('board.items', { n: s.items.length })}
              >
                <span aria-hidden>{s.count ?? s.items.length}</span>
                <span className="sr-only">{t('board.items', { n: s.items.length })}</span>
              </span>
              {groupSummary && s.items.length ? (
                <GroupSummary setting={groupSummary} board={board} items={s.items} env={env} pre={s.groupSummary} />
              ) : null}
            </button>
            {open && !s.header && (s.items.length || (seedOf(s) && board.capabilities['item.create'])) ? (
              // F4: the group's items as rows of one bordered box.
              <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
                <Paged items={s.items} onRange={onRange}>
                  {(it) =>
                    isStub(it) ? (
                      <div key={it.id} className="flex h-14 items-center px-3" data-testid="row-loading">
                        <Skeleton className="h-3 w-40" />
                      </div>
                    ) : (
                      // r16mobsub: a card with subitems gets a count chip that opens a compact list of them.
                      <div key={it.id} className="border-b border-line-soft last:border-b-0">
                        <ItemTile
                          item={it}
                          fields={fields}
                          env={env}
                          members={members}
                          boardId={board.id}
                          variant="row"
                          className="border-b-0"
                          menu={{ board, mutations, addCells: s.seed?.cells }}
                        />
                        <CardSubitems parent={it} board={board} env={env} members={members} color={s.color} />
                      </div>
                    )
                  }
                </Paged>
                {seedOf(s) && board.capabilities['item.create'] ? (
                  <QuickAdd
                    placeholder={t('board.addItem', { item: term })}
                    data-add-item
                    boardId={board.id}
                    seed={seedOf(s)!}
                    mutations={mutations}
                    computed={computed}
                  />
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
};

/** A windowed board on a phone: this many rows per section at first, and as many more per "show more". */
const PAGE = 50;

/**
 * The rows of a section: all of them on a normal board; on a windowed one (`onRange`) the first pages only —
 * reported as on screen so they load — with a "show more" button.
 */
export const Paged = ({
  items,
  onRange,
  children,
}: {
  items: Item[];
  onRange?: (ids: string[], source?: string) => void;
  children: (item: Item) => ReactNode;
}) => {
  const [limit, setLimit] = useState(PAGE);
  const source = useId();
  const shown = useMemo(() => (onRange ? items.slice(0, limit) : items), [items, limit, onRange]);
  useEffect(() => {
    if (onRange && shown.length)
      onRange(
        shown.map((i) => i.id),
        source,
      );
  }, [onRange, shown, source]);
  return (
    <>
      {shown.map(children)}
      {shown.length < items.length ? (
        <button
          type="button"
          className="h-10 w-full text-sm text-primary hover:bg-surface-2"
          data-testid="show-more"
          onClick={() => setLimit((n) => n + PAGE)}
        >
          {t('windowed.showMore', { n: Math.min(PAGE, items.length - shown.length) })}
        </button>
      ) : null}
    </>
  );
};

/**
 * Prod (phase 2): "+ from a template" next to the phone's add field — the board's item templates, in the
 * apply dialog the desktop uses (into this group). Shown only when the board has templates.
 */
const FromTemplate = ({ boardId, groupId }: { boardId: string; groupId: string }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const templates = useItemTemplates(accountId, boardId).data ?? [];
  if (!templates.length) return null;
  return (
    <button
      type="button"
      onClick={() => openItemTemplates({ kind: 'apply', boardId, groupId })}
      aria-label={t('board.addFromTemplate')}
      title={t('board.addFromTemplate')}
      data-testid="mobile-add-from-template"
      className="grid size-11 shrink-0 place-items-center text-muted active:bg-surface-3"
    >
      <Icon name="template" size={17} />
    </button>
  );
};

const QuickAdd = (props: Parameters<typeof QuickAddField>[0] & { boardId: string }) => {
  const { boardId, ...rest } = props;
  return (
    <div className="flex items-center">
      <div className="min-w-0 flex-1">
        <QuickAddField {...rest} />
      </div>
      {props.seed.groupId ? <FromTemplate boardId={boardId} groupId={props.seed.groupId} /> : null}
    </div>
  );
};

const QuickAddField = ({
  placeholder,
  seed,
  mutations: m,
  computed,
  'data-add-item': addItem,
}: {
  placeholder: string;
  seed: NonNullable<Section['seed']>;
  mutations: ReturnType<typeof useBoardMutations>;
  /** The board computes item names: a button, not a field — the server names the new item. */
  computed?: boolean;
  /** marks the field (or button) the empty board's "add a first item" goes to — it was dropped here. */
  'data-add-item'?: boolean;
}) => {
  const [name, setName] = useState('');
  // r26: one tap creates the item (no keyboard on the phone). r27: it does not open the card — the new
  // row is shown (scrolled to, lit briefly); a tap on its name opens it.
  if (computed)
    return (
      <button
        type="button"
        data-testid="mobile-add-computed-item"
        data-add-item={addItem || undefined}
        disabled={m.createItem.isPending}
        onClick={() =>
          m.createItem.mutate({ groupId: seed.groupId, cells: seed.cells }, { onSuccess: (it) => revealNewItem(it.id) })
        }
        className="flex h-11 w-full items-center px-3 text-start text-sm text-muted active:bg-surface-3 disabled:opacity-50"
      >
        + {t('name.newItem')}
      </button>
    );
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setName('');
    m.createItem.mutate(
      { name: value, groupId: seed.groupId, cells: seed.cells },
      { onError: () => setName((cur) => cur || value) },
    );
  };
  return (
    <form onSubmit={onSubmit}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={placeholder}
        data-add-item={addItem || undefined}
        className="h-11 w-full bg-transparent px-3 text-sm outline-none placeholder:text-muted focus:bg-surface-3"
      />
    </form>
  );
};

/**
 * Round 12 — the phone's table: the name column stays at the inline-start edge while the other
 * columns scroll sideways under the group's header row, compact rows, the group headers (colour, name, count,
 * collapse). A tap on a cell opens that column's own editor as a bottom sheet (`PopoverSheetContext`); a tap on
 * the name opens the item card; "+ item" at the end of each group.
 */
const MobileGrid = ({
  board,
  sections,
  columns,
  members,
  mutations: m,
  collapsed,
  onToggle,
  env,
  groupSummary = null,
  onRange,
}: MobileProps) => {
  const term = board.item_terminology === 'item' ? t('board.itemDefault') : board.item_terminology;
  const nameTitle = board.columns.find((c) => c.type === 'name')?.title || term;
  const openItem = useOpenItem(board.parent_board_id ?? board.id);
  // r26: a board that computes names adds with one tap — no name field, no keyboard.
  const computed = computedNameInfo(board).computed;
  // r16mobsub: an open item's subitems follow it inline (`MobileSubtree`).
  const sub = useContext(SubitemsContext);
  // r25: the sticky name column widens toward the start of the sideways scroll (`--m-name-w`).
  const tableRef = useRef<HTMLDivElement>(null);
  useScrollNameWidth(tableRef);
  return (
    <PopoverSheetContext.Provider value>
      <div
        ref={tableRef}
        className="group/mtable w-max min-w-full pb-6"
        data-testid="mobile-table"
        data-layout="table"
        role="table"
        aria-label={board.name}
      >
        {visibleSections(sections, collapsed).map((s) => {
          const open = !collapsed.has(s.key);
          const seed = seedOf(s);
          return (
            <section key={s.key} className="mb-3" data-testid="board-section" data-section={s.key} role="rowgroup">
              {/* The group's header stays in view while the columns scroll sideways. A row with one cell: a row
                  group holds rows only (axe aria-required-children). */}
              <div role="row">
                <div role="cell">
                  <button
                    type="button"
                    onClick={() => onToggle(s.key)}
                    aria-expanded={open}
                    aria-label={open ? t('board.collapseGroup') : t('board.expandGroup')}
                    data-testid="mobile-group-header"
                    className="sticky start-0 flex h-9 max-w-[calc(100vw-2rem)] items-center gap-2"
                  >
                    <span className="text-muted">
                      <Icon name={open ? 'chevronDown' : 'chevronEnd'} size={13} strokeWidth={2.4} />
                    </span>
                    <span
                      aria-hidden
                      className="h-5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: s.color }}
                    />
                    <span
                      className="truncate font-display text-[0.9375rem] font-extrabold"
                      style={{ color: inkFor(s.color) }}
                    >
                      {s.title}
                    </span>
                    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-px text-xs font-normal text-fg-2 tabular-nums">
                      <span aria-hidden>{s.count ?? s.items.length}</span>
                      <span className="sr-only">{t('board.items', { n: s.items.length })}</span>
                    </span>
                    {groupSummary && s.items.length ? (
                      <GroupSummary
                        setting={groupSummary}
                        board={board}
                        items={s.items}
                        env={env}
                        pre={s.groupSummary}
                      />
                    ) : null}
                  </button>
                </div>
              </div>
              {open && !s.header ? (
                <div
                  // The group's colour edge belongs to the sticky name column (below), so the names never slide
                  // over it when the columns scroll sideways.
                  className="overflow-clip rounded-[10px] border border-s-0 border-line bg-surface"
                >
                  <MobileHeaderRow
                    testId="mobile-header-row"
                    nameTitle={nameTitle}
                    columns={columns}
                    color={s.color}
                    // as on the desktop, the header's box checks every item of the group.
                    lead={
                      <span className="grid shrink-0 place-items-center ps-2 pe-1">
                        <SelectAllBox
                          ids={s.items.map((i) => i.id)}
                          label={t('select.group', { name: s.title })}
                          testId="mobile-select-group"
                        />
                      </span>
                    }
                    className="sticky top-0 z-[4] bg-surface-2"
                  />
                  <Paged items={s.items} onRange={onRange}>
                    {(it) =>
                      isStub(it) ? (
                        <div key={it.id} className="flex h-10 items-center px-3" data-testid="row-loading">
                          <Skeleton className="h-3 w-40" />
                        </div>
                      ) : (
                        <Fragment key={it.id}>
                          <MobileGridRow
                            board={board}
                            item={it}
                            columns={columns}
                            members={members}
                            mutations={m}
                            color={s.color}
                            depthMax={board.hierarchy_depth_max}
                            onOpen={() => openItem(it.id)}
                            addCells={s.seed?.cells}
                          />
                          {sub?.expanded.has(it.id) ? (
                            <MobileSubtree parent={it} board={board} color={s.color} members={members} />
                          ) : null}
                        </Fragment>
                      )
                    }
                  </Paged>
                  {seed && board.capabilities['item.create'] ? (
                    <div role="row" className="sticky start-0 max-w-[calc(100vw-2rem)] border-t border-line-soft">
                      <div role="cell">
                        <QuickAdd
                          placeholder={t('board.addItem', { item: term })}
                          data-add-item
                          boardId={board.id}
                          seed={seed}
                          mutations={m}
                          computed={computed}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </PopoverSheetContext.Provider>
  );
};
