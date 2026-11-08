// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import {
  computeProgress,
  PROGRESS_SOURCES,
  progressSettingsSchema,
  t,
  type ProgressSettings,
  type ProgressSource,
  msgKey,
} from '@bines/shared';
import { Button, cn, Field, Input, Notice, Segmented, Switch } from '@bines/ui';
import { tagVars } from '../../lib/label-color';
import { type Column, useBoard } from './board-api';
import { ProgressCell } from './cells/P1Cells';
import type { CellProps } from './cells';
import type { P1FormProps } from './P1ColumnForms';
import { CheckRow, PickerButton } from './toolbar/parts';

/**
 * r15cols — the progress column's settings, made clear: first where the progress comes from (the subitems, status
 * columns of the item, or both), then exactly what counts as done — which labels, sub-subitems too, weighted by a
 * numbers column — with a sentence saying what will be computed and a live example bar. Nothing per client.
 */
type StatusLabelLike = { id: number; label: string; color: string; is_done?: boolean; is_deactivated?: boolean };
const labelsOf = (c: Column | undefined) =>
  ((c?.settings.labels as StatusLabelLike[] | undefined) ?? []).filter((l) => !l.is_deactivated);
/** The saved done labels, or — none saved — the labels marked done (what the server reads then). */
const doneOf = (c: Column | undefined, saved: number[]) =>
  saved.length
    ? saved
    : labelsOf(c)
        .filter((l) => l.is_done)
        .map((l) => l.id);
const WEIGHT_TYPES = new Set(['numbers', 'formula', 'mirror', 'time_tracking', 'rating']);

/** A weight input (0–100). */
const WeightInput = ({ value, onChange, testId }: { value: number; onChange: (n: number) => void; testId: string }) => (
  <Input
    aria-label={t('progress.weight')}
    data-testid={testId}
    className="h-8 w-20"
    inputMode="decimal"
    dir="ltr"
    value={String(value)}
    onChange={(e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n) && n >= 0 && n <= 100) onChange(n);
    }}
  />
);

/** The labels of a status column as chips: on = counts as done. */
const DoneLabels = ({
  column,
  chosen,
  onChange,
  testId,
}: {
  column: Column | undefined;
  chosen: number[];
  onChange: (ids: number[]) => void;
  testId: string;
}) => {
  const labels = labelsOf(column);
  if (!labels.length) return null;
  return (
    <div
      className="flex flex-wrap gap-1"
      data-testid={testId}
      role="group"
      aria-label={t('r15cols.progress.doneLabels')}
    >
      {labels.map((l) => {
        const on = chosen.includes(l.id);
        return (
          <button
            key={l.id}
            type="button"
            aria-pressed={on}
            data-testid="progress-done-label"
            data-label={l.label}
            onClick={() => onChange(on ? chosen.filter((x) => x !== l.id) : [...chosen, l.id])}
            className={cn(
              'label-tag h-6 gap-1 text-xs transition-opacity',
              on ? 'ring-2 ring-primary ring-offset-1' : 'opacity-45 hover:opacity-80',
            )}
            style={tagVars(l.color)}
          >
            {on ? <span aria-hidden>✓</span> : null}
            {l.label || t('filter.blank')}
          </button>
        );
      })}
    </div>
  );
};

const Section = ({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId?: string;
}) => (
  <div className="flex flex-col gap-2 rounded-[12px] border border-line p-3" data-testid={testId}>
    <div>
      <p className="text-sm font-semibold text-heading">{title}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
    {children}
  </div>
);

/** Legacy settings (before r15cols) shown as the source they amount to; nothing set = not chosen yet. */
const initialSource = (s: ProgressSettings): ProgressSource | null => {
  if (s.source) return s.source;
  if (s.subitems && s.columns.length) return 'both';
  if (s.subitems) return 'subitems';
  if (s.columns.length) return 'columns';
  return null;
};

