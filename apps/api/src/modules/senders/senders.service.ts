// SPDX-License-Identifier: AGPL-3.0-only
import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AppError,
  accountSettingsSchema,
  newId,
  type SenderKind,
  type SenderRequest,
  senderValueExempt,
  type UpdateAccount,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers, accounts, senderRequests, users } from '../../db/schema';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { recordEvent } from '../activity/activity.repo';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { notifyUsers } from '../notifications/notify';
import { loadPlatformSettings } from '../platform/platform-settings';

/**
 * Custom senders (S-46): an account admin's email sender name / Reply-To / SMS sender id needs the platform owner's
 * approval (owner console setting, on by default). The account's settings hold only approved values — so every
 * sender (API emails, the worker's notification emails, SMS) keeps reading the settings as before — and a new value
 * waits here as `pending`. Approve = the value is written into the settings; reject = it never is (with a reason).
 * Every step is audited in the account, and the admin who asked is notified of the decision.
 */

type Settings = ReturnType<typeof accountSettingsSchema.parse>;
type Patch = NonNullable<UpdateAccount['settings']>;

const readValue = (s: Settings, kind: SenderKind): string | undefined =>
  kind === 'email_sender_name'
    ? s.branding.email_sender_name
    : kind === 'email_reply_to'
      ? s.branding.email_reply_to
      : s.sms.sender_id;

/** The settings with one sender set (a string) or cleared (null). */
const writeValue = (s: Settings, kind: SenderKind, value: string | null): Settings => {
  if (kind === 'sms_sender_id') {
    const sms = { ...s.sms } as Settings['sms'];
    if (value === null) delete sms.sender_id;
    else sms.sender_id = value;
    return { ...s, sms };
  }
  const branding = { ...s.branding };
  if (value === null) delete branding[kind];
  else branding[kind] = value;
  return { ...s, branding };
};

/** The sender fields of a PATCH /accounts/me (undefined = not sent). */
const sentValue = (p: Patch, kind: SenderKind): string | null | undefined =>
  kind === 'email_sender_name'
    ? p.branding?.email_sender_name
    : kind === 'email_reply_to'
      ? p.branding?.email_reply_to
      : p.sms?.sender_id;

/** The patch without one sender field (it waits for approval instead). */
const withoutValue = (p: Patch, kind: SenderKind): Patch => {
  if (kind === 'sms_sender_id') {
    if (!p.sms) return p;
    const { sender_id: _drop, ...sms } = p.sms;
    return { ...p, sms };
  }
  if (!p.branding) return p;
  const { [kind]: _drop, ...branding } = p.branding;
  return { ...p, branding };
};

export const sendersNeedApproval = async (db: Db) => (await loadPlatformSettings(db)).senders.require_approval;

const cancelPending = (tx: Db, accountId: string, kind: SenderKind) =>
  tx
    .update(senderRequests)
    .set({ status: 'cancelled', decidedAt: new Date() })
    .where(
      and(eq(senderRequests.accountId, accountId), eq(senderRequests.kind, kind), eq(senderRequests.status, 'pending')),
    );

/**
 * PATCH /accounts/me, inside its transaction: each custom sender that needs approval leaves the patch and becomes a
 * pending request (an older pending one of the same kind is replaced). Clearing, the account's own name, the value
 * already in force, or approval switched off by the owner: applied as sent (a pending request of that kind is
 * withdrawn). Returns the patch to apply and the requests made.
 */
