// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import {
  defaultCapacity,
  t,
  TIMELINE_GROUP,
  TIMELINE_NO_GROUP,
  type MessageKey,
  type QueryEnv,
  type ViewSettings,
  WORKLOAD_SOURCES,
} from '@bines/shared';
import { Switch } from '@bines/ui';
import { type BoardDetail, type Member, useBoard } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { CheckRow, PickerButton } from '../toolbar/parts';
import { calendarColumns } from '../views/CalendarView';
import { colorColumns, timelineDateColumn, timelineGroupColumns } from './TimelineChart';
import { effortColumns, peopleColumns, subWorkloadColumns } from './WorkloadView';

/**
 * View settings of Timeline, Gantt and Workload (15 §7, M8 ד6–ד8): every choice is a draft until the view is saved
 * (D20) — date column, grouping, colours, dependency column, subitems, critical path; people, measure, capacity.
 */
type Update = (fn: (s: ViewSettings) => ViewSettings) => void;
type Props = { board: BoardDetail; env: QueryEnv; settings: ViewSettings; update: Update };

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1 text-xs font-medium text-muted">{children}</div>
);

type TimelineCfg = NonNullable<ViewSettings['timeline']>;
type GanttCfg = NonNullable<ViewSettings['gantt']>;

/** Date column, grouping and colour — shared by Timeline and Gantt (`key`). */
const BarSettings = ({ board, env, settings, update, kind }: Props & { kind: 'timeline' | 'gantt' }) => {
  const cfg = (kind === 'gantt' ? settings.gantt : settings.timeline) ?? ({} as Partial<GanttCfg>);
  const set = (patch: Partial<GanttCfg>) =>
    update((s) =>
      kind === 'gantt'
        ? { ...s, gantt: { zoom: 'week', show_subitems: true, show_critical: false, ...s.gantt, ...patch } }
        : { ...s, timeline: { zoom: 'week', ...s.timeline, ...(patch as Partial<TimelineCfg>) } },
    );
  const dates = calendarColumns(board, env);
  const date = timelineDateColumn(board, env, cfg.date_column_id);
  const groups = timelineGroupColumns(board, env);
  const groupBy = cfg.group_by ?? TIMELINE_GROUP;
  const groupLabel =
    groupBy === TIMELINE_GROUP
      ? t('timeline.groupByGroups')
      : groupBy === TIMELINE_NO_GROUP
        ? t('timeline.groupByNone')
        : (groups.find((c) => c.id === groupBy)?.title ?? t('timeline.groupByGroups'));
  const colors = colorColumns(board, env);
  const colorBy = colors.find((c) => c.id === cfg.color_by);
  return (
    <>
      <div>
        <Label>{t('viewSettings.dateColumn')}</Label>
        <PickerButton
          testId="timeline-date-column"
          label={date?.title}
          placeholder={t('filter.column')}
          menuLabel={t('viewSettings.dateColumn')}
          className="w-full"
          items={dates.map((c) => ({
            label: c.title,
            checked: c.id === date?.id,
            onSelect: () => set({ date_column_id: c.id }),
          }))}
        />
      </div>
      <div>
        <Label>{t('timeline.groupBy')}</Label>
        <PickerButton
          testId="timeline-group-by"
          label={groupLabel}
          placeholder={groupLabel}
          menuLabel={t('timeline.groupBy')}
          className="w-full"
          items={[
            {
              label: t('timeline.groupByGroups'),
              checked: groupBy === TIMELINE_GROUP,
              onSelect: () => set({ group_by: TIMELINE_GROUP }),
            },
            {
              label: t('timeline.groupByNone'),
              checked: groupBy === TIMELINE_NO_GROUP,
              onSelect: () => set({ group_by: TIMELINE_NO_GROUP }),
            },
            ...groups.map((c) => ({
              label: c.title,
              checked: c.id === groupBy,
              onSelect: () => set({ group_by: c.id }),
            })),
          ]}
        />
      </div>
      <div>
        <Label>{t('viewSettings.colorBy')}</Label>
        <PickerButton
          testId="timeline-color-by"
          label={colorBy?.title ?? t('timeline.colorByGroup')}
          placeholder={t('timeline.colorByGroup')}
          menuLabel={t('viewSettings.colorBy')}
          className="w-full"
          items={[
            {
              label: t('timeline.colorByGroup'),
              checked: !colorBy,
              onSelect: () => set({ color_by: undefined }),
            },
            ...colors.map((c) => ({
              label: c.title,
              checked: c.id === colorBy?.id,
              onSelect: () => set({ color_by: c.id }),
            })),
          ]}
        />
      </div>
      {/* the axis without weekends and days off (a saved view setting). */}
      <label className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-fg">{t('workdays.onlyView')}</span>
          <span className="block text-xs text-muted">{t('workdays.onlyView.hint')}</span>
        </span>
        <Switch
          checked={!!cfg.working_days_only}
          onChange={(on) => set({ working_days_only: on || undefined })}
          testId="timeline-working-days-only"
        />
      </label>
    </>
  );
};

