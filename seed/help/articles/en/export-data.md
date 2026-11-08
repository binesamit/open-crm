---
title: "Exporting a board to Excel"
slug: export-data
locale: en
translation_of: export-data
category: "import-export-archive-and-trash"
tags: ["import-export", "boards"]
visibility: public
excerpt: "How to export a board, a filtered view or selected items to an Excel or CSV file, subitems included."
publish: true
---
Sometimes you need the data outside the system: to send a report to a client, to crunch numbers in Excel, or to keep a copy on the side. Exporting creates an Excel or CSV file from exactly what you see in the view: the same filter, the same sort and the same columns, in the same order. That way you can prepare a focused file without cleaning it up afterwards.

## What you'll learn

- How to export the board's current view to Excel or CSV
- How to export subitems as well
- How to export only the items you selected
- How to set up a view that matches exactly the file you need

## Exporting the board

1. Open the board and the view you want to export.
2. In the board header, click **⋯** (**More actions**).
3. Hover over **Export**. A reminder appears at the top of the submenu: **What the view shows — filter, sort and columns**.
4. Choose the format:

   - **Export to Excel**: an ‎.xlsx file.
   - **Export to Excel with subitems**: appears when the board has subitems.
   - **Export to CSV**: a text file that opens in any program.
5. The file downloads to your computer, and the message **Downloaded** appears.

![The Export menu in the board header with Excel and CSV options](images/export-data-1.webp)

## What goes into the file

- **Rows:** only the items shown in the view. If you turned on a filter or a search, only their results.
- **Order:** the view's sort.
- **Columns:** **Name**, **Group**, and then the columns visible in the view, in the order they appear. Columns you hid aren't included.
- **Subitems:** in the export with subitems, each subitem gets its own row under its parent item, with the arrow ↳ before its name. The subitems' columns are added at the end with the prefix "Sub:", for example "Sub: Owner".

> **Tip:** Want a focused file, say only this month's open deals with four columns? Create a view with the right filter and columns, and export from it. Next time the file is ready in two clicks.

## Exporting selected items

1. Tick the items you want in the checkboxes at the start of each row.
2. In the action bar that opens at the bottom of the screen, click **Export to Excel**.
3. An Excel file downloads with only the items you selected.

![The action bar for selected items with the Export to Excel button](images/export-data-2.webp)

## Excel or CSV?

| Format | When to choose it |
| --- | --- |
| **Excel** | For working in Excel or Google Sheets, for reports, and for exports with subitems. |
| **CSV** | For moving data to another system that accepts CSV, or when you need a plain text file. |

## More exports in account management

Account admins can also export CSV files from the admin center: the user list (in **Users**), the audit log (in **Audit log**), and the run details of scheduled cleanup.

## Frequently asked questions

**The export has fewer items than the board. Why?**\
The export includes only what the view shows. Check whether a filter, a search or a filtered view is active.

**Can I export the items' updates and files?**\
The export includes the column values. Updates and files stay on the item card.

**Can I import the file back after editing it?**\
Yes. Edit the file and import it with import and edit, matching existing items by name, so the items are updated instead of duplicated.

## See also

- Importing data from Excel and CSV
- Working with views
- Search, filter, sort and group on a board
- Multi-select and actions on several items
