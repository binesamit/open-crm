---
title: "Subitems and depth levels"
slug: subitems
locale: en
translation_of: subitems
category: "boards-groups-and-items"
tags: ["subitems", "items", "boards"]
visibility: public
excerpt: "How to break an item into subitems, and subitems into their own subitems, with their own columns, drag-and-drop ordering, sorting and filtering."
publish: true
---
Sometimes one item is really several small tasks: a project with stages, an order with several products, or a client with several requests. Subitems let you break an item into parts that open right below it on the board, and each part has its own owner, status and date. You can also go one level deeper and add subitems to a subitem, building a layered structure of work.

## What you'll learn

- Open an item's subitems list and add to it
- Add another level (a subitem of a subitem)
- Manage the subitem columns
- Reorder subitems, move them, and move them up between levels
- Sort, filter and search inside subitems too

## Adding subitems

1. Hover over the item row and click the arrow next to the name. On an item that already has subitems, their number also appears next to the arrow.
2. A small table opens below the item, with the **+ Add subitem** field at the bottom.
3. Type a name and press Enter. The field stays open so you can add the next one.

![Subitems open below an item, with their own header row and an add field](images/subitems-1.webp)

Another way: in the item menu (**⋯** or right-click), choose **Add subitem**.

> **Tip:** To keep the view uncluttered, subitem lists start closed each time you open the board. Clicking the arrow opens and closes them.

## Depth levels

A subitem can have subitems of its own:

1. Open the subitem's menu.
2. Choose **Add subitem**.
3. The add field of the new level gets the focus. Type a name and press Enter.

Each level is indented one step further in, like stairs, so it's easy to see what belongs to what. The number of levels allowed is set separately for each board. When you reach the last level, the **Add subitem** option simply doesn't appear in the menu.

## Subitem columns

Subitems have their own columns, separate from the item columns. For example: items have "Client" and "Deal amount" columns, and subitems have "Owner", "Status" and "Due date". All the subitems on the board, at every level, use the same columns.

- **Add a column:** Click **+** at the end of the subitems header row and choose a column type.
- **Change, hide and reorder:** Exactly like regular columns, through the column's header menu. The **Hide** panel in the toolbar has a separate list for subitem columns.
- **Summary row:** Each subitems list has its own summary row at the bottom.

> **Tip:** Want to see on the item itself how many of its subitems are done? Add a progress tracking column to the board, which calculates the percentage from the subitems' status.

## Reordering and moving

- **Order within the list:** Grab the drag handle at the start of the subitem row and drag it to its new place. **Add item below** in the menu adds a new subitem right after the current one.
- **To another item:** Drag a subitem and drop it in the middle of another item's or subitem's row, and it becomes that one's subitem. Dropping it on the top or bottom edge of a row places it next to that row, at the same level. The subitems under it move along with it.
- **One level up:** On a subitem at the second level or deeper, choose **Move up one level** in the menu (or Shift+Tab when it's selected).
- **Turn into a regular item:** Choose **Make an item**, choose a group and confirm.

![Dragging a subitem onto another item on the board](images/subitems-2.webp)

> **Note:** You can't put a subitem inside one of its own subitems, or go beyond the number of levels the board allows. In those cases the system simply won't let you drop it.

A subitem doesn't move to another board on its own: it moves together with its parent item. To turn a regular item into a subitem of another item, use **Make a subitem of…**. The details are in the article on moving and converting.

## Sorting, filtering and searching

- **Sort:** The **Sort** panel in the toolbar has a separate section, **Sort subitems**, which sorts them by their own columns. Without sorting, the manual order is kept. You can also sort by clicking a column header in the subitems header row.
- **Search:** Searching the board (Ctrl+F) also finds subitems at any level. Items that contain a match open and show only the matching subitems.
- **Filter:** The **Advanced conditions** also lists the subitem columns, for example **Subitem: Status**. The **Person also finds items by their subitems** option makes filtering by person also show items where only one of their subitems is assigned to that person.

A subitem that's shown only because something under it matches the filter appears faded, and hovering shows the explanation **Shown because an item under it matches the filter**.

## Frequently asked questions

**Where do I see subitems in the item card?**\
The item card has a **Subitems** tab with the full list, and you can add and edit from there too.

**Can I select several subitems and act on them together?**\
Yes. Check their checkboxes, or the checkbox in the header row that selects all of that item's subitems, and an actions bar appears, just like for items.

**Can I edit many subitems at once?**\
Yes. **Import and edit** has a **Subitems** tab, with a **Parent item** column that sets which item each row belongs to.

## See also

- Items: create, edit and duplicate
- Moving items between boards and converting
- Numbers, rating, progress tracking, checkbox and vote
- Import and edit in a sheet
- Search, filter, sort and group on a board
