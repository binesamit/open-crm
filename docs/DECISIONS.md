# Bines OS Platform — Architecture Decisions (binding)

The architecture decision record of Bines OS: the choices every other doc and every file in this repository follows,
with the reasoning behind them. It is for contributors and anyone who wants to know why the platform is built the way
it is. Change a decision here first, then the code. Decisions keep their numbers (D1–D33) because code comments cite
them; a decision that was replaced says so and points to its successor.

Language: the product UI is Hebrew-first (RTL) with English as a second language; code, ids, API and the docs are in
English (a few user-facing guides also have a Hebrew version, `*.he.md`).

## D1. What we are building

A self-hosted work platform (boards, groups, items with typed columns, automations) for services businesses: CRM,
projects, support and finance boards, and a **client portal** where each client (as a _guest_) sees only its own items.
It is **multi-account**: the platform owner can open additional accounts (tenants) — e.g. for a client business or a
partner — from an owner console (D12), and since D32–D33 any installation may also let people sign up and host
accounts for others. Every tenant row carries `account_id`; accounts are fully isolated from each other. The platform
is open source under the AGPL-3.0 (D33).

The feature baseline is the full work-management feature set (boards, views, automations, dashboards, docs); the things
commercial tools lock behind Enterprise tiers (item-level visibility, closed workspaces, account permissions, audit
log) are implemented natively for everyone.

## D2. Stack

- **Runtime/API**: Node 22 LTS (`.nvmrc`, `.node-version`, `railpack.json`; `engines` >=22.12, required by Hocuspocus
  4), TypeScript, **Hono** (REST JSON API + SSE), Zod for validation.
- **DB**: **PostgreSQL 18**, **Drizzle ORM** + drizzle-kit migrations. JSONB for column settings and cell values. An
  embedded PGlite database in standalone mode (D31).
- **Auth**: **Better Auth** for authentication only (email+password, Google, Microsoft, magic link). **No organization
  plugin** — it binds a session to one active organization, which contradicts D12; account membership, invitations and
  API tokens are our own tables. Sign-up completes an invitation (D12): password sign-up must carry the invitation
  token, magic link / social sign-in need a pending invitation or the platform-owner email — unless the platform owner
  turns on self sign-up (D32).
- **Frontend**: **React 18 + Vite + TypeScript**, TanStack Query + Router, Zustand for board state, TanStack
  Table/Virtual for the grid, dnd-kit for drag & drop, Radix primitives + Tailwind. RTL via `dir="rtl"` on `<html>`;
  logical CSS properties only.
- **Realtime**: SSE per board (`GET /boards/:id/events`); clients re-fetch on event. Collaborative docs use Hocuspocus
  (Yjs) over WebSocket (D25).
- **Jobs**: pg-based queue (`graphile-worker`) for automations, webhooks, scheduled triggers, exports, imports.
- **Files**: any S3-compatible storage (e.g. Cloudflare R2, AWS S3, MinIO) with presigned uploads and downloads — bytes
  never pass through the API; max 500 MB per file. MinIO in `docker-compose.yml` for local development; a local folder
  in standalone mode (D31).
- **Email**: Resend or SMTP (invitations, notifications, inbound email to items via a Resend webhook).
- **Deploy**: one `api` service that also serves the built `apps/web/dist` SPA, so web and API share one origin and the
  session cookie needs no cross-site setup; a `worker` service; PostgreSQL. No Redis. Docker image, Docker Compose and a
  Railway template are documented in `docs/SELF-HOSTING.md`.
- **Monorepo**: pnpm workspaces with recursive scripts (`pnpm -r`; no Turborepo, to avoid a native binary in the
  toolchain): `apps/api`, `apps/web`, `apps/worker`, `packages/shared` (types, zod schemas, column-type registry),
  `packages/sdk` (TS client), `packages/ui`, plus server-only packages (`packages/server-*`).

## D3. Core domain model (one line each; details in 02-DATA-MODEL.md)

account → users (membership with role) → workspaces (open/closed) → folders (≤3 levels) → boards
(main/shareable/private) → groups → items (tree: `parent_item_id`, `depth` 0..5; subitems live on the board's
**sub-board** with their own columns — D14) → cells (one row per item×column, JSONB value) ; columns (typed, settings
JSONB, ordered) ; views ; updates (threaded, mentions, files) ; automations (trigger/conditions/actions JSON) ;
webhooks ; api_tokens ; activity_log ; trash (soft delete + `deleted_at`, purge after 30 days) ; templates ; forms.

