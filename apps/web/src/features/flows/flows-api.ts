// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Flow,
  FlowConnection,
  FlowConnectionSettings,
  FlowConnectionTarget,
  FlowDraft,
  FlowDraftAnswer,
  FlowLimit,
  FlowPlatform,
  FlowRun,
  FlowStats,
} from '@bines/shared';
import { api } from '../../lib/api';

/** "זרימות": connections to n8n / Make / Zapier, their flows and runs. */
export const flowKeys = {
  connections: (accountId: string) => ['account', accountId, 'flow-connections'] as const,
  flows: (accountId: string, id: string) => ['account', accountId, 'flow-connections', id, 'flows'] as const,
  runs: (accountId: string, id: string, flowId: string | null, status: string) =>
    ['account', accountId, 'flow-connections', id, 'runs', flowId ?? '', status] as const,
};

export const useFlowConnections = (accountId: string, enabled = true) =>
  useQuery({
    queryKey: flowKeys.connections(accountId),
    queryFn: () => api(accountId).get<{ data: FlowConnection[]; platforms: FlowPlatform[] }>('/flow-connections'),
    enabled,
  });

export type FlowList = { data: Flow[]; fetched_at: string | null; limited: FlowLimit | null };
export type FlowRunsAnswer = {
  data: FlowRun[];
  warning?: string;
  warning_detail?: string;
  limited?: FlowLimit | null;
  fetched_at?: string | null;
};
export type FlowStatsAnswer = { data: Record<string, FlowStats>; pending: string[]; limited: FlowLimit | null };

/**
 * The flows of a connection. The server keeps the platform's answer a while (the connection's cache settings — prod
 * Make's per-minute limit); `refresh` asks it to ask the platform now (it may answer what it kept, when the
 * last refresh was moments ago).
 */
export const useFlows = (accountId: string, connectionId: string | null) => {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: flowKeys.flows(accountId, connectionId ?? ''),
    queryFn: () => api(accountId).get<FlowList>(`/flow-connections/${connectionId}/flows`),
    enabled: !!connectionId,
    staleTime: 30_000,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => api(accountId).get<FlowList>(`/flow-connections/${connectionId}/flows?refresh=1`),
    onSuccess: (list) => qc.setQueryData(flowKeys.flows(accountId, connectionId ?? ''), list),
  });
  return { ...query, refresh };
};

/** Some flows' stats (platforms that load them per flow): what is not loaded now comes back in `pending`. */
export const fetchFlowStats = (accountId: string, connectionId: string, flowIds: string[], refresh = false) =>
  api(accountId).post<FlowStatsAnswer>(`/flow-connections/${connectionId}/flows/stats`, {
    flow_ids: flowIds,
    refresh,
  });

export const useFlowRuns = (
  accountId: string,
  connectionId: string,
  flowId: string | null,
  status: 'error' | 'all',
) => {
  const qc = useQueryClient();
  const path = (refresh: boolean) => {
    const q = new URLSearchParams({ status, limit: '50' });
    if (flowId) q.set('flow_id', flowId);
    if (refresh) q.set('refresh', '1');
    return `/flow-connections/${connectionId}/runs?${q}`;
  };
  const key = flowKeys.runs(accountId, connectionId, flowId, status);
  const query = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<FlowRunsAnswer>(path(false)),
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => api(accountId).get<FlowRunsAnswer>(path(true)),
    onSuccess: (runs) => qc.setQueryData(key, runs),
  });
  return { ...query, refresh };
};

export type NewFlowConnection = {
  name: string;
  target: FlowConnectionTarget;
  settings: Partial<FlowConnectionSettings>;
};

export const useFlowMutations = (accountId: string) => {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: flowKeys.connections(accountId) });
  return {
    create: useMutation({
      mutationFn: (v: NewFlowConnection) => api(accountId).post<FlowConnection>('/flow-connections', v),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: {
        id: string;
        name?: string;
        target?: FlowConnectionTarget;
        settings?: Partial<FlowConnectionSettings>;
        enabled?: boolean;
      }) => {
        const { id, ...patch } = v;
        return api(accountId).patch<FlowConnection>(`/flow-connections/${id}`, patch);
      },
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(accountId).delete(`/flow-connections/${id}`),
      onSuccess: done,
    }),
    test: useMutation({
      mutationFn: (id: string) => api(accountId).post<FlowConnection>(`/flow-connections/${id}/test`, {}),
      onSuccess: done,
    }),
    setActive: useMutation({
      mutationFn: (v: { id: string; flowId: string; active: boolean }) =>
        api(accountId).put<Flow>(`/flow-connections/${v.id}/flows/${encodeURIComponent(v.flowId)}/active`, {
          active: v.active,
        }),
      onSuccess: (_f, v) => qc.invalidateQueries({ queryKey: flowKeys.flows(accountId, v.id) }),
    }),
    retry: useMutation({
      mutationFn: (v: { id: string; runId: string; flowId: string | null }) =>
        api(accountId).post<{ run_id: string | null }>(
          `/flow-connections/${v.id}/runs/${encodeURIComponent(v.runId)}/retry${
            v.flowId ? `?flow_id=${encodeURIComponent(v.flowId)}` : ''
          }`,
          {},
        ),
      onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: ['account', accountId, 'flow-connections', v.id] }),
    }),
    aiDraft: useMutation({
      mutationFn: (v: { id: string; request: string }) =>
        api(accountId).post<FlowDraftAnswer>(`/flow-connections/${v.id}/drafts`, { request: v.request }),
    }),
    createFromDraft: useMutation({
      mutationFn: (v: { id: string; draft: FlowDraft }) =>
        api(accountId).post<Flow>(`/flow-connections/${v.id}/flows`, { draft: v.draft }),
      onSuccess: (_f, v) => qc.invalidateQueries({ queryKey: flowKeys.flows(accountId, v.id) }),
    }),
  };
};
