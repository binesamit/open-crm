// SPDX-License-Identifier: AGPL-3.0-only
import { t, viewMenu, type MessageKey, type PlanFeatureKey, type ViewSettings, type ViewType } from '@bines/shared';
import { Button, cn, Menu, MenuTrigger, useActionMenu, type MenuEntry } from '@bines/ui';
import { ApiError } from '@bines/sdk';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { confirmDelete, confirmDialog, promptDialog } from '../../../lib/dialogs';
import { toMenuEntries } from '../../../lib/entity-menu';
import { usePlanGates } from '../../../lib/plan-gate';
import { gateMenuEntry, planUpgradeMenuEntries } from '../../../lib/plan-limit';
import { useNavigate } from '@tanstack/react-router';
import type { View, ViewMutations } from './views-api';
import { useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { showToast } from '../../../lib/toast';
import { BoardAccountContext } from '../board-context';
import { BoardPickerDialog } from '../BoardPickerDialog';
import type { ViewState } from './use-view-state';
import { Icon, type IconName } from '../../../lib/icons';

export const TYPE_ICON: Record<ViewType, IconName> = {
  table: 'table',
  kanban: 'kanban',
  calendar: 'calendar',
  cards: 'cards',
  timeline: 'timeline',
  gantt: 'gantt',
  workload: 'workload',
  chart: 'chart',
  files: 'file',
  map: 'map',
  extension: 'ext',
  form: 'form',
  dashboard: 'dashboard',
};

/** View types the "+" menu offers (11-UI §4; M8 adds Timeline / Gantt / Workload and Chart / Files / Map). */
export const CREATABLE_VIEW_TYPES: ViewType[] = [
  'table',
  'kanban',
  'calendar',
  'cards',
  'timeline',
  'gantt',
  'workload',
  'chart',
  'files',
  'map',
  'form',
  'dashboard',
];

/** View types the account's plan must include (the rest need nothing). */
const VIEW_TYPE_FEATURE: Partial<Record<ViewType, PlanFeatureKey>> = { form: 'forms', dashboard: 'dashboards' };

/**
 * Moves a tab within my layout. Pinned tabs stay first: a pinned tab moves among the pinned ones only, an unpinned
 * one among the unpinned only — dropped on the other kind, it stops at the boundary (last pinned / first unpinned).
 */
export const moveTab = (views: View[], activeId: string, overId: string) => {
  const pinned = views.filter((v) => v.pinned).map((v) => v.id);
  const rest = views.filter((v) => !v.pinned).map((v) => v.id);
  const isPinned = pinned.includes(activeId);
  const group = isPinned ? pinned : rest;
  const from = group.indexOf(activeId);
  const to = group.includes(overId) ? group.indexOf(overId) : isPinned ? group.length - 1 : 0;
  const moved = arrayMove(group, from, to);
  const nextPinned = isPinned ? moved : pinned;
  const nextRest = isPinned ? rest : moved;
  return { pinned: nextPinned, order: [...nextPinned, ...nextRest] };
};

/** Tabs move along the strip only: no vertical drift that would lift the tab out of the row (Fix: ). */
const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

/** Pin = last of the pinned; unpin = first of the others. */
export const togglePin = (views: View[], id: string) => {
  const pinned = views.filter((v) => v.pinned && v.id !== id).map((v) => v.id);
  const rest = views.filter((v) => !v.pinned && v.id !== id).map((v) => v.id);
  const wasPinned = views.find((v) => v.id === id)?.pinned;
  const nextPinned = wasPinned ? pinned : [...pinned, id];
  const nextRest = wasPinned ? [id, ...rest] : rest;
  return { pinned: nextPinned, order: [...nextPinned, ...nextRest] };
};

/**
 * View tabs (11-UI §2, 15-VIEWS §6): one tab per view, ⋯ / right click for pin, rename, duplicate, default, lock,
 * share, delete; tabs drag into my own order (pinned first); "+" creates a view from what is on screen now.
 */
export const ViewTabs = ({
  views,
  current,
  dirty,
  canCreateShared,
  onSelect,
  onCreate,
  extraCreate = [],
  mutations: m,
}: {
  views: View[];
  current: View;
  dirty: boolean;
  canCreateShared: boolean;
  onSelect: (id: string) => void;
  onCreate: (type: ViewType) => void;
  /** More "+" entries after the built-in types: the board views of installed extensions (D27). */
  extraCreate?: MenuEntry[];
  mutations: ViewMutations;
}) => {
  const plus = useActionMenu();
  const addEntries = useAddViewEntries({ canCreateShared, onCreate, extraCreate, testIdPrefix: 'view-add' });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<string | null>(null);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over || active.id === over.id) return;
    m.layout.mutate(moveTab(views, String(active.id), String(over.id)));
  };
  const lastPinned = views.filter((v) => v.pinned).at(-1)?.id;
  const draggedView = dragging ? views.find((v) => v.id === dragging) : undefined;
  const tab = (v: View) => (
    <ViewTab
      key={v.id}
      view={v}
      active={v.id === current.id}
      dirty={dirty && v.id === current.id}
      onSelect={onSelect}
      onTogglePin={() => m.layout.mutate(togglePin(views, v.id))}
      divider={v.id === lastPinned && lastPinned !== views.at(-1)?.id}
      mutations={m}
    />
  );
  const pinned = views.filter((v) => v.pinned);
  const others = views.filter((v) => !v.pinned);
  return (
    // F4: the tabs are a segmented switch; the active view is filled with the brand ink.
    // Fix: the strip keeps its exact height while a tab is dragged — the dragged tab is drawn in an
    // overlay outside the strip (nothing overflows, no scrollbar appears), it moves horizontally only, and the
    // strip never scrolls vertically.
    <div
      className="flex h-9 w-fit max-w-full min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-[12px] bg-surface-2 p-[0.1875rem]"
      data-testid="view-tabs"
      data-tour="board.views"
    >
      {/* Prod (axe): the tab list holds the tabs only — "+" and the drag announcer sit outside it. */}
      <div role="tablist" aria-label={t('view.tabs')} className="flex items-center gap-0.5">
        <DndContext
          accessibility={{ container: document.body }}
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[horizontalOnly]}
          autoScroll={{ threshold: { x: 0.15, y: 0 } }}
          onDragStart={({ active }) => setDragging(String(active.id))}
          onDragCancel={() => setDragging(null)}
          onDragEnd={onDragEnd}
        >
          {/* Pinned and other tabs sort among their own kind (moveTab): the gap opens only where the tab can land. */}
          <SortableContext items={pinned.map((v) => v.id)} strategy={horizontalListSortingStrategy}>
            {pinned.map(tab)}
          </SortableContext>
          <SortableContext items={others.map((v) => v.id)} strategy={horizontalListSortingStrategy}>
            {others.map(tab)}
          </SortableContext>
          {createPortal(
            <DragOverlay dropAnimation={null} modifiers={[horizontalOnly]}>
              {draggedView ? (
                <div
                  data-testid="view-tab-overlay"
                  className={cn(
                    'flex h-[1.875rem] cursor-grabbing items-center gap-1 rounded-[9px] ps-3 pe-7 text-sm shadow-[var(--shadow-pop)]',
                    draggedView.id === current.id ? 'bg-primary font-semibold text-on-primary' : 'bg-surface text-fg',
                  )}
                >
                  <TabFace view={draggedView} dirty={dirty && draggedView.id === current.id} />
                </div>
              ) : null}
            </DragOverlay>,
            document.body,
          )}
        </DndContext>
      </div>
      <button
        type="button"
        aria-label={t('view.add')}
        title={t('view.add')}
        data-testid="view-add"
        data-tour="board.add-view"
        onClick={plus.fromTrigger}
        className="grid size-[1.875rem] shrink-0 place-items-center rounded-[9px] text-fg-2 hover:bg-surface hover:text-fg"
      >
        <Icon name="plus" size={15} strokeWidth={2} />
      </button>
      <Menu at={plus.at} onClose={plus.close} label={t('view.add')} items={addEntries} />
    </div>
  );
};

