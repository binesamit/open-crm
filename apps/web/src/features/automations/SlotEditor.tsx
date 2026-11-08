// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  AI_FIDELITY_MODES,
  AI_NO_SOURCE_IMAGE_MODES,
  AI_PHOTO_MODES,
  AI_VARIATIONS_MAX,
  COMPUTED_ON_EMPTY,
  COMPUTED_PARENT,
  computedToKeys,
  computedToNames,
  type ComputedEnv,
  type ComputedPreviewResult,
  hasMessage,
  type AiFidelity,
  type AiPhotoMode,
  type AiSourceCount,
  DATE_EXPR_RE,
  dateExprShift,
  generateImageSources,
  type ItemTemplateSummary,
  PEOPLE_SPECIAL,
  proposeItemTemplateSources,
  SUB_LEVELS,
  TIMER_ACTIONS,
  triggerColumns,
  WEEKDAYS,
  t,
  type DraftRecipe,
  type MessageKey,
  type StatusLabel,
} from '@bines/shared';
import { Button, Input, Picker, SearchableList, TimeField } from '@bines/ui';
import { LabelTag, tagVars } from '../../lib/label-color';
import { columnTypeLabel } from '../../lib/locale';
import type { BoardDetail, Member } from '../board/board-api';

import { CheckRow } from '../board/toolbar/parts';
import { StyleExamplesSection, type StyleExamplesValue } from '../ai2/StyleExamplesSection';
import { columnFits, MULTI_COLUMN_TRIGGERS, pickInSection, toggleTriggerColumn, type ColumnSection } from './scopes';
import { templateSegments, type DisplayEnv, type Segment } from './slot-display';
import { FlowTriggerSlot, isFlowTrigger } from './flow-trigger';
import { runReasonText } from './run-reasons';

/** r18board 5: text with its `{variables}` as small named chips. */
export const Segments = ({ segs }: { segs: Segment[] }) => (
  <>
    {segs.map((s, i) =>
      'chip' in s ? (
        <span
          key={i}
          className="mx-0.5 inline-flex h-5 items-center rounded-full bg-surface px-1.5 align-middle text-[0.75rem] font-semibold text-fg-2 ring-1 ring-line"
          data-testid="slot-var"
          data-var={s.raw}
        >
          {s.chip}
        </span>
      ) : (
        <span key={i}>{s.text}</span>
      ),
    )}
  </>
);

/**
 * The editor of one blank of the sentence (04 §8.1): a column, labels, a group, people, a date expression, a
 * number, a time or a text with template variables — never a native picker.
 */
export type SlotTarget = { owner: Record<string, unknown> & { type: string }; field: string; isTrigger: boolean };

type Ctx = {
  board: BoardDetail;
  boards: { id: string; name: string }[];
  members: Member[];
  /** run_agent: the agents I may run. */
  agents?: { id: string; name: string }[];
  /** copy_from_linked: the columns of the board a relation column links to (undefined while loading). */
  linkedColumns?: (relation: unknown) => BoardDetail['columns'] | undefined;
  /**
   * D14: the columns a blank picks from when they are not the board's own — a subitem trigger's (the sub-board),
   * a parent / subitems action's `column` or `source`. Undefined = the board's columns.
   */
  columnsOf?: (slot: SlotTarget, field: 'column' | 'source') => BoardDetail['columns'] | undefined;
  /** More variables for texts (`{parent.*}`, `{subitem.*}`). */
  extraVariables?: { v: string; label: string }[];
  /**
   * r17ui: a column blank that can reach other levels (the item's subitems, its parent) lists them in sections;
   * picking in another section switches the trigger / action to that level's variant. Null = the plain list.
   */
  columnSections?: (slot: SlotTarget) => ColumnSection<BoardDetail['columns'][number]>[] | null;
  /** send_sms: the account's saved SMS texts (GET /sms/status). */
  smsTemplates?: { id: string; name: string; text: string }[];
  /** send_document: the interactive document templates this board may use. */
  idocTemplates?: { id: string; name: string }[];
  /** Item templates (phase 2): the templates of the board a template action works on. */
  itemTemplatesOf?: (owner: SlotTarget['owner']) => ItemTemplateSummary[];
  /**
   * r18board 5: the run item's columns — the sub-board's for a subitem trigger. People, date, relation blanks and
   * `{item.*}` variables read the run item, so they list these (undefined = the board's columns).
   */
  itemColumns?: BoardDetail['columns'];
  /** generate_image's style examples: the account, and the run item's board (its filter's columns). */
  accountId?: string;
  itemBoardId?: string;
  /** r18board 5: how a level's columns are titled in a picker ("עמודות הפריט" / "עמודות תת-פריט"). */
  itemColumnsLabel?: string;
  /**
   * notifyfix: a subitem-level run may also reach its PARENT's people columns (`column:<parent key>` — the engine reads
   * the parent's cell). Listed as a second section under `parentColumnsLabel`. Undefined = no parent level.
   */
  parentColumns?: BoardDetail['columns'];
  parentColumnsLabel?: string;
  /** r18board 5: readable chips for a text's `{variables}` (the builder's display env). */
  displayEnv?: DisplayEnv;
  /**
   * set_computed: what the expression can read by name (the item, its parent, its linked items) and
   * a preview on items of the board (nothing is written).
   */
  computed?: {
    env: ComputedEnv;
    preview: (body: { expression: string; column?: string; round?: number }) => Promise<ComputedPreviewResult>;
  };
};

/** The run item's columns (r18board 5). */
const itemColumnsOf = (ctx: Ctx) => ctx.itemColumns ?? ctx.board.columns;

const columnsFor = (ctx: Ctx, s: SlotTarget) =>
  (ctx.columnsOf?.(s, 'column') ?? ctx.board.columns).filter((c) => columnFits(s.owner.type, s.isTrigger, c));

const labelsOf = (ctx: Ctx, key: unknown, slot?: SlotTarget): StatusLabel[] =>
  (
    ((slot && ctx.columnsOf?.(slot, 'column')) ?? ctx.board.columns).find((c) => c.id === key)?.settings as
      { labels?: StatusLabel[] } | undefined
  )?.labels?.filter((l) => !l.is_deactivated) ?? [];

/**
 * r17ui: a scrolling column of choices. Its rows never shrink — a flex column under a max height
 * squeezes `truncate` rows (overflow hidden → no minimum height) into blank slivers instead of scrolling.
 */
const PICK_LIST = 'flex max-h-72 flex-col gap-1 overflow-y-auto overscroll-contain [&>*]:shrink-0';

