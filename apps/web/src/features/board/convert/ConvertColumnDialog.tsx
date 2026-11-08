// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import {
  type ColumnConversion,
  type ConversionDependent,
  type ConversionPreview,
  conversionTargets,
  type ConvertOptions,
  labelColorKey,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, cn, Dialog, Notice, Spinner, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { columnTypeLabel } from '../../../lib/locale';
import { showToast } from '../../../lib/toast';
import { ColorGrid, tagVars } from '../../../lib/label-color';
import { useUndoToast } from '../../../lib/undo';
import { type BoardDetail, type Column } from '../board-api';
import { Popover } from '../cells/Popover';
import { useOpenItem } from '../open-item';
import { PickerButton } from '../toolbar/parts';
import { conversionKeys, previewConversion, runConversion } from './convert-api';

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * "שינוי סוג עמודה" (D28, plan §4): the target type, the pair's options, then the server's dry run — counts
 * (converted · empty · failed), examples before → after and the failures (a click opens the item), the labels /
 * tags it would create (remove one, recolour a status label), what else is affected — and "convert". A large board
 * converts in the background: the dialog follows its progress. Done → a toast with "undo" (one step).
 */
export const ConvertColumnDialog = ({
  accountId,
  board,
  column,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const undoToast = useUndoToast(accountId);
  const targets = conversionTargets(column.type);
  const [toType, setToType] = useState<string | null>(null);
  const [options, setOptions] = useState<ConvertOptions>({});
  // A background conversion: its latest state while the dialog follows it.
  const [running, setRunning] = useState<ColumnConversion | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: [...conversionKeys.all(accountId, board.id), 'preview', column.id, toType, options],
    queryFn: () => previewConversion(accountId, board.id, column.id, { to_type: toType!, options }),
    enabled: !!toType && !running,
    staleTime: 0,
    gcTime: 0,
  });

  const finish = async (c: ColumnConversion) => {
    await qc.invalidateQueries({ queryKey: ['account', accountId, 'board', board.id] });
    if (c.status === 'failed') {
      showToast({ message: t('convert.failedRun', { error: c.error ?? '' }), tone: 'error' });
      setRunning(null);
      return;
    }
    onClose();
    const message =
      c.counts.failed > 0
        ? t('convert.doneWithBackup', { type: columnTypeLabel(c.to_type), n: c.counts.failed })
        : t('convert.done', { type: columnTypeLabel(c.to_type) });
    if (c.event_id) undoToast(message, c.event_id);
    else showToast({ message });
  };
  const apply = async (p: ConversionPreview) => {
    setBusy(true);
    try {
      let c = await runConversion(accountId, board.id, column.id, {
        to_type: p.to_type,
        options,
        fingerprint: p.fingerprint,
      });
      // A large board converts in the background: follow it until it ends (the dialog stays open meanwhile).
      while (c.status === 'running') {
        setRunning(c);
        await new Promise((r) => setTimeout(r, 1500));
        c = await api(accountId).get<ColumnConversion>(`/boards/${board.id}/conversions/${c.id}`);
      }
      await finish(c);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'preview_stale') {
        showToast({ message: t('convert.stale') });
        void preview.refetch();
      } else showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const p = preview.data;
  const skip = new Set((options.skip_labels ?? []).map(norm));
  const setSkip = (name: string, off: boolean) => {
    const next = new Set(skip);
    if (off) next.add(norm(name));
    else next.delete(norm(name));
    setOptions({ ...options, skip_labels: [...next] });
  };
  const setColor = (name: string, color: string) =>
    setOptions({ ...options, label_colors: { ...options.label_colors, [norm(name)]: labelColorKey(color) } });

  const footer = (
    <div className="flex w-full items-center justify-end gap-2">
      <Button variant="ghost" onClick={onClose} data-testid="convert-cancel">
        {t('convert.cancel')}
      </Button>
      <Button
        data-testid="convert-apply"
        disabled={!p || preview.isFetching || !!running || p.counts.converted + p.counts.failed === 0}
        busy={busy}
        onClick={() => p && void apply(p)}
      >
        {p && p.counts.failed > 0 ? t('convert.applyWithBackup', { n: p.counts.failed }) : t('convert.apply')}
      </Button>
    </div>
  );

  return (
    <Dialog
      open
      onClose={running ? () => undefined : onClose}
      title={t('convert.title', { name: column.title })}
      subtitle={t('convert.subtitle', { type: columnTypeLabel(column.type) })}
      className="max-w-3xl!"
      footer={footer}
    >
      <div className="space-y-4" data-testid="convert-dialog">
        {running ? (
          <ProgressPanel conversion={running} />
        ) : (
          <>
            <section>
              <h3 className="mb-2 text-[0.8125rem] font-semibold text-heading">{t('convert.chooseType')}</h3>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('convert.chooseType')}>
                {targets.map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={toType === type}
                    data-testid="convert-target"
                    data-type={type}
                    onClick={() => {
                      setToType(type);
                      setOptions({});
                    }}
                    className={cn(
                      'h-8 rounded-[10px] border px-3 text-[0.8125rem]',
                      toType === type
                        ? 'border-primary bg-[var(--accent-soft)] text-heading'
                        : 'border-line-strong bg-surface hover:border-primary',
                    )}
                  >
                    {columnTypeLabel(type)}
                  </button>
                ))}
              </div>
            </section>
            {toType && preview.isLoading ? <Spinner label={t('convert.loading')} /> : null}
            {preview.error ? <Notice tone="error">{errorMessage(preview.error)}</Notice> : null}
            {p ? (
              <PreviewPanel
                preview={p}
                options={options}
                onOptions={setOptions}
                skip={skip}
                onSkip={setSkip}
                onColor={setColor}
                boardId={board.id}
              />
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
};

const ProgressPanel = ({ conversion }: { conversion: ColumnConversion | null }) => {
  const pct = conversion && conversion.total ? Math.round((conversion.done / conversion.total) * 100) : 0;
  return (
    <div className="space-y-2 py-4" data-testid="convert-progress" data-pct={pct}>
      <p className="text-[0.8125rem] text-fg-2">{t('convert.running', { pct })}</p>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted">{t('convert.runningHint')}</p>
    </div>
  );
};

const Count = ({
  n,
  label,
  tone,
  testId,
}: {
  n: number;
  label: string;
  tone: 'ok' | 'neutral' | 'danger';
  testId: string;
}) => (
  <span data-testid={testId} data-n={n}>
    <Badge tone={tone}>
      <span className="tabular-nums">{n}</span> {label}
    </Badge>
  </span>
);

const PreviewPanel = ({
  preview: p,
  options,
  onOptions,
  skip,
  onSkip,
  onColor,
  boardId,
}: {
  preview: ConversionPreview;
  options: ConvertOptions;
  onOptions: (o: ConvertOptions) => void;
  skip: Set<string>;
  onSkip: (name: string, off: boolean) => void;
  onColor: (name: string, color: string) => void;
  boardId: string;
}) => {
  const openItem = useOpenItem(boardId);
  const labels = p.to_type === 'tags' ? p.new_tags : p.new_labels;
  return (
    <div className="space-y-4" data-testid="convert-preview">
      {p.option_keys.length ? <OptionsRow preview={p} options={options} onOptions={onOptions} /> : null}

      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="convert-counts"
        data-converted={p.counts.converted}
        data-empty={p.counts.empty}
        data-failed={p.counts.failed}
      >
        <Count n={p.counts.converted} label={t('convert.count.converted')} tone="ok" testId="convert-count-converted" />
        <Count n={p.counts.empty} label={t('convert.count.empty')} tone="neutral" testId="convert-count-empty" />
        <Count n={p.counts.failed} label={t('convert.count.failed')} tone="danger" testId="convert-count-failed" />
        <span className="text-xs text-muted">{t('convert.count.scope', { n: p.counts.items })}</span>
      </div>
      {p.counts.partial ? <Notice tone="warn">{t('convert.partial', { n: p.counts.partial })}</Notice> : null}
      {p.counts.failed ? <Notice tone="info">{t('convert.failedNote', { n: p.counts.failed })}</Notice> : null}
      {p.background ? <Notice tone="info">{t('convert.background')}</Notice> : null}

      {p.samples.converted.length ? (
        <section>
          <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-heading">{t('convert.examples')}</h3>
          <ul className="divide-y divide-[var(--line)] rounded-[10px] border border-[var(--line)]">
            {p.samples.converted.map((s) => (
              <li
                key={s.item_id}
                className="flex items-center gap-2 px-2.5 py-1.5 text-[0.8125rem]"
                data-testid="convert-sample"
              >
                <button
                  type="button"
                  className="w-32 shrink-0 truncate text-start text-muted hover:underline"
                  onClick={() => openItem(s.item_id)}
                >
                  {s.item_name}
                </button>
                <bdi className="min-w-0 flex-1 truncate">{s.before}</bdi>
                <span aria-hidden className="text-muted">
                  ←
                </span>
                <bdi className="min-w-0 flex-1 truncate font-medium text-heading">{s.after}</bdi>
                {s.partial ? <Badge tone="warn">{t('convert.partialBadge')}</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.samples.failed.length ? (
        <section>
          <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-heading">{t('convert.failedExamples')}</h3>
          <ul className="divide-y divide-[var(--line)] rounded-[10px] border border-[var(--line)]">
            {p.samples.failed.map((s) => (
              <li
                key={s.item_id}
                className="flex items-center gap-2 px-2.5 py-1.5 text-[0.8125rem]"
                data-testid="convert-failed-sample"
              >
                <button
                  type="button"
                  className="w-32 shrink-0 truncate text-start text-muted hover:underline"
                  onClick={() => openItem(s.item_id)}
                >
                  {s.item_name}
                </button>
                <bdi className="min-w-0 flex-1 truncate">{s.before}</bdi>
                <span className="text-xs text-muted">{tDynamic(`convert.reason.${s.reason ?? 'not_parsed'}`)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {labels.length || p.skipped_labels.length ? (
        <section>
          <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-heading">
            {t(p.to_type === 'tags' ? 'convert.newTags' : 'convert.newLabels')}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => (
              <NewLabelChip
                key={l.name}
                name={l.name}
                color={l.color}
                count={l.count}
                onRemove={() => onSkip(l.name, true)}
                onColor={onColor}
              />
            ))}
            {p.skipped_labels
              .filter((l) => skip.has(norm(l.name)))
              .map((l) => (
                <button
                  key={l.name}
                  type="button"
                  data-testid="convert-label-skipped"
                  data-name={l.name}
                  onClick={() => onSkip(l.name, false)}
                  title={t('convert.labelRestore')}
                  className="h-7 rounded-full border border-dashed border-line-strong px-2.5 text-xs text-muted line-through hover:border-primary"
                >
                  {l.name} ({l.count})
                </button>
              ))}
          </div>
          <p className="mt-1 text-xs text-muted">{t('convert.newLabelsHint')}</p>
        </section>
      ) : null}

      <DependentsList dependents={p.dependents} />
    </div>
  );
};

const NewLabelChip = ({
  name,
  color,
  count,
  onRemove,
  onColor,
}: {
  name: string;
  color?: string;
  count: number;
  onRemove: () => void;
  onColor: (name: string, color: string) => void;
}) => {
  const [palette, setPalette] = useState(false);
  return (
    <span
      data-testid="convert-label"
      data-name={name}
      data-color={color ?? ''}
      className="relative inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--line)] bg-surface ps-1 pe-1.5 text-xs"
    >
      {color ? (
        // The label's real look (its tint, a dot in its ink), like the label editor.
        <button
          type="button"
          aria-label={t('convert.labelColor', { name })}
          onClick={() => setPalette(true)}
          className="label-tag size-5 rounded-[var(--radius-sm)] p-0 hover:ring-2 hover:ring-[var(--tag-ink)]"
          style={tagVars(color)}
        >
          <span className="size-1.5 rounded-full" style={{ backgroundColor: 'var(--tag-ink)' }} />
        </button>
      ) : null}
      <bdi className="font-medium">{name}</bdi>
      <span className="text-muted tabular-nums">{count}</span>
      <button
        type="button"
        data-testid="convert-label-remove"
        aria-label={t('convert.labelRemove', { name })}
        title={t('convert.labelRemove', { name })}
        onClick={onRemove}
        className="text-muted hover:text-danger-fg"
      >
        ✕
      </button>
      <Popover open={palette} onClose={() => setPalette(false)}>
        {/* pal40: all forty colours. Prod fix (r15board 5): stays open after a pick (outside click / Esc close it). */}
        <ColorGrid
          kind="pressed"
          look="label"
          size="md"
          label={t('convert.labelColor', { name })}
          testId="convert-palette"
          className="p-2"
          selected={(c) => c === color}
          onPick={(c) => onColor(name, c)}
        />
      </Popover>
    </span>
  );
};

const OptionsRow = ({
  preview: p,
  options,
  onOptions,
}: {
  preview: ConversionPreview;
  options: ConvertOptions;
  onOptions: (o: ConvertOptions) => void;
}) => {
  const eff = p.options;
  const pick = <K extends keyof ConvertOptions>(
    key: K,
    values: ConvertOptions[K][],
    labelOf: (v: ConvertOptions[K]) => string,
  ) => (
    <label className="flex items-center gap-2 text-[0.8125rem]">
      <span className="text-fg-2">{tDynamic(`convert.opt.${key}`)}</span>
      <PickerButton
        testId={`convert-opt-${key}`}
        label={labelOf(eff[key])}
        placeholder={labelOf(eff[key])}
        menuLabel={tDynamic(`convert.opt.${key}`)}
        items={values.map((v) => ({
          label: labelOf(v),
          checked: eff[key] === v,
          onSelect: () => onOptions({ ...options, [key]: v }),
        }))}
      />
    </label>
  );
  return (
    <div
      className="flex flex-wrap items-center gap-4 rounded-[10px] bg-surface-2 px-3 py-2"
      data-testid="convert-options"
    >
      {p.option_keys.includes('date_order')
        ? pick('date_order', ['dmy', 'mdy'], (v) => tDynamic(`convert.opt.date_order.${v}`))
        : null}
      {p.option_keys.includes('timeline_side')
        ? pick('timeline_side', ['start', 'end'], (v) => tDynamic(`convert.opt.timeline_side.${v}`))
        : null}
      {p.option_keys.includes('people_as')
        ? pick('people_as', ['name', 'email'], (v) => tDynamic(`convert.opt.people_as.${v}`))
        : null}
      {p.option_keys.includes('rating_max') ? pick('rating_max', [3, 4, 5, 10], (v) => String(v)) : null}
      {p.option_keys.includes('number_unit') ? (
        <label className="flex items-center gap-2 text-[0.8125rem]">
          <Switch
            checked={eff.number_unit !== false}
            onChange={(on) => onOptions({ ...options, number_unit: on })}
            label={t('convert.opt.number_unit')}
          />
          <span className="text-fg-2">{t('convert.opt.number_unit')}</span>
        </label>
      ) : null}
    </div>
  );
};

const ACTION_TONE: Record<ConversionDependent['action'], 'ok' | 'info' | 'warn' | 'danger'> = {
  kept: 'ok',
  updated: 'info',
  review: 'warn',
  disabled: 'danger',
};

/** "מה עוד מושפע" (plan §6): every dependent with what the conversion does to it. */
export const DependentsList = ({ dependents }: { dependents: ConversionDependent[] }) => (
  <section data-testid="convert-dependents" data-count={dependents.length}>
    <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-heading">{t('convert.dependents')}</h3>
    {dependents.length ? (
      <ul className="space-y-1">
        {dependents.map((d, i) => (
          <li
            key={`${d.kind}-${d.id}-${i}`}
            data-testid="convert-dependent"
            data-kind={d.kind}
            data-action={d.action}
            className="flex items-center gap-2 text-[0.8125rem]"
          >
            <Badge tone={ACTION_TONE[d.action] === 'info' ? 'info' : ACTION_TONE[d.action]}>
              {t(`convert.action.${d.action}`)}
            </Badge>
            <span className="text-muted">{t(`convert.kind.${d.kind}`)}</span>
            <bdi className="truncate font-medium">{d.name}</bdi>
            <span className="truncate text-xs text-muted">
              {tDynamic(`convert.detail.${d.detail}`, flatInfo(d.info))}
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-[0.8125rem] text-muted">{t('convert.noDependents')}</p>
    )}
  </section>
);

const flatInfo = (info: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(info ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)] as const),
  );