## D4. Column types = a registry, not an enum

`packages/shared/src/columns/defs/<family>.ts` — one module per type exporting its type, settings and value schemas,
default settings, render hints, filter operators, sort key, aggregation, automation support, `toText` and `fromText`.
Adding a column type = adding a module. The spec is `03-COLUMN-TYPES.md`; the catalog of every type, generated from the
registry, is `COLUMN-TYPES.generated.md`.

## D5. Automations = data, not code

A recipe is `{trigger, conditions[], actions[]}` JSON. The worker evaluates triggers from the activity log (every write
emits an event), runs conditions, executes actions through the same service layer the API uses (so permissions and
activity logging apply). Action catalogue and trigger catalogue are registries like column types.

## D6. Permissions

Roles: `admin`, `member`, `viewer` (read-only, free), `guest` (external; sees only shareable boards it is subscribed
to). Board permission sets: `edit_everything`, `edit_content`, `edit_assigned`, `view_comment`. Column restrictions:
`edit` and `view` lists. **Item-level visibility** (`view_items: all | assigned_or_created | by_filter`) is a
first-class board setting — not an enterprise-tier feature — so one support board can serve all clients and each guest
sees only its own rows. The portal is therefore a _filtered view_ of the real boards, not a copy (no sync automations
needed). Owners bypass everything. Strictest rule wins. Enforced in the service layer, never only in the UI.

## D7. API

REST JSON under `/api/v1` (Hono + OpenAPI via `@hono/zod-openapi`), Bearer tokens (personal or service), cursor
pagination, `If-Match` revisions on columns/boards, idempotency keys on writes, rate limits per token, outgoing
webhooks with challenge handshake and HMAC signature. No GraphQL facade. `packages/sdk` is a thin typed client; the
contract is the OpenAPI document.

## D8. Extensions

"Apps" rendered in an iframe inside a board/item/dashboard slot, authenticated with a short-lived token, talking to the
same API; custom automation blocks are HTTP endpoints registered in the action registry. Core never imports from
`extensions/`. Detailed in D27 and `10-EXTENSIONS.md`.

## D9. Seed

Built-in board templates ship with the product (`seed/templates`).

## D10. UI interaction model (the original look is superseded by D24 and D30)

The interaction model: left pane, board header, tabs for views, groups with a color rail, inline cells, item card with
Updates, batch bar — this is the spec (detailed in 11-UI-DESIGN.md). The visual identity is our own, applied through
tokens; dark mode from day one. The first look ("Warm Editorial") was replaced by D24, and its palette by D30.

## D11. Non-goals

Originally: GraphQL, SSO/SCIM, a marketplace, mobile apps, cross-board dashboards, Gantt/Workload, AI columns, billing,
public sign-up, per-account custom domains. Since then the marketplace became extensions (D27), dashboards and advanced
views were built (D25), AI columns and agents were built (D26), and billing and self sign-up became optional platform
features (D32, D33). Still not built: GraphQL, SSO (SAML/OIDC) and SCIM, native mobile apps (the web app is responsive
and installable as a PWA), per-account custom domains.

## D12. Multiple accounts (tenants)

- **Who creates accounts**: the _platform owner_ (`users.is_platform_owner = true`; seeded from `SEED_ADMIN_EMAIL`, or
  the person who completes first-run setup) via the owner console (`/owner`, API `/api/v1/platform/*`). Otherwise
  sign-up only completes an invitation, unless self sign-up is turned on (D32). Creating an account =
  `{name, slug, first_admin_email, template_set: 'empty' | <a starter pack key> (D27)}` → account + settings +
  invitation of the first admin (+ optional built-in templates). The owner console can also rename, suspend
  (`accounts.status = suspended` ⇒ every request of that account returns `423 account_suspended`, guests included),
  restore and soft-delete accounts, and shows per-account usage.
- **Platform owner ≠ account member**: the owner console sees account metadata and usage only, never board data. To
  work inside an account the owner needs a membership there (or a time-boxed `support_access_grant`, 08 §6). Being
  platform owner bypasses nothing in `can()`.
