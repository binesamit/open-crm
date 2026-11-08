# Boards, groups and items

Hebrew version: [boards-groups-items.he.md](boards-groups-items.he.md)

## What it's for

A board is a list of items. Each item is one row: a task, a client, an order. Items sit in groups (sections such as
"This week" or "Done"). An item can have subitems for the steps inside it. This guide covers adding, moving, copying
and removing all of these. It also covers editing many items at once and undoing mistakes.

## Groups

### Add a group

1. Press "New group" (or "Add a group") at the top of the board.
2. Type the "Group name", pick a "Color" and press "Add".

On a phone, "Add a group" is in the board's ⋯ menu.

### Group actions

Open the menu next to the group's name ("Actions for group …"):

- "Collapse group" / "Expand group", and "Collapse all groups" (Ctrl+G)
- "Rename", "Color"
- "New group above", "New group below", "Duplicate group"
- "Move up", "Move down"
- "Move to another board"
- "Archive", "Delete group"

A board keeps at least one group, so the last group can't be deleted, archived or moved.

## Items

Each board can use its own word for an item (lead, task, client). Buttons then read, for example, "+ Add task". Admins
set the default word for new boards in "Administration" > "General" > "Item terminology".

### Add an item

1. At the bottom of a group, press "+ Add item" and type the name. Or press "New item" at the top of the board.
2. Press Enter.

To add an item from a ready-made template, use "Add an item from a template". See [Item templates](item-templates.md).

### Open, rename and edit

- Click the item's name to open the item card. See [Item card and collaboration](item-card-and-collaboration.md).
- To rename, press F2 on the row or choose "Rename" in the item menu.
- Click a cell to edit it. Enter saves, Esc cancels, Tab moves to the next cell.

### Item actions

Right-click a row, or open its menu:

- "Open", "Open in new tab", "Copy link", "Copy ID" ("Copy key" when the board has an item key column)
- "Follow item": get notified about it
- "Rename", "Add item below", "Add subitem"
- "Duplicate", "Duplicate with updates"
- "Save as template", "Subitems from a template…"
- "Move to group", "Move to another board"
- "Make a subitem of…", "Move to item", "Make an item"
- "Archive", "Delete"

You see only what your permissions allow.

### Reorder and move items

- Drag a row by its ⋮⋮ handle, or press and hold the name cell until the row lifts. Drop it before, after or inside
  another row, or in another group.
- To move to another group without dragging: "Move to group" and pick the group.

### Move an item to another board

1. In the item menu, choose "Move to another board".
2. Pick the "Workspace", the "Target board" and the "Group".
3. Check the "Column mapping". Each column goes to a column of the same type on the target. You can choose "Don't
   move" for a column, or create a "+ New column" on the target (if you may add columns there). Values that are not
   mapped are marked "Will be lost".
4. Press "Move".

Undo brings the unmapped values back.

## Subitems

Subitems break an item into smaller steps. They live on a sub-board with columns of their own. The sub-board starts
with name, owner, status and date columns. You can add more from the subitems' header row, like on any board.

### Add subitems

1. Press the arrow next to the item's name. It also shows how many subitems there are.
2. Press "+ Add subitem" and type the name.

Or choose "Add subitem" in the item menu. Subitems can have subitems of their own, up to five levels below the item.
Each level is indented further in.

### Change the level of an item

- "Make a subitem of…": turns an item into a subitem of another item. Its values move to the subitems' columns.
- "Make an item": turns a subitem back into an item. You pick the group and check the column mapping.
- "Move to item" > "Under an item…" or "One level up": moves a row within the hierarchy.

Subitems follow the parent board's permissions. Deleting or archiving an item takes its subitems with it.

## How items are named

By default people type item names. You can also have the name built from columns.

1. Open the menu of the name column and choose "Item name source".
2. Choose one of:
   - "Free text": people type the name.
   - "From a column": the name is one column's value (for example a client, a number or a date).
   - "Template": combine columns and text, for example {Client} – {Date}.
3. Optional: set the "Text when empty", turn on "Warn when two items get the same name", and choose whether to
   open the item card after creating an item.
4. Check the "Preview" and press "Save".

Names update by themselves when the columns change. Going back to "Free text" keeps the current names as plain,
editable text. For subitems, open the menu of their own name column.

## Select many items and edit them together

1. Tick the check box at the start of each row. Shift+click ticks a range, and Ctrl+A selects every item in the view.
2. A bar shows "… items selected". Choose an action:
   - "Edit": set one value for every selected item in a column, or "Clear the value in all".
   - "Shift dates": move a date column by a number of days, or of working days. A negative number moves earlier.
   - "Move to group", "To board", "Move to item"
   - "Duplicate", "Archive", "Delete"
   - "Export to Excel": download only the selected items.
3. "Clear selection" (or Esc) ends the selection.

Up to 5,000 items can be selected at once. Items you have no permission to change are skipped, and the bar says how
many.

To edit a whole board like a spreadsheet, see the "Import" sheet in [Import and export](import-export.md).

## Duplicate a board

1. In the sidebar, open the board's menu and choose "Duplicate board".
2. Type the "New board name" and pick the "Workspace".
3. Under "What to copy", choose "Structure only", "Structure and items" or "Structure, items and updates".
4. Optional: "Keep the subscribers".
5. Press "Duplicate".

To reuse a board's setup later, choose "Save as template" instead.

## Undo and redo

- After most actions a message appears with "Undo". Press it to take the action back.
- Ctrl+Z undoes your last action for up to a minute. Ctrl+Shift+Z (or Ctrl+Y) redoes it.
- Older actions: open the board's ⋯ menu > "Activity" (Ctrl+Shift+L). Each row shows who did what and when, with
  "Undo" on actions you may undo (your own, or anyone's if you are an admin) for seven days. One action on many items
  is undone as one.
- You can search the log and filter it by "Person", "Column", "Action type" and "Dates".

If someone changed the value after your action, you are warned ("The value changed since") and can choose "Undo
anyway".

## Archive, trash and restore

There are two ways to put things away:

- "Archive": for items, groups and boards you're finished with but want to keep. They stay in the archive with no
  time limit. An archived board is left out of lists and search.
- "Delete": moves things to trash. Trash keeps them for 30 days, then deletes them for good.

### Restore something

1. Open the avatar menu and choose "Archive" or "Trash".
2. Find it with the search box (in trash you can also filter "All types").
3. Press "Restore".

If the thing you restore sits inside something that is also in trash (for example an item of a deleted board), you
are asked to "Restore both".

In trash, members see what they deleted, and admins see everything deleted in the account. "Delete permanently"
removes one entry for good. Only admins can "Empty trash". Guests don't have trash or archive.

## Related

- [Getting started](getting-started.md)
- [Columns](columns.md)
- [Views](views.md)
- [Search, filter, sort and group](search-filter-sort-group.md)
- [Item card and collaboration](item-card-and-collaboration.md)
- [Item templates](item-templates.md)
- [Import and export](import-export.md)
- [Sharing and permissions](sharing-and-permissions.md)
