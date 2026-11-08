// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useMemo, useState, type FormEvent } from 'react';
import {
  paint,
  rankBetween,
  readIds,
  t,
  type Column,
  type Field,
  type QueryEnv,
  type ViewSettings,
} from '@bines/shared';
import { cn, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { tagVars } from '../../../lib/label-color';
import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import type { BoardDetail, Item, Member, useBoardMutations } from '../board-api';
import { safeField } from '../toolbar/filter-model';
import { LabelEditor, type EditableLabel } from '../cells/LabelEditor';
import { Popover } from '../cells/Popover';
import { Icon } from '../../../lib/icons';
import { ItemTile } from './ItemTile';

type Label = { id: number; label: string; color?: string; index?: number; is_deactivated?: boolean };
type Lane = { key: string; label: string; color: string; items: Item[] };
const EMPTY = '__empty__';

/** Columns a Kanban can be built on: status and dropdown (11-UI §4). */
export const kanbanColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return f && (f.model === 'label' || f.model === 'labels');
  });

/** Column types a card shows by default (F4: status, person, number, date) — glanceable values, in this order. */
const CARD_TYPES = ['status', 'people', 'numbers', 'date', 'timeline', 'dropdown', 'tags'];

/**
 * Fields shown on cards when the view doesn't choose: up to four glanceable columns (first of each type, in the
 * F4 order) besides the lane column — not simply the first columns, which are often text / phone / email that
 * most items leave empty (cards then showed only titles). Falls back to the first columns.
 */
export const defaultCardFields = (board: BoardDetail, except?: string) => {
  const candidates = board.columns.filter((c) => c.type !== 'name' && c.id !== except);
  const picked = CARD_TYPES.flatMap((type) => candidates.find((c) => c.type === type) ?? []).slice(0, 4);
  return picked.length ? picked : candidates.slice(0, 3);
};

/** The view's chosen card fields, in the order chosen (ids of deleted columns are skipped). */
export const chosenFields = (board: BoardDetail, ids: string[]) =>
  ids.flatMap((id) => board.columns.find((c) => c.id === id) ?? []);

const laneId = (key: string) => `lane:${key}`;
/** A card's id is fixed for the whole drag (its starting lane), even while it is shown in another lane. */
const cardId = (lane: string, itemId: string) => `card:${lane}:${itemId}`;
const itemIdOf = (id: string) => id.split(':').slice(2).join(':');

/** Ranks can tie across groups; fall back to "right after the previous card". */
const safeRank = (a: string | null, b: string | null) => {
  try {
    return rankBetween(a, b);
  } catch {
    return rankBetween(a, null);
  }
};

/** Card drags look at cards and lanes; lane drags only at lanes. */
const collision: CollisionDetection = (args) =>
  args.active.data.current?.type === 'lane'
    ? closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === 'lane'),
      })
    : closestCorners(args);

type Drag = { kind: 'card'; id: string; from: string; order: Record<string, string[]> } | { kind: 'lane'; key: string };

/**
 * Kanban (11-UI §4): one lane per label of a status/dropdown column (+ blank). Cards drag
 * within a lane (sets their order) and across lanes (sets the value too); the card floats above everything and
 * the others make room where it will land. Lanes drag by their header; their order is a view setting.
 */
