# Item templates

Hebrew version: [item-templates.he.md](item-templates.he.md)

## What it's for

Some work repeats: onboarding a new client, a monthly report, an event with the same twenty steps. An item template
saves an item, with all its subitems, values, updates and files, so you can create the whole tree again in one step.
When you apply it, the template can ask a few questions (a name, a start date, who is in charge) and fill them in
everywhere, moving every date by working days.

Templates belong to a board. Anyone who can add items to the board can use them; saving, editing and deleting templates
needs permission to change the board's structure.

## Save an item as a template

1. Open the item's menu (in its row or in the item card) and choose "Save as template".
2. Enter the "Template name" and, optionally, a "Category" (it groups templates in the menu).
3. Under "What is kept" choose what goes into the template: "All its subitems, at every level", "Its updates", and
   "Its files (in columns and updates)".
4. Under "What to ask when it is applied" tick the questions you want:
   - "When does it start?": every date moves with it, in working days, skipping holidays.
   - "Who is in charge?": wherever the item's owner appears in the tree, the person chosen comes instead.
   - "A new name": the item's name is replaced in its subitems and updates too.
5. Click "Save". The message "Saved as the template "…"" offers "Open in the editor" if you want to fine-tune it.

"Save as template" is offered on top-level items, not on subitems.

## Create items from a template

1. Next to the "New item" button at the top of the board, open the arrow ("More ways to add"). When the board has
   templates, they are listed there by category.
2. Pick a template. The "New from a template" window opens.
3. Answer the template's questions. If it has none, you see "This template asks nothing: ready to create."
4. Check "What will be made": the tree of items with their dates.
5. Click "Create". The message says how many items were made.

The whole tree is created as one action, so one undo removes it all. If a value can no longer be set (for example a
column was deleted), the rest is created and a message tells you how many values were skipped.

## Add subitems from a template to an existing item

1. Open the item's menu and choose "Subitems from a template…".
2. Pick a template, answer its questions and click "Create".

The template's items are added as subitems under the item.

## Manage and edit templates

Open the board's menu ("More actions") and choose "Item templates", or choose "Manage templates…" under the "New item"
arrow. The list shows each template with its number of items and version. From there you can "Create", "Edit" or
"Delete" a template, or start a "New template".

The "Template editor" has three parts:

- "Structure": the tree of the item and its subitems. Add a "Subitem", rename, reorder with "Up" and "Down", and move
  with "One level in" and "One level out". The depth follows what the board allows.
- "Values": for the selected item, a value per column. For each column choose the "Kind of value": "Empty", "Fixed",
  "Relative date" (for example "+3 working days" after a date question, with an optional end), "From a question", "Text
  with fields" (text that uses questions, such as "Materials from {name}") or "Files".
- "Questions when applied": add a "Question" with a type ("Text", "Date" or "Person") and mark it "Required" if needed.
  Use questions in names, text, dates and people columns. "Updates it adds" lets you write the updates the item gets.

Click "Save". A change to the tree or the questions saves a new version of the template. If you leave without saving,
you are asked "Leave without saving?".

Dates are counted in working days on the account's calendar (see [Calendar and Google sync](calendar-and-google-sync.md)).
A template can hold up to 500 items.

## Use a template in an automation

Two automation actions use item templates:

- "Create an item from a template": creates the tree on a board. Choose the template, the "Group" (by default "The first
  group"), and under "Answers to the template's questions" where each question takes its answer on the item that ran the
  automation (a question left unset takes "Its default"). You can also link the new item: "Link on the item that ran it"
  and "Link back on the new item".
- "Subitems from a template": adds the template's items as subitems of the item that ran the automation.

See [Automations](automations.md).

## Use a template in a form

In the form editor, choose "Item from a template". Each submission then makes its item from the template, with its
subitems, values, updates and files. The answers fill the item as always and win over the template's values. Under
"The template's questions, from the answers" choose which form question answers each template question. See
[Docs and forms](docs-and-forms.md).

## AI and connected tools

The AI assistant and connected AI tools (through MCP) can list, read, save, change, apply and delete item templates,
with your permissions. See [AI](ai.md) and [MCP and API](mcp-and-api.md).

## Related

- [Boards, groups and items](boards-groups-items.md)
- [Columns](columns.md)
- [Automations](automations.md)
- [Docs and forms](docs-and-forms.md)
- [Calendar and Google sync](calendar-and-google-sync.md)
- [AI](ai.md)
- [MCP and API](mcp-and-api.md)
