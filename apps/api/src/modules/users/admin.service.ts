// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type BulkUsers,
  type BulkUsersResult,
  bulkUsersSchema,
  canAccount,
  columnTypes,
  deleteUserDetailsSchema,
  newId,
  parseCellValue,
  type TransferOwnership,
  type TransferResult,
  transferOwnershipSchema,
  type UpdateUser,
  updateUserSchema,
  formatInstantDate,
  toCsv,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AccountContext, AppDeps, SessionUser } from '../../types';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { accountRegion } from '../accounts/region';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { assertWithinLimit } from '../billing/entitlements';
import { invitationDto, reissueInvitation } from '../invitations/invitations.service';
import { findInvitationInAccount } from '../invitations/invitations.repo';
import { memberNames, upsertCell } from '../items/items.repo';
import { deleteMemberSubscriptions } from '../pwa/pwa.repo';
import { listTeamRows } from '../teams/teams.repo';
import {
  MEMBER_PROFILE_FIELDS,
  type MemberProfilePatch,
  type ProfilePatch,
  updateMemberProfile,
  updateUserProfile,
} from './users.repo';
import { listMembers } from './users.service';
import {
  activeElsewhere,
  anonymiseUser,
  assertMayTakeOverSignIn,
  mayTakeOverSignIn,
  namesManagedElsewhere,
  countActiveAdmins,
  deleteIdentitiesOf,
  deleteSessionsOf,
  demoteBoardOwner,
  disableOwnedAutomations,
  disableOwnedWebhooks,
  dropBoardOwnership,
  findMemberWithUser,
  moveAutomations,
  moveServiceTokens,
  moveWebhooks,
  ownedBoards,
  peopleCellsOf,
  revokePersonalTokens,
  setBoardRole,
  setMembership,
} from './admin.repo';
import { accountLocale, st } from '../../lib/i18n';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Administration → users (08 §3, account admin A2; decided 2026-10-04): change role, edit, deactivate / activate,
 * transfer ownership, delete details (anonymise), bulk, resend invitations, CSV. Admins only; the actor never
 * acts on themselves; the account always keeps an active admin. Every change → audit + activity.
 */
export type AdminActor = { ctx: AccountContext; user: SessionUser; requestId?: string };
type Deps = Pick<AppDeps, 'db' | 'storage' | 'mailer' | 'env' | 'logger'>;

export const ANON_EMAIL_DOMAIN = 'anon.invalid';

/** The member, or 404 — another account's people do not exist here (CLAUDE.md §7). */
const loadMember = async (db: Db, a: AdminActor, userId: string) => {
  const m = await findMemberWithUser(db, a.ctx.accountId, userId);
  if (!m) throw new AppError('not_found', 'User not found');
  return m;
};

const assertNotSelf = (a: AdminActor, userId: string, reason: string) => {
  if (userId === a.user.id) throw new AppError('forbidden', reason);
};

/** Removing an active admin (role change / deactivation) must leave another one. */
const assertKeepsAdmin = async (db: Db, a: AdminActor, m: { role: string; status: string }) => {
  if (m.role === 'admin' && m.status === 'active' && (await countActiveAdmins(db, a.ctx.accountId)) <= 1)
    throw new AppError('last_admin', 'The account must keep an active admin');
};

const audit = (db: Db, a: AdminActor, action: string, targetId: string, payload: Record<string, unknown>) =>
  recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action,
    targetType: 'user',
    targetId,
    payload,
  });

const event = (
  db: Db,
  a: AdminActor,
  type: string,
  e: {
    before?: unknown;
    after?: unknown;
    meta?: Record<string, unknown>;
    batchId?: string | null;
    boardId?: string | null;
  },
) =>
  recordEvent(db, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: e.boardId ?? null,
    batchId: e.batchId ?? null,
    before: e.before,
    after: e.after,
    meta: e.meta,
  });

