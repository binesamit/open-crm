# 00 — PRD: Bines OS Platform

This is the product requirements document: what Bines OS is for, who uses it, the jobs the built-in board templates
cover, and the product's scope. It is written for contributors and evaluators who want the "why" before reading the
technical specs (`01`–`15`). Where it disagrees with [`DECISIONS.md`](DECISIONS.md), the decisions win.

> Language convention: the UI is Hebrew-first (RTL) with English as a second language; code, identifiers, table
> names and the API are in English.

## 1. Vision

A self-hosted, open-source work-management platform (boards, groups, items with typed columns, automations,
dashboards, docs) on which a services business can run its CRM, projects, support, finance and AI operations — plus a
**client portal** in which each client (as a `guest`) sees only what belongs to it.

Why build it instead of renting a closed SaaS tool:

- What a client portal needs (item-level visibility, closed workspaces, account-level permissions, an audit log) is
  usually locked behind an Enterprise tier.
- Closed tools often have no API for creating automations, and column order and permissions cannot be controlled
  through their APIs.
- Agents (over MCP) and integration tools such as Make or n8n can talk to the platform directly; a board that is a
  Postgres table saves a whole synchronisation layer.

The interaction model (D10, D24) and the permission model (D6) are defined in these docs, with three points we decide
for ourselves because we own the code:

1. Item-level `view_items` is an ordinary board setting, not an Enterprise feature.
2. `viewer` is free and read-only; a `guest` sees only shareable boards they are subscribed to **or** items they are
   allowed to see on boards with `view_items ≠ all`.
3. Automations are JSON (D5) — created from the UI, the API, the seed and AI agents in the same format.

**Open source, multi-account (D12, D33).** Bines OS is released under the AGPL-3.0; any installation may be used,
changed and hosted as a service. One installation holds any number of fully isolated accounts (tenants; `account_id`
on every row). The first account is created on first run (or by the seed, `SEED_ACCOUNT_NAME`); the platform owner
opens, suspends and manages further accounts from the owner console (`/owner`). Self sign-up exists but is off by
default (D32); plans and pricing are optional settings of the installation.

## 2. Users

| User                         | System role (`role`)          | Who this is in practice                                  | What they need                                                                                                                         |
| ---------------------------- | ----------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Platform owner               | `admin` + `is_platform_owner` | The person or company running the installation           | Everything in their own account; opening / suspending other accounts from the owner console (no access to their data unless invited) |
| Account admin                | `admin` (in another account)  | A client, partner or team that got its own account       | To manage their account the way the platform owner manages the first one; never sees other accounts                                  |
| Team member / freelancer     | `member`                      | A colleague or contractor joining a project              | To edit the boards they were invited to, log time, get notifications; not to see finance                                              |
| Viewer                       | `viewer`                      | A business partner, an accountant                        | To read main boards (invoices, for example) without editing; free                                                                     |
| Client                       | `guest`                       | A contact at a client marked "gets updates"              | To open a request, see project status and their hours bank, talk in Updates, get email notifications — and never see another client  |
| Automation / agent           | `service` token               | Make, n8n, an MCP client such as Claude, other services | To read / write through the API with a limited scope; every write is recorded in the activity log with `actor_type=service`         |

Every action in the system is performed by an **actor** (`user` or `service`) and checked in the service layer (see
[`05-PERMISSIONS.md`](05-PERMISSIONS.md)).

## 3. Jobs-to-be-done by module

The repository ships a sample template set (`seed/templates/*.json`) that models a services business. Each module is
a folder in a workspace plus boards from those templates; the folder numbers (01–07) follow the business flow. Some of
the flows below rely on an external service (an invoicing system, an MCP tool server, a messaging provider) connected
over webhooks, the API or MCP; those services are not part of the platform.

### 3.1 CRM (folders 01 + 02) — `leads`, `contacts`, `quotes`, `accounts`, `opportunities`

| JTBD                                                                | How it happens on the platform                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A lead arrives from a form, a messaging channel or email and I want it in a queue | Public form → item in `leads`, group "Open"; `lead_key` = `L-0001`; Kanban by status; a "Follow up today" view (follow-up date ≤ today)                                                                                              |
| I turned a lead into a quote                                        | A button or automation creates an item in `quotes` ("Client — Subject — Q2026-001") with a `board_relation` back to the lead                                                                                                                  |
| The quote was approved → I need a client and a project              | `quotes.status = Approved` ⇒ an outgoing webhook / MCP call to an external service, which creates the client in the invoicing system, an item in `accounts` (if missing), a project from a template, and moves the lead to "Won"          |
| I want one "client file"                                            | `accounts` is the hub: every other board links to it with `board_relation`; `mirror` columns show projects / tickets / invoices / hours bank; a "health" `formula` 🟢🟡🔴; a Cards view "Client files"                                     |
| Contacts are separate from clients                                  | `contacts`: one person = one item; `account` (board_relation), `role`, `gets_updates` (checkbox) — guests are invited to the portal from here; `guest_user` is filled after the invitation (a column only owners may edit)                 |
| Find growth opportunities                                           | `opportunities`: an agent scans active clients weekly and creates an "idea" with its reasoning; a person filters them; hours-bank balance < 20% ⇒ an "hours bank renewal" opportunity                                                     |

