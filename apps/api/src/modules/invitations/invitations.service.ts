// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import {
  AppError,
  canAccount,
  canInviteRole,
  DASHBOARD_LEVELS,
  type DashboardLevel,
  DOC_LEVELS,
  newId,
  type AccountRole,
  type DocLevel,
  type InvitationStatus,
} from '@bines/shared';
import { findDashboard, insertDashboardMembers } from '../dashboards/dashboards.repo';
import { auditGuestShare } from '../sharing/sharing';
import { findDoc, insertDocMembers } from '../docs/docs.repo';
import type { z } from 'zod';
import type { inviteUsersSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers, users } from '../../db/schema';
import { invitationEmail } from '@bines/server-mail';
import { RateLimiter } from '../../lib/rate-limit';
import { newSecretToken, sha256 } from '../../lib/tokens';
import type { AccountContext, AppDeps, RequestMeta, SessionUser } from '../../types';
import { accountDto, loadSettings } from '../accounts/accounts.service';
import { findMembership, insertMembership, type AccountRow } from '../accounts/accounts.repo';
import { assertFeature, assertWithinLimit } from '../billing/entitlements';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { securityOf } from '../admin/security.service';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { findBoard, findWorkspace, insertBoardMember } from '../boards/boards.repo';
import { insertWorkspaceMember } from '../boards/workspace-members.repo';
import { findLocaleByEmail, findUserIdByEmail, setLastAccountId } from '../users/users.repo';
import { accountMailBrand } from '../platform/mail-brand';
import { assertMayJoinAccount, ownerMayJoin } from '../support/support.access';
import { isPlatformOwnerUser } from '../support/support.repo';
import { loadPlatformSettings } from '../platform/platform-settings';
import { notifyUsers } from '../notifications/notify';
import { accountPasswordMin } from '../../auth/password-policy';
import {
  findInvitationInAccount,
  findInviterName,
  findOpenInvitationForAccountEmail,
  findPendingInvitationForAccountEmail,
  findValidInvitationByToken,
  insertInvitation,
  type InvitationRow,
  listOpenInvitationsForAccount,
  listPendingInvitationsForEmail,
  markInvitationAccepted,
  markInvitationEmailed,
  markInvitationOpened,
  revokeInvitation,
  rotateInvitationToken,
} from './invitations.repo';
import { webOrigin } from '../platform/public-address';

const DAY_MS = 24 * 60 * 60 * 1000;

type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>;

/**
 * Invitation emails per inviter per hour (S-12): a taken-over account cannot send hundreds of emails from our
 * domain. The owner console's platform settings set it (empty = env INVITE_EMAILS_PER_HOUR, default 50; 0 = none).
 * Copy-link invitations send nothing and are not counted.
 */
const inviteEmails = new RateLimiter(Number.MAX_SAFE_INTEGER, 60 * 60 * 1000);

/** Counts one invitation email for `inviterId`; 429 `rate_limited` once the hour's budget is used up. */
const takeInviteEmail = async (deps: Pick<AppDeps, 'db' | 'env'>, inviterId: string | null) => {
  const limit = (await loadPlatformSettings(deps.db)).email.invite_emails_per_hour ?? deps.env.INVITE_EMAILS_PER_HOUR;
  if (!inviterId || !limit) return;
  const { waitMs } = inviteEmails.take(inviterId, limit);
  if (waitMs > 0)
    throw new AppError('rate_limited', 'Too many invitation emails', { retry_after_ms: waitMs, limit_per_hour: limit });
};

/** Where an open invitation stands (`INVITATION_STATUSES`). */
export const invitationStatus = (inv: InvitationRow, now = Date.now()): InvitationStatus => {
  if (inv.expiresAt.getTime() <= now) return 'expired';
  if (inv.openedAt) return 'opened';
  if (inv.emailStatus === 'failed') return 'failed';
  return inv.emailStatus === 'sent' ? 'sent' : 'link';
};

/**
 * `url` only for whoever just issued the link (the raw token is never stored, so lists cannot show it).
 * `inviterName` (lists): who invited — null when that person is gone.
 */
