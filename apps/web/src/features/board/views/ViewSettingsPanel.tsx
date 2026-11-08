// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CALENDAR_EMPTY_CLICK,
  CALENDAR_HOUR_HEIGHTS,
  CALENDAR_TIME_SOURCES,
  calendarSettingsOf,
  type CalendarViewSettings,
  t,
  type MessageKey,
  type QueryEnv,
  type SummaryFn,
  type ViewSettings,
  type ViewType,
} from '@bines/shared';
import { boardKeys, type BoardDetail, type Column, type Member } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { ColumnPicker, useCreateColumn } from '../ColumnPicker';
import { cn, Segmented, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { quickCardFields } from './CalendarQuickCard';
import { GanttSettings, TimelineSettings, WorkloadSettings } from '../timeline/TimelineSettings';
import { groupSummaryOptions } from '../table/BoardTable';
import { safeField } from '../toolbar/filter-model';
import { CheckRow, PickerButton, ToolbarPanel } from '../toolbar/parts';
import { calendarColumns, hourColumns } from './CalendarView';
import { defaultCardFields, kanbanColumns } from './KanbanView';
import { showToast } from '../../../lib/toast';
import { Icon } from '../../../lib/icons';
import type { View } from './views-api';
import { ChartSettings, MapSettings } from './P1ViewSettings';
import { locationColumns } from './MapView';

type Update = (fn: (s: ViewSettings) => ViewSettings) => void;

/** "View settings" (15 §7): the table's rows; Kanban lanes and card fields; Calendar date column; Cards fields. */
export const ViewSettingsPanel = ({
  type,
  board,
  env,
  settings,
  update,
  view,
  views,
  members = [],
  coloring,
  mainTable,
}: {
  type: ViewType;
  board: BoardDetail;
  env: QueryEnv;
  settings: ViewSettings;
  update: Update;
  /** The open view and the board's views: "copy settings from" offers the others of the same type. */
  view?: View;
  views?: View[];
  /** Workload: per-person capacity. */
  members?: Member[];
  /** Prod fix (r15board 1): the table's conditional coloring lives here (a page of its own), not in the toolbar. */
  coloring?: ReactNode;
  /** on the default table, the board's setting for its column order. */
  mainTable?: ReactNode;
}) => {
  const coloringCount = coloring ? settings.coloring.length : 0;
  return (
    <ToolbarPanel
      label={t('viewSettings.title')}
      icon="gear"
      testId="toolbar-view-settings"
      count={coloringCount}
      panelClassName="max-w-[96vw]"
    >
      {() => (
        <SettingsPages coloring={coloring} coloringCount={coloringCount}>
          {type === 'table' ? <TableSettings board={board} env={env} settings={settings} update={update} /> : null}
          {type === 'table' ? mainTable : null}
          {type === 'kanban' ? <KanbanSettings board={board} env={env} settings={settings} update={update} /> : null}
          {type === 'calendar' ? (
            <CalendarSettings board={board} env={env} settings={settings} update={update} />
          ) : null}
          {type === 'cards' ? (
            <FieldsPicker
              board={board}
              chosen={settings.cards?.fields ?? []}
              fallback={defaultCardFields(board).map((c) => c.id)}
              onChange={(fields) => update((s) => ({ ...s, cards: { ...s.cards, fields } }))}
            />
          ) : null}
          {type === 'timeline' ? (
            <TimelineSettings board={board} env={env} settings={settings} update={update} />
          ) : null}
          {type === 'gantt' ? <GanttSettings board={board} env={env} settings={settings} update={update} /> : null}
          {type === 'workload' ? (
            <WorkloadSettings board={board} env={env} settings={settings} update={update} members={members} />
          ) : null}
          {type === 'chart' ? <ChartSettings board={board} env={env} settings={settings} update={update} /> : null}
          {type === 'dashboard' ? (
            // Round 15: whether the view's toolbar (filter, search, person) narrows the widgets.
            <CheckRow
              checked={settings.dashboard?.apply_view_filter ?? true}
              onToggle={() =>
                update((s) => ({
                  ...s,
                  dashboard: {
                    widgets: s.dashboard?.widgets ?? [],
                    apply_view_filter: !(s.dashboard?.apply_view_filter ?? true),
                  },
                }))
              }
            >
              <span data-testid="dashboard-view-apply-filter">{t('dashboards.view.applyFilter')}</span>
            </CheckRow>
          ) : null}
          {type === 'map' ? (
            <MapSettings
              board={board}
              env={env}
              settings={settings}
              update={update}
              fields={
                <FieldsPicker
                  board={board}
                  chosen={settings.map?.card_fields ?? []}
                  fallback={defaultCardFields(board, locationColumns(board)[0]?.id).map((c) => c.id)}
                  onChange={(card_fields) => update((s) => ({ ...s, map: { ...s.map, card_fields } }))}
                />
              }
            />
          ) : null}
          {view && views ? <CopySettingsFrom view={view} views={views} update={update} /> : null}
        </SettingsPages>
      )}
    </ToolbarPanel>
  );
};

/**
 * The panel's pages: the settings, and (tables) the coloring rules — opened from a row at the top, with a way
 * back. Mounted only while the panel is open, so it always reopens on the settings.
 */
const SettingsPages = ({
  coloring,
  coloringCount,
  children,
}: {
  coloring?: ReactNode;
  coloringCount: number;
  children: ReactNode;
}) => {
  const [page, setPage] = useState<'main' | 'coloring'>('main');
  if (page === 'coloring' && coloring)
    return (
      <div className="space-y-2 text-sm" data-testid="view-settings-coloring">
        <button
          type="button"
          data-testid="view-settings-back"
          onClick={() => setPage('main')}
          className="flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          <Icon name="chevronEnd" size={12} className="rotate-180" />
          {t('viewSettings.title')}
        </button>
        {coloring}
      </div>
    );
  return (
    <div className="w-72 space-y-3 text-sm" data-testid="view-settings">
      {coloring ? (
        <button
          type="button"
          data-testid="toolbar-coloring"
          onClick={() => setPage('coloring')}
          className="flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] border border-line px-2.5 text-start hover:bg-surface-2"
        >
          <Icon name="palette" size={15} />
          <span className="min-w-0 flex-1 truncate">{t('coloring.button')}</span>
          {coloringCount ? (
            <span className="rounded-full bg-primary px-1.5 text-[0.6875rem] leading-4 text-on-primary">
              {coloringCount}
            </span>
          ) : null}
          <Icon name="chevronEnd" size={12} className="text-muted" />
        </button>
      ) : null}
      {children}
    </div>
  );
};

/** Settings copied from another view: everything it saves (D20) — never its name, type or id. */
export const copiedSettings = (source: ViewSettings): ViewSettings => structuredClone(source);

/**
 * Fix: "copy settings from a view…" — another view of the same type on this board (table → table,
 * Kanban → Kanban…). Its saved settings (filters, sort, grouping, hidden columns, column order and widths, Kanban
 * lanes / card fields, calendar date column, coloring, summaries…) replace this view's as an unsaved draft (D20):
 * the save bar then saves them, or "reset" brings the view back.
 */
const CopySettingsFrom = ({ view, views, update }: { view: View; views: View[]; update: Update }) => {
  const sources = views.filter((v) => v.type === view.type && v.id !== view.id);
  return (
    <div className="border-t border-line pt-3">
      <Label>{t('viewSettings.copyFrom')}</Label>
      {sources.length ? (
        <PickerButton
          testId="view-copy-settings"
          menuLabel={t('viewSettings.copyFrom')}
          placeholder={t('viewSettings.copyFrom.pick')}
          className="w-full"
          items={sources.map((source) => ({
            label: source.name,
            onSelect: () => {
              update(() => copiedSettings(source.settings));
              showToast({ message: t('viewSettings.copyFrom.done', { name: source.name }) });
            },
          }))}
        />
      ) : (
        <p className="text-xs text-muted" data-testid="view-copy-settings-none">
          {t('viewSettings.copyFrom.none')}
        </p>
      )}
    </div>
  );
};

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1 text-xs font-medium text-muted">{children}</div>
);

