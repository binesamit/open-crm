# 12 — Roadmap

What Bines OS already does, and what is planned next. It is for users, self-hosters and contributors who want to know
where the project is going or are looking for something to work on. The items under "Planned" are not built yet; the
other docs describe only what exists.

Nothing here is a promise or a date. If you want to work on an item, open an issue first so the design can be agreed
(see [`CONTRIBUTING.md`](../CONTRIBUTING.md) and the binding rules in [`DECISIONS.md`](DECISIONS.md)).

## What exists today

| Area                         | What you get                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform and accounts        | Invitation sign-in and optional self sign-up (DECISIONS D32), multiple isolated accounts (D12), owner console, standalone one-container install or Docker Compose (D31), email and SMS                      |
| Boards                       | Boards, groups, 37 column types ([`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md)), inline editing, relations / mirrors / formulas, item card, subitems as sub-boards up to 5 levels deep (D14)     |
| Table and views              | Search, nested filters, sort, grouping, hidden columns, saved and personal views ([`15-VIEWS.md`](15-VIEWS.md)); kanban, calendar, Gantt, timeline, workload, map, chart, files and form views            |
| Structure and tracking       | Context menus and keyboard shortcuts ([`14-CONTEXT-MENUS.md`](14-CONTEXT-MENUS.md)), move and duplicate, time tracking                                                                                      |
| Real-time collaboration      | Live updates over SSE, notification bell and email, My Work, presence, collaborative docs                                                                                                                    |
| Import                       | Excel / CSV import into a board, and import through the API or MCP                                                                                                                                           |
| Automations and integrations | Automations as data ([`04-AUTOMATIONS.md`](04-AUTOMATIONS.md)), scheduled automations, API tokens and SDK, incoming and outgoing webhooks, OpenAPI ([`06-API.md`](06-API.md)), n8n and Make integrations |
| Guests and forms             | Board-scoped guests (D23), a client portal ([`09-CLIENT-PORTAL.md`](09-CLIENT-PORTAL.md)), public forms, email to a board or item                                                                           |
| Design                       | Our own design language and palette (D24, D30), dark mode, mobile layout, RTL first with English ([`11-UI-DESIGN.md`](11-UI-DESIGN.md))                                                                     |
| Dashboards and docs          | Cross-board dashboards, docs in cells, interactive documents (quotes, agreements, signatures)                                                                                                                |
| Extensions and AI            | Extensions ([`10-EXTENSIONS.md`](10-EXTENSIONS.md), [`extensions/README.md`](extensions/README.md)), AI columns, agents, an MCP server, AI provider choice                                                  |
| Running it for others        | Plans and pricing, self sign-up, legal documents, support access, and an optional license server in the owner console (D33)                                                                                  |

## Planned

### Integrations and platform

- More payment providers and calendars, as extensions rather than core (D33).
- SSO with SAML / OIDC and SCIM provisioning, environments and custom roles.
- Log streaming and external secret stores.
- Per-account custom domains.
- An automatic move from the embedded database (PGlite) to PostgreSQL. Today the move is a manual export and import
  ([`SELF-HOSTING.md`](SELF-HOSTING.md)).
- Postgres row-level security as a second layer of tenant isolation, behind the service-layer checks.
- Extension slots for a custom renderer of an existing column and for sidebar objects.
- A public, community extension catalog shared across installations (today each installation has its own catalog and
  private installs).

### Boards, views and menus

- Board-level saved filters: named, shared filters per board.
- Slash commands in an empty cell (`/status …`, `/assign me`, `/date tomorrow`).
- More context-menu entries: "filter by this value" and change history on a cell; rename, move and signed link on a
  file; sort, freeze, wrap, duplicate and save-as-template on a column; export a group; menus on empty areas and on a
  person's avatar.
- An `auto_number` column that renumbers on reorder (custom item keys on the item ID column cover most cases today).
- Link column that fetches the page title automatically.
- File column sources from cloud drives.
- Keeping an item's previous keys after it moves to another board.
- Sorting a workspace's sidebar alphabetically, and pinning tools in the sidebar.
- Remembering a person's column mapping per pair of boards when moving items.
- Search results from audio and video transcripts.

### Permissions and administration

- Item visibility by filter rules (`view_items.mode = by_filter`), for example per-client rules in a portal.
- Per-board overrides of individual capabilities in the permissions dialog.
- More configurable account permissions: who may create workspaces and each kind of board, delete their own boards,
  export, create API tokens (including guests), move items between boards, delete other people's items, and whether
  guests see each other.
- Account-level feature switches (link previews, GIFs, public forms and similar).
- A richer password policy (character classes, breach check, maximum age), configurable session lifetimes, and an
  emergency "end all sessions" action.
- A working-status field on the profile (emoji, text, until when).
- Team owners, guests in teams, and nested teams in the API.
- Per-account portal branding beyond name and logo (colour, welcome text, which sections show).

### Automations

- An account-wide automation rate cap (runs per minute, actions per day) that pauses automations and alerts the
  owner, with a stored daily usage rollup and a cycle detector across automations.
- Exporting a board's automations in the seed format.
- An "Automations" tab on the item card: runs that touched the item and automations that may fire on it.
- A warning that lists the automations that will break before a column, label, group or board is deleted.
- Notifying an automation's owner when it fails (at most once an hour).
- Retention rules for automation runs and webhook deliveries.
- A usage period that counts from each account's billing start (today usage is counted per calendar month).

### API

- `?include=` expansion and `?fields=` trimming on reads.
- Rate limits that weigh expensive endpoints more heavily.

### Performance and operations

- Windowed loading in every view for boards of tens of thousands of items, including huge sub-boards and the import
  sheet ([`PERFORMANCE-REVIEW.md`](PERFORMANCE-REVIEW.md) §7a).
- A script that re-keys long position keys, and a configurable database pool size (§7.3, §7.4).
- A load test against a deployed environment, with a short k6 run in CI (§7.5).
- Monthly `activity_log` partitions created automatically, with old partitions archived to object storage.
- Rate limits and replay caches in a shared store, for running several API replicas.
- Continued automated accessibility checks (`a11y.yml`) on every new screen.

### Security hardening

The open findings of the [security review](SECURITY-REVIEW.md), the [AI security review](AI-SECURITY-REVIEW.md) and the
[extensions security review](EXTENSIONS-SECURITY-REVIEW.md) are tracked there with their ids. In short:

- A permission model for documents that covers both document links and export (S-40, S-94).
- Per-viewer filtering of dashboard metadata (S-42); keeping relation links the writer cannot see (S-43).
- An Origin / `Sec-Fetch-Site` CSRF check (S-79) and https-only webhooks in production (S-102).
- Closing collaboration connections when their session or token is revoked (S-95).
- An approval mode inside Bines for sensitive MCP tools, and a reservation-based AI budget (AI review §4).
- The remaining items listed as open in each review.

### Not planned

- GraphQL: the REST API with OpenAPI and the MCP server are the supported interfaces.
- Native mobile apps: the web app is responsive and installable as a PWA.
