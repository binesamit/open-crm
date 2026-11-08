---
title: "Selecting several items and acting on them together"
slug: multi-select
locale: en
translation_of: multi-select
category: "boards-groups-and-items"
tags: ["items", "boards", "shortcuts"]
visibility: public
excerpt: "How to select several items together and set a value, shift dates, move, duplicate, export, archive or delete them in one action."
publish: true
---
When you need to update dozens of items, there's no reason to go through them one by one. Select them all, and an action bar appears at the bottom of the screen that works on all the selected items at once: it sets a value in a column, shifts dates, moves them to another group or board, duplicates, exports, archives or deletes. Each such action counts as one action, so undoing it brings all the items back together too.

## What you'll learn

- Select single items, a range, a whole group or the entire view
- Use the action bar at the bottom of the screen
- Set one value for all the items and shift dates
- Undo an action you took on many items

## How to select

| What you want to select | How |
| --- | --- |
| One item | Hover over the row and check the checkbox at its start |
| A range of items | Select one item, then Shift+click another item's checkbox. Everything in between is selected |
| A whole group | Check the checkbox in the group's header row |
| All of an item's subitems | Check the checkbox in the subitems header row |
| Everything shown in the view | Ctrl+A (when the focus isn't in a text field) |
| Clear the selection | Esc, or **Clear selection** in the bar |

Selection works in the table view and the cards view. In cards there's a checkbox on each card, and Ctrl+click on a card adds it to the selection without opening it.

> **Tip:** Ctrl+A selects only what the view currently shows. Filter first by status, person or date, and Ctrl+A will select exactly the items you need.

> **Note:** On a very large board, Ctrl+A selects up to 5,000 items and shows the message **The first 5,000 are selected — filter to narrow down**.

## The action bar

As soon as you select at least one item, a bar appears at the bottom of the screen with the number of selected items and these actions:

![The action bar at the bottom of the screen with three items selected](images/multi-select-1.webp)

| Button | What it does |
| --- | --- |
| **Edit** | Sets one value in the column you choose, for all the items |
| **Shift dates** | Moves dates earlier or later by a number of days |
| **Move to group** | Moves them all to another group on the board |
| **Export to Excel** | Downloads an Excel file with only the selected items |
| **To board** | Opens the move to another board window, with column mapping |
| **Duplicate** | Creates a copy of each of the items |
| **Archive** | Moves them all to the archive |
| **Delete** | Moves them all to the Trash, after you confirm (the Delete key works too) |
| **Clear selection** | Clears the selection (Esc works too) |

The same actions are available when you right-click one of the selected rows. The menu that opens works on all the selected items, not just the row you clicked. The bar shows only actions you're allowed to take.

## Set a value for all the items

1. In the bar, click **Edit**.
2. Choose the column you want to update, for example "Status" or "Owner".
3. An editor opens, titled **Value for every item in "…"**. Choose or type the value, just like in a regular cell.
4. The value is written to all the items, and a message appears such as **"Status" updated on 12 items**.

To empty a column in all the items, click **Clear the value in all** in the same editor.

**A quicker way:** When two or more items are selected, you can simply edit a cell in one of the selected rows. Hovering over the cell shows **Applies to N items**, and the value you choose is written to all the selected items in that column.

![The multi-edit value editor, open on a Status column](images/multi-select-2.webp)

## Shift dates

1. In the bar, click **Shift dates** and choose a date column.
2. In the **Shift "…"** window, type how many days to shift by. A positive number moves dates later, and a negative number moves them earlier.
3. Confirm. Every date in the column moves by exactly the number of days you chose, relative to the date it had.

This is especially useful when a whole project slips by a week: no need to go through each date separately.

## Permissions and skipped items

Each action runs only on items you're allowed to change. If some of the items can't be edited, for example because of an edit restriction on a column, they're skipped, and the message says so, for example **3 skipped (no permission)**.

## Undo an action on many items

- The message that appears after each action has an **Undo** button, which brings back all the items at once.
- Ctrl+Z undoes the last action within a minute.
- In the board's **Activity log**, the action appears as a single row, for example "2 items (…)". The **Undo** button in that row undoes all of it.

## Frequently asked questions

**Why doesn't a certain column appear in the "Edit" list?**\
Some columns are updated in their own way rather than through multi-edit, for example files, time tracking, votes and connect boards. Calculated columns such as formula and mirror don't appear either.

**The selection disappeared after I applied a filter. Why?**\
The selection includes only items shown in the view. An item the filter hides drops out of the selection.

**Can I select items in a Kanban or calendar view?**\
Multi-select is available in the table view and the cards view. To work on many items, switch to the table.

## See also

- Items: create, edit and duplicate
- Import and edit in a sheet
- Moving items between boards and converting
- Undo and the activity log
- Keyboard shortcuts