export const invitationDto = (inv: InvitationRow, url?: string, inviterName?: string | null) => ({
  id: inv.id,
  email: inv.email,
  role: inv.role,
  expires_at: inv.expiresAt.toISOString(),
  created_at: inv.createdAt.toISOString(),
  status: invitationStatus(inv),
  last_sent_at: inv.lastSentAt?.toISOString() ?? null,
  send_count: inv.sendCount,
  opened_at: inv.openedAt?.toISOString() ?? null,
  ...(inviterName !== undefined
    ? { invited_by: inv.invitedBy && inviterName ? { id: inv.invitedBy, name: inviterName } : null }
    : {}),
  ...(url ? { url } : {}),
});

/** The account's invitation settings: link lifetime, resend wait, telling the inviter. */
const invitationSettingsOf = async (db: Db, accountId: string) => (await loadSettings(db, accountId)).invitations;

/** Up to five active people of the account (the seats already taken on the invitation; no service users). */
const teamNames = async (db: Db, accountId: string) =>
  (
    await db
      .select({ name: users.name })
      .from(accountMembers)
      .innerJoin(users, eq(users.id, accountMembers.userId))
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.status, 'active'), eq(users.isService, false)),
      )
      .orderBy(asc(accountMembers.joinedAt))
      .limit(5)
  ).map((r) => r.name);

/**
 * Emails the invitation link (branded as the account) and records it on the invitation: when, by whom, one more
 * send, sent / failed. A failure is reported (false), never thrown — the link is still there to copy.
 */
const emailInvitation = async (
  deps: Deps,
  account: AccountRow,
  inv: InvitationRow,
  url: string,
  by: string | null,
  message?: string,
) => {
  let emailed = true;
  try {
    await deps.mailer.send(
      invitationEmail({
        to: inv.email,
        // The invitee's language when they already use the platform, else the account's.
        brand: await accountMailBrand(deps, account, await findLocaleByEmail(deps.db, inv.email)),
        accountName: account.name,
        inviterName: (await findInviterName(deps.db, inv.invitedBy ?? by)) ?? null,
        role: inv.role,
        url,
        message,
        team: await teamNames(deps.db, account.id),
      }),
    );
  } catch (err) {
    emailed = false;
    deps.logger.warn({ err, invitationId: inv.id }, 'invitation email failed');
  }
  await markInvitationEmailed(deps.db, inv.id, by, emailed);
  return emailed;
};

/** The landing page of an invitation token. */
/** `origin` = the platform's public address (owner console, M11; else WEB_ORIGIN). */
export const invitationUrl = (origin: string, token: string) => `${origin}/invite/${token}`;

const emailDomain = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

/**
 * Domain rules of an invitation (08 §5, account admin A4): a guest is never from the account's own domains and
 * follows the guest domain policy (allow / block list); with "members only from our domains" on, everyone else
 * must be from one of them. null = allowed.
 */
const domainRefusal = (
  settings: { domains: string[] } & Record<string, unknown>,
  role: AccountRole,
  domain: string,
): string | null => {
  const security = securityOf(settings);
  if (role === 'guest') {
    if (settings.domains.includes(domain)) return 'guest_domain_not_external';
    const policy = security.guest_domain_policy;
    if (policy.mode === 'allow_list' && !policy.domains.includes(domain)) return 'guest_domain_not_allowed';
    if (policy.mode === 'block_list' && policy.domains.includes(domain)) return 'guest_domain_blocked';
    return null;
  }
  if (security.restrict_members_to_domains && settings.domains.length && !settings.domains.includes(domain))
    return 'domain_not_allowed';
  return null;
};

/**
 * Creates (or replaces) a pending invitation and emails the link. Shared by account admins (POST /users/invite)
 * and the owner console (first admin of a new account). Returns the invitation and its link (for the issuer to
 * copy and send another way — fix8); email failures are reported, not thrown. `sendEmail: false` = link only
 * ("העתקת קישור"): nothing is sent. Either way any earlier link for the same email stops working.
 */
