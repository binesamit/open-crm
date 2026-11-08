# Columns

Hebrew version: [columns.he.md](columns.he.md)

## What it's for

Columns hold the information you keep about every item: who is in charge, the status, a due date, an amount, files and
more. Each column has a type, and the type decides what the cell looks like, how you fill it in, how it is filtered,
sorted and summed, and what automations can do with it. Pick the type that matches the information and Bines OS does
the rest.

A board can have up to 500 columns, of which up to 60 can be "Connect boards" columns.

## Add a column

1. Click the "+" at the end of the column header row ("Add column").
2. Type in "Search column type" to narrow the list, or scroll through the tiles.
3. Click a type. The column is added with the type's name as its title; rename it right away (see below).

To add a column at a specific place, open the menu of a neighbouring column header and choose "Add column to the left"
or "Add column to the right", then pick the type.

Many settings that need a column (a view, a form, a document, a button) also offer "New … column" at the bottom of
their column list, so you can create the column without leaving the setting.

Tip: you need permission to change the board's structure to add columns. If you don't see the "+", ask a board owner.

## Rename, describe and resize a column

- Rename: open the column header menu and choose "Rename" (or press F2).
- Description: in "Column settings" fill in "Description" ("What this column is for and how to fill it in"). People see
  it from the column header.
- Width: drag the edge of the header. Widths are personal; choose "My width for everyone" in the column menu to make
  yours the board's default.
- Copy the column's id (for formulas, the API or integrations): "Copy column ID".

## Change a column's settings

1. Open the column header menu.
2. Choose "Column settings". Only types that have settings show this entry.
3. Change what you need and click "Save".

The settings of each type are described in the list of column types below.

## Change a column's type

You can turn a column into another type without losing the data you already have.

1. Open the column header menu and choose "Change column type".
2. Under "Convert to which type?" pick the new type.
3. Review the preview: how many cells will convert, how many are empty, and how many will fail, with
   "Examples: before → after" and "What else is affected" (formulas, automations and other settings that use the column).
4. When converting to a status or dropdown, you can recolour the new labels or remove ones you don't want.
5. Click "Convert".

Values that do not read as the new type leave the cell empty; the original value is kept in a backup and marked on the
board ("Original value: … — click to copy"). On a large board the conversion runs in the background with a progress
bar, and the column is locked until it finishes.

To go back, open the column menu and choose "Type change history". From there you can "Undo" or "Restore from backup"
while the backup is kept. The name column's type can't be changed.

## Delete a column

1. Open the column header menu and choose "Delete column".
2. Confirm. The column goes to the trash and can be restored from there within 30 days.

The name column can't be deleted. A column that is used to build the item name must first be removed from the name
source.

## Group summaries (the footer row)

Under each group a summary row shows a calculation per column: a sum or average for numbers, a coloured distribution
for status columns, earliest / latest / date range for dates, how many are checked or filled, and so on.

To change a column's calculation, click its summary cell and pick another one ("sum", "average", "median", "min", "max",
"count", "distribution", "checked", "filled", "earliest", "latest", "date range" or "none").

## Restrict who can see or edit a column

A board owner can restrict a column so that only some people may edit it ("Restricted editing") or even see it
("Restricted viewing"): board header > "Permissions" > "Restricted columns". See
[Sharing and permissions](sharing-and-permissions.md).

## The column types

### Basic types

- Name: the item's name, the first column of every board. It can't be deleted. Clicking it opens the item card.
  The name can also be built automatically from other columns (see "Build item names from columns" below).
- Text: one line of text (up to 2,000 characters). Links in it are clickable. While you type, values that already exist
  in the column are suggested.
- Long text: several lines (up to 20,000 characters), edited in a pop-up.
- Numbers: a number. In "Column settings" choose the "Number format" (plain, currency, percent or a custom unit of up to
  8 characters), the "Symbol position", the "Decimal places" and the "Thousands separator (1,000)".
- Status: one coloured label per item, such as Working on it / Done / Stuck. Click the cell and choose "Edit labels" to
  add, rename, recolour, reorder and delete labels (up to 40). Mark one label as the "Done" label: it drives deadline
  colouring, progress and "done" filters. A label that is in use is turned off instead of being deleted.
