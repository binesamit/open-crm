// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  DEFAULT_DATE_TIME,
  formatTimeline,
  formulaHref,
  localDateValue,
  nextLabelId,
  OVERDUE_RED,
  movePopup,
  moveTransition,
  reachableLabels,
  paint,
  rangeDays,
  showDayMarks,
  storedDateValue,
  t,
  timelineOverdue,
  timelineProgress,
  todayIn,
  type Column,
  type DateRange,
  type StatusLabel,
  type ItemPopup,
  type StatusWorkflow,
  type WorkflowTransition,
  type TimelineSettings,
  workflowOn,
} from '@bines/shared';
import { autoFocusSearch, Avatar, Calendar, cn, TimeField } from '@bines/ui';
import { type Member, useBoard, useTeams } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { PopupDialog } from '../workflow/popup';
import { api } from '../../../lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { tagVars } from '../../../lib/label-color';
import { confirmDialog } from '../../../lib/dialogs';
import { showToast } from '../../../lib/toast';
import { Popover, PopoverSheetContext } from './Popover';
import { StatusPicker } from './StatusPicker';
import { statusPickerLayout, type StatusPickerLayout } from './status-picker-layout';
import { RelationCell } from './RelationCell';
import { DependencyCell } from './DependencyCell';
import { TextCell } from './TextCell';
import { TimeCell } from './TimeCell';
import { FileCell } from './FileCell';
import { TagsCell } from './TagsCell';
import { VoteCell } from './VoteCell';
import { SecretCell } from './SecretCell';
import { SignatureCell } from '../../idocs/SignatureCell';
import { MirrorCell } from './MirrorCell';
import { DocCell } from '../../docs/DocCell';
import {
  ButtonCell,
  ColorCell,
  CountryCell,
  HourCell,
  LocationCell,
  ProgressCell,
  WeekCell,
  WorldClockCell,
} from './P1Cells';
import { EmailLink } from './EmailLink';
import { LabelEditor, type EditableLabel } from './LabelEditor';
import { AiCell } from '../../ai2/AiCell';
import { SearchClear } from '../../../lib/search-clear';
import { PhoneNumber } from '../../phone/PhoneCell';
import { cellHebrewText, cellShowsHebrew, spanDuration } from '../day-text';

/**
 * Web side of the column registry (CLAUDE.md "How to add a column type": renderer/editor per type).
 * A map from type → component; unknown or read-only types fall back to plain text.
 */
export type CellProps = {
  column: Column;
  value: unknown;
  text: string | null;
  /** Relation / dependency cells: the linked items' names, aligned with `value.item_ids` (never split `text`). */
  names?: string[];
  editable: boolean;
  /** `opts.workflowOverride`: a status move past the column's workflow, on purpose (owners and admins). */
  onChange: (value: unknown, opts?: { workflowOverride?: boolean }) => void;
  members: Member[];
  accountId: string;
  itemId: string;
  boardId: string;
  /** May change the column's settings (labels) from the cell — `column.update` on the board. */
  canEditSettings: boolean;
  onSettingsChange: (settings: Record<string, unknown>) => Promise<unknown>;
  /** The board's owner or an admin (`board.update`): may pass a status workflow's block on purpose. */
  canManageBoard?: boolean;
  /** The other cells of the row (a phone cell reads its Telegram username column). Optional. */
  rowCells?: Record<string, { value: unknown; text: string | null } | undefined>;
};

const base = 'relative flex h-full w-full items-center px-2 text-sm';
const clickable = (editable: boolean) => (editable ? 'cursor-pointer hover:bg-surface-2' : '');

/** Inline single-line editor used by text-like cells. */
export const InlineInput = ({
  initial,
  type = 'text',
  dir,
  onCommit,
  onCancel,
}: {
  initial: string;
  type?: string;
  dir?: 'ltr' | 'rtl';
  onCommit: (v: string) => void;
  onCancel: () => void;
}) => {
  const [v, setV] = useState(initial);
  // Enter commits and the input unmounts; Chrome then fires `blur` on the removed element — one commit only
  // (audit 2026-10-10 web #9: two PUTs, two activity rows, two Ctrl+Z steps).
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      e.preventDefault(); // the edit is cancelled; the item card around it stays open (round 13)
      done.current = true;
      onCancel();
    }
  };
  return (
    <input
      autoFocus
      type={type}
      dir={dir}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={onKey}
      onBlur={commit}
      className="h-full w-full border-2 border-primary bg-surface px-2 text-sm outline-none"
    />
  );
};

/** Text-ish cell: shows `text`, edits a string, converts with toValue (null clears). */
const makeInlineCell =
  (opts: {
    toInput: (value: unknown) => string;
    toValue: (input: string, column: Column) => unknown;
    type?: string;
    dir?: 'ltr' | 'rtl';
    href?: (value: unknown) => string | undefined;
  }) =>
  ({ column, value, text, editable, onChange }: CellProps) => {
    const [editing, setEditing] = useState(false);
    if (editing) {
      return (
        <InlineInput
          initial={value == null ? '' : opts.toInput(value)}
          type={opts.type}
          dir={opts.dir}
          onCancel={() => setEditing(false)}
          onCommit={(input) => {
            setEditing(false);
            const next = input.trim() === '' ? null : opts.toValue(input.trim(), column);
            if (JSON.stringify(next) !== JSON.stringify(value ?? null)) onChange(next);
          }}
        />
      );
    }
    const href = value != null ? opts.href?.(value) : undefined;
    return (
      <div className={cn(base, clickable(editable))} onClick={() => editable && setEditing(true)}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            dir={opts.dir}
            className="truncate text-primary underline"
            onClick={(e) => e.stopPropagation()}
          >
            {text}
          </a>
        ) : (
          <span className="truncate" dir={opts.dir}>
            {text}
          </span>
        )}
      </div>
    );
  };

