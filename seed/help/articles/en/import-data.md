---
title: "Importing data from Excel and CSV"
slug: import-data
locale: en
translation_of: import-data
category: "import-export-archive-and-trash"
tags: ["import-export", "boards"]
visibility: public
excerpt: "How to import an Excel or CSV file into a board: match columns, update existing items, add new rows and check everything before it's written."
publish: true
---
Have a client list in Excel, an inventory table exported from another system or a CSV file you got from a supplier? You can bring it into a board in a few minutes. The import goes through the **Import and edit** screen, a sheet where you see the data before it's written, so you can match columns, update items that already exist, fix problem values and approve only when everything looks right.

## What you'll learn

- Which files you can import and how to open the import
- How to match each column in the file to a column on the board, or create a new column
- How to update existing items instead of creating duplicates
- What to check on the review screen before writing
- How to undo an import

## Before you start

- You can import an **Excel (.xlsx)** or **CSV** file (also .tsv and .txt), up to 20MB.
- A CSV file saved in Excel in Hebrew is read correctly without any special conversion.
- Importing is available on a computer, to anyone allowed to edit items on the board.
- One import and edit can work with up to 10,000 rows. For a larger file, split it into several parts.

## Opening the import

1. Go to the board you want to import into.
2. In the board header, click **⋯** (**More actions**) and choose **Import**.
3. In the sheet that opens, click **Import file** and pick the file. You can also just drag the file onto the sheet and drop it.

![The import and edit screen with the Import file button and a file dragged onto the sheet](images/import-data-1.webp)

## Matching the columns

The **Import from a file** window opens:

1. If the Excel file has several sheets, pick the right one under **Sheet**.
2. Make sure **The first row is headers** is checked, if the first row has the column names.
3. The **File columns** section shows each column from the file, and next to it the **Board column** it goes into. The platform has already matched by name and by the type of values, and you can change it:

   - Pick a different column on the board.
   - Pick **Do not import**: the column is skipped.
   - Pick **New column…**, then set the **New column type** and **New column name**. Such a column is marked **new** and is created on the board at the end of the process.

![The Import from a file window with the column mapping and a preview](images/import-data-2.webp)

> **Tip:** Import values such as "New", "In progress" and "Done" into a status column. Values that don't have a label yet are offered as new labels on the review screen.

## Updating existing items

So that importing again doesn't create duplicates, choose **Match existing items by**, for example the item name, a client number or an email.

- A row in the file whose value in that column is the same as an existing item updates that item.
- The other rows are added as new items.
- An empty cell in the file doesn't delete an existing value.

If all the rows are new, leave it on **No matching — every row is new**.

## Preview and putting it in the sheet

In the **Preview** section you see the first rows exactly as they'll go in, with a summary above them: how many items will be updated and how many new rows will be added. Values that won't go in (for example into computed columns such as a formula) are listed separately.

1. Click **Put in the sheet**.
2. The data appears in the import and edit sheet. Here you can still fix, type or paste values.
3. When everything is ready, click **Finish**.

> **Note:** Nothing is written to the board until you click **Finish** and approve.

## Review before writing

Before writing, the **Review before writing** screen appears. It shows how many **items updated** and how many **new items** will be created, and asks for a decision on anything unclear:

| Section | What to do |
| --- | --- |
| **New values** | Values that don't exist yet in a status or dropdown column. Decide whether to add them as a new label, and in which color. |
| **New tags** | Tags that don't exist yet in the account. Decide whether to add them. |
| **Values that could not be read** | An invalid date, number or email. Click **Fix** to go back to the cell in the sheet. |
| **People not found** | Names that weren't recognized as users. You can **Skip** them, or invite anyone who has an email address. |

This screen also shows the **new columns to create on the board**. To go back and fix things, click **Back to the sheet**; when everything is right, click **Approve and write**.

## Undoing an import

The whole import is saved as a single action. If something went wrong, you can undo all of it from the board's activity log.

## Frequently asked questions

**Can I import directly from Google Sheets?**\
Download the sheet as an Excel or CSV file and import it. You can also copy a range of cells and paste it straight into the import and edit sheet.

**I got a message that the file is too large. What do I do?**\
Split the file into several smaller files and import them one after another.

**Why didn't a column from the file come in?**\
It may be set to **Do not import**, or it may point to a computed column. Check the mapping in the import window.

## See also

- Import and edit in a sheet
- Exporting a board to Excel
- Adding and managing columns
- Undo and the activity log
- Creating your first board