export const TimelineSettings = (p: Props) => <BarSettings {...p} kind="timeline" />;

export const GanttSettings = (p: Props) => {
  const { board, settings, update } = p;
  const cfg = settings.gantt;
  const deps = board.columns.filter((c) => c.type === 'dependency');
  const dep = deps.find((c) => c.id === cfg?.dependency_column_id) ?? deps[0];
  const set = (patch: Partial<GanttCfg>) =>
    update((s) => ({ ...s, gantt: { zoom: 'week', show_subitems: true, show_critical: false, ...s.gantt, ...patch } }));
  return (
    <>
      <BarSettings {...p} kind="gantt" />
      <div>
        <Label>{t('gantt.dependencyColumn')}</Label>
        {deps.length ? (
          <PickerButton
            testId="gantt-dependency-column"
            label={dep?.title}
            placeholder={t('filter.column')}
            menuLabel={t('gantt.dependencyColumn')}
            className="w-full"
            items={deps.map((c) => ({
              label: c.title,
              checked: c.id === dep?.id,
              onSelect: () => set({ dependency_column_id: c.id }),
            }))}
          />
        ) : (
          <p className="text-xs text-muted" data-testid="gantt-no-dependency">
            {t('gantt.noDependency')}
          </p>
        )}
      </div>
      {board.subitems_board_id ? (
        <CheckRow
          checked={cfg?.show_subitems ?? true}
          onToggle={() => set({ show_subitems: !(cfg?.show_subitems ?? true) })}
        >
          <span data-testid="gantt-show-subitems">{t('gantt.showSubitems')}</span>
        </CheckRow>
      ) : null}
      {deps.length ? (
        <CheckRow checked={!!cfg?.show_critical} onToggle={() => set({ show_critical: !cfg?.show_critical })}>
          {t('gantt.critical')}
        </CheckRow>
      ) : null}
    </>
  );
};

type WorkloadCfg = NonNullable<ViewSettings['workload']>;

/** A number field that saves on blur / Enter (no native spinner or picker). */
const NumberField = ({
  value,
  placeholder,
  onCommit,
  testId,
  label,
}: {
  value: number | undefined;
  placeholder?: string;
  onCommit: (n: number | undefined) => void;
  testId?: string;
  label: string;
}) => {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) return onCommit(undefined);
    const n = Number(trimmed.replace(',', '.'));
    if (Number.isFinite(n) && n >= 0 && n <= 10000) onCommit(n);
    else setText(value === undefined ? '' : String(value));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      data-testid={testId}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className="h-8 w-20 rounded-[10px] border border-line-strong bg-surface px-2 text-sm tabular-nums focus:border-primary focus:outline-none"
      dir="ltr"
    />
  );
};

