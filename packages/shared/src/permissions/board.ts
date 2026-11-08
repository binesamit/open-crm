// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from './account';

/**
 * Board-level permissions (05-PERMISSIONS §4, §5, §10) for the actions that exist so far. Pure: the API loads a
 * BoardPermissionContext once per request and asks `canBoard`. Strictest rule wins; owners bypass the matrix.
 * Item-level visibility (view_items, §6) and column restrictions (§6.1) plug in here with the items epic.
 */
export type BoardKind = 'main' | 'shareable' | 'private';
export type PermissionSet = 'edit_everything' | 'edit_content' | 'edit_assigned' | 'view_comment';
/** Most to least: an explicit role (05 §4) only lowers what the permission set gives. */
export const BOARD_ROLES = ['editor', 'contributor', 'assigned_contributor', 'viewer'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const BOARD_ACTIONS = [
  'board.read',
  'board.update',
  'board.delete',
  'board.manage_permissions',
  'board.invite',
  'group.create',
  'group.update',
  'group.reorder',
  'group.delete',
  'column.create',
  'column.update',
  'column.reorder',
  'column.delete',
  'item.read',
  'item.create',
  'item.update',
  'item.move_group',
  'item.delete',
  /** Shared views (15 §3): create, and save settings to views one did not create. */
  'view.create',
  'view.update',
  /** Lock / unlock, set the default view, save to a locked view, delete other people's views. */
  'view.manage',
  /** Automations of the board (04 §8): see them and their runs; create / edit / switch them (M6). */
  'automation.read',
  'automation.manage',
  /** Outgoing webhooks of the board (06 §2.17): its owners and admins. */
  'webhook.manage',
] as const;
export type BoardAction = (typeof BOARD_ACTIONS)[number];

export type BoardPermissionContext = {
  accountRole: AccountRole;
  workspaceVisible: boolean;
  board: { kind: BoardKind; permissionSet: PermissionSet };
  /** null = not subscribed (personally or through a team). `level`: explicit role, null = the set's. */
  membership: { role: 'owner' | 'subscriber'; level?: BoardRole | null } | null;
  /**
   * the account lets guests change a board's structure (`permissions.guests_edit_structure`, off by
   * default). Read for guests only; absent = off.
   */
  guestStructure?: boolean;
};

export type BoardDecision = { ok: true; via: string } | { ok: false; reason: string; as404?: boolean };

const allow = (via: string): BoardDecision => ({ ok: true, via });
const deny = (reason: string, as404 = false): BoardDecision => ({ ok: false, reason, as404 });

const SET_ROLE: Record<PermissionSet, BoardRole> = {
  edit_everything: 'editor',
  edit_content: 'contributor',
  edit_assigned: 'assigned_contributor',
  view_comment: 'viewer',
};

/** Capability matrix (05 §5): true = ✔ (or ✔○ — overrides come with the permissions dialog). */
const MATRIX: Record<BoardRole, Partial<Record<BoardAction, boolean>>> = {
  editor: {
    'board.read': true,
    'board.invite': true,
    'group.create': true,
    'group.update': true,
    'group.reorder': true,
    'group.delete': true,
    'column.create': true,
    'column.update': true,
    'column.reorder': true,
    'column.delete': true,
    'item.read': true,
    'item.create': true,
    'item.update': true,
    'item.move_group': true,
    'item.delete': true,
    'view.create': true,
    'view.update': true,
    'automation.read': true,
    'automation.manage': true,
  },
  contributor: {
    'board.read': true,
    'board.invite': true,
    'item.read': true,
    'item.create': true,
    'item.update': true,
    'item.move_group': true,
    'item.delete': true,
    'view.create': true,
    'automation.read': true,
  },
  // Item mutations are further limited to assigned/created items in the items service (05 §10 step 4).
  assigned_contributor: {
    'board.read': true,
    'item.read': true,
    'item.create': true,
    'item.update': true,
    'item.move_group': true,
    'item.delete': true,
    'view.create': true,
    'automation.read': true,
  },
  viewer: { 'board.read': true, 'item.read': true, 'automation.read': true },
};

/** The lower of two roles; null = no limit. */
export const stricterRole = (a: BoardRole, b: BoardRole | null): BoardRole =>
  b && BOARD_ROLES.indexOf(b) > BOARD_ROLES.indexOf(a) ? b : a;

/** The more generous of two roles; null = no limit (wins). */
export const looserRole = (a: BoardRole | null, b: BoardRole | null): BoardRole | null =>
  a === null || b === null ? null : BOARD_ROLES.indexOf(a) < BOARD_ROLES.indexOf(b) ? a : b;

/** Whether the actor can see the board at all (05 §4). */
export const canAccessBoard = (ctx: BoardPermissionContext): boolean => {
  if (!ctx.workspaceVisible) return false;
  if (ctx.membership) return ctx.accountRole !== 'guest' || ctx.board.kind === 'shareable';
  if (ctx.accountRole === 'guest') return false;
  return ctx.board.kind === 'main';
};

export const effectiveBoardRole = (ctx: BoardPermissionContext): BoardRole | 'owner' => {
  if (ctx.membership?.role === 'owner' && ctx.accountRole !== 'viewer' && ctx.accountRole !== 'guest') return 'owner';
  if (ctx.accountRole === 'viewer') return 'viewer'; // strictest wins: account viewers are read-only everywhere
  return stricterRole(SET_ROLE[ctx.board.permissionSet], ctx.membership?.level ?? null);
};

const OWNER_OR_ADMIN_ONLY: BoardAction[] = [
  'board.update',
  'board.delete',
  'board.manage_permissions',
  'view.manage',
  'webhook.manage',
];

const GUEST_NEVER: BoardAction[] = ['automation.manage', 'board.invite'];

/**
 * The board's structure: its columns (add, settings — a connect-boards column's boards included
 * order, delete, convert) and its groups. A guest changes none of it, whatever the permission set gives the board's
 * subscribers, unless the account allows it (`guestStructure`). Board settings are owner-only anyway.
 */
export const STRUCTURE_ACTIONS: BoardAction[] = [
  'column.create',
  'column.update',
  'column.reorder',
  'column.delete',
  'group.create',
  'group.update',
  'group.reorder',
  'group.delete',
];

export const canBoard = (ctx: BoardPermissionContext, action: BoardAction): BoardDecision => {
  // Admins manage every board's metadata; content of private/shareable boards needs a subscription (05 §10 step 1).
  if (ctx.accountRole === 'admin') {
    if (ctx.board.kind !== 'main' && !ctx.membership && (action === 'item.read' || action.startsWith('item.'))) {
      return deny('admin_not_subscribed', true);
    }
    return allow('admin');
  }
  if (!canAccessBoard(ctx)) return deny('board_access', true);
  // Guests never create or edit automations and never invite (05 §2: perm.guest_automations ✘, "invites ✘ ever"),
  // whatever the board's permission set gives its subscribers.
  if (ctx.accountRole === 'guest' && GUEST_NEVER.includes(action)) return deny('guest_restricted');
  if (ctx.accountRole === 'guest' && !ctx.guestStructure && STRUCTURE_ACTIONS.includes(action))
    return deny('guest_structure');
  const role = effectiveBoardRole(ctx);
  if (role === 'owner') return allow('owner');
  if (OWNER_OR_ADMIN_ONLY.includes(action)) return deny('owner_only');
  return MATRIX[role][action] ? allow(role) : deny('role_ceiling');
};

/**
 * May the actor edit every item of the board — not only the ones assigned to them (`assigned_contributor`)? What a
 * delegate (an agent, AI-RT1) may get on a board is capped by this for its creator: an agent never edits items its
 * creator could not.
 */
export const canEditAllItems = (ctx: BoardPermissionContext): boolean => {
  if (!canBoard(ctx, 'item.update').ok) return false;
  if (ctx.accountRole === 'admin') return true;
  return effectiveBoardRole(ctx) !== 'assigned_contributor';
};

/** Map of every action → allowed, for the UI (`capabilities` in GET /boards/:id). */
export const boardCapabilities = (ctx: BoardPermissionContext): Record<BoardAction, boolean> =>
  Object.fromEntries(BOARD_ACTIONS.map((a) => [a, canBoard(ctx, a).ok])) as Record<BoardAction, boolean>;
