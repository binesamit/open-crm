// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import { isComputedName, renderNameSource, type Item, type NameSourceMode, type ItemsPage, t } from '@bines/shared';
import { Button, Dialog, Input, Notice, RadioCard, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { boardKeys, type BoardDetail } from '../board-api';
import { ColumnTypeGlyph } from '../table/type-glyphs';
import { ColumnPick, nameSourceColumns } from './ColumnPick';
import { boardNameSource, useSaveNameSource } from './name-source-api';
import {
  draftReady,
  draftToSource,
  insertColumn,
  removeSegment,
  setSegmentText,
  templateToSegments,
  type Segment,
} from './template-segments';

/**
 * "מקור שם הפריט" ("way 2", NAME-API §6.2): free / from a column / a template built from column chips and
 * text between them (no code), the text when everything is empty, and the duplicates warning. One board at a time
 * — the main board and its sub-board each have their own (opened from their own name column header).
 */
export const NameSourceDialog = ({
  accountId,
  board,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  onClose: () => void;
}) => {
  const initial = useMemo(() => boardNameSource(board), [board]);
  const wasComputed = isComputedName(initial);
  const [mode, setMode] = useState<NameSourceMode>(initial.mode);
  const [columnId, setColumnId] = useState<string | null>(
    initial.mode === 'column' ? (initial.column_id ?? null) : null,
  );
  const [segments, setSegments] = useState<Segment[]>(() =>
    templateToSegments(initial.mode === 'template' ? initial.template : ''),
  );
  const [emptyText, setEmptyText] = useState(initial.empty_text ?? '');
  const [warn, setWarn] = useState(!!initial.warn_duplicates);
  const [openOnCreate, setOpenOnCreate] = useState(!!initial.open_on_create);
  const [invalidKey, setInvalidKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The caret: which text piece and where in it — "הוסף עמודה" inserts the chip there.
  const caret = useRef<{ index: number; offset: number } | undefined>(undefined);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const save = useSaveNameSource(accountId, board.id);
  const columns = nameSourceColumns(board.columns);
  const titleOf = (key: string) => board.columns.find((c) => c.id === key)?.title ?? key;
  const typeOf = (key: string) => board.columns.find((c) => c.id === key)?.type ?? '';

  // Preview: the first three items, rendered here exactly as the server will (renderNameSource).
  const sample = useQuery({
    queryKey: [...boardKeys.board(accountId, board.id), 'name-preview'],
    queryFn: () => api(accountId).post<ItemsPage>(`/boards/${board.id}/items/query`, { limit: 3 }),
    staleTime: 30_000,
  });
  const draft = { mode, columnId, segments, emptyText, warn, openOnCreate };
  const source = draftToSource(draft);
  const ready = draftReady(draft);
  const preview = (sample.data?.data ?? [])
    .slice(0, 3)
    .map((it: Item) => renderNameSource(source, (key) => it.cells[key]?.text ?? null) ?? it.name);

  const choose = (next: NameSourceMode) => {
    setMode(next);
    setInvalidKey(null);
    if (next !== 'free' && !wasComputed && !emptyText) setEmptyText(t('name.source.emptyDefault'));
  };

  const onTextKey = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    const el = e.currentTarget;
    // Backspace at the start of a text piece removes the chip before it.
    if (
      e.key === 'Backspace' &&
      el.selectionStart === 0 &&
      el.selectionEnd === 0 &&
      segments[index - 1]?.kind === 'column'
    ) {
      e.preventDefault();
      const before = segments[index - 2];
      const offset = before?.kind === 'text' ? before.text.length : 0;
      setSegments(removeSegment(segments, index - 1));
      caret.current = { index: Math.max(0, index - 2), offset };
      requestAnimationFrame(() => {
        const input = inputs.current.get(Math.max(0, index - 2));
        input?.focus();
        input?.setSelectionRange(offset, offset);
      });
    }
  };
  const remember = (index: number, el: HTMLInputElement) => {
    caret.current = { index, offset: el.selectionStart ?? el.value.length };
  };

  const submit = () => {
    setError(null);
    setInvalidKey(null);
    save.mutate(source, {
      onSuccess: (out) => {
        const r = out.recompute;
        if (r?.status === 'done' && isComputedName(out.name_source))
          showToast({ message: t('name.source.recomputed', { renamed: r.renamed }) });
        onClose();
      },
      onError: (e) => {
        const details = e instanceof ApiError ? ((e.body.details ?? {}) as { column_id?: string }) : {};
        if (e instanceof ApiError && e.body.code === 'name_source_invalid' && details.column_id) {
          setInvalidKey(details.column_id);
          setError(t('name.source.invalidColumn', { column: titleOf(details.column_id) }));
        } else setError(errorMessage(e));
      },
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('name.source.title')}
      subtitle={board.name}
      className="max-w-[560px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('name.source.cancel')}
          </Button>
          <Button onClick={submit} busy={save.isPending} disabled={!ready} data-testid="name-source-save">
            {t('name.source.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="name-source-dialog">
        {board.parent_board_id ? <Notice tone="info">{t('name.source.subitemsNote')}</Notice> : null}
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={t('name.source.title')}>
          <RadioCard
            name="name-source-mode"
            checked={mode === 'free'}
            onSelect={() => choose('free')}
            title={t('name.source.free')}
            hint={t('name.source.freeHelp')}
            testId="name-source-free"
          />
          <RadioCard
            name="name-source-mode"
            checked={mode === 'column'}
            onSelect={() => choose('column')}
            title={t('name.source.column')}
            hint={t('name.source.columnHelp')}
            testId="name-source-column-mode"
          />
          <RadioCard
            name="name-source-mode"
            checked={mode === 'template'}
            onSelect={() => choose('template')}
            title={t('name.source.template')}
            hint={t('name.source.templateHelp')}
            testId="name-source-template-mode"
          />
        </div>

        {mode === 'free' && wasComputed ? <Notice tone="info">{t('name.source.freeNote')}</Notice> : null}

        {mode === 'column' ? (
          <ColumnPick
            columns={board.columns}
            testId="name-source-pick"
            invalid={!!columnId && invalidKey === columnId}
            onPick={(key) => {
              setColumnId(key);
              setInvalidKey(null);
            }}
            trigger={
              columnId ? (
                <>
                  <ColumnTypeGlyph type={typeOf(columnId)} />
                  <span className="truncate">{titleOf(columnId)}</span>
                </>
              ) : (
                <span className="text-muted">{t('name.source.pickColumn')}</span>
              )
            }
          />
        ) : null}

        {mode === 'template' ? (
          <div className="flex flex-col gap-2">
            <div
              className="flex min-h-11 flex-wrap items-center gap-1 rounded-[10px] border border-line-strong bg-surface px-2 py-1.5 focus-within:border-primary"
              data-testid="name-template"
              onClick={(e) => {
                // A click on the box's empty part puts the caret at the end.
                if (e.target === e.currentTarget) {
                  const last = segments.length - 1;
                  const input = inputs.current.get(last);
                  input?.focus();
                  input?.setSelectionRange(input.value.length, input.value.length);
                }
              }}
            >
              {segments.map((s, i) =>
                s.kind === 'column' ? (
                  <span
                    key={`c${i}`}
                    data-testid="name-template-chip"
                    data-key={s.key}
                    data-invalid={invalidKey === s.key || undefined}
                    className={
                      invalidKey === s.key || !columns.some((c) => c.id === s.key)
                        ? 'inline-flex h-7 items-center gap-1 rounded-full bg-danger-soft ps-2.5 pe-1 text-xs font-semibold text-danger-fg'
                        : 'inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft ps-2.5 pe-1 text-xs font-semibold text-primary'
                    }
                  >
                    {titleOf(s.key)}
                    <button
                      type="button"
                      aria-label={t('name.source.removeColumn', { column: titleOf(s.key) })}
                      data-testid="name-template-chip-remove"
                      onClick={() => setSegments(removeSegment(segments, i))}
                      className="grid size-5 place-items-center rounded-full hover:bg-surface"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <input
                    key={`t${i}`}
                    ref={(el) => {
                      if (el) inputs.current.set(i, el);
                      else inputs.current.delete(i);
                    }}
                    value={s.text}
                    data-testid="name-template-text"
                    aria-label={t('name.source.templateText')}
                    placeholder={segments.length === 1 ? t('name.source.templatePlaceholder') : undefined}
                    onChange={(e) => {
                      setSegments(setSegmentText(segments, i, e.target.value));
                      remember(i, e.target);
                    }}
                    onSelect={(e) => remember(i, e.currentTarget)}
                    onFocus={(e) => remember(i, e.currentTarget)}
                    onKeyDown={(e) => onTextKey(e, i)}
                    // Grows with its text; a narrow field between chips stays clickable.
                    style={{
                      width: segments.length === 1 && !s.text ? '100%' : `${Math.max(1.5, [...s.text].length + 1)}ch`,
                    }}
                    className="h-7 min-w-[1.5ch] bg-transparent text-sm outline-none"
                  />
                ),
              )}
            </div>
            <ColumnPick
              columns={board.columns}
              testId="name-template-add"
              onPick={(key) => {
                const next = insertColumn(segments, key, caret.current);
                setSegments(next);
                setInvalidKey(null);
                // The caret goes to the text right after the new chip.
                const at = caret.current ? caret.current.index + 2 : next.length - 1;
                caret.current = { index: at, offset: 0 };
                requestAnimationFrame(() => inputs.current.get(at)?.focus());
              }}
              trigger={<span>+ {t('name.source.addColumn')}</span>}
            />
          </div>
        ) : null}

        {mode !== 'free' ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-fg-2">{t('name.source.emptyText')}</span>
            <Input
              value={emptyText}
              maxLength={255}
              data-testid="name-source-empty"
              onChange={(e) => setEmptyText(e.target.value)}
            />
          </label>
        ) : null}

        <label className="flex items-center justify-between gap-3 text-sm">
          <span>{t('name.source.warnDuplicates')}</span>
          <Switch checked={warn} onChange={setWarn} testId="name-source-warn" label={t('name.source.warnDuplicates')} />
        </label>

        {/* a new item stays in its row (default), or its card opens. */}
        {mode !== 'free' ? (
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t('name.source.openOnCreate')}</span>
            <Switch
              checked={openOnCreate}
              onChange={setOpenOnCreate}
              testId="name-source-open-on-create"
              label={t('name.source.openOnCreate')}
            />
          </label>
        ) : null}

        {mode !== 'free' && ready && preview.length ? (
          <div className="rounded-[10px] bg-surface-3 p-2.5" data-testid="name-source-preview">
            <p className="mb-1 text-xs font-semibold text-fg-2">{t('name.source.preview')}</p>
            <ul className="flex flex-col gap-0.5 text-sm">
              {preview.map((p, i) => (
                <li key={i} className="truncate" data-testid="name-source-preview-row">
                  {p || <span className="text-muted">—</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};