const ROW_HEIGHTS = ['single', 'double', 'triple'] as const;
/** Round 12: the table on a phone — a table (default) or the cards. */
const MOBILE_LAYOUTS = ['table', 'cards'] as const;

/** Table rows (15 §7): height (1–3 lines), wrapping long text instead of cutting it, the footer row. */
const TableSettings = ({
  board,
  env,
  settings,
  update,
}: {
  board: BoardDetail;
  env: QueryEnv;
  settings: ViewSettings;
  update: Update;
}) => (
  <>
    <div>
      <Label>{t('viewSettings.rowHeight')}</Label>
      <PickerButton
        testId="view-row-height"
        menuLabel={t('viewSettings.rowHeight')}
        placeholder={t('viewSettings.rowHeight.single')}
        label={t(`viewSettings.rowHeight.${settings.row_height}`)}
        items={ROW_HEIGHTS.map((h) => ({
          label: t(`viewSettings.rowHeight.${h}`),
          checked: settings.row_height === h,
          onSelect: () => update((s) => ({ ...s, row_height: h })),
        }))}
      />
    </div>
    <div>
      <Label>{t('r12.mobile.layout')}</Label>
      <PickerButton
        testId="view-mobile-layout"
        menuLabel={t('r12.mobile.layout')}
        placeholder={t('r12.mobile.layout.table')}
        label={t(`r12.mobile.layout.${settings.mobile_layout ?? 'table'}` as MessageKey)}
        items={MOBILE_LAYOUTS.map((layout) => ({
          label: t(`r12.mobile.layout.${layout}` as MessageKey),
          checked: (settings.mobile_layout ?? 'table') === layout,
          onSelect: () => update((s) => ({ ...s, mobile_layout: layout })),
        }))}
      />
    </div>
    <CheckRow checked={settings.wrap_text} onToggle={() => update((s) => ({ ...s, wrap_text: !s.wrap_text }))}>
      <span data-testid="view-wrap-text">{t('viewSettings.wrapText')}</span>
    </CheckRow>
    <CheckRow checked={settings.show_summary} onToggle={() => update((s) => ({ ...s, show_summary: !s.show_summary }))}>
      {t('viewSettings.showSummary')}
    </CheckRow>
    <GroupSummarySettings board={board} env={env} settings={settings} update={update} />
  </>
);

