// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ReactNode } from 'react';
import {
  columnTypes,
  DEFAULT_DATE_TIME,
  DURATION_MODES,
  type DurationMode,
  FORMULA_CATALOG,
  formulaProblem,
  formulaRefNames,
  formulaToKeys,
  formulaToNames,
  quotedFormulaRefs,
  getRegion,
  FORMULA_CATEGORIES,
  type FormulaCategory,
  ITEM_KEY_PREFIX_RE,
  MIRROR_DISPLAYS,
  MIRROR_SUBITEMS,
  type MirrorDisplay,
  t,
  timelineDoneLabels,
  type TimelineSettings,
  type MessageKey,
  type RelationPickerGrouping,
  type StatusLabel,
  msgKey,
  dynamicKey,
} from '@bines/shared';
import {
  Button,
  Card,
  cn,
  Dialog,
  Field,
  Input,
  Notice,
  SearchableList,
  Segmented,
  Switch,
  TimeField,
} from '@bines/ui';
import { tagVars } from '../../lib/label-color';
import { errorMessage } from '../../lib/api';
import { columnTypeLabel } from '../../lib/locale';
import { type BoardDetail, type Column, useBoard, useItemSequence, useTree, useWorkspaces } from './board-api';
import { useNumberFormatFields } from './NumberFormatFields';
import { PickerButton } from './toolbar/parts';
import { TwoWaySection } from './TwoWaySection';
import { choiceSettings, choiceStateOf, RelationFilterSection } from './RelationFilterSection';
import { P1_FORMS } from './P1ColumnForms';
import { PhoneColumnForm } from '../phone/PhoneColumnForm';
import { AiColumnForm } from '../ai2/AiColumnForm';
import { SecretColumnForm } from '../secrets/SecretColumnForm';
import { SearchClear } from '../../lib/search-clear';
import { MirrorDisplayPreview } from './cells/MirrorCell';
import { FormulaEditor, type FormulaEditorHandle } from './FormulaEditor';
import { formulaProblemText } from './formula-problem';

/** `after`: a further request once the settings are saved (the dialog closes when both succeed). */
type Save = (settings: Record<string, unknown>, after?: () => Promise<unknown>) => Promise<unknown>;
/** Wraps a form's body in the dialog, its save button in the footer. */
type Shell = (body: ReactNode, save: ReactNode) => ReactNode;
type FormProps = { column: Column; busy: boolean; onSave: Save; shell: Shell };

/** What the dialog saves: the type's settings (when its form has any) and/or the column's description. */
export type ColumnPatch = { settings?: Record<string, unknown>; description?: string | null };

/**
 * Settings for engine columns (formula / board_relation / mirror) — 03 §2.16–2.18. Other types keep their
 * defaults (labels are edited in the cell picker in a later slice).
 * fix6-table 4: every column has an optional description, edited here (at the top) and shown as an (i) beside its
 * header title. `only="description"` (the column menu's "עריכת תיאור") opens just that field.
 */
