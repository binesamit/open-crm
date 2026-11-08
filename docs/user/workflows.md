# Workflows and scenarios

Hebrew version: [workflows.he.md](workflows.he.md)

## What it's for

Beyond simple automations, Bines OS has three tools for processes:

- Status workflow — decides which moves between the labels of a status column are allowed, who may make them, and
  what must be filled in first. A move can open a popup that asks for the missing details.
- Scenarios — automations drawn on a canvas: one trigger, then filters, branches, actions and waits, joined by lines.
- Flows — a view of your outside n8n, Make and Zapier flows: what runs, when it ran and where it failed.

## Status workflow

### Turn on a workflow for a status column

1. Open the board and click the header of a status column.
2. Choose "Workflow (moves between labels)". You need permission to change the board's settings.
3. Switch on "The workflow is on for this column".
4. Under "Allowed moves", each row is the current label and each column a label it may move to. Tick the moves you
   allow. The row "Any label" allows a move from everywhere.
5. Click "Save".

When someone tries a move that is not allowed, they see "The workflow does not allow this move".

### Set rules for a move

Click a move in the grid to open its rules ("Rules of each move"). Each move can have:

- "Fields that must be filled" — columns that must have a value before the move.
- "Who may make this move" — people or teams. Nobody chosen: everyone who may edit the cell.
- "Conditions for the move" — click "+ Add a condition". The move happens only when the item meets them. If not, the
  message lists what is missing and the popup lets you fill it in.
- "Your own message when the move is blocked (optional)" — for example "Can't close before full payment".
- "A popup opens on this move" — see below.
- "Subitems" — "The move needs subitems": a minimum number of complete subitems ("Complete subitems, at least"), the
  "Fields a subitem must have", whether "Every subitem must be complete (not only the minimum)", and "Count only
  subitems that…" match conditions you set.

Moves with rules are marked "Has rules" in the grid.

### Ask for details in a popup

With "A popup opens on this move", the move opens a window with the fields you chose. The values are saved with the
move; cancelling the popup cancels the move too.

1. Optional: write a "Popup title". None: the action's name.
2. Under "Fields the popup asks for", click "+ Add a field" for each column and tick "Required" where needed.
3. Under "Free note:", choose "None", "Optional" or "Required". The note is saved as an update on the item.
4. Under "Subitems in the popup", choose which subitem columns appear, so people can add subitems and fill in their
   missing fields right there.

In the popup, "What the move needs" shows each requirement as "Met" or "Missing".

### General settings

Under "General":

- "A new item (empty status) may take any label".
- "The status may be cleared".
- "Board owners and admins may make a blocked move on purpose (it is logged)". They see "Blocked by the workflow.
  Click to make the move anyway" and confirm with "Make the move".
- "Automations that change the status:" — "Follow the workflow" or "Pass it".

### Items on a label the workflow does not include

If some items sit on a label the workflow leaves out, "Items outside the workflow" shows how many. They stay there
until someone moves them. To move them all, choose a label under "Move them all to:" and click "Move". Each move is
logged.

### Versions

Every save keeps a version. Under "Versions" you can "Restore" an older one; it is saved again as the newest version
and the other versions stay.

## Scenarios (visual builder)

A scenario is an automation built on a canvas. It runs beside the board's automations and does not depend on them.
Use it when you need branches ("if this, do A; otherwise do B") or a wait ("two days later, check again").

### Create a scenario

1. Open the board, open its ⋯ menu and choose "Scenarios (visual builder)". You need permission to manage the board's
   automations.
2. Click "New scenario", type a "Scenario name" and click "Create". The editor opens.
3. Start with a trigger: drag it from the "Blocks" list onto the canvas.
4. Add more blocks (see below) and connect them.
5. Click "Save".

### Blocks

The "Blocks" list has three groups:

- "Trigger" — what starts the scenario. A scenario has one trigger. You can use the board's events: an item is created
  (or created in a group), a status or column changes, an item moves to a group, a checkbox is checked, an update is
  posted, a subitem is created or changes, a person is assigned, a number crosses a threshold, a file is added, a
  button is clicked, or an item is archived, deleted or restored. Date, schedule and incoming-webhook triggers are
  only in automations for now.
- "Logic":
  - "Filter" — "Goes on only if" its conditions match.
  - "Branches" — several branches, each with its own conditions, plus "Otherwise", which goes on when no other branch
    matches. A branch without conditions always matches. Under "Which branches run" choose "The first that matches"
    or "Every one that matches". Use "+ Add a branch" to add one (up to 10).
  - "Wait" — "How long to wait" in "Minutes", "Hours" or "Days" (up to 30 days).
- "Actions" — the same actions as in automations (set columns, move, create items, notify, email, webhook and more),
  except SMS, sending to integrations and extension actions.

### Work on the canvas

- Drag a block onto the canvas, or click it in the list to add it after the chosen block.
- Connect blocks by dragging from dot to dot.
- Point at a line to add a block in its middle (+) — "Add a block here" — or "Remove the connection".
- Click a block to open "Block settings". Change it with "Edit", give it a "Block name", or "Delete the block".
- A scenario can have up to 60 blocks.

### Fix issues and switch it on

Under "Scenario" the editor lists what must be fixed before the scenario can be switched on, such as "No trigger", "A
filter has no conditions", "A block is not connected to the trigger" or "A loop: a block leads back to one that
already ran". When all is well it says "The scenario is ready to be switched on."

Back in the scenarios list, switch it "On". A scenario saved with issues is switched off.

A scenario runs with the rights of whoever saved it last: whoever saves a change becomes its owner.

### Test and read the run log

- "Test on an item" — pick an item. This is a real run: its actions do happen, even while the scenario is off.
- "Run log" — each run with its status ("Pending", "Running", "Waiting", "Succeeded", "Partly succeeded", "Failed",
  "Skipped"), each step, and which branches it took ("Took: …").

A scenario is switched off after 20 errors in a row.

## Flows: your n8n, Make and Zapier flows

The "Flows" page (Administration > Flows) shows the flows of your outside automation platforms in one place. It is
available when the account's plan includes it.

1. Click "New connection", choose the "Platform" and enter its address or zone and its API key or token. The key is
   stored encrypted and never shown again.
2. Click "Test connection".
3. The list shows each flow's "Status", "Last run" and "Failures (7 days)". Click "Runs" to see runs, "Failures only"
   to filter, and "Run again" to retry a failed run (where the platform allows it). "Open in the platform" opens the
   flow there for editing.

Under "Settings", admins choose "Who sees the flows", turn on "Alert when a flow fails" and its "Alert channel"
("Bell", "Bell + email" or "Email"), and decide whether AI may draft, edit or operate flows; every AI change waits
for approval. You can also start an automation from a flow failure — see [Automations](automations.md). More about
connecting outside tools: [MCP and API](mcp-and-api.md).

## Related

- [Automations](automations.md)
- [Columns](columns.md)
- [Boards, groups and items](boards-groups-items.md)
- [Notifications and inbox](notifications-and-inbox.md)
- [MCP and API](mcp-and-api.md)
- [Sharing and permissions](sharing-and-permissions.md)