export const WorkloadSettings = ({ board, env, settings, update, members }: Props & { members: Member[] }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const subBoard = useBoard(accountId, board.subitems_board_id ?? '').data;
  const cfg =
    settings.workload ?? ({ measure: 'count', unit: 'day', capacity_overrides: {}, source: 'items' } as WorkloadCfg);
  const set = (patch: Partial<WorkloadCfg>) =>
    update((s) => ({
      ...s,
      workload: { measure: 'count', unit: 'day', capacity_overrides: {}, source: 'items', ...s.workload, ...patch },
    }));
  const source = cfg.source ?? 'items';
  const sub = source === 'items' ? null : subWorkloadColumns(subBoard, env, cfg);
  const people = peopleColumns(board, env);
  const person = people.find((c) => c.id === cfg.people_column_id) ?? people[0];
  const dates = calendarColumns(board, env);
  const date = timelineDateColumn(board, env, cfg.date_column_id);
  const efforts = effortColumns(board, env);
  const effort = efforts.find((c) => c.id === cfg.effort_column_id) ?? efforts[0];
  const measure = cfg.measure ?? 'count';
  const humans = members.filter((mb) => !mb.agent && mb.status !== 'deactivated').slice(0, 100);
  return (
    <>
      <div>
        <Label>{t('workload.source')}</Label>
        <PickerButton
          testId="workload-source"
          label={t(`workload.source.${source}` as MessageKey)}
          placeholder={t('workload.source.items')}
          menuLabel={t('workload.source')}
          className="w-full"
          items={WORKLOAD_SOURCES.map((v) => ({
            label: t(`workload.source.${v}` as MessageKey),
            checked: v === source,
            testId: `workload-source-${v}`,
            onSelect: () => set({ source: v }),
          }))}
        />
      </div>
      <div>
        <Label>{t('workload.peopleColumn')}</Label>
        <PickerButton
          testId="workload-people-column"
          label={person?.title}
          placeholder={t('filter.column')}
          menuLabel={t('workload.peopleColumn')}
          className="w-full"
          items={people.map((c) => ({
            label: c.title,
            checked: c.id === person?.id,
            onSelect: () => set({ people_column_id: c.id }),
          }))}
        />
      </div>
      <div>
        <Label>{t('viewSettings.dateColumn')}</Label>
        <PickerButton
          testId="workload-date-column"
          label={date?.title}
          placeholder={t('filter.column')}
          menuLabel={t('viewSettings.dateColumn')}
          className="w-full"
          items={dates.map((c) => ({
            label: c.title,
            checked: c.id === date?.id,
            onSelect: () => set({ date_column_id: c.id }),
          }))}
        />
      </div>
      <div>
        <Label>{t('workload.measure')}</Label>
        <PickerButton
          testId="workload-measure"
          label={t(`workload.measure.${measure}` as MessageKey)}
          placeholder={t('workload.measure.count')}
          menuLabel={t('workload.measure')}
          className="w-full"
          items={(['count', 'column'] as const).map((mm) => ({
            label: t(`workload.measure.${mm}` as MessageKey),
            checked: mm === measure,
            onSelect: () => set({ measure: mm }),
          }))}
        />
      </div>
      {measure === 'column' ? (
        <div>
          <Label>{t('workload.effortColumn')}</Label>
          {efforts.length ? (
            <PickerButton
              testId="workload-effort-column"
              label={effort?.title}
              placeholder={t('filter.column')}
              menuLabel={t('workload.effortColumn')}
              className="w-full"
              items={efforts.map((c) => ({
                label: c.title,
                checked: c.id === effort?.id,
                onSelect: () => set({ effort_column_id: c.id }),
              }))}
            />
          ) : (
            <p className="text-xs text-muted">{t('workload.noEffort')}</p>
          )}
        </div>
      ) : null}
      {source === 'items' ? null : !sub ? (
        <p className="text-xs text-muted" data-testid="workload-no-subitems">
          {t('workload.noSubitems')}
        </p>
      ) : (
        <div className="space-y-2 rounded-[10px] border border-line-soft p-2" data-testid="workload-sub-columns">
          <div className="text-xs font-semibold text-fg-2">{t('workload.subColumns')}</div>
          <SubColumnPicker
            label={t('workload.peopleColumn')}
            testId="workload-sub-people-column"
            columns={sub.people}
            current={sub.person}
            onSelect={(id) => set({ sub_people_column_id: id })}
          />
          <SubColumnPicker
            label={t('viewSettings.dateColumn')}
            testId="workload-sub-date-column"
            columns={calendarColumns(subBoard!, sub.env)}
            current={sub.date}
            onSelect={(id) => set({ sub_date_column_id: id })}
          />
          {measure === 'column' ? (
            <SubColumnPicker
              label={t('workload.effortColumn')}
              testId="workload-sub-effort-column"
              columns={sub.efforts}
              current={sub.effort}
              onSelect={(id) => set({ sub_effort_column_id: id })}
            />
          ) : null}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <Label>{t('workload.capacity')}</Label>
        <NumberField
          key={`cap-${measure}-${cfg.capacity ?? ''}`}
          testId="workload-capacity-input"
          label={t('workload.capacity')}
          value={cfg.capacity}
          placeholder={String(defaultCapacity(measure))}
          onCommit={(n) => set({ capacity: n })}
        />
      </div>
      {humans.length ? (
        <div>
          <Label>{t('workload.perPerson')}</Label>
          <div className="max-h-48 space-y-1 overflow-y-auto" data-testid="workload-overrides">
            {humans.map((mb) => (
              <div key={mb.user_id} className="flex items-center justify-between gap-2">
                <span className="truncate text-sm">{mb.name || mb.email}</span>
                <NumberField
                  key={`${mb.user_id}-${cfg.capacity_overrides?.[mb.user_id] ?? ''}`}
                  testId="workload-override"
                  label={mb.name || mb.email}
                  value={cfg.capacity_overrides?.[mb.user_id]}
                  placeholder={String(cfg.capacity ?? defaultCapacity(measure))}
                  onCommit={(n) => {
                    const next = { ...cfg.capacity_overrides };
                    if (n === undefined) delete next[mb.user_id];
                    else next[mb.user_id] = n;
                    set({ capacity_overrides: next });
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
};

/** One of the sub-board's columns for a workload of subitems (round 15). */
const SubColumnPicker = ({
  label,
  testId,
  columns,
  current,
  onSelect,
}: {
  label: string;
  testId: string;
  columns: { id: string; title: string }[];
  current: { id: string; title: string } | undefined;
  onSelect: (id: string) => void;
}) => (
  <div>
    <Label>{label}</Label>
    {columns.length ? (
      <PickerButton
        testId={testId}
        label={current?.title}
        placeholder={t('filter.column')}
        menuLabel={label}
        className="w-full"
        items={columns.map((c) => ({ label: c.title, checked: c.id === current?.id, onSelect: () => onSelect(c.id) }))}
      />
    ) : (
      <p className="text-xs text-muted">{t('workload.noColumn')}</p>
    )}
  </div>
);
