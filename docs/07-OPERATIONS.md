# 07 — Day-to-day operations (semantics)

This document defines what each everyday operation does — moving, duplicating, archiving, deleting, undoing, batch
actions, import / export, notifications — in terms of who may do it, where it lives in the UI, which API call performs
it, what changes in the data, which event it emits and how it is undone. It is for contributors implementing or
changing these behaviours, and for integrators who need the exact semantics behind the endpoints in
[`06-API.md`](06-API.md).

Related documents: [`DECISIONS.md`](DECISIONS.md) (D3 model, D6 permissions), [`04-AUTOMATIONS.md`](04-AUTOMATIONS.md),
[`06-API.md`](06-API.md) (the endpoints named here), [`05-PERMISSIONS.md`](05-PERMISSIONS.md),
[`14-CONTEXT-MENUS.md`](14-CONTEXT-MENUS.md). Entries marked **[decision]** are deliberate departures from the
conventional behaviour of comparable tools. UI labels are given in English; the Hebrew interface has the equivalent
strings. The OpenAPI document served at `/api/docs` is the exact source for request and response bodies.

For every operation: **who** (role / board permission), **UI**, **API**, **data effect**, **event emitted**
(`activity_log.type`), **undo**.

Vocabulary used in "who" columns:

- `admin`, `member`, `viewer`, `guest` — account roles (D6).
- `owner` — board owner (bypasses board/column permissions).
- `structure` — a user whose effective board permission set allows structural edits (`edit_everything` for
  non-owners).
- `content` — `edit_content` or better; `assigned` — `edit_assigned` and the item is assigned to them (in the configured
  people column) or created by them; `comment` — `view_comment`.
- Item **visibility** (`view_items: assigned_or_created`) is applied before everything: an item the user cannot see does
  not exist for them (404).
- **Strictest rule wins** across account → workspace → board → column.

Undo levels:

- **Toast undo**: a toast after delete / archive / move / batch actions; **Ctrl+Z** undoes the last action for 60
  seconds. Calls `POST /activity/:eventId/undo` (the whole batch when the event has one).
- **Activity-log undo**: the board / item activity log (Ctrl+Shift+L) → "Undo" on reversible events for **7 days**, by
  the **actor or an admin** (**[decision]**: admins too, not only the actor).
- **Trash restore**: 30 days, by the deleter or an admin.

---

## 1. Sidebar

### 1.1 Ordering and drag

| | |
|---|---|
| Who | any user with access to the workspace; guests have no workspace tree (only their list of shareable boards) |
| UI | drag boards / dashboards / docs / folders within a workspace and into folders; drop indicators |
| API | `PATCH /boards/:id {folder_id, workspace_id?, position}`, `PATCH /folders/:id {parent_folder_id?, workspace_id?, position}` |
| Data | `position` is a **lexorank** string per sibling list (`workspace_id, folder_id`) — `0\|hzzzzz:` style; boards, docs, dashboards and folders in one folder share one order; rebalanced when gaps run out |
| Event | `board.moved` (folder / position), `folder.moved` — board-level activity, not item |
| Undo | toast (reorder is cheap to redo) |

Collapsing folders is a per-user client preference (`localStorage`), not persisted on the server.

### 1.2 Favorites

| | |
|---|---|
| Who | any user (guests too) |
| UI | star on the board header / the board's menu → "Add to favorites"; the favorites section at the top of the sidebar; drag to reorder |
| API | `GET / PUT /me/favorites` (also `/me/favorite-boards`, `/me/favorite-docs`) |
| Data | personal; removed automatically when the target is purged |
| Event | none |
| Undo | — |

### 1.3 Recents

Recently visited boards / docs / dashboards / items per user, recorded by the web client (`POST /search/recent`,
`POST /views/:id/open`). Shown in the quick-search palette (Ctrl+B) when it opens empty. No event, no undo.

---

## 2. Folders

