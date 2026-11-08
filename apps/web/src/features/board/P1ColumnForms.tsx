// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import {
  BUTTON_ACTIONS,
  buttonSettingsSchema,
  columnTypes,
  colorKeyFromHex,
  GROUP_COLORS,
  GROUP_PALETTE,
  t,
  type ButtonAction,
  msgKey,
  dynamicKey,
} from '@bines/shared';
import { Button, cn, Field, Input, Segmented, Switch } from '@bines/ui';
import { columnTypeLabel } from '../../lib/locale';
import { colorName } from '../../lib/label-color';
import type { BoardDetail, Column } from './board-api';
import { PickerButton } from './toolbar/parts';
import { ProgressForm } from './ProgressForm';
import { EMPTY_POPUP, PopupEditor } from './workflow/popup';
import { EMPTY_LINKED, LinkedButtonEditor } from './LinkedButtonEditor';

/**
 * Settings of the P1 columns (M8 ד10–ד11) — everything in the UI, nothing per client: progress weights, the
 * button's text / colour / confirmation / action, hour and clock formats, working hours, the colour format and
 * the week's first day.
 */
type Save = (settings: Record<string, unknown>) => Promise<unknown>;
export type P1FormProps = {
  accountId: string;
  board: BoardDetail;
  column: Column;
  busy: boolean;
  onSave: Save;
  shell: (body: ReactNode, save: ReactNode) => ReactNode;
};

const SaveButton = ({ busy, onClick }: { busy: boolean; onClick: () => void }) => (
  <Button busy={busy} data-testid="column-settings-save" onClick={onClick}>
    {t('common.save')}
  </Button>
);

const FormatField = ({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
}) => (
  <Field label={label}>
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      testId="column-format"
      options={options.map((o) => ({ value: o, label: t(dynamicKey(`p1.format.${o}`)), testId: `format-${o}` }))}
    />
  </Field>
);

// ---- button ----
/** Our palette's colours (a button stores its hex). */
const SWATCHES = GROUP_PALETTE.map((k) => GROUP_COLORS[k]);
const writable = (board: BoardDetail) =>
  board.columns.filter((c) => {
    const def = columnTypes.get(c.type);
    return !!def && !def.readOnly && def.storage === 'cell' && !def.engine && c.type !== 'name';
  });

