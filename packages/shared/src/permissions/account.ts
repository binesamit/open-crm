// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Account-level capabilities (05-PERMISSIONS §2). Board/column/item rules come with the boards module (Phase 1);
 * this file covers what exists in Phase 0: reading the account, settings, users and invitations.
 */
export const accountRoleSchema = z.enum(['admin', 'member', 'viewer', 'guest']);
export type AccountRole = z.infer<typeof accountRoleSchema>;

/** `account.permissions` keys used so far, with the defaults from 05 §2 (✔ = true). */
export const accountPermissionsSchema = z.object({
  invite_members: z.boolean().default(false),
  invite_viewers: z.boolean().default(true),
  viewer_invite_viewers: z.boolean().default(false),
  invite_guests: z.boolean().default(true),
  /** Account viewers write Updates only when this is on (05 §2). */
  viewer_can_comment: z.boolean().default(false),
  /** Updates show who saw them and on which device ("seen by"); off = nothing is recorded or shown. */
  show_update_views: z.boolean().default(true),
  /** Boards show who opened them and how long ago ("viewed the board"); off = nothing is recorded or shown. */
  show_board_viewers: z.boolean().default(true),
  /**
   * the faces in a board's header are who opened it in the last this-many hours; everyone earlier is
   * in the list's "earlier" part (with when).
   */
  board_viewers_recent_hours: z.number().int().min(1).max(720).default(24),
  /** Account automation templates: admins save / edit / delete them; members too when this is on (all members use them). */
  members_manage_automation_templates: z.boolean().default(false),
  /**
   * Guests change a board's structure — its columns and groups — as far as the board's permission set lets its
   * subscribers. Off (the default): a guest edits items only.
   */
  guests_edit_structure: z.boolean().default(false),
});
export type AccountPermissions = z.infer<typeof accountPermissionsSchema>;
export const DEFAULT_ACCOUNT_PERMISSIONS: AccountPermissions = accountPermissionsSchema.parse({});

export type AccountAction =
  | 'account.read'
  | 'account.update'
  | 'users.read'
  | 'users.invite'
  | 'users.manage'
  | 'invitations.manage'
  | 'audit.read';

export type AccountDecision = { ok: true } | { ok: false; reason: string };

const allow: AccountDecision = { ok: true };
const deny = (reason: string): AccountDecision => ({ ok: false, reason });

/** Who may invite whom (05 §2: "מזמין members / viewers / guests"). Admins can invite any role. */
export const canInviteRole = (
  actorRole: AccountRole,
  inviteeRole: AccountRole,
  perms: AccountPermissions = DEFAULT_ACCOUNT_PERMISSIONS,
): AccountDecision => {
  if (actorRole === 'admin') return allow;
  if (actorRole === 'guest') return deny('guest_cannot_invite');
  if (inviteeRole === 'admin') return deny('admin_only');
  if (actorRole === 'member') {
    if (inviteeRole === 'member') return perms.invite_members ? allow : deny('perm.invite_members');
    if (inviteeRole === 'viewer') return perms.invite_viewers ? allow : deny('perm.invite_viewers');
    return perms.invite_guests ? allow : deny('perm.invite_guests');
  }
  // viewer
  if (inviteeRole === 'viewer') return perms.viewer_invite_viewers ? allow : deny('perm.viewer_invite_viewers');
  return deny('viewer_read_only');
};

export const canAccount = (
  role: AccountRole,
  action: AccountAction,
  perms: AccountPermissions = DEFAULT_ACCOUNT_PERMISSIONS,
): AccountDecision => {
  switch (action) {
    case 'account.read':
      return allow;
    case 'account.update':
    case 'users.manage':
    case 'invitations.manage':
    case 'audit.read':
      return role === 'admin' ? allow : deny('admin_only');
    case 'users.read':
      // Guests see only the people they share boards / items with — the list is filtered (D22.7).
      return allow;
    case 'users.invite':
      return role === 'admin' ||
        (role === 'member' && (perms.invite_members || perms.invite_viewers || perms.invite_guests)) ||
        (role === 'viewer' && perms.viewer_invite_viewers)
        ? allow
        : deny('cannot_invite');
  }
};
