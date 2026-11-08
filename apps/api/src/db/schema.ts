// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bines OS Platform — Drizzle schema (PostgreSQL 18, drizzle-orm 0.3x pg-core, >= 0.36 for array-style index callbacks).
 * Source of truth: docs/02-DATA-MODEL.md. Keep the two in sync — change the doc first.
 *
 * Conventions
 * - All primary keys are ULIDs (varchar(26)) generated in the service layer (`ulid()`).
 * - Every tenant-scoped table carries `account_id`.
 * - `position` columns are LexoRank strings.
 * - CHECK constraints, expression indexes, partitioning (activity_log) and RLS policies live in hand-written
 *   SQL migrations (see comments marked `SQL:`), because drizzle-kit does not model them.
 */
import { relations, sql, type SQL } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  pgSequence,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  date,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const accountMemberRoleEnum = pgEnum('account_member_role', ['admin', 'member', 'viewer', 'guest']);
export const memberStatusEnum = pgEnum('member_status', ['invited', 'active', 'deactivated']);
export const accountStatusEnum = pgEnum('account_status', ['active', 'suspended']);
export const workspaceKindEnum = pgEnum('workspace_kind', ['open', 'closed']);
export const workspaceMemberRoleEnum = pgEnum('workspace_member_role', ['owner', 'member']);
export const boardKindEnum = pgEnum('board_kind', ['main', 'shareable', 'private']);
export const boardPermissionSetEnum = pgEnum('board_permission_set', [
  'edit_everything',
  'edit_content',
  'edit_assigned',
  'view_comment',
]);
export const boardViewItemsEnum = pgEnum('board_view_items', ['all', 'assigned_or_created', 'by_filter']);
export const boardMemberRoleEnum = pgEnum('board_member_role', ['owner', 'subscriber']);
/** An explicit board role for a subscriber (05 §4): a ceiling under the permission set, never above it. */
export const boardRoleEnum = pgEnum('board_role', ['editor', 'contributor', 'assigned_contributor', 'viewer']);
export const groupColorEnum = pgEnum('group_color', [
  'blue',
  'green',
  'forest',
  'lime',
  'orange',
  'red',
  'purple',
  'light_gray',
  'azure',
  'violet',
  'yellow',
  'orange_red',
  'salmon',
  'crimson',
  'pink',
  'turquoise',
  'navy',
  'brown',
  'gray',
  // 0083 (pal40): every palette key.
  'gold',
  'sage',
  'slate',
  'plum',
  'rust',
  'amber_deep',
  'olive_deep',
  'moss',
  'emerald_deep',
  'teal_deep',
  'ocean',
  'midnight',
  'grape',
  'magenta_deep',
  'wine',
  'maroon',
  'rose',
  'peach',
  'apricot',
  'sky_soft',
  'iris',
  'lilac',
  'orchid',
  'blush',
  'taupe',
  'stone',
  'graphite',
  'steel',
]);
export const viewTypeEnum = pgEnum('view_type', [
  'table',
  'kanban',
  'calendar',
  'timeline',
  'gantt',
  'form',
  'cards',
  'workload',
  'chart',
  'files',
  'map',
  'extension',
  'dashboard',
]);
export const viewVisibilityEnum = pgEnum('view_visibility', ['shared', 'private']);
export const automationRunStatusEnum = pgEnum('automation_run_status', [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
]);
export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', ['pending', 'delivered', 'failed', 'dead']);
export const actorTypeEnum = pgEnum('actor_type', [
  'user',
  'automation',
  'api',
  'system',
  'form',
  'email',
  'agent',
  'document',
]);
export const assetKindEnum = pgEnum('asset_kind', ['file', 'link', 'doc']);
export const trashObjectTypeEnum = pgEnum('trash_object_type', [
  'workspace',
  'folder',
  'board',
  'group',
  'item',
  'column',
  'view',
  'update',
  'asset',
  'automation',
  'form',
  'doc',
  'dashboard',
  // a file removed from a files cell (with its versions).
  'file',
]);
/** M8 ד1: a doc in the sidebar, or a doc inside a `doc` cell (ד2). */
export const docHostEnum = pgEnum('doc_host', ['workspace', 'cell']);
export const docMemberLevelEnum = pgEnum('doc_member_level', ['owner', 'editor', 'commenter', 'viewer']);
/** M8 ד4: who is invited to a dashboard — its owners edit and share it, editors edit it, viewers look. */
export const dashboardMemberLevelEnum = pgEnum('dashboard_member_level', ['owner', 'editor', 'viewer']);
export const templateKindEnum = pgEnum('template_kind', ['board', 'workspace']);
export const notificationChannelEnum = pgEnum('notification_channel', ['in_app', 'email', 'push']);
export const updateSourceEnum = pgEnum('update_source', [
  'user',
  'email',
  'automation',
  'api',
  'form',
  'sms',
  'document',
]);

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------
const ulid = (name: string) => varchar(name, { length: 26 });
const pk = () => ulid('id').primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const emptyJson = sql`'{}'::jsonb`;
const emptyArray = sql`'[]'::jsonb`;
/** Binary (a doc's Yjs state). Read back as a Uint8Array by node-postgres and PGlite alike. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });
/** Full-text search vector (agent knowledge, מ9) — always generated by Postgres, never written. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** JSON shapes referenced by $type<>; the real Zod schemas live in packages/shared. */
export type RestrictionList = { users: string[]; teams: string[] };
export type JsonObject = Record<string, unknown>;
export type JsonArray = unknown[];

// ---------------------------------------------------------------------------
// Account, users, membership, teams
// ---------------------------------------------------------------------------
export const accounts = pgTable('accounts', {
  id: pk(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  logoAssetId: ulid('logo_asset_id').references((): AnyPgColumn => assets.id, { onDelete: 'set null' }),
  /** Unused and not read: plans live in `account_subscriptions`; kept for old rows. */
  plan: varchar('plan', { length: 32 }).notNull().default('self_hosted'),
  /** D12 — suspended accounts answer every scoped request with 423. */
  status: accountStatusEnum('status').notNull().default('active'),
  suspendedAt: ts('suspended_at'),
  createdBy: ulid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: ts('deleted_at'),
  /**
   * the account's deletion was scheduled (by `deletion_requested_by`) — locked like a closed account
   * until `deletion_due_at`, when the worker purges it for good. Null = not scheduled (cancelling clears them).
   */
  deletionScheduledAt: ts('deletion_scheduled_at'),
  deletionDueAt: ts('deletion_due_at'),
  deletionRequestedBy: ulid('deletion_requested_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /** `{reminded: [7, 1], purge: {started_at, users, emailed}}` — reminders sent and the purge's resumable state. */
  deletionState: jsonb('deletion_state').$type<JsonObject>().notNull().default(emptyJson),
  /** Who opened the account (D32): `owner` (owner console, the default), `setup` (first run), `signup` (self sign-up). */
  origin: varchar('origin', { length: 16 }).notNull().default('owner'),
});

/** Better Auth `user` model (modelName: "users") + our additional fields. */
export const users = pgTable(
  'users',
  {
    id: pk(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: varchar('name', { length: 120 }).notNull(),
    image: text('image'),
    avatarAssetId: ulid('avatar_asset_id').references((): AnyPgColumn => assets.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 120 }),
    phone: varchar('phone', { length: 32 }),
    /** Profile (fix2): free-text department / team and an optional birthday (YYYY-MM-DD). */
    department: varchar('department', { length: 120 }),
    birthday: date('birthday', { mode: 'string' }),
    locale: varchar('locale', { length: 8 }).notNull().default('he'),
    /** The member's own IANA zone; null = never chosen → the account's (`settings.locale.timezone`, A3). */
    timezone: varchar('timezone', { length: 64 }),
    /** D12 — owner console access (create/suspend accounts). Grants no access to data inside accounts. */
    isPlatformOwner: boolean('is_platform_owner').notNull().default(false),
    isSupportStaff: boolean('is_support_staff').notNull().default(false),
    /** A service identity behind service API tokens (06 §1.2: "שירות: <name>"); it never signs in. */
    isService: boolean('is_service').notNull().default(false),
    /** Better Auth twoFactor plugin (M8 ד12): set once the authenticator app is verified. */
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    lastSeenAt: ts('last_seen_at'),
    /** Agreed to the platform's marketing email (a separate unticked box); null = no / withdrawn. */
    marketingOptInAt: ts('marketing_opt_in_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ux_users_email').on(sql`lower(${t.email})`)],
);

// ---------------------------------------------------------------------------
// Better Auth (authentication only — no organization plugin; account membership is ours, D12).
// Property names follow Better Auth's field names; the adapter maps { user, session, account, verification }.
// ---------------------------------------------------------------------------
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: pk(),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    /** password / magic_link / google / microsoft; null = made before this was recorded. */
    signInMethod: varchar('sign_in_method', { length: 32 }),
    /** S-72: the organisation of a provider sign-in — Google's `hd` / Microsoft's `tid`; null = none / not a provider. */
    signInOrg: varchar('sign_in_org', { length: 200 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ix_auth_sessions_user').on(t.userId)],
);

/** Better Auth "account" model = a login identity (credential password, Google …), not a tenant. */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: pk(),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Better Auth field `accountId` = the provider's account id (Google sub, or user id for credentials). */
    accountId: varchar('provider_account_id', { length: 255 }).notNull(),
    providerId: varchar('provider_id', { length: 32 }).notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ix_auth_identities_user').on(t.userId),
    uniqueIndex('ux_auth_identities_provider').on(t.providerId, t.accountId),
  ],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: pk(),
    identifier: varchar('identifier', { length: 255 }).notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ix_auth_verifications_identifier').on(t.identifier)],
);

/**
 * Better Auth `twoFactor` model (M8 ד12): one row per person with an authenticator app. The secret and the backup
 * codes are encrypted by Better Auth with BETTER_AUTH_SECRET; `verified` = the first code was entered.
 */
export const authTwoFactors = pgTable(
  'auth_two_factors',
  {
    id: pk(),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_auth_two_factors_user').on(t.userId)],
);

/**
 * Pending invitations to an account (08 §3.1). The membership row is created on accept; the raw token is only
 * ever in the email link — we store its SHA-256.
 */
export const accountInvitations = pgTable(
  'account_invitations',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: accountMemberRoleEnum('role').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    /** { board_ids?: string[] } — boards to subscribe the invitee to on accepting (M7) */
    payload: jsonb('payload').$type<JsonObject>().notNull().default(emptyJson),
    invitedBy: ulid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    acceptedBy: ulid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts('revoked_at'),
    /** Who cancelled it. */
    revokedBy: ulid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    /** The email: when it last went out, by whom, how many times, and whether the last one was sent. */
    lastSentAt: ts('last_sent_at'),
    lastSentBy: ulid('last_sent_by').references(() => users.id, { onDelete: 'set null' }),
    sendCount: integer('send_count').notNull().default(0),
    /** 'sent' | 'failed' (null = never emailed: a copied link). */
    emailStatus: varchar('email_status', { length: 16 }),
    /** First time the link was opened (the public preview). */
    openedAt: ts('opened_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_invitations_account_pending')
      .on(t.accountId)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index('ix_invitations_email').on(sql`lower(${t.email})`),
  ],
);

export const accountMembers = pgTable(
  'account_members',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: accountMemberRoleEnum('role').notNull().default('member'),
    status: memberStatusEnum('status').notNull().default('invited'),
    invitedBy: ulid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    invitedAt: ts('invited_at'),
    joinedAt: ts('joined_at'),
    deactivatedAt: ts('deactivated_at'),
    deactivatedBy: ulid('deactivated_by').references(() => users.id, { onDelete: 'set null' }),
    /** The member's own preferences in this account (My Work customization, M4). */
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    /**
     * Fix: ("in one account he is a manager, in the other only a consultant"): who the person is in
     * THIS account — job title, department, work phone. Edited by the person and by the account's admins; personal
     * fields (name, photo, birthday, language, time zone) stay on `users`. `users.title/phone/department` are no
     * longer read (moved here by 0041).
     */
    title: varchar('title', { length: 120 }),
    department: varchar('department', { length: 120 }),
    phone: varchar('phone', { length: 32 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_account_members_account_user').on(t.accountId, t.userId),
    index('ix_account_members_user').on(t.userId),
    index('ix_account_members_account_role')
      .on(t.accountId, t.role)
      .where(sql`${t.deactivatedAt} is null`),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    color: varchar('color', { length: 32 }),
    parentTeamId: ulid('parent_team_id').references((): AnyPgColumn => teams.id, { onDelete: 'set null' }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_teams_account_name')
      .on(t.accountId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: ulid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    isLead: boolean('is_lead').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index('ix_team_members_user').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Workspaces, folders, boards
// ---------------------------------------------------------------------------
export const workspaces = pgTable(
  'workspaces',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    kind: workspaceKindEnum('kind').notNull().default('open'),
    icon: varchar('icon', { length: 64 }),
    color: varchar('color', { length: 32 }),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    position: text('position').notNull(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_workspaces_account')
      .on(t.accountId, t.position)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// SQL: CHECK ((user_id IS NOT NULL) <> (team_id IS NOT NULL))
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    workspaceId: ulid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    teamId: ulid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    role: workspaceMemberRoleEnum('role').notNull().default('member'),
    addedBy: ulid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_workspace_members_user').on(t.workspaceId, t.userId),
    uniqueIndex('ux_workspace_members_team').on(t.workspaceId, t.teamId),
  ],
);

// SQL: CHECK (depth BETWEEN 0 AND 2)
export const folders = pgTable(
  'folders',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    workspaceId: ulid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    parentFolderId: ulid('parent_folder_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull().default(0),
    name: varchar('name', { length: 120 }).notNull(),
    color: varchar('color', { length: 32 }),
    position: text('position').notNull(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_folders_workspace_parent')
      .on(t.workspaceId, t.parentFolderId, t.position)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// SQL: CHECK (hierarchy_depth_max BETWEEN 1 AND 6)
export const boards = pgTable(
  'boards',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    workspaceId: ulid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    folderId: ulid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    /** Set on a sub-board (D14): the board whose items its items are subitems of. Hidden from lists. */
    parentBoardId: ulid('parent_board_id').references((): AnyPgColumn => boards.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    kind: boardKindEnum('kind').notNull().default('main'),
    position: text('position').notNull(),
    itemTerminology: varchar('item_terminology', { length: 40 }).notNull().default('item'),
    hierarchyDepthMax: integer('hierarchy_depth_max').notNull().default(5),
    permissionSet: boardPermissionSetEnum('permission_set').notNull().default('edit_everything'),
    viewItems: boardViewItemsEnum('view_items').notNull().default('all'),
    /** ViewItemsConfig: { column_ids?: string[] | 'any_people', rules?: VisibilityRule[] } — 05-PERMISSIONS §6. */
    viewItemsConfig: jsonb('view_items_config').$type<JsonObject>().notNull().default(emptyJson),
    assigneeColumnId: ulid('assignee_column_id').references((): AnyPgColumn => columns.id, { onDelete: 'set null' }),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    createdFromTemplateId: ulid('created_from_template_id').references((): AnyPgColumn => templates.id, {
      onDelete: 'set null',
    }),
    sourceBoardId: bigint('source_board_id', { mode: 'number' }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    archivedBy: ulid('archived_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_boards_workspace_folder')
      .on(t.workspaceId, t.folderId, t.position)
      .where(sql`${t.deletedAt} is null`),
    index('ix_boards_account_kind')
      .on(t.accountId, t.kind)
      .where(sql`${t.deletedAt} is null`),
    index('ix_boards_name_trgm').using('gin', t.name.op('gin_trgm_ops')),
    uniqueIndex('ux_boards_source')
      .on(t.accountId, t.sourceBoardId)
      .where(sql`${t.sourceBoardId} is not null`),
    // One sub-board per board (D14).
    uniqueIndex('ux_boards_parent')
      .on(t.parentBoardId)
      .where(sql`${t.parentBoardId} is not null`),
  ],
);

export const boardMembers = pgTable(
  'board_members',
  {
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: boardMemberRoleEnum('role').notNull().default('subscriber'),
    /** null = what the permission set gives. */
    level: boardRoleEnum('level'),
    addedBy: ulid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] }), index('ix_board_members_user').on(t.userId)],
);

export const boardTeamMembers = pgTable(
  'board_team_members',
  {
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    teamId: ulid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: boardMemberRoleEnum('role').notNull().default('subscriber'),
    /** null = what the permission set gives. */
    level: boardRoleEnum('level'),
    addedBy: ulid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.teamId] })],
);

export const groups = pgTable(
  'groups',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    color: groupColorEnum('color').notNull().default('blue'),
    position: text('position').notNull(),
    sourceGroupId: varchar('source_group_id', { length: 64 }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    archivedBy: ulid('archived_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_groups_board_position')
      .on(t.boardId, t.position)
      .where(sql`${t.deletedAt} is null and ${t.archivedAt} is null`),
  ],
);

// SQL: CHECK (key ~ '^[a-z][a-z0-9_]{0,49}$'); CHECK (NOT (restricted_edit IS NOT NULL AND restricted_view IS NOT NULL))
export const columns = pgTable(
  'columns',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 50 }).notNull(),
    type: varchar('type', { length: 32 }).notNull(), // registry key, see 03-COLUMN-TYPES.md
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    position: text('position').notNull(),
    width: integer('width').notNull().default(140),
    restrictedEdit: jsonb('restricted_edit').$type<RestrictionList>(),
    restrictedView: jsonb('restricted_view').$type<RestrictionList>(),
    rollupFunction: varchar('rollup_function', { length: 16 }),
    isRequired: boolean('is_required').notNull().default(false),
    sourceColumnId: varchar('source_column_id', { length: 64 }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    /** D28: a background type conversion runs on the column — cell edits wait (423 `column_converting`). */
    convertingId: ulid('converting_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    // Intentionally NOT partial: a deleted column's key stays reserved (it is never reused on the board).
    uniqueIndex('ux_columns_board_key').on(t.boardId, t.key),
    index('ix_columns_board_position')
      .on(t.boardId, t.position)
      .where(sql`${t.deletedAt} is null`),
    index('ix_columns_type').on(t.accountId, t.type),
  ],
);

// SQL: CHECK ((depth = 0 AND group_id IS NOT NULL AND parent_item_id IS NULL) OR (depth > 0 AND parent_item_id IS NOT NULL AND group_id IS NULL));
//      CHECK (depth BETWEEN 0 AND 5)
export const items = pgTable(
  'items',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    groupId: ulid('group_id').references(() => groups.id, { onDelete: 'restrict' }),
    parentItemId: ulid('parent_item_id').references((): AnyPgColumn => items.id, { onDelete: 'cascade' }),
    rootItemId: ulid('root_item_id').references((): AnyPgColumn => items.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull().default(0),
    position: text('position').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    keySeq: integer('key_seq'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    creatorType: actorTypeEnum('creator_type').notNull().default('user'),
    lastCellChangeAt: ts('last_cell_change_at'),
    lastCellChangeBy: ulid('last_cell_change_by').references(() => users.id, { onDelete: 'set null' }),
    childCount: integer('child_count').notNull().default(0),
    sourceItemId: bigint('source_item_id', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    archivedBy: ulid('archived_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_items_board_group_position')
      .on(t.boardId, t.groupId, t.position)
      .where(sql`${t.deletedAt} is null and ${t.depth} = 0`),
    index('ix_items_parent_position')
      .on(t.parentItemId, t.position)
      .where(sql`${t.deletedAt} is null`),
    index('ix_items_root')
      .on(t.rootItemId)
      .where(sql`${t.rootItemId} is not null`),
    index('ix_items_board_deleted').on(t.boardId, t.deletedAt),
    index('ix_items_name_trgm').using('gin', t.name.op('gin_trgm_ops')),
    index('ix_items_created_by').on(t.accountId, t.createdBy),
    uniqueIndex('ux_items_board_key_seq')
      .on(t.boardId, t.keySeq)
      .where(sql`${t.keySeq} is not null`),
    uniqueIndex('ux_items_source')
      .on(t.accountId, t.sourceItemId)
      .where(sql`${t.sourceItemId} is not null`),
  ],
);

/** One row per (item, column) that has a value. Absence of a row == empty cell. */
export const cells = pgTable(
  'cells',
  {
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    value: jsonb('value').$type<JsonObject>().notNull(),
    // Denormalized sort/search keys, computed by the column-type registry in the service layer.
    textValue: text('text_value'),
    numberValue: doublePrecision('number_value'),
    dateValue: ts('date_value'),
    dateEndValue: ts('date_end_value'),
    updatedAt: updatedAt(),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedByType: actorTypeEnum('updated_by_type').notNull().default('user'),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.columnId] }),
    index('ix_cells_board').on(t.boardId),
    index('ix_cells_column_number').on(t.columnId, t.numberValue),
    index('ix_cells_column_date').on(t.columnId, t.dateValue),
    // The text's first 200 characters only: a btree entry holds at most ~2.7 KB, and a long text cell is longer
    // (prod 2026-10-10: "index row size 3792 exceeds btree version 4 maximum 2704" on every save of such a cell).
    index('ix_cells_column_text').on(t.columnId, sql`left(${t.textValue}, 200)`),
    index('ix_cells_column_updated').on(t.columnId, t.updatedAt),
    index('ix_cells_value_gin').using('gin', t.value.op('jsonb_path_ops')),
    index('ix_cells_text_trgm').using('gin', t.textValue.op('gin_trgm_ops')),
  ],
);

/** Directed links for board_relation / dependency columns. Two-way pairs are written as two rows. */
export const itemLinks = pgTable(
  'item_links',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    fromItemId: ulid('from_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    toItemId: ulid('to_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
    /** dependency links (M8 ד7): `{kind: 'FS'|'SS'|'FF'|'SF', lag_days}`; '{}' = FS, no lag / a relation. */
    meta: jsonb('meta').$type<JsonObject>().notNull().default(emptyJson),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_item_links_col_from_to').on(t.columnId, t.fromItemId, t.toItemId),
    index('ix_item_links_to').on(t.toItemId, t.columnId),
    index('ix_item_links_from').on(t.fromItemId),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }), // null = account-wide
    name: varchar('name', { length: 60 }).notNull(),
    color: varchar('color', { length: 32 }).notNull().default('blue'),
    usageCount: integer('usage_count').notNull().default(0),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_tags_scope_name')
      .on(t.accountId, sql`coalesce(${t.boardId}, '')`, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    index('ix_tags_name_trgm').using('gin', t.name.op('gin_trgm_ops')),
  ],
);

export const itemTags = pgTable(
  'item_tags',
  {
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    tagId: ulid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.columnId, t.tagId] }), index('ix_item_tags_tag').on(t.tagId)],
);