/**
 * The "+ new view" choices: the view types (gated by the account's plan), the extensions' board views, and the
 * plan's upgrade rows — the tab bar's "+" and the phone's views dropdown.
 */
export const useAddViewEntries = ({
  canCreateShared,
  onCreate,
  extraCreate = [],
  testIdPrefix,
}: {
  canCreateShared: boolean;
  onCreate: (type: ViewType) => void;
  extraCreate?: MenuEntry[];
  /** `${prefix}-${type}` test ids on the type rows. */
  testIdPrefix: string;
}): MenuEntry[] => {
  // Plan feature gates: a form view needs `forms`, a dashboard view `dashboards` — listed, disabled.
  const planGate = usePlanGates(useContext(BoardAccountContext).id);
  const viewGate = (type: ViewType) => (VIEW_TYPE_FEATURE[type] ? planGate(VIEW_TYPE_FEATURE[type]) : undefined);
  const navigate = useNavigate();
  return [
    ...CREATABLE_VIEW_TYPES.map((type) =>
      gateMenuEntry(viewGate(type), {
        label: `${t(`view.type.${type}` as MessageKey)}${canCreateShared ? '' : ` (${t('view.private')})`}`,
        onSelect: () => onCreate(type),
        testId: `${testIdPrefix}-${type}`,
      }),
    ),
    ...(extraCreate.length ? [{ kind: 'separator' as const }, ...extraCreate] : []),
    ...planUpgradeMenuEntries(CREATABLE_VIEW_TYPES.map(viewGate), (path) => void navigate({ to: path })),
  ];
};

