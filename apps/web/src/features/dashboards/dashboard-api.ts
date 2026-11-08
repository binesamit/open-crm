// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  t,
  UNDO_TOAST_SECONDS,
  type DashboardColumns,
  type DashboardDetail,
  type DashboardFilter,
  type DashboardKind,
  type DashboardMembers,
  type InviteToDashboardResult,
  type Deleted,
  type GridRect,
  type Query,
  type Widget,
  type WidgetData,
} from '@bines/shared';
import { api } from '../../lib/api';
import { useEventStream } from '../../lib/realtime';
import { showToast } from '../../lib/toast';
import { boardKeys } from '../board/board-api';

/** Dashboards (M8 ד4–ד5): the dashboard, its members, its sources' columns, each widget's data, mutations. */
export const dashboardKeys = {
  dashboard: (accountId: string, id: string) => ['account', accountId, 'dashboard', id] as const,
  members: (accountId: string, id: string) => ['account', accountId, 'dashboard', id, 'members'] as const,
  columns: (accountId: string, id: string) => ['account', accountId, 'dashboard', id, 'columns'] as const,
  data: (accountId: string, id: string) => ['account', accountId, 'dashboard', id, 'data'] as const,
  sourceOptions: (accountId: string) => ['account', accountId, 'dashboard-source-options'] as const,
};

export const dashboardPath = (accountSlug: string, id: string) => `/a/${accountSlug}/dash/${id}`;

export const useDashboard = (accountId: string, id: string) =>
  useQuery({
    queryKey: dashboardKeys.dashboard(accountId, id),
    queryFn: () => api(accountId).get<DashboardDetail>(`/dashboards/${id}`),
  });

export const useDashboardColumns = (accountId: string, id: string, enabled = true) =>
  useQuery({
    queryKey: dashboardKeys.columns(accountId, id),
    queryFn: () => api(accountId).get<DashboardColumns>(`/dashboards/${id}/columns`),
    enabled,
  });

export const useDashboardMembers = (accountId: string, id: string) =>
  useQuery({
    queryKey: dashboardKeys.members(accountId, id),
    queryFn: () => api(accountId).get<DashboardMembers>(`/dashboards/${id}/members`),
  });

/** A widget's data for me, with the filter bar as I have it now. */
export const useWidgetData = <D>(
  accountId: string,
  dashboardId: string,
  widget: Widget,
  filter: DashboardFilter,
  enabled: boolean,
) =>
  useQuery({
    queryKey: [...dashboardKeys.data(accountId, dashboardId), widget.id, widget.settings, filter] as const,
    queryFn: () =>
      api(accountId).post<WidgetData<D>>(`/dashboards/${dashboardId}/widgets/${widget.id}/data`, { filter }),
    enabled,
    placeholderData: (prev) => prev,
  });

/**
 * A widget of a board's Dashboard view (round 15): its data for me from the board, with the view's query when the
 * view narrows its widgets. Under the board's items key, so the board's live refresh reloads it too.
 */
export const useBoardWidgetData = <D>(
  accountId: string,
  boardId: string,
  widget: Pick<Widget, 'type' | 'settings'>,
  query: Query | undefined,
  enabled: boolean,
) =>
  useQuery({
    queryKey: ['account', accountId, 'board', boardId, 'items', 'widget-data', widget.type, widget.settings, query],
    queryFn: () =>
      api(accountId).post<WidgetData<D>>(`/boards/${boardId}/widget-data`, {
        widget: { type: widget.type, settings: widget.settings },
        ...(query ? { query } : {}),
      }),
    enabled,
    placeholderData: (prev) => prev,
  });

export const boardWidgetColumnsKey = (accountId: string, boardId: string) =>
  ['account', accountId, 'board', boardId, 'widget-columns'] as const;
export const fetchBoardWidgetColumns = (accountId: string, boardId: string) =>
  api(accountId).get<DashboardColumns>(`/boards/${boardId}/widget-columns`);
export const useBoardWidgetColumns = (accountId: string, boardId: string, enabled = true) =>
  useQuery({
    queryKey: boardWidgetColumnsKey(accountId, boardId),
    queryFn: () => fetchBoardWidgetColumns(accountId, boardId),
    enabled,
  });

/**
 * Live refresh (plan §3.4): the dashboard stream says "something changed" — a source board or the dashboard itself
 * — and the widgets refetch, at most every 2 seconds.
 */
export const useDashboardLive = (accountId: string, id: string) => {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef({ data: false, dashboard: false });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEventStream(`/dashboards/${id}/events`, accountId, (e) => {
    if (e.type === 'ready') return;
    const own = e.type.startsWith('dashboard.') || e.type === 'resync';
    dirty.current.data = true;
    if (own) dirty.current.dashboard = true;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const d = dirty.current;
      dirty.current = { data: false, dashboard: false };
      if (d.dashboard) void qc.invalidateQueries({ queryKey: dashboardKeys.dashboard(accountId, id), exact: true });
      if (d.data) void qc.invalidateQueries({ queryKey: dashboardKeys.data(accountId, id) });
    }, 2000);
  });
};

export type DashboardPlace = { after_id: string } | { before_id: string };

const TREE_FIELDS = ['name', 'icon', 'kind', 'folder_id', 'workspace_id', 'position'] as const;