- **One user, many accounts**: `users` is global (one email, one login); `account_members` holds role/status per
  account. A user can be admin in one account and guest in another. The avatar menu has an account switcher; `/`
  redirects to the last used account (`user_profile_settings.last_account_id`) or to an account picker.
- **URL & request scoping**: web routes are `/a/:accountSlug/...` (portal: `/a/:accountSlug/portal/...`); one domain,
  one session cookie. Every account-scoped API call carries `X-Account-Id`; the server resolves membership for (session
  user, account) per request — the session itself is **not** bound to an account (multiple tabs on different accounts
  work). API tokens are bound to exactly one account; a mismatching `X-Account-Id` → `403 account_mismatch`. Non-scoped
  routes: `/auth/*`, `/me/accounts`, `/platform/*`, public forms, inbound hooks.
- **Isolation is a release gate**: cross-account tests (user of A cannot read/write/search/subscribe/SSE/export
  anything of B, ids of B return 404) are part of the permissions test matrix and block merge, like the guest isolation
  tests.
- Account-level things stay per account: settings, branding (portal + emails), domains, teams, tokens, webhooks,
  automations quota, audit log, trash. Built-in templates (`seed/templates`) are global and available to every account.

## D13. The public address is a setting

One origin serves web + API (D2), so moving an installation to another address is configuration, not code. Code and
docs never hard-code the origin.

- The origin is a platform setting: owner console → Platform settings → "System address"
  (`platform_settings.public_address`: `web_origin`, optional `api_origin`, `previous_origins`). One resolver
  (`resolvePublicAddress` in `@bines/shared`; API `modules/platform/public-address.ts`, worker `src/public-address.ts`):
  setting → `WEB_ORIGIN`. It applies without a redeploy (30 s cache).
- The old address is kept in `previous_origins` (accepted by CORS, Better Auth `trustedOrigins` and the MCP token
  audience) until the owner removes it, so links already sent by email (invitations, magic links) keep working.
- The S3 bucket CORS follows it (address + previous + `WEB_ORIGIN`) at boot and on save when `S3_SET_CORS` is on;
  otherwise set the bucket's CORS with the provider's own tool.
