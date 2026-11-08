// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AI_COLUMN_KINDS,
  AI_COLUMN_OUTPUTS,
  AI_IMAGE_QUALITIES,
  AI_IMAGE_SIZES,
  AI_EXTRACT_FIELDS,
  AI_FIDELITY_MODES,
  AI_IMAGE_RERUN_MODES,
  AI_NO_SOURCE_IMAGE_MODES,
  AI_PHOTO_MODES,
  AI_SOURCE_COLUMNS_MAX,
  AI_SUMMARY_LENGTHS,
  AI_VARIATIONS_MAX,
  type AiImageRerunMode,
  aiColumnRefs,
  type AiColumnSettings,
  aiColumnSettingsSchema,
  t,
  msgKey,
  dynamicKey,
} from '@bines/shared';
import { Button, Field, Input, Menu, Notice, Segmented, Switch, useActionMenu } from '@bines/ui';
import { isImageAiColumn, onExistingEntries } from './run-choice';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import type { BoardDetail, Column } from '../board/board-api';
import { BoardAccountContext } from '../board/board-context';
import { CheckRow, PickerButton } from '../board/toolbar/parts';
import { money, runStartToast, runToast } from './AiCell';
import { StyleExamplesSection } from './StyleExamplesSection';
import { useAiColumnConnections, useAiColumnInfo, useRunAiColumn } from './ai2-api';
import { defaultChoiceLabel, modelChoices, modelMenuEntries, useAiModels } from '../ai/ai-api';
import { GatedButton, PlanGateNote, usePlanGate } from '../../lib/plan-gate';

/**
 * Settings of an AI column (מ11) — everything chosen here, nothing per client in code: what it does (summarise,
 * classify, extract, translate, a custom prompt with {Column} references), which columns it reads (and updates) —
 * photos of file columns too (designs from them, or reads them — all, or the newest N of each; no
 * photo = from the description or skip; style examples of other items, round 3; round 4: each photo separately or
 * all together, variations, how much may change (free / close / locked on a base), a new version or another design
 * on a re-run),
 * the AI connection + model (Administration → AI ו-MCP), auto-run, limits per run and per month; and "run now" on
 * the empty cells or on all of them.
 */
type Props = {
  accountId: string;
  board: BoardDetail;
  column: Column;
  busy: boolean;
  onSave: (settings: Record<string, unknown>) => Promise<unknown>;
  shell: (body: ReactNode, save: ReactNode) => ReactNode;
};

const num = (s: string, fallback: number) => {
  const n = Number(s);
  return s.trim() && Number.isFinite(n) ? n : fallback;
};

