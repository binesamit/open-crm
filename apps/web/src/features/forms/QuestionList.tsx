// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FILE_KINDS,
  formFileLimitsSchema,
  formHiddenOnly,
  formInputOf,
  formQuestionAllowed,
  formUnsupportedReason,
  hasMessage,
  newQuestionId,
  t,
  type BoardDetail,
  type Column,
  type FormAccess,
  type FormQuestion,
  type MessageKey,
  type PublicQuestion,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, cn, Field, Input, Menu, Picker, Switch, useActionMenu } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { HiddenValueEditor } from './HiddenValueEditor';

/** Editor texts (the person's UI language). */
const typeName = (type: string) => {
  const key = `columnType.${type}`;
  return hasMessage(key) ? t(key) : type;
};

type Labels = { labels?: { id: number; label: string; color?: string; index?: number; is_deactivated?: boolean }[] };

/** How a question looks on the page — for the default-value and condition inputs here. */
export const previewQuestion = (q: FormQuestion, column: Column): PublicQuestion => {
  const input = formInputOf(column.type)!;
  const labels = ((column.settings as Labels).labels ?? []).filter((l) => !l.is_deactivated && l.label.trim());
  return {
    id: q.id,
    input,
    label: q.label || column.title,
    help: q.help,
    required: q.required,
    condition: q.condition,
    ...(input === 'choice' || input === 'multi_choice'
      ? { choices: labels.map((l) => ({ value: l.id, label: l.label, ...(l.color ? { color: l.color } : {}) })) }
      : {}),
    ...(input === 'multi_choice' ? { multiple: true } : {}),
    ...(input === 'rating' ? { rating_max: (column.settings as { max?: number }).max ?? 5 } : {}),
  };
};

/**
 * The questions of a form (M11): which board columns are asked, in what order (drag), each with its label, help
 * text, required / hidden-with-default and one "show only if" condition; file questions with their limits.
 */
