// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  FORM_PARAM_RE,
  formHiddenOnly,
  formInputOf,
  formParamUrl,
  getLocale,
  t,
  type BoardDetail,
  type Column,
  type FormAnswer,
  type FormHiddenItem,
  type FormHiddenSource,
  type FormQuestion,
  type Item,
  type ItemSearchResult,
  type PublicQuestion,
} from '@bines/shared';
import { cn, Field, Input, Notice, Picker, Switch } from '@bines/ui';
import { api } from '../../lib/api';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { SearchClear } from '../../lib/search-clear';
import { boardKeys, useBoard, useMembers, useTree, useWorkspaces } from '../board/board-api';
import { FormFieldInput } from './FormFields';

/** Editor texts (the person's UI language) — as in `QuestionList`. */

/** Column inputs that have their own picker (labels, people, a calendar, a checkbox, stars). */
const PICKER_INPUTS = new Set(['choice', 'multi_choice', 'people', 'date', 'checkbox', 'rating']);

/** The sources a hidden question on this column can take its value from, in the order the editor shows them. */
export const hiddenSourcesFor = (column: Column): FormHiddenSource[] => {
  if (formHiddenOnly(column.type)) return ['item', 'url'];
  const input = formInputOf(column.type);
  if (input === 'people') return ['choice', 'item', 'url'];
  return PICKER_INPUTS.has(input ?? '') ? ['manual', 'choice', 'item', 'url'] : ['manual', 'item', 'url'];
};

/** The source a hidden question uses (one its column does not offer falls back to the first it does). */
export const hiddenSourceOf = (q: FormQuestion, column: Column): FormHiddenSource => {
  const offered = hiddenSourcesFor(column);
  // Forms saved before sources existed: a label id / list / checkbox value was picked, not typed.
  const legacyPicked = q.default_value !== undefined && q.default_value !== null && typeof q.default_value !== 'string';
  const s = q.hidden_source ?? (legacyPicked && offered.includes('choice') ? 'choice' : 'manual');
  return offered.includes(s) ? s : offered[0]!;
};

/** The patch that switches a hidden question to a source (with what that source needs to start). */
const switchTo = (source: FormHiddenSource, q: FormQuestion, column: Column): Partial<FormQuestion> => {
  const relation = formHiddenOnly(column.type);
  return {
    hidden_source: source,
    hidden_item: source === 'item' ? (q.hidden_item ?? null) : null,
    hidden_param: source === 'url' ? (q.hidden_param ?? { name: 'ref', fallback: !relation }) : null,
    // A picked value is not free text and the other way round: switching between them starts empty.
    ...(source !== hiddenSourceOf(q, column) && (source === 'manual' || source === 'choice')
      ? { default_value: undefined }
      : {}),
    ...(relation ? { default_value: undefined } : {}),
  };
};

/**
 * Where a hidden question's value comes from (r16forms): typed, picked from the column's options, read from an item
 * of a board when the form is submitted, or taken from a parameter of the link. Each choice says in plain words what
 * it does.
 */
