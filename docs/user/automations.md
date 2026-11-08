# Automations

Hebrew version: [automations.he.md](automations.he.md)

## What it's for

An automation is a rule that does work for you: "When something happens on the board, then do this". For example,
when a status changes to "Done", move the item to another group and tell the board owners; or every Sunday at 9:00,
remind the people assigned to items that are due this week. Each automation belongs to one board.

An automation has three parts:

- Trigger ("When") — the event that starts it.
- Conditions ("only if") — optional checks the item must meet.
- Actions ("then") — one or more things it does, in order.

For flows with branches and waits, see [Workflows and scenarios](workflows.md).

## Who can build automations

- Admins and members can create automations on boards they work on. An admin can turn this off for members in the
  account permissions. Viewers and guests cannot create automations.
- You can edit or delete an automation you own. Board owners and admins can edit any automation on the board.
- An automation runs with the permissions of its owner. If the owner may not do something (for example, edit a
  restricted column), that action fails.

## Open the automation center

1. Open the board.
2. Click "Automations" in the board header. On a phone it is in the board's ⋯ menu.
3. The window has three tabs: "Manage" (the board's automations), "Create" (ready recipes and the custom builder) and
   "Webhooks" (events sent to outside systems).

To see every automation in the account, click "Automations" in the side menu. That page shows, for the boards you can
see, how many are "Active", "Runs (30 days)", "Actions done (30 days)", "Errors (7 days)" and what is "Scheduled in
24 h", with a "Runs per day, 30 days" chart. Use "Open the board" to edit one.

## Create an automation from a recipe

1. In the automation center, open the "Create" tab.
2. Pick a category on the side ("Status change", "Items", "Dates & time", "People", "Across boards",
   "Notifications & email", "Webhooks & integrations", and others), or type in "Search recipes…".
3. Click a recipe. It opens in the builder as a sentence with blanks.
4. Click each blank (column, label, group, person, message…) and choose a value.
5. Click "Save and switch on", or "Save as off" to keep it switched off for now.

Examples of recipes: each item moves to the group of its status; a reminder on the day a date arrives; whoever creates
the item becomes its owner; open an item on another board when the status changes; send the item to an outside
system when it is created.

## Build a custom automation

1. In the "Create" tab, click "Build a custom automation".
2. Under "When", pick a "Trigger" and fill in its blanks.
3. Optional: click "+ condition" to add checks (see below).
4. Click "+ Choose an action", pick an action and fill it in. Click "+ action" to add more actions; they run in order.
5. Optional: type a "Name (optional)". If you leave it empty, the name is the sentence of the trigger and actions.
6. Click "Save and switch on" or "Save as off".

If something is missing or wrong (for example a column that no longer exists), the builder shows it in red and the
automation cannot be switched on until it is fixed.

## Triggers you can use

Items and groups

- "When an item is created", "When an item is created in {group}".
- "When an item moves to {group}".
- "When an item is archived", "When an item is deleted", "When an item is restored".

Columns

- "When {column} changes to {labels}" (status). You can pick one label, several, or any.
- "When {column} changes". You can pick one or more columns: a change in any of them runs the automation.
- "When {column} is {state}" (a checkbox is checked or unchecked).
- "When {column} {operator} {value}" (a number crosses a threshold, such as "is greater than").
- "When {who} is assigned in {column}" (a person column).
- "When a file is added to {column}".
- "When {column} is clicked" (a button column).
- "When all items linked in {column} are done" (a connect-boards column).

Subitems

- "When a subitem is created".
- "When a subitem's {column} changes to {labels}", "When a subitem's {column} changes".

Dates and time

- "When the date in {column} arrives", on the day or some days before or after, at a time you choose.
- "{days} days before the date in {column}", or "{days} working days before…". Working days follow the account's work
  week and holidays.
- "Every {period} at {time}": every hour, day, week (on a weekday) or month (on a day of the month). The check runs for
  each item on the board, so you can add conditions such as "status is not Done".

Other sources

- "When an update is posted" — optionally only when it contains a word.
- "When a webhook arrives" — an outside system sends data to the automation (see below).
- "When the extension {block} fires" — an event from an installed extension.
- "When a flow fails in {connection}" / "When a flow works again in {connection}" — your connected n8n, Make or Zapier
  flows (only people who see Administration > Flows can pick a connection).

## Add conditions

Conditions make the automation run only for some items.

1. In the builder, click "+ condition".
2. Pick a column, an operator and a value — the same choices as in a board filter.
3. Add more rules if you need them. The line under the conditions reads them back as a sentence.

If an automation was saved with advanced conditions ("or", nested groups or a negation), the builder keeps them as
they are and lets you edit the simple ones.

## Actions you can use

Columns

- "Set status", "Set a column", "Set a date" (today, now, a number of days or working days from a date, or empty).
- "Clear a column", "Increase a number", "Rename the item".
- "Set a computed value" — see below.
- "Copy from a linked item" — takes a value from the item linked in a connect-boards column.

Items

- "Move to group", "Duplicate the item", "Archive", "Delete".
- "Create an item", "Create a subitem".
- "Create an item from a template", "Subitems from a template" — see [Item templates](item-templates.md).
- "Connect items" — links items in a connect-boards column.

Subitems and parent item

- "Set a column of the parent", "Set a column of each subitem".
- "Copy from the parent", "Copy to the parent", "Copy to each subitem".

People

- "Assign", "Unassign" — in a person column: the item's creator, whoever made the change, a specific person, or the
  people in another column.

Notifications and email

- "Notify" — a notification in the bell (and by email, according to each person's settings). Recipients can be people
  columns, "the board owners", "the board's subscribers", "whoever is mentioned" and specific people.
- "Send email" — to an email column, to people, or to typed addresses, with a subject and text.
- "Post an update" — writes an update on the item.
- "Send SMS" — to a phone column, with a saved template or your own text. Available only when the account's plan
  and SMS settings allow it.
- "Send an interactive document" — sends a document made from one of the board's document templates. See
  [Interactive documents](interactive-documents.md).

Across boards

- "Move to board". "Create an item" can also create the item on another board.

Webhooks and integrations

- "Webhook" — sends the item to an outside address.
- "Send to integrations (n8n / Make)" — sends the item on a channel that your integrations listen to.

Time

- "Start time tracking", "Stop time tracking" — choose whose timer: whoever made the change, a fixed person or the
  people in a people column, and what to do when nobody made the change. See [Time tracking](time-tracking.md).

AI

- "Run an agent" — gives one of the AI agents you manage a task about the item.
- "Generate an AI image" — creates an image into a file column from a description, optionally using photos in the
  item. These need an AI connection; see [AI](ai.md).

Extensions

- "Extension" — an action offered by an installed extension.

## Use the item's values in messages

In messages, email subjects, update text and webhook addresses you can insert values from the item. Type `{` and pick
from the list, for example `{item.name}`, the item link, the board name, or who did it. A column's value is shown as
text (a status label, people's names, a date).

## Set a computed value

Use "Set a computed value" to write the result of a calculation into a column when the trigger fires — for example a
price times a quantity, written once at that moment (unlike a formula column, which always recalculates).

1. Add the action "Set a computed value" and choose the column to write to.
2. In "The calculation", build the expression. It works as in a formula column: `+ - * /`, brackets and functions
   such as `ROUND`, `MIN`, `MAX`, `IF`. Insert columns from "The item's columns", "The parent item's columns", or
   "From the item linked in {relation}".
3. To give an empty column a default, write it after a bar, for example `{Quantity|1}`.
4. Choose "Rounding" ("No rounding" or a number of digits after the point).
5. Choose what happens "When a column has no value, or there is no result": "Leave the column as it is", "Clear the
   column" or "Write 0".
6. Use "Preview" with a "Sample item" to see the result before saving.

## Map columns when creating or moving items

When an action creates an item on another board or moves an item there, click "Column mapping ({n})" to choose what
goes to each column of the target board: a column of this item, "A fixed value" (text or a variable), or nothing.
"Map by name" fills the matches for you. Unmapped columns stay empty; on a move they are copied by name and type.

## Receive data from outside ("When a webhook arrives")

1. Build an automation with the trigger "When a webhook arrives".
2. Under "Which item?", choose "No item (board level)" or find the item "By item id" or by a column, using a "JSON
   field" of the incoming data.
3. Leave "Secret (required)" empty to have one generated on save.
4. Save. The automations list then shows the "Inbound URL".
5. In the sending system (Make, n8n…), send a POST with JSON to that URL, with the secret in the `X-Bines-Secret`
   header — never in the URL.
6. In the actions, use the incoming data as `{payload.field}`, for example `{payload.lead.name}`.

## Manage automations

In the "Manage" tab each automation shows its switch, its "Last run", how many runs it had and whether it "had
errors". From each row you can:

- Switch it on or off ("Turn on" / "Turn off").
- "Edit" it.
- "Test" it (see below).
- Open its "History".
- "Duplicate" it — the copy is created switched off.
- "Save as template" — reuse it on other boards (see below).
- Delete it.

A row marked "Needs fixing" refers to something that is gone (a column, a label, a group or a board). Edit it and
pick the missing part again. A row marked "Waiting for its owner to switch it on" was changed by someone other than
its owner (or handed to a new owner), so it was switched off; only its owner or an admin can switch it back on.

## Test an automation

1. In the "Manage" tab, click "Test" on the automation.
2. Under "On which item?", search for an item.
3. Click "Preview". You see whether the conditions are met and what each action would do. Nothing is written.
4. To run it for real on that item, click "Run it for real", then check the "History".

## Read the history

Click "History" to see each run: when it ran, on which item, and its result — "succeeded", "partial", "failed",
"skipped", "pending" or "running". Each action shows "done", "skipped" or "error", with the reason, for example
"conditions not met", "switched off", "the item is gone" or "loop stopped".

Automations protect themselves from loops: a chain of automations that triggers itself is stopped, and an automation
that runs too many times on the same item in one minute stops too. An automation can also be skipped when the plan's
monthly automation runs are used up.

## Reuse automations as templates

1. In the "Manage" tab, open the automation's ⋯ menu and choose "Save as template". Give it a "Name" and a
   "Description". Webhook addresses and secrets are not kept.
2. To use it on another board, click "Automations" in the side menu and find it under "Account templates". Click
   "Install", pick the board and choose, under "What fits
   on this board", the columns, groups and labels it should use.
3. Tick "Switch on right away" if you want it active at once; otherwise it is installed switched off.

By default only admins save and edit account templates. An admin can allow it with "Members may also save and edit
templates".

## Buttons that run actions

A button column puts a button on every item. In the column's settings, under "What the button does", choose:

- "Runs an automation" — every click runs the board's automations whose trigger is "When a button is clicked".
- "Opens a link" — the address can include the item's values, such as `{item.name}`.
- "Sets values" — writes fixed values into columns.
- "Opens a popup" — asks for some fields before it saves.
- "Creates a linked item" — creates an item on another board and links it to this one.

To set up "Creates a linked item":

1. Choose "The new item's board".
2. Under "Linked through the column", pick the connect-boards column that links the two boards (on either board). If
   there is none, add one first.
3. Optional: under "Copy from the item to the new item", choose "From column" and "To column" pairs. Add "Fixed values
   for the new item" if needed.
4. Under "The popup", choose which columns of the other board to ask for. With none, the item is created at once.
5. Under "If a linked item already exists", you can "Open it in the popup instead of creating another".
6. Under "After saving", choose "A message with "Open"" or "Open the card".

Nothing is created until the person clicks "Save" in the popup. "Ask for confirmation first" adds a confirmation
before the button runs.

## Tips

- Start with "Save as off", test on one item, then switch it on.
- Deleting a column, label or group that an automation uses makes that automation need fixing.
- Automations that change a status can be set to follow or pass the status workflow; see
  [Workflows and scenarios](workflows.md).

## Related

- [Workflows and scenarios](workflows.md)
- [Columns](columns.md)
- [Item templates](item-templates.md)
- [Notifications and inbox](notifications-and-inbox.md)
- [Interactive documents](interactive-documents.md)
- [Time tracking](time-tracking.md)
- [AI](ai.md)
- [MCP and API](mcp-and-api.md)
- [Extensions](extensions.md)
- [Sharing and permissions](sharing-and-permissions.md)