| op | who | UI / API | data | event | undo |
|---|---|---|---|---|---|
| Create | member/admin with board-creation rights in the workspace | "+" → "New folder" / folder menu → "New folder" (subfolder) · `POST /folders` | depth ≤ 3 (`depth_exceeded`); creator stored | `folder.created` | — |
| Rename | folder creator, workspace owner, admin | folder menu → "Rename" · `PATCH /folders/:id` | | `folder.renamed` | activity-log undo |
| Color | same | folder menu → "Change color" · `PATCH /folders/:id` | `color` | `folder.updated` | activity-log undo |
| Move to another workspace | creator or admin, who may create in the target and manage every board in the folder | folder menu → "Move to…" · `PATCH /folders/:id {workspace_id}` | the folder subtree and all its boards / dashboards / docs change `workspace_id` and land at the target's root; subscribers unchanged; closed-workspace rule: boards become invisible to non-members of the target | `folder.moved` + one `board.moved` per board (one batch) | toast + activity-log undo of the batch (moves everything back) |
| Move into / out of a folder | same | drag · `PATCH /folders/:id {parent_folder_id}` | never into itself or a folder inside it; depth check on the whole subtree | `folder.moved` | toast |
| Delete | same | folder menu → "Delete folder" → the confirmation lists what is inside · `DELETE /folders/:id` | **[decision, [14 §7](14-CONTEXT-MENUS.md)]** the folder and its sub-folders go to **trash**; the boards inside are **not** deleted, they move to the workspace root (nothing reachable is lost) | `folder.deleted {folder_ids, board_ids}` | toast undo puts the folder back and returns the boards into it; later: Trash → restore folder |

Visibility: a folder is visible to users who can see at least one asset inside it (or its creator); empty folders are
visible to the creator, workspace owners and admins.

---

## 3. Moving things

### 3.1 Item between groups

| | |
|---|---|
| Who | `content`+; `assigned` only for their items; guests per board permission |
| UI | drag a row to another group (also onto a collapsed group header); item menu → "Move to…" → group; batch bar → "Move to…". Dropping under an active sort places the item at the sort-consistent slot and recalculates `position` within the group. |
| API | `POST /items/:id/move-to-group {group_id, position}` |
| Data | `group_id`, a new lexorank `position`; subitems follow (they live on the sub-board) |
| Event | `item.moved_to_group {from_group_id, to_group_id}` → triggers `item_moved_to_group` automations and webhooks |
| Undo | toast + activity-log undo |

### 3.2 Reorder items within a group (lexorank)

Drag → `POST /items/:id/reorder`. `position` is a lexorank string (base-36, bucket prefix `0|`). Insert = midpoint
between neighbours; when the strings grow too long the group's positions are rewritten (no event, no undo). Event
`item.reordered` (undoable). Sorting a view never writes positions.

### 3.3 Reorder groups / columns

Groups: drag (collapsed or expanded) → `POST /boards/:id/groups/:groupId/reorder`; toast undo. Columns: drag the header
→ `POST /boards/:id/columns/:col/reorder` (board level); toast undo. Who: `structure`.

### 3.4 Move item to another board

