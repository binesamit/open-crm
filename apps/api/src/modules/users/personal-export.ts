// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AppError, canAccount } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  apiTokens,
  assets,
  auditLog,
  authIdentities,
  authSessions,
  legalConsents,
  legalDocuments,
  notifications,
  timeEntries,
  updates,
  users,
} from '../../db/schema';
import { RateLimiter } from '../../lib/rate-limit';
import type { Actor, RequestMeta, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { findMemberWithUser } from './admin.repo';

/**
 * Personal data export (privacy — GDPR art. 15 access and art. 20 portability; Israel Privacy Law
 * §13 right of access): what the platform holds about one person, as one JSON file.
 *
 * - `GET /me/export`: the person, about themself — every account they belong to.
 * - `GET /users/{id}/export`: an account admin, about a member — only that account's rows (the account is the
 *   controller of its members' data there; other accounts are not theirs to see).
 *
 * Never in it: secrets (password hash, 2FA secret, session / API / OAuth tokens — only their names, prefixes and
 * dates), other people's content beyond what this person wrote. Board content the person merely appears in (a
 * people cell, a mention) stays with the account's own export — it is the account's record, not the person's.
 * Lists are capped (the newest first) so a file stays a file; `truncated` says when a cap was hit.
 */
export const PERSONAL_EXPORT_VERSION = 1;
const CAP = 5000;

/** Five exports an hour per person (it reads many tables). */
const newLimiter = () => new RateLimiter(5, 60 * 60_000);
let limiter = newLimiter();
export const forgetPersonalExportLimits = () => {
  limiter = newLimiter();
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const build = async (db: Db, userId: string, accountId: string | null) => {
  const inAccount = <T>(col: T) => (accountId ? eq(col as never, accountId) : undefined);
  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user) throw new AppError('not_found', 'User not found');

  const memberships = await db
    .select({ m: accountMembers, name: accounts.name, slug: accounts.slug })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(and(eq(accountMembers.userId, userId), inAccount(accountMembers.accountId)));

  const consents = accountId
    ? []
    : await db
        .select({ c: legalConsents, slug: legalDocuments.slug })
        .from(legalConsents)
        .innerJoin(legalDocuments, eq(legalDocuments.id, legalConsents.documentId))
        .where(eq(legalConsents.userId, userId))
        .orderBy(desc(legalConsents.createdAt));

  const sessions = accountId
    ? []
    : await db.select().from(authSessions).where(eq(authSessions.userId, userId)).orderBy(desc(authSessions.createdAt));
  const identities = accountId
    ? []
    : await db
        .select({ provider: authIdentities.providerId, createdAt: authIdentities.createdAt })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userId));

  const tokens = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), inAccount(apiTokens.accountId)))
    .orderBy(desc(apiTokens.createdAt));

  const written = await db
    .select()
    .from(updates)
    .where(and(eq(updates.createdBy, userId), isNull(updates.deletedAt), inAccount(updates.accountId)))
    .orderBy(desc(updates.createdAt))
    .limit(CAP + 1);

  const time = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.userId, userId), isNull(timeEntries.deletedAt), inAccount(timeEntries.accountId)))
    .orderBy(desc(timeEntries.startedAt))
    .limit(CAP + 1);

  const files = await db
    .select()
    .from(assets)
    .where(and(eq(assets.ownerId, userId), isNull(assets.deletedAt), inAccount(assets.accountId)))
    .orderBy(desc(assets.createdAt))
    .limit(CAP + 1);

  const bell = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), inAccount(notifications.accountId)))
    .orderBy(desc(notifications.createdAt))
    .limit(CAP + 1);

  const audit = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actorId, userId), inAccount(auditLog.accountId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(CAP + 1);

  const cap = <T>(rows: T[]) => rows.slice(0, CAP);
  const truncated = [written, time, files, bell, audit].some((r) => r.length > CAP);

  return {
    format: 'bines-personal-export' as const,
    version: PERSONAL_EXPORT_VERSION,
    generated_at: new Date().toISOString(),
    scope: (accountId ? 'account' : 'all_accounts') as 'account' | 'all_accounts',
    truncated,
    profile: {
      id: user.id,
      email: user.email,
      email_verified: user.emailVerified,
      name: user.name,
      title: user.title,
      phone: user.phone,
      department: user.department,
      birthday: user.birthday,
      locale: user.locale,
      timezone: user.timezone,
      two_factor_enabled: user.twoFactorEnabled,
      created_at: iso(user.createdAt),
      last_seen_at: iso(user.lastSeenAt),
    },
    memberships: memberships.map(({ m, name, slug }) => ({
      account: { id: m.accountId, name, slug },
      role: m.role,
      status: m.status,
      title: m.title,
      department: m.department,
      phone: m.phone,
      invited_at: iso(m.invitedAt),
      joined_at: iso(m.joinedAt),
      deactivated_at: iso(m.deactivatedAt),
    })),
    legal_consents: consents.map(({ c, slug }) => ({
      document: slug,
      version: c.version,
      context: c.context,
      at: iso(c.createdAt),
      ip: c.ip,
      user_agent: c.userAgent,
    })),
    sign_in: {
      providers: identities.map((i) => ({ provider: i.provider, linked_at: iso(i.createdAt) })),
      sessions: sessions.map((s) => ({
        created_at: iso(s.createdAt),
        expires_at: iso(s.expiresAt),
        ip: s.ipAddress,
        user_agent: s.userAgent,
        method: s.signInMethod,
      })),
    },
    api_tokens: tokens.map((t) => ({
      account_id: t.accountId,
      name: t.name,
      prefix: t.tokenPrefix,
      scopes: t.scopes,
      created_at: iso(t.createdAt),
      last_used_at: iso(t.lastUsedAt),
      expires_at: iso(t.expiresAt),
      revoked_at: iso(t.revokedAt),
    })),
    updates: cap(written).map((u) => ({
      id: u.id,
      account_id: u.accountId,
      board_id: u.boardId,
      item_id: u.itemId,
      reply_to: u.parentUpdateId,
      // A secret update's text is sealed: the export says there is one, never what it says.
      text: u.isSecret ? '🔒' : u.bodyText,
      created_at: iso(u.createdAt),
      edited_at: iso(u.editedAt),
    })),
    time_entries: cap(time).map((e) => ({
      account_id: e.accountId,
      item_id: e.itemId,
      started_at: iso(e.startedAt),
      ended_at: iso(e.endedAt),
      duration_s: e.durationS,
      note: e.note,
      billable: e.billable,
    })),
    files: cap(files).map((f) => ({
      id: f.id,
      account_id: f.accountId,
      name: f.fileName,
      mime: f.mime,
      size: f.size,
      created_at: iso(f.createdAt),
    })),
    notifications: cap(bell).map((n) => ({
      account_id: n.accountId,
      type: n.type,
      item_id: n.itemId,
      created_at: iso(n.createdAt),
      read_at: iso(n.readAt),
    })),
    security_log: cap(audit).map((r) => ({
      account_id: r.accountId,
      action: r.action,
      target: r.targetType ? { type: r.targetType, id: r.targetId } : null,
      at: iso(r.createdAt),
      ip: r.ip,
      user_agent: r.userAgent,
    })),
  };
};

