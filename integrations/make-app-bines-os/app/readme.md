# Bines OS

Boards, items, subitems, updates, files and AI agents of Bines OS: instant triggers that register their own webhooks, actions and searches with each board's columns.

Connect with your Bines OS address and a personal API token (profile menu → API tokens). The token acts as you, limited to its scopes and boards.

## Instant triggers

- **Watch Items Created** — An item was added to the board.
- **Watch Column Value Changed** — A value of the chosen column changed.
- **Watch Status Changed** — A status column changed — optionally only one column, or only to one label.
- **Watch Any Column Changed** — Any value of the board changed.
- **Watch Items Renamed** — An item got a new name.
- **Watch Updates** — An update (comment) was posted on an item.
- **Watch Items Moved to a Group** — An item moved into the chosen group.
- **Watch Items Moved to Any Group** — An item moved between groups.
- **Watch Archived Items** — An item was archived.
- **Watch Deleted Items** — An item was moved to the trash.
- **Watch Restored Items** — An item came back from the trash or the archive.
- **Watch Items Moved to This Board** — An item moved here from another board.
- **Watch Edited Updates** — An update (comment) on an item was edited.
- **Watch Deleted Updates** — An update (comment) on an item was deleted.
- **Watch Files Added** — A file was added to a files column or an update.
- **Watch Groups Created** — A group was added to the board.
- **Watch Columns Created** — A column was added to the board.
- **Watch Column Type Changed** — A column's type was changed.
- **Watch Subitems Created** — A subitem was added under an item.
- **Watch Subitem Column Changed** — A value of a subitem changed — optionally only one subitem column.
- **Watch Subitem Status Changed** — A status column of a subitem changed — optionally only one column, or only to one label.
- **Watch Subitems Renamed** — A subitem got a new name.
- **Watch Archived Subitems** — A subitem was archived.
- **Watch Deleted Subitems** — A subitem was moved to the trash.
- **Watch Subitem Updates** — An update (comment) was posted on a subitem.
- **Watch "Send to Integrations"** — A Bines OS automation ran its "send to integrations" action (any trigger, any conditions).

## Actions

- **Create an Item** — Creates an item with column values.
- **Update an Item** — Changes an item’s name and column values. Empty fields leave the column unchanged.
- **Get an Item** — Returns an item with its column values.
- **Archive an Item** — Archives an item.
- **Delete an Item** — Moves an item to the trash (restorable for 30 days).
- **Duplicate an Item** — Duplicates an item, optionally with its updates.
- **Move an Item to a Group** — Moves an item to another group of its board.
- **Move an Item to a Board** — Moves an item to another board. Columns are matched by type and title (else the only column of that type), as the move dialog proposes.
- **Create a Subitem** — Creates a subitem under an item, with the sub-board’s column values.
- **Update a Subitem** — Changes a subitem’s name and column values.
- **Move a Subitem** — Moves a subitem (with its own subitems) under another item or subitem of the same board.
- **Archive a Subitem** — Archives a subitem.
- **Delete a Subitem** — Moves a subitem to the trash (restorable for 30 days).
- **Create an Update** — Posts an update (comment) on an item.
- **Reply to an Update** — Replies to an update.
- **Upload a File** — Uploads a file to a files column of an item.
- **Create a Group** — Adds a group to a board.
- **Create an Item From a Template** — A new item with its subitems from one of the board’s item templates — or the template’s subitems under an existing item. One undo for all of it.
- **Move a Subitem Up a Level** — Moves a subitem under its grandparent; a first-level subitem becomes an item of the board.
- **Tick a Check Box of an Update** — Ticks or clears one check box of an update or reply (counted from 1, in the text’s order).
- **Add a Link to a Files Column** — Adds a web link to a files column of an item, beside its files.
- **Start a Timer** — Starts the token owner’s timer on a timer column of an item.
- **Stop a Timer** — Stops the token owner’s timer on a timer column of an item.
- **Log Time** — Logs time by hand on a timer column (at most 24 hours, not in the future).
- **Rename a Group** — Gives a group of a board a new title.
- **Delete a Group** — Deletes a group of a board (its items go to the trash with it).
- **Create a Column** — Adds a column to a board. A title the board already has gets the next free number. Types that need settings (formula, mirror, connected boards) are made with Make an API Call.
- **Run an AI Agent** — Runs an AI agent now with a prompt. The token needs the agents:run scope.
- **Get a Board Schema** — Returns a board’s groups and columns (type, options, value schema).

## Searches

- **Search Items** — Lists a board’s items matching free text and column filters (all pages).
- **Find Items by Column Value** — Finds items by a column value: phone numbers match by digits, emails and text ignore case. Use the column "name" for the item name.
- **Get Subitems of an Item** — Lists the subitems right under an item (or under a subitem), in their order.
- **Search Subitems** — Lists the subitems of a board matching free text and subitem column filters (all pages).
- **Find Subitems by Column Value** — Finds subitems by a value of a subitem column (phone by digits, emails and text ignore case).
- **List Users** — Lists the active members of the account.
- **Get the Time Log of an Item** — Lists an item’s time entries, newest first.
- **Search Everything** — Items (name or values), boards, updates and people matching a text (2+ characters) that the token can see.
- **List Teams** — Lists the account’s teams with their members.
- **List Boards** — Lists the boards the token can open.

## Universal

- **Make an API Call** — Any Bines OS REST call with this connection (see /api/docs on your instance).
