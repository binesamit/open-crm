# n8n-nodes-bines-os

The official [n8n](https://n8n.io) community nodes for **Bines OS** — a work OS of boards, items, subitems, updates,
files, automations and AI agents.

- **Bines OS Trigger** — starts a workflow when something happens on a board. It registers its own webhook when the
  workflow is switched on and removes it when it is switched off: there is no URL to copy anywhere.
- **Bines OS** — actions and searches: create / update / move / archive / delete / duplicate items, subitems, updates
  and replies, items from templates, time tracking, file uploads and links, groups and columns, AI agent runs, find an
  item by phone or email, list items with filters, search everything, list people, teams and boards, and a generic API
  call. Usable as a tool by n8n AI agents.

Fields are dynamic: once a board is chosen, its columns load and each one renders in its own type (a status shows its
labels, a date takes a date, people take emails or names). **Subitems** work the same way: choose the parent board and
the subitem columns load from its sub-board. Columns with predefined values — status, dropdown, people, tags,
connected boards — **offer their values to pick** wherever a value is asked for (the column mapper, "find by column
value", filters, the trigger's label).

### What's new in 0.3.0

Additions only — every 0.2 operation, field and event keeps its name and behaviour, so saved workflows run unchanged.

- Items: **Apply Template** (a new item with its subitems from one of the board's item templates — group, position,
  answers to its variables — or the template's subitems under an existing item).
- Subitems: **Move Up a Level** (under its grandparent; a first-level subitem becomes an item of the board).
- **Time Tracking**: start / stop a timer, log time by hand, get an item's time log.
- Files: **Add Link to Column** (a web link in a files column, beside its files).
- Updates: **Tick Check Box** (tick or clear one check box of an update or reply).
- Groups: **Rename**, **Delete**. **Column**: **Create** (types that need no settings).
- **Search Everything** (items, boards, updates and people you can see) and **Get Teams**.
- Trigger events: item restored, item moved to this board, update edited, update deleted, file added, group created,
  column created, column type changed.
- Built against n8n-workflow 2.x and checked with n8n's own linter (`pnpm lint:n8n`, `@n8n/node-cli`).

### What's new in 0.2.0

- Subitems everywhere: the subitem column mapper reads the sub-board (its own field, `subitemColumns`), new subitem
  operations (get, get many of an item, get many with filters, find by column value, move under another item,
  archive, delete) and subitem trigger events (column changed — optionally one column —, status changed — optionally
  one column / label —, renamed, archived, deleted, update posted).
- Value pickers: the mapper offers labels, people, tags and connected items; "find by column value" and filter
  conditions have a **From List** mode (searchable: labels, people, connected items by name, values already used) next
  to typing a value.
- Workflows saved with 0.1 keep working (a typed find value, the subitem mapper saved as `columns`).

> The product name in every label comes from one constant (`nodes/shared/constants.ts → PRODUCT_NAME`). The node and
> credential internal names (`binesOs`, `binesOsTrigger`, `binesOsApi`) are saved inside workflows — never rename them.

## Install

### From npm (once published)

In n8n: **Settings → Community nodes → Install**, enter `n8n-nodes-bines-os`, accept the risk notice, install.
Self-hosted only for unverified community nodes; n8n Cloud needs the package to be verified by n8n first.

### From a local tarball (before publishing)

```bash
# in this folder (a member of the bines-os-platform pnpm workspace)
pnpm install
pnpm build
npm pack                       # → n8n-nodes-bines-os-0.2.0.tgz
```

Then install the tarball into your n8n's custom-nodes folder and restart n8n:

```bash
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom
npm init -y >/dev/null 2>&1    # only the first time
npm install /path/to/n8n-nodes-bines-os-0.2.0.tgz
# restart n8n — "Bines OS" and "Bines OS Trigger" appear in the nodes panel
```

With Docker, mount the folder and install inside it:

```bash
docker run -it --rm -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
# (install the tarball into ~/.n8n/custom on the host first, as above)
```

The trigger needs n8n to be reachable from the Bines OS server (set `WEBHOOK_URL` in n8n to its public address, or
use a tunnel while testing).

## Credentials — "Bines OS API"

| Field        | Value                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------- |
| Instance URL | The address you open Bines OS at, e.g. `https://crm.example.com` (with or without `/api/v1`). |
| API Token    | A personal token from **Settings → API tokens** (`bos_pat_…`).                                |

The token acts as you, inside the account it was made in, limited to its scopes (and to its boards, if you limited it).
Give it what the workflow needs:

| Scope           | Needed for                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `boards:read`   | boards, schema, get / list / find items (every workflow)                                                                                |
| `items:write`   | create / update / move / archive / delete / duplicate items and subitems, apply item templates, file uploads and links, time tracking   |
| `updates:write` | post updates and replies, tick their check boxes                                                                                        |
| `webhooks`      | the trigger (it subscribes and unsubscribes webhooks; you must be allowed to manage the board's webhooks — board owner or admin)        |
| `users:read`    | the people picker, "Get many users", "Get teams", and people columns given by name or email                                             |
| `boards:write`  | create, rename and delete groups; create columns                                                                                        |
| `search`        | Search Everything                                                                                                                       |
| `agents:run`    | run an AI agent ("AI Agent → Run"); the token's owner must be allowed to run that agent. `agents:write` (manage agents) is never needed |

**Test** calls `GET /api/v1/auth/me`.

## Trigger — "Bines OS Trigger"

Choose a **board** and an **event** (for subitem events, the board of the parent items — the subitem columns and
labels load from its sub-board):

| Event                      | Platform event                                          | Extra fields                                                                 |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Item Created               | `item_created`                                          | —                                                                            |
| Column Value Changed       | `specific_column_changed`                               | Column                                                                       |
| Status Changed             | `status_changed`                                        | Status column (optional), Label (optional — only when it becomes this label) |
| Any Column Changed         | `column_changed`                                        | —                                                                            |
| Item Renamed               | `item_name_changed`                                     | —                                                                            |
| Update Posted              | `update_created`                                        | —                                                                            |
| Item Moved to Group        | `item_moved_to_specific_group`                          | Group                                                                        |
| Item Moved to Any Group    | `item_moved_to_group`                                   | —                                                                            |
| Item Archived              | `item_archived`                                         | —                                                                            |
| Item Deleted               | `item_deleted`                                          | —                                                                            |
| Subitem Created            | `subitem_created`                                       | —                                                                            |
| Subitem Column Changed     | `subitem_column_changed`                                | Subitem column (optional — empty = any)                                      |
| Subitem Status Changed     | `subitem_column_changed` + `config.column_type: status` | Subitem status column (optional), Label (optional)                           |
| Subitem Renamed            | `subitem_name_changed`                                  | —                                                                            |
| Subitem Archived           | `subitem_archived`                                      | —                                                                            |
| Subitem Deleted            | `subitem_deleted`                                       | —                                                                            |
| Update Posted on a Subitem | `subitem_update_created`                                | —                                                                            |
| Sent From an Automation    | `automation_sent`                                       | Channel (optional)                                                           |
| Item Restored              | `item_restored`                                         | —                                                                            |
| Item Moved to This Board   | `item_moved_to_board`                                   | —                                                                            |
| Update Edited              | `update_edited`                                         | —                                                                            |
| Update Deleted             | `update_deleted`                                        | —                                                                            |
| File Added                 | `file_added`                                            | —                                                                            |
| Group Created              | `group_created`                                         | —                                                                            |
| Column Created             | `column_created`                                        | —                                                                            |
| Column Type Changed        | `column_type_changed`                                   | —                                                                            |

Options: **Include Item** (default on — the event carries the item with its column values, no second call needed) and
**Verify Signature** (default on).

**"Sent from an automation"** pairs with the automation action **"send to integrations"** in Bines OS: build any
automation in the app (any trigger, any conditions) and end it with that action; every workflow listening on the board
receives the item. A **channel** (free text, e.g. `new-lead`) lets several workflows listen to different automations
of the same board.

### How the subscription works

1. When the workflow is switched on (or while it listens for a test event), the node calls
   `POST /api/v1/boards/{boardId}/webhooks` with the n8n webhook URL, the event, its filter (`config`) and a fresh
   signing secret, and keeps the subscription id and secret in the workflow's static data.
2. Bines OS proves the URL first: it POSTs `{"challenge": "…"}` and the trigger answers with the same JSON. If n8n
   cannot answer yet, the node retries with `skip_handshake` (allowed to board owners and admins).
3. Before re-registering, n8n calls `GET /api/v1/webhooks/{id}`; a subscription that is gone, switched off or for
   another event is replaced.
4. When the workflow is switched off: `DELETE /api/v1/webhooks/{id}`.

Every delivery is signed: `X-Bines-Signature: sha256=HMAC-SHA256(secret, X-Bines-Timestamp + "." + raw body)`. The
trigger refuses unsigned, forged and stale (over 10 minutes) calls with `401`. Failed deliveries are retried by Bines
OS (1 min … 24 h) and logged per subscription.

### Output

The platform's event object, stable and documented in the API reference (**Webhooks**), plus `deliveryId`:

```json
{
  "type": "status_changed",
  "boardId": "01JB…",
  "boardName": "Leads",
  "itemId": "01JB…",
  "itemName": "Dana Levi",
  "groupId": "topics",
  "groupName": "New",
  "columnId": "status",
  "columnType": "status",
  "columnTitle": "Status",
  "value": { "index": 1, "text": "Done" },
  "previousValue": { "index": 0, "text": "New" },
  "actor": { "kind": "user", "id": "01JB…", "name": "the product owner" }
  "changedAt": "2026-10-06T09:30:00.000Z",
  "eventId": "01JB…",
  "subscriptionId": "01JB…",
  "item": {
    "id": "01JB…",
    "name": "Dana Levi",
    "board_id": "01JB…",
    "group_id": "topics",
    "cells": {
      "status": { "value": { "index": 1 }, "text": "Done" },
      "phone": { "value": { "phone": "050-1234567" }, "text": "050-1234567" }
    },
    "column_values": { "Status": "Done", "Phone": "050-1234567" }
  },
  "deliveryId": "01JB…"
}
```

## Actions and searches — "Bines OS"

| Resource      | Operation                                                           | API                                                                        |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Item          | Create (name, group, column values)                                 | `POST /boards/{boardId}/items`                                             |
| Item          | Update (name, column values)                                        | `PATCH /items/{id}`                                                        |
| Item          | Get                                                                 | `GET /items/{id}`                                                          |
| Item          | Get Many (filters + free-text search, all pages)                    | `POST /boards/{boardId}/items/query`                                       |
| Item          | Find by Column Value (phone, email, any column, or `name`)          | `POST /boards/{boardId}/items/find`                                        |
| Item          | Move to Group                                                       | `POST /items/{id}/move-to-group`                                           |
| Item          | Move to Board (columns mapped by id, then by title, same type)      | `POST /items/{id}/move-to-board`                                           |
| Item          | Archive                                                             | `POST /items/{id}/archive`                                                 |
| Item          | Delete (to the trash, 30 days)                                      | `DELETE /items/{id}`                                                       |
| Item          | Duplicate (optionally with updates)                                 | `POST /items/{id}/duplicate`                                               |
| Item          | Apply Template (new item + subitems; or the subitems under an item) | `POST /item-templates/{id}/apply`                                          |
| Subitem       | Create (under a parent item, with the sub-board's columns)          | `POST /items/{id}/subitems`                                                |
| Subitem       | Update                                                              | `PATCH /items/{id}`                                                        |
| Subitem       | Get                                                                 | `GET /items/{id}`                                                          |
| Subitem       | Get Many of an Item (the subitems right under it, in order)         | `GET /items/{id}/subitems`                                                 |
| Subitem       | Get Many (filters on subitem columns + free text, all pages)        | `POST /boards/{subBoardId}/items/query`                                    |
| Subitem       | Find by Column Value                                                | `POST /boards/{subBoardId}/items/find`                                     |
| Subitem       | Move to Another Item (first / last)                                 | `POST /items/{id}/reparent`                                                |
| Subitem       | Archive / Delete                                                    | `POST /items/{id}/archive`, `DELETE /items/{id}`                           |
| Subitem       | Move Up a Level                                                     | `POST /items/{id}/outdent`                                                 |
| Update        | Create (post on an item)                                            | `POST /items/{id}/updates`                                                 |
| Update        | Reply                                                               | `POST /updates/{id}/replies`                                               |
| Update        | Tick Check Box (counted from 1)                                     | `PUT /updates/{id}/tasks/{index}`                                          |
| File          | Upload to a files column (from an input binary field)               | presign → PUT → complete → attach                                          |
| File          | Add Link to a files column                                          | `POST /items/{id}/cells/{columnId}/links`                                  |
| Group         | Create / Rename / Delete                                            | `POST /boards/{boardId}/groups`, `PATCH` / `DELETE …/groups/{groupId}`     |
| Column        | Create (a taken title gets the next free number)                    | `POST /boards/{boardId}/columns`                                           |
| Time Tracking | Start / Stop Timer, Add Entry, Get Entries                          | `POST /items/{id}/time/start` · `/stop` · `/entries`, `GET …/time/entries` |
| Search        | Search Everything (2+ characters, optionally archived items)        | `GET /search`                                                              |
| User          | Get Teams                                                           | `GET /teams`                                                               |
| AI Agent      | Run (prompt, optional item, dry run)                                | `POST /agents/{id}/runs`                                                   |
| User          | Get Many (active members, search)                                   | `GET /users`                                                               |
| Board         | Get Many / Get Schema                                               | `GET /boards`, `GET /boards/{boardId}/schema`                              |
| API Call      | Any REST call (method, path, query, body)                           | anything under `/api/v1`                                                   |

### Column values

The **Column Values** mapper lists the board's writable columns (from `GET /boards/{boardId}/schema`). Choose
**Map Each Column Manually** or **Map Automatically** (input fields named after a column id or title). Values:

| Column type                         | Accepts                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Status                              | a label (picked from the list, or its text, any case) or its id                                  |
| Dropdown                            | a label picked from the list; or labels / ids, comma-separated                                   |
| People                              | a person picked from the list; or emails, unique names or user ids, comma-separated              |
| Tags                                | a tag picked from the list; or tag names (new ones are created) / ids, comma-separated           |
| Connect boards                      | an item picked from the list (the linked boards' items); or item ids, comma-separated            |
| Date                                | `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (taken as written — no time-zone shift; midnight = date only) |
| Timeline                            | `YYYY-MM-DD - YYYY-MM-DD`                                                                        |
| Numbers / Rating                    | a number                                                                                         |
| Checkbox                            | true / false                                                                                     |
| Text, Long text, Email, Phone, Link | text                                                                                             |
| Hour                                | `HH:MM`                                                                                          |
| Anything else                       | per its JSON Schema (a single field is filled from the text), or a JSON object                   |

A JSON object (`{"index": 1}`) is always sent as the raw stored value — for any column type. Empty values leave the
column unchanged. An unknown label or person fails the item with a message that names the column and the choices.

Output items are the API's item plus `column_values` (text by column title).

### Find by column value

**Value** has two modes: **From List** shows the column's values (status / dropdown labels, people, tags, connected
items by name, or the values already used in a text column — searchable) and **Value** takes any text or expression.

Phone numbers compare by digits — formatting, a leading `0` and a country prefix do not matter
(`+972 50-123-4567` = `050-1234567`). Emails compare case-insensitively; other columns by their text, case-insensitively.
**Contains** looks inside the text. Archived and trashed items are not returned.

## Platform endpoints added for this app

| Endpoint                                                                        | What for                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /boards?q=`                                                                | flat board list for pickers                                                                           |
| `GET /boards/{boardId}/schema`                                                  | groups, columns (type, writable, options, JSON Schema of the value, linked boards), sub-board columns |
| `GET /boards/{boardId}/columns/{columnId}/choices?q=&subitems=`                 | the values of a column, for the value pickers                                                         |
| `GET /items/{id}/subitems`                                                      | the subitems right under an item                                                                      |
| webhook `subitem_column_changed` + `config.column_id` / `column_type` / `label` | the subitem triggers' filters                                                                         |
| `POST /boards/{boardId}/items/find`                                             | find by column value                                                                                  |
| `GET /webhooks/{id}`                                                            | the trigger's `checkExists`                                                                           |
| webhook event `automation_sent` + `config.channel`                              | "send to integrations" automation action                                                              |
| webhook `config.include_item`                                                   | the item with its cells in every event                                                                |

All are in the public API reference (`/api/docs`).

## Development

```bash
pnpm --filter n8n-nodes-bines-os test        # unit tests (HTTP mocked)
pnpm --filter n8n-nodes-bines-os typecheck
pnpm --filter n8n-nodes-bines-os build       # → dist/ (CommonJS, what n8n loads)
```

To try it against a local n8n with live reload, `npm link` the folder into `~/.n8n/custom` and run `pnpm build` after
each change, then restart n8n.

Publishing (not done yet): bump `version`, `pnpm build`, `npm publish` (public). For n8n Cloud, submit the package for
verification (no runtime dependencies — this package has none).

## The Make app

Make has the same resources as a Make custom app: `integrations/make-app-bines-os` (19 instant triggers with
self-registering webhooks, the actions and searches above, dynamic column fields from the board schema, and the same
value conversion as an IML function). Its README explains how to push it to Make.
