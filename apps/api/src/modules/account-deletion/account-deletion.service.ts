// SPDX-License-Identifier: AGPL-3.0-only
import {
  ACCOUNT_DELETION_REMINDER_DAYS,
  type AccountDeletionStatus,
  AppError,
  deletionNameMatches,
  formatInstantDate,
  type PendingDeletion,
} from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { AppDeps, AccountContext, RequestMeta, SessionUser } from '../../types';
import { assertAccountAdmin } from '../../lib/account-admin';
import { enqueueJob } from '../../lib/jobs';
import { st } from '../../lib/i18n';
import { recordAudit } from '../audit/audit.repo';
import { accountRegion } from '../accounts/region';
import { type AccountRow } from '../accounts/accounts.repo';
import { forgetEntitlements } from '../billing/entitlements';
import { recordPlanChanged } from '../billing/plan-status';
import { forgetSecurity } from '../admin/two-factor.service';
import { twoFactorEnabledOf } from '../admin/two-factor.repo';
import { verifyFreshCode } from '../admin/fresh-code';
import { accountMailBrand, platformMailBrand } from '../platform/mail-brand';
import { loadPlatformSettings } from '../platform/platform-settings';
import { appLink } from '../platform/public-address';
import { expireExports } from './account-export.service';
import {
  accountTables,
  adminRecipients,
  deleteAccountRow,
  deleteAssetRows,
  deleteBatch,
  deleteItemsBatch,
  dueForPurge,
  exportFilesOf,
  findAnyAccount,
  findPurgeAudit,
  findUserForActor,
  insertPlatformAudit,
  scheduledDeletions,
  setDeletionSchedule,
  setDeletionState,
  storedAssetsBatch,
  usersOnlyHere,
} from './account-deletion.repo';

/**
 * Account deletion. An admin (there is no "account owner" role — the admins are the account's
 * owners) schedules it from Administration → General after the export is offered: the account's name typed again
 * and a fresh two-factor code (no two-factor sign-in = no deletion). The account is then locked at once like a closed
 * account (one screen, nothing runs; requireAccount → deletion-lock.ts, entitlements read it as `closed`) for the
 * owner's grace period (`account_deletion.grace_days`, 30 by default); the admins are emailed now, 7 days and 1 day
 * before, and any of them can cancel meanwhile. When it ends the worker purges everything — rows, stored files,
 * search entries — in resumable batches; one platform audit row says "account X deleted on Y by Z", and people whose
 * only account it was keep an empty profile and get an email. The owner console lists the scheduled accounts and can
 * cancel or delete one now (the owner's own fresh code).
 */

export const DELETION_SWEEP_TASK = 'account.deletion_sweep';
export const PURGE_TASK = 'account.purge';

type Deps = Pick<AppDeps, 'db' | 'storage' | 'env' | 'mailer' | 'logger' | 'auth'>;
type AdminActor = { ctx: AccountContext; user: SessionUser; requestId?: string };
type PurgeBy = { id: string | null; name: string; email: string; via: 'admin' | 'owner' | 'owner_console' };
type DeletionState = {
  reminded?: number[];
  /** The owner console's "delete now": the purge is theirs. */
  owner_now?: PurgeBy;
  purge?: {
    started_at: string;
    users: { id: string; email: string; name: string; locale: string }[];
    emailed?: boolean;
    by?: PurgeBy;
  };
};

const DAY = 86_400_000;
const stateOf = (account: Pick<AccountRow, 'deletionState'>) => (account.deletionState ?? {}) as DeletionState;

const assertDeletionAdmin = (a: AdminActor) => {
  if (a.ctx.support) throw new AppError('forbidden', 'not_for_support');
  assertAccountAdmin(a.ctx, { reason: 'admin_only' });
};

