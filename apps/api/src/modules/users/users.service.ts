// SPDX-License-Identifier: AGPL-3.0-only
import { erasureRequestedAt } from './erasure-request';
import {
  AppError,
  canAccount,
  type ListUsersQuery,
  type MemberDto,
  type Profile,
  type UpdateProfile,
  updateProfileSchema,
} from '@bines/shared';
import { type FileStorage, imageLink, isInlineSafeMime } from '../../lib/storage';
import type { AccountContext, AppDeps, SessionUser, Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { ownUploadedAssets, releaseAssets } from '../files/files.service';
import { lastSeen, memberTeams, namesManagedElsewhere } from './admin.repo';
import { guestPeople } from './guest-people';
import {
  listAccountMembers,
  MEMBER_PROFILE_FIELDS,
  memberProfile,
  type MemberProfilePatch,
  type ProfilePatch,
  setUserAvatar,
  updateMemberProfile,
  updateUserProfile,
  userAvatar,
  userAvatarAsset,
  userProfile,
} from './users.repo';

const AVATAR_TTL = 60 * 60;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Photos only as raster images (S-14: never SVG — it can carry script). */
export const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** An uploaded photo wins (short-lived inline link, files only via presigned URLs — CLAUDE.md §10). */
export const avatarUrl = async (
  storage: FileStorage,
  row:
    | { image: string | null; avatarKey: string | null; avatarName: string | null; avatarMime?: string | null }
    | undefined,
) => {
  if (row?.avatarKey) {
    // A photo saved before S-14 may be an SVG: then it downloads instead of rendering from the storage origin.
    return imageLink(storage, row.avatarKey, row.avatarName ?? 'avatar', {
      inline: isInlineSafeMime(row.avatarMime ?? ''),
      ttl: AVATAR_TTL,
    });
  }
  return row?.image ?? null;
};

/**
 * GET /users — the account's people (any status; service identities are not people). Filters: role, status, team,
 * name / email search. Admins also see when each person was last seen.
 */
export const listMembers = async (
  deps: Pick<AppDeps, 'db' | 'storage'>,
  ctx: AccountContext,
  user: SessionUser,
  q: ListUsersQuery = {},
): Promise<MemberDto[]> => {
  const decision = canAccount(ctx.role, 'users.read');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  let rows = await listAccountMembers(deps.db, ctx.accountId);
  // A guest sees only the people they share boards and items with (D22.7).
  if (ctx.role === 'guest') {
    const people = await guestPeople(deps.db, { ctx, user });
    rows = rows.filter((m) => people.has(m.userId));
  }
  const teams = await memberTeams(deps.db, ctx.accountId);
  if (q.role) rows = rows.filter((m) => m.role === q.role);
  if (q.status) rows = rows.filter((m) => m.status === q.status);
  if (q.team_id) rows = rows.filter((m) => teams.get(m.userId)?.some((t) => t.id === q.team_id));
  if (q.q) {
    const needle = q.q.toLowerCase();
    rows = rows.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(needle));
  }
  const seen =
    ctx.role === 'admin'
      ? await lastSeen(
          deps.db,
          rows.map((m) => m.userId),
        )
      : null;
  // S-63: whose name an admin here may not change (it shows in other accounts too) — admins only.
  const managed =
    ctx.role === 'admin'
      ? await namesManagedElsewhere(
          deps.db,
          ctx.accountId,
          rows.map((m) => m.userId),
        )
      : null;
  // A guest gets a name, a face and an address to pick from — not the phone, department, title or teams of the
  // people they share an item with (audit 2026-10-10 security #17).
  const guest = ctx.role === 'guest';
  return Promise.all(
    rows.map(async (m) => ({
      user_id: m.userId,
      email: m.email,
      name: m.name,
      role: m.role,
      status: m.status,
      joined_at: m.joinedAt?.toISOString() ?? null,
      avatar_url: await avatarUrl(deps.storage, m),
      title: guest ? null : m.title,
      phone: guest ? null : m.phone,
      department: guest ? null : m.department,
      teams: guest ? [] : (teams.get(m.userId) ?? []),
      last_seen_at: seen ? (seen.get(m.userId)?.toISOString() ?? null) : null,
      deactivated_at: m.deactivatedAt?.toISOString() ?? null,
      anonymised: m.email.endsWith('@anon.invalid'),
      erasure_requested_at: ctx.role === 'admin' ? erasureRequestedAt(m.settings) : null,
      two_factor_enabled: seen ? m.twoFactorEnabled : null,
      name_managed_elsewhere: managed ? managed.has(m.userId) && m.userId !== user.id : null,
    })),
  );
};

export const myAvatarUrl = async (deps: Pick<AppDeps, 'db' | 'storage'>, userId: string) =>
  avatarUrl(deps.storage, await userAvatar(deps.db, userId));

/**
 * Sets the profile photo from one of my finished uploads (PNG / JPEG / WebP, ≤5 MB). The photo is the user's, in
 * every account. The photo it replaces leaves storage (R2) once nothing else holds it.
 */