const NumbersCell = makeInlineCell({
  toInput: (v) => String(v),
  toValue: (s) => Number(s),
  type: 'number',
  dir: 'ltr',
});
/**
 * Phone (03 §2.11): any length from 2 digits; the country comes from the column, never hard-coded. The number opens
 * its click actions (`PhoneNumber`); the cell around it (and Enter / F2) edits.
 */
const PhoneCell = ({ column, value, text, editable, onChange, accountId, itemId, rowCells }: CellProps) => {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <InlineInput
        initial={(value as { phone?: string } | null)?.phone ?? ''}
        type="tel"
        dir="ltr"
        onCancel={() => setEditing(false)}
        onCommit={(input) => {
          setEditing(false);
          const s = input.trim();
          const country = column.settings.default_country;
          const next = s === '' ? null : typeof country === 'string' ? { phone: s, country } : { phone: s };
          const prev = (value as { phone?: string } | null)?.phone ?? null;
          if ((next?.phone ?? null) !== prev) onChange(next);
        }}
      />
    );
  }
  const tgColumn = column.settings.telegram_username_column;
  const tg = typeof tgColumn === 'string' ? rowCells?.[tgColumn] : undefined;
  return (
    <div className={cn(base, clickable(editable))} onClick={() => editable && setEditing(true)}>
      {value != null ? (
        <PhoneNumber
          accountId={accountId}
          itemId={itemId}
          columnId={column.id}
          settings={column.settings}
          value={value}
          text={text}
          editable={editable}
          telegramRaw={typeof tg?.value === 'string' ? tg.value : (tg?.text ?? null)}
          onEdit={() => setEditing(true)}
        />
      ) : null}
    </div>
  );
};

/**
 * Address + display text (email 03 §2.10, link 03 §2.12, M1.1 #5): the cell shows the text (or the address)
 * as a link; the editor has both fields.
 */
const makeAddressCell = (opts: {
  key: 'email' | 'url';
  type: 'email' | 'url';
  normalize: (address: string) => string;
  href: (address: string) => string;
}) =>
  function AddressCell({ value, text, editable, onChange }: CellProps) {
    const [open, setOpen] = useState(false);
    const current = value as Record<string, string> | null;
    const [address, setAddress] = useState('');
    const [label, setLabel] = useState('');
    const save = () => {
      setOpen(false);
      const a = address.trim();
      const next = a ? { [opts.key]: opts.normalize(a), ...(label.trim() ? { text: label.trim() } : {}) } : null;
      if (JSON.stringify(next) !== JSON.stringify(current ?? null)) onChange(next);
    };
    return (
      <div
        className={cn(base, clickable(editable))}
        onClick={() => {
          if (!editable || open) return;
          setAddress(current?.[opts.key] ?? '');
          setLabel(current?.text ?? '');
          setOpen(true);
        }}
      >
        {current && opts.key === 'email' ? (
          // Gmail / Outlook / the mail app / copy — our menu, or straight to the chosen one.
          <EmailLink address={current.email!} text={text ?? current.email!} />
        ) : current ? (
          <a
            href={opts.href(current[opts.key]!)}
            target="_blank"
            rel="noreferrer"
            dir="auto"
            className="truncate text-primary underline"
            onClick={(e) => e.stopPropagation()}
          >
            {text}
          </a>
        ) : null}
        <Popover open={open} onClose={() => setOpen(false)} className="w-72">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="block space-y-1 text-xs text-muted">
              <span>{t(opts.key === 'email' ? 'cell.email.address' : 'cell.link.address')}</span>
              <input
                autoFocus
                type={opts.type}
                dir="ltr"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="h-8 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-2 text-sm text-fg"
              />
            </label>
            <label className="block space-y-1 text-xs text-muted">
              <span>{t('cell.displayText')}</span>
              <input
                value={label}
                placeholder={t('cell.displayText.hint')}
                onChange={(e) => setLabel(e.target.value)}
                className="h-8 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-2 text-sm text-fg"
              />
            </label>
            <div className="flex justify-end">
              <button type="submit" className="rounded-[var(--radius-sm)] bg-primary px-3 py-1 text-xs text-on-primary">
                {t('common.save')}
              </button>
            </div>
          </form>
        </Popover>
      </div>
    );
  };

const EmailCell = makeAddressCell({
  key: 'email',
  type: 'email',
  normalize: (a) => a,
  href: (a) => `mailto:${a}`,
});
const LinkCell = makeAddressCell({
  key: 'url',
  type: 'url',
  normalize: (a) => (/^https?:\/\//.test(a) ? a : `https://${a}`),
  href: (a) => a,
});

const LongTextCell = ({ value, text, editable, onChange }: CellProps) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <div
      className={cn(base, clickable(editable))}
      onClick={() => {
        if (!editable || open) return;
        setDraft((value as { text?: string } | null)?.text ?? '');
        setOpen(true);
      }}
    >
      <span className="truncate">{text}</span>
      <Popover open={open} onClose={() => setOpen(false)} className="w-80">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-40 w-full resize-none rounded-[var(--radius-sm)] border border-line bg-surface p-2 text-sm"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="rounded-[var(--radius-sm)] bg-primary px-3 py-1 text-xs text-on-primary"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onChange(draft.trim() ? { text: draft } : null);
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </Popover>
    </div>
  );
};