/**
 * A new invitation to an address that already has a pending one replaces it — and keeps what the earlier one gave
 * (boards, workspaces, docs, dashboards): sharing a board and then a dashboard with the same new person is one
 * invitation that opens both. Lists are merged; the old message is not carried.
 *
 * Doc and dashboard levels are kept per object (`doc_levels` / `dashboard_levels`, S-62): the new invitation sets
 * the level only on the objects it shares itself (its inviter was checked for those — `doc.manage` /
 * `dashboard.manage`), and an object only the earlier invitation shared keeps the level that inviter set. A later
 * inviter can never raise a grant on an object they cannot share.
 */
export const mergeInvitationAccess = (prev: unknown, next: Record<string, unknown>): Record<string, unknown> => {
  const merged = (() => {
    if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return { ...next };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prev as Record<string, unknown>)) if (k !== 'message') out[k] = v;
    for (const [k, v] of Object.entries(next)) {
      if (k.endsWith('_level') || k.endsWith('_levels')) continue; // per object, below
      const before = out[k];
      out[k] = k.endsWith('_ids') && Array.isArray(v) && Array.isArray(before) ? [...new Set([...before, ...v])] : v;
    }
    return out;
  })();
  const prevObj = prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
  for (const kind of ['doc', 'dashboard'] as const) {
    const levels = { ...levelsOf(prevObj, kind), ...levelsOf(next, kind) };
    delete merged[`${kind}_level`];
    delete merged[`${kind}_levels`];
    if (Object.keys(levels).length) merged[`${kind}_levels`] = levels;
  }
  return merged;
};

/**
 * The level of each doc / dashboard an invitation payload shares: `<kind>_levels` (per object), else the older
 * single `<kind>_level` for all of its `<kind>_ids` (invitations made before S-62), else viewer.
 */
export const levelsOf = (payload: unknown, kind: 'doc' | 'dashboard'): Record<string, string> => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const p = payload as Record<string, unknown>;
  const ids = Array.isArray(p[`${kind}_ids`]) ? (p[`${kind}_ids`] as unknown[]) : [];
  const single = typeof p[`${kind}_level`] === 'string' ? (p[`${kind}_level`] as string) : 'viewer';
  const per =
    p[`${kind}_levels`] && typeof p[`${kind}_levels`] === 'object' && !Array.isArray(p[`${kind}_levels`])
      ? (p[`${kind}_levels`] as Record<string, unknown>)
      : {};
  const out: Record<string, string> = {};
  for (const id of ids)
    if (typeof id === 'string') out[id] = typeof per[id] === 'string' ? (per[id] as string) : single;
  return out;
};

export const issueInvitation = async (
  deps: Deps,
  p: {
    account: AccountRow;
    email: string;
    role: AccountRole;
    invitedBy: string | null;
    payload?: Record<string, unknown>;
    message?: string;
    sendEmail?: boolean;
    auditAction?: string;
    /** Extra fields of the audit row (e.g. `via: 'platform_owner'` from the owner console). */
    auditPayload?: Record<string, unknown>;
  },
): Promise<{ invitation: InvitationRow; emailed: boolean; url: string }> => {
  const { db } = deps;
  // Plans: inviting a guest is the plan's `guests` (guests already in stay).
  if (p.role === 'guest') await assertFeature(db, p.account.id, 'guests');
  // Plans: a new non-guest invitation takes a seat (re-inviting the same address takes none).
  if (p.role !== 'guest' && !(await findPendingInvitationForAccountEmail(db, p.account.id, p.email)))
    await assertWithinLimit(db, p.account.id, 'seats', 1);
  if (p.sendEmail !== false) await takeInviteEmail(deps, p.invitedBy);
  const { expiry_days } = await invitationSettingsOf(db, p.account.id);
  const token = newSecretToken();
  const id = newId();

  await db.transaction(async (tx) => {
    // An open one to the same address (pending, or expired) is replaced: one invitation per address.
    const existing = await findOpenInvitationForAccountEmail(tx, p.account.id, p.email);
    if (existing) await revokeInvitation(tx, existing.id, p.invitedBy);
    await insertInvitation(tx, {
      id,
      accountId: p.account.id,
      email: p.email,
      role: p.role,
      tokenHash: sha256(token),
      payload: {
        ...mergeInvitationAccess(existing?.payload, p.payload ?? {}),
        ...(p.message ? { message: p.message } : {}),
      },
      invitedBy: p.invitedBy,
      expiresAt: new Date(Date.now() + expiry_days * DAY_MS),
    });
    await recordAudit(tx, {
      accountId: p.account.id,
      actorId: p.invitedBy,
      action: p.auditAction ?? 'user.invited',
      targetType: 'invitation',
      targetId: id,
      payload: { email: p.email, role: p.role, replaced: existing?.id ?? null, ...p.auditPayload },
    });
  });

  const url = invitationUrl(await webOrigin(deps), token);
  if (p.sendEmail === false)
    return { invitation: (await findInvitationInAccount(db, p.account.id, id))!, emailed: false, url };
  const emailed = await emailInvitation(
    deps,
    p.account,
    (await findInvitationInAccount(db, p.account.id, id))!,
    url,
    p.invitedBy,
    p.message,
  );
  return { invitation: (await findInvitationInAccount(db, p.account.id, id))!, emailed, url };
};

