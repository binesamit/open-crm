// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  t,
  type DashboardColumns,
  type DashboardDetail,
  type DashboardFilter,
  type MyAccount,
  type WidgetItems,
  WIDGET_TYPES,
  msgKey,
  dynamicKey,
} from '@bines/shared';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  Input,
  Menu,
  MenuTrigger,
  Notice,
  Picker,
  SkeletonRows,
  useActionMenu,
  type MenuEntry,
} from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDelete } from '../../lib/dialogs';
import { appLink, copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { GatedButton, PlanGateBanner, usePlanGate } from '../../lib/plan-gate';
import { gateMenuEntry } from '../../lib/plan-limit';
import { useDeletedToast } from '../../lib/undo';
import { useMembers } from '../board/board-api';
import { dashboardKeys, dashboardPath, useDashboard, useDashboardLive, useDashboardMutations } from './dashboard-api';
import { DashboardGrid } from './DashboardGrid';
import { DashboardSourcesDialog } from './DashboardDialogs';
import { DASHBOARD_KIND_ICON, DashboardShareDialog, dashboardKindOf } from './DashboardShareDialog';
import { WidgetCard } from './WidgetCard';
import { type DrillSource, WidgetDrillContext } from './widget-drill';
import { widgetPreset } from './widget-presets';
import { DashboardGlyph } from './DashboardGlyph';
import { favoritesOf, useAllFavorites } from '../shell/use-favorites';
import { useQueryClient } from '@tanstack/react-query';
import './viz.css';
import { SearchClear } from '../../lib/search-clear';
import { useExtensionWidgetEntries } from '../extensions/ExtensionSlots';

/**
 * A dashboard (M8 ד4–ד5, D25): a full page in the workspace — the F4 page anatomy (icon, title, kind, actions),
 * a filter bar for every widget, and the widgets on a 12-column grid that owners arrange by dragging. Each
 * widget's data comes from the server for this viewer; the page refreshes live when a source board changes.
 */
export const DashboardPage = ({ account, dashboardId }: { account: MyAccount; dashboardId: string }) => {
  const d = useDashboard(account.id, dashboardId);
  useDashboardLive(account.id, dashboardId);
  if (d.isPending)
    return (
      <main className="w-full px-4 py-5 md:px-6">
        <SkeletonRows rows={6} label={t('app.loading')} />
      </main>
    );
  if (!d.data)
    return (
      <main className="w-full px-4 py-5 md:px-6" data-testid="dashboard-page-error">
        <Notice tone="error">{d.error ? errorMessage(d.error) : t('error.not_found')}</Notice>
      </main>
    );
  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="dashboard-page" data-dashboard-id={d.data.id}>
      <DashboardView account={account} dashboard={d.data} />
    </main>
  );
};

const KIND_TONE = { main: 'ok', private: 'violet', shareable: 'info' } as const;

