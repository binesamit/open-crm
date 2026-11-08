// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t, type MessageKey, type ViewType } from '@bines/shared';
import { cn, Dialog, Menu, MenuTrigger, SEARCH_THRESHOLD, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon } from '../../../lib/icons';
import { MobileBarSlotContext } from '../../shell/mobile-bar-slot';
import { PopoverSheetContext } from '../cells/Popover';
import { SearchBox } from '../toolbar/BoardToolbar';
import {
  CREATABLE_VIEW_TYPES,
  TabFace,
  togglePin,
  TYPE_ICON,
  useAddViewEntries,
  useViewActions,
} from '../views/ViewTabs';
import { mobileViewMenuEntries } from './mobile-view-menu';
import type { View, ViewMutations } from '../views/views-api';

/** An icon button of the phone's board bar — the shell top bar's own look (its ☰, search and bell). */
export const BAR_BTN =
  'relative grid size-9 shrink-0 place-items-center rounded-[10px] hover:bg-[var(--shell-hover)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]';

/**
 * Prod fix (mobilehead, product owner: "on the phone the top of the board up to the table is more than half the screen,
 * and sticky"): on a phone the board's title row, view tabs and both toolbar rows become ONE compact bar inside
 * the shell's top bar — the board's name with the current view under it (a tap switches views in a bottom sheet),
 * search (opens inline), the tools sheet (filter / person / sort / hide / group / colouring / view settings, with
 * the active conditions' count), ⋯ and "+". Without the shell's slot (an item card is open, no shell) the bar is
 * drawn at the top of the page instead, in the same shell colours.
 */
export const MobileBarHost = ({ children }: { children: ReactNode }) => {
  const slot = useContext(MobileBarSlotContext);
  const bar = (
    <div
      data-board-bar
      data-testid="mobile-board-bar"
      data-placement={slot ? 'shell' : 'page'}
      className="flex h-14 min-w-0 flex-1 items-center gap-0.5"
    >
      {children}
    </div>
  );
  if (slot) return createPortal(bar, slot);
  return <div className="flex shrink-0 bg-shell px-1 text-shell-strong">{bar}</div>;
};

/**
 * The board's name with the current view under it; a tap opens the views as a bottom sheet — choose one, its ⋯
 * actions (the tab menu's), or "+" for a new view.
 */
