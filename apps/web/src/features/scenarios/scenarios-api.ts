// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScenarioDto, ScenarioGraph, ScenarioRunDto } from '@bines/shared';
import { api } from '../../lib/api';

/** phase 3 — a board's scenarios, their runs, and the changes. */
export const scenarioKeys = {
  list: (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'scenarios'] as const,
  runs: (accountId: string, id: string) => ['account', accountId, 'scenario', id, 'runs'] as const,
};

export const useScenarios = (accountId: string, boardId: string, enabled = true) =>
  useQuery({
    queryKey: scenarioKeys.list(accountId, boardId),
    queryFn: async () => (await api(accountId).get<{ data: ScenarioDto[] }>(`/boards/${boardId}/scenarios`)).data,
    enabled,
  });

export const useScenarioRuns = (accountId: string, id: string) =>
  useQuery({
    queryKey: scenarioKeys.runs(accountId, id),
    queryFn: async () => (await api(accountId).get<{ data: ScenarioRunDto[] }>(`/scenarios/${id}/runs?limit=50`)).data,
    refetchInterval: 15_000,
  });

export const useScenarioMutations = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: scenarioKeys.list(accountId, boardId) });
  const client = api(accountId);
  return {
    create: useMutation({
      mutationFn: (v: { name: string; graph?: ScenarioGraph }) =>
        client.post<ScenarioDto>(`/boards/${boardId}/scenarios`, v),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; name?: string; graph?: ScenarioGraph }) =>
        client.patch<ScenarioDto>(`/scenarios/${v.id}`, { name: v.name, graph: v.graph }),
      onSuccess: refresh,
    }),
    setActive: useMutation({
      mutationFn: (v: { id: string; active: boolean }) =>
        client.put<ScenarioDto>(`/scenarios/${v.id}/active`, { active: v.active }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.delete(`/scenarios/${id}`),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: (v: { id: string; itemId: string }) =>
        client.post<ScenarioRunDto>(`/scenarios/${v.id}/test`, { item_id: v.itemId }),
      onSuccess: (_r, v) => {
        void refresh();
        void qc.invalidateQueries({ queryKey: scenarioKeys.runs(accountId, v.id) });
        void qc.invalidateQueries({ queryKey: ['account', accountId, 'board', boardId, 'items'] });
      },
    }),
  };
};