const memberDto = async (deps: Deps, a: AdminActor, userId: string) => {
  const list = await listMembers(deps, a.ctx, a.user);
  const found = list.find((m) => m.user_id === userId);
  if (!found) throw new AppError('not_found', 'User not found');
  return found;
};

/** The change itself (no answer body) — shared by PATCH /users/:id and the bulk role change. */
const applyUpdate = async (db: Db, a: AdminActor, userId: string, input: UpdateUser) => {
  const m = await loadMember(db, a, userId);
  const roleChange = input.role && input.role !== m.membership.role ? input.role : undefined;
  if (roleChange) {
    assertNotSelf(a, userId, 'own_role');
    // Plans: a guest made a member takes a seat.
    if (m.membership.role === 'guest' && m.membership.status !== 'deactivated') {
      await assertWithinLimit(db, a.ctx.accountId, 'seats', 1);
    }
    if (m.membership.role === 'admin') await assertKeepsAdmin(db, a, m.membership);
  }
  // The name is the person's own (every account); job title, department and phone are theirs in THIS account
  // only (Fix: ) — what an admin of this account edits here never reaches the person's other accounts.
  const patch: ProfilePatch = {};
  if (input.name !== undefined && input.name !== '' && input.name !== m.user.name) patch.name = input.name;
  // S-63: the name shows in every account the person opens, so an admin of this one changes it only when it shows
  // nowhere else (your own name is always yours to change).
  if (
    patch.name !== undefined &&
    userId !== a.user.id &&
    (await namesManagedElsewhere(db, a.ctx.accountId, [userId])).size
  )
    throw new AppError('conflict', 'name_managed_elsewhere');
  const memberPatch: MemberProfilePatch = {};
  for (const k of MEMBER_PROFILE_FIELDS) {
    const v = input[k] === '' ? null : input[k];
    if (v !== undefined && v !== m.membership[k]) memberPatch[k] = v;
  }
  if (!roleChange && !Object.keys(patch).length && !Object.keys(memberPatch).length) return;
  await db.transaction(async (tx) => {
    if (roleChange) await setMembership(tx, a.ctx.accountId, userId, { role: roleChange });
    if (Object.keys(patch).length) await updateUserProfile(tx, userId, patch);
    if (Object.keys(memberPatch).length) await updateMemberProfile(tx, a.ctx.accountId, userId, memberPatch);
    const was = { ...m.user, ...m.membership } as Record<string, unknown>;
    const before = {
      ...(roleChange ? { role: m.membership.role } : {}),
      ...Object.fromEntries([...Object.keys(patch), ...Object.keys(memberPatch)].map((k) => [k, was[k]])),
    };
    const after = { ...(roleChange ? { role: roleChange } : {}), ...patch, ...memberPatch };
    await event(tx, a, 'user.updated', { before, after, meta: { user_id: userId } });
    await audit(tx, a, roleChange ? 'user.role_changed' : 'user.updated', userId, { before, after });
  });
};

/** PATCH /users/:id — role, name, job title, department, phone. Never your own role; never the last admin. */
export const updateUser = async (deps: Deps, a: AdminActor, userId: string, raw: UpdateUser) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  await applyUpdate(deps.db, a, userId, updateUserSchema.parse(raw));
  return memberDto(deps, a, userId);
};

/**
 * Moves what `from` owns in this account to `to` (08 §3.2): boards they own, automations they own, webhooks and
 * service tokens they created, and — when asked — their people-column assignments. Runs inside `tx`; one batch.
 */
