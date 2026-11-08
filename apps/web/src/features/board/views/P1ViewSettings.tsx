// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import {
  CHART_TYPES,
  MEASURE_FNS,
  t,
  viewChartSchema,
  WIDGET_DATE_UNITS,
  type ChartDimension,
  type QueryEnv,
  type ViewChart,
  type ViewSettings,
  msgKey,
} from '@bines/shared';
import type { BoardDetail } from '../board-api';
import { safeField } from '../toolbar/filter-model';
import { PickerButton } from '../toolbar/parts';
import { colorColumns, locationColumns } from './MapView';

/** View settings of the Chart and Map views (M8 ד9–ד10), shown in the "view settings" panel. */
type Update = (fn: (s: ViewSettings) => ViewSettings) => void;

const Label = ({ children }: { children: ReactNode }) => (
  <div className="mb-1 text-xs font-medium text-muted">{children}</div>
);

/** Columns a chart can split by: everything groupable but files, buttons and long text. */
const dimensionColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return !!f && f.model !== 'files' && !['name', 'button', 'long_text', 'doc'].includes(c.type);
  });
const numberColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return (
      f?.source === 'column' &&
      ['sum', 'avg', 'median', 'min', 'max'].some((a) => f.def.aggregates.includes(a as never))
    );
  });

const DimensionPicker = ({
  board,
  env,
  value,
  onChange,
  testId,
  label,
  allowNone,
}: {
  board: BoardDetail;
  env: QueryEnv;
  value: ChartDimension | null;
  onChange: (d: ChartDimension | null) => void;
  testId: string;
  label: string;
  allowNone?: boolean;
}) => {
  const cols = dimensionColumns(board, env);
  const current = value?.kind === 'column' ? board.columns.find((c) => c.id === value.column_id) : undefined;
  const isDate = !!current && safeField(current.id, env)?.model === 'date';
  return (
    <div>
      <Label>{label}</Label>
      <PickerButton
        testId={testId}
        className="w-full"
        menuLabel={label}
        placeholder={allowNone ? t('chartView.none') : t('chartView.group')}
        label={!value ? undefined : value.kind === 'group' ? t('chartView.group') : current?.title}
        items={[
          ...(allowNone ? [{ label: t('chartView.none'), checked: !value, onSelect: () => onChange(null) }] : []),
          {
            label: t('chartView.group'),
            checked: value?.kind === 'group',
            onSelect: () => onChange({ kind: 'group' }),
          },
          ...cols.map((c) => ({
            label: c.title,
            checked: value?.kind === 'column' && value.column_id === c.id,
            onSelect: () => onChange({ kind: 'column', column_id: c.id, date_unit: 'month' }),
          })),
        ]}
      />
      {isDate && value?.kind === 'column' ? (
        <PickerButton
          testId={`${testId}-unit`}
          className="mt-1 w-full"
          menuLabel={t('chartView.dateUnit')}
          placeholder={t('chartView.unit.month')}
          label={t(msgKey(`chartView.unit.${value.date_unit}`))}
          items={WIDGET_DATE_UNITS.map((u) => ({
            label: t(msgKey(`chartView.unit.${u}`)),
            checked: value.date_unit === u,
            onSelect: () => onChange({ ...value, date_unit: u }),
          }))}
        />
      ) : null}
    </div>
  );
};