/** GET /account-deletion: the schedule (any member may read it — the locked screen shows the date to everyone). */
export const deletionStatus = async (deps: Pick<Deps, 'db'>, a: AdminActor): Promise<AccountDeletionStatus> => {
  const settings = (await loadPlatformSettings(deps.db)).account_deletion;
  const account = await findAnyAccount(deps.db, a.ctx.accountId);
  const requester = account?.deletionRequestedBy
    ? ((await adminNames(deps, account.deletionRequestedBy)) ?? null)
    : null;
  return {
    scheduled_at: account?.deletionScheduledAt?.toISOString() ?? null,
    due_at: account?.deletionDueAt?.toISOString() ?? null,
    requested_by: requester,
    two_factor_enabled: await twoFactorEnabledOf(deps.db, a.user.id),
    grace_days: settings.grace_days,
    export_days: settings.export_days,
  };
};

const adminNames = async (deps: Pick<Deps, 'db'>, userId: string) => {
  const u = await findUserForActor(deps.db, userId);
  return u ? { id: u.id, name: u.name || u.email } : undefined;
};

/** Everyone in the account sees the change at once (the app refetches /me/accounts → the locked screen or back). */
const announce = async (deps: Pick<Deps, 'db'>, accountId: string, actorId: string | null, reason: string) => {
  forgetEntitlements(accountId);
  forgetSecurity(accountId);
  await recordPlanChanged(deps.db, [accountId], { id: actorId, type: actorId ? 'user' : 'system' }, reason);
};

/**
 * POST /account-deletion: the name typed again (case and spaces around it do not count; 422 `confirm_mismatch`)
 * and a fresh code (403 `step_up_two_factor_required` without two-factor sign-in, 422 `step_up_code_invalid`). Sessions
 * only. Already scheduled = 409.
 */