const transferIn = async (tx: Db, a: AdminActor, fromId: string, input: TransferOwnership): Promise<TransferResult> => {
  const { to_user_id: toId } = input;
  const scope = new Set(input.scope);
  if (toId === fromId) throw new AppError('invalid_value', 'same_user');
  const to = await findMemberWithUser(tx, a.ctx.accountId, toId);
  // The new owner is an active member who can own things (not a viewer or guest).
  if (!to || to.membership.status !== 'active') throw new AppError('invalid_value', 'transfer_target_inactive');
  if (to.membership.role !== 'admin' && to.membership.role !== 'member')
    throw new AppError('invalid_value', 'transfer_target_role');

  const batchId = newId();
  const result: TransferResult = {
    boards: 0,
    automations: 0,
    webhooks: 0,
    service_tokens: 0,
    assignments: 0,
    batch_id: batchId,
  };
  const meta = { from_user_id: fromId, to_user_id: toId, via: 'transfer_ownership' };

  if (scope.has('boards')) {
    for (const { boardId } of await ownedBoards(tx, a.ctx.accountId, fromId)) {
      await setBoardRole(tx, a.ctx.accountId, boardId, toId, 'owner', a.user.id);
      await demoteBoardOwner(tx, a.ctx.accountId, boardId, fromId);
      await event(tx, a, 'board.members_changed', {
        boardId,
        batchId,
        before: { user_id: fromId, role: 'owner' },
        after: { user_id: toId, role: 'owner' },
        meta,
      });
      result.boards++;
    }
  }
  if (scope.has('automations')) {
    for (const r of await moveAutomations(tx, a.ctx.accountId, fromId, toId)) {
      await event(tx, a, 'automation.owner_changed', {
        boardId: r.boardId,
        batchId,
        before: { owner_id: fromId },
        after: { owner_id: toId },
        meta: { ...meta, automation_id: r.id },
      });
      result.automations++;
    }
  }
  if (scope.has('webhooks')) {
    for (const r of await moveWebhooks(tx, a.ctx.accountId, fromId, toId)) {
      await event(tx, a, 'webhook.owner_changed', {
        boardId: r.boardId,
        batchId,
        before: { created_by: fromId },
        after: { created_by: toId },
        meta: { ...meta, webhook_id: r.id },
      });
      result.webhooks++;
    }
  }
  if (scope.has('service_tokens')) {
    for (const r of await moveServiceTokens(tx, a.ctx.accountId, fromId, toId)) {
      await event(tx, a, 'token.owner_changed', {
        batchId,
        before: { created_by: fromId },
        after: { created_by: toId },
        meta: { ...meta, token_id: r.id, name: r.name },
      });
      result.service_tokens++;
    }
  }
  if (scope.has('assignments')) {
    const def = columnTypes.get('people')!;
    const found = await peopleCellsOf(tx, a.ctx.accountId, fromId);
    const allIds = new Set<string>([toId]);
    for (const c of found)
      for (const p of (c.value as { persons_and_teams?: { id: string; kind: string }[] }).persons_and_teams ?? [])
        if (p.kind === 'person') allIds.add(p.id);
    const names = await memberNames(tx, a.ctx.accountId, [...allIds]);
    const teamNames = new Map((await listTeamRows(tx, a.ctx.accountId)).map((t) => [t.id, t.name]));
    for (const c of found) {
      const before = c.value as { persons_and_teams: { id: string; kind: 'person' | 'team' }[] };
      const seen = new Set<string>();
      const next = before.persons_and_teams
        .map((p) => (p.kind === 'person' && p.id === fromId ? { id: toId, kind: 'person' as const } : p))
        .filter((p) => {
          const key = `${p.kind}:${p.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      // Re-validated like any write, except the column's max: a swap never adds people.
      const parsed = parseCellValue(
        def,
        { ...(c.settings as Record<string, unknown>), max_people: 0 },
        { persons_and_teams: next },
        {
          userName: (id) => names.get(id) ?? teamNames.get(id),
        },
      );
      if (!parsed.ok) continue;
      await upsertCell(tx, {
        itemId: c.itemId,
        columnId: c.columnId,
        accountId: a.ctx.accountId,
        boardId: c.boardId,
        value: parsed.value as Record<string, unknown>,
        textValue: parsed.derived.textValue,
        numberValue: parsed.derived.numberValue,
        dateValue: parsed.derived.dateValue,
        dateEndValue: parsed.derived.dateEndValue,
        updatedBy: a.user.id,
        updatedByType: 'user',
      });
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'cell.changed',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: c.boardId,
        itemId: c.itemId,
        columnId: c.columnId,
        batchId,
        before: { value: before },
        after: { value: parsed.value },
        meta: { column_key: c.columnKey, column_type: 'people', ...meta },
      });
      result.assignments++;
    }
  }
  const moved = result.boards + result.automations + result.webhooks + result.service_tokens + result.assignments;
  if (!moved) return { ...result, batch_id: null };
  await event(tx, a, 'user.ownership_transferred', {
    batchId,
    after: { ...result, batch_id: undefined },
    meta: { ...meta, scope: [...scope] },
  });
  await audit(tx, a, 'user.ownership_transferred', fromId, { to_user_id: toId, scope: [...scope], ...result });
  return result;
};

/** POST /users/:id/transfer-ownership */
export const transferOwnership = async (deps: Deps, a: AdminActor, userId: string, raw: TransferOwnership) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  const input = transferOwnershipSchema.parse(raw);
  await loadMember(deps.db, a, userId);
  return deps.db.transaction((tx) => transferIn(tx, a, userId, input));
};

/**
 * Deactivation (08 §3.2): the membership is off (no sign-in to this account), personal tokens are revoked,
 * automations / webhooks still owned are switched off with `owner_deactivated`, push devices in this account removed. Sessions are global (D12): they end
 * only when the person has no other active account. Optionally transfers first, in the same transaction.
 */
const deactivateIn = async (tx: Db, a: AdminActor, userId: string, transfer?: TransferOwnership) => {
  assertNotSelf(a, userId, 'own_membership');
  const m = await loadMember(tx, a, userId);
  if (m.membership.status === 'deactivated') return null;
  await assertKeepsAdmin(tx, a, m.membership);
  const transferred = transfer ? await transferIn(tx, a, userId, transferOwnershipSchema.parse(transfer)) : null;
  await setMembership(tx, a.ctx.accountId, userId, {
    status: 'deactivated',
    deactivatedAt: new Date(),
    deactivatedBy: a.user.id,
  });
  const tokens = await revokePersonalTokens(tx, a.ctx.accountId, userId);
  const autos = await disableOwnedAutomations(tx, a.ctx.accountId, userId);
  const hooks = await disableOwnedWebhooks(tx, a.ctx.accountId, userId);
  // Push to their phones in this account stops now (PWA), even while their session lives on for other accounts.
  const devices = await deleteMemberSubscriptions(tx, a.ctx.accountId, userId);
  // Not someone whose sign-in opens more than this account (the platform owner, another account, support work — S-52).
  const signedOut = (await mayTakeOverSignIn(tx, a.ctx.accountId, userId)).ok;
  if (signedOut) await deleteSessionsOf(tx, userId);
  const summary = {
    tokens_revoked: tokens.length,
    automations_disabled: autos.length,
    webhooks_disabled: hooks.length,
    push_devices_removed: devices,
    sessions_ended: signedOut,
  };
  await event(tx, a, 'user.deactivated', {
    before: { status: m.membership.status },
    after: { status: 'deactivated' },
    meta: { user_id: userId, ...summary },
  });
  await audit(tx, a, 'user.deactivated', userId, summary);
  return transferred;
};

export const deactivateUser = async (
  deps: Deps,
  a: AdminActor,
  userId: string,
  body: { transfer?: TransferOwnership } = {},
) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  const transferred = await deps.db.transaction((tx) => deactivateIn(tx, a, userId, body.transfer));
  return { user: await memberDto(deps, a, userId), transfer: transferred };
};

const activateIn = async (tx: Db, a: AdminActor, userId: string) => {
  const m = await loadMember(tx, a, userId);
  if (m.membership.status === 'active') return;
  if (m.user.email.endsWith(`@${ANON_EMAIL_DOMAIN}`)) throw new AppError('conflict', 'anonymised');
  // Plans: back in = a seat again (guests take none).
  if (m.membership.role !== 'guest') await assertWithinLimit(tx, a.ctx.accountId, 'seats', 1);
  await setMembership(tx, a.ctx.accountId, userId, { status: 'active', deactivatedAt: null, deactivatedBy: null });
  await event(tx, a, 'user.activated', {
    before: { status: m.membership.status },
    after: { status: 'active' },
    meta: { user_id: userId },
  });
  await audit(tx, a, 'user.activated', userId, {});
};

/** POST /users/:id/activate — back in; switched-off automations stay off until someone turns them on. */
export const activateUser = async (deps: Deps, a: AdminActor, userId: string) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  await deps.db.transaction((tx) => activateIn(tx, a, userId));
  return memberDto(deps, a, userId);
};

/**
 * DELETE /users/:id/details (08 §3.2) — only after deactivation, irreversible: email → deleted+<ulid>@anon.invalid,
 * name → "משתמש שנמחק" (or the first name), photo / phone / title / department cleared, sign-ins removed. Content
 * stays under the same user id; board ownership ends. Refused while the person is active in another account.
 */
export const deleteUserDetails = async (
  deps: Deps,
  a: AdminActor,
  userId: string,
  raw: z.input<typeof deleteUserDetailsSchema> = {},
) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  const input = deleteUserDetailsSchema.parse(raw);
  const { db } = deps;
  assertNotSelf(a, userId, 'own_membership');
  const m = await loadMember(db, a, userId);
  if (m.membership.status !== 'deactivated') throw new AppError('not_deactivated', 'Deactivate the user first');
  if (m.user.isPlatformOwner) throw new AppError('forbidden', 'platform_owner');
  if (await activeElsewhere(db, a.ctx.accountId, userId))
    throw new AppError('user_active_elsewhere', 'The user is active in another account');
  // S-52: wiping their sign-ins also ends support work / a grant / an invitation elsewhere — never from here.
  await assertMayTakeOverSignIn(db, a.ctx.accountId, userId);
  const first = m.user.name.trim().split(/\s+/)[0];
  const name =
    input.display === 'first_name' && first
      ? first
      : st('server.deletedUser', undefined, await accountLocale(deps.db, a.ctx.accountId));
  await db.transaction(async (tx) => {
    await anonymiseUser(tx, userId, `deleted+${newId().toLowerCase()}@${ANON_EMAIL_DOMAIN}`, name);
    await deleteIdentitiesOf(tx, userId);
    await deleteSessionsOf(tx, userId);
    const boards = await dropBoardOwnership(tx, a.ctx.accountId, userId);
    // No personal data in the event: only that it happened.
    await event(tx, a, 'user.anonymised', { meta: { user_id: userId, boards_released: boards.length } });
    await audit(tx, a, 'user.anonymised', userId, { display: input.display, boards_released: boards.length });
  });
  return memberDto(deps, a, userId);
};

/**
 * POST /users/invitations/:id/resend — the same invitation emailed again with a fresh link (the old one stops
 * working; id, inviter, role and boards kept). `linkOnly` (POST …/link, fix8): the fresh link comes back
 * to copy — sent by WhatsApp etc. when email fails — and nothing is emailed. `expiresInDays` = the new link's
 * lifetime (default: the account's invitation setting).
 */
export const resendInvitation = async (
  deps: Deps,
  a: AdminActor,
  invitationId: string,
  linkOnly = false,
  expiresInDays?: number,
) => {
  const decision = canAccount(a.ctx.role, 'invitations.manage');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  const inv = await findInvitationInAccount(deps.db, a.ctx.accountId, invitationId);
  if (!inv) throw new AppError('not_found', 'Invitation not found');
  const { invitation, emailed, url } = await reissueInvitation(deps, {
    account: a.ctx.account,
    invitation: inv,
    actorId: a.user.id,
    linkOnly,
    expiresInDays,
  });
  await recordEvent(deps.db, {
    accountId: a.ctx.accountId,
    type: linkOnly ? 'invitation.link_copied' : 'invitation.resent',
    actorId: a.user.id,
    requestId: a.requestId,
    meta: { invitation_id: invitation.id, role: inv.role },
  });
  return { invitation: invitationDto(invitation, url), emailed };
};

/** POST /users/bulk — one op on ≤200 people (never yourself); what cannot be done is reported, not thrown. */
export const bulkUsers = async (deps: Deps, a: AdminActor, raw: BulkUsers): Promise<BulkUsersResult> => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  const input = bulkUsersSchema.parse(raw);
  const skipped: BulkUsersResult['skipped'] = [];
  let done = 0;
  for (const id of [...new Set(input.ids)]) {
    try {
      if (input.op === 'resend') {
        await resendInvitation(deps, a, id);
      } else if (id === a.user.id) {
        throw new AppError('forbidden', 'self');
      } else if (input.op === 'set_role') {
        await applyUpdate(deps.db, a, id, { role: input.role });
      } else if (input.op === 'deactivate') {
        await deps.db.transaction((tx) => deactivateIn(tx, a, id));
      } else {
        await deps.db.transaction((tx) => activateIn(tx, a, id));
      }
      done++;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ id, code: err.code === 'forbidden' ? err.message : err.code });
    }
  }
  return { done, skipped };
};

/** GET /users/export.csv — the people of the account, one row each (headers in the reader's language, BOM for Excel). */
export const usersCsv = async (deps: Deps, a: AdminActor) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  const [rows, region] = await Promise.all([
    listMembers(deps, a.ctx, a.user),
    accountRegion(deps.db, a.ctx.accountId, a.user),
  ]);
  const day = (iso: string | null | undefined) => (iso ? formatInstantDate(iso, {}, region) : '');
  const lang = region.language;
  const h = (k: string) => st(`server.csv.users.${k}`, undefined, lang);
  return toCsv(
    ['name', 'email', 'role', 'status', 'title', 'department', 'phone', 'teams', 'joined', 'lastSeen'].map(h),
    rows.map((m) => [
      m.name,
      m.email,
      st(`role.${m.role}`, undefined, lang),
      st(`adminUsers.status.${m.status}`, undefined, lang),
      m.title,
      m.department,
      m.phone,
      (m.teams ?? []).map((t) => t.name).join(', '),
      day(m.joined_at),
      day(m.last_seen_at),
    ]),
  );
};

// ---- the account's default "transfer to" person (settings.default_transfer_user_id) ----
const SETTING = 'default_transfer_user_id';

export const getDefaultTransferUser = async (db: Db, a: AdminActor) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  const settings = await getAccountSettings(db, a.ctx.accountId);
  const id = (settings as Record<string, unknown>)[SETTING];
  return { user_id: typeof id === 'string' ? id : null };
};

export const setDefaultTransferUser = async (db: Db, a: AdminActor, userId: string | null) => {
  assertAccountAdmin(a.ctx, { action: 'users.manage' });
  if (userId) {
    const m = await findMemberWithUser(db, a.ctx.accountId, userId);
    if (!m || m.membership.status !== 'active' || (m.membership.role !== 'admin' && m.membership.role !== 'member'))
      throw new AppError('invalid_value', 'transfer_target_role');
  }
  await db.transaction(async (tx) => {
    const settings = await getAccountSettings(tx, a.ctx.accountId);
    const before = (settings as Record<string, unknown>)[SETTING] ?? null;
    await upsertAccountSettings(tx, a.ctx.accountId, { ...settings, [SETTING]: userId }, a.user.id);
    await event(tx, a, 'account.updated', { before: { [SETTING]: before }, after: { [SETTING]: userId } });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'account.updated',
      targetType: 'account',
      targetId: a.ctx.accountId,
      payload: { settings: [SETTING], before, after: userId },
    });
  });
  return { user_id: userId };
};