export const ChartSettings = ({
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
  const c = viewChartSchema.parse(settings.chart ?? {});
  const set = (patch: Partial<ViewChart>) => update((s) => ({ ...s, chart: { ...c, ...patch } }));
  const nums = numberColumns(board, env);
  return (
    <div className="space-y-3" data-testid="chart-settings">
      <div>
        <Label>{t('chartView.type')}</Label>
        <PickerButton
          testId="chart-type"
          className="w-full"
          menuLabel={t('chartView.type')}
          placeholder={t('chartView.type.bar')}
          label={t(msgKey(`chartView.type.${c.chart_type}`))}
          items={CHART_TYPES.map((x) => ({
            label: t(msgKey(`chartView.type.${x}`)),
            checked: c.chart_type === x,
            onSelect: () => set({ chart_type: x }),
          }))}
        />
      </div>
      <DimensionPicker
        board={board}
        env={env}
        value={c.x}
        onChange={(x) => set({ x: x ?? { kind: 'group' } })}
        testId="chart-x"
        label={c.chart_type === 'pie' || c.chart_type === 'donut' ? t('chartView.slices') : t('chartView.x')}
      />
      {c.chart_type === 'stacked_bar' ? (
        <DimensionPicker
          board={board}
          env={env}
          value={c.series}
          onChange={(series) => set({ series })}
          testId="chart-series"
          label={t('chartView.series')}
          allowNone
        />
      ) : null}
      <div>
        <Label>{t('chartView.measure')}</Label>
        <PickerButton
          testId="chart-measure"
          className="w-full"
          menuLabel={t('chartView.measure')}
          placeholder={t('chartView.fn.count')}
          label={t(msgKey(`chartView.fn.${c.measure.fn}`))}
          items={MEASURE_FNS.filter((f) => f === 'count' || nums.length).map((f) => ({
            label: t(msgKey(`chartView.fn.${f}`)),
            checked: c.measure.fn === f,
            onSelect: () =>
              set({
                measure:
                  f === 'count' ? { fn: f, column_id: null } : { fn: f, column_id: c.measure.column_id ?? nums[0]!.id },
              }),
          }))}
        />
        {c.measure.fn !== 'count' ? (
          <PickerButton
            testId="chart-measure-column"
            className="mt-1 w-full"
            menuLabel={t('chartView.measureColumn')}
            placeholder={t('chartView.measureColumn')}
            label={nums.find((n) => n.id === c.measure.column_id)?.title}
            items={nums.map((n) => ({
              label: n.title,
              checked: n.id === c.measure.column_id,
              onSelect: () => set({ measure: { ...c.measure, column_id: n.id } }),
            }))}
          />
        ) : null}
      </div>
    </div>
  );
};

export const MapSettings = ({
  board,
  env,
  settings,
  update,
  fields,
}: {
  board: BoardDetail;
  env: QueryEnv;
  settings: ViewSettings;
  update: Update;
  /** The card-fields picker (shared with Kanban / Cards). */
  fields: ReactNode;
}) => {
  const m = { card_fields: [], ...settings.map };
  const locs = locationColumns(board);
  const colors = colorColumns(board, env);
  const loc = locs.find((c) => c.id === m.location_column_id) ?? locs[0];
  const color = m.color_by === '' ? undefined : (board.columns.find((c) => c.id === m.color_by) ?? colors[0]);
  return (
    <div className="space-y-3" data-testid="map-settings">
      <div>
        <Label>{t('mapView.column')}</Label>
        <PickerButton
          testId="map-location-column"
          className="w-full"
          menuLabel={t('mapView.column')}
          placeholder={t('mapView.noColumn')}
          label={loc?.title}
          items={locs.map((c) => ({
            label: c.title,
            checked: c.id === loc?.id,
            onSelect: () => update((s) => ({ ...s, map: { ...m, location_column_id: c.id } })),
          }))}
        />
      </div>
      <div>
        <Label>{t('mapView.colorBy')}</Label>
        <PickerButton
          testId="map-color-by"
          className="w-full"
          menuLabel={t('mapView.colorBy')}
          placeholder={t('mapView.noColor')}
          label={color?.title}
          items={[
            {
              label: t('mapView.noColor'),
              checked: !color,
              onSelect: () => update((s) => ({ ...s, map: { ...m, color_by: '' } })),
            },
            ...colors.map((c) => ({
              label: c.title,
              checked: c.id === color?.id,
              onSelect: () => update((s) => ({ ...s, map: { ...m, color_by: c.id } })),
            })),
          ]}
        />
      </div>
      {fields}
    </div>
  );
};
