// SPDX-License-Identifier: AGPL-3.0-only
import { AreaBoundary } from '../../lib/error-screen';
import { useState, type ReactNode } from 'react';
import {
  t,
  type DashboardColumns,
  type DashboardDetail,
  type DashboardFilter,
  type MyAccount,
  type Widget,
  type WidgetData,
  widgetTypes,
  dynamicKey,
} from '@bines/shared';
import { Menu, MenuTrigger, Notice, Skeleton, useActionMenu, type MenuEntry } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDelete } from '../../lib/dialogs';
import { useDashboardColumns, useDashboardMutations, useWidgetData } from './dashboard-api';
import type { GridHandles } from './DashboardGrid';
import { TextView, WIDGET_VIEWS } from './WidgetViews';
import { type WidgetBoards, WidgetSettingsDialog } from './WidgetSettings';
import { ExtensionWidget } from '../extensions/ExtensionSlots';
import { canDrill, DrillPanel, type DrillState, useDrillSource } from './widget-drill';

/** A widget's data as its card needs it (a react-query result). */
type DataState = { data?: WidgetData; isPending: boolean; error: unknown };

/**
 * One widget on the grid (F4 card): its title, what it reads (and how many sources the viewer cannot see), its
 * data — and, for editors, the move handle, the resize corner and a ⋯ menu (settings, remove). The frame knows
 * nothing of where widgets live: a workspace dashboard (`WidgetCard`) and a board's Dashboard view (round 15)
 * give it their data, columns and saves.
 */
export const WidgetFrame = ({
  account,
  widget,
  data,
  handles,
  canEdit,
  boards,
  columns,
  editing,
  setEditing,
  onSave,
  saving,
  saveError,
  onRemove,
  extension,
}: {
  account: MyAccount;
  widget: Widget;
  data: DataState;
  handles: GridHandles | null;
  canEdit: boolean;
  boards: WidgetBoards;
  /** The pickers' columns (loaded while editing). */
  columns: DashboardColumns | undefined;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onSave: (v: { title: string; settings: Record<string, unknown> }) => void;
  saving: boolean;
  saveError: unknown;
  onRemove: (title: string) => void;
  /** An extension's widget renders its own page instead of data. */
  extension?: ReactNode;
}) => {
  const def = widgetTypes.get(widget.type);
  const menu = useActionMenu();
  const typeLabel = t(dynamicKey(`dashboards.type.${widget.type}`));
  const title = widget.title || typeLabel;
  const View = WIDGET_VIEWS[widget.type];
  // Prod /: values list their items, items open their card — where the page says how.
  const source = useDrillSource();
  const [drill, setDrill] = useState<DrillState | null>(null);

  const items: MenuEntry[] = [
    // An extension's widget is configured inside its own page (its storage), not here.
    ...(widget.type === 'extension'
      ? []
      : ([
          {
            label: t('dashboards.widget.settings'),
            testId: 'widget-menu-settings',
            onSelect: () => setEditing(true),
          },
          { kind: 'separator' },
        ] as MenuEntry[])),
    {
      label: t('menu.delete'),
      danger: true,
      testId: 'widget-menu-delete',
      onSelect: () => void confirmDelete(title).then((ok) => ok && onRemove(title)),
    },
  ];

  return (
    <section
      className="flex h-full min-h-0 flex-col rounded-[16px] border border-line bg-surface p-3 shadow-[0_1px_2px_rgba(13,59,53,0.04)]"
      aria-label={title}
      data-testid="widget"
      data-type={widget.type}
      data-title={title}
    >
      <header className="mb-2 flex min-w-0 items-center gap-1">
        {handles?.moveHandle}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-heading" title={title}>
          {title}
        </h2>
        {data.data?.hidden_boards ? (
          <span
            className="shrink-0 rounded-full bg-surface-2 px-2 text-[0.6875rem] text-muted"
            data-tip={t('dashboards.hiddenBoards.hint')}
            title={t('dashboards.hiddenBoards.hint')}
            data-testid="widget-hidden-boards"
          >
            {t('dashboards.hiddenBoards', { n: data.data.hidden_boards })}
          </span>
        ) : null}
        {data.data?.truncated ? (
          <span className="shrink-0 text-[0.6875rem] text-warn" title={t('dashboards.truncated')}>
            ⚠
          </span>
        ) : null}
        {canEdit ? (
          <>
            <MenuTrigger
              label={t('sidebar.actionsFor', { name: title })}
              onClick={menu.fromTrigger}
              className="h-7 px-1.5"
            />
            <Menu at={menu.at} onClose={menu.close} items={items} label={t('sidebar.actionsFor', { name: title })} />
          </>
        ) : null}
      </header>
      <div className="min-h-0 flex-1" data-testid="widget-body">
        {!def ? (
          <Notice tone="warn">{t('dashboards.unknownType')}</Notice>
        ) : extension ? (
          extension
        ) : !def.readsBoards ? (
          <TextView widget={widget} />
        ) : data.isPending ? (
          <Skeleton className="h-full w-full rounded-[10px]" />
        ) : data.error ? (
          <Notice tone="error">{errorMessage(data.error)}</Notice>
        ) : View && data.data ? (
          // Round 12: a crash in one widget stays in its card; the rest of the dashboard keeps working.
          <AreaBoundary area="widget" resetKey={widget.id}>
            <View
              account={account}
              widget={widget}
              data={data.data}
              onDrill={source && canDrill(widget) ? (pick, label) => setDrill({ pick, label }) : undefined}
              openItem={source?.openItem}
            />
          </AreaBoundary>
        ) : null}
      </div>
      {handles?.resizeHandle}
      {drill && source ? (
        <DrillPanel widget={widget} title={title} drill={drill} source={source} onClose={() => setDrill(null)} />
      ) : null}
      {editing && columns ? (
        <WidgetSettingsDialog
          widget={widget}
          boards={boards}
          columns={columns}
          busy={saving}
          error={saveError}
          onClose={() => setEditing(false)}
          onSave={onSave}
        />
      ) : null}
    </section>
  );
};