const ViewTab = ({
  view,
  active,
  dirty,
  onSelect,
  onTogglePin,
  divider,
  mutations: m,
}: {
  view: View;
  active: boolean;
  dirty: boolean;
  onSelect: (id: string) => void;
  onTogglePin: () => void;
  /** The last pinned tab draws the line between pinned and other tabs. */
  divider: boolean;
  mutations: ViewMutations;
}) => {
  const menu = useActionMenu();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: view.id });
  // Prod (axe): the tab itself selects the view (click, Enter / Space) and is what drags; its ⋯ menu opens
  // from the keyboard on the tab (Shift+F10 / the menu key) — the visible ⋯ is for the pointer only, beside the tab,
  // so no control is nested in a tab and the tab list holds tabs only. dnd-kit's role / role description stay off.
  const { role: _role, 'aria-roledescription': _desc, ...dragAttributes } = attributes;
  const select = () => onSelect(view.id);
  const { items, rename, dialog } = useViewActions(view, onTogglePin, m);
  return (
    <div
      ref={setNodeRef}
      role="presentation"
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn(
        'group relative flex h-[1.875rem] shrink-0 cursor-grab items-center gap-1 rounded-[9px] ps-3 pe-1 text-sm active:cursor-grabbing',
        active ? 'bg-primary font-semibold text-on-primary' : 'text-fg-2 hover:bg-surface hover:text-fg',
        // The tab itself stays in the row as the drop placeholder; the overlay follows the pointer.
        isDragging && 'opacity-40',
        divider && 'me-2 after:absolute after:inset-y-1.5 after:-end-1.5 after:w-px after:bg-line-strong',
      )}
    >
      <div
        role="tab"
        aria-selected={active}
        aria-label={view.name}
        data-testid="view-tab"
        data-tour="board.view-tab"
        data-view-name={view.name}
        data-pinned={view.pinned || undefined}
        {...dragAttributes}
        {...listeners}
        onClick={select}
        onDoubleClick={() => view.can_save && void rename()}
        onContextMenu={menu.onContextMenu}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            return select();
          }
          menu.onKeyDown(e);
          listeners?.onKeyDown?.(e);
        }}
        className="flex h-full cursor-grab items-center gap-1.5 rounded-[9px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] active:cursor-grabbing"
      >
        <TabFace view={view} dirty={dirty} />
      </div>
      <MenuTrigger
        pointerOnly
        label={t('view.actions', { name: view.name })}
        onClick={menu.fromTrigger}
        className={active ? 'text-current hover:bg-current/15 hover:text-current' : undefined}
      />
      <Menu at={menu.at} onClose={menu.close} items={items} label={t('view.actions', { name: view.name })} />
      {dialog}
    </div>
  );
};

/**
 * A view's ⋯ actions (pin, rename, duplicate, copy to a board, default, lock, share, delete) — the tab's menu and
 * the phone's view sheet. `dialog` is the "copy to board" picker while it is open.
 */