export const KanbanView = ({
  board,
  items,
  settings,
  env,
  members,
  mutations: m,
  update,
  sorted,
  windowed,
}: {
  /**
   * A windowed board (perf review §7.1): `items` are the loaded first cards of each lane; `totals` = each lane's
   * real size (by lane key) from the server, `onMore` loads more of a lane.
   */
  windowed?: { totals: Record<string, number>; onMore: (laneKey: string) => void };
  board: BoardDetail;
  items: Item[];
  settings: ViewSettings;
  env: QueryEnv;
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
  update: (fn: (s: ViewSettings) => ViewSettings) => void;
  /** With a sort in the view, a card's place in its lane comes from the sort, so drops only change lanes. */
  sorted: boolean;
}) => {
  const choices = kanbanColumns(board, env);
  const laneColumn = choices.find((c) => c.id === settings.kanban?.column_id) ?? choices[0];
  const field = laneColumn ? safeField(laneColumn.id, env) : null;
  const fields = useMemo(() => {
    const chosen = settings.kanban?.card_fields;
    return chosen?.length ? chosenFields(board, chosen) : defaultCardFields(board, laneColumn?.id);
  }, [settings.kanban?.card_fields, board, laneColumn?.id]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [drag, setDrag] = useState<Drag | null>(null);
  const canMove = !!board.capabilities['item.update'];
  const laneOrder = settings.kanban?.lane_order;

  const lanes = useMemo<Lane[]>(() => {
    if (!field || field.source !== 'column') return [];
    const labels = ((field.settings.labels as Label[]) ?? [])
      .filter((l) => !l.is_deactivated)
      .sort((a, b) => (a.index ?? a.id) - (b.index ?? b.id));
    const byLane = new Map<string, Item[]>([[EMPTY, []], ...labels.map((l) => [String(l.id), []] as [string, Item[]])]);
    for (const it of items) {
      const ids = readIds(it, field);
      if (!ids.length) byLane.get(EMPTY)!.push(it);
      for (const id of ids) byLane.get(id)?.push(it);
    }
    const all: Lane[] = [
      ...labels.map((l) => ({
        key: String(l.id),
        label: l.label,
        color: paint(l.color) ?? paint('blue'),
        items: byLane.get(String(l.id))!,
      })),
      { key: EMPTY, label: t('filter.blank'), color: 'var(--status-empty)', items: byLane.get(EMPTY)! },
    ];
    const rank = (k: string) => {
      const i = laneOrder?.indexOf(k) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ordered = all
      .map((l, i) => ({ l, i }))
      .sort((a, b) => rank(a.l.key) - rank(b.l.key) || a.i - b.i)
      .map((x) => x.l);
    return settings.kanban?.show_empty === false
      ? ordered.filter((l) => l.items.length || windowed?.totals[l.key])
      : ordered;
  }, [field, items, settings.kanban?.show_empty, laneOrder, windowed]);

  if (!laneColumn || !field) return <p className="py-16 text-center text-sm text-muted">{t('kanban.noColumn')}</p>;

  const byId = new Map(items.map((i) => [i.id, i]));
  /** Card ids per lane: during a card drag, the live order (with the card in the lane it hovers). */
  const cardsOf = (lane: Lane) =>
    drag?.kind === 'card' ? (drag.order[lane.key] ?? []) : lane.items.map((i) => cardId(lane.key, i.id));
  const laneOfCard = (order: Record<string, string[]>, id: string) =>
    Object.keys(order).find((k) => order[k]!.includes(id));

  const onDragStart = ({ active }: DragStartEvent) => {
    if (active.data.current?.type === 'lane') return setDrag({ kind: 'lane', key: active.data.current.key as string });
    const order = Object.fromEntries(lanes.map((l) => [l.key, l.items.map((i) => cardId(l.key, i.id))]));
    setDrag({ kind: 'card', id: String(active.id), from: active.data.current?.lane as string, order });
  };

  // Moving over another lane: the card joins it now, so its cards make room where it would land.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (drag?.kind !== 'card' || !over) return;
    const order = drag.order;
    const fromLane = laneOfCard(order, String(active.id));
    const overData = over.data.current;
    const toLane = overData?.type === 'lane' ? (overData.key as string) : laneOfCard(order, String(over.id));
    if (!fromLane || !toLane || fromLane === toLane) return;
    const target = order[toLane]!.filter((id) => id !== active.id);
    const at = overData?.type === 'lane' ? target.length : Math.max(0, target.indexOf(String(over.id)));
    target.splice(at, 0, String(active.id));
    setDrag({
      ...drag,
      order: { ...order, [fromLane]: order[fromLane]!.filter((id) => id !== active.id), [toLane]: target },
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const current = drag;
    setDrag(null);
    if (!current || !over) return;
    if (current.kind === 'lane') {
      if (active.id === over.id) return;
      const keys = lanes.map((l) => laneId(l.key));
      const next = arrayMove(keys, keys.indexOf(String(active.id)), keys.indexOf(String(over.id)));
      update((s) => ({
        ...s,
        kanban: { card_fields: [], show_empty: true, ...s.kanban, lane_order: next.map((k) => k.slice(5)) },
      }));
      return;
    }
    const order = current.order;
    const toLane = laneOfCard(order, String(active.id));
    if (!toLane) return;
    let list = order[toLane]!;
    if (over.id !== active.id && list.includes(String(over.id)))
      list = arrayMove(list, list.indexOf(String(active.id)), list.indexOf(String(over.id)));
    void commit(itemIdOf(String(active.id)), current.from, toLane, list.map(itemIdOf));
  };

  /** The new cell value when a card moves from one lane to another. */
  const valueFor = (item: Item, f: Field, from: string, to: string): unknown => {
    if (f.model === 'label') return to === EMPTY ? null : { index: Number(to) };
    const ids = readIds(item, f).filter((id) => id !== from);
    const next = to === EMPTY ? [] : [...new Set([...ids, to])];
    return next.length ? { ids: next.map(Number) } : null;
  };

  /**
   * a new card in a lane gets the lane's value (none in the empty lane, or when I may not edit the
   * column — the server would refuse the whole item).
   */
  const laneCells = (key: string): Record<string, unknown> | undefined =>
    key === EMPTY || laneColumn.restricted_edit || laneColumn.read_only
      ? undefined
      : { [laneColumn.id]: valueFor({ cells: {} } as Item, field, EMPTY, key) };

  const commit = async (itemId: string, from: string, to: string, laneItemIds: string[]) => {
    const item = byId.get(itemId);
    if (!item) return;
    const at = laneItemIds.indexOf(itemId);
    const prev = byId.get(laneItemIds[at - 1] ?? '') ?? null;
    const next = byId.get(laneItemIds[at + 1] ?? '') ?? null;
    const before = lanes.find((l) => l.key === from)?.items.map((i) => i.id) ?? [];
    const moved = from !== to || before.indexOf(itemId) !== at;
    if (!moved) return;
    if (from !== to) {
      const value = valueFor(item, field, from, to);
      const labels = ((field.source === 'column' && field.settings.labels) || []) as Label[];
      const text =
        value === null
          ? null
          : (field.model === 'label' ? [Number(to)] : (value as { ids: number[] }).ids)
              .map((id) => labels.find((l) => l.id === id)?.label ?? '')
              .join(', ');
      m.patchItem(itemId, (i) => {
        const cells = { ...i.cells };
        if (value === null) delete cells[laneColumn.id];
        else cells[laneColumn.id] = { value, text };
        return { ...i, cells };
      });
    }
    if (!sorted && item.group_id) {
      m.patchItem(itemId, (i) => ({ ...i, position: safeRank(prev?.position ?? null, next?.position ?? null) }));
    }
    // One after the other, so the second answer (the whole item) already carries the first change.
    if (from !== to)
      await m.setCell.mutateAsync({ itemId, columnId: laneColumn.id, value: valueFor(item, field, from, to) });
    if (!sorted && item.group_id)
      m.placeItem.mutate({ itemId, groupId: item.group_id, afterId: prev?.id ?? null, beforeId: next?.id ?? null });
  };

  /** N7: lane ⋯ → move one place towards the start / end (the same view setting as dragging a lane). */
  const moveLane = (key: string, dir: -1 | 1) => {
    const keys = lanes.map((l) => l.key);
    const at = keys.indexOf(key);
    if (at < 0 || !keys[at + dir]) return;
    const next = arrayMove(keys, at, at + dir);
    update((s) => ({ ...s, kanban: { card_fields: [], show_empty: true, ...s.kanban, lane_order: next } }));
  };
  const canEditLabels = !!board.capabilities['column.update'];
  const saveLabels = (labels: EditableLabel[]) =>
    m.updateColumn.mutateAsync({ columnId: laneColumn.id, settings: { ...laneColumn.settings, labels } });
  const allLabels = ((field.source === 'column' && field.settings.labels) || []) as EditableLabel[];

  const activeItem = drag?.kind === 'card' ? byId.get(itemIdOf(drag.id)) : undefined;
  const activeLane = drag?.kind === 'lane' ? lanes.find((l) => l.key === drag.key) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDrag(null)}
    >
      <SortableContext items={lanes.map((l) => laneId(l.key))} strategy={horizontalListSortingStrategy}>
        <div className="flex items-start gap-3 overflow-x-auto pb-4" data-testid="kanban">
          {lanes.map((lane, i) => (
            <LaneView
              key={lane.key}
              lane={lane}
              cards={cardsOf(lane)}
              byId={byId}
              board={board}
              fields={fields}
              env={env}
              members={members}
              mutations={m}
              canMove={canMove}
              addCells={laneCells(lane.key)}
              onAdd={(name) => m.createItem.mutate({ name, groupId: board.groups[0]!.id, cells: laneCells(lane.key) })}
              canAdd={!!board.capabilities['item.create'] && board.groups.length > 0}
              onMove={
                lanes.length > 1
                  ? {
                      start: i > 0 ? () => moveLane(lane.key, -1) : undefined,
                      end: i < lanes.length - 1 ? () => moveLane(lane.key, 1) : undefined,
                    }
                  : undefined
              }
              labels={
                canEditLabels ? { all: allLabels, withColor: field.model === 'label', save: saveLabels } : undefined
              }
              more={
                windowed
                  ? { total: windowed.totals[lane.key] ?? lane.items.length, load: () => windowed.onMore(lane.key) }
                  : undefined
              }
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activeItem ? (
          <ItemTile
            item={activeItem}
            fields={fields}
            env={env}
            members={members}
            boardId={board.id}
            variant="kanban"
            className="w-[248px] rotate-2 cursor-grabbing border-primary shadow-[var(--shadow-pop)]"
          />
        ) : activeLane ? (
          <div
            className="label-tag flex w-72 items-center justify-between rounded-[var(--radius)] px-3 py-2 text-sm shadow-[var(--shadow-pop)]"
            style={tagVars(activeLane.color)}
          >
            <span>{activeLane.label}</span>
            <span className="text-xs">{activeLane.items.length}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

const LaneView = ({
  lane,
  cards,
  byId,
  board,
  fields,
  env,
  members,
  canMove,
  onAdd,
  canAdd,
  mutations,
  onMove,
  labels,
  more,
  addCells,
}: {
  /** A windowed board: the lane's real size, and how to load more of its cards. */
  more?: { total: number; load: () => void };
  lane: Lane;
  cards: string[];
  byId: Map<string, Item>;
  board: BoardDetail;
  fields: Column[];
  env: QueryEnv;
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
  canMove: boolean;
  onAdd: (name: string) => void;
  canAdd: boolean;
  /** the lane's value — a new card (the lane's "+", a card's "add item below") gets it. */
  addCells?: Record<string, unknown>;
  /** Lane ⋯: move towards the start / end (missing at the edges). */
  onMove?: { start?: () => void; end?: () => void };
  /** Lane ⋯: edit the lane column's labels (with `column.update`). */
  labels?: { all: EditableLabel[]; withColor: boolean; save: (labels: EditableLabel[]) => Promise<unknown> };
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: laneId(lane.key),
    data: { type: 'lane', key: lane.key },
  });
  const [name, setName] = useState('');
  const inputId = useId();
  const menu = useActionMenu();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (next: EditableLabel[], opts?: { leaving?: boolean }) => {
    if (!labels) return;
    setBusy(true);
    try {
      await labels.save(next);
      // Saved on leaving: the editor is closed already and may be open again by now.
      if (!opts?.leaving) setEditing(false);
    } catch {
      // The board shows the mutation error; the editor stays open with the user's changes.
    } finally {
      setBusy(false);
    }
  };
  // N7: only actions that work here — a new item in this lane, edit the labels, move the lane.
  const entries: MenuEntry[] = [
    ...(canAdd
      ? [
          {
            label: t('kanban.lane.addItem'),
            icon: <Icon name="plus" />,
            onSelect: () => document.getElementById(inputId)?.focus(),
          },
        ]
      : []),
    ...(labels ? [{ label: t('labels.edit'), icon: <Icon name="edit" />, onSelect: () => setEditing(true) }] : []),
    ...(onMove
      ? [
          { kind: 'separator' as const },
          {
            label: t('kanban.lane.moveStart'),
            icon: <Icon name="chevronStart" />,
            disabled: !onMove.start,
            onSelect: () => onMove.start?.(),
          },
          {
            label: t('kanban.lane.moveEnd'),
            icon: <Icon name="chevronEnd" />,
            disabled: !onMove.end,
            onSelect: () => onMove.end?.(),
          },
        ]
      : []),
  ];
  const menuLabel = t('kanban.laneMenu', { name: lane.label });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd(name.trim());
    setName('');
  };
  return (
    <section
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn(
        'flex w-[270px] shrink-0 flex-col gap-2 rounded-[16px] border border-line-soft bg-surface-3 p-2.5 transition-shadow',
        isDragging && 'opacity-40',
        isOver && 'ring-2 ring-primary',
      )}
      data-testid="kanban-lane"
      data-lane={lane.label}
    >
      {/* The header drags the lane; its ⋯ (F4) and the label editor sit beside it, outside the drag handle. */}
      <div className="relative flex h-8 items-center gap-1">
        <header
          {...attributes}
          {...listeners}
          className="flex h-8 min-w-0 flex-1 cursor-grab items-center gap-2 px-1 active:cursor-grabbing"
          aria-label={t('kanban.dragLane', { name: lane.label })}
        >
          {/* F4: the lane's colour as a bar next to its title, like a group. */}
          <span aria-hidden className="h-4 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: lane.color }} />
          <span className="min-w-0 truncate font-display text-[0.9375rem] font-extrabold text-heading">
            {lane.label}
          </span>
          <span
            className="shrink-0 rounded-full bg-surface-2 px-2 py-px text-xs font-normal text-fg-2 tabular-nums"
            data-testid="lane-count"
          >
            {more?.total ?? cards.length}
          </span>
        </header>
        {entries.length ? (
          <>
            <button
              type="button"
              data-testid="lane-menu"
              aria-haspopup="menu"
              aria-label={menuLabel}
              title={t('menu.actions')}
              onClick={menu.fromTrigger}
              className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-fg-2 hover:bg-surface-2 hover:text-fg"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="5" cy="12" r="1.3" />
                <circle cx="12" cy="12" r="1.3" />
                <circle cx="19" cy="12" r="1.3" />
              </svg>
            </button>
            <Menu at={menu.at} onClose={menu.close} items={entries} label={menuLabel} />
          </>
        ) : null}
        {labels ? (
          <Popover open={editing} onClose={() => setEditing(false)}>
            <LabelEditor
              labels={labels.all}
              withColor={labels.withColor}
              maxLength={labels.withColor ? 30 : 100}
              busy={busy}
              onSave={(l, o) => void save(l, o)}
              onCancel={() => setEditing(false)}
            />
          </Popover>
        ) : null}
      </div>
      <SortableContext items={cards} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-10 min-w-0 flex-col gap-2" data-testid="kanban-cards">
          {cards.map((id) => {
            const item = byId.get(itemIdOf(id));
            return item ? (
              <SortableCard
                key={id}
                id={id}
                lane={lane.key}
                item={item}
                board={board}
                fields={fields}
                env={env}
                members={members}
                mutations={mutations}
                canMove={canMove}
                addCells={addCells}
              />
            ) : null;
          })}
        </div>
      </SortableContext>
      {more && more.total > cards.length ? (
        <button
          type="button"
          data-testid="show-more"
          className="h-8 rounded-[10px] text-sm text-primary hover:bg-surface-2"
          onClick={more.load}
        >
          {t('windowed.showMore', { n: more.total - cards.length })}
        </button>
      ) : null}
      {canAdd ? (
        // F4: looks like a ghost small button ("+ פריט חדש") and types in place.
        <form onSubmit={submit}>
          <input
            id={inputId}
            data-testid="lane-add-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('kanban.addItem')}
            className="h-8 w-full rounded-[10px] bg-transparent px-2.5 text-sm text-fg outline-none placeholder:text-fg-2 hover:bg-surface-2 focus:bg-surface focus:ring-1 focus:ring-line-strong"
          />
        </form>
      ) : null}
    </section>
  );
};

const SortableCard = ({
  id,
  lane,
  item,
  board,
  fields,
  env,
  members,
  mutations,
  canMove,
  addCells,
}: {
  id: string;
  lane: string;
  item: Item;
  board: BoardDetail;
  fields: Column[];
  env: QueryEnv;
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
  canMove: boolean;
  addCells?: Record<string, unknown>;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: 'card', lane },
    disabled: !canMove,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn(
        'min-w-0',
        canMove && 'cursor-grab',
        // The card being dragged stays as a dashed slot: that is where it will land.
        isDragging && 'rounded-[12px] border-2 border-dashed border-primary bg-primary-soft [&>*]:invisible',
      )}
    >
      <ItemTile
        item={item}
        fields={fields}
        env={env}
        members={members}
        boardId={board.id}
        variant="kanban"
        menu={{ board, mutations, addCells }}
        dragHandle={{ ...attributes, ...listeners }}
      />
    </div>
  );
};