const DashboardView = ({ account, dashboard }: { account: MyAccount; dashboard: DashboardDetail }) => {
  const mut = useDashboardMutations(account.id);
  const deleted = useDeletedToast(account.id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const menu = useActionMenu();
  const addMenu = useActionMenu();
  const members = useMembers(account.id).data?.data ?? [];
  const [renaming, setRenaming] = useState(false);
  const [sources, setSources] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [search, setSearch] = useState(dashboard.settings.filter.search ?? '');
  const [person, setPerson] = useState(dashboard.settings.filter.person ?? '');
  const [filter, setFilter] = useState<DashboardFilter>(dashboard.settings.filter);
  const drillSource: DrillSource = {
    key: [...dashboardKeys.data(account.id, dashboard.id), filter],
    fetch: (w, pick, cursor) =>
      api(account.id).post<WidgetItems>(`/dashboards/${dashboard.id}/widgets/${w.id}/items`, {
        pick,
        filter,
        ...(cursor ? { cursor } : {}),
      }),
    openItem: (boardId, itemId) =>
      void navigate({
        to: '/a/$accountSlug/dash/$dashboardId/i/$boardId/$itemId',
        params: { accountSlug: account.slug, dashboardId: dashboard.id, boardId, itemId },
      }),
  };
  const canEdit = dashboard.capabilities['dashboard.edit'];
  // An editor (edit without manage) changes widgets, layout, sources and filter — not sharing, kind or delete.
  const canManage = dashboard.capabilities['dashboard.manage'];
  // Plan feature gate: without `dashboards` it opens read-only — add widget, layout, rename, share
  // and sources stay visible but disabled with the hint, and a banner says why (the server refuses anyway).
  const dashGate = usePlanGate(account.id, 'dashboards');
  const editable = canEdit && dashGate.allowed;
  // The widgets read their rights from the dashboard: read-only ones while the plan lacks `dashboards`.
  const viewed = editable
    ? dashboard
    : { ...dashboard, capabilities: { ...dashboard.capabilities, 'dashboard.edit': false, 'dashboard.manage': false } };
  const kind = dashboardKindOf(dashboard);
  const path = dashboardPath(account.slug, dashboard.id);
  // Favourites (Fix: ): a dashboard can be starred like a board or a doc — first in its ⋯ menu.
  const favorites = favoritesOf(useAllFavorites(account.id), 'dashboard');
  const favorite = favorites.isFavorite(dashboard.id);

  // The search applies after a pause in typing; the person at once.
  useEffect(() => {
    const id = setTimeout(
      () => setFilter({ ...(search.trim() ? { search: search.trim() } : {}), ...(person ? { person } : {}) }),
      300,
    );
    return () => clearTimeout(id);
  }, [search, person]);

  const extWidgets = useExtensionWidgetEntries(account.id, dashboard.workspace_id, (v) =>
    mut.addWidget.mutate({ id: dashboard.id, type: 'extension', title: v.title, settings: v.settings }),
  );
  const addWidget = async (type: string) => {
    const columns = await qc
      .fetchQuery({
        queryKey: dashboardKeys.columns(account.id, dashboard.id),
        queryFn: () => api(account.id).get<DashboardColumns>(`/dashboards/${dashboard.id}/columns`),
      })
      .catch(() => undefined);
    mut.addWidget.mutate({
      id: dashboard.id,
      type,
      settings: widgetPreset(type, columns),
    });
  };

  const items: MenuEntry[] = [
    {
      label: t(msgKey(favorite ? 'sidebar.unfavorite' : 'sidebar.favorite')),
      testId: 'dashboard-page-menu-favorite',
      disabled: !favorites.loaded,
      onSelect: () =>
        favorites.toggle({ id: dashboard.id, name: dashboard.name, workspace_id: dashboard.workspace_id }),
    },
    { kind: 'separator' },
    { label: t('menu.copyLink'), testId: 'dashboard-menu-copy-link', onSelect: () => copyText(appLink(path)) },
    ...(account.role === 'admin' || account.role === 'member'
      ? [
          gateMenuEntry(dashGate, {
            label: t('dashboards.duplicate'),
            testId: 'dashboard-menu-duplicate',
            onSelect: () =>
              mut.duplicate.mutate(
                { id: dashboard.id },
                {
                  onSuccess: (copy) =>
                    void navigate({
                      to: '/a/$accountSlug/dash/$dashboardId',
                      params: { accountSlug: account.slug, dashboardId: copy.id },
                    }),
                },
              ),
          }),
        ]
      : []),
    ...(canManage
      ? [
          { kind: 'separator' as const },
          {
            label: t('menu.delete'),
            danger: true,
            testId: 'dashboard-menu-delete',
            onSelect: () =>
              void confirmDelete(dashboard.name).then(
                (ok) =>
                  ok &&
                  mut.remove.mutate(
                    { id: dashboard.id, name: dashboard.name },
                    {
                      onSuccess: (res) => {
                        deleted(dashboard.name, res);
                        void navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
                      },
                    },
                  ),
              ),
          },
        ]
      : []),
  ];
  const addItems: MenuEntry[] = [
    ...WIDGET_TYPES.filter((type) => type !== 'extension').map((type) => ({
      label: t(dynamicKey(`dashboards.type.${type}`)),
      testId: `add-widget-${type}`,
      onSelect: () => void addWidget(type),
    })),
    // Installed extensions' widgets (D27 ת5), each by its own name.
    ...(extWidgets.length ? [{ kind: 'separator' } as MenuEntry, ...extWidgets] : []),
  ];
  const error = mut.update.error ?? mut.remove.error ?? mut.addWidget.error ?? mut.saveLayout.error;
  const personOptions = [
    { value: '', label: t('dashboards.filter.anyone') },
    { value: 'me', label: t('dashboards.filter.me') },
    ...members
      .filter((m) => m.status === 'active' && m.role !== 'guest')
      .map((m) => ({ value: `user:${m.user_id}`, label: m.name || m.email, keywords: m.email })),
  ];

  return (
    <div className="mx-auto w-full max-w-[1400px]" data-testid="dashboard-view">
      {canEdit ? (
        <div className="mb-3 overflow-hidden rounded-[10px]">
          <PlanGateBanner gate={dashGate} />
        </div>
      ) : null}
      <header className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-[14px] bg-accent-soft text-accent-fg max-md:size-10"
        >
          <DashboardGlyph size={24} />
        </span>
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          {renaming ? (
            <TitleInput
              initial={dashboard.name}
              onDone={(name) => {
                setRenaming(false);
                if (name && name !== dashboard.name) mut.update.mutate({ id: dashboard.id, name });
              }}
            />
          ) : (
            <h1
              className={cn(
                'truncate font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl',
                editable && 'cursor-text rounded-[8px] hover:bg-surface-2',
              )}
              data-testid="dashboard-title"
              title={editable ? t('menu.rename') : undefined}
              onClick={editable ? () => setRenaming(true) : undefined}
            >
              {dashboard.name}
            </h1>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={KIND_TONE[kind]}>
              <Icon name={DASHBOARD_KIND_ICON[kind]} size={12} />
              <span data-testid="dashboard-kind" data-kind={kind}>
                {t(msgKey(`dashboards.kind.${kind}`))}
              </span>
            </Badge>
            <span data-testid="dashboard-board-count">
              {t('dashboards.boardsCount', { n: dashboard.boards.length })}
            </span>
            {/* Guests are never told about boards they cannot see (the server sends 0 for them too). */}
            {dashboard.hidden_boards && account.role !== 'guest' ? (
              <span title={t('dashboards.hiddenBoards.hint')}>
                · {t('dashboards.hiddenBoards', { n: dashboard.hidden_boards })}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canEdit ? (
            <GatedButton
              gate={dashGate}
              upgrade={false}
              variant="secondary"
              onClick={() => setSources(true)}
              data-testid="dashboard-sources-open"
            >
              <Icon name="board" size={15} />
              <span className="max-sm:hidden">{t('dashboards.sources')}</span>
            </GatedButton>
          ) : null}
          {canManage ? (
            <GatedButton
              gate={dashGate}
              upgrade={false}
              variant="secondary"
              onClick={() => setSharing(true)}
              data-testid="dashboard-share-open"
            >
              <Icon name="people" size={15} />
              <span className="max-sm:hidden">{t('dashboards.share')}</span>
            </GatedButton>
          ) : null}
          {canEdit ? (
            <>
              <GatedButton
                gate={dashGate}
                upgrade={false}
                variant="accent"
                onClick={addMenu.fromTrigger}
                data-testid="dashboard-add-widget"
                data-tour="dashboard.add-widget"
                busy={mut.addWidget.isPending}
              >
                <Icon name="plus" size={15} />
                {t('dashboards.addWidget')}
              </GatedButton>
              <Menu at={addMenu.at} onClose={addMenu.close} items={addItems} label={t('dashboards.addWidget')} />
            </>
          ) : null}
          <div className="group">
            <MenuTrigger
              label={t('sidebar.actionsFor', { name: dashboard.name })}
              onClick={menu.fromTrigger}
              className="h-9 px-2 text-lg opacity-100"
            />
          </div>
          <Menu
            at={menu.at}
            onClose={menu.close}
            items={items}
            label={t('sidebar.actionsFor', { name: dashboard.name })}
          />
        </div>
      </header>

      {/* One row of filters above the widgets (dataviz: filters in one row above the charts). */}
      <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="dashboard-filter-bar">
        <div className="relative w-64 max-sm:w-full">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <div className="relative">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('dashboards.filter.search')}
              aria-label={t('dashboards.filter.search')}
              className="ps-8 pe-7"
              data-testid="dashboard-search"
            />
            <SearchClear value={search} onClear={() => setSearch('')} testId="dashboard-search-clear" />
          </div>
        </div>
        <Picker
          label={t('dashboards.filter.person')}
          value={person}
          options={personOptions}
          searchable
          className="w-48"
          testId="dashboard-person"
          onChange={setPerson}
        />
        {editable &&
        (filter.search !== dashboard.settings.filter.search || filter.person !== dashboard.settings.filter.person) ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="dashboard-filter-save"
            onClick={() => mut.update.mutate({ id: dashboard.id, settings: { filter } })}
          >
            {t('dashboards.filter.save')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3">
          <Notice tone="error">{errorMessage(error)}</Notice>
        </div>
      ) : null}

      <div className="mt-4">
        {!dashboard.widgets.length ? (
          <EmptyState
            testId="dashboard-empty"
            icon={<DashboardGlyph size={28} />}
            title={t(
              msgKey(dashboard.boards.length || !canEdit ? 'dashboards.empty.title' : 'dashboards.empty.noBoards'),
            )}
            action={
              canEdit ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {!dashboard.boards.length ? (
                    <GatedButton gate={dashGate} upgrade={false} variant="secondary" onClick={() => setSources(true)}>
                      {t('dashboards.sources')}
                    </GatedButton>
                  ) : null}
                  <GatedButton
                    gate={dashGate}
                    upgrade={false}
                    variant="accent"
                    onClick={addMenu.fromTrigger}
                    data-testid="dashboard-empty-add"
                    data-tour="dashboard.add-widget"
                  >
                    {t('dashboards.addWidget')}
                  </GatedButton>
                </div>
              ) : null
            }
          >
            {t('dashboards.empty.hint')}
          </EmptyState>
        ) : (
          // Prod /: a widget's values list their items, and an item opens its card over the dashboard.
          <WidgetDrillContext.Provider value={drillSource}>
            <DashboardGrid
              widgets={dashboard.widgets}
              editable={editable}
              onLayout={(next) =>
                mut.saveLayout.mutate({ id: dashboard.id, widgets: next.map((n) => ({ id: n.id, position: n.rect })) })
              }
              render={(w, handles) => (
                <WidgetCard account={account} dashboard={viewed} widget={w} filter={filter} handles={handles} />
              )}
            />
          </WidgetDrillContext.Provider>
        )}
      </div>

      {sources ? (
        <DashboardSourcesDialog account={account} dashboard={dashboard} onClose={() => setSources(false)} />
      ) : null}
      {sharing ? (
        <DashboardShareDialog account={account} dashboard={dashboard} onClose={() => setSharing(false)} />
      ) : null}
    </div>
  );
};

const TitleInput = ({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) => {
  const [value, setValue] = useState(initial);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onDone(value.trim() || null);
    if (e.key === 'Escape') onDone(null);
  };
  return (
    <Input
      autoFocus
      value={value}
      maxLength={255}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => onDone(value.trim() || null)}
      aria-label={t('menu.rename')}
      data-testid="dashboard-title-input"
      className="h-11 text-2xl font-bold"
    />
  );
};