export const useDashboardMutations = (accountId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const refresh = async (id?: string) => {
    await qc.invalidateQueries({ queryKey: ['account', accountId, 'tree'] });
    await qc.invalidateQueries({ queryKey: boardKeys.workspaces(accountId) });
    if (id) await qc.invalidateQueries({ queryKey: dashboardKeys.dashboard(accountId, id), exact: true });
  };
  const setDashboard = (id: string, fn: (d: DashboardDetail) => DashboardDetail) =>
    qc.setQueryData<DashboardDetail>(dashboardKeys.dashboard(accountId, id), (old) => (old ? fn(old) : old));
  return {
    create: useMutation({
      mutationFn: (v: { workspaceId: string; folder_id: string | null; name?: string }) =>
        client.post<DashboardDetail>(`/workspaces/${v.workspaceId}/dashboards`, {
          folder_id: v.folder_id,
          name: v.name,
        }),
      onSuccess: () => refresh(),
    }),
    update: useMutation({
      mutationFn: (v: {
        id: string;
        name?: string;
        description?: string;
        icon?: string | null;
        kind?: DashboardKind;
        folder_id?: string | null;
        workspace_id?: string;
        position?: DashboardPlace;
        settings?: { board_ids?: string[]; filter?: DashboardFilter };
      }) => {
        const { id, ...patch } = v;
        return client.patch<DashboardDetail>(`/dashboards/${id}`, patch);
      },
      onSuccess: (d, v) => {
        qc.setQueryData(dashboardKeys.dashboard(accountId, d.id), d);
        void qc.invalidateQueries({ queryKey: dashboardKeys.columns(accountId, d.id) });
        void qc.invalidateQueries({ queryKey: dashboardKeys.data(accountId, d.id) });
        // The sidebar trees show name, icon, kind and place only: a change of boards / filter / description does
        // not wait for every workspace tree to reload (an account with many workspaces made "save" hang).
        const inTree = TREE_FIELDS.some((f) => v[f] !== undefined);
        return inTree ? refresh() : undefined;
      },
    }),
    remove: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.delete<Deleted>(`/dashboards/${v.id}`),
      onSuccess: (_r, v) => refresh(v.id),
    }),
    duplicate: useMutation({
      mutationFn: (v: { id: string }) => client.post<DashboardDetail>(`/dashboards/${v.id}/duplicate`, {}),
      onSuccess: () => refresh(),
    }),
    setMembers: useMutation({
      mutationFn: (v: { id: string; members: { type: 'user' | 'team'; id: string; level: string }[] }) =>
        client.put<DashboardMembers>(`/dashboards/${v.id}/members`, { members: v.members }),
      onSuccess: (res, v) => {
        qc.setQueryData(dashboardKeys.members(accountId, v.id), res);
        return refresh(v.id);
      },
    }),
    /** POST /dashboards/:id/invite — share by email (people in the account join at once, new people are invited). */
    invite: useMutation({
      mutationFn: (v: {
        id: string;
        emails: string[];
        role: 'member' | 'guest';
        level: string;
        message?: string;
        send_email?: boolean;
      }) => {
        const { id, ...body } = v;
        return client.post<InviteToDashboardResult>(`/dashboards/${id}/invite`, body);
      },
      onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: dashboardKeys.members(accountId, v.id) }),
    }),
    addWidget: useMutation({
      mutationFn: (v: { id: string; type: string; title?: string; settings?: Record<string, unknown> }) =>
        client.post<Widget>(`/dashboards/${v.id}/widgets`, { type: v.type, title: v.title, settings: v.settings }),
      onSuccess: (_w, v) => qc.invalidateQueries({ queryKey: dashboardKeys.dashboard(accountId, v.id), exact: true }),
    }),
    updateWidget: useMutation({
      mutationFn: (v: { dashboardId: string; id: string; title?: string; settings?: Record<string, unknown> }) =>
        client.patch<Widget>(`/dashboard-widgets/${v.id}`, { title: v.title, settings: v.settings }),
      onSuccess: (w, v) =>
        setDashboard(v.dashboardId, (d) => ({ ...d, widgets: d.widgets.map((x) => (x.id === w.id ? w : x)) })),
    }),
    removeWidget: useMutation({
      mutationFn: (v: { dashboardId: string; id: string; title: string }) =>
        client.delete<Deleted>(`/dashboard-widgets/${v.id}`),
      onSuccess: (_r, v) => {
        setDashboard(v.dashboardId, (d) => ({ ...d, widgets: d.widgets.filter((x) => x.id !== v.id) }));
        // Not an activity undo: the widget comes back through its own restore.
        showToast({
          message: t('trash.toast.deleted', { what: v.title }),
          seconds: UNDO_TOAST_SECONDS,
          action: {
            label: t('undo.action'),
            run: async () => {
              await client.post(`/dashboard-widgets/${v.id}/restore`, {});
              await qc.invalidateQueries({ queryKey: dashboardKeys.dashboard(accountId, v.dashboardId), exact: true });
            },
          },
        });
      },
    }),
    saveLayout: useMutation({
      mutationFn: (v: { id: string; widgets: { id: string; position: GridRect }[] }) =>
        client.put<{ widgets: Widget[] }>(`/dashboards/${v.id}/layout`, { widgets: v.widgets }),
      onMutate: (v) => {
        const at = new Map(v.widgets.map((w) => [w.id, w.position]));
        setDashboard(v.id, (d) => ({
          ...d,
          widgets: d.widgets.map((w) => ({ ...w, position: at.get(w.id) ?? w.position })),
        }));
      },
      onSuccess: (res, v) => setDashboard(v.id, (d) => ({ ...d, widgets: res.widgets })),
      // A refused layout (rights changed, conflict, network) is re-read, not left on screen (audit 2026-10-10 web #5).
      onError: (_e, v) =>
        void qc.invalidateQueries({ queryKey: dashboardKeys.dashboard(accountId, v.id), exact: true }),
    }),
  };
};