const Chip = ({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  color?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`shrink-0 truncate px-2 py-1 text-start text-sm ${color ? 'label-tag justify-start' : 'rounded'} ${active ? 'ring-2 ring-[var(--primary)]' : ''}`}
    style={color ? tagVars(color) : { backgroundColor: 'var(--surface-2)' }}
    data-color={color}
    data-testid="slot-option"
    data-value={label}
  >
    {label}
  </button>
);

/** Variables a text can use: the item's fields and columns (`{` autocomplete, as chips). */
const Variables = ({ ctx, onInsert }: { ctx: Ctx; onInsert: (v: string) => void }) => (
  <div className="flex flex-wrap gap-1" data-testid="slot-variables">
    {[
      { v: '{item.name}', label: t('r18.auto.var.itemName') },
      ...itemColumnsOf(ctx)
        .filter((c) => c.type !== 'name')
        .map((c) => ({ v: `{item.${c.id}}`, label: c.title })),
      ...(ctx.extraVariables ?? []),
      { v: '{board.name}', label: t('auto.var.board') },
      { v: '{item.url}', label: t('auto.var.url') },
      { v: '{actor}', label: t('auto.var.actor') },
      { v: '{today}', label: t('auto.date.today') },
    ].map((x) => (
      <button
        key={x.v}
        type="button"
        className="inline-flex h-6 items-center rounded-full bg-surface-2 px-[0.5625rem] text-xs font-semibold text-fg-2 hover:text-fg"
        onClick={() => onInsert(x.v)}
        data-testid="slot-variable"
        data-var={x.v}
      >
        {x.label}
      </button>
    ))}
  </div>
);

const TextSlot = ({
  value,
  ctx,
  onChange,
  multiline,
  hint,
}: {
  value: string;
  ctx: Ctx;
  onChange: (v: string) => void;
  multiline?: boolean;
  /** A line under the field (generate_image: columns in the description bring their text). */
  hint?: string;
}) => {
  const [text, setText] = useState(value);
  return (
    <div className="w-80 space-y-2">
      {multiline ? (
        <textarea
          autoFocus
          className="min-h-24 w-full rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="slot-text"
        />
      ) : (
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} data-testid="slot-text" />
      )}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {ctx.displayEnv && /\{[^{}]+\}/.test(text) ? (
        // r18board 5: the text as it will read — its variables as named chips, not `{item.status}` keys.
        <p className="text-xs leading-6 text-fg-2" data-testid="slot-text-preview">
          <Segments segs={templateSegments(text, ctx.displayEnv)} />
        </p>
      ) : null}
      <Variables ctx={ctx} onInsert={(v) => setText((x) => `${x}${v}`)} />
      <Button size="sm" onClick={() => onChange(text)} data-testid="slot-apply">
        {t('common.save')}
      </Button>
    </div>
  );
};

/**
 * generate_image: the file columns whose photos the picture starts from (in the order picked), how
 * many of each (all, or the newest N), and what happens without a photo (from the description, or skip). The old
 * single `source_column` is read as a list of one and replaced by `source_columns` on the first change.
 */
