// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { BOARD_ROLES } from '../permissions/board';
import { SECRET_LIMITS } from '../columns/defs/secret';

/** The board permissions dialog (05 §4–6). */
export const PERMISSION_SETS = ['edit_everything', 'edit_content', 'edit_assigned', 'view_comment'] as const;
export const VIEW_ITEMS_MODES = ['all', 'assigned_or_created'] as const;

export const viewItemsSchema = z.object({
  mode: z.enum(VIEW_ITEMS_MODES),
  /** People columns (keys) that count as "assigned"; 'any_people' = every people column. */
  column_ids: z.union([z.array(z.string()), z.literal('any_people')]).default('any_people'),
});

/**
 * deleting (or archiving) an item or subitem on the board takes a fresh two-factor code — the same code
 * as secrets, counting `verify_minutes` (never past the account's ceiling). Off by default; a subitems board follows
 * its main board. Automations the board's people built still delete; the AI, agents and MCP do not.
 */
export const deleteGuardSchema = z.object({
  enabled: z.boolean().default(false),
  verify_minutes: z
    .number()
    .int()
    .min(SECRET_LIMITS.verifyMinutes.min)
    .max(SECRET_LIMITS.verifyMinutes.max)
    .default(SECRET_LIMITS.verifyMinutes.default),
});
export type DeleteGuard = z.infer<typeof deleteGuardSchema>;

/** A board's `settings.delete_guard` with the defaults filled in. */
export const deleteGuardOf = (boardSettings: unknown): DeleteGuard => {
  const parsed = deleteGuardSchema.safeParse((boardSettings as { delete_guard?: unknown } | null)?.delete_guard ?? {});
  return parsed.success ? parsed.data : deleteGuardSchema.parse({});
};

export const boardPermissionsSchema = z.object({
  permission_set: z.enum(PERMISSION_SETS),
  view_items: viewItemsSchema,
  delete_guard: deleteGuardSchema,
  members: z.array(
    z.object({
      user_id: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.enum(['owner', 'subscriber']),
      /** Explicit role (05 §4) — at most what the set gives; null = the set's. */
      level: z.enum(BOARD_ROLES).nullable(),
    }),
  ),
  /** Teams subscribed to the board: every team member gets the subscription. */
  teams: z.array(
    z.object({
      team_id: z.string(),
      name: z.string(),
      role: z.enum(['owner', 'subscriber']),
      level: z.enum(BOARD_ROLES).nullable(),
    }),
  ),
  /** Columns only owners — and the listed people and teams — may edit (`edit`) or see (`view`) (05 §6.1). */
  column_restrictions: z.array(
    z.object({
      column_id: z.string(),
      kind: z.enum(['edit', 'view']),
      users: z.array(z.string()),
      teams: z.array(z.string()),
    }),
  ),
  can_manage: z.boolean(),
  /** false: no owner can act (left the account, or an owning team is empty) — an admin may claim the board. */
  has_active_owner: z.boolean(),
});
export type BoardPermissions = z.infer<typeof boardPermissionsSchema>;

export const updateBoardPermissionsSchema = z.object({
  permission_set: z.enum(PERMISSION_SETS).optional(),
  view_items: viewItemsSchema.optional(),
  delete_guard: deleteGuardSchema.optional(),
});

export const boardMemberInputSchema = z.object({
  role: z.enum(['owner', 'subscriber']).default('subscriber'),
  level: z.enum(BOARD_ROLES).nullable().default(null),
});
export const columnRestrictionSchema = z.object({
  kind: z.enum(['edit', 'view']).nullable(),
  /** Besides board owners and admins (always allowed). */
  users: z.array(z.string()).max(200).default([]),
  teams: z.array(z.string()).max(100).default([]),
});