/** The "edit labels" mode both label cells share. */
const useLabelEditing = ({ column, onSettingsChange }: CellProps) => {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (labels: EditableLabel[], opts?: { leaving?: boolean }) => {
    setBusy(true);
    try {
      await onSettingsChange({ ...column.settings, labels });
      // Saved on leaving: the editor is closed already and may be open again by now.
      if (!opts?.leaving) setEditing(false);
    } catch {
      // The board shows the mutation error; the editor stays open with the user's changes.
    } finally {
      setBusy(false);
    }
  };
  return { editing, setEditing, busy, save };
};

const EditLabelsButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full cursor-pointer rounded-[var(--radius-sm)] px-2 py-1 text-start text-xs text-muted hover:bg-surface-2 hover:text-fg"
  >
    ✎ {t('labels.edit')}
  </button>
);

/** Round 2: a move the app checks before sending it (its conditions or required columns may be missing). */
const gatedMove = (t: WorkflowTransition) => !!(t.conditions?.rules.length || t.required?.length);

/** The popup a gated move opens when something is missing: its required columns (the conditions add theirs). */
const autoPopup = (t: WorkflowTransition, cells: CellProps['rowCells']): ItemPopup => ({
  fields: (t.required ?? [])
    .filter((k) => k !== 'name' && (cells?.[k]?.value ?? null) === null)
    .map((column_id) => ({ column_id, required: true })),
  note: 'off',
});

/** the owner's on-purpose move past the workflow (it is logged). */
const confirmOverride = () =>
  confirmDialog({
    title: t('workflow.override.title'),
    message: t('workflow.override.message'),
    confirmLabel: t('workflow.override.confirm'),
  });

