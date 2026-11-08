// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { z } from 'zod';
import type { AppDeps } from '../../types';
import { EXPORT_TASK, runAccountExport } from './account-export.service';
import { DELETION_SWEEP_TASK, deletionSweep, PURGE_TASK, purgeAccount } from './account-deletion.service';

/**
 * Account export and deletion: the export build (queued per request), the purge the owner console
 * starts ("delete now"), and the hourly sweep — reminders, expired exports, and every scheduled purge whose day came
 * (console-deleted accounts too only when the owner turned `account_deletion.purge_console_deleted` on).
 */
const exportPayload = z.object({ id: z.string().min(1) });
const purgePayload = z.object({
  account_id: z.string().min(1),
  by: z
    .object({
      id: z.string().nullable(),
      name: z.string(),
      email: z.string(),
      via: z.enum(['admin', 'owner', 'owner_console']),
    })
    .optional(),
});

export const accountDeletionTasks = (deps: AppDeps): TaskList => ({
  [EXPORT_TASK]: async (payload) => {
    await runAccountExport(deps, exportPayload.parse(payload).id);
  },
  [PURGE_TASK]: async (payload) => {
    const p = purgePayload.parse(payload);
    await purgeAccount(deps, p.account_id, p.by);
  },
  [DELETION_SWEEP_TASK]: async () => {
    const r = await deletionSweep(deps);
    if (r.reminders || r.expired || r.purged) deps.logger.info(r, DELETION_SWEEP_TASK);
  },
});

export const accountDeletionCronItems: CronItem[] = [
  { task: DELETION_SWEEP_TASK, match: '40 * * * *', identifier: DELETION_SWEEP_TASK },
];
