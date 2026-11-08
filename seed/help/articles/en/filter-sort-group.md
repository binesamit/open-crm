---
title: "Search, filter, sort and group on a board"
slug: filter-sort-group
locale: en
translation_of: filter-sort-group
category: "search-filter-and-sort"
tags: ["filters", "search", "views", "boards"]
visibility: public
excerpt: "How to search a board, narrow it with a quick filter, sort by several levels, group by a column, hide columns and save it all in a view."
publish: true
---
A board with hundreds of items becomes truly useful when it shows only what matters right now: my tasks, this month's deals, or the customers waiting for a reply. The toolbar above the board brings together all the tools for this: search, filter, sort, group and hiding columns. Every such change shows immediately, and is saved in the view only if you choose to save it.

## What you'll learn

- Search the board, including subitems
- Filter quickly by status, person, group or date
- Sort by several levels and group by a column
- Hide columns and reorder them
- Save the settings in the view or reset them

![The board toolbar with search, filter, sort, group and hide](images/filter-sort-group-1.webp)

## Searching the board

1. In the toolbar, click the magnifying glass icon (**Search this board…**), or press Ctrl+F.
2. Type a word, name or number. The board filters as you type, and the matching text is highlighted in the cells.
3. Esc clears the search.

The search checks the item name and the text of all the cells, as well as subitems at every level. An item with a matching subitem expands and shows only the matching subitems. The search stays active when you switch between views of the same board.

> **Tip:** On a board, Ctrl+F opens the board's search, not the browser's. To search the whole account, use Ctrl+B.

## Quick filter

1. Click **Filter** in the toolbar.
2. The top part, **Quick filters**, shows a column for each of these: **Group**, status and dropdown columns, people columns, tags and date columns. Next to each value you see how many items currently have it.
3. Click values to filter. Several values in the same column mean "any of them", and values from different columns mean "all of these".

![The filter panel with quick filter values and the number of items for each value](images/filter-sort-group-2.webp)

A few useful details:

- In people columns, **Me** appears first: clicking it filters the items assigned to you. Teams appear too.
- Date columns show relative values: **Today**, **Yesterday**, **Tomorrow**, **This week**, **Last week**, **Next week**, **This month**, **Last month**, **Next month** and **Overdue**. They're recalculated every day.
- Every column also has **Empty**, for items with no value.
- At the top you see **Showing N of M**, and **Clear all** removes all the conditions.

When the filter is active, the number of conditions appears next to the **Filter** button, and hovering over it shows them in words. For more complex conditions, with "or", condition groups and negation, use **Advanced conditions** in the same panel.

## Sort

1. Click **Sort**.
2. Click **+ Add sort**, choose a column and choose **Ascending** or **Descending**.
3. You can add up to five sort levels. For example: first by status, and within each status by due date. Drag sort rows to change their order, and **Remove sort** deletes a level.

**Quick sort:** Hover over a column header and click the arrow that appears. The first click sorts ascending, the second descending, and the third removes the sort.

On a board with subitems, the same panel also has **Sort subitems**, which sorts the subitems by their columns. When there's no sort, the manual order is kept.

> **Note:** While the view is sorted or grouped by a column, you can't drag items to arrange them manually.

## Group by

The default is the board's groups. Instead, you can group the items by the values of a column:

1. Click **Group by**.
2. Choose a column, for example status, owner, due date or checkbox.
3. Choose **Ascending** or **Descending** for the order of the groups.

Each value becomes a group in the view, and items with no value appear under **No value**. When you group by date, the groups are relative: **Today**, **This week**, **Next week**, **Next month**, **Later**, **Earlier** and so on. In a column that can hold several values, like people, an item appears in every group that matches it. Dragging an item between groups in a grouped view changes its value in the column. To go back to the regular split, choose **Board groups**.

Grouping is available in the table view.

## Hiding columns

1. Click the eye icon (**Hide**). When there are hidden columns, their number appears next to it.
2. Untick the columns you want to hide, or use **Show all** and **Hide all**. The **Search columns** box helps on a board with many columns.
3. Drag columns in the list to change their order in the view.

Subitem columns have a separate list in the same panel.

## Saving in the view

Everything described here is a draft of the view. As soon as you change something, a bar appears with "N unsaved changes", containing:

- **Save to view** – saves the changes in the current view, for everyone who uses it.
- **Save as a new view** – creates a new view with these settings. On the board's main table this is the only option.
- **Reset** – returns the view to its saved state.

Free-text search isn't saved in the view. It belongs to your current visit to the board.

> **Note:** In a locked view you can filter and sort temporarily, but not save. Instead you'll see **This view is locked — save as a new view**. Your temporary changes don't affect anyone else.

## Frequently asked questions

**The board is suddenly empty. What happened?**\
A filter or search is probably hiding everything. You'll see the message **No items match the filter.** and next to it **Reset**, which returns the view to its saved state.

**How do I filter "my tasks" in one click?**\
In the quick filter, in the people column, click **Me**, and save it as a new view called "My tasks". From now on, just choose it.

**Where is this on a phone?**\
On a phone, search is in the board's top bar, and the other tools open as a sheet from the bottom of the screen.

## See also

- Advanced conditionss: conditions, condition groups and connections
- Working with views
- Searching the whole account
- Conditional coloring
- Subitems and depth levels