const StatusCell = (props: CellProps) => {
  const { column, value, text, editable, onChange, canEditSettings, canManageBoard } = props;
  const [open, setOpen] = useState(false);
  const edit = useLabelEditing(props);
  const all = (column.settings.labels as StatusLabel[] | undefined) ?? [];
  const labels = all.filter((l) => !l.is_deactivated).sort((a, b) => a.index - b.index);
  const current = all.find((l) => l.id === (value as { index?: number } | null)?.index);
  // the column's workflow fades the labels a move from the current one may not reach.
  const workflow = column.settings.workflow as StatusWorkflow | undefined;
  // Moves limited to other people are faded too (the server checks again).
  const { meId } = useContext(BoardAccountContext);
  const teams = useTeams(props.accountId).data?.data ?? [];
  const myTeams = teams.filter((x) => x.member_ids.includes(meId)).map((x) => x.id);
  const reachable = workflowOn(workflow)
    ? reachableLabels(workflow, current?.id ?? null, meId ? { userId: meId, teamIds: myTeams } : undefined)
    : null;
  const blocked = reachable ? new Set(labels.filter((l) => !reachable.has(l.id)).map((l) => l.id)) : undefined;
  const mayOverride = !!canManageBoard && workflow?.allow_override !== false;
  const clearBlocked = workflowOn(workflow) && workflow.allow_clear === false && !!current;
  // Phase 2: the label whose move opened a popup (its values and the label are saved together).
  const [asking, setAsking] = useState<StatusLabel | null>(null);
  // Round 2: a move with conditions or required values and no popup of its own opens one only when something is
  // missing (the dialog checks, then makes the move straight away or asks).
  const askingMove = asking ? moveTransition(workflow, current?.id ?? null, asking.id) : null;
  const askingPopup = asking
    ? (movePopup(workflow, current?.id ?? null, asking.id) ??
      (askingMove && gatedMove(askingMove) ? autoPopup(askingMove, props.rowCells) : null))
    : null;
  const askingAuto = !!asking && !movePopup(workflow, current?.id ?? null, asking.id);
  const board = useBoard(props.accountId, props.boardId).data;
  const qc = useQueryClient();
  const cellRef = useRef<HTMLButtonElement>(null);
  // Phones keep the bottom sheet with one list (r12); elsewhere the labels flow into columns (pal40).
  const sheet = useContext(PopoverSheetContext);
  const [layout, setLayout] = useState<StatusPickerLayout | null>(null);
  const measure = () => {
    const r = cellRef.current?.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
    setLayout(statusPickerLayout(labels.length, r, viewport));
  };
  // The labels changed while open (edited, or by someone else): lay them out again.
  useEffect(() => {
    if (open) measure();
  }, [open, labels.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    setOpen(false);
    edit.setEditing(false);
  };
  const shown: StatusPickerLayout =
    sheet || !layout
      ? { ...statusPickerLayout(labels.length), columns: 1, rows: Math.max(1, labels.length), centred: false }
      : layout;
  // c9: the label editor shows the same columns, in the same place (beside the centre past two columns).
  const centred = !sheet && shown.centred;
  return (
    <div className="relative h-full w-full">
      <button
        ref={cellRef}
        type="button"
        data-cell-edit
        disabled={!editable}
        onClick={() => {
          if (!open) measure();
          setOpen((o) => !o);
        }}
        // Our label look ("ג2"): a strong tint of the label's colour fills the whole cell, edge to edge
        // the table's own lines separate neighbours — with the text in its deep shade; an empty cell is the empty fill.
        // `data-color` = the stored key. r16motion: `motion-color` crossfades the colour when the label changes.
        className="label-tag motion-color flex h-full w-full cursor-pointer rounded-none px-2 text-sm disabled:cursor-default"
        style={tagVars(current?.color)}
        data-color={current?.color}
        // An empty cell still says what it is to a screen reader (axe button-name).
        aria-label={current ? undefined : `${column.title}: ${t('filter.noStatus')}`}
      >
        <span className="truncate">{current ? (text ?? '') : ''}</span>
      </button>
      <Popover
        open={open}
        onClose={close}
        placement={centred ? 'centre' : 'anchor'}
        className={edit.editing ? undefined : shown.columns === 1 ? 'flex w-56 flex-col' : 'flex flex-col'}
      >
        {edit.editing ? (
          <LabelEditor
            labels={all}
            withColor
            maxLength={30}
            busy={edit.busy}
            onSave={(l, o) => void edit.save(l, o)}
            onCancel={() => edit.setEditing(false)}
          />
        ) : (
          <StatusPicker
            labels={labels}
            currentId={current?.id}
            layout={shown}
            onPick={(l) => {
              close();
              // Phase 2: a move with a popup asks for its values first; they go with the move in one write.
              const mv = moveTransition(workflow, current?.id ?? null, l.id);
              if (movePopup(workflow, current?.id ?? null, l.id) || (mv && gatedMove(mv))) setAsking(l);
              else onChange({ index: l.id });
            }}
            blocked={blocked}
            onPickBlocked={
              mayOverride
                ? (l) => {
                    close();
                    void confirmOverride().then((ok) => ok && onChange({ index: l.id }, { workflowOverride: true }));
                  }
                : undefined
            }
            onClear={() => {
              close();
              if (!clearBlocked) onChange(null);
              else if (mayOverride)
                void confirmOverride().then((ok) => ok && onChange(null, { workflowOverride: true }));
              else showToast({ message: t('error.workflow_blocked.not_allowed'), tone: 'error' });
            }}
            footer={canEditSettings ? <EditLabelsButton onClick={() => edit.setEditing(true)} /> : null}
          />
        )}
      </Popover>
      {asking && askingPopup && board ? (
        <PopupDialog
          accountId={props.accountId}
          board={board}
          itemId={props.itemId}
          rowCells={props.rowCells ?? {}}
          popup={askingPopup}
          title={t('popup.moveTitle', { label: asking.label })}
          move={askingMove ?? undefined}
          onPass={
            askingAuto
              ? () => {
                  setAsking(null);
                  onChange({ index: asking.id });
                }
              : undefined
          }
          onClose={() => setAsking(null)}
          onSubmit={async (cells, note, subitems) => {
            await api(props.accountId).patch(`/items/${props.itemId}`, {
              cells: { ...cells, [column.id]: { index: asking.id } },
              ...(note ? { note } : {}),
              ...(subitems ? { subitems } : {}),
            });
            await qc.invalidateQueries({ queryKey: ['account', props.accountId, 'board', props.boardId, 'items'] });
            // subitems added or filled in from the popup.
            if (subitems && board?.subitems_board_id)
              await qc.invalidateQueries({
                queryKey: ['account', props.accountId, 'board', board.subitems_board_id, 'items'],
              });
          }}
        />
      ) : null}
    </div>
  );
};

type DropdownLabel = { id: number; label: string; is_deactivated?: boolean };

/** Dropdown (03 §2.6): search, toggle, type + Enter to create a label, and the shared label editor. */
const DropdownCell = (props: CellProps) => {
  const { column, value, editable, onChange, canEditSettings, onSettingsChange } = props;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const edit = useLabelEditing(props);
  const all = (column.settings.labels as DropdownLabel[] | undefined) ?? [];
  const labels = all.filter((l) => !l.is_deactivated);
  const ids = (value as { ids?: number[] } | null)?.ids ?? [];
  const limit = column.settings.limit_select ? Number(column.settings.label_limit_count ?? 0) : 0;
  const canCreate = canEditSettings && column.settings.allow_create !== 'none';
  const query = q.trim();
  const shown = labels.filter((l) => l.label.toLowerCase().includes(query.toLowerCase()));
  const exact = labels.find((l) => l.label === query);

  const toggle = (id: number) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : limit === 1 ? [id] : [...ids, id];
    if (limit > 1 && next.length > limit) return;
    onChange(next.length ? { ids: next } : null);
  };
  // The label must exist before the cell may reference it (server validates label_not_found).
  // One at a time: the next label id comes from the refreshed column, never from a stale list.
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const id = nextLabelId(all);
      await onSettingsChange({ ...column.settings, labels: [...all, { id, label: query.slice(0, 100) }] });
      setQ('');
      onChange({ ids: limit === 1 ? [id] : [...ids, id] });
    } catch {
      // Shown by the board's mutation error.
    } finally {
      setCreating(false);
    }
  };
  const close = () => {
    setOpen(false);
    setQ('');
    edit.setEditing(false);
  };

  return (
    <div className={cn(base, clickable(editable))} onClick={() => editable && setOpen(true)}>
      <span className="flex min-w-0 gap-1 overflow-hidden" data-testid="cell-value">
        {ids.map((id) => (
          <span key={id} className="truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs">
            {all.find((l) => l.id === id)?.label}
          </span>
        ))}
      </span>
      <Popover open={open} onClose={close} className={edit.editing ? undefined : 'w-60'}>
        {edit.editing ? (
          <LabelEditor
            labels={all}
            withColor={false}
            maxLength={100}
            busy={edit.busy}
            onSave={(l, o) => void edit.save(l, o)}
            onCancel={() => edit.setEditing(false)}
          />
        ) : (
          <>
            <div className="relative mb-1">
              <input
                autoFocus={autoFocusSearch()}
                value={q}
                placeholder={canCreate ? t('labels.searchOrCreate') : t('labels.search')}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !query || creating) return;
                  if (exact) {
                    toggle(exact.id);
                    setQ('');
                  } else if (canCreate) void create();
                }}
                className="w-full rounded border border-line px-2 py-1 text-sm pe-7"
              />
              <SearchClear value={q} onClear={() => setQ('')} testId="labels-search-clear" />
            </div>
            <div className="max-h-56 overflow-auto">
              {shown.map((l) => (
                <label
                  key={l.id}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-sm hover:bg-surface-2"
                >
                  <input type="checkbox" checked={ids.includes(l.id)} onChange={() => toggle(l.id)} />
                  <span className="truncate">{l.label}</span>
                </label>
              ))}
              {!labels.length && !query ? <p className="px-2 py-1 text-xs text-muted">{t('labels.none')}</p> : null}
            </div>
            {query && !exact && canCreate ? (
              <button
                type="button"
                disabled={creating}
                onClick={() => void create()}
                className="w-full truncate rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm text-primary hover:bg-surface-2"
              >
                + {t('labels.create', { label: query })}
              </button>
            ) : null}
            {ids.length ? (
              <button
                type="button"
                onClick={() => onChange(null)}
                className="w-full rounded-[var(--radius-sm)] px-2 py-1 text-start text-xs text-muted hover:bg-surface-2"
              >
                {t('board.clear')}
              </button>
            ) : null}
            {canEditSettings ? <EditLabelsButton onClick={() => edit.setEditing(true)} /> : null}
          </>
        )}
      </Popover>
    </div>
  );
};

