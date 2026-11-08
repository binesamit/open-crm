# Import and export

Hebrew version: [import-export.he.md](import-export.he.md)

## What it's for

Bring data in from Excel or CSV files, edit a whole board like a spreadsheet, and take your data out again. You can
download a single board or view, or the whole account as one file.

## Import from Excel or CSV

Imports go through the "Import and edit" sheet. Nothing is written to the board until you press "Finish" and approve.

Who can import: board owners and admins who may edit the board's items. The sheet needs a computer screen; it isn't
offered on phones.

### Open the sheet

1. Open the board and press its ⋯ menu ("More actions").
2. Choose "Import".
3. Choose "Choose a file to import" (an Excel .xlsx or CSV file, or drop it here). Or choose "Edit in a sheet (no
   file)" to edit the board's items as a spreadsheet.

The sheet starts with what the current view shows. To work on fewer items, filter the view before opening it.

### Map the file's columns

After you pick a file, "Import from a file" opens:

1. If the file has several sheets, pick the "Sheet".
2. Leave "The first row is headers" ticked if the first row holds column names.
3. Under "File columns", check where each file column goes ("Board column"). Bines OS matches them by name and by
   the kind of values. For each one you can:
   - pick another board column,
   - choose "New column…" and give it a "New column type" and "New column name",
   - or choose "Do not import".
4. Under "Match existing items by", choose a column to match rows to items you already have. A file row whose
   value in that column equals an item updates it; the rest are added as new rows. An empty file cell does not clear
   a value. Choose "No matching — every row is new" to add everything as new items.
5. Check the "Preview" and the summary ("… items will be updated · … new rows").
6. Press "Put in the sheet".

### Check and write

1. The file is now in the sheet. Look it over. You can type in cells, paste from Excel (also below the last row) and
   drop more files on the sheet. Delete clears a cell, and Ctrl+Z steps back in the sheet.
2. Press "Finish".
3. "Review before writing" lists what will happen:
   - how many items are updated, how many are new, and how many cells change,
   - "New values": labels that don't exist in a column yet. Choose which to add as new labels. A value you don't add
     leaves its cells empty.
   - "New tags": tags that don't exist in the account yet.
   - "Values that could not be read": invalid dates, numbers, emails and so on. Press "Fix" to go back to the cell.
   - "People not found": they won't be assigned. People with an email address can be invited ("Invite as") or
     skipped ("Skip").
   - New columns that will be created on the board.
4. Press "Approve and write". A message confirms how many items were updated and added.

The whole import is one action. "Undo" in the message, Ctrl+Z within a minute, or "Undo" in the board's activity log
takes it all back, including new columns.

If you close the sheet before finishing, you are asked "Leave without saving?". The changes are lost.

### Subitems

When the board has subitems, the sheet has an "Items" tab and a "Subitems" tab. On the subitems tab, the "Parent
item" column says which item each subitem belongs to, by the item's name. If two items share a name, rename one so
it is clear which.

### Good to know

- Files up to 20 MB. Up to 10,000 rows in the sheet, and up to 50 new columns in one import.
- One write can hold up to 5 MB of data. Split a bigger file into parts.
- Computed columns (formulas, mirrors and so on) are not written by an import. The sheet marks them.
- Secret columns are write-only: existing values are not shown, and new values are stored encrypted. Cells that
  already hold a secret stay as they are unless you choose "Replace existing values". A replaced secret does not come
  back with undo.

## Export a board or a view

1. Open the board and the view you want. The export follows what the view shows: its filter, search, sort and visible
   columns.
2. Open the board's ⋯ menu and choose "Export".
3. Choose "Export to Excel", "Export to Excel with subitems" (when the board has subitems) or "Export to CSV".

The file downloads at once. An export holds up to 10,000 items.

### Export only some items

Select the items with their check boxes. In the bar that appears, choose "Export to Excel".

## Other exports

- A doc: "Export" > "PDF (print)", "Markdown" or "HTML". See [Docs and forms](docs-and-forms.md).
- An item's time log: "Export CSV". See [Time tracking](time-tracking.md).
- The users list (admins): "Administration" > "Users" > "Export CSV".

## Export all the account's data (backup)

Admins can download everything in the account as one ZIP file.

1. Open "Administration" > "General".
2. In "Your data", press "Export all data".
3. The export is prepared in the background. You can close the page; you get an email when it is ready.
4. Press "Download". Downloading requires signing in.

The ZIP holds:

- every board as an Excel file (items and subitems, with updates on a second sheet),
- every doc as Markdown and HTML,
- the files, by board and item,
- the list of users and their roles.

The download link stays valid for a number of days (seven unless your installation sets otherwise). Private items you
have no access to are left out and listed in the README file inside the ZIP. To make a fresh copy later, press "Export
again".

## Copy a board setup to another account

Admins can save boards as a pack: "Administration" > "Extensions" > "Save as a pack". A pack holds boards as templates,
without items, and optionally their automations ("Include the boards' automations (they load switched off)"). Press
"Download the pack", then import it into another account from "Add an extension". See [Extensions](extensions.md).

## Related

- [Boards, groups and items](boards-groups-items.md)
- [Columns](columns.md)
- [Views](views.md)
- [Search, filter, sort and group](search-filter-sort-group.md)
- [Docs and forms](docs-and-forms.md)
- [Time tracking](time-tracking.md)
- [Extensions](extensions.md)
- [Account administration](account-admin.md)
