---
title: "Changing a column's type"
slug: column-conversion
locale: en
translation_of: column-conversion
category: "columns"
tags: ["columns", "boards", "import-export"]
visibility: public
excerpt: "How to change the type of an existing column, for example from text to numbers or status, with a preview, a full backup of the values, undo and restore."
publish: true
---
Sometimes, after the board is already full, you discover a column was built with the wrong type: amounts were saved as text so they can't be summed, or statuses were typed by hand instead of picked from a list. **Change column type** fixes this without losing information. Before converting, you see an exact preview of what will happen to each cell, the original value of every cell is kept in a backup, and you can undo or restore later too.

## What you'll learn

- How to start a conversion and what the preview shows
- Which types can be converted and what happens to values that didn't make it
- What happens to formulas, views and automations that use the column
- How to undo a conversion and restore from the backup

## Who can convert

Changing a column's type is available to **board owners** and **account admins** only, because it affects all the items on the board and everything that depends on the column.

## Converting

1. Open the column menu: hover over the header and click **⋯**, or right-click the header.
2. Choose **Change column type**. The option appears only when the column has supported target types.
3. In the window that opens, under **Convert to which type?**, choose the new type. Only types you can convert to are shown.
4. The system checks all the cells (**Checking what happens to every cell…**) and shows a preview.
5. Go over the preview (details below), and change the options if needed.
6. Click **Convert**. If there are values that won't convert, the button shows how many of them will be kept in the backup, for example **Convert (3 kept in the backup)**.

![Change column type window with counters, before and after examples and new labels](images/column-conversion-1.webp)

## What the preview shows

- **Counters:** how many values **convert**, how many are **empty** and how many **fail**, out of all the items on the board (including the archive and the Trash, so restoring an item doesn't bring back a value of the old type).
- **Examples: before → after** – a few real values from the board and how they'll look after the conversion. A value that only partly makes it is marked **partial**.
- **Will not convert** – examples of values that can't be read as the new type, with the reason (for example **does not read as the new type** or **no person by that name**).
- **New labels to create** (or **New tags to create**) – when converting to status, dropdown or tags, the system creates labels for values that don't have one. Clicking the color changes it, and you can remove a label from the list. In that case its cells won't convert and are kept in the backup.
- **Conversion options**, only when relevant: **Date order** (**day/month/year** or **month/day/year**), **Date to keep** when converting a timeline to a date, **Show** **Names** or **Emails** when converting people to text, **Keep the unit / currency** when converting numbers to text, and the **Rating scale** when converting to a rating.
- **What else is affected** – a list of formulas, mirror columns, views, automations, widgets, forms and more that use the column, and for each one what will happen to it: **keeps working**, **updated**, **worth a check** or **switched off**.

## Which conversions are possible

| From | To | What to know |
| --- | --- | --- |
| Any regular type | **Text** / **Long text** | Always possible. The value is kept as it's displayed |
| Text | **Numbers** | "₪1,250" becomes 1250. Text like "about 5" won't convert |
| Text | **Date** / **Timeline** | Formats like 31/12/2026 or 2026-12-31 |
| Text | **Status** / **Dropdown** / **Tags** | Missing labels are created. In dropdown and tags, comma-separated values become several labels |
| **Status** | **Dropdown** (and back) | The labels carry over as they are. From dropdown to status the first label is kept, and the rest are kept in the backup |
| **Date** | **Timeline** (and back) | From timeline to date you choose which end to keep |
| **Numbers** | **Rating** (and back) | Whole numbers within the scale |
| Text | **People** | By the full name or email of a member of the account |

**You can't convert** the name column, calculated columns (formula, mirror, progress tracking, item ID, creation log, last updated), columns written in their own way (files, time tracking, vote, doc, button, secret), connect boards and dependency, or the AI column. In these cases, add a new column of the type you want.

## After converting

- The message **The column is now ...** appears, with an **Undo** button.
- A cell that didn't convert stays empty and marked. Hovering over the mark shows the **original value**, and clicking it copies it.
- A bar above the table summarizes how many values didn't convert. Click **Show failed in conversion** to see only those items and fix them by hand, and then **Show all**. When you're done, click **Clear the marks**.

![The bar about values that didn't convert, with the buttons to show failed in conversion and clear the marks](images/column-conversion-2.webp)

> **Note:** On especially large boards the conversion runs in the background. The column header shows **Converting…** with the progress percentage, and the column is locked for editing until it finishes. You can keep working on the rest of the board. If the conversion fails halfway, it changes nothing.

## Undo and restore

In the column menu, choose **Type change history**. Each conversion shows who did it and when, the status, the counters and the full **Report**. From there you can:

- **Undo** – within the first seven days. Brings back the previous type, the settings and all the values, including automations that were switched off.
- **Restore from backup** – even after the undo window, as long as the backup is kept. If cells were edited since the conversion, you can choose whether to bring them back to their original value too.

Account admins can set in the same window how long to keep backups (**Keep backups**): **30 days**, **90 days**, **A year** or **forever**.

## Frequently asked questions

**Does the conversion delete values that didn't make it?**\
No. Every original value is kept in the backup, even when the conversion succeeded, and you can copy it from the mark in the cell or restore everything.

**What happens to an automation that uses the column?**\
If it also fits the new type, it keeps working. If not, it's switched off and the owners get a message. Undoing the conversion turns it back on.

## See also

- Adding and managing columns
- Status, dropdown and tags
- Undo and the activity log
- Introduction to automations and templates
- Importing data from Excel and CSV
