# Docs and forms

Hebrew version: [docs-and-forms.he.md](docs-and-forms.he.md)

## What it's for

Docs are pages your team writes together: meeting notes, procedures, briefs, plans. Several people can edit the same doc at once and see each other live. A doc can show live boards and items inside it.

Forms collect information from people inside or outside your company. Every answer becomes a new item on a board, so requests, leads and registrations land straight in your work.

## Docs

### Create a doc

1. In the sidebar, click "Add new" > "New doc". To create it inside a folder, open the folder's menu and choose "New doc here".
2. The doc opens. Click the title to name it.

All the docs of a workspace are listed on the workspace page under "Docs". Creating docs depends on your account's plan; if it is not included, the option is shown disabled with the reason.

### Write and add blocks

- Just start typing. Type `/` to open "Add a block" and pick one: "Text", "Large heading", "Medium heading", "Small heading", "Bulleted list", "Numbered list", "Task list", "Table", "Quote", "Code block", "Divider", "Callout", "Toggle", "Two columns", "Image", "File", "Board or view (live)" and "Item card (live)".
- Select text to format it (bold, italic, underline, strikethrough, highlight, link, "Inline code").
- Each block has a handle on its side: drag it to move the block, or click it for "Block actions": "Turn into", "Copy link to block", "Move up", "Move down", "Delete block".
- In a table, the "Table" menu adds and deletes rows and columns and turns the "Header row" on or off.

### Mention people and link to work

Type `@` in a doc to mention a person (they are notified) or to link to an item, a board or another doc.

### Embed a live board or item

1. Type `/` and choose "Board or view (live)" or "Item card (live)".
2. Pick the board (and the view), or search for the item.
3. Click "Embed".

The embed always shows the current data. Readers who cannot see that board or item see "Restricted board" or "Restricted item" instead.

### Work together live

- Everyone in the doc edits at the same time; changes appear for all immediately. The doc saves by itself ("Saving…", "Saved").
- The avatars at the top show who is "In the doc now". Click them to see who is typing and to "jump to where they are".
- In the doc's menu > "Live presence" you can turn off "Show where others are" or "Show others where I am".

### Comment on a block

1. Click inside the block you want to comment on.
2. Press 💬 ("Comment on the block"), write, and click "Send". Use `@` to mention someone.
3. Open "Comments" at the top to see "Open" and "Resolved" comments. A thread can be marked "Resolve" and later "Reopen".

### Version history

The doc saves versions by itself after editing. To save one by hand, open the doc's menu > "Version history" > "Save version" and give it a name. To go back, pick a version and click "Restore version"; what was there is kept as a version too, so nothing is lost.

### Share a doc

1. Click "Share" at the top of the doc.
2. Choose the "Doc type":
   - "Main": everyone in the workspace sees and edits the doc (account viewers read only).
   - "Private": only the people invited see it, at the level they were given.
   - "Shareable": only the people invited, and guests from outside the company can be invited too.
3. Under "Who is invited", use "Add a person or team…" and choose each one's "Permission": "Owner", "Editor", "Commenter" or "Viewer".
4. To invite new people, use "Invite by email", enter the addresses and choose "Invite as" "Team member" or "Guest". Guests can only be invited to a shareable doc.

### Export, duplicate, delete

From the doc's menu: "Copy link", "Export" ("PDF (print)", "Markdown", "HTML"), "Duplicate doc", and "Delete".

### A doc inside an item (Doc column)

Add a column of type "Doc" to a board to give each item its own doc.

1. Click the cell and choose "New doc".
2. The doc opens in a side panel ("Doc in an item"). Click "Open as a page" for the full screen.
3. In the column's settings, "Template for new docs" makes every new doc in the column start as a copy of a doc you choose from the board's workspace.

## Forms

A form belongs to a board: each question is one of the board's columns, and each answer creates an item.

### Create a form

1. Open the board and click "New view".
2. Choose "Form".
3. Give the form a "Form title" and a "Description".

### Add and set questions

1. Under "Questions", click "Add question" and pick a column. Drag questions to reorder them.
2. Click "Edit question" to set:
   - "Question on the form" (empty = the column's name) and "Help text".
   - "Required".
   - "Hidden (preset value)": the question is not shown, and every item gets a value you choose under "Where the value comes from": "Type it", "Pick from the column's options", "From an item on a board", or "From the link" (a parameter in the form's address, such as `?ref=newsletter`, so one form can be shared with several links that each fill a different value).
   - "Show only if": show the question only when an earlier answer has a given value.
   - For file questions: "Max file size (MB)", "Max number of files" and "Allowed file types".
3. Columns that cannot be questions (calculated columns, for example) are listed under "Columns that can't be questions". A column that links to another board can only be a hidden question.

### What happens after submitting

Under "Submit and thank you":

- "Submit button text".
- "Thank-you message", or "Or go to an address after submitting" (a full `https://` address).

### Form settings

Under "Settings":

- "Who can fill it": "Anyone with the link" or "Account members only".
- "Form language": the texts and direction of the form page.
- "Group for new items" (default: the board's first group).
- "Item from a template": each submission creates its item from an item template, with its subitems, values, updates and files. The answers still fill the item and win over the template's values.
- "Close on" a date, and "Max responses" (empty = no limit).
- "Account name and logo", "Logo" and "Cover image" for the top of the page.
- "Privacy notice": text shown above the submit button. Use it to say who collects the answers and why.
- "Spam protection": a hidden trap field and a rate limit always protect the form. You can also use Cloudflare Turnstile: follow the account setting (Administration > Security) or turn it on or off for this form only, optionally with "Separate keys for this form".

### Share the form

Under "Share":

1. Turn "Form is on" on. While it is off, the link answers "not found".
2. "Copy link" or "Open the form". The form shows "{n} responses".
3. "Download QR" gives a QR code of the form for print.
4. To show the form on your website, turn on "Allow embedding on other sites" and use "Copy embed code".
5. "New link" replaces the address; the old link and its QR code stop working at once.

### Answers

Each submission creates an item in the chosen group, and its activity says it came from the form. People filling the form see clear messages when a required field is missing, a file is too large, or the form is closed.

## Related

- [Getting started](getting-started.md)
- [Views](views.md)
- [Columns](columns.md)
- [Item card and collaboration](item-card-and-collaboration.md)
- [Item templates](item-templates.md)
- [Automations](automations.md)
- [Sharing and permissions](sharing-and-permissions.md)
- [Interactive documents](interactive-documents.md)
