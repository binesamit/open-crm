// SPDX-License-Identifier: AGPL-3.0-only
import type { NotificationType } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import { findMembership } from '../accounts/accounts.repo';
import { recordAudit } from '../audit/audit.repo';
import { notifyUsers } from '../notifications/notify';

/**
 * Sharing docs and dashboards like boards (product fix list): what both do when someone gets access — a
 * "shared with you" notification (only to people who can open the object now, never the actor, by each person's
 * bell / email settings) and, for guests, an audit row (who gave an outside person access to what, at which level).
 */
export type SharedObject = { type: 'doc' | 'dashboard'; id: string; name: string };

/** May this user (with their own account role) open the object? The module's loader, as a yes / no. */
export type CanOpen = (db: Db, ctx: AccountContext, user: SessionUser) => Promise<boolean>;

const contextOf = async (db: Db, account: AccountContext['account'], userId: string) => {
  const m = await findMembership(db, account.id, userId);
  if (m?.status !== 'active') return null;
  return { account, accountId: account.id, role: m.role, membershipId: m.id, boardLimit: null } as AccountContext;
};

/** "X shared <doc / dashboard> with you" to each of `userIds` who can open it now. Returns who was notified. */
export const notifyShared = async (
  tx: Db,
  account: AccountContext['account'],
  object: SharedObject,
  actorId: string | null,
  userIds: Iterable<string>,
  canOpen: CanOpen,
): Promise<string[]> => {
  const type: NotificationType = object.type === 'doc' ? 'doc_shared' : 'dashboard_shared';
  const audience: string[] = [];
  for (const id of new Set(userIds)) {
    if (id === actorId) continue;
    const ctx = await contextOf(tx, account, id);
    if (ctx && (await canOpen(tx, ctx, { id } as SessionUser))) audience.push(id);
  }
  return notifyUsers(
    tx,
    {
      accountId: account.id,
      type,
      actorId,
      target: {
        docId: object.type === 'doc' ? object.id : null,
        dashboardId: object.type === 'dashboard' ? object.id : null,
      },
      payload: { [object.type === 'doc' ? 'doc_name' : 'dashboard_name']: object.name },
    },
    audience,
  );
};

/** Of these users, the guests of the account. */
export const guestsAmong = async (db: Db, accountId: string, userIds: Iterable<string>) => {
  const out = new Set<string>();
  for (const id of new Set(userIds)) if ((await findMembership(db, accountId, id))?.role === 'guest') out.add(id);
  return out;
};

/**
 * Audit (08 §11): a guest got access to a doc / dashboard, or lost it — the admins' audit log shows who opened what
 * to an outside person. `share.guest_added` / `share.guest_removed`, one row per guest.
 */
export const auditGuestShare = async (
  tx: Db,
  p: {
    accountId: string;
    actorId: string | null;
    object: SharedObject;
    added?: { userId: string; level: string }[];
    removed?: string[];
    via?: string;
  },
) => {
  for (const g of p.added ?? [])
    await recordAudit(tx, {
      accountId: p.accountId,
      actorId: p.actorId,
      action: 'share.guest_added',
      targetType: p.object.type,
      targetId: p.object.id,
      payload: { name: p.object.name, user_id: g.userId, level: g.level, ...(p.via ? { via: p.via } : {}) },
    });
  for (const userId of p.removed ?? [])
    await recordAudit(tx, {
      accountId: p.accountId,
      actorId: p.actorId,
      action: 'share.guest_removed',
      targetType: p.object.type,
      targetId: p.object.id,
      payload: { name: p.object.name, user_id: userId },
    });
};

/** Audit: a doc / dashboard became shareable (guests may be invited) or stopped being so. */
export const auditKindChange = async (
  tx: Db,
  p: { accountId: string; actorId: string | null; object: SharedObject; from: string; to: string },
) => {
  if (p.from === p.to || (p.from !== 'shareable' && p.to !== 'shareable')) return;
  await recordAudit(tx, {
    accountId: p.accountId,
    actorId: p.actorId,
    action: 'share.kind_changed',
    targetType: p.object.type,
    targetId: p.object.id,
    payload: { name: p.object.name, from: p.from, to: p.to },
  });
};