| | |
|---|---|
| Who | `content`+ on the source with the board permission `items.move_to_board` (default on for `edit_everything` / `edit_content`, off for `edit_assigned` / `view_comment`), **and** item-create rights on the target (a member of the target board if it is private / shareable). Guests: only between shareable boards they are on. |
| UI | item menu → "Move to…" → board → board picker (search; boards the user may create items in) → destination group → **mapping dialog** (§3.4.1) → "Move". Batch bar → the same dialog once for all selected items (the mapping applies to all). |
| API | `POST /items/:id/move-to-board`; bulk: `POST /boards/:id/items/bulk {action:{type:"move_to_board", …}}` |
| Data | the **same row** keeps its `id` / URL; `board_id`, `group_id`, `position` change; cells are rewritten per the mapping (dropped cells are kept in the event's snapshot for undo); **subitems move with the item** (auto-mapped by type + title); **updates, replies, likes and files move** (they hang off the item); **the activity log moves** — events keep `item_id`, so the item's activity view shows the whole history; the source board's activity keeps a single `item.moved_to_board` event. Links: `board_relation` values survive only where the mapped target column points to the same board (otherwise dropped and listed); links from other boards to this item are **kept** (they reference the item id). `dependency` and `time_tracking` entries move when a column of the same type is mapped (**[decision]**: kept when mapped rather than dropped). Formula / mirror values are recomputed. Schedules for `date_arrived` automations are re-armed on the target board. |
| Event | `item.moved_to_board {from_board_id, to_board_id, mapping, dropped_columns}` (indexed on both boards) → webhook `item_moved_to_board`; the target board's `item_created` automations do **not** fire ([04 §2](04-AUTOMATIONS.md)). |
| Undo | toast + activity-log undo for **7 days**, by the actor or an admin: restores the item to the source board / group / position from the snapshot (dropped cells restored, cells created on the target discarded). If the source board was deleted meanwhile → `422 not_reversible`. |

#### 3.4.1 Mapping dialog

Rows = source columns (the item's, then a "Subitems" section). Each row: source column (icon, title) → target select.
Pre-filled by **type + title** match (case-insensitive, trimmed, ignoring Hebrew vowel marks). Candidates in the
select: columns of the same type first, then convertible pairs ([04 §6.2](04-AUTOMATIONS.md)), then "Create a new
column" (creates the column on the target with the same title / type / settings; requires `structure` on the target),
then "Don't move" (red). Unmapped rows show a red "This data will be lost" warning, and the confirm button says how many
columns will not be mapped. An API call without `mapping` gets the same automatic mapping.

### 3.5 Move group to another board

Who: `structure` on both boards + `move_to_board`. UI: group menu → "Move to…" → board → mapping dialog (once). API:
`POST /boards/:id/groups/:groupId/move-to-board`. Data: **[decision]** the group row itself is moved (same id — group
ids are unique per account) and placed at the bottom of the target, and all its items move as in §3.4 with one
`batch_id`. Event: `group.moved_to_board` + one `item.moved_to_board` per item in the batch. Undo: toast + activity-log
batch undo.

### 3.6 Move board between workspaces / folders

| | |
|---|---|
| Who | board owner or admin, with management rights in the destination workspace (closed workspaces require membership) |
| UI | board menu → "Move to…" → workspace → folder (optional). The confirmation lists subscribers who are **not** members of a closed destination (they keep access to the board itself — a board subscription is independent of the workspace — but will not see the workspace) and **cross-board automations** that touch this board (both directions), which are kept unchanged. |
| API | `PATCH /boards/:id {workspace_id, folder_id?, position?}` |
| Data | `workspace_id`, `folder_id`, `position`; nothing else changes. Cross-board automations, relation columns, mirrors, webhooks, forms, views and dashboards referencing the board are **kept** unchanged. |
| Event | `board.moved {from_workspace_id, to_workspace_id}` |
| Undo | toast + activity-log undo |

### 3.7 Convert item ↔ subitem

Who: `content`+ on the board (and on the target parent). UI: item menu → "Make a subitem of…" (pick a parent in the
same board) / subitem menu → "Make an item" (pick a group); also drag in the hierarchy. API: `POST /items/:id/convert`,
`POST /items/:id/outdent`, `POST /items/:id/reparent`, bulk `move_under` / `move_up`. Data: `parent_item_id` / depth
change; cells are mapped between the board's and the sub-board's columns with the same mapping logic (auto-map by type
+ title); own subitems come along (one level deeper each; beyond `hierarchy_depth_max` → blocked). Event:
`item.converted {from_depth, to_depth, parent_item_id}`. Undo: toast + activity-log undo (7 days).

---

## 4. Duplicate and templates

### 4.1 Duplicate board

| | |
|---|---|
| Who | a member/admin who can view the board and create boards in the target workspace (the duplicator becomes **owner**); viewers and guests cannot |
| UI | board menu → "More actions" → "Duplicate board" → mode: **structure only** / **structure and items** / **structure, items and updates**; name (default "Copy of X"); destination; "Keep subscribers" (default off) |
| API | `POST /boards/:id/duplicate {mode, name?, folder_id?, keep_subscribers?}` |
| Data copied | columns (same ids, same settings incl. status labels), groups, views, forms (copied **inactive**, new public tokens), item defaults, item terminology, board **permissions** + `view_items`, **column restrictions**, board **automations** (cross-board targets kept; automations that point at the board itself are retargeted to the copy); items (modes 2/3) with cells, subitems and links **within the board** (links to other boards kept as-is; two-way columns on other boards get the copies appended), creation log = now / the duplicator; updates + files (mode 3; files are re-referenced, not re-uploaded). **Not copied**: webhooks, activity log, subscribers (unless asked), notification settings, favorites, running timers. |
| Event | `board.duplicated {from_board_id}` on the new board |
| Undo | none (delete the copy → trash) |

### 4.2 Duplicate item / group

Item: item menu → "Duplicate" / "Duplicate with updates"; batch bar → "Duplicate". `POST /items/:id/duplicate`. The copy
is placed directly below, named "X (copy)"; cells are copied except `auto_number`, `creation_log`, `item_id`, time
tracking and files; subitems and relation links are copied (the two-way side is appended). Event
`item.duplicated {from_item_id}` on the new item; `item_created` automations **do** fire for the copy. Undo: toast
trashes the copy.

Group: group menu → "Duplicate group" (with items by default). `POST /boards/:id/groups/:groupId/duplicate`. Event
`group.duplicated`. Undo: toast trashes the copy.

### 4.3 Save as template / use template

| | |
|---|---|
| Save | **board owners** (and admins): board menu → "More actions" → "Save as template" → name, description. `POST /boards/:id/save-as-template`. Stored as an account template (the same format as `seed/templates/*.json`, see `seed/templates/README.md`) and listed in the template center. |
| Use | a member/admin with board-creation rights: "+" → template center → preview → "Use template" → destination / name / kind. `POST /boards {template_key, …}`. Multi-board templates install into a new folder and rewrite cross-board references (relation columns, automation targets). Automations are installed active. Event `board.created {from_template}`. |
| Edit / delete / hide | owners / admins: `PATCH / DELETE /templates/:key`; a template can be opened as a draft board, edited and saved back (`POST /templates/:key/draft`, `POST /boards/:id/template-draft/save`); built-in templates can be hidden and restored. Boards made from a template are not linked to it — changing the template does not change them. |

Item templates (one item with its subitem tree, applied inside a board) are separate: `/boards/:id/item-templates`,
`POST /item-templates/:id/apply`.

---

## 5. Archive, delete, trash, undo

### 5.1 Matrix

| object | Archive | Delete (→ trash) | Who |
|---|---|---|---|
| Board | board menu → "Archive"; kept indefinitely; hidden from the sidebar / search unless archived items are included; automations and webhooks paused; relations from other boards show the values greyed; restore from the archive page | board menu → "Delete board" → trash 30 days; relations from other boards are cleared **on purge** (kept while in trash, so a restore is lossless); dashboard widgets show the board as deleted | owner / admin; a board without owners can be archived / deleted by an admin only |
| Group | group menu → "Archive" (its items are archived with it) | "Delete" → trash with its items (the last group cannot be deleted: `last_group`) | `structure` |
| Item / subitem | item menu or batch bar → "Archive"; indefinitely; excluded from queries unless `state=archived`; schedules removed | "Delete" → trash 30 days with subitems, cells, updates, files; links from other items removed on purge | item delete right (`items.delete`; `edit_assigned` users only their own) |
| Column | — | column menu → "Delete column" → confirmation (shows the automations / views that reference it) → trash 30 days with its cells; the id stays reserved forever | `structure` |
| View | — | trash 30 days (restore via the activity log or the trash) | view creator / owner (`views.delete_own` / `delete_others`) |
| Update / reply | — | trash 30 days | author / owner |
| Folder | — | trash (§2) | creator / workspace owner / admin |
| Workspace | — | only an empty workspace can be deleted (`409 workspace_not_empty`), never the last one | admin |
| Dashboard / doc | — | trash 30 days | owner |

### 5.2 Trash

Profile menu → "Trash": a table of name / type / origin (board › group) / deleted by / when / purge date, with
**Restore** and **Delete permanently**; "Empty trash" for admins. Admins see everything; others only what they deleted.
Restore puts the object back in its original place; if the parent is gone (group purged) items land in the first group;
if the board is in trash, restoring an item first offers to restore the board. API: [06 §2.20](06-API.md). The purge job
runs hourly; once nothing references a stored file any more, the hourly `files.purge` job removes it from storage.

### 5.3 Undo

| mechanism | window | who | covers |
|---|---|---|---|
| Toast at the top of the screen; **Ctrl+Z** undoes the last action, **Ctrl+Shift+Z** redoes | 60 s for Ctrl+Z | the actor | delete, archive, move (item / group / board / folder), batch actions, paste, column delete, cell changes |
| Activity-log undo | 7 days | the actor **or an admin** | the reversible event types listed in [06 §2.19](06-API.md) — cell changes, renames, moves (including to another board, with the snapshot), conversions, deletes and archives (restore), duplicates, column changes and type conversions, bulk batches (one click for the whole batch) |
| Trash restore | 30 days | deleter or admin | anything in trash |

Undo writes a compensating event (`undo_of`); history is never rewritten. If the current value differs from the value
the event produced (someone changed it since), the UI warns that the value changed and asks whether to undo anyway; the
API requires `{force:true}` (`409 changed_since` otherwise). Automations and webhooks fire on undo writes like on any
other write (actor = the person undoing).

---

## 6. Batch actions

| | |
|---|---|
| Select | a checkbox per row; the group checkbox / group menu → "Select all in group"; click the first and **Shift+click** the last = range (within and across groups in view order); **Ctrl+A** selects every item in the view. Subitems are selectable across parents when their rows are expanded. |
| Toolbar (bottom, floating) | count · **Duplicate** · **Export** · **Archive** · **Delete** · **Move to…** (group / board) · **Edit** (set a value in an editable column, or clear it) · **Shift dates by N days** (date / timeline columns) · relation links add / remove · ✕ |
| Who | each action checks every item; items the user may not change are skipped and reported ("3 items skipped — no permission") |
| API | `POST /boards/:id/items/bulk` (up to 5,000 ids) or `POST /boards/:id/items/bulk-query` (everything a filter matches, up to 50,000); all writes share one `batch_id`; automations fire per item (subject to the rate cap), webhooks fire per item with `batchId` set |
| Event | per-item events + a summary `batch.executed {action, count, skipped}` row |
| Undo | the toast undoes the whole batch; the activity log shows one collapsed row for the batch with "Undo all" |

Keyboard: `Esc` clears the selection; `Delete` on a selection → delete confirmation.

---

## 7. Items: creation, defaults, terminology, paste, convert

### 7.1 Creating items

UI: "+ Add item" at the bottom of each group (inline name editor; Enter commits and opens the next), the "New item"
button in the board header, item menu → "Create item below", paste (§7.3), forms, email to the board, the API,
automations, import. Who: `content`+ (`items.create`), guests per board permission. Event `item.created {source}`.
Undo: toast (deletes).

**Item default values**: board settings → "Item default values" (owners): a default per column (status, people incl.
the creator, date relative to today, dropdown, numbers, text, relation). Stored in `boards.settings.item_defaults`.
**Applied to every creation path** — UI, API, form, import, automation, email — with the request's explicit cells
winning (**[decision]**: applied uniformly, so a default value never needs an automation).

**Item terminology**: board settings → "Item terminology" (singular / plural, with presets such as item, task, lead,
deal, client, ticket, project, invoice). Stored in `boards.item_terminology {singular, plural}` and used in all UI
strings of that board ("+ Add lead", "New lead"). Event `board.updated`. The account default is in the account settings.

### 7.2 Item card

Clicking an item name opens the item card as a side panel (or full page). Its tabs are configured per board
(`PATCH /boards/:id {card:{tabs}}`): **Updates** (threaded, files, likes, reactions), **Fields** (the item's columns,
optionally a chosen subset), **Time** (time tracking) and **Activity** (the item's activity log with undo buttons); a
tab can be renamed or hidden. Cells are editable in the card; the subitems table is inside.

### 7.3 Paste from a spreadsheet

Pasting several lines into a name cell (or into a group's "+ Add item" editor) offers to create one item per line;
tab-separated columns are mapped onto the visible columns in order. Pasting a range of cells over the grid fills the
cells (Ctrl+C / X / V work on cell ranges). Pasting an unknown label into a status / dropdown cell offers to create the
label. Who: `items.create` (and `structure` to create labels when the column does not allow it). Writes share one
batch. Undo: toast for the whole batch.

### 7.4 Export to xlsx / csv

Who: board permission `general.export` (default: members and viewers yes, guests no; the owner can change it). UI:
board menu → "Export", the batch bar → export the selection, the view menu → export this view (respects filters / sort /
hidden columns). API: `POST /boards/:id/export`. Auto numbers are exported as values, formulas as computed values,
files as URLs. Event `board.exported` + an audit-log row. No undo.

### 7.5 Import from xlsx / csv

Who: `items.create` (and `structure` to create columns / labels). UI: board menu → "Import" → upload → mapping (file
columns → board columns, or "create column" per file column; how to handle rows that match existing items) → preview
→ "Import". The file is read **in the browser**; the rows are written through the normal item endpoints, up to 10,000
rows per import. `item_created` automations fire for imported items. Undo: toast + activity-log batch undo.

---

## 8. Views, columns, groups presentation

| op | who | UI / API | data | event | undo |
|---|---|---|---|---|---|
| Collapse / expand group | anyone (personal) | the arrow beside the title; group menu → "Collapse all"; **Ctrl+G** toggles all | personal view preferences (`PUT /views/:id/prefs`); the view's saved setting is the shared default | none | — |
| Column width | view editors (shared); everyone (personal until saved to the view) | drag the header edge | the view's settings (shared) / personal view preferences | `view.updated` when saved | — |
| Pin (freeze) column | view editors | column menu → "Pin" — pinned columns stay at the start (RTL: right) during horizontal scroll | the view's settings | `view.updated` | — |
| Hide / show column | view editors | column menu → "Hide"; the "Columns" button in the board header lists all with toggles | the view's settings | `view.updated` | — |
| Add view | board permission `views.add` (default: members yes; guests yes on shareable boards; viewers no) | "+" tab → type | ≤ 100 views | `view.created` | — |
| Delete view | `views.delete_own` / `views.delete_others` (owner) | tab menu → "Delete" | trash 30 days | `view.deleted` | activity log + trash |
| Lock view | owner / admin | tab menu → "Lock view" | `locked = true`; other users can change filters / sort **temporarily** (not saved) and get `view_locked` on save | `view.updated` | — |
| Set default view | owner | tab menu → "Set as default" | `boards.default_view_id` | `board.updated` | — |
| Filters / sort / group by | anyone temporarily; saved by view editors | the board header's filter builder (the same rules JSON as `items/query`) | the view's settings | `view.updated` | — |

Adding a column or group, renaming, settings, changing type and restrictions: who = `structure` / owner
(restrictions); events `column.created / updated / type_changed / restricted`, `group.created / renamed /
color_changed`. A type change is reversible from its conversion backup ([06 §2.8](06-API.md)) and through activity-log
undo for 7 days.

---

## 9. People: search, My Work, inbox, notifications, users

### 9.1 Search everything

Who: any user; results are filtered by visibility (guests: only their shareable boards). UI: the magnifier in the top
bar / **Ctrl+B** quick-search palette: items, updates, files, boards, docs, people; recent searches; arrow keys + Enter
open. **Ctrl+F** searches the current board. API: `GET /search`. Searches are not logged.

### 9.2 My Work

Who: everyone, including viewers (customize, not edit) and guests. Sections: **overdue · today · this week · next week
· later · no date** of items where the user appears in a people column (or the chosen column per board), using the
chosen date column per board (the first date / timeline column by default) and status column (done = labels flagged as
done). Customize: choose boards, people columns, per-board date / status columns, "Hide done items", group by board /
date. Inline edit of status / date / people (permission-checked per item). Limits: 50 boards, 1,000 items, items
updated within 4 months. API: [06 §2.23](06-API.md). Edits emit the normal item events.

### 9.3 Inbox / notifications

- **Bell** (top bar): the count of unread notifications; a list grouped today / yesterday / earlier; kinds: assigned to
  me, mention, item change (per board setting), board activity, automation, system. Click → opens the item / update.
  "Mark all as read". Settings → per-user notification settings (bell / email / digest per kind).
- **Inbox**: a feed of updates and replies from boards / items the user follows, plus mentions; filter to mentions only
  or by board; reply inline.
- Per-user settings: `GET / PATCH /me/notifications/settings`; the account default for new users is in the admin
  settings. Personal settings always cap what board settings deliver.
- **Board notification settings** (board menu → "Notifications"): **all** / **mute** / **custom** (mentions,
  assignments, automations, updates), `PUT /boards/:id/notifications`. Following an item happens automatically on
  create / assign / mention / update; manually via the item menu → "Follow" (`PUT /items/:id/follow`).

### 9.4 Users (admin): invite, deactivate, reactivate, delete details

Administration → "Users" (a users table: role editable inline, teams, status filter, bulk actions, CSV export). See
[06 §2.3](06-API.md) for the API and effects. Inviting a guest: the email must be on a domain outside the account's
authorized domains, and the invitation names the shareable boards the guest joins. Deactivation dialog: shows the
user's automations and sole-owned private / shareable boards and who takes them over (or the account's default
transfer user); confirm; audit row. Reactivate: filter inactive users → "Activate". Delete details: only when inactive;
irreversible; audit row. Teams: the "Teams" page; admins edit them.

### 9.5 Support access

Administration → security → "Allow support access" → duration → confirm. Creates a time-boxed grant for the platform's
support team, logged in the audit log on every use; it expires automatically and can be revoked any time. API:
[06 §2.24](06-API.md).

---

## 10. Keyboard shortcuts

The shortcuts list in the app (Shift+?) is rendered from `packages/shared/src/menus/shortcuts.ts`, which lists only
shortcuts that are wired. "Ctrl" is ⌘ on macOS.

| keys | scope | action |
|---|---|---|
| Shift+? | everywhere | the shortcut list |
| Ctrl+Z / Ctrl+Shift+Z | everywhere | undo the last action (within a minute) / redo |
| Ctrl+B | everywhere | search everything |
| Esc | everywhere | close a dialog / menu; on a board, clear the selection |
| Ctrl+F | board | search the board |
| Ctrl+G | board | collapse / expand all groups |
| Ctrl+Shift+L | board | the board's activity log |
| Ctrl+A | board | select every item in the view |
| Shift+click | board | select a range (on the checkbox) |
| ↑ ↓ ← → | board | move between cells (RTL-aware) |
| Shift+↑ ↓ ← → | board | select a range of cells |
| Tab / Shift+Tab | board | next / previous cell |
| Enter | board | edit the cell |
| Ctrl+C / X / V | board | copy / cut / paste cells |
| Delete | board | clear the cell (or range); on a selection, delete the selected items (with confirmation) |
| Shift+F10 | menus | the actions menu of what has focus |
| ↑ ↓ / Enter | menus | move between menu items / choose |

Shortcuts are disabled while typing in text inputs and editors.

---

## 11. Permission matrix (quick reference)

| operation | admin | member (owner) | member (edit_everything) | member (edit_content) | member (edit_assigned) | member (view_comment) | viewer | guest (shareable board, per set) |
|---|---|---|---|---|---|---|---|---|
| create board / folder / workspace | ✓ | ✓ | ✓ (account right) | ✓ | ✓ | ✓ | ✗ | ✗ |
| change board permissions / kind / move board / save template | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| add / edit / delete columns, group order, lock views | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ only with edit_everything |
| create items, paste, import | ✓ | ✓ | ✓ | ✓ | ✓ (own, created by them) | ✗ | ✗ | per set |
| edit cells | ✓ | ✓ | ✓ | ✓ | assigned / created only | ✗ | ✗ | per set, minus column restrictions |
| delete / archive items | ✓ | ✓ | ✓ | ✓ (category default on) | own only | ✗ | ✗ | per set |
| move item to board | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | only to shareable boards they are on |
| post updates / replies / likes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| export | ✓ | ✓ | per `general.export` | same | same | same | ✓ | ✗ default |
| automations: create / edit on the board | ✓ | ✓ | per `general.automations` | same | ✗ | ✗ | ✗ | per `general.automations` (actions limited to that board) |
| see the activity log | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| undo (activity log) | ✓ any | own | own | own | own | own | — | own |
| trash: see / restore / purge | all / all / all | own / own / own | own | own | own | own | — | own |
| invite members / guests | ✓ | ✓ (board subscribers) | ✓ members | ✓ members | ✗ | ✗ | viewers only | ✗ |
| My Work / search / favorites | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (own boards) |
| API tokens | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |

Item-level visibility (`view_items: assigned_or_created`) applies to every non-owner row of this table, including
search, My Work, exports, the recipients of automation notifications and webhooks (a webhook created by a user only
receives events for items that user can see — webhooks created by admins / service users see everything). The full
model is in [`05-PERMISSIONS.md`](05-PERMISSIONS.md).

---

## 12. Event catalogue (activity_log.type) used above

`item.created, item.renamed, item.reordered, item.moved_to_group, item.moved_to_board, item.converted, item.duplicated,
item.archived, item.restored, item.deleted, item.purged, cell.changed, link.changed, update.created, update.edited,
update.deleted, reply.created, like.added, button.clicked, group.created, group.renamed, group.color_changed,
group.reordered, group.moved_to_board, group.duplicated, group.archived, group.deleted, group.restored, column.created,
column.updated, column.settings_changed, column.type_changed, column.restricted, column.reordered, column.deleted,
column.restored, view.created, view.updated, view.deleted, view.restored, board.created, board.updated,
board.duplicated, board.moved, board.kind_changed, board.permissions_changed, board.members_changed, board.archived,
board.restored, board.deleted, board.exported, folder.created, folder.renamed, folder.updated, folder.moved,
folder.deleted, folder.restored, workspace.created, workspace.updated, workspace.deleted, template.created,
batch.executed, schedule.fired, webhook_in.received, undo.performed, manual.test`.

Every row carries `actor`, `source`, `batch_id`, `undo_of`, and is the single feed for: SSE ([06 §1.11](06-API.md)),
automations ([04 §5](04-AUTOMATIONS.md)), outgoing webhooks ([06 §2.17](06-API.md)), the activity log UI, and undo.
