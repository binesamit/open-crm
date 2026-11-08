// SPDX-License-Identifier: AGPL-3.0-only
import {
  GROUP_DATE_UNITS,
  type GroupBy,
  type GroupDateUnit,
  type GroupMode,
  groupModes,
  isGroupable,
  MAX_GROUP_LEVELS,
  t,
} from '@bines/shared';
import { cn, Input, Picker } from '@bines/ui';
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import type { HTMLAttributes } from 'react';
import { columnTypeLabel } from '../../../lib/locale';
import { safeField } from './filter-model';
import type { FilterCtx } from './FilterPanel';
import { CheckRow } from './parts';

const NONE = '__none__';

/** The view's grouping: the first level (none = the board's groups) and up to two levels inside it. */
export type Grouping = { group_by?: GroupBy; subgroups?: GroupBy[] };

const chip = (on: boolean) =>
  cn(
    'h-9 rounded-full border px-3 text-[0.8125rem]',
    on ? 'border-primary bg-primary text-on-primary' : 'border-line-strong bg-surface text-fg hover:bg-surface-2',
  );

/**
 * The group panel (13 §4.1; — the canvas "חלון הקיבוץ"): a card per level, up to three — its column
 * and order, and how it groups: a date by when / day / week / month / quarter / year (a
 * timeline by its start or end), other columns by their modes (each / combination / team, ranges, first letter …).
 * The first level may be the board's groups; the levels inside it are dragged into order.
 */
export const GroupByPanel = ({
  value,
  ctx,
  onChange,
}: {
  value: Grouping;
  ctx: FilterCtx;
  onChange: (g: Grouping) => void;
}) => {
  const choices = ctx.columns.filter((c) => {
    const f = safeField(c.id, ctx.env);
    return c.type !== 'name' && f && isGroupable(f);
  });
  const first = value.group_by;
  const inner = value.subgroups ?? [];
  const used = new Set([first?.column_id, ...inner.map((g) => g.column_id)]);
  const emit = (g: GroupBy | undefined, rest: GroupBy[]) =>
    onChange({ group_by: g, subgroups: rest.length ? rest : undefined });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // The column levels are dragged among themselves; the board's groups (a first level without a column) stay first.
  const columnLevels = [...(first ? [first] : []), ...inner];
  const ids = columnLevels.map((g, i) => `${i}:${g.column_id}`);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const moved = arrayMove(columnLevels, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    if (first) emit(moved[0], moved.slice(1));
    else emit(undefined, moved);
  };
  const free = choices.find((c) => !used.has(c.id));
  const levelCount = 1 + inner.length;

  return (
    <div className="flex w-[min(30rem,calc(100vw-2rem))] flex-col gap-3" data-testid="group-panel">
      <h2 className="font-display text-lg font-medium text-primary">{t('group.dialogTitle')}</h2>
      {!first ? (
        <LevelCard
          index={0}
          g={undefined}
          ctx={ctx}
          choices={choices}
          used={used}
          onChange={(g) => emit(g, inner)}
          onRemove={inner.length ? () => emit(inner[0], inner.slice(1)) : undefined}
        />
      ) : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {columnLevels.map((g, i) => {
            const index = first ? i : i + 1;
            return (
              <SortableLevel key={ids[i]} id={ids[i]!} draggable={columnLevels.length > 1}>
                {(handle) => (
                  <LevelCard
                    index={index}
                    g={g}
                    ctx={ctx}
                    choices={choices}
                    used={used}
                    handle={handle}
                    onChange={(next) => {
                      if (index === 0) emit(next, inner);
                      else if (next)
                        emit(
                          first,
                          inner.map((x, j) => (j === index - 1 ? next : x)),
                        );
                    }}
                    onRemove={
                      index === 0
                        ? inner.length
                          ? () => emit(inner[0], inner.slice(1))
                          : undefined
                        : () =>
                            emit(
                              first,
                              inner.filter((_, j) => j !== index - 1),
                            )
                    }
                  />
                )}
              </SortableLevel>
            );
          })}
        </SortableContext>
      </DndContext>
      {levelCount < MAX_GROUP_LEVELS && free ? (
        <button
          type="button"
          className="h-11 rounded-[10px] border border-dashed border-line-strong text-sm text-primary hover:bg-surface-2"
          data-testid="group-add-level"
          onClick={() => emit(first, [...inner, { column_id: free.id, direction: 'asc', collapse: false }])}
        >
          {t('group.addLevel')}
        </button>
      ) : null}
      <p className="text-xs text-muted">{t('group.savedInView')}</p>
    </div>
  );
};

/** A level card that can be dragged by its handle (the column levels). */
const SortableLevel = ({
  id,
  draggable,
  children,
}: {
  id: string;
  draggable: boolean;
  children: (handle: HTMLAttributes<HTMLSpanElement> | null) => React.ReactNode;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id, disabled: !draggable });
  return (
    <div ref={setNodeRef} style={{ transform: DndCSS.Translate.toString(transform), transition }}>
      {children(draggable ? { ...attributes, ...listeners } : null)}
    </div>
  );
};