/**
 * N3: one field summarised next to each group's name — off by default. Any column whose type has a footer
 * calculation; its function defaults to the one the footer shows for that column.
 */
const GroupSummarySettings = ({
  board,
  env,
  settings,
  update,
}: {
  board: BoardDetail;
  env: QueryEnv;
  settings: ViewSettings;
  update: Update;
}) => {
  const choices = board.columns
    .filter((c) => c.type !== 'name')
    .map((c) => ({ column: c, options: groupSummaryOptions(c.id, env) }))
    .filter((x) => x.options.length > 0);
  const current = settings.group_summary;
  const chosen = choices.find((x) => x.column.id === current?.column_id);
  const footerFn = (columnId: string, options: SummaryFn[]) => {
    const f = settings.summaries[columnId];
    return f && options.includes(f) ? f : options[0]!;
  };
  const fn = chosen
    ? current?.fn && chosen.options.includes(current.fn)
      ? current.fn
      : footerFn(chosen.column.id, chosen.options)
    : undefined;
  return (
    <div>
      <Label>{t('viewSettings.groupSummary')}</Label>
      <div className="flex gap-2">
        <PickerButton
          testId="view-group-summary"
          menuLabel={t('viewSettings.groupSummary')}
          placeholder={t('summary.none')}
          label={chosen?.column.title ?? t('summary.none')}
          className="min-w-0 flex-1"
          items={[
            {
              label: t('summary.none'),
              checked: !chosen,
              onSelect: () => update((s) => ({ ...s, group_summary: null })),
            },
            ...choices.map(({ column }) => ({
              label: column.title,
              checked: column.id === chosen?.column.id,
              // A new column starts with the footer's calculation (no `fn` = follow the footer).
              onSelect: () => update((s) => ({ ...s, group_summary: { column_id: column.id } })),
            })),
          ]}
        />
        {chosen && fn ? (
          <PickerButton
            testId="view-group-summary-fn"
            menuLabel={t('viewSettings.groupSummaryFn')}
            placeholder={t(`summary.${fn}` as MessageKey)}
            label={t(`summary.${fn}` as MessageKey)}
            className="w-28 shrink-0"
            items={chosen.options.map((o) => ({
              label: t(`summary.${o}` as MessageKey),
              checked: o === fn,
              onSelect: () => update((s) => ({ ...s, group_summary: { column_id: chosen.column.id, fn: o } })),
            }))}
          />
        ) : null}
      </div>
    </div>
  );
};

