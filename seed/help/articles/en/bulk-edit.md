---
title: "Import and edit in a sheet"
slug: bulk-edit
locale: en
translation_of: bulk-edit
category: "boards-groups-and-items"
tags: ["items", "boards", "import-export", "subitems"]
visibility: public
excerpt: "How to open a board as a sheet, type and paste from Excel, import a file, check the summary and save all the changes at once."
publish: true
---
**Import and edit** opens the board as a spreadsheet: every item is a row, every column is a column, and you can type, paste a whole block from Excel or import a file. Nothing is written to the board while you work. Only when you click **Finish** do you get a clear summary of what is about to change, and only after you approve is everything saved at once. It's the right tool for updating a price list, loading a customer list or fixing dozens of cells in one go.

## What you'll learn

- Opening import and edit and working in the sheet
- Pasting data from Excel and adding new rows
- Importing an Excel or CSV file into the sheet
- Reading the summary before writing, and approving it
- Undoing an import and edit that was already saved

> **Note:** Import and edit is available to board owners and account admins, on a computer only.

## Opening the sheet

1. Open the board and choose the view you want to edit. The sheet shows the items and columns of the current view, including its filters.
2. In the board header, click **⋯** (**More actions**).
3. Choose **Import**.

The top of the window shows the board name, the number of rows and the reminder **Changes are written to the board only on "Finish"**.

![The import and edit sheet with the board's columns and edited cells](images/bulk-edit-1.webp)

> **Tip:** To edit only part of the board, for example the items of one group or in a certain status, filter the view before you open the sheet.

## Working in the sheet

- **Edit a cell:** click a cell and start typing, or press Enter or F2 to open it for editing. Enter saves and moves down to the next cell.
- **Navigate:** arrows and Tab, as in any spreadsheet.
- **Clear:** the Delete key clears the selected cells.
- **Undo a step:** Ctrl+Z undoes the last step in the sheet, and Ctrl+Y redoes it. All of this happens before anything is written to the board.
- **New rows:** type or paste below the last row and a new row is created. The **Group (new rows)** column sets which group it goes into.

Edited cells are marked. The bottom of the window shows how many cells changed and how many new rows were added.

Computed columns, such as formula, mirror or progress tracking, are shown in the sheet but frozen for editing. Hovering over them shows **Computed column — frozen in import and edit**.

**Values in the sheet are written as text:** in a status column you type the label name, in a people column the name or email address, and in a date column the date itself. A cell whose value can't be understood, for example "abc" in a numbers column, is marked as invalid. A new value that doesn't exist yet as a label in the column is marked too, and will appear in the summary.

## Pasting from Excel

1. Copy a table from Excel or Google Sheets.
2. In the sheet, click the cell where the table's top corner should go.
3. Press Ctrl+V. The block spreads across the cells, and rows that go past the end of the sheet are added as new rows.

If part of the block lands on frozen columns, those cells are not pasted, and a message tells you how many cells were skipped.

## Importing a file

1. Click **Import file** at the bottom of the window, or just drag an Excel (.xlsx) or CSV file onto the sheet.
2. If the file has several sheets, choose the right **Sheet**. Tick **The first row is headers** if that's the case.
3. Under **File columns**, set the **Board column** each file column goes into. The system suggests a match by name and type. You can also choose **Do not import**, or **New column…** with a type and a name.
4. In **Match existing items by**, choose a column, for example name or email. A row in the file whose value matches an item in the sheet updates that item, and the other rows are added as new. You can also choose **No matching — every row is new**.
5. Check the **Preview** and click **Put in the sheet**.

The data goes into the sheet as a draft. Check it and click **Finish**, as with any other edit. An empty cell in the file doesn't delete an existing value.

> **Note:** You can import a file of up to 20MB, and a single sheet can hold up to 10,000 rows. For a bigger file, split it or filter the view before opening.

## The summary before writing

When you click **Finish**, the **Review before writing** screen opens. It shows:

| Part of the summary | What you do there |
| --- | --- |
| **items updated** / **new items** / **cells** | Numbers for a quick check |
| **New values** | Labels that don't exist in the column yet. Decide whether to add each one, and you can pick a color for it. A value that isn't added won't be written |
| **New tags** | Tags that don't exist in the account yet. Decide whether to add them |
| **Values that could not be read** | Dates, numbers, emails and other values that aren't valid. **Fix** takes you back to the cell in the sheet |
| **People not found** | Names that weren't recognized. You can **Skip** them, and anyone listed with an email address can be invited to the account |
| New columns | Columns the import will create on the board |

![The review-before-writing screen with new values and update counts](images/bulk-edit-2.webp)

Click **Back to the sheet** to keep fixing, or **Approve and write** to save. When it's done you'll see a message like **Import saved: 12 updated, 3 added**.

## The "Subitems" tab

On a board that has subitems, the sheet has two tabs: **Items** and **Subitems**. The subitems tab shows the subitem columns, plus an extra column, **Parent item**, where you write the name of the item each row belongs to. You can also write the name of a new item you added in the items tab. Both tabs are saved together with the same **Finish**.

## Leaving and undoing

- **Leave without saving:** closing the window with open changes asks **Leave without saving?**. **Leave without saving** deletes the draft, and nothing is written to the board.
- **Undo after saving:** the whole import and edit is saved as a single action. Ctrl+Z within a minute, or **Undo** on the matching row in the board's **Activity log**, reverts everything, including deleting the new rows.

## Frequently asked questions

**What's the difference between import and edit and importing from Excel into a board?**\
Import and edit works on an existing board: you can update existing items and add new ones, and see everything before saving. To create a brand-new board from a file, use data import.

**Someone changed the board while I was working in the sheet. What happens?**\
The system checks again before writing. If a column changed in the meantime, the summary is updated and you're asked to approve again.

**Why don't I see "Import" in the menu?**\
It appears for board owners and account admins, on a computer only, and not on an archived board.

## See also

- Multi-select and actions on several items
- Importing data from Excel and CSV
- Exporting a board to Excel
- Undo and the activity log
- Subitems and nesting levels