export const scheduleDeletion = async (
  deps: Deps,
  a: AdminActor & { sessionId?: string | null; token?: unknown },
  input: { confirm_name: string; code: string },
  headers: Headers,
  meta: RequestMeta,
) => {
  assertDeletionAdmin(a);
  if (a.token) throw new AppError('forbidden', 'session_only');
  const account = await findAnyAccount(deps.db, a.ctx.accountId);
  if (!account) throw new AppError('not_found', 'Account not found');
  if (account.deletionDueAt) throw new AppError('conflict', 'deletion_already_scheduled');
  if (!deletionNameMatches(input.confirm_name, account.name))
    throw new AppError('confirm_mismatch', 'Type the account name to confirm');
  await verifyFreshCode(deps, a.user.id, input.code, headers);

  const { grace_days } = (await loadPlatformSettings(deps.db)).account_deletion;
  const now = new Date();
  const dueAt = new Date(now.getTime() + grace_days * DAY);
  await setDeletionSchedule(deps.db, account.id, {
    scheduledAt: now,
    dueAt,
    requestedBy: a.user.id,
    state: { reminded: [] },
  });
  await recordAudit(deps.db, {
    accountId: account.id,
    actorId: a.user.id,
    action: 'account.deletion_scheduled',
    targetType: 'account',
    targetId: account.id,
    payload: { due_at: dueAt.toISOString(), grace_days },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  await announce(deps, account.id, a.user.id, 'deletion_scheduled');
  await emailAdmins(deps, { ...account, deletionDueAt: dueAt }, 'scheduled', a.user.name || a.user.email);
  return deletionStatus(deps, a);
};

/** POST /account-deletion/cancel: any admin of the account, while it waits. */
export const cancelDeletion = async (deps: Deps, a: AdminActor, meta: RequestMeta) => {
  assertDeletionAdmin(a);
  const account = await findAnyAccount(deps.db, a.ctx.accountId);
  if (!account?.deletionDueAt) throw new AppError('conflict', 'deletion_not_scheduled');
  await unschedule(deps, account, { id: a.user.id, name: a.user.name || a.user.email }, meta, 'admin');
  return deletionStatus(deps, a);
};

const unschedule = async (
  deps: Deps,
  account: AccountRow,
  by: { id: string; name: string },
  meta: RequestMeta | null,
  via: 'admin' | 'owner_console',
) => {
  if (stateOf(account).purge) throw new AppError('conflict', 'deletion_in_progress');
  await setDeletionSchedule(deps.db, account.id, { scheduledAt: null, dueAt: null, requestedBy: null, state: {} });
  await recordAudit(deps.db, {
    accountId: account.id,
    actorId: by.id,
    action: 'account.deletion_cancelled',
    targetType: 'account',
    targetId: account.id,
    payload: { due_at: account.deletionDueAt?.toISOString() ?? null, via },
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
  });
  await announce(deps, account.id, by.id, 'deletion_cancelled');
  await emailAdmins(deps, account, 'cancelled', by.name);
};

// ---- emails to the admins ----

type AdminMail = 'scheduled' | 'reminder' | 'cancelled';

/** Returns how many admins there were to write to and how many the mail reached. */
const emailAdmins = async (deps: Deps, account: AccountRow, kind: AdminMail, byName?: string, days?: number) => {
  const url = await appLink(deps, `/a/${account.slug}`);
  const admins = await adminRecipients(deps.db, account.id);
  const left = account.deletionDueAt
    ? Math.max(0, Math.ceil((account.deletionDueAt.getTime() - Date.now()) / 86_400_000))
    : 0;
  let sent = 0;
  for (const admin of admins) {
    try {
      const brand = await accountMailBrand(deps, account, admin.locale);
      const l = brand.locale;
      const region = await accountRegion(deps.db, account.id, admin);
      const date = account.deletionDueAt ? formatInstantDate(account.deletionDueAt, {}, region) : '';
      const v = { name: account.name, date, by: byName ?? '', days: days ?? 0 };
      await deps.mailer.send(
        noticeEmail({
          to: admin.email,
          brand,
          subject: st(`accountDeletion.mail.${kind}.subject`, v, l),
          title: st(`accountDeletion.mail.${kind}.title`, v, l),
          ...(kind !== 'cancelled' && left > 0
            ? {
                hero: {
                  kind: 'days' as const,
                  big: date,
                  done: 0,
                  total: left,
                  caption: st('mail.obj.days.left', { days: left }, l),
                },
              }
            : {}),
          lines: [
            st(`accountDeletion.mail.${kind}.body`, v, l),
            ...(kind === 'cancelled' ? [] : [st('accountDeletion.mail.howToCancel', v, l)]),
          ],
          cta: { label: st(`accountDeletion.mail.${kind}.cta`, v, l), url },
          reason: st('accountDeletion.mail.reason', v, l),
        }),
      );
      sent++;
    } catch (err) {
      deps.logger.warn({ err, accountId: account.id }, 'account deletion email failed');
    }
  }
  return { recipients: admins.length, sent };
};

/** The reminders, 7 days and 1 day before (each once; a late sweep sends only the nearest). */
export const sendReminders = async (deps: Deps, now = new Date()) => {
  let sent = 0;
  for (const { account } of await scheduledDeletions(deps.db)) {
    if (!account.deletionDueAt || account.deletionDueAt <= now) continue;
    const state = stateOf(account);
    const reminded = new Set(state.reminded ?? []);
    const left = account.deletionDueAt.getTime() - now.getTime();
    const due = ACCOUNT_DELETION_REMINDER_DAYS.filter((d) => left <= d * DAY && !reminded.has(d));
    if (!due.length) continue;
    // The email first, the mark after: a reminder no admin received is tried again by the next sweep
    // (audit 2026-10-10 worker #18). Every passed mark is recorded at once; the email names the nearest.
    const mail = await emailAdmins(deps, account, 'reminder', undefined, Math.min(...due));
    if (mail.recipients && !mail.sent) continue;
    for (const d of due) reminded.add(d);
    await setDeletionState(deps.db, account.id, { ...state, reminded: [...reminded] });
    sent++;
  }
  return sent;
};

// ---- the purge ----

const BATCH = 2000;
const FILE_BATCH = 200;

/**
 * Deletes everything of one account, for good. Idempotent and resumable: each step can run again after a crash —
 * the people to tell are written down first, stored files go before their rows, every table is emptied in batches
 * (several passes, so rows another table still points at go once that table is empty), then the platform audit row
 * (one per account — a unique index) and the emails, and last the account row itself.
 */
export const purgeAccount = async (deps: Deps, accountId: string, by?: PurgeBy) => {
  const account = await findAnyAccount(deps.db, accountId);
  if (!account) return false;
  let state = stateOf(account);

  // 1. Who to tell afterwards, and who did it — written before anything goes.
  if (!state.purge) {
    const requester = account.deletionRequestedBy
      ? await findUserForActor(deps.db, account.deletionRequestedBy)
      : undefined;
    state = {
      ...state,
      purge: {
        started_at: new Date().toISOString(),
        users: (await usersOnlyHere(deps.db, accountId)).map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          locale: u.locale,
        })),
        by: by ??
          state.owner_now ?? {
            id: requester?.id ?? null,
            name: requester?.name ?? '',
            email: requester?.email ?? '',
            via: account.deletedAt && !account.deletionDueAt ? 'owner_console' : 'admin',
          },
      },
    };
    await setDeletionState(deps.db, accountId, state);
  }
  forgetEntitlements(accountId);

  // 2. Stored files: exports, then every asset (storage first, then the row).
  for (const e of await exportFilesOf(deps.db, accountId)) if (e.storageKey) await deps.storage.remove(e.storageKey);
  for (;;) {
    const batch = await storedAssetsBatch(deps.db, accountId, FILE_BATCH);
    if (!batch.length) break;
    for (const f of batch) if (f.storageKey) await deps.storage.remove(f.storageKey);
    await deleteAssetRows(
      deps.db,
      batch.map((f) => f.id),
    );
  }

  // 3. Rows: items first (the biggest tree), then every table with an account_id, in passes until all are empty.
  while ((await deleteItemsBatch(deps.db, accountId, BATCH)) > 0);
  const tables = await accountTables(deps.db);
  let left = new Set(tables);
  for (let pass = 0; pass < 10 && left.size; pass++) {
    const next = new Set<string>();
    for (const table of left) {
      try {
        while ((await deleteBatch(deps.db, table, accountId, BATCH)) > 0);
      } catch (err) {
        // Still pointed at by a row of a table not emptied yet (a restricting key): the next pass.
        if ((err as { code?: string }).code === '23503' || /foreign key/i.test(String(err))) next.add(table);
        else throw err;
      }
    }
    if (next.size === left.size) break;
    left = next;
  }

  // 4. The one platform audit row, then the people whose only account this was.
  const purge = state.purge!;
  if (!(await findPurgeAudit(deps.db, accountId)))
    await insertPlatformAudit(deps.db, {
      action: 'account.purged',
      targetType: 'account',
      targetId: accountId,
      actorId: purge.by?.id ?? null,
      payload: {
        name: account.name,
        slug: account.slug,
        by: purge.by ?? null,
        scheduled_at: account.deletionScheduledAt?.toISOString() ?? null,
        due_at: account.deletionDueAt?.toISOString() ?? null,
        started_at: purge.started_at,
        users_notified: purge.users.length,
      },
    });
  if (!purge.emailed) {
    await emailUsersLeft(deps, account, purge.users);
    state = { ...state, purge: { ...purge, emailed: true } };
    await setDeletionState(deps.db, accountId, state);
  }

  // 5. The account itself (what any key still held goes with it).
  await deleteAccountRow(deps.db, accountId);
  forgetEntitlements(accountId);
  forgetSecurity(accountId);
  deps.logger.info({ accountId }, 'account purged');
  return true;
};

