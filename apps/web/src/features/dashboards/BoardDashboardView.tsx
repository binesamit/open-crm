// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  getWidgetDef,
  type MyAccount,
  newId,
  nextFreeRect,
  parseWidgetSettings,
  type Query,
  t,
  VIEW_WIDGET_TYPES,
  type ViewDashboard,
  type ViewSettings,
  type ViewWidget,
  type Widget,
  type WidgetItems,
  widgetTypes,
  msgKey,
} from '@bines/shared';
import { EmptyState, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { api } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { GatedButton, PlanGateBanner, usePlanGate } from '../../lib/plan-gate';
import type { BoardDetail } from '../board/board-api';
import {
  boardWidgetColumnsKey,
  fetchBoardWidgetColumns,
  useBoardWidgetColumns,
  useBoardWidgetData,
} from './dashboard-api';
import { DashboardGlyph } from './DashboardGlyph';
import { DashboardGrid, type GridHandles } from './DashboardGrid';
import { WidgetFrame } from './WidgetCard';
import { type DrillSource, WidgetDrillContext } from './widget-drill';
import { widgetPreset } from './widget-presets';
import './viz.css';

type Update = (fn: (s: ViewSettings) => ViewSettings) => void;
const EMPTY: ViewDashboard = { widgets: [], apply_view_filter: true };

/**
 * A board's Dashboard view (round 15): the workspace dashboard's widgets — the same grid, cards, settings forms,
 * renderers and server engine — over this board's items and / or subitems. The widgets are the view's settings,
 * so adding, arranging or configuring one is a change of the view like any other (draft → save, or save as a new
 * view); when the view says so, its toolbar's filter, search and person narrow every widget.
 */
export const BoardDashboardView = ({
  account,
  board,
  settings,
  query,
  update,
}: {
  account: MyAccount;
  board: BoardDetail;
  settings: ViewSettings;
  /** The view's effective query (the toolbar), pruned to the board's columns. */
  query: Query;
  update: Update;
}) => {
  const qc = useQueryClient();
  const addMenu = useActionMenu();
  // Plan feature gate: without `dashboards` the widgets stay readable, nothing is added or moved.
  const dashGate = usePlanGate(account.id, 'dashboards');
  const dash = settings.dashboard ?? EMPTY;
  const narrowBy = dash.apply_view_filter ? query : undefined;
  // a widget's values list their items (from the board, under the view's filter), and an item opens
  // its card over the board.
  const navigate = useNavigate();
  const drillSource: DrillSource = {
    key: ['account', account.id, 'board', board.id, 'items', 'widget-items', narrowBy],
    fetch: (w, pick, cursor) =>
      api(account.id).post<WidgetItems>(`/boards/${board.id}/widget-items`, {
        widget: { type: w.type, settings: w.settings },
        ...(narrowBy ? { query: narrowBy } : {}),
        pick,
        ...(cursor ? { cursor } : {}),
      }),
    openItem: (boardId, itemId) =>
      void navigate({
        to: '/a/$accountSlug/b/$boardId/i/$itemId',
        params: { accountSlug: account.slug, boardId, itemId },
        search: (prev: Record<string, unknown>) => prev,
      } as never),
  };
  const setDash = (fn: (d: ViewDashboard) => ViewDashboard) =>
    update((s) => ({ ...s, dashboard: fn(s.dashboard ?? EMPTY) }));

  const addWidget = async (type: ViewWidget['type']) => {
    const columns = await qc
      .fetchQuery({
        queryKey: boardWidgetColumnsKey(account.id, board.id),
        queryFn: () => fetchBoardWidgetColumns(account.id, board.id),
      })
      .catch(() => undefined);
    const def = getWidgetDef(type);
    setDash((d) => ({
      ...d,
      widgets: [
        ...d.widgets,
        {
          id: newId(),
          type,
          title: '',
          position: nextFreeRect(
            d.widgets.map((w) => ({ id: w.id, rect: w.position })),
            def.defaultSize,
          ),
          settings: parseWidgetSettings(type, widgetPreset(type, columns)),
        },
      ],
    }));
  };
  const addItems: MenuEntry[] = VIEW_WIDGET_TYPES.map((type) => ({
    label: t(msgKey(`dashboards.type.${type}`)),
    testId: `add-widget-${type}`,
    onSelect: () => void addWidget(type),
  }));

  return (
    <div className="flex flex-col gap-3 pb-6" data-testid="dashboard-board-view">
      {dashGate.allowed ? null : (
        <div className="overflow-hidden rounded-[10px]">
          <PlanGateBanner gate={dashGate} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted" data-testid="dashboard-board-view-scope">
          {t(msgKey(dash.apply_view_filter ? 'dashboards.view.narrowed' : 'dashboards.view.wholeBoard'))}
        </span>
        <span className="flex-1" />
        <GatedButton
          gate={dashGate}
          upgrade={false}
          variant="accent"
          onClick={addMenu.fromTrigger}
          data-testid="dashboard-add-widget"
          data-tour="dashboard.add-widget"
        >
          <Icon name="plus" size={15} />
          {t('dashboards.addWidget')}
        </GatedButton>
        <Menu at={addMenu.at} onClose={addMenu.close} items={addItems} label={t('dashboards.addWidget')} />
      </div>
      {!dash.widgets.length ? (
        <EmptyState
          testId="dashboard-empty"
          icon={<DashboardGlyph size={28} />}
          title={t('dashboards.empty.title')}
          action={
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
          }
        >
          {t('dashboards.view.emptyHint')}
        </EmptyState>
      ) : (
        <WidgetDrillContext.Provider value={drillSource}>
          <DashboardGrid
            widgets={dash.widgets}
            editable={dashGate.allowed}
            onLayout={(next) => {
              const at = new Map(next.map((n) => [n.id, n.rect]));
              setDash((d) => ({
                ...d,
                widgets: d.widgets.map((w) => ({ ...w, position: at.get(w.id) ?? w.position })),
              }));
            }}
            render={(w, handles) => (
              <BoardWidgetCard
                account={account}
                board={board}
                widget={w}
                query={narrowBy}
                handles={handles}
                canEdit={dashGate.allowed}
                onSave={(patch) =>
                  setDash((d) => ({ ...d, widgets: d.widgets.map((x) => (x.id === w.id ? { ...x, ...patch } : x)) }))
                }
                onRemove={() => setDash((d) => ({ ...d, widgets: d.widgets.filter((x) => x.id !== w.id) }))}
              />
            )}
          />
        </WidgetDrillContext.Provider>
      )}
    </div>
  );
};

/** One widget of the view: its data from the board, its settings saved into the view's draft. */
const BoardWidgetCard = ({
  account,
  board,
  widget,
  query,
  handles,
  canEdit,
  onSave,
  onRemove,
}: {
  account: MyAccount;
  board: BoardDetail;
  widget: Widget;
  query: Query | undefined;
  handles: GridHandles | null;
  canEdit: boolean;
  onSave: (patch: { title: string; settings: Record<string, unknown> }) => void;
  onRemove: () => void;
}) => {
  const def = widgetTypes.get(widget.type);
  const data = useBoardWidgetData(account.id, board.id, widget, query, !!def?.readsBoards);
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const columns = useBoardWidgetColumns(account.id, board.id, editing);
  return (
    <WidgetFrame
      account={account}
      widget={widget}
      data={data}
      handles={handles}
      canEdit={canEdit}
      boards={[{ id: board.id, name: board.name }]}
      columns={columns.data}
      editing={editing}
      setEditing={(v) => {
        setSaveError(null);
        setEditing(v);
      }}
      saving={false}
      saveError={saveError}
      onSave={(v) => {
        try {
          onSave({ title: v.title, settings: parseWidgetSettings(widget.type, v.settings) });
          setEditing(false);
        } catch (e) {
          setSaveError(e);
        }
      }}
      onRemove={onRemove}
    />
  );
};