const ButtonForm = ({ accountId, board, column, busy, onSave, shell }: P1FormProps) => {
  const initial = buttonSettingsSchema.parse(column.settings ?? {});
  const [label, setLabel] = useState(initial.label);
  const [color, setColor] = useState(initial.color);
  const [confirm, setConfirm] = useState(initial.confirm);
  const [action, setAction] = useState<ButtonAction>(initial.action);
  const targets = writable(board);
  const values = action.kind === 'set_values' ? action.values : [];
  const setValues = (next: { column_id: string; text: string }[]) => setAction({ kind: 'set_values', values: next });
  return shell(
    <>
      <Field label={t('button.label')}>
        <Input
          value={label}
          maxLength={40}
          placeholder={column.title}
          data-testid="button-label"
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <Field label={t('button.color')}>
        <div className="flex flex-wrap gap-1.5" data-testid="button-colors">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={colorName(colorKeyFromHex(c))}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
              className={cn(
                'size-6 rounded-[6px] border border-black/10',
                color === c && 'ring-2 ring-primary ring-offset-1',
              )}
              style={{ background: c }}
            />
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={confirm} onChange={setConfirm} testId="button-confirm" />
        {t('button.askConfirm')}
      </label>
      <Field label={t('button.action')}>
        <Segmented
          label={t('button.action')}
          value={action.kind}
          testId="button-action"
          onChange={(kind) =>
            setAction(
              kind === 'open_url'
                ? { kind, url: action.kind === 'open_url' ? action.url : 'https://' }
                : kind === 'set_values'
                  ? { kind, values }
                  : kind === 'popup'
                    ? { kind, popup: action.kind === 'popup' ? action.popup : EMPTY_POPUP }
                    : kind === 'create_linked'
                      ? action.kind === 'create_linked'
                        ? action
                        : EMPTY_LINKED
                      : { kind: 'automation' },
            )
          }
          options={BUTTON_ACTIONS.map((a) => ({
            value: a,
            label: t(msgKey(`button.kind.${a}`)),
            testId: `button-kind-${a}`,
          }))}
        />
      </Field>
      {action.kind === 'automation' ? (
        <p className="text-sm text-muted" data-testid="button-automation-hint">
          {t('button.automationHint')}
        </p>
      ) : null}
      {action.kind === 'open_url' ? (
        <Field label={t('button.url')} hint={t('button.urlHint')}>
          <Input
            dir="ltr"
            value={action.url}
            data-testid="button-url"
            onChange={(e) => setAction({ kind: 'open_url', url: e.target.value })}
          />
        </Field>
      ) : null}
      {action.kind === 'popup' ? (
        <PopupEditor
          accountId={accountId}
          board={board}
          excludeColumnId={column.id}
          popup={action.popup}
          onChange={(popup) => setAction({ kind: 'popup', popup })}
        />
      ) : null}
      {action.kind === 'create_linked' ? (
        <LinkedButtonEditor accountId={accountId} board={board} action={action} onChange={setAction} />
      ) : null}
      {action.kind === 'set_values' ? (
        <Field label={t('button.setValues')} hint={t('button.setValuesHint')}>
          <div className="flex flex-col gap-1.5" data-testid="button-values">
            {values.map((v, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <PickerButton
                  className="w-40 shrink-0"
                  testId="button-value-column"
                  menuLabel={t('button.column')}
                  placeholder={t('button.column')}
                  label={targets.find((c) => c.id === v.column_id)?.title}
                  items={targets.map((c) => ({
                    label: `${c.title} · ${columnTypeLabel(c.type)}`,
                    checked: c.id === v.column_id,
                    onSelect: () => setValues(values.map((x, j) => (j === i ? { ...x, column_id: c.id } : x))),
                  }))}
                />
                <Input
                  className="h-8 min-w-0 flex-1"
                  value={v.text}
                  data-testid="button-value-text"
                  placeholder={t('button.valuePlaceholder')}
                  onChange={(e) => setValues(values.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                />
                <button
                  type="button"
                  aria-label={t('common.delete')}
                  className="px-1 text-muted hover:text-fg"
                  onClick={() => setValues(values.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
            {values.length < 20 && targets.length ? (
              <button
                type="button"
                data-testid="button-value-add"
                className="self-start text-sm text-primary hover:underline"
                onClick={() => setValues([...values, { column_id: targets[0]!.id, text: '' }])}
              >
                + {t('button.addValue')}
              </button>
            ) : null}
          </div>
        </Field>
      ) : null}
    </>,
    <SaveButton
      busy={busy}
      onClick={() =>
        void onSave({
          label: label.trim(),
          color,
          confirm,
          action:
            action.kind === 'set_values'
              ? { kind: 'set_values', values: action.values.filter((v) => v.column_id) }
              : action,
        })
      }
    />,
  );
};

// ---- hour / colour (formats) ----
const HourForm = ({ column, busy, onSave, shell }: P1FormProps) => {
  const [format, setFormat] = useState(String(column.settings.format ?? 'auto'));
  return shell(
    <FormatField value={format} onChange={setFormat} options={['auto', '24h', '12h']} label={t('p1.timeFormat')} />,
    <SaveButton busy={busy} onClick={() => void onSave({ ...column.settings, format })} />,
  );
};

const ColorForm = ({ column, busy, onSave, shell }: P1FormProps) => {
  const [format, setFormat] = useState(String(column.settings.format ?? 'hex'));
  return shell(
    <FormatField value={format} onChange={setFormat} options={['hex', 'rgb']} label={t('p1.colorFormat')} />,
    <SaveButton busy={busy} onClick={() => void onSave({ ...column.settings, format })} />,
  );
};

// ---- week ----
const WeekForm = ({ column, busy, onSave, shell }: P1FormProps) => {
  const [first, setFirst] = useState<string>(
    typeof column.settings.first_day === 'number' ? String(column.settings.first_day) : 'account',
  );
  return shell(
    <Field label={t('week.firstDay')}>
      <PickerButton
        testId="week-first-day"
        menuLabel={t('week.firstDay')}
        placeholder={t('week.firstDay.account')}
        label={first === 'account' ? t('week.firstDay.account') : t(dynamicKey(`weekday.${first}`))}
        items={['account', '0', '1', '6'].map((d) => ({
          label: d === 'account' ? t('week.firstDay.account') : t(dynamicKey(`weekday.${d}`)),
          checked: first === d,
          onSelect: () => setFirst(d),
        }))}
      />
    </Field>,
    <SaveButton busy={busy} onClick={() => void onSave(first === 'account' ? {} : { first_day: Number(first) })} />,
  );
};

// ---- world clock ----
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const WorldClockForm = ({ column, busy, onSave, shell }: P1FormProps) => {
  const s = column.settings as { format?: string; work_start?: string; work_end?: string; work_days?: number[] };
  const [format, setFormat] = useState(s.format ?? 'auto');
  const [start, setStart] = useState(s.work_start ?? '09:00');
  const [end, setEnd] = useState(s.work_end ?? '18:00');
  const [days, setDays] = useState<number[]>(s.work_days ?? [0, 1, 2, 3, 4]);
  const ok = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  return shell(
    <>
      <FormatField value={format} onChange={setFormat} options={['auto', '24h', '12h']} label={t('p1.timeFormat')} />
      <Field label={t('worldClock.hours')}>
        <div className="flex items-center gap-2" dir="ltr">
          <Input
            className="h-8 w-20"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            data-testid="clock-start"
          />
          <span>–</span>
          <Input className="h-8 w-20" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="clock-end" />
        </div>
      </Field>
      <Field label={t('worldClock.days')}>
        <div className="flex flex-wrap gap-1" data-testid="clock-days">
          {DAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => setDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d].sort()))}
              className={cn(
                'h-8 rounded-[8px] border px-2.5 text-xs',
                days.includes(d) ? 'border-primary bg-primary text-[var(--on-primary)]' : 'border-line-strong',
              )}
            >
              {t(dynamicKey(`weekday.${d}`))}
            </button>
          ))}
        </div>
      </Field>
    </>,
    <SaveButton
      busy={busy || !ok(start) || !ok(end)}
      onClick={() => void onSave({ format, work_start: start, work_end: end, work_days: days })}
    />,
  );
};

/** The settings form per P1 type (ColumnSettings opens it). */
export const P1_FORMS: Record<string, (p: P1FormProps) => ReactNode> = {
  progress: ProgressForm,
  button: ButtonForm,
  hour: HourForm,
  color_picker: ColorForm,
  week: WeekForm,
  world_clock: WorldClockForm,
};