/** A workspace dashboard's widget: its data, columns and saves through the dashboard's API. */
export const WidgetCard = ({
  account,
  dashboard,
  widget,
  filter,
  handles,
}: {
  account: MyAccount;
  dashboard: DashboardDetail;
  widget: Widget;
  filter: DashboardFilter;
  handles: GridHandles | null;
}) => {
  const def = widgetTypes.get(widget.type);
  const data = useWidgetData(account.id, dashboard.id, widget, filter, !!def?.readsBoards);
  const mut = useDashboardMutations(account.id);
  const [editing, setEditing] = useState(false);
  const columns = useDashboardColumns(account.id, dashboard.id, editing);
  return (
    <WidgetFrame
      account={account}
      widget={widget}
      data={data}
      handles={handles}
      canEdit={dashboard.capabilities['dashboard.edit']}
      boards={dashboard.boards}
      columns={columns.data}
      editing={editing}
      setEditing={setEditing}
      saving={mut.updateWidget.isPending}
      saveError={mut.updateWidget.error}
      onSave={(v) =>
        mut.updateWidget.mutate(
          { dashboardId: dashboard.id, id: widget.id, title: v.title, settings: v.settings },
          { onSuccess: () => setEditing(false) },
        )
      }
      onRemove={(title) => mut.removeWidget.mutate({ dashboardId: dashboard.id, id: widget.id, title })}
      extension={
        widget.type === 'extension' ? (
          <ExtensionWidget
            accountId={account.id}
            dashboardId={dashboard.id}
            widgetId={widget.id}
            settings={widget.settings as { installation_id?: string | null; feature?: string | null }}
          />
        ) : undefined
      }
    />
  );
};
