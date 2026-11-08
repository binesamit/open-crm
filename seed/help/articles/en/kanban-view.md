---
title: "Kanban view"
slug: kanban-view
locale: en
translation_of: kanban-view
category: "views"
tags: ["views", "boards", "items", "columns"]
visibility: public
excerpt: "Turn any status or dropdown column into a Kanban board, drag cards between stages and choose which fields appear on each card."
publish: true
---
The Kanban view shows the board's items as cards arranged in lanes, one lane per label. It's the natural way to manage a process with stages — requests, deals, tasks — and see at a glance where everything stands. Dragging a card from one lane to another updates the value on the board itself, so all the other views update immediately.

## What you'll learn

- How to create a Kanban view and which column it's based on
- How to move cards and add items directly in a lane
- How to reorder lanes and edit the labels
- How to choose which fields appear on the cards

## Creating a Kanban view

1. At the top of the board, next to the view tabs, click **+**.
2. Choose **Kanban**.
3. Give the view a name and click **OK**.

The Kanban is built on a **Status** or **Dropdown** column. Each label in the column becomes a lane in the Kanban, plus a lane called **Empty** for items that don't have a value yet.

> **Note:** If the board has no status or dropdown column, you'll see the message **A Kanban needs a status or dropdown column on the board.** Add such a column and the Kanban builds itself.

![Kanban view with "Working on it", "Stuck", "Done" and "Empty" lanes, and cards in each lane](images/kanban-view-1.webp)

## Moving cards

- **Change stage:** Drag a card to another lane. The value in the item's status (or dropdown) column updates immediately.
- **Order within a lane:** Drag a card up or down to set its position. The order is kept after a refresh too.
- **The "Empty" lane:** Dragging a card there clears the item's value.

> **Tip:** When the view has a sort, a card's position within the lane is set by the sort. In that case dragging changes only the lane, not the order.

In a Kanban based on a **Dropdown** column, an item can appear in several lanes at once if several values are selected for it.

## Opening an item and card actions

- Clicking a card opens the **item card** with all the details, updates and files.
- Right-clicking a card (or **⋯**) opens the item menu — the same menu you get in the table.
- The card also shows the item's update count, so you can see right away where there's an active conversation.

## Adding an item directly to a lane

At the bottom of each lane there's a **+ New item** field. Type a name and press Enter — the item is created on the board with that lane's value. You can keep typing to add several items in a row.

## Lane actions in the Kanban

Click **⋯** in the lane header:

- **New item in this lane** — focuses the lane's add field.
- **Edit labels** — change the names, colors and order of the labels (for people allowed to edit columns).
- **Move left** / **Move right** — moves the lane one place.

You can also drag a whole lane by its header to another position. The lane order is saved as part of the view.

## Kanban settings

In the board toolbar, click **View settings**. In the window you'll find:

| Setting | What it does |
| --- | --- |
| **Kanban lanes by** | Chooses the status or dropdown column the Kanban is built on |
| **Fields on cards** | Tick which columns are shown on each card |
| **Show empty lanes** | When cleared, lanes with no cards are hidden |

![Kanban "View settings" window with "Kanban lanes by", "Fields on cards" and "Show empty lanes"](images/kanban-view-2.webp)

When you don't choose any fields, the card automatically shows up to four useful fields — status, people, number and date. Empty fields aren't shown, so the card stays clean.

> **Note:** As in every view, the settings start as a draft. Click **Save to view** so they apply to everyone.

## Frequently asked questions

**Can I filter the Kanban?**\
Yes. Search, **Filter** and the **Person** filter in the toolbar work in the Kanban exactly as they do in the table.

**The board has several status columns. How do I switch?**\
In **View settings**, choose a different column under **Kanban lanes by**. You can also create two Kanban views, one for each column.

**On a large board, not all the cards appear.**\
On especially large boards, each lane loads its first cards. Click **Show more** at the bottom of the lane to load more.

## See also

- Working with views
- Status, dropdown and tags
- Files view and cards view
- The item card