/** One level: its column (the first may be "no grouping" = the board's groups), order and how it groups. */
const LevelCard = ({
  index,
  g,
  ctx,
  choices,
  used,
  handle,
  onChange,
  onRemove,
}: {
  index: number;
  g: GroupBy | undefined;
  ctx: FilterCtx;
  choices: FilterCtx['columns'];
  used: Set<string | undefined>;
  handle?: HTMLAttributes<HTMLSpanElement> | null;
  onChange: (g: GroupBy | undefined) => void;
  onRemove?: () => void;
}) => {
  // Test ids: the first level's as before (`group-column` …); the others' with their number (`group-column-2`).
  const sfx = index ? `-${index + 1}` : '';
  const field = g ? safeField(g.column_id, ctx.env) : null;
  const isDate = field?.model === 'date';
  const isLabels = field?.model === 'label' || field?.model === 'labels';
  const isRange = !!(field?.source === 'column' && field.def.toDateEnd);
  const unit: GroupDateUnit = g?.date_unit ?? 'when';
  // ק2: how a column that is not a date groups — its modes, the first being its default.
  const modes = field ? groupModes(field) : [];
  const mode = g?.mode && modes.includes(g.mode) ? g.mode : modes[0];
  const modeLabel = (m: GroupMode) =>
    m === 'each'
      ? t(
          field?.model === 'label'
            ? 'group.orderLabels'
            : field?.model === 'people'
              ? 'group.mode.eachPerson'
              : 'group.mode.each',
        )
      : t(`group.mode.${m}`);
  const orderLabel = (d: 'asc' | 'desc') =>
    isLabels && mode !== 'name' && mode !== 'combo'
      ? t(d === 'asc' ? 'group.orderLabels' : 'group.orderLabelsDesc')
      : isDate
        ? t(d === 'asc' ? 'group.orderEarly' : 'group.orderLate')
        : t(d === 'asc' ? 'group.orderAsc' : 'group.orderDesc');

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[12px] border p-3.5',
        index ? 'border-accent bg-[var(--accent-soft)]' : 'border-line',
      )}
      data-testid="group-level"
      data-level={index + 1}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-[0.8125rem] text-on-primary">
          {index + 1}
        </span>
        <span className="text-sm text-muted">{t(index ? 'group.levelNested' : 'group.level1')}</span>
        <span className="flex-1" />
        {handle ? (
          <span
            {...handle}
            className="cursor-grab px-1 text-[0.8125rem] text-muted"
            role="button"
            tabIndex={0}
            aria-label={t('group.dragLevel')}
          >
            ⠿
          </span>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-[8px] px-2 py-1 text-[0.8125rem] text-danger-fg hover:bg-surface-2"
            data-testid={`group-remove${sfx}`}
          >
            {t('group.removeLevel')}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          {t('group.column')}
          <Picker
            value={g?.column_id ?? NONE}
            label={t('group.column')}
            testId={`group-column${sfx}`}
            searchable
            onChange={(id) =>
              onChange(id === NONE ? undefined : { column_id: id, direction: g?.direction ?? 'asc', collapse: false })
            }
            options={[
              // Only the first level can be the board's groups.
              ...(index ? [] : [{ value: NONE, label: t('group.none') }]),
              ...choices
                .filter((c) => c.id === g?.column_id || !used.has(c.id))
                .map((c) => ({ value: c.id, label: c.title, keywords: columnTypeLabel(c.type) })),
            ]}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          {t('group.order')}
          <Picker
            value={g?.direction ?? 'asc'}
            label={t('group.order')}
            testId={`group-direction${sfx}`}
            onChange={(direction) => g && onChange({ ...g, direction })}
            options={(['asc', 'desc'] as const).map((d) => ({ value: d, label: orderLabel(d) }))}
          />
        </label>
      </div>
      {g && isDate ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted" id={`group-unit-label${sfx}`}>
            {t('group.by')}
          </span>
          <div role="radiogroup" aria-labelledby={`group-unit-label${sfx}`} className="flex flex-wrap gap-1.5">
            {GROUP_DATE_UNITS.map((u) => (
              <button
                key={u}
                type="button"
                role="radio"
                aria-checked={unit === u}
                data-testid={`group-unit-${u}${sfx}`}
                onClick={() => onChange({ ...g, date_unit: u })}
                className={chip(unit === u)}
              >
                {t(`group.unit.${u}`)}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted" data-testid={`group-unit-hint${sfx}`}>
            {t(`group.unitHint.${unit}`)}
          </span>
          {unit === 'when' ? (
            <CheckRow checked={!!g.past_detail} onToggle={() => onChange({ ...g, past_detail: !g.past_detail })}>
              {t('group.pastDetail')}
            </CheckRow>
          ) : null}
          {isRange ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              {t('group.edge')}
              <div role="radiogroup" aria-label={t('group.edge')} className="flex gap-1.5">
                {(['start', 'end'] as const).map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={(g.date_edge ?? 'start') === e}
                    data-testid={`group-edge-${e}${sfx}`}
                    onClick={() => onChange({ ...g, date_edge: e })}
                    className={chip((g.date_edge ?? 'start') === e)}
                  >
                    {t(e === 'start' ? 'group.edgeStart' : 'group.edgeEnd')}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {g && field && modes.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted" id={`group-mode-label${sfx}`}>
            {t('group.by')}
          </span>
          <div role="radiogroup" aria-labelledby={`group-mode-label${sfx}`} className="flex flex-wrap gap-1.5">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                data-testid={`group-mode-${m}${sfx}`}
                onClick={() => onChange({ ...g, mode: m })}
                className={chip(mode === m)}
              >
                {modeLabel(m)}
              </button>
            ))}
          </div>
          {mode === 'ranges' ? (
            <label className="flex items-center gap-2 text-xs text-muted">
              {t('group.rangeSize')}
              <Input
                inputMode="decimal"
                className="h-9 w-28"
                placeholder={t('group.rangeAuto')}
                aria-label={t('group.rangeSize')}
                data-testid={`group-range-size${sfx}`}
                value={g.range_size ?? ''}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/,/g, ''));
                  const { range_size: _drop, ...rest } = g;
                  onChange(e.target.value.trim() && n > 0 ? { ...g, range_size: n } : rest);
                }}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {g && field?.model === 'label' ? (
        <CheckRow checked={!!g.show_empty} onToggle={() => onChange({ ...g, show_empty: !g.show_empty })}>
          {t('group.showEmpty')}
        </CheckRow>
      ) : null}
    </div>
  );
};