- Dropdown: one or more labels without colour. Type a new value and press Enter to create a label.
- Date: a date, optionally with a time. Settings: "Include time" (shown in each viewer's time zone), "Show the weekday",
  "Hide the current year", "Hebrew date" (a second line with the Hebrew date) and "Mark days off in the picker".
- Timeline: a start and end date shown as a bar. Settings: "Include hours", "Show the duration in the cell and on the
  bar", "Count the duration in" (for example working days), "Keep the working days when moving", and "Red when the
  timeline is overdue" with an optional "Linked status column" whose done labels stop the red.
- People: members, guests or teams assigned to the item. Assigned people are notified. This is the column that decides
  who is "assigned" for permissions such as "Edit only items assigned to them".
- Email: an email address; clicking it starts an email.
- Phone: a phone number with its country (see "Phone actions and SMS" below).
- Link: a web address (http or https) with optional display text.
- Checkbox: checked or not.
- Files: one or more files per cell. Upload from your computer, paste a screenshot, add a link, or pick from the
  gallery. Setting: "Show images as small previews in the cell". Removing a file sends it to the trash. See
  [Item card and collaboration](item-card-and-collaboration.md) for file versions.

### Useful extras

- Rating: stars from 1 up to a maximum.
- Tags: account-wide tags; type to "Search or add a tag".
- Vote: each person can "Vote" once or "Take back my vote"; the cell shows the count and who voted.
- Doc: a document inside the item's cell, opened in a side panel. Setting: "Template for new docs" (each new doc starts
  as a copy of the chosen doc). See [Docs and forms](docs-and-forms.md).
- Time tracking: a timer and a log of time entries per item. See [Time tracking](time-tracking.md).
- Hour: a time of day. Setting: "Time format".
- Week: a week of the year, seven days from the "First day of the week" (by default the account setting).
- World clock: shows the current time in a chosen time zone, with optional "Working days" and "Working hours (in that
  zone)".
- Color picker: a colour. Setting: "Colour format".
- Country: a country with its flag.
- Location: an address. Bines OS locates it on the map (shown as "Locating…" until found) so it can appear in the map
  view. An admin can add a "Google Maps key (optional)" in the map settings for address completion through Google;
  without it a free service is used.
- AI: a cell the AI fills from other columns of the item. See "AI column" below and [AI](ai.md).

### Connections and computed columns

- Connect boards: links items to items on another board (or the same board). See below.
- Mirror: shows a column of the connected items. See below.
- Dependency: the items on the same board that this item depends on. Settings: "Date column that moves" and "When a
  previous item moves": "Shift the same", "Shift only on overlap" or "Arrows only". For each dependency you can set the
  "Dependency kind" (FS = finish-to-start is the default) and a "Lag in days (minus = overlap)". Dependencies show as
  arrows in the Gantt view.
- Formula: a calculation from other columns. See below.
- Progress tracking: the percent of an item's work that is done. See below.
- Item ID: a number per item. Settings: "Prefix (optional)" (English letters, digits and a hyphen, up to 10
  characters, for example BT-0042), "Minimum digits" and "Next number" (to continue numbering from a previous system).
  The number never changes when the item moves between groups.
- Creation log: who created the item and when. Setting "Show" (person, date or both) and "Show the time too". An item
  that came from a form shows the form.
- Last updated: the last change to the item. Setting "Updates when changed" lets you count only changes in chosen
  columns ("Any column" by default).
- Button: a button in every row. See below.

### Advanced

- Secret: a password or key kept on an item, encrypted on the server. See below.
- Signature: who signed an interactive document of the item, and when. It is filled only by the signing flow and opens
  a signing certificate. See [Interactive documents](interactive-documents.md).

## Connect boards

What it's for: link a deal to its client, a task to its project, an order to its products.

1. Add a "Connect boards" column.
2. In "Column settings" > "Boards to connect" choose one or more boards.
3. Optional: "Allow multiple items", "Order of items when picking" ("By board and group", "By board" or "One list"),
   and "Max characters per item in the cell".
4. Click a cell to pick items. The list opens without typing; type to search ("Showing the first 30 — type to search").
   If nothing matches, "Create "…"" makes a new item in the other board and links it.

### Offer only some items

Under "Offer only items that…" choose "All items", "By view" (a shared view of the other board) or "By filter". You can
add a "Text above the list", "Show only matching items in the cell", and "Apply the filter in the API and to agents
too". An item that is already linked and stops matching stays linked and is marked ⚠.

### Two-way connection