export const useViewActions = (view: View, onTogglePin: () => void, m: ViewMutations) => {
  const [copying, setCopying] = useState(false);
  const { id: accountId } = useContext(BoardAccountContext);
  const rename = async () => {
    const name = await promptDialog({ title: t('view.rename'), label: t('view.name'), initial: view.name });
    if (name && name !== view.name) m.update.mutate({ viewId: view.id, name });
  };
  const items = toMenuEntries(
    viewMenu({
      pinned: view.pinned,
      shared: view.visibility === 'shared',
      isDefault: view.is_default,
      locked: view.is_locked,
      canSave: view.can_save,
      canManage: view.can_manage,
      canDelete: view.can_delete,
    }),
    {
      pin: onTogglePin,
      unpin: onTogglePin,
      rename: () => void rename(),
      duplicate: () => m.duplicate.mutate(view.id),
      copy_to_board: () => setCopying(true),
      make_default: () => m.update.mutate({ viewId: view.id, is_default: true }),
      lock: () => m.update.mutate({ viewId: view.id, is_locked: true }),
      unlock: () => m.update.mutate({ viewId: view.id, is_locked: false }),
      make_shared: () => m.update.mutate({ viewId: view.id, visibility: 'shared' }),
      delete: () => void confirmDelete(view.name).then((ok) => ok && m.remove.mutate({ id: view.id, name: view.name })),
    },
  );
  const dialog = copying
    ? // Outside the tab's DOM is not enough: React events bubble through portals, so the dialog sits in a
      // portal that stops them before the tab's drag listeners.
      createPortal(
        <div onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <BoardPickerDialog
            accountId={accountId}
            title={t('view.copyToBoard.title', { name: view.name })}
            confirmLabel={t('view.copyToBoard.confirm')}
            exclude={[view.board_id]}
            onClose={() => setCopying(false)}
            onPick={(board) =>
              m.copyToBoard
                .mutateAsync({ viewId: view.id, boardId: board.id })
                .then(() => showToast({ message: t('view.copyToBoard.done', { name: view.name, board: board.name }) }))
            }
          />
        </div>,
        document.body,
      )
    : null;
  return { items, rename, dialog };
};

/** What a tab shows: its icon (📌 when pinned), name, lock, "private" and the unsaved-changes dot. */
export const TabFace = ({ view, dirty }: { view: View; dirty: boolean }) => (
  <span className="flex items-center gap-1.5">
    {view.pinned ? (
      <span role="img" aria-label={t('view.pinned')} title={t('view.pinned')}>
        <Icon name="pin" size={14} />
      </span>
    ) : (
      <Icon name={TYPE_ICON[view.type]} size={14} />
    )}
    <span className="max-w-48 truncate">{view.name}</span>
    {view.is_locked ? (
      <span role="img" aria-label={t('view.locked')} title={t('view.locked')}>
        <Icon name="lock" size={13} />
      </span>
    ) : null}
    {view.visibility === 'private' ? (
      <span title={t('view.private')} className="rounded-[5px] bg-current/12 px-1 text-[0.6875rem] font-medium">
        {t('view.private')}
      </span>
    ) : null}
    {dirty ? <span aria-label={t('view.unsaved')} className="size-1.5 rounded-full bg-accent" /> : null}
  </span>
);

/**
 * "N unsaved changes · Save to view · Save as new view · Reset" (15 §2). A locked view (or one I may not save)
 * offers only "save as new"; a save that loses a race (409) asks: overwrite, or save as a new view.
 */
export const SaveBar = ({
  view,
  state,
  mutations: m,
  onSaveAsNew,
}: {
  view: View;
  state: ViewState;
  mutations: ViewMutations;
  onSaveAsNew: () => void;
}) => {
  if (!state.dirty) return null;
  const save = async (settings: ViewSettings, force = false) => {
    try {
      await m.save.mutateAsync({ view, settings, force });
      state.clear(view.id);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      const overwrite = await confirmDialog({
        title: t('view.conflict.title'),
        message: t('view.conflict.message'),
        confirmLabel: t('view.conflict.overwrite'),
      });
      if (overwrite) await save(settings, true);
      else onSaveAsNew();
    }
  };
  if (state.outdated)
    return (
      <div className="flex items-center gap-2 text-sm" data-testid="view-outdated">
        <span className="text-muted">{t('view.outdated')}</span>
        <Button size="sm" onClick={state.reset} data-testid="view-outdated-use-new">
          {t('view.outdated.useNew')}
        </Button>
        <Button variant="ghost" size="sm" onClick={state.keepMine} data-testid="view-outdated-keep">
          {t('view.outdated.keepMine')}
        </Button>
      </div>
    );
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="save-bar">
      <span className="text-muted">{t('view.changes', { n: state.changes.length })}</span>
      {view.is_system ? (
        // The default table never changes: its changes become a new view.
        <Button size="sm" onClick={onSaveAsNew} data-testid="view-save">
          {t('view.saveMainAsNew')}
        </Button>
      ) : view.can_save ? (
        <Button size="sm" busy={m.save.isPending} onClick={() => void save(state.draft!)} data-testid="view-save">
          {t('view.save')}
        </Button>
      ) : view.is_locked ? (
        <span className="text-xs text-muted">🔒 {t('view.lockedHint')}</span>
      ) : null}
      {view.is_system ? null : (
        <Button variant="secondary" size="sm" onClick={onSaveAsNew} data-testid="view-save-new">
          {t('view.saveAsNew')}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={state.reset} data-testid="view-reset">
        {t('view.reset')}
      </Button>
    </div>
  );
};