export const ProgressForm = ({ accountId, board, column, busy, onSave, shell }: P1FormProps) => {
  const initial = progressSettingsSchema.parse(column.settings ?? {});
  const status = board.columns.filter((c) => c.type === 'status');
  const subBoard = useBoard(accountId, board.subitems_board_id ?? '').data;
  const subColumns = subBoard?.columns ?? [];
  const subStatus = subColumns.filter((c) => c.type === 'status');
  const subWeights = subColumns.filter((c) => WEIGHT_TYPES.has(c.type));

  const [source, setSource] = useState<ProgressSource | null>(() => initialSource(initial));
  const [chosen, setChosen] = useState<Record<string, { weight: number; done: number[] | null }>>(() =>
    Object.fromEntries(
      initial.columns.map((c) => [
        c.column_id,
        { weight: c.weight, done: c.done_labels.length ? c.done_labels : null },
      ]),
    ),
  );
  const [subColumn, setSubColumn] = useState<string | null>(initial.subitems?.column_id ?? null);
  const [subDone, setSubDone] = useState<number[] | null>(
    initial.subitems?.done_labels.length ? initial.subitems.done_labels : null,
  );
  const [subWeight, setSubWeight] = useState(initial.subitems?.weight ?? 1);
  const [recursive, setRecursive] = useState(initial.subitems?.recursive ?? false);
  const [weightColumn, setWeightColumn] = useState<string | null>(initial.subitems?.weight_column_id ?? null);
  const [hide, setHide] = useState(initial.hide_percent);

  const subStatusColumn = subStatus.find((c) => c.id === subColumn) ?? (subColumn ? undefined : subStatus[0]);
  const effectiveSubColumn = subStatusColumn?.id ?? null;
  const subDoneIds = subDone ?? doneOf(subStatusColumn, []);
  const useSub = source === 'subitems' || source === 'both';
  const useCols = source === 'columns' || source === 'both';
  const chosenCols = Object.entries(chosen).filter(([id]) => status.some((c) => c.id === id));

  const settings: ProgressSettings = {
    source: source ?? undefined,
    columns: useCols
      ? chosenCols.map(([column_id, c]) => ({
          column_id,
          weight: c.weight,
          done_labels:
            c.done ??
            doneOf(
              status.find((s) => s.id === column_id),
              [],
            ),
        }))
      : [],
    subitems:
      useSub && effectiveSubColumn
        ? {
            column_id: effectiveSubColumn,
            weight: subWeight,
            done_labels: subDoneIds,
            recursive,
            weight_column_id: weightColumn,
          }
        : null,
    hide_percent: hide,
  };

  // What is missing, in words — the empty state of the dialog.
  const missing: string[] = [];
  if (!source) missing.push(t('r15cols.progress.missing.source'));
  if (useSub && !board.subitems_board_id) missing.push(t('r15cols.progress.missing.noSubitems'));
  else if (useSub && !effectiveSubColumn) missing.push(t('r15cols.progress.missing.subStatus'));
  else if (useSub && !subDoneIds.length) missing.push(t('r15cols.progress.missing.subDone'));
  if (useCols && !chosenCols.length) missing.push(t('r15cols.progress.missing.columns'));
  if (useCols && settings.columns.some((c) => !c.done_labels.length))
    missing.push(t('r15cols.progress.missing.columnDone'));

  // The live example: 3 of 4 subitems done, the first chosen column done and the others not.
  const example = computeProgress(settings, {
    statusColumns: status.map((c) => c.id),
    isDone: (key) => key === chosenCols[0]?.[0],
    subitems: 0.75,
  });
  const sentence = [
    useSub && effectiveSubColumn
      ? t(msgKey(recursive ? 'r15cols.progress.explain.subitemsRecursive' : 'r15cols.progress.explain.subitems'), {
          labels: labelsOf(subStatusColumn)
            .filter((l) => subDoneIds.includes(l.id))
            .map((l) => `"${l.label}"`)
            .join(' / '),
          column: subStatusColumn?.title ?? '',
        }) +
        (weightColumn
          ? ` ${t('r15cols.progress.explain.weighted', { column: subWeights.find((c) => c.id === weightColumn)?.title ?? '' })}`
          : '')
      : null,
    useCols && chosenCols.length
      ? t('r15cols.progress.explain.columns', {
          columns: chosenCols.map(([id, c]) => `${status.find((s) => s.id === id)?.title} (×${c.weight})`).join(', '),
        })
      : null,
  ].filter(Boolean);

  const previewColumn = { ...column, settings: { ...column.settings, hide_percent: hide } } as Column;
  return shell(
    <>
      <p className="text-sm text-muted">{t('r15cols.progress.intro')}</p>
      <Field label={t('r15cols.progress.source')}>
        <Segmented
          label={t('r15cols.progress.source')}
          value={(source ?? '') as ProgressSource}
          onChange={setSource}
          testId="progress-source"
          options={PROGRESS_SOURCES.map((v) => ({
            value: v,
            label: t(msgKey(`r15cols.progress.source.${v}`)),
            testId: `progress-source-${v}`,
          }))}
        />
      </Field>

      {useSub ? (
        <Section
          title={t('r15cols.progress.subitems.title')}
          hint={t('r15cols.progress.subitems.hint')}
          testId="progress-subitems-section"
        >
          {!board.subitems_board_id ? (
            <Notice>{t('r15cols.progress.noSubitemsYet')}</Notice>
          ) : (
            <>
              <Field label={t('r15cols.progress.subStatus')}>
                {subStatus.length ? (
                  <PickerButton
                    testId="progress-subitems"
                    menuLabel={t('r15cols.progress.subStatus')}
                    placeholder={t('r15cols.progress.pick')}
                    label={subStatusColumn?.title}
                    items={subStatus.map((c) => ({
                      label: c.title,
                      checked: c.id === effectiveSubColumn,
                      onSelect: () => {
                        setSubColumn(c.id);
                        setSubDone(null);
                      },
                    }))}
                  />
                ) : (
                  <Notice>{t('r15cols.progress.noSubStatus')}</Notice>
                )}
              </Field>
              {subStatusColumn ? (
                <Field label={t('r15cols.progress.doneLabels')} hint={t('r15cols.progress.doneLabelsHint')}>
                  <DoneLabels
                    column={subStatusColumn}
                    chosen={subDoneIds}
                    onChange={setSubDone}
                    testId="progress-sub-done"
                  />
                </Field>
              ) : null}
              <label className="flex items-start gap-2 text-sm">
                <Switch checked={recursive} onChange={setRecursive} testId="progress-recursive" />
                <span>
                  {t('r15cols.progress.recursive')}
                  <span className="block text-xs text-muted">{t('r15cols.progress.recursiveHint')}</span>
                </span>
              </label>
              <Field label={t('r15cols.progress.weightBy')} hint={t('r15cols.progress.weightByHint')}>
                <PickerButton
                  testId="progress-weight-column"
                  menuLabel={t('r15cols.progress.weightBy')}
                  placeholder={t('r15cols.progress.weightBy.none')}
                  label={subWeights.find((c) => c.id === weightColumn)?.title ?? t('r15cols.progress.weightBy.none')}
                  items={[
                    {
                      label: t('r15cols.progress.weightBy.none'),
                      checked: !weightColumn,
                      onSelect: () => setWeightColumn(null),
                    },
                    ...subWeights.map((c) => ({
                      label: c.title,
                      checked: c.id === weightColumn,
                      onSelect: () => setWeightColumn(c.id),
                    })),
                  ]}
                />
              </Field>
              {source === 'both' ? (
                <Field label={t('r15cols.progress.subitemsWeight')}>
                  <WeightInput value={subWeight} onChange={setSubWeight} testId="progress-subitems-weight" />
                </Field>
              ) : null}
            </>
          )}
        </Section>
      ) : null}

      {useCols ? (
        <Section
          title={t('r15cols.progress.columns.title')}
          hint={t('r15cols.progress.columns.hint')}
          testId="progress-columns"
        >
          {status.length ? null : <Notice>{t('progress.noStatus')}</Notice>}
          {status.map((c) => {
            const on = c.id in chosen;
            const entry = chosen[c.id];
            return (
              <div key={c.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <CheckRow
                    checked={on}
                    onToggle={() =>
                      setChosen((p) => {
                        const next = { ...p };
                        if (on) delete next[c.id];
                        else next[c.id] = { weight: 1, done: null };
                        return next;
                      })
                    }
                    className="flex-1"
                  >
                    {c.title}
                  </CheckRow>
                  {on && entry ? (
                    <WeightInput
                      value={entry.weight}
                      testId="progress-weight"
                      onChange={(n) => setChosen((p) => ({ ...p, [c.id]: { ...entry, weight: n } }))}
                    />
                  ) : null}
                </div>
                {on && entry ? (
                  <div className="ps-8">
                    <DoneLabels
                      column={c}
                      chosen={entry.done ?? doneOf(c, [])}
                      onChange={(ids) => setChosen((p) => ({ ...p, [c.id]: { ...entry, done: ids } }))}
                      testId="progress-column-done"
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </Section>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={hide} onChange={setHide} testId="progress-hide-percent" />
        {t('progress.hidePercent')}
      </label>

      {missing.length ? (
        <div data-testid="progress-empty">
          <Notice tone="warn">
            <span>
              <span className="block font-semibold">{t('r15cols.progress.empty')}</span>
              {missing.map((m) => (
                <span key={m} className="block">
                  • {m}
                </span>
              ))}
            </span>
          </Notice>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-[12px] bg-surface-2 p-3" data-testid="progress-preview">
          <p className="text-sm text-fg-2" data-testid="progress-explain">
            {sentence.join(` ${t('r15cols.progress.explain.and')} `)}
          </p>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-muted">{t('r15cols.progress.example')}</span>
            <div className="h-8 min-w-0 flex-1 rounded-[6px] bg-surface">
              <ProgressCell
                {...({} as CellProps)}
                column={previewColumn}
                value={example === null ? null : { percent: example }}
                text={null}
              />
            </div>
          </div>
        </div>
      )}
    </>,
    <Button
      busy={busy}
      data-testid="column-settings-save"
      disabled={missing.length > 0}
      onClick={() => void onSave(settings)}
    >
      {t('common.save')}
    </Button>,
  );
};
