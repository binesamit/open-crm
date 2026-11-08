# The item card and working together

Hebrew version: [item-card-and-collaboration.he.md](item-card-and-collaboration.he.md)

## What it's for

Every item has a card: one place with its fields, its conversation, its files and its history. Your team talks on the item itself instead of in scattered chats and emails, so anyone who opens it later sees the whole story.

## Open an item card

1. On a board, click the item's name (or select the row and press Enter).
2. The card opens beside the board. Press Esc or "Close" to go back; the board keeps its view, filter and search.

Tips:

- To open the item in its own browser tab, use the item's menu (right-click the row, or the ⋯ button) > "Open in new tab", or press Ctrl+Enter.
- To change the card's width, drag its inner edge. Double-click the edge for the default width. The card's ⋯ menu has "Reset card width".
- A linked item from another board opens over the current one, with its own board's fields and permissions.

## The card's tabs

A new board's card has these tabs:

| Tab | What you find there |
| --- | --- |
| "Updates" | The item's conversation. Always first, always shown. |
| "Fields" | The item's columns as a form you can edit, and under them its subitems. |
| "Subitems" | The item's subitems as a small table. |
| "Time" | The time log. Shown only when the board has a time tracking column. |
| "Activity" | Every change made to the item. |
| "Documents" | Interactive documents (quotes, agreements) shared from this item. |

Installed extensions can add their own tabs after these.

### Arrange the tabs (board owners and admins)

1. Open any item on the board and click the gear button "Tab settings" at the end of the tab row.
2. Drag tabs to reorder them ("Updates" is "Always first").
3. Rename a tab, hide it ("Show …" switch), or remove an extra tab.
4. To split a long form, click "Add a fields tab" and choose which columns it shows and in what order. You can add several fields tabs.
5. Under "Fields per row", choose 1, 2, 3 or "Auto". A narrow card shows fewer; a phone always shows one per row.
6. Under "Subitems in the card", choose the "Default view" for the subitems table, whether to show the "Summary row", and whether a "Subitems table in the Fields tab" appears.

The settings apply to every item on that board.

## Write an update

1. Open the card on the "Updates" tab.
2. Click "Write an update…" and type. Use the toolbar for bold, italic, lists and links; "More" holds underline, strikethrough, highlight, headings, a numbered list, a "Checklist", quote, code and a divider.
3. Press Ctrl+Enter or click "Update" to post. Enter starts a new line.

Tips:

- An unfinished update is kept as a "Saved draft" until you post or "Clear" it.
- Paste or drop an image straight into the text.
- A "Checklist" in an update works as a small to-do list: anyone allowed to edit can tick its boxes.

## Mention someone

1. In an update or reply, type `@` and start typing a name.
2. Pick the person from the list.

The person gets a notification ("… mentioned you on …") and sees it in their inbox. AI agents also appear in the list; one that cannot answer here is shown greyed out with the reason (see [AI](ai.md)).

## Reply, react, edit and delete

- To reply: click "Reply" under an update and write in "Write a reply…".
- To react: click "Add reaction" and pick an emoji (Like, Love, Haha, Celebrate, Wow, Sad).
- Each update has an actions menu ("Update actions"): "Reply", "Edit" (the author only), "Copy text", "Copy link", and "Delete" (the author, board owners and admins).
- "Copy link" gives a link that opens the item on that update's thread. Whoever opens it sees "Showing one update" and can click "All updates".
- "Seen by {n}" under an update shows who has read it.

## Attach files and voice notes to an update

1. In the composer, click "Attach file" to upload from your computer, or "From gallery" to pick a file already in the account.
2. If voice recording is turned on, click "Voice recording", speak, then "Stop recording". The recording is attached as a file and can be transcribed ("Transcribe") when AI transcription is available.

## Secret updates

When secret updates are allowed (Administration > Security > "Secret updates", or per board), the composer has a "Secret" switch. A secret update's text is stored encrypted and shown only after a code from your authenticator app; files cannot be attached. You must have two-factor authentication turned on to write or read secret updates. Others see only that there is a secret update.

## Follow an item

Click "Follow" on the card (or "Follow item" in the item's menu). New updates on the item will then notify you. Click "Following" to stop.

## Files on an item

Files live in a Files column (each cell can hold several files) and in updates.

### Upload a file

1. Click the Files cell, or drag files onto it.
2. Each file can be up to 500 MB.

### Preview a file

Click a file to open the viewer. It shows images (with "Zoom in" and "Fit to window"), PDFs, video, audio and text. HTML pages show as "Page", with a "Source" tab for the code. Office files (Word, Excel, PowerPoint) can be shown with "Preview with Office Online"; this sends the file's link to Microsoft, so it is a separate click. Use "Previous file" and "Next file" to move between files, and "Download" to save one.

To download every file in a cell at once, use "Download all (ZIP)".

### Comment on a file

In the viewer, open the "Comments" tab, write in "Write a comment on the file…" and click "Send". The comment is posted as an update on the item, linked to the file.

### File versions

1. Open the file in the viewer and go to "Versions".
2. Click "Upload a new version", or drag a file onto the upload area.
3. The new file becomes "Current". Older versions stay in the list.

From a version's menu you can "Download version {n}", "Make current", or "Delete version". Only a version that is not current can be deleted, by whoever uploaded it or a board admin. All versions count toward the account's storage.

### Ask the AI to change a picture

For PNG, JPEG and WebP images, the "Versions" tab may show "Ask AI for a change". It appears only when AI is on for the account, an image model is chosen, and you may edit the item.

1. Describe the change under "What should change in the picture?" (for example, remove the background).
2. Click "Send to AI". It can take up to a minute.
3. The result is saved as a new version. To undo, make the version before it current.

Each change is a charged AI image.

### Remove a file

In the viewer, click "Remove file". The file moves to the trash with all its versions.

## The activity log

- On the card, the "Activity" tab lists every change to the item: who, what and when.
- For the whole board, click "Activity" in the board header (or press Ctrl+Shift+L). Filter by "Person", "Column", "Action type" and "Dates", or search the log.
- A change can be undone from the log with "Undo" while you may: your own action, or any action if you are an admin, within 7 days. If someone changed the value since, you are asked whether to "Undo anyway".

## The item menu (right-click)

Right-click an item row, a Kanban card or the card header, or click its ⋯ button (Shift+F10 also opens it). You see only what your permissions allow:

- "Open", "Open in new tab", "Copy link", "Copy ID", "Copy key" (when the board numbers its items), "Follow item"
- "Rename" (F2), "Add item below", "Add subitem"
- "Duplicate", "Duplicate with updates"
- "Save as template", "Subitems from a template…"
- "Move to group", "Move to another board", "Make a subitem of…", "Make an item" (for a subitem), "Move up one level"
- "Archive", "Delete"

When several items are selected, right-clicking one of them acts on all of them.

## Related

- [Boards, groups and items](boards-groups-items.md)
- [Columns](columns.md)
- [Docs and forms](docs-and-forms.md)
- [Interactive documents](interactive-documents.md)
- [Notifications and inbox](notifications-and-inbox.md)
- [Time tracking](time-tracking.md)
- [Item templates](item-templates.md)
- [AI](ai.md)
- [Sharing and permissions](sharing-and-permissions.md)