const KanbanSettings = ({
  board,
  env,
  settings,
  update,
}: {
  board: BoardDetail;
  env: QueryEnv;
  settings: ViewSettings;
  update: Update;
}) => {
  const choices = kanbanColumns(board, env);
  const current = choices.find((c) => c.id === settings.kanban?.column_id) ?? choices[0];
  const kanban = settings.kanban ?? { card_fields: [], show_empty: true, lane_order: [] };
  return (
    <>
      <div>
        <Label>{t('viewSettings.laneColumn')}</Label>
        <PickerButton
          label={current?.title}
          placeholder={t('filter.column')}
          menuLabel={t('viewSettings.laneColumn')}
          className="w-full"
          testId="kanban-column"
          items={choices.map((c) => ({
            label: c.title,
            checked: c.id === current?.id,
            onSelect: () => update((s) => ({ ...s, kanban: { ...kanban, column_id: c.id } })),
          }))}
        />
      </div>
      <FieldsPicker
        board={board}
        exclude={current?.id}
        chosen={kanban.card_fields}
        fallback={defaultCardFields(board, current?.id).map((c) => c.id)}
        onChange={(card_fields) => update((s) => ({ ...s, kanban: { ...kanban, card_fields } }))}
      />
      <CheckRow
        checked={kanban.show_empty}
        onToggle={() => update((s) => ({ ...s, kanban: { ...kanban, show_empty: !kanban.show_empty } }))}
      >
        {t('viewSettings.showEmpty')}
      </CheckRow>
    </>
  );
};

