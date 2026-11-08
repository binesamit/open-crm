# 02 — Data Model (PostgreSQL 18 + Drizzle)

This is the reference for the Bines OS database: every table, column, enum and index, and the rules behind them. It is
written for contributors changing the schema and for self-hosters or integrators who need to read the data directly.

This document is the source of truth for the data model. It is implemented one-to-one in `apps/api/src/db/schema.ts`
(Drizzle, `pg-core`) and applied through `drizzle-kit` migrations. Every model change starts here, then goes into
`schema.ts`, and only then into the code. It follows [`DECISIONS.md`](DECISIONS.md). The settings and value shape of
each column type are in [`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md) and the generated
[`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md).

---

## 0. Global conventions

| Topic | Decision |
|---|---|
| Ids | **ULID** (26 characters, Crockford base32, generated in the service layer with `ulid()`), column `id varchar(26)`. ULIDs sort by time ⇒ efficient B-tree index, and they can be used as a pagination cursor. Exceptions: `activity_log.id` (a ULID, but with a composite PK because of partitioning), link tables (composite PK). |
| Multi-tenant | `account_id varchar(26) NOT NULL` on **every** table except `accounts`, `users`, `templates` (built-in) and `user_profile_settings`. Every service-layer query filters by the request's `account_id` (DECISIONS D12: `X-Account-Id` plus a membership check for sessions; the token's account for API tokens). An installation runs many accounts side by side. |
| Times | Always `timestamptz` (UTC in the DB; converted to the user's time zone in the UI). `created_at NOT NULL DEFAULT now()`, `updated_at NOT NULL DEFAULT now()` (updated by the service layer, not by a trigger). |
| Soft delete | `deleted_at timestamptz NULL` plus a row in `trash_entries`. `archived_at timestamptz NULL` = archive (never purged). See §5. |
| JSONB | `settings`, `value`, `payload`, `recipe` — always an object (`{}` by default, never `NULL`), validated with Zod before writing. |
| Position / order | `position text` in **LexoRank** format (a base-36 fractional key, e.g. `"0|hzzzzz:"`). Inserting between two neighbours = an in-between key, no renumbering. Rebalance only when a key grows longer than 64. |
| Names | Tables `snake_case`, plural; FK `<singular>_id`; indexes `ix_<table>_<cols>`, unique `ux_<table>_<cols>`. |
| Better Auth | Authentication only (DECISIONS D2). Better Auth uses `users` (its `user` table, with `additionalFields`: `isPlatformOwner`, `locale`, `timezone` — `input: false`), `auth_sessions`, `auth_identities` (its `account` model = a sign-in identity: credential/Google, **not** a tenant) and `auth_verifications`; the adapter maps `{user, session, account, verification}`. **No organization plugin and no apikey plugin**: memberships (`account_members`), invitations (`account_invitations`, §2.3a) and tokens (`api_tokens`) are our own tables. Ids = ULID (`advanced.database.generateId`). |
| Revision | `revision int NOT NULL DEFAULT 1` on `boards`, `columns`, `views`, `automations`, `forms`. See §8. |

### 0.1 Enums (pgEnum)

| Name | Values |
|---|---|
| `account_member_role` | `admin`, `member`, `viewer`, `guest` |
| `member_status` | `invited`, `active`, `deactivated` |
| `workspace_kind` | `open`, `closed` |
| `workspace_member_role` | `owner`, `member` |
| `board_kind` | `main`, `shareable`, `private` |
| `board_permission_set` | `edit_everything`, `edit_content`, `edit_assigned`, `view_comment` |
| `account_status` | `active`, `suspended` |
| `board_view_items` | `all`, `assigned_or_created`, `by_filter` |
| `board_member_role` | `owner`, `subscriber` |
| `group_color` | 19 colours — see §0.2 |
| `view_type` | `table`, `kanban`, `calendar`, `timeline`, `gantt`, `form`, `cards`, `workload`, `chart`, `files` |
| `automation_run_status` | `pending`, `running`, `succeeded`, `failed`, `skipped` |
| `webhook_delivery_status` | `pending`, `delivered`, `failed`, `dead` |
| `actor_type` | `user`, `automation`, `api`, `system`, `form`, `email` |
| `asset_kind` | `file`, `link`, `doc` |
| `trash_object_type` | `workspace`, `folder`, `board`, `group`, `item`, `column`, `view`, `update`, `asset`, `automation`, `form` |
| `template_kind` | `board`, `workspace` |
| `notification_channel` | `in_app`, `email` |
| `update_source` | `user`, `email`, `automation`, `api`, `form` |

### 0.2 Group colours — `group_color` (19 keys, 12 colours)

The enum values are our own keys; the hex values live in `packages/shared/colors.ts` — **our own palette** (DECISIONS
D30, [11-UI-DESIGN](11-UI-DESIGN.md) §9.1), light and dark. Migration `0071_f9_colour_keys` renamed the keys; the old
keys (`bright_blue`, `done_green`…) are still accepted as input and read as the new ones (`LEGACY_GROUP_COLOR_KEYS`,
`normalizeGroupColor`); display goes through `groupColorHex`, so data saved under an old key still shows its colour.

The 12 group colours (`GROUP_PALETTE`, in the order a new group receives them): `forest`, `yellow`, `turquoise`, `crimson`, `navy`, `purple`, `green`, `orange`, `blue`, `pink`, `violet`, `gray`. The enum's seven other keys are retired and shown as a palette colour (`RETIRED_GROUP_COLOR_KEYS`): `lime`→`green`, `red`→`crimson`, `light_gray`→`gray`, `azure`→`blue`, `orange_red`→`orange`, `salmon`→`pink`, `brown`→`gold`. The hex of every key is in the table in 11-UI-DESIGN §9.1.

Label colours (status, conditional colouring) are 16 keys of the same palette (`STATUS_COLORS`), stored as a key inside `columns.settings` (not a DB enum); migration `0080_own_palette` converted old hex values to the nearest key. The `brown` / `olive` keys it wrote are now read as `gold` (`RENAMED_COLOR_KEYS`); support tags (hex) were moved to the live palette in migration `0081_vivid_palette`.

---

## 1. ER summary

```mermaid
erDiagram
    accounts ||--o{ account_members : has
    users ||--o{ account_members : joins
    accounts ||--o{ teams : has
    teams ||--o{ team_members : has
    users ||--o{ team_members : in
    accounts ||--o{ workspaces : has
    workspaces ||--o{ workspace_members : has
    workspaces ||--o{ folders : has
    folders ||--o{ folders : parent
    workspaces ||--o{ boards : has
    folders ||--o{ boards : contains
    boards ||--o{ board_members : has
    boards ||--o{ board_team_members : has
    boards ||--o{ groups : has
    boards ||--o{ columns : has
    boards ||--o{ items : has
    groups ||--o{ items : contains
    items ||--o{ items : parent_item
    items ||--o{ cells : has
    columns ||--o{ cells : typed_by
    items ||--o{ item_links : from
    items ||--o{ item_links : to
    columns ||--o{ item_links : via
    items ||--o{ updates : has
    updates ||--o{ updates : reply
    updates ||--o{ update_mentions : mentions
    updates ||--o{ update_likes : liked
    updates ||--o{ update_files : attaches
    cells ||--o{ cell_files : attaches
    assets ||--o{ cell_files : is
    assets ||--o{ update_files : is
    assets ||--o{ assets : version_of
    boards ||--o{ views : has
    views ||--o| forms : is
    forms ||--o{ form_submissions : receives
    boards ||--o{ automations : has
    automations ||--o{ automation_runs : runs
    activity_log ||--o{ automation_runs : triggered_by
    boards ||--o{ webhooks : has
    webhooks ||--o{ webhook_deliveries : delivers
    accounts ||--o{ api_tokens : issues
    users ||--o{ notifications : receives
    users ||--o{ notification_settings : configures
    accounts ||--o{ tags : has
    items ||--o{ item_tags : tagged
    tags ||--o{ item_tags : used
    accounts ||--o{ templates : owns
    accounts ||--o{ trash_entries : has
    accounts ||--o{ audit_log : has
    accounts ||--|| account_settings : has
    users ||--|| user_profile_settings : has
    accounts ||--o{ support_access_grants : grants
    boards ||--o{ item_keys : sequences
    items ||--o{ time_entries : tracks
    accounts ||--o{ import_jobs : runs
```

---

## 2. Tables — accounts, users, organization

### 2.1 `accounts`
An account = a tenant. An installation holds several (DECISIONS D12): the first account (`SEED_ACCOUNT_SLUG`) and any others the platform owner opens. Every row in every table points to its account; there are no relations between accounts.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK, ULID |
| `slug` | varchar(63) | NO | — | **UNIQUE**; `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`; used in the URL `/a/<slug>/...`; reserved: `owner`, `admin`, `api`, `auth`, `portal`, `me`, `f`, `www` |
| `name` | varchar(120) | NO | — | |
| `logo_asset_id` | varchar(26) | YES | NULL | FK → `assets.id` (SET NULL) |
| `plan` | varchar(32) | NO | `'self_hosted'` | Not read: an account's plan is `account_subscriptions` (§7.14). Kept for old rows |
| `status` | account_status | NO | `'active'` | `suspended` ⇒ every request to the account returns `423 account_suspended` (DECISIONS D12) |
| `suspended_at` | timestamptz | YES | NULL | |
| `created_by` | varchar(26) | YES | NULL | FK → users (SET NULL); the platform owner who opened it |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |
| `origin` | varchar(16) | NO | `'owner'` | Who opened it (DECISIONS D32, migration `0087_signup`): `owner` (owner console), `setup` (first install), `signup` (self sign-up) |

### 2.2 `users`
Better Auth's `user` table (with `modelName: "users"`). Fields marked ⚙ are required by Better Auth.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK, ULID (Better Auth's `generateId` replaced with ulid) ⚙ |
| `email` | varchar(320) | NO | — | **UNIQUE** (lowercased in the service layer; index `ux_users_email` on `lower(email)`) ⚙ |
| `email_verified` | boolean | NO | false | ⚙ |
| `name` | varchar(120) | NO | — | ⚙ |
| `image` | text | YES | NULL | ⚙ (URL; we prefer `avatar_asset_id`) |
| `avatar_asset_id` | varchar(26) | YES | NULL | FK → `assets.id` (SET NULL) |
| `title` | varchar(120) | YES | NULL | Job title (shown in the People hover card) |
| `phone` | varchar(32) | YES | NULL | E.164 |
| `locale` | varchar(8) | NO | `'he'` | |
| `timezone` | varchar(64) | YES | — | IANA; null = not chosen → the account's time zone (`settings.locale.timezone`, migration 0032) |
| `is_platform_owner` | boolean | NO | false | DECISIONS D12 — access to the owner console (`/owner`): create/suspend/delete accounts and usage data. Does **not** grant access to data inside an account |
| `is_support_staff` | boolean | NO | false | Unused — support access is granted to `is_platform_owner` or by email (§7.9) |
| `last_seen_at` | timestamptz | YES | NULL | |
| `created_at` / `updated_at` | timestamptz | NO | now() | ⚙ |

### 2.3 `account_members`
A user's membership in an account, with a role. A guest (`guest`) must be an account member (with role=guest) so it can be attached to shareable boards.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK → accounts (CASCADE) |
| `user_id` | varchar(26) | NO | — | FK → users (CASCADE) |
| `role` | account_member_role | NO | `'member'` | |
| `status` | member_status | NO | `'invited'` | `active` after the invitation is accepted |
| `invited_by` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `invited_at` | timestamptz | YES | NULL | |
| `joined_at` | timestamptz | YES | NULL | |
| `deactivated_at` | timestamptz | YES | NULL | A deactivated user cannot sign in, but stays in history and People cells |
| `deactivated_by` | varchar(26) | YES | NULL | FK → users |
| `created_at` / `updated_at` | timestamptz | NO | now() | |