/**
 * Date (03 §2.7). with "include time" (`show_time`) — or a value that already has one — the picker
 * also holds a time (our TimeField, never a native input). The date and time are the viewer's region (a stored time
 * is UTC); they are saved once, when the picker closes on an outside click — Esc discards them, like a text cell's
 * edit. Without a time a picked day saves and closes at once.
 */
const DateCell = ({ value, text, editable, onChange, column }: CellProps) => {
  const [open, setOpen] = useState(false);
  const stored = value as { date?: string; time?: string } | null;
  const current = stored?.date
    ? localDateValue({ date: stored.date, ...(stored.time ? { time: stored.time } : {}) })
    : null;
  const withTime = column.settings.show_time === true || !!current?.time;
  const defaultTime =
    typeof column.settings.default_time === 'string' ? column.settings.default_time : DEFAULT_DATE_TIME;
  const [draft, setDraft] = useState<{ date: string | null; time?: string }>({ date: null });
  const save = (date: string | null, time?: string) => {
    const next = date ? storedDateValue(date, time) : null;
    if (JSON.stringify(next) !== JSON.stringify(value ?? null)) onChange(next);
  };
  const close = () => {
    setOpen(false);
    if (withTime && (draft.date !== (current?.date ?? null) || draft.time !== current?.time))
      save(draft.date, draft.time);
  };
  // the Hebrew date as a small second line (the column's choice, else the account's).
  const hebrew =
    current?.date && cellShowsHebrew(column.settings.hebrew_date as 'account' | 'on' | 'off' | undefined)
      ? cellHebrewText(current.date)
      : '';
  return (
    <div
      className={cn(base, 'justify-center', hebrew && 'flex-col gap-0.5', clickable(editable))}
      onClick={() => {
        if (!editable || open) return;
        setDraft({ date: current?.date ?? null, ...(current?.time ? { time: current.time } : {}) });
        setOpen(true);
      }}
    >
      <span dir="ltr" className={cn(hebrew && 'leading-tight')}>
        {text}
      </span>
      {hebrew ? (
        <span data-testid="date-hebrew" className="truncate text-[0.6875rem] leading-none font-normal text-muted">
          {hebrew}
        </span>
      ) : null}
      <Popover open={open} onClose={close} onEscape={() => setOpen(false)}>
        <Calendar
          mode="single"
          dayMarks={showDayMarks(column.settings.day_marks as 'account' | 'on' | 'off' | undefined)}
          value={withTime ? draft.date : (current?.date ?? null)}
          onChange={(date) => {
            if (withTime && date) {
              setDraft((d) => ({ ...d, date }));
              return;
            }
            setOpen(false);
            // Keeps an existing time (03 §2.7: value.time is optional).
            save(date, date ? current?.time : undefined);
          }}
        />
        {withTime && draft.date ? (
          <div
            data-testid="date-time-row"
            className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-sm font-normal"
          >
            <span className="text-muted">{t('dateCell.time')}</span>
            {draft.time ? (
              <>
                <TimeField
                  value={draft.time}
                  onChange={(time) => setDraft((d) => ({ ...d, time }))}
                  label={t('dateCell.time')}
                  testId="date-time-field"
                  hourLabel={t('time.hours')}
                  minuteLabel={t('time.minutes')}
                />
                <button
                  type="button"
                  data-testid="date-remove-time"
                  onClick={() => setDraft((d) => ({ date: d.date }))}
                  className="rounded-[var(--radius-sm)] px-2 py-1 text-xs text-muted hover:bg-surface-2"
                >
                  {t('dateCell.removeTime')}
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="date-add-time"
                onClick={() => setDraft((d) => ({ ...d, time: defaultTime }))}
                className="rounded-[var(--radius-sm)] px-2 py-1 text-primary hover:bg-surface-2"
              >
                + {t('dateCell.addTime')}
              </button>
            )}
          </div>
        ) : null}
      </Popover>
    </div>
  );
};