export const timeEntrySourceEnum = pgEnum('time_entry_source', ['timer', 'manual', 'automation', 'import']);

/**
 * Time tracking (03 §3.3): one row per session — the truth behind a `time_tracking` cell, whose value is a cache
 * rewritten in the same transaction. A user may run any number of timers, but one per cell (partial unique index).
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    durationS: integer('duration_s').generatedAlwaysAs(
      (): SQL => sql`(extract(epoch from (ended_at - started_at)))::int`,
    ),
    source: timeEntrySourceEnum('source').notNull().default('timer'),
    note: text('note'),
    billable: boolean('billable').notNull().default(true),
    editedBy: ulid('edited_by').references(() => users.id, { onDelete: 'set null' }),
    editedAt: ts('edited_at'),
    /** An import: the source time-tracking entry (re-runs update instead of duplicating). */
    sourceEntryId: bigint('source_entry_id', { mode: 'number' }),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_time_entries_source')
      .on(t.accountId, t.sourceEntryId)
      .where(sql`${t.sourceEntryId} is not null`),
    index('ix_time_entries_item').on(t.itemId, t.columnId, t.startedAt),
    index('ix_time_entries_board_started').on(t.boardId, t.startedAt),
    index('ix_time_entries_user_started').on(t.accountId, t.userId, t.startedAt),
    uniqueIndex('ux_time_entries_running_cell')
      .on(t.itemId, t.columnId, t.userId)
      .where(sql`${t.endedAt} is null and ${t.deletedAt} is null`),
  ],
);

/**
 * Item-number sequences (item_id column, display custom_key), one per board. A non-empty prefix is unique per
 * account; an empty prefix (just the number: 1, 2, …) can be on any number of boards.
 */
export const itemKeys = pgTable(
  'item_keys',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    prefix: varchar('prefix', { length: 12 }).notNull(),
    padding: integer('padding').notNull().default(3),
    nextSeq: integer('next_seq').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_item_keys_account_prefix')
      .on(t.accountId, t.prefix)
      .where(sql`${t.prefix} <> ''`),
    index('ix_item_keys_board').on(t.boardId),
    uniqueIndex('ux_item_keys_column').on(t.columnId),
  ],
);

// ---------------------------------------------------------------------------
// Updates & files
// ---------------------------------------------------------------------------
export const updates = pgTable(
  'updates',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    parentUpdateId: ulid('parent_update_id').references((): AnyPgColumn => updates.id, { onDelete: 'cascade' }),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),
    /** The editor's document (ProseMirror JSON) for rich updates — what editing reopens; null = plain text. */
    bodyJson: jsonb('body_json').$type<JsonObject>(),
    source: updateSourceEnum('source').notNull().default('user'),
    /** Details of where the update came from: `{sms: {to, column_id, provider_id}}` for an SMS sent from the item. */
    meta: jsonb('meta').$type<JsonObject>(),
    statusColumnId: ulid('status_column_id').references(() => columns.id, { onDelete: 'set null' }),
    statusLabelId: integer('status_label_id'),
    isPinned: boolean('is_pinned').notNull().default(false),
    /**
     * A secret update: the text lives encrypted in `secret_update_bodies`; body_html / body_text stay
     * empty and body_json null here, so no generic path (search, exports, notifications, AI, automations) sees it.
     */
    isSecret: boolean('is_secret').notNull().default(false),
    emailMessageId: varchar('email_message_id', { length: 255 }),
    /** An import: the source update / reply (re-runs update instead of duplicating). */
    sourceUpdateId: bigint('source_update_id', { mode: 'number' }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_updates_item_created')
      .on(t.itemId, t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    index('ix_updates_parent').on(t.parentUpdateId),
    index('ix_updates_board_created').on(t.boardId, t.createdAt.desc()),
    index('ix_updates_body_trgm').using('gin', t.bodyText.op('gin_trgm_ops')),
    uniqueIndex('ux_updates_source')
      .on(t.accountId, t.sourceUpdateId)
      .where(sql`${t.sourceUpdateId} is not null`),
    uniqueIndex('ux_updates_email_msg')
      .on(t.accountId, t.emailMessageId)
      .where(sql`${t.emailMessageId} is not null`),
  ],
);

export const updateMentions = pgTable(
  'update_mentions',
  {
    id: pk(),
    updateId: ulid('update_id')
      .notNull()
      .references(() => updates.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    teamId: ulid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    mentionEveryone: boolean('mention_everyone').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_update_mentions_user').on(t.updateId, t.userId),
    uniqueIndex('ux_update_mentions_team').on(t.updateId, t.teamId),
    index('ix_update_mentions_user').on(t.userId, t.createdAt),
  ],
);

export const updateLikes = pgTable(
  'update_likes',
  {
    updateId: ulid('update_id')
      .notNull()
      .references(() => updates.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    reaction: varchar('reaction', { length: 16 }).notNull().default('like'),
    createdAt: createdAt(),
  },
  // One row per user per reaction: a user may react with several emoji (M1.1 #14).
  (t) => [primaryKey({ columns: [t.updateId, t.userId, t.reaction] })],
);

/**
 * "Seen by" (the eye on an update): who saw an update or reply on screen, and on which kind of device.
 * One row per user per device class; the client reports what became visible, the device comes from the request
 * headers. The author's own views are never stored.
 */
export const updateViews = pgTable(
  'update_views',
  {
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    updateId: ulid('update_id')
      .notNull()
      .references(() => updates.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** desktop | mobile | tablet (UPDATE_VIEW_DEVICES). */
    device: varchar('device', { length: 8 }).notNull(),
    /** Browser and OS ("Chrome · Windows") — never the full User-Agent string. */
    userAgent: varchar('user_agent', { length: 64 }).notNull().default(''),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.updateId, t.userId, t.device] }),
    index('ix_update_views_account_user').on(t.accountId, t.userId),
  ],
);

/**
 * r18boardviews: who opened a board and when — one row per board and person, its time moved (and the
 * count raised) at most once per BOARD_VIEW_THROTTLE_MS. Off with `permissions.show_board_viewers`.
 */
export const boardViewers = pgTable(
  'board_viewers',
  {
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** desktop | mobile | tablet of the latest open (from the request headers). */
    device: varchar('device', { length: 8 }).notNull(),
    /** "Chrome · Windows" of the latest open — never the full User-Agent string. */
    userAgent: varchar('user_agent', { length: 64 }).notNull().default(''),
    viewCount: integer('view_count').notNull().default(1),
    firstViewedAt: ts('first_viewed_at').notNull().defaultNow(),
    lastViewedAt: ts('last_viewed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.userId] }),
    index('ix_board_viewers_board_last').on(t.boardId, t.lastViewedAt),
    index('ix_board_viewers_account_user').on(t.accountId, t.userId),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    ownerId: ulid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    kind: assetKindEnum('kind').notNull().default('file'),
    storageKey: text('storage_key'),
    externalUrl: text('external_url'),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mime: varchar('mime', { length: 127 }).notNull().default('application/octet-stream'),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    sha256: varchar('sha256', { length: 64 }),
    parentAssetId: ulid('parent_asset_id').references((): AnyPgColumn => assets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    uploadStatus: varchar('upload_status', { length: 16 }).notNull().default('pending'),
    /**
     * The text of an audio / video file: made only when someone asks (or by the account's "automatic"
     * choice), kept so it shows under the player for everyone who may read the file, editable by whoever may edit
     * what holds it. Per version: a new version starts without one. `{text, model, by, at, edited_by?, edited_at?}`.
     */
    transcript: jsonb('transcript').$type<JsonObject>(),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_assets_account_created').on(t.accountId, t.createdAt),
    index('ix_assets_parent_version').on(t.parentAssetId, t.version),
    index('ix_assets_owner').on(t.ownerId),
  ],
);

export const cellFiles = pgTable(
  'cell_files',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id').notNull(),
    columnId: ulid('column_id').notNull(),
    assetId: ulid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_cell_files_cell',
      columns: [t.itemId, t.columnId],
      foreignColumns: [cells.itemId, cells.columnId],
    }).onDelete('cascade'),
    uniqueIndex('ux_cell_files').on(t.itemId, t.columnId, t.assetId),
  ],
);

export const updateFiles = pgTable(
  'update_files',
  {
    updateId: ulid('update_id')
      .notNull()
      .references(() => updates.id, { onDelete: 'cascade' }),
    assetId: ulid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.updateId, t.assetId] })],
);

// ---------------------------------------------------------------------------
// Views & forms
// ---------------------------------------------------------------------------
export const views = pgTable(
  'views',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    type: viewTypeEnum('type').notNull().default('table'),
    name: varchar('name', { length: 120 }).notNull(),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    isLocked: boolean('is_locked').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    /** The board's default table (15 §4): cannot be deleted or change type. */
    isSystem: boolean('is_system').notNull().default(false),
    /** 'private' views are visible to their creator only and don't count toward the 100-view quota (15 §3). */
    visibility: viewVisibilityEnum('visibility').notNull().default('shared'),
    position: text('position').notNull(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    /** An import: the source board view (re-runs update instead of duplicating). */
    sourceViewId: bigint('source_view_id', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_views_source')
      .on(t.accountId, t.sourceViewId)
      .where(sql`${t.sourceViewId} is not null`),
    uniqueIndex('ux_views_system')
      .on(t.boardId)
      .where(sql`${t.isSystem} = true and ${t.deletedAt} is null`),
    index('ix_views_board_position')
      .on(t.boardId, t.position)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('ux_views_default')
      .on(t.boardId)
      .where(sql`${t.isDefault} = true and ${t.deletedAt} is null`),
  ],
);

/** Personal view overrides (15 §1): column widths, collapsed groups, wrap — never shared, no revision bump. */
export const userViewPrefs = pgTable(
  'user_view_prefs',
  {
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viewId: ulid('view_id')
      .notNull()
      .references(() => views.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.viewId] })],
);

/** Per user and board: the view opened last (15 §7). */
export const userBoardPrefs = pgTable(
  'user_board_prefs',
  {
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    lastViewId: ulid('last_view_id').references(() => views.id, { onDelete: 'set null' }),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.boardId] })],
);

export const forms = pgTable(
  'forms',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    viewId: ulid('view_id')
      .notNull()
      .references(() => views.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 64 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    passwordHash: text('password_hash'),
    isActive: boolean('is_active').notNull().default(true),
    requireLogin: boolean('require_login').notNull().default(false),
    targetGroupId: ulid('target_group_id').references(() => groups.id, { onDelete: 'set null' }),
    questions: jsonb('questions').$type<JsonArray>().notNull().default(emptyArray),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ux_forms_view').on(t.viewId), uniqueIndex('ux_forms_slug').on(t.slug)],
);

export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    formId: ulid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'set null' }),
    submittedBy: ulid('submitted_by').references(() => users.id, { onDelete: 'set null' }),
    submitterEmail: varchar('submitter_email', { length: 320 }),
    ip: varchar('ip', { length: 45 }),
    /** M11 public forms: a keyed hash of the client address (counting / abuse review) — the address itself is not kept. */
    ipHash: varchar('ip_hash', { length: 64 }),
    /** "Chrome 120 · Android" — a short summary, never the raw header. */
    userAgent: varchar('user_agent', { length: 120 }),
    answers: jsonb('answers').$type<JsonObject>().notNull().default(emptyJson),
    createdAt: createdAt(),
  },
  (t) => [index('ix_form_submissions_form_created').on(t.formId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Automations, events, webhooks, tokens
// ---------------------------------------------------------------------------
export const automations = pgTable(
  'automations',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }), // null = account-level
    title: varchar('title', { length: 255 }).notNull(),
    recipe: jsonb('recipe').$type<{ trigger: JsonObject; conditions: JsonObject[]; actions: JsonObject[] }>().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ownerId: ulid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdFromTemplateId: ulid('created_from_template_id').references((): AnyPgColumn => templates.id, {
      onDelete: 'set null',
    }),
    seedKey: varchar('seed_key', { length: 32 }),
    runCount: integer('run_count').notNull().default(0),
    lastRunAt: ts('last_run_at'),
    lastErrorAt: ts('last_error_at'),
    /** Errored runs in a row; 20 deactivates the automation (04 §5.7). */
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    deactivatedReason: varchar('deactivated_reason', { length: 160 }),
    /** Free text for humans (seed notes, unresolved references). */
    note: text('note'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_automations_board_active')
      .on(t.boardId, t.isActive)
      .where(sql`${t.deletedAt} is null`),
    // The activity_log dispatch trigger asks "does this account have any active automation?" on every insert.
    index('ix_automations_account_active')
      .on(t.accountId)
      .where(sql`${t.isActive} and ${t.deletedAt} is null`),
    // SQL: CREATE INDEX ix_automations_trigger_type ON automations (account_id, (recipe->'trigger'->>'type')) WHERE is_active AND deleted_at IS NULL;
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    automationId: ulid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    eventId: ulid('event_id'), // activity_log.id (no FK: partitioned table)
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'set null' }),
    status: automationRunStatusEnum('status').notNull().default('pending'),
    /** Why a run was skipped: conditions, inactive, item_gone, max_depth, self_loop, cycle (04 §5.3–5.4). */
    skipReason: varchar('skip_reason', { length: 64 }),
    /** 1 for a person's change; +1 for each automation in the chain that caused the event (04 §5.4). */
    depth: integer('depth').notNull().default(1),
    /** Automation ids of the chain that led here, oldest first (cycle detection). */
    chain: jsonb('chain').$type<string[]>().notNull().default(emptyArray),
    eventType: varchar('event_type', { length: 64 }),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    error: text('error'),
    actionsLog: jsonb('actions_log').$type<JsonArray>().notNull().default(emptyArray),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_automation_runs_automation_created').on(t.automationId, t.createdAt.desc()),
    index('ix_automation_runs_status')
      .on(t.accountId, t.status)
      .where(sql`${t.status} in ('pending','running')`),
    // One run per automation × event × item: a period tick or a linked-items change fans out to many items.
    uniqueIndex('ux_automation_runs_event')
      .on(t.automationId, t.eventId, sql`coalesce(${t.itemId}, '')`)
      .where(sql`${t.eventId} is not null`),
  ],
);

/**
 * Account automation templates ("save as template"): a recipe taken off its board, its board references as slots
 * that are picked again on install (shared `automations/recipe-template.ts`). `pack_key` = installed by a data pack.
 */