When the column connects to a single board, you can turn on "Two-way connection" so a link made on one side also shows
on the other board.

1. In "Column settings" click "Turn on two-way".
2. Choose "New column" (and its name on the other board) or "Existing column" (a connect column there that links back
   to this board).
3. Save. "Existing links on both sides will show on the other side too."

While two-way, the linked board is fixed. Turning it off keeps both columns and their links, one-way.

## Mirror

What it's for: show the client's phone on the deal, or the total hours of a project's tasks, without copying data.

1. Add a "Mirror" column.
2. In "Column settings" choose "Through connection column" (a Connect boards column, or "Subitems").
3. Choose the "Column to show" from the connected board.
4. When several items are linked, choose the "Summary" (for numbers: sum, average, median, min, max, count; for status:
   distribution or percent done; for dates: earliest, latest or range).
5. For status and dropdown columns, "Show as": "Text", "Coloured labels" or "Colour bar".

When the connection holds a single item you can edit the mirrored value in place, and it changes in the source item
(with your permissions there). A mirror can show another mirror up to two levels deep.

## Formula

What it's for: calculate a value from other columns, such as price × quantity, days left, or a traffic-light status.

1. Add a "Formula" column and open "Column settings".
2. Write the formula. Refer to columns by name in braces, for example `IF({Status}="Done",1,0)`. Type `{` to pick a
   column or a function from "Columns and functions".
3. The side panel lists every function by category ("Logic", "Numbers", "Text", "Dates"), with "Search functions". Each
   one shows its syntax and an example.
4. Check the "Preview", then save.

Optional settings: "Number result format" (unit, currency, decimals, thousands separator; also used in the summary row,
mirrors and exports) and "Show as link" (a result that is a web address becomes a clickable link).

Functions available: IF, AND, OR, NOT, SWITCH, IFERROR, ISBLANK, SUM, AVERAGE, MIN, MAX, COUNT, ROUND, ROUNDUP,
ROUNDDOWN, ABS, MOD, DIVIDE, MULTIPLY, MINUS, POWER, SQRT, VALUE, CONCATENATE, LEN, LEFT, RIGHT, TRIM, UPPER, LOWER,
REPLACE, SUBSTITUTE, SEARCH, REPT, TEXT, TODAY, NOW, DATE, DAYS, WORKDAYS, ADD_WORKDAYS, HOURS_DIFF, ADD_DAYS,
SUBTRACT_DAYS, FORMAT_DATE, YEAR, MONTH, DAY, WEEKNUM, HOUR, MINUTE.

Tips:

- Inside quotes, `{Column}` is plain text, not the column's value. Write it without quotes to get the value.
- TODAY() uses the account's time zone.
- Formula results are stored, so you can filter, sort and use them in automation conditions.
- A formula can't refer to Files, Tags, Location, Week, Color picker, Progress, Button or Doc columns.

## Progress tracking

What it's for: a progress bar per item that fills as its steps are done.

1. Add a "Progress tracking" column and open "Column settings".
2. Under "Compute from" choose:
   - "Status columns of the item": tick the columns that count as steps, choose the "Labels that count as done" for each,
     and set a "Weight" for each step.
   - "Subitems": choose "The subitems' status column" and its done labels. Optionally "Weight of each subitem" (by a
     numbers column, for example hours) and "Include sub-subitems".
   - Both, with a "Weight of the subitems against the status columns".
3. Optional: "Hide the percentage next to the bar".

If something is missing, the form lists it under "For the column to work, it still needs:".

## Button

What it's for: one click in a row to run an action.

1. Add a "Button" column and open "Column settings".
2. Set the "Button text" and "Colour", and optionally "Ask for confirmation first".
3. Under "What the button does" choose:
   - "Runs an automation": each click runs the board's automations with the trigger "When a button is clicked". Create
     one in the automation center. See [Automations](automations.md).
   - "Opens a link": a web address that can include the item's values, such as `{item.name}`, `{item.id}` or
     `{item.<column id>}`.
   - "Sets values": "Values to write" into columns, typed as you would paste them (a label name, a date, a person's
     name, a number). One click is one undo.
   - "Opens a popup": creates a linked item on another board (see next section).
4. Save.

To click a button you need permission to edit the item and the column.

### Create a linked item from a button ("Opens a popup")

What it's for: from a client, open a small form that creates a job on the jobs board, already linked and pre-filled.