export const ColumnSettings = ({
  accountId,
  board,
  column,
  onSave,
  onClose,
  only,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  onSave: (patch: ColumnPatch) => Promise<unknown>;
  onClose: () => void;
  only?: 'description';
}) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [description, setDescription] = useState(column.description ?? '');
  const run = async (settings?: Record<string, unknown>, after?: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    const text = description.trim() || null;
    try {
      await onSave({
        ...(settings ? { settings } : {}),
        ...(text !== (column.description ?? null) ? { description: text } : {}),
      });
      await after?.();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save: Save = (settings, after) => run(settings, after);

  const descriptionField = (
    <Field label={t('column.description')}>
      <textarea
        autoFocus={only === 'description'}
        value={description}
        maxLength={1000}
        data-testid="column-description-input"
        placeholder={t('column.description.placeholder')}
        onChange={(e) => setDescription(e.target.value)}
        className="h-20 w-full resize-y rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
      />
    </Field>
  );
  const shell: Shell = (body, saveButton) => (
    <Dialog
      open
      onClose={onClose}
      title={only === 'description' ? t('column.editDescription') : t('board.columnSettings')}
      subtitle={`${column.title} · ${columnTypeLabel(column.type)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {saveButton ?? (
            // A type without settings of its own: the button saves the description alone.
            <Button busy={busy} data-testid="column-settings-save" onClick={() => void run()}>
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {descriptionField}
        {body}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
  const props = { column, busy, onSave: save, shell };

  if (only === 'description') return shell(null, null);
  const Form = settingsFormFor(column.type);
  if (Form) return Form({ ...props, accountId, board });
  return shell(null, null);
};

type FormRender = (p: FormProps & { accountId: string; board: BoardDetail }) => ReactNode;

/** The settings form of a column type, by its type — checked first. */
export const TYPE_FORMS: Record<string, FormRender> = {
  creation_log: (p) => <MetaLogForm {...p} />,
  last_updated: (p) => <MetaLogForm {...p} />,
  numbers: (p) => <NumbersForm {...p} />,
  item_id: (p) => <ItemIdForm {...p} />,
  dependency: (p) => <DependencyForm {...p} />,
  phone: (p) => <PhoneColumnForm {...p} />,
  timeline: (p) => <TimelineForm {...p} />,
  date: (p) => <DateForm {...p} />,
  ai: (p) => <AiColumnForm {...p} />,
  file: (p) => <FileColumnForm {...p} />,
};

/** …then by the type's engine (formula, relations, mirror, cell docs, secrets). */
export const ENGINE_FORMS: Partial<Record<string, FormRender>> = {
  formula: (p) => <FormulaForm {...p} />,
  links: (p) => <RelationForm {...p} />,
  mirror: (p) => <MirrorForm {...p} />,
  doc: (p) => <DocColumnForm {...p} />,
  secret: (p) => <SecretColumnForm {...p} />,
};

/** The form the dialog shows for a type (the P1 types' forms last), or none — the description alone. */
export const settingsFormFor = (type: string): FormRender | undefined => {
  const engine = columnTypes.get(type)?.engine;
  const P1Form = P1_FORMS[type];
  return (
    TYPE_FORMS[type] ?? (engine ? ENGINE_FORMS[engine] : undefined) ?? (P1Form ? (p) => <P1Form {...p} /> : undefined)
  );
};

/**
 * Whether a column type has settings of its own — the column menu offers "הגדרות עמודה" for it. Read from the same
 * tables as the dialog (the date column's form was unreachable, missing from a copy of this list)
 * other engine columns (not votes) keep the entry for their description, as before.
 */
export const hasColumnSettings = (type: string) => {
  const engine = columnTypes.get(type)?.engine;
  return !!settingsFormFor(type) || (!!engine && engine !== 'vote');
};

/** A files column: images as small previews in the cell — on unless turned off. */
const FileColumnForm = ({ column, busy, onSave, shell }: FormProps) => {
  const [previews, setPreviews] = useState(column.settings.image_previews !== false);
  return shell(
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={previews} onChange={setPreviews} testId="file-column-previews" />
      {t('files.column.imagePreviews')}
    </label>,
    <Button
      busy={busy}
      data-testid="column-settings-save"
      onClick={() => void onSave({ ...column.settings, image_previews: previews })}
    >
      {t('common.save')}
    </Button>,
  );
};

/**
 * A doc column (M8 ד2): the doc every new cell doc starts from — any doc of the board's workspace (a "template"
 * doc kept there), or none.
 */
const DocColumnForm = ({
  accountId,
  board,
  column,
  busy,
  onSave,
  shell,
}: FormProps & { accountId: string; board: BoardDetail }) => {
  const docs = (useTree(accountId, board.workspace_id).data?.entities ?? []).filter((e) => e.type === 'doc');
  const [template, setTemplate] = useState<string | null>(
    (column.settings.template_doc_id as string | undefined) ?? null,
  );
  const chosen = docs.find((d) => d.id === template);
  return shell(
    <Field label={t('docs2.column.template')} hint={t('docs2.column.templateHint')}>
      <PickerButton
        testId="doc-column-template"
        menuLabel={t('docs2.column.template')}
        placeholder={t('docs2.column.noTemplate')}
        label={chosen ? chosen.name : t('docs2.column.noTemplate')}
        items={[
          {
            label: t('docs2.column.noTemplate'),
            checked: !template,
            onSelect: () => setTemplate(null),
          },
          ...docs.map((d) => ({ label: d.name, checked: d.id === template, onSelect: () => setTemplate(d.id) })),
        ]}
      />
    </Field>,
    <Button
      busy={busy}
      data-testid="column-settings-save"
      onClick={() => {
        const { template_doc_id: _drop, ...rest } = column.settings;
        void _drop;
        void onSave(template ? { ...rest, template_doc_id: template } : rest);
      }}
    >
      {t('common.save')}
    </Button>,
  );
};

const CREATION_MODES = ['both', 'date', 'person'] as const;

/** "Created" (03 §2.21): who and when, only the date, or only who. */
const DEP_MODES_UI = ['strict', 'flexible', 'visual'] as const;

/**
 * A dependency column (M8 ד7, D25): how dependents follow a change — the same shift / only on overlap / arrows
 * only — and which date / timeline column moves (default: the board's first timeline, else its first date).
 */
const DependencyForm = ({ board, column, busy, onSave, shell }: FormProps & { board: BoardDetail }) => {
  const [mode, setMode] = useState<(typeof DEP_MODES_UI)[number]>(
    (column.settings.mode as (typeof DEP_MODES_UI)[number] | undefined) ?? 'flexible',
  );
  const dated = board.columns.filter((c) => c.type === 'timeline' || c.type === 'date');
  const ordered = [...dated.filter((c) => c.type === 'timeline'), ...dated.filter((c) => c.type !== 'timeline')];
  const [dateColumn, setDateColumn] = useState<string | undefined>(
    (column.settings.date_column_id as string | undefined) ?? undefined,
  );
  const shown = ordered.find((c) => c.id === dateColumn) ?? ordered[0];
  return shell(
    <>
      <Field label={t('dependency.mode')}>
        <PickerButton
          testId="dependency-mode"
          menuLabel={t('dependency.mode')}
          placeholder={t('dependency.mode.flexible')}
          label={t(`dependency.mode.${mode}` as MessageKey)}
          items={DEP_MODES_UI.map((m) => ({
            label: t(`dependency.mode.${m}` as MessageKey),
            checked: m === mode,
            onSelect: () => setMode(m),
          }))}
        />
      </Field>
      <p className="text-xs text-muted" data-testid="dependency-mode-hint">
        {t(`dependency.mode.${mode}.hint` as MessageKey)}
      </p>
      <Field label={t('dependency.dateColumn')}>
        {ordered.length ? (
          <PickerButton
            testId="dependency-date-column"
            menuLabel={t('dependency.dateColumn')}
            placeholder={t('filter.column')}
            label={shown?.title}
            items={ordered.map((c) => ({
              label: c.title,
              checked: c.id === shown?.id,
              onSelect: () => setDateColumn(c.id),
            }))}
          />
        ) : (
          <Notice>{t('dependency.noDateColumn')}</Notice>
        )}
      </Field>
    </>,
    <Button
      busy={busy}
      data-testid="column-settings-save"
      onClick={() => void onSave({ ...column.settings, mode, ...(dateColumn ? { date_column_id: dateColumn } : {}) })}
    >
      {t('common.save')}
    </Button>,
  );
};

type HebrewDateSetting = 'account' | 'on' | 'off';

/** The Hebrew date of a date / timeline cell: the account's choice (named), shown or hidden. */
const HebrewDateField = ({
  value,
  onChange,
}: {
  value: HebrewDateSetting;
  onChange: (v: HebrewDateSetting) => void;
}) => {
  const account = getRegion().calendar.hebrew_dates === 'cells' ? 'on' : 'off';
  return (
    <Field label={t('dateCol.hebrewDate')} hint={t('dateCol.hebrewDate.hint')}>
      <Segmented<HebrewDateSetting>
        label={t('dateCol.hebrewDate')}
        testId="column-hebrew-date"
        value={value}
        onChange={onChange}
        options={[
          {
            value: 'account',
            label: t('duration.account', { mode: t(`dateCol.hebrewDate.${account}`) }),
            testId: 'column-hebrew-date-account',
          },
          { value: 'on', label: t('dateCol.hebrewDate.on'), testId: 'column-hebrew-date-on' },
          { value: 'off', label: t('dateCol.hebrewDate.off'), testId: 'column-hebrew-date-off' },
        ]}
      />
    </Field>
  );
};

type DayMarksSetting = 'account' | 'on' | 'off';

/** Dots for days off / half days in the cell's picker: the account's choice (named), on or off. */
const DayMarksField = ({ value, onChange }: { value: DayMarksSetting; onChange: (v: DayMarksSetting) => void }) => {
  const account = getRegion().calendar.picker_marks === 'dot' ? 'on' : 'off';
  return (
    <Field label={t('dateCol.dayMarks')} hint={t('dateCol.dayMarks.hint')}>
      <Segmented<DayMarksSetting>
        label={t('dateCol.dayMarks')}
        testId="column-day-marks"
        value={value}
        onChange={onChange}
        options={[
          {
            value: 'account',
            label: t('duration.account', { mode: t(`dateCol.dayMarks.${account}`) }),
            testId: 'column-day-marks-account',
          },
          { value: 'on', label: t('dateCol.dayMarks.on'), testId: 'column-day-marks-on' },
          { value: 'off', label: t('dateCol.dayMarks.off'), testId: 'column-day-marks-off' },
        ]}
      />
    </Field>
  );
};

/** Sets a key, or drops it when it holds its default (settings stay small). */
const withSetting = (settings: Record<string, unknown>, key: string, value: unknown, fallback: unknown) => {
  const next = { ...settings };
  if (value === fallback) delete next[key];
  else next[key] = value;
  return next;
};

/**
 * A date column: include a time and the time a new one starts at, the weekday, the current year
 * and the Hebrew date. Other settings (a deadline, a roll-up) are edited elsewhere and kept.
 */
const DateForm = ({ column, busy, onSave, shell }: FormProps) => {
  const [withTime, setWithTime] = useState(column.settings.show_time === true);
  const [defaultTime, setDefaultTime] = useState(
    typeof column.settings.default_time === 'string' ? column.settings.default_time : DEFAULT_DATE_TIME,
  );
  const [weekday, setWeekday] = useState(column.settings.show_weekday === true);
  const [hideYear, setHideYear] = useState(column.settings.hide_current_year === true);
  const [hebrew, setHebrew] = useState<HebrewDateSetting>(
    (column.settings.hebrew_date as HebrewDateSetting | undefined) ?? 'account',
  );
  const [marks, setMarks] = useState<DayMarksSetting>(
    (column.settings.day_marks as DayMarksSetting | undefined) ?? 'account',
  );
  return shell(
    <>
      <div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={withTime} onChange={setWithTime} testId="date-include-time" />
          {t('dateCol.includeTime')}
        </label>
        <p className="mt-1 text-xs text-muted">{t('dateCol.includeTime.hint')}</p>
      </div>
      {withTime ? (
        <Field label={t('dateCol.defaultTime')}>
          <span data-testid="date-default-time">
            <TimeField
              value={defaultTime}
              onChange={setDefaultTime}
              label={t('dateCol.defaultTime')}
              hourLabel={t('time.hours')}
              minuteLabel={t('time.minutes')}
            />
          </span>
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={weekday} onChange={setWeekday} testId="date-show-weekday" />
        {t('dateCol.showWeekday')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={hideYear} onChange={setHideYear} testId="date-hide-year" />
        {t('dateCol.hideCurrentYear')}
      </label>
      <HebrewDateField value={hebrew} onChange={setHebrew} />
      <DayMarksField value={marks} onChange={setMarks} />
    </>,
    <Button
      busy={busy}
      data-testid="column-settings-save"
      onClick={() => {
        let next = withSetting(column.settings, 'show_time', withTime, false);
        next = withSetting(next, 'default_time', withTime ? defaultTime : DEFAULT_DATE_TIME, DEFAULT_DATE_TIME);
        next = withSetting(next, 'show_weekday', weekday, false);
        next = withSetting(next, 'hide_current_year', hideYear, false);
        next = withSetting(next, 'hebrew_date', hebrew, 'account');
        next = withSetting(next, 'day_marks', marks, 'account');
        void onSave(next);
      }}
    >
      {t('common.save')}
    </Button>,
  );
};

/**
 * Timeline (r26): red when overdue (default on) and, optionally, a linked status column — an
 * item whose status is one of its done labels (default: the labels marked done) never turns red.
 */
const TimelineForm = ({ board, column, busy, onSave, shell }: FormProps & { board: BoardDetail }) => {
  const settings = column.settings as TimelineSettings;
  const [red, setRed] = useState(settings.overdue_red !== false);
  const statuses = board.columns.filter((c) => c.type === 'status');
  const [statusId, setStatusId] = useState<string | undefined>(
    statuses.some((c) => c.id === settings.status_column_id) ? settings.status_column_id : undefined,
  );
  const status = statuses.find((c) => c.id === statusId);
  const labels = ((status?.settings.labels ?? []) as StatusLabel[]).filter((l) => !l.is_deactivated);
  const [done, setDone] = useState<number[]>(() => timelineDoneLabels(settings, status));
  const pickStatus = (id: string | undefined) => {
    setStatusId(id);
    const next = statuses.find((c) => c.id === id);
    // A newly linked status starts from its own done labels.
    setDone(id === settings.status_column_id ? timelineDoneLabels(settings, next) : timelineDoneLabels({}, next));
  };
  const toggle = (id: number) => setDone((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  // how the length is counted, showing it, keeping it on a move, and the Hebrew date.
  const [duration, setDuration] = useState<DurationMode | 'account'>(settings.duration ?? 'account');
  const [showDuration, setShowDuration] = useState(settings.show_duration === true);
  const [keep, setKeep] = useState(settings.keep_workdays === true);
  const [hebrew, setHebrew] = useState<HebrewDateSetting>(settings.hebrew_date ?? 'account');
  const [marks, setMarks] = useState<DayMarksSetting>(settings.day_marks ?? 'account');
  // "with hours" — a start and an end time besides the days (the calendar by the hour).
  const [withTime, setWithTime] = useState(settings.show_time === true);
  const durationLabel = (m: DurationMode | 'account') =>
    m === 'account'
      ? t('duration.account', { mode: t(`duration.${getRegion().calendar.duration}`) })
      : t(`duration.${m}`);
  const save = () => {
    const rest = { ...column.settings };
    delete rest.overdue_red;
    delete rest.status_column_id;
    delete rest.done_label_ids;
    let next: Record<string, unknown> = {
      ...rest,
      ...(red ? {} : { overdue_red: false }),
      ...(statusId ? { status_column_id: statusId, done_label_ids: done } : {}),
    };
    next = withSetting(next, 'duration', duration, 'account');
    next = withSetting(next, 'show_duration', showDuration, false);
    next = withSetting(next, 'keep_workdays', keep, false);
    next = withSetting(next, 'hebrew_date', hebrew, 'account');
    next = withSetting(next, 'day_marks', marks, 'account');
    next = withSetting(next, 'show_time', withTime, false);
    void onSave(next);
  };
  return shell(
    <>
      <div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={withTime} onChange={setWithTime} testId="timeline-include-time" />
          {t('timelineCol.includeTime')}
        </label>
        <p className="mt-1 text-xs text-muted">{t('timelineCol.includeTime.hint')}</p>
      </div>
      <Field label={t('timelineCol.duration')}>
        <PickerButton
          testId="timeline-duration-mode"
          menuLabel={t('timelineCol.duration')}
          placeholder={durationLabel('account')}
          label={durationLabel(duration)}
          items={(['account', ...DURATION_MODES] as const).map((m) => ({
            label: durationLabel(m),
            checked: m === duration,
            testId: `timeline-duration-${m}`,
            onSelect: () => setDuration(m),
          }))}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={showDuration} onChange={setShowDuration} testId="timeline-show-duration" />
        {t('timelineCol.showDuration')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={keep} onChange={setKeep} testId="timeline-keep-workdays" />
        {t('timelineCol.keepWorkdays')}
      </label>
      <p className="-mt-2 text-xs text-muted">{t('timelineCol.keepWorkdays.hint')}</p>
      <HebrewDateField value={hebrew} onChange={setHebrew} />
      <DayMarksField value={marks} onChange={setMarks} />
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={red} onChange={setRed} testId="timeline-overdue-red" />
        {t('r26.timeline.overdueRed')}
      </label>
      <p className="text-xs text-muted">{t('r26.timeline.overdueRed.hint')}</p>
      {red ? (
        <Field label={t('r26.timeline.status')} hint={t('r26.timeline.status.hint')}>
          <PickerButton
            testId="timeline-status-column"
            menuLabel={t('r26.timeline.status')}
            placeholder={t('r26.timeline.status.none')}
            label={status?.title}
            items={[
              {
                label: t('r26.timeline.status.none'),
                checked: !status,
                testId: 'timeline-status-none',
                onSelect: () => pickStatus(undefined),
              },
              ...statuses.map((c) => ({
                label: c.title,
                checked: c.id === status?.id,
                testId: `timeline-status-${c.id}`,
                onSelect: () => pickStatus(c.id),
              })),
            ]}
          />
        </Field>
      ) : null}
      {red && status ? (
        <Field label={t('r26.timeline.doneLabels')} hint={t('r26.timeline.doneLabels.hint')}>
          <div className="flex flex-wrap gap-1.5" data-testid="timeline-done-labels">
            {labels.map((l) => {
              const on = done.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  data-testid={`timeline-done-${l.id}`}
                  onClick={() => toggle(l.id)}
                  className={cn(
                    'h-7 rounded-[8px] border px-2.5 text-xs font-semibold transition-opacity',
                    on ? 'label-tag border-transparent' : 'border-line-strong bg-surface text-fg-2 opacity-70',
                  )}
                  style={on ? tagVars(l.color) : undefined}
                >
                  {l.label || t('r26.timeline.emptyLabel')}
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}
    </>,
    <Button busy={busy} data-testid="column-settings-save" onClick={save}>
      {t('common.save')}
    </Button>,
  );
};

/**
 * "Created" / "Last updated" (03 §2.21–2.22, r23ui): who and when, only when, or only who; the time of day too or
 * not; and — last updated only, a "last modified time" column — which columns' changes count (none = any).
 */
const MetaLogForm = ({ board, column, busy, onSave, shell }: FormProps & { board: BoardDetail }) => {
  const lastUpdated = column.type === 'last_updated';
  const stored = column.settings.mode as (typeof CREATION_MODES)[number] | 'ago' | undefined;
  // `ago` = a last-updated column made before r23ui, which showed the date.
  const [mode, setMode] = useState<(typeof CREATION_MODES)[number]>(stored === 'ago' ? 'date' : (stored ?? 'both'));
  const [showTime, setShowTime] = useState(column.settings.show_time === true);
  const [watched, setWatched] = useState<string[]>(
    Array.isArray(column.settings.columns) ? (column.settings.columns as string[]) : [],
  );
  // Columns a person changes: not this column, not the computed ones (formula, mirror, other logs …).
  const choices = board.columns.filter((c) => {
    const def = columnTypes.get(c.type);
    return c.id !== column.id && !!def && (c.type === 'name' || (!def.readOnly && def.storage !== 'computed'));
  });
  const modeKey = (m: string) =>
    lastUpdated ? dynamicKey(`r23ui.lastUpdated.mode.${m}`) : dynamicKey(`creationLog.mode.${m}`);
  const watchedTitles = watched.map((key) => choices.find((c) => c.id === key)?.title).filter(Boolean);
  return shell(
    <>
      <Field label={t('creationLog.show')}>
        <PickerButton
          testId="creation-log-mode"
          menuLabel={t('creationLog.show')}
          placeholder={t(modeKey('both'))}
          label={t(modeKey(mode))}
          items={CREATION_MODES.map((m) => ({
            label: t(modeKey(m)),
            checked: m === mode,
            testId: `meta-log-mode-${m}`,
            onSelect: () => setMode(m),
          }))}
        />
      </Field>
      {mode !== 'person' ? (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={showTime} onChange={setShowTime} testId="meta-log-show-time" />
          {t('r23ui.metaLog.showTime')}
        </label>
      ) : null}
      {lastUpdated ? (
        <Field label={t('r23ui.lastUpdated.columns')} hint={t('r23ui.lastUpdated.columns.hint')}>
          <PickerButton
            testId="last-updated-columns"
            menuLabel={t('r23ui.lastUpdated.columns')}
            placeholder={t('r23ui.lastUpdated.columns.any')}
            label={watchedTitles.length ? watchedTitles.join(', ') : undefined}
            items={[
              {
                label: t('r23ui.lastUpdated.columns.any'),
                checked: !watched.length,
                testId: 'last-updated-columns-any',
                onSelect: () => setWatched([]),
              },
              { kind: 'separator' as const },
              ...choices.map((c) => ({
                label: c.title,
                checked: watched.includes(c.id),
                keepOpen: true,
                testId: `last-updated-column-${c.id}`,
                keywords: columnTypeLabel(c.type),
                onSelect: () =>
                  setWatched((w) => (w.includes(c.id) ? w.filter((x) => x !== c.id) : [...w, c.id].slice(0, 50))),
              })),
            ]}
          />
        </Field>
      ) : null}
    </>,
    <Button
      busy={busy}
      data-testid="column-settings-save"
      onClick={() => {
        const { columns: _old, ...rest } = column.settings;
        void onSave({
          ...rest,
          mode,
          show_time: showTime,
          ...(lastUpdated && watched.length ? { columns: watched } : {}),
        });
      }}
    >
      {t('common.save')}
    </Button>,
  );
};

const FormulaForm = ({
  accountId,
  board,
  column,
  busy,
  onSave,
  shell,
}: FormProps & { accountId: string; board: BoardDetail }) => {
  // people read and type columns by name ({Price}); the column keeps their ids, so a rename is safe.
  const names = formulaRefNames(board.columns);
  const [formula, setFormula] = useState(() => formulaToNames(String(column.settings.formula ?? ''), board.columns));
  const stored = formulaToKeys(formula, board.columns);
  // Fix: a URL result shows as a clickable link (auto / always for bare domains too / never).
  const [showAsLink, setShowAsLink] = useState<'auto' | 'on' | 'off'>(
    (column.settings.show_as_link as 'auto' | 'on' | 'off' | undefined) ?? 'auto',
  );
  // A number result is shown like a numbers column (03 §2.18): unit, decimals, 1,000s.
  const format = useNumberFormatFields({
    accountId,
    settings: column.settings,
    preview: (s) => columnTypes.get('formula')!.formatNumber!(1234.5, s as never),
  });
  const editor = useRef<FormulaEditorHandle>(null);
  const [cat, setCat] = useState<FormulaCategory | 'all'>('all');
  const [q, setQ] = useState('');
  const keys = new Set(board.columns.map((c) => c.id));
  // the syntax is checked as typed (the message names the column as written), unknown columns on
  // the stored form; both said in the reader's language. Columns written inside quotes are text: say so.
  const problem = stored.trim() ? (formulaProblem(formula) ?? formulaProblem(stored, keys)) : null;
  const quoted = quotedFormulaRefs(formula, board.columns);
  /** Inserts at the caret (or the end) and puts the caret `caretBack` characters before its end. */
  const insert = (text: string, caretBack = 0) => editor.current?.insert(text, caretBack);
  const shown = FORMULA_CATALOG.filter(
    (f) => (cat === 'all' || f.category === cat) && `${f.name} ${f.he}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return shell(
    <>
      <Field label={t('board.formula')} hint={`${t('board.formula.hint')} ${t('r15cols.formula.braceHint')}`}>
        <FormulaEditor
          ref={editor}
          value={formula}
          onChange={setFormula}
          columns={board.columns.filter((c) => c.id !== column.id).map((c) => ({ ...c, id: names.get(c.id) ?? c.id }))}
        />
      </Field>
      {problem ? (
        <p className="text-xs text-[var(--danger)]" data-testid="formula-error">
          {formulaProblemText(problem)}
        </p>
      ) : null}
      {quoted.length ? (
        <p className="text-xs text-warn" data-testid="formula-quoted-refs">
          {t('formula.quotedRefs', { columns: quoted.map((c) => `{${c}}`).join(', ') })}{' '}
          <span className="inline-block font-mono" dir="ltr">{`CONCATENATE({${quoted[0]}}, " - ")`}</span>
        </p>
      ) : null}
      <div>
        <p className="mb-1.5 text-xs font-semibold text-fg-2">{t('formula.columns')}</p>
        <div className="flex flex-wrap gap-1">
          {board.columns
            .filter((c) => c.id !== column.id)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.id}
                onClick={() => insert(`{${names.get(c.id) ?? c.id}}`)}
                className="inline-flex h-6 items-center rounded-full bg-surface-2 px-[0.5625rem] text-xs font-semibold text-fg-2 hover:bg-info-soft hover:text-info-fg"
              >
                {c.title}
              </button>
            ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-line" data-testid="formula-functions">
        <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface-3 p-2">
          {(['all', ...FORMULA_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cat === c}
              onClick={() => setCat(c)}
              className={cn(
                'inline-flex h-6 items-center rounded-full px-[0.5625rem] text-xs',
                cat === c ? 'bg-primary font-semibold text-on-primary' : 'text-fg-2 hover:bg-surface-2',
              )}
            >
              {t(`formula.cat.${c}` as MessageKey)}
            </button>
          ))}
          <div className="relative ms-auto">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('formula.search')}
              aria-label={t('formula.search')}
              className="h-7 w-32 rounded-[8px] border border-line-strong bg-surface px-2 text-xs focus:border-primary focus:outline-none pe-7"
            />
            <SearchClear value={q} onClear={() => setQ('')} testId="formula-search-clear" />
          </div>
        </div>
        <ul className="max-h-56 divide-y divide-[var(--line-soft)] overflow-auto">
          {shown.map((f) => (
            <li key={f.name}>
              <button
                type="button"
                data-testid="formula-function"
                data-name={f.name}
                onClick={() => insert(`${f.name}()`, 1)}
                className="w-full space-y-0.5 px-3 py-2 text-start hover:bg-surface-2"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-sm font-semibold" dir="ltr">
                    {f.syntax}
                  </span>
                  <span className="text-xs text-muted">{f.he}</span>
                </span>
                <span className="block font-mono text-xs text-muted" dir="ltr">
                  {f.example} → {f.result}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-3.5 border-t border-line pt-3.5" data-testid="formula-number-format">
        <div>
          <p className="text-sm font-semibold text-heading">{t('formula.numberFormat')}</p>
          <p className="text-xs text-muted">{t('formula.numberFormat.hint')}</p>
        </div>
        {format.body}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3.5">
        <p className="text-sm font-semibold text-heading">{t('formula.showAsLink')}</p>
        <p className="text-xs text-muted">{t('formula.showAsLink.hint')}</p>
        <Segmented
          label={t('formula.showAsLink')}
          value={showAsLink}
          onChange={setShowAsLink}
          testId="formula-link-mode"
          options={(['auto', 'on', 'off'] as const).map((v) => ({
            value: v,
            label: t(`formula.showAsLink.${v}` as MessageKey),
            testId: `formula-link-${v}`,
          }))}
        />
      </div>
    </>,
    <Button
      busy={busy}
      disabled={!!problem}
      data-testid="column-settings-save"
      onClick={() => onSave({ ...format.settings, formula: stored, show_as_link: showAsLink })}
    >
      {t('common.save')}
    </Button>,
  );
};

const RelationForm = ({
  accountId,
  board,
  column,
  busy,
  onSave,
  shell,
}: FormProps & { accountId: string; board: BoardDetail }) => {
  const ws = useWorkspaces(accountId).data?.data[0];
  const tree = useTree(accountId, ws?.id).data;
  const saved = (column.settings.board_ids as string[] | undefined) ?? [];
  const [ids, setIds] = useState<string[]>(saved);
  const [multiple, setMultiple] = useState(column.settings.allow_multiple !== false);
  // A two-way column keeps its one board (03 §2.16): the list is locked while paired.
  const locked = useBoard(accountId, board.id).data?.columns.find((c) => c.id === column.id)?.settings.two_way === true;
  const dirty = ids.length !== saved.length || ids.some((id) => !saved.includes(id));
  // r19relfilter: "offer only items that…" per linked board (relations only, not dependencies).
  const [choice, setChoice] = useState(() => choiceStateOf(column.settings));
  const isRelation = column.type === 'board_relation';
  // each chip's name up to this many characters (empty = by the cell's width).
  const [maxChars, setMaxChars] = useState(
    column.settings.chip_max_chars ? String(column.settings.chip_max_chars) : '',
  );
  const maxCharsOk = !maxChars.trim() || (/^\d+$/.test(maxChars.trim()) && +maxChars >= 3 && +maxChars <= 100);
  const boardNames = new Map((tree?.boards ?? []).map((b) => [b.id, b.name]));
  // how the picker lists the items (by board and group by default).
  const [groupBy, setGroupBy] = useState<RelationPickerGrouping>(
    (column.settings.picker_group_by as RelationPickerGrouping | undefined) ?? 'board_group',
  );
  // a board taken off takes its links along on save — said before saving.
  const removed = isRelation ? saved.filter((id) => !ids.includes(id)) : [];
  return shell(
    <>
      <p className="text-xs font-semibold text-fg-2">{t('board.relation.boards')}</p>
      <SearchableList items={tree?.boards ?? []} text={(b) => b.name} autoFocus={false} testId="relation-search">
        {(shown) => (
          <div className="max-h-64 space-y-1.5 overflow-auto">
            {shown.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-[0.9375rem] accent-[var(--check)]"
                  checked={ids.includes(b.id)}
                  disabled={locked}
                  onChange={() => setIds((x) => (x.includes(b.id) ? x.filter((y) => y !== b.id) : [...x, b.id]))}
                />
                {b.name}
              </label>
            ))}
          </div>
        )}
      </SearchableList>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-[0.9375rem] accent-[var(--check)]"
          checked={multiple}
          onChange={() => setMultiple((v) => !v)}
        />
        {t('board.relation.multiple')}
      </label>
      {isRelation ? (
        <label className="flex items-center gap-2 text-sm">
          <span>{t('board.relation.maxChars')}</span>
          <Input
            inputMode="numeric"
            className="w-16"
            value={maxChars}
            placeholder={t('board.relation.maxCharsAuto')}
            aria-invalid={!maxCharsOk || undefined}
            onChange={(e) => setMaxChars(e.target.value)}
            data-testid="relation-max-chars"
          />
        </label>
      ) : null}
      {removed.length ? (
        <p className="text-xs text-warn" role="status" data-testid="relation-removed-boards">
          {t('board.relation.removedBoards', { boards: removed.map((id) => boardNames.get(id) ?? id).join(', ') })}
        </p>
      ) : null}
      {isRelation ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-fg-2">{t('board.relation.pickerGroupBy')}</p>
          <Segmented
            label={t('board.relation.pickerGroupBy')}
            value={groupBy}
            onChange={setGroupBy}
            testId="relation-group-by"
            options={[
              {
                value: 'board_group',
                label: t('board.relation.pickerGroupBy.board_group'),
                testId: 'relation-group-by-board_group',
              },
              { value: 'board', label: t('board.relation.pickerGroupBy.board'), testId: 'relation-group-by-board' },
              { value: 'none', label: t('board.relation.pickerGroupBy.none'), testId: 'relation-group-by-none' },
            ]}
          />
        </div>
      ) : null}
      {isRelation && ids.length ? (
        <RelationFilterSection
          accountId={accountId}
          boardIds={ids}
          boardNames={boardNames}
          state={choice}
          onChange={setChoice}
        />
      ) : null}
      <TwoWaySection accountId={accountId} board={board} column={column} dirty={dirty} />
    </>,
    <Button
      busy={busy}
      disabled={!maxCharsOk}
      data-testid="column-settings-save"
      onClick={() => {
        const { chip_max_chars: _m, picker_group_by: _g, ...rest } = column.settings;
        const base = {
          ...rest,
          board_ids: ids,
          allow_multiple: multiple,
          ...(isRelation && maxChars.trim() ? { chip_max_chars: Number(maxChars) } : {}),
          ...(isRelation && groupBy !== 'board_group' ? { picker_group_by: groupBy } : {}),
        };
        void onSave(isRelation ? choiceSettings(base, choice, ids) : base);
      }}
    >
      {t('common.save')}
    </Button>,
  );
};

const MirrorForm = ({
  accountId,
  board,
  column,
  busy,
  onSave,
  shell,
}: FormProps & { accountId: string; board: BoardDetail }) => {
  const relations = board.columns.filter((c) => columnTypes.get(c.type)?.engine === 'links');
  // A mirror reads through a relation column, or — D14 — the item's own subitems.
  const sources = [
    ...(board.subitems_board_id ? [{ id: MIRROR_SUBITEMS, title: t('board.mirror.subitems') }] : []),
    ...relations.map((c) => ({ id: c.id, title: c.title })),
  ];
  const [relationId, setRelationId] = useState(String(column.settings.relation_column_id ?? sources[0]?.id ?? ''));
  const [sourceId, setSourceId] = useState(String(column.settings.source_column_id ?? ''));
  const [aggregate, setAggregate] = useState(String(column.settings.aggregate ?? 'sum'));
  const relation = relations.find((c) => c.id === relationId);
  const targetBoardId =
    relationId === MIRROR_SUBITEMS
      ? (board.subitems_board_id ?? '')
      : ((relation?.settings.board_ids as string[] | undefined)?.[0] ?? '');
  const target = useBoard(accountId, targetBoardId);
  const targetColumns = targetBoardId ? (target.data?.columns.filter((c) => c.type !== 'name') ?? []) : [];
  const aggregates = ['sum', 'avg', 'median', 'min', 'max', 'count'];
  // r15cols: a mirror of labels shows as text, coloured chips or the footer's distribution bar.
  const [display, setDisplay] = useState<MirrorDisplay>(
    (column.settings.display as MirrorDisplay | undefined) ?? 'text',
  );
  const sourceType = targetColumns.find((c) => c.id === sourceId)?.type;
  const labelSource = sourceType === 'status' || sourceType === 'dropdown' || sourceType === 'mirror';
  return shell(
    <>
      <Field label={t('board.mirror.relation')}>
        <PickerButton
          testId="mirror-relation"
          menuLabel={t('board.mirror.relation')}
          placeholder={t('board.mirror.pick')}
          label={sources.find((x) => x.id === relationId)?.title}
          items={sources.map((x) => ({
            label: x.title,
            checked: x.id === relationId,
            onSelect: () => {
              setRelationId(x.id);
              setSourceId('');
            },
          }))}
        />
      </Field>
      <Field label={t('board.mirror.source')}>
        <PickerButton
          testId="mirror-source"
          menuLabel={t('board.mirror.source')}
          placeholder={t('board.mirror.pick')}
          label={targetColumns.find((c) => c.id === sourceId)?.title}
          items={targetColumns.map((c) => ({
            label: c.title,
            keywords: columnTypeLabel(c.type),
            checked: c.id === sourceId,
            onSelect: () => setSourceId(c.id),
          }))}
        />
      </Field>
      <Field label={t('board.mirror.aggregate')}>
        <PickerButton
          menuLabel={t('board.mirror.aggregate')}
          placeholder={t('board.mirror.pick')}
          label={t(`agg.${aggregate}` as MessageKey)}
          items={aggregates.map((x) => ({
            label: t(`agg.${x}` as MessageKey),
            checked: x === aggregate,
            onSelect: () => setAggregate(x),
          }))}
        />
      </Field>
      {labelSource ? (
        <div className="flex flex-col gap-1.5" data-testid="mirror-display">
          <p className="text-sm font-semibold text-heading">{t('r15cols.mirror.display')}</p>
          <p className="text-xs text-muted">{t('r15cols.mirror.displayHint')}</p>
          <Segmented
            label={t('r15cols.mirror.display')}
            value={display}
            onChange={setDisplay}
            testId="mirror-display-mode"
            options={MIRROR_DISPLAYS.map((v) => ({
              value: v,
              label: t(msgKey(`r15cols.mirror.display.${v}`)),
              testId: `mirror-display-${v}`,
            }))}
          />
          <MirrorDisplayPreview display={display} source={targetColumns.find((c) => c.id === sourceId)} />
        </div>
      ) : null}
    </>,
    <Button
      busy={busy}
      disabled={!relationId || !sourceId}
      data-testid="column-settings-save"
      onClick={() =>
        onSave({
          ...column.settings,
          relation_column_id: relationId,
          source_column_id: sourceId,
          aggregate,
          display: labelSource ? display : 'text',
        })
      }
    >
      {t('common.save')}
    </Button>,
  );
};

/** Numbers (03 §2.4): plain, currency, percent or a custom unit; decimals; 1,000s. */
const NumbersForm = ({ accountId, column, busy, onSave, shell }: FormProps & { accountId: string }) => {
  const format = useNumberFormatFields({
    accountId,
    settings: column.settings,
    preview: (s) => columnTypes.get('numbers')!.toText(1234.5, s, {}),
  });
  return shell(
    format.body,
    <Button busy={busy} data-testid="column-settings-save" onClick={() => void onSave(format.settings)}>
      {t('common.save')}
    </Button>,
  );
};

/**
 * Item numbers (03 §2.19): an optional prefix (empty = just the number), the minimum digits, and the number the
 * next item gets (continue numbering from another system).
 */
const ItemIdForm = ({
  accountId,
  board,
  column,
  busy,
  onSave,
  shell,
}: FormProps & { accountId: string; board: BoardDetail }) => {
  const sequence = useItemSequence(accountId, board.id, column.id);
  const custom = column.settings.display === 'custom_key';
  const [prefix, setPrefix] = useState(custom ? String(column.settings.prefix ?? '') : '');
  const [padding, setPadding] = useState(Number(column.settings.padding ?? (custom && column.settings.prefix ? 4 : 1)));
  const [next, setNext] = useState<string | null>(null);
  const current = sequence.data?.sequence ?? null;
  const shownNext = next ?? (current ? String(current.next_seq) : '');
  const max = current?.max_seq ?? 0;
  const badPrefix = !ITEM_KEY_PREFIX_RE.test(prefix);
  const nextNumber = Number(shownNext);
  const badNext = next !== null && (!/^\d{1,10}$/.test(next) || nextNumber <= max || nextNumber < 1);
  const preview = `${prefix}${String(current ? (next !== null && !badNext ? nextNumber : current.next_seq) : 1).padStart(padding, '0')}`;
  const save = () =>
    void onSave({ ...column.settings, display: 'custom_key', prefix, padding }, async () => {
      if (next !== null && current && nextNumber !== current.next_seq) await sequence.setNext(nextNumber);
    });
  return shell(
    <>
      <Field label={t('itemId.prefix')} hint={t('itemId.prefix.hint')}>
        <input
          value={prefix}
          maxLength={10}
          dir="ltr"
          data-testid="item-id-prefix"
          onChange={(e) => setPrefix(e.target.value.trim())}
          className="h-9 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-sm focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
        />
      </Field>
      {badPrefix ? <p className="text-xs text-[var(--danger)]">{t('itemId.prefix.invalid')}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('itemId.padding')}>
          <PickerButton
            testId="item-id-padding"
            menuLabel={t('itemId.padding')}
            placeholder="1"
            label={String(padding)}
            className="h-9 w-full"
            items={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
              label: String(n),
              checked: n === padding,
              onSelect: () => setPadding(n),
            }))}
          />
        </Field>
        {current ? (
          <Field label={t('itemId.next')}>
            <input
              value={shownNext}
              inputMode="numeric"
              dir="ltr"
              data-testid="item-id-next"
              onChange={(e) => setNext(e.target.value.replace(/\D/g, ''))}
              className="h-9 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-sm tabular-nums focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
            />
          </Field>
        ) : null}
      </div>
      {current ? (
        <p className={cn('text-xs', badNext ? 'text-[var(--danger)]' : 'text-muted')}>
          {badNext ? t('itemId.next.min', { max }) : t('itemId.next.hint')}
        </p>
      ) : null}
      <Card soft className="flex items-center justify-between gap-3">
        <span className="text-muted">{t('itemId.preview')}</span>
        <span
          className="font-display text-[1.1875rem] font-extrabold text-heading tabular-nums"
          dir="ltr"
          data-testid="item-id-preview"
        >
          {preview}
        </span>
      </Card>
    </>,
    <Button busy={busy} disabled={badPrefix || badNext} data-testid="column-settings-save" onClick={save}>
      {t('common.save')}
    </Button>,
  );
};