export const HiddenValueEditor = ({
  accountId,
  board,
  formUrl,
  q,
  column,
  preview,
  disabled,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  formUrl: string;
  q: FormQuestion;
  column: Column;
  preview: PublicQuestion | null;
  disabled: boolean;
  onChange: (patch: Partial<FormQuestion>) => void;
}) => {
  const source = hiddenSourceOf(q, column);
  const relation = formHiddenOnly(column.type);
  const sources = hiddenSourcesFor(column);
  return (
    <div className="space-y-3 rounded-[10px] bg-surface-3 p-2.5" data-testid="form-hidden-value">
      <span className="block text-xs font-semibold text-fg-2">{t('forms.editor.hv.title')}</span>
      <div role="radiogroup" aria-label={t('forms.editor.hv.title')} className="grid gap-1.5">
        {sources.map((s) => {
          const on = s === source;
          const key = s === 'item' && relation ? 'itemRelation' : s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => !on && onChange(switchTo(s, q, column))}
              data-testid={`form-hidden-source-${s}`}
              className={cn(
                'flex items-start gap-2 rounded-[10px] border bg-surface px-2.5 py-2 text-start disabled:opacity-60',
                on ? 'border-primary ring-2 ring-[var(--accent-soft)]' : 'border-line hover:border-line-strong',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2',
                  on ? 'border-primary' : 'border-line-strong',
                )}
              >
                {on ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-fg">{t(`forms.editor.hv.source.${key}`)}</span>
                <span className="block text-xs text-muted">{t(`forms.editor.hv.source.${key}.help`)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {source === 'manual' ? (
        <ManualValue q={q} column={column} preview={preview} disabled={disabled} onChange={onChange} />
      ) : source === 'choice' ? (
        <PickedValue
          accountId={accountId}
          q={q}
          column={column}
          preview={preview}
          testId="form-hidden-choice"
          onChange={onChange}
        />
      ) : source === 'item' ? (
        <ItemSource
          accountId={accountId}
          board={board}
          column={column}
          value={q.hidden_item ?? null}
          disabled={disabled}
          onChange={(hidden_item) => onChange({ hidden_item })}
        />
      ) : (
        <ParamSource
          accountId={accountId}
          formUrl={formUrl}
          q={q}
          column={column}
          preview={preview}
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </div>
  );
};

/** A typed value (free text): labels by their name, a date as YYYY-MM-DD, a number … — the server checks it. */
const ManualValue = ({
  q,
  column,
  preview,
  disabled,
  onChange,
}: {
  q: FormQuestion;
  column: Column;
  preview: PublicQuestion | null;
  disabled: boolean;
  onChange: (patch: Partial<FormQuestion>) => void;
}) => {
  const input = formInputOf(column.type);
  // Text-like questions use their own input; columns with a picker take the typed text (e.g. a label's name).
  if (preview && !PICKER_INPUTS.has(input ?? ''))
    return (
      <Field label={t('forms.editor.defaultValue')} hint={t('forms.editor.defaultValueHint')}>
        <FormFieldInput
          question={{ ...preview, id: `${preview.id}-manual` }}
          value={q.default_value ?? undefined}
          onChange={(v) => onChange({ default_value: v })}
          lang={getLocale()}
        />
      </Field>
    );
  const str = typeof q.default_value === 'string' || typeof q.default_value === 'number' ? String(q.default_value) : '';
  return (
    <Field label={t('forms.editor.defaultValue')} hint={t('forms.editor.hv.manualHint')}>
      <Input
        value={str}
        maxLength={500}
        disabled={disabled}
        onChange={(e) => onChange({ default_value: e.target.value })}
        data-testid="form-hidden-manual"
      />
    </Field>
  );
};

/** A value picked with the column's own control: its labels, the account's people, a calendar, stars. */
const PickedValue = ({
  accountId,
  q,
  column,
  preview,
  testId,
  value,
  onChange,
}: {
  accountId: string;
  q: FormQuestion;
  column: Column;
  preview: PublicQuestion | null;
  testId: string;
  /** Default: the question's fixed value. */
  value?: FormAnswer;
  onChange: (patch: Partial<FormQuestion>) => void;
}) => {
  const people = formInputOf(column.type) === 'people';
  const members = useMembers(accountId).data?.data ?? [];
  if (!preview) return null;
  const question: PublicQuestion = people
    ? {
        ...preview,
        input: 'people',
        multiple: true,
        choices: members
          .filter((m) => m.status === 'active' && !m.agent)
          .map((m) => ({ value: m.user_id, label: m.name || m.email })),
      }
    : preview;
  return (
    // A group, not <Field>'s <label>: the column's control holds several buttons (labels, people…), and a <label>
    // around them gave the first one the whole text as its name and selected it on a click anywhere inside.
    <div role="group" aria-label={t('forms.editor.defaultValue')} className="block space-y-1.5">
      <span className="text-xs font-semibold text-fg-2">{t('forms.editor.defaultValue')}</span>
      <div data-testid={testId}>
        <FormFieldInput
          question={{ ...question, id: `${question.id}-${testId}` }}
          value={value ?? q.default_value ?? undefined}
          onChange={(v) => onChange({ default_value: v })}
          lang={getLocale()}
        />
      </div>
      <span className="block text-xs text-muted">{t('forms.editor.defaultValueHint')}</span>
    </div>
  );
};

type Hit = { id: string; name: string; board_id: string };

/**
 * An item of a board: the board (a connect-boards question: one of its linked boards), the item (search), and —
 * except "the item itself" — the column whose value is read when the form is submitted.
 */
const ItemSource = ({
  accountId,
  board,
  column,
  value,
  disabled,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  value: FormHiddenItem | null;
  disabled: boolean;
  onChange: (v: FormHiddenItem | null) => void;
}) => {
  const relation = formHiddenOnly(column.type);
  const linked = (column.settings.board_ids as string[] | undefined) ?? [];
  // The board being browsed; the source is saved once an item of it is picked.
  const [boardId, setBoardId] = useState(value?.board_id ?? (relation ? (linked[0] ?? '') : board.id));
  const source = useBoard(accountId, boardId);
  const columns = source.data?.columns ?? [];
  const sameKind = relation || column.type === 'people';
  const columnOptions = [
    ...(relation ? [{ value: '__self__', label: t('forms.editor.hv.itemItself') }] : []),
    ...columns
      .filter((c) => !sameKind || c.type === column.type)
      .map((c) => ({ value: c.id, label: c.type === 'name' ? t('forms.editor.hv.itemName') : c.title })),
  ];
  const firstColumn = relation ? null : column.type === 'people' ? (columnOptions[0]?.value ?? 'name') : 'name';
  const pickItem = (id: string) =>
    onChange({
      board_id: boardId,
      item_id: id,
      column_key: value?.board_id === boardId ? (value.column_key ?? null) : firstColumn,
    });
  const current = value?.board_id === boardId ? value : null;
  return (
    <div className="space-y-2" data-testid="form-hidden-item">
      {relation ? (
        <RelationBoardPicker accountId={accountId} boardIds={linked} value={boardId} onChange={setBoardId} />
      ) : (
        <BoardPicker
          key={source.data?.workspace_id ?? board.workspace_id}
          accountId={accountId}
          initialWorkspace={source.data?.workspace_id ?? board.workspace_id}
          value={boardId}
          onChange={setBoardId}
        />
      )}
      {boardId ? (
        <ItemPicker
          key={boardId}
          accountId={accountId}
          boardId={boardId}
          itemId={current?.item_id ?? ''}
          disabled={disabled}
          onPick={pickItem}
        />
      ) : null}
      {relation && current && current.column_key === null ? (
        <ChoiceFilterWarning accountId={accountId} boardId={board.id} column={column} value={current} />
      ) : null}
      {current ? (
        <Field label={t('forms.editor.hv.column')}>
          <Picker
            label={t('forms.editor.hv.column')}
            value={current.column_key ?? '__self__'}
            options={columnOptions}
            onChange={(k) => onChange({ ...current, column_key: k === '__self__' ? null : k })}
            testId="form-hidden-item-column"
          />
        </Field>
      ) : null}
    </div>
  );
};

/**
 * r19relfilter: the item a hidden connect-boards question links is one the column's filter does not offer. It does
 * not block anything — the form still links it on submit, marked "does not match the filter". (A value read from a
 * column of an item is only known at submit time, so it is not checked here.)
 */
const ChoiceFilterWarning = ({
  accountId,
  boardId,
  column,
  value,
}: {
  accountId: string;
  boardId: string;
  column: Column;
  value: FormHiddenItem;
}) => {
  const check = useQuery({
    queryKey: ['account', accountId, 'board', value.board_id, 'choice-check', boardId, column.id, value.item_id],
    queryFn: () =>
      api(accountId).get<ItemSearchResult>(
        `/boards/${value.board_id}/items/search?source_board_id=${boardId}&column_id=${encodeURIComponent(column.id)}&ids=${encodeURIComponent(value.item_id)}`,
      ),
    retry: false,
    staleTime: 10_000,
  });
  const filter = check.data?.filter;
  if (!filter || filter.invalid || check.data!.data.some((x) => x.id === value.item_id)) return null;
  return (
    <div data-testid="form-hidden-choice-warning">
      <Notice tone="warn">
        {t('forms.editor.hv.notInChoiceFilter', { filter: filter.label ?? t('relfilter.mode.filter') })}
      </Notice>
    </div>
  );
};

/** A board of the account: Workspace → board (searchable). */
const BoardPicker = ({
  accountId,
  initialWorkspace,
  value,
  onChange,
}: {
  accountId: string;
  initialWorkspace: string;
  value: string;
  onChange: (boardId: string) => void;
}) => {
  const workspaces = useWorkspaces(accountId).data?.data ?? [];
  const [wsId, setWsId] = useState(initialWorkspace);
  const tree = useTree(accountId, wsId || workspaces[0]?.id).data;
  const boards = tree?.boards ?? [];
  return (
    <div className={cn('grid gap-2', workspaces.length > 1 && 'sm:grid-cols-2')}>
      {workspaces.length > 1 ? (
        <Field label={t('forms.editor.hv.workspace')}>
          <Picker
            label={t('forms.editor.hv.workspace')}
            value={wsId}
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            onChange={setWsId}
            testId="form-hidden-workspace"
          />
        </Field>
      ) : null}
      <Field label={t('forms.editor.hv.board')}>
        <Picker
          label={t('forms.editor.hv.board')}
          value={value}
          placeholder={t('forms.editor.hv.board')}
          options={boards.map((b) => ({ value: b.id, label: b.name }))}
          onChange={onChange}
          searchable
          testId="form-hidden-board"
        />
      </Field>
    </div>
  );
};

/** One of the boards a connect-boards column links to. */
const RelationBoardPicker = ({
  accountId,
  boardIds,
  value,
  onChange,
}: {
  accountId: string;
  boardIds: string[];
  value: string;
  onChange: (boardId: string) => void;
}) => {
  const boards = useQueries({
    queries: boardIds.map((b) => ({
      queryKey: boardKeys.board(accountId, b),
      queryFn: () => api(accountId).get<BoardDetail>(`/boards/${b}`),
      staleTime: 60_000,
    })),
  });
  if (!boardIds.length) return <p className="text-xs text-danger-fg">{t('forms.editor.hv.noLinkedBoards')}</p>;
  if (boardIds.length === 1) return null;
  return (
    <Field label={t('forms.editor.hv.board')}>
      <Picker
        label={t('forms.editor.hv.board')}
        value={value}
        options={boardIds.map((b, i) => ({ value: b, label: boards[i]?.data?.name ?? '…' }))}
        onChange={onChange}
        testId="form-hidden-board"
      />
    </Field>
  );
};

/** An item of a board: the picked one, and a search to pick (another). */
const ItemPicker = ({
  accountId,
  boardId,
  itemId,
  disabled,
  onPick,
}: {
  accountId: string;
  boardId: string;
  itemId: string;
  disabled: boolean;
  onPick: (id: string) => void;
}) => {
  const [open, setOpen] = useState(!itemId);
  const [q, setQ] = useState('');
  const query = q.trim();
  const picked = useQuery({
    queryKey: ['account', accountId, 'item', itemId],
    queryFn: () => api(accountId).get<Item>(`/items/${itemId}`),
    enabled: !!itemId,
    retry: false,
    staleTime: 60_000,
  });
  const results = useQuery({
    queryKey: ['account', accountId, 'board', boardId, 'search', query],
    queryFn: () =>
      api(accountId).get<{ data: Hit[] }>(`/boards/${boardId}/items/search?q=${encodeURIComponent(query)}`),
    enabled: open || !itemId,
    staleTime: 10_000,
  });
  const hits = results.data?.data ?? [];
  return (
    <Field label={t('forms.editor.hv.item')}>
      <div className="space-y-1.5">
        {itemId ? (
          <div className="flex items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate" data-testid="form-hidden-item-picked">
              {picked.isError ? t('forms.editor.hv.itemGone') : (picked.data?.name ?? '…')}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOpen((o) => !o)}
              className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
              data-testid="form-hidden-item-change"
            >
              {t('forms.editor.hv.changeItem')}
            </button>
          </div>
        ) : null}
        {open || !itemId ? (
          <div className="rounded-[10px] border border-line bg-surface p-1.5">
            <div className="relative">
              <Input
                value={q}
                disabled={disabled}
                placeholder={t('forms.editor.hv.searchItem')}
                onChange={(e) => setQ(e.target.value)}
                className="pe-7"
                data-testid="form-hidden-item-search"
              />
              <SearchClear value={q} onClear={() => setQ('')} />
            </div>
            <ul className="mt-1 max-h-48 overflow-auto" role="listbox" aria-label={t('forms.editor.hv.item')}>
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={h.id === itemId}
                    disabled={disabled}
                    onClick={() => {
                      onPick(h.id);
                      setOpen(false);
                      setQ('');
                    }}
                    className={cn(
                      'w-full truncate rounded-[8px] px-2 py-1 text-start text-sm hover:bg-surface-2',
                      h.id === itemId && 'font-semibold text-primary',
                    )}
                    data-testid="form-hidden-item-option"
                  >
                    {h.name}
                  </button>
                </li>
              ))}
              {!hits.length && !results.isPending ? (
                <li className="px-2 py-1 text-xs text-muted">{t('forms.editor.hv.noItems')}</li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </Field>
  );
};

/** A parameter of the link: its name, whether a missing one falls back to a fixed value, and an example link. */
const ParamSource = ({
  accountId,
  formUrl,
  q,
  column,
  preview,
  disabled,
  onChange,
}: {
  accountId: string;
  formUrl: string;
  q: FormQuestion;
  column: Column;
  preview: PublicQuestion | null;
  disabled: boolean;
  onChange: (patch: Partial<FormQuestion>) => void;
}) => {
  const relation = formHiddenOnly(column.type);
  const param = q.hidden_param ?? { name: 'ref', fallback: !relation };
  // The name being typed: saved only once it is a valid parameter name.
  const [name, setName] = useState(param.name);
  const valid = FORM_PARAM_RE.test(name);
  const example = formParamUrl(formUrl, valid ? name : param.name, t('forms.editor.hv.exampleValue'));
  const picker = PICKER_INPUTS.has(formInputOf(column.type) ?? '');
  return (
    <div className="space-y-2" data-testid="form-hidden-param">
      <Field label={t('forms.editor.hv.param')} hint={valid ? t('forms.editor.hv.paramHint') : undefined}>
        <Input
          value={name}
          maxLength={40}
          dir="ltr"
          disabled={disabled}
          aria-invalid={!valid || undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (FORM_PARAM_RE.test(e.target.value)) onChange({ hidden_param: { ...param, name: e.target.value } });
          }}
          data-testid="form-hidden-param-name"
        />
      </Field>
      {!valid ? <p className="text-xs font-semibold text-danger-fg">{t('forms.editor.hv.paramInvalid')}</p> : null}
      <div className="space-y-1">
        <span className="block text-xs font-semibold text-fg-2">{t('forms.editor.hv.example')}</span>
        <div className="flex items-center gap-2 rounded-[10px] border border-line bg-surface px-2.5 py-1.5">
          <code dir="ltr" className="min-w-0 flex-1 truncate text-xs" data-testid="form-hidden-param-example">
            {example}
          </code>
          <button
            type="button"
            onClick={() => copyText(example)}
            aria-label={t('forms.editor.hv.copy')}
            title={t('forms.editor.hv.copy')}
            className="grid size-7 place-items-center rounded-full text-muted hover:bg-surface-2"
          >
            <Icon name="copy" size={14} />
          </button>
        </div>
        <span className="block text-xs text-muted">
          {t(`forms.editor.${relation ? 'hv.paramRelationHint' : 'hv.paramValueHint'}`)}
        </span>
      </div>
      {relation ? null : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={param.fallback}
              disabled={disabled}
              onChange={(on) => onChange({ hidden_param: { ...param, fallback: on } })}
              testId="form-hidden-param-fallback"
            />
            {t('forms.editor.hv.fallback')}
          </label>
          {param.fallback ? (
            picker ? (
              <PickedValue
                accountId={accountId}
                q={q}
                column={column}
                preview={preview}
                testId="form-hidden-fallback"
                onChange={onChange}
              />
            ) : (
              <ManualValue q={q} column={column} preview={preview} disabled={disabled} onChange={onChange} />
            )
          ) : null}
        </>
      )}
    </div>
  );
};
