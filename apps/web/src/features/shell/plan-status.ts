// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import { ApiError } from '@bines/sdk';

/**
 * Plans (sync-plans): what the account's subscription status blocks, as the server tells it — a 403
 * `account_closed` (everything: the closed screen, plan-lock), a 423 `plan_suspended` (everything but the admins'
 * "My plan") or `plan_read_only` (writes). The shell learns it from
 * the first such answer of any query or mutation of the account (PlanStatus.tsx), and shows the suspended screen
 * or the read-only banner. Nothing is guessed on the client: a status the server never answered is not shown.
 */
export type PlanBlock = 'deletion' | 'closed' | 'suspended' | 'read_only';

/** Which block wins when two are known: deletion, closed, then suspended, then read-only. */
const RANK: Record<PlanBlock, number> = { deletion: 4, closed: 3, suspended: 2, read_only: 1 };

export const planBlockOf = (err: unknown): PlanBlock | null => {
  if (!(err instanceof ApiError)) return null;
  // plan-lock: the owner closed the account (403 `account_closed`).
  if (err.status === 403 && err.body.code === 'account_closed') return 'closed';
  // the account is scheduled for deletion (403 `account_deletion_scheduled`).
  if (err.status === 403 && err.body.code === 'account_deletion_scheduled') return 'deletion';
  if (err.status !== 423) return null;
  return err.body.code === 'plan_suspended' ? 'suspended' : err.body.code === 'plan_read_only' ? 'read_only' : null;
};

// One small store per tab: account id → what is blocked. Closed wins over suspended, suspended over read-only.
const blocks = new Map<string, PlanBlock>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const emit = () => {
  for (const fn of listeners) fn();
};

export const planBlock = (accountId: string): PlanBlock | null => blocks.get(accountId) ?? null;

export const markPlanBlock = (accountId: string, block: PlanBlock) => {
  const now = blocks.get(accountId);
  if (now && RANK[now] >= RANK[block]) return;
  blocks.set(accountId, block);
  emit();
};

/** The server says the plan allows the account again (`plan_status` from /me/accounts): forget the 423 mark. */
export const clearPlanBlock = (accountId: string) => {
  if (!blocks.delete(accountId)) return;
  emit();
};

/** What `plan_status` (GET /me/accounts) blocks: undefined = the server did not say (older API) — keep the 423 marks. */
export const planBlockOfStatus = (status: string | null | undefined): PlanBlock | null | undefined =>
  status === undefined
    ? undefined
    : status === 'closed' || status === 'suspended' || status === 'read_only'
      ? status
      : null;

/** Tests: forget every account's state. */
export const resetPlanBlocks = () => {
  blocks.clear();
  emit();
};

export const usePlanBlock = (accountId: string): PlanBlock | null =>
  useSyncExternalStore(subscribe, () => planBlock(accountId));