/**
 * Re-send / copy link (decided): the SAME invitation — id, inviter, role, boards and the rest — gets a
 * new link valid `expiresInDays` (default: the account's setting); the earlier link stops working at once (only a
 * hash is stored, so an old link cannot be re-sent; one live link per invitation). An expired invitation comes back
 * to life this way (and takes a seat again). Emailing (not a copied link) waits the account's resend cooldown and
 * counts in the hourly email budget (S-12).
 */
export const reissueInvitation = async (
  deps: Deps,
  p: {
    account: AccountRow;
    invitation: InvitationRow;
    actorId: string;
    linkOnly?: boolean;
    expiresInDays?: number;
    /** Extra fields of the audit row (`via: 'platform_owner'` from the owner console). */
    auditPayload?: Record<string, unknown>;
  },
) => {
  const { db } = deps;
  const inv = p.invitation;
  if (inv.acceptedAt || inv.revokedAt) throw new AppError('not_found', 'Invitation not found');
  const settings = await invitationSettingsOf(db, p.account.id);
  if (!p.linkOnly && inv.lastSentAt && settings.resend_cooldown_minutes > 0) {
    const waitMs = inv.lastSentAt.getTime() + settings.resend_cooldown_minutes * 60_000 - Date.now();
    if (waitMs > 0)
      throw new AppError('rate_limited', 'invitation_resend_cooldown', {
        retry_after_ms: waitMs,
        cooldown_minutes: settings.resend_cooldown_minutes,
      });
  }
  if (inv.expiresAt.getTime() <= Date.now()) {
    if (inv.role === 'guest') await assertFeature(db, p.account.id, 'guests');
    else await assertWithinLimit(db, p.account.id, 'seats', 1);
  }
  if (!p.linkOnly) await takeInviteEmail(deps, p.actorId);
  const days = p.expiresInDays ?? settings.expiry_days;
  const token = newSecretToken();
  await db.transaction(async (tx) => {
    await rotateInvitationToken(tx, inv.id, sha256(token), new Date(Date.now() + days * DAY_MS));
    await recordAudit(tx, {
      accountId: p.account.id,
      actorId: p.actorId,
      action: p.linkOnly ? 'invitation.link_copied' : 'invitation.resent',
      targetType: 'invitation',
      targetId: inv.id,
      payload: { email: inv.email, role: inv.role, expires_in_days: days, ...p.auditPayload },
    });
  });
  const url = invitationUrl(await webOrigin(deps), token);
  const fresh = (await findInvitationInAccount(db, p.account.id, inv.id))!;
  const message = (inv.payload as { message?: string }).message;
  const emailed = p.linkOnly ? false : await emailInvitation(deps, p.account, fresh, url, p.actorId, message);
  return { invitation: (await findInvitationInAccount(db, p.account.id, inv.id))!, emailed, url };
};

