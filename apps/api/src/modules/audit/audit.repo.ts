// SPDX-License-Identifier: AGPL-3.0-only
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { auditLog } from '../../db/schema';

/** Security/admin events (08 §11). Every account/user/invitation/platform mutation writes one row. */
export type AuditEntry = {
  accountId: string;
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

export const recordAudit = (db: Db, e: AuditEntry) =>
  db.insert(auditLog).values({
    id: newId(),
    accountId: e.accountId,
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    payload: e.payload ?? {},
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  });