export const automationTemplates = pgTable(
  'automation_templates',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    category: varchar('category', { length: 48 }),
    recipe: jsonb('recipe').$type<JsonObject>().notNull(),
    slots: jsonb('slots').$type<JsonArray>().notNull().default(emptyArray),
    sourceAutomationId: ulid('source_automation_id').references(() => automations.id, { onDelete: 'set null' }),
    packKey: varchar('pack_key', { length: 64 }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_automation_templates_account')
      .on(t.accountId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * Scheduled triggers (04 §5.6): one row per (automation, item) for date triggers, one per automation (item null)
 * for `every_time_period`. The minute tick fires rows whose `fire_at` passed and `fired_at` is null.
 */
export const automationSchedules = pgTable(
  'automation_schedules',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    automationId: ulid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(), // 'date' | 'period'
    fireAt: ts('fire_at').notNull(),
    /** What fire_at was computed from (date + offset + time); a change re-arms the row. */
    valueHash: varchar('value_hash', { length: 120 }),
    firedAt: ts('fired_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_automation_schedules_item')
      .on(t.automationId, t.itemId)
      .where(sql`${t.itemId} is not null`),
    uniqueIndex('ux_automation_schedules_period')
      .on(t.automationId)
      .where(sql`${t.itemId} is null`),
    index('ix_automation_schedules_due')
      .on(t.fireAt)
      .where(sql`${t.firedAt} is null`),
  ],
);

/**
 * Event bus + undo source. SQL: `PARTITION BY RANGE (created_at)` with monthly partitions
 * (activity_log_yYYYYmMM) — declared in the hand-written migration; drizzle-kit sees a plain table.
 * No FKs on purpose (partitioned tables cannot be FK targets and we keep inserts cheap).
 */
export const activityLog = pgTable(
  'activity_log',
  {
    id: ulid('id').notNull(),
    accountId: ulid('account_id').notNull(),
    boardId: ulid('board_id'),
    itemId: ulid('item_id'),
    columnId: ulid('column_id'),
    actorId: ulid('actor_id'),
    actorType: actorTypeEnum('actor_type').notNull().default('user'),
    automationId: ulid('automation_id'),
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload')
      .$type<{ before?: unknown; after?: unknown; meta?: JsonObject }>()
      .notNull()
      .default(emptyJson),
    batchId: ulid('batch_id'),
    requestId: varchar('request_id', { length: 64 }),
    undoneAt: ts('undone_at'),
    undoneByEventId: ulid('undone_by_event_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('ix_al_account_created').on(t.accountId, t.createdAt.desc()),
    index('ix_al_board_created').on(t.boardId, t.createdAt.desc()),
    index('ix_al_item_created').on(t.itemId, t.createdAt.desc()),
    index('ix_al_type').on(t.accountId, t.type, t.createdAt.desc()),
    index('ix_al_batch').on(t.batchId),
  ],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    config: jsonb('config').$type<JsonObject>().notNull().default(emptyJson),
    secret: varchar('secret', { length: 128 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    challengeVerifiedAt: ts('challenge_verified_at'),
    /** Dead deliveries in a row; 50 disables the webhook (06 §2.17). */
    failureCount: integer('failure_count').notNull().default(0),
    disabledReason: varchar('disabled_reason', { length: 120 }),
    description: varchar('description', { length: 255 }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    // The activity_log dispatch trigger asks "does this account have an active webhook?".
    index('ix_webhooks_account_active')
      .on(t.accountId)
      .where(sql`${t.isActive} = true and ${t.deletedAt} is null`),
    index('ix_webhooks_board_event')
      .on(t.boardId, t.eventType)
      .where(sql`${t.isActive} = true and ${t.deletedAt} is null`),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** A board webhook's delivery — or an automation's `webhook` action (then `automation_id` + the target). */
    webhookId: ulid('webhook_id').references(() => webhooks.id, { onDelete: 'cascade' }),
    automationId: ulid('automation_id').references(() => automations.id, { onDelete: 'cascade' }),
    actionIndex: integer('action_index'),
    url: text('url'),
    method: varchar('method', { length: 8 }).notNull().default('POST'),
    headers: jsonb('headers').$type<Record<string, string>>(),
    eventType: varchar('event_type', { length: 64 }),
    responseMs: integer('response_ms'),
    eventId: ulid('event_id').notNull(),
    status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    requestBody: jsonb('request_body').$type<JsonObject>().notNull().default(emptyJson),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    error: text('error'),
    nextAttemptAt: ts('next_attempt_at'),
    deliveredAt: ts('delivered_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_wd_webhook_created').on(t.webhookId, t.createdAt.desc()),
    index('ix_wd_pending')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = service token
    name: varchar('name', { length: 120 }).notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    tokenPrefix: varchar('token_prefix', { length: 12 }).notNull(),
    scopes: jsonb('scopes')
      .$type<string[]>()
      .notNull()
      .default(sql`'["boards:read"]'::jsonb`),
    boardIds: jsonb('board_ids').$type<string[]>(),
    /** The token's own budgets (ANSWERS 6א.9); null = the account's, then the platform's default. */
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    dailyQuota: integer('daily_quota'),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_api_tokens_hash').on(t.tokenHash),
    index('ix_api_tokens_account')
      .on(t.accountId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * AI connections (D26, the planning notes "AGENTS-MCP" מ1): a provider + its API key, saved once per account by admins.
 * The key is AES-256-GCM encrypted (`lib/secrets.ts`) and never sent back — only `key_hint` (its last 4 chars).
 */
export const aiConnections = pgTable(
  'ai_connections',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    keyEnc: text('key_enc').notNull(),
    keyHint: varchar('key_hint', { length: 8 }).notNull(),
    /** OpenAI-compatible servers: where the API answers; SSRF-guarded on save and on every call. */
    baseUrl: varchar('base_url', { length: 500 }),
    /** Models added by hand / capabilities corrected: `[{id, display_name?, capabilities?}]`. */
    manualModels: jsonb('manual_models')
      .$type<{ id: string; display_name?: string; capabilities?: Record<string, unknown> }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    defaultModel: varchar('default_model', { length: 80 }),
    /** Fix: prices an admin set per model, `{model: {input, output}}` USD per 1M tokens. */
    priceOverrides: jsonb('price_overrides')
      .$type<Record<string, { input: number; output: number }>>()
      .notNull()
      .default(emptyJson),
    lastTest: jsonb('last_test').$type<{ ok: boolean; at: string; error: string | null }>(),
    lastUsedAt: ts('last_used_at'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_ai_connections_account')
      .on(t.accountId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * The platform's AI price table (owner console → "AI prices"): USD per 1M tokens per provider (or `*`) and
 * model — an exact id or a `*` pattern. Seeded by migration 0056 with the prices that used to be in code. A
 * connection's own `price_overrides` win over it; a model matched by neither has an unknown price (cost 0, flagged).
 */
export const aiPrices = pgTable(
  'ai_prices',
  {
    id: pk(),
    provider: varchar('provider', { length: 32 }).notNull(),
    model: varchar('model', { length: 120 }).notNull(),
    input: doublePrecision('input').notNull(),
    output: doublePrecision('output').notNull(),
    cacheRead: doublePrecision('cache_read'),
    cacheWrite: doublePrecision('cache_write'),
    /** AI images: USD per image, and per image by size / quality (`{"1024x1024/high": 0.17}`). */
    perImage: doublePrecision('per_image'),
    imagePrices: jsonb('image_prices').$type<Record<string, number>>(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    note: varchar('note', { length: 255 }),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ux_ai_prices_provider_model').on(t.provider, t.model)],
);

/** AI spend per account × day × source × connection × model, upserted after every model call (מ1, A5 tile). */
export const aiUsage = pgTable(
  'ai_usage',
  {
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    /** agent / column / assistant / test */
    source: varchar('source', { length: 32 }).notNull(),
    connectionId: ulid('connection_id').notNull(),
    model: varchar('model', { length: 80 }).notNull(),
    calls: integer('calls').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    /** USD, 6 decimals. */
    costUsd: doublePrecision('cost_usd').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day, t.source, t.connectionId, t.model] })],
);

/**
 * Agents (the planning notes "AGENTS-MCP" מ6–מ7, D26): built in the UI, one service user each (`users.is_service`) that the
 * activity log shows. The boards an agent may touch are its user's board subscriptions (board_members: level
 * viewer = read, contributor = edit content), never more than its creator can do.
 */
export const agents = pgTable(
  'agents',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    avatar: varchar('avatar', { length: 16 }),
    role: varchar('role', { length: 200 }).notNull().default(''),
    instructions: text('instructions').notNull().default(''),
    connectionId: ulid('connection_id').references(() => aiConnections.id, { onDelete: 'set null' }),
    model: varchar('model', { length: 80 }).notNull(),
    effort: varchar('effort', { length: 16 }).notNull().default('medium'),
    tools: jsonb('tools').$type<string[]>().notNull().default(emptyArray),
    approvalTools: jsonb('approval_tools').$type<string[]>().notNull().default(emptyArray),
    /** learner | autonomous */
    approvalMode: varchar('approval_mode', { length: 16 }).notNull().default('learner'),
    limits: jsonb('limits').$type<JsonObject>().notNull().default(emptyJson),
    /** When it acts on its own (מ8): mention / assign, columns, board scope, guests, tasks (agentTriggersSchema). */
    triggers: jsonb('triggers').$type<JsonObject>().notNull().default(emptyJson),
    isActive: boolean('is_active').notNull().default(true),
    /** The starter template it was created from (seed/agents/<key>.json), if any. */
    templateKey: varchar('template_key', { length: 40 }),
    /** Web search: `{status: off | requested | approved, requested_by, decided_by, at}`. */
    webSearch: jsonb('web_search').$type<JsonObject>().notNull().default(emptyJson),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_agents_account')
      .on(t.accountId)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('ux_agents_user').on(t.userId),
  ],
);

/** One run of an agent (מ6): queued → running → waiting_approval ⇄ running → succeeded / failed / cancelled / skipped. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    agentId: ulid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** manual | automation | mention | assign | schedule */
    trigger: varchar('trigger', { length: 16 }).notNull().default('manual'),
    prompt: text('prompt'),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'set null' }),
    dryRun: boolean('dry_run').notNull().default(false),
    status: varchar('status', { length: 24 }).notNull().default('queued'),
    skipReason: varchar('skip_reason', { length: 64 }),
    error: text('error'),
    finalText: text('final_text'),
    model: varchar('model', { length: 80 }),
    /** Model calls so far. */
    steps: integer('steps').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    requestedBy: ulid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Trigger context for stage מ8 (event id, chain depth …). */
    meta: jsonb('meta').$type<JsonObject>().notNull().default(emptyJson),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    undoneAt: ts('undone_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_agent_runs_agent_created').on(t.agentId, t.createdAt.desc()),
    index('ix_agent_runs_account_status').on(t.accountId, t.status),
  ],
);

/**
 * The transcript of a run, append-only (preserved thinking: a model answer is sent back exactly as it came).
 * `prompt` = the first user message; `model` = one answer (`content` = its raw blocks); `tool` = one tool_use and
 * its result (`content` = the tool_result block sent back).
 */
export const agentRunSteps = pgTable(
  'agent_run_steps',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    runId: ulid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    tool: varchar('tool', { length: 64 }),
    toolUseId: varchar('tool_use_id', { length: 80 }),
    input: jsonb('input').$type<unknown>(),
    output: jsonb('output').$type<unknown>(),
    isError: boolean('is_error').notNull().default(false),
    /** Tool steps: ran / dry_run / rejected / expired / blocked / failed. */
    outcome: varchar('outcome', { length: 16 }),
    content: jsonb('content').$type<unknown>(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_agent_run_steps_seq').on(t.runId, t.seq)],
);

/** A tool call waiting for a person (מ7): approve → the run resumes and runs it; reject / expiry → it is told so. */
export const agentApprovals = pgTable(
  'agent_approvals',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    agentId: ulid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    runId: ulid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    toolUseId: varchar('tool_use_id', { length: 80 }).notNull(),
    tool: varchar('tool', { length: 64 }).notNull(),
    input: jsonb('input').$type<unknown>(),
    preview: text('preview').notNull().default(''),
    /** pending | approved | rejected | expired */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    reason: text('reason'),
    decidedBy: ulid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_agent_approvals_call').on(t.runId, t.toolUseId),
    index('ix_agent_approvals_pending')
      .on(t.accountId, t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * An agent's knowledge source (מ9): an uploaded file (text extracted on the server), a doc, a note written in the
 * editor, or a board (read through the agent's board tools — never dumped into the index). `added_by` is whose
 * read access the source rests on; at search time a doc counts only while the agent's creator can still read it.
 */
export const agentKnowledge = pgTable(
  'agent_knowledge',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    agentId: ulid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** file | doc | board | note */
    kind: varchar('kind', { length: 16 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    assetId: ulid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    docId: ulid('doc_id').references(() => docs.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    /** A note's text. */
    body: text('body'),
    /** indexing | ready | error */
    status: varchar('status', { length: 16 }).notNull().default('indexing'),
    error: varchar('error', { length: 120 }),
    chunks: integer('chunks').notNull().default(0),
    chars: integer('chars').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
    addedBy: ulid('added_by').references(() => users.id, { onDelete: 'set null' }),
    indexedAt: ts('indexed_at'),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_agent_knowledge_agent')
      .on(t.agentId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** Passages of a knowledge source, searched with Postgres FTS (`simple` config: Hebrew has no stemmer). */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    agentId: ulid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sourceId: ulid('source_id')
      .notNull()
      .references(() => agentKnowledge.id, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(),
    body: text('body').notNull(),
    // Hebrew glues one-letter prefixes (ו ה ב ל מ ש כ) to words: each word is indexed with and without one.
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', body || ' ' || regexp_replace(body, '(^|[^א-ת])[והבלמשכ]([א-ת]{2,})', '\\1\\2', 'g'))`,
    ),
  },
  (t) => [
    index('ix_knowledge_chunks_source').on(t.sourceId, t.ord),
    index('ix_knowledge_chunks_tsv').using('gin', t.tsv),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: varchar('key', { length: 128 }).notNull(),
    accountId: ulid('account_id').notNull(),
    principalId: ulid('principal_id').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.principalId, t.key] })],
);

// ---------------------------------------------------------------------------
// Notifications, templates, trash, admin
// ---------------------------------------------------------------------------
export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 48 }).notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull().default(emptyJson),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    updateId: ulid('update_id').references(() => updates.id, { onDelete: 'cascade' }),
    /** A doc notification (M8 ד2–ד3: mentioned in a doc, a comment): the doc it opens. */
    docId: ulid('doc_id').references((): AnyPgColumn => docs.id, { onDelete: 'cascade' }),
    /** A dashboard notification (shared with me): the dashboard it opens. */
    dashboardId: ulid('dashboard_id').references((): AnyPgColumn => dashboards.id, { onDelete: 'cascade' }),
    actorId: ulid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    readAt: ts('read_at'),
    emailedAt: ts('emailed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_notifications_user_unread')
      .on(t.userId, t.createdAt.desc())
      .where(sql`${t.readAt} is null`),
    index('ix_notifications_user_created').on(t.userId, t.createdAt.desc()),
  ],
);

/**
 * Who follows an item (D15): its creator, assignees (a team → its members), people mentioned on it and people
 * who write an update join automatically; "follow" / "unfollow" in the item menu. A manual unfollow stays
 * (`muted`) so an automatic rule never adds the person back.
 */
export const itemFollowers = pgTable(
  'item_followers',
  {
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** creator | assigned | mentioned | update | manual */
    source: varchar('source', { length: 16 }).notNull(),
    muted: boolean('muted').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.userId] }), index('ix_item_followers_user').on(t.userId)],
);

/**
 * Inbox entries I marked read (the "V", 07 §9.3). "Mark all read" is a watermark instead
 * (`account_members.settings.inbox_cleared_at`), so it costs one write however full the inbox is.
 */
/**
 * "V" on inbox entries (search.repo.ts: `dismissInbox`, the inbox read) — written and read through raw SQL, so
 * nothing imports this const; the table is live (audit 2026-10-10 dedup #27 called it orphan — it is not).
 */
export const inboxDismissals = pgTable(
  'inbox_dismissals',
  {
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    updateId: ulid('update_id')
      .notNull()
      .references(() => updates.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.updateId] })],
);

export const notificationSettings = pgTable(
  'notification_settings',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    type: varchar('type', { length: 48 }).notNull().default('*'),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    digest: varchar('digest', { length: 16 }).notNull().default('instant'),
    updatedAt: updatedAt(),
  },
  // Per account (a user's settings differ between accounts).
  (t) => [
    uniqueIndex('ux_notification_settings').on(
      t.accountId,
      t.userId,
      t.channel,
      t.type,
      sql`coalesce(${t.boardId}, '')`,
    ),
  ],
);

/**
 * Web Push subscriptions (PWA, the planning notes "PWA"): one row per browser / phone a user turned the phone channel on
 * for, per account (a browser has one endpoint for the whole origin; each account it is enabled in gets a row).
 * Tied to the sign-in session: signing out (or an admin ending the session) removes it. The push service answering
 * 404 / 410 removes it too (the worker).
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: ulid('session_id').references(() => authSessions.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: varchar('p256dh', { length: 256 }).notNull(),
    auth: varchar('auth', { length: 128 }).notNull(),
    /** "iPhone", "Chrome · Android" — shown in the settings list. */
    deviceLabel: varchar('device_label', { length: 80 }).notNull().default(''),
    /** Sends that failed in a row (not 404/410, which delete the row at once). */
    failures: integer('failures').notNull().default(0),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    uniqueIndex('ux_push_subscriptions_endpoint').on(t.accountId, t.endpoint),
    index('ix_push_subscriptions_user').on(t.accountId, t.userId),
  ],
);

export const templates = pgTable(
  'templates',
  {
    id: pk(),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'cascade' }), // null = built-in
    kind: templateKindEnum('kind').notNull().default('board'),
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    category: varchar('category', { length: 48 }),
    snapshot: jsonb('snapshot').$type<JsonObject>().notNull(),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    sourceBoardId: ulid('source_board_id').references(() => boards.id, { onDelete: 'set null' }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_templates_scope_key')
      .on(sql`coalesce(${t.accountId}, '')`, t.key)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const trashEntries = pgTable(
  'trash_entries',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    objectType: trashObjectTypeEnum('object_type').notNull(),
    objectId: ulid('object_id').notNull(),
    objectName: varchar('object_name', { length: 255 }).notNull(),
    boardId: ulid('board_id'),
    parentEntryId: ulid('parent_entry_id').references((): AnyPgColumn => trashEntries.id, { onDelete: 'cascade' }),
    deletedBy: ulid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: ts('deleted_at').notNull().defaultNow(),
    purgeAfter: ts('purge_after')
      .notNull()
      .default(sql`now() + interval '30 days'`),
    restorePayload: jsonb('restore_payload').$type<JsonObject>().notNull().default(emptyJson),
    restoredAt: ts('restored_at'),
    purgedAt: ts('purged_at'),
  },
  (t) => [
    index('ix_trash_account_deleted')
      .on(t.accountId, t.deletedAt.desc())
      .where(sql`${t.restoredAt} is null and ${t.purgedAt} is null`),
    index('ix_trash_purge')
      .on(t.purgeAfter)
      .where(sql`${t.restoredAt} is null and ${t.purgedAt} is null`),
    uniqueIndex('ux_trash_object')
      .on(t.objectType, t.objectId)
      .where(sql`${t.restoredAt} is null and ${t.purgedAt} is null`),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    actorId: ulid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: ulid('target_id'),
    payload: jsonb('payload').$type<JsonObject>().notNull().default(emptyJson),
    ip: varchar('ip', { length: 45 }),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_audit_account_created').on(t.accountId, t.createdAt.desc()),
    index('ix_audit_actor').on(t.actorId, t.createdAt.desc()),
  ],
);

/**
 * Full account exports: one ZIP per request, built by a background job and kept in storage under
 * `exports/<account>/` until `expires_at` (then the file is removed and the row says `expired`).
 */
export const accountExports = pgTable(
  'account_exports',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    requestedBy: ulid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** pending | running | ready | failed | expired */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    storageKey: text('storage_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    summary: jsonb('summary').$type<JsonObject>(),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    expiresAt: ts('expires_at'),
  },
  (t) => [
    index('ix_account_exports_account').on(t.accountId, t.createdAt.desc()),
    index('ix_account_exports_expires').on(t.expiresAt),
  ],
);

/**
 * The platform's own audit: what outlives an account — "account X deleted on Y by Z". Never tied to
 * an account by a foreign key (the account is gone); `target_id` keeps its id.
 */
export const platformAuditLog = pgTable(
  'platform_audit_log',
  {
    id: pk(),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: varchar('target_id', { length: 64 }).notNull(),
    actorId: ulid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<JsonObject>().notNull().default(emptyJson),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_platform_audit_created').on(t.createdAt.desc()),
    uniqueIndex('ux_platform_audit_account_purged')
      .on(t.targetId)
      .where(sql`${t.action} = 'account.purged'`),
  ],
);

