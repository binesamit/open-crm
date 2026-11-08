// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChecklistState, ClientChecklistEvent } from '@bines/shared';
import { api } from '../../lib/api';

/** "First steps": the person's checklist in an account, and what the app reports to it. */
export const checklistKeys = { mine: (accountId: string) => ['account', accountId, 'first-steps'] as const };

export const useChecklist = (accountId: string, enabled = true) =>
  useQuery({
    queryKey: checklistKeys.mine(accountId),
    queryFn: () => api(accountId).get<ChecklistState>('/me/first-steps'),
    enabled,
    staleTime: 20_000,
    // A step done on another screen ticks without a reload.
    refetchInterval: 30_000,
  });

/**
 * A board opened, a view switched — the log does not record them, so the app reports them (at most once in a while:
 * a tour step waiting for one needs a fresh report, a page full of tab clicks does not).
 */
const REPORT_EVERY_MS = 10_000;
const reportedAt = new Map<string, number>();
export const reportChecklist = (accountId: string, event: ClientChecklistEvent) => {
  const key = `${accountId}:${event}`;
  const now = Date.now();
  if (now - (reportedAt.get(key) ?? 0) < REPORT_EVERY_MS) return;
  reportedAt.set(key, now);
  void api(accountId)
    .post('/me/first-steps/mark', { event })
    .catch(() => reportedAt.delete(key));
};

export const useChecklistActions = (accountId: string) => {
  const qc = useQueryClient();
  const patch = (fn: (d: ChecklistState) => ChecklistState) =>
    qc.setQueryData<ChecklistState>(checklistKeys.mine(accountId), (d) => (d ? fn(d) : d));
  return {
    dismiss: async (dismissed: boolean) => {
      patch((d) => ({ ...d, dismissed, open: dismissed ? false : d.open }));
      await api(accountId).post('/me/first-steps/dismiss', { dismissed });
    },
    /** Folded into its pill / unfolded — remembered for the person. */
    collapse: async (collapsed: boolean) => {
      patch((d) => ({ ...d, collapsed }));
      await api(accountId).post('/me/first-steps/dismiss', { collapsed });
    },
    refresh: () => qc.invalidateQueries({ queryKey: checklistKeys.mine(accountId) }),
  };
};

/** A tour step waiting for an action: did the person do it since the step opened? */
export const checklistSeen = (accountId: string, event: string, since: string) =>
  api(accountId).get<{ seen: boolean }>(
    `/me/first-steps/seen?event=${encodeURIComponent(event)}&since=${encodeURIComponent(since)}`,
  );