export const MobileViewSwitch = ({
  boardName,
  view,
  views,
  dirty,
  canCreateShared,
  onSelect,
  onCreate,
  extraCreate = [],
  mutations: m,
  open: openProp,
  onOpenChange,
  hideTrigger,
}: {
  boardName: string;
  view: View;
  views: View[];
  dirty: boolean;
  canCreateShared: boolean;
  onSelect: (id: string) => void;
  onCreate: (type: ViewType) => void;
  extraCreate?: MenuEntry[];
  mutations: ViewMutations;
  /** r18board 3: the sheet's open state, when the page's view chips row opens it too. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Only the sheet (the bar's search covers the name): the chips row can still open it. */
  hideTrigger?: boolean;
}) => {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const plus = useActionMenu();
  return (
    <>
      {hideTrigger ? null : (
        <button
          type="button"
          data-testid="mobile-view-switch"
          data-tour="board.title"
          data-view-name={view.name}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${boardName} · ${view.name}`}
          onClick={() => setOpen(true)}
          className="flex min-w-0 flex-1 flex-col items-start justify-center rounded-[10px] px-2 py-1 text-start hover:bg-[var(--shell-hover)]"
        >
          <span
            data-testid="mobile-board-name"
            className="block w-full truncate font-display text-[0.9375rem] leading-tight font-extrabold"
          >
            {boardName}
          </span>
          <span className="flex max-w-full items-center gap-1 text-xs leading-tight text-shell-muted">
            <Icon name={TYPE_ICON[view.type]} size={12} />
            <span className="truncate">{view.name}</span>
            {dirty ? (
              <span aria-label={t('view.unsaved')} className="size-1.5 shrink-0 rounded-full bg-accent" />
            ) : null}
            <Icon name="chevronDown" size={12} strokeWidth={2.2} className="shrink-0" />
          </span>
        </button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={t('mobilehead.views')} subtitle={boardName}>
        <div className="-mx-2 flex flex-col gap-0.5" data-testid="mobile-view-sheet">
          {views.map((v) => (
            <ViewOption
              key={v.id}
              view={v}
              active={v.id === view.id}
              dirty={dirty && v.id === view.id}
              onSelect={() => {
                onSelect(v.id);
                setOpen(false);
              }}
              onTogglePin={() => m.layout.mutate(togglePin(views, v.id))}
              mutations={m}
            />
          ))}
          <button
            type="button"
            data-testid="mobile-view-add"
            onClick={plus.fromTrigger}
            className="mt-1 flex h-11 items-center gap-3 rounded-[10px] px-3 text-[0.9375rem] text-primary hover:bg-surface-2"
          >
            <Icon name="plus" size={18} strokeWidth={2} />
            {t('view.add')}
          </button>
          <Menu
            at={plus.at}
            onClose={plus.close}
            label={t('view.add')}
            items={[
              ...CREATABLE_VIEW_TYPES.map((type) => ({
                label: `${t(`view.type.${type}` as MessageKey)}${canCreateShared ? '' : ` (${t('view.private')})`}`,
                onSelect: () => {
                  setOpen(false);
                  onCreate(type);
                },
              })),
              ...(extraCreate.length
                ? [
                    { kind: 'separator' as const },
                    ...extraCreate.map((e) =>
                      'onSelect' in e && e.onSelect
                        ? {
                            ...e,
                            onSelect: () => {
                              setOpen(false);
                              e.onSelect!();
                            },
                          }
                        : e,
                    ),
                  ]
                : []),
            ]}
          />
        </div>
      </Dialog>
    </>
  );
};

/**
 * r18board 3 (product owner: "on the phone I don't see the views to choose from") and f9 views (product
 * owner: "on the phone the views bar at the top should be a dropdown menu"): at the top of the scrolling area (it
 * scrolls away with the rows), one full-width button with the current view (its icon, name, the unsaved-changes dot)
 * and a chevron. It opens the app's `Menu` under it: every view with its icon (a tap switches; a search on top when
 * there are many), then the current view's ⋯ actions, "+ new view" and "all views" (the views sheet, with each
 * view's actions).
 */
export const MobileViewDropdown = ({
  view,
  views,
  dirty,
  canCreateShared,
  onSelect,
  onCreate,
  extraCreate = [],
  mutations: m,
  onManage,
}: {
  view: View;
  views: View[];
  dirty: boolean;
  canCreateShared: boolean;
  onSelect: (id: string) => void;
  onCreate: (type: ViewType) => void;
  extraCreate?: MenuEntry[];
  mutations: ViewMutations;
  /** Opens the views sheet. */
  onManage: () => void;
}) => {
  const menu = useActionMenu();
  const { items: currentActions, dialog } = useViewActions(view, () => m.layout.mutate(togglePin(views, view.id)), m);
  const addEntries = useAddViewEntries({ canCreateShared, onCreate, extraCreate, testIdPrefix: 'mobile-view-add' });
  const label = t('mobilehead.viewsMenu');
  return (
    <>
      <button
        type="button"
        data-testid="mobile-view-dropdown"
        data-view-name={view.name}
        aria-haspopup="menu"
        aria-expanded={!!menu.at}
        aria-label={`${label}: ${view.name}`}
        onClick={menu.fromTrigger}
        className={cn(
          'flex h-10 w-full min-w-0 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 text-start text-[0.875rem] font-semibold text-fg',
          'active:bg-surface-2 aria-expanded:border-primary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
        )}
      >
        <Icon name={TYPE_ICON[view.type]} size={16} className="shrink-0 text-primary" />
        <span className="min-w-0 truncate">{view.name}</span>
        {dirty ? <span aria-label={t('view.unsaved')} className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
        <Icon name="chevronDown" size={16} strokeWidth={2.2} className="ms-auto shrink-0 text-fg-2" />
      </button>
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={label}
        testId="mobile-view-menu"
        searchable={views.length > SEARCH_THRESHOLD}
        items={mobileViewMenuEntries({
          views,
          current: view,
          icon: (type) => <Icon name={TYPE_ICON[type]} size={16} />,
          onSelect,
          currentActions,
          addEntries,
          onManage,
          addIcon: <Icon name="plus" size={16} strokeWidth={2} />,
          actionsIcon: <Icon name="edit" size={16} />,
          manageIcon: <Icon name="gear" size={16} />,
        })}
      />
      {dialog}
    </>
  );
};

/** One view in the phone's view sheet: a tap opens it; ⋯ has the tab's actions (pin, rename, delete…). */
const ViewOption = ({
  view,
  active,
  dirty,
  onSelect,
  onTogglePin,
  mutations: m,
}: {
  view: View;
  active: boolean;
  dirty: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  mutations: ViewMutations;
}) => {
  const menu = useActionMenu();
  const { items, dialog } = useViewActions(view, onTogglePin, m);
  return (
    <div
      data-active={active || undefined}
      data-testid="mobile-view-option"
      data-view-name={view.name}
      className={cn(
        'flex h-11 items-center gap-1 rounded-[10px] pe-1 text-[0.9375rem]',
        active ? 'bg-primary-soft font-semibold text-primary' : 'text-fg hover:bg-surface-2',
      )}
    >
      <button
        type="button"
        aria-current={active || undefined}
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 items-center gap-2 ps-3"
      >
        <TabFace view={view} dirty={dirty} />
        {active ? <Icon name="check" size={16} strokeWidth={2.2} className="ms-auto shrink-0" /> : null}
      </button>
      <MenuTrigger
        label={t('view.actions', { name: view.name })}
        onClick={menu.fromTrigger}
        className="grid size-9 place-items-center text-base opacity-100"
      />
      <Menu at={menu.at} onClose={menu.close} items={items} label={t('view.actions', { name: view.name })} />
      {dialog}
    </div>
  );
};

/**
 * The bar's search: an icon (with a dot while something is searched); a tap opens the field over the whole bar,
 * focused; it folds back when left empty, or by its "close" button (the search stays on).
 */
export const MobileSearch = ({
  value,
  onChange,
  open,
  setOpen,
}: {
  value: string;
  onChange: (v: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) =>
  open ? (
    <div className="flex min-w-0 flex-1 items-center gap-1 ps-1" data-testid="mobile-search" data-tour="board.search">
      <div className="min-w-0 flex-1">
        <SearchBox value={value} onChange={onChange} autoFocus onLeave={(empty) => empty && setOpen(false)} />
      </div>
      <button
        type="button"
        data-testid="mobile-search-close"
        aria-label={t('mobilehead.closeSearch')}
        title={t('mobilehead.closeSearch')}
        // Before the field's blur: the tap itself closes it (whatever the field holds).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(false)}
        className={BAR_BTN}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  ) : (
    <button
      type="button"
      data-testid="mobile-search-open"
      data-tour="board.search"
      data-active={value ? 'true' : undefined}
      aria-label={t('toolbar.search')}
      title={t('toolbar.search')}
      onClick={() => setOpen(true)}
      className={BAR_BTN}
    >
      <Icon name="search" size={19} />
      {value ? (
        <span aria-hidden className="absolute top-1.5 end-1.5 size-2 rounded-full bg-accent ring-2 ring-shell" />
      ) : null}
    </button>
  );

/** An active condition as the phone shows it: its wording, and what removes it. */
export type MobileCondition = { key: string; label: string };

/**
 * The tools button (filter icon, the active conditions' count as a badge) and its bottom sheet: the active
 * conditions (each removable, and "clear all" — moved them here from a chips row above the rows)
 * then the toolbar's tools as full-width rows (`BoardToolbar sheet`); their panels open as bottom sheets over it.
 */
export const MobileToolsButton = ({
  count,
  active,
  open,
  setOpen,
  conditions = [],
  onClear,
  onClearAll,
  children,
}: {
  /** Active filter conditions (the Person filter included). */
  count: number;
  /** Something else is on (sort, grouping, hidden columns): a dot when nothing is counted. */
  active: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The active conditions, listed at the top of the sheet. */
  conditions?: MobileCondition[];
  onClear?: (key: string) => void;
  onClearAll?: () => void;
  children: ReactNode;
}) => (
  <>
    <button
      type="button"
      data-testid="mobile-filter-open"
      data-tour="board.filter"
      data-count={count || undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t('mobilehead.tools')}
      title={t('mobilehead.tools')}
      onClick={() => setOpen(true)}
      className={BAR_BTN}
    >
      <Icon name="filter" size={19} />
      {count ? (
        <span
          data-testid="mobile-filter-count"
          className="absolute -top-0.5 -end-0.5 grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-on-accent tabular-nums"
        >
          {count}
        </span>
      ) : active ? (
        <span aria-hidden className="absolute top-1.5 end-1.5 size-2 rounded-full bg-accent ring-2 ring-shell" />
      ) : null}
    </button>
    <Dialog open={open} onClose={() => setOpen(false)} title={t('mobilehead.tools')}>
      <PopoverSheetContext.Provider value>
        <div className="-mx-2" data-testid="mobile-filter-sheet">
          {conditions.length ? (
            <div data-testid="mobile-filter-active" className="mx-2 mb-2 border-b border-line pb-3">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-xs font-semibold text-muted">{t('mobilehead.activeFilters')}</h3>
                {onClearAll ? (
                  <button
                    type="button"
                    data-testid="mobile-filter-clear-all"
                    onClick={onClearAll}
                    className="ms-auto rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary-soft"
                  >
                    {t('filter.clearAll')}
                  </button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {conditions.map((c) => (
                  <span
                    key={c.key}
                    data-testid="mobile-filter-chip"
                    className="flex h-7 max-w-full min-w-0 items-center rounded-full bg-primary-soft text-xs font-medium text-primary"
                  >
                    <span className="min-w-0 truncate ps-2.5 pe-1" title={c.label}>
                      {c.label}
                    </span>
                    {onClear ? (
                      <button
                        type="button"
                        data-testid="mobile-filter-chip-clear"
                        aria-label={t('filter.removeRule')}
                        title={t('filter.removeRule')}
                        onClick={() => onClear(c.key)}
                        className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-current/10"
                      >
                        <Icon name="x" size={13} strokeWidth={2.2} />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {children}
        </div>
      </PopoverSheetContext.Provider>
    </Dialog>
  </>
);

/**
 * What used to sit above the table and is not needed while working in it — the views dropdown and the save bar —
 * at the top of the scrolling area, so it scrolls away with the rows. Kept at the screen's width while the columns
 * scroll sideways. Product decision: no description line (⋯ → "תיאור הבורד") and no active-filter
 * chips row (the filter icon's badge counts them; its sheet lists them with "clear all").
 */
export const MobileBoardLead = ({
  views,
  children,
}: {
  /** r18board 3 / f9 views: the views dropdown (`MobileViewDropdown`), first. */
  views?: ReactNode;
  /** The save bar / an error, when there is one. */
  children?: ReactNode;
}) => {
  if (!views && !children) return null;
  return (
    <div
      data-testid="mobile-board-lead"
      className="sticky start-0 flex max-w-[calc(100vw-2rem)] flex-col gap-2 pb-2 [&:empty]:hidden"
    >
      {views}
      {children}
    </div>
  );
};
