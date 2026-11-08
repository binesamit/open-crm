// SPDX-License-Identifier: AGPL-3.0-only
import { TICKET_DONE_STATUSES, type TicketStatus } from '@bines/shared';
import type { Db } from '../../db/client';
import type { RequestMeta } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { revokeTicketGrantRows } from '../support/support.repo';
import { slaOnStatus } from './tickets.sla';
import { cancelPendingRequests, findTicket, insertEvent, type TicketRow, updateTicketRow } from './tickets.repo';

/**
 * A ticket's status change, the one place for both sides: the timestamps, the SLA pause, the staff
 * history — and when the ticket is solved or closed, every support grant approved from it is revoked at once (in the
 * account's audit log, with the ticket) and pending access requests end.
 */
export const changeStatus = async (
  db: Db,
  t: TicketRow,
  next: TicketStatus,
  actor: { id: string | null; side: 'customer' | 'staff' },
  meta: Pick<RequestMeta, 'ip' | 'userAgent'> = { ip: null, userAgent: null },
): Promise<TicketRow> => {
  if (t.status === next) return t;
  const now = new Date();
  const patch: Partial<TicketRow> = { status: next, ...slaOnStatus(t, next, now) };
  if (next === 'solved') patch.solvedAt = t.solvedAt ?? now;
  if (next === 'closed') {
    patch.closedAt = now;
    patch.solvedAt = t.solvedAt ?? now;
  }
  if (!TICKET_DONE_STATUSES.includes(next)) {
    patch.solvedAt = null;
    patch.closedAt = null;
  }
  await updateTicketRow(db, t.id, patch);
  await insertEvent(db, t.id, actor.id, 'status', { from: t.status, to: next, by: actor.side });
  if (TICKET_DONE_STATUSES.includes(next)) await endTicketAccess(db, t, actor.id, meta);
  return (await findTicket(db, t.id))!;
};

/** Revokes the ticket's grants and ends its pending access requests (solved / closed). */
export const endTicketAccess = async (
  db: Db,
  t: TicketRow,
  actorId: string | null,
  meta: Pick<RequestMeta, 'ip' | 'userAgent'>,
) => {
  const revoked = await revokeTicketGrantRows(db, t.id, actorId);
  for (const g of revoked) {
    await recordAudit(db, {
      accountId: g.accountId,
      actorId,
      action: 'support.revoked',
      targetType: 'support_grant',
      targetId: g.id,
      payload: {
        mode: g.scope === 'read_write' ? 'edit' : 'view',
        expires_at: g.expiresAt.toISOString(),
        email: g.grantedToEmail,
        ticket_id: t.id,
        ticket_number: t.number,
        via: 'ticket',
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    // The docs socket re-checks the account's connections on `account.*` (S-24).
    await recordEvent(db, {
      accountId: g.accountId,
      type: 'account.support_access_changed',
      actorId,
      meta: { grant_id: g.id, action: 'revoked', ticket_id: t.id },
    });
    await insertEvent(db, t.id, actorId, 'access.revoked', { grant_id: g.id });
  }
  const cancelled = await cancelPendingRequests(db, t.id, actorId);
  for (const r of cancelled) await insertEvent(db, t.id, actorId, 'access.cancelled', { request_id: r.id });
  return revoked.length;
};