const ImageSourcesSlot = ({
  owner,
  ctx,
  onSet,
}: {
  owner: Record<string, unknown> & { type: string };
  ctx: Ctx;
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const src = generateImageSources(owner as Parameters<typeof generateImageSources>[0]);
  const files = itemColumnsOf(ctx).filter((c) => c.type === 'file');
  // Every change saves the whole choice in the new fields (an old single column keeps its "newest 1").
  const commit = (next: Partial<typeof src>) => {
    const v = { ...src, ...next };
    onSet({
      source_columns: v.columns.length ? v.columns : undefined,
      source_column: undefined,
      source_count: v.columns.length && v.count !== 'all' ? v.count : undefined,
      when_no_source_image: v.columns.length && v.whenNone !== 'text' ? v.whenNone : undefined,
      // Round 4: photos picked for the first time on an action → one image per photo (an older action keeps
      // `together` until changed here).
      ...(!src.columns.length && v.columns.length && owner.photo_mode === undefined ? { photo_mode: 'each' } : {}),
    });
  };
  const setColumns = (columns: string[]) => commit({ columns });
  const countLabel = (n: AiSourceCount) =>
    n === 'all'
      ? t('ai2.form.sourceCountAll')
      : n === 1
        ? t('ai2.form.sourceCountOne')
        : t('ai2.form.sourceCountMany', { n });
  const heading = (k: MessageKey) => <span className="px-1 pt-1.5 text-xs text-muted">{t(k)}</span>;
  return (
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1" data-testid="slot-source-columns">
      <CheckRow checked={!src.columns.length} onToggle={() => setColumns([])}>
        {t('auto.source.none')}
      </CheckRow>
      <SearchableList items={files} text={(c) => c.title} testId="slot-search">
        {(shown) => (
          <div className="max-h-56 overflow-y-auto">
            {shown.map((c) => {
              const at = src.columns.indexOf(c.id);
              return (
                <CheckRow
                  key={c.id}
                  testId="slot-source-column"
                  checked={at >= 0}
                  onToggle={() => setColumns(at >= 0 ? src.columns.filter((k) => k !== c.id) : [...src.columns, c.id])}
                >
                  <span className="truncate">
                    {at >= 0 && src.columns.length > 1 ? `${at + 1}. ${c.title}` : c.title}
                  </span>
                </CheckRow>
              );
            })}
          </div>
        )}
      </SearchableList>
      {src.columns.length ? (
        <>
          {heading('ai2.form.sourceImageCount')}
          <div className="flex flex-wrap gap-1" data-testid="slot-source-count">
            {(['all', 1, 2, 3, 4, 5, 10] as const).map((n) => (
              <Chip key={n} label={countLabel(n)} active={src.count === n} onClick={() => commit({ count: n })} />
            ))}
          </div>
          {heading('ai2.form.noSourcePhoto')}
          <div className="flex flex-wrap gap-1" data-testid="slot-no-source">
            {AI_NO_SOURCE_IMAGE_MODES.map((m) => (
              <Chip
                key={m}
                label={t(`ai2.noSource.${m}` as MessageKey)}
                active={src.whenNone === m}
                onClick={() => commit({ whenNone: m })}
              />
            ))}
          </div>
        </>
      ) : null}
      {ctx.accountId ? (
        // Style examples (round 3): other items' approved images, sent first as the style to follow.
        <div className="mt-1.5">
          <StyleExamplesSection
            accountId={ctx.accountId}
            boardId={ctx.itemBoardId ?? ctx.board.id}
            fileColumns={files}
            value={owner.style_examples as StyleExamplesValue | undefined}
            onChange={(style_examples) => onSet({ style_examples: style_examples ?? undefined })}
          />
        </div>
      ) : null}
      <ImageDesignOptions owner={owner} files={files} several={src.columns.length > 0} onSet={onSet} />
    </div>
  );
};

/**
 * generate_image, round 4, as the AI column's form: one image per photo or one from all (with
 * photos), variations per call, and how much may change (locked: the base column, else the newest style example).
 */
const ImageDesignOptions = ({
  owner,
  files,
  several,
  onSet,
}: {
  owner: Record<string, unknown>;
  files: { id: string; title: string }[];
  several: boolean;
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const heading = (k: MessageKey, testId?: string) => (
    <span className="px-1 pt-1.5 text-xs text-muted" data-testid={testId}>
      {t(k)}
    </span>
  );
  const photoMode = (owner.photo_mode as AiPhotoMode | undefined) ?? 'together';
  const variations = (owner.variations as number | undefined) ?? 1;
  const fidelity = (owner.fidelity as AiFidelity | undefined) ?? 'free';
  const base = owner.fidelity_base_column as string | undefined;
  return (
    <div className="flex flex-col gap-1" data-testid="slot-image-design">
      {several ? (
        <>
          {heading('ai2.form.photoMode')}
          <div className="flex flex-wrap gap-1" data-testid="slot-photo-mode">
            {AI_PHOTO_MODES.map((m) => (
              <Chip
                key={m}
                label={t(`ai2.photoMode.${m}` as MessageKey)}
                active={photoMode === m}
                onClick={() => onSet({ photo_mode: m })}
              />
            ))}
          </div>
        </>
      ) : null}
      {heading('ai2.form.variations')}
      <div className="flex flex-wrap gap-1" data-testid="slot-variations">
        {Array.from({ length: AI_VARIATIONS_MAX }, (_, i) => i + 1).map((n) => (
          <Chip
            key={n}
            label={String(n)}
            active={variations === n}
            onClick={() => onSet({ variations: n === 1 ? undefined : n })}
          />
        ))}
      </div>
      <span className="px-1 text-xs text-muted">{t('ai2.form.variationsHint')}</span>
      {heading('ai2.form.fidelity')}
      <div className="flex flex-wrap gap-1" data-testid="slot-fidelity">
        {AI_FIDELITY_MODES.map((m) => (
          <Chip
            key={m}
            label={t(`ai2.fidelity.${m}` as MessageKey)}
            active={fidelity === m}
            onClick={() =>
              onSet({
                fidelity: m === 'free' ? undefined : m,
                ...(m === 'locked' ? {} : { fidelity_base_column: undefined }),
              })
            }
          />
        ))}
      </div>
      {fidelity === 'locked' ? (
        <>
          {heading('ai2.form.fidelityBase')}
          <div className="flex flex-wrap gap-1" data-testid="slot-fidelity-base">
            <Chip
              label={t('ai2.form.fidelityBaseStyle')}
              active={!base}
              onClick={() => onSet({ fidelity_base_column: undefined })}
            />
            {files.map((c) => (
              <Chip
                key={c.id}
                label={c.title}
                active={base === c.id}
                onClick={() => onSet({ fidelity_base_column: c.id })}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
};

const NumberSlot = ({
  value,
  onChange,
  min,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
}) => {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const n = Number(text);
  const ok = text.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min);
  return (
    <div className="flex w-56 items-center gap-2">
      <Input
        autoFocus
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="slot-number"
      />
      <Button className="h-9 px-3" disabled={!ok} onClick={() => onChange(n)} data-testid="slot-apply">
        {t('common.save')}
      </Button>
    </div>
  );
};

/**
 * A date trigger's number of days and how they count: calendar days, or working days of the
 * account calendar (no weekend, holidays or days off) — `workdays` on the trigger.
 */
const DaysSlot = ({
  value,
  workdays,
  min,
  onChange,
}: {
  value: number | undefined;
  workdays: boolean;
  min?: number;
  onChange: (n: number, workdays: boolean) => void;
}) => {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const [unit, setUnit] = useState<'days' | 'workdays'>(workdays ? 'workdays' : 'days');
  const n = Number(text);
  const ok = text.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min);
  return (
    <div className="w-64 space-y-2" data-testid="slot-days">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          className="w-20"
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="slot-number"
        />
        <div className="w-36">
          <Picker
            label={t('auto.date.unit')}
            value={unit}
            onChange={setUnit}
            options={(['days', 'workdays'] as const).map((u) => ({ value: u, label: t(`filter.unit.${u}`) }))}
          />
        </div>
      </div>
      <Button
        className="h-9 px-3"
        disabled={!ok}
        onClick={() => onChange(Math.round(n), unit === 'workdays')}
        data-testid="slot-apply"
      >
        {t('common.save')}
      </Button>
    </div>
  );
};

/** `today | now | column:x` ± N h/d/wd/w/m [@HH:MM] (04 §4.2; wd = working days). */
const DateExprSlot = ({ value, ctx, onChange }: { value: string; ctx: Ctx; onChange: (v: string) => void }) => {
  const m = DATE_EXPR_RE.exec(value ?? '') ?? [];
  const parsed = m[2] ? dateExprShift(m[2]) : null;
  const [base, setBase] = useState(m[1] ?? 'today');
  const [shift, setShift] = useState(parsed ? String(parsed.n) : '0');
  const [unit, setUnit] = useState<string>(parsed?.unit ?? 'd');
  const [at, setAt] = useState(m[3]?.slice(1) ?? '');
  const dates = itemColumnsOf(ctx).filter((c) => c.type === 'date' || c.type === 'timeline');
  const n = Number(shift);
  const build = () =>
    `${base}${base !== 'clear' && n ? `${n > 0 ? '+' : ''}${n}${unit}` : ''}${base !== 'clear' && at ? `@${at}` : ''}`;
  return (
    <div className="w-72 space-y-2" data-testid="slot-date">
      <Picker
        label={t('auto.date.base')}
        value={base}
        onChange={setBase}
        options={[
          { value: 'today', label: t('auto.date.today') },
          { value: 'now', label: t('auto.date.now') },
          { value: 'clear', label: t('auto.date.clear') },
          ...dates.map((c) => ({ value: `column:${c.id}`, label: c.title })),
        ]}
      />
      {base !== 'clear' ? (
        <div className="flex items-center gap-2">
          <Input
            className="w-20"
            value={shift}
            onChange={(e) => setShift(e.target.value)}
            data-testid="slot-date-shift"
          />
          <div className="w-32">
            <Picker
              label={t('auto.date.unit')}
              value={unit}
              onChange={setUnit}
              options={(['h', 'd', 'wd', 'w', 'm'] as const).map((u) => ({
                value: u,
                label: t(`auto.date.unit.${u}` as MessageKey, { n: '' }).trim(),
              }))}
            />
          </div>
        </div>
      ) : null}
      {base !== 'clear' && base !== 'now' ? (
        <TimeField
          value={at || '09:00'}
          onChange={setAt}
          label={t('auto.date.at')}
          hourLabel={t('time.hours')}
          minuteLabel={t('time.minutes')}
        />
      ) : null}
      <Button size="sm" disabled={!Number.isFinite(n)} onClick={() => onChange(build())} data-testid="slot-apply">
        {t('common.save')}
      </Button>
    </div>
  );
};

/**
 * send_sms: one of the account's saved SMS texts (filled from the item when it runs), or a text of
 * its own with variables. Choosing one clears the other.
 */
const SmsMessageSlot = ({
  template,
  message,
  ctx,
  onSet,
}: {
  template: string | undefined;
  message: string;
  ctx: Ctx;
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const templates = ctx.smsTemplates ?? [];
  return (
    <div className="flex w-80 flex-col gap-2" data-testid="slot-sms">
      {templates.length ? (
        <div className="flex flex-col gap-1" data-testid="slot-sms-templates">
          <p className="text-xs font-semibold text-muted">{t('auto.sms.templates')}</p>
          {templates.map((x) => (
            <Chip
              key={x.id}
              label={x.name}
              active={x.id === template}
              onClick={() => onSet({ template: x.id, message: undefined })}
            />
          ))}
          <p className="pt-1 text-xs font-semibold text-muted">{t('auto.sms.ownText')}</p>
        </div>
      ) : null}
      <TextSlot
        multiline
        value={template ? '' : message}
        ctx={ctx}
        onChange={(x) => onSet({ message: x, template: undefined })}
      />
    </div>
  );
};

/**
 * r17ui: the columns of every item the run reaches — "item columns", "subitem columns", "parent
 * item columns"… — under their headers; picking one in another section switches the owner's type (`pickInSection`).
 */
/** A preview result as people read it: the value, or why there is none (and what `on_empty` then does). */
const previewText = (r: ComputedPreviewResult['samples'][number], onEmpty: string) =>
  r.ok
    ? t('auto.computed.preview_result' as MessageKey, { value: r.text ?? '' })
    : `${runReasonText(r.reason)} · ${t(`auto.computed.on_empty_opt.${onEmpty}` as MessageKey)}`;

/**
 * set_computed: the calculation, typed with column names (stored with keys), the columns it can read
 * in sections — the item's, its parent's, each linked item's — and a preview on items of the board.
 */
const ExpressionSlot = ({
  owner,
  ctx,
  onSet,
}: {
  owner: Record<string, unknown> & { type: string };
  ctx: Ctx;
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const env = ctx.computed?.env ?? { item: [] };
  const [text, setText] = useState(() => computedToNames((owner.expression as string | undefined) ?? '', env));
  const [preview, setPreview] = useState<ComputedPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const insert = (keyRef: string) => {
    setText((x) => `${x}${computedToNames(`{${keyRef}}`, env)}`);
    setPreview(null);
  };
  const onEmpty = (owner.on_empty as string | undefined) ?? 'skip';
  const runPreview = async () => {
    if (!ctx.computed || !text.trim()) return;
    setBusy(true);
    try {
      setPreview(
        await ctx.computed.preview({
          expression: computedToKeys(text, env),
          ...(typeof owner.column === 'string' ? { column: owner.column } : {}),
          ...(typeof owner.round === 'number' ? { round: owner.round } : {}),
        }),
      );
    } catch (e) {
      setPreview({ samples: [], error: { code: (e as Error).message } });
    } finally {
      setBusy(false);
    }
  };
  const section = (title: string, refs: { key: string; title: string }[], testId: string) =>
    refs.length ? (
      <div className="space-y-1" data-testid={testId}>
        <p className="px-1 text-[0.6875rem] font-semibold text-muted">{title}</p>
        <div className="flex flex-wrap gap-1">
          {refs.map((r) => (
            <button
              key={r.key}
              type="button"
              className="rounded-[8px] border border-line px-2 py-0.5 text-xs hover:border-primary"
              onClick={() => insert(r.key)}
            >
              {r.title}
            </button>
          ))}
        </div>
      </div>
    ) : null;
  const issueText = (code: string, detail?: string) =>
    hasMessage(`auto.issue.${code}`) ? t(`auto.issue.${code}` as MessageKey, { detail: detail ?? '' }) : code;
  return (
    <div className="w-96 space-y-2.5" data-testid="slot-expression">
      <p className="text-xs font-semibold">{t('auto.computed.title' as MessageKey)}</p>
      <textarea
        autoFocus
        dir="auto"
        className="min-h-20 w-full rounded-[10px] border border-line-strong bg-surface p-2.5 font-mono text-sm focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        data-testid="slot-text"
      />
      <p className="text-xs text-muted">{t('auto.computed.hint' as MessageKey)}</p>
      <div className="max-h-56 space-y-2 overflow-y-auto">
        {section(
          t('auto.computed.vars.item' as MessageKey),
          env.item.map((c) => ({ key: c.id, title: c.title })),
          'computed-vars-item',
        )}
        {section(
          t('auto.computed.vars.parent' as MessageKey),
          (env.parent ?? []).map((c) => ({ key: `${COMPUTED_PARENT}.${c.id}`, title: c.title })),
          'computed-vars-parent',
        )}
        {(env.relations ?? []).map((r) =>
          r.columns ? (
            <div key={r.id}>
              {section(
                t('auto.computed.vars.relation' as MessageKey, { relation: r.title }),
                r.columns.map((c) => ({ key: `${r.id}.${c.id}`, title: c.title })),
                `computed-vars-${r.id}`,
              )}
            </div>
          ) : (
            <p key={r.id} className="px-1 text-xs text-muted">
              {t('auto.computed.vars.relation' as MessageKey, { relation: r.title })}:{' '}
              {t('auto.computed.vars.loading' as MessageKey)}
            </p>
          ),
        )}
      </div>
      {ctx.computed ? (
        <div className="space-y-1 rounded-[10px] bg-surface-3 p-2" data-testid="computed-preview">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !text.trim()}
            onClick={() => void runPreview()}
            data-testid="computed-preview-run"
          >
            {t('auto.computed.preview' as MessageKey)}
          </Button>
          {preview?.error ? (
            <p className="text-xs text-danger-fg" data-testid="computed-preview-error">
              {t('auto.computed.preview_error' as MessageKey, {
                error: issueText(preview.error.code, preview.error.detail),
              })}
            </p>
          ) : preview && !preview.samples.length ? (
            <p className="text-xs text-muted">{t('auto.computed.preview_none' as MessageKey)}</p>
          ) : (
            preview?.samples.map((r) => (
              <p key={r.item_id} className="text-xs" data-testid="computed-preview-row">
                <span className="text-muted">{r.name}: </span>
                {previewText(r, onEmpty)}
              </p>
            ))
          )}
        </div>
      ) : null}
      <Button
        size="sm"
        disabled={!text.trim()}
        onClick={() => onSet({ expression: computedToKeys(text, env) })}
        data-testid="slot-apply"
      >
        {t('common.save')}
      </Button>
    </div>
  );
};

/** set_computed: rounding (digits after the point) and what an empty value does — saved on each pick. */
const ComputedOptionsSlot = ({
  owner,
  onSet,
}: {
  owner: Record<string, unknown>;
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const round = owner.round as number | undefined;
  const onEmpty = (owner.on_empty as string | undefined) ?? 'skip';
  return (
    <div className="w-72 space-y-3" data-testid="slot-computed-options">
      <div className="space-y-1">
        <p className="text-xs font-semibold">{t('auto.computed.round' as MessageKey)}</p>
        <div className="flex flex-col gap-1">
          <Chip
            label={t('auto.computed.round_none' as MessageKey)}
            active={round === undefined}
            onClick={() => onSet({ round: undefined })}
          />
          {[0, 1, 2, 3, 4].map((n) => (
            <Chip
              key={n}
              label={t('auto.computed.round_digits' as MessageKey, { n })}
              active={round === n}
              onClick={() => onSet({ round: n })}
            />
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-semibold">{t('auto.computed.on_empty' as MessageKey)}</p>
        <div className="flex flex-col gap-1">
          {COMPUTED_ON_EMPTY.map((m) => (
            <Chip
              key={m}
              label={t(`auto.computed.on_empty_opt.${m}` as MessageKey)}
              active={onEmpty === m}
              onClick={() => onSet({ on_empty: m === 'skip' ? undefined : m })}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const SectionedColumns = ({
  slot,
  sections,
  onSet,
}: {
  slot: SlotTarget;
  sections: ColumnSection<BoardDetail['columns'][number]>[];
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const rows = sections.flatMap((s) => s.columns.map((c) => ({ s, c })));
  // "when … changes" hears one column or more.
  const multi = slot.isTrigger && MULTI_COLUMN_TRIGGERS.has(slot.owner.type);
  const heard = triggerColumns(slot.owner as { column?: string; columns?: string[] });
  return (
    <>
      {multi ? <MultiColumnHint /> : null}
      <SearchableList
        items={rows}
        text={({ s, c }) => `${c.title} ${columnTypeLabel(c.type)} ${t(s.label as MessageKey)}`}
        className="w-64"
        testId="slot-search"
      >
        {(shown) => (
          <div className={PICK_LIST} data-testid="slot-columns" data-sectioned="">
            {shown.map(({ s, c }, i) => (
              <div key={`${s.scope}:${c.id}`} className="flex flex-col gap-1">
                {i === 0 || shown[i - 1]!.s !== s ? (
                  <p
                    className="px-1 pt-1.5 text-[0.6875rem] font-semibold text-muted"
                    data-testid="slot-col-section"
                    data-scope={s.scope}
                  >
                    {t(s.label as MessageKey)}
                  </p>
                ) : null}
                {multi ? (
                  <CheckRow
                    checked={s.type === slot.owner.type && heard.includes(c.id)}
                    onToggle={() => onSet(toggleTriggerColumn(slot.owner, s, c.id))}
                    testId="slot-option"
                  >
                    {c.title}
                  </CheckRow>
                ) : (
                  <Chip
                    label={c.title}
                    active={c.id === slot.owner.column && s.type === slot.owner.type}
                    onClick={() => onSet(pickInSection(slot.owner, s, c.id))}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </SearchableList>
    </>
  );
};

const MultiColumnHint = () => (
  <p className="mb-1.5 w-64 text-xs text-muted" data-testid="slot-multi-columns">
    {t('auto.trigger.more_columns' as MessageKey)}
  </p>
);

export const SlotEditor = ({
  slot,
  ctx,
  onSet,
}: {
  slot: SlotTarget;
  ctx: Ctx;
  /** Writes fields of the owner (trigger or action); several at once for coupled fields. */
  onSet: (patch: Record<string, unknown>) => void;
}) => {
  const { owner, field } = slot;
  const v = owner[field];
  // r18board 5: people blanks read the run item — a subitem trigger's are the sub-board's people columns.
  const peopleColumns = (ctx.columnsOf?.(slot, 'column') ?? itemColumnsOf(ctx)).filter((c) => c.type === 'people');

  // Whose timer: who made the change, a people column, a fixed person, the owner (unset), everyone.
  // r16name: a title and labelled sections (people columns / a fixed person) so the choice reads clearly.
  if (TIMER_ACTIONS.has(owner.type) && (field === 'who' || field === 'fallback')) {
    type Opt = { value: string; label: string; group: 'special' | 'column' | 'parent_column' | 'person' };
    const columnOpts: Opt[] = [
      ...peopleColumns.map((c): Opt => ({ value: `column:${c.id}`, label: c.title, group: 'column' })),
      // notifyfix: a subitem run's parent people columns (the engine reads the parent's cell).
      ...(ctx.parentColumns ?? [])
        .filter((c) => c.type === 'people' && !peopleColumns.some((x) => x.id === c.id))
        .map((c): Opt => ({ value: `column:${c.id}`, label: c.title, group: 'parent_column' })),
    ];
    const opts: Opt[] =
      field === 'fallback'
        ? [{ value: '', label: t('auto.timer.skip'), group: 'special' }, ...columnOpts]
        : [
            { value: '@actor', label: t('auto.who.actor'), group: 'special' },
            ...columnOpts,
            ...ctx.members
              .filter((m) => m.status === 'active')
              .map((m): Opt => ({ value: `user:${m.user_id}`, label: m.name || m.email, group: 'person' })),
            { value: '@automation_owner', label: t('auto.who.automation_owner'), group: 'special' },
            ...(owner.type === 'stop_time_tracking'
              ? [{ value: '@all', label: t('auto.who.all'), group: 'special' } as Opt]
              : []),
          ];
    const current = v ?? (field === 'who' ? '@automation_owner' : '');
    const heading = (k: string) => (
      <span className="px-1 pt-1.5 text-xs font-semibold text-muted">{t(k as MessageKey)}</span>
    );
    const choose = (o: Opt) =>
      onSet(
        field === 'fallback'
          ? { fallback: o.value || undefined }
          : { who: o.value, ...(o.value === '@actor' ? {} : { fallback: undefined }) },
      );
    const chip = (o: Opt) => (
      <Chip key={o.value} label={o.label} active={o.value === current} onClick={() => choose(o)} />
    );
    return (
      <div className="flex w-64 flex-col gap-1.5" data-testid={`slot-timer-${field}-editor`}>
        <span className="text-sm font-semibold">
          {t((field === 'who' ? 'auto.timer.who_title' : 'auto.timer.fallback_title') as MessageKey)}
        </span>
        <SearchableList items={opts} text={(o) => o.label} testId="slot-search">
          {(shown) => {
            const special = shown.filter(
              (o) => o.group === 'special' && o.value !== '@automation_owner' && o.value !== '@all',
            );
            const tail = shown.filter((o) => o.value === '@automation_owner' || o.value === '@all');
            const cols = shown.filter((o) => o.group === 'column');
            const parentCols = shown.filter((o) => o.group === 'parent_column');
            const people = shown.filter((o) => o.group === 'person');
            return (
              <div className="flex max-h-72 flex-col gap-1 overflow-y-auto" data-testid={`slot-timer-${field}`}>
                {special.map(chip)}
                {cols.length ? (
                  <>
                    {heading('auto.timer.people_column')}
                    {cols.map(chip)}
                  </>
                ) : null}
                {parentCols.length ? (
                  <>
                    <p
                      className="px-1 pt-1.5 text-[0.6875rem] font-semibold text-muted"
                      data-testid="slot-parent-col-section"
                    >
                      {ctx.parentColumnsLabel}
                    </p>
                    {parentCols.map(chip)}
                  </>
                ) : null}
                {people.length ? (
                  <>
                    {heading('auto.timer.person')}
                    {people.map(chip)}
                  </>
                ) : null}
                {tail.length ? (
                  <>
                    {heading('auto.timer.other')}
                    {tail.map(chip)}
                  </>
                ) : null}
              </div>
            );
          }}
        </SearchableList>
      </div>
    );
  }

  // a flow trigger's connection / flow (the account's flow connections).
  if (slot.isTrigger && isFlowTrigger(owner.type) && (field === 'connection' || field === 'flow'))
    return <FlowTriggerSlot owner={owner} field={field} onSet={onSet} />;

  switch (field) {
    case 'column': {
      const sections = ctx.columnSections?.(slot);
      if (sections && sections.length > 1) return <SectionedColumns slot={slot} sections={sections} onSet={onSet} />;
      // "when a file is added" may hear any file column of the board.
      const anyColumn = slot.isTrigger && owner.type === 'file_added';
      // "when … changes" hears one column or more (checks).
      const multi = slot.isTrigger && MULTI_COLUMN_TRIGGERS.has(owner.type);
      const heard = triggerColumns(owner as { column?: string; columns?: string[] });
      return (
        <>
          {multi ? <MultiColumnHint /> : null}
          <SearchableList
            items={columnsFor(ctx, slot)}
            text={(c) => `${c.title} ${columnTypeLabel(c.type)}`}
            className="w-64"
            testId="slot-search"
          >
            {(shown) => (
              <div className={PICK_LIST} data-testid="slot-columns">
                {anyColumn ? (
                  <Chip
                    label={t('auto.word.any_file_column')}
                    active={!v}
                    onClick={() => onSet({ column: undefined })}
                  />
                ) : null}
                {shown.map((c) =>
                  multi ? (
                    <CheckRow
                      key={c.id}
                      checked={heard.includes(c.id)}
                      onToggle={() => onSet(toggleTriggerColumn(owner, owner, c.id))}
                      testId="slot-option"
                    >
                      {c.title}
                    </CheckRow>
                  ) : (
                    <Chip key={c.id} label={c.title} active={c.id === v} onClick={() => onSet({ column: c.id })} />
                  ),
                )}
              </div>
            )}
          </SearchableList>
        </>
      );
    }
    case 'source_columns':
      return <ImageSourcesSlot owner={owner} ctx={ctx} onSet={onSet} />;
    case 'expression':
      return <ExpressionSlot owner={owner} ctx={ctx} onSet={onSet} />;
    case 'on_empty':
      return <ComputedOptionsSlot owner={owner} onSet={onSet} />;
    case 'labels': {
      const all = labelsOf(ctx, owner.column, slot);
      const chosen = Array.isArray(v) ? (v as string[]) : [];
      return (
        <div className="w-64 space-y-1" data-testid="slot-labels">
          <CheckRow checked={v === 'any'} onToggle={() => onSet({ labels: v === 'any' ? [] : 'any' })}>
            {t('auto.word.anything')}
          </CheckRow>
          <SearchableList items={all} text={(l) => l.label} testId="slot-search">
            {(shown) => (
              <div className="max-h-72 overflow-y-auto">
                {shown.map((l) => (
                  <CheckRow
                    key={l.id}
                    checked={chosen.includes(l.label)}
                    onToggle={() =>
                      onSet({
                        labels: chosen.includes(l.label) ? chosen.filter((x) => x !== l.label) : [...chosen, l.label],
                      })
                    }
                  >
                    <LabelTag color={l.color} className="h-5">
                      {l.label || '—'}
                    </LabelTag>
                  </CheckRow>
                ))}
              </div>
            )}
          </SearchableList>
          {!all.length ? <p className="text-xs text-muted">{t('auto.pick_column_first')}</p> : null}
        </div>
      );
    }
    case 'label':
      return (
        <SearchableList
          items={labelsOf(ctx, owner.column, slot)}
          text={(l) => l.label}
          className="w-56"
          testId="slot-search"
        >
          {(shown) => (
            <div className={PICK_LIST} data-testid="slot-labels">
              {shown.map((l) => (
                <Chip
                  key={l.id}
                  label={l.label || '—'}
                  color={l.color}
                  active={l.label === v}
                  onClick={() => onSet({ label: l.label })}
                />
              ))}
            </div>
          )}
        </SearchableList>
      );
    case 'group': {
      const opts = [
        ...(owner.type === 'item_moved_to_group' ? [{ id: 'any', title: t('auto.group.any') }] : []),
        ...(!slot.isTrigger && owner.type === 'move_to_group'
          ? [
              { id: '@top', title: t('auto.group.top') },
              { id: '@bottom', title: t('auto.group.bottom') },
            ]
          : []),
        ...ctx.board.groups.map((g) => ({ id: g.id, title: g.title })),
      ];
      return (
        <SearchableList items={opts} text={(g) => g.title} className="w-56" testId="slot-search">
          {(shown) => (
            <div className={PICK_LIST} data-testid="slot-groups">
              {shown.map((g) => (
                <Chip key={g.id} label={g.title} active={g.id === v} onClick={() => onSet({ group: g.id })} />
              ))}
            </div>
          )}
        </SearchableList>
      );
    }
    case 'board':
      return (
        <SearchableList
          items={[{ id: '@self', name: t('auto.word.this_board') }, ...ctx.boards.filter((b) => b.id !== ctx.board.id)]}
          text={(b) => b.name}
          className="w-64"
          testId="slot-search"
        >
          {(shown) => (
            <div className={PICK_LIST} data-testid="slot-boards">
              {shown.map((b) => (
                <Chip
                  key={b.id}
                  label={b.name}
                  active={b.id === v}
                  onClick={() =>
                    onSet(
                      owner.type === 'create_item_from_template'
                        ? // Another board has its own templates, groups and columns.
                          {
                            board: b.id,
                            template: undefined,
                            group: undefined,
                            variables: undefined,
                            connect_back_column: undefined,
                          }
                        : { board: b.id, group: undefined, mapping: undefined },
                    )
                  }
                />
              ))}
            </div>
          )}
        </SearchableList>
      );
    case 'who':
    case 'to': {
      const email = owner.type === 'send_email';
      type Opt = { value: string; label: string; group: 'special' | 'column' | 'parent_column' | 'person' };
      const opts: Opt[] = [
        ...(owner.type === 'person_assigned'
          ? [{ value: 'any', label: t('auto.who.any'), group: 'special' as const }]
          : []),
        ...PEOPLE_SPECIAL.filter((p) => p !== '@mentions').map((p) => ({
          value: p,
          label: t(`auto.who.${p.slice(1)}` as MessageKey),
          group: 'special' as const,
        })),
        ...peopleColumns.map((c) => ({ value: `column:${c.id}`, label: c.title, group: 'column' as const })),
        ...(email
          ? itemColumnsOf(ctx)
              .filter((c) => c.type === 'email')
              .map((c) => ({ value: `column:${c.id}`, label: c.title, group: 'column' as const }))
          : []),
        // notifyfix: the parent item's people (and, for e-mail, e-mail) columns — keys the item list doesn't have.
        ...(ctx.parentColumns ?? [])
          .filter((c) => c.type === 'people' || (email && c.type === 'email'))
          .filter((c) => !itemColumnsOf(ctx).some((x) => x.id === c.id))
          .map((c) => ({ value: `column:${c.id}`, label: c.title, group: 'parent_column' as const })),
        ...ctx.members
          .filter((m) => m.status === 'active')
          .map((m) => ({ value: `user:${m.user_id}`, label: m.name || m.email, group: 'person' as const })),
      ];
      const chip = (o: Opt) => (
        <Chip key={o.value} label={o.label} active={o.value === v} onClick={() => onSet({ [field]: o.value })} />
      );
      return (
        <SearchableList items={opts} text={(o) => o.label} className="w-64" testId="slot-search">
          {(shown) => {
            const cols = shown.filter((o) => o.group === 'column');
            const parentCols = shown.filter((o) => o.group === 'parent_column');
            const people = shown.filter((o) => o.group === 'person');
            return (
              <div className={PICK_LIST} data-testid="slot-people">
                {shown.filter((o) => o.group === 'special').map(chip)}
                {cols.length ? (
                  <>
                    {/* r18board 5: which item's columns these are (a subitem trigger reads the subitem's). */}
                    <p className="px-1 pt-1.5 text-[0.6875rem] font-semibold text-muted" data-testid="slot-col-section">
                      {ctx.itemColumnsLabel ?? t('auto.cols.item')}
                    </p>
                    {cols.map(chip)}
                  </>
                ) : null}
                {parentCols.length ? (
                  <>
                    <p
                      className="px-1 pt-1.5 text-[0.6875rem] font-semibold text-muted"
                      data-testid="slot-parent-col-section"
                    >
                      {ctx.parentColumnsLabel}
                    </p>
                    {parentCols.map(chip)}
                  </>
                ) : null}
                {people.length ? (
                  <>
                    <p className="px-1 pt-1.5 text-[0.6875rem] font-semibold text-muted">{t('auto.timer.person')}</p>
                    {people.map(chip)}
                  </>
                ) : null}
              </div>
            );
          }}
        </SearchableList>
      );
    }
    case 'time':
      return (
        <div className="w-56 p-1">
          <TimeField
            value={typeof v === 'string' ? v : '09:00'}
            onChange={(x) => onSet({ time: x })}
            label={t('auto.blank.time')}
            hourLabel={t('time.hours')}
            minuteLabel={t('time.minutes')}
          />
        </div>
      );
    case 'days':
    case 'offset_days':
      return (
        <DaysSlot
          value={v as number | undefined}
          workdays={owner.workdays === true}
          min={field === 'days' ? 1 : undefined}
          onChange={(n, workdays) => onSet({ [field]: n, workdays: workdays || undefined })}
        />
      );
    case 'by':
      return <NumberSlot value={v as number | undefined} onChange={(n) => onSet({ [field]: n })} />;
    case 'period':
      return (
        <div className="w-64 space-y-2" data-testid="slot-period">
          <Picker
            label={t('auto.blank.period')}
            value={(owner.period as string) ?? 'day'}
            onChange={(p) => onSet({ period: p })}
            options={(['hour', 'day', 'week', 'month'] as const).map((p) => ({
              value: p,
              label: t(
                p === 'week'
                  ? 'auto.period.week'
                  : p === 'month'
                    ? 'auto.period.month'
                    : (`auto.period.${p}` as MessageKey),
              ),
            }))}
          />
          {owner.period === 'week' ? (
            <Picker
              label={t('auto.period.weekday')}
              value={(owner.weekday as string) ?? 'sun'}
              onChange={(d) => onSet({ weekday: d })}
              options={WEEKDAYS.map((d) => ({ value: d, label: t(`auto.weekday.${d}` as MessageKey) }))}
            />
          ) : null}
          {owner.period === 'month' ? (
            <Picker
              label={t('auto.period.day_of_month')}
              value={String(owner.day_of_month ?? 1)}
              onChange={(d) => onSet({ day_of_month: Number(d) })}
              options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
            />
          ) : null}
        </div>
      );
    case 'state':
      return (
        <div className="flex w-48 flex-col gap-1">
          {(['checked', 'unchecked'] as const).map((s) => (
            <Chip key={s} label={t(`auto.checkbox.${s}`)} active={v === s} onClick={() => onSet({ state: s })} />
          ))}
        </div>
      );
    case 'operator':
      return (
        <div className="flex w-56 flex-col gap-1">
          {(['greater_than', 'greater_than_or_equal', 'lower_than', 'lower_than_or_equal'] as const).map((o) => (
            <Chip key={o} label={t(`auto.op.${o}`)} active={v === o} onClick={() => onSet({ operator: o })} />
          ))}
        </div>
      );
    case 'value':
      if (owner.type === 'set_date')
        return <DateExprSlot value={(v as string) ?? 'today'} ctx={ctx} onChange={(x) => onSet({ value: x })} />;
      if (owner.type === 'number_threshold')
        return <NumberSlot value={v as number | undefined} onChange={(n) => onSet({ value: n })} />;
      return <TextSlot value={typeof v === 'string' ? v : ''} ctx={ctx} onChange={(x) => onSet({ value: x })} />;
    case 'channel':
      // "Send to integrations": the channel an n8n / Make trigger may listen to (empty = every trigger).
      return <TextSlot value={(v as string) ?? ''} ctx={ctx} onChange={(x) => onSet({ channel: x })} />;
    case 'message':
      if (owner.type === 'send_sms')
        return (
          <SmsMessageSlot
            template={typeof owner.template === 'string' ? owner.template : undefined}
            message={typeof v === 'string' ? v : ''}
            ctx={ctx}
            onSet={onSet}
          />
        );
      return <TextSlot multiline value={(v as string) ?? ''} ctx={ctx} onChange={(x) => onSet({ [field]: x })} />;
    case 'body':
    case 'body_html':
    case 'prompt':
      return (
        <TextSlot
          multiline
          value={(v as string) ?? ''}
          ctx={ctx}
          onChange={(x) => onSet({ [field]: x })}
          {...(owner.type === 'generate_image' && field === 'prompt' ? { hint: t('auto.image.prompt_hint') } : {})}
        />
      );
    case 'template':
      if (owner.type === 'create_item_from_template' || owner.type === 'add_template_subitems') {
        const list = ctx.itemTemplatesOf?.(owner) ?? [];
        // A template picked: its questions are answered from the item's fitting columns at first (a proposal).
        const pick = (x: ItemTemplateSummary) => {
          const sources = proposeItemTemplateSources(
            x.variables,
            itemColumnsOf(ctx).map((c) => ({ key: c.id, type: c.type })),
          );
          onSet({ template: x.id, variables: Object.keys(sources).length ? sources : undefined });
        };
        return (
          <SearchableList items={list} text={(x) => `${x.name} ${x.category}`} className="w-64" testId="slot-search">
            {(shown) => (
              <div className={PICK_LIST} data-testid="slot-item-templates">
                {shown.map((x) => (
                  <Chip key={x.id} label={x.name} active={x.id === v} onClick={() => pick(x)} />
                ))}
                {!list.length ? <p className="text-xs text-muted">{t('auto.itemTemplate.none')}</p> : null}
              </div>
            )}
          </SearchableList>
        );
      }
      if (owner.type !== 'send_document')
        return <TextSlot value={(v as string) ?? ''} ctx={ctx} onChange={(x) => onSet({ [field]: x })} />;
      return (
        <SearchableList items={ctx.idocTemplates ?? []} text={(a) => a.name} className="w-64" testId="slot-search">
          {(shown) => (
            <div className={PICK_LIST} data-testid="slot-idoc-templates">
              {shown.map((a) => (
                <Chip key={a.id} label={a.name} active={a.id === v} onClick={() => onSet({ template: a.id })} />
              ))}
              {!(ctx.idocTemplates ?? []).length ? <p className="text-xs text-muted">{t('auto.idoc.none')}</p> : null}
            </div>
          )}
        </SearchableList>
      );
    case 'agent':
      return (
        <SearchableList items={ctx.agents ?? []} text={(a) => a.name} className="w-64" testId="slot-search">
          {(shown) => (
            <div className={PICK_LIST} data-testid="slot-agents">
              {shown.map((a) => (
                <Chip key={a.id} label={a.name} active={a.id === v} onClick={() => onSet({ agent: a.id })} />
              ))}
              {!(ctx.agents ?? []).length ? <p className="text-xs text-muted">{t('auto.agent.none')}</p> : null}
            </div>
          )}
        </SearchableList>
      );
    case 'relation':
      return (
        <div className="flex w-64 flex-col gap-1" data-testid="slot-columns">
          {itemColumnsOf(ctx)
            .filter((c) => c.type === 'board_relation')
            .map((c) => (
              <Chip key={c.id} label={c.title} active={c.id === v} onClick={() => onSet({ relation: c.id })} />
            ))}
        </div>
      );
    case 'level':
      // D14: which items of the sub-board a subitem trigger hears.
      return (
        <div className="flex w-56 flex-col gap-1" data-testid="slot-level">
          {SUB_LEVELS.map((l) => (
            <Chip
              key={l}
              label={t(`auto.level.${l}` as MessageKey)}
              active={(v ?? 'any') === l}
              onClick={() => onSet({ level: l === 'any' ? undefined : l })}
            />
          ))}
        </div>
      );
    case 'source': {
      // Copy from / to the parent or the subitems (D14): the other item's columns, or the name.
      const own = ctx.columnsOf?.(slot, 'source');
      const cols = own ?? ctx.linkedColumns?.(owner.relation);
      if (!own && !owner.relation) return <p className="w-56 text-xs text-muted">{t('auto.pick_column_first')}</p>;
      return (
        <SearchableList
          items={[
            { id: 'name', title: t('auto.word.name'), type: 'name' },
            ...(cols ?? []).filter((c) => c.type !== 'name'),
          ]}
          text={(c) => `${c.title} ${columnTypeLabel(c.type)}`}
          className="w-64"
          testId="slot-search"
        >
          {(shown) => (
            <div className={PICK_LIST} data-testid="slot-columns">
              {shown.map((c) => (
                <Chip key={c.id} label={c.title} active={c.id === v} onClick={() => onSet({ source: c.id })} />
              ))}
            </div>
          )}
        </SearchableList>
      );
    }
    default:
      // name, subject, url, contains, block
      return (
        <TextSlot
          value={(v as string) ?? ''}
          ctx={ctx}
          onChange={(x) => onSet({ [field]: field === 'contains' && !x.trim() ? undefined : x })}
        />
      );
  }
};

export type { DraftRecipe };
