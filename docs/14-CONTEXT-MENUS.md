# 14 — Context menus (right-click), ⋯ menus and keyboard shortcuts

How entity menus work: where the ⋯ button appears, what each entity's menu contains, how permissions filter it, the
keyboard shortcuts, and how the menu registry is implemented and tested. For frontend contributors adding or changing
an action.

Rule: every entity has **one menu**, opened identically from three places — right-click, the ⋯ button (shown on hover
and on keyboard focus), and Shift+F10 / the Menu key. The entries come from a registry
(`packages/shared/src/menus/<entity>.ts`) filtered by permissions — an entry the user may not use is **not shown**
(rather than disabled). Destructive entries come last, after a separator, in red. Extensions add entries through the
`board_menu_action` slot ([`10-EXTENSIONS.md`](10-EXTENSIONS.md)).

Rendering: RTL-aware, submenus open towards the free side, keyboard navigation, the shortcut shown on the side
(`Kbd`). Right-clicking an item that is **not selected** selects it first; right-clicking an item inside a multiple
selection acts on all selected items (the batch menu, §2).

## 0. Where the ⋯ button appears

| Entity                            | Position                                    | Visible                                  | Opens                 |
| --------------------------------- | ------------------------------------------- | ---------------------------------------- | --------------------- |
| Item (row)                        | at the start edge of the row, by the checkbox | on hover / keyboard focus / always on mobile | §1                    |
| Item (Kanban / Cards tile)        | the tile's corner                           | on hover                                 | §1                    |
| Item (item card header)           | next to ⬆⬇                                  | always                                   | §1 (without "Open")   |
| Subitem                           | as an item, indented                        | on hover                                 | §1 + "Make top-level item" |
| Group                             | next to the group name                      | on hover over the group header           | §5                    |
| Column (table header)             | at the side of the header                   | on hover                                 | §4                    |
| Cell                              | no ⋯ — right-click only (or Shift+F10)      | —                                        | §3                    |
| View (tab)                        | on the tab                                  | active tab: always; others: on hover     | §9                    |
| Board (sidebar)                   | at the end of the row                       | on hover / focus                         | §6                    |
| Folder (sidebar)                  | at the end of the row                       | on hover                                 | §7                    |
| Workspace (picker)                | ⋯ next to the workspace name                | always                                   | §8                    |
| Update / reply                    | the message's corner                        | on hover                                 | §10                   |
| Dashboard / widget                | the widget's header                         | on hover                                 | dashboard actions     |
| Users, teams, templates (admin)   | at the end of the row                       | on hover                                 | row actions           |

Accessibility: every ⋯ is a `<button aria-haspopup="menu" aria-label="Actions for <entity>">`, shown on keyboard focus
too (not only on hover), and its menu is identical to the right-click menu.

## 1. Item (row / name / Kanban tile)

| Entry                                     | Shortcut     | Permission                     | Notes                                            |
| ----------------------------------------- | ------------ | ------------------------------ | ------------------------------------------------ |
| Open                                      | Enter        | view                           | the item card (not shown inside the card)        |
| Open in a new tab                         | Ctrl+Enter   | view                           |                                                  |
| Copy link                                 |              | view                           |                                                  |
| Copy ID / copy key                        |              | view                           | the ULID, or the custom key (`BT-0042`) when set |
| Follow                                    |              | view                           | a checkbox entry                                 |
| Rename                                    | F2           | `item.update`                  | inline                                           |
| Add item below                            |              | `item.create`                  | in the same group                                |
| Add subitem                               |              | `item.create`                  | if the depth allows                              |
| Duplicate / duplicate with updates        |              | `item.create`                  |                                                  |
| Save as template / subitems from template |              | `column.create` / `item.create` | item templates                                   |
| Move to group ▸ / move to board…          |              | `item.move_group`              | a mapping screen for another board               |
| Make subitem of… / make top-level item    |              | `item.update` + `item.create`  | columns mapped automatically                     |
| Archive                                   |              | `item.delete`                  | with undo                                        |
| Delete                                    | Delete       | `item.delete`                  | to the trash for 30 days                         |
| — extensions —                            |              |                                | `board_menu_action` with `contexts: item`        |

## 2. Multiple selection (batch bar + right-click on a selected item)

Set value ▸ (status / people / date … for all — a submenu by column) · Shift dates by N days · Move to group ▸ · Move
to board… · Duplicate · Archive · Delete · Clear selection (Esc). Selecting: checkbox, Shift+click for a range,
Ctrl+click, the group's checkbox = the whole group, Ctrl+A on the board = everything in the filtered view.

## 3. Cell

| Entry                        | Shortcut          | Notes                                                                                                   |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| Edit                         | Enter / typing    | the type's editor                                                                                       |
| Open link                    |                   | link / email / phone cells                                                                              |
| Copy / cut / paste           | Ctrl+C / X / V    | the clipboard holds text + internal JSON (`application/x-bines-cell`); paste into a range; pasting from a spreadsheet creates rows |
| Clear cell                   | Delete / Backspace |                                                                                                         |
| Open linked item             |                   | relation / mirror cells                                                                                 |

