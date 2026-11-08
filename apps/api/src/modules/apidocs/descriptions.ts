// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The public API reference's wording per operation: a short title for the navigation and a description for
 * people integrating with the API. Kept apart from the routes so the route files keep their terse summaries
 * (which the full document — `/api/v1/openapi.full.json`, owners only — and the SDK use) and so the reference reads as one voice. A route's own
 * `description`, when it has one, wins over the text here.
 *
 * `test/apidocs.test.ts` fails when a public operation has no entry and when an entry names an operation that no
 * longer exists — a new endpoint cannot ship undocumented.
 */
export const DESCRIPTIONS: Record<string, readonly [title: string, description: string]> = {
  // ── Account ─────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /accounts/me': [
    'Get the account',
    'Returns the account the token belongs to, with its settings: name, time zone, date format, first day of the week, branding and enabled features.',
  ],
  'PATCH /accounts/me': [
    'Update the account',
    'Changes the account name and settings. Send only the fields you want to change. Admins only. A custom email sender name, Reply-To or SMS sender id may need the platform operator approval: it is then saved as a pending request (see **Get sender approvals**) and the current sender stays in use until it is approved.',
  ],
  'GET /accounts/me/sender-requests': [
    'Get sender approvals',
    'Whether custom senders need approval on this platform, and the latest request for each of the email sender name, the Reply-To and the SMS sender id: pending, approved or rejected (with the reason). Admins only.',
  ],
  'PUT /accounts/me/logo': [
    'Set the account logo',
    'Sets the account logo from a file you already uploaded (see **Files → Start an upload**). Images up to 2 MB. Admins only.',
  ],
  'DELETE /accounts/me/logo': [
    'Remove the account logo',
    'Removes the account logo; the app falls back to the account initials. Admins only.',
  ],
  'PUT /accounts/me/nav': [
    'Set the account’s sidebar and top bar layout',
    'Sets where each of the app’s general places sits on a computer for everyone in the account who has not chosen their own (`placement`, places as in **Get my sidebar and top bar layout**), and whether members may choose their own (`locked`). Admins only.',
  ],
  'PUT /accounts/me/email-logo': [
    'Set the email logo',
    'Sets the logo shown in the emails the account sends (invitations, notifications) from a file you already uploaded (see **Files → Start an upload**). Images up to 2 MB. Without it, emails show the account logo. Admins only.',
  ],
  'DELETE /accounts/me/email-logo': [
    'Remove the email logo',
    'Removes the email logo; emails then show the account logo. Admins only.',
  ],
  'GET /accounts/me/logo': [
    'Get the account logo',
    'Redirects to a short-lived link of the account logo. Also accepts `?account_id=` because an `<img>` tag cannot send headers.',
  ],
  'GET /accounts/me/default-transfer-user': [
    'Get the default transfer member',
    'The member offered by default to receive boards, automations and other things a person owns when they are deactivated. Admins only.',
  ],
  'PATCH /accounts/me/default-transfer-user': [
    'Set the default transfer member',
    'Sets (or clears with `null`) the member offered by default when someone is deactivated. Admins only.',
  ],

  // ── Activity & undo ─────────────────────────────────────────────────────────────────────────────────────────
  'POST /activity/{id}/undo': [
    'Undo an action',
    'Reverts the action recorded in an activity entry — the whole batch when the action was part of one (a bulk edit, an automation run). Answers `409 changed_since` when something changed the same data afterwards; send `force: true` to undo anyway.',
  ],
  'POST /activity/{id}/redo': [
    'Redo an action',
    'Re-applies an action that was undone (it undoes the undo). Answers `409 changed_since` when the data changed meanwhile, unless `force: true`.',
  ],
  'POST /activity/batches/{id}/undo': [
    'Undo a batch',
    'Reverts every action of a batch at once. Every write response and activity entry carries its `batch_id`.',
  ],

  // ── Agents ──────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /agents': [
    'List agents',
    'The AI agents you manage (admins see all of them), and whether you may create a new one.',
  ],
  'POST /agents': [
    'Create an agent',
    'Creates an AI agent. The agent gets its own service identity; the boards you give it are checked against your own access.',
  ],
  'GET /agents/{id}': [
    'Get an agent',
    'One agent with its profile, model, tools, boards, approval mode, limits and state.',
  ],
  'PATCH /agents/{id}': [
    'Update an agent',
    'Changes an agent: profile, model, tools, boards, approval mode, limits, or switches it on and off. Send only what changes.',
  ],
  'DELETE /agents/{id}': ['Delete an agent', 'Deletes an agent. Its past runs and the activity it caused stay.'],
  'POST /agents/{id}/web-search/{decision}': [
    'Decide an agent’s web search request',
    'Approves or rejects a member’s request to let an agent search the web. Recorded in the audit log. Admins only.',
  ],
  'GET /agents/connections': [
    'List agent AI connections',
    'The AI connections an agent may use — names and models only, never a key.',
  ],
  'GET /agents/directory': [
    'List mentionable agents',
    'Agents that act when mentioned or assigned, as they appear in mention lists and people pickers. `unavailable` lists the other agents you could mention, each with the reason it cannot act now (mention off, inactive, not on a board you can see, guests not allowed, no AI connection).',
  ],
  'GET /agents/templates': [
    'List agent templates',
    'Starter agent templates and which of them this account already added.',
  ],
  'POST /agents/templates/seed': [
    'Add starter agents',
    'Adds agents from the starter templates. They start inactive, in learner mode and without boards, so nothing runs until you set them up.',
  ],
  'GET /agents/{id}/automations': [
    'List an agent’s automations',
    'Automations that run this agent (the `run_agent` action).',
  ],
  'GET /agents/{id}/knowledge': ['List knowledge sources', 'The agent’s knowledge sources and their indexing status.'],
  'POST /agents/{id}/knowledge': [
    'Add a knowledge source',
    'Adds a knowledge source to an agent: a file you uploaded (PDF, DOCX, TXT, MD), a doc, a board or a note. It is indexed in the background.',
  ],
  'POST /agents/{id}/knowledge/{sourceId}/reindex': [
    'Re-index a knowledge source',
    'Reads a knowledge source again — after a doc changed or when indexing a file failed.',
  ],
  'DELETE /agents/{id}/knowledge/{sourceId}': [
    'Remove a knowledge source',
    'Removes a knowledge source; it leaves the agent’s index at once.',
  ],
  'GET /agents/approvals': [
    'List approval requests',
    'Steps waiting for approval by the agents you manage (the approvals inbox).',
  ],
  'POST /agents/approvals/{id}': [
    'Approve or reject a step',
    'Approves or rejects a step an agent is waiting on. The run continues from where it stopped.',
  ],
  'GET /agents/runs': ['List agent runs', 'Runs of the agents you manage, newest first.'],
  'GET /agents/runs/{id}': ['Get an agent run', 'One run with every step the agent took and its approvals.'],
  'POST /agents/runs/{id}/cancel': ['Cancel a run', 'Stops a queued, running or waiting run.'],
  'POST /agents/runs/{id}/undo': [
    'Undo a run',
    'Reverts every change the run made, as one batch. Answers `409 changed_since` when the data changed meanwhile, unless `force: true`.',
  ],
  'POST /agents/{id}/runs': [
    'Run an agent',
    'Runs the agent now with a prompt. With `dry_run: true` its write tools only report what they would do.',
  ],

  // ── AI ──────────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /ai/settings': ['Get AI settings', 'The account’s AI and MCP settings. Admins only.'],
  'GET /ai/web-search': [
    'Get web search settings',
    'The search service the account’s agents use, its limits and today’s use. The key is never returned. Admins only.',
  ],
  'PATCH /ai/web-search': [
    'Update web search settings',
    'Sets the search service, its key (write-only) and the limits per run and per day. Recorded in the audit log. Admins only.',
  ],
  'PATCH /ai/settings': [
    'Update AI settings',
    'Changes the account’s AI and MCP settings. Recorded in the audit log. Admins only.',
  ],
  'GET /ai/connections': [
    'List AI connections',
    'The account’s AI provider connections: provider, a hint of the key and the default model — never the key itself. Admins only.',
  ],
  'POST /ai/connections': [
    'Create an AI connection',
    'Saves a connection to an AI provider: Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible server (`base_url` — Mistral, Groq, OpenRouter, DeepSeek, a local Ollama when the platform allows local addresses). The key is encrypted at rest and never returned. Admins only.',
  ],
  'PATCH /ai/connections/{id}': [
    'Update an AI connection',
    'Renames a connection, changes its default model, server address, hand-added models (with their capabilities) or per-model prices, or replaces its key. Admins only.',
  ],
  'DELETE /ai/connections/{id}': ['Delete an AI connection', 'Deletes an AI connection. Admins only.'],
  'POST /ai/connections/{id}/test': [
    'Test an AI connection',
    'Checks that the connection’s key works, with a call that costs nothing. Admins only.',
  ],
  'GET /ai/connections/{id}/models': [
    'List models',
    'The models the provider offers on this connection plus the ones added by hand — tool-calling models first, then newest and most capable first — with prices (the connection’s own, else the platform’s price table; null = unknown, the model is still listed), capabilities (tools, vision, JSON, streaming, context, images) and `default_model`: the connection’s default, or when none is set the newest tool-calling model (`default_auto`). Cached for an hour; admins can pass `refresh=true`.',
  ],
  'POST /ai/connections/models': [
    'Preview a provider’s models',
    'Reads the models a provider offers for a key (and `base_url` for an OpenAI-compatible server) before the connection is saved, in the same shape as a connection’s model list, so its default model can be picked from the live list. Nothing is stored. Admins only.',
  ],
  'GET /ai/usage': ['Get AI usage', 'A month’s AI spend per connection, source and model. Admins only.'],
  'GET /ai/mcp': [
    'Get MCP access',
    'The account’s MCP server address, whether you may connect, and the tools you would get. See the **MCP** guide.',
  ],
  'GET /ai-columns/connections': [
    'List AI column connections',
    'The AI connections an AI column may use — names only, never a key.',
  ],
  'GET /ai-columns/runs/{id}': ['Get an AI column run', 'Progress, cost and errors of one AI column run.'],
  'POST /boards/{boardId}/ai-columns/{columnId}/items/{itemId}/outputs/{fileId}/reject': [
    'Reject an AI design',
    'Removes a design an AI image column made (one of the cell’s `ai.outputs`) from the output file column to the trash — restorable, and undoable like any file removal — and marks it `rejected: true` on the cell. Needs the rights to remove a file there. A later run makes a new design in its place (a rejected design is never versioned). Removing the file from the file column directly marks it the same way. Not a design of this cell: 404.',
  ],
  'GET /boards/{boardId}/ai-columns/{columnId}': [
    'Get an AI column',
    'Whether an AI column is ready to run, its spend this month and its latest runs.',
  ],
  'POST /boards/{boardId}/ai-columns/{columnId}/items/{itemId}/retry-missing': [
    'Complete an AI cell’s missing designs',
    'For an AI column with image output: queues only the cell’s designs that were not made — `failed` ones (a provider error after its retries, a cost limit, a refusal …) and `pending` / `running` ones whose run has stopped — as a new run (the same as `POST …/run` with `only_missing: true` for this item). Designs already made are never made or charged again; a design that re-makes an earlier one still becomes its new version. Nothing missing: the run is `done` with the item skipped. The cell’s designs being made right now by a live run: the item fails with `ai_run_in_progress`. A text column: 422 `ai_column_not_image`. Needs the rights of a run.',
  ],
  'POST /boards/{boardId}/ai-columns/{columnId}/run': [
    'Run an AI column',
    'Fills AI cells for the given items, for every empty cell, or for all cells. The run is one undoable batch; large runs are queued and reported by `GET /ai-columns/runs/{id}`. A column with `source_image_columns` (file columns, in order; the old single `source_image_column` is still read) sends each item’s images of those columns with the request in that order — `source_image_count` `"all"` (default) or the newest N of each column; when the model takes fewer (OpenAI gpt-image 16, Gemini 3 image models 14, Gemini 2.5 Flash Image 3, plus a bytes cap per request) the newest go and the cell’s `ai.source_images` says `{sent, total}`. Image output starts from them, text output reads them with a model that sees images; with several columns a line naming which images came from which column is added to the prompt. An item without an image there is made from the description only (`when_no_source_image: "text"`, the default) or is not run or charged (`"skip"` — `no_source_image` in the run’s errors). With `output: "image"` (round 4): `photo_mode` `"each"` (the default of a new column: one call — and one design — per source photo, style examples going with each) or `"together"` (one call with every photo; settings saved before round 4 read as this); `variations` 1–4 designs per photo (each design is its own charged image). Image output is always queued (the images queue): the run answers `running` with `unit: "image"` and `total` = the designs to make; each design (item × source photo × variation) is one job, made one after the other (at most `images.concurrency` runs of the account side by side, Administration → AI), its file saved as soon as it is made. A busy, slow or unavailable provider (429, timeout, 5xx, network) is tried again up to 5 times over a few minutes with a growing wait and jitter (its `Retry-After` honoured); a refusal or another 4xx fails that design with its reason. The run’s `max_usd_per_run` and the column’s `max_usd_per_month` are checked before every design; when reached, the designs left are marked failed (`limit_run_usd` / `limit_month_usd`) and the run stops — what was made is kept. Every design is its own file in `image_column`, listed in the cell’s `ai.outputs` (`file_id`, `source_asset_id`, `variation`, `version`, `rejected`, `status` `pending` / `running` / `done` / `failed`, `error`, `attempts`, `retry_at`); poll `GET /ai-columns/runs/{id}` for `done` / `failed`. `only_missing: true` (or `POST …/items/{itemId}/retry-missing`) makes only the designs not made yet. A re-run of an item that has designs: `image_on_rerun` `"version"` (the default of a new column — each new design becomes a new version of the design made for the same photo + variation, history kept; the old value `"replace"` reads as this) or `"add"` (another file); `on_existing: "version" | "add"` in this request overrides it for the run. `fidelity`: `"free"`, `"close"` (keep the composition and colours of the starting picture) or `"locked"` (the newest image of `fidelity_base_column`, else the newest style example, is sent first as the approved base to keep exactly — only the figure is replaced with the one in the item’s photo; no base = close, with `ai.note: "fidelity_no_base"`); prompt guidance only, no masks. Style examples: `style_examples: {column, filter, count}` (off = `null`, the default) sends the newest `count` (default 3, 1–10) images of a file column on OTHER items of the board that match `filter` (the board filter model, e.g. status = Approved; none = any item with an image there) first, as the style to follow, with a line saying so — read with the runner’s rights (items or a column they can’t read are left out); they take the model’s limit first and `ai.source_images` then says `{sent, total, examples}`. None match = run as without them.',
  ],

  // ── Archive ─────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /archive': ['List archived things', 'Archived items, groups and boards on boards you can read, newest first.'],
  'POST /archive/{type}/{id}/restore': [
    'Restore from the archive',
    'Brings an archived item, group or board back where it was.',
  ],
  'POST /boards/{boardId}/groups/{groupId}/archive': [
    'Archive a group',
    'Archives a group with its items. A board always keeps at least one group.',
  ],
  'POST /boards/{id}/archive': ['Archive a board', 'Archives a board. Board owners and admins.'],
  'POST /items/{id}/archive': [
    'Archive an item',
    'Archives an item with its subitems. Needs the right to delete the item.',
  ],

  // ── Audit ───────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /audit': [
    'List audit log entries',
    'The account’s audit log — sign-ins, permission and settings changes, exports and other security events — filtered by person, event and days, one page at a time. Admins only.',
  ],
  'GET /audit/export.csv': ['Export the audit log', 'The filtered audit log as CSV, up to 10,000 rows. Admins only.'],

  // ── Automations ─────────────────────────────────────────────────────────────────────────────────────────────
  'GET /automations': [
    'List automations',
    'Every automation on the boards you can read, with its board and its runs of the last 7 days.',
  ],
  'GET /automations/usage': [
    'Get automation usage',
    'Runs per day over 30 days by outcome, the actions carried out, and scheduled runs due in the next 24 hours.',
  ],
  'GET /automations/{id}': ['Get an automation', 'One automation: its trigger, conditions, actions and state.'],
  'PATCH /automations/{id}': [
    'Update an automation',
    'Edits an automation, switches it on or off, or transfers it to another owner. Send `If-Match` with the revision you read to avoid overwriting someone else’s change.',
  ],
  'DELETE /automations/{id}': ['Delete an automation', 'Deletes an automation (to the trash).'],
  'GET /automations/{id}/runs': [
    'List automation runs',
    'The automation’s run history, newest first. For the next page, pass the last id you received as `before`.',
  ],
  'GET /boards/{boardId}/automations': ['List a board’s automations', 'The automations of one board.'],
  'POST /boards/{boardId}/automations': [
    'Create an automation',
    'Creates an automation on a board from a recipe `{trigger, conditions, actions}`. The recipe is validated against the board’s columns and groups; problems answer `422 invalid_recipe` with the path of each issue. A computed value (`set_computed`) writes the result of an expression — the formula column’s language over `{key}` of the item, `{parent.key}` of its parent and `{relation.key}` of the item it links to, `{key|1}` a default for an empty cell — into a plain column people can still edit. For example, on a service line (a subitem): `{"trigger":{"type":"subitem_column_changed","columns":["service","qty"]},"actions":[{"type":"set_computed","column":"planned_minutes","expression":"{qty|1} * {service.min_per_unit}","round":2,"on_empty":"skip"}]}`; `POST /boards/{boardId}/automations/computed-preview` shows the result on a few items first.',
  ],
  'POST /boards/{boardId}/automations/computed-preview': [
    'Preview a computed value',
    'Computes a `set_computed` expression on up to three items of the board (`level: sub` — of its sub-board, for a subitem trigger), or on `item_id`, and returns each result as `column` would show it, or why there is none (`missing_value`, `no_result`, `not_a_value`). Nothing is written. An expression the save would refuse answers `error` with its code.',
  ],
  'POST /automations/{id}/activate': ['Activate an automation', 'Switches an automation on.'],
  'POST /automations/{id}/deactivate': ['Deactivate an automation', 'Switches an automation off.'],
  'POST /automations/{id}/save-as-template': [
    'Save an automation as a template',
    'Saves an automation as a template of the account. Its references to the board (columns, sub-board columns, groups, labels) become blanks that are picked again when the template is installed; webhook URLs and secrets are not kept. Admins (and members, when the account allows it).',
  ],
  'GET /automation-templates': [
    'List automation templates',
    'The account’s automation templates, newest first, each with its blanks and its sentence; `can_manage` says whether you may save, edit and delete them.',
  ],
  'GET /automation-templates/{id}': [
    'Get an automation template',
    'One automation template with its recipe and blanks.',
  ],
  'PATCH /automation-templates/{id}': [
    'Update an automation template',
    'Renames an automation template or changes its description or category.',
  ],
  'DELETE /automation-templates/{id}': ['Delete an automation template', 'Deletes an automation template.'],
  'POST /automation-templates/{id}/proposal': [
    'Preview a template install',
    'For a target board: each blank of the template with the columns, groups or labels that fit it and the one proposed (same type, same title first). Send `mapping` to see the choices after your own picks.',
  ],
  'POST /automation-templates/{id}/install': [
    'Install an automation template',
    'Creates an automation on a board from the template. Blanks take the values in `mapping` (blank id → column key, group id, label or text) and otherwise the proposal; a blank nothing fits answers `422 invalid_recipe`. The automation is validated like any other and starts switched off unless `is_active` is true.',
  ],
  'POST /automations/{id}/test': [
    'Test an automation',
    'Runs an automation on one item: as a dry run (shows what would happen, writes nothing) or for real.',
  ],
  'POST /hooks/in/{id}': [
    'Trigger an inbound webhook',
    'Runs an automation whose trigger is “incoming webhook”, with the JSON body as its input. Authenticate with the automation’s secret in the `X-Bines-Secret` header — no API token. See **Webhooks**.',
  ],

  // ── Boards & templates ──────────────────────────────────────────────────────────────────────────────────────
  'POST /boards': [
    'Create a board',
    'Creates a board — empty or from a template — in a workspace or folder. You become its owner.',
  ],
  'GET /boards': [
    'List boards',
    'Every board you can open, flat across workspaces, with its workspace — for board pickers in integrations. `q` filters by part of the name, `workspace_id` by workspace. Sub-boards are not listed (see `subitems` in the board schema).',
  ],
  'GET /boards/{boardId}/schema': [
    'Get the board schema',
    'What an integration needs to render a field per column: the groups, and for each column its id, title, type, whether you may write it through `cells`, how its value reads (`value_model`), its options (status and dropdown labels, by id), a JSON Schema of the value `cells.<id>` accepts and, for a connect-boards column, the boards it links (`linked_board_ids` — pick their items with **Search items by name**). `subitems` describes the sub-board the same way once the board has subitems: use its `board_id` to query, find or search subitems.',
  ],
  'GET /boards/{boardId}/fields': [
    'Get the column-values form',
    'The writable columns of a board as ready-made input fields for integrations: each with its id (`name`), title (`label`) and a field type — a select with the labels of a status or dropdown column (value = label id), a multiple select whose options load from the column’s values (`rpc://listUsers` for people, `rpc://listValues?…` → **List column values** for tags and connected items), yes / no for a checkbox, a number, a URL, multi-line text, or text with a hint for dates, timelines and hours. With `subitems=true`, the fields of the board’s sub-board. Fill them in and send them as `values` when you create or update an item.',
  ],
  'GET /boards/{boardId}/columns/{columnId}/choices': [
    'List column values',
    'The values a column can hold, for value pickers in integrations: the labels of a status or dropdown column, the account’s active people, the tags, the items a connect-boards column links (searched by name across its linked boards), item names for `name`, or the values already typed in a free-text column (most used first). Each choice has `id` — what a filter or a write takes (label id, user id, tag id, item id; null for free text) — and `text`, what the cell reads and what **Find items by a column value** compares. `q` narrows by text; at most 100 choices. With `subitems=true`, `columnId` is a column of the board’s sub-board. People’s emails (`hint`) need a token with `users:read`.',
  ],
  'GET /boards/{boardId}': [
    'Get a board',
    'A board with its columns, groups and what you may do on it. Use the column ids and label ids from here when you write cells.',
  ],
  'PATCH /boards/{boardId}': [
    'Update a board',
    'Renames a board, changes its description or its permission set. Board owners and admins.',
  ],
  'DELETE /boards/{boardId}': [
    'Delete a board',
    'Moves a board to the trash, where it can be restored for 30 days. Board owners and admins.',
  ],
  'POST /boards/{boardId}/duplicate': [
    'Duplicate a board',
    'Copies a board: its structure only, with its items, or with items and updates. You own the copy.',
  ],
  'POST /boards/{boardId}/save-as-template': [
    'Save a board as a template',
    'Saves the board’s structure as a template of this account. Board owners and admins.',
  ],
  'DELETE /boards/{boardId}/template-draft': [
    'Discard a template draft',
    'Discards your working board of a template; the template stays as it was.',
  ],
  'POST /boards/{boardId}/template-draft/save': [
    'Save a template draft',
    'Saves your working board over its template and removes the working board.',
  ],
  'GET /templates': [
    'List templates',
    'The board templates available in this account: built-in ones and the account’s own.',
  ],
  'GET /templates/hidden': ['List hidden templates', 'Built-in templates removed from this account. Admins only.'],
  'PATCH /templates/{key}': [
    'Update a template',
    'Renames one of the account’s templates or changes its description. Its creator or an admin.',
  ],
  'DELETE /templates/{key}': ['Delete a template', 'Deletes one of the account’s templates. Boards made from it stay.'],
  'POST /templates/{key}/draft': [
    'Open a template draft',
    'Returns your working board of a template (the open one, or a new hidden one) to edit the template’s structure. For whoever may edit the template.',
  ],
  'POST /templates/{key}/duplicate': [
    'Duplicate a template',
    'Copies a template — built-in or the account’s — as a new template of this account.',
  ],
  'POST /templates/{key}/restore': [
    'Restore a built-in template',
    'Brings a removed built-in template back to this account. Admins only.',
  ],

  // ── Columns ─────────────────────────────────────────────────────────────────────────────────────────────────
  'POST /boards/{boardId}/columns': [
    'Create a column',
    'Adds a column of one of the column types (status, people, date, numbers, relation …) with its settings. You may choose its id (`[a-z][a-z0-9_]`, unique on the board).',
  ],
  'PATCH /boards/{boardId}/columns/{columnId}': [
    'Update a column',
    'Renames a column, changes its width or its settings (for example the labels of a status column). The name column’s `settings.name_source` is the board’s item name source — see **Set the item name source**.',
  ],
  'GET /boards/{boardId}/columns/{columnId}/workflow-versions': [
    'List workflow versions',
    'A status column’s workflow (`settings.workflow`: the allowed moves between labels, the columns a move needs filled, who may make it and its conditions) is saved as a new version on every change. Lists them, newest first, with who saved each and when.',
  ],
  'POST /boards/{boardId}/columns/{columnId}/workflow-versions/{version}/restore': [
    'Restore a workflow version',
    'Puts a saved version of the status column’s workflow back; the restore is saved as the newest version. Board owners and admins only. A move the workflow blocks answers `409 workflow_blocked` (`details.reason`: `not_allowed`, `who`, `required` with the missing `columns`, `subitems`, `note`, or `conditions` with `failed` — each condition not met: `column_id`, `title`, `operator`, `values` in words and the item’s `current` value — and `any` when one of them is enough; `details.message` is the move’s own text, when it has one); an owner or admin may pass it with `workflow_override: true` on the cell write, which is logged.',
  ],
  'GET /boards/{id}/scenarios': [
    'List scenarios',
    'A board’s scenarios: automations drawn as a graph — one trigger, then filters, routers (branches, each with its own conditions, and “otherwise”), actions and waits joined by edges. Each comes with its `issues` (what stops it from being switched on) and its last run.',
  ],
  'POST /boards/{id}/scenarios': [
    'Create a scenario',
    'Creates a scenario (off). The graph’s triggers and actions are the automations’ own (`trigger` / `action` objects as in a recipe); SMS, integrations and extension actions are not available in scenarios yet.',
  ],
  'GET /scenarios/{id}': ['Get a scenario', 'One scenario with its graph, its issues and its last run.'],
  'PATCH /scenarios/{id}': [
    'Update a scenario',
    'Renames it or saves its graph. A scenario runs with its owner’s rights, so whoever saves a change becomes its owner. A graph with issues switches it off.',
  ],
  'PUT /scenarios/{id}/active': [
    'Switch a scenario on or off',
    'On needs a graph without issues (`422` with the `issues`); switching on makes you its owner.',
  ],
  'DELETE /scenarios/{id}': ['Delete a scenario', 'Deletes the scenario; its runs go with it.'],
  'GET /scenarios/{id}/runs': [
    'List scenario runs',
    'Runs, newest first: status (`succeeded`, `partial`, `failed`, `skipped`, `waiting`) and each step — the node, what came out (an action’s output, the branches a router took) or why it stopped.',
  ],
  'POST /scenarios/{id}/test': [
    'Test a scenario on an item',
    'Runs the scenario on one item of its board now — its actions really happen — even while it is off, and answers with the run and its steps.',
  ],
  'DELETE /boards/{boardId}/columns/{columnId}': [
    'Delete a column',
    'Moves a column to the trash. Its id stays reserved on the board and is never reused. A column the board’s computed item name is built from answers `409 column_in_name_source`: change the name source first.',
  ],
  'GET /boards/{boardId}/name-source': [
    'Get the item name source',
    'How the board names its items: `free` (typed by people, the default), `column` (the display text of one column, `column_id`) or `template` (text with `{column_id}` placeholders, e.g. `{client} – {date}`), with the text used when everything is empty (`empty_text`) and the duplicate warning setting. `refs` lists the columns the name reads; `recompute` is the last recompute of the board’s names (`status`, `done` of `total`). A sub-board has its own setting.',
  ],
  'PUT /boards/{boardId}/name-source': [
    'Set the item name source',
    'Makes the board compute item names from its columns, or lets people type them again (`mode: free` — the last computed names stay as text). A computed name is stored as the item’s `name`, so search, filters, exports, webhooks and MCP see it as any name; the item keeps its id. It follows every change of the columns it reads, including a linked item’s name or cells on another board. Any column with text can be used (relations, mirrors and formulas too); several linked items are joined with commas. Changing the source recomputes the board — in the request on small boards, in the background on big ones (poll **Get the item name source** or follow `board.names_recompute_progress` on the live stream). Placeholders must name existing columns (`422 name_source_invalid`). Needs the right to change columns.',
  ],
  'GET /boards/{boardId}/name-duplicates': [
    'List duplicate item names',
    'Names shared by more than one active item of the board, the most shared first (up to 100 names with up to 20 item ids each), with how many names and items are affected. Turn on `warn_duplicates` in the name source to have the app warn about them; duplicates are never blocked.',
  ],
  'POST /boards/{boardId}/columns/{columnId}/reorder': [
    'Move a column',
    'Moves a column to another position. The name column always stays first.',
  ],
  'POST /boards/{boardId}/columns/{columnId}/convert': [
    'Change a column type',
    'Converts a column to another type and carries its values over (text to numbers, status to dropdown, people to text …). Send `dry_run: true` first: nothing is written and the answer is a preview with the counts (converted, empty, failed), sample values, the labels that would be created and the formulas, filters and automations that use the column. Then send the same request with the preview’s `fingerprint` to convert; `409 preview_stale` means the column changed since the preview. Above 5,000 cells the conversion runs in the background — poll **Get a conversion**. The original values are kept as a backup. Board owners and admins only.',
  ],
  'GET /boards/{boardId}/conversions': [
    'List column conversions',
    'The board’s column type changes, newest first, with their status and counts. Filter to one column with `?column_id=`.',
  ],
  'GET /boards/{boardId}/conversions/failed': [
    'List cells that failed to convert',
    'The cells of recent conversions whose value could not be converted, with their original value, so you can fix them by hand. A conversion drops out of the list once its marks are cleared.',
  ],
  'GET /boards/{boardId}/conversions/{conversionId}': [
    'Get a conversion',
    'A conversion with its status (`running`, `done`, `failed` …), progress, counts and report. Poll it while a background conversion runs.',
  ],
  'POST /boards/{boardId}/conversions/{conversionId}/undo': [
    'Undo a conversion',
    'Puts the column back as it was before the conversion: its type, settings, every value and the formulas, filters and automations that changed with it. Values edited since the conversion are kept unless you send `force: true`.',
  ],
  'POST /boards/{boardId}/conversions/{conversionId}/restore': [
    'Restore a column from its backup',
    'Restores the original type and values from the conversion’s backup, also after the undo window has passed. Send `dry_run: true` first for a preview (counts, cells changed since the conversion, affected formulas and automations) and then the preview’s `fingerprint`. Cells edited since the conversion stay as they are unless you send `force: true`.',
  ],
  'POST /boards/{boardId}/conversions/{conversionId}/clear-failed': [
    'Clear the failed-cell marks',
    'Stops marking the cells that failed in a conversion. The backup of their original values is kept. Board owners, admins and the person who ran the conversion.',
  ],
  'GET /conversions/settings': [
    'Get the conversion backup period',
    'How many days the original values of a column conversion are kept for restoring (`backup_days`: 30, 90, 365, or 0 = until removed by hand).',
  ],
  'PUT /conversions/settings': [
    'Set the conversion backup period',
    'Sets how many days the original values of a column conversion are kept (30, 90, 365, or 0 = until removed by hand). Admins only.',
  ],
  'GET /boards/{boardId}/columns/{columnId}/sequence': [
    'Get an item-number sequence',
    'The prefix, padding and next number of an item-number column.',
  ],
  'PUT /boards/{boardId}/columns/{columnId}/sequence': [
    'Set an item-number sequence',
    'Sets the number the next item gets — useful to continue numbering from another system.',
  ],
  'PUT /boards/{boardId}/columns/{columnId}/two-way': [
    'Set a two-way relation',
    'Pairs a relation column with a column on the target board so both sides stay in sync, or turns it back to one-way.',
  ],
  'GET /boards/{boardId}/columns/{columnId}/relation-matches': [
    'Check relation links against the filter',
    'For a connect-boards column that offers only items matching a view or a filter: the linked items that no longer match it, for the caller (they stay linked and are marked). Computed per caller, never stored.',
  ],
  'GET /boards/{boardId}/columns/{columnId}/values': [
    'List column values',
    'Values already used in a column, most used first — for suggestions while typing.',
  ],
  'PUT /boards/{boardId}/columns/{columnId}/restriction': [
    'Restrict a column',
    'Restricts who may edit a column (others can read it) or who may see it at all. Board owners and the people or teams listed are exempt; `null` removes the restriction.',
  ],

  // ── Dashboards ──────────────────────────────────────────────────────────────────────────────────────────────
  'POST /workspaces/{id}/dashboards': ['Create a dashboard', 'Creates a dashboard in a workspace. You own it.'],
  'GET /dashboards/source-options': [
    'List possible dashboard sources',
    'Every board of the account you may read, from all workspaces, to choose the source boards of a dashboard.',
  ],
  'GET /dashboards/{id}': [
    'Get a dashboard',
    'A dashboard with its widgets, source boards and what you may do on it. `kind` is main, private or shareable; `sharing` is a deprecated alias of `kind`, removed in the next release.',
  ],
  'PATCH /dashboards/{id}': [
    'Update a dashboard',
    'Renames a dashboard, changes its description, source boards, filter, kind (main, private or shareable) or place. Owners only.',
  ],
  'DELETE /dashboards/{id}': ['Delete a dashboard', 'Moves a dashboard to the trash. Owners and admins.'],
  'POST /dashboards/{id}/duplicate': [
    'Duplicate a dashboard',
    'Copies a dashboard with its widgets, right after it. You own the copy.',
  ],
  'GET /dashboards/{id}/members': [
    'List dashboard members',
    'People and teams invited to the dashboard, with their level.',
  ],
  'PUT /dashboards/{id}/members': [
    'Set dashboard members',
    'Replaces the members of a dashboard, each with a level: owner, editor or viewer. Guests only on a shareable dashboard and never as owners; a dashboard always keeps an owner. Owners and admins.',
  ],
  'POST /dashboards/{id}/invite': [
    'Share a dashboard by email',
    'Shares a dashboard with email addresses at a level (owner, editor or viewer): people already in the account join it at once, new people get an account invitation that adds them when they accept. Guests only on a shareable dashboard; a guest invited as owner becomes an editor. What a guest sees in the widgets is limited to boards shared with them. Owners and admins.',
  ],
  'GET /dashboards/{id}/columns': [
    'List dashboard source columns',
    'Columns, groups and views of the source boards you may see, merged by type and title — what widget settings can refer to.',
  ],
  'POST /dashboards/{id}/widgets': [
    'Add a widget',
    'Adds a widget of one of the widget types (numbers, chart, battery, table …). Owners only.',
  ],
  'PUT /dashboards/{id}/layout': [
    'Set the widget layout',
    'Sets every widget’s place and size on the grid. Overlapping widgets are pushed down.',
  ],
  'POST /dashboards/{id}/widgets/{widgetId}/data': [
    'Get widget data',
    'A widget’s data as you may see it — each source board’s access, item visibility and column restrictions apply.',
  ],
  'GET /boards/{id}/item-templates': [
    'List item templates',
    'A board’s item templates: name, category, how many items and how deep, and the variables applying one asks for (without the trees).',
  ],
  'POST /boards/{id}/item-templates': [
    'Create an item template',
    'An item template from a tree: the top item’s values by the board’s column keys, its subitems’ by the subitems columns; dates in working days after a date variable; text with {variable} fields; updates and files (files you uploaded). Needs rights to change the board’s structure.',
  ],
  'POST /items/{id}/save-as-template': [
    'Save an item as a template',
    'The item and its subitems at every depth as a template: their values, updates and files (the template keeps its own copies). Dates become working days after a "start" variable, the item’s owner and name become variables (each can be left out).',
  ],
  'GET /item-templates/{id}': ['Get an item template', 'One item template with its whole tree and its variables.'],
  'PATCH /item-templates/{id}': [
    'Update an item template',
    'Renames an item template or replaces its tree / variables; a new tree or variables is a new version (items made before keep what they got).',
  ],
  'DELETE /item-templates/{id}': [
    'Delete an item template',
    'Takes it out of every menu; items made from it stay. Restore brings it back (and the delete can be undone).',
  ],
  'POST /item-templates/{id}/restore': ['Restore an item template', 'Brings a deleted item template back.'],
  'POST /item-templates/{id}/apply': [
    'Apply an item template',
    'A new item with all its subitems (in a group, the first by default), or with parent_item_id the template’s subitems under that item (its empty cells take the template values). Send the variables: text, a date YYYY-MM-DD, or user ids for a person. One batch_id undoes it all.',
  ],
  'POST /dashboards/{id}/widgets/{widgetId}/items': [
    'List the items behind a widget value',
    'The items a clicked value of a widget is made of (a number, a chart bucket and series, a battery segment, a person in a workload), as you may see them, 50 at a time. `pick` says which value; `not_x` lists the buckets shown, for the folded “other” bucket.',
  ],
  'PATCH /dashboard-widgets/{id}': ['Update a widget', 'Changes a widget’s title and settings. Owners only.'],
  'DELETE /dashboard-widgets/{id}': [
    'Remove a widget',
    'Removes a widget. `POST /dashboard-widgets/{id}/restore` brings it back.',
  ],
  'POST /dashboard-widgets/{id}/restore': ['Restore a widget', 'Brings a removed widget back.'],

  // ── Docs ────────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /workspaces/{id}/docs': ['List docs', 'The docs of a workspace that you can open.'],
  'POST /workspaces/{id}/docs': ['Create a doc', 'Creates a doc in a workspace. You own it.'],
  'GET /docs/{id}': ['Get a doc', 'A doc’s details and what you may do on it.'],
  'PATCH /docs/{id}': ['Update a doc', 'Renames a doc, changes its icon, kind, place or settings. Owners and admins.'],
  'DELETE /docs/{id}': ['Delete a doc', 'Moves a doc to the trash. Owners and admins.'],
  'GET /docs/{id}/content': [
    'Get doc content',
    'The doc’s content as last saved, as ProseMirror JSON and as plain text — no real-time connection needed.',
  ],
  'GET /docs/{id}/export': ['Export a doc', 'Exports a doc as HTML, Markdown, or a page ready to print to PDF.'],
  'POST /docs/{id}/duplicate': [
    'Duplicate a doc',
    'Copies a doc (its saved content) right after it. You own the copy.',
  ],
  'POST /docs/{id}/collab-token': [
    'Get a collaboration token',
    'A 5-minute token to open the doc’s real-time editing connection without a browser session.',
  ],
  'GET /docs/{id}/members': ['List doc members', 'People and teams invited to the doc, with their level.'],
  'PUT /docs/{id}/members': [
    'Set doc members',
    'Replaces the members of a doc. A doc always keeps an owner. Owners and admins.',
  ],
  'POST /docs/{id}/invite': [
    'Share a doc by email',
    'Shares a doc: people already in the account join at once; new people (guests too) get an invitation.',
  ],
  'GET /docs/{id}/comments': [
    'List doc comments',
    'The doc’s comment threads, each anchored to a block, with their comments.',
  ],
  'POST /docs/{id}/comments': [
    'Start a comment thread',
    'Starts a comment thread on a block of the doc. Owners, editors and commenters.',
  ],
  'POST /doc-comment-threads/{id}/comments': [
    'Reply in a thread',
    'Adds a reply to a comment thread; a resolved thread is reopened.',
  ],
  'POST /doc-comment-threads/{id}/resolve': [
    'Resolve a thread',
    'Resolves (`resolved: true`) or reopens a comment thread.',
  ],
  'PATCH /doc-comments/{id}': ['Edit a comment', 'Edits one of your comments.'],
  'DELETE /doc-comments/{id}': ['Delete a comment', 'Deletes a comment. Its author or whoever manages the doc.'],
  'GET /docs/{id}/versions': ['List doc versions', 'The doc’s versions, newest first — automatic and named ones.'],
  'POST /docs/{id}/versions': ['Save a doc version', 'Saves the doc as it is now as a named version.'],
  'GET /docs/{id}/versions/{versionId}': ['Get a doc version', 'The content of one version, for a preview.'],
  'POST /docs/{id}/versions/{versionId}/restore': [
    'Restore a doc version',
    'Makes a version’s content the doc’s current content. This is recorded as a new version, so no history is lost.',
  ],
  'POST /items/{id}/cells/{columnId}/doc': [
    'Get an item’s doc',
    'Returns the doc of an item’s doc cell, creating it on first use. For whoever may change the cell.',
  ],

  // ── Files ───────────────────────────────────────────────────────────────────────────────────────────────────
  'POST /files/presign': [
    'Start an upload',
    'Step 1 of an upload: returns a presigned URL. `PUT` the file’s bytes to it directly (files up to 500 MB), then call **Finish an upload**.',
  ],
  'POST /files/{id}/complete': [
    'Finish an upload',
    'Step 2 of an upload: tells the server the upload is done; it checks the stored object. The file can then be attached to a file cell, an update or a profile.',
  ],
  'GET /voice': [
    'Voice settings',
    'What the update composer may offer: whether recording a voice message is on, its longest length in seconds, and whether transcription is available to you now (on, AI on, a connection chosen).',
  ],
  'GET /ai/connections/{id}/transcription-models': [
    'List a connection’s transcription models',
    'The speech-to-text models of an AI connection, newest first (empty for a provider that does not transcribe). Admins only.',
  ],
  'GET /files/{id}': [
    'Get a file',
    'A file’s metadata and a download link valid for 15 minutes. Access follows the item the file is on. A file with versions is served at its current version (`version` says which); the id of an older version serves that version, for whoever may read the file.',
  ],
  'POST /files/{id}/transcribe': [
    'Transcribe an audio or video file',
    'The text of an audio or video file you may read, made with the speech-to-text connection the account’s admin chose (Administration → AI → Voice and transcription). Needs AI on in the account; the cost counts in AI usage and the monthly budget. Not for guests. The text is kept on the file version: asking again returns it (`reused: true`, nothing charged) unless `force: true`.',
  ],
  'GET /files/{id}/transcript': [
    'Get a file’s transcript',
    'The kept transcript of an audio or video file you may read (`transcript: null` until someone transcribed it), and whether you may correct it (`can_edit`: you may edit what holds the file — the update’s author, or the editors of the file’s cell). No AI, no cost.',
  ],
  'PATCH /files/{id}/transcript': [
    'Correct a file’s transcript',
    'Replaces the transcript’s text (empty text removes it). For whoever may edit what holds the file; recorded in the item’s activity.',
  ],
  'GET /files/{id}/versions': [
    'List a file’s versions',
    'The versions of a file in a file cell, newest first: id, version number, name, size, type, who uploaded it and when, and which one is current (the newest). For whoever may read the file.',
  ],
  'POST /files/{id}/versions': [
    'Upload a new version',
    'Makes a finished upload of yours (`file_id`, from **Start an upload** and **Finish an upload**) the next version of a file in a file cell. The cell keeps one file, now at the new version. The same rights as attaching to the cell; `409 file_in_use` when that upload is already attached somewhere.',
  ],
  'POST /files/{id}/versions/{versionId}/make-current': [
    'Make a version current',
    'Brings an older version back: its bytes are copied as a new version, which becomes current. Nothing is rewritten; the copy counts toward the storage limit.',
  ],
  'GET /files/{id}/ai-edit': [
    'Can I ask the AI to change this image?',
    'Whether you may ask the AI for a change to this file now: `available`, or `reason` why not (no right to change the cell, AI off, the AI budget used up, no image model chosen in Administration → AI → AI images, a plan without AI).',
  ],
  'POST /files/{id}/ai-edit': [
    'Ask the AI to change an image',
    'Sends the image (PNG, JPEG or WebP, up to 20 MB) with your `instruction` (up to 2000 characters, e.g. “remove the background”) to the account’s image model — the connection and model chosen in Administration → AI → AI images — and saves the result as the file’s next version, which becomes current. `version_id` changes an older version instead of the current one. The same rights as uploading a version; then the account’s AI must be on and within budget, and the shared AI change rate applies (`429`). A model that cannot edit images answers `422 ai_model_no_image_edit` and nothing is charged; a file that is not an image, `422 ai_source_not_image`. Each change is a charged AI image, recorded in AI usage. To undo, make the version before it current.',
  ],
  'DELETE /files/{id}/versions/{versionId}': [
    'Delete a version',
    'Deletes one version at once (not to the trash), with its stored bytes: its uploader or a board owner / admin. Never the current version (`409 version_is_current`), nor version 1 while newer versions exist (`409 first_version_kept` — it holds the file in its cell).',
  ],
  'DELETE /files/{id}': [
    'Discard an upload',
    'Discards a file you uploaded but never attached; it is removed from storage at once.',
  ],
  'POST /items/{id}/cells/{columnId}/files': [
    'Attach files to a cell',
    'Attaches uploaded files to an item’s file cell.',
  ],
  'DELETE /items/{id}/cells/{columnId}/files/{fileId}': [
    'Remove a file from a cell',
    'Removes one file from an item’s file cell. It goes to the trash with all its versions (restorable like an item, then purged with its stored bytes); undo puts it back.',
  ],
  'POST /items/{id}/cells/{columnId}/links': [
    'Add a link to a cell',
    'Adds a web link to an item’s file cell, beside its files. An http(s) address (`example.com` becomes `https://example.com/`) and an optional name shown instead of the address.',
  ],
  'PATCH /items/{id}/cells/{columnId}/links/{linkId}': [
    'Change a link in a cell',
    'Changes a file cell’s link: its address, its name, or both. Send only what changes; an empty name shows the address again.',
  ],
  'DELETE /items/{id}/cells/{columnId}/links/{linkId}': [
    'Remove a link from a cell',
    'Removes one link from an item’s file cell. Undo from the activity log puts it back in its place.',
  ],
  'GET /boards/{id}/files': [
    'List a board’s files',
    'Every file on a board — in file cells and updates, on items and subitems — that you may see.',
  ],
  'GET /boards/{id}/viewers': [
    'List who viewed a board',
    'Everyone who opened the board in the app, newest first: their name and photo, when they last opened it (`last_viewed_at`), when they first did, how many times (opens within 5 minutes of each other count once) and the device of the latest open. Pages of 50 by default (`limit` up to 100; pass `next_cursor` as `cursor` for the next page); `total` counts everyone. People no longer active in the account are left out. A guest sees only themselves. When the account turned "show who viewed boards" off, the list is empty and `enabled` is false.',
  ],

  // ── Folders ─────────────────────────────────────────────────────────────────────────────────────────────────
  'POST /folders': [
    'Create a folder',
    'Creates a folder in a workspace or inside another folder (up to three levels deep).',
  ],
  'PATCH /folders/{id}': ['Update a folder', 'Renames a folder or changes its colour.'],
  'DELETE /folders/{id}': [
    'Delete a folder',
    'Moves a folder and its sub-folders to the trash. The boards inside move to the workspace root.',
  ],

  // ── Maps & addresses ────────────────────────────────────────────────────────────────────────────────────────
  'GET /geo/config': ['Get map settings', 'The map style and which address lookups the account has.'],
  'PUT /geo/settings': [
    'Update map settings',
    'Sets the map tiles, extra allowed origins, geocoding and the Google key (write-only — never returned). Admins only.',
  ],
  'GET /geo/autocomplete': [
    'Suggest addresses',
    'Address suggestions for text being typed. Answers an empty list when the account has no Google key.',
  ],
  'GET /geo/places/{placeId}': ['Get a place', 'A suggested place with its full address and coordinates.'],

  // ── Groups ──────────────────────────────────────────────────────────────────────────────────────────────────
  'POST /boards/{boardId}/groups': [
    'Create a group',
    'Adds a group to a board, at the top unless you give a position.',
  ],
  'PATCH /boards/{boardId}/groups/{groupId}': ['Update a group', 'Renames a group or changes its colour.'],
  'DELETE /boards/{boardId}/groups/{groupId}': [
    'Delete a group',
    'Moves a group and its items to the trash. A board always keeps at least one group.',
  ],
  'POST /boards/{boardId}/groups/{groupId}/duplicate': [
    'Duplicate a group',
    'Copies a group right below it, with its items unless `with_items` is `false`.',
  ],
  'POST /boards/{boardId}/groups/{groupId}/move-to-board': [
    'Move a group to another board',
    'Moves a group (keeping its id) and its items to another board, in one batch. Cells follow the column mapping.',
  ],
  'POST /boards/{boardId}/groups/{groupId}/reorder': [
    'Move a group',
    'Moves a group to another position on its board.',
  ],

  // ── Items ───────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /boards/{boardId}/items': [
    'List items',
    'All items of a board with their cells, keyed by column id. Pass a saved query in `q` to filter and sort. Pass `columns=status,owner` to get only those columns in each item’s `cells` (at most 50 ids; ids the board does not have, or that you may not see, are left out). For large boards prefer **Query items**, which pages.',
  ],
  'POST /boards/{boardId}/items/find': [
    'Find items by a column value',
    'Looks items up by the value of one column — the usual "find the lead by phone or email" step of an integration. `match: exact` (default) compares phone numbers by their digits (formatting, a leading zero or a country prefix do not matter), emails case-insensitively and anything else by its text, case-insensitively; `match: contains` finds the value inside the text. Use `name` as `column_id` for the item name. Returns at most `limit` items (default 10, at most 50) in board order; archived and trashed items are left out. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'POST /boards/{boardId}/items/query': [
    'Query items',
    'Finds items with a nested AND / OR / NOT filter on any column, free-text search, a person filter and multi-level sort. Returns one page and a `next_cursor` — see **Pagination**. Forms can send flat `rules` instead — `{column_id, operator, value, choice}`, all ANDed (and with `filter`): `value` as typed (several comma-separated for `any_of` / `not_any_of`), `choice` as picked from **List column values**, which wins when set. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'GET /boards/{boardId}/items/count': [
    'Count items',
    'How many items match a query given in `q`. Limited to 10 requests a second per person.',
  ],
  'GET /boards/{boardId}/items/search': [
    'Search items by name',
    "Items of a board whose name matches — for pickers such as a relation column. With `source_board_id` and `column_id` (a connect-boards column linking to this board) only the items that column's filter offers, 30 at a time (`offset`), with how many name matches the filter hides; `ids` checks given items (which of them the filter offers).",
  ],
  'POST /boards/{boardId}/items/outline': [
    'Get a view outline',
    'For very large boards: the matching item ids per section of a view in view order, with the footer summaries, so a client can load rows on demand.',
  ],
  'POST /boards/{boardId}/items': [
    'Create an item',
    'Creates an item in a group (the first group by default), optionally with cell values keyed by column id. Each value follows its column type. On a board that computes item names from columns (`name_computed: true` on its items) `name` is optional and ignored: the name is computed from the cells you send. Instead of stored values you can send `values`: plain input keyed by column id (a status by its label, people by email or name, dates as `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, several values comma-separated), converted per column type — a value that does not fit answers `422` naming the column and its choices. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'GET /items/{id}': [
    'Get an item',
    'One item with all its cells. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'PATCH /items/{id}': [
    'Update an item',
    'Renames an item and/or sets several cells in one batch. A `null` value clears the cell. Where the board computes item names (`name_computed: true`), a different `name` answers `409 item_name_computed` with the columns the name reads (`details.refs`) — change those instead. Instead of stored values you can send `values`: plain input keyed by column id (a status by its label, people by email or name, dates as `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, several values comma-separated), converted per column type — a value that does not fit answers `422` naming the column and its choices. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'DELETE /items/{id}': [
    'Delete an item',
    'Moves an item and its subitems to the trash, where it can be restored for 30 days.',
  ],
  'PUT /items/{id}/cells/{columnId}': ['Set a cell', 'Sets one cell. The value follows the column type.'],
  'DELETE /items/{id}/cells/{columnId}': ['Clear a cell', 'Clears one cell.'],
  'GET /items/{id}/subitems': [
    'List subitems',
    'The subitems right under an item (or under a subitem), in their order, with their cells keyed by sub-board column id. Archived and trashed subitems are left out. The sub-board columns are in `subitems` of **Get the board schema**. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'POST /items/{id}/subitems': [
    'Create a subitem',
    'Adds a subitem under an item. Subitems live on the board’s sub-board with their own columns, created on first use. When the sub-board computes item names, `name` is optional and ignored. Instead of stored values you can send `values`: plain input keyed by column id (a status by its label, people by email or name, dates as `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, several values comma-separated), converted per column type — a value that does not fit answers `422` naming the column and its choices. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'POST /items/{id}/duplicate': [
    'Duplicate an item',
    'Copies an item right below it, with its subitems; with `with_updates` also its updates. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'POST /items/{id}/move-to-group': [
    'Move an item to a group',
    'Moves an item to another group of its board, or to another position. With `?format=flat` each item also carries `column_values` — its cells’ text keyed by column title.',
  ],
  'POST /items/{id}/move-to-board': [
    'Move an item to another board',
    'Moves an item with its subitems to another board. Cells follow the column mapping you send; without `mapping` the columns are mapped automatically — the same type and title, else the only column of that type.',
  ],
  'POST /items/{id}/convert': [
    'Convert an item',
    'Turns an item into a subitem of `parent_item_id`, or a subitem into an item in `group_id`. Cells follow the column mapping.',
  ],
  'POST /items/{id}/reparent': [
    'Move a subitem under another item',
    'Moves a subitem (with its own subitems) under another item or subitem of the board, at a position.',
  ],
  'POST /items/{id}/outdent': [
    'Outdent a subitem',
    'Moves a subitem one level up: under its grandparent, right after its parent.',
  ],
  'POST /items/{id}/reorder': ['Reorder a subitem', 'Moves a subitem among its siblings.'],
  'POST /items/{id}/buttons/{columnId}': [
    'Click a button',
    'Clicks a button column on an item: runs the column’s action and fires the `button.clicked` trigger for automations.',
  ],
  'GET /items/{id}/buttons/{columnId}/linked': [
    'Linked item for a button',
    'For a button that creates a linked item: the linked item its popup fills in (by the button’s “open it again” rule), or null with the values a new item starts with (copied from this item and the fixed ones).',
  ],
  'POST /items/{id}/cells/{columnId}/vote': ['Vote', 'Casts or takes back your vote in a vote column.'],
  'PUT /items/{id}/cells/{columnId}/secret': [
    'Set a secret',
    'Sets or clears the value of a secret column. The value is encrypted on the server and stored apart from the item: the item and its cell only say that a value exists, who changed it and when. Send `null` to clear it. Needs edit rights on the column. Setting a value into an empty cell needs nothing more; replacing or clearing an existing value needs a fresh two-factor code (as for a reveal — with a token, the `secrets:read` scope) unless the column’s “require a code to change or clear” setting is off.',
  ],
  'POST /items/{id}/cells/{columnId}/secret/reveal': [
    'Reveal a secret',
    'Returns the value of a secret column once. With a token, the token needs the `secrets:read` scope (not included in any other scope, `admin` neither) and its person needs two-factor authentication turned on and must be allowed by the column. Every reveal is in the audit log; the answer is never cached.',
  ],
  'POST /items/{id}/cells/{columnId}/secret/copy': [
    'Record a secret copy',
    'Records that a revealed secret was copied to the clipboard (audit log). Refused when the column does not allow copying. Needs the `secrets:read` scope.',
  ],
  'GET /secrets/log': [
    'Get the secrets log',
    'Who revealed, copied, set or cleared which secret and when, newest first, with filters by person, board, action and dates. Admins only. Never contains a value.',
  ],
  'POST /updates/{id}/reveal': [
    'Reveal a secret update',
    'Returns the text of a secret update or reply once (its HTML, plain text and editor document). In the thread a secret update has an empty body and `secret: true`. With a token, the token needs the `secrets:read` scope (not included in any other scope, `admin` neither) and its person needs two-factor authentication turned on and must be allowed by the board’s secret-update settings. Guests never reveal. Every reveal is in the audit log; the answer is never cached.',
  ],
  'POST /updates/{id}/secret-copy': [
    'Record a secret update copy',
    'Records that a revealed secret update was copied to the clipboard (audit log). Refused when the board’s settings do not allow copying. Needs the `secrets:read` scope.',
  ],
  'GET /boards/{id}/secret-updates': [
    'Get the secret-update settings of a board',
    'Whether people may write secret updates on this board and how they are revealed: what applies here (`effective`), the account’s default (`account`) and the board’s own settings (`board`, null when it follows the account). A subitems board answers its parent board’s. Changing them is done in the app, with a fresh two-factor code.',
  ],
  'POST /boards/{boardId}/items/bulk': [
    'Bulk action on items',
    'Runs one action (move, archive, delete, set a cell …) on up to 5,000 items in one batch. Items you may not change are skipped and counted. Undo the whole batch with **Undo a batch**.',
  ],
  'POST /boards/{boardId}/items/bulk-query': [
    'Bulk action on a query',
    'Runs one action on every item matching a query — up to 50,000 items — in one batch.',
  ],
  'POST /boards/{boardId}/items/bulk-edit': [
    'Bulk edit or import',
    'Imports or edits up to 10,000 rows in one batch: creates the new columns, labels and tags it needs, then updates existing items and creates new ones. Secret columns take values in `rows[].secrets` (encrypted, never returned); a cell that already holds a secret is replaced only with `secrets_mode: "replace"`, which may need a fresh two-factor code (a token: the `secrets:read` scope). Replaced secrets do not come back with undo.',
  ],
  'POST /boards/{boardId}/items/bulk-edit/{batchId}/undo': [
    'Undo a bulk edit',
    'Reverts a bulk edit: cells and names go back, new items and columns go to the trash, new labels are removed.',
  ],
  'POST /boards/{boardId}/export': [
    'Export a board',
    'Downloads the board — a view’s query and columns, or selected items — as Excel (.xlsx) or CSV.',
  ],
  'GET /boards/{id}/update-counts': [
    'Count updates per item',
    'The number of top-level updates on each item of the board that you may see.',
  ],

  // ── Me ──────────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /auth/me': [
    'Get the current identity',
    'Who the token acts as: the person (or service identity), the account, how you authenticated and your scopes. A good first call to check a token.',
  ],
  'GET /me/favorites': [
    'List favourites',
    'Your favourite boards, docs and dashboards in this account, in your order.',
  ],
  'PUT /me/favorites': [
    'Set favourites',
    'Replaces your favourites with the list you send, in that order. Things you cannot open are dropped.',
  ],
  'GET /me/favorite-boards': [
    'List favourite boards',
    'Your favourite boards in your order — only boards you can still open.',
  ],
  'PUT /me/favorite-boards': [
    'Set favourite boards',
    'Replaces your favourite boards, in order. Boards you cannot open are dropped.',
  ],
  'GET /me/favorite-docs': ['List favourite docs', 'Your favourite docs in your order — only docs you can still open.'],
  'PUT /me/favorite-docs': ['Set favourite docs', 'Replaces your favourite docs, in order.'],
  'GET /me/export': [
    'Download my personal data',
    'Everything the platform holds about you, as one JSON file (an access / portability request): your profile, the accounts you belong to, the legal documents you accepted, your sign-ins and sessions, your API tokens (names and prefixes only), the updates you wrote, your time entries, files you uploaded, your notifications and your security log. No secret is ever included. Five a hour; audited in each of your accounts.',
  ],
  'GET /me/erasure-request': [
    'Get my erasure request',
    'Whether you asked for your details to be deleted, the accounts the request is pending in, and whether you belong to any account at all.',
  ],
  'POST /me/erasure-request': [
    'Ask for my details to be deleted',
    'The right to erasure. Send your own email address in `confirm_email`. In each account you belong to the request is recorded and the account’s admins are emailed; they carry it out by deactivating you and deleting your details. If you belong to no account, your details are deleted at once and you are signed out. Platform owners and support staff cannot use this; they write to the privacy address.',
  ],
  'DELETE /me/erasure-request': ['Withdraw my erasure request', 'Withdraws a pending request in every account.'],
  'GET /me/appearance': [
    'Get my text size and density',
    'Your text size (`small`, `normal`, `large`, `xlarge`) and table density (`compact`, `normal`, `comfortable`) in the app, on every device, your icon style (`icon_style`: `duo`, `line`, `solid`, `sharp`, `bold` or `accent`) and what a click on an email address does (`email_open`: `ask` for a menu, `gmail`, `outlook` or `mailto`). `user` is what you chose yourself; send `X-Account-Id` to also get that account’s default, which applies to whatever you did not choose.',
  ],
  'PUT /me/appearance': [
    'Set my text size and density',
    'Sets your text size, table density, icon style and / or email click. Send only what you want to change; `null` goes back to the default.',
  ],
  'GET /me/nav': [
    'Get my sidebar and top bar layout',
    'Where each of the app’s general places sits for you in this account on a computer: the sidebar (`side`), the top bar (`top`) or nowhere (`hidden` — also not on a phone; every place but `account` can be hidden). Places: `account`, `home`, `my_work`, `inbox`, `automations`, `flows`, `agents`, `search`, `assistant`, `help`, `bell`. `layout` is what applies, `mine` is your own choice (`null` = you follow the account), and `account` is the account’s default with `locked` (when true, everyone follows it).',
  ],
  'PUT /me/nav': [
    'Set my sidebar and top bar layout',
    'Sets your own layout in this account. Send `placement` with any of the places; a place you leave out follows the account’s default. `null` goes back to the account’s layout. Refused while the account’s layout is locked.',
  ],
  'GET /me/phone-actions': [
    'Get my phone click preference',
    'What a click on a phone number does for you: `click` (`menu`, `column_default`, or one action — `whatsapp`, `telegram`, `call`, `sms`, `copy`), `whatsapp_desktop` (`auto` = wa.me, `app`, `web`) and `sms_mobile` (`ask`, `system`, `device`). `user` is what you chose yourself; the rest are defaults.',
  ],
  'PUT /me/phone-actions': [
    'Set my phone click preference',
    'Sets what a click on a phone number does for you. Send only what you want to change; `null` goes back to the default.',
  ],

  // ── My work ─────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /me/work': [
    'Get my work',
    'Items assigned to you or your teams across boards, in deadline sections (overdue, today, this week …).',
  ],
  'PATCH /me/work/settings': [
    'Update my work settings',
    'Changes how My Work is built: hide done items, grouping, and per board which date and status columns count or whether the board is hidden.',
  ],

  // ── Notifications ───────────────────────────────────────────────────────────────────────────────────────────
  'GET /me/notifications': ['List notifications', 'Your notifications, newest first, with the unread count.'],
  'POST /me/notifications/read': [
    'Mark notifications read',
    'Marks some notifications (`ids`) or all of them (`all: true`) as read.',
  ],
  'GET /me/notifications/settings': [
    'Get notification settings',
    'Your notification settings in this account: bell and email per category, the email digest and muted boards.',
  ],
  'PATCH /me/notifications/settings': ['Update notification settings', 'Changes some categories and/or the digest.'],
  'GET /boards/{boardId}/notifications': [
    'Get board notification settings',
    'Whether you muted a board, and whether its owners muted it for everyone.',
  ],
  'PUT /boards/{boardId}/notifications': [
    'Mute a board',
    'Mutes or unmutes a board’s notifications for you. Board owners and admins can mute it for everyone (`muted_for_everyone`).',
  ],
  'GET /items/{id}/follow': ['Get follow state', 'Whether you follow an item — followers are notified of its updates.'],
  'PUT /items/{id}/follow': [
    'Follow an item',
    'Follows or unfollows an item. An unfollow is remembered, so you are not added back automatically.',
  ],
  'GET /me/inbox': [
    'List inbox',
    'Updates and replies on items you follow, and mentions of you, from the last 6 months, newest first.',
  ],
  'GET /me/inbox/count': ['Count unread inbox entries', 'The number of unread inbox entries, counted up to 100.'],
  'POST /me/inbox/read': [
    'Mark inbox entries read',
    'Marks some inbox entries (`ids`) or all of them (`all: true`) as read, with their notifications.',
  ],

  // ── Board permissions ───────────────────────────────────────────────────────────────────────────────────────
  'GET /boards/{boardId}/permissions': [
    'Get board permissions',
    'The board’s permission set, which items each person sees, its owners and subscribers, and its restricted columns.',
  ],
  'PUT /boards/{boardId}/permissions': [
    'Update board permissions',
    'Changes the permission set and/or who sees which items. Board owners and admins.',
  ],
  'PUT /boards/{boardId}/members/{userId}': [
    'Add a board member',
    'Subscribes a member to a board as owner or subscriber, optionally with an explicit role. A board always keeps an owner.',
  ],
  'DELETE /boards/{boardId}/members/{userId}': [
    'Remove a board member',
    'Removes a member from a board, or leaves it yourself.',
  ],
  'PUT /boards/{boardId}/teams/{teamId}': [
    'Add a team to a board',
    'Subscribes a team (all its members) as owner or subscriber, optionally with an explicit role.',
  ],
  'DELETE /boards/{boardId}/teams/{teamId}': ['Remove a team from a board', 'Unsubscribes a team from a board.'],
  'POST /boards/{boardId}/invite': [
    'Invite to a board',
    'Invites people by email: account members are subscribed at once; new people get an invitation.',
  ],
  'POST /boards/{boardId}/claim': [
    'Claim a board',
    'An admin takes ownership of a board no owner can act on. Answers `409` when the board has an active owner.',
  ],

  // ── Real-time events ────────────────────────────────────────────────────────────────────────────────────────
  'GET /boards/{boardId}/events': [
    'Stream board events',
    'A Server-Sent Events stream of changes on a board and its subitems. Reconnect with `Last-Event-ID` to replay what you missed (up to 24 hours).',
  ],
  'GET /dashboards/{dashboardId}/events': [
    'Stream dashboard events',
    'A Server-Sent Events stream that signals when a dashboard or one of its boards changed, so you can reload the widgets.',
  ],
  'GET /me/events': [
    'Stream my events',
    'A Server-Sent Events stream of events addressed to you in this account, such as new notifications. `account.plan_changed` (type only) says the plan status of the account may have changed: reload `GET /me/accounts`.',
  ],

  // ── Search ──────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /search': [
    'Search',
    'Items (by name or cell text), boards, updates and people matching `q` (at least 2 characters), within your access.',
  ],
  'GET /search/recent': ['List recent searches', 'Your recent searches in this account, newest first.'],
  'POST /search/recent': ['Save a recent search', 'Remembers a search; an existing one moves to the top.'],
  'DELETE /search/recent': ['Clear recent searches', 'Forgets your recent searches.'],

  // ── Security ────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /security': [
    'Get security settings',
    'Allowed email domains, auto-join, the guest domain policy and other account security settings. Admins only.',
  ],
  'GET /security/domain-join': [
    'Get domain join status',
    "Each of the account's domains with its verification (and the DNS TXT record that verifies it), auto-join and its role, whether the platform's sign-up is open, and the sign-up link to share. People with an address at a verified domain join the account by themselves when auto-join is on. Admins only.",
  ],
  'POST /security/domain-join/domains/{domain}/verify': [
    'Verify a domain',
    "Verifies one of the account's domains for joining: at once when the admin's own verified address is at it, else by its DNS TXT record. Free mailbox domains are refused; a domain another account verified cannot be verified twice. Admins only.",
  ],
  'PATCH /security': [
    'Update security settings',
    'Changes the account’s security settings. Recorded in the audit log. Admins only.',
  ],
  'GET /security/sessions': ['List sign-ins', 'Active sign-ins of the account’s people. Admins only.'],
  'DELETE /security/sessions/{id}': [
    'Sign out a session',
    'Signs out one sign-in (not your current one). Admins only.',
  ],
  'POST /security/sessions/sign-out-all': [
    'Sign out everyone',
    'Signs out every sign-in of the account’s people except yours. Admins only.',
  ],
  'GET /security/captcha': [
    'Get the CAPTCHA settings',
    'The account’s Cloudflare Turnstile: site key, whether a secret is set (never the secret itself), the master switch and the public places it protects. Admins only.',
  ],
  'PATCH /security/captcha': [
    'Update the CAPTCHA settings',
    'Changes the account’s Cloudflare Turnstile. Turning it on needs both keys. Recorded in the audit log. Admins only.',
  ],

  // ── System ──────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /health': ['Health check', 'Answers `200` with `{"status": "ok"}` while the service is up. No authentication.'],
  'GET /setup': [
    'First-run setup status',
    'Whether the installation still needs its owner account (no user exists yet). No authentication.',
  ],
  'POST /setup': [
    'Create the owner account',
    'Creates the platform owner and the first account’s admin, and signs them in. Works once, only while no user exists (afterwards `409 setup_done`). No authentication.',
  ],

  // ── Tags ────────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /tags': ['List tags', 'The account’s tags, used by tags columns.'],
  'POST /tags': ['Create a tag', 'Creates a tag, or returns the existing tag with the same name.'],

  // ── Teams ───────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /teams': ['List teams', 'The account’s teams with their members.'],
  'POST /teams': ['Create a team', 'Creates a team. Admins only.'],
  'PATCH /teams/{id}': ['Update a team', 'Renames a team, changes its colour or replaces its members. Admins only.'],
  'DELETE /teams/{id}': ['Delete a team', 'Deletes a team. Admins only.'],

  // ── Administration ──────────────────────────────────────────────────────────────────────────────────────────
  'GET /admin/boards': [
    'List all boards',
    'Every board of the account with its owners, item count and last change — private boards as metadata only. Admins only.',
  ],
  'POST /admin/boards/{id}/archive': ['Archive any board', 'Archives a board. Recorded in the audit log. Admins only.'],
  'DELETE /admin/boards/{id}': [
    'Delete any board',
    'Moves a board to the trash. Recorded in the audit log. Admins only.',
  ],
  'POST /admin/boards/{id}/transfer-ownership': [
    'Transfer board ownership',
    'Makes an active member the owner of a board. Recorded in the audit log. Admins only.',
  ],
  'GET /admin/tidy/rules': [
    'Get clean-up rules',
    'The scheduled clean-up rules (with their defaults) and the last run. Admins only.',
  ],
  'PUT /admin/tidy/rules': [
    'Update clean-up rules',
    'Changes clean-up rules — only the rules you send change. Recorded in the audit log. Admins only.',
  ],
  'POST /admin/tidy/preview': [
    'Preview a clean-up',
    'A dry run: what the enabled rules (or the ones named) would do now — counts and a sample. Admins only.',
  ],
  'POST /admin/tidy/run': [
    'Run a clean-up',
    'Runs the enabled clean-up rules now. Recorded in the audit log. Admins only.',
  ],
  'GET /admin/tidy/runs': ['List clean-up runs', 'The latest clean-up runs. Admins only.'],
  'GET /admin/tidy/runs/{id}/export.csv': [
    'Export a clean-up run',
    'What one clean-up run touched, as CSV. Admins only.',
  ],

  // ── Time tracking ───────────────────────────────────────────────────────────────────────────────────────────
  'POST /items/{id}/time/start': [
    'Start a timer',
    'Starts your timer on an item’s time-tracking cell. Your timers elsewhere keep running; starting a running timer changes nothing.',
  ],
  'POST /items/{id}/time/stop': [
    'Stop a timer',
    'Stops your running timer on an item — on one column, or all of them.',
  ],
  'GET /me/time/running': ['List my running timers', 'All your running timers in this account.'],
  'GET /items/{id}/time/entries': ['List time entries', 'An item’s time log, newest first.'],
  'GET /items/{id}/time/entries.csv': ['Export time entries', 'An item’s time log as CSV.'],
  'POST /items/{id}/time/entries': [
    'Add a time entry',
    'Adds a manual time entry with a start and an end, or a start and a duration. Up to 24 hours, not in the future.',
  ],
  'PATCH /time/entries/{id}': [
    'Update a time entry',
    'Edits a time entry — your own, or anyone’s for board owners and admins. The entry is marked as edited.',
  ],
  'DELETE /time/entries/{id}': ['Delete a time entry', 'Deletes a time entry (to the trash).'],
  'GET /boards/{boardId}/time/report': [
    'Get a time report',
    'Time tracked on a board and its subitems, by person, item or day, over local days.',
  ],
  'GET /boards/{boardId}/time/report.csv': [
    'Export a time report',
    'The report’s entries as CSV, one row per entry with decimal hours — ready for billing.',
  ],

  // ── Trash ───────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /trash': [
    'List the trash',
    'What is in the trash: everything for admins, your own deletions for everyone else.',
  ],
  'POST /trash/{id}/restore': [
    'Restore from the trash',
    'Puts something back where it was. Answers `409 parent_in_trash` while its board, item or folder is in the trash.',
  ],
  'DELETE /trash/{id}': [
    'Delete permanently',
    'Deletes something in the trash for good; it is removed by the next purge.',
  ],
  'DELETE /trash': ['Empty the trash', 'Empties the account’s trash. Admins only.'],

  // ── Updates ─────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /items/{id}/updates': [
    'List updates',
    'An item’s updates thread: updates newest first, their replies oldest first.',
  ],
  'POST /items/{id}/updates': [
    'Post an update',
    'Posts an update on an item. Mention people as `[@Name](user:<id>)` — they are notified. Attach uploaded files with `file_ids`.',
  ],
  'POST /updates/{id}/replies': ['Reply to an update', 'Posts a reply to an update.'],
  'POST /items/{id}/sms': [
    'Send an SMS',
    'Sends an SMS to the number in a phone column of the item (`column_id`) through the account’s SMS provider, and logs it as an update on the item (`source: "sms"`). Send `text`, or `template_id` — one of the account’s SMS templates, filled from the item (`{item.name}`, `{item.<column>}`; only columns you can see). `dry_run: true` returns the number (E.164) and the text without sending. Who may send is an account setting (guests never); sends are limited per person per hour and per account per day (`429`). A number the provider cannot deliver to returns `422 sms_unsupported_number` (the current provider sends to Israeli mobiles only).',
  ],
  'GET /sms/status': [
    'Get the SMS status',
    'Whether you may send SMS from items (`can_send`, and `reason` when not), whether the provider is set up, the account’s SMS templates, the budgets and how much of them is used.',
  ],
  'PATCH /updates/{id}': [
    'Edit an update',
    'Edits one of your updates or replies: its text (left out = unchanged), files to attach (`file_ids`, your own uploads) and attached files to take off (`remove_file_ids`).',
  ],
  'PUT /updates/{id}/tasks/{index}': [
    'Tick a check box in an update',
    'Ticks or clears one check box of an update or reply (`index` from 0, in the order they appear). Anyone who may comment on the item, not only its author; only that box changes and the update is not marked edited.',
  ],
  'DELETE /updates/{id}': ['Delete an update', 'Deletes an update. Its author, board owners or admins.'],
  'DELETE /updates/{id}/files/{fileId}': [
    'Remove a file from an update',
    'Removes a file attached to an update. Its author, board owners or admins.',
  ],
  'POST /updates/views': [
    'Report seen updates',
    'Tells the server which updates and replies you just saw on screen (up to 100 at a time), for their "seen by" list. The device (desktop, phone, tablet) and a short browser/OS label come from the request headers. Your own updates, and ones you cannot read, are skipped. Seeing one again only moves its time.',
  ],
  'GET /updates/{id}/views': [
    'List who saw an update',
    'Everyone who saw an update or reply, newest first, with each device they saw it on and when. Updates carry the first 20 of them in `seen`. Empty when the account turned "show who viewed updates" off; not for guests.',
  ],
  'POST /updates/{id}/like': ['Like an update', 'Likes an update.'],
  'DELETE /updates/{id}/like': ['Unlike an update', 'Takes back your like.'],
  'PUT /updates/{id}/reactions/{reaction}': ['Add a reaction', 'Adds your reaction to an update.'],
  'DELETE /updates/{id}/reactions/{reaction}': ['Remove a reaction', 'Removes your reaction from an update.'],
  'GET /items/{id}/activity': [
    'List item activity',
    'What changed on an item, by whom and when. Not available to guests.',
  ],
  'GET /boards/{id}/activity': [
    'List board activity',
    'A board’s activity log, including its subitems, newest first, 100 entries a page (pass `next_before` as `before` for the next one). A batch (a bulk edit, an automation run) is one entry. Each entry carries the value `before` and `after` the change. Filters, combined: `actor_id` (a member’s id, or `system` for automations and the system), `column` (a column key), `type` (event types, comma-separated, e.g. `cell.changed,item.renamed`), `from` / `to` (inclusive days, `YYYY-MM-DD`, UTC) and `q` (free text over the item’s name, the person, the column and the values). Not available to guests.',
  ],

  // ── Usage ───────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /usage': ['Get account usage', 'The account’s usage over the last N days (30 by default). Admins only.'],

  // ── Members ─────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /users': ['List members', 'People of the account. Filter by role, status, team or text (`q`).'],
  'GET /users/export.csv': ['Export members', 'The people of the account as CSV. Admins only.'],
  'GET /users/me': [
    'Get my profile',
    'Your profile: name, job title, phone, department, birthday, language, time zone and photo.',
  ],
  'PATCH /users/me': ['Update my profile', 'Changes any part of your profile. An empty text clears that field.'],
  'PUT /users/me/avatar': ['Set my photo', 'Sets your profile photo from an uploaded image (up to 5 MB).'],
  'DELETE /users/me/avatar': ['Remove my photo', 'Removes your profile photo.'],
  'PATCH /users/{id}': [
    'Update a member',
    'Changes a member’s role, name, job title, department or phone. Admins only; you cannot change your own role.',
  ],
  'POST /users/invite': [
    'Invite members',
    'Invites people by email with a role (admin, member, viewer or guest). Who may invite which role follows the account’s settings. Each invitation is emailed unless `send_email` is false; the answer carries every new link to copy.',
  ],
  'GET /users/invitations': [
    'List invitations',
    'Open invitations — pending and expired — with their status (link, sent, failed, opened, expired), who invited, and when the email last went out. Admins only.',
  ],
  'DELETE /users/invitations/{id}': [
    'Revoke an invitation',
    'Cancels an open invitation: its link stops working at once. Admins only.',
  ],
  'POST /users/invitations/{id}/resend': [
    'Resend an invitation',
    'Emails the same invitation again with a fresh link (the earlier link stops working), valid `expires_in_days` (default: the account’s setting). Waits the account’s resend interval and counts in the hourly email budget. Admins only.',
  ],
  'POST /users/invitations/{id}/link': [
    'Get an invitation link',
    'A fresh invitation link to send another way (a chat message, for example); the earlier link stops working. Nothing is emailed. Admins only.',
  ],
  'POST /users/bulk': [
    'Bulk action on members',
    'One action — change role, deactivate, activate or resend the invitation — on up to 200 people (not yourself).',
  ],
  'POST /users/{id}/deactivate': [
    'Deactivate a member',
    'Deactivates a member: their sign-ins and tokens stop. Optionally transfers what they own to another member first, in the same transaction.',
  ],
  'POST /users/{id}/activate': ['Activate a member', 'Activates a deactivated member again.'],
  'POST /users/{id}/transfer-ownership': [
    'Transfer ownership',
    'Moves a member’s boards, automations, webhooks, service tokens and (optionally) people assignments to another member.',
  ],
  'GET /users/{id}/export': [
    'Export a member’s personal data',
    'An account admin answers a member’s access request: the member’s data in this account only, as one JSON file (profile, membership, API tokens, updates, time entries, files, notifications, security log). Sessions and consents are the person’s own and are left out. Audited as `user.data_exported`.',
  ],
  'DELETE /users/{id}/details': [
    'Delete a member’s details',
    'Anonymises a deactivated member: their personal details are deleted; their content stays. Cannot be undone.',
  ],

  // ── Views ───────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /boards/{boardId}/views': [
    'List views',
    'The board’s views you can see — shared ones and your private ones — with your personal preferences and the view to open.',
  ],
  'POST /boards/{boardId}/views': [
    'Create a view',
    'Creates a view on a board (table, kanban, calendar, chart …) with its settings.',
  ],
  'PATCH /views/{id}': [
    'Update a view',
    'Saves a view’s settings, renames, locks, reorders or shares it, or makes it the board’s default. Send `If-Match` when changing settings.',
  ],
  'DELETE /views/{id}': ['Delete a view', 'Deletes a view. The main table cannot be deleted.'],
  'POST /views/{id}/duplicate': ['Duplicate a view', 'Copies a view on its board, or onto another board (`board_id`).'],
  'GET /views/{id}/form': [
    'Get a form',
    'The form of a form view: its questions (board columns), texts, access, limits, embedding and anti-spam settings, the public link token and the number of submissions. A new form view gets a form with defaults on first read.',
  ],
  'PATCH /views/{id}/form': [
    'Update a form',
    'Saves any part of a form. Questions must refer to columns of the board that a form can fill; a condition refers to an earlier shown question. The Turnstile secret is write-only (`null` removes it).',
  ],
  'POST /views/{id}/form/token': [
    'Replace the public link',
    'Gives the form a new unguessable token; the old link stops working at once.',
  ],
  'GET /public/forms/{token}': [
    'Read a public form',
    'What the public page shows: the configured questions and labels only. No token needed; a members-only form needs a signed-in member. A closed form answers `form_closed`; an unknown or disabled one 404.',
  ],
  'POST /public/forms/{token}/uploads': [
    'Upload a file for a form',
    'Starts an upload for a file question: checks the question’s size and type limits and returns a presigned PUT. Send the returned `upload_id` with the answers. Rate-limited per client address.',
  ],
  'GET /public/forms/{token}/questions/{questionId}/options': [
    'List the items of a connect-boards question',
    'One page (30) of the items a connect-boards question offers, by name (`q`), from one of its linked boards (`board`, an index; `offset` for the next page). Only each item’s id and name. A list for members needs a signed-in member who may read the linked board; otherwise 404. Rate-limited per client address.',
  ],
  'POST /public/forms/{token}/submit': [
    'Submit a form',
    'Validates every answer on the server (required, conditions, column types, files) and creates an item on the board through the normal items service, so automations and webhooks fire. Rate-limited per client address and per form; honeypot and optional Turnstile.',
  ],
  // ── Interactive documents ──
  'GET /idoc-templates': [
    'List document templates',
    'The account’s interactive document templates (and, with `board_id`, that board’s own). Board templates of boards you cannot open are left out.',
  ],
  'POST /idoc-templates': [
    'Create a template',
    'A blank template, or one started from a built-in starter (`starter`), a copy of another template (`from_template_id`) or of a document (`from_doc_id`). Members and admins only.',
  ],
  'GET /idoc-templates/{id}': ['Get a template', 'Its sections (each with its settings) and the document settings.'],
  'PATCH /idoc-templates/{id}': ['Change a template', 'Name, board, sections and settings. Its creator or an admin.'],
  'DELETE /idoc-templates/{id}': ['Delete a template', 'Documents made from it keep their own copy.'],
  'GET /items/{id}/idocs': [
    'List an item’s documents',
    'Status (draft, sent, viewed, signed, expired, revoked), version, views and the signature summary. The public `url` only for people who may edit the item.',
  ],
  'POST /items/{id}/idocs': [
    'Make a document',
    'A copy of a template (or starter) for this item, as a draft with its own unguessable public link. Needs edit rights on the item.',
  ],
  'GET /idocs/{id}': [
    'Get a document',
    'The document’s own sections and settings, status, version, link and signature summary.',
  ],
  'PATCH /idocs/{id}': [
    'Change a document',
    'Name, sections and settings. A signed document that locks after signing answers `idoc_signed` until it is reopened.',
  ],
  'DELETE /idocs/{id}': ['Delete a document', 'A signed document is evidence: only an admin deletes it.'],
  'POST /idocs/{id}/send': [
    'Send a document',
    'Emails the link to the contact (the document’s email column, or `email`), or only marks it sent (`no_email`), and opens the link for the document’s set number of days.',
  ],
  'POST /idocs/{id}/token': ['Replace the link', 'A new public token; the old link stops working at once.'],
  'POST /idocs/{id}/revoke': [
    'Close the link',
    'The page then shows that the document is closed. Reopen to open it again.',
  ],
  'POST /idocs/{id}/reopen': [
    'Reopen a document',
    'Opens a signed, closed or expired document again; a signed one gets a new version and must be signed again.',
  ],
  'GET /idocs/{id}/events': [
    'A document’s log',
    'Sent, opened, choices, inputs, questions, code checks, signing, reopening — with who, when and the client address.',
  ],
  'GET /idocs/{id}/pdf': [
    'Download a document as PDF',
    'The same file the client downloads: before signing, the page as the client sees it now (choices, totals, questions), every page marked unsigned; once signed, exactly what was signed, with the signature and a certificate page. Hebrew right to left, the document’s colours, rows never split across pages. Up to 60 pages (413 above that). Anyone who may see the document.',
  ],
  'POST /idocs/{id}/preview': [
    'Preview a document',
    'The page as the client would see it, with unsaved sections / settings, read with your own rights (the builder’s preview).',
  ],
  'GET /signatures/{id}': [
    'Get a signature certificate',
    'Signer, identity check, server time, IP and browser, consents, what was signed (choices and totals), the SHA-256 of the signed content and the document’s log.',
  ],
  'GET /public/idocs/{token}': [
    'Read a public document',
    'What the page shows: sections with merged texts, rows with opaque keys, totals’ inputs and the question threads started on the page. `state` = verify asks for the one-time code first (send the key in `X-Idoc-Key`). No internal ids.',
  ],
  'POST /public/idocs/{token}/verify': [
    'Send a one-time code',
    'Emails a 6-digit code to the document’s contact. A few per hour.',
  ],
  'POST /public/idocs/{token}/verify/check': [
    'Check the code',
    'Answers the visitor key (for `X-Idoc-Key`, valid for hours). Limited attempts.',
  ],
  'POST /public/idocs/{token}/select': [
    'Tick a row',
    'Ticks / unticks a row or changes its quantity under the section’s rules (fixed, one of, required rows); writes the item’s columns and totals.',
  ],
  'POST /public/idocs/{token}/inputs': [
    'Save the client’s details',
    'Writes the inputs of a section into the item’s columns (validated per column type).',
  ],
  'POST /public/idocs/{token}/questions': [
    'Ask a question',
    'Becomes an update on the item (source `document`, no author) — or a reply in one of this document’s threads.',
  ],
  'POST /public/idocs/{token}/sign': [
    'Approve / sign',
    'Checks the consents, drawing and required inputs, stores the evidence and the SHA-256 of what was signed, locks the document, writes the signature / status / files columns and emails the signer a copy. Only the first signature of a version counts.',
  ],
  'GET /public/idocs/{token}/pdf': [
    'Download a public document as PDF',
    'The client’s PDF: what the page shows now, marked unsigned — or, once signed, what was signed with its certificate. Not for a closed or expired link; asks for the one-time code first when the document does (the visitor key in `X-Idoc-Key` or `?k=`). Rate-limited per document and client address; logged as `downloaded`.',
  ],
  'GET /public/idocs/{token}/files/{ref}': [
    'A document’s file',
    'Redirects to a short-lived link of a file the page shows (logo, images, attachments). The visitor key may come as `?k=`.',
  ],
  // ── Help center ─────────────────────────────────────────────────────────────────────────────────────────────
  'GET /legal': [
    'List legal documents',
    'The published legal documents (terms of service, privacy policy, acceptable use, cookies, licenses, responsible AI …): slug, title in Hebrew and English, the current version and whether people must accept it. No token needed; rate-limited per client address.',
  ],
  'GET /legal/sub-processors': [
    'List the sub-processors',
    'The services that process personal data on the operator’s behalf (name, purpose in both languages, data location, link to their processing terms), as the platform owner published them. Empty when none are published. No token needed; rate-limited per client address.',
  ],
  'GET /legal/{slug}': [
    'Read a legal document',
    'One published legal document in the requested `locale` (`he` or `en`), rendered to HTML with its headings for a table of contents, the current version and its publish date. No token needed; rate-limited per client address.',
  ],
  'GET /help/center': [
    'Read the help center',
    'The public help center’s name, logo and categories. No token needed. 404 when the platform turned the help center (or its public part) off. Rate-limited per client address.',
  ],
  'GET /help/articles': [
    'Search help articles',
    'Searches the published help articles marked for everyone (`q`; Hebrew prefixes are understood, so “ללוח” finds “לוח”), or lists a category (`category_id`). Results in the requested `locale` first. A signed-in person also finds the articles for signed-in users. No token needed; rate-limited per client address.',
  ],
  'GET /help/articles/{slug}': [
    'Read a help article',
    'One published help article by its slug (or id), rendered as safe HTML, with links to its other languages. Drafts are never returned; articles for signed-in users only with a session. No token needed; rate-limited per client address.',
  ],
  'GET /help/assets/{id}': [
    'Read a help article image',
    'Redirects to a short-lived link of an image used in help articles. No token needed; rate-limited per client address.',
  ],
  'POST /views/{id}/open': ['Mark a view as opened', 'Remembers this view as the one you opened last on its board.'],
  'PUT /views/{id}/prefs': [
    'Save my view preferences',
    'Saves your personal overrides of a view (column widths, collapsed groups, wrapping); merged with what is stored.',
  ],
  'DELETE /views/{id}/prefs': ['Reset my view preferences', 'Drops your personal overrides of a view.'],
  'PUT /boards/{boardId}/views/layout': [
    'Save my view tabs',
    'Saves your personal tab layout on a board: pinned views first, then your order.',
  ],
  'POST /boards/{id}/chart': ['Get chart data', 'Chart data of a board under a query — what a chart view shows.'],
  'POST /boards/{id}/widget-data': [
    'Get dashboard view widget data',
    "One widget of a board's dashboard view: its items and / or subitems, under the view's filter when sent.",
  ],
  'POST /boards/{id}/widget-items': [
    'List the items behind a dashboard view widget value',
    "The items a clicked value of a board dashboard view's widget is made of, under the view's filter when sent.",
  ],
  'GET /boards/{id}/widget-columns': [
    'List dashboard view columns',
    "The board's and its subitems' columns you may see, merged by type and title (for widget settings).",
  ],

  // ── Webhooks ────────────────────────────────────────────────────────────────────────────────────────────────
  'GET /boards/{boardId}/webhooks': ['List webhooks', 'The board’s webhooks. Board owners and admins.'],
  'POST /boards/{boardId}/webhooks': [
    'Create a webhook',
    'Subscribes a URL to one event of a board. The URL must first answer the challenge — see **Webhooks**. The response includes the signing secret. With `config.format: "flat"` each event also carries `deliveryId`, and an included item `column_values` (its cells’ text keyed by column title) — for integrations that cannot read headers or reshape the item themselves.',
  ],
  'GET /webhooks/{id}': [
    'Get a webhook',
    'One webhook with its event, filter, state and signing secret — an integration checks with it that its subscription still exists.',
  ],
  'PATCH /webhooks/{id}': [
    'Update a webhook',
    'Changes the URL (the new URL must answer the challenge again), configuration or description, or switches the webhook on or off.',
  ],
  'DELETE /webhooks/{id}': ['Delete a webhook', 'Deletes a webhook; no more calls are made.'],
  'POST /webhooks/{id}/rotate-secret': [
    'Rotate a webhook secret',
    'Creates a new signing secret. Calls from now on are signed with it.',
  ],
  'GET /webhooks/{id}/deliveries': [
    'List deliveries',
    'The webhook’s delivery log, newest first: status, attempts and responses.',
  ],
  'POST /webhooks/deliveries/{id}/redeliver': ['Redeliver', 'Sends a delivery again now.'],
  'POST /webhooks/{id}/test': ['Send a test event', 'Sends a synthetic test event to the webhook’s URL.'],

  // ── Incoming email ──────────────────────────────────────────────────────────────────────────
  'GET /items/{id}/email-address': [
    'Get an item’s email address',
    'The item’s address (`address`), or null until someone makes it. `off` says why there is none: `platform` (no inbound domain on the platform) or `account` (incoming email is off in Administration → Connections). Whoever may comment on the item.',
  ],
  'POST /items/{id}/email-address': [
    'Create an item’s email address',
    'Makes the item’s address on first use and returns it (the same one on later calls). Mail sent to it becomes an update on the item, with its attachments; mail from someone outside the account shows their address and has no author. `403` while incoming email is off.',
  ],
  'POST /items/{id}/email-address/rotate': [
    'Replace an item’s email address',
    'A new random address; the old one stops working at once and for good (mail to it is dropped).',
  ],
  'DELETE /items/{id}/email-address': [
    'Remove an item’s email address',
    'Retires the address; mail to it is dropped. A new one can be made again later.',
  ],
  'GET /boards/{id}/email-address': [
    'Get a board’s email address',
    'The board’s address, or null until someone makes it (`off` as for items). Whoever may create items on the board.',
  ],
  'POST /boards/{id}/email-address': [
    'Create a board’s email address',
    'Makes the board’s address on first use. Mail sent to it opens a new item named by the subject, with the message as its first update.',
  ],
  'POST /boards/{id}/email-address/rotate': [
    'Replace a board’s email address',
    'A new random address; the old one stops working at once and for good.',
  ],
  'DELETE /boards/{id}/email-address': [
    'Remove a board’s email address',
    'Retires the address; mail to it is dropped.',
  ],

  // ── Workspaces ──────────────────────────────────────────────────────────────────────────────────────────────
  'GET /workspaces': ['List workspaces', 'The workspaces you can see.'],
  'POST /workspaces': [
    'Create a workspace',
    'Creates a workspace — open to the whole account, or closed to its members.',
  ],
  'PATCH /workspaces/{id}': ['Update a workspace', 'Renames a workspace, changes its kind or its description.'],
  'DELETE /workspaces/{id}': [
    'Delete a workspace',
    'Deletes an empty workspace. The account always keeps at least one. Admins only.',
  ],
  'GET /workspaces/{id}/tree': [
    'Get a workspace tree',
    'The workspace’s folders, boards, docs and dashboards that you can see, in their order.',
  ],
  'GET /workspaces/{id}/members': [
    'List workspace members',
    'Who belongs to a workspace (who sees a closed one), and whether you manage them.',
  ],
  'POST /workspaces/{id}/members': [
    'Add workspace members',
    'Adds account members to a workspace, or invites new people by email (they join on accepting).',
  ],
  'DELETE /workspaces/{id}/members/{userId}': [
    'Remove a workspace member',
    'Removes a member from a workspace, or leaves it yourself.',
  ],
};
