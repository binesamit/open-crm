// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CARD_FIELDS_PER_ROW,
  cardFieldsPerRowFor,
  cardSubitemsOf,
  resolveCardTabs,
  t,
  type CardFieldsPerRow,
  type CardSubitems,
  type CardTab,
  type MessageKey,
} from '@bines/shared';
import { Button, cn, Dialog, Notice, Segmented, Switch } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { boardKeys, useBoard, type BoardDetail, type Column } from '../board/board-api';
import { cardFieldColumns } from './FieldsTab';
import { subBoardIdOf, subitemColumns } from './SubitemsTab';
import { useSubBoardViews } from './card-settings';
import { PickerButton } from '../board/toolbar/parts';

/** The default name of a card tab (shown when the board did not rename it). */
const DEFAULT_NAME: Record<CardTab['type'], MessageKey> = {
  updates: 'item.updates',
  fields: 'item.fields' as MessageKey,
  subitems: 'item.subitems' as MessageKey,
  time: 'item.time',
  activity: 'item.activity',
  documents: 'idoc.tab' as MessageKey,
};
export const cardTabName = (tab: CardTab) => tab.title?.trim() || t(DEFAULT_NAME[tab.type]);

const MAX_TABS = 20;

/** ⋮⋮ handle + the row (a sortable list item). */
const SortableRow = ({
  id,
  testId,
  dragLabel,
  children,
  className,
}: {
  id: string;
  testId: string;
  dragLabel: string;
  children: ReactNode;
  className?: string;
}) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 bg-surface px-2.5 py-2',
        isDragging && 'relative z-10 shadow-[var(--shadow-pop)]',
        className,
      )}
      data-testid={testId}
      data-id={id}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={dragLabel}
        title={dragLabel}
        className="cursor-grab px-0.5 text-muted hover:text-fg active:cursor-grabbing"
      >
        ⋮⋮
      </button>
      {children}
    </li>
  );
};

const useListSensors = () =>
  useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

/**
 * Picks and orders the columns of one tab: a "fields" tab (the board's columns) or the "subitems" tab (the
 * sub-board's columns shown next to each subitem's name).
 */