Indexes: `ux_account_members_account_user (account_id, user_id)`; `ix_account_members_user (user_id)`; `ix_account_members_account_role (account_id, role) WHERE deactivated_at IS NULL`.

### 2.3a `account_invitations`
A pending invitation to an account ([08-ACCOUNT-ADMIN](08-ACCOUNT-ADMIN.md) §3.1). The `account_members` row is created only on acceptance. The raw token exists only in the email link; its `sha256` is stored.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK (CASCADE) |
| `email` | varchar(320) | NO | — | Index on `lower(email)` |
| `role` | account_member_role | NO | — | |
| `token_hash` | varchar(64) | NO | — | UNIQUE, sha256 hex |
| `payload` | jsonb | NO | `{}` | `{ board_ids? }` — boards the invitee is added to on acceptance |
| `invited_by` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `expires_at` | timestamptz | NO | — | 7 days (the seed's owner invitation: one year) |
| `accepted_at` / `accepted_by` | | YES | NULL | |
| `revoked_at` | timestamptz | YES | NULL | A new invitation to the same email revokes the previous one |
| `created_at` | timestamptz | NO | now() | |

Acceptance: (a) with the token (`POST /invitations/accept`) or (b) from the "my invitations" list by **verified** email (`POST /me/invitations/:id/accept`); in both cases the session's email must match the invitation's email.

### 2.4 `teams`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK (CASCADE) |
| `name` | varchar(120) | NO | — | |
| `description` | text | YES | NULL | |
| `color` | varchar(32) | YES | NULL | A key from the group palette |
| `parent_team_id` | varchar(26) | YES | NULL | FK → teams (SET NULL); sub-teams, depth ≤ 2 |
| `created_by` | varchar(26) | YES | NULL | FK → users |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ux_teams_account_name (account_id, lower(name)) WHERE deleted_at IS NULL`.

### 2.5 `team_members`

| column | type | null | default | notes |
|---|---|---|---|---|
| `team_id` | varchar(26) | NO | — | FK → teams (CASCADE) |
| `user_id` | varchar(26) | NO | — | FK → users (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `is_lead` | boolean | NO | false | |
| `created_at` | timestamptz | NO | now() | |

PK `(team_id, user_id)`; index `ix_team_members_user (user_id)`.

---

## 3. Tables — workspaces, folders, boards

### 3.1 `workspaces`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK (CASCADE) |
| `name` | varchar(120) | NO | — | |
| `description` | text | YES | NULL | |
| `kind` | workspace_kind | NO | `'open'` | `open` = every member/viewer in the account sees it; `closed` = only `workspace_members` (guests never see a workspace — only boards) |
| `icon` | varchar(64) | YES | NULL | Emoji or icon key |
| `color` | varchar(32) | YES | NULL | |
| `settings` | jsonb | NO | `{}` | `{ default_board_kind, item_terminology_default, allow_members_create_boards: bool, sidebar_order: string[] }` |
| `position` | text | NO | — | LexoRank in the sidebar |
| `created_by` | varchar(26) | YES | NULL | FK → users |
| `revision` | integer | NO | 1 | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `archived_at` / `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ix_workspaces_account (account_id, position) WHERE deleted_at IS NULL`.

### 3.2 `workspace_members`
Workspace owners (`owner`) can manage structure and members; `member` can see it (relevant mainly for `closed`). A row points to a user **or** a team.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `workspace_id` | varchar(26) | NO | — | FK → workspaces (CASCADE) |
| `user_id` | varchar(26) | YES | NULL | FK → users (CASCADE) |
| `team_id` | varchar(26) | YES | NULL | FK → teams (CASCADE) |
| `role` | workspace_member_role | NO | `'member'` | |
| `added_by` | varchar(26) | YES | NULL | FK → users |
| `created_at` | timestamptz | NO | now() | |

CHECK (SQL migration): `(user_id IS NOT NULL) <> (team_id IS NOT NULL)`. Unique: `ux_workspace_members_user (workspace_id, user_id)`, `ux_workspace_members_team (workspace_id, team_id)`.

### 3.3 `folders`
Up to 3 levels: `depth` 0, 1, 2. The service rejects a create or move that would cause `depth > 2` or a cycle.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `workspace_id` | varchar(26) | NO | — | FK → workspaces (CASCADE) |
| `parent_folder_id` | varchar(26) | YES | NULL | FK → folders (CASCADE) |
| `depth` | integer | NO | 0 | 0..2 (CHECK) |
| `name` | varchar(120) | NO | — | |
| `color` | varchar(32) | YES | NULL | |
| `position` | text | NO | — | LexoRank among siblings |
| `created_by` | varchar(26) | YES | NULL | FK → users |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ix_folders_workspace_parent (workspace_id, parent_folder_id, position) WHERE deleted_at IS NULL`.

### 3.4 `boards`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `workspace_id` | varchar(26) | NO | — | FK → workspaces (RESTRICT — a workspace is deleted only after its boards were moved or deleted) |
| `folder_id` | varchar(26) | YES | NULL | FK → folders (SET NULL); NULL = workspace root |
| `name` | varchar(255) | NO | — | |
| `description` | text | YES | NULL | |
| `kind` | board_kind | NO | `'main'` | `main` = all account members; `shareable` = subscribers including guests; `private` = subscribers, no guests |
| `position` | text | NO | — | LexoRank within the folder/root |
| `item_terminology` | varchar(40) | NO | `'item'` | E.g. `'lead'`, `'ticket'`, `'work item'` — affects UI text only |
| `hierarchy_depth_max` | integer | NO | 5 | The deepest `depth` allowed under an item: 1 = subitems only; 2 = also sub-subitems (the default for every new board); up to 5 (six levels, including the item). CHECK 1..6, but a value of 6 is read as 5 (`effectiveDepthMax`, `ck_items_depth`) |
| `permission_set` | board_permission_set | NO | `'edit_everything'` | DECISIONS D6 |
| `view_items` | board_view_items | NO | `'all'` | DECISIONS D6 — `assigned_or_created`: non-owners see only items they created or are assigned to in **any** People column (or in `view_items_config.column_ids`); `by_filter`: by `view_items_config.rules` ([05-PERMISSIONS](05-PERMISSIONS.md) §6) |
| `view_items_config` | jsonb | NO | `{}` | Zod `ViewItemsConfig`: `{ column_ids?: string[] \| 'any_people', rules?: VisibilityRule[] }` (05 §6) |
| `assignee_column_id` | varchar(26) | YES | NULL | FK → columns (SET NULL). The People column that defines "assigned" for `edit_assigned`. NULL ⇒ all People columns |
| `settings` | jsonb | NO | `{}` | See §3.4.1 |
| `created_from_template_id` | varchar(26) | YES | NULL | FK → templates (SET NULL) |
| `source_board_id` | bigint | YES | NULL | The source id the record was imported from (`existing_board_id` in templates) |
| `created_by` | varchar(26) | YES | NULL | FK → users |
| `revision` | integer | NO | 1 | Advances on every **structure** change (columns/groups/settings); not on every cell change |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `archived_at` / `deleted_at` | timestamptz | YES | NULL | |

#### 3.4.1 `boards.settings` (Zod `BoardSettings`)
```jsonc
{
  "default_group_id": null,              // default group for new items
  "new_item_defaults": { "<column_key>": <value> },   // default column values
  "item_default_values_enabled": true,
  "show_item_id_in_name": false,
  "allow_guests_to_create_items": true,  // relevant for shareable
  "notify_on_item_created": false,
  "email_to_board_address": "board-<ulid>@in.example.com",  // Resend inbound
  "deadline_pairs": [],                  // derived from date/timeline column settings (cache)
  "weekend_days": null,                  // null = inherit from account_settings
  "subitem_column_key": null,            // the virtual subitems column (if any)
  "color": null, "icon": null,
  "ui": { "default_view_id": null, "collapsed_groups": [] }
}
```

Indexes: `ix_boards_workspace_folder (workspace_id, folder_id, position) WHERE deleted_at IS NULL`; `ix_boards_account_kind (account_id, kind) WHERE deleted_at IS NULL`; `ix_boards_name_trgm` GIN trigram on `name`; `ux_boards_source (account_id, source_board_id) WHERE source_board_id IS NOT NULL`.

### 3.5 `board_members`
`owner` overrides everything (DECISIONS D6). `subscriber` = subscribed (receives notifications; for `shareable`/`private` boards this is also who can see the board at all).

| column | type | null | default | notes |
|---|---|---|---|---|
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `user_id` | varchar(26) | NO | — | FK → users (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `role` | board_member_role | NO | `'subscriber'` | |
| `added_by` | varchar(26) | YES | NULL | FK → users |
| `created_at` | timestamptz | NO | now() | |

PK `(board_id, user_id)`; index `ix_board_members_user (user_id)`.
Rule: a board must have at least one owner; removing the last owner is rejected (`409 LAST_OWNER`).

### 3.6 `board_team_members`

| column | type | null | default | notes |
|---|---|---|---|---|
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `team_id` | varchar(26) | NO | — | FK → teams (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `role` | board_member_role | NO | `'subscriber'` | |
| `added_by` | varchar(26) | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

PK `(board_id, team_id)`.

### 3.7 `groups`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `title` | varchar(255) | NO | — | |
| `color` | group_color | NO | `'blue'` | |
| `position` | text | NO | — | LexoRank within the board |
| `source_group_id` | varchar(64) | YES | NULL | E.g. `topics`, `group_mm6xhwbk` |
| `created_by` | varchar(26) | YES | NULL | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `archived_at` / `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ix_groups_board_position (board_id, position) WHERE deleted_at IS NULL AND archived_at IS NULL`.
Rule: a board must have at least one active group; deleting the last one is rejected.

### 3.8 `columns`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK, ULID (a stable internal key; `cells.column_id` points here) |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `key` | varchar(50) | NO | — | A readable id for the API, formulas and automations. `^[a-z][a-z0-9_]{0,49}$`. **UNIQUE per board, including deleted columns** (a deleted column's key stays reserved). On import the original id is kept (`color_mm6x6akt`). When created without a key: `<type>`, then `<type>_<4 base36>` |
| `type` | varchar(32) | NO | — | A registry key (`status`, `numbers`, …). Not an enum — DECISIONS D4 |
| `title` | varchar(255) | NO | — | |
| `description` | text | YES | NULL | The "i" tooltip in the header |
| `settings` | jsonb | NO | `{}` | Validated by the type's `settingsSchema` |
| `position` | text | NO | — | LexoRank; the `name` column is always first (the service prevents moving a column before it) |
| `width` | integer | NO | 140 | px; 60..1200 |
| `restricted_edit` | jsonb | YES | NULL | `{ "users": [ulid], "teams": [ulid] }`; NULL = no restriction. Board owners are always allowed |
| `restricted_view` | jsonb | YES | NULL | Same shape. CHECK: not both `restricted_edit` and `restricted_view` together |
| `rollup_function` | varchar(16) | YES | NULL | For multi-level boards: `sum|min|max|avg|count|count_done|none`; NULL = the type's default (§6) |
| `is_required` | boolean | NO | false | Enforced in forms and in "conditional status" |
| `source_column_id` | varchar(64) | YES | NULL | |
| `created_by` | varchar(26) | YES | NULL | |
| `revision` | integer | NO | 1 | `If-Match` in the API |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `archived_at` / `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ux_columns_board_key (board_id, key)` (no WHERE — intentionally, so deleted keys stay reserved); `ix_columns_board_position (board_id, position) WHERE deleted_at IS NULL`; `ix_columns_type (account_id, type)` (to find all board_relation columns pointing at a board).
Limits: ≤ 500 active columns per board; ≤ 60 `board_relation` + `dependency` columns per board; exactly one `name` column (created with the board, cannot be deleted).

### 3.9 `items`
Items and subitems live in the same table (DECISIONS D3). `depth = 0` = an item in a group; `depth ≥ 1` = a subitem (it has no group of its own; for display it inherits the root's group).

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `group_id` | varchar(26) | YES | NULL | FK → groups (RESTRICT). NOT NULL when `depth=0`; NULL when `depth≥1` (CHECK) |
| `parent_item_id` | varchar(26) | YES | NULL | FK → items (CASCADE). NULL ⇔ `depth=0` (CHECK) |
| `root_item_id` | varchar(26) | YES | NULL | FK → items. The tree's root (depth 0); NULL for the root itself. Denormalized to fetch a whole tree in one query |
| `depth` | integer | NO | 0 | 0..5 (CHECK; the service enforces `depth ≤ effectiveDepthMax(boards.hierarchy_depth_max)`) |
| `position` | text | NO | — | LexoRank among siblings (same group / same parent) |
| `name` | varchar(255) | NO | — | 1..255, not empty (the `name` column's cell is **not** stored in `cells` — this field is it) |
| `key_seq` | integer | YES | NULL | The running number of the custom key (`item_id` column) — set on creation, never changes |
| `created_by` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `creator_type` | actor_type | NO | `'user'` | For `creation_log` (form/email/automation) |
| `last_cell_change_at` | timestamptz | YES | NULL | Source of the `last_updated` column (cell changes only, not updates) |
| `last_cell_change_by` | varchar(26) | YES | NULL | FK → users |
| `child_count` | integer | NO | 0 | Number of active direct children (cache; maintained by the service) |
| `source_item_id` | bigint | YES | NULL | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `archived_at` / `deleted_at` | timestamptz | YES | NULL | |

Indexes:
- `ix_items_board_group_position (board_id, group_id, position) WHERE deleted_at IS NULL AND depth = 0` — the main table scan.
- `ix_items_parent_position (parent_item_id, position) WHERE deleted_at IS NULL` — children.
- `ix_items_root (root_item_id) WHERE root_item_id IS NOT NULL` — loading a tree.
- `ix_items_board_deleted (board_id, deleted_at)` — trash / purge.
- `ix_items_name_trgm` GIN `gin_trgm_ops` on `name` — search.
- `ix_items_created_by (account_id, created_by)` — `view_items=assigned_or_created`.
- `ux_items_board_key_seq (board_id, key_seq) WHERE key_seq IS NOT NULL`.
- `ux_items_source (account_id, source_item_id) WHERE source_item_id IS NOT NULL`.

### 3.10 `cells`
One row per `(item, column)` **that has a value**. No row = an empty cell. Clearing a cell = deleting the row (and an activity_log event with the previous value).

| column | type | null | default | notes |
|---|---|---|---|---|
| `item_id` | varchar(26) | NO | — | FK → items (CASCADE) |
| `column_id` | varchar(26) | NO | — | FK → columns (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE). Denormalized for whole-board queries and RLS |
| `value` | jsonb | NO | — | Shape per the type's `valueSchema` (03-COLUMN-TYPES). Never `null` — an empty cell is a row that does not exist |
| `text_value` | text | YES | NULL | The type's `toText(value, settings)` — for search, `contains_text`, alphabetical sort, export |
| `number_value` | double precision | YES | NULL | Numeric `sortKey` (numbers, rating, vote count, progress %, status index, checkbox 0/1, time_tracking seconds, auto_number) |
| `date_value` | timestamptz | YES | NULL | Time `sortKey` (date, timeline.from, week.start, creation/last_updated, hour as UTC today) |
| `date_end_value` | timestamptz | YES | NULL | timeline.to / week.end — for `END_DATE` filtering and Gantt queries |
| `updated_at` | timestamptz | NO | now() | |
| `updated_by` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `updated_by_type` | actor_type | NO | `'user'` | |

PK `(item_id, column_id)`. The three sort columns are **computed in the service layer** on every write (not Postgres `GENERATED`, because the derivation depends on the column's type and settings), and recomputed in a batch when `settings` change (for example reordering status labels).

Indexes:
- `ix_cells_board (board_id)` — loading a whole board (`SELECT … WHERE board_id = $1 AND item_id = ANY($2)`).
- `ix_cells_column_number (column_id, number_value)`, `ix_cells_column_date (column_id, date_value)`, `ix_cells_column_text (column_id, text_value)` — sort/filter by column.
- `ix_cells_value_gin` GIN `jsonb_path_ops` on `value` — `any_of` filtering on arrays (`value @> '{"ids":[3]}'`, people, tags, linked item ids).
- `ix_cells_text_trgm` GIN `gin_trgm_ops` on `text_value` — free-text board search and Search Everything.
- `ix_cells_column_updated (column_id, updated_at)` — "within the last".

### 3.11 `item_links`
Links between items for `board_relation` and `dependency`. Each row is one direction: *item `from_item_id`, in column `column_id`, points to `to_item_id`*.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `column_id` | varchar(26) | NO | — | FK → columns (CASCADE). The column where the link is shown (on `from_item`'s board) |
| `from_item_id` | varchar(26) | NO | — | FK → items (CASCADE) |
| `to_item_id` | varchar(26) | NO | — | FK → items (CASCADE) |
| `position` | text | NO | — | Display order in the cell |
| `created_by` | varchar(26) | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

Unique: `ux_item_links_col_from_to (column_id, from_item_id, to_item_id)`. Indexes: `ix_item_links_to (to_item_id, column_id)` (reverse lookup), `ix_item_links_from (from_item_id)`.

**Deriving two-way links and mirrors**
1. A `board_relation` column with `settings.two_way = true` gets `settings.reflection_column_id` = the ULID of a `board_relation` column on the target board (created automatically, with `settings.two_way=true, reflection_column_id=<the source>`). The two columns are a symmetric pair.
2. Writing a link A→B in column X inserts **two** rows into `item_links` in the same transaction: `(X, A, B)` and `(X', B, A)`; removing it deletes both. There is no "primary direction" — each column reads only its own rows.
3. The relation column's `cells` row holds a cache: `{"item_ids":[…]}` + `text_value` = the linked items' names (comma-separated). The service updates the cache on **both** sides on every link change, and the `text_value` of every linking item when an item's name changes.
4. `mirror` does not write to `item_links` on its own: its value is computed **at read time** (a JOIN over `item_links` → the source column's `cells`, batched across boards in `boards.repo.ts`), aggregated per the column's rollup. Editing a mirror cell in the UI = writing to the source cell (if the user may edit it there).
5. Mirror-of-mirror limit: 2 levels (checked when the column is created).

### 3.12 `item_tags`

| column | type | null | default | notes |
|---|---|---|---|---|
| `item_id` | varchar(26) | NO | — | FK → items (CASCADE) |
| `column_id` | varchar(26) | NO | — | FK → columns (CASCADE) |
| `tag_id` | varchar(26) | NO | — | FK → tags (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `position` | text | NO | — | |
| `created_at` | timestamptz | NO | now() | |

PK `(item_id, column_id, tag_id)`; index `ix_item_tags_tag (tag_id)`. The tags column's `cells` row holds a cache `{"tag_ids":[…]}`.

### 3.13 `time_entries`
The time-tracking log of `time_tracking` columns (03-COLUMN-TYPES §3.3; replaces `time_tracking_sessions`, which was never written, migrations `0003`/`0004`). This is the source of truth for billing hours; the `cells` row holds a cache `{ duration, running, runners?: [{user_id, since}], entries_count }` written in the same transaction.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) — for reports |
| `item_id` | varchar(26) | NO | — | FK → items (CASCADE) |
| `column_id` | varchar(26) | NO | — | FK → columns (CASCADE) |
| `user_id` | varchar(26) | YES | NULL | FK → users (SET NULL) — whose time it is |
| `started_at` | timestamptz | NO | — | |
| `ended_at` | timestamptz | YES | NULL | NULL = running |
| `duration_s` | integer | YES | GENERATED | `extract(epoch from ended_at - started_at)` |
| `source` | time_entry_source | NO | `'timer'` | `timer \| manual \| automation \| import` |
| `note` | text | YES | NULL | |
| `billable` | boolean | NO | true | Default from `settings.billable_default` |
| `edited_by` | varchar(26) | YES | NULL | FK → users — who edited it / logged it on someone else's behalf |
| `edited_at` | timestamptz | YES | NULL | An edited entry is marked in the UI |
| `created_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | Trash |

Indexes: `ix_time_entries_item (item_id, column_id, started_at)`; `ix_time_entries_board_started (board_id, started_at)`; `ix_time_entries_user_started (account_id, user_id, started_at)`; **`ux_time_entries_running_cell (item_id, column_id, user_id) WHERE ended_at IS NULL AND deleted_at IS NULL`** — several timers may run at once, but only one per user per cell (migration `0005`).

### 3.14 `item_keys`
Sequences for the custom key (`item_id` column, `displayType: customKey`). The prefix is unique **per account** (one board per prefix) and stays reserved until the column is deleted.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `column_id` | varchar(26) | NO | — | FK → columns (CASCADE) |
| `prefix` | varchar(12) | NO | — | `^[A-Z0-9]{1,10}$` (capital letters/digits; a hyphen is added on display) |
| `padding` | integer | NO | 3 | 0..12 |
| `next_seq` | integer | NO | 1 | Allocated with `UPDATE … SET next_seq = next_seq + 1 RETURNING` (atomic) |
| `created_at` / `updated_at` | timestamptz | NO | now() | |

Unique: `ux_item_keys_account_prefix (account_id, prefix)`; `ux_item_keys_column (column_id)`.

---

## 4. Tables — updates, files

### 4.1 `updates`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `item_id` | varchar(26) | NO | — | FK → items (CASCADE) |
| `parent_update_id` | varchar(26) | YES | NULL | FK → updates (CASCADE); a reply (one level only — a reply to a reply gets the same parent) |
| `body_html` | text | NO | — | Produced on the server only: from `body_json` through an allowlist (`shared/rich.ts`: p, h2, h3, strong, em, u, s, mark, code, pre, a[http/https/mailto], ul, ol, li, task list, blockquote, hr, br, span.mention) or from plain text (`renderUpdateBody`). HTML from the browser is never stored |
| `body_json` | jsonb | YES | NULL | The editor document (ProseMirror JSON, up to 200KB) — what opens for editing; NULL = a plain-text update |
| `body_text` | text | NO | — | Plain text for search, notifications and `toText` |
| `source` | update_source | NO | `'user'` | |
| `status_column_id` | varchar(26) | YES | NULL | FK → columns (SET NULL). An update written from a status cell ("+") |
| `status_label_id` | integer | YES | NULL | The label at the time of writing |
| `is_pinned` | boolean | NO | false | |
| `email_message_id` | varchar(255) | YES | NULL | For deduplicating inbound email |
| `created_by` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `created_at` | timestamptz | NO | now() | |
| `edited_at` | timestamptz | YES | NULL | |
| `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ix_updates_item_created (item_id, created_at DESC) WHERE deleted_at IS NULL`; `ix_updates_parent (parent_update_id)`; `ix_updates_board_created (board_id, created_at DESC)`; `ix_updates_body_trgm` GIN on `body_text`; `ux_updates_email_msg (account_id, email_message_id) WHERE email_message_id IS NOT NULL`.

### 4.2 `update_mentions`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `update_id` | varchar(26) | NO | — | FK → updates (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `user_id` | varchar(26) | YES | NULL | FK → users (CASCADE) |
| `team_id` | varchar(26) | YES | NULL | FK → teams (CASCADE) |
| `mention_everyone` | boolean | NO | false | `@everyone` — all board subscribers |
| `created_at` | timestamptz | NO | now() | |

Unique: `ux_update_mentions_user (update_id, user_id)`, `ux_update_mentions_team (update_id, team_id)`. Index `ix_update_mentions_user (user_id, created_at)`.

### 4.3 `update_likes`

| column | type | null | default | notes |
|---|---|---|---|---|
| `update_id` | varchar(26) | NO | — | FK → updates (CASCADE) |
| `user_id` | varchar(26) | NO | — | FK → users (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `reaction` | varchar(16) | NO | `'like'` | `REACTIONS` in `shared/api/updates.ts`: `like|heart|laugh|party|wow|sad` (👍 ❤️ 😂 🎉 😮 😢) |
| `created_at` | timestamptz | NO | now() | |

PK `(update_id, user_id, reaction)` — a user can give several different reactions to the same update (migration `0002_rich_updates_reactions`). `like` = the original like.

### 4.4 `assets`
A file in S3 storage (or an external link, or a doc). Versions: a new file with `parent_asset_id` = the first version; `version` increments; the current version is `MAX(version)`. `cell_files`/`update_files` always point at the **version root** (`parent_asset_id IS NULL`).

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `owner_id` | varchar(26) | YES | NULL | FK → users (SET NULL); the uploader |
| `kind` | asset_kind | NO | `'file'` | |
| `storage_key` | text | YES | NULL | `acc/<account_id>/<ulid>/<filename>`; NULL for `link` |
| `external_url` | text | YES | NULL | For `link` (Google Drive/Dropbox/URL) |
| `file_name` | varchar(255) | NO | — | |
| `mime` | varchar(127) | NO | `'application/octet-stream'` | |
| `size` | bigint | NO | 0 | bytes; ≤ 524,288,000 (500 MB, DECISIONS D2) |
| `width` / `height` | integer | YES | NULL | For images |
| `sha256` | varchar(64) | YES | NULL | Optional deduplication |
| `parent_asset_id` | varchar(26) | YES | NULL | FK → assets (CASCADE) |
| `version` | integer | NO | 1 | |
| `upload_status` | varchar(16) | NO | `'pending'` | `pending` (presigned URL issued) → `ready` (verified with HEAD) → `failed`. A job cleans up `pending` older than 24h |
| `created_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ix_assets_account_created (account_id, created_at)`; `ix_assets_parent_version (parent_asset_id, version)`; `ix_assets_owner (owner_id)`.

### 4.5 `cell_files`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `item_id` | varchar(26) | NO | — | Composite FK `(item_id, column_id)` → `cells` (CASCADE) |
| `column_id` | varchar(26) | NO | — | |
| `asset_id` | varchar(26) | NO | — | FK → assets (CASCADE) |
| `position` | text | NO | — | |
| `created_by` | varchar(26) | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

Unique: `ux_cell_files (item_id, column_id, asset_id)`. The file column's `cells.value` = a `{"files":[{asset_id, name, kind}]}` cache.

### 4.6 `update_files`

| column | type | null | default | notes |
|---|---|---|---|---|
| `update_id` | varchar(26) | NO | — | FK → updates (CASCADE) |
| `asset_id` | varchar(26) | NO | — | FK → assets (CASCADE) |
| `account_id` | varchar(26) | NO | — | FK |
| `position` | text | NO | — | |
| `created_at` | timestamptz | NO | now() | |

PK `(update_id, asset_id)`.

---

## 5. Tables — views, forms

### 5.1 `views`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `type` | view_type | NO | `'table'` | |
| `name` | varchar(120) | NO | — | |
| `settings` | jsonb | NO | `{}` | See §5.1.1 |
| `is_locked` | boolean | NO | false | Locked = only owners/admins change its settings |
| `is_default` | boolean | NO | false | The "default table"; one per board (`ux_views_default (board_id) WHERE is_default`) |
| `position` | text | NO | — | Tab order |
| `created_by` | varchar(26) | YES | NULL | |
| `revision` | integer | NO | 1 | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Index `ix_views_board_position (board_id, position) WHERE deleted_at IS NULL`. Limit: ≤ 100 views per board.

#### 5.1.1 `views.settings` (Zod `ViewSettings`, shared keys + per type)
```jsonc
{
  "filter": {                       // AND of groups; each group is an OR of rules (an "advanced filter")
    "groups": [ { "rules": [ { "column_key": "status", "operator": "any_of", "value": [1, 3] } ] } ],
    "quick": { "search": "", "person_user_id": null }
  },
  "sort": [ { "column_key": "date", "direction": "asc" } ],
  "group_by": null,                 // column_key (status/people/date/dropdown/checkbox) or null = by the board's groups
  "hidden_columns": ["long_text_x"],
  "column_order": null,             // null = the board's order; otherwise an array of column_key
  "column_widths": { "status": 160 },
  "frozen_until_column_key": "name",
  "collapsed_groups": [],
  "row_height": "single",           // single|double|triple
  "show_subitems": "collapsed",     // collapsed|expanded|flat
  // kanban
  "kanban": { "column_key": "status", "card_fields": ["people","date"], "hide_empty_lanes": false },
  // calendar / timeline / gantt
  "calendar": { "date_column_keys": ["date"], "color_by": "group" },
  "timeline": { "column_key": "timeline", "color_by": "group", "label_by": null },
  "gantt": { "column_key": "timeline", "dependency_column_key": "deps", "show_baseline": false },
  // cards
  "cards": { "cover_column_key": "file", "fields": ["status","people"] },
  // workload
  "workload": { "people_column_key": "people", "effort": { "mode": "item_count" | "column", "column_key": null }, "capacity_per_day": 8 },
  // chart
  "chart": { "kind": "bar", "x_column_key": "status", "y": { "mode": "count" | "sum", "column_key": null }, "cumulative": false }
}
```

### 5.2 `forms`
A form = a view of type `form` + its publishing data. One row per form view.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | NO | — | FK → boards (CASCADE) |
| `view_id` | varchar(26) | NO | — | FK → views (CASCADE), **UNIQUE** |
| `slug` | varchar(64) | NO | — | Globally **UNIQUE**; public URL `/f/<slug>` — the public token, 24 random `[a-z0-9]` characters, replaced with `POST /views/:id/form/token` |
| `title` | varchar(255) | NO | — | |
| `description` | text | YES | NULL | |
| `password_hash` | text | YES | NULL | argon2id; NULL = no password |
| `is_active` | boolean | NO | true | |
| `require_login` | boolean | NO | false | If true — only the account's users (guests included) |
| `target_group_id` | varchar(26) | YES | NULL | FK → groups (SET NULL); NULL = `boards.settings.default_group_id` |
| `questions` | jsonb | NO | `[]` | `formQuestionSchema` (`packages/shared/src/api/forms.ts`) — `[{ id, column_key, label, help, required, hidden, default_value?, condition: {question_id, equals} \| null, files?: {max_mb, kinds, max_files} }]`; order = array order |
| `settings` | jsonb | NO | `{}` | `formSettingsSchema` — `{ language, submit_label, success_message, redirect_url, logo_asset_id, cover_asset_id, show_account_branding, close_at, max_submissions, allow_embed, turnstile_site_key }` + `turnstile_secret_sealed` (encrypted, server side only) |
| `created_by` | varchar(26) | YES | NULL | |
| `revision` | integer | NO | 1 | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |

### 5.3 `form_submissions`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `form_id` | varchar(26) | NO | — | FK → forms (CASCADE) |
| `item_id` | varchar(26) | YES | NULL | FK → items (SET NULL) — the item that was created |
| `submitted_by` | varchar(26) | YES | NULL | FK → users; NULL = anonymous |
| `submitter_email` | varchar(320) | YES | NULL | |
| `ip` | inet (varchar(45)) | YES | NULL | Unused (only a hash is stored) |
| `ip_hash` | varchar(64) | YES | NULL | Migration 0048: HMAC-SHA256 of the client's real address (S-10) — for counting and abuse checks; the address itself is not stored |
| `user_agent` | varchar(120) | YES | NULL | A summary ("Chrome 131 · Android"), not the raw header |
| `answers` | jsonb | NO | `{}` | A snapshot of the raw answers |
| `created_at` | timestamptz | NO | now() | |

Index `ix_form_submissions_form_created (form_id, created_at)`.

---

## 6. Tables — automations, events, webhooks, tokens

### 6.1 `automations`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | YES | NULL | FK → boards (CASCADE); NULL = account level (e.g. "every day at 08:00 …") |
| `title` | varchar(255) | NO | — | The recipe sentence ("When Status changes to Won, send a webhook") |
| `recipe` | jsonb | NO | — | `{ "trigger": {type, …}, "conditions": [{type, …}], "actions": [{type, …}] }` — exactly the shape of `seed/automations/*.json` |
| `is_active` | boolean | NO | true | |
| `owner_id` | varchar(26) | YES | NULL | FK → users (SET NULL); the automation runs **with the owner's permissions** |
| `created_from_template_id` | varchar(26) | YES | NULL | FK → templates (SET NULL) |
| `seed_key` | varchar(32) | YES | NULL | `L1`, `A7` … from the seed |
| `run_count` | integer | NO | 0 | |
| `last_run_at` | timestamptz | YES | NULL | |
| `last_error_at` | timestamptz | YES | NULL | |
| `created_by` | varchar(26) | YES | NULL | |
| `revision` | integer | NO | 1 | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Indexes: `ix_automations_board_active (board_id, is_active) WHERE deleted_at IS NULL`; `ix_automations_trigger_type (account_id, (recipe->'trigger'->>'type')) WHERE is_active AND deleted_at IS NULL` (an expression index — in a SQL migration).

### 6.2 `automation_runs`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `automation_id` | varchar(26) | NO | — | FK → automations (CASCADE) |
| `event_id` | varchar(26) | YES | NULL | The triggering `activity_log.id` (no FK — the table is partitioned); NULL for a scheduled trigger |
| `item_id` | varchar(26) | YES | NULL | FK → items (SET NULL) |
| `status` | automation_run_status | NO | `'pending'` | |
| `started_at` | timestamptz | YES | NULL | |
| `finished_at` | timestamptz | YES | NULL | |
| `error` | text | YES | NULL | |
| `actions_log` | jsonb | NO | `[]` | `[{ index, type, status, started_at, finished_at, result, error }]` |
| `created_at` | timestamptz | NO | now() | |

Indexes: `ix_automation_runs_automation_created (automation_id, created_at DESC)`; `ix_automation_runs_status (account_id, status) WHERE status IN ('pending','running')`; `ux_automation_runs_event (automation_id, event_id) WHERE event_id IS NOT NULL` (idempotency — one event triggers an automation once).
### 6.3 `activity_log` — the event bus and the source of undo
**Every write** in the service layer adds a row here in the same transaction. The worker (graphile-worker) receives `NOTIFY activity_log_insert` and processes triggers; a board's SSE stream is derived from it; "Undo" restores from `payload.before`.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | ULID |
| `account_id` | varchar(26) | NO | — | (No FK — partitioned; integrity enforced in the service) |
| `board_id` | varchar(26) | YES | NULL | |
| `item_id` | varchar(26) | YES | NULL | |
| `column_id` | varchar(26) | YES | NULL | |
| `actor_id` | varchar(26) | YES | NULL | users.id; NULL for system |
| `actor_type` | actor_type | NO | `'user'` | |
| `automation_id` | varchar(26) | YES | NULL | When the change was caused by an automation (prevents loops: chain depth ≤ 5) |
| `type` | varchar(64) | NO | — | See the catalog in §6.3.1 |
| `payload` | jsonb | NO | `{}` | `{ "before": …, "after": …, "meta": … }` |
| `batch_id` | varchar(26) | YES | NULL | Groups a batch of operations (undone together) |
| `request_id` | varchar(64) | YES | NULL | For correlating with logs |
| `undone_at` | timestamptz | YES | NULL | |
| `undone_by_event_id` | varchar(26) | YES | NULL | |
| `created_at` | timestamptz | NO | now() | The partition key |

PK `(id, created_at)`. **`PARTITION BY RANGE (created_at)`** — declared in the hand-written migration `0000_init.sql` with a catch-all `activity_log_default` partition; monthly partitions (`activity_log_yYYYYmMM`) can be attached alongside it. Drizzle does not declare partitions (drizzle-kit sees a plain table). Retention: the daily `maintenance.retention` job deletes rows older than the platform owner's setting (owner console → Platform settings → Retention; empty = keep).
Indexes (on every partition): `ix_al_account_created (account_id, created_at DESC)`; `ix_al_board_created (board_id, created_at DESC)`; `ix_al_item_created (item_id, created_at DESC)`; `ix_al_type (account_id, type, created_at DESC)`; `ix_al_batch (batch_id)`.

#### 6.3.1 The `type` catalog (strings; the registry is in `packages/shared/events.ts`)
`item.created`, `item.renamed`, `item.moved_group`, `item.moved_board`, `item.moved_parent`, `item.archived`, `item.restored`, `item.deleted`, `item.duplicated`,
`cell.changed` (payload: `{column_key, type, before, after}`), `cell.cleared`,
`item_link.added`, `item_link.removed`,
`update.created`, `update.edited`, `update.deleted`, `update.liked`, `update.mentioned`,
`file.added`, `file.removed`, `file.version_added`,
`group.created`, `group.renamed`, `group.recolored`, `group.moved`, `group.archived`, `group.deleted`, `group.restored`,
`column.created`, `column.updated` (title/settings/permissions), `column.moved`, `column.archived`, `column.deleted`, `column.restored`,
`board.created`, `board.updated`, `board.moved`, `board.archived`, `board.deleted`, `board.restored`, `board.member_added`, `board.member_removed`, `board.permissions_changed`,
`view.created`, `view.updated`, `view.deleted`, `form.submitted`,
`automation.created`, `automation.updated`, `automation.toggled`, `automation.deleted`,
`workspace.*`, `folder.*`, `member.*` (joining / role), `subscription.added`, `subscription.removed`,
`schedule.tick` (scheduled triggers — produced by the worker), `button.clicked`, `time_tracking.started`, `time_tracking.stopped`, `vote.cast`, `vote.removed`.

### 6.4 `webhooks`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | YES | NULL | FK → boards (CASCADE); NULL = account |
| `url` | text | NO | — | https only |
| `event_type` | varchar(64) | NO | — | From §6.3.1, or `*` for the board; `column.changed:<column_key>` to filter by column |
| `config` | jsonb | NO | `{}` | `{ column_keys: [], group_ids: [], include_cells: bool, headers: {} }` |
| `secret` | varchar(128) | NO | — | HMAC-SHA256 (`X-Bines-Signature`), shown once |
| `is_active` | boolean | NO | true | |
| `challenge_verified_at` | timestamptz | YES | NULL | DECISIONS D7 — handshake |
| `failure_count` | integer | NO | 0 | Disabled automatically after 50 consecutive failures |
| `created_by` | varchar(26) | YES | NULL | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Index `ix_webhooks_board_event (board_id, event_type) WHERE is_active AND deleted_at IS NULL`.

### 6.5 `webhook_deliveries`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `webhook_id` | varchar(26) | NO | — | FK → webhooks (CASCADE) |
| `event_id` | varchar(26) | NO | — | activity_log.id |
| `status` | webhook_delivery_status | NO | `'pending'` | |
| `attempt` | integer | NO | 0 | Backoff: 1m, 5m, 30m, 2h, 12h → `dead` |
| `request_body` | jsonb | NO | `{}` | |
| `response_status` | integer | YES | NULL | |
| `response_body` | text | YES | NULL | ≤ 4 KB |
| `error` | text | YES | NULL | |
| `next_attempt_at` | timestamptz | YES | NULL | |
| `delivered_at` | timestamptz | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

Indexes: `ix_wd_webhook_created (webhook_id, created_at DESC)`; `ix_wd_pending (next_attempt_at) WHERE status = 'pending'`.
### 6.6 `api_tokens`
API tokens are our own table (Better Auth's `apikey` plugin is not used — see §0).

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `user_id` | varchar(26) | YES | NULL | FK → users (CASCADE); NULL = a service token (acts as `actor_type=api`, with admin permissions limited by `scopes`) |
| `name` | varchar(120) | NO | — | |
| `token_hash` | varchar(128) | NO | — | SHA-256 of the token; **UNIQUE** |
| `token_prefix` | varchar(12) | NO | — | `bos_` + 8 characters, for identification in the UI |
| `scopes` | jsonb | NO | `["boards:read"]` | `boards:read, boards:write, items:read, items:write, updates:write, files:write, automations:manage, webhooks:manage, admin` |
| `board_ids` | jsonb | YES | NULL | Restricts to specific boards; NULL = by the user's permissions |
| `rate_limit_per_minute` | integer | NO | 600 | |
| `last_used_at` | timestamptz | YES | NULL | |
| `expires_at` | timestamptz | YES | NULL | |
| `created_by` | varchar(26) | YES | NULL | |
| `revoked_at` | timestamptz | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

Indexes: `ux_api_tokens_hash (token_hash)`; `ix_api_tokens_account (account_id) WHERE revoked_at IS NULL`.

### 6.7 `idempotency_keys` (DECISIONS D7)

| column | type | null | default | notes |
|---|---|---|---|---|
| `key` | varchar(128) | NO | — | `Idempotency-Key` header |
| `account_id` | varchar(26) | NO | — | |
| `principal_id` | varchar(26) | NO | — | user_id or token_id |
| `request_hash` | varchar(64) | NO | — | SHA-256 of method+path+body |
| `response_status` | integer | YES | NULL | |
| `response_body` | jsonb | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

PK `(account_id, principal_id, key)`. Retention: 24h (hourly job `maintenance.idempotency_purge`).

---

## 7. Tables — notifications, tags, templates, trash, admin

### 7.1 `notifications`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `user_id` | varchar(26) | NO | — | FK → users (CASCADE) |
| `type` | varchar(48) | NO | — | `mention`, `reply`, `assigned`, `update_on_subscribed_item`, `status_changed`, `date_reminder`, `automation_notify`, `invite`, `board_shared`, `form_submitted`, `like`, `system` |
| `payload` | jsonb | NO | `{}` | `{ title, body, url, actor_id, board_id, item_id, update_id, column_key }` |
| `board_id` | varchar(26) | YES | NULL | FK → boards (CASCADE) |
| `item_id` | varchar(26) | YES | NULL | FK → items (CASCADE) |
| `update_id` | varchar(26) | YES | NULL | FK → updates (CASCADE) |
| `actor_id` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `read_at` | timestamptz | YES | NULL | |
| `emailed_at` | timestamptz | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

Indexes: `ix_notifications_user_unread (user_id, created_at DESC) WHERE read_at IS NULL`; `ix_notifications_user_created (user_id, created_at DESC)`. Retention: the platform owner's setting (daily job `maintenance.retention`; empty = keep).

### 7.2 `notification_settings`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `user_id` | varchar(26) | NO | — | FK → users (CASCADE) |
| `channel` | notification_channel | NO | — | |
| `type` | varchar(48) | NO | `'*'` | A notification type or `*` |
| `board_id` | varchar(26) | YES | NULL | FK → boards (CASCADE); NULL = global. A row with board_id = mute/unmute per board |
| `enabled` | boolean | NO | true | |
| `digest` | varchar(16) | NO | `'instant'` | `instant|hourly|daily|off` (for email) |
| `updated_at` | timestamptz | NO | now() | |

Unique: `ux_notification_settings (user_id, channel, type, COALESCE(board_id,''))` (an expression — SQL migration). The default when no row exists: in_app on, email on for `mention|assigned|invite`.

### 7.3 `tags`
Account-level tags (shared by all `main` boards); `private`/`shareable` boards hold a separate set — `board_id` not NULL.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `board_id` | varchar(26) | YES | NULL | FK → boards (CASCADE); NULL = account |
| `name` | varchar(60) | NO | — | No `#`, no spaces |
| `color` | varchar(32) | NO | `'blue'` | A key from the group palette |
| `usage_count` | integer | NO | 0 | Cache |
| `created_by` | varchar(26) | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Unique: `ux_tags_scope_name (account_id, COALESCE(board_id,''), lower(name)) WHERE deleted_at IS NULL` (SQL migration). Index `ix_tags_name_trgm`.

### 7.4 `templates`
A snapshot of a board (or a whole workspace) in the `seed/templates/*.json` format (`board.schema.json`). Built-in templates: `account_id IS NULL`, `is_builtin = true`, loaded from the seed at boot (upsert by `key`).

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | YES | NULL | FK (CASCADE); NULL = built-in |
| `kind` | template_kind | NO | `'board'` | |
| `key` | varchar(64) | NO | — | `projects`, `project_multilevel` … |
| `name` | varchar(255) | NO | — | |
| `description` | text | YES | NULL | |
| `category` | varchar(48) | YES | NULL | `crm|projects|support|finance|portal|ops` |
| `snapshot` | jsonb | NO | — | board: `{ board, groups, columns, views, forms, automations, sample_items? }`; workspace: `{ workspace, folders, boards: [board snapshots] }` |
| `is_builtin` | boolean | NO | false | |
| `source_board_id` | varchar(26) | YES | NULL | FK → boards (SET NULL) — "Save as template" |
| `created_by` | varchar(26) | YES | NULL | |
| `created_at` / `updated_at` | timestamptz | NO | now() | |
| `deleted_at` | timestamptz | YES | NULL | |

Unique: `ux_templates_scope_key (COALESCE(account_id,''), key) WHERE deleted_at IS NULL` (SQL migration).

### 7.5 `trash_entries`
A trash record for every soft-deleted object. `restore_payload` holds what is needed to restore the **position** (group/parent/position/folder) and severed links — not the content (the content stays in its tables with `deleted_at`).

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `object_type` | trash_object_type | NO | — | |
| `object_id` | varchar(26) | NO | — | (No FK — polymorphic) |
| `object_name` | varchar(255) | NO | — | For display, even after purge |
| `board_id` | varchar(26) | YES | NULL | Context ("origin") |
| `parent_entry_id` | varchar(26) | YES | NULL | FK → trash_entries (CASCADE). Children of a nested deletion (the items of a deleted group) — only the parent is shown |
| `deleted_by` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `deleted_at` | timestamptz | NO | now() | |
| `purge_after` | timestamptz | NO | `deleted_at + 30 days` | |
| `restore_payload` | jsonb | NO | `{}` | `{ group_id, parent_item_id, position, folder_id, workspace_id, severed_links: [{column_id, from, to}] }` |
| `restored_at` | timestamptz | YES | NULL | |
| `purged_at` | timestamptz | YES | NULL | |

Indexes: `ix_trash_account_deleted (account_id, deleted_at DESC) WHERE restored_at IS NULL AND purged_at IS NULL`; `ix_trash_purge (purge_after) WHERE restored_at IS NULL AND purged_at IS NULL`; `ux_trash_object (object_type, object_id) WHERE restored_at IS NULL AND purged_at IS NULL`.

### 7.6 `audit_log`
Admin and security actions (not content changes — those are in `activity_log`).

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `actor_id` | varchar(26) | YES | NULL | FK → users (SET NULL) |
| `action` | varchar(64) | NO | — | `member.invited`, `member.role_changed`, `member.deactivated`, `token.created`, `token.revoked`, `support_access.granted`, `support_access.revoked`, `settings.changed`, `login.success`, `login.failed`, `password.changed`, `export.created`, `board.permissions_changed`, `trash.purged`, `impersonation.started` |
| `target_type` | varchar(32) | YES | NULL | |
| `target_id` | varchar(26) | YES | NULL | |
| `payload` | jsonb | NO | `{}` | |
| `ip` | varchar(45) | YES | NULL | |
| `user_agent` | text | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

Indexes: `ix_audit_account_created (account_id, created_at DESC)`; `ix_audit_actor (actor_id, created_at DESC)`. Retention: the platform owner's setting (daily job `maintenance.retention`; empty = keep until deleted by hand).

### 7.7 `account_settings`

| column | type | null | default | notes |
|---|---|---|---|---|
| `account_id` | varchar(26) | NO | — | PK, FK → accounts (CASCADE) |
| `settings` | jsonb | NO | `{}` | See below |
| `updated_by` | varchar(26) | YES | NULL | |
| `updated_at` | timestamptz | NO | now() | |

```jsonc
{
  "locale_default": "he", "timezone_default": "Asia/Jerusalem",
  "week_start": 0,                      // 0=Sunday
  "weekend_days": [5, 6],               // Fri-Sat (the Israeli default)
  "date_format": "DD/MM/YYYY", "time_format": "24h",
  "working_hours": { "start": 9, "end": 18 },
  "default_status_labels": [ /* StatusLabel[] */ ],
  "default_board_kind": "main",
  "guest_domains_blocklist": [],
  "allowed_email_domains": [],          // members must have a domain from the list (empty = no restriction)
  "security": { "session_max_hours": 720, "require_2fa_admins": false, "api_tokens_enabled": true, "public_forms_enabled": true },
  "permissions": { "members_can_create_workspaces": true, "members_can_invite_guests": true, "viewers_can_export": true,
                   "who_can_create_boards": "members", "who_can_delete_boards": "owners" },
  "retention": { "trash_days": 30, "activity_months": 24 },
  "branding": { "logo_asset_id": null, "primary_color": null, "portal_name": "Bines Portal" },
  "email_inbound_domain": "in.example.com"
}
```

### 7.8 `user_profile_settings`
Cross-account user preferences (DECISIONS D2: one Better Auth user can belong to several accounts).

| column | type | null | default | notes |
|---|---|---|---|---|
| `user_id` | varchar(26) | NO | — | PK, FK → users (CASCADE) |
| `settings` | jsonb | NO | `{}` | `{ theme: "system|light|dark", language: "he|en", date_format, time_format, week_start, number_format: "comma_period|period_comma", density, start_page, keyboard_shortcuts: bool, email_digest: "daily|off", my_work: { boards: [], columns: [] }, sidebar: { collapsed: bool, favorites: { [account_id]: [] } }, last_account_id: string \| null }` — `last_account_id` decides where `/` redirects (DECISIONS D12) |
| `updated_at` | timestamptz | NO | now() | |

### 7.9 `support_access_grants` (+ `support_recovery_requests`, migration 0050)
"Remote support access": an account admin grants support temporary access to the account — `platform` = anyone who is `users.is_platform_owner`, or `email` = whoever signs in with that verified email. While the grant is valid, that person acts as an admin of the account without a membership; `read` = read-only (every change returns 405 `support_read_only`), `read_write` = editing (but not managing people / tokens / security / support access). Every request is recorded in `audit_log` (`support.session.start|view|action|refused`). Enforcement: `modules/support/support.access.ts` (REST, MCP, docs WS, SSE). `users.is_support_staff` is unused — the column is kept but never read.

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK (CASCADE) |
| `granted_by` | varchar(26) | NO | — | FK → users |
| `granted_to_user_id` | varchar(26) | YES | NULL | FK → users; unused (`grantee_kind` + `granted_to_email` decide) |
| `grantee_kind` | varchar(16) | NO | `'platform'` | `platform|email` |
| `granted_to_email` | varchar(320) | YES | NULL | For `email` |
| `scope` | varchar(16) | NO | `'read'` | `read` (view) `|read_write` (edit) |
| `reason` | text | YES | NULL | |
| `expires_at` | timestamptz | NO | — | Durations from the owner console (default 1/4/24/168 hours), ≤ the platform's and the account's maximum |
| `revoked_at` / `revoked_by` | timestamptz / varchar(26) | YES | NULL | |
| `last_used_at` | timestamptz | YES | NULL | A pause longer than `session_idle_minutes` = a new session (audit + email) |
| `created_at` | timestamptz | NO | now() | |

Index `ix_support_grants_account_active (account_id, expires_at) WHERE revoked_at IS NULL`.

`support_recovery_requests` — the emergency path for the owner console's recovery link (without a grant): `account_id`, `requested_by`, `target_user_id`, `target_email`, `reason`, `available_at` (= now + `emergency_delay_hours`, default 24), `cancelled_at/by` (any admin), `used_at` (single use). Index `ix_support_recovery_account (account_id, created_at desc)`.

### 7.10 `import_jobs`

| column | type | null | default | notes |
|---|---|---|---|---|
| `id` | varchar(26) | NO | — | PK |
| `account_id` | varchar(26) | NO | — | FK |
| `source` | varchar(16) | NO | `'file'` | `file|csv|excel|template` |
| `status` | varchar(16) | NO | `'pending'` | `pending|running|succeeded|failed|cancelled` |
| `config` | jsonb | NO | `{}` | `{ workspace_id, folder_id, column_mapping, include_updates, include_files }` |
| `progress` | jsonb | NO | `{}` | `{ boards: {done, total}, items: {…}, updates: {…}, files: {…} }` |
| `id_map` | jsonb | NO | `{}` | `{ boards: {<source_id>: ulid}, columns: {…}, groups: {…}, items: {…}, users: {…} }` — for linking relation columns in a second pass |
| `log` | jsonb | NO | `[]` | |
| `error` | text | YES | NULL | |
| `created_by` | varchar(26) | YES | NULL | |
| `started_at` / `finished_at` | timestamptz | YES | NULL | |
| `created_at` | timestamptz | NO | now() | |

### 7.11 `ai_connections` + `ai_usage` (DECISIONS D26)

`ai_connections`: `id`, `account_id` FK, `name`, `provider` (one of `AI_PROVIDERS` in `packages/shared/src/ai/models.ts`: `anthropic`, `openai`, `gemini`, `openai_compatible`, `soniox`), `key_enc` (AES-256-GCM `v1.iv.tag.data`, never returned), `key_hint` (`…AbCd`), `default_model`, `last_test` jsonb `{ok, at, error}`, `last_used_at`, `created_by`, `created_at`, `updated_at`, `deleted_at` (soft).
`ai_usage`: PK (`account_id`, `day`, `source` agent/column/assistant/test, `connection_id`, `model`) → `calls`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd` (from each call's real usage × `packages/shared/src/ai/models.ts`). Upserted after every model call.
MCP action log: trigger `tr_activity_log_mcp_actor` (migration 0025) stamps rows written inside `set_config('bines.mcp', …)` — `actor_type='api'`, `payload.meta.via='mcp'`, `payload.meta.mcp`, `batch_id` of the tool call.

### 7.12 OAuth for MCP (migration `mcp2_oauth`)

Our own small authorization server (`apps/api/src/modules/oauth`); every secret is stored as SHA-256 only.
`oauth_clients` (platform-wide): `id`, `client_id` unique (`bos_cli_…` for DCR, the https URL for a Client ID Metadata Document), `kind` (`dcr`/`cimd`), `client_name`, `client_uri`, `logo_uri`, `redirect_uris` jsonb, `auth_method` (`none`/`client_secret_post`/`client_secret_basic`), `secret_hash`, `fetched_at`, `fresh_until` (CIMD cache, 1 h).
`oauth_grants`: one authorization request — `client_pk`, `redirect_uri`, `state`, `code_challenge` (S256), `requested_scopes`, `resource`, `status` (`pending`→`approved`→`used` / `denied`), then the consent: `user_id`, `account_id`, `scopes`, `board_ids`, `code_hash` (2 min), `connection_id`; `expires_at` (15 min).
`mcp_connections`: `account_id` FK, `user_id`, `client_pk`, `client_name`, `scopes`, `board_ids` (null = all the user sees), `last_used_at`, `revoked_at`, `revoked_by`. One user × one account (DECISIONS D12); reconnecting the same app to the same account replaces the row.
`oauth_tokens`: `account_id`, `connection_id`, `kind` (`access` 1 h / `refresh` 30 d), `token_hash` unique, `resource` (audience = `WEB_ORIGIN/mcp`), `expires_at`, `used_at` (refresh tokens rotate — a replay revokes the connection), `revoked_at`.

### 7.13 Column type conversion (DECISIONS D28, migration `0044_convert`)

`column_conversions`: one type change of a column (`kind` `convert`) or a restore from a conversion's backup (`restore`, `restore_of`): `account_id`, `board_id`, `column_id` FKs, `from_type`/`from_settings`, `to_type`/`to_settings` (the target's labels decided once for the whole column), `options` (the preview's choices), `status` (`running`/`done`/`failed`/`undone`), `total`/`done` (progress of a background run), `item_count`, `converted`/`empty`/`failed`/`partial`, `report` (`dependents` — what else it touched — and `undo`: the before-state of views, automations and widgets it changed), `event_id` (the `column.type_changed` event, undoable as one step), `batch_id`, `error`, `failed_cleared_at` (the board stops marking failed cells), `backup_purged_at` (retention: `account_settings.settings.conversions.backup_days`, default 90, 0 = forever), `created_by`, `created_at`, `finished_at`, `undone_at`.
`column_conversion_cells` (PK `conversion_id, item_id`): every cell that had a value — `outcome` (`converted`/`empty`/`failed`), `partial`, `old_value` + its keys (`old_text`/`old_number`/`old_date`/`old_date_end`), `new_value` + its keys. The switch replaces the column's cells with the new side (set-based); an undo with the old side.
`columns.converting_id`: set while a background conversion runs — cell writes, settings changes and deletes answer 423 `column_converting`.

### 7.14 Subscription plans (migration `0053_plans`)

`plans` (platform-level, no `account_id`): `name`, `description`, `visibility` (`public` offered / `hidden` owner-assigned only), `sort`, `archived_at`. A plan an account ever had is never deleted (409 `plan_in_use`) — it is archived.
`plan_versions`: `plan_id`, `version` (unique per plan), `price_monthly_minor` / `price_yearly_minor` (minor units), `currency`, `vat_included`, `pricing` (`flat` / `per_seat`), `limits` (jsonb PlanLimits: `seats`, `boards`, `items`, `storage_gb`, `automation_runs`, `ai_usd`, `api_calls_per_day`; absent / null = unlimited), `features` (jsonb keys of the owner's catalogue), `trial_days`. A version any subscription used is immutable (409 `version_in_use`): a new price = a new version; accounts keep theirs (grandfathering). New assignments default to the newest.
`account_subscriptions`: the history of an account's plans; the current one has `ended_at is null` (unique partial index). `plan_version_id` (restrict), `status` (`subscription_status`: trial / active / past_due / read_only / suspended / closed) + `status_since`, `status_message` (the owner's words to the account's members while it is closed; null = the platform's text), `interval` (month / year), `seats` (bought; caps the seat limit), `period_start` / `period_end`, `trial_ends_at`, `cancel_at_period_end`, `overrides` (jsonb: a number replaces the plan's limit, null = unlimited), `note`, `provider` / `external_id` (the billing provider's reference, when a provider bills the subscription), `trial_end_status` (DECISIONS D32, `0087_signup`: the row's own trial-end rule — `active` / `past_due` / `read_only`; null = the billing settings' `trial_end_status`; a trial ending in read-only by its own rule is suspended after `read_only_days`). No account gets a row by itself: none = legacy = unlimited.
`account_usage_counters` (PK `account_id, period, kind`): monthly consumption counters (`automation_runs`, period `YYYY-MM` UTC — a new month is a new row = the reset) and the once-a-period alert marks (`warned_at`, `reached_at`) of every kind.
The effective status is computed, not stored: billing settings (`platform_settings` row `billing`: `warn_pct`, `past_due_grace_days`, `read_only_days`, `trial_end_status`, `canceled_status`, `upgrade_text` / `upgrade_url`, `closed_text` / `contact_url` (the closed screen), `features` catalogue, `usage_period`) turn a trial past its end, a cancellation past the period end and a past_due beyond the grace into the next status (`effectiveSubscriptionStatus`, shared). Enforcement: `modules/billing/entitlements.ts`. `closed` (plan lock, migration 0072) is set by the platform owner only — no schedule reaches or leaves it: every account-scoped request answers 403 `account_closed` except `GET /plan` and the person's support tickets (never to a token); MCP, OAuth consent, live docs, public forms, inbound webhooks, outgoing webhooks and every background job of the account stop; nothing is deleted. Read-only / suspended / closed also stop all AI (`assertAiStatusAllows`).

The account's own cancellation (migration 0103): billing settings `cooling_off_days`, `cancel_fee_pct`, `cancel_fee_cap`, `yearly_refund` (`monthly_rate` | `pro_rata` | `none`), `renewal_reminder_days` and `change_notice_days` (the notice before a change to a plan's price, features or limits, `{{change_notice_days}}` in the terms); the rules are in `modules/billing/cancellation-rules.ts` (pure, unit-tested). `account_subscriptions.purchased_at` (paid online — the cancellation window counts from here), `cancellation` jsonb (`{case, refund_minor, currency, at, by, ends_at}`; a cancellation without a refund can be undone until the period ends) and `renewal_reminded_for` (one yearly reminder per period end, hourly job `billing.renewal_reminders`). The provider that bills a subscription carries out the cancellation and refund through its `SubscriptionControl` (`modules/billing/provider.ts`; the built-in Stripe connection registers one). Legal documents: `legal_documents.purchase_consent` (accepted at checkout, `legal_consents.context = checkout`), `legal_document_versions.material` (a minor version asks nobody again); `users.marketing_opt_in_at` and `signup_requests.marketing_opt_in` (the separate marketing checkbox).

Design notes
- **(a) Monthly period.** `automation_runs` and `ai_usd` count per calendar month in UTC (reset on the 1st), for every account whatever its billing day. The billing setting `usage_period` accepts only `calendar` (`PLAN_USAGE_PERIODS`).
- **(b) Seats.** A seat = an active or invited non-guest member, plus a pending non-guest invitation. Guests and service identities (`users.is_service`: service tokens, agents, extensions) never take a seat (`seatsUsed`, tested in `plans.test.ts` / `plan-features.test.ts`).
- **(c) Feature gates.** The code knows only the keys (`PLAN_FEATURE_KEYS`, `packages/shared/src/api/plans.ts`): `ai`, `automations_advanced`, `api`, `extensions`, `flows`, `dashboards`, `docs`, `forms`, `guests`; labels are in i18n (`plan.feature.<key>`), and the owner's catalogue may relabel them or add its own (shown, not enforced). Remote support access is never gated. `planIncludesFeature(list, key)`: legacy (null) and a version with an **empty** list = everything; only a version that lists features is restricted. Enforcement (402 `plan_feature_unavailable` {feature, upgrade: true}): the route table `modules/billing/feature-gates.ts` (writes only; reads and DELETE always pass) in `requireAccount`, plus `assertFeature` at the body / non-route points — AI column type and conversion, the AI model call (`completeWith`), AI column runs, agent runs (skipped `plan_feature_unavailable`), automation actions `webhook` / `send_email` / `send_sms` / `send_to_integrations` / `run_agent` (`PLAN_FEATURE_ACTIONS`: refused on save, skipped at run time — the automation stays on), form views (new / duplicate / first open) and public form answers, guest invitations, API-token use, the MCP server and OAuth app approval, the docs editor (opens read-only). Nothing is deleted or hidden: a dashboard / doc / form / token made before a downgrade stays readable, and works again after an upgrade. `/me/accounts` and `/auth/me` carry `plan_features` (null = all); `GET /plan` carries `entitlements.all_features` and `feature_access` [{key, label, included, gated}].

### 7.15 Errors & health hub (migration `errhub`)

`error_events` (platform-level, `account_id` nullable): one row per distinct failure — `fingerprint` (unique; FNV-64 of source + code + normalized message + account + entity link, `errorFingerprint` in shared), `source` (`ERROR_SOURCES`), `code`, `severity` (info / warning / error / critical — a repeat keeps the highest), `message` (varchar 300, always `redactErrorMessage`: no credentials, addresses, quoted values, numbers, query strings), `links` (jsonb, ids only: board / item / automation / run / agent / flow / webhook / installation / job / request id / page), `count`, `first_seen_at` / `last_seen_at`, `status` (new / acknowledged / resolved / ignored), `assignee_id` (support staff or owner), `muted_until`, `resolved_at` / `resolved_by` (null = resolved by itself), `reopened_count`, `ticket_id`, `note` (support only). A resolved row that happens again reopens (`new`); an ignored one stays ignored.
`error_event_hours` (PK `event_id, hour`): occurrences per hour — alert windows, the "spikes" view, the detail's 24-hour bars; kept 8 days.
`error_alerts`: alerts that fired (`rule_id`, `mode` instant / digest / account, `event_ids`, `recipients` = who sees it in the console's bell, `read_by`, `dedupe_key`).
Settings: `platform_settings` row `errors` (`errorHubSettingsSchema`): sources on/off + default severity, problem skips, retention per severity, auto-resolve hours, writer queue / flush, browser errors (on, sample rate, per person per hour), spikes, alert rules + digest hour / zone + mutes, the accounts' Health page (sources, admin alerts — off by default), GlitchTip address. Written by the API's batched writer (`modules/errors/errors.writer.ts`) and the worker (`repositories/errors.repo.ts`).

#### Support agent (migration `0095_support_agent`)

An AI that investigates an error or a ticket for the owner console. Platform-level rows: an error may have no account.
- `support_agent_runs`: `error_event_id` / `ticket_id` / `account_id` (SET NULL), `trigger` (manual / auto), `status`
  (queued / running / succeeded / failed / stopped), `prompt` (what the person asked), `model`, `report` (jsonb:
  `supportAgentReportSchema`: summary, root cause, evidence with refs, impact, proposed fix, confidence),
  `final_text`, `error` (why it ended badly), `steps`, `tool_calls`, tokens, `cost_usd` (the platform's cost, kept here
  and never in an account's `ai_usage`), `code_ref` (the deployed commit the code was read at), `requested_by`.
  The `dev_*` columns are for the "approve development" step (a person approves, the agent opens a draft PR on an
  `agent/` branch).
- `support_agent_steps` (unique `run_id, seq`): `prompt` / `model` / `tool` steps, each saved before the next, with the
  tool's input, error flag and the message block replayed to the model.
- `support_agent_actions`: what the agent proposes (`resolve_error`, `mute_error`, `reply_to_customer`) and a person
  decides (`pending` / `approved` / `rejected`, `decided_by`, `decided_at`). Nothing runs until approved.

Settings: `platform_settings` row `support_agent` (`supportAgentSettingsSchema`): the kill switch, model, effort, steps,
cost per run and per month, the GitHub repository and its sealed read-only token. The model calls use `ai_connection` — an
existing AI connection of an account where the person choosing it is an admin (`completeWith`, source `support_agent`:
priced, budgeted and logged in that account's `ai_usage`; no key of its own) — or else the help center's platform AI
(Support → Knowledge → AI). The tools are read-only: the error, the ticket, `describe_record` (metadata only unless
the person who started the run has access to that account; secret columns never; emails and phones masked), the
schema, help articles, and the code on GitHub at `code_ref`. Every GitHub call and every decision is in
`platform_audit_log`.

**Approve development.** After a report, the owner or a role in `develop_roles` (leads by default) approves; a
`prompt` step marked `{phase: develop}` starts a second conversation, and the agent writes the fix with `edit_file` /
`write_file` and ends with `open_pull_request`. It uses a separate sealed write token (`github.write_token_enc`: Contents +
Pull requests, one repository). Enforced in `github.ts` `writeCall`, whatever the model asks: only `POST git/refs` for
`refs/heads/agent/…`, `PUT contents` on an `agent/…` branch (never `.github/`, env files or keys), and `POST pulls`
with `draft: true` to the base branch — no ref update, no force, no merge; the kill switch is read before every write.
`dev_status` approved → running → opened | failed, `dev_branch`, `dev_pr_url`; the PR link becomes an internal note on
the ticket. Protect the base branch on GitHub as well.

**Logs, data queries and automatic runs** (no migration; all in the `support_agent` settings row): `log_sources` — a list of sources, each of a
provider kind (`railway`: one environment's logs via the fixed `environmentLogs` GraphQL query, optionally one service;
`sentry`: a Sentry / GlitchTip server's issues and their latest event), token sealed, every call in
`platform_audit_log` (`support_agent.logs`); new providers = a kind + an adapter in `logs.ts`. `sql.enabled` (the
platform owner only) turns on `query_data`: no SQL text from the model — a table, columns, filters, grouping and a limit
from an ALLOW-LIST in `data-access.ts` (the same list `describe_record` reads; no credential, session, token, secret,
key, password or mail-body table or column is in it), built with quoted identifiers and bound values, in a READ ONLY
transaction with a 5 s timeout, at most 200 rows, every query with its statement in `platform_audit_log`
(`support_agent.query`). Filters / grouping / order only on metadata columns; content columns only with access to the
row's account, and a row with content requested and no account is dropped. `auto`
(`enabled`, `severities`, `max_per_day`, `run_as` = who turned it on): the `support_agent.auto` cron (every 5 minutes)
investigates each new, unmuted error of those severities once (`trigger = auto`). `find_similar_reports` searches earlier
reports' summary / root cause.

### 7.16 Self sign-up (DECISIONS D32, migration `0087_signup`)

`signup_requests` — platform-level (no `account_id` until the account exists): one row per sign-up attempt. `email`, `name`,
`org_name`, `plan_version_id` (the version shown), `method` (`password` / `google` / `microsoft`), `status`
(`pending_email` / `pending_provider` / `pending_approval` / `approved` / `provisioned` / `rejected` / `expired` /
`existing_user`), `token_hash` (sha256 of the email link's token or of the provider intent's cookie; single use),
`password_hash` (Better Auth's hash, only until the account exists or the request ends), `locale`, `timezone`, `currency`,
`consents` (jsonb `[{slug, version}]`), `ip`, `user_agent`, `account_id` / `user_id` / `decided_by` (SET NULL), `decided_at`,
`reason`, `sends` + `last_sent_at` ("send again"), `expires_at`, `verified_at`, `created_at`, `updated_at`. Indexes: (email,
created_at), (status, created_at), created_at desc, (ip, created_at), unique token_hash. The rate limits and the daily cap
count these rows. The daily `signup.sweep` expires old links and deletes ended rows after 30 days. The settings are the
`platform_settings` row `signup` (`signupSettingsSchema`, packages/shared `api/signup.ts`).

### 7.17 Platform costs (migration `0101_platform_costs`)

Platform-level, platform owner only (owner console → Costs). Nothing about a provider, a price or a currency is in code:
adapters (`COST_ADAPTER_DEFS`, packages/shared `api/costs.ts`) only know how to read a provider; the owner connects sources
and sets prices.

- `cost_sources` — `adapter` (`internal` — one row, made on first use / `railway` / `cloudflare_r2` / `http_json` /
  `recurring`), `name`, `enabled`, `config` jsonb (the adapter's plain settings), `secret_sealed` + `secret_hint` (SecretBox;
  never returned), `budget_monthly` (display currency), `last_sync_at` / `last_sync_ok` / `last_error` (`{reason, details}`
  JSON), soft delete.
- `cost_entries` — PK (`source_id`, `day`, `metric`, `service`, `account_ref` — '' = no account): `quantity` + `unit`, and
  either `amount` (money the source reported: AI spend, a fee) or `cost` computed from the price table (null = unpriced),
  in `currency`. A sync replaces its source's rows for the days it read and reprices the whole months touched.
- `cost_prices` — per `metric` and `service` (or `*`) from `effective_from`: `price` per unit, `currency`,
  `free_per_month` (a free tier: units free each calendar month, the earliest days first, across sources). Unique
  (metric, service, effective_from). A change reprices every row it covers.
- `cost_fx_rates` — PK (`day`, `currency`, `quote`): 1 currency = `rate` quote (the display currency), from `source`
  (Bank of Israel / Frankfurter); manual rates live in the settings.
- `usage_meter` — PK (`day`, `account_ref`, `metric`): counts the platform keeps as it happens (`email_sent`,
  `sms_segments`, `web_search_calls`, `automation_runs`) and the day's level of `storage` (GB-months), read by the
  `internal` source.

Settings: `platform_settings` row `costs` (`COST_SETTINGS_DEFAULTS`: display currency, rate source, the daily sync's UTC
hour and days re-read, backfill days, allocation, budget, spike rule, alert addresses); row `costs_state` (last daily run,
rates time, alert keys sent). Jobs: `costs.tick` hourly (the daily sync at the owner's hour, then the alerts) and
`costs.sync` (a "sync now" or a new source).

---

## 8. Cross-table semantics

### 8.1 Indexing strategy (summary)
| Need | Index |
|---|---|
| Loading a board (first page, 200 items) | `items (board_id, group_id, position) WHERE deleted_at IS NULL AND depth=0` → `cells (board_id)` + `item_id = ANY(…)` |
| Subitems | `items (parent_item_id, position)` / `items (root_item_id)` |
| Sorting by a column | `cells (column_id, number_value|date_value|text_value)` — the query does `LEFT JOIN cells ON item_id AND column_id = $col` and orders `NULLS LAST` |
| `any_of` filtering on an array | GIN `jsonb_path_ops` on `cells.value` + `value @> '{"ids":[3]}'` |
| Free-text search | Trigram on `items.name`, `cells.text_value`, `updates.body_text`, `boards.name` (`pg_trgm`, `ILIKE '%…%'`) |
| "Assigned to me" / `view_items` | GIN on `cells.value` with `@> '{"users":["<me>"]}'` for each People column of the board + `items.created_by` |
| Automations by trigger | Expression index on `recipe->'trigger'->>'type'` |
| Trash / purge | `trash_entries (purge_after)` partial |
| A board's events (SSE catch-up) | `activity_log (board_id, created_at DESC)` per partition |

Required extensions: `pg_trgm`, `btree_gin` (to combine column_id with GIN), `pgcrypto` (optional).

### 8.2 Soft delete, archive and purge
- **Archive** (`archived_at`): a board/group/item/column disappears from the regular view and is reachable through "View archive"; **it never expires**. Relation links to an archived item stay (shown greyed out).
- **Delete** (`deleted_at` + `trash_entries`): nested — deleting a board also marks `deleted_at` on its groups/items/columns/views (a bulk `UPDATE … WHERE board_id`), with one `trash_entries` row for the board (children are recorded with `parent_entry_id` **only** if they were deleted separately before). `item_links` rows **to** a deleted item stay but are filtered out on read (`JOIN items … deleted_at IS NULL`); the item's `restore_payload` keeps the links so the other side's cache can be restored.
- **Restore**: clears `deleted_at` (nested), returns the object to its position from `restore_payload` (if the group/parent was deleted — to the default destination), sets `restored_at`, and refreshes the link and mirror caches. Only an admin or `deleted_by` can see and restore it.
- **Purge job** (`trash.purge`, hourly graphile-worker cron): for every `trash_entries` row with `purge_after < now()` and `restored_at IS NULL`: physical `DELETE` of the object (CASCADE handles the children) and `purged_at = now()`. Uploads nobody uses any more leave storage through the separate hourly `files.purge` job.
- **Undo** (1 minute in the banner, 7 days through the Activity Log): every `activity_log` event with `payload.before` can be reversed by whoever performed it; `batch_id` reverses the whole batch; a deletion reverses into a restore.
- A deleted column: its `cells` stay until purge (restore brings the values back); its `key` can **not** be reused (ux_columns_board_key has no WHERE).

### 8.3 Multi-level items (subitems = depth ≥ 1)
- There is no separate "subitems board". **All levels share the board's columns.** On import, the columns of "Subitems of X" are merged into board X: a column that exists on both boards (same `type` + same `title`) maps to the same column; otherwise a new column is created with `settings.levels = [1]` (shown only on the listed levels). `columns.settings.levels: number[] | null` (NULL = all levels) is a key shared by every type.
- The board's `hierarchy_depth_max` = the deepest `depth` allowed: 1 = subitems only, 2 = subitems and sub-subitems (the default for every new board and on import), 5 = full multi-level (`project_multilevel`). A stored value above 5 is read as 5 (`packages/shared/src/hierarchy.ts`).
- Limits: ≤ 750 direct children per parent; ≤ 10,000 items per board (all levels included) by default.
- **Rollups** (showing a summary of the children on the parent): each column has a `rollup_function` (or the type's default: numbers→`sum`, date/timeline→`max` (latest), status→`count_done` (battery), people→`none`, checkbox→`count_done`, time_tracking→`sum`, tags→`union`). The parent shows the rollup **only when its own cell is empty** ("leaf vs calculated" — in the API: `is_leaf:false`). Computation: at read time in SQL (`WITH RECURSIVE` over `root_item_id`).
- Deleting/archiving a parent applies to all its descendants (the same `trash_entries` row). Moving a parent to another group moves the tree. Converting item↔subitem = changing `parent_item_id`/`depth`/`group_id` + updating `root_item_id` for all descendants (CTE); `depth` is checked against `hierarchy_depth_max`.

### 8.4 Moving an item
- **Within the board** (group/parent/position): update `group_id`/`parent_item_id`/`position` + an `item.moved_group`/`item.moved_parent` event. Atomic for a whole tree.
- **To another board** (`POST /items/:id/move {target_board_id, target_group_id, column_mapping}`):
  1. The service computes a column mapping: by default by `(type, title)`, then by `(type, key)`; the client can supply `column_mapping: { "<src_column_id>": "<dst_column_id>" | null }`. An incompatible type ⇒ `null` (the value is lost, recorded in `payload.dropped`).
  2. In one transaction: `items.board_id/group_id/position` are updated; `cells` are **deleted and rewritten** with the new `column_id` (re-key) — status/dropdown values are mapped by **label text** (a missing label is created on the target if `create_labels_if_missing`, otherwise dropped); `item_links` of unmapped relation columns are deleted (and the other side's cache is updated); `item_tags` are kept if the target has a tags column; `updates`/`cell_files` move as they are (`board_id` is updated). `key_seq` is reset and reallocated if the target has a custom key.
  3. **The item keeps its `id`** — external links don't break.
  4. An `item.moved_board` event with a full `payload.before` (including cells) ⇒ undo is possible for 7 days.
- Moving a **group** to another board = moving all its items with the same mapping. Moving a **board** between workspaces/folders = updating `workspace_id/folder_id/position` only (no data change; `workspace_members` don't change — if the target workspace is `closed`, board subscribers who are not members lose access, and a warning is shown).

### 8.5 Revisions and optimistic concurrency
- `boards`, `columns`, `views`, `automations`, `forms`, `workspaces` hold a `revision`. Every `PATCH` accepts `If-Match: <revision>` (or `revision` in the body); a mismatch ⇒ `409 REVISION_MISMATCH` with the current state. The `UPDATE` is `… WHERE id=$1 AND revision=$2 RETURNING` and increments `revision = revision + 1`.
- **Cells**: intentionally last-write-wins, but every write keeps `before` in `activity_log` and sends SSE; a client holding a stale value receives the new one within a second.
- `boards.revision` advances on every **structure** change (column/group/view/permissions) and serves as the ETag for `GET /boards/:id/structure` (the client caches the structure and asks with `If-None-Match`).

### 8.6 Id formats
| Object | Format | Example |
|---|---|---|
| Every PK | ULID, 26 characters | `01J9F2Z6QW8K3T4R5V6X7Y8Z9A` |
| `columns.key` | `^[a-z][a-z0-9_]{0,49}$` | `status`, `color_mm6x6akt` |
| `items.key_seq` + prefix | `<PREFIX>-<zero-padded seq>` | `PRJ-2026-014` (prefix `PRJ-2026`, padding 3) — the hyphen is display only |
| `forms.slug` | `^[a-z0-9-]{6,64}$` | `support-request-x7k2` |
| API token | `bos_` + 40 base62 characters; only the hash is stored | `bos_8Kq…` |
| LexoRank | `<bucket>|<base36>:` | `0|hzzzzz:` |

### 8.7 Design limits
The sizes the data model is designed for. Not every one is enforced as a hard error by the service; plan limits
(§7.14) are the limits an installation enforces per account.

| Limit | Value |
|---|---|
| Active columns per board | 500 |
| `board_relation` + `dependency` columns per board | 60 |
| Items per board (all levels) | 10,000 (default) |
| Direct children per parent | 750 |
| Tree depth | `hierarchy_depth_max` ≤ 5 child levels (depth 0..5); a stored 6 is enforced as 5 |
| Views per board | 100 |
| Status labels per column / label length | 40 / 30 characters |
| Dropdown labels per column / per board | 1,000 / 20,000 |
| Folder depth | 3 (depth 0..2) |
| File | 500 MB |
| `long_text` | 2,000 characters (can be raised in settings up to 20,000) |
| Formula | 10,000 characters; mirror-of-mirror 2 levels |
| Total cell data per item | ~256 KB (warning at 64 KB) |
| Batch API | 500 items per call |

### 8.8 Tenant isolation
- **Enforcement is in the service layer** (DECISIONS D6): every repository query is scoped by the request's `account_id`, and board/column/item permissions (`packages/shared/src/permissions/` + the module services) apply to SELECT as well as to writes: `view_items=assigned_or_created` adds the condition `created_by = me OR EXISTS(cells people @> me)`; `restricted_view` removes columns from the result.
- The database does not use Postgres row-level security; isolation relies on the service layer and its tests.
- Guests: on top of all of the above, `role=guest` gets an allowlist of `board_ids` (from `board_members` on `shareable` boards) applied to **every** query (items, cells, updates, assets, activity_log, notifications). A guest never sees `workspaces`/`folders`, the board's `activity_log`, or users who are not subscribers of the same boards.