export type PersonalExport = Awaited<ReturnType<typeof build>>;

const charge = (key: string) => {
  const wait = limiter.hit(key);
  if (wait > 0) throw new AppError('rate_limited', 'Too many exports', { retry_after_ms: wait });
};

/** GET /me/export — the signed-in person, about themself (every account). Audited in each account they are in. */
export const exportMyData = async (db: Db, user: SessionUser, meta: RequestMeta) => {
  if (user.isService) throw new AppError('forbidden', 'not_for_service_users');
  charge(`me:${user.id}`);
  const data = await build(db, user.id, null);
  for (const m of data.memberships)
    await recordAudit(db, {
      accountId: m.account.id,
      actorId: user.id,
      action: 'user.data_exported',
      targetType: 'user',
      targetId: user.id,
      payload: { by: 'self' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  return data;
};

/** GET /users/{id}/export — an account admin, about a member: this account's rows only. Audited. */
export const exportMemberData = async (db: Db, a: Actor, userId: string, meta: RequestMeta) => {
  const decision = canAccount(a.ctx.role, 'users.manage');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  if (!(await findMemberWithUser(db, a.ctx.accountId, userId))) throw new AppError('not_found', 'User not found');
  charge(`member:${a.user.id}`);
  const data = await build(db, userId, a.ctx.accountId);
  await recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'user.data_exported',
    targetType: 'user',
    targetId: userId,
    payload: { by: 'admin' },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return data;
};