/** Cancels an open invitation: its link stops working at once; audited (`invitation.revoked`). */
export const cancelInvitation = async (
  db: Db,
  p: { accountId: string; id: string; actorId: string; auditPayload?: Record<string, unknown>; meta?: RequestMeta },
) => {
  const inv = await findInvitationInAccount(db, p.accountId, p.id);
  if (!inv || inv.acceptedAt || inv.revokedAt) throw new AppError('not_found', 'Invitation not found');
  await db.transaction(async (tx) => {
    await revokeInvitation(tx, p.id, p.actorId);
    await recordAudit(tx, {
      accountId: p.accountId,
      actorId: p.actorId,
      action: 'invitation.revoked',
      targetType: 'invitation',
      targetId: p.id,
      payload: { email: inv.email, role: inv.role, ...p.auditPayload },
      ip: p.meta?.ip,
      userAgent: p.meta?.userAgent,
    });
  });
};

/** The account's open invitations (pending + expired) with status and inviter. */
export const openInvitationsOf = async (db: Db, accountId: string) =>
  (await listOpenInvitationsForAccount(db, accountId)).map(({ inviterName, ...inv }) =>
    invitationDto(inv, undefined, inviterName ?? null),
  );

/** Who an invitation lets in besides the account: boards to subscribe and (closed) workspaces to join on accepting. */
export type InviteAccess = {
  boardIds?: string[];
  workspaceIds?: string[];
  /** Docs to join on accepting (M8 ד3, the doc's share dialog), at this level. */
  docIds?: string[];
  docLevel?: DocLevel;
  /** Dashboards to join on accepting (the dashboard's share dialog), at this level. */
  dashboardIds?: string[];
  dashboardLevel?: DashboardLevel;
};

/**
 * Invites the emails that are not in the account yet (domain rules, role rules, one email each) — the account
 * part of every invite. People already in the account come back in `existing` for the caller to add directly
 * (a board or workspace invite), and are never re-invited.
 */
export const inviteNewPeople = async (
  deps: Deps,
  ctx: AccountContext,
  actor: SessionUser,
  /** `sendEmail: false` = no emails, only the links to copy. */
  input: { emails: string[]; role: AccountRole; message?: string; sendEmail?: boolean } & InviteAccess,
) => {
  const { db } = deps;
  const settings = await loadSettings(db, ctx.accountId);
  const invited: ReturnType<typeof invitationDto>[] = [];
  const existing: { email: string; userId: string; role: AccountRole }[] = [];
  const errors: { email: string; code: string }[] = [];
  const fresh: string[] = [];
  for (const raw of new Set(input.emails.map((e) => e.trim().toLowerCase()))) {
    const userId = await findUserIdByEmail(db, raw);
    const member = userId ? await findMembership(db, ctx.accountId, userId) : undefined;
    if (member && userId) {
      if (member.status === 'active') existing.push({ email: raw, userId, role: member.role as AccountRole });
      else errors.push({ email: raw, code: 'already_member' }); // deactivated: reactivate in the users page
    } else fresh.push(raw);
  }
  if (fresh.length) {
    const may = canAccount(ctx.role, 'users.invite', settings.permissions);
    const roleDecision = canInviteRole(ctx.role, input.role, settings.permissions);
    // Remote support never brings new people in, whatever the screen (a board, workspace, doc or
    // dashboard share): an invitation would outlive the grant (S-51). People already in are still added.
    const refusal = ctx.support
      ? 'support_not_allowed'
      : !may.ok
        ? 'cannot_invite'
        : !roleDecision.ok
          ? roleDecision.reason
          : null;
    const payload = {
      ...(input.boardIds?.length ? { board_ids: input.boardIds } : {}),
      ...(input.workspaceIds?.length ? { workspace_ids: input.workspaceIds } : {}),
      // One level per object (S-62): a later invitation to the same address changes only its own objects' levels.
      ...(input.docIds?.length
        ? {
            doc_ids: input.docIds,
            doc_levels: Object.fromEntries(input.docIds.map((id) => [id, input.docLevel ?? 'viewer'])),
          }
        : {}),
      ...(input.dashboardIds?.length
        ? {
            dashboard_ids: input.dashboardIds,
            dashboard_levels: Object.fromEntries(
              input.dashboardIds.map((id) => [id, input.dashboardLevel ?? 'viewer']),
            ),
          }
        : {}),
    };
    for (const email of fresh) {
      const code = refusal ?? domainRefusal(settings, input.role, emailDomain(email));
      if (code) {
        errors.push({ email, code });
        continue;
      }
      let issued: Awaited<ReturnType<typeof issueInvitation>>;
      try {
        issued = await issueInvitation(deps, {
          account: ctx.account,
          email,
          role: input.role,
          invitedBy: actor.id,
          message: input.message,
          payload,
          sendEmail: input.sendEmail,
        });
      } catch (err) {
        // Over the hourly email budget / the plan's seats: the rest are reported, not sent; nothing at all sent →
        // the error itself (429 / 402).
        const code = err instanceof AppError ? err.code : null;
        if (
          (code !== 'rate_limited' && code !== 'plan_limit_reached' && code !== 'plan_feature_unavailable') ||
          !invited.length
        )
          throw err;
        errors.push({ email, code });
        continue;
      }
      const { invitation, emailed, url } = issued;
      invited.push(invitationDto(invitation, url));
      if (!emailed && input.sendEmail !== false) errors.push({ email, code: 'email_failed' });
    }
  }
  return { invited, existing, errors };
};

