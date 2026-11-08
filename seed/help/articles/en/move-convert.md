---
title: "Moving items between boards and converting them"
slug: move-convert
locale: en
translation_of: move-convert
category: "boards-groups-and-items"
tags: ["items", "boards", "subitems", "columns"]
visibility: public
excerpt: "How to move an item, several items or a whole group to another board with column mapping, and how to turn an item into a subitem and back."
publish: true
---
Work goes through stages, and sometimes through boards too: a lead that became a customer moves from a "Leads" board to a "Customers" board, and a task that turned out to be part of a bigger task should become its subitem. The system moves the item with its values, updates and history, and lets you decide exactly where each piece of information goes.

## What you'll learn

- Moving an item to another board and mapping the columns
- Moving several items or a whole group at once
- Turning an item into a subitem of another item
- Turning a subitem back into a regular item
- Undoing a move made by mistake

## Moving an item to another board

1. Open the item menu (**⋯** on the row, or right-click) and choose **Move to another board**.
2. In the window that opens, choose the **Workspace** (if there's more than one), then under **Target board** click **Pick a board** and choose the board.
3. Under **Group**, choose which group on the target board the item goes into.
4. Go over the **Column mapping** table (explained below).
5. Click **Move**.

The item disappears from the current board, and a message says it was moved to the target board, with an **Undo** button.

![The move-to-another-board window with the target board choice and the column mapping table](images/move-convert-1.webp)

## Column mapping

The mapping table lists every column of the current board that has values, and next to it the column on the target board the values will go into. The item name always moves, so it isn't listed.

- **Automatic matching:** the system suggests a column of the same type in advance, preferring one with the same name. "Status" maps to "Status", "Due date" to a matching date column, and so on.
- **Manual choice:** click the target column to choose a different one.
- **Converting between types:** sometimes columns of a different type that can be converted to are offered too, for example text to long text. Such an option is marked **converted**, and the values are converted to the target column's type.
- **New column:** choose **+ New column** to create a column on the target board identical to the source column, with the same settings. This option is available only if you're allowed to add columns on the target board.
- **Don't move:** a column that isn't mapped is marked in red with **Will be lost**, and its values won't move. In that case the confirm button says how many columns won't be mapped, for example **Move (2 columns not mapped)**.

> **Tip:** The next time you move an item between the same two boards, the mapping you chose appears in advance.

> **Note:** If you undo the move, the values of unmapped columns come back to the item too.

## Moving several items or a whole group

- **Several items:** tick the items with the checkboxes. In the action bar that appears at the bottom of the screen, click **To board**. The same window opens, titled "Move N items to another board".
- **A whole group:** in the group menu (**⋯** next to the group name), choose **Move to another board**. In the window, choose a board and map the columns. The group moves with all its items, so there's no need to choose a target group.

![The multi-select action bar with the To board button](images/move-convert-2.webp)

## Turning an item into a subitem

1. In the item menu, choose **Make a subitem of…**.
2. In the window, under **Of which item?**, search in the **Search items** box and choose the parent item.
3. If the board's subitems already have columns, a **Column mapping** table appears where you decide where each value goes. If they don't have columns yet, the columns are mapped automatically by type and name.
4. Click **Convert**.

The item appears under the parent item, and the subitem count next to the parent's name updates.

## Turning a subitem into an item

- **All the way:** in the subitem's menu, choose **Make an item**. In the window, choose a **Group**, check the mapping and click **Convert**.
- **One level only:** on a subitem at the second level or deeper, choose **Move up one level** (or Shift+Tab). It becomes a subitem of its grandparent, and its own subitems move with it.

> **Note:** A subitem doesn't move to another board on its own. Move the parent item, or turn the subitem into an item and then move it.

## Undo

Every move or conversion shows a message with an **Undo** button, and Ctrl+Z undoes it within a minute. After that you can still undo it from the board's **Activity log**.

## Permissions

- To move an item to another board, you need permission to move items on the current board, and permission to add items on the target board. If you're missing permission on either one, the move won't happen and a matching message appears.
- Turning an item into a subitem and back requires permission to edit and create items.

## Frequently asked questions

**What happens to the item's updates and files?**\
Updates always move with the item. Files in a files column move according to that column's mapping, like any other value.

**What happens to subitems when I move an item?**\
They move together with the parent item.

**Why is the "+ New column" option disabled?**\
You don't have permission to add columns on the target board. Ask the board owners to add the column, or map to an existing column.

## See also

- Subitems and nesting levels
- Multi-select and actions on several items
- Working with groups
- Undo and the activity log
- Changing a column's type