/**
 * Timeline (03 §2.8): a pill `DD/MM – DD/MM` (year only across years), filled by how much has passed. Owner fix
 * (fix5-board 3): the pill always shows the dates; the number of days is a small bubble above it while hovered
 * in the page's own direction, never inside the pill's LTR text ("ימים 8" read oddly there).
 * fix6-table 1: the bubble lives in a portal so the sticky header / other columns never cover it.
 * Saves as soon as both ends are picked; the picker stays open until clicked away.
 */
const TimelineCell = ({ value, editable, onChange, column, rowCells, accountId, boardId }: CellProps) => {
  const [open, setOpen] = useState(false);
  const [today] = useState(() => todayIn());
  const v = value as { from: string; to: string; from_time?: string; to_time?: string; milestone?: boolean } | null;
  // r26: past its end and not done = the overdue red (the column's settings, linked status).
  const settings = column.settings as TimelineSettings;
  const linked = !!settings.status_column_id;
  const board = useBoard(accountId, linked ? boardId : '').data;
  const overdue = timelineOverdue(v, settings, {
    today,
    cells: rowCells,
    ...(linked && board ? { columns: board.columns } : {}),
  });
  const [draft, setDraft] = useState<DateRange & { from_time?: string; to_time?: string }>({ from: null, to: null });
  // "with hours" — a start and an end time (wall-clock), saved when the picker closes.
  const withTime = settings.show_time === true || !!v?.from_time;
  const saveDraft = () => {
    if (!draft.from || !draft.to) return;
    const { from_time } = draft;
    let { to_time } = draft;
    // One day: the end after the start (an hour later when it is not).
    if (from_time && to_time && draft.from === draft.to && to_time <= from_time) {
      const end = Math.min(23 * 60 + 59, Number(from_time.slice(0, 2)) * 60 + Number(from_time.slice(3, 5)) + 60);
      to_time = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
    }
    const next = {
      from: draft.from,
      to: draft.to,
      ...(v?.milestone ? { milestone: true } : {}),
      ...(from_time && to_time ? { from_time, to_time } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(v ?? null)) onChange(next);
  };
  const times = v?.from_time && v.to_time ? `${v.from_time}–${v.to_time}` : '';
  const days = v ? rangeDays(v.from, v.to) : 0;
  // the length counted in the column's mode (working days…); shown after the pill when asked.
  const counted = v ? spanDuration(v.from, v.to, settings) : null;
  const daysText = counted ? counted.text : days === 1 ? t('timeline.oneDay') : t('timeline.days', { n: days });
  const hebrew = v && cellShowsHebrew(settings.hebrew_date) ? cellHebrewText(v.from, v.to) : '';
  // The hovered pill's box: the days bubble is placed from it (fixed, in a portal).
  const [tip, setTip] = useState<DOMRect | null>(null);
  // A scroll moves the pill away from the bubble: hide it until the next hover.
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [tip]);
  return (
    <div
      className={cn(base, 'justify-center', hebrew && 'flex-col gap-0.5', clickable(editable))}
      onClick={() => {
        if (!editable || open) return;
        setDraft({
          from: v?.from ?? null,
          to: v?.to ?? null,
          ...(v?.from_time ? { from_time: v.from_time, to_time: v.to_time } : {}),
        });
        setOpen(true);
      }}
    >
      {v ? (
        <span className="flex w-full min-w-0 items-center justify-center gap-1.5">
          <span
            className="relative flex w-full max-w-44 min-w-0 justify-center"
            onMouseEnter={(e) => setTip(e.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => setTip(null)}
          >
            <span
              dir="ltr"
              data-testid="timeline-pill"
              data-overdue={overdue || undefined}
              className="relative flex h-6 w-full items-center justify-center overflow-hidden rounded-full bg-[var(--bar-track)] px-2 text-xs font-normal text-[var(--on-bar)]"
              style={overdue ? { backgroundColor: paint(OVERDUE_RED), color: 'var(--on-c)' } : undefined}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 start-0 bg-[var(--bar)]"
                style={
                  overdue
                    ? { width: '100%', backgroundColor: paint(OVERDUE_RED) }
                    : { width: `${timelineProgress(v.from, v.to, today) * 100}%` }
                }
              />
              {overdue ? (
                <span aria-hidden className="relative me-1">
                  !
                </span>
              ) : null}
              <span className="relative truncate tabular-nums" data-testid="timeline-text">
                {formatTimeline(v.from, v.to, today)}
                {times ? ` ${times}` : ''}
              </span>
            </span>
            {tip
              ? createPortal(
                  // fix6-table 1: in a portal on body (fixed), above the sticky header and the neighbouring cells —
                  // below the pill when there is no room above it (the first row under the header).
                  <span
                    role="tooltip"
                    data-testid="timeline-days"
                    className="pointer-events-none fixed z-popover whitespace-nowrap rounded-[6px] bg-heading px-2 py-0.5 text-[0.6875rem] font-semibold text-surface shadow-md"
                    style={{
                      left: tip.left + tip.width / 2,
                      ...(tip.top < 32
                        ? { top: tip.bottom + 4, transform: 'translateX(-50%)' }
                        : { top: tip.top - 4, transform: 'translate(-50%, -100%)' }),
                    }}
                  >
                    {daysText}
                    {overdue ? ` · ${t('r26.timeline.overdue')}` : ''}
                  </span>,
                  document.body,
                )
              : null}
          </span>
          {settings.show_duration ? (
            <span data-testid="timeline-duration" className="shrink-0 text-xs font-normal whitespace-nowrap text-muted">
              · {daysText}
            </span>
          ) : null}
        </span>
      ) : null}
      {hebrew ? (
        <span data-testid="timeline-hebrew" className="truncate text-[0.6875rem] leading-none font-normal text-muted">
          {hebrew}
        </span>
      ) : null}
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          if (withTime) saveDraft();
        }}
        onEscape={() => setOpen(false)}
      >
        <Calendar
          mode="range"
          dayMarks={showDayMarks(settings.day_marks)}
          value={draft}
          onChange={(next) => {
            setDraft((d) => ({ ...d, ...next }));
            if (withTime) {
              if (!next.from && v) onChange(null);
              return;
            }
            if (next.from && next.to) onChange({ from: next.from, to: next.to });
            else if (!next.from && v) onChange(null);
          }}
        />
        {withTime && draft.from && draft.to ? (
          <div
            data-testid="timeline-time-row"
            className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-sm font-normal"
          >
            <span className="text-muted">{t('timelineCell.hours')}</span>
            {draft.from_time ? (
              <>
                <span dir="ltr" className="flex items-center gap-1.5">
                  <TimeField
                    value={draft.from_time}
                    onChange={(from_time) => setDraft((d) => ({ ...d, from_time }))}
                    label={t('timelineCell.start')}
                    testId="timeline-start-time"
                    hourLabel={t('time.hours')}
                    minuteLabel={t('time.minutes')}
                  />
                  –
                  <TimeField
                    value={draft.to_time ?? draft.from_time}
                    onChange={(to_time) => setDraft((d) => ({ ...d, to_time }))}
                    label={t('timelineCell.end')}
                    testId="timeline-end-time"
                    hourLabel={t('time.hours')}
                    minuteLabel={t('time.minutes')}
                  />
                </span>
                <button
                  type="button"
                  data-testid="timeline-remove-time"
                  onClick={() => setDraft((d) => ({ from: d.from, to: d.to }))}
                  className="rounded-[var(--radius-sm)] px-2 py-1 text-xs text-muted hover:bg-surface-2"
                >
                  {t('dateCell.removeTime')}
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="timeline-add-time"
                onClick={() => setDraft((d) => ({ ...d, from_time: DEFAULT_DATE_TIME, to_time: '10:00' }))}
                className="rounded-[var(--radius-sm)] px-2 py-1 text-primary hover:bg-surface-2"
              >
                + {t('timelineCell.addHours')}
              </button>
            )}
          </div>
        ) : null}
      </Popover>
    </div>
  );
};