export const inviteUsers = async (
  deps: Deps,
  ctx: AccountContext,
  actor: SessionUser,
  input: z.infer<typeof inviteUsersSchema>,
) => {
  const { db } = deps;
  const settings = await loadSettings(db, ctx.accountId);
  if (!canAccount(ctx.role, 'users.invite', settings.permissions).ok) throw new AppError('forbidden', 'cannot_invite');
  const roleDecision = canInviteRole(ctx.role, input.role, settings.permissions);
  if (!roleDecision.ok) throw new AppError('forbidden', roleDecision.reason);

  // Inviting from a board (M7): the inviter may invite to it, and a guest only joins shareable boards (05 §4).
  const boardIds = [...new Set(input.board_ids ?? [])];
  // A board in a closed workspace: the invitee joins the workspace too, or the board stays out of sight (fix6).
  const workspaceIds = new Set<string>();
  for (const boardId of boardIds) {
    const access = await loadBoardAccess(db, ctx, actor, boardId);
    assertBoard(access, 'board.invite');
    if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
    if (input.role === 'guest' && access.board.kind !== 'shareable')
      throw new AppError('invalid_value', 'guest_needs_shareable_board');
    if (access.workspace.kind === 'closed' && input.role !== 'guest') workspaceIds.add(access.workspace.id);
  }

  const res = await inviteNewPeople(deps, ctx, actor, {
    emails: input.emails,
    role: input.role,
    message: input.message,
    sendEmail: input.send_email,
    boardIds,
    workspaceIds: [...workspaceIds],
  });
  return {
    invited: res.invited,
    errors: [...res.existing.map((e) => ({ email: e.email, code: 'already_member' })), ...res.errors],
  };
};

/** GET /users/invitations: open invitations (pending + expired) with status, inviter and email history. */
export const listAccountInvitations = async (db: Db, ctx: AccountContext) => {
  if (!canAccount(ctx.role, 'invitations.manage').ok) throw new AppError('forbidden', 'admin_only');
  return openInvitationsOf(db, ctx.accountId);
};

export const revokeAccountInvitation = async (
  db: Db,
  ctx: AccountContext,
  actor: SessionUser,
  id: string,
  meta?: RequestMeta,
) => {
  if (!canAccount(ctx.role, 'invitations.manage').ok) throw new AppError('forbidden', 'admin_only');
  await cancelInvitation(db, { accountId: ctx.accountId, id, actorId: actor.id, meta });
};

/** Public preview for the /invite/:token landing page. */
export const previewInvitation = async (db: Db, token: string) => {
  const inv = await findValidInvitationByToken(db, token);
  if (!inv) throw new AppError('invitation_invalid', 'Invitation is invalid or expired');
  // "Opened" in the invitations list: the first time the link's page loads.
  if (!inv.openedAt) await markInvitationOpened(db, inv.id);
  return {
    account: { name: inv.account.name, slug: inv.account.slug },
    email: inv.email,
    role: inv.role,
    expires_at: inv.expiresAt.toISOString(),
    password_min_length: await accountPasswordMin(db, inv.accountId),
  };
};

