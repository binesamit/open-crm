// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Blueprint, OnboardingState } from '@bines/shared';
import { api } from '../../lib/api';

/** "How to start?": the start screen's state and its calls, inside an account. */
export const onboardingKeys = { state: (accountId: string) => ['account', accountId, 'onboarding'] as const };

export const useOnboarding = (accountId: string, enabled = true) =>
  useQuery({
    queryKey: onboardingKeys.state(accountId),
    queryFn: () => api(accountId).get<OnboardingState>('/onboarding'),
    enabled,
    staleTime: 60_000,
  });

export type AiMessage = { role: 'user' | 'assistant'; text: string };
export type AiReply = { text: string; blueprint: Blueprint | null };
export type Built = {
  workspace_id: string;
  board_ids: string[];
  dashboard_id: string | null;
  doc_ids?: string[];
  automation_ids?: string[];
  issues: string[];
};

export const useOnboardingActions = (accountId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  // Everything the account shows (workspaces, trees, the start screen) changes after a build.
  const refresh = () => qc.invalidateQueries({ queryKey: ['account', accountId] });
  return {
    installKit: async (kit: string, sample = true) => {
      const out = await client.post<{ workspace_id: string | null }>('/onboarding/kit', { kit, sample_data: sample });
      await refresh();
      return out;
    },
    ask: (messages: AiMessage[], blueprint: Blueprint | null) =>
      client.post<AiReply>('/onboarding/ai', { messages, ...(blueprint ? { blueprint } : {}) }),
    build: async (blueprint: Blueprint, skip: string[], sample: boolean) => {
      const out = await client.post<Built>('/onboarding/build', {
        blueprint,
        skip_boards: skip,
        sample_data: sample,
      });
      await refresh();
      return out;
    },
    skip: async () => {
      await client.post('/onboarding/skip', {});
      await refresh();
    },
    /** "Undo" after a build: what it made goes to the trash (restorable from there); the workspace stays. */
    removeBuilt: async (built: Pick<Built, 'board_ids' | 'dashboard_id' | 'doc_ids' | 'automation_ids'>) => {
      for (const id of built.automation_ids ?? []) await client.delete(`/automations/${encodeURIComponent(id)}`);
      if (built.dashboard_id) await client.delete(`/dashboards/${encodeURIComponent(built.dashboard_id)}`);
      for (const id of built.doc_ids ?? []) await client.delete(`/docs/${encodeURIComponent(id)}`);
      for (const id of built.board_ids) await client.delete(`/boards/${encodeURIComponent(id)}`);
      await refresh();
    },
    /** "Delete the sample data" (phase B): one batch; `undo` brings the rows back. */
    removeSample: async () => {
      const out = await client.delete<{ removed: number; batch_id: string | null }>('/onboarding/sample');
      await refresh();
      return out;
    },
    undoBatch: async (batchId: string) => {
      await client.post(`/activity/batches/${encodeURIComponent(batchId)}/undo`, {});
      await refresh();
    },
  };
};