1. Choose "Opens a popup" under "What the button does".
2. "The new item's board": pick the board.
3. "Linked through the column": pick the Connect boards column that links the two boards (on either board). If there is
   none, add a Connect boards column first.
4. "Copy from the item to the new item": map "From column" to "To column". Values are copied when the item is created
   and can be changed in the popup.
5. "Fixed values for the new item": values every new item gets.
6. "The popup": the other board's columns the popup asks for. With none, the item is created at once.
7. "If a linked item already exists": optionally "Open it in the popup instead of creating another".
8. "After saving": "Open the card" or "A message with "Open"".

## Phone actions and SMS

Clicking a phone number can open a small menu ("Phone number actions") with "WhatsApp", "Telegram", "Call", "SMS" and
"Copy".

In "Column settings" of a phone column:

- "Action menu when clicking a number": off makes the number a plain call link.
- "Actions shown": which actions appear and in what order.
- "Default action": what a long press or Ctrl+click does.
- "Default country": for numbers typed without a country code (by default the account's setting).
- "Telegram username column": a text column with the @username; without it Telegram opens by the number.

"Send SMS" sends a message from the system (free text or a template) and saves it as an update on the item. It works
only when an admin has set up an SMS provider for the account, and the account may limit it to admins or members and
cap how many messages are sent per hour or day. Guests can't send SMS. "SMS from my device" opens your phone's own
messaging app instead.

## Secret column

What it's for: keep client logins, passwords and keys on the item, hidden from view.

- The value is stored encrypted and is never shown in the cell. Click the eye ("Show the secret") to see it for a few
  seconds, or "Copy" it (the clipboard is emptied after the show time).
- Seeing a secret needs two-factor authentication: you enter a code from your authenticator app. If two-factor is off,
  the cell asks you to "Turn on two-factor authentication" in your profile.
- Settings (changing them needs a verification code): "Who may reveal" ("Everyone who sees the column" or "Only some
  people"), "Show for (seconds)", "Verification valid for", "Allow copying", "Alert admins after (reveals per person per
  hour)", whether replacing or deleting a value needs a code, and the "Value type": "Text", "Long text" or "Check box".
- "Secrets log" shows who revealed, copied or changed a secret and when. Values are never logged.

This is protection inside the system, not an end-to-end encrypted vault: whoever runs the server could in principle
reach the values.

## AI column

What it's for: let AI fill a cell for every item, such as a summary, a category, an extracted detail or a translation.

1. Add an "AI" column (available when the account's plan includes AI; otherwise the tile is shown disabled).
2. In "Column settings" choose "What the column does": "Summarize", "Classify", "Extract", "Translate" or "Custom
   prompt".
3. Choose "What the AI reads" (columns of the item, the "Item name", "The item's latest updates"). You can also name
   columns in the prompt in braces, such as `{Status}`.
4. Choose the "AI connection" and "Model". If the account has no AI connection yet, an admin adds one in the settings.
5. Optional: "Run by itself when its input columns change", limits ("Items per run", "Max $ per run", "Max $ per
   month"), and for "Classify" "Also write the label to" a status or dropdown column.
6. Use "Run on empty cells" or "Run on all cells".

Each cell shows that it was "AI generated" with the model and cost. You can "Edit by hand", "Run again" or "Clear". More
in [AI](ai.md).

## Build item names from columns

What it's for: names that are always consistent, such as "Client – Date", built for you.

1. Open the menu of the name column header and choose "Item name source".
2. Under "How items are named" choose "Free text" (people type the name), "From a column" (one column's value) or
   "Template" (columns and text, for example `{Client} – {Date}`).
3. Optional: "Text when empty", "Warn when two items get the same name", and "Open the item card after creating it".
4. Check the "Preview" and click "Save". Existing names update ("Updating names… n of m").

Computed names update by themselves when the source columns change, including connected items on other boards. Going
back to "Free text" keeps the current names as plain, editable text. For subitems, open the menu of their own name
column.

## Related

- [Boards, groups and items](boards-groups-items.md)
- [Views](views.md)
- [Search, filter, sort and group](search-filter-sort-group.md)
- [Automations](automations.md)
- [Item templates](item-templates.md)
- [Time tracking](time-tracking.md)
- [AI](ai.md)
- [Interactive documents](interactive-documents.md)
- [Sharing and permissions](sharing-and-permissions.md)
- [Import and export](import-export.md)
