// SPDX-License-Identifier: AGPL-3.0-only
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  columnTypes,
  isComputedName,
  nameSourceOfColumns,
  nameSourceRefs,
  POPUP_MAX_FIELDS,
  POPUP_NOTE_MAX,
  SUBITEMS_MAX,
  t,
  type ItemPopup,
  type PopupSubitemsWrite,
  type WorkflowTransition,
} from '@bines/shared';
import { Button, cn, Dialog, Field, Input, Notice, Segmented, Switch } from '@bines/ui';
import { columnTypeLabel } from '../../../lib/locale';
import { errorMessage } from '../../../lib/api';
import { useBoard, useItems, useMembers, type BoardDetail, type Column } from '../board-api';
import { cellFor } from '../cells';
import { PickerButton } from '../toolbar/parts';
import { MoveChecklist, useMoveChecks } from './move-checks';

/**
 * phase 2 — the popup that asks for values before an action (a workflow move, a button click): its editor
 * (which columns, which are required, a note) and the dialog people fill in. The dialog edits a draft — nothing is
 * written until "save", and then the values and the action go in one request.
 */

/**
 * Columns a popup may ask for: plain cell columns and relations (connected boards, dependencies)
 * not computed, not files / time / votes, not the name.
 */
export const popupColumns = (board: BoardDetail, excludeId?: string) =>
  board.columns.filter((c) => {
    const def = columnTypes.get(c.type);
    return (
      !!def &&
      !def.readOnly &&
      def.storage === 'cell' &&
      (!def.engine || def.engine === 'links') &&
      c.type !== 'name' &&
      c.id !== excludeId
    );
  });

export const EMPTY_POPUP: ItemPopup = { fields: [], note: 'off' };

