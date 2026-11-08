---
title: "Undo and the activity log"
slug: undo-activity
locale: en
translation_of: undo-activity
category: "boards-groups-and-items"
tags: ["boards", "items", "shortcuts", "trash"]
visibility: public
excerpt: "How to undo an action from the message or with Ctrl+Z, redo it, and find and undo older changes in the board's activity log."
publish: true
---
Everyone makes mistakes sometimes: deleting the wrong item, pasting over the wrong column, or moving a whole group to another board by accident. Almost every action can be undone: right after you do it, with one click or with Ctrl+Z, and even days later through the activity log. The log records who changed what and when, and shows the value before and after the change.

## What you'll learn

- Undo an action right away, from the message or from the keyboard
- Redo an action you undid
- Open the board's activity log and filter it
- Undo an older action from the log

## Undoing right away

**From the message:** After actions such as deleting, archiving, duplicating, moving to a group or to another board, and actions on several items, a short message appears at the bottom of the screen with an **Undo** button. Clicking it brings back the previous state, and the message **Undone** appears.

**From the keyboard:**

| Shortcut | What it does |
| --- | --- |
| Ctrl+Z | Undoes the last action, if less than a minute has passed since you did it |
| Ctrl+Shift+Z or Ctrl+Y | Redoes what you just undid |

Ctrl+Z also works on edits that don't show a message, such as changing a value in a cell or renaming an item. Pasting a range of cells, or clearing several cells together, counts as one action and is undone together.

> **Tip:** If there's nothing to undo, the message **Nothing to undo** appears. In that case, look for the action in the activity log.

## Opening the board's activity log

1. In the board header, click **⋯** (**More actions**).
2. Choose **Activity**. You can also just press Ctrl+Shift+L.

The **Activity — board name** window opens, with a list of actions from newest to oldest. Each row shows who did the action, what they did, on which item and how long ago. Hovering over the time shows the exact time. For a value change, the previous value and the new value are shown too.

![A board's activity log with action rows, before and after values and an undo button](images/undo-activity-1.webp)

A few things worth knowing about the log:

- An action done on several items together appears as one row, for example "3 items (…)".
- An action by an automation or by the platform is marked with a lightning icon and the label **System**.
- An action done through a form, an extension or an outside AI assistant names its source, for example **via the form "Service request"**.
- An action that was undone is marked with an **Undone** tag, and the undo action itself appears with the suffix **undo**.

## Filtering the log

At the top of the log there's a filter row:

- **Search the log — item, person, value…**: free search
- **Anyone**: only actions by a specific person
- **All columns**: only changes to a specific column
- **All actions**: by action type, for example **Column value changed**, **Item created**, **Moved to a group**, **Deleted** or **New update**
- **Any date**: a date range from a calendar

**Clear filters** brings back the full list.

## Undoing an action from the log

1. Find the action in the log. It's usually quickest to filter by column, person or date.
2. On the action's row, click **Undo**.
3. If the value has changed again since, the question **The value changed since** appears: undoing brings back the state from before the action and overwrites the later change. Click **Undo anyway** to go ahead.

![The confirmation window The value changed since, with the Undo anyway button](images/undo-activity-2.webp)

What you can undo from the log:

- A change to a cell value and renaming an item
- Creating, duplicating, moving to a group and changing an item's position
- Moving to another board and converting to a subitem
- Archiving and deleting. The item, group or column comes back from the archive or from the Trash
- Import and edit and import, as one complete action
- Changing a column's type

> **Note:** The **Undo** button appears in the log only on actions you did yourself in the last seven days. Account admins can also undo other people's actions. Each action can be undone once.

## The history of a single item

To see only what happened to a specific item, open the item card and go to the **Activity** tab. It shows the same details, only for that item.

## Frequently asked questions

**I pressed Ctrl+Z and nothing happened. Why?**\
Ctrl+Z undoes only the last action, and only in the first minute after it. If more time has passed, or you've done another action in the meantime, undo it from the activity log.

**I deleted an item two weeks ago. How do I get it back?**\
Deleted items are kept in the Trash for 30 days. Go to the Trash and restore it from there.

**Does undoing also reverse actions by an automation that ran because of the change?**\
No. Undoing reverses only the action you picked. If an automation changed other values as a result, those changes appear in the log as separate rows.

## See also

- Trash and restoring
- Archive
- Multi-select and actions on several items
- The item card
- Keyboard shortcuts