export const setMyAvatar = async (
  deps: Pick<AppDeps, 'db' | 'storage'> & Partial<Pick<AppDeps, 'logger'>>,
  a: Actor,
  fileId: string,
) => {
  const [asset] = await ownUploadedAssets(deps.db, a, [fileId]);
  if (!AVATAR_MIMES.has(asset!.mime.toLowerCase())) throw new AppError('invalid_value', 'avatar_not_image');
  if (asset!.size > MAX_AVATAR_BYTES) throw new AppError('payload_too_large', 'avatar_too_large');
  const previous = await userAvatarAsset(deps.db, a.user.id);
  await deps.db.transaction(async (tx) => {
    await setUserAvatar(tx, a.user.id, asset!.id);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'user.avatar_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { asset_id: asset!.id },
    });
  });
  if (previous && previous.id !== asset!.id) await releaseAssets(deps, previous.accountId, [previous.id]);
  return { avatar_url: await myAvatarUrl(deps, a.user.id) };
};

export const removeMyAvatar = async (
  deps: Pick<AppDeps, 'db' | 'storage'> & Partial<Pick<AppDeps, 'logger'>>,
  a: Actor,
) => {
  const previous = await userAvatarAsset(deps.db, a.user.id);
  await deps.db.transaction(async (tx) => {
    await setUserAvatar(tx, a.user.id, null);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'user.avatar_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { asset_id: null },
    });
  });
  if (previous) await releaseAssets(deps, previous.accountId, [previous.id]);
  return { avatar_url: await myAvatarUrl(deps, a.user.id) };
};

/**
 * GET /users/me — my profile (fix2): the personal fields (the same everywhere) and, since Fix: , who I am in
 * THIS account (the `X-Account-Id` one): job title, department, work phone.
 */
export const myProfile = async (deps: Pick<AppDeps, 'db' | 'storage'>, a: Actor): Promise<Profile> => {
  const row = await userProfile(deps.db, a.user.id);
  if (!row) throw new AppError('not_found', 'User not found');
  const member = (await memberProfile(deps.db, a.ctx.accountId, a.user.id)) ?? {
    title: null,
    department: null,
    phone: null,
  };
  const { marketingOptInAt, ...personal } = row;
  return {
    ...personal,
    ...member,
    marketing_opt_in: !!marketingOptInAt,
    account: { id: a.ctx.accountId, name: a.ctx.account.name },
    avatar_url: await myAvatarUrl(deps, a.user.id),
  };
};

/**
 * PATCH /users/me — my name, birthday, language and time zone (everywhere), and my job title, department and phone
 * in this account only (Fix: ). Only my own profile (the path names no one else); a service identity has
 * none. One `user.profile_updated` event with what changed (`meta.account_fields` names the per-account ones).
 */
export const updateMyProfile = async (
  deps: Pick<AppDeps, 'db' | 'storage'>,
  a: Actor,
  raw: UpdateProfile,
): Promise<Profile> => {
  const decision = canAccount(a.ctx.role, 'users.read');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  const input = updateProfileSchema.parse(raw);
  const before = await userProfile(deps.db, a.user.id);
  if (!before) throw new AppError('not_found', 'User not found');
  const beforeMember = await memberProfile(deps.db, a.ctx.accountId, a.user.id);
  if (!beforeMember) throw new AppError('not_found', 'User not found');
  const patch: ProfilePatch = {};
  for (const k of ['name', 'birthday', 'locale', 'timezone'] as const) {
    const v = input[k] === '' ? null : input[k];
    if (v !== undefined && v !== before[k]) (patch as Record<string, unknown>)[k] = v;
  }
  // The platform's marketing email: agreeing keeps the date; withdrawing clears it.
  if (input.marketing_opt_in !== undefined && input.marketing_opt_in !== !!before.marketingOptInAt)
    patch.marketingOptInAt = input.marketing_opt_in ? new Date() : null;
  const memberPatch: MemberProfilePatch = {};
  for (const k of MEMBER_PROFILE_FIELDS) {
    const v = input[k] === '' ? null : input[k];
    if (v !== undefined && v !== beforeMember[k]) memberPatch[k] = v;
  }
  const changed = [...Object.keys(patch), ...Object.keys(memberPatch)];
  if (changed.length) {
    const was = { ...before, ...beforeMember } as Record<string, unknown>;
    await deps.db.transaction(async (tx) => {
      if (Object.keys(patch).length) await updateUserProfile(tx, a.user.id, patch);
      if (Object.keys(memberPatch).length) await updateMemberProfile(tx, a.ctx.accountId, a.user.id, memberPatch);
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'user.profile_updated',
        actorId: a.user.id,
        requestId: a.requestId,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: { ...patch, ...memberPatch },
        ...(Object.keys(memberPatch).length ? { meta: { account_fields: Object.keys(memberPatch) } } : {}),
      });
    });
  }
  return myProfile(deps, a);
};