export const PopupEditor = ({
  accountId,
  board,
  excludeColumnId,
  popup,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  excludeColumnId?: string;
  popup: ItemPopup;
  onChange: (p: ItemPopup) => void;
}) => {
  const columns = popupColumns(board, excludeColumnId);
  const unused = columns.filter((c) => !popup.fields.some((f) => f.column_id === c.id));
  return (
    <div className="space-y-2.5" data-testid="popup-editor">
      <Field label={t('popup.titleField')}>
        <Input
          value={popup.title ?? ''}
          maxLength={120}
          placeholder={t('popup.titlePlaceholder')}
          data-testid="popup-title"
          onChange={(e) => onChange({ ...popup, title: e.target.value || undefined })}
        />
      </Field>
      <div className="space-y-1.5">
        <p className="text-xs text-fg-2">{t('popup.fields')}</p>
        {popup.fields.map((f, i) => {
          const c = columns.find((x) => x.id === f.column_id);
          return (
            <div key={f.column_id} className="flex items-center gap-2 text-sm" data-testid="popup-field">
              <span className="min-w-0 flex-1 truncate">{c?.title ?? f.column_id}</span>
              <label className="flex items-center gap-1.5 text-xs text-fg-2">
                <Switch
                  checked={!!f.required}
                  label={t('popup.required')}
                  testId={`popup-required-${f.column_id}`}
                  onChange={(on) =>
                    onChange({
                      ...popup,
                      fields: popup.fields.map((x, j) => (j === i ? { ...x, required: on || undefined } : x)),
                    })
                  }
                />
                {t('popup.required')}
              </label>
              <button
                type="button"
                aria-label={t('popup.removeField', { name: c?.title ?? f.column_id })}
                className="cursor-pointer px-1 text-muted hover:text-fg"
                onClick={() => onChange({ ...popup, fields: popup.fields.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          );
        })}
        {popup.fields.length < POPUP_MAX_FIELDS && unused.length ? (
          <PickerButton
            className="w-56"
            testId="popup-add-field"
            menuLabel={t('popup.addField')}
            placeholder={t('popup.addField')}
            items={unused.map((c) => ({
              label: `${c.title} · ${columnTypeLabel(c.type)}`,
              onSelect: () => onChange({ ...popup, fields: [...popup.fields, { column_id: c.id }] }),
            }))}
          />
        ) : null}
      </div>
      <PopupSubitemsEditor accountId={accountId} board={board} popup={popup} onChange={onChange} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t('popup.note')}</span>
        <Segmented
          label={t('popup.note')}
          value={popup.note ?? 'off'}
          onChange={(v) => onChange({ ...popup, note: v })}
          options={[
            { value: 'off', label: t('popup.note.off'), testId: 'popup-note-off' },
            { value: 'optional', label: t('popup.note.optional'), testId: 'popup-note-optional' },
            { value: 'required', label: t('popup.note.required'), testId: 'popup-note-required' },
          ]}
        />
      </div>
    </div>
  );
};

/** The board an item of `board` keeps its subitems on (a sub-board keeps them on itself); '' = none yet. */
export const subitemsBoardOf = (board: BoardDetail) =>
  board.parent_board_id ? board.id : (board.subitems_board_id ?? '');

/**
 * A sub-board's computed name: the columns it is built from that a popup can fill in, in source order
 * null when people type the name.
 */
export const computedNameSources = (subBoard: BoardDetail | undefined): Column[] | null => {
  if (!subBoard) return null;
  const source = nameSourceOfColumns(subBoard.columns);
  if (!isComputedName(source)) return null;
  const fillable = popupColumns(subBoard);
  return nameSourceRefs(source).flatMap((k) => fillable.filter((c) => c.id === k));
};

/** Sub-board columns a subitems rule or popup may ask for: the name, then the columns a popup may ask for. */
export const subitemFillable = (subBoard: BoardDetail | undefined): Pick<Column, 'id' | 'title' | 'type'>[] => {
  const title = subBoard?.columns.find((c) => c.type === 'name')?.title ?? t('popup.subitems.name');
  return [
    // A computed name says so: it is filled in through its source columns.
    { id: 'name', title: computedNameSources(subBoard) ? `${title} ƒ` : title, type: 'name' },
    ...(subBoard ? popupColumns(subBoard) : []),
  ];
};

/** A whole number typed in a small box (no browser spinner), kept between `min` and `max`. */
export const CountInput = ({
  value,
  onChange,
  label,
  testId,
  min = 0,
  max = SUBITEMS_MAX,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  testId?: string;
  min?: number;
  max?: number;
}) => (
  <Input
    className="w-16"
    inputMode="numeric"
    aria-label={label}
    data-testid={testId}
    value={String(value)}
    onChange={(e) => {
      const n = Number(e.target.value.replace(/[^0-9]/g, '') || 0);
      onChange(Math.min(max, Math.max(min, n)));
    }}
  />
);

/** the popup editor's subitems section: which sub-board columns the popup shows (each may be required). */
const PopupSubitemsEditor = ({
  accountId,
  board,
  popup,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  popup: ItemPopup;
  onChange: (p: ItemPopup) => void;
}) => {
  const subBoard = useBoard(accountId, subitemsBoardOf(board)).data;
  const s = popup.subitems;
  const set = (p: Partial<NonNullable<ItemPopup['subitems']>>) =>
    onChange({ ...popup, subitems: { fields: [], ...s, ...p } });
  const columns = subitemFillable(subBoard);
  return (
    <div className="space-y-1.5" data-testid="popup-subitems-editor">
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <Switch
          checked={!!s}
          label={t('popup.subitems')}
          testId="popup-subitems-on"
          onChange={(on) => onChange({ ...popup, subitems: on ? { fields: [{ column_id: 'name' }] } : undefined })}
        />
        {t('popup.subitems')}
      </label>
      {s ? (
        <div className="space-y-1.5 ps-1">
          <p className="text-xs text-fg-2">{t('popup.subitems.fields')}</p>
          {s.fields.map((f, i) => {
            const title = columns.find((c) => c.id === f.column_id)?.title ?? f.column_id;
            return (
              <div key={f.column_id} className="flex items-center gap-2 text-sm" data-testid="popup-subitems-field">
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <label className="flex items-center gap-1.5 text-xs text-fg-2">
                  <Switch
                    checked={!!f.required}
                    label={t('popup.required')}
                    testId={`popup-subitems-required-${f.column_id}`}
                    onChange={(on) =>
                      set({ fields: s.fields.map((x, j) => (j === i ? { ...x, required: on || undefined } : x)) })
                    }
                  />
                  {t('popup.required')}
                </label>
                <button
                  type="button"
                  aria-label={t('popup.removeField', { name: title })}
                  className="cursor-pointer px-1 text-muted hover:text-fg"
                  onClick={() => set({ fields: s.fields.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
            );
          })}
          {s.fields.length < POPUP_MAX_FIELDS && columns.some((c) => !s.fields.some((f) => f.column_id === c.id)) ? (
            <PickerButton
              className="w-56"
              testId="popup-subitems-add-field"
              menuLabel={t('popup.addField')}
              placeholder={t('popup.addField')}
              items={columns
                .filter((c) => !s.fields.some((f) => f.column_id === c.id))
                .map((c) => ({
                  label: c.type === 'name' ? c.title : `${c.title} · ${columnTypeLabel(c.type)}`,
                  onSelect: () => set({ fields: [...s.fields, { column_id: c.id }] }),
                }))}
            />
          ) : null}
          {computedNameSources(subBoard) ? (
            <label className="flex items-center gap-2 text-xs text-fg-2">
              <Switch
                checked={!s.hide_name}
                label={t('popup.subitems.showName')}
                testId="popup-subitems-show-name"
                onChange={(on) => set({ hide_name: on ? undefined : true })}
              />
              {t('popup.subitems.showName')}
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-fg-2">
            {t('popup.subitems.min')}
            <CountInput
              value={s.min ?? 0}
              label={t('popup.subitems.min')}
              testId="popup-subitems-min"
              onChange={(min) => set({ min: min || undefined })}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
};

type Cells = Record<string, { value: unknown; text: string | null; names?: string[] } | undefined>;

const linkIds = (v: unknown) => (v as { item_ids?: string[] } | null | undefined)?.item_ids;
type Member = NonNullable<ReturnType<typeof useMembers>['data']>['data'][number];

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && !v.trim()) ||
  (typeof v === 'object' && Object.keys(v as object).length === 0);

/** One asked column: the board's own cell editor on a draft value, framed like a field. */
const DraftCell = ({
  accountId,
  boardId,
  itemId,
  column,
  value,
  savedText,
  rowCells,
  members,
  onChange,
}: {
  accountId: string;
  boardId: string;
  itemId: string;
  column: Column;
  value: unknown;
  /** The stored cell's text while the draft has not touched it; undefined = the draft's (computed here). */
  savedText: string | null | undefined;
  rowCells: Cells;
  members: Member[];
  onChange: (v: unknown) => void;
}) => {
  const nameOf = (id: string) => members.find((m) => m.user_id === id)?.name;
  const text =
    savedText !== undefined
      ? savedText
      : value === null || value === undefined
        ? null
        : (columnTypes.get(column.type)?.toText(value as never, column.settings as never, { userName: nameOf }) ??
          null);
  // A relation's linked names by id from the stored cell (the draft may add or drop links; the cell names new ones).
  const saved = rowCells[column.id];
  const savedNames = new Map((linkIds(saved?.value) ?? []).map((id, i) => [id, saved?.names?.[i] ?? '']));
  const names = linkIds(value)?.map((id) => savedNames.get(id) ?? '');
  return (
    <div className="relative h-9 min-w-0 overflow-hidden rounded-[var(--radius-sm)] border border-line bg-surface">
      {createElement(cellFor(column), {
        column,
        value: value ?? null,
        text,
        names,
        editable: true,
        members,
        accountId,
        itemId,
        boardId,
        rowCells,
        onChange,
        canEditSettings: false,
        onSettingsChange: async () => undefined,
      })}
    </div>
  );
};

type NewRow = { key: number; name: string; cells: Record<string, unknown> };

/**
 * The popup people fill in: each asked column with the board's own cell editor on a draft of the item's values, and
 * the note. "Save" checks the required ones here (the server checks again), then hands the changed values and the
 * note to `onSubmit` — one request with the action; an error stays in the dialog.: with a subitems section
 * the item's subitems (to fill in) and new rows to add go in the same request. Round 2: with the workflow `move`,
 * its conditions are ticked off at the top, and a condition the item does not meet brings its column in to change.
 * With `onPass` (a move that has no popup of its own) the dialog opens only when something is missing; otherwise
 * it calls `onPass` and shows nothing.
 */
export const PopupDialog = ({
  accountId,
  board,
  itemId,
  rowCells,
  popup,
  title,
  subtitle,
  move,
  onPass,
  onSubmit,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  itemId: string;
  rowCells: Cells;
  popup: ItemPopup;
  title: string;
  /** A muted line under the title (P1-03: what saving does — "created only when you save"). */
  subtitle?: string;
  move?: WorkflowTransition;
  onPass?: () => void;
  onSubmit: (
    cells: Record<string, unknown>,
    note: string | undefined,
    subitems: PopupSubitemsWrite | undefined,
  ) => Promise<unknown>;
  onClose: () => void;
}) => {
  const members = useMembers(accountId).data?.data ?? [];
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Round 2: the move's conditions on the item with the draft; the columns of those not met when the popup opened
  // are asked for too (they stay while being filled in).
  const editable = popupColumns(board);
  const { checks, any } = useMoveChecks(accountId, board, itemId, rowCells, draft, move, editable);
  const [conditionColumns] = useState(() =>
    checks.flatMap((x) =>
      !x.met && x.column && !popup.fields.some((f) => f.column_id === x.column!.id) ? [x.column] : [],
    ),
  );
  const fields = [
    ...popup.fields
      .map((f) => ({ f, c: board.columns.find((x) => x.id === f.column_id) }))
      .filter((x): x is { f: (typeof popup.fields)[number]; c: Column } => !!x.c),
    ...conditionColumns
      .filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i)
      .map((c) => ({ f: { column_id: c.id } as (typeof popup.fields)[number], c })),
  ];
  const valueOf = (c: Column) => (c.id in draft ? draft[c.id] : (rowCells[c.id]?.value ?? null));
  // A move with no popup of its own: open only when a required value or a condition is missing.
  const [gated] = useState(
    () => !!onPass && !fields.some(({ f, c }) => f.required && isEmpty(valueOf(c))) && checks.every((x) => x.met),
  );
  useEffect(() => {
    if (gated) onPass?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const noteMode = popup.note ?? 'off';

  // the subitems section — the item's own subitems (one level down) and the new rows.
  const sub = popup.subitems;
  const subId = sub ? subitemsBoardOf(board) : '';
  const subBoard = useBoard(accountId, subId).data;
  const subItems = useItems(accountId, subId).data?.data;
  const children = useMemo(
    () =>
      (subItems ?? [])
        .filter((x) => x.parent_item_id === itemId)
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)),
    [subItems, itemId],
  );
  const subFields = (sub?.fields ?? []).filter((f) => f.column_id !== 'name');
  // A computed name is not typed: its source columns are asked for, first, even when not picked.
  const nameSources = computedNameSources(subBoard);
  const subColumns = [
    ...(nameSources ?? [])
      .filter((c) => !subFields.some((f) => f.column_id === c.id))
      .map((c) => ({ f: { column_id: c.id } as (typeof subFields)[number], c })),
    ...subFields
      .map((f) => ({ f, c: subBoard?.columns.find((x) => x.id === f.column_id) }))
      .filter((x): x is { f: (typeof subFields)[number]; c: Column } => !!x.c),
  ];
  const nameTitle = subBoard?.columns.find((c) => c.type === 'name')?.title ?? t('popup.subitems.name');
  const nameRequired = !!sub?.fields.find((f) => f.column_id === 'name')?.required;
  // P1-03: a name built from the columns can be hidden (the popup's setting); a typed one always shows.
  const showName = !nameSources || !sub?.hide_name;
  const [subDraft, setSubDraft] = useState<Record<string, Record<string, unknown>>>({});
  const [rows, setRows] = useState<NewRow[]>([]);
  const nextKey = useRef(1);
  const subValue = (childId: string, cells: Cells, colId: string) =>
    colId in (subDraft[childId] ?? {}) ? subDraft[childId]![colId] : (cells[colId]?.value ?? null);
  // A new row left empty is not added.
  const filledRows = rows.filter((r) => r.name.trim() || Object.values(r.cells).some((v) => !isEmpty(v)));
  // A new row's computed name is there once one of its source columns is filled in.
  const named = (name: string, get: (colId: string) => unknown) =>
    !!name.trim() || (!!nameSources && nameSources.some((c) => !isEmpty(get(c.id))));
  const complete = (name: string, get: (colId: string) => unknown) =>
    (!nameRequired || named(name, get)) && subColumns.every(({ f, c }) => !f.required || !isEmpty(get(c.id)));
  const have =
    children.filter((ch) => complete(ch.name, (id) => subValue(ch.id, ch.cells as Cells, id))).length +
    filledRows.filter((r) => complete(r.name, (id) => r.cells[id])).length;
  const total = children.length + filledRows.length;
  const min = sub?.min ?? 0;

  const save = async () => {
    const missing = fields.filter(({ f, c }) => f.required && isEmpty(valueOf(c))).map(({ c }) => c.title);
    if (missing.length) return setError(t('popup.missing', { columns: missing.join(', ') }));
    if (sub) {
      const requiredTitles = [
        ...(nameRequired ? [nameTitle] : []),
        ...subColumns.filter(({ f }) => f.required).map(({ c }) => c.title),
      ].join(', ');
      if (filledRows.some((r) => !named(r.name, (id) => r.cells[id])))
        return setError(
          t('popup.missing', {
            columns: nameSources?.length ? nameSources.map((c) => c.title).join(', ') : nameTitle,
          }),
        );
      if (have < min)
        return setError(
          requiredTitles
            ? t('popup.subitems.missing', { min, columns: requiredTitles })
            : t('popup.subitems.missingCount', { min }),
        );
      if (sub.all && have < total) return setError(t('popup.subitems.incomplete', { columns: requiredTitles }));
    }
    if (noteMode === 'required' && !note.trim()) return setError(t('popup.noteMissing'));
    const update = Object.entries(subDraft)
      .filter(([, cells]) => Object.keys(cells).length)
      .map(([id, cells]) => ({ id, cells }));
    const create = filledRows.map((r) => ({
      ...(r.name.trim() ? { name: r.name.trim() } : {}),
      cells: Object.fromEntries(Object.entries(r.cells).filter(([, v]) => !isEmpty(v))),
    }));
    setBusy(true);
    setError(null);
    try {
      await onSubmit(
        draft,
        noteMode !== 'off' && note.trim() ? note.trim() : undefined,
        update.length || create.length
          ? { ...(update.length ? { update } : {}), ...(create.length ? { create } : {}) }
          : undefined,
      );
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (gated) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={popup.title || title}
      subtitle={subtitle}
      className={sub ? 'max-w-3xl!' : 'max-w-lg!'}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} data-testid="popup-cancel">
            {t('popup.cancel')}
          </Button>
          <Button busy={busy} onClick={() => void save()} data-testid="popup-save">
            {t('popup.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3" data-testid="popup-dialog">
        {move?.message && checks.some((x) => !x.met) ? (
          <Notice tone="warn">
            <span data-testid="popup-move-message">{move.message}</span>
          </Notice>
        ) : null}
        <MoveChecklist checks={checks} any={any} />
        {fields.map(({ f, c }) => (
          <div key={c.id} className="flex flex-col gap-1" data-testid="popup-input" data-column={c.id}>
            <span className="text-xs text-fg-2">
              {c.title}
              {f.required ? <span className="text-danger-fg"> *</span> : null}
            </span>
            <DraftCell
              accountId={accountId}
              boardId={board.id}
              itemId={itemId}
              column={c}
              value={valueOf(c)}
              savedText={c.id in draft ? undefined : (rowCells[c.id]?.text ?? null)}
              rowCells={rowCells}
              members={members}
              onChange={(value) => {
                setDraft((d) => ({ ...d, [c.id]: value }));
                setError(null);
              }}
            />
          </div>
        ))}
        {sub ? (
          <section className="space-y-1.5" data-testid="popup-subitems">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-fg-2">{t('popup.subitems.title')}</span>
              {min > 0 ? (
                <span
                  className={cn('text-xs', have >= min ? 'text-ok-fg' : 'text-fg-2')}
                  data-testid="popup-subitems-count"
                >
                  {t('popup.subitems.count', { have, min })}
                  {have >= min ? ' ✓' : ''}
                </span>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-2 text-xs text-fg-2">
                    {showName ? (
                      <th className="px-2 py-1 text-start font-normal">
                        {nameTitle}
                        {nameRequired ? <span className="text-danger-fg"> *</span> : null}
                      </th>
                    ) : null}
                    {subColumns.map(({ f, c }) => (
                      <th key={c.id} className="min-w-32 px-2 py-1 text-start font-normal">
                        {c.title}
                        {f.required ? <span className="text-danger-fg"> *</span> : null}
                      </th>
                    ))}
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {children.map((ch) => {
                    const cells = ch.cells as Cells;
                    return (
                      <tr key={ch.id} className="border-t border-line" data-testid="popup-subitem-row">
                        {showName ? <td className="max-w-48 truncate px-2 py-1">{ch.name}</td> : null}
                        {subColumns.map(({ c }) => {
                          const touched = c.id in (subDraft[ch.id] ?? {});
                          return (
                            <td key={c.id} className="px-1 py-1" data-column={c.id}>
                              <DraftCell
                                accountId={accountId}
                                boardId={subId}
                                itemId={ch.id}
                                column={c}
                                value={subValue(ch.id, cells, c.id)}
                                savedText={touched ? undefined : (cells[c.id]?.text ?? null)}
                                rowCells={cells}
                                members={members}
                                onChange={(value) => {
                                  setSubDraft((d) => ({ ...d, [ch.id]: { ...d[ch.id], [c.id]: value } }));
                                  setError(null);
                                }}
                              />
                            </td>
                          );
                        })}
                        <td />
                      </tr>
                    );
                  })}
                  {rows.map((r) => (
                    <tr key={r.key} className="border-t border-line" data-testid="popup-subitem-new">
                      {showName ? (
                        <td className="px-1 py-1">
                          {nameSources ? (
                            <span className="px-1 text-xs text-muted" data-testid="popup-subitem-name-computed">
                              ƒ {t('popup.subitems.nameComputed')}
                            </span>
                          ) : (
                            <Input
                              value={r.name}
                              maxLength={255}
                              placeholder={t('popup.subitems.new')}
                              aria-label={nameTitle}
                              data-testid="popup-subitem-name"
                              onChange={(e) => {
                                const name = e.target.value;
                                setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, name } : x)));
                                setError(null);
                              }}
                            />
                          )}
                        </td>
                      ) : null}
                      {subColumns.map(({ c }) => (
                        <td key={c.id} className="px-1 py-1" data-column={c.id}>
                          <DraftCell
                            accountId={accountId}
                            boardId={subId}
                            itemId={itemId}
                            column={c}
                            value={r.cells[c.id] ?? null}
                            savedText={undefined}
                            rowCells={{}}
                            members={members}
                            onChange={(value) => {
                              setRows((rs) =>
                                rs.map((x) => (x.key === r.key ? { ...x, cells: { ...x.cells, [c.id]: value } } : x)),
                              );
                              setError(null);
                            }}
                          />
                        </td>
                      ))}
                      <td className="px-1 text-center">
                        <button
                          type="button"
                          aria-label={t('popup.subitems.remove')}
                          data-testid="popup-subitem-remove"
                          className="cursor-pointer px-1 text-muted hover:text-fg"
                          onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!children.length && !rows.length ? (
                    <tr>
                      <td colSpan={subColumns.length + 2} className="px-2 py-2 text-xs text-muted">
                        {t('popup.subitems.none')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {children.length + rows.length < SUBITEMS_MAX ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="popup-subitems-add"
                onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, name: '', cells: {} }])}
              >
                {t('popup.subitems.add')}
              </Button>
            ) : null}
          </section>
        ) : null}
        {noteMode !== 'off' ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-2">
              {t('popup.noteLabel')}
              {noteMode === 'required' ? <span className="text-danger-fg"> *</span> : null}
            </span>
            <textarea
              value={note}
              rows={3}
              maxLength={POPUP_NOTE_MAX}
              data-testid="popup-note"
              onChange={(e) => {
                setNote(e.target.value);
                setError(null);
              }}
              className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm outline-none focus:border-primary"
            />
          </label>
        ) : null}
        {error ? (
          <p className="text-sm text-danger-fg" role="alert" data-testid="popup-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
};