const CalendarSettings = ({
  board,
  env,
  settings,
  update,
}: {
  board: BoardDetail;
  env: QueryEnv;
  settings: ViewSettings;
  update: Update;
}) => {
  const choices = calendarColumns(board, env);
  const cal = calendarSettingsOf(settings.calendar);
  const set = (patch: Partial<CalendarViewSettings>) =>
    update((s) => ({ ...s, calendar: { ...calendarSettingsOf(s.calendar), ...patch } }));
  const colorChoices = board.columns.filter((c) => safeField(c.id, env)?.model === 'label');
  const colorBy = colorChoices.find((c) => c.id === cal.color_by) ?? colorChoices[0];
  const create = useCreateColumn(board);
  const turnOnHours = useTurnOnTimelineHours(board);
  const fromTimeline = cal.time_source === 'timeline';
  // the source's own column — a timeline for "timeline with hours", a date for "date + hours".
  const sourceColumns = cal.show_hours
    ? choices.filter((c) => c.type === (fromTimeline ? 'timeline' : 'date'))
    : choices;
  const sourceColumn = sourceColumns.find((c) => c.id === cal.date_column_id) ?? sourceColumns[0];
  const needsHours =
    cal.show_hours && fromTimeline && !!sourceColumn && !(sourceColumn.settings as { show_time?: boolean }).show_time;
  const hours = hourColumns(board);
  const hourItems = (key: 'day_start' | 'day_end', from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i).map((h) => ({
      label: `${String(h).padStart(2, '0')}:00`,
      checked: cal[key] === h,
      onSelect: () => set({ [key]: h }),
    }));
  return (
    <>
      <SettingLine label={t('calendar.set.showHours')}>
        <Switch
          checked={cal.show_hours}
          onChange={(on) => set({ show_hours: on })}
          label={t('calendar.set.showHours')}
          testId="calendar-show-hours"
        />
      </SettingLine>
      {cal.show_hours ? (
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t('calendar.set.source')}>
          {CALENDAR_TIME_SOURCES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={cal.time_source === v}
              data-testid={`calendar-source-${v}`}
              onClick={() => set({ time_source: v, date_column_id: undefined })}
              className="flex items-start gap-2 text-start text-sm"
            >
              <span
                className={cn(
                  'mt-0.5 size-4 shrink-0 rounded-full border-[1.5px] border-line-strong',
                  cal.time_source === v && 'border-[5px] border-primary',
                )}
              />
              <span>
                {t(`calendar.set.source.${v}`)}
                <small className="block text-xs text-muted">{t(`calendar.set.source.${v}.hint`)}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div>
        <Label>
          {cal.show_hours && fromTimeline ? t('calendar.set.timelineColumn') : t('viewSettings.dateColumn')}
        </Label>
        <ColumnPicker
          columns={sourceColumns}
          value={sourceColumn?.id}
          onChange={(id) => set({ date_column_id: id })}
          menuLabel={t('viewSettings.dateColumn')}
          testId="calendar-column"
          create={create}
          createTypes={cal.show_hours ? [fromTimeline ? 'timeline' : 'date'] : ['date', 'timeline']}
          newTitle={(type) =>
            t(type === 'timeline' ? 'calendar.addColumn.title.timeline' : 'calendar.addColumn.title.date')
          }
          newSettings={(type) => (type === 'timeline' && cal.show_hours ? { show_time: true } : undefined)}
        />
        {needsHours ? (
          <p className="mt-1.5 text-xs text-muted" data-testid="calendar-timeline-no-hours">
            {t('calendar.set.timelineNoHours')}{' '}
            {turnOnHours ? (
              <button
                type="button"
                className="text-heading underline"
                onClick={() => void turnOnHours(sourceColumn)}
                data-testid="calendar-timeline-turn-on"
              >
                {t('calendar.set.timelineTurnOn')}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
      {cal.show_hours && !fromTimeline ? (
        <>
          <div>
            <Label>{t('calendar.set.startHour')}</Label>
            <ColumnPicker
              columns={hours}
              value={cal.start_hour_column_id}
              onChange={(id) => set({ start_hour_column_id: id })}
              placeholder={t('calendar.set.pickColumn')}
              menuLabel={t('calendar.set.startHour')}
              testId="calendar-start-hour"
              create={create}
              createTypes={['hour']}
              newTitle={() => t('calendar.set.startHour')}
            />
          </div>
          <div>
            <Label>{t('calendar.set.endHour')}</Label>
            <ColumnPicker
              columns={hours}
              value={cal.end_hour_column_id}
              onChange={(id) => set({ end_hour_column_id: id })}
              placeholder={t('calendar.set.noEnd')}
              menuLabel={t('calendar.set.endHour')}
              testId="calendar-end-hour"
              leading={[
                {
                  label: t('calendar.set.noEnd'),
                  checked: !cal.end_hour_column_id,
                  onSelect: () => set({ end_hour_column_id: undefined }),
                },
              ]}
              create={create}
              createTypes={['hour']}
              newTitle={() => t('calendar.set.endHour')}
            />
          </div>
        </>
      ) : null}
      {cal.show_hours ? (
        <>
          <SettingLine label={t('calendar.set.snap')}>
            <Segmented
              label={t('calendar.set.snap')}
              value={String(cal.snap)}
              onChange={(v) => set({ snap: Number(v) as CalendarViewSettings['snap'] })}
              testId="calendar-snap"
              options={['5', '10', '15', '30'].map((v) => ({ value: v, label: v }))}
            />
          </SettingLine>
          <SettingLine label={t('calendar.set.shownHours')}>
            <span className="flex items-center gap-1.5" dir="ltr">
              <PickerButton
                label={`${String(cal.day_start).padStart(2, '0')}:00`}
                placeholder="07:00"
                menuLabel={t('calendar.set.dayStart')}
                testId="calendar-day-start"
                items={hourItems('day_start', 0, Math.min(23, cal.day_end - 1))}
              />
              –
              <PickerButton
                label={`${String(cal.day_end).padStart(2, '0')}:00`}
                placeholder="21:00"
                menuLabel={t('calendar.set.dayEnd')}
                testId="calendar-day-end"
                items={hourItems('day_end', cal.day_start + 1, 24)}
              />
            </span>
          </SettingLine>
          <SettingLine label={t('calendar.set.hourHeight')}>
            <Segmented
              label={t('calendar.set.hourHeight')}
              value={cal.hour_height}
              onChange={(v) => set({ hour_height: v })}
              testId="calendar-hour-height"
              options={CALENDAR_HOUR_HEIGHTS.map((v) => ({ value: v, label: t(`calendar.set.hourHeight.${v}`) }))}
            />
          </SettingLine>
          <SettingLine label={t('calendar.set.duration')}>
            <Segmented
              label={t('calendar.set.duration')}
              value={String(cal.default_duration)}
              onChange={(v) => set({ default_duration: Number(v) })}
              testId="calendar-duration"
              options={['30', '60', '90'].map((v) => ({
                value: v,
                label: t('calendar.set.minutes', { n: Number(v) }),
              }))}
            />
          </SettingLine>
          <SettingLine label={t('calendar.set.weekends')}>
            <Switch
              checked={cal.show_weekends}
              onChange={(on) => set({ show_weekends: on })}
              label={t('calendar.set.weekends')}
              testId="calendar-weekends"
            />
          </SettingLine>
        </>
      ) : null}
      {colorChoices.length ? (
        <div>
          <Label>{t('viewSettings.colorBy')}</Label>
          <PickerButton
            label={colorBy?.title}
            placeholder={t('filter.column')}
            menuLabel={t('viewSettings.colorBy')}
            className="w-full"
            items={colorChoices.map((c) => ({
              label: c.title,
              checked: c.id === colorBy?.id,
              onSelect: () => set({ color_by: c.id }),
            }))}
          />
        </div>
      ) : null}
      {/* what an empty spot of a day offers. */}
      <div>
        <Label>{t('viewSettings.calendarEmptyClick')}</Label>
        <PickerButton
          label={t(`viewSettings.calendarEmptyClick.${cal.empty_click}` as MessageKey)}
          placeholder={t('viewSettings.calendarEmptyClick')}
          menuLabel={t('viewSettings.calendarEmptyClick')}
          className="w-full"
          testId="calendar-empty-click"
          items={CALENDAR_EMPTY_CLICK.map((v) => ({
            label: t(`viewSettings.calendarEmptyClick.${v}` as MessageKey),
            checked: cal.empty_click === v,
            onSelect: () => set({ empty_click: v }),
          }))}
        />
      </div>
      {cal.show_hours ? (
        <FieldsPicker
          board={board}
          exclude={sourceColumn?.id}
          label={t('calendar.set.cardFields')}
          chosen={cal.card_fields}
          fallback={quickCardFields(
            board,
            [],
            [sourceColumn?.id, cal.start_hour_column_id, cal.end_hour_column_id],
          ).map((c) => c.id)}
          onChange={(card_fields) => set({ card_fields })}
        />
      ) : null}
    </>
  );
};

/** A setting's name and its control on one line. */
const SettingLine = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-3 text-sm">
    <span className="min-w-0 text-fg">{label}</span>
    {/* The control keeps its own width (a segmented row never scrolls); the name wraps instead. */}
    <div className="shrink-0">{children}</div>
  </div>
);

/** turns "with hours" on in a timeline column (for whoever may change the board's columns). */
const useTurnOnTimelineHours = (board: BoardDetail) => {
  const account = useContext(BoardAccountContext);
  const qc = useQueryClient();
  if (!board.capabilities['column.update'] || !account.id) return null;
  return async (column: Column) => {
    try {
      await api(account.id).patch<Column>(`/boards/${board.id}/columns/${column.id}`, {
        settings: { ...(column.settings as Record<string, unknown>), show_time: true },
      });
      await qc.invalidateQueries({ queryKey: boardKeys.board(account.id, board.id) });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
};

const FieldsPicker = ({
  board,
  chosen,
  fallback,
  exclude,
  label,
  onChange,
}: {
  board: BoardDetail;
  chosen: string[];
  fallback: string[];
  exclude?: string;
  label?: string;
  onChange: (fields: string[]) => void;
}) => {
  const shown = chosen.length ? chosen : fallback;
  return (
    <div>
      <Label>{label ?? t('viewSettings.cardFields')}</Label>
      <div className="max-h-56 overflow-y-auto">
        {board.columns
          .filter((c) => c.type !== 'name' && c.id !== exclude)
          .map((c) => {
            const on = shown.includes(c.id);
            return (
              <CheckRow
                key={c.id}
                checked={on}
                onToggle={() => onChange(on ? shown.filter((x) => x !== c.id) : [...shown, c.id])}
              >
                <span className="truncate">{c.title}</span>
              </CheckRow>
            );
          })}
      </div>
    </div>
  );
};
