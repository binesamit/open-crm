// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Automation, AutomationRun, AutomationTestResult, BoardListEntry } from '@bines/shared';
import { api } from '../../lib/api';
import { useReadableBoards } from '../board/board-api';

/** Automations of a board (06 §2.16) — list, save, switch, delete, runs, test. */
export const automationKeys = {
  list: (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'automations'] as const,
  runs: (accountId: string, id: string) => ['account', accountId, 'automation', id, 'runs'] as const,
};

export type SavedAutomation = Automation & { warnings: { path: string; code: string; detail?: string }[] };

export const useAutomations = (accountId: string, boardId: string, enabled = true) =>
  useQuery({
    queryKey: automationKeys.list(accountId, boardId),
    queryFn: () => api(accountId).get<{ data: Automation[] }>(`/boards/${boardId}/automations`),
    enabled,
  });

export const useAutomationMutations = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const refresh = () => qc.invalidateQueries({ queryKey: automationKeys.list(accountId, boardId) });
  return {
    create: useMutation({
      mutationFn: (body: { title?: string; recipe: unknown; is_active: boolean }) =>
        client.post<SavedAutomation>(`/boards/${boardId}/automations`, body),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: (p: {
        id: string;
        revision: number;
        body: { title?: string; recipe?: unknown; is_active?: boolean };
      }) => client.patch<SavedAutomation>(`/automations/${p.id}`, p.body, { 'if-match': String(p.revision) }),
      onSuccess: refresh,
    }),
    toggle: useMutation({
      mutationFn: (p: { id: string; on: boolean }) =>
        client.post<SavedAutomation>(`/automations/${p.id}/${p.on ? 'activate' : 'deactivate'}`, {}),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.delete<{ ok: true }>(`/automations/${id}`),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: (p: { id: string; item_id?: string; dry_run: boolean }) =>
        client.post<AutomationTestResult>(`/automations/${p.id}/test`, { item_id: p.item_id, dry_run: p.dry_run }),
      onSuccess: refresh,
    }),
  };
};

export const useRuns = (accountId: string, id: string) =>
  useQuery({
    queryKey: automationKeys.runs(accountId, id),
    queryFn: () =>
      api(accountId).get<{ data: AutomationRun[]; next: string | null }>(`/automations/${id}/runs?limit=50`),
  });

/** Every board of the account I can see (targets of cross-board actions) — one `GET /boards`. */
export const useAllBoards = (accountId: string) => useReadableBoards(accountId).data?.data ?? EMPTY;
const EMPTY: BoardListEntry[] = [];

/** Items of the board matching a text (the test dialog's item picker). */
export const useItemSearch = (accountId: string, boardId: string, q: string) =>
  useQuery({
    queryKey: ['account', accountId, 'board', boardId, 'search', q],
    queryFn: () =>
      api(accountId).get<{ data: { id: string; name: string; board_id: string }[] }>(
        `/boards/${boardId}/items/search?q=${encodeURIComponent(q)}`,
      ),
    staleTime: 10_000,
  });
