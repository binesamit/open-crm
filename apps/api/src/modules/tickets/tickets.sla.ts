// SPDX-License-Identifier: AGPL-3.0-only
import {
  addBusinessMinutes,
  type BusinessHours,
  SLA_PAUSED_STATUSES,
  type TicketSla,
  type TicketStatus,
} from '@bines/shared';
import type { SlaRow, TicketRow } from './tickets.repo';

/**
 * SLA timers (stage 5): per priority a first-response and a resolution target, in business hours or
 * around the clock (owner console → Support → SLA). The resolution timer stops while the ticket waits for the
 * customer or is on hold, and the deadline moves by the time it stood still. Breach rules here and in SQL
 * (`firstBreachSql` / `resolutionBreachSql`) are the same.
 */
export const slaDue = (from: Date, policy: SlaRow | undefined, hours: BusinessHours) => ({
  firstResponseDueAt: policy
    ? addBusinessMinutes(from, policy.firstResponseMinutes, hours, policy.businessHours)
    : null,
  resolutionDueAt: policy ? addBusinessMinutes(from, policy.resolutionMinutes, hours, policy.businessHours) : null,
});

export const slaOf = (t: TicketRow, now = new Date()): TicketSla => {
  const fr = t.firstResponseDueAt;
  const rd = t.resolutionDueAt;
  const firstBreached = !!fr && (t.firstRespondedAt ? t.firstRespondedAt > fr : now > fr);
  const resolutionBreached = !!rd && (t.solvedAt ? t.solvedAt > rd : t.slaPausedAt ? t.slaPausedAt > rd : now > rd);
  return {
    first_response_due_at: fr?.toISOString() ?? null,
    resolution_due_at: rd?.toISOString() ?? null,
    first_responded_at: t.firstRespondedAt?.toISOString() ?? null,
    first_response_breached: firstBreached,
    resolution_breached: resolutionBreached,
    paused: !!t.slaPausedAt,
  };
};

/**
 * The SLA fields that change with a status change: entering a waiting status stops the resolution timer; leaving
 * it moves the deadline by the pause; solving stops it for good (the pause is cleared, the deadline stays).
 */
export const slaOnStatus = (t: TicketRow, next: TicketStatus, now = new Date()) => {
  const paused = SLA_PAUSED_STATUSES.includes(next);
  const patch: Partial<TicketRow> = {};
  if (paused && !t.slaPausedAt) patch.slaPausedAt = now;
  if (!paused && t.slaPausedAt) {
    patch.slaPausedAt = null;
    if (t.resolutionDueAt && next !== 'solved' && next !== 'closed')
      patch.resolutionDueAt = new Date(t.resolutionDueAt.getTime() + (now.getTime() - t.slaPausedAt.getTime()));
  }
  return patch;
};