export const accountSettings = pgTable('account_settings', {
  accountId: ulid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
  updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

/**
 * Platform-wide settings of the owner console (one row, id `platform`): product name, platform email sender, SMS
 * sender, API-token budgets (`platformSettingsSchema` in @bines/shared). Missing row = the defaults.
 */
export const platformSettings = pgTable('platform_settings', {
  id: varchar('id', { length: 32 }).primaryKey(),
  settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
  updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

export const userProfileSettings = pgTable('user_profile_settings', {
  userId: ulid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
  updatedAt: updatedAt(),
});

export const supportAccessGrants = pgTable(
  'support_access_grants',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    grantedBy: ulid('granted_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    grantedToUserId: ulid('granted_to_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** `platform` = any platform owner; `email` = the person signed in with `granted_to_email` (verified). */
    granteeKind: varchar('grantee_kind', { length: 16 }).notNull().default('platform'),
    grantedToEmail: varchar('granted_to_email', { length: 320 }),
    /** `read` (view only — the default) or `read_write` (edit). */
    scope: varchar('scope', { length: 16 }).notNull().default('read'),
    reason: text('reason'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokedBy: ulid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    /** The last request made under the grant (a gap longer than the idle time starts a new session). */
    lastUsedAt: ts('last_used_at'),
    /** Approved from a support ticket: solving / closing the ticket revokes it. */
    ticketId: ulid('ticket_id').references((): AnyPgColumn => supportTickets.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_support_grants_account_active')
      .on(t.accountId, t.expiresAt)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * The emergency path of the owner's recovery link: asked without a support grant, it is announced to
 * the account's admins and opens only after the platform's waiting period; any admin may cancel it before.
 */
export const supportRecoveryRequests = pgTable(
  'support_recovery_requests',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    requestedBy: ulid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    targetUserId: ulid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetEmail: varchar('target_email', { length: 320 }).notNull(),
    reason: text('reason').notNull(),
    availableAt: ts('available_at').notNull(),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: ulid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('ix_support_recovery_account').on(t.accountId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Support tickets: platform-level helpdesk — staff, queues, categories, SLA, canned replies, tags
// tickets with their messages (public replies / internal notes), attachments (account assets), assignments,
// history and access requests. Tickets carry the customer's `account_id` (cascade with the account), but they are
// never read through an account's boards: the console reads them by the staff role only.
// ---------------------------------------------------------------------------
/** Sequential ticket numbers across the platform (1042, 1043 …); the first one is a setting (`number_start`). */
export const supportTicketNumberSeq = pgSequence('support_ticket_number_seq', { startWith: 1, minValue: 1 });

/** Platform support staff (agent / lead), invited by email by the platform owner; resolved by the verified address. */
export const supportStaff = pgTable(
  'support_staff',
  {
    id: pk(),
    email: varchar('email', { length: 320 }).notNull(),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'set null' }),
    role: varchar('role', { length: 16 }).notNull().default('agent'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    invitedBy: ulid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ux_support_staff_email').on(sql`lower(${t.email})`)],
);

export const supportQueues = pgTable('support_queues', {
  id: pk(),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
});

/** What the customer picks; routes the ticket to a queue (null = the default queue). */
export const supportCategories = pgTable('support_categories', {
  id: pk(),
  name: varchar('name', { length: 80 }).notNull(),
  queueId: ulid('queue_id').references(() => supportQueues.id, { onDelete: 'set null' }),
  defaultPriority: varchar('default_priority', { length: 16 }),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
});

/** SLA targets per priority (minutes), counted in business hours or around the clock. */
export const supportSlaPolicies = pgTable('support_sla_policies', {
  priority: varchar('priority', { length: 16 }).primaryKey(),
  firstResponseMinutes: integer('first_response_minutes').notNull(),
  resolutionMinutes: integer('resolution_minutes').notNull(),
  businessHours: boolean('business_hours').notNull().default(true),
  updatedAt: updatedAt(),
});

export const supportCannedReplies = pgTable('support_canned_replies', {
  id: pk(),
  title: varchar('title', { length: 120 }).notNull(),
  body: text('body').notNull(),
  queueId: ulid('queue_id').references(() => supportQueues.id, { onDelete: 'set null' }),
  createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const supportTags = pgTable(
  'support_tags',
  {
    id: pk(),
    name: varchar('name', { length: 40 }).notNull(),
    color: varchar('color', { length: 7 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_support_tags_name').on(sql`lower(${t.name})`)],
);

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: pk(),
    number: integer('number').notNull(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    requesterId: ulid('requester_id').references(() => users.id, { onDelete: 'set null' }),
    requesterEmail: varchar('requester_email', { length: 320 }).notNull(),
    requesterName: varchar('requester_name', { length: 120 }).notNull().default(''),
    subject: varchar('subject', { length: 200 }).notNull(),
    status: varchar('status', { length: 24 }).notNull().default('new'),
    priority: varchar('priority', { length: 16 }).notNull().default('normal'),
    categoryId: ulid('category_id').references(() => supportCategories.id, { onDelete: 'set null' }),
    queueId: ulid('queue_id').references(() => supportQueues.id, { onDelete: 'set null' }),
    assigneeId: ulid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    /** What the app attached (page, browser, recent errors) — only what the person kept. */
    context: jsonb('context').$type<JsonObject>(),
    firstResponseDueAt: ts('first_response_due_at'),
    resolutionDueAt: ts('resolution_due_at'),
    firstRespondedAt: ts('first_responded_at'),
    /** The resolution timer stopped (pending customer / on hold) since then. */
    slaPausedAt: ts('sla_paused_at'),
    firstBreachAlertedAt: ts('first_breach_alerted_at'),
    resolutionBreachAlertedAt: ts('resolution_breach_alerted_at'),
    solvedAt: ts('solved_at'),
    closedAt: ts('closed_at'),
    csatRating: integer('csat_rating'),
    csatComment: text('csat_comment'),
    csatAt: ts('csat_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_support_tickets_number').on(t.number),
    index('ix_support_tickets_account').on(t.accountId, t.createdAt.desc()),
    index('ix_support_tickets_status').on(t.status, t.priority, t.createdAt),
    index('ix_support_tickets_assignee').on(t.assigneeId, t.status),
  ],
);

export const supportTicketMessages = pgTable(
  'support_ticket_messages',
  {
    id: pk(),
    ticketId: ulid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    authorId: ulid('author_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: varchar('author_name', { length: 120 }).notNull().default(''),
    /** `customer` | `staff` | `system`. */
    kind: varchar('kind', { length: 16 }).notNull(),
    /** `public` (the customer sees it) | `internal` (a staff note — never shown to the customer). */
    visibility: varchar('visibility', { length: 16 }).notNull().default('public'),
    body: text('body').notNull(),
    /**
     * Knowledge-center articles support attached to the reply: ids only, so the card always shows the
     * article's current published title; read through the readers' rules (published, visible to the customer).
     */
    articleIds: text('article_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [index('ix_support_messages_ticket').on(t.ticketId, t.createdAt)],
);

/** Files of a ticket: assets of the customer's account (uploaded with the account's file flow). */
export const supportTicketAttachments = pgTable(
  'support_ticket_attachments',
  {
    id: pk(),
    ticketId: ulid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    messageId: ulid('message_id').references(() => supportTicketMessages.id, { onDelete: 'cascade' }),
    assetId: ulid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_support_attachments_ticket').on(t.ticketId), index('ix_support_attachments_asset').on(t.assetId)],
);

export const supportTicketTags = pgTable(
  'support_ticket_tags',
  {
    ticketId: ulid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    tagId: ulid('tag_id')
      .notNull()
      .references(() => supportTags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.tagId] })],
);

/** Who held the ticket and when (assign / unassign history; the ticket keeps the current assignee). */
export const supportTicketAssignments = pgTable(
  'support_ticket_assignments',
  {
    id: pk(),
    ticketId: ulid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    assigneeId: ulid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    assignedBy: ulid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    assignedAt: createdAt(),
    unassignedAt: ts('unassigned_at'),
  },
  (t) => [index('ix_support_assignments_ticket').on(t.ticketId, t.assignedAt)],
);

/** The staff audit of a ticket: every change (status, priority, assignment, tags, access) — staff eyes only. */
export const supportTicketEvents = pgTable(
  'support_ticket_events',
  {
    id: pk(),
    ticketId: ulid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    actorId: ulid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    type: varchar('type', { length: 48 }).notNull(),
    data: jsonb('data').$type<JsonObject>().notNull().default(emptyJson),
    createdAt: createdAt(),
  },
  (t) => [index('ix_support_events_ticket').on(t.ticketId, t.createdAt)],
);

/** A support person asks, from a ticket, to enter the account; an account admin approves (→ a grant) or declines. */
export const supportAccessRequests = pgTable(
  'support_access_requests',
  {
    id: pk(),
    ticketId: ulid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    requestedBy: ulid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: varchar('mode', { length: 8 }).notNull().default('view'),
    durationHours: integer('duration_hours').notNull(),
    reason: text('reason').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    expiresAt: ts('expires_at').notNull(),
    decidedBy: ulid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    grantId: ulid('grant_id').references((): AnyPgColumn => supportAccessGrants.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_support_access_requests_ticket').on(t.ticketId, t.createdAt),
    index('ix_support_access_requests_account').on(t.accountId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Knowledge center: platform-level help articles — never an account's doc.
// ---------------------------------------------------------------------------
export const helpCategories = pgTable('help_categories', {
  id: pk(),
  name: varchar('name', { length: 80 }).notNull(),
  nameEn: varchar('name_en', { length: 80 }),
  icon: varchar('icon', { length: 40 }),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A help article in one language (`group_id` ties the languages of the same article). `title`/`content` are the
 * working copy; `published_*` the version readers see (search indexes only that, in `help_chunks`).
 */
export const helpArticles = pgTable(
  'help_articles',
  {
    id: pk(),
    groupId: ulid('group_id').notNull(),
    locale: varchar('locale', { length: 2 }).notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    excerpt: varchar('excerpt', { length: 300 }).notNull().default(''),
    categoryId: ulid('category_id').references(() => helpCategories.id, { onDelete: 'set null' }),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `public` (the public help center, no sign-in) | `signed_in`. */
    visibility: varchar('visibility', { length: 16 }).notNull().default('signed_in'),
    /** `draft` | `published`. */
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    content: jsonb('content').$type<JsonObject>().notNull(),
    version: integer('version').notNull().default(1),
    publishedTitle: varchar('published_title', { length: 200 }),
    publishedContent: jsonb('published_content').$type<JsonObject>(),
    publishedText: text('published_text'),
    publishedVersion: integer('published_version'),
    publishedAt: ts('published_at'),
    publishedBy: ulid('published_by').references(() => users.id, { onDelete: 'set null' }),
    /** Made from a solved ticket ("turn into an article"). */
    sourceTicketId: ulid('source_ticket_id').references(() => supportTickets.id, { onDelete: 'set null' }),
    /** `article` | `guide` (a video and numbered steps with screenshots). */
    kind: varchar('kind', { length: 16 }).notNull().default('article'),
    /** A guide's video and steps: the working copy, and the version readers see. */
    guide: jsonb('guide').$type<JsonObject>(),
    publishedGuide: jsonb('published_guide').$type<JsonObject>(),
    /** The guided tour "show me in the app" starts. */
    tourId: ulid('tour_id').references((): AnyPgColumn => helpTours.id, { onDelete: 'set null' }),
    helpfulYes: integer('helpful_yes').notNull().default(0),
    helpfulNo: integer('helpful_no').notNull().default(0),
    views: integer('views').notNull().default(0),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_help_articles_slug')
      .on(t.locale, t.slug)
      .where(sql`${t.deletedAt} is null`),
    index('ix_help_articles_group').on(t.groupId),
    index('ix_help_articles_status').on(t.status, t.locale),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Legal documents — platform-level (never an account's): terms, privacy, … written in the owner console
// both UI languages, Markdown. The working draft lives on the document; every publish is an immutable version.
export type LegalTextsJson = { title: { he: string; en: string }; body: { he: string; en: string } };

export const legalDocuments = pgTable(
  'legal_documents',
  {
    id: pk(),
    slug: varchar('slug', { length: 60 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Every person accepts each published version (sign-up checkbox, "terms updated" prompt). */
    requiresConsent: boolean('requires_consent').notNull().default(false),
    /** Accepted by the admin who buys a plan, at checkout — not when joining. */
    purchaseConsent: boolean('purchase_consent').notNull().default(false),
    draft: jsonb('draft').$type<LegalTextsJson>().notNull(),
    publishedVersion: integer('published_version'),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ux_legal_documents_slug').on(t.slug)],
);

export const legalDocumentVersions = pgTable(
  'legal_document_versions',
  {
    id: pk(),
    documentId: ulid('document_id')
      .notNull()
      .references(() => legalDocuments.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    texts: jsonb('texts').$type<LegalTextsJson>().notNull(),
    publishedBy: ulid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: ts('published_at').notNull().defaultNow(),
    /** A material change asks everyone to accept again; a minor one does not. */
    material: boolean('material').notNull().default(true),
  },
  (t) => [uniqueIndex('ux_legal_document_versions').on(t.documentId, t.version)],
);

/** Who accepted which published version, when and from where (sign-up, or the prompt after an update). */
export const legalConsents = pgTable(
  'legal_consents',
  {
    id: pk(),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: ulid('document_id')
      .notNull()
      .references(() => legalDocuments.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** `invite` (joining) | `prompt` (after an update) | `signup` (self sign-up, D32) | `checkout` (buying a plan). */
    context: varchar('context', { length: 16 }).notNull(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 300 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_legal_consents').on(t.userId, t.documentId, t.version),
    index('ix_legal_consents_doc').on(t.documentId, t.version),
  ],
);

// Owner guides — platform-level, private to the platform owner: Markdown pages (operating notes, the
// license issuer's runbook …) written in the owner console, never in the repository. Either language may be empty.
export type OwnerGuideTextsJson = { he: string; en: string };

export const ownerGuides = pgTable(
  'owner_guides',
  {
    id: pk(),
    title: jsonb('title').$type<OwnerGuideTextsJson>().notNull(),
    body: jsonb('body').$type<OwnerGuideTextsJson>().notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('ix_owner_guides_order').on(t.sortOrder)],
);

export const helpArticleVersions = pgTable(
  'help_article_versions',
  {
    id: pk(),
    articleId: ulid('article_id')
      .notNull()
      .references(() => helpArticles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** `save` | `publish` | `restore`. */
    kind: varchar('kind', { length: 16 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    content: jsonb('content').$type<JsonObject>().notNull(),
    /** A guide's video and steps at this version. */
    guide: jsonb('guide').$type<JsonObject>(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_help_article_versions_article').on(t.articleId, t.version)],
);

/**
 * Guided tours: platform content written in the owner console — a screen (`route`), who it is for
 * how it starts and its steps (each pointing at a `data-tour` mark of the app). One row per language.
 */
export const helpTours = pgTable(
  'help_tours',
  {
    id: pk(),
    locale: varchar('locale', { length: 2 }).notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    route: varchar('route', { length: 24 }).notNull(),
    /** `all` | `admins`. */
    audience: varchar('audience', { length: 16 }).notNull().default('all'),
    /** `offer` | `auto` | `menu`. */
    start: varchar('start', { length: 16 }).notNull().default('offer'),
    /** `draft` | `published`. */
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    position: integer('position').notNull().default(0),
    steps: jsonb('steps')
      .$type<JsonObject[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_help_tours_slug')
      .on(t.locale, t.slug)
      .where(sql`${t.deletedAt} is null`),
    index('ix_help_tours_route').on(t.status, t.locale, t.route),
  ],
);

/** What each person did with each tour (finished / closed): a tour is offered once, and can always run again. */
export const helpTourProgress = pgTable(
  'help_tour_progress',
  {
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tourId: ulid('tour_id')
      .notNull()
      .references(() => helpTours.id, { onDelete: 'cascade' }),
    /** `done` | `dismissed`. */
    state: varchar('state', { length: 16 }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tourId] })],
);

/**
 * Passages of the published articles, searched like `knowledge_chunks` (`simple` config + the Hebrew one-letter
 * prefix strip), the title weighted above the body. Feeds both the search and the help assistant.
 *
 * Kept apart from `knowledge_chunks` on purpose (decision d): help articles are platform-wide
 * (no account), carry a title weighted above the body, and are re-chunked only when an article is published,
 * while `knowledge_chunks` belong to one account's agent sources and are re-indexed on that account's edits.
 * One shared table would mix account-scoped and platform-wide rows under one index and one isolation rule.
 *
 * The `\\1\\2` below is escaped on purpose: inside a tagged template `\1` is an invalid escape whose cooked
 * string is undefined, so the expression would reach drizzle-kit empty.
 */
export const helpChunks = pgTable(
  'help_chunks',
  {
    id: pk(),
    articleId: ulid('article_id')
      .notNull()
      .references(() => helpArticles.id, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', title || ' ' || regexp_replace(title, '(^|[^א-ת])[והבלמשכ]([א-ת]{2,})', '\\1\\2', 'g')), 'A') || setweight(to_tsvector('simple', body || ' ' || regexp_replace(body, '(^|[^א-ת])[והבלמשכ]([א-ת]{2,})', '\\1\\2', 'g')), 'B')`,
    ),
  },
  (t) => [index('ix_help_chunks_article').on(t.articleId, t.ord), index('ix_help_chunks_tsv').using('gin', t.tsv)],
);

/** What readers did (metrics): searches (and the ones that found nothing), views, "did this help?", deflections. */
export const helpEvents = pgTable(
  'help_events',
  {
    id: pk(),
    kind: varchar('kind', { length: 24 }).notNull(),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'set null' }),
    articleId: ulid('article_id').references(() => helpArticles.id, { onDelete: 'set null' }),
    query: varchar('query', { length: 200 }),
    locale: varchar('locale', { length: 2 }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_help_events_kind').on(t.kind, t.createdAt), index('ix_help_events_article').on(t.articleId)],
);

/**
 * Images of help articles (kb-import): platform storage under `platform/help/`, never an account's file. One row per
 * distinct content (sha256), so the same screenshot imported twice is stored once. Served by a public redirect
 * (GET /help/assets/{id}) to a short-lived signed link.
 */
export const helpAssets = pgTable(
  'help_assets',
  {
    id: pk(),
    storageKey: varchar('storage_key', { length: 200 }).notNull(),
    contentType: varchar('content_type', { length: 40 }).notNull(),
    size: integer('size').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    width: integer('width'),
    height: integer('height'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_help_assets_sha256').on(t.sha256)],
);

/**
 * Custom senders waiting for the platform owner (S-46): an account admin's email sender name / Reply-To / SMS
 * sender id. The account's settings hold only approved values; a request is `pending` until the owner approves
 * (the value is written into the settings) or rejects it (with a reason). `cancelled` = replaced or withdrawn.
 */
export const senderRequests = pgTable(
  'sender_requests',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    value: varchar('value', { length: 320 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    reason: text('reason'),
    requestedBy: ulid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: ulid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_sender_requests_account').on(t.accountId, t.kind, t.createdAt.desc()),
    index('ix_sender_requests_status').on(t.status, t.createdAt),
  ],
);

export const importJobs = pgTable('import_jobs', {
  id: pk(),
  accountId: ulid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  source: varchar('source', { length: 16 }).notNull().default('file'),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  config: jsonb('config').$type<JsonObject>().notNull().default(emptyJson),
  progress: jsonb('progress').$type<JsonObject>().notNull().default(emptyJson),
  idMap: jsonb('id_map').$type<JsonObject>().notNull().default(emptyJson),
  log: jsonb('log').$type<JsonArray>().notNull().default(emptyArray),
  error: text('error'),
  createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: createdAt(),
});

/**
 * Importers' memory (generic, any source): an id in the source system → the row it became here, so a re-run
 * updates instead of duplicating. `source` = the importer's name; `entity_type` = workspace, board, column, item, view,
 * asset, automation …
 */
export const importRefs = pgTable(
  'import_refs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 32 }).notNull(),
    externalId: varchar('external_id', { length: 191 }).notNull(),
    entityType: varchar('entity_type', { length: 32 }).notNull(),
    entityId: ulid('entity_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_import_refs_external').on(t.accountId, t.source, t.externalId),
    index('ix_import_refs_entity').on(t.accountId, t.entityType, t.entityId),
  ],
);

// ---------------------------------------------------------------------------
// Docs (M8 ד1, D25) — a workspace object next to boards, edited together live (Yjs)
// ---------------------------------------------------------------------------
// SQL: CHECK (host = 'workspace' OR (board_id IS NOT NULL AND item_id IS NOT NULL AND column_id IS NOT NULL))
export const docs = pgTable(
  'docs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    workspaceId: ulid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    folderId: ulid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    position: text('position').notNull(),
    /** Like boards.kind: main = the workspace, private = invited, shareable = invited, guests too. */
    kind: boardKindEnum('kind').notNull().default('main'),
    host: docHostEnum('host').notNull().default('workspace'),
    /** Only for host = 'cell' (ד2): the cell the doc is in; it then has the item's permissions. */
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id').references(() => columns.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    icon: varchar('icon', { length: 16 }),
    coverAssetId: ulid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    /** The Yjs state — the truth. */
    ydoc: bytea('ydoc'),
    /** ProseMirror JSON derived from `ydoc` on every save (reading, export, rendering without a WebSocket). */
    content: jsonb('content').$type<JsonObject>(),
    /** Plain text derived from `content` (search). */
    textValue: text('text_value').notNull().default(''),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    revision: integer('revision').notNull().default(1),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    deletedAt: ts('deleted_at'),
    /** An imported doc (idempotent import). */
    sourceDocId: bigint('source_doc_id', { mode: 'number' }),
  },
  (t) => [
    index('ix_docs_workspace_folder')
      .on(t.workspaceId, t.folderId, t.position)
      .where(sql`${t.deletedAt} is null`),
    index('ix_docs_account')
      .on(t.accountId)
      .where(sql`${t.deletedAt} is null`),
    index('ix_docs_name_trgm').using('gin', t.name.op('gin_trgm_ops')),
    index('ix_docs_text_trgm').using('gin', t.textValue.op('gin_trgm_ops')),
    uniqueIndex('ux_docs_source')
      .on(t.accountId, t.sourceDocId)
      .where(sql`${t.sourceDocId} is not null`),
  ],
);

/** Who is invited to a doc and how (owner / editor / commenter / viewer): a person or a team. */
export const docMembers = pgTable(
  'doc_members',
  {
    id: pk(),
    docId: ulid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    teamId: ulid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    level: docMemberLevelEnum('level').notNull().default('editor'),
    addedBy: ulid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_doc_members_user')
      .on(t.docId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('ux_doc_members_team')
      .on(t.docId, t.teamId)
      .where(sql`${t.teamId} is not null`),
    index('ix_doc_members_user').on(t.userId),
    index('ix_doc_members_team').on(t.teamId),
  ],
);

/** Files a doc shows (derived from its content on save): they are never orphans while it holds them. */
export const docAssets = pgTable(
  'doc_assets',
  {
    docId: ulid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    assetId: ulid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.assetId] }), index('ix_doc_assets_asset').on(t.assetId)],
);

/**
 * A doc's versions (M8 ד3): automatic snapshots (after editing, at most every 30 minutes of it) and named ones.
 * Restoring one makes a new version — history is never rewritten.
 */
export const docVersions = pgTable(
  'doc_versions',
  {
    id: pk(),
    docId: ulid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    ydoc: bytea('ydoc').notNull(),
    content: jsonb('content').$type<JsonObject>(),
    textValue: text('text_value').notNull().default(''),
    /** Null for an automatic snapshot. */
    label: varchar('label', { length: 120 }),
    auto: boolean('auto').notNull().default(true),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_doc_versions_doc').on(t.docId, t.createdAt.desc())],
);

/** A comment thread on one block of a doc (M8 ד3): anchored by the block's id + the text it quoted. */
export const docCommentThreads = pgTable(
  'doc_comment_threads',
  {
    id: pk(),
    docId: ulid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    blockId: varchar('block_id', { length: 64 }).notNull(),
    quote: text('quote').notNull().default(''),
    resolvedAt: ts('resolved_at'),
    resolvedBy: ulid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_doc_comment_threads_doc')
      .on(t.docId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const docComments = pgTable(
  'doc_comments',
  {
    id: pk(),
    threadId: ulid('thread_id')
      .notNull()
      .references(() => docCommentThreads.id, { onDelete: 'cascade' }),
    docId: ulid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** ProseMirror JSON, like an update's body (rendered through the shared allowlist). */
    body: jsonb('body').$type<JsonObject>().notNull(),
    textValue: text('text_value').notNull().default(''),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('ix_doc_comments_thread').on(t.threadId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Relations (query API). Only the ones the API/worker actually traverse.
// ---------------------------------------------------------------------------
export const accountsRelations = relations(accounts, ({ many, one }) => ({
  members: many(accountMembers),
  teams: many(teams),
  workspaces: many(workspaces),
  boards: many(boards),
  settings: one(accountSettings, { fields: [accounts.id], references: [accountSettings.accountId] }),
}));

export const usersRelations = relations(users, ({ many, one }) => ({
  memberships: many(accountMembers),
  teamMemberships: many(teamMembers),
  boardMemberships: many(boardMembers),
  notifications: many(notifications),
  profileSettings: one(userProfileSettings, { fields: [users.id], references: [userProfileSettings.userId] }),
}));

export const accountMembersRelations = relations(accountMembers, ({ one }) => ({
  account: one(accounts, { fields: [accountMembers.accountId], references: [accounts.id] }),
  user: one(users, { fields: [accountMembers.userId], references: [users.id] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  account: one(accounts, { fields: [teams.accountId], references: [accounts.id] }),
  parent: one(teams, { fields: [teams.parentTeamId], references: [teams.id], relationName: 'team_parent' }),
  children: many(teams, { relationName: 'team_parent' }),
  members: many(teamMembers),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  account: one(accounts, { fields: [workspaces.accountId], references: [accounts.id] }),
  members: many(workspaceMembers),
  folders: many(folders),
  boards: many(boards),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceMembers.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
  team: one(teams, { fields: [workspaceMembers.teamId], references: [teams.id] }),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [folders.workspaceId], references: [workspaces.id] }),
  parent: one(folders, { fields: [folders.parentFolderId], references: [folders.id], relationName: 'folder_parent' }),
  children: many(folders, { relationName: 'folder_parent' }),
  boards: many(boards),
}));

export const boardsRelations = relations(boards, ({ one, many }) => ({
  account: one(accounts, { fields: [boards.accountId], references: [accounts.id] }),
  workspace: one(workspaces, { fields: [boards.workspaceId], references: [workspaces.id] }),
  folder: one(folders, { fields: [boards.folderId], references: [folders.id] }),
  assigneeColumn: one(columns, {
    fields: [boards.assigneeColumnId],
    references: [columns.id],
    relationName: 'board_assignee',
  }),
  members: many(boardMembers),
  teamMembers: many(boardTeamMembers),
  groups: many(groups),
  columns: many(columns, { relationName: 'board_columns' }),
  items: many(items),
  views: many(views),
  automations: many(automations),
  webhooks: many(webhooks),
}));

export const boardMembersRelations = relations(boardMembers, ({ one }) => ({
  board: one(boards, { fields: [boardMembers.boardId], references: [boards.id] }),
  user: one(users, { fields: [boardMembers.userId], references: [users.id] }),
}));

export const boardTeamMembersRelations = relations(boardTeamMembers, ({ one }) => ({
  board: one(boards, { fields: [boardTeamMembers.boardId], references: [boards.id] }),
  team: one(teams, { fields: [boardTeamMembers.teamId], references: [teams.id] }),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  board: one(boards, { fields: [groups.boardId], references: [boards.id] }),
  items: many(items),
}));

export const columnsRelations = relations(columns, ({ one, many }) => ({
  board: one(boards, { fields: [columns.boardId], references: [boards.id], relationName: 'board_columns' }),
  cells: many(cells),
  links: many(itemLinks),
  itemKey: one(itemKeys, { fields: [columns.id], references: [itemKeys.columnId] }),
}));

export const itemsRelations = relations(items, ({ one, many }) => ({
  board: one(boards, { fields: [items.boardId], references: [boards.id] }),
  group: one(groups, { fields: [items.groupId], references: [groups.id] }),
  parent: one(items, { fields: [items.parentItemId], references: [items.id], relationName: 'item_parent' }),
  children: many(items, { relationName: 'item_parent' }),
  root: one(items, { fields: [items.rootItemId], references: [items.id], relationName: 'item_root' }),
  descendants: many(items, { relationName: 'item_root' }),
  creator: one(users, { fields: [items.createdBy], references: [users.id] }),
  cells: many(cells),
  outgoingLinks: many(itemLinks, { relationName: 'link_from' }),
  incomingLinks: many(itemLinks, { relationName: 'link_to' }),
  updates: many(updates),
  tags: many(itemTags),
  timeEntries: many(timeEntries),
}));

export const cellsRelations = relations(cells, ({ one, many }) => ({
  item: one(items, { fields: [cells.itemId], references: [items.id] }),
  column: one(columns, { fields: [cells.columnId], references: [columns.id] }),
  updatedByUser: one(users, { fields: [cells.updatedBy], references: [users.id] }),
  files: many(cellFiles),
}));

export const itemLinksRelations = relations(itemLinks, ({ one }) => ({
  column: one(columns, { fields: [itemLinks.columnId], references: [columns.id] }),
  from: one(items, { fields: [itemLinks.fromItemId], references: [items.id], relationName: 'link_from' }),
  to: one(items, { fields: [itemLinks.toItemId], references: [items.id], relationName: 'link_to' }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  items: many(itemTags),
}));

export const itemTagsRelations = relations(itemTags, ({ one }) => ({
  item: one(items, { fields: [itemTags.itemId], references: [items.id] }),
  tag: one(tags, { fields: [itemTags.tagId], references: [tags.id] }),
  column: one(columns, { fields: [itemTags.columnId], references: [columns.id] }),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  item: one(items, { fields: [timeEntries.itemId], references: [items.id] }),
  column: one(columns, { fields: [timeEntries.columnId], references: [columns.id] }),
}));

export const itemKeysRelations = relations(itemKeys, ({ one }) => ({
  board: one(boards, { fields: [itemKeys.boardId], references: [boards.id] }),
  column: one(columns, { fields: [itemKeys.columnId], references: [columns.id] }),
}));

export const updatesRelations = relations(updates, ({ one, many }) => ({
  item: one(items, { fields: [updates.itemId], references: [items.id] }),
  board: one(boards, { fields: [updates.boardId], references: [boards.id] }),
  parent: one(updates, { fields: [updates.parentUpdateId], references: [updates.id], relationName: 'update_parent' }),
  replies: many(updates, { relationName: 'update_parent' }),
  author: one(users, { fields: [updates.createdBy], references: [users.id] }),
  mentions: many(updateMentions),
  likes: many(updateLikes),
  files: many(updateFiles),
}));

export const updateMentionsRelations = relations(updateMentions, ({ one }) => ({
  update: one(updates, { fields: [updateMentions.updateId], references: [updates.id] }),
  user: one(users, { fields: [updateMentions.userId], references: [users.id] }),
  team: one(teams, { fields: [updateMentions.teamId], references: [teams.id] }),
}));

export const updateLikesRelations = relations(updateLikes, ({ one }) => ({
  update: one(updates, { fields: [updateLikes.updateId], references: [updates.id] }),
  user: one(users, { fields: [updateLikes.userId], references: [users.id] }),
}));

export const assetsRelations = relations(assets, ({ one, many }) => ({
  owner: one(users, { fields: [assets.ownerId], references: [users.id] }),
  parent: one(assets, { fields: [assets.parentAssetId], references: [assets.id], relationName: 'asset_versions' }),
  versions: many(assets, { relationName: 'asset_versions' }),
  cellFiles: many(cellFiles),
  updateFiles: many(updateFiles),
}));

export const cellFilesRelations = relations(cellFiles, ({ one }) => ({
  cell: one(cells, { fields: [cellFiles.itemId, cellFiles.columnId], references: [cells.itemId, cells.columnId] }),
  asset: one(assets, { fields: [cellFiles.assetId], references: [assets.id] }),
}));

export const updateFilesRelations = relations(updateFiles, ({ one }) => ({
  update: one(updates, { fields: [updateFiles.updateId], references: [updates.id] }),
  asset: one(assets, { fields: [updateFiles.assetId], references: [assets.id] }),
}));

export const viewsRelations = relations(views, ({ one }) => ({
  board: one(boards, { fields: [views.boardId], references: [boards.id] }),
  form: one(forms, { fields: [views.id], references: [forms.viewId] }),
}));

export const formsRelations = relations(forms, ({ one, many }) => ({
  board: one(boards, { fields: [forms.boardId], references: [boards.id] }),
  view: one(views, { fields: [forms.viewId], references: [views.id] }),
  targetGroup: one(groups, { fields: [forms.targetGroupId], references: [groups.id] }),
  submissions: many(formSubmissions),
}));

export const formSubmissionsRelations = relations(formSubmissions, ({ one }) => ({
  form: one(forms, { fields: [formSubmissions.formId], references: [forms.id] }),
  item: one(items, { fields: [formSubmissions.itemId], references: [items.id] }),
}));

export const automationsRelations = relations(automations, ({ one, many }) => ({
  board: one(boards, { fields: [automations.boardId], references: [boards.id] }),
  owner: one(users, { fields: [automations.ownerId], references: [users.id] }),
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(automationRuns, ({ one }) => ({
  automation: one(automations, { fields: [automationRuns.automationId], references: [automations.id] }),
  item: one(items, { fields: [automationRuns.itemId], references: [items.id] }),
}));

export const webhooksRelations = relations(webhooks, ({ one, many }) => ({
  board: one(boards, { fields: [webhooks.boardId], references: [boards.id] }),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  webhook: one(webhooks, { fields: [webhookDeliveries.webhookId], references: [webhooks.id] }),
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  account: one(accounts, { fields: [apiTokens.accountId], references: [accounts.id] }),
  user: one(users, { fields: [apiTokens.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  actor: one(users, { fields: [notifications.actorId], references: [users.id] }),
  board: one(boards, { fields: [notifications.boardId], references: [boards.id] }),
  item: one(items, { fields: [notifications.itemId], references: [items.id] }),
  update: one(updates, { fields: [notifications.updateId], references: [updates.id] }),
}));

export const templatesRelations = relations(templates, ({ one, many }) => ({
  account: one(accounts, { fields: [templates.accountId], references: [accounts.id] }),
  sourceBoard: one(boards, { fields: [templates.sourceBoardId], references: [boards.id] }),
  boards: many(boards),
}));

export const trashEntriesRelations = relations(trashEntries, ({ one, many }) => ({
  parent: one(trashEntries, {
    fields: [trashEntries.parentEntryId],
    references: [trashEntries.id],
    relationName: 'trash_parent',
  }),
  children: many(trashEntries, { relationName: 'trash_parent' }),
  deletedByUser: one(users, { fields: [trashEntries.deletedBy], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// OAuth 2.1 for MCP (the planning notes "AGENTS-MCP" §4, מ5; D26): our own small authorization server for remote AI apps
// (Claude.ai, ChatGPT). Every secret (client secret, authorization code, access / refresh token) is stored as its
// SHA-256 only. A connection = one user × one account (D12) × the scopes and boards chosen on the consent screen.
// ---------------------------------------------------------------------------

/**
 * OAuth clients: registered dynamically (RFC 7591, `kind = 'dcr'`, a random client_id) or known by their Client ID
 * Metadata Document (`kind = 'cimd'`, the client_id is the document's https URL; the fetched metadata is cached here).
 * Platform-wide, like the auth tables: a client is not an account's — the connection is.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: pk(),
    clientId: varchar('client_id', { length: 512 }).notNull(),
    kind: varchar('kind', { length: 8 }).notNull(),
    clientName: varchar('client_name', { length: 120 }).notNull(),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    /** none (public, PKCE only) / client_secret_post / client_secret_basic. */
    authMethod: varchar('auth_method', { length: 32 }).notNull().default('none'),
    secretHash: varchar('secret_hash', { length: 128 }),
    /** CIMD: when the metadata document was fetched and until when the copy is fresh. */
    fetchedAt: ts('fetched_at'),
    freshUntil: ts('fresh_until'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_oauth_clients_client_id').on(t.clientId)],
);

/**
 * One authorization request: created by GET /oauth/authorize (validated client + redirect URI + PKCE challenge),
 * decided on the consent screen (account, scopes, boards), then holds the one-time code until it is exchanged.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: pk(),
    clientPk: ulid('client_pk')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    state: text('state').notNull(),
    codeChallenge: varchar('code_challenge', { length: 128 }).notNull(),
    requestedScopes: jsonb('requested_scopes').$type<string[]>().notNull(),
    resource: text('resource').notNull(),
    /** pending → approved (code issued) → used; or denied. */
    status: varchar('status', { length: 12 }).notNull().default('pending'),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>(),
    boardIds: jsonb('board_ids').$type<string[]>(),
    codeHash: varchar('code_hash', { length: 128 }),
    codeExpiresAt: ts('code_expires_at'),
    /** The connection the code was exchanged for (a replayed code revokes it). */
    connectionId: ulid('connection_id'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_oauth_grants_code').on(t.codeHash), index('ix_oauth_grants_expires').on(t.expiresAt)],
);

/** A connected AI app: one user in one account (D12), with the consented scopes and (optionally) boards. */
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientPk: ulid('client_pk')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    clientName: varchar('client_name', { length: 120 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    /** null = every board the user can see. */
    boardIds: jsonb('board_ids').$type<string[]>(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: ulid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_mcp_connections_account')
      .on(t.accountId, t.userId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/** Access tokens (1 hour, bound to the `/mcp` resource) and rotating refresh tokens of a connection — hashes only. */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    connectionId: ulid('connection_id')
      .notNull()
      .references(() => mcpConnections.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 8 }).notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    /** The audience (RFC 8707): the canonical MCP server URL the token was issued for. */
    resource: text('resource').notNull(),
    expiresAt: ts('expires_at').notNull(),
    /** Refresh tokens: set when rotated — presenting it again is a replay and revokes the connection. */
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_oauth_tokens_hash').on(t.tokenHash), index('ix_oauth_tokens_connection').on(t.connectionId)],
);

// ---------------------------------------------------------------------------
// Dashboards (M8 ד4–ד5)
// ---------------------------------------------------------------------------
/** A dashboard in a workspace (sidebar, folders, trash) — widgets reading several boards. */
export const dashboards = pgTable(
  'dashboards',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    workspaceId: ulid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    folderId: ulid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    position: text('position').notNull(),
    /** main = the whole workspace sees it, private = only who is invited (D25: no guests yet). */
    kind: boardKindEnum('kind').notNull().default('main'),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description').notNull().default(''),
    icon: varchar('icon', { length: 16 }),
    /** { board_ids, filter } — see `dashboardSettingsSchema`. */
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    revision: integer('revision').notNull().default(1),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_dashboards_workspace_folder')
      .on(t.workspaceId, t.folderId, t.position)
      .where(sql`${t.deletedAt} is null`),
    index('ix_dashboards_account')
      .on(t.accountId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const dashboardMembers = pgTable(
  'dashboard_members',
  {
    id: pk(),
    dashboardId: ulid('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    teamId: ulid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    level: dashboardMemberLevelEnum('level').notNull().default('viewer'),
    addedBy: ulid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_dashboard_members_user')
      .on(t.dashboardId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('ux_dashboard_members_team')
      .on(t.dashboardId, t.teamId)
      .where(sql`${t.teamId} is not null`),
    index('ix_dashboard_members_user').on(t.userId),
    index('ix_dashboard_members_team').on(t.teamId),
  ],
);

/** A widget of a dashboard: a registry type (`packages/shared/src/widgets`), its place on the grid, its settings. */
export const dashboardWidgets = pgTable(
  'dashboard_widgets',
  {
    id: pk(),
    dashboardId: ulid('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 40 }).notNull(),
    title: varchar('title', { length: 255 }).notNull().default(''),
    /** {x, y, w, h} on the 12-column grid. */
    position: jsonb('position').$type<JsonObject>().notNull(),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_dashboard_widgets_dashboard')
      .on(t.dashboardId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * Scheduled cleaning (M8 ד13): one row per run of an account's tidy rules — by the daily job, by an admin's "run
 * now", or a dry run (counts only). `results` = per rule {rule, count, error?}; `details` = what was touched (capped)
 * for the CSV.
 */
export const tidyRuns = pgTable(
  'tidy_runs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** schedule | manual */
    trigger: varchar('trigger', { length: 16 }).notNull(),
    dryRun: boolean('dry_run').notNull().default(false),
    /** succeeded | partial | failed */
    status: varchar('status', { length: 16 }).notNull(),
    results: jsonb('results')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    details: jsonb('details')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    actorId: ulid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_tidy_runs_account_created').on(t.accountId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Maps (M8 ד10): geocoded addresses and the account's geocoding key
// ---------------------------------------------------------------------------
/** One geocoder answer per account and address (normalised): an address is looked up once (Nominatim policy). */
export const geocodeCache = pgTable(
  'geocode_cache',
  {
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    query: varchar('query', { length: 500 }).notNull(),
    provider: varchar('provider', { length: 16 }).notNull(),
    found: boolean('found').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    countryCode: varchar('country_code', { length: 2 }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.query] })],
);

/** The account's Google Places key (sealed, write-only) — address completion while typing (03 §3.6). */
export const accountGeo = pgTable('account_geo', {
  accountId: ulid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  googleKey: text('google_key'),
  googleKeyHint: varchar('google_key_hint', { length: 16 }),
  updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

/**
 * An account's web search service for its agents: Brave Search or Tavily, the key sealed with
 * SECRETS_KEY (write-only — never returned), and the limits per agent run and per day.
 */
export const accountWebSearch = pgTable('account_web_search', {
  accountId: ulid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 16 }),
  keyEnc: text('key_enc'),
  keyHint: varchar('key_hint', { length: 16 }),
  maxPerRun: integer('max_per_run').notNull().default(10),
  maxPerDay: integer('max_per_day').notNull().default(200),
  updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// AI columns (מ11) and the AI assistant panel (מ12) — the planning notes "AGENTS-MCP", D26
// ---------------------------------------------------------------------------

/**
 * One fill of an AI column: a cell button, "run on all / empty", the batch bar, or an auto-run after its inputs
 * changed. Every write of a run is one batch (`batch_id`) — undone at once from the toast or the activity log.
 */
export const aiColumnRuns = pgTable(
  'ai_column_runs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    requestedBy: ulid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** manual | auto */
    trigger: varchar('trigger', { length: 16 }).notNull().default('manual'),
    /** items | empty | all */
    mode: varchar('mode', { length: 16 }).notNull().default('items'),
    /** The items to fill (resolved when the run was asked for). */
    itemIds: jsonb('item_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    total: integer('total').notNull().default(0),
    done: integer('done').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    stopped: varchar('stopped', { length: 40 }),
    batchId: ulid('batch_id'),
    errors: jsonb('errors')
      .$type<{ item_id: string; error: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Asked through a board-limited API token / MCP connection (S-64): the queued run sees only these boards. */
    boardLimit: jsonb('board_limit').$type<string[]>(),
    /** …and with that token's scopes (null = a signed-in person): e.g. no updates read without `updates:read`. */
    tokenScopes: jsonb('token_scopes').$type<string[]>(),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('ix_ai_column_runs_column').on(t.columnId, t.createdAt.desc())],
);

/** An AI column's spend per month (its own limit, next to the account budget). */
export const aiColumnUsage = pgTable(
  'ai_column_usage',
  {
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    month: varchar('month', { length: 7 }).notNull(),
    calls: integer('calls').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.columnId, t.month] })],
);

/**
 * Auto-run debounce: a change of an input column (re)sets `due_at`; a cell runs once its inputs stopped changing.
 * `actor_id` = who changed it last (the run acts with their rights).
 */
export const aiColumnPending = pgTable(
  'ai_column_pending',
  {
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    actorId: ulid('actor_id').references(() => users.id, { onDelete: 'cascade' }),
    /** The last change came through a board-limited token / MCP connection (S-64): the auto-run keeps that limit. */
    boardLimit: jsonb('board_limit').$type<string[]>(),
    tokenScopes: jsonb('token_scopes').$type<string[]>(),
    dueAt: ts('due_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.columnId] }), index('ix_ai_column_pending_due').on(t.dueAt)],
);

/**
 * A person's chat with the assistant about a board or an item (their own; deletable). or about a
 * document / a dashboard / nothing (the whole account), and with one of the account's agents instead of the
 * assistant (`agent_id`).
 */
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    docId: ulid('doc_id').references(() => docs.id, { onDelete: 'cascade' }),
    dashboardId: ulid('dashboard_id').references(() => dashboards.id, { onDelete: 'cascade' }),
    agentId: ulid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 120 }).notNull().default(''),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_ai_conversations_user')
      .on(t.accountId, t.userId, t.boardId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * One message of a chat. `content` = the model transcript of the message, append-only (preserved thinking: sent
 * back exactly as it came): a user message's turn, or an answer's model turns + tool results. `actions` = the
 * write calls waiting for / decided by the person.
 */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    conversationId: ulid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: varchar('role', { length: 16 }).notNull(),
    text: text('text').notNull().default(''),
    content: jsonb('content')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    reads: jsonb('reads')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    actions: jsonb('actions')
      .$type<JsonObject[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    error: varchar('error', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_ai_messages_seq').on(t.conversationId, t.seq)],
);

/**
 * Files a person attached to a chat message (pasted images, PDFs, documents — like the updates
 * composer). The message's stored transcript names each file by id; its bytes are read from storage when the
 * conversation is sent to the model. A file linked here is in use (the orphan-file sweep keeps it).
 */
export const aiMessageFiles = pgTable(
  'ai_message_files',
  {
    messageId: ulid('message_id')
      .notNull()
      .references(() => aiMessages.id, { onDelete: 'cascade' }),
    assetId: ulid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.assetId] }), index('ix_ai_message_files_asset').on(t.assetId)],
);

// ---------------------------------------------------------------------------
// Extensions — "תוספות" (D27, the planning notes "MARKETPLACE" ת0–ת2)
// ---------------------------------------------------------------------------

/**
 * An extension's manifest as known here: the platform catalog (`account_id` null — seed/packs, upserted by key)
 * or one an account's admin added by URL / pasted JSON (private to that account). Installing it in an account =
 * an `extension_installations` row.
 */
export const extensions = pgTable(
  'extensions',
  {
    id: pk(),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'cascade' }), // null = platform catalog
    key: varchar('key', { length: 48 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    version: varchar('version', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 8 }).notNull(), // data | code
    manifest: jsonb('manifest').$type<JsonObject>().notNull(),
    /** Where the manifest was fetched from (an update check re-fetches it); null = pasted or seeded. */
    sourceUrl: text('source_url'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** ת7: the platform owner's §8 security review a catalog entry was published with (null = seeded pack). */
    review: jsonb('review').$type<JsonObject>(),
    publishedBy: ulid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: ts('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_extensions_scope_key')
      .on(sql`coalesce(${t.accountId}, '')`, t.key)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * Earlier versions of a platform catalog entry (M11 stage 3, starter kits as data): every save of a starter kit in
 * the owner console keeps the manifest it replaced, so a kit can be compared and restored. Platform-level.
 */
export const catalogVersions = pgTable(
  'catalog_versions',
  {
    id: pk(),
    key: varchar('key', { length: 48 }).notNull(),
    version: varchar('version', { length: 64 }).notNull(),
    manifest: jsonb('manifest').$type<JsonObject>().notNull(),
    /** What the save did (created / edited / restored / from_boards). */
    note: varchar('note', { length: 255 }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_catalog_versions_key').on(t.key, t.createdAt)],
);

/**
 * An extension installed in an account, with the admin's consent: the approved manifest (what runs is always this
 * one — a newer version that asks for more waits in `pending_manifest`), the granted scopes, boards and guests.
 * One row per account and key: uninstalling keeps it (`uninstalled_at`) so a reinstall never duplicates a pack.
 */
export const extensionInstallations = pgTable(
  'extension_installations',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    extensionId: ulid('extension_id')
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 48 }).notNull(),
    version: varchar('version', { length: 64 }).notNull(),
    manifest: jsonb('manifest').$type<JsonObject>().notNull(),
    source: varchar('source', { length: 12 }).notNull(), // url | manifest | catalog
    grantedScopes: jsonb('granted_scopes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** null = every board the user can see. */
    boardIds: jsonb('board_ids').$type<string[]>(),
    allowGuests: boolean('allow_guests').notNull().default(false),
    status: varchar('status', { length: 12 }).notNull().default('enabled'), // enabled | disabled
    pendingManifest: jsonb('pending_manifest').$type<JsonObject>(),
    /** What a data pack created here (workspace, boards, templates, automations) — so a reinstall adds nothing twice. */
    state: jsonb('state').$type<JsonObject>().notNull().default(emptyJson),
    consentedBy: ulid('consented_by').references(() => users.id, { onDelete: 'set null' }),
    consentedAt: ts('consented_at'),
    installedBy: ulid('installed_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The installation's ONE signing secret (sealed, lib/secrets; ext-signing.ts): it signs our automation calls (ת4)
     * and lifecycle webhooks (ת6), and checks the triggers its server fires. Made on first need, or issued with the
     * server credentials (and delivered in `installed`); rotated by an admin; cleared on uninstall.
     */
    signingSecret: text('signing_secret'),
    // ---- ת6: versions ----
    /** Stay on this version: the daily check only reports newer ones (as pending). */
    versionLocked: boolean('version_locked').notNull().default(false),
    /** A version asking for nothing new applies by itself (off = it waits like one that asks for more). */
    autoUpdate: boolean('auto_update').notNull().default(true),
    lastCheckedAt: ts('last_checked_at'),
    checkError: varchar('check_error', { length: 120 }),
    // ---- ת6: the extension's own server (manifest `server`) ----
    /** The extension service user its server acts as (is_service, a member of the account). */
    serviceUserId: ulid('service_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** OAuth client credentials (client_credentials at /oauth/token): the id, the secret's SHA-256. */
    serverClientId: varchar('server_client_id', { length: 64 }),
    serverSecretHash: varchar('server_secret_hash', { length: 64 }),
    serverStatus: varchar('server_status', { length: 12 }), // pending | connected | failed
    serverError: varchar('server_error', { length: 200 }),
    serverEvent: varchar('server_event', { length: 16 }),
    serverEventAt: ts('server_event_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    uninstalledAt: ts('uninstalled_at'),
  },
  (t) => [
    uniqueIndex('ux_extension_installations_key').on(t.accountId, t.key),
    index('ix_extension_installations_extension').on(t.extensionId),
    uniqueIndex('ux_extension_installations_client').on(t.serverClientId),
  ],
);

/**
 * An extension's own storage (ת5, `/ext/storage`): key → JSON per installation (`user_id` null, shared by its
 * users) or per installation × user. Size-capped per installation (EXT_STORAGE_QUOTA_BYTES); kept on uninstall
 * (a reinstall reuses the installation row) and gone with the account.
 */
export const extensionStorage = pgTable(
  'extension_storage',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    installationId: ulid('installation_id')
      .notNull()
      .references(() => extensionInstallations.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 200 }).notNull(),
    value: jsonb('value').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_extension_storage_key').on(t.installationId, sql`coalesce(${t.userId}, '')`, t.key),
    index('ix_extension_storage_account').on(t.accountId),
  ],
);

/**
 * the count beside an extension's sidebar page (`app_page`) — the account's (`user_id` null) or one
 * member's (wins over the account's). Set by the extension (its server or its page); gone with the installation.
 */
export const extensionAppPageBadges = pgTable(
  'extension_app_page_badges',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    installationId: ulid('installation_id')
      .notNull()
      .references(() => extensionInstallations.id, { onDelete: 'cascade' }),
    feature: varchar('feature', { length: 40 }).notNull(),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    count: integer('count').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_extension_app_page_badges').on(t.installationId, t.feature, sql`coalesce(${t.userId}, '')`),
    index('ix_extension_app_page_badges_account').on(t.accountId),
  ],
);

/** The platform owner's emergency kill switch (ת7 §8): an extension key switched off in every account at once. */
export const extensionKills = pgTable('extension_kills', {
  key: varchar('key', { length: 48 }).primaryKey(),
  reason: text('reason').notNull(),
  killedBy: ulid('killed_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** ת6: every manifest an installation ran (installed, auto-updated, approved, rolled back) — "back to a version". */
export const extensionVersions = pgTable(
  'extension_versions',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    installationId: ulid('installation_id')
      .notNull()
      .references(() => extensionInstallations.id, { onDelete: 'cascade' }),
    version: varchar('version', { length: 64 }).notNull(),
    manifest: jsonb('manifest').$type<JsonObject>().notNull(),
    via: varchar('via', { length: 12 }).notNull(), // installed | auto | approved | manual | rollback
    appliedBy: ulid('applied_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_extension_versions_installation').on(t.installationId, t.createdAt)],
);

/**
 * ת6: access tokens of extension servers (OAuth client_credentials) — the SHA-256 only, an hour long, acting as the
 * installation's service user; uninstalling, disabling or the kill switch stop them at once (checked per request).
 */
export const extensionServerTokens = pgTable(
  'extension_server_tokens',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    installationId: ulid('installation_id')
      .notNull()
      .references(() => extensionInstallations.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** The scopes it was asked for (a narrower `scope` at /oauth/token, EXT-RT16); null = the whole grant. */
    scopes: jsonb('scopes').$type<string[]>(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ux_extension_server_tokens_hash').on(t.tokenHash),
    index('ix_extension_server_tokens_installation').on(t.installationId),
  ],
);

/**
 * מ10 — outbound MCP: an external MCP server an account's admin registered. Credentials are sealed (lib/secrets);
 * `tools` is the last `tools/list`, `tool_policy` the admin's choice per tool (`{enabled, approval}` — off until
 * enabled, approval on by default).
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 16 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    url: text('url').notNull(),
    authKind: varchar('auth_kind', { length: 16 }).notNull().default('none'), // none | bearer | oauth_client
    /** The bearer token or the OAuth client secret, sealed. */
    secretEnc: text('secret_enc'),
    secretHint: varchar('secret_hint', { length: 12 }),
    /** OAuth client: `{token_url, client_id, scope}` (the secret is `secret_enc`). */
    oauth: jsonb('oauth').$type<JsonObject>(),
    enabled: boolean('enabled').notNull().default(true),
    tools: jsonb('tools')
      .$type<JsonObject[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    toolPolicy: jsonb('tool_policy').$type<JsonObject>().notNull().default(emptyJson),
    status: varchar('status', { length: 12 }).notNull().default('unknown'), // unknown | ok | error
    lastError: varchar('last_error', { length: 300 }),
    refreshedAt: ts('refreshed_at'),
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    maxCallsPerHour: integer('max_calls_per_hour').notNull().default(120),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('ux_mcp_servers_key')
      .on(t.accountId, t.key)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------
// External automation platforms — "זרימות": n8n / Make / Zapier connections of an account
// ---------------------------------------------------------------------------
export const flowConnections = pgTable(
  'flow_connections',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 16 }).notNull(), // n8n | make | zapier
    name: varchar('name', { length: 120 }).notNull(),
    /** Where it lives, never secret: n8n `{base_url}`, Make `{zone, team_id}`, Zapier `{}`. */
    config: jsonb('config').$type<JsonObject>().notNull().default(emptyJson),
    /** The API key / token, sealed (lib/secrets). */
    secretEnc: text('secret_enc'),
    secretHint: varchar('secret_hint', { length: 12 }),
    /** flowConnectionSettingsSchema (visibility, AI, alerts, check interval, hourly cap). */
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    enabled: boolean('enabled').notNull().default(true),
    status: varchar('status', { length: 12 }).notNull().default('unknown'), // unknown | ok | error
    lastError: varchar('last_error', { length: 300 }),
    checkedAt: ts('checked_at'),
    /** Failures that started before this are history (no alert for them). */
    monitorSince: ts('monitor_since').notNull().defaultNow(),
    /** The last failure check (the worker's interval is per connection). */
    lastPolledAt: ts('last_polled_at'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_flow_connections_account')
      .on(t.accountId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** One row per failed run that was alerted on — the dedupe of the failure check. */
export const flowFailureAlerts = pgTable(
  'flow_failure_alerts',
  {
    connectionId: ulid('connection_id')
      .notNull()
      .references(() => flowConnections.id, { onDelete: 'cascade' }),
    runId: varchar('run_id', { length: 64 }).notNull(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    flowId: varchar('flow_id', { length: 64 }),
    createdAt: createdAt(),
    /** The flow ran fine again after this failure (`flow_recovered` automations heard it once). */
    recoveredAt: ts('recovered_at'),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.runId] })],
);

// ---------------------------------------------------------------------------
// Column type conversion (D28, the planning notes "COLUMN-CONVERSION")
// ---------------------------------------------------------------------------
/**
 * One type change of a column (or a restore from its backup): from / to type and settings, the counts, the report
 * of what else it touched (`report.dependents`) and the before-state of those (`report.undo`) so an undo puts
 * everything back. Its cells' original values live in `column_conversion_cells` (kept `backup_days`).
 */
export const columnConversions = pgTable(
  'column_conversions',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    /** convert | restore */
    kind: varchar('kind', { length: 16 }).notNull().default('convert'),
    restoreOf: ulid('restore_of'),
    fromType: varchar('from_type', { length: 32 }).notNull(),
    fromSettings: jsonb('from_settings').$type<JsonObject>().notNull().default(emptyJson),
    toType: varchar('to_type', { length: 32 }).notNull(),
    toSettings: jsonb('to_settings').$type<JsonObject>().notNull().default(emptyJson),
    options: jsonb('options').$type<JsonObject>().notNull().default(emptyJson),
    /** running | done | failed | undone */
    status: varchar('status', { length: 16 }).notNull().default('running'),
    total: integer('total').notNull().default(0),
    done: integer('done').notNull().default(0),
    itemCount: integer('item_count').notNull().default(0),
    converted: integer('converted').notNull().default(0),
    empty: integer('empty').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    partial: integer('partial').notNull().default(0),
    report: jsonb('report').$type<JsonObject>().notNull().default(emptyJson),
    eventId: ulid('event_id'),
    batchId: ulid('batch_id'),
    error: text('error'),
    failedClearedAt: ts('failed_cleared_at'),
    backupPurgedAt: ts('backup_purged_at'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
    undoneAt: ts('undone_at'),
  },
  (t) => [
    index('ix_column_conversions_column').on(t.columnId, t.createdAt.desc()),
    index('ix_column_conversions_board').on(t.boardId, t.createdAt.desc()),
    index('ix_column_conversions_account').on(t.accountId, t.createdAt),
  ],
);

/**
 * The backup of a conversion: every cell that had a value — the original value and its keys (restored by an undo
 * or a restore), and the new value computed for it (the conversion writes it; an undo checks nobody changed it).
 */
export const columnConversionCells = pgTable(
  'column_conversion_cells',
  {
    conversionId: ulid('conversion_id')
      .notNull()
      .references(() => columnConversions.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** converted | empty | failed */
    outcome: varchar('outcome', { length: 10 }).notNull(),
    partial: boolean('partial').notNull().default(false),
    oldValue: jsonb('old_value'),
    oldText: text('old_text'),
    oldNumber: doublePrecision('old_number'),
    oldDate: ts('old_date'),
    oldDateEnd: ts('old_date_end'),
    newValue: jsonb('new_value'),
    newText: text('new_text'),
    newNumber: doublePrecision('new_number'),
    newDate: ts('new_date'),
    newDateEnd: ts('new_date_end'),
  },
  (t) => [
    primaryKey({ columns: [t.conversionId, t.itemId] }),
    index('ix_column_conversion_cells_failed')
      .on(t.conversionId)
      .where(sql`${t.outcome} = 'failed'`),
  ],
);

// ---------------------------------------------------------------------------
// Subscription plans (stages 1–3): the owner's plans and their immutable versions, each account's
// subscription (history = its rows; the current one has no `ended_at`) and the usage counters / alert marks.
// Platform-level (no account_id) except the subscriptions and counters. No account gets a subscription by itself:
// none = legacy / unlimited. `accounts.plan` (varchar, 'self_hosted') predates this and is not read — superseded.
// ---------------------------------------------------------------------------
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trial',
  'active',
  'past_due',
  'read_only',
  'suspended',
  // plan-lock: the owner closed the account (only the plan, the offered plans and support answer).
  'closed',
]);

export const plans = pgTable('plans', {
  id: pk(),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description'),
  /** `public` = offered (upgrade lists, a future sign-up); `hidden` = assigned by the owner only. */
  visibility: varchar('visibility', { length: 16 }).notNull().default('public'),
  sort: integer('sort').notNull().default(0),
  /** The pricing page: selling points, the "recommended" mark, a per-seat minimum. */
  highlights: jsonb('highlights').$type<string[]>().notNull().default(emptyArray),
  recommended: boolean('recommended').notNull().default(false),
  minSeats: integer('min_seats'),
  archivedAt: ts('archived_at'),
  createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const planVersions = pgTable(
  'plan_versions',
  {
    id: pk(),
    planId: ulid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Prices in minor units (agorot / cents). */
    priceMonthlyMinor: bigint('price_monthly_minor', { mode: 'number' }).notNull().default(0),
    priceYearlyMinor: bigint('price_yearly_minor', { mode: 'number' }).notNull().default(0),
    currency: varchar('currency', { length: 3 }).notNull().default('ILS'),
    vatIncluded: boolean('vat_included').notNull().default(true),
    /** `flat` | `per_seat`. */
    pricing: varchar('pricing', { length: 16 }).notNull().default('flat'),
    /** PlanLimits — absent / null = unlimited. */
    limits: jsonb('limits').$type<JsonObject>().notNull().default(emptyJson),
    features: jsonb('features').$type<string[]>().notNull().default(emptyArray),
    trialDays: integer('trial_days').notNull().default(0),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_plan_versions_plan_version').on(t.planId, t.version)],
);

export const accountSubscriptions = pgTable(
  'account_subscriptions',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    planVersionId: ulid('plan_version_id')
      .notNull()
      .references(() => planVersions.id, { onDelete: 'restrict' }),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    statusSince: ts('status_since').notNull().defaultNow(),
    /** `month` | `year`. */
    interval: varchar('interval', { length: 8 }).notNull().default('month'),
    seats: integer('seats'),
    periodStart: ts('period_start').notNull().defaultNow(),
    periodEnd: ts('period_end'),
    trialEndsAt: ts('trial_ends_at'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** When it was paid for online: the cancellation window counts from here. */
    purchasedAt: ts('purchased_at'),
    /** The period end a renewal reminder was sent for, so each renewal is reminded once. */
    renewalRemindedFor: ts('renewal_reminded_for'),
    /**
     * The account's own cancellation: the case, the refund (minor units), when and by whom. Null = not
     * cancelled by the account; a cancellation without a refund can be undone until the period ends.
     */
    cancellation: jsonb('cancellation').$type<JsonObject>(),
    /** PlanOverrides — the owner's per-account limits (null value = unlimited). */
    overrides: jsonb('overrides').$type<JsonObject>().notNull().default(emptyJson),
    /** The add-ons held: add-on id → {qty, limit_kind, amount, name}, a snapshot. */
    addons: jsonb('addons').$type<JsonObject>().notNull().default(emptyJson),
    note: text('note'),
    /** What the account's members read about the status (the closed screen); null = the platform's text. */
    statusMessage: text('status_message'),
    /**
     * This subscription's own trial-end rule (`active` / `past_due` / `read_only`; self sign-up, D32); null = the
     * billing settings' `trial_end_status`.
     */
    trialEndStatus: varchar('trial_end_status', { length: 16 }),
    /** A billing provider's reference (a trusted platform extension, later). */
    provider: varchar('provider', { length: 40 }),
    externalId: varchar('external_id', { length: 200 }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    endedAt: ts('ended_at'),
  },
  (t) => [
    uniqueIndex('ux_account_subscriptions_current')
      .on(t.accountId)
      .where(sql`${t.endedAt} is null`),
    index('ix_account_subscriptions_account').on(t.accountId, t.createdAt),
    index('ix_account_subscriptions_version').on(t.planVersionId),
  ],
);

/**
 * Add-ons (decision 5): the owner's units that raise one limit of a plan (storage, automation runs
 * AI budget…), priced per unit per month / year. Platform-level. `plan_ids` empty = every paid public plan.
 */
export const planAddons = pgTable('plan_addons', {
  id: pk(),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description'),
  limitKind: varchar('limit_kind', { length: 32 }).notNull(),
  unitAmount: doublePrecision('unit_amount').notNull(),
  /** Prices in minor units (agorot / cents). */
  priceMonthlyMinor: bigint('price_monthly_minor', { mode: 'number' }).notNull().default(0),
  priceYearlyMinor: bigint('price_yearly_minor', { mode: 'number' }).notNull().default(0),
  currency: varchar('currency', { length: 3 }).notNull().default('ILS'),
  vatIncluded: boolean('vat_included').notNull().default(true),
  planIds: jsonb('plan_ids').$type<string[]>().notNull().default(emptyArray),
  maxQty: integer('max_qty').notNull().default(20),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The trial emails a subscription got (self sign-up ה5): one row per (subscription, kind), so the hourly job sends
 * each at most once — also a reminder it skipped because a later one was due (sent_at = when it was skipped).
 */
export const trialEmailsSent = pgTable(
  'trial_emails_sent',
  {
    subscriptionId: ulid('subscription_id')
      .notNull()
      .references(() => accountSubscriptions.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 24 }).notNull(),
    /** false = passed over (a later email was already due), nothing was sent. */
    sent: boolean('sent').notNull().default(true),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subscriptionId, t.kind] })],
);

/**
 * Usage per account × period (`YYYY-MM` / `YYYY-MM-DD`) × limit kind: consumption counters (automation runs) and the
 * marks that make the warning / reached notification go out once a period.
 */
export const accountUsageCounters = pgTable(
  'account_usage_counters',
  {
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    period: varchar('period', { length: 10 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    value: doublePrecision('value').notNull().default(0),
    warnedAt: ts('warned_at'),
    reachedAt: ts('reached_at'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.period, t.kind] })],
);

// ---------------------------------------------------------------------------
// Secret columns
// ---------------------------------------------------------------------------
/**
 * Each account's data key for secret columns (envelope encryption): 32 random bytes, sealed (AES-256-GCM) with the
 * platform master key `SECRET_MASTER_KEY`. Never stored in the clear; lost master key = lost secrets.
 */
export const accountSecretKeys = pgTable('account_secret_keys', {
  accountId: ulid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  wrappedKey: text('wrapped_key').notNull(),
  createdAt: createdAt(),
});

/**
 * A secret cell's value, encrypted with the account's data key (bound to its item and column). Kept apart from
 * `cells` on purpose: no generic path (search, exports, AI, webhooks, activity, duplicate) ever reads this table.
 */
export const secretValues = pgTable(
  'secret_values',
  {
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    ciphertext: text('ciphertext').notNull(),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.columnId] }), index('ix_secret_values_account').on(t.accountId)],
);

/**
 * A secret update's text: `{html, text, json}` encrypted with the account's data key, bound to the
 * account and the update. Kept apart from `updates` on purpose (like `secret_values`); goes with the update.
 */
export const secretUpdateBodies = pgTable(
  'secret_update_bodies',
  {
    updateId: ulid('update_id')
      .primaryKey()
      .references(() => updates.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    ciphertext: text('ciphertext').notNull(),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [index('ix_secret_update_bodies_account').on(t.accountId)],
);

/**
 * A fresh two-factor code entered to reveal secrets: per person and sign-in session (signing out ends it). Each
 * column decides how long it counts (`verify_minutes`).
 */
export const secretRevealGrants = pgTable(
  'secret_reveal_grants',
  {
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: ulid('session_id')
      .notNull()
      .references(() => authSessions.id, { onDelete: 'cascade' }),
    verifiedAt: ts('verified_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
);

// ---------------------------------------------------------------------------
// Errors & health hub: platform-level rows (with the account they belong to, if any)
// ---------------------------------------------------------------------------

/**
 * One row per distinct failure (`fingerprint`: source + code + normalized message + account + entity); a repeat
 * adds to `count` and moves `last_seen_at`. The message is redacted (`redactErrorMessage`) and `links` hold ids
 * only — never item values, addresses or secrets. `status` is support's workflow; a resolved row that happens again
 * reopens (`reopened_count`). Written by the batched writer (modules/errors/errors.writer.ts) and the worker.
 */
export const errorEvents = pgTable(
  'error_events',
  {
    id: pk(),
    fingerprint: varchar('fingerprint', { length: 32 }).notNull(),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 16 }).notNull(),
    code: varchar('code', { length: 80 }).notNull(),
    severity: varchar('severity', { length: 12 }).notNull(),
    message: varchar('message', { length: 300 }).notNull().default(''),
    links: jsonb('links').$type<Record<string, string>>().notNull().default(emptyJson),
    count: integer('count').notNull().default(1),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    status: varchar('status', { length: 16 }).notNull().default('new'),
    assigneeId: ulid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    mutedUntil: ts('muted_until'),
    resolvedAt: ts('resolved_at'),
    /** Who resolved it; null with `resolved_at` = resolved by itself (quiet for the auto-resolve time). */
    resolvedBy: ulid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    reopenedCount: integer('reopened_count').notNull().default(0),
    ticketId: ulid('ticket_id').references(() => supportTickets.id, { onDelete: 'set null' }),
    /** Support's internal note (never shown to the account). */
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_error_events_fingerprint').on(t.fingerprint),
    index('ix_error_events_last_seen').on(t.lastSeenAt.desc()),
    index('ix_error_events_account').on(t.accountId, t.lastSeenAt.desc()),
    index('ix_error_events_status').on(t.status, t.lastSeenAt.desc()),
  ],
);

/** Occurrences per event and hour: thresholds per window, spikes and the detail's 24-hour bars. */
export const errorEventHours = pgTable(
  'error_event_hours',
  {
    eventId: ulid('event_id')
      .notNull()
      .references(() => errorEvents.id, { onDelete: 'cascade' }),
    hour: ts('hour').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.hour] }), index('ix_error_event_hours_hour').on(t.hour)],
);

/**
 * Alerts that fired (instant, the daily digest, or an account's own): the console's bell lists them (`read_by` =
 * who opened them) and emails went to `recipients`. `dedupe_key` stops the same rule repeating for the same event in
 * its window.
 */
export const errorAlerts = pgTable(
  'error_alerts',
  {
    id: pk(),
    ruleId: varchar('rule_id', { length: 40 }).notNull(),
    ruleName: varchar('rule_name', { length: 80 }).notNull().default(''),
    mode: varchar('mode', { length: 12 }).notNull(),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    eventIds: jsonb('event_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    total: integer('total').notNull().default(0),
    recipients: jsonb('recipients')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    readBy: jsonb('read_by')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dedupeKey: varchar('dedupe_key', { length: 120 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_error_alerts_created').on(t.createdAt.desc()),
    index('ix_error_alerts_dedupe').on(t.dedupeKey, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Support agent: an AI that investigates an error or a ticket for the platform's support staff
// read-only tools, a report, actions that wait for a person. Platform-level rows (an error may have no account);
// its cost is the platform's, kept on the run (never in an account's `ai_usage`).
// ---------------------------------------------------------------------------

/**
 * One investigation. `report` is what the agent submitted (root cause, evidence, impact, proposed fix, confidence).
 * The `dev_*` columns are the "approve development" step: a person approves, the agent writes the fix on its own
 * branch and opens a draft PR — never on the default branch, never merged by it.
 */
export const supportAgentRuns = pgTable(
  'support_agent_runs',
  {
    id: pk(),
    errorEventId: ulid('error_event_id').references(() => errorEvents.id, { onDelete: 'set null' }),
    ticketId: ulid('ticket_id').references(() => supportTickets.id, { onDelete: 'set null' }),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** `manual` (a person pressed "investigate") or `auto` (a new critical error, when the owner turned it on). */
    trigger: varchar('trigger', { length: 12 }).notNull().default('manual'),
    /** `queued` → `running` → `succeeded` | `failed` | `stopped`. */
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    /** What the person asked on top of the error / ticket (optional). */
    prompt: text('prompt').notNull().default(''),
    model: varchar('model', { length: 120 }),
    report: jsonb('report').$type<Record<string, unknown>>(),
    finalText: text('final_text'),
    error: varchar('error', { length: 120 }),
    steps: integer('steps').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    /** The production build the code was read at (so file lines match what ran). */
    codeRef: varchar('code_ref', { length: 64 }),
    requestedBy: ulid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Development step: `approved` → `running` → `opened` (a draft PR) | `failed`. */
    devStatus: varchar('dev_status', { length: 16 }),
    devApprovedBy: ulid('dev_approved_by').references(() => users.id, { onDelete: 'set null' }),
    devApprovedAt: ts('dev_approved_at'),
    devBranch: varchar('dev_branch', { length: 120 }),
    devPrUrl: varchar('dev_pr_url', { length: 300 }),
    devError: varchar('dev_error', { length: 120 }),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ix_support_agent_runs_error').on(t.errorEventId, t.createdAt.desc()),
    index('ix_support_agent_runs_ticket').on(t.ticketId, t.createdAt.desc()),
    index('ix_support_agent_runs_created').on(t.createdAt.desc()),
  ],
);

/** Every step of a run, in order: the model's turns and each tool call (what was read), for the live view and audit. */
export const supportAgentSteps = pgTable(
  'support_agent_steps',
  {
    id: pk(),
    runId: ulid('run_id')
      .notNull()
      .references(() => supportAgentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    /** `prompt` | `model` | `tool`. */
    kind: varchar('kind', { length: 8 }).notNull(),
    tool: varchar('tool', { length: 64 }),
    toolUseId: varchar('tool_use_id', { length: 80 }),
    input: jsonb('input'),
    output: jsonb('output'),
    isError: boolean('is_error').notNull().default(false),
    /** The message block replayed to the model (assistant content / tool_result). */
    content: jsonb('content'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_support_agent_steps_seq').on(t.runId, t.seq)],
);

/**
 * What the agent proposes and a person decides: resolve / mute the error, a reply to the customer (a draft the
 * person may edit). Nothing here runs until approved.
 */
export const supportAgentActions = pgTable(
  'support_agent_actions',
  {
    id: pk(),
    runId: ulid('run_id')
      .notNull()
      .references(() => supportAgentRuns.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 24 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(emptyJson),
    /** `pending` | `approved` | `rejected`. */
    status: varchar('status', { length: 12 }).notNull().default('pending'),
    decidedBy: ulid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('ix_support_agent_actions_run').on(t.runId)],
);

// ---------------------------------------------------------------------------
// License server (docs/LICENSING.md, part C) — used only where `LICENSE_SIGNING_KEY` is set (the licensor's own
// installation). Platform-level rows: no account.
// ---------------------------------------------------------------------------

/**
 * The licenses this server issued. The key text is kept so the owner can copy / email it again; a renewal or a plan
 * change re-signs and replaces it (same `ref`). Revoking only marks the row: an installation learns it on its
 * optional online check.
 */
export const issuedLicenses = pgTable(
  'issued_licenses',
  {
    id: pk(),
    /** The key's `id` field (kept across renewals). */
    ref: varchar('ref', { length: 64 }).notNull(),
    licensee: varchar('licensee', { length: 200 }).notNull(),
    plan: varchar('plan', { length: 20 }).notNull(),
    features: jsonb('features')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    seats: integer('seats'),
    instanceId: varchar('instance_id', { length: 64 }),
    expires: ts('expires'),
    graceDays: integer('grace_days').notNull().default(14),
    support: varchar('support', { length: 20 }).notNull().default('community'),
    email: varchar('email', { length: 320 }),
    key: text('key').notNull(),
    issuedAt: ts('issued_at').notNull().defaultNow(),
    issuedBy: ulid('issued_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts('revoked_at'),
    revokedBy: ulid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    /** Bought online: the payment provider (`stripe`) and its customer / subscription ids. */
    paymentProvider: varchar('payment_provider', { length: 40 }),
    paymentCustomerId: varchar('payment_customer_id', { length: 120 }),
    paymentSubscriptionId: varchar('payment_subscription_id', { length: 120 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_issued_licenses_ref').on(t.ref),
    index('ix_issued_licenses_instance').on(t.instanceId),
    index('ix_issued_licenses_created').on(t.createdAt.desc()),
    index('ix_issued_licenses_subscription').on(t.paymentProvider, t.paymentSubscriptionId),
  ],
);

/**
 * Expiry reminders sent: one row per license, per expiry date, per "days before" — the unique key
 * makes the hourly job idempotent (a renewed license has a new expiry, so its reminders start over).
 */
export const licenseReminders = pgTable(
  'license_reminders',
  {
    id: pk(),
    licenseId: ulid('license_id')
      .notNull()
      .references(() => issuedLicenses.id, { onDelete: 'cascade' }),
    expires: ts('expires').notNull(),
    days: integer('days').notNull(),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ux_license_reminders').on(t.licenseId, t.expires, t.days)],
);

/** Payment-provider webhook events handled: idempotent on the provider's event id. */
export const licensePaymentEvents = pgTable(
  'license_payment_events',
  {
    id: pk(),
    provider: varchar('provider', { length: 40 }).notNull(),
    eventId: varchar('event_id', { length: 200 }).notNull(),
    type: varchar('type', { length: 80 }).notNull(),
    licenseId: ulid('license_id').references(() => issuedLicenses.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_license_payment_events').on(t.provider, t.eventId)],
);

/**
 * Installations that registered (the questionnaire): the answers, the email and whether it was verified, the
 * Registered key issued for it, and — only if the installation opted in to telemetry — its last heartbeat.
 * The verification token and the poll secret are stored hashed (sha256).
 */
export const licenseInstallations = pgTable(
  'license_installations',
  {
    id: pk(),
    instanceId: varchar('instance_id', { length: 64 }).notNull(),
    company: varchar('company', { length: 200 }).notNull().default(''),
    size: varchar('size', { length: 10 }),
    role: varchar('role', { length: 120 }).notNull().default(''),
    useCase: varchar('use_case', { length: 20 }),
    email: varchar('email', { length: 320 }).notNull(),
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    version: varchar('version', { length: 40 }),
    locale: varchar('locale', { length: 8 }),
    verifyTokenHash: varchar('verify_token_hash', { length: 64 }),
    verifyExpiresAt: ts('verify_expires_at'),
    verifiedAt: ts('verified_at'),
    pollSecretHash: varchar('poll_secret_hash', { length: 64 }),
    licenseId: ulid('license_id').references(() => issuedLicenses.id, { onDelete: 'set null' }),
    lastSeenAt: ts('last_seen_at'),
    activeUsers: integer('active_users'),
    boards: integer('boards'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_license_installations_instance').on(t.instanceId),
    uniqueIndex('ux_license_installations_verify').on(t.verifyTokenHash),
    index('ix_license_installations_created').on(t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Self sign-up (D32) — platform-level (no account yet): one row per attempt, from the form to the account.
// ---------------------------------------------------------------------------
export const signupRequests = pgTable(
  'signup_requests',
  {
    id: pk(),
    email: varchar('email', { length: 320 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    orgName: varchar('org_name', { length: 120 }).notNull(),
    /** The plan version shown when the person chose (null = the default plan's current version at creation). */
    planVersionId: ulid('plan_version_id'),
    /** `password` / `google` / `microsoft`. */
    method: varchar('method', { length: 16 }).notNull(),
    /** SignupRequestStatus (packages/shared api/signup.ts). */
    status: varchar('status', { length: 20 }).notNull(),
    /** sha256 of the email link's token (single use) / of the provider intent's id; cleared once used. */
    tokenHash: varchar('token_hash', { length: 64 }),
    /** The password's hash (Better Auth's hasher), only until the account exists or the request ends. */
    passwordHash: text('password_hash'),
    locale: varchar('locale', { length: 8 }),
    timezone: varchar('timezone', { length: 64 }),
    currency: varchar('currency', { length: 3 }),
    /** `[{slug, version}]` the person accepted on the form. */
    consents: jsonb('consents')
      .$type<JsonArray>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Ticked the marketing box on the form; copied to the person when the account is made. */
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 300 }),
    accountId: ulid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /**
     * Domain join (ה7): the existing account this address joins (its organisation's verified domain) instead of a
     * new account; null = a new account of one's own.
     */
    joinAccountId: ulid('join_account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: ulid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    reason: text('reason'),
    /** Emails sent for this request (the first one and every "send again"). */
    sends: integer('sends').notNull().default(0),
    lastSentAt: ts('last_sent_at'),
    expiresAt: ts('expires_at'),
    verifiedAt: ts('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ix_signup_requests_email').on(t.email, t.createdAt),
    index('ix_signup_requests_status').on(t.status, t.createdAt),
    index('ix_signup_requests_created').on(t.createdAt.desc()),
    index('ix_signup_requests_ip').on(t.ip, t.createdAt),
    uniqueIndex('ux_signup_requests_token').on(t.tokenHash),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type Account = typeof accounts.$inferSelect;
export type User = typeof users.$inferSelect;
export type AccountMember = typeof accountMembers.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Board = typeof boards.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Column = typeof columns.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Cell = typeof cells.$inferSelect;
export type ItemLink = typeof itemLinks.$inferSelect;
export type Update = typeof updates.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type View = typeof views.$inferSelect;
export type Form = typeof forms.$inferSelect;
export type Automation = typeof automations.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type ActivityEvent = typeof activityLog.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
/**
 * Security incident register (privacy — GDPR art. 33(5) "document any personal data breach"
 * Israel's data-security regulations, reg. 11: record every security event, report a severe one to the Privacy
 * Protection Authority at once). Platform owner only. `detected_at` starts the 72-hour clock (GDPR art. 33(1));
 * `authority_notified_at` / `subjects_notified_at` record when, and `reminded_at` that the owners were reminded.
 */
export const securityIncidents = pgTable(
  'security_incidents',
  {
    id: pk(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull().default(''),
    /** low / medium / high / critical (SecurityIncidentSeverity). */
    severity: varchar('severity', { length: 16 }).notNull(),
    /** open / contained / closed. */
    status: varchar('status', { length: 16 }).notNull().default('open'),
    /** Whether personal data was involved (a personal data breach — the reporting duties apply). */
    personalData: boolean('personal_data').notNull().default(false),
    detectedAt: ts('detected_at').notNull(),
    occurredAt: ts('occurred_at'),
    /** Accounts affected (ids), and an estimate of the people. */
    accountIds: jsonb('account_ids').$type<string[]>().notNull().default([]),
    peopleAffected: integer('people_affected'),
    /** What kinds of data (free text: "emails, phone numbers"). */
    dataCategories: text('data_categories').notNull().default(''),
    /** What was done to contain it and prevent it again. */
    measures: text('measures').notNull().default(''),
    authorityNotifiedAt: ts('authority_notified_at'),
    authorityReference: varchar('authority_reference', { length: 120 }),
    subjectsNotifiedAt: ts('subjects_notified_at'),
    remindedAt: ts('reminded_at'),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ix_security_incidents_detected').on(t.detectedAt.desc())],
);
export type SecurityIncidentRow = typeof securityIncidents.$inferSelect;

// ---------------------------------------------------------------------------
// Incoming email
// ---------------------------------------------------------------------------
/**
 * The email address of an item (mail → an update on it) or a board (mail → a new item). `token` is random, so the
 * address cannot be guessed; rotating sets `disabled_at` on the old row and makes a new one (an old address never
 * comes back). `created_by`: who made it — mail from someone outside the account is written in their name (as the
 * actor; the update itself has no author and shows the sender).
 */
export const inboundAddresses = pgTable(
  'inbound_addresses',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** `item` | `board`. */
    kind: varchar('kind', { length: 8 }).notNull(),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 32 }).notNull(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    disabledAt: ts('disabled_at'),
  },
  (t) => [
    uniqueIndex('ux_inbound_addresses_token').on(t.token),
    uniqueIndex('ux_inbound_addresses_item')
      .on(t.itemId)
      .where(sql`${t.kind} = 'item' and ${t.disabledAt} is null`),
    uniqueIndex('ux_inbound_addresses_board')
      .on(t.boardId)
      .where(sql`${t.kind} = 'board' and ${t.disabledAt} is null`),
    index('ix_inbound_addresses_account').on(t.accountId),
  ],
);
export type InboundAddressRow = typeof inboundAddresses.$inferSelect;

/**
 * Every message that reached one of our addresses: the provider's id and the Message-ID (a retry or the same mail
 * sent twice is taken once), the sender, and what came of it (`queued` → `done` / `rejected` with a reason /
 * `failed`). Also the count behind the per-address and per-account hourly limits.
 */
export const inboundEmails = pgTable(
  'inbound_emails',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    addressId: ulid('address_id')
      .notNull()
      .references(() => inboundAddresses.id, { onDelete: 'cascade' }),
    providerEmailId: varchar('provider_email_id', { length: 100 }).notNull(),
    messageId: varchar('message_id', { length: 255 }),
    fromEmail: varchar('from_email', { length: 320 }).notNull().default(''),
    /** `queued` | `done` | `rejected` | `failed`. */
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    reason: varchar('reason', { length: 40 }),
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'set null' }),
    updateId: ulid('update_id').references(() => updates.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('ux_inbound_emails_provider').on(t.addressId, t.providerEmailId),
    uniqueIndex('ux_inbound_emails_message')
      .on(t.addressId, t.messageId)
      .where(sql`${t.messageId} is not null`),
    index('ix_inbound_emails_address_created').on(t.addressId, t.createdAt.desc()),
    index('ix_inbound_emails_account_created').on(t.accountId, t.createdAt.desc()),
  ],
);
export type InboundEmailRow = typeof inboundEmails.$inferSelect;

// ---------------------------------------------------------------------------
// Platform costs
// ---------------------------------------------------------------------------

/**
 * Where the platform's costs come from (owner console → Costs → Sources): the platform's own measurements
 * (`internal`, one row, made on first use), a provider read with the owner's read-only key (`railway`,
 * `cloudflare_r2`, `http_json`), or a fixed fee (`recurring`). Platform-wide, platform owner only. The key is sealed
 * (SecretBox) and never returned; `config` holds the adapter's plain settings (`COST_ADAPTER_DEFS`).
 */
export const costSources = pgTable('cost_sources', {
  id: pk(),
  adapter: varchar('adapter', { length: 32 }).notNull(),
  name: varchar('name', { length: 80 }),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config').$type<JsonObject>().notNull().default(emptyJson),
  secretSealed: text('secret_sealed'),
  secretHint: varchar('secret_hint', { length: 16 }),
  /** A monthly budget in the display currency (null = none). */
  budgetMonthly: doublePrecision('budget_monthly'),
  lastSyncAt: ts('last_sync_at'),
  lastSyncOk: boolean('last_sync_ok'),
  lastError: text('last_error'),
  createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: ts('deleted_at'),
});
export type CostSourceRow = typeof costSources.$inferSelect;

/**
 * One day of one metric of one source (per service, per account when the platform knows it — `account_ref` '' =
 * no account): the quantity, and either the money the source reported (`amount`, AI spend / a fee) or the cost the
 * price table gives (`cost`, recomputed whenever a price changes). A sync replaces its source's rows for the days it
 * read. `cost` is in `currency`; null = no price for the metric (`unpriced`).
 */
export const costEntries = pgTable(
  'cost_entries',
  {
    sourceId: ulid('source_id')
      .notNull()
      .references(() => costSources.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    metric: varchar('metric', { length: 60 }).notNull(),
    service: varchar('service', { length: 120 }).notNull().default(''),
    accountRef: varchar('account_ref', { length: 26 }).notNull().default(''),
    quantity: doublePrecision('quantity').notNull().default(0),
    unit: varchar('unit', { length: 24 }).notNull(),
    /** Money the source itself reported (direct metrics); null = priced from the table. */
    amount: doublePrecision('amount'),
    cost: doublePrecision('cost'),
    currency: varchar('currency', { length: 3 }),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.day, t.metric, t.service, t.accountRef] }),
    index('ix_cost_entries_day').on(t.day),
    index('ix_cost_entries_metric_day').on(t.metric, t.day),
  ],
);
export type CostEntryRow = typeof costEntries.$inferSelect;

/**
 * Unit prices (owner console → Costs → Prices): per metric (and a service, or `*`), from a day on — a price change
 * keeps the old one for the days before it. `free_per_month` = units free each calendar month (a free tier).
 */
export const costPrices = pgTable(
  'cost_prices',
  {
    id: pk(),
    metric: varchar('metric', { length: 60 }).notNull(),
    service: varchar('service', { length: 120 }).notNull().default('*'),
    price: doublePrecision('price').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    freePerMonth: doublePrecision('free_per_month').notNull().default(0),
    effectiveFrom: date('effective_from').notNull(),
    note: varchar('note', { length: 255 }),
    updatedBy: ulid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ux_cost_prices_metric_service_from').on(t.metric, t.service, t.effectiveFrom)],
);
export type CostPriceRow = typeof costPrices.$inferSelect;

/** Exchange rates per day: 1 `currency` = `rate` units of `quote` (the display currency when it was fetched). */
export const costFxRates = pgTable(
  'cost_fx_rates',
  {
    day: date('day').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    quote: varchar('quote', { length: 3 }).notNull(),
    rate: doublePrecision('rate').notNull(),
    source: varchar('source', { length: 16 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.currency, t.quote] })],
);

/**
 * What the platform counts as it happens, per day (and account when known; '' = none): emails sent, SMS parts,
 * web searches, the day's stored bytes as GB-months. The `internal` cost source reads it.
 */
export const usageMeter = pgTable(
  'usage_meter',
  {
    day: date('day').notNull(),
    accountRef: varchar('account_ref', { length: 26 }).notNull().default(''),
    metric: varchar('metric', { length: 60 }).notNull(),
    quantity: doublePrecision('quantity').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.accountRef, t.metric] })],
);

// Interactive documents: an item shared as a live page made of sections. Templates hold the
// sections and settings; a document is an item's own copy with a public token, a status, a version and its log;
// signing stores the evidence (one shape with legal consents) and writes a signature column.
export const idocTemplates = pgTable(
  'idoc_templates',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Null = any board of the account. */
    boardId: ulid('board_id').references(() => boards.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 120 }).notNull(),
    description: varchar('description', { length: 500 }).notNull().default(''),
    sections: jsonb('sections').$type<JsonArray>().notNull().default(emptyArray),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ix_idoc_templates_account').on(t.accountId, t.boardId)],
);

/**
 * Item templates: an item tree at any depth with its values, updates and files, and the variables
 * asked when it is applied (`@bines/shared` api/item-templates). On one board (its items; deeper levels use the
 * board's subitems columns). `version` goes up with every change of the tree or the variables.
 */
export const itemTemplates = pgTable(
  'item_templates',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    category: varchar('category', { length: 60 }).notNull().default(''),
    description: varchar('description', { length: 500 }).notNull().default(''),
    variables: jsonb('variables').$type<JsonArray>().notNull().default(emptyArray),
    root: jsonb('root').$type<JsonObject>().notNull(),
    version: integer('version').notNull().default(1),
    sourceItemId: ulid('source_item_id').references(() => items.id, { onDelete: 'set null' }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_item_templates_board')
      .on(t.accountId, t.boardId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** The files an item template holds (its own copies): in use while it does (the unused-file sweep keeps them). */
export const itemTemplateAssets = pgTable(
  'item_template_assets',
  {
    templateId: ulid('template_id')
      .notNull()
      .references(() => itemTemplates.id, { onDelete: 'cascade' }),
    assetId: ulid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.assetId] }), index('ix_item_template_assets_asset').on(t.assetId)],
);

/**
 * phase 3: a scenario — a graph of the automations' triggers and actions (shared `scenarios/graph.ts`) on a
 * board's canvas. Runs as its owner; switched off after 20 errors in a row like an automation; no versions.
 */
export const scenarios = pgTable(
  'scenarios',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    graph: jsonb('graph').$type<JsonObject>().notNull(),
    isActive: boolean('is_active').notNull().default(false),
    ownerId: ulid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    deactivatedReason: text('deactivated_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('ix_scenarios_board_active')
      .on(t.boardId)
      .where(sql`${t.isActive} and ${t.deletedAt} is null`),
  ],
);

/** One run of a scenario: each step's input, output or error (the run log), and where a wait resumes. */
export const scenarioRuns = pgTable(
  'scenario_runs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    scenarioId: ulid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'cascade' }),
    eventId: ulid('event_id'), // activity_log.id (no FK: partitioned table)
    itemId: ulid('item_id').references(() => items.id, { onDelete: 'set null' }),
    /** pending · running · waiting · succeeded · partial · failed · skipped */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    skipReason: varchar('skip_reason', { length: 64 }),
    depth: integer('depth').notNull().default(1),
    chain: jsonb('chain').$type<string[]>().notNull().default(emptyArray),
    steps: jsonb('steps').$type<JsonArray>().notNull().default(emptyArray),
    /** A wait step: the nodes to go on with, and when. */
    resumeAt: ts('resume_at'),
    resumeNodes: jsonb('resume_nodes').$type<string[]>().notNull().default(emptyArray),
    error: text('error'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_scenario_runs_scenario_created').on(t.scenarioId, t.createdAt.desc()),
    uniqueIndex('ux_scenario_runs_event')
      .on(t.scenarioId, t.eventId)
      .where(sql`${t.eventId} is not null`),
  ],
);

/** every saved version of a status column's workflow (restore puts one back as a new version). */
export const statusWorkflowVersions = pgTable(
  'status_workflow_versions',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: ulid('column_id')
      .notNull()
      .references(() => columns.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    workflow: jsonb('workflow').$type<JsonObject>().notNull(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ux_status_workflow_versions').on(t.columnId, t.version)],
);

export const idocDocs = pgTable(
  'idoc_docs',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: ulid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    templateId: ulid('template_id').references(() => idocTemplates.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 200 }).notNull(),
    sections: jsonb('sections').$type<JsonArray>().notNull().default(emptyArray),
    settings: jsonb('settings').$type<JsonObject>().notNull().default(emptyJson),
    /** draft | sent | viewed | signed | expired | revoked (expired is also derived from `expires_at` on read). */
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    version: integer('version').notNull().default(1),
    /** The public link's secret: [a-z0-9]{32}; replaced on demand (the old link stops working). */
    token: varchar('token', { length: 64 }).notNull(),
    expiresAt: ts('expires_at'),
    sentAt: ts('sent_at'),
    sentTo: varchar('sent_to', { length: 320 }),
    firstViewedAt: ts('first_viewed_at'),
    lastViewedAt: ts('last_viewed_at'),
    viewCount: integer('view_count').notNull().default(0),
    signedAt: ts('signed_at'),
    signatureId: ulid('signature_id'),
    /** Choices of rows that have no "selected" / "quantity" column: { [sectionId]: { [itemId]: { s?, q? } } }. */
    state: jsonb('state').$type<JsonObject>().notNull().default(emptyJson),
    /** The pending one-time code: { hash, email, expires_at, attempts, sent_at } (hash only, never the code). */
    otp: jsonb('otp').$type<JsonObject>(),
    createdBy: ulid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ux_idoc_docs_token').on(t.token),
    index('ix_idoc_docs_item').on(t.itemId),
    index('ix_idoc_docs_account_status').on(t.accountId, t.status),
  ],
);

/** Append-only log of a document: sent, opened, ticks, questions, signing … (the certificate's history). */
export const idocEvents = pgTable(
  'idoc_events',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    docId: ulid('doc_id')
      .notNull()
      .references(() => idocDocs.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 24 }).notNull(),
    /** A member (user id) or null for the client. */
    userId: ulid('user_id').references(() => users.id, { onDelete: 'set null' }),
    who: varchar('who', { length: 200 }),
    detail: varchar('detail', { length: 500 }).notNull().default(''),
    data: jsonb('data').$type<JsonObject>(),
    ip: varchar('ip', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_idoc_events_doc').on(t.docId, t.createdAt)],
);

/** A signature: the evidence (consentEvidenceSchema), the content hash, and the snapshot of what was signed. */
export const idocSignatures = pgTable(
  'idoc_signatures',
  {
    id: pk(),
    accountId: ulid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    docId: ulid('doc_id')
      .notNull()
      .references(() => idocDocs.id, { onDelete: 'cascade' }),
    itemId: ulid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    evidence: jsonb('evidence').$type<JsonObject>().notNull(),
    /** SVG path data of a drawn signature. */
    drawing: text('drawing'),
    /** Exactly what the client saw and chose: sections, rows, inputs, totals (the hash is over this). */
    snapshot: jsonb('snapshot').$type<JsonObject>().notNull(),
    fileAssetId: ulid('file_asset_id'),
    createdAt: createdAt(),
  },
  (t) => [index('ix_idoc_signatures_doc').on(t.docId)],
);

export type IdocTemplateRow = typeof idocTemplates.$inferSelect;
export type IdocDocRow = typeof idocDocs.$inferSelect;
export type IdocEventRow = typeof idocEvents.$inferSelect;
export type IdocSignatureRow = typeof idocSignatures.$inferSelect;

export type Tag = typeof tags.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type TrashEntry = typeof trashEntries.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type NewCell = typeof cells.$inferInsert;
