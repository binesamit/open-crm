---
title: "Status, dropdown and tags"
slug: status-dropdown-tags
locale: en
translation_of: status-dropdown-tags
category: "columns"
tags: ["columns", "items", "boards"]
visibility: public
excerpt: "How to work with status, dropdown and tags columns: picking a value, creating and editing labels, colors, the “Done” label and the differences between the three types."
publish: true
---
These three columns help you classify items with labels set up in advance, instead of free text. That way everyone uses the same terms, and you can filter, group and build automations reliably. **Status** shows one colored label that fills the whole cell, **Dropdown** lets you pick several labels from a list that belongs to the board, and **Tags** are labels shared across the whole account that you can use on several boards.

## What you'll learn

- How to pick and clear a value in a status column
- How to add, color, reorder and delete labels
- What the "Done" label is for
- How to work with a dropdown and create labels in it as you type
- When to use tags

## The status column

Every new status column comes with three ready-made labels: **Working on it** (orange), **Done** (green) and **Stuck** (red). You can change them and add more.

### Picking a status

1. Click the status cell in the item's row.
2. Pick a label from the list. The cell takes on its color right away.
3. To empty the cell, click **Clear** at the bottom of the list.

### Editing the labels

1. Click any cell in the column, and at the bottom of the list click **✎ Edit labels**.
2. In the label editor you can:

   - Change the **Label name** right in the field (up to 30 characters).
   - Click the color square and pick another color from the palette.
   - Drag the handle at the side of the row (**Drag to reorder**) to reorder the labels.
   - Mark one label as the **"Done" label** by clicking its check mark.
   - Click **Delete label** to remove it.
   - Click **+ New label** to add a label.
3. Click **Save**.

![The status column's label editor with colors, drag handles and the Done label mark](images/status-dropdown-tags-1.webp)

> **Note:** If you delete a label that's still used by items, it doesn't disappear from them. It just stops appearing in the list to pick from, and existing items keep it. That way no value is lost.

> **Tip:** Editing labels is available only to people allowed to change the board's column settings. Other users can only pick existing labels.

### Why the "Done" label matters

The label marked as "Done" tells the platform what counts as "finished". It's used by:

- The group's **Summary row**, which shows the **distribution** of labels as a color bar.
- The filter that checks whether an item is finished or not.
- The **Progress tracking** column, which counts finished statuses.
- The **My work** screen, which tells open tasks apart from finished ones.

Each column can have only one "Done" label.

## The dropdown column

A dropdown is similar to a status, but you can pick several labels in the same cell, and the labels show as gray chips with no color. It suits things like areas of interest, products a client bought or marketing channels.

1. Click the cell. A list opens with checkboxes and a **Search or create a label** field.
2. Check existing labels to add them to the cell, or uncheck them to remove them.
3. To create a new label, type its name and click **+ Create "..."** (or press Enter). The label is created and selected right away.
4. **Clear** removes all the labels from the cell.

Here too, **✎ Edit labels** opens the label editor for renaming, reordering and deleting (without colors). A dropdown label name can be up to 100 characters.

## The tags column

Tags belong to the whole account, not to one board. A tag created on the "Clients" board is also available on the "Projects" board, so you can search and filter by it everywhere.

1. Click a cell in the tags column.
2. Type in the **Search or add a tag** field. Matching existing tags appear in the list.
3. If the tag doesn't exist, click **Add tag "\#..."**.
4. Tags show in the cell in their color with a \# sign. To remove a tag, open the cell and click the X next to the tag in the panel.

![An open tags cell with search and the option to add a new tag](images/status-dropdown-tags-2.webp)

## Which type should you pick?

| You need... | Pick |
| --- | --- |
| One clear state for each item, with colors and a "Done" label | **Status** |
| Several values from a closed list that belongs to the board | **Dropdown** |
| A classification shared by several boards in the account | **Tags** |

> **Tip:** Picked a type and then found out you need another? You can convert a status to a dropdown and back without losing labels, and also convert free text to a status. The platform creates the missing labels by itself.

## Frequently asked questions

**How many labels can a status column have?**\
Up to 40 labels per column.

**Can I change the color of a label that's already in use?**\
Yes. Changing the color in the label editor updates every item that uses the label right away.

**I pasted text from Excel into a status column. What happens?**\
The platform matches the text to a label by its name. To turn a whole text column into a status, use column type conversion.

## See also

- Adding and managing columns
- Converting a column's type
- Conditional coloring
- Advanced conditionss: conditions, condition groups and connections
- Numbers, rating, progress tracking, checkbox and vote