/** "The account was deleted": to each person whose only account it was (they keep an empty profile). */
const emailUsersLeft = async (deps: Deps, account: AccountRow, people: { email: string; locale: string }[]) => {
  for (const p of people) {
    try {
      const brand = await platformMailBrand(deps, p.locale);
      const l = brand.locale;
      const v = { name: account.name };
      await deps.mailer.send(
        noticeEmail({
          to: p.email,
          brand,
          subject: st('accountDeletion.mail.purged.subject', v, l),
          title: st('accountDeletion.mail.purged.title', v, l),
          hero: { kind: 'fade' },
          lines: [st('accountDeletion.mail.purged.body', v, l), st('accountDeletion.mail.purged.profile', v, l)],
          reason: st('accountDeletion.mail.purged.reason', v, l),
        }),
      );
    } catch (err) {
      deps.logger.warn({ err, accountId: account.id }, 'account purge email failed');
    }
  }
};

/**
 * The hourly sweep: reminders, expired exports, and the purge of every scheduled account whose time came. Accounts
 * the owner console soft-deleted are purged too only when the owner turned `purge_console_deleted` on (off by default).
 */
export const deletionSweep = async (deps: Deps, now = new Date()) => {
  const reminders = await sendReminders(deps, now);
  const expired = await expireExports(deps, now);
  const { grace_days, purge_console_deleted } = (await loadPlatformSettings(deps.db)).account_deletion;
  let purged = 0;
  const due = await dueForPurge(deps.db, now, { graceDays: grace_days, purgeConsoleDeleted: purge_console_deleted });
  for (const { id } of due) {
    try {
      if (await purgeAccount(deps, id)) purged++;
    } catch (err) {
      deps.logger.error({ err, accountId: id }, 'account purge failed — resumes on the next sweep');
    }
  }
  return { reminders, expired, purged };
};