- Fixed at start only: Better Auth's base (`BETTER_AUTH_URL`, the OAuth return address, e.g.
  `https://<domain>/api/auth/callback/google`) and the API docs CSP. On platforms that offer variable references
  (Railway's `${{RAILWAY_PUBLIC_DOMAIN}}`), prefer literal origins: a reference is resolved per service at its deploy
  and changes when the service's primary domain changes.

## D14. Subitems = a sub-board with its own columns

Replaces an earlier "all levels share the board's columns" rule.

- A board may have one **sub-board** (`boards.parent_board_id` → the parent, `kind` of the parent, hidden from the
  sidebar, search and the board list; created on the first subitem). Subitems are items of the sub-board whose
  `parent_item_id` is an item of the parent board. The sub-board has **its own columns** (default on creation: name,
  owner, status, date), managed from the subitems' header like any board's columns.
- Levels below a subitem (sub-subitems, up to `hierarchy_depth_max` ≤ 5) stay on the same sub-board and share its
  columns.
- Permissions, subscribers and `view_items` are the parent board's: the sub-board has no access rules of its own (05).
  Activity, trash and undo work per item as everywhere; deleting/archiving an item takes its subitems with it.
- Table UI: an expand arrow + child count by the item name; the subitems open under it as a nested table with its own
  header row, **indented like stairs** (each level further in), never on the same line as the parent's name.
- Columns on the parent can read the subitems: a **mirror** column may target "subitems" (pick a sub-board column;
  aggregate per type — sum / earliest–latest / status battery), and the rollup ("show summary on parent") uses the same
  path.
- Converting item ↔ subitem maps cells between the two boards' columns by type+title (07 §3.4.1 mapping dialog);
  unmapped values are listed before confirming.

## D15. Notifications: delivery and following

- **Email goes out from the worker** (`notifications.dispatch` job: retries, and the daily digest in the same place).
  The API only writes the `notifications` row (in the action's transaction) and enqueues the job. The email client and
  templates live in a server-only workspace package (`packages/server-mail`) used by both `api` and `worker` — not
  `packages/shared`, which also runs in the browser.
- **Item following is automatic** for the item's creator, everyone assigned to it (a team assignment → its members),
  anyone mentioned on it, and anyone who writes an update or reply on it; "follow" / "unfollow" sit in the item menu.
  Stored in `item_followers`; a manual unfollow is remembered (`muted`) so an automatic rule does not re-add the user.
- "Who viewed this board" is a list kept per board (`board_viewers`: person, last open, device); live presence
  (cursors, who is editing) exists in collaborative docs only.

## D16. No data migration at first

Superseded by D18–D19 (historical).

## D17. (Historical — a delivery-order plan; no lasting decision.)

## D18–D19. Migration of a previous workspace

A one-time data migration from an earlier tool was done with a private tool; it is not part of this repository. Data
import for everyone is the Excel/CSV import and the API.

## D20. Views: nothing changes without "save"; the default table is fixed

- Every change to a view (filter, sort, grouping, hidden columns, **column order**, coloring…) is a draft until the
  user saves it; column order is the view's (`column_order`), not a silent board-wide reorder.
- The default table never changes: saving its draft creates a new view ("Save as new view"); the API refuses settings
  on it (`main_table_is_fixed`). Personal preferences (widths, collapsed groups) stay personal.

## D21. Automations run in the API process; nothing account-specific in code

- Automation runs execute **inside the api process** (a graphile-worker runner for the `automation.*` tasks) so actions
  call the very same services the HTTP routes use (D5); `apps/worker` keeps the maintenance jobs.
- **Nothing account-specific in code**: the engine knows only generic trigger/action modules; every automation is a row
  scoped by `account_id` + `board_id` and references that board's own columns/labels/groups. A new account starts with
  no automations. Recipes from an earlier system can be loaded only by an explicit command for a named account
  (`pnpm --filter @bines/api automations:seed -- --account <slug> --dir <folder>`), always **inactive**, so an admin
  turns each one on after a dry-run test. The only thing shared across accounts is the builder's catalogue of blank
  template sentences.

## D22. Guests and clients

Points 1–2 were replaced by D23.

1. _(Replaced by D23.)_
2. **Generic — nothing hard-coded**: any board can be made shareable with guests. No board or column is fixed in code;
   the seed kit is only a starting suggestion.
3. **Email to items**: each item can have its own reply address, and a reply lands in the item's updates
   (`modules/inbound-email`).
4. **SMS / WhatsApp to clients** are automations (the `webhook` action or a built-in channel), not portal code.
5. **Captcha**: Cloudflare Turnstile in invisible/managed mode on public forms (no login) — no floating badge; a
   challenge appears inside the form only when Cloudflare suspects a bot. Optional on sign-in and self sign-up (D32).
6. Setting up a client is done in the UI; nothing about a particular client is coded.
7. **No separate portal — guests work in the same app**: a guest signs in to the same app and sees only the shareable
   boards they were invited to (and, per `view_items`, only their items), with the normal board UI (table, views, item
   card, updates; editing per the board's rights). No workspaces, other boards, automations, tokens, activity log or
   member directory. "New request" = adding an item on the shared board; public forms stay for people without an
   account. This replaces 09's branded portal layout.

## D23. Guests are board-scoped — no "client"

Replaces D22.1, D22.2 and 05 §2.1's client scope. A guest is simply a person invited to a board — by email, from the
board's permissions dialog (or the account's invite form), and subscribed to that board on accepting; guests only join
shareable boards. What they see and do is the board's existing permissions, the same as for everyone: the permission
set / explicit role, column restrictions, and `view_items` (`all`, or `assigned_or_created` — then the guest sees what
they created or are assigned to in a people column). There is no client attached to a guest and no `by_client` mode
(removed in migration 0022; a board that was `by_client` became `assigned_or_created`). Guests use the same UI
(D22.7); the server filters their sidebar and people lists (the people of the boards / items they share).

## D24. The visual design is "F4"

Replaces D10's first look. A deep-green shell (`#0d3b35`) holding the sidebar, the content as one floating white panel
(radius 20, deep shadow), an amber accent (`#ffb020`, dark text on it), green-tinted greys, Heebo 800 for headings and
Rubik for UI, status filling the whole cell, groups with a colour bar, a summary row per group (status cell, group bar
and colours **replaced by D30**). Dark mode = "F3" (the same layout, a dark panel). D10's interaction model stays; only
the look changes. Spec: `docs/11-UI-DESIGN.md` §9 and `design-guide/f4/`.

## D25. Dashboards, advanced views and docs

Replaces D11's "dashboards / Gantt / Workload" non-goal.

- Docs with live co-editing (Tiptap + Yjs + Hocuspocus in the api process, state in Postgres); doc permissions like
  boards (main / private / shareable, editor / commenter / viewer); comments, versions and export (PDF + Markdown +
  HTML).
- Dashboards are created by any member (not viewers/guests): main = the workspace, private = invited.
- Gantt dependency modes are set per dependency column; Workload measure chosen per view with a daily capacity.
- Maps use OpenFreeMap tiles (provider swappable in settings).
- Two-factor sign-in is optional; admins may require it.

## D26. Agents and a full MCP server

- **AI keys per connection**: keys are saved once per account as "AI connections" (provider + key, encrypted,
  write-only, admins manage them) and every agent (and AI column) picks a connection and a model; costs are reported per
  connection. There is no platform-wide key.
- **Every agent is built in the UI** — name, role, instructions, model + connection, allowed tools, boards, knowledge,
  triggers, approval policy, cost limits; no agent in code; starter templates are editable data (`seed/agents`).
- The MCP server exposes the same capabilities as the API, under the same permissions.

## D27. Extensions

Replaces D11's "marketplace" non-goal and the original `10-EXTENSIONS.md` §7.

- Extensions are private per account plus a platform catalog the owner manages; only account admins install (members
  may ask). The developer hosts an extension's code — the platform frames it and sends signed requests, never runs it.
- An update without a new scope applies by itself; a new scope / origin / feature waits for an admin's consent.
- No new column types from extensions (D4). Extensions are off for guests unless an admin allows them. Starter kits are
  data packs (no kit name in code). No billing for extensions.

**Security is the first requirement** — extensions other people build must not be able to harm the system:

1. Three sandbox layers — the extension's own origin (never ours; refused at install), `<iframe sandbox>` without top
   navigation / modals, and a CSP `frame-src` built per account page from that account's enabled extensions.
2. The token reaches the frame by postMessage only (never in a URL), is minted per user × installation × board ×
   feature for 10 minutes, bound to the frame's origin, and what it may do = the user's own rights × the scopes the
   admin approved × that board × a path allowlist (board content only — never tokens, extensions, administration, the
   owner console, AI or agents); it is re-checked against the installation on every request. CORS lets extension
   origins call the API with that token only, never with the session cookie; `admin` is never a grantable scope.
3. A consent screen before install, and again for a version that asks for more.
4. Every write is stamped "via the extension" with one batch per request and can be undone.
5. Rate limits per installation and per user.
6. Admins switch an extension off at once, and the platform owner has an emergency kill switch that stops it in every
   account (tokens, frames, CORS), recorded in each account's audit log.

## D28. Column type conversion

- All the useful pairs convert: numbers ↔ rating, people ↔ text, contact types, checkbox, timeline ↔ date, any type →
  text, and text into any type the paste parser reads.
- A cell that fails stays empty; its original value is kept in a backup, shown on hover ("Original value") and listed
  by a "failed in conversion" filter until the marks are cleared. Text → status / dropdown / tags creates the missing
  labels / tags (shown and approved — or removed — in the preview). Archived (and trashed) items convert too.
- Backups are kept 90 days (admins choose 30 / 90 / 365 / forever). An automation that no longer fits is switched off
  and its owner told. Only the board's owners and the account's admins convert. Above 5,000 cells the conversion runs
  as a background job with the column locked and a progress bar.
- How it is built: one shared pipeline (`convertCell`: old value → the old type's text → `cellFromText`, direct rules
  where they keep more) runs for the preview (dry run) and the conversion, so the counts match. The conversion needs
  the preview's fingerprint (stale → 409). It writes the backup (`column_conversion_cells`: original and new value per
  cell) first, then switches in one transaction (set-based cells, type + settings, dependents, one
  `column.type_changed` event, an audit row) — a failure before the switch changes nothing. The undo (toast / Ctrl+Z /
  activity log, 7 days) restores type, settings, values and dependents from the backup; "restore from backup" after
  that is a conversion of its own (undoable too).
- Saved filter / colouring rules that no longer apply are kept but disabled (`rule.disabled`), never deleted.
- Not converted (a clear reason is shown; a new column + copy is the way): formula, mirror, progress, item id, files,
  time tracking, votes, cell docs, buttons, relations, AI columns and the name column. Numbers ↔ progress is out:
  progress is computed from status columns (`engine: 'progress'`) and has no values of its own.

## D29. Fair-code licensing

Superseded by D33 (historical). The SDK packages staying MIT and contributions under a CLA (not DCO) carried over into
D33.

## D30. Our own palette and label look — no borrowed trade dress

Replaces "the imported palettes stay" (D10, D24, 11-UI §9). Function may resemble other tools; the recognisable
**look** may not.

- **Palette**: 16 label colours + 12 group colours of our own, vivid and saturated, each with a light and a dark value
  (`PALETTE` in `packages/shared/src/colors.ts`, `--c-<key>` in `tokens.css`; table in 11-UI §9.1). Every colour is ≥3:1
  on the surface of its theme. A test fails when any of our values is within ΔE2000 6 of a well-known third-party
  palette, and a CI guard fails when one of its hex values appears in our source outside the import mappers'
  known-input tables. Dark mode keeps the same fill; only blue / indigo / purple / violet / berry are lifted a little
  off the dark surface.
- **Keys, not hex**: status labels, colouring rules and account default labels store a palette key (migration
  `0080_own_palette` converted stored hex to the nearest key). An old hex is still read as the nearest key
  (`normalizeLabelColor`, `paint`) — caches and old events do not break. Templates map their colours to our keys. Group
  keys stay (the enum); seven retired ones render as a twin; a new group takes our order, the brand colours first.
  `brown` / `olive` label keys read as `gold` (`RENAMED_COLOR_KEYS`). Support tags store a hex; migration
  `0081_vivid_palette` moved them to the current values.
- **Look**: the **status cell is a full fill, edge to edge, with white text centred**; the picker, cards, calendar,
  kanban, filters, My Work and the activity log use solid filled chips with white text; battery / summary bars stay.
  White text on the fills is ≥2.6:1, the accepted trade-off of the full-fill look (the contrast test requires 2.6).
  Groups: the name in the group's colour plus a coloured bar. Amber is `#f58000` and indigo `#4040e8` so that the
  contrast and distance tests pass.
- **Words**: "Table" (not "Main table"), "In progress", "Blocked".

## D31. Standalone mode — install in one minute

Installing the open-source system must be as simple and light as a single `docker run`. The Docker image's **default
command** is standalone mode (`apps/api/src/standalone.ts`): `docker run -p 3000:3000 -v bines_data:/data <image>`,
then the owner account is created in the browser. Compose (Postgres + MinIO + migrate + worker) stays as the
production path.

- **Database**: `DATABASE_URL` unset → PGlite (Postgres in WebAssembly, the engine the tests already run on) in
  `$DATA_DIR/db`; the same migrations at boot. PGlite is one connection, so standalone is **one process**: the api, the
  SPA and the job runner together. graphile-worker runs on a pg-pool look-alike over PGlite (`db/pglite-pool.ts`: a
  client's BEGIN…COMMIT holds PGlite's exclusive lock; LISTEN/NOTIFY per client); the realtime bus uses PGlite's own
  listen. Advisory locks and SKIP LOCKED work as on one Postgres session. The maintenance worker's tasks join the api's
  runner — `standalone.ts` is the **only** place the api imports `@bines/worker` (its `./tasks` export). With
  `DATABASE_URL` set the same entry uses Postgres (one process).
- **Files**: no S3 → `FILES_DIR` (`$DATA_DIR/files`), served by the API through short-lived HMAC-signed links with the
  presigned-URL semantics (the API checks access before signing); only inline-safe types inline, nosniff, own CSP.
- **Secrets**: missing `BETTER_AUTH_SECRET` / `SECRET_MASTER_KEY` are generated once into `$DATA_DIR/secrets.json`
  (0600); the environment wins; values never logged.
- **First-run setup** (`POST /setup`, public): only while no user exists; single by a claim row (`platform_settings` id
  `setup`, primary key) plus a re-check; the owner goes through the normal doors (first account + admin invitation,
  password sign-up with that invitation, accept). With `SEED_ADMIN_EMAIL` only that address may use it.
  `first-admin-link` keeps working for Postgres installs.
- **Email** off by default: password sign-in; the sign-in screen hides the email link / reset; invitations give a link
  to copy; the owner console says how to add SMTP. Magic links are never written to a log.
- **Limits** (documented): small teams; one container per volume; scale = Postgres (`DATABASE_URL`) / compose.

## D32. Self sign-up — off by default, through the existing doors

Amends D11 and D12's "no public sign-up that creates an account": a person may open an account of their own **only
while the platform owner turns it on** (owner console; `platform_settings` row `signup`, off by default).

- **The same doors**: the account and its starter kit (`provisionAccount`), the first-admin invitation (seats), a
  Better Auth password sign-up with that invitation's token (password policy), accepting it; then the plan's trial and
  the legal consent the form recorded. No new way to create a user except a Google / Microsoft sign-up the sign-up
  screen started (an HttpOnly intent cookie, 30 minutes, provider-verified address) — `auth.ts` reads it only when there
  is no invitation, and only while the switch is on.
- **Email first**: no account before the address is proved (the email link; Google / Microsoft only with a verified
  address). The answer is the same for every address; the email says "you already have an account". A magic link signs
  in only. The password is kept as its hash until the account exists.
- **Plans**: the person picks a public plan (the default pre-selected); the trial is the version's own days, else the
  sign-up setting (14); no card. The trial ends in **read-only at once** and is **suspended `read_only_days` (30)
  later**; closed only by hand — as the subscription's own rule (`account_subscriptions.trial_end_status`), so trials
  the owner gives by hand keep the billing settings' rule.
- **Protections**: Turnstile mandatory (cannot be turned on without the platform's keys), honeypot, throw-away inbox
  list + the owner's block / allow lists + "work email only", per-address-per-hour / per-email-per-day / platform daily
  limits (counted from `signup_requests`), and a manual-approval switch (off).
- **Joining by domain**: an account may let people with a verified email domain join it (`mode: domain_join`).
- **Editions**: superseded by D33 — no key of any kind is needed; outbound email is required.

## D33. Open source for everyone: AGPL-3.0, nothing locked, every installation may host and sell

Replaces D29. The platform is published under the GNU AGPL-3.0-only with section 7 additional permissions
(`LICENSE-EXCEPTIONS.md`: extensions through the public API / SDKs under any license; attribution; trademarks in
`TRADEMARKS.md`), the SDK packages (`packages/sdk`, `packages/ext-sdk`, `packages/create-bines-app`) and the
integrations stay MIT, and contributions come under a CLA that promises the contribution always stays available under
an OSI license. There is no enterprise code, no license-gated feature and no edition limit.

What stays, and is open to every installer:

- **Hosting others ("platform mode")** — the owner console's plans, prices, Stripe, self sign-up, legal documents,
  trial emails and support are the same on every installation; the Self sign-up switch is the one gate. Plan limits on
  hosted accounts are the operator's business with its customers, not a lock on the software.
- **License keys as a record** — a key names a plan, seats, support level and expiry; it unlocks nothing
  (`LICENSED_FEATURES_BUILT` is empty). The owner console shows it; above the seats a warning only.
- **A license server from the console** — any installation makes its own Ed25519 signing key (sealed with
  `SECRET_MASTER_KEY`, `platform_settings` row `license_server`; `LICENSE_SIGNING_KEY` in the environment still works,
  the console's key wins), publishes the public key at `/public/licenses/key`, and trusts its own key. An installation
  stores its provider's public key beside the server address (fetched when the address is saved, or pasted) and trusts
  only the keys of providers it chose — the key built into `public-key.ts` stays trusted for existing installations.
- **Telemetry** stays opt-in, off by default, sent only to the provider the owner configured.

Why: the simplest possible install for people and AI (nothing to register, nothing to unlock), no dependence on the
original author or their server, and what was built for the author's own hosting becomes a feature of the product.
The documentation describes the product in its own terms (`LICENSING.md`, `GUIDE.md` §1/§5/§6).
