// SPDX-License-Identifier: AGPL-3.0-only
import { type AccountRole, AppError, type CreateAccountInput } from '@bines/shared';
import type { z } from 'zod';
import type { updatePlatformAccountSchema } from '@bines/shared';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import {
  type AccountRow,
  findAccountById,
  findAccountBySlug,
  findMembership,
  listAccountsWithStats,
  updateAccountRow,
} from '../accounts/accounts.repo';
import { provisionAccount } from '../accounts/accounts.service';
import {
  cancelInvitation,
  invitationDto,
  issueInvitation,
  openInvitationsOf,
  reissueInvitation,
} from '../invitations/invitations.service';
import { findInvitationInAccount } from '../invitations/invitations.repo';
import { diagnosticEmail } from '@bines/server-mail';
import { st } from '../../lib/i18n';
import { accountMailBrand, platformMailBrand } from './mail-brand';
import { smsSenderId } from './platform-settings';
import { FIRST_ADMIN_PAYLOAD, ownerMayTakeFirstAdmin } from '../support/support.access';
import { isPlatformOwnerEmail } from '../support/support.repo';
import { ownerSupportSessions } from '../support/support.service';
import { originOf } from '../me/me.service';

/**
 * Owner console (D12). Sees account metadata and counts only — never board data — and bypasses nothing
 * inside an account: to work in one, the owner needs a membership like anyone else.
 */
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>;

const platformDto = (
  row: Awaited<ReturnType<typeof listAccountsWithStats>>[number],
  support: Map<string, { grant_id: string; mode: 'view' | 'edit'; expires_at: string }> = new Map(),
) => ({
  id: row.account.id,
  name: row.account.name,
  slug: row.account.slug,
  status: row.account.status,
  created_at: row.account.createdAt.toISOString(),
  suspended_at: row.account.suspendedAt?.toISOString() ?? null,
  members: { admin: row.admin, member: row.member, viewer: row.viewer, guest: row.guest },
  pending_invitations: row.pendingInvitations,
  support: support.get(row.account.id) ?? null,
  deletion_due_at: row.account.deletionDueAt?.toISOString() ?? null,
  origin: originOf(row.account.origin),
});

