// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccessRequest,
  TicketContext,
  TicketMessage,
  TicketPriority,
  TicketStatus,
  TicketSummary,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { ticketArticlesByIds } from './tickets.articles';
import { slaOf } from './tickets.sla';
import {
  listAccessRequests,
  listAttachments,
  listMessages,
  type TicketListRow,
  type TicketRow,
  ticketTagsOf,
} from './tickets.repo';

/** The DTOs of tickets; `staff` adds what only the console shows (account, assignee, SLA, tags). */
export const summaryOf = (
  r: Pick<TicketListRow, 't' | 'categoryName'> & Partial<TicketListRow>,
  staff: boolean,
  tags: { id: string; name: string; color: string | null }[] = [],
  now = new Date(),
): TicketSummary => {
  const t = r.t;
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status as TicketStatus,
    priority: t.priority as TicketPriority,
    category: t.categoryId && r.categoryName ? { id: t.categoryId, name: r.categoryName } : null,
    requester: { id: t.requesterId, name: t.requesterName || t.requesterEmail, email: t.requesterEmail },
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
    solved_at: t.solvedAt?.toISOString() ?? null,
    closed_at: t.closedAt?.toISOString() ?? null,
    csat_rating: t.csatRating,
    ...(staff
      ? {
          account: { id: t.accountId, name: r.accountName ?? '', slug: r.accountSlug ?? '' },
          assignee: t.assigneeId ? { id: t.assigneeId, name: r.assigneeName ?? '' } : null,
          queue: t.queueId && r.queueName ? { id: t.queueId, name: r.queueName } : null,
          tags,
          sla: slaOf(t, now),
        }
      : {}),
  };
};

export const withTags = async (db: Db, rows: TicketListRow[], staff: boolean) => {
  const tags = staff
    ? await ticketTagsOf(
        db,
        rows.map((r) => r.t.id),
      )
    : [];
  const now = new Date();
  return rows.map((r) =>
    summaryOf(
      r,
      staff,
      tags.filter((x) => x.ticketId === r.t.id).map(({ id, name, color }) => ({ id, name, color })),
      now,
    ),
  );
};

/**
 * The thread: the customer never gets internal notes (they are not even read). Attached articles are read live, under
 * the customer's reading rules — staff see the same cards the customer does.
 */
export const threadOf = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  t: TicketRow,
  staff: boolean,
): Promise<TicketMessage[]> => {
  const [messages, files] = await Promise.all([listMessages(deps.db, t.id, !staff), listAttachments(deps.db, t.id)]);
  const articles = await ticketArticlesByIds(
    deps,
    messages.flatMap((m) => m.articleIds ?? []),
  );
  return messages.map((m) => ({
    id: m.id,
    kind: m.kind as TicketMessage['kind'],
    visibility: m.visibility as TicketMessage['visibility'],
    body: m.body,
    author: m.kind === 'system' ? null : { id: m.authorId, name: m.authorName },
    created_at: m.createdAt.toISOString(),
    attachments: files
      .filter((f) => f.a.messageId === m.id && f.asset.uploadStatus === 'uploaded')
      .map((f) => ({ id: f.a.id, name: f.asset.fileName, size: f.asset.size, mime: f.asset.mime })),
    articles: (m.articleIds ?? []).flatMap((id) => {
      const a = articles.get(id);
      return a ? [a] : [];
    }),
  }));
};

export const accessRequestsOf = async (db: Db, ticketId: string, now = new Date()): Promise<AccessRequest[]> =>
  (await listAccessRequests(db, ticketId)).map(({ r, requesterName, deciderName, grant }) => ({
    id: r.id,
    ticket_id: r.ticketId,
    mode: r.mode === 'edit' ? 'edit' : 'view',
    duration_hours: r.durationHours,
    reason: r.reason,
    status: (r.status === 'pending' && r.expiresAt <= now ? 'expired' : r.status) as AccessRequest['status'],
    requested_by: { id: r.requestedBy, name: requesterName ?? '' },
    created_at: r.createdAt.toISOString(),
    expires_at: r.expiresAt.toISOString(),
    decided_at: r.decidedAt?.toISOString() ?? null,
    decided_by_name: deciderName,
    grant_id: r.grantId,
    grant_status: grant ? (grant.revokedAt ? 'revoked' : grant.expiresAt <= now ? 'expired' : 'active') : null,
    grant_expires_at: grant?.expiresAt.toISOString() ?? null,
  }));

export const contextOf = (t: TicketRow) => (t.context ?? null) as TicketContext | null;