export const routeSenderChanges = async (
  tx: Db,
  a: { accountId: string; accountName: string; userId: string },
  current: Settings,
  patch: Patch,
  meta: RequestMeta,
): Promise<{ patch: Patch; requested: { kind: SenderKind; value: string }[] }> => {
  const kinds = (['email_sender_name', 'email_reply_to', 'sms_sender_id'] as const).filter(
    (k) => sentValue(patch, k) !== undefined,
  );
  if (!kinds.length) return { patch, requested: [] };
  const required = await sendersNeedApproval(tx);
  let next = patch;
  const requested: { kind: SenderKind; value: string }[] = [];
  for (const kind of kinds) {
    const value = sentValue(patch, kind)!;
    const trimmed = value?.trim() ?? null;
    if (
      trimmed === null ||
      !required ||
      trimmed === readValue(current, kind) ||
      senderValueExempt(kind, trimmed, a.accountName)
    ) {
      await cancelPending(tx, a.accountId, kind);
      // A marker for the admin's status line: a cleared value shows nothing, one applied at once shows as in force.
      if (trimmed !== readValue(current, kind))
        await tx.insert(senderRequests).values({
          id: newId(),
          accountId: a.accountId,
          kind,
          value: trimmed ?? '',
          status: trimmed === null ? 'cancelled' : 'approved',
          requestedBy: a.userId,
          decidedAt: new Date(),
        });
      continue;
    }
    next = withoutValue(next, kind);
    await cancelPending(tx, a.accountId, kind);
    const id = newId();
    await tx.insert(senderRequests).values({
      id,
      accountId: a.accountId,
      kind,
      value: trimmed,
      status: 'pending',
      requestedBy: a.userId,
    });
    await recordAudit(tx, {
      accountId: a.accountId,
      actorId: a.userId,
      action: 'sender.requested',
      targetType: 'sender_request',
      targetId: id,
      payload: { kind, value: trimmed },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    requested.push({ kind, value: trimmed });
  }
  return { patch: next, requested };
};

const requester = alias(users, 'requester');
const decider = alias(users, 'decider');

const selectRequests = (db: Db) =>
  db
    .select({
      r: senderRequests,
      accountName: accounts.name,
      requestedByName: requester.name,
      requestedByEmail: requester.email,
      decidedByName: decider.name,
    })
    .from(senderRequests)
    .innerJoin(accounts, eq(accounts.id, senderRequests.accountId))
    .leftJoin(requester, eq(requester.id, senderRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, senderRequests.decidedBy));

type Row = Awaited<ReturnType<ReturnType<typeof selectRequests>['where']>>[number];

const dto = (x: Row, withAccount: boolean): SenderRequest => ({
  id: x.r.id,
  account_id: x.r.accountId,
  ...(withAccount ? { account_name: x.accountName } : {}),
  kind: x.r.kind as SenderKind,
  value: x.r.value,
  status: x.r.status as SenderRequest['status'],
  reason: x.r.reason,
  requested_by_name: x.requestedByName || x.requestedByEmail || null,
  decided_by_name: x.decidedByName ?? null,
  created_at: x.r.createdAt.toISOString(),
  decided_at: x.r.decidedAt?.toISOString() ?? null,
});

/**
 * GET /accounts/me/sender-requests (admins): the latest request of each kind — none when the latest was withdrawn
 * or cleared (a value back to the default needs no status line).
 */
export const accountSenderStatus = async (db: Db, ctx: { accountId: string; role: string }) => {
  if (ctx.role !== 'admin') throw new AppError('forbidden', 'admins_only');
  const rows = await selectRequests(db)
    .where(eq(senderRequests.accountId, ctx.accountId))
    .orderBy(desc(senderRequests.createdAt), desc(senderRequests.id));
  const seen = new Set<string>();
  const latest = rows.filter((x) => !seen.has(x.r.kind) && !!seen.add(x.r.kind));
  return {
    require_approval: await sendersNeedApproval(db),
    data: latest.filter((x) => x.r.status !== 'cancelled').map((x) => dto(x, false)),
  };
};

/** GET /platform/sender-requests (owner): pending first-come, or the latest 200 of every status. */
export const listSenderRequests = async (db: Db, status: 'pending' | 'all') => {
  const q = selectRequests(db);
  const rows =
    status === 'pending'
      ? await q.where(eq(senderRequests.status, 'pending')).orderBy(senderRequests.createdAt)
      : await q
          .where(inArray(senderRequests.status, ['pending', 'approved', 'rejected']))
          .orderBy(desc(senderRequests.createdAt))
          .limit(200);
  return { data: rows.map((x) => dto(x, true)) };
};

/** POST /platform/sender-requests/{id}/approve|reject (owner). */
export const decideSenderRequest = async (
  deps: Pick<AppDeps, 'db'>,
  owner: SessionUser,
  id: string,
  decision: 'approved' | 'rejected',
  reason: string | null,
  meta: RequestMeta,
) => {
  const out = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(senderRequests).where(eq(senderRequests.id, id)).limit(1).for('update');
    if (!row) throw new AppError('not_found', 'Sender request not found');
    if (row.status !== 'pending') throw new AppError('conflict', 'sender_request_decided');
    const kind = row.kind as SenderKind;
    const now = new Date();
    await tx
      .update(senderRequests)
      .set({ status: decision, reason: reason || null, decidedBy: owner.id, decidedAt: now })
      .where(eq(senderRequests.id, id));
    if (decision === 'approved') {
      const current = accountSettingsSchema.parse(await getAccountSettings(tx, row.accountId));
      const before = readValue(current, kind) ?? null;
      await upsertAccountSettings(tx, row.accountId, writeValue(current, kind, row.value), owner.id);
      await recordEvent(tx, {
        accountId: row.accountId,
        type: 'account.updated',
        actorId: owner.id,
        requestId: meta.requestId,
        before: { [kind]: before },
        after: { [kind]: row.value },
      });
    }
    await recordAudit(tx, {
      accountId: row.accountId,
      actorId: owner.id,
      action: decision === 'approved' ? 'sender.approved' : 'sender.rejected',
      targetType: 'sender_request',
      targetId: id,
      payload: { kind, value: row.value, ...(reason ? { reason } : {}) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    // The admin who asked hears about it (if they are still an active member of the account).
    const [member] = row.requestedBy
      ? await tx
          .select({ userId: accountMembers.userId })
          .from(accountMembers)
          .where(
            and(
              eq(accountMembers.accountId, row.accountId),
              eq(accountMembers.userId, row.requestedBy),
              eq(accountMembers.status, 'active'),
            ),
          )
          .limit(1)
      : [];
    if (member)
      await notifyUsers(
        tx,
        {
          accountId: row.accountId,
          type: 'sender_request',
          actorId: null,
          payload: {
            excerpt: `${row.value}${reason ? ` — ${reason}` : ''}`,
            sender: { request_id: id, kind, value: row.value, status: decision, reason: reason || null },
          },
        },
        [member.userId],
      );
    return row.accountId;
  });
  const [row] = await selectRequests(deps.db).where(eq(senderRequests.id, id)).limit(1);
  return { ...dto(row!, true), account_id: out };
};
