// SPDX-License-Identifier: AGPL-3.0-only
import { createElement, useContext, useEffect, useState } from 'react';
import {
  batchMenu,
  BULK_MAX_ITEMS,
  treeMoveItems,
  type BulkItemsRequest,
  type BulkResult,
  durationMode,
  type DurationMode,
  type Query,
  t,
} from '@bines/shared';
import { cn, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { confirmDialog, promptDialog } from '../../lib/dialogs';
import { useUndoToast } from '../../lib/undo';
import { showToast } from '../../lib/toast';
import { errorMessage } from '../../lib/api';
import type { BoardDetail, Column, Member, useBoardMutations } from './board-api';
import { BoardAccountContext } from './board-context';
import { exportBoard } from './ExportButton';
import { cellFor } from './cells';
import { bulkSettable } from './table/bulk-cells';
import { Popover } from './cells/Popover';
import { MoveDialog } from './MoveDialog';
import { useTreeMove } from './tree-move';
import type { Selection } from './selection';
import { columnTypeLabel } from '../../lib/locale';
import { useBucketBatchMove } from './table/bucket';
import { isTyping } from '../../lib/keys';
import { toMenuEntries } from '../../lib/entity-menu';
import { AiBatchButton } from '../ai2/AiBatch';
import { featureLabel, useExtensionActions } from '../extensions/ExtensionSlots';

/** A right click on a selected row or card opens the batch actions there (14 §2). */
const BATCH_MENU_EVENT = 'bines:batch-menu';
export const openBatchMenu = (e: {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => {
  e.preventDefault();
  e.stopPropagation();
  window.dispatchEvent(new CustomEvent(BATCH_MENU_EVENT, { detail: { x: e.clientX, y: e.clientY } }));
};

/** Columns a batch can set (07 §6 "ערוך"): editable cells, not files / time log / votes / relations (own flows). */
/** Columns a batch can set — the same rule as an edit in a checked row (round 12, `bulk-cells.ts`). */
const settable = bulkSettable;

/**
 * The floating batch bar (07 §6, 14 §2) while rows are selected: count · delete · move to group · set a value ·
 * shift dates · ✕. One request per action; the toast undoes the whole batch (Ctrl+Z too).
 */
export const BatchBar = ({
  board,
  selection,
  members,
  mutations: m,
  matchAll,
}: {
  /** A windowed board: the view's query and how many items it matches (see `byQuery`). */
  matchAll?: { query: Query; total: number };
  board: BoardDetail;
  selection: Selection;
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
}) => {
  const { id: accountId, meId } = useContext(BoardAccountContext);
  const undoToast = useUndoToast(accountId);
  // Installed extensions' batch actions (D27 ת3): a modal frame with the selected items as context.
  const extBatch = useExtensionActions({
    accountId,
    boardId: board.parent_board_id ?? board.id,
    meId,
    where: 'batch',
    itemIds: selection.ids,
    enabled: selection.ids.length > 0,
  });
  const moveMenu = useActionMenu();
  const editMenu = useActionMenu();
  const datesMenu = useActionMenu();
  const treeMenu = useActionMenu();
  const [editing, setEditing] = useState<Column | null>(null);
  const [moving, setMoving] = useState(false);
  const [contextAt, setContextAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => setContextAt((e as CustomEvent<{ x: number; y: number }>).detail);
    window.addEventListener(BATCH_MENU_EVENT, onOpen);
    return () => window.removeEventListener(BATCH_MENU_EVENT, onOpen);
  }, []);
  const caps = board.capabilities;
  const n = selection.ids.length;
  // A view grouped by a column: "move" sets that column's value (its sections), like the drag and the item menu.
  const bucketMove = useBucketBatchMove(board.id);
  const canMoveGroup = bucketMove ? !!caps['item.update'] : !!caps['item.move_group'] && board.groups.length > 1;

  // A windowed board with every match selected beyond one batch's cap: the server runs it by the view's query
  // (rows never loaded too) — one batch, one undo, like any other.
  const byQuery = !!matchAll && n > BULK_MAX_ITEMS && n === matchAll.total;
  const run = (action: BulkItemsRequest['action'], message: (res: BulkResult) => string, clear = false) => {
    const handlers = {
      onSuccess: (res: BulkResult) => {
        if (clear) selection.clear();
        const skipped = res.skipped ? ` · ${t('batch.skipped', { n: res.skipped })}` : '';
        undoToast(`${message(res)}${skipped}`, res.event_id);
      },
      onError: (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' }),
    };
    if (byQuery) m.bulkQuery.mutate({ query: matchAll.query, action }, handlers);
    else m.bulk.mutate({ item_ids: selection.ids, action }, handlers);
  };

  // Hierarchy moves: the shared "move to item" entry — the same hook as the row and cell menus.
  const tree = useTreeMove(accountId, board, m, selection.clear);
  const treeRows = byQuery ? { ids: selection.ids, query: matchAll.query } : { ids: selection.ids };
  const treeHandlers = tree.handlers(treeRows);
  const treeEntries = toMenuEntries(treeMoveItems(tree.rights), treeHandlers);

  const columns = board.columns.filter(settable);
  const dateColumns = board.columns.filter((c) => c.type === 'date' || c.type === 'timeline');
  const groups: MenuEntry[] = bucketMove
    ? bucketMove(selection.ids)
    : board.groups.map((g) => ({
        label: g.title,
        onSelect: () =>
          run({ type: 'move_to_group', group_id: g.id }, (r) => t('batch.done.move', { n: r.done, group: g.title })),
      }));
  const editEntries: MenuEntry[] = columns.map((c) => ({
    label: c.title,
    keywords: columnTypeLabel(c.type),
    onSelect: () => setEditing(c),
  }));
  const dateEntries: MenuEntry[] = dateColumns.map((c) => {
    // The server counts the shift as the column counts days: working days say so.
    const own = (c.settings as { duration?: DurationMode | 'account' } | null)?.duration;
    const workdays = durationMode(own) !== 'calendar';
    return {
      label: c.title,
      onSelect: () =>
        void promptDialog({
          title: t('batch.shiftDates.title', { column: c.title }),
          label: t(workdays ? 'batch.shiftDates.workdays' : 'batch.shiftDates.days'),
        }).then((v) => {
          const days = Number(v);
          if (!v || !Number.isInteger(days) || days === 0) return;
          run({ type: 'shift_dates', column_id: c.id, days }, (r) =>
            t(workdays ? 'batch.done.shiftWorkdays' : 'batch.done.shift', { n: r.done, days }),
          );
        }),
    };
  });
  const remove = () =>
    void confirmDialog({
      title: t('batch.delete.title', { n }),
      message: t('board.confirmDelete'),
      danger: true,
    }).then((ok) => ok && run({ type: 'delete' }, (r) => t('batch.done.delete', { n: r.done }), true));

  // Esc clears the selection, Delete asks to delete it — not while typing (open menus take Esc first).
  const canDelete = !!caps['item.delete'];
  useEffect(() => {
    if (!n) return;
    const onKey = (e: KeyboardEvent) => {
      // The table's active cell handles its keys first (Delete clears the cell there).
      if (e.defaultPrevented || isTyping(e.target)) return;
      if (e.key === 'Escape') selection.clear();
      else if (e.key === 'Delete' && canDelete) {
        e.preventDefault();
        remove();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!n) return extBatch.dialog ? <>{extBatch.dialog}</> : null;
  // An extension acts on rows it can be told about: not on a selection of every match beyond what is loaded.
  const extFeatures = byQuery ? [] : extBatch.features;

  const contextEntries = toMenuEntries(
    batchMenu({
      canEdit: !!caps['item.update'] && columns.length > 0,
      canMoveGroup,
      canMoveBoard: !!caps['item.move_group'] && !board.parent_board_id,
      canCreate: !!caps['item.create'],
      canDelete: !!caps['item.delete'],
      tree: tree.rights,
    }),
    {
      move_to_board: () => setMoving(true),
      ...treeHandlers,
      duplicate: () => run({ type: 'duplicate' }, (r) => t('batch.done.duplicate', { n: r.done })),
      archive: () => run({ type: 'archive' }, (r) => t('batch.done.archive', { n: r.done }), true),
      delete: remove,
      clear_selection: selection.clear,
    },
    { set_value: editEntries, shift_dates: dateEntries, move_to_group: groups },
  ).concat(byQuery ? [] : extBatch.entries);

  const button =
    'flex h-full min-w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-[10px] px-3 text-[0.6875rem] text-fg-2 hover:bg-surface-2 hover:text-fg disabled:opacity-40';
  // c9: a full pill (owner, 2026-10); the inline padding keeps the first and last items clear of the round ends.
  return (
    <div
      role="toolbar"
      aria-label={t('batch.title', { n })}
      data-testid="batch-bar"
      className="fixed inset-x-0 bottom-7 z-40 mx-auto flex h-14 w-max max-w-[calc(100vw-2rem)] items-stretch overflow-x-auto rounded-full border border-line bg-surface px-3 py-1 shadow-[var(--shadow-pop)]"
    >
      <Menu at={contextAt} onClose={() => setContextAt(null)} items={contextEntries} label={t('batch.title', { n })} />
      <div className="flex h-11 shrink-0 items-center gap-2 self-center border-e border-line ps-1 pe-3">
        <span
          className="grid h-8 min-w-8 place-items-center rounded-full bg-accent px-2 font-bold text-on-accent"
          data-testid="batch-count"
        >
          {n}
        </span>
        <span className="text-sm font-semibold">{t('batch.selected')}</span>
      </div>
      {selection.capped ? (
        <span className="flex items-center px-3 text-xs text-danger-fg">{t('batch.capped')}</span>
      ) : null}
      {caps['item.update'] && columns.length ? (
        <div className="relative flex">
          <button type="button" className={button} onClick={editMenu.fromTrigger} aria-haspopup="menu">
            <Icon name="edit" size={18} />
            {t('batch.edit')}
          </button>
          <Menu at={editMenu.at} onClose={editMenu.close} items={editEntries} label={t('batch.edit')} />
          {editing ? (
            <Popover open onClose={() => setEditing(null)} className="w-64">
              <BulkEditor
                column={editing}
                board={board}
                members={members}
                accountId={accountId}
                onSet={(value) => {
                  const col = editing;
                  setEditing(null);
                  run({ type: 'set_cell', column_id: col.id, value }, (r) =>
                    t(value === null ? 'batch.done.clear' : 'batch.done.set', { n: r.done, column: col.title }),
                  );
                }}
              />
            </Popover>
          ) : null}
        </div>
      ) : null}
      {byQuery ? null : (
        <AiBatchButton accountId={accountId} board={board} itemIds={selection.ids} className={button} />
      )}
      {extFeatures.map((f) => (
        <button
          key={`${f.installation_id}:${f.feature}`}
          type="button"
          className={button}
          title={f.extension_name}
          data-testid={`batch-ext-${f.extension_key}-${f.feature}`}
          onClick={() => extBatch.open(f)}
        >
          <Icon name="ext" size={18} />
          {featureLabel(f)}
        </button>
      ))}
      {extBatch.dialog}
      {caps['item.update'] && dateColumns.length ? (
        <>
          <button type="button" className={button} onClick={datesMenu.fromTrigger} aria-haspopup="menu">
            <Icon name="calendar" size={18} />
            {t('batch.shiftDates')}
          </button>
          <Menu at={datesMenu.at} onClose={datesMenu.close} items={dateEntries} label={t('batch.shiftDates')} />
        </>
      ) : null}
      {canMoveGroup ? (
        <>
          <button type="button" className={button} onClick={moveMenu.fromTrigger} aria-haspopup="menu">
            <Icon name="move" size={18} />
            {t('batch.move')}
          </button>
          <Menu at={moveMenu.at} onClose={moveMenu.close} items={groups} label={t('batch.move')} />
        </>
      ) : null}
      {!board.parent_board_id ? (
        <button
          type="button"
          className={button}
          data-testid="batch-export"
          onClick={() => void exportBoard(accountId, board.id, { format: 'xlsx', item_ids: selection.ids })}
        >
          <Icon name="download" size={18} />
          {t('export.selected')}
        </button>
      ) : null}
      {caps['item.move_group'] && !board.parent_board_id ? (
        <>
          <button type="button" className={button} onClick={() => setMoving(true)}>
            <Icon name="board" size={18} />
            {t('batch.moveToBoard')}
          </button>
          {moving ? (
            <MoveDialog
              accountId={accountId}
              board={board}
              title={t('move.titleMany', { n })}
              onClose={() => setMoving(false)}
              onMove={(v) =>
                new Promise((resolve, reject) =>
                  (byQuery ? m.bulkQuery : m.bulk).mutate(
                    {
                      ...(byQuery ? { query: matchAll.query } : { item_ids: selection.ids }),
                      action: { type: 'move_to_board', board_id: v.board.id, group_id: v.groupId, mapping: v.mapping },
                    } as never,
                    {
                      onSuccess: (res) => {
                        selection.clear();
                        const skipped = res.skipped ? ` · ${t('batch.skipped', { n: res.skipped })}` : '';
                        undoToast(
                          `${t('move.toastMany', { n: res.done, board: v.board.name })}${skipped}`,
                          res.event_id,
                        );
                        resolve(res);
                      },
                      onError: (err) => {
                        showToast({ message: errorMessage(err), tone: 'error' });
                        reject(err);
                      },
                    },
                  ),
                )
              }
            />
          ) : null}
        </>
      ) : null}
      {treeEntries.length ? (
        <>
          <button
            type="button"
            className={button}
            onClick={treeMenu.fromTrigger}
            aria-haspopup="menu"
            data-testid="batch-tree"
          >
            <Icon name="nest" size={18} />
            {t('batch.tree')}
          </button>
          <Menu at={treeMenu.at} onClose={treeMenu.close} items={treeEntries} label={t('batch.tree')} />
        </>
      ) : null}
      {tree.dialog}
      {caps['item.create'] ? (
        <button
          type="button"
          className={button}
          onClick={() => run({ type: 'duplicate' }, (r) => t('batch.done.duplicate', { n: r.done }))}
        >
          <Icon name="duplicate" size={18} />
          {t('batch.duplicate')}
        </button>
      ) : null}
      {caps['item.delete'] ? (
        <button
          type="button"
          className={button}
          onClick={() => run({ type: 'archive' }, (r) => t('batch.done.archive', { n: r.done }), true)}
        >
          <Icon name="archive" size={18} />
          {t('batch.archive')}
        </button>
      ) : null}
      {caps['item.delete'] ? (
        <button type="button" className={cn(button, 'text-danger-fg hover:text-danger-fg')} onClick={remove}>
          <Icon name="trash" size={18} />
          {t('batch.delete')}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t('batch.clear')}
        title="Esc"
        className="ms-1 grid size-10 shrink-0 place-items-center self-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
        onClick={selection.clear}
      >
        ✕
      </button>
    </div>
  );
};

/** "Set value": the column's own cell editor, empty; its first change applies to every selected item. */
const BulkEditor = ({
  column,
  board,
  members,
  accountId,
  onSet,
}: {
  column: Column;
  board: BoardDetail;
  members: Member[];
  accountId: string;
  onSet: (value: unknown) => void;
}) => {
  return (
    <div className="space-y-2" data-testid="batch-editor">
      <p className="text-xs text-muted">{t('batch.setFor', { column: column.title })}</p>
      <div className="h-9 rounded-[var(--radius-sm)] border border-line" data-column-type={column.type}>
        {/* The type's own editor, chosen at run time from the cell registry. */}
        {createElement(cellFor(column), {
          column,
          value: null,
          text: null,
          editable: true,
          members,
          accountId,
          itemId: '',
          boardId: board.id,
          onChange: (value: unknown) => onSet(value),
          canEditSettings: false,
          onSettingsChange: () => Promise.resolve(),
        })}
      </div>
      <button type="button" className="text-xs text-muted hover:text-danger-fg" onClick={() => onSet(null)}>
        {t('batch.clearValue')}
      </button>
    </div>
  );
};
