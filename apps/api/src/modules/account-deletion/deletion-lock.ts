// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';

/**
 * The lock of an account scheduled for deletion — like a closed account (plan-lock), one screen
 * instead of the app: inside the account scope only its deletion status, the admins' cancel, the full export
 * (start, list, download — the data can still be taken out) and support tickets answer; never to a token.
 * Everything else is 403 `account_deletion_scheduled` (with `due_at`). Roles are the services' checks.
 */
const DELETION_OPEN: { method: RegExp; path: RegExp }[] = [
  { method: /^GET$/, path: /^\/account-deletion$/ },
  { method: /^POST$/, path: /^\/account-deletion\/cancel$/ },
  { method: /^(GET|POST)$/, path: /^\/account-export$/ },
  { method: /^GET$/, path: /^\/account-export\/[A-Za-z0-9_-]+\/download$/ },
  { method: /^(GET|POST)$/, path: /^\/support\/tickets(\/[A-Za-z0-9_-]+(\/(messages|close|reopen|rating))?)?$/ },
];

export const deletionAllows = (method: string, path: string) =>
  DELETION_OPEN.some((r) => r.method.test(method) && r.path.test(path));

export const deletionScheduledError = (dueAt: Date) =>
  new AppError('account_deletion_scheduled', 'The account is scheduled for deletion', {
    due_at: dueAt.toISOString(),
  });

export const assertDeletionAllows = (p: { dueAt: Date; method: string; path: string; token: boolean }) => {
  if (!p.token && deletionAllows(p.method, p.path)) return;
  throw deletionScheduledError(p.dueAt);
};