### 3.2 Projects (folder 03) — `projects`, `tasks`, `project-templates`, `project-multilevel`

| JTBD                                     | How                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A project is born from an approved quote | Creating a project from a template copies the subitems of `project-templates` into tasks on `tasks` and links `project`, `account`, `quote`                                                |
| Know the stage and report to the client  | `projects.stage`, `client_status` (what the client sees), `public_to_client` (checkbox) ⇒ published to the portal, `last_update_to_client` (long_text)                                       |
| Log billable hours                       | `tasks.actual_hours` is the source of truth for billing; `time_tracking` helps; `tasks` subitems are a checklist (not billed separately)                                                  |
| A large project: track → module → task   | A `project-multilevel` board: an item tree up to 5 levels deep, rolled-up status battery, Gantt / Workload views                                                                            |
| Completion                               | All tasks done ⇒ `stage = QA` (automation) ⇒ … ⇒ "Inactive"                                                                                                                                   |

### 3.3 Support (folders 02 + 05) — `support-tickets`, `faq-clients`, `kb-internal`, portal requests

| JTBD                               | How                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A client opens a request           | In the portal (an item on `support-tickets` with the client's `requester` / `account`), on their own `portal-client` board (mode B), or through a public form / email-to-board |
| SLA                                | `priority` ⇒ an automation sets `sla_due` (P1 4h, P2 24h, P3 72h, P4 5d); `sla_breach` (formula); a breach ⇒ a notification                                                |
| The client sees status and talks to me | Updates on the item; mentions; `client_visible` (checkbox) controls what the client sees; email on every update                                                         |
| A solved ticket becomes knowledge  | `resolved + solution` ⇒ an agent drafts a Q&A on `faq-clients` (`published=false`); a person approves ⇒ it appears in the portal's "Guides" tab                            |
| Internal knowledge for agents      | `kb-internal` — agents quote only items with `agent_may_quote`                                                                                                              |

### 3.4 Finance (folder 04) — `invoices`, `hours-bank`, `funds`

| JTBD                                     | How                                                                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invoices without retyping                | `invoices` is a log only; its source is an external invoicing system synced by an integration (key `morning_doc_id`); `sync-log` records discrepancies from a daily reconciliation                |
| Split each invoice into funds            | An invoice's subitems are allocations to `funds` by default percentages (sum = 100%); an allocation above a threshold needs a person's approval; an invoice cannot be "Paid" while "Unallocated" ≠ 0 |
| An hours bank per client                 | `hours-bank`: "Client — Package — Date"; `used` (mirror from tasks), `left` (formula); < 20% ⇒ low status + an opportunity + a notification                                                        |
| The client sees their own balance        | The portal's "Hours" tab is a view on `hours-bank` filtered to the guest's `account`, with money columns hidden (`restrict_column_view`)                                                            |

### 3.5 Operations / AI (folder 06) — `automation-monitor`, `agent-log`, `sync-log`, `control-panel`

| JTBD                                        | How                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Know that a client's external automation failed | `automation-monitor`: error handlers in Make / n8n → webhook → an upsert on the board; a failure ⇒ a P2 ticket + a notification; > 48h ⇒ client turns red |
| What did the agent do                       | `agent-log`: every MCP write tool writes a row (middleware); readable by everyone; kept 90 days                                                           |
| Run a sync by hand                          | `control-panel`: changing a status to "Run now" ⇒ a webhook to n8n                                                                                       |
| The platform itself                         | The built-in automation center: run history, errors, quota (see [`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md), Usage)                                     |

### 3.6 Creative (folder 06) — `creative`

A small board: `status`, `people`, `file` and two `vote` columns.

## 4. The client portal experience (summary; the full spec is [`09-CLIENT-PORTAL.md`](09-CLIENT-PORTAL.md))

1. A contact in `contacts` is marked `gets_updates` ⇒ an admin clicks "Invite to portal" ⇒ an invitation email with a
   magic link (Better Auth).
2. The guest lands on `/portal` — a reduced layout (no sidebar) with tabs: **My requests / My projects / Hours /
   Guides**.
3. "New request" is a form (name, type, urgency, description, files — required fields) that creates an item on
   `support-tickets` with the guest's `account` + `requester`.
4. In the item card the guest sees status (mirror), description, files and Updates. They write, mention the team and
   attach files.
5. Every update ⇒ an email (reply-by-email creates an update); other channels (such as WhatsApp) through a webhook to
   an external service.
6. A guest **never** sees another client's item, a workspace name, the activity log, internal columns
   (`restrict_column_view`) or other guests' names (by default).
7. Two configuration modes: **A (default)** — shared boards + `view_items: by_filter / assigned_or_created`; **B
   (optional)** — a dedicated shareable board per client (the `portal-client` template).
8. Clients who do not sign in: a public form (password / captcha) + an email-to-board address.

## 5. Success criteria

| Metric                                                           | Target                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Importing existing data (Excel / CSV into a board, or API / MCP) | 100% of rows imported, 0 columns lost                                                                                                  |
| Loading a 2,000-item board (P95)                                 | < 1.5 s first load, < 100 ms scrolling (virtualised)                                                                                   |
| A cell update → visible to another user                          | < 1 s (SSE)                                                                                                                            |
| Client isolation                                                 | 0 failures in the test matrices of [`05-PERMISSIONS.md`](05-PERMISSIONS.md) §11 and [`09-CLIENT-PORTAL.md`](09-CLIENT-PORTAL.md) §10 — blocks merge |
| Automation: trigger → action                                     | < 5 s P95                                                                                                                              |
| A portal request → notification to the team                      | < 30 s                                                                                                                                 |

## 6. Scope

The platform covers, among other things:

- **Accounts and access**: multiple accounts (D12) with an owner console (create / suspend / usage), an account
  switcher and `/a/:slug/...` URLs; users and roles (admin / member / viewer / guest); email invitations, Google
  OAuth, magic links, 2FA; optional self sign-up (D32).
- **Structure**: workspaces (open / closed), folders (≤ 3 levels), boards (main / shareable / private), groups, items
  with subitems on a sub-board (D14, up to 5 levels), cells.
- **Column types**: 37 types, listed with their settings, values, filters and API shapes in
  [`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md); the design of each type is in
  [`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md).
- **Views**: table (virtualised, inline editors, group by, filter, sort, hidden columns, batch bar), kanban, calendar,
  cards, timeline, Gantt, workload, chart, files, map, form, board dashboard and extension views; saved and personal
  views ([`15-VIEWS.md`](15-VIEWS.md)).
- **Item card**: Updates (threads, mentions, files, reply-by-email), files, activity, subitems, docs.
- **Permissions**: permission sets, board roles, `view_items` (all / assigned_or_created / by_filter), column
  restrictions, account permissions ([`05-PERMISSIONS.md`](05-PERMISSIONS.md)).
- **Safety nets**: trash (30 days), undo (toast, and from the activity log for 7 days), archive, soft delete.
- **Collaboration**: SSE realtime, presence, search, notifications (bell, email, web push), My Work, collaborative
  docs.
- **Automations and integration**: JSON automations with a catalog of triggers and actions, scheduled automations,
  run history ([`04-AUTOMATIONS.md`](04-AUTOMATIONS.md)); incoming and outgoing webhooks; API tokens, SDK and OpenAPI
  ([`06-API.md`](06-API.md)); an MCP server.
- **Import / export**: Excel / CSV import and export, templates, public forms (with password / captcha),
  email-to-board.
- **Dashboards**: cross-board widgets (numbers, charts, battery, table and more).
- **Client portal**: home, new request, item page, limited mentions, email in / out, branding.
- **Administration**: users, teams, security (2FA, sessions, domains), support access, tokens, trash, audit log,
  tidy-up, usage ([`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md)).
- **Extensions and AI**: an extension framework and catalog ([`10-EXTENSIONS.md`](10-EXTENSIONS.md)), AI columns,
  agents, interactive documents.

Future work is listed in [`12-ROADMAP.md`](12-ROADMAP.md).

## 7. Non-goals

- A GraphQL API (REST + OpenAPI + MCP cover the same ground).
- Native mobile apps — the web app is responsive and installable as a PWA.
- Splitting into separate "products" (CRM / dev / service) — there is one product, configured by templates and
  settings.
- Customer-specific code paths: every behaviour is a setting, and optional or third-party integrations are extensions
  (D33).

## 8. Glossary (UI term ↔ entity)

The Hebrew column is the term shown in the Hebrew (default) UI.

| UI term (English)           | Hebrew UI           | Entity / identifier                                                               | Note                                                                   |
| --------------------------- | ------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Account                     | חשבון               | `account`                                                                         | A tenant; there can be many (D12)                                      |
| Platform owner              | בעל פלטפורמה        | `users.is_platform_owner`                                                         | Opens / suspends accounts; sees no data without a membership           |
| Owner console               | קונסולת בעלים       | `/owner`                                                                          | Account management                                                     |
| User / team member          | משתמש / חבר צוות    | `user` / `membership.role=member`                                                 |                                                                        |
| Admin                       | מנהל                | `admin`                                                                           |                                                                        |
| Viewer                      | צופה                | `viewer`                                                                          | Read-only, free                                                        |
| Guest / client              | אורח / לקוח         | `guest`                                                                           | External; a domain other than the account's domains                    |
| Team                        | צוות                | `team`                                                                            |                                                                        |
| Workspace                   | מרחב עבודה          | `workspace` (`kind: open\|closed`)                                                |                                                                        |
| Folder                      | תיקייה              | `folder`                                                                          | ≤ 3 levels                                                             |
| Board                       | בורד                | `board` (`kind: main\|shareable\|private`)                                        |                                                                        |
| Main / shareable / private board | בורד ראשי / משותף / פרטי | main / shareable / private                                              |                                                                        |
| Group                       | קבוצה               | `group`                                                                           | A colour strip from the group palette                                  |
| Item                        | אייטם / פריט        | `item` (`depth=0`)                                                                | Renameable per board: `item_terminology` ("request", "contact", …)     |
| Subitem                     | סאב-אייטם           | `item` (`depth≥1`, `parent_item_id`)                                              | Lives on the board's sub-board (D14)                                   |
| Multi-level board           | בורד רב-רמות        | `board.hierarchy_type = multi_level`                                              |                                                                        |
| Column                      | עמודה               | `column` (`type`, `settings` JSONB)                                               |                                                                        |
| Cell                        | תא                  | `cell`                                                                            | `item_id × column_id`, `value` JSONB, `text_value` for search          |
| View                        | תצוגה               | `view` (`type`: one of `VIEW_TYPES` in `packages/shared/src/views/settings.ts`)    | See [`15-VIEWS.md`](15-VIEWS.md)                                       |
| Form                        | טופס                | `form`                                                                            | A form view + public / password settings                               |
| Update                      | עדכון               | `update`                                                                          | Threads, mentions, files; a reply = an update with `parent_update_id`  |
| File                        | קובץ                | `file` / `asset`                                                                  | S3-compatible storage                                                  |
| Automation                  | אוטומציה            | `automation` (`trigger, conditions[], actions[]`)                                 |                                                                        |
| Run history                 | היסטוריית ריצות     | `automation_run`                                                                  |                                                                        |
| Webhook                     | Webhook             | `webhook`                                                                         | Outgoing; challenge + HMAC                                             |
| API token                   | טוקן API            | `api_token` (`scopes[]`)                                                          | Personal / service                                                     |
| Board permissions           | הרשאות בורד         | `board_permission` (`set`, `view_items`)                  |                                                                        |
| Subscriber / board member   | מנוי / חבר בורד     | `board_subscriber` (`role`)                                                       |                                                                        |
| Owner                       | בעלים               | `board_subscriber.role=owner`                                                     | Bypasses everything on the board                                       |
| Column restriction          | הגבלת עמודה         | `column_restriction` (`kind: edit\|view`, `principals[]`)                         |                                                                        |
| Item visibility             | נראות אייטמים       | `view_items: all \| assigned_or_created \| by_filter`                             |                                                                        |
| Trash                       | סל מחזור            | `trash` (`deleted_at`)                                                            | 30 days                                                                |
| Archive                     | ארכיון              | `archived_at`                                                                     | No time limit                                                          |
| Activity log                | יומן פעילות         | `activity_log`                                                                    | Every mutation                                                         |
| Audit log                   | יומן ביקורת         | `audit_log`                                                                       | Security / admin events                                                |
| Notifications / bell        | ההתראות שלי / פעמון | `notification`                                                                    |                                                                        |
| My Work                     | העבודה שלי          | My Work                                                                           | Items assigned to me, by date                                          |
| Template                    | תבנית               | `template`                                                                        | `seed/templates/*.json`                                                |
| Portal                      | פורטל               | `/portal`                                                                         | The guest layout                                                       |
| Support access              | גישה לתמיכה         | `support_access_grant`                                                            | Time-limited impersonation-view                                        |
| Extension / app             | הרחבה / אפליקציה    | `extension`                                                                       | [`10-EXTENSIONS.md`](10-EXTENSIONS.md)                                 |
| "Done" status               | סטטוס "הושלם"       | a label with `is_done=true`                                                       |                                                                        |
| Battery                     | סוללה               | battery summary                                                                   | Group footer / multi-level parent                                      |
| Custom key                  | מזהה מותאם          | `item_id` column, custom prefix (`L-`, `Q-`, `PRJ-`, `BT-`)                       |                                                                        |