## 4. Column header

Rename (F2) · Settings (type-specific options, description, validation, restrict edit / view, default value for new
items) · Add column before ▸ / after ▸ (by type) · Width for everyone · Change type (allowed pairs,
[`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md) §5) · Conversions · Copy column ID · Delete (to the trash; the name column
cannot be deleted). Sorting, filtering and grouping by the column are in the board toolbar
([`13-FILTERS.md`](13-FILTERS.md)).

## 5. Group (header)

Collapse / expand · Collapse all / expand all (Ctrl+G) · Rename · Colour ▸ · Add group above / below · Duplicate group
· Move up / down · Move to board… · Archive · Delete (to the trash; the only group cannot be deleted, moved or
archived).

## 6. Board (sidebar / header)

Open in a new tab · Copy link · Copy board ID · Rename · **Move to ▸** folder… / workspace… · Duplicate · Save as
template · Archive · Delete. The board header also holds the board's settings, permissions, members, automations,
activity log (Ctrl+Shift+L) and export ([`11-UI-DESIGN.md`](11-UI-DESIGN.md) §2). Docs and dashboards in the sidebar
have the same menu shape (open in a new tab, copy link, copy ID, rename, move to, duplicate, delete).

## 7. Folder (sidebar)

New inside ▸ board / doc / dashboard / subfolder · Rename · Delete.

## 8. Workspace (picker / name)

New ▸ board / doc / dashboard / folder · Rename · Delete. Workspace settings (name, icon, description, open / closed)
and members are in the workspace page.

## 9. View (tab)

Pin / unpin (personal tab order) · Rename · Duplicate · Copy to board… · Make default (shared views, managers) · Lock /
unlock (managers) · Make shared (a private view) · Delete (the main table cannot be deleted). Details:
[`15-VIEWS.md`](15-VIEWS.md).

## 10. Update / reply

Reply · Edit (author) · Copy text · Copy link · Delete (author / board owner).

## 11. File

File versions have their own menu in the file viewer (`features/files/versions.tsx`): open, download, make current,
delete a version.

## 12. Users and teams (admin)

Row menus in Administration → Users and Teams ([`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md) §3).

## 13. Automations

Automations are listed in the automations screen with a switch and actions per row (edit, run history, delete).

## 14. Empty areas

Right-clicking an empty area has no menu of its own; use the toolbar and the "+" buttons.

## 15. Keyboard shortcuts

The list shown by Shift+? comes from `SHORTCUTS` in `packages/shared/src/menus/shortcuts.ts`:

- Global: Shift+? shortcut list · Ctrl+Z / Ctrl+Shift+Z undo / redo (the last action, up to a minute; older changes
  through the activity log) · Ctrl+B quick search · Esc close.
- Board: Ctrl+F board search · Ctrl+G collapse groups · Ctrl+Shift+L activity log · Ctrl+A select all · Shift+click
  range · arrows move in the grid · Tab next cell · Enter edit / open · Shift+arrows extend a range · Ctrl+C / X / V ·
  Delete clear cells / delete the selection · Esc clear the selection.
- Menus: Shift+F10 context menu · ↑ ↓ move · Enter choose.

## 16. Implementation

`packages/shared/src/menus/`: `types.ts` (`MenuNode` = action / submenu / separator, `menu()` removes redundant
separators, `menuIds()` for tests), `board.ts` (`itemMenu`, `groupMenu`, `columnMenu`, `viewMenu`), `sidebar.ts`
(`sidebarBoardMenu`, `folderMenu`, `workspaceMenu`, `sidebarDocMenu`, `sidebarDashboardMenu`), `cell.ts`
(`cellMenu`), `batch.ts` (`batchMenu`), `tree.ts` (moving within the item tree), `update.ts` (`updateMenu`),
`shortcuts.ts` (`SHORTCUTS`). Every builder receives a ctx with `caps` (the capabilities from `GET /boards/:id`) or
permission flags from the server, and returns only what is allowed. A new action enters the registry together with
its handler.
In the web app: `toMenuEntries(nodes, handlers, slots)` (`apps/web/src/lib/entity-menu.ts`) maps each `id` to a
handler (an id without a handler is an error in development), and a submenu without `items` is filled from `slots`
(groups, folders, column types). `useActionMenu().onKeyDown` = Shift+F10 / the Menu key. `useItemMenu` is shared by the
row, Kanban and Cards. Global shortcuts: `features/shell/Shortcuts.tsx` (Shift+?, Ctrl+Z = undo the last action up to
a minute).
Tests: `packages/shared/test/menus.test.ts` — a snapshot of every menu × role (admin / owner / member / contributor /
viewer / guest) plus explicit rules (a viewer sees no edit / destructive entry; the last group and the name column
cannot be deleted).