const audit = (deps: Deps, account: AccountRow, owner: SessionUser, action: string, meta: RequestMeta, payload = {}) =>
  recordAudit(deps.db, {
    accountId: account.id,
    actorId: owner.id,
    action,
    targetType: 'account',
    targetId: account.id,
    payload: { ...payload, via: 'platform_owner' },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

const mustFind = async (deps: Deps, id: string) => {
  const account = await findAccountById(deps.db, id);
  if (!account) throw new AppError('not_found', 'Account not found');
  return account;
};

/** The account list, with my active support grant per account ("enter support" shows only while one is active). */
export const listPlatformAccounts = async (
  deps: Deps,
  owner: SessionUser,
  opts: { q?: string; status?: 'active' | 'suspended' },
) => {
  const support = await ownerSupportSessions(deps, owner);
  return (await listAccountsWithStats(deps.db, opts)).map((row) => platformDto(row, support));
};

export const createPlatformAccount = async (
  deps: Deps,
  owner: SessionUser,
  input: CreateAccountInput,
  meta: RequestMeta,
) => {
  const account = await deps.db.transaction((tx) =>
    provisionAccount(tx, {
      name: input.name,
      slug: input.slug,
      templateSet: input.template_set,
      timezone: input.timezone,
      currency: input.currency,
      createdBy: owner.id,
    }),
  );
  await audit(deps, account, owner, 'account.created', meta, { template_set: input.template_set });
  const { invitation, emailed, url } = await issueInvitation(deps, {
    account,
    email: input.first_admin_email,
    role: 'admin',
    invitedBy: owner.id,
    // The account's first admin (S-51): the owner's own address works only while the account is still empty.
    payload: FIRST_ADMIN_PAYLOAD,
    auditPayload: { via: 'platform_owner' },
  });
  const [row] = await listAccountsWithStats(deps.db, { id: account.id });
  return { account: platformDto(row!), invitation: invitationDto(invitation, url), emailed };
};

export const updatePlatformAccount = async (
  deps: Deps,
  owner: SessionUser,
  id: string,
  input: z.infer<typeof updatePlatformAccountSchema>,
  meta: RequestMeta,
) => {
  const account = await mustFind(deps, id);
  if (input.slug && input.slug !== account.slug && (await findAccountBySlug(deps.db, input.slug))) {
    throw new AppError('slug_taken', `Slug "${input.slug}" is taken`);
  }
  await updateAccountRow(deps.db, id, {
    ...(input.name ? { name: input.name } : {}),
    ...(input.slug ? { slug: input.slug } : {}),
  });
  await audit(deps, account, owner, 'account.renamed', meta, {
    from: { name: account.name, slug: account.slug },
    to: input,
  });
};

export const setAccountSuspended = async (
  deps: Deps,
  owner: SessionUser,
  id: string,
  suspended: boolean,
  reason: string | undefined,
  meta: RequestMeta,
) => {
  const account = await mustFind(deps, id);
  await updateAccountRow(
    deps.db,
    id,
    suspended ? { status: 'suspended', suspendedAt: new Date() } : { status: 'active', suspendedAt: null },
  );
  await audit(deps, account, owner, suspended ? 'account.suspended' : 'account.restored', meta, { reason });
};

export const deletePlatformAccount = async (
  deps: Deps,
  owner: SessionUser,
  id: string,
  confirmSlug: string,
  meta: RequestMeta,
) => {
  const account = await mustFind(deps, id);
  if (confirmSlug !== account.slug) throw new AppError('confirm_mismatch', 'Type the account slug to confirm');
  await updateAccountRow(deps.db, id, { deletedAt: new Date() });
  await audit(deps, account, owner, 'account.deleted', meta);
};

/**
 * Owner-only check that email (Resend) and SMS (TextMe) are wired in this environment. With `account_id`, the test
 * goes out as that account would send it (its sender name / SMS sender id); without, as the platform.
 */
export const sendDiagnostic = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'mailer' | 'sms' | 'logger'>,
  owner: SessionUser,
  input: { channel: 'email' | 'sms'; to: string; account_id?: string },
) => {
  const account = input.account_id ? await mustFind(deps, input.account_id) : null;
  const brand = account
    ? await accountMailBrand(deps, account, owner.locale)
    : await platformMailBrand(deps, owner.locale);
  try {
    if (input.channel === 'email') {
      await deps.mailer.send(diagnosticEmail({ to: input.to, brand }));
      return { ok: true as const, id: null };
    }
    const text = st('mail.diagnostic.text', { product: brand.product }, brand.locale);
    const { id } = await deps.sms.send({ to: input.to, text, senderId: await smsSenderId(deps.db, account?.id) });
    return { ok: true as const, id };
  } catch (err) {
    deps.logger.warn({ err, channel: input.channel }, 'diagnostic send failed');
    throw new AppError('unavailable', err instanceof Error ? err.message : 'send_failed');
  }
};

/**
 * The back-door rule (S-51), for every way the owner console hands out an invitation link: to the
 * owner's own address — or any platform owner's — only as an active admin of the account, or for the first-admin
 * invitation of an account nobody is in yet. Never by a support grant (no membership comes out of one).
 */
const assertNotOwnBackDoor = async (
  deps: Deps,
  owner: SessionUser,
  accountId: string,
  email: string,
  invitation?: { payload: unknown },
) => {
  const e = email.trim().toLowerCase();
  if (e !== owner.email.toLowerCase() && !(await isPlatformOwnerEmail(deps.db, e))) return;
  // A fresh link to the first-admin invitation of an account the owner created, while nobody is in it yet.
  if (invitation && (await ownerMayTakeFirstAdmin(deps.db, accountId, invitation))) return;
  const m = await findMembership(deps.db, accountId, owner.id);
  if (m?.status === 'active' && m.role === 'admin') return;
  throw new AppError('forbidden', 'support_grant_required', { emergency_available: false });
};

/**
 * POST /platform/accounts/{id}/invitations: the owner console invites anyone to an account — the first
 * admin or any other person, emailed or as a link to copy. Never a way in for the owner (assertNotOwnBackDoor).
 * Audited as the owner's (`via: 'platform_owner'`).
 */
export const platformInvite = async (
  deps: Deps,
  owner: SessionUser,
  id: string,
  input: { email: string; role?: AccountRole; send_email?: boolean },
) => {
  const account = await mustFind(deps, id);
  await assertNotOwnBackDoor(deps, owner, account.id, input.email);
  const { invitation, emailed, url } = await issueInvitation(deps, {
    account,
    email: input.email,
    role: input.role ?? 'admin',
    invitedBy: owner.id,
    sendEmail: input.send_email ?? true,
    auditPayload: { via: 'platform_owner' },
  });
  return { invitation: invitationDto(invitation, url), emailed };
};

/** POST /platform/accounts/{id}/invite-admin — the first (or another) admin; same rules as platformInvite. */
export const inviteAccountAdmin = (deps: Deps, owner: SessionUser, id: string, email: string) =>
  platformInvite(deps, owner, id, { email, role: 'admin' });

/** GET /platform/accounts/{id}/invitations — the account's open invitations (metadata: who, role, status). */
export const listPlatformInvitations = async (deps: Deps, id: string) => {
  const account = await mustFind(deps, id);
  return openInvitationsOf(deps.db, account.id);
};

const mustFindInvitation = async (deps: Deps, accountId: string, invitationId: string) => {
  const inv = await findInvitationInAccount(deps.db, accountId, invitationId);
  if (!inv || inv.acceptedAt || inv.revokedAt) throw new AppError('not_found', 'Invitation not found');
  return inv;
};

/**
 * POST /platform/accounts/{id}/invitations/{invitationId}/resend | /link — the same invitation, a fresh link (the
 * old one dies). A link to the owner's own address follows the back-door rule.
 */
export const platformResendInvitation = async (
  deps: Deps,
  owner: SessionUser,
  id: string,
  invitationId: string,
  opts: { linkOnly: boolean; expiresInDays?: number },
) => {
  const account = await mustFind(deps, id);
  const inv = await mustFindInvitation(deps, account.id, invitationId);
  await assertNotOwnBackDoor(deps, owner, account.id, inv.email, inv);
  const { invitation, emailed, url } = await reissueInvitation(deps, {
    account,
    invitation: inv,
    actorId: owner.id,
    linkOnly: opts.linkOnly,
    expiresInDays: opts.expiresInDays,
    auditPayload: { via: 'platform_owner' },
  });
  return { invitation: invitationDto(invitation, url), emailed };
};

/** DELETE /platform/accounts/{id}/invitations/{invitationId} — cancel: the link stops working at once; audited. */
export const platformCancelInvitation = async (
  deps: Deps,
  owner: SessionUser,
  id: string,
  invitationId: string,
  meta: RequestMeta,
) => {
  const account = await mustFind(deps, id);
  await mustFindInvitation(deps, account.id, invitationId);
  await cancelInvitation(deps.db, {
    accountId: account.id,
    id: invitationId,
    actorId: owner.id,
    auditPayload: { via: 'platform_owner' },
    meta,
  });
};