export const QuestionList = ({
  accountId,
  board,
  formUrl,
  questions,
  columns,
  access,
  disabled,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  /** The form's public link (the example link of a value taken from the link). */
  formUrl: string;
  questions: FormQuestion[];
  columns: Column[];
  access: FormAccess;
  disabled: boolean;
  onChange: (next: FormQuestion[]) => void;
}) => {
  const byKey = new Map(columns.map((c) => [c.id, c]));
  const used = new Set(questions.map((q) => q.column_key));
  const available = columns.filter((c) => !used.has(c.id) && formQuestionAllowed(c.type));
  const unavailable = columns.filter((c) => !formQuestionAllowed(c.type));
  const [open, setOpen] = useState<string | null>(null);
  const add = useActionMenu();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = questions.findIndex((q) => q.id === active.id);
    const to = questions.findIndex((q) => q.id === over.id);
    const moved = arrayMove(questions, from, to);
    // A condition must point at an earlier question: one that now comes later loses its condition.
    const seen = new Set<string>();
    onChange(
      moved.map((q) => {
        const keep = !q.condition || seen.has(q.condition.question_id);
        seen.add(q.id);
        return keep ? q : { ...q, condition: null };
      }),
    );
  };
  const update = (id: string, patch: Partial<FormQuestion>) =>
    onChange(questions.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const remove = (id: string) =>
    onChange(
      questions
        .filter((q) => q.id !== id)
        .map((q) => (q.condition?.question_id === id ? { ...q, condition: null } : q)),
    );
  const addColumn = (c: Column) => {
    const q: FormQuestion = {
      id: newQuestionId(),
      column_key: c.id,
      label: '',
      help: '',
      required: false,
      hidden: false,
      condition: null,
      ...(formInputOf(c.type) === 'files' ? { files: formFileLimitsSchema.parse({}) } : {}),
      // Connect boards is a hidden question: the new item is linked to an item picked here.
      ...(formHiddenOnly(c.type) ? { hidden: true, hidden_source: 'item' as const, hidden_item: null } : {}),
    };
    onChange([...questions, q]);
    setOpen(q.id);
  };

  return (
    <section className="space-y-3" data-testid="form-questions">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-heading">{t('forms.editor.questions')}</h3>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || !available.length}
          onClick={add.fromTrigger}
          data-testid="form-add-question"
        >
          <Icon name="plus" size={14} />
          {t('forms.editor.addQuestion')}
        </Button>
        <Menu
          at={add.at}
          onClose={add.close}
          label={t('forms.editor.addQuestion')}
          items={available.map((c) => ({
            label: `${c.title} · ${typeName(c.type)}`,
            testId: `form-add-column-${c.id}`,
            onSelect: () => addColumn(c),
          }))}
        />
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={questions.map((q) => q.id)} strategy={verticalListSortingStrategy}>
          <ol className="space-y-2">
            {questions.map((q, i) => {
              const column = byKey.get(q.column_key);
              return (
                <QuestionRow
                  key={q.id}
                  accountId={accountId}
                  board={board}
                  formUrl={formUrl}
                  q={q}
                  column={column}
                  earlier={questions.slice(0, i).filter((x) => !x.hidden && byKey.has(x.column_key))}
                  columns={byKey}
                  access={access}
                  open={open === q.id}
                  disabled={disabled}
                  onToggle={() => setOpen((o) => (o === q.id ? null : q.id))}
                  onChange={(patch) => update(q.id, patch)}
                  onRemove={() => remove(q.id)}
                />
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
      {unavailable.length ? (
        <details className="rounded-[var(--radius)] bg-surface-3 px-3 py-2 text-xs text-muted">
          <summary className="cursor-pointer font-semibold">
            {t('forms.editor.unavailable', { n: unavailable.length })}
          </summary>
          <ul className="mt-2 space-y-1" data-testid="form-unavailable">
            {unavailable.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {c.title} · {typeName(c.type)}
                </span>
                <span>{tDynamic(`forms.editor.reason.${formUnsupportedReason(c.type)}`)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
};

const QuestionRow = ({
  accountId,
  board,
  formUrl,
  q,
  column,
  earlier,
  columns,
  access,
  open,
  disabled,
  onToggle,
  onChange,
  onRemove,
}: {
  accountId: string;
  board: BoardDetail;
  formUrl: string;
  q: FormQuestion;
  column: Column | undefined;
  earlier: FormQuestion[];
  columns: Map<string, Column>;
  access: FormAccess;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<FormQuestion>) => void;
  onRemove: () => void;
}) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: q.id,
    disabled,
  });
  const input = column ? formInputOf(column.type) : null;
  const isName = column?.type === 'name';
  const preview = column && input ? previewQuestion(q, column) : null;
  // Uploads come from the person; connect boards is always hidden (its switch is locked on).
  const hiddenOnly = column ? formHiddenOnly(column.type) : false;
  // Uploads and secrets come only from the person filling the form.
  const canHide = input !== 'files' && input !== 'secret' && !hiddenOnly;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded-[var(--radius)] border border-line bg-surface',
        isDragging && 'relative z-10 shadow-[var(--shadow-pop)]',
      )}
      data-testid="form-question"
      data-column={q.column_key}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={disabled}
          aria-label={t('forms.editor.drag')}
          title={t('forms.editor.drag')}
          className="cursor-grab px-1 text-muted hover:text-fg active:cursor-grabbing disabled:cursor-default"
        >
          ⋮⋮
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-start">
          <span className="truncate text-sm font-semibold text-fg">{q.label || column?.title || q.column_key}</span>
          {q.required ? <span className="text-danger-fg">*</span> : null}
          <span className="truncate text-xs text-muted">
            {column ? typeName(column.type) : t('forms.editor.columnGone')}
          </span>
          {q.hidden ? <Badge>{t('forms.editor.hiddenBadge')}</Badge> : null}
          {q.condition ? <Badge tone="info">{t('forms.editor.conditionBadge')}</Badge> : null}
          {input === 'people' && access === 'public' && !q.hidden ? (
            <Badge tone="warn">{t('forms.editor.membersOnlyBadge')}</Badge>
          ) : null}
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={t('forms.editor.edit')}
          title={t('forms.editor.edit')}
          className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-2"
          data-testid="form-question-toggle"
        >
          <Icon name={open ? 'collapse' : 'expand'} size={15} />
        </button>
        {!isName ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label={t('forms.editor.remove')}
            title={t('forms.editor.remove')}
            className="grid size-8 place-items-center rounded-full text-muted hover:bg-danger-soft hover:text-danger-fg disabled:opacity-40"
            data-testid="form-question-remove"
          >
            <Icon name="trash" size={14} />
          </button>
        ) : null}
      </div>
      {open && column ? (
        <div className="space-y-3 border-t border-line-soft px-3 py-3">
          <Field label={t('forms.editor.label')} hint={t('forms.editor.labelHint', { title: column.title })}>
            <Input
              value={q.label}
              maxLength={200}
              placeholder={column.title}
              disabled={disabled}
              onChange={(e) => onChange({ label: e.target.value })}
              data-testid="form-question-label"
            />
          </Field>
          <Field label={t('forms.editor.help')}>
            <textarea
              value={q.help}
              maxLength={1000}
              rows={2}
              disabled={disabled}
              onChange={(e) => onChange({ help: e.target.value })}
              className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Switch
                checked={q.required}
                disabled={disabled || q.hidden}
                onChange={(on) => onChange({ required: on })}
                testId="form-question-required"
              />
              {t('forms.editor.required')}
            </label>
            {canHide ? (
              <label className="flex items-center gap-2">
                <Switch
                  checked={q.hidden}
                  disabled={disabled}
                  onChange={(on) => onChange({ hidden: on, ...(on ? { required: false, condition: null } : {}) })}
                  testId="form-question-hidden"
                />
                {t('forms.editor.hidden')}
              </label>
            ) : null}
          </div>
          {q.hidden ? (
            <HiddenValueEditor
              accountId={accountId}
              board={board}
              formUrl={formUrl}
              q={q}
              column={column}
              preview={preview}
              disabled={disabled}
              onChange={onChange}
            />
          ) : (
            <ConditionEditor q={q} earlier={earlier} columns={columns} disabled={disabled} onChange={onChange} />
          )}
          {input === 'files' ? <FileLimitsEditor q={q} disabled={disabled} onChange={onChange} /> : null}
        </div>
      ) : null}
    </li>
  );
};

/** "Show only if <earlier question> is <value>" — one condition per question. */
const ConditionEditor = ({
  q,
  earlier,
  columns,
  disabled,
  onChange,
}: {
  q: FormQuestion;
  earlier: FormQuestion[];
  columns: Map<string, Column>;
  disabled: boolean;
  onChange: (patch: Partial<FormQuestion>) => void;
}) => {
  const target = earlier.find((x) => x.id === q.condition?.question_id);
  const targetColumn = target ? columns.get(target.column_key) : undefined;
  const targetPreview = target && targetColumn ? previewQuestion(target, targetColumn) : null;
  const NONE = '__none__';
  return (
    <div className="space-y-2 rounded-[10px] bg-surface-3 p-2.5" data-testid="form-condition">
      <span className="block text-xs font-semibold text-fg-2">{t('forms.editor.condition')}</span>
      <Picker
        label={t('forms.editor.condition')}
        value={q.condition?.question_id ?? NONE}
        options={[
          { value: NONE, label: t('forms.editor.always') },
          ...earlier.map((x) => ({
            value: x.id,
            label: x.label || columns.get(x.column_key)?.title || x.column_key,
          })),
        ]}
        onChange={(id) =>
          onChange({
            condition:
              id === NONE
                ? null
                : { question_id: id, equals: q.condition?.question_id === id ? q.condition.equals : '' },
          })
        }
        testId="form-condition-question"
      />
      {q.condition && targetPreview ? (
        targetPreview.input === 'choice' || targetPreview.input === 'multi_choice' ? (
          <Picker
            label={t('forms.editor.equals')}
            value={String(q.condition.equals)}
            placeholder={t('forms.editor.equals')}
            options={(targetPreview.choices ?? []).map((c) => ({ value: String(c.value), label: c.label }))}
            onChange={(v) => onChange({ condition: { question_id: q.condition!.question_id, equals: Number(v) } })}
            testId="form-condition-value"
          />
        ) : targetPreview.input === 'checkbox' ? (
          <Picker
            label={t('forms.editor.equals')}
            value={q.condition.equals === true ? 'yes' : 'no'}
            options={[
              { value: 'yes', label: t('forms.editor.checked') },
              { value: 'no', label: t('forms.editor.unchecked') },
            ]}
            onChange={(v) => onChange({ condition: { question_id: q.condition!.question_id, equals: v === 'yes' } })}
            testId="form-condition-value"
          />
        ) : (
          <Input
            value={String(q.condition.equals)}
            maxLength={500}
            disabled={disabled}
            placeholder={t('forms.editor.equals')}
            onChange={(e) => onChange({ condition: { question_id: q.condition!.question_id, equals: e.target.value } })}
            data-testid="form-condition-value"
          />
        )
      ) : null}
    </div>
  );
};

const FileLimitsEditor = ({
  q,
  disabled,
  onChange,
}: {
  q: FormQuestion;
  disabled: boolean;
  onChange: (patch: Partial<FormQuestion>) => void;
}) => {
  const limits = q.files ?? formFileLimitsSchema.parse({});
  const set = (patch: Partial<typeof limits>) => onChange({ files: { ...limits, ...patch } });
  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
  };
  return (
    <div className="space-y-2 rounded-[10px] bg-surface-3 p-2.5" data-testid="form-file-limits">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('forms.editor.maxMb')}>
          <Input
            inputMode="numeric"
            value={String(limits.max_mb)}
            disabled={disabled}
            onChange={(e) => set({ max_mb: num(e.target.value, 1, 100, limits.max_mb) })}
          />
        </Field>
        <Field label={t('forms.editor.maxFiles')}>
          <Input
            inputMode="numeric"
            value={String(limits.max_files)}
            disabled={disabled}
            onChange={(e) => set({ max_files: num(e.target.value, 1, 10, limits.max_files) })}
          />
        </Field>
      </div>
      <span className="block text-xs font-semibold text-fg-2">{t('forms.editor.fileKinds')}</span>
      <div className="flex flex-wrap gap-1.5">
        {FILE_KINDS.filter((k) => k !== 'other').map((k) => {
          const on = limits.kinds.includes(k);
          return (
            <button
              key={k}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => set({ kinds: on ? limits.kinds.filter((x) => x !== k) : [...limits.kinds, k] })}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                on ? 'border-primary bg-primary-soft font-semibold text-heading' : 'border-line-strong text-fg-2',
              )}
            >
              {t(`filesView.kind.${k}` as MessageKey)}
            </button>
          );
        })}
      </div>
      <span className="block text-xs text-muted">{limits.kinds.length ? '' : t('forms.editor.anyKind')}</span>
    </div>
  );
};
