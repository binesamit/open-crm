# 05 — Permissions model

This document describes who can see and do what in Bines OS: account roles, workspaces, board permission sets,
item-level visibility, column restrictions, support access and API tokens. It is for developers working on the API
or UI and for administrators who want to understand exactly how access is decided.

> Governed by [D6](DECISIONS.md#d6-permissions). Every capability here is a normal feature — nothing is reserved for a
> higher tier.
> Code: `packages/shared/src/permissions/` (pure, testable functions: `account.ts`, `board.ts`, `doc.ts`,
> `dashboard.ts`), enforced in `apps/api/src/modules/*/*.service.ts`.
> Overriding rule: **the strictest rule wins. Board owners bypass everything on their own board. Admins bypass
> everything in the account.**

## 1. Principles

1. Four layers, from broad to narrow: **account role → workspace membership → board subscription + permission
   set/role → column restriction + item visibility**. Each layer can only **narrow** access.
2. An "allow" in a lower layer never cancels a "deny" in a higher one.
3. Everything is checked on the server (service layer). The UI receives computed `capabilities` and hides or
   disables controls — that is convenience, not security.
4. Reads (list / search / SSE) are filtered in the query, not afterwards; writes are checked before the transaction.
5. An actor is a `user` (session), a `service` (API token), an `extension` (JWT) or an `automation` (runs with the
   rights of the automation's owner — column restrictions still apply).

## 2. Account roles (`membership.role`)

| Capability | admin | member | viewer | guest |
| --- | :-: | :-: | :-: | :-: |
| Sees `main` boards in open workspaces | ✔ | ✔ | ✔ (read) | ✘ |
| Sees `main` boards in a closed workspace | ✔ | workspace members only | members only (read) | ✘ |
| Sees `shareable` boards | ✔ | subscribers only | subscribers (read) | **subscribers only** |
| Sees `private` boards | ✔ (content directory; no content without a subscription — see §4) | subscribers only | subscribers (read) | ✘ never |
| Sees workspace / folder names | ✔ | ✔ | ✔ | ✘ |
| Sees a board's activity log | ✔ | ✔ (per board) | ✘ | ✘ |
| Sees other guests' names | ✔ | ✔ | ✔ | per `account.settings.guests_see_other_guests` (default ✘) |
| Creates a workspace | ✔ | `perm.create_workspace` (default ✔) | ✘ | ✘ |
| Creates a main / shareable / private board | ✔ | per `perm.create_board.{main,shareable,private}` (default ✔/✔/✔) | ✘ | ✘ (not even shareable) |
| Owns a board | ✔ | ✔ | ✘ | ✘ |
| Can be invited to a board | — | ✔ | ✔ | shareable only |
| Creates / edits items | ✔ | per board | ✘ | per board (shareable) |
| Writes Updates | ✔ | ✔ | ✘ (default; `perm.viewer_can_comment`) | ✔ on their boards |
| Can be assigned on an item (people) | ✔ | ✔ | ✔ | ✔ (if subscribed to the board) |
| Invites members | ✔ | `perm.invite_members` (default ✘) | ✘ | ✘ |
| Invites viewers | ✔ | `perm.invite_viewers` (✔) | `perm.viewer_invite_viewers` (✘) | ✘ |
| Invites guests | ✔ | `perm.invite_guests` (✔) | ✘ | ✘ never |
| Deletes own / others' boards | ✔/✔ | `perm.delete_own_boards` (✔) / ✘ | ✘ | ✘ |
| Exports Excel / CSV | ✔ | `perm.export` (✔) | `perm.viewer_export` (✔) | ✘ |
| Uses the API (personal token) | ✔ | `perm.api_tokens` (✔) | ✘ | `perm.guest_api_tokens` (✘) |
| Creates / edits automations | ✔ | `perm.automations` (✔) | ✘ | ✘ never |
| Moves items / groups between boards | ✔ | `perm.move_items_between_boards` (✔) | ✘ | ✘ |
| Deletes other people's items | ✔ | `perm.delete_others_items` (✔) | ✘ | ✘ |
| Uploads / deletes files | ✔ | ✔ | ✘ | ✔ on their boards |
| Creates teams | ✔ | `perm.create_teams` (✘) | ✘ | ✘ |
| My Work, search, notifications, profile | ✔ | ✔ | ✔ | ✔ (search limited to what they can see) |
| Administration | ✔ | ✘ | ✘ | ✘ |
| Takes a paid seat | ✔ | ✔ | **no** | **no** |

`perm.*` names are keys of the `account.permissions` JSONB (`08-ACCOUNT-ADMIN.md` §2.5) with the defaults shown
above. The keys stored and editable today (Administration → General) are those in `accountPermissionsSchema`
(`packages/shared/src/permissions/account.ts`): `invite_members`, `invite_viewers`, `viewer_invite_viewers`,
`invite_guests`, `viewer_can_comment`, `show_update_views`, `show_board_viewers`, `board_viewers_recent_hours`,
`members_manage_automation_templates` and `guests_edit_structure`. For the other rows the default shown is the fixed
behaviour of the role.

### 2.1 Guest constraints

- The guest's email address must be on a domain that is **not** in `account.domains` (otherwise the inviter is
  offered to invite the person as a member or viewer).
- A `guest` is invited to a board ([D23](DECISIONS.md)) — there is no separate "client" entity. What a guest sees and
  does is decided by the board's permissions (§4–6).
- A guest sees the same interface: the sidebar shows only the workspaces and folders on the path to the boards shared
  with them (`/workspaces`, `/workspaces/:id/tree`), not the rest of the structure. A guest never sees: names of boards
  they are not subscribed to, the activity log, "who viewed", the user directory (their mention picker is limited —
  §6.3), usage, or the API docs.
- A guest never creates automations and never invites anyone, whatever the board's permission set gives its
  subscribers. A guest changes a board's structure (columns, groups) only when the account turns on
  `guests_edit_structure`; by default a guest edits items only.

## 3. Workspaces

|  | `open` | `closed` |
| --- | --- | --- |
| Who sees the workspace in the list | every admin / member / viewer | workspace members + admins |
| Who sees the `main` boards in it | every admin / member / viewer | workspace members only |
| Joining | free (a member or viewer clicks "Join") | invited by a workspace owner / admin, or request + approval |
| Who can change the type | workspace owner, admin | |
| Guest | never a workspace member; sees only shareable boards they were invited to | |

`workspace_members(role: owner|member)`. A workspace owner manages membership, creates folders and boards, and sets
`workspace.permissions` (a subset of the account permissions: `create_boards.{main,shareable,private}`,
`create_folders`, `invite_members`) — never wider than the account allows. A member subscribed to one specific board
inside a closed workspace sees that board and not the rest.

## 4. Boards: kinds and subscriptions

| `board.kind` | Who sees it without a subscription | Who can be invited | guest |
| --- | --- | --- | --- |
| `main` | everyone who sees the workspace | member / viewer / team | ✘ |
| `shareable` | nobody (admins — metadata only, in the content directory) | member / viewer / guest / team | ✔ |
| `private` | nobody | member / viewer / team | ✘ |

Board members are stored with `role ∈ {owner, subscriber}` and an optional explicit level
`∈ {editor, contributor, assigned_contributor, viewer}`; teams can be subscribed too (every team member gets the
subscription).

- A new board: its creator is the `owner`. A board must have at least one active owner (otherwise an admin can claim
  ownership).
- The **permission set** (`permission_set`) decides the default role of everyone who is not an owner and has no
  explicit level:

| `permission_set` | Default role for non-owners |
| --- | --- |
| `edit_everything` — "Edit everything" | `editor` |
| `edit_content` — "Edit content only" | `contributor` |
| `edit_assigned` — "Edit only items assigned to me" | `assigned_contributor` (assignment columns: `view_items.column_ids`; `any_people` = every people column) |
| `view_comment` — "View and comment" | `viewer` |

A subscriber can be given an explicit level **lower than or equal to** what the set allows (an owner can lower an
editor to viewer, but cannot raise an account viewer to editor). `membership.role = viewer` always maps to `viewer`
on the board regardless of the set (strictest wins).

## 5. Capability matrix by board role

✔ = allowed by default; ○ = can be removed by the owner in the permissions dialog; ✘ = not allowed and cannot be
added (a ceiling). An owner always has ✔ for everything.

This matrix is the full model. The actions enforced by `canBoard` today are listed in `BOARD_ACTIONS`
(`packages/shared/src/permissions/board.ts`): board read / update / delete / manage permissions / invite, group and
column create / update / reorder / delete, item read / create / update / move group / delete, view create / update /
manage, automation read / manage and webhook manage. Per-board ○ overrides are not stored yet: an allowed cell
behaves as ✔.

### 5.1 Items (`item.*`)

| capability | editor | contributor | assigned_contributor | viewer |
| --- | :-: | :-: | :-: | :-: |
| `item.read` (subject to view_items §6) | ✔ | ✔ | ✔ | ✔ |
| `item.create` | ✔○ | ✔○ | ✔○ (the creator counts as assigned) | ✘ |
| `item.update` (name + cells) | ✔○ | ✔○ | only if assigned / created | ✘ |
| `item.move_group` | ✔○ | ✔○ | assigned only ○ | ✘ |
| `item.move_board` | ✔○ (and `perm.move_items_between_boards`) | ✔○ | ✘ | ✘ |
| `item.duplicate` | ✔○ | ✔○ | assigned only ○ | ✘ |
| `item.archive` | ✔○ | ✔○ | assigned only ○ | ✘ |
| `item.delete` | ✔○ (others': `perm.delete_others_items`) | own ✔○ / others ○ | own only ○ | ✘ |
| `item.restore` | ✔○ | ✔○ | ✘ | ✘ |
| `item.export` | ✔○ | ✔○ | ✔○ | ✔○ (`perm.viewer_export`) |

### 5.2 Subitems (`subitem.*`)

The same as Items. A subitem counts as assigned for `assigned_contributor` if it **or its parent** is assigned.

### 5.3 General (`board.*`)

| capability | editor | contributor | assigned_contributor | viewer |
| --- | :-: | :-: | :-: | :-: |
| `board.read_settings` | ✔ | ✔ | ✔ | ✔ |
| `board.update` (name, description, terminology, defaults) | ✘ | ✘ | ✘ | ✘ |
| `board.invite` (members / teams) | ✔○ | ✔○ | ✘ | ✘ |
| `board.invite_guests` | ○ (default ✘) | ✘ | ✘ | ✘ |
| `board.manage_permissions` | ✘ | ✘ | ✘ | ✘ |
| `board.manage_automations` | ✔○ | ○ | ✘ | ✘ |
| `board.manage_webhooks` | ✔○ | ✘ | ✘ | ✘ |
| `board.view_activity` | ✔○ | ✔○ | ✔○ | ○ (account viewers ✘ always) |
| `board.duplicate` | ✔○ | ✘ | ✘ | ✘ |
| `board.archive` / `board.delete` | ✘ | ✘ | ✘ | ✘ |
| `board.change_kind` | ✘ | ✘ | ✘ | ✘ |
| `board.save_template` | ✘ | ✘ | ✘ | ✘ |
| `board.manage_forms` | ✔○ | ✘ | ✘ | ✘ |
| `board.email_address` (see the board's email-to-board address) | ✔○ | ✔○ | ✘ | ✘ |

### 5.4 Updates (`update.*`)

| capability | editor | contributor | assigned_contributor | viewer |
| --- | :-: | :-: | :-: | :-: |
| `update.read` (on a visible item) | ✔ | ✔ | ✔ | ✔ |
| `update.create` / `update.reply` | ✔○ | ✔○ | ✔○ (on any visible item, not only assigned ones) | ✔○ |
| `update.edit_own` / `update.delete_own` | ✔○ | ✔○ | ✔○ | ✔○ |
| `update.delete_others` | ○ | ✘ | ✘ | ✘ |
| `update.mention` | ✔ (per §6.3) | ✔ | ✔ | ✔ |
| `update.attach_file` | ✔○ | ✔○ | ✔○ | ✔○ |
| `update.react` | ✔ | ✔ | ✔ | ✔ |

### 5.5 Columns (`column.*`)

| capability | editor | contributor | assigned_contributor | viewer |
| --- | :-: | :-: | :-: | :-: |
| `column.create` | ✔○ | ○ (✘) | ✘ | ✘ |
| `column.update_settings` (labels, formula, width, title) | ✔○ | ○ (✘) | ✘ | ✘ |
| `column.reorder` | ✔○ | ○ (✘) | ✘ | ✘ |
| `column.delete` | ✔○ | ✘ | ✘ | ✘ |
| `column.change_type` | ○ (✘) | ✘ | ✘ | ✘ |
| `column.manage_restrictions` | ✘ | ✘ | ✘ | ✘ |
| `column.collapse/hide` (personal, in a view) | ✔ | ✔ | ✔ | ✔ |

### 5.6 Groups (`group.*`)

| capability | editor | contributor | assigned_contributor | viewer |
| --- | :-: | :-: | :-: | :-: |
| `group.create` | ✔○ | ○ (✘) | ✘ | ✘ |
| `group.update` (name, colour) | ✔○ | ○ (✘) | ✘ | ✘ |
| `group.reorder` | ✔○ | ○ | ✘ | ✘ |
| `group.archive/delete` | ✔○ | ✘ | ✘ | ✘ |
| `group.move_board` | ✔○ (+perm) | ✘ | ✘ | ✘ |
| `group.collapse` (personal) | ✔ | ✔ | ✔ | ✔ |

### 5.7 Views (`view.*`)

| capability | editor | contributor | assigned_contributor | viewer |
| --- | :-: | :-: | :-: | :-: |
| `view.read` | ✔ | ✔ | ✔ | ✔ |
| `view.create` (shared) | ✔○ | ✔○ | ○ | ✘ |
| `view.create_personal` | ✔ | ✔ | ✔ | ✔ |
| `view.update_own` / `view.delete_own` | ✔○ | ✔○ | ✔○ | personal only |
| `view.update_others` / `view.delete_others` | ○ (✘) | ✘ | ✘ | ✘ |
| `view.lock` / `view.unlock` | ✘ | ✘ | ✘ | ✘ |
| Editing a locked view | admin / owner only | | | |

### 5.8 Forms (`form.*`)

| capability | editor | contributor | assigned_contributor | viewer |
| --- | :-: | :-: | :-: | :-: |
| `form.read` | ✔ | ✔ | ✔ | ✔ |
| `form.create/update/delete` | ✔○ | ✘ | ✘ | ✘ |
| `form.share_public` | ○ (✘) | ✘ | ✘ | ✘ |
| `form.submit` (public) | — anonymous, per the form's settings | | | |

## 6. Item-level visibility (`view_items`)

```ts
type ViewItems =
  | { mode: 'all' }
  | { mode: 'assigned_or_created'; column_ids: string[] | 'any_people' };
```

- Applies to **everyone who is not an owner or admin**. Owners and admins see everything.
- `assigned_or_created`: an item is visible if `item.created_by = me` **or** I (or a team I belong to) am in one of
  the listed people columns (every people column with `any_people`). A subitem is visible if it, or its top-level
  item, is visible ([D14](DECISIONS.md)). A sub-board follows its parent board's rules.
- Implementation: `apps/api/src/modules/items/visibility.ts`. **Every** read of items / cells / updates / search /
  SSE / export / automation conditions goes through it. No API returns an item by id without this filter (`404`, not
  `403`, so as not to leak that the item exists).
- Updates, mentions, files and activity of an invisible item are invisible. Search is filtered. A mirror from another
  board shows only values from items visible on the source board (otherwise `hidden: true`).

### 6.1 Column restrictions

- Stored per column (`restricted_edit`, `restricted_view`); edited in the board permissions dialog as
  `column_restrictions: [{ column_id, kind: 'edit' | 'view', users[], teams[] }]`. Board owners and admins are always
  allowed.
- `view`: anyone not on the list does not receive the cell (not in the API, SSE or export, and not through a mirror or
  formula derived from it).
- `edit`: anyone not on the list gets `403 column_restricted` on write; the UI shows a lock.
- A column cannot have both `view` and `edit` — `view` wins (whoever cannot see it cannot edit it anyway).
- Duplicating a board or template duplicates its restrictions.

### 6.2 Assignment columns for `edit_assigned`

The people columns in `view_items.column_ids` (`any_people` = every people column on the board). "Assigned" includes
a team I am a member of. The creator of an item always counts as assigned to it.

### 6.3 Mentions

`update.mention` is allowed only for principals the actor may see:

- admin / member / viewer: every account member, teams, "everyone on the board / item", and the board's guests.
- guest: `GET /users` returns a filtered list for a guest (`users/guest-people.ts`). For each board shared with them:
  if they see all its items — every subscriber of the board (people and members of subscribed teams); if the board
  is restricted (assignment) — only people who appear on the items they see (creator, assignee, update author).
  Always themselves. The same list filters the subscribers in the permissions dialog (without teams). There is no
  separate endpoint — mentions and people pickers use `/users` as usual.

## 7. Account-level permissions (`account.permissions`)

The full model with defaults, per role (admin is always ✔). Which keys are stored and editable today is listed under
§2.

| key | member | viewer | guest |
| --- | :-: | :-: | :-: |
| `create_workspace` | ✔ | ✘ | ✘ |
| `create_board.main` / `.shareable` / `.private` | ✔/✔/✔ | ✘ | ✘ |
| `create_folder` | ✔ | ✘ | ✘ |
| `delete_own_boards` / `archive_own_boards` | ✔ | ✘ | ✘ |
| `delete_others_items` | ✔ | ✘ | ✘ |
| `move_items_between_boards` / `move_groups_between_boards` | ✔ | ✘ | ✘ |
| `invite_members` / `invite_viewers` / `invite_guests` | ✘/✔/✔ | ✘/✘ (`viewer_invite_viewers`)/✘ | ✘ |
| `invite_non_authorized_domains` | ✔ | ✘ | ✘ |
| `export` | ✔ | ✔ | ✘ |
| `api_tokens` | ✔ | ✘ | ✘ |
| `automations` (create / edit) | ✔ | ✘ | ✘ |
| `webhooks` | ✔ | ✘ | ✘ |
| `upload_files` / `delete_files` | ✔/✔ | ✘ | ✔/own |
| `create_teams` / `manage_own_teams` | ✘/✔ | ✘ | ✘ |
| `mention_everyone` | ✔ | ✘ | ✘ |
| `viewer_can_comment` | — | ✘ | — |
| `save_templates` | ✔ | ✘ | ✘ |
| `create_views` / `delete_others_views` | ✔/✘ | ✘ | ✔/✘ |
| `create_forms` / `share_public_forms` | ✔/✔ | ✘ | ✘ |
| `view_usage` | ✘ | ✘ | ✘ |
| `guests_see_other_guests` (account-wide flag) | — | — | ✘ |
| `guests_edit_structure` (account-wide flag) | — | — | ✘ |
| `guest_api_tokens` | — | — | ✘ |

## 8. Support access grants

Table `support_access_grants(id, account_id, granted_by, grantee_kind, granted_to_user_id | granted_to_email, scope,
reason, expires_at, revoked_at, last_used_at, ticket_id)`; API under `/support-access`; enforcement in
`apps/api/src/modules/support/support.access.ts`.

- An account admin grants remote support access to a platform owner (`grantee_kind: platform`) or to a specific
  person by verified email (`email`), for a limited time (default 24 hours, at most 168 hours — both platform
  settings). A grant can be approved from a support ticket; solving or closing the ticket revokes it.
- While a grant is active the grantee enters the account as an admin of it, through every entrance (REST, MCP, the
  docs socket, live streams).
- `scope: read` (view, the default): reads only — every change answers `405 support_read_only`.
  `scope: read_write` (edit): everything an admin may do, except what would outlive the grant — people and
  invitations, tokens / OAuth / extensions, security and support access itself.
- Every request under a grant is written to the account's audit log: changes always, reads when the owner console
  says so (default on, at most once a minute per page). The first request after a pause starts a session, which is
  audited and emailed to the account's admins.
- Revoking (`revoked_at`) takes effect on the next request.

## 9. API tokens (`api_tokens`)

- Personal tokens (`bos_pat_…`) act as their user with the token's scopes ∩ the user's permissions. Service tokens
  (`bos_svc_…`, `user_id = null`) are created by admins and act as a separate account-level identity. Either may be
  limited to `board_ids[]`.
- Scopes (`TOKEN_SCOPES` in `packages/shared/src/api/tokens.ts`): `boards:read`, `boards:write`, `items:write`,
  `updates:read`, `updates:write`, `users:read`, `users:write`, `teams:write`, `automations:read`,
  `automations:write`, `agents:read`, `agents:run`, `agents:write`, `webhooks`, `notifications:read`,
  `notifications:write`, `search`, `admin`, `secrets:read`. A write scope implies its read scope; `admin` implies
  everything except `secrets:read`. Only admins may give a token `admin`, `users:write` or `secrets:read`.
- A missing scope ⇒ `403 insufficient_scope`.
- Only the hash is stored; the token is shown once. Revocation is immediate; `last_used_at` is recorded. Each token
  may have its own rate limit and daily quota (null = the account's, then the platform's default).

## 10. The `can(actor, action, resource)` algorithm — strictest wins

The checks run in this order. In code they are split by resource: `canAccount` (`account.ts`), `canBoard` /
`canAccessBoard` / `effectiveBoardRole` (`board.ts`), `canDoc` (`doc.ts`) and `canDashboard` (`dashboard.ts`); item
visibility and column restrictions are applied by the items service. The sketch below shows the full decision
sequence:

```ts
export function can(ctx: PermissionContext, action: Action, res: ResourceRef): Decision {
  const { actor, account, workspace, board, column, item, grant } = ctx

  // 0. hard gates
  if (actor.deactivated) return deny('deactivated')
  if (grant?.mode === 'view' && isMutation(action)) return deny('support_read_only')
  if (actor.type === 'service' || actor.type === 'extension') {
    if (!scopeCovers(actor.scopes, action)) return deny('insufficient_scope')
    if (actor.boardIds && board && !actor.boardIds.includes(board.id)) return deny('token_board_scope')
  }

  // 1. account layer
  if (actor.role === 'admin') {
    if (board && !isSubscribed(actor, board) && isContentRead(action) && board.kind !== 'main')
      return deny('admin_not_subscribed')          // admin sees metadata, not private/shareable content
    return allow('admin')
  }
  if (isAccountAction(action)) return account.permissions[actor.role]?.[action] ? allow() : deny('account_permission')

  // 2. workspace layer
  if (workspace && !canSeeWorkspace(actor, workspace)) return deny('workspace')
  if (isWorkspaceAction(action))
    return (isWorkspaceOwner(actor, workspace) || workspace.permissions[actor.role]?.[action]) ? allow() : deny('workspace_permission')

  // 3. board layer
  if (!board) return deny('no_board')
  if (!canAccessBoard(actor, board, workspace)) return deny('board_access')     // kind + subscription (§4)
  if (isBoardOwner(actor, board)) return allow('owner')                          // owners bypass §5, §6, §6.1
  const role = effectiveBoardRole(actor, board)                                  // min(subscriber level, set→default role, accountRole==='viewer' ? 'viewer' : ∞)
  const cap = CAPABILITY_MATRIX[role][action]
  if (!cap) return deny('role_ceiling')
  if (requiresAccountPerm(action) && !account.permissions[actor.role]?.[requiresAccountPerm(action)])
    return deny('account_permission')                                             // e.g. item.move_board

  // 4. item layer
  if (item) {
    if (!itemVisible(actor, board, item)) return deny('item_invisible', { as: 404 })
    if (role === 'assigned_contributor' && isItemMutation(action) && !isAssignedOrCreator(actor, board, item))
      return deny('not_assigned')
  }

  // 5. column layer
  if (column) {
    const r = effectiveRestrictions(board, column)      // includes derived (formula/mirror) restrictions
    if (r.view && !principalMatches(actor, r.view)) return deny('column_view', { as: 404 })
    if (isCellWrite(action) && r.edit && !principalMatches(actor, r.edit)) return deny('column_edit')
  }
  return allow(role)
}
```

- `Decision = { ok: true, via } | { ok: false, reason, as404? }`.
- The permission context is loaded once per request. List reads do not call the check per item; they use the
  visibility query (§6), which implements steps 3–5 in SQL. The single-resource check is used for writes and for
  reading one item.
- `capabilities` for the UI: `GET /boards/:id` returns `{ capabilities: Record<Action, boolean> }` for the actor,
  computed by the same function (`boardCapabilities`).

## 11. Where the checks live, and the test matrix

- Every `*.service.ts`: each public method starts with a permission check or uses the visibility query.
- Unit (`packages/shared/test/permissions.test.ts`, `board-permissions.test.ts`, `doc-permissions.test.ts`): fixture
  tables of `[actor role, workspace kind, board kind, subscribed?, set, subscriber level, …] × action → expected`.
- Integration (`apps/api/test`): per endpoint — admin ✔, member by role, viewer 403 on writes, guest 404 on another
  client's item, guest 403 on a workspace. `permissions-board.test.ts` covers the board matrix;
  `guest-isolation.test.ts` checks that two guests on a shared board never see each other's items through any query
  (list, get, search, SSE, export, mentionables, files, updates, activity).
- `account-isolation.test.ts` ([D12](DECISIONS.md), blocks merging): two accounts A/B, a user who is a member of A
  only and a user who is a member of both — a session with B's `X-Account-Id` without membership ⇒ 404; A's token
  with B's header ⇒ 403 `account_mismatch`; the id of a B board / item / column / file / token / webhook through A ⇒
  404; search, SSE, mentionables, export and automations (an action targeting a B board) never cross accounts; a
  platform owner who is not a member of B ⇒ 404 on every account-scoped endpoint.
- E2E (Playwright): the permissions dialog (4 sets + view_items), a guest sees only their own items.
- Regression: every permission bug gets a new fixture row before the fix.