export const AiColumnForm = ({ accountId, board, column, busy, onSave, shell }: Props) => {
  const { slug } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const initial = aiColumnSettingsSchema.parse(column.settings ?? {});
  const [s, setS] = useState<AiColumnSettings>(initial);
  const [labelsText, setLabelsText] = useState(initial.labels.join('\n'));
  const [limits, setLimits] = useState({
    items: String(initial.max_items_per_run),
    run: String(initial.max_usd_per_run),
    month: initial.max_usd_per_month === null ? '' : String(initial.max_usd_per_month),
  });
  const set = (patch: Partial<AiColumnSettings>) => setS((x) => ({ ...x, ...patch }));
  const connections = useAiColumnConnections(accountId).data?.data ?? [];
  const info = useAiColumnInfo(accountId, board.id, column.id).data;
  const run = useRunAiColumn(accountId, board.id, { onStart: runStartToast });
  // Plan feature gate: without `ai` the column stays editable here but cannot run.
  const aiGate = usePlanGate(accountId, 'ai');

  const others = board.columns.filter((c) => c.id !== column.id && c.type !== 'name');
  const labelColumns = board.columns.filter((c) => c.type === 'status' || c.type === 'dropdown');
  const conn = connections.find((c) => c.id === s.connection_id);
  // The connection's live model list (any provider); nothing else is offered.
  const liveModels = useAiModels(accountId, conn?.id ?? null);
  const image = s.output === 'image';
  // Image output (AI images): only models that make images.
  const models = modelChoices(liveModels.data, s.model).filter(
    (m) => !image || m.capabilities.image_generation || m.id === s.model,
  );
  const fileColumns = board.columns.filter((c) => c.type === 'file');
  // Photos as input: any file columns but the one the images are saved in, in the order picked.
  const sourceColumns = fileColumns.filter((c) => !image || c.id !== s.image_column);
  const sources = s.source_image_columns;
  const sourceTitles = sources
    .map((k) => fileColumns.find((c) => c.id === k)?.title)
    .filter((x): x is string => !!x)
    .join(', ');
  const toggleSource = (key: string) =>
    set({
      source_image_columns: sources.includes(key)
        ? sources.filter((k) => k !== key)
        : [...sources, key].slice(0, AI_SOURCE_COLUMNS_MAX),
      // The made images never land in a column they are read from.
      ...(image && s.image_column === key && !sources.includes(key) ? { image_column: null } : {}),
    });
  const sourceCountLabel = (n: number | 'all') =>
    n === 'all'
      ? t('ai2.form.sourceCountAll')
      : n === 1
        ? t('ai2.form.sourceCountOne')
        : t('ai2.form.sourceCountMany', { n });
  const SOURCE_COUNTS = ['all', 1, 2, 3, 4, 5, 10] as const;
  const modelName = (id: string | null) => models.find((x) => x.id === id)?.display_name ?? id;
  const referenced = new Set(aiColumnRefs(s.instructions));

  const settings = (): AiColumnSettings => ({
    ...s,
    labels: labelsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 50),
    max_items_per_run: Math.round(num(limits.items, 100)),
    max_usd_per_run: num(limits.run, 1),
    max_usd_per_month: limits.month.trim() ? num(limits.month, 10) : null,
  });
  // Round 4: "run on all" of an image column asks what to do with the designs items already have.
  const allMenu = useActionMenu();
  const runNow = (mode: 'empty' | 'all', onExisting?: AiImageRerunMode) =>
    run.mutate(
      { columnId: column.id, mode, ...(onExisting ? { on_existing: onExisting } : {}) },
      {
        onSuccess: (r) => runToast(accountId, r, () => qc.invalidateQueries({ queryKey: ['account', accountId] })),
        onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
      },
    );

  const kindOptions = AI_COLUMN_KINDS.map((x) => ({
    value: x,
    label: t(msgKey(`ai2.kind.${x}`)),
    testId: `ai-kind-${x}`,
  }));

  return shell(
    <div className="flex flex-col gap-3.5" data-testid="ai-column-form">
      <PlanGateNote gate={aiGate} />
      <Field label={t('ai2.form.output')} hint={t('ai2.form.outputHint')}>
        <Segmented
          label={t('ai2.form.output')}
          value={s.output}
          onChange={(output) => set({ output, model: null })}
          options={AI_COLUMN_OUTPUTS.map((x) => ({
            value: x,
            label: t(msgKey(`ai2.output.${x}`)),
            testId: `ai-output-${x}`,
          }))}
          testId="ai-output"
        />
      </Field>
      {image ? null : (
        <Field label={t('ai2.form.kind')}>
          <Segmented
            label={t('ai2.form.kind')}
            value={s.kind}
            onChange={(kind) => set({ kind })}
            options={kindOptions}
            testId="ai-kind"
          />
        </Field>
      )}
      {image ? (
        <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1" data-testid="ai-image-options">
          <Field label={t('ai2.form.imageColumn')} hint={t('ai2.form.imageColumnHint')}>
            <PickerButton
              testId="ai-image-column"
              label={fileColumns.find((c) => c.id === s.image_column)?.title}
              placeholder={t('ai2.form.pickFileColumn')}
              menuLabel={t('ai2.form.imageColumn')}
              items={fileColumns
                .filter((c) => !sources.includes(c.id))
                .map((c) => ({
                  label: c.title,
                  testId: 'ai-image-column-option',
                  checked: c.id === s.image_column,
                  onSelect: () => set({ image_column: c.id }),
                }))}
            />
          </Field>
          <Field label={t('ai2.form.imageSize')}>
            <PickerButton
              testId="ai-image-size"
              label={s.image_size ?? undefined}
              placeholder={t('ai2.form.accountDefault')}
              menuLabel={t('ai2.form.imageSize')}
              items={[
                {
                  label: t('ai2.form.accountDefault'),
                  checked: s.image_size === null,
                  onSelect: () => set({ image_size: null }),
                },
                ...AI_IMAGE_SIZES.map((v) => ({
                  label: v,
                  checked: v === s.image_size,
                  onSelect: () => set({ image_size: v }),
                })),
              ]}
            />
          </Field>
          <Field label={t('ai2.form.imageQuality')}>
            <PickerButton
              testId="ai-image-quality"
              label={s.image_quality ?? undefined}
              placeholder={t('ai2.form.accountDefault')}
              menuLabel={t('ai2.form.imageQuality')}
              items={[
                {
                  label: t('ai2.form.accountDefault'),
                  checked: s.image_quality === null,
                  onSelect: () => set({ image_quality: null }),
                },
                ...AI_IMAGE_QUALITIES.map((v) => ({
                  label: v,
                  checked: v === s.image_quality,
                  onSelect: () => set({ image_quality: v }),
                })),
              ]}
            />
          </Field>
        </div>
      ) : null}
      {image && !fileColumns.length ? <Notice tone="warn">{t('ai2.form.noFileColumns')}</Notice> : null}

      <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1" data-testid="ai-source-options">
        <Field label={t('ai2.form.sourceImageColumn')} hint={t('ai2.form.sourceImageColumnHint')}>
          <PickerButton
            testId="ai-source-column"
            label={sourceTitles || undefined}
            placeholder={t('ai2.form.noSourceImage')}
            menuLabel={t('ai2.form.sourceImageColumn')}
            items={[
              {
                label: t('ai2.form.noSourceImage'),
                testId: 'ai-source-column-none',
                checked: !sources.length,
                onSelect: () => set({ source_image_columns: [] }),
              },
              // Several at once: the menu stays open; the order picked is the order they are sent in.
              ...sourceColumns.map((c) => {
                const at = sources.indexOf(c.id);
                return {
                  label: at >= 0 && sources.length > 1 ? `${at + 1}. ${c.title}` : c.title,
                  testId: 'ai-source-column-option',
                  checked: at >= 0,
                  keepOpen: true,
                  onSelect: () => toggleSource(c.id),
                };
              }),
            ]}
          />
        </Field>
        {sources.length ? (
          <Field label={t('ai2.form.sourceImageCount')} hint={t('ai2.form.sourceImageCountHint')}>
            <PickerButton
              testId="ai-source-count"
              label={sourceCountLabel(s.source_image_count)}
              placeholder={sourceCountLabel('all')}
              menuLabel={t('ai2.form.sourceImageCount')}
              items={SOURCE_COUNTS.map((n) => ({
                label: sourceCountLabel(n),
                testId: `ai-source-count-${n}`,
                checked: n === s.source_image_count,
                onSelect: () => set({ source_image_count: n }),
              }))}
            />
          </Field>
        ) : null}
      </div>
      {sources.length ? (
        <Field label={t('ai2.form.noSourcePhoto')}>
          <Segmented
            label={t('ai2.form.noSourcePhoto')}
            value={s.when_no_source_image}
            onChange={(when_no_source_image) => set({ when_no_source_image })}
            options={AI_NO_SOURCE_IMAGE_MODES.map((x) => ({
              value: x,
              label: t(msgKey(`ai2.noSource.${x}`)),
              testId: `ai-no-source-${x}`,
            }))}
            testId="ai-no-source"
          />
        </Field>
      ) : null}
      {sources.length && !image ? <p className="text-xs text-muted">{t('ai2.form.sourceNeedsVision')}</p> : null}
      <StyleExamplesSection
        accountId={accountId}
        boardId={board.id}
        fileColumns={fileColumns}
        value={s.style_examples}
        onChange={(style_examples) => set({ style_examples })}
      />
      {image ? (
        // Round 4: one design per photo or one from all, variations, how much may change, re-run.
        <div className="flex flex-col gap-3.5" data-testid="ai-design-options">
          {sources.length ? (
            <Field label={t('ai2.form.photoMode')} hint={t('ai2.form.photoModeHint')}>
              <Segmented
                label={t('ai2.form.photoMode')}
                value={s.photo_mode}
                onChange={(photo_mode) => set({ photo_mode })}
                options={AI_PHOTO_MODES.map((x) => ({
                  value: x,
                  label: t(msgKey(`ai2.photoMode.${x}`)),
                  testId: `ai-photo-mode-${x}`,
                }))}
                testId="ai-photo-mode"
              />
            </Field>
          ) : null}
          <Field label={t('ai2.form.variations')} hint={t('ai2.form.variationsHint')}>
            <Segmented
              label={t('ai2.form.variations')}
              value={String(s.variations)}
              onChange={(v) => set({ variations: Number(v) })}
              options={Array.from({ length: AI_VARIATIONS_MAX }, (_, i) => String(i + 1)).map((x) => ({
                value: x,
                label: x,
                testId: `ai-variations-${x}`,
              }))}
              testId="ai-variations"
            />
          </Field>
          <Field label={t('ai2.form.fidelity')} hint={t('ai2.form.fidelityHint')}>
            <Segmented
              label={t('ai2.form.fidelity')}
              value={s.fidelity}
              onChange={(fidelity) => set({ fidelity })}
              options={AI_FIDELITY_MODES.map((x) => ({
                value: x,
                label: t(msgKey(`ai2.fidelity.${x}`)),
                testId: `ai-fidelity-${x}`,
              }))}
              testId="ai-fidelity"
            />
          </Field>
          {s.fidelity === 'locked' ? (
            <Field label={t('ai2.form.fidelityBase')} hint={t('ai2.form.fidelityBaseHint')}>
              <PickerButton
                testId="ai-fidelity-base"
                label={fileColumns.find((c) => c.id === s.fidelity_base_column)?.title}
                placeholder={t('ai2.form.fidelityBaseStyle')}
                menuLabel={t('ai2.form.fidelityBase')}
                items={[
                  {
                    label: t('ai2.form.fidelityBaseStyle'),
                    testId: 'ai-fidelity-base-style',
                    checked: !s.fidelity_base_column,
                    onSelect: () => set({ fidelity_base_column: null }),
                  },
                  ...fileColumns
                    .filter((c) => c.id !== s.image_column)
                    .map((c) => ({
                      label: c.title,
                      testId: 'ai-fidelity-base-option',
                      checked: c.id === s.fidelity_base_column,
                      onSelect: () => set({ fidelity_base_column: c.id }),
                    })),
                ]}
              />
            </Field>
          ) : null}
          <Field label={t('ai2.form.onRerun')} hint={t('ai2.form.onRerunHint')}>
            <Segmented
              label={t('ai2.form.onRerun')}
              value={s.image_on_rerun}
              onChange={(image_on_rerun) => set({ image_on_rerun })}
              options={AI_IMAGE_RERUN_MODES.map((x) => ({
                value: x,
                label: t(msgKey(`ai2.rerun.${x}`)),
                testId: `ai-rerun-${x}`,
              }))}
              testId="ai-rerun"
            />
          </Field>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
        <Field label={t('ai2.form.connection')}>
          <PickerButton
            testId="ai-connection"
            label={conn?.name}
            placeholder={t('ai2.form.pickConnection')}
            menuLabel={t('ai2.form.connection')}
            items={connections.map((c) => ({
              label: c.name,
              testId: 'ai-connection-option',
              checked: c.id === s.connection_id,
              onSelect: () => set({ connection_id: c.id }),
            }))}
          />
        </Field>
        <Field label={t('ai2.form.model')}>
          <PickerButton
            testId="ai-model"
            label={
              modelName(s.model) ??
              (image ? undefined : (modelName(liveModels.data?.default_model ?? null) ?? undefined))
            }
            placeholder={t('ai2.form.connectionDefault')}
            menuLabel={t('ai2.form.model')}
            items={[
              {
                label: image
                  ? t('ai2.form.connectionDefault')
                  : defaultChoiceLabel(t('ai2.form.connectionDefault'), liveModels.data),
                testId: 'ai-model-default',
                checked: s.model === null,
                onSelect: () => set({ model: null }),
              },
              ...modelMenuEntries(models, s.model, (id) => set({ model: id }), 'ai-model-option'),
            ]}
          />
        </Field>
      </div>
      {!connections.length ? (
        <Notice tone="warn">
          {t('ai2.form.noConnections')}{' '}
          <Link
            to="/a/$accountSlug/admin/$section"
            params={{ accountSlug: slug, section: 'ai' }}
            className="font-semibold underline"
            data-testid="ai-settings-link"
          >
            {t('ai2.settingsLink')}
          </Link>
        </Notice>
      ) : null}

      <Field label={t('ai2.form.inputs')} hint={t('ai2.form.inputsHint')}>
        <div
          className="flex max-h-44 flex-col gap-0.5 overflow-auto rounded-[10px] border border-line p-1"
          data-testid="ai-inputs"
        >
          <CheckRow checked={s.include_name} onToggle={() => set({ include_name: !s.include_name })}>
            {t('ai2.form.itemName')}
          </CheckRow>
          {others.map((c) => {
            const on = s.inputs.includes(c.id);
            return (
              <div key={c.id} data-testid="ai-input" data-column={c.id}>
                <CheckRow
                  checked={on || referenced.has(c.title) || referenced.has(c.id)}
                  onToggle={() => set({ inputs: on ? s.inputs.filter((x) => x !== c.id) : [...s.inputs, c.id] })}
                >
                  <span className="truncate">{c.title}</span>
                </CheckRow>
              </div>
            );
          })}
          <CheckRow checked={s.include_updates} onToggle={() => set({ include_updates: !s.include_updates })}>
            {t('ai2.form.updates')}
          </CheckRow>
        </div>
      </Field>

      {!image && s.kind === 'summarize' ? (
        <Field label={t('ai2.form.length')}>
          <Segmented
            label={t('ai2.form.length')}
            value={s.length}
            onChange={(length) => set({ length })}
            options={AI_SUMMARY_LENGTHS.map((x) => ({ value: x, label: t(msgKey(`ai2.length.${x}`)) }))}
          />
        </Field>
      ) : null}
      {!image && s.kind === 'classify' ? (
        <>
          <Field label={t('ai2.form.labelsFrom')}>
            <PickerButton
              testId="ai-labels-from"
              label={
                labelColumns.find((c) => c.id === s.labels_from)?.title ?? (s.labels_from ? s.labels_from : undefined)
              }
              placeholder={t('ai2.form.fixedList')}
              menuLabel={t('ai2.form.labelsFrom')}
              items={[
                {
                  label: t('ai2.form.fixedList'),
                  checked: !s.labels_from,
                  onSelect: () => set({ labels_from: null }),
                },
                ...labelColumns.map((c) => ({
                  label: c.title,
                  checked: c.id === s.labels_from,
                  onSelect: () => set({ labels_from: c.id }),
                })),
              ]}
            />
          </Field>
          {!s.labels_from ? (
            <Field label={t('ai2.form.labels')} hint={t('ai2.form.labelsHint')}>
              <textarea
                value={labelsText}
                data-testid="ai-labels"
                onChange={(e) => setLabelsText(e.target.value)}
                className="h-24 w-full resize-y rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm focus:border-primary focus:outline-none"
              />
            </Field>
          ) : null}
          <Field label={t('ai2.form.writeTo')} hint={t('ai2.form.writeToHint')}>
            <PickerButton
              testId="ai-write-to"
              label={labelColumns.find((c) => c.id === s.write_to)?.title}
              placeholder={t('ai2.form.none')}
              menuLabel={t('ai2.form.writeTo')}
              items={[
                { label: t('ai2.form.none'), checked: !s.write_to, onSelect: () => set({ write_to: null }) },
                ...labelColumns.map((c) => ({
                  label: c.title,
                  checked: c.id === s.write_to,
                  onSelect: () => set({ write_to: c.id }),
                })),
              ]}
            />
          </Field>
        </>
      ) : null}
      {!image && s.kind === 'extract' ? (
        <Field label={t('ai2.form.extract')}>
          <Segmented
            label={t('ai2.form.extract')}
            value={s.extract}
            onChange={(extract) => set({ extract })}
            options={AI_EXTRACT_FIELDS.map((x) => ({ value: x, label: t(msgKey(`ai2.extract.${x}`)) }))}
          />
        </Field>
      ) : null}
      {!image && s.kind === 'translate' ? (
        <Field label={t('ai2.form.language')}>
          <Input
            value={s.language}
            maxLength={40}
            data-testid="ai-language"
            onChange={(e) => set({ language: e.target.value })}
          />
        </Field>
      ) : null}

      <Field
        label={t(
          msgKey(
            image
              ? 'ai2.form.imagePrompt'
              : s.kind === 'custom'
                ? 'ai2.form.prompt'
                : s.kind === 'extract'
                  ? 'ai2.form.what'
                  : 'ai2.form.instructions',
          ),
        )}
        hint={t('ai2.form.promptHint')}
      >
        <textarea
          value={s.instructions}
          maxLength={4000}
          data-testid="ai-instructions"
          onChange={(e) => set({ instructions: e.target.value })}
          className="h-24 w-full resize-y rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm focus:border-primary focus:outline-none"
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={s.auto_run} onChange={(auto_run) => set({ auto_run })} testId="ai-auto-run" />
        {t('ai2.form.autoRun')}
      </label>

      <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
        <Field label={t('ai2.form.maxItems')}>
          <Input
            inputMode="numeric"
            dir="ltr"
            value={limits.items}
            data-testid="ai-max-items"
            onChange={(e) => setLimits((l) => ({ ...l, items: e.target.value }))}
          />
        </Field>
        <Field label={t('ai2.form.maxRunUsd')}>
          <Input
            inputMode="decimal"
            dir="ltr"
            value={limits.run}
            data-testid="ai-max-run"
            onChange={(e) => setLimits((l) => ({ ...l, run: e.target.value }))}
          />
        </Field>
        <Field label={t('ai2.form.maxMonthUsd')}>
          <Input
            inputMode="decimal"
            dir="ltr"
            value={limits.month}
            placeholder={t('ai2.form.noLimit')}
            data-testid="ai-max-month"
            onChange={(e) => setLimits((l) => ({ ...l, month: e.target.value }))}
          />
        </Field>
      </div>
      {/*: what the dollar limits stop (with images: every design is checked before it is made). */}
      <p className="-mt-1.5 text-xs text-muted" data-testid="ai-limits-hint">
        {s.output === 'image' ? t('ai2.form.limitsHintImage') : t('ai2.form.limitsHint')}
      </p>

      {info ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-[12px] bg-surface-2 p-2.5 text-sm"
          data-testid="ai-run-now"
        >
          <span className="text-fg-2" data-testid="ai-month-usd">
            {t('ai2.form.monthSpend', { cost: money(info.month_usd) })}
          </span>
          <span className="flex-1" />
          {board.capabilities['item.update'] ? (
            <>
              <GatedButton
                gate={aiGate}
                upgrade={false}
                size="sm"
                variant="secondary"
                data-testid="ai-run-empty"
                busy={run.isPending}
                disabled={!info.ready}
                onClick={() => runNow('empty')}
              >
                <Icon name="sparkle" size={14} />
                {t('ai2.form.runEmpty')}
              </GatedButton>
              <GatedButton
                gate={aiGate}
                upgrade={false}
                size="sm"
                variant="ghost"
                data-testid="ai-run-all"
                disabled={!info.ready || run.isPending}
                onClick={(e) => (isImageAiColumn(column) ? allMenu.fromTrigger(e) : runNow('all'))}
              >
                {t('ai2.form.runAll')}
              </GatedButton>
              <Menu
                at={allMenu.at}
                onClose={allMenu.close}
                label={t('ai2.form.runAll')}
                items={onExistingEntries(column, (on) => runNow('all', on), 'ai-run-all-existing')}
              />
            </>
          ) : null}
          {!info.ready && info.reason ? (
            <p className="w-full text-xs text-muted">{t(dynamicKey(`ai2.reason.${info.reason}`))}</p>
          ) : null}
        </div>
      ) : null}
    </div>,
    <Button busy={busy} data-testid="column-settings-save" onClick={() => void onSave(settings())}>
      {t('common.save')}
    </Button>,
  );
};