// ---- owner console ----

export const listPendingDeletions = async (deps: Pick<Deps, 'db'>): Promise<PendingDeletion[]> =>
  (await scheduledDeletions(deps.db)).map(({ account, requester }) => ({
    id: account.id,
    name: account.name,
    slug: account.slug,
    scheduled_at: (account.deletionScheduledAt ?? account.deletionDueAt!).toISOString(),
    due_at: account.deletionDueAt!.toISOString(),
    requested_by: requester?.id ? { id: requester.id, name: requester.name, email: requester.email } : null,
  }));

const ownerAudit = (
  deps: Pick<Deps, 'db'>,
  account: AccountRow,
  owner: SessionUser,
  action: string,
  meta: RequestMeta,
) =>
  recordAudit(deps.db, {
    accountId: account.id,
    actorId: owner.id,
    action,
    targetType: 'account',
    targetId: account.id,
    payload: { via: 'platform_owner' },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

export const ownerCancelDeletion = async (deps: Deps, owner: SessionUser, accountId: string, meta: RequestMeta) => {
  const account = await findAnyAccount(deps.db, accountId);
  if (!account || !account.deletionDueAt) throw new AppError('not_found', 'deletion_not_scheduled');
  await unschedule(deps, account, { id: owner.id, name: owner.name || owner.email }, meta, 'owner_console');
};

/**
 * "Delete now" (owner console): the account's address typed again and the owner's own fresh code. The purge is
 * queued at once (or run right away where no worker runs); its audit row names the owner.
 */
export const ownerPurgeNow = async (
  deps: Deps,
  owner: SessionUser,
  accountId: string,
  input: { confirm_slug: string; code: string },
  headers: Headers,
  meta: RequestMeta,
) => {
  const account = await findAnyAccount(deps.db, accountId);
  if (!account || !account.deletionDueAt) throw new AppError('not_found', 'deletion_not_scheduled');
  if (input.confirm_slug.trim() !== account.slug) throw new AppError('confirm_mismatch', 'Type the account slug');
  await verifyFreshCode(deps, owner.id, input.code, headers);
  const now = new Date();
  const by: PurgeBy = { id: owner.id, name: owner.name, email: owner.email, via: 'owner' };
  await setDeletionSchedule(deps.db, account.id, {
    scheduledAt: account.deletionScheduledAt ?? now,
    dueAt: now,
    requestedBy: account.deletionRequestedBy,
    state: { ...stateOf(account), owner_now: by },
  });
  await ownerAudit(deps, account, owner, 'account.deletion_now', meta);
  if (!(await enqueueJob(deps.db, PURGE_TASK, { account_id: account.id, by }, { maxAttempts: 5 })))
    await purgeAccount(deps, account.id, by);
};