/** People (03 §2.9, M1.1 #6): profile photos (initials fallback) in the cell, the chosen list and the picker. */
const PeopleCell = ({ value, editable, onChange, members, accountId }: CellProps) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const teams = useTeams(accountId).data?.data ?? [];
  const people = (value as { persons_and_teams?: { id: string; kind: string }[] } | null)?.persons_and_teams ?? [];
  const ids = people.map((p) => p.id);
  const toggle = (id: string, kind: 'person' | 'team' = 'person') => {
    const next = ids.includes(id) ? people.filter((p) => p.id !== id) : [...people, { id, kind }];
    onChange(next.length ? { persons_and_teams: next } : null);
  };
  const member = (id: string) => members.find((m) => m.user_id === id);
  const team = (id: string) => teams.find((x) => x.id === id);
  const nameOf = (id: string) => member(id)?.name || member(id)?.email || team(id)?.name || '?';
  const shownTeams = teams.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className={cn(base, 'justify-center', clickable(editable))} onClick={() => editable && setOpen(true)}>
      <span className="flex items-center" data-testid="cell-value">
        {ids.slice(0, 3).map((id, i) => (
          <Avatar
            key={id}
            name={nameOf(id)}
            url={member(id)?.avatar_url}
            size={26}
            className={cn('ring-2 ring-[var(--surface)]', i > 0 && '-ms-1.5')}
          />
        ))}
        {ids.length > 3 ? <span className="ms-1 text-xs text-muted">+{ids.length - 3}</span> : null}
      </span>
      <Popover open={open} onClose={() => setOpen(false)} className="w-64">
        {/* Built only while open: hundreds of members × every row of the board otherwise (each render). */}
        {open ? (
          <>
            {ids.length ? (
              <div className="mb-2 flex flex-wrap gap-1 border-b border-line pb-2">
                {ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={t('people.remove', { name: nameOf(id) })}
                    className="flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pe-2 ps-0.5 text-xs hover:bg-primary-soft"
                  >
                    <Avatar name={nameOf(id)} url={member(id)?.avatar_url} size={18} />
                    <span className="max-w-24 truncate">{nameOf(id)}</span>
                    <span aria-hidden className="text-muted">
                      ✕
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="relative mb-2">
              <input
                autoFocus={autoFocusSearch()}
                placeholder={t('board.searchPeople')}
                data-testid="people-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full rounded border border-line px-2 py-1 text-sm pe-7"
              />
              <SearchClear value={q} onClear={() => setQ('')} testId="people-search-clear" />
            </div>
            <div className="max-h-56 overflow-auto">
              {shownTeams.length ? (
                <>
                  <p className="px-2 pb-1 pt-0.5 text-[0.6875rem] font-medium text-muted">{t('teams.title')}</p>
                  {shownTeams.map((x) => (
                    <label
                      key={x.id}
                      data-testid="people-team"
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
                    >
                      <input type="checkbox" checked={ids.includes(x.id)} onChange={() => toggle(x.id, 'team')} />
                      <Avatar name={x.name} size={24} />
                      <span className="min-w-0 flex-1 truncate">{x.name}</span>
                      <span className="text-[0.6875rem] text-muted">
                        {t('teams.count', { n: x.member_ids.length })}
                      </span>
                    </label>
                  ))}
                  <p className="px-2 pb-1 pt-2 text-[0.6875rem] font-medium text-muted">{t('teams.people')}</p>
                </>
              ) : null}
              {members
                .filter(
                  (m) =>
                    m.status === 'active' &&
                    (!m.agent || m.agent.assign) &&
                    `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase()),
                )
                .map((m) => (
                  <label
                    key={m.user_id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
                    data-testid={m.agent ? 'people-agent' : undefined}
                  >
                    <input type="checkbox" checked={ids.includes(m.user_id)} onChange={() => toggle(m.user_id)} />
                    <Avatar name={m.agent?.avatar || m.name || m.email} url={m.avatar_url} size={24} />
                    <span className="min-w-0 flex-1 truncate">{m.name || m.email}</span>
                    {m.agent ? (
                      <span className="shrink-0 rounded-full bg-violet-soft px-1.5 text-[0.6875rem] font-normal text-violet-fg">
                        {t('agents.digitalWorker')}
                      </span>
                    ) : null}
                  </label>
                ))}
            </div>
          </>
        ) : null}
      </Popover>
    </div>
  );
};

const CheckboxCell = ({ value, editable, onChange }: CellProps) => {
  const checked = !!(value as { checked?: boolean } | null)?.checked;
  return (
    <div className={cn(base, 'justify-center')}>
      <input
        type="checkbox"
        aria-label={t('cell.checkbox')}
        disabled={!editable}
        checked={checked}
        onChange={() => onChange(checked ? null : { checked: true })}
        className="size-4 cursor-pointer accent-[var(--check)] disabled:cursor-default"
      />
    </div>
  );
};

const RatingCell = ({ column, value, editable, onChange }: CellProps) => {
  const max = Number(column.settings.max ?? 5);
  const rating = (value as { rating?: number } | null)?.rating ?? 0;
  return (
    <div className={cn(base, 'justify-center gap-0.5')} dir="ltr">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          disabled={!editable}
          onClick={() => onChange(n === rating ? null : { rating: n })}
          className={cn(
            'cursor-pointer text-base leading-none disabled:cursor-default',
            n <= rating ? 'text-[var(--rating)]' : 'text-[var(--mark-off)]',
          )}
        >
          ★
        </button>
      ))}
    </div>
  );
};

const ReadOnlyCell = ({ column, text }: CellProps) => (
  <div className={cn(base, 'text-muted')} title={t('board.readOnly')}>
    <span className="truncate" dir={column.type === 'item_id' ? 'ltr' : 'auto'}>
      {text}
    </span>
  </div>
);

/**
 * Fix: — a formula whose result is a web address is a link (the column's "show as link": auto / on / off).
 * Only http(s) (`formulaHref`), opened in a new tab without access back to this page.
 */
const FormulaCell = (props: CellProps) => {
  const href = formulaHref((props.value as { result?: unknown } | null)?.result, props.column.settings);
  if (!href) return <ReadOnlyCell {...props} />;
  return (
    <div className={base} data-link="true">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        dir="ltr"
        title={href}
        data-testid="formula-link"
        className="truncate text-primary underline"
        onClick={(e) => e.stopPropagation()}
      >
        {props.text || href}
      </a>
    </div>
  );
};

export const CELLS: Record<string, ComponentType<CellProps>> = {
  text: TextCell,
  long_text: LongTextCell,
  numbers: NumbersCell,
  status: StatusCell,
  dropdown: DropdownCell,
  date: DateCell,
  timeline: TimelineCell,
  people: PeopleCell,
  email: EmailCell,
  phone: PhoneCell,
  link: LinkCell,
  checkbox: CheckboxCell,
  rating: RatingCell,
  board_relation: RelationCell,
  dependency: DependencyCell,
  file: FileCell,
  time_tracking: TimeCell,
  tags: TagsCell,
  vote: VoteCell,
  doc: DocCell,
  button: ButtonCell,
  hour: HourCell,
  week: WeekCell,
  world_clock: WorldClockCell,
  color_picker: ColorCell,
  country: CountryCell,
  location: LocationCell,
  ai: AiCell,
  secret: SecretCell,
  signature: SignatureCell,
};

/** Read-only types with a look of their own (M8: progress); the rest of the read-only ones show their text. */
export const READ_ONLY_CELLS: Record<string, ComponentType<CellProps>> = {
  progress: ProgressCell,
  formula: FormulaCell,
  mirror: MirrorCell,
};

/** Whether a column has a cell component (else the table shows its plain text). */
export const hasCellComponent = (column: Column) =>
  !!(column.read_only ? READ_ONLY_CELLS[column.type] : CELLS[column.type]);

export const cellFor = (column: Column): ComponentType<CellProps> =>
  (column.read_only ? READ_ONLY_CELLS[column.type] : CELLS[column.type]) || ReadOnlyCell;
