// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type AuditEntry,
  type AuditPage,
  auditQuerySchema,
  canAccount,
  formatDateTime,
  toCsv,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import { accountRegion } from '../accounts/region';
import { auditEventTypes, type AuditFilter, boardNames, countAudit, listAudit, userNames } from './admin.repo';
import { st } from '../../lib/i18n';

/**
 * Administration → יומן ביקורת (08 §11, account admin A4): the account's `audit_log` with filters (person, event,
 * days), pages and a CSV. Admins only (`audit.read`). Rows are written by `recordAudit` where things happen.
 */
type Actor = { ctx: AccountContext; user?: Pick<SessionUser, 'locale' | 'timezone'> };

const assertCanRead = (ctx: AccountContext) => {
  const decision = canAccount(ctx.role, 'audit.read');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
};

const DAY = 86_400_000;
const filterOf = (q: z.infer<typeof auditQuerySchema>): AuditFilter => ({
  actorId: q.actor_id || undefined,
  event: q.event || undefined,
  from: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined,
  // `to` is inclusive: until the start of the next day.
  to: q.to ? new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + DAY) : undefined,
});

type Row = Awaited<ReturnType<typeof listAudit>>[number];

/** Names of the targets (people, boards) — or what the row itself remembers (an email, a token's name). */
const toEntries = async (db: Db, accountId: string, rows: Row[]): Promise<AuditEntry[]> => {
  const userIds = rows.filter((r) => r.row.targetType === 'user' && r.row.targetId).map((r) => r.row.targetId!);
  const boardIds = rows.filter((r) => r.row.targetType === 'board' && r.row.targetId).map((r) => r.row.targetId!);
  const [people, boards] = await Promise.all([
    userNames(db, [...new Set(userIds)]),
    boardNames(db, accountId, [...new Set(boardIds)]),
  ]);
  return rows.map(({ row, actorName }) => {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const remembered = typeof p.name === 'string' ? p.name : typeof p.email === 'string' ? p.email : null;
    const target_name =
      (row.targetType === 'user' && row.targetId ? people.get(row.targetId) : undefined) ??
      (row.targetType === 'board' && row.targetId ? boards.get(row.targetId) : undefined) ??
      remembered;
    return {
      id: row.id,
      created_at: row.createdAt.toISOString(),
      actor_id: row.actorId,
      actor_name: actorName ?? null,
      event: row.action,
      target_type: row.targetType,
      target_id: row.targetId,
      target_name,
      details: p,
      ip: row.ip,
      user_agent: row.userAgent,
    };
  });
};

export const listAuditLog = async (db: Db, a: Actor, raw: z.input<typeof auditQuerySchema>): Promise<AuditPage> => {
  assertCanRead(a.ctx);
  const q = auditQuerySchema.parse(raw);
  const f = filterOf(q);
  const [rows, total, events] = await Promise.all([
    listAudit(db, a.ctx.accountId, f, q.page_size, (q.page - 1) * q.page_size),
    countAudit(db, a.ctx.accountId, f),
    auditEventTypes(db, a.ctx.accountId),
  ]);
  return { data: await toEntries(db, a.ctx.accountId, rows), total, page: q.page, page_size: q.page_size, events };
};

const CSV_LIMIT = 10_000;

/** GET /audit/export.csv — the filtered log (newest first, ≤10,000 rows; headers in the reader's language, BOM). */
export const auditCsv = async (db: Db, a: Actor, raw: z.input<typeof auditQuerySchema>) => {
  assertCanRead(a.ctx);
  const q = auditQuerySchema.parse(raw);
  const entries = await toEntries(db, a.ctx.accountId, await listAudit(db, a.ctx.accountId, filterOf(q), CSV_LIMIT, 0));
  // The time in the reader's region (A3) — date / time format and zone.
  const region = await accountRegion(db, a.ctx.accountId, a.user);
  return toCsv(
    ['time', 'actor', 'event', 'target', 'targetId', 'ip', 'browser', 'details'].map((k) =>
      st(`server.csv.audit.${k}`, undefined, region.language),
    ),
    entries.map((e) => [
      formatDateTime(e.created_at, {}, region),
      e.actor_name ?? '',
      e.event,
      e.target_name ?? e.target_type ?? '',
      e.target_id ?? '',
      e.ip ?? '',
      e.user_agent ?? '',
      JSON.stringify(e.details),
    ]),
  );
};
