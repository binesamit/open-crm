// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import {
  CHART_TYPES,
  type ColumnRef,
  type ColumnRole,
  columnFitsRole,
  columnTypes,
  type DashboardColumns,
  type Dimension,
  FILTER_OPERATORS,
  getRegion,
  isRelationMatchOp,
  type Measure,
  MEASURE_FNS,
  resolveColumnRef,
  sourceReadsItems,
  sourceReadsSubitems,
  t,
  TIME_GROUPS,
  TIME_RANGES,
  type Widget,
  WIDGET_DATE_UNITS,
  WIDGET_SOURCES,
  type WidgetFilter,
  type WidgetSource,
  widgetTypes,
  msgKey,
  dynamicKey,
  paint,
} from '@bines/shared';
import { Button, Dialog, Field, Input, Notice, Picker, Segmented, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { DateField } from './DateField';
import { DateRuleValues } from '../board/toolbar/DateRuleValue';

/**
 * A widget's settings (M8 ד4–ד5), all in the UI: its sources (some of the dashboard's boards), its own filter, and
 * per type — columns (named by type + title across boards, with a manual column per board when titles differ),
 * calculation, grouping, chart type, range… One form per type, keyed like the registry.
 */
type S = Record<string, unknown>;
/** The boards a widget may choose among (a dashboard's sources; a board view's own board). */
export type WidgetBoards = { id: string; name: string }[];
type FormProps = { settings: S; set: (patch: S) => void; columns: DashboardColumns; boards: WidgetBoards };

/**
 * The pickers' columns for a widget's source (round 15): the boards' columns for items, their sub-boards' for
 * subitems, both for both — a column offered is one the widget can read.
 */
export const scopeColumns = (cols: DashboardColumns, source: WidgetSource | undefined): DashboardColumns => {
  const boards = cols.boards.filter((b) => (b.subitems_of ? sourceReadsSubitems(source) : sourceReadsItems(source)));
  const ids = new Set(boards.map((b) => b.id));
  return { boards, columns: cols.columns.filter((c) => Object.keys(c.keys).some((id) => ids.has(id))) };
};

/** A source entry's name: a sub-board is its board's subitems. */
const boardLabel = (b: DashboardColumns['boards'][number]) =>
  b.subitems_of ? t('dashboards.subitemsOf', { board: b.name }) : b.name;

const refValue = (r: ColumnRef | null | undefined) => (r ? `${r.type}\u0000${r.title}` : '');

/** One column across the sources, filtered to what the field accepts; boards without it get a manual choice. */
const ColumnField = ({
  label,
  role,
  value,
  onChange,
  columns,
  allowNone,
  testId,
}: {
  label: string;
  role: ColumnRole;
  value: ColumnRef | null | undefined;
  onChange: (r: ColumnRef | null) => void;
  columns: DashboardColumns;
  allowNone?: boolean;
  testId?: string;
}) => {
  const options = columns.columns
    .filter((c) => columnFitsRole(c.type, role))
    .map((c) => ({
      value: refValue(c),
      label: `${c.title} · ${columnTypes.get(c.type)?.labelHe ?? c.type}`,
    }));
  const missing = value
    ? columns.boards.filter(
        (b) => !resolveColumnRef(value, b.id, b.columns) && b.columns.some((c) => columnFitsRole(c.type, role)),
      )
    : [];
  const mapped = value ? columns.boards.filter((b) => value.keys?.[b.id]) : [];
  return (
    <div className="space-y-1.5">
      <Field label={label}>
        <Picker
          label={label}
          value={refValue(value)}
          placeholder={t('dashboards.pickColumn')}
          options={[...(allowNone ? [{ value: '', label: t('dashboards.noColumn') }] : []), ...options]}
          searchable
          testId={testId}
          onChange={(v) => {
            if (!v) return onChange(null);
            const c = columns.columns.find((x) => refValue(x) === v)!;
            onChange({ type: c.type, title: c.title });
          }}
        />
      </Field>
      {[...new Set([...missing, ...mapped])].map((b) => (
        <div key={b.id} className="flex items-center gap-2 ps-3 text-xs text-muted">
          <span className="w-32 shrink-0 truncate">{boardLabel(b)}</span>
          <Picker
            label={t('dashboards.columnOn', { board: boardLabel(b) })}
            value={value?.keys?.[b.id] ?? ''}
            placeholder={t('dashboards.notOnBoard')}
            className="h-8"
            options={b.columns
              .filter((c) => columnFitsRole(c.type, role))
              .map((c) => ({ value: c.id, label: c.title }))}
            onChange={(key) => onChange({ ...value!, keys: { ...(value?.keys ?? {}), [b.id]: key } })}
          />
        </div>
      ))}
    </div>
  );
};

/** Which of the dashboard's boards the widget reads (none ticked = all). */
const BoardsField = ({ settings, set, boards }: FormProps) => {
  const chosen = (settings.board_ids as string[] | undefined) ?? [];
  const toggle = (id: string) =>
    set({ board_ids: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] });
  if (boards.length < 2) return null;
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-semibold text-fg-2">{t('dashboards.widgetBoards')}</legend>
      <p className="text-xs text-muted">{t('dashboards.widgetBoards.hint')}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {boards.map((b) => (
          <label key={b.id} className="inline-flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={chosen.includes(b.id)}
              onChange={() => toggle(b.id)}
              data-testid="widget-board-option"
            />
            {b.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
};

const MeasureField = ({
  value,
  onChange,
  columns,
}: {
  value: Measure;
  onChange: (m: Measure) => void;
  columns: DashboardColumns;
}) => (
  <div className="grid gap-2 sm:grid-cols-2">
    <Field label={t('dashboards.measure')}>
      <Picker
        label={t('dashboards.measure')}
        value={value.fn}
        testId="widget-measure-fn"
        options={MEASURE_FNS.map((f) => ({ value: f, label: t(msgKey(`dashboards.fn.${f}`)) }))}
        onChange={(fn) => onChange({ fn, column: fn === 'count' ? null : value.column })}
      />
    </Field>
    {value.fn !== 'count' ? (
      <ColumnField
        label={t('dashboards.measureColumn')}
        role="number"
        value={value.column}
        columns={columns}
        testId="widget-measure-column"
        onChange={(column) => onChange({ ...value, column })}
      />
    ) : null}
  </div>
);

const DimensionField = ({
  label,
  value,
  onChange,
  columns,
  testId,
}: {
  label: string;
  value: Dimension;
  onChange: (d: Dimension) => void;
  columns: DashboardColumns;
  testId: string;
}) => (
  <div className="space-y-2">
    <Field label={label}>
      <Segmented
        label={label}
        value={value.kind}
        testId={testId}
        onChange={(kind) =>
          onChange(
            kind === 'column'
              ? {
                  kind,
                  column: columns.columns.find((c) => columnFitsRole(c.type, 'labels')) ??
                    columns.columns[0] ?? { type: 'status', title: '' },
                  date_unit: 'month',
                }
              : { kind },
          )
        }
        options={(['board', 'group', 'column'] as const).map((v) => ({
          value: v,
          label: t(msgKey(`dashboards.dim.${v}`)),
          testId: `${testId}-${v}`,
        }))}
      />
    </Field>
    {value.kind === 'column' ? (
      <div className="grid gap-2 sm:grid-cols-2">
        <ColumnField
          label={t('dashboards.column')}
          role="any"
          value={{ type: value.column.type, title: value.column.title, keys: value.column.keys }}
          columns={columns}
          testId={`${testId}-column`}
          onChange={(c) => c && onChange({ ...value, column: c })}
        />
        {columnFitsRole(value.column.type, 'date') ? (
          <Field label={t('dashboards.dateUnit')}>
            <Picker
              label={t('dashboards.dateUnit')}
              value={value.date_unit}
              options={WIDGET_DATE_UNITS.map((u) => ({ value: u, label: t(msgKey(`dashboards.unit.${u}`)) }))}
              onChange={(date_unit) => onChange({ ...value, date_unit })}
            />
          </Field>
        ) : null}
      </div>
    ) : null}
  </div>
);

const NO_VALUE_OPS = new Set(['is_empty', 'is_not_empty', 'is_done', 'is_not_done']);
/** A date rule's values change shape with the operator (N + unit, two dates, one date). */
const dateShape = (op: string) =>
  op === 'within_the_last' || op === 'within_the_next' ? 'relative' : op === 'between' ? 'pair' : 'one';

/** The widget's own filter: rules on columns across the boards (labels by their text). */
const FilterField = ({ settings, set, columns }: FormProps) => {
  const filter = (settings.filter as WidgetFilter | undefined) ?? { operator: 'and', rules: [] };
  const put = (next: WidgetFilter) => set({ filter: next });
  const first = columns.columns[0];
  return (
    <fieldset className="space-y-2" data-testid="widget-filter">
      <legend className="text-xs font-semibold text-fg-2">{t('dashboards.filter')}</legend>
      {filter.rules.length > 1 ? (
        <Segmented
          label={t('dashboards.filter')}
          value={filter.operator}
          onChange={(operator) => put({ ...filter, operator })}
          options={[
            { value: 'and', label: t('dashboards.filter.and') },
            { value: 'or', label: t('dashboards.filter.or') },
          ]}
        />
      ) : null}
      {filter.rules.map((r, i) => {
        const def = columnTypes.get(r.column.type);
        // r19relfilter: a relation's "does not match its filter" is per viewer — not a dashboard filter.
        const ops = (def?.filterOperators ?? []).filter(
          (o) => (FILTER_OPERATORS as readonly string[]).includes(o) && !isRelationMatchOp(o),
        );
        const merged = columns.columns.find((c) => c.type === r.column.type && c.title === r.column.title);
        // Fix: a date column filters by relative dates (today, this week, last 30 days…) or an exact day.
        const isDate = def?.filterModel === 'date';
        const replace = (rule: WidgetFilter['rules'][number]) =>
          put({ ...filter, rules: filter.rules.map((x, j) => (j === i ? rule : x)) });
        return (
          <div
            key={i}
            className="space-y-1.5 rounded-[10px] border border-line-soft p-2"
            data-testid="widget-filter-rule"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <ColumnField
                label={t('dashboards.column')}
                role="any"
                value={r.column}
                columns={columns}
                onChange={(c) => c && replace({ column: c, operator: 'any_of', values: [] })}
              />
              <Field label={t('filter.operator')}>
                <Picker
                  label={t('filter.operator')}
                  value={r.operator}
                  options={ops.map((o) => ({
                    value: o,
                    label: t(
                      msgKey(
                        isDate && (o === 'greater_than' || o === 'lower_than')
                          ? `filter.op.date.${o}`
                          : `filter.op.${o}`,
                      ),
                    ),
                  }))}
                  onChange={(operator) =>
                    replace({
                      ...r,
                      operator,
                      values:
                        NO_VALUE_OPS.has(operator) || (isDate && dateShape(operator) !== dateShape(r.operator))
                          ? []
                          : r.values,
                    })
                  }
                />
              </Field>
            </div>
            {NO_VALUE_OPS.has(r.operator) ? null : isDate ? (
              <div data-testid="widget-filter-date">
                <DateRuleValues
                  operator={r.operator}
                  values={r.values}
                  firstDay={getRegion().first_day}
                  onChange={(values) => replace({ ...r, values })}
                />
              </div>
            ) : merged?.labels.length ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {merged.labels.map((l) => (
                  <label key={l.label} className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={r.values.includes(l.label)}
                      data-testid="widget-filter-label"
                      onChange={() =>
                        replace({
                          ...r,
                          values: r.values.includes(l.label)
                            ? r.values.filter((v) => v !== l.label)
                            : [...r.values, l.label],
                        })
                      }
                    />
                    <span aria-hidden className="size-2.5 rounded-full" style={{ background: paint(l.color) }} />
                    {l.label}
                  </label>
                ))}
              </div>
            ) : (
              <Input
                value={String(r.values[0] ?? '')}
                aria-label={t('dashboards.filter.value')}
                placeholder={t('dashboards.filter.value')}
                onChange={(e) => replace({ ...r, values: e.target.value ? [e.target.value] : [] })}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => put({ ...filter, rules: filter.rules.filter((_, j) => j !== i) })}
            >
              {t('dashboards.filter.remove')}
            </Button>
          </div>
        );
      })}
      {first ? (
        <Button
          variant="dashed"
          size="sm"
          data-testid="widget-filter-add"
          onClick={() =>
            put({
              ...filter,
              rules: [
                ...filter.rules,
                { column: { type: first.type, title: first.title }, operator: 'any_of', values: [] },
              ],
            })
          }
        >
          + {t('dashboards.filter.add')}
        </Button>
      ) : null}
    </fieldset>
  );
};

/** Round 15: the items, the subitems or both of every source board. */
const SourceField = ({ settings, set }: FormProps) => (
  <Field label={t('dashboards.source')}>
    <Segmented
      label={t('dashboards.source')}
      value={(settings.source as WidgetSource | undefined) ?? 'items'}
      testId="widget-source"
      onChange={(source) => set({ source })}
      options={WIDGET_SOURCES.map((v) => ({
        value: v,
        label: t(msgKey(`dashboards.source.${v}`)),
        testId: `widget-source-${v}`,
      }))}
    />
  </Field>
);

const Sources = (p: FormProps) => (
  <>
    <SourceField {...p} />
    <BoardsField {...p} />
    <FilterField {...p} />
  </>
);

const FORMS: Record<string, (p: FormProps) => ReactNode> = {
  numbers: (p) => (
    <>
      <MeasureField
        value={p.settings.measure as Measure}
        columns={p.columns}
        onChange={(measure) => p.set({ measure })}
      />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('dashboards.prefix')}>
          <Input
            value={String(p.settings.prefix ?? '')}
            maxLength={12}
            onChange={(e) => p.set({ prefix: e.target.value })}
          />
        </Field>
        <Field label={t('dashboards.suffix')}>
          <Input
            value={String(p.settings.suffix ?? '')}
            maxLength={12}
            onChange={(e) => p.set({ suffix: e.target.value })}
          />
        </Field>
      </div>
      <Sources {...p} />
    </>
  ),
  battery: (p) => (
    <>
      <ColumnField
        label={t('dashboards.statusColumn')}
        role="labels"
        value={p.settings.column as ColumnRef | null}
        columns={p.columns}
        testId="widget-status-column"
        onChange={(column) => p.set({ column })}
      />
      <Sources {...p} />
    </>
  ),
  chart: (p) => (
    <>
      <Field label={t('dashboards.chartType')}>
        <Segmented
          label={t('dashboards.chartType')}
          value={p.settings.chart_type as (typeof CHART_TYPES)[number]}
          testId="widget-chart-type"
          onChange={(chart_type) => p.set({ chart_type })}
          options={CHART_TYPES.map((c) => ({
            value: c,
            label: t(msgKey(`dashboards.chart.${c}`)),
            testId: `chart-type-${c}`,
          }))}
        />
      </Field>
      <DimensionField
        label={t('dashboards.xAxis')}
        value={p.settings.x as Dimension}
        columns={p.columns}
        testId="widget-x"
        onChange={(x) => p.set({ x })}
      />
      {p.settings.chart_type === 'stacked_bar' ? (
        <DimensionField
          label={t('dashboards.series')}
          value={(p.settings.series as Dimension | null) ?? { kind: 'group' }}
          columns={p.columns}
          testId="widget-series"
          onChange={(series) => p.set({ series })}
        />
      ) : null}
      <MeasureField
        value={p.settings.measure as Measure}
        columns={p.columns}
        onChange={(measure) => p.set({ measure })}
      />
      <Sources {...p} />
    </>
  ),
  table: (p) => {
    const cols = (p.settings.columns as ColumnRef[]) ?? [];
    return (
      <>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-fg-2">{t('dashboards.columns')}</legend>
          {cols.map((c, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <ColumnField
                  label={t('dashboards.column')}
                  role="any"
                  value={c}
                  columns={p.columns}
                  onChange={(n) => n && p.set({ columns: cols.map((x, j) => (j === i ? n : x)) })}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('dashboards.filter.remove')}
                onClick={() => p.set({ columns: cols.filter((_, j) => j !== i) })}
              >
                ✕
              </Button>
            </div>
          ))}
          {cols.length < 8 && p.columns.columns[0] ? (
            <Button
              variant="dashed"
              size="sm"
              data-testid="widget-table-add-column"
              onClick={() =>
                p.set({ columns: [...cols, { type: p.columns.columns[0]!.type, title: p.columns.columns[0]!.title }] })
              }
            >
              + {t('dashboards.addColumn')}
            </Button>
          ) : null}
        </fieldset>
        <Sources {...p} />
      </>
    );
  },
  calendar: (p) => <DatedForm {...p} />,
  timeline: (p) => <DatedForm {...p} />,
  workload: (p) => (
    <>
      <ColumnField
        label={t('dashboards.peopleColumn')}
        role="people"
        value={p.settings.people_column as ColumnRef | null}
        columns={p.columns}
        testId="widget-people-column"
        onChange={(people_column) => p.set({ people_column })}
      />
      <MeasureField
        value={p.settings.measure as Measure}
        columns={p.columns}
        onChange={(measure) => p.set({ measure })}
      />
      <ColumnField
        label={t('dashboards.splitColumn')}
        role="labels"
        allowNone
        value={p.settings.split_column as ColumnRef | null}
        columns={p.columns}
        onChange={(split_column) => p.set({ split_column })}
      />
      <Sources {...p} />
    </>
  ),
  time_report: (p) => (
    <>
      <Field label={t('dashboards.time.groupBy')}>
        <Picker
          label={t('dashboards.time.groupBy')}
          value={p.settings.group_by as (typeof TIME_GROUPS)[number]}
          testId="widget-time-group"
          options={TIME_GROUPS.map((g) => ({ value: g, label: t(msgKey(`dashboards.time.by.${g}`)) }))}
          onChange={(group_by) => p.set({ group_by })}
        />
      </Field>
      {p.settings.group_by === 'column' ? (
        <ColumnField
          label={t('dashboards.column')}
          role="any"
          value={p.settings.column as ColumnRef | null}
          columns={p.columns}
          onChange={(column) => p.set({ column })}
        />
      ) : null}
      <Field label={t('dashboards.time.range')}>
        <Picker
          label={t('dashboards.time.range')}
          value={p.settings.range as (typeof TIME_RANGES)[number]}
          testId="widget-time-range"
          options={TIME_RANGES.map((r) => ({ value: r, label: t(msgKey(`dashboards.time.range.${r}`)) }))}
          onChange={(range) => p.set({ range })}
        />
      </Field>
      {p.settings.range === 'custom' ? (
        <div className="grid grid-cols-2 gap-2">
          <DateField
            label={t('dashboards.time.from')}
            value={p.settings.from as string | null}
            onChange={(from) => p.set({ from })}
          />
          <DateField
            label={t('dashboards.time.to')}
            value={p.settings.to as string | null}
            onChange={(to) => p.set({ to })}
          />
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={!!p.settings.billable_only} onChange={(billable_only) => p.set({ billable_only })} />
        {t('dashboards.time.billableOnly')}
      </label>
      <BoardsField {...p} />
    </>
  ),
  board_view: (p) => {
    const board = p.columns.boards.find((b) => b.id === p.settings.board_id);
    return (
      <>
        <Field label={t('dashboards.board')}>
          <Picker
            label={t('dashboards.board')}
            value={String(p.settings.board_id ?? '')}
            placeholder={t('dashboards.pickBoard')}
            testId="widget-board"
            options={p.columns.boards.map((b) => ({ value: b.id, label: b.name }))}
            onChange={(board_id) => p.set({ board_id, view_id: null })}
          />
        </Field>
        {board ? (
          <Field label={t('dashboards.view')}>
            <Picker
              label={t('dashboards.view')}
              value={String(p.settings.view_id ?? '')}
              options={[
                { value: '', label: t('dashboards.wholeBoard') },
                ...board.views.map((v) => ({ value: v.id, label: v.name })),
              ]}
              onChange={(view_id) => p.set({ view_id: view_id || null })}
            />
          </Field>
        ) : null}
      </>
    );
  },
  text: (p) => (
    <Field label={t('dashboards.text')}>
      <textarea
        className="min-h-40 w-full rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm text-fg focus:border-primary focus:outline-none"
        value={String(p.settings.text ?? '')}
        maxLength={5000}
        data-testid="widget-text-input"
        onChange={(e) => p.set({ text: e.target.value })}
      />
    </Field>
  ),
};

const DatedForm = (p: FormProps) => (
  <>
    <ColumnField
      label={t('dashboards.dateColumn')}
      role="date"
      value={p.settings.date_column as ColumnRef | null}
      columns={p.columns}
      testId="widget-date-column"
      onChange={(date_column) => p.set({ date_column })}
    />
    <ColumnField
      label={t('dashboards.colorColumn')}
      role="labels"
      allowNone
      value={p.settings.color_column as ColumnRef | null}
      columns={p.columns}
      onChange={(color_column) => p.set({ color_column })}
    />
    <Sources {...p} />
  </>
);

export const WidgetSettingsDialog = ({
  widget,
  boards,
  columns,
  onSave,
  onClose,
  busy,
  error,
}: {
  widget: Widget;
  boards: WidgetBoards;
  columns: DashboardColumns;
  onSave: (v: { title: string; settings: S }) => void;
  onClose: () => void;
  busy: boolean;
  error: unknown;
}) => {
  const [title, setTitle] = useState(widget.title);
  const [settings, setSettings] = useState<S>(widget.settings);
  const Form = FORMS[widget.type];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('dashboards.widgetSettings', { type: t(dynamicKey(`dashboards.type.${widget.type}`)) })}
      className="max-w-xl!"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} data-testid="widget-settings-save" onClick={() => onSave({ title, settings })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="widget-settings" data-type={widget.type}>
        <Field label={t('dashboards.widgetTitle')}>
          <Input
            value={title}
            maxLength={255}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="widget-title-input"
          />
        </Field>
        {Form ? (
          <Form
            settings={settings}
            set={(patch) => setSettings((s) => ({ ...s, ...patch }))}
            columns={'source' in settings ? scopeColumns(columns, settings.source as WidgetSource) : columns}
            boards={boards}
          />
        ) : null}
        {/* a click on a value lists its items (on by default; types that can). */}
        {widgetTypes.get(widget.type)?.drill?.length ? (
          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={(settings as { drill?: boolean }).drill !== false}
              onChange={(drill) => setSettings((s) => ({ ...s, drill }))}
              testId="widget-drill-setting"
            />
            <span>
              <span className="block text-fg">{t('dashboards.drill.setting')}</span>
              <span className="block text-xs text-muted">{t('dashboards.drill.settingHint')}</span>
            </span>
          </label>
        ) : null}
        {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