/**
 * The inviter hears that the invitation was accepted: bell + email by their notification settings
 * when the account's invitation setting says so and they are still an active member there (the owner console
 * sees it in its invitations list instead).
 */
const notifyInviter = async (tx: Db, inv: InvitationRow, user: SessionUser) => {
  if (!inv.invitedBy || inv.invitedBy === user.id) return;
  if (!(await invitationSettingsOf(tx, inv.accountId)).notify_inviter) return;
  const m = await findMembership(tx, inv.accountId, inv.invitedBy);
  if (m?.status !== 'active') return;
  await notifyUsers(
    tx,
    {
      accountId: inv.accountId,
      type: 'invitation_accepted',
      actorId: user.id,
      payload: { excerpt: inv.email, invitation: { id: inv.id, email: inv.email, role: inv.role } },
    },
    [inv.invitedBy],
  );
};

const accept = async (db: Db, user: SessionUser, inv: InvitationRow & { account: AccountRow }, meta: RequestMeta) => {
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError('invitation_email_mismatch', 'This invitation was sent to a different email');
  }
  if (!user.emailVerified) throw new AppError('forbidden', 'email_not_verified');
  // S-51: a platform owner never joins an account by an invitation he gave himself (owner console, a support
  // session, a board share…) — only as the account's own choice or under an active edit support grant.
  await assertMayJoinAccount(db, user.id, inv.accountId, inv);

  await db.transaction(async (tx) => {
    const existing = await findMembership(tx, inv.accountId, user.id);
    if (existing?.status === 'deactivated') throw new AppError('forbidden', 'Membership is deactivated');
    if (!existing) {
      const now = new Date();
      await insertMembership(tx, {
        id: newId(),
        accountId: inv.accountId,
        userId: user.id,
        role: inv.role,
        status: 'active',
        invitedBy: inv.invitedBy,
        invitedAt: inv.createdAt,
        joinedAt: now,
      });
    }
    // Boards the invitation came from (M7): subscribe — skipped when gone meanwhile.
    for (const boardId of (inv.payload as { board_ids?: string[] }).board_ids ?? []) {
      const board = await findBoard(tx, inv.accountId, boardId);
      if (!board || board.deletedAt) continue;
      if (inv.role === 'guest' && board.kind !== 'shareable') continue;
      await insertBoardMember(tx, { boardId, userId: user.id, accountId: inv.accountId, role: 'subscriber' });
      await recordEvent(tx, {
        accountId: inv.accountId,
        type: 'board.members_changed',
        actorId: user.id,
        boardId,
        before: null,
        after: { user_id: user.id, role: 'subscriber', via: 'invitation' },
      });
    }
    // Closed workspaces the invitation came from (fix6): join them — skipped when gone meanwhile; guests never
    // join a workspace (they see the shareable boards they subscribe to).
    for (const workspaceId of (inv.payload as { workspace_ids?: string[] }).workspace_ids ?? []) {
      if (inv.role === 'guest' || !(await findWorkspace(tx, inv.accountId, workspaceId))) continue;
      const added = await insertWorkspaceMember(tx, {
        id: newId(),
        accountId: inv.accountId,
        workspaceId,
        userId: user.id,
        role: 'member',
        addedBy: inv.invitedBy,
      });
      if (added)
        await recordEvent(tx, {
          accountId: inv.accountId,
          type: 'workspace.members_changed',
          actorId: user.id,
          before: null,
          after: { workspace_id: workspaceId, user_id: user.id, role: 'member', via: 'invitation' },
        });
    }
    // Docs the invitation came from (M8 ד3): join them at the level chosen — skipped when gone meanwhile; a
    // guest only on a shareable doc, and never as its owner.
    // The level is the one set on that doc (S-62: per object, never another doc's).
    const docLevels = levelsOf(inv.payload, 'doc');
    for (const [docId, asked] of Object.entries(docLevels)) {
      const doc = await findDoc(tx, inv.accountId, docId);
      if (!doc || doc.host !== 'workspace') continue;
      if (inv.role === 'guest' && doc.kind !== 'shareable') continue;
      let level: DocLevel = DOC_LEVELS.includes(asked as DocLevel) ? (asked as DocLevel) : 'viewer';
      if (inv.role === 'guest' && level === 'owner') level = 'editor';
      await insertDocMembers(tx, [
        { id: newId(), docId, accountId: inv.accountId, userId: user.id, level, addedBy: inv.invitedBy },
      ]);
      await recordEvent(tx, {
        accountId: inv.accountId,
        type: 'doc.members_changed',
        actorId: user.id,
        after: { id: docId, user_id: user.id, level, via: 'invitation' },
        meta: { doc_id: docId, access_changed: true },
      });
      if (inv.role === 'guest')
        await auditGuestShare(tx, {
          accountId: inv.accountId,
          actorId: inv.invitedBy,
          object: { type: 'doc', id: docId, name: doc.name },
          added: [{ userId: user.id, level }],
          via: 'invitation',
        });
    }
    // Dashboards the invitation came from: the same — a guest only on a shareable one, never its owner.
    for (const [dashboardId, asked] of Object.entries(levelsOf(inv.payload, 'dashboard'))) {
      const dashboard = await findDashboard(tx, inv.accountId, dashboardId);
      if (!dashboard) continue;
      if (inv.role === 'guest' && dashboard.kind !== 'shareable') continue;
      let level: DashboardLevel = DASHBOARD_LEVELS.includes(asked as DashboardLevel)
        ? (asked as DashboardLevel)
        : 'viewer';
      if (inv.role === 'guest' && level === 'owner') level = 'editor';
      await insertDashboardMembers(tx, [
        { id: newId(), dashboardId, accountId: inv.accountId, userId: user.id, level, addedBy: inv.invitedBy },
      ]);
      await recordEvent(tx, {
        accountId: inv.accountId,
        type: 'dashboard.members_changed',
        actorId: user.id,
        after: { id: dashboardId, user_id: user.id, level, via: 'invitation' },
        meta: { dashboard_id: dashboardId, access_changed: true },
      });
      if (inv.role === 'guest')
        await auditGuestShare(tx, {
          accountId: inv.accountId,
          actorId: inv.invitedBy,
          object: { type: 'dashboard', id: dashboardId, name: dashboard.name },
          added: [{ userId: user.id, level }],
          via: 'invitation',
        });
    }
    await markInvitationAccepted(tx, inv.id, user.id);
    await setLastAccountId(tx, user.id, inv.accountId);
    await recordAudit(tx, {
      accountId: inv.accountId,
      actorId: user.id,
      action: 'invitation.accepted',
      targetType: 'invitation',
      targetId: inv.id,
      payload: { role: inv.role, already_member: !!existing },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    if (!existing) await notifyInviter(tx, inv, user);
  });
  const membership = (await findMembership(db, inv.accountId, user.id))!;
  return { ...accountDto(inv.account), role: membership.role };
};

export const acceptInvitationByToken = async (db: Db, user: SessionUser, token: string, meta: RequestMeta) => {
  const inv = await findValidInvitationByToken(db, token);
  if (!inv) throw new AppError('invitation_invalid', 'Invitation is invalid or expired');
  return accept(db, user, inv, meta);
};

/** Invitations addressed to my (verified) email — shown in the account picker. */
export const listMyInvitations = async (db: Db, user: SessionUser) => {
  if (!user.emailVerified) return [];
  const rows = await listPendingInvitationsForEmail(db, user.email);
  // A platform owner does not see the ones he may not take (S-51) — accepting them would be refused.
  const owner = await isPlatformOwnerUser(db, user.id);
  const open = [];
  for (const r of rows)
    if (!owner || (await ownerMayJoin(db, user.id, r.invitation.accountId, r.invitation))) open.push(r);
  return open.map(({ invitation, account }) => ({
    ...invitationDto(invitation),
    account: { id: account.id, name: account.name, slug: account.slug },
  }));
};

export const acceptMyInvitation = async (db: Db, user: SessionUser, id: string, meta: RequestMeta) => {
  const match = (await listPendingInvitationsForEmail(db, user.email)).find((r) => r.invitation.id === id);
  if (!match) throw new AppError('invitation_invalid', 'Invitation is invalid or expired');
  return accept(db, user, { ...match.invitation, account: match.account }, meta);
};