const FieldsPicker = ({
  tab,
  all,
  chosen,
  fallback,
  title,
  testId = 'card-tab-fields-picker',
  onChange,
}: {
  tab: CardTab;
  /** Every column that can be shown, in the board's order. */
  all: Column[];
  /** The ones shown now, in their order. */
  chosen: string[];
  /** What "missing" means (saved as missing when the choice equals it): every column, or the first few. */
  fallback: string[];
  title: string;
  testId?: string;
  onChange: (columns: string[] | undefined) => void;
}) => {
  const order = [...chosen, ...all.map((c) => c.id).filter((id) => !chosen.includes(id))];
  const sensors = useListSensors();
  // The default choice = "missing", so columns added later show up by themselves.
  const save = (ids: string[]) =>
    onChange(ids.length === fallback.length && ids.every((id, i) => id === fallback[i]) ? undefined : ids);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const next = arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    save(next.filter((id) => chosen.includes(id)));
  };
  const toggle = (id: string, on: boolean) => save(order.filter((x) => (x === id ? on : chosen.includes(x))));

  return (
    <section className="flex flex-col gap-2" data-testid={testId} data-tab-id={tab.id}>
      <h3 className="text-[0.8125rem] font-bold text-heading">{title}</h3>
      {all.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <ul className="max-h-72 overflow-auto rounded-[14px] border border-line [&>li+li]:border-t [&>li+li]:border-line-soft">
              {order.map((id) => {
                const c = all.find((x) => x.id === id)!;
                const on = chosen.includes(id);
                return (
                  <SortableRow key={id} id={id} testId="card-tab-column" dragLabel={t('labels.drag')}>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => toggle(id, e.target.checked)}
                        data-testid="card-tab-column-toggle"
                        data-column={id}
                        className="size-4 accent-[var(--check)]"
                      />
                      <span className={cn('truncate', !on && 'text-muted')}>{c.title}</span>
                    </label>
                  </SortableRow>
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
        <p className="text-sm text-muted">{t('item.fields.empty')}</p>
      )}
    </section>
  );
};

/** The "subitems" tab's columns: from the sub-board (none until the board's first subitem creates it). */
const SubitemsPicker = ({
  accountId,
  board,
  tab,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  tab: CardTab;
  onChange: (columns: string[] | undefined) => void;
}) => {
  const sub = useBoard(accountId, subBoardIdOf(board)).data;
  const title = t('card.tabs.subitemColumnsOf', { name: cardTabName(tab) });
  if (!sub)
    return (
      <section className="flex flex-col gap-2" data-testid="card-tab-subitems-picker" data-tab-id={tab.id}>
        <h3 className="text-[0.8125rem] font-bold text-heading">{title}</h3>
        <p className="text-sm text-muted">{t('card.tabs.noSubBoard')}</p>
      </section>
    );
  return (
    <FieldsPicker
      tab={tab}
      all={sub.columns.filter((c) => c.type !== 'name')}
      chosen={subitemColumns(sub, tab.columns).map((c) => c.id)}
      fallback={subitemColumns(sub, undefined).map((c) => c.id)}
      title={title}
      testId="card-tab-subitems-picker"
      onChange={onChange}
    />
  );
};

/**
 * How the card shows subitems (cardsub): the table under the fields on / off, the sub-board view the card starts
 * with, the footer; a filter / sort saved from the card ("save as default") can be cleared here.
 */
const SubitemsSettings = ({
  accountId,
  board,
  value,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  value: CardSubitems;
  onChange: (v: CardSubitems) => void;
}) => {
  const subBoardId = subBoardIdOf(board);
  const sub = useBoard(accountId, subBoardId).data;
  const views = useSubBoardViews(accountId, sub ? subBoardId : '').data ?? [];
  const current = views.find((v) => v.id === value.view_id);
  const saved = !!value.filter || value.sort.length > 0;
  const row = 'flex items-center justify-between gap-3 text-sm';
  return (
    <section className="flex flex-col gap-2.5" data-testid="card-subitems-settings">
      <h3 className="text-[0.8125rem] font-bold text-heading">{t('cardsub.settings.title')}</h3>
      <div className={row}>
        <span>{t('cardsub.settings.inFields')}</span>
        <Switch
          checked={value.in_fields}
          onChange={(in_fields) => onChange({ ...value, in_fields })}
          label={t('cardsub.settings.inFields')}
          testId="card-subitems-in-fields"
        />
      </div>
      <div className={row}>
        <span>{t('cardsub.settings.view')}</span>
        {sub ? (
          <PickerButton
            label={current?.name ?? t('cardsub.view.none')}
            placeholder={t('cardsub.settings.view')}
            menuLabel={t('cardsub.settings.view')}
            testId="card-subitems-default-view"
            className="w-56"
            items={[
              {
                label: t('cardsub.view.none'),
                checked: !current,
                onSelect: () => onChange({ ...value, view_id: undefined }),
              },
              ...views.map((v) => ({
                label: v.name,
                checked: v.id === current?.id,
                onSelect: () => onChange({ ...value, view_id: v.id }),
              })),
            ]}
          />
        ) : (
          <span className="text-xs text-muted">{t('card.tabs.noSubBoard')}</span>
        )}
      </div>
      <div className={row}>
        <span>{t('cardsub.settings.showSummary')}</span>
        <Switch
          checked={value.show_summary}
          onChange={(show_summary) => onChange({ ...value, show_summary })}
          label={t('cardsub.settings.showSummary')}
          testId="card-subitems-show-summary"
        />
      </div>
      {saved || Object.keys(value.summaries).length ? (
        <div className={row}>
          <span className="text-xs text-muted">{t('cardsub.settings.saved')}</span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="card-subitems-clear-query"
            onClick={() => {
              const { filter: _f, ...rest } = value;
              onChange({ ...rest, sort: [], summaries: {} });
            }}
          >
            {t('cardsub.settings.clear')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};

/**
 * The card's tabs for this board (N19ב): reorder (drag), rename, show / hide, add or remove "fields" tabs and
 * choose each one's fields. "Updates" stays first and always shown. Saved on the board (`PATCH {card: {tabs}}`).
 */
export const CardTabsDialog = ({
  accountId,
  board,
  parentCard,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  /** A subitems board's parent board's card settings (its fields per row, until this board sets its own). */
  parentCard?: unknown;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [tabs, setTabs] = useState<CardTab[]>(() => resolveCardTabs(board.card).slice(1));
  const [picking, setPicking] = useState<string | null>(null);
  const [subitems, setSubitems] = useState<CardSubitems>(() => cardSubitemsOf(board.card));
  const [perRow, setPerRow] = useState<CardFieldsPerRow>(() => cardFieldsPerRowFor(board.card, parentCard));
  const sensors = useListSensors();
  const patch = (id: string, p: Partial<CardTab>) =>
    setTabs((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setTabs((list) =>
      arrayMove(
        list,
        list.findIndex((x) => x.id === active.id),
        list.findIndex((x) => x.id === over.id),
      ),
    );
  };
  const addFields = () => {
    const id = `fields_${Date.now().toString(36)}`;
    const n = tabs.filter((x) => x.type === 'fields').length + 1;
    setTabs((list) => [...list, { id, type: 'fields', hidden: false, title: `${t(DEFAULT_NAME.fields)} ${n}` }]);
    setPicking(id);
  };
  const save = useMutation({
    mutationFn: () =>
      api(accountId).patch(`/boards/${board.id}`, {
        card: {
          tabs: tabs.map((x) => ({
            id: x.id,
            type: x.type,
            hidden: x.hidden,
            ...(x.title?.trim() ? { title: x.title.trim() } : {}),
            ...((x.type === 'fields' || x.type === 'subitems') && x.columns ? { columns: x.columns } : {}),
          })),
          subitems,
          // Always stored, 1 too: a subitems board's own 1 wins over its parent board's setting.
          fields_per_row: perRow,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) });
      onClose();
    },
  });
  const picked = tabs.find((x) => x.id === picking && (x.type === 'fields' || x.type === 'subitems'));

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('card.tabs.title')}
      subtitle={board.name}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={save.isPending} onClick={() => save.mutate()} data-testid="card-tabs-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="card-tab-settings-dialog">
        <ul className="overflow-hidden rounded-[14px] border border-line [&>li+li]:border-t [&>li+li]:border-line-soft">
          <li className="flex items-center gap-2 bg-surface-3 px-2.5 py-2" data-testid="card-tab-row" data-id="updates">
            <span aria-hidden className="px-0.5 text-line-strong">
              ⋮⋮
            </span>
            <Icon name="lock" size={14} className="text-muted" />
            <span className="flex-1 truncate text-sm font-semibold">{t('item.updates')}</span>
            <span className="text-xs text-muted">{t('card.tabs.fixed')}</span>
          </li>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={tabs.map((x) => x.id)} strategy={verticalListSortingStrategy}>
              {tabs.map((x) => (
                <SortableRow key={x.id} id={x.id} testId="card-tab-row" dragLabel={t('card.tabs.drag')}>
                  <input
                    value={x.title ?? ''}
                    maxLength={40}
                    placeholder={t(DEFAULT_NAME[x.type])}
                    aria-label={t('card.tabs.name')}
                    data-testid="card-tab-title"
                    onChange={(e) => patch(x.id, { title: e.target.value })}
                    className={cn(
                      'h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-line bg-surface px-2 text-sm focus:border-primary focus:outline-none',
                      x.hidden && 'text-muted',
                    )}
                  />
                  {x.type === 'fields' ? (
                    <Button
                      variant={picking === x.id ? 'primary' : 'ghost'}
                      size="sm"
                      aria-pressed={picking === x.id}
                      data-testid="card-tab-pick-fields"
                      onClick={() => setPicking((p) => (p === x.id ? null : x.id))}
                    >
                      <Icon name="table" size={14} />
                      {t('card.tabs.fields', { n: cardFieldColumns(board, x.columns).length })}
                    </Button>
                  ) : x.type === 'subitems' ? (
                    <Button
                      variant={picking === x.id ? 'primary' : 'ghost'}
                      size="sm"
                      aria-pressed={picking === x.id}
                      data-testid="card-tab-pick-subitem-columns"
                      onClick={() => setPicking((p) => (p === x.id ? null : x.id))}
                    >
                      <Icon name="table" size={14} />
                      {t('card.tabs.columns')}
                    </Button>
                  ) : null}
                  <Switch
                    checked={!x.hidden}
                    onChange={(on) => patch(x.id, { hidden: !on })}
                    label={t('card.tabs.show', { name: cardTabName(x) })}
                    testId="card-tab-visible"
                  />
                  {x.type === 'fields' && x.id !== 'fields' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('card.tabs.remove', { name: cardTabName(x) })}
                      title={t('card.tabs.remove', { name: cardTabName(x) })}
                      data-testid="card-tab-remove"
                      className="w-8 px-0 text-muted hover:text-danger-fg"
                      onClick={() => {
                        setTabs((list) => list.filter((y) => y.id !== x.id));
                        if (picking === x.id) setPicking(null);
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </Button>
                  ) : (
                    <span className="w-8 shrink-0" />
                  )}
                </SortableRow>
              ))}
            </SortableContext>
          </DndContext>
        </ul>
        {tabs.length + 1 < MAX_TABS ? (
          <Button variant="dashed" size="sm" className="self-start" data-testid="card-tab-add" onClick={addFields}>
            <Icon name="plus" size={14} />
            {t('card.tabs.addFields')}
          </Button>
        ) : null}
        {picked?.type === 'fields' ? (
          <FieldsPicker
            tab={picked}
            all={cardFieldColumns(board, undefined)}
            chosen={cardFieldColumns(board, picked.columns).map((c) => c.id)}
            fallback={cardFieldColumns(board, undefined).map((c) => c.id)}
            title={t('card.tabs.fieldsOf', { name: cardTabName(picked) })}
            onChange={(columns) => patch(picked.id, { columns })}
          />
        ) : picked?.type === 'subitems' ? (
          <SubitemsPicker
            accountId={accountId}
            board={board}
            tab={picked}
            onChange={(columns) => patch(picked.id, { columns })}
          />
        ) : null}
        {/* r15: how many fields stand side by side in the "Fields" tabs (a phone always shows one). */}
        <section className="flex flex-col gap-2 border-t border-line pt-4" data-testid="card-fields-per-row">
          <h3 className="text-[0.8125rem] font-bold text-heading">{t('card.fieldsPerRow.title')}</h3>
          <Segmented
            label={t('card.fieldsPerRow.title')}
            value={String(perRow)}
            onChange={(v) => setPerRow(v === 'auto' ? 'auto' : (Number(v) as 1 | 2 | 3))}
            className="self-start"
            options={CARD_FIELDS_PER_ROW.map((n) => ({
              value: String(n),
              label: n === 'auto' ? t('card.fieldsPerRow.auto') : String(n),
              testId: `card-fields-per-row-${n}`,
            }))}
          />
          <p className="text-xs text-muted">{t('card.fieldsPerRow.hint')}</p>
        </section>
        <div className="border-t border-line pt-4">
          <SubitemsSettings accountId={accountId} board={board} value={subitems} onChange={setSubitems} />
        </div>
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
