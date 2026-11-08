# 08 — Account, administration and user profile

This document specifies how an account (tenant) is created and administered — settings, users, teams, security,
support access, API tokens, usage, tidy-up, trash, audit log — and what each person controls in their own profile.
It is for developers working on the API or the admin screens, and for self-hosters who want to know what an account
admin can configure.

> Everything here is available to every account; nothing is locked behind a plan unless the installation's plans say
> so. Endpoints are under `/api/v1` and require `membership.role = admin` unless stated otherwise. Every admin action
> writes an `audit_log` row.

## 1. Sign-up and the first account

Multiple accounts: see D12 in [`DECISIONS.md`](DECISIONS.md).

- **Joining an existing account** happens through an invitation (`/invite/:token`) or an allowed email domain of an
  existing account (§5). Self sign-up that creates a new account exists but is **off by default** (D32); the
  platform owner turns it on in the owner console.
- The seed (`pnpm db:seed`, `src/db/bootstrap.ts`) creates the **platform owner** (`users.is_platform_owner = true`,
  `SEED_ADMIN_EMAIL`) and — **only when no account exists at all** (not even a deleted one) — the first account
  (`SEED_ACCOUNT_NAME` / `SEED_ACCOUNT_SLUG` / `SEED_TEMPLATE_SET`; locally "Demo" / `demo` / `default` = a workspace,
  folders 01–07 and boards from the templates), and invites the platform owner into it as admin. The account is not
  identified by slug or name, so renaming it in the owner console does not create a duplicate on the next deploy.
- **Additional accounts** are opened from the owner console (`/owner` → "New account"): name, slug, the first admin's
  email, a starter set (`empty`, or a template set such as folders 01–07 with empty boards from the templates), time
  zone and currency. The account, its `account_settings` with the defaults of §2 and an invitation email (branded
  with the new account's name) are created. From then on the account's admin manages it alone; the platform owner
  sees none of its data unless invited or granted support access (§6).
- Owner console: a table of accounts (name, slug, status, created, users per role, boards, items, storage,
  automation actions this month) with actions: rename / change slug, suspend / restore (with a reason), soft delete
  (type the slug to confirm; final purge only if the owner turned on `account_deletion.purge_console_deleted` — see
  §2.1), resend the admin invitation. Endpoints: [`06-API.md`](06-API.md) §2.1a.
- URL: `https://work.example.com/a/<slug>/...` — one domain and one session for all accounts; `/` redirects to the
  last account (`last_account_id`) or to an account picker. The account switcher is in the avatar menu.

## 2. Account settings (Administration → General)

Table `accounts` plus the `account_settings` JSONB (`packages/shared/src/account/settings.ts`). Main fields:

| Field                                 | Key                                                                                         | Default                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Account name                          | `name`                                                                                      | "Demo"                                                                        |
| Slug                                  | `slug`                                                                                      | `demo`                                                                        |
| Logo (sidebar) and email logo         | `PUT /accounts/me/logo`, `PUT /accounts/me/email-logo`                                      | — (40×40 PNG recommended)                                                     |
| Portal name                           | `branding.portal_name`                                                                      | the account's name                                                            |
| Email sender name, reply-to, look     | `branding.email_sender_name`, `branding.email_reply_to`, `branding.email_accent_color`, `branding.email_style` | the platform's                                                                |
| Weekend                               | `locale.weekend: 'fri_sat' \| 'sat_sun'`                                                    | `fri_sat`                                                                     |
| First day of the week                 | `locale.first_day: 0..6`                                                                    | 0 (Sunday)                                                                    |
| Language / time zone / date and time format | `locale.language: 'he' \| 'en'`, `locale.timezone`, `locale.date_format`, `locale.time_format: '24h' \| '12h'` | `he`, `Asia/Jerusalem`, `DD/MM/YYYY`, `24h`                                   |
| Currency                              | `locale.currency`                                                                           | `ILS`                                                                         |
| Default status labels for new columns | `defaults.status_labels[]`                                                                  | In progress (`yellow`) / Done (`forest`, `is_done`) / Blocked (`crimson`) — keys from our palette ([`11-UI-DESIGN.md`](11-UI-DESIGN.md) §9.1) |
| Default item terminology              | `defaults.item_terminology`                                                                 | `item`                                                                        |
| Default group colours                 | `defaults.group_colors`                                                                     | empty = the palette order (`forest`, `yellow`, …)                             |
| Account domains                       | `domains`                                                                                   | — (a guest must use another domain)                                           |
| System announcement banner            | `announcement: {text ≤150, url?, until?}`                                                   | —                                                                             |
| Notification defaults for new members | `notifications` (§12.3)                                                                     |                                                                               |
| Account permissions                   | `permissions` ([`05-PERMISSIONS.md`](05-PERMISSIONS.md) §7)                                 |                                                                               |
| Also                                  | `sms`, `api_limits`, `invitations`, `session_checks`, `downloads`, `tours`, `inbound_email`, `pwa`, `calendar`, `idoc_themes` | see the schema                                                                |

**Region settings apply everywhere** (`packages/shared/src/locale/format.ts` — one formatting module; no scattered
`toLocale*` calls): every date and time in the UI (cells, item card, updates, activity log, My Work, inbox,
notifications, time log), calendars (first day of the week, weekend shading) and the calendar view, numbers and
currency. The web app keeps a "current region" (`apps/web/src/lib/region.ts`) = the account's settings plus the
language and time zone from the user's profile; changing it refreshes the UI. On the server, the cell text in DTOs
(date / timeline / creation log / last updated) is rewritten for the reader's region (`modules/accounts/region.ts`),
and so are exports, time reports and the audit / users CSVs. Automations and service tokens write in the account's
region (`{x|date}` without a pattern = the account's format, `{x|currency}` = the account's currency). The stored
`text_value` stays canonical (DD/MM/YYYY, UTC) for search and sorting.

Endpoints: `GET/PATCH /accounts/me`, `PUT/GET/DELETE /accounts/me/logo`, `PUT/DELETE /accounts/me/email-logo`,
`GET /accounts/me/email-preview`, `POST /accounts/me/email-test`.

### 2.1 Your data — export and account deletion

- **Export all data** (admins): `POST /account-export` → the `account.export` job builds one ZIP in the background (a
  temporary file, item by item, files streamed from storage one at a time): `boards/<board>.xlsx` (an items +
  subitems sheet and an updates sheet), `docs/<doc>.md|.html`, `files/<board>/<item>/<file>`, `users.csv`,
  `README.txt`. It is kept in storage under `exports/<account>/` for the owner's `export_days` (default 7), the
  requester gets an email, and it is downloaded from `GET /account-export/{id}/download` (a short-lived link, audited).
  The export reads as the requester — a private board or doc they are not a member of is left out and listed in the
  summary and in the README. The hourly sweep deletes expired files (`expired`).
- **Deleting the account** (admins — there is no separate "account owner" role): the export is offered first, the
  account name is typed again, and a fresh 2FA code is required (`POST /account-deletion`; without 2FA → 403
  `step_up_two_factor_required`). The account is locked at once like a closed account: only `GET /account-deletion`,
  `POST /account-deletion/cancel`, the export and support answer (others: 403 `account_deletion_scheduled`), and all
  background work stops (entitlements read it as `closed`). The grace period is the owner's `grace_days` (default 30);
  every admin is emailed when it is scheduled, 7 days before and 1 day before; any admin can cancel.
- **Final deletion** (job `account.deletion_sweep` every hour, or "Delete now" in the owner console with the slug and
  the owner's 2FA): first the people for whom this is their only account are recorded, then the storage files (before
  the rows), every table with `account_id` in batches and several passes, one `platform_audit_log` row
  (`account.purged`, unique), emails to people left with an empty profile, and finally the account row. Idempotent and
  resumes after a crash. The sweep purges automatically only accounts scheduled for deletion (`deletion_due_at`).
  Accounts the owner soft-deleted from the console are purged after the same grace period only when the owner turned
  on `account_deletion.purge_console_deleted` (console → platform settings, "Also purge accounts deleted from the
  console"; **off by default**, so an existing installation never permanently deletes old, previously deleted accounts
  without the owner choosing it).

## 3. User management (Administration → Users)

Tables: `users` (global: email, name, password hash via Better Auth) and `account_members` (account_id, user_id,
role, status, title, department, invitation and activation data).

Screen: a table with search and filters (role, status, team); columns: name, email, role (inline dropdown), teams,
last sign-in, status. Row menu: edit, change role, reset 2FA, recovery link, deactivate / activate, delete details,
transfer ownership. **Bulk**: select ⇒ bottom bar: change role / add to team / deactivate / activate / resend
invitation (≤200 per action; never yourself; the last admin cannot be demoted).

### 3.1 Invitations

`POST /users/invite` `{email, role, board_ids? (for a guest: shareable boards only, attached on acceptance — D23),
message?}` ⇒ a pending invitation and an email with a link to `/invite/<token>`. Lifetime and resend wait are account
settings (`invitations`). `GET /users/invitations`, `POST /users/invitations/{id}/resend`,
`POST /users/invitations/{id}/link` (copy the link), `DELETE /users/invitations/{id}`. Guests can sign in with a
magic link (no password required).

- Validation: guest ⇒ the domain must not be in `account.domains` (otherwise 400 `use_member_role`);
  `guest_domain_policy` (§5) is checked; with `restrict_members_to_domains` on, members must use an account domain.
  Who may invite whom is an account permission (`invite_members`, `invite_viewers`, `invite_guests`).
- Auto-join: someone signing up with an email in a verified account domain while `auto_join = true` joins as
  `auto_join_role` (`member` by default). Domain verification: `GET /security/domain-join`,
  `POST /security/domain-join/domains/{domain}/verify`.

### 3.2 Deactivation versus deletion

**Deactivate** (`POST /users/{id}/deactivate`):

- The user's sessions and API tokens are revoked; status `deactivated`; they no longer count as a seat.
- They stay assigned on items (shown greyed out). Automations and webhooks they own are disabled with reason
  `owner_deactivated`; the dialog offers "Transfer ownership to…" first
  (`POST /users/{id}/transfer-ownership {to_user_id, scope}`). The account's default heir can be set with
  `PATCH /accounts/me/default-transfer-user`.
- Private / shareable boards where they were the only owner can be reassigned by an admin
  (`POST /admin/boards/{id}/transfer-ownership`).
- Reactivate: `POST /users/{id}/activate`.

**Delete details** (`DELETE /users/{id}/details`, only after deactivation, irreversible):

- Choose the display name: "Deleted user" (default) or first name only.
- The `users` row: email ⇒ `deleted+<ulid>@anon.invalid`, name ⇒ the choice, phone / photo / title ⇒ null,
  password / 2FA / OAuth ⇒ deleted, `anonymised_at` set.
- Content stays (items, updates, files, activity), attributed to the `user_id` (grey avatar). People assignments stay.
  Board ownership is removed; automations stay disabled.
- Audit: `user.anonymised`.

**A person's own erasure request** (GDPR Art. 17, and equivalent national privacy law): Profile → Security → "My data"
→ "Delete my details"; the person types their own email (`POST /me/erasure-request {confirm_email}`).

- Member of accounts: the request is recorded on every membership (`account_members.settings.erasure_requested_at`),
  every account admin is emailed, and the user list shows a "requested deletion" badge (`erasure_requested_at` in
  `GET /users`, admins only). The admin carries it out: deactivate → delete details. The person can withdraw while it
  is pending (`DELETE /me/erasure-request`). Audit: `user.erasure_requested` / `user.erasure_withdrawn`.
- Member of no account: the details are deleted at once (as in "delete details"), together with sign-ins and
  sessions.
- Platform owners, support staff and service users cannot use it — they contact the privacy address.

### 3.3 More endpoints

`GET /users` (filters, cursor), `PATCH /users/{id}` (role, title, department),
`POST /users/bulk` `{ids, op}`, `POST /users/{id}/reset-2fa`, `POST /users/{id}/recovery-link`,
`GET /users/export.csv`, `GET /users/{id}/export` (one person's data).

## 4. Teams

A team has a name, a colour and members. Admins create and edit teams. Teams are used
in people columns (`team:<id>`), board invitations, @mentions, column restrictions, "my teams" in filters and
`view_items` principals. Endpoints: `GET/POST /teams`, `PATCH/DELETE /teams/{id}` (membership is part of the team
object: `member_ids`).

## 5. Security (Administration → Security)

`account_security` JSONB (`accountSecuritySchema` in `packages/shared/src/api/admin.ts`):

| Setting                           | Key                                                                                                       | Default                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Minimum password length           | `password_min_length` (null = the platform's minimum)                                                     | null                          |
| Two-factor authentication         | `two_factor: {mode: 'optional' \| 'required_admins' \| 'required_all', grace_days, required_since}`; TOTP + backup codes | `optional`, 7 days grace      |
| Single sign-on only               | `sso: {required, providers: ['google','microsoft'], domains, exempt_admins, google_domains, microsoft_tenants}` | off                           |
| Account domains and auto-join     | `domains`, `restrict_members_to_domains`, `auto_join`, `auto_join_role`                                   | —, false, false, `member`     |
| Guest domain policy               | `guest_domain_policy: {mode: 'any' \| 'allow_list' \| 'block_list', domains[]}`                           | `any`                         |
| IP allowlist                      | `ip_allowlist: {enabled, ranges[], exempt_user_ids[]}` (addresses or CIDR ranges)                         | off; saving it on requires the saver's own address to be inside |
| Fresh-code ceiling for secrets    | `secret_max_verify_minutes`                                                                               | 12 hours                      |
| Support access                    | `support_access: {allow_edit, max_hours}` (§6)                                                            | `allow_edit: false`, 168 h    |
| CAPTCHA for public forms          | `GET/PATCH /security/captcha`                                                                             |                               |
| Sessions                          | `GET /security/sessions` (user, IP, user agent, created, last seen), `DELETE /security/sessions/{id}`, `POST /security/sessions/sign-out-all` |                               |

Endpoints: `GET/PATCH /security` and the ones listed in the table.

## 6. Remote support access

Data model: [`02-DATA-MODEL.md`](02-DATA-MODEL.md) §7.9. Administration → Security → "Support access": "Allow
access" (to whom — the platform's support or a named supporter by email; view only / view and edit; a duration from
the owner console's list; a reason), a list of active and past grants with revoke, and the account's settings: "Allow
edit access" (off by default) and "Maximum duration". `GET/POST /support-access`, `DELETE /support-access/{id}`,
`POST /support-access/recovery-requests/{id}/cancel` — session only, not tokens.

- Support acts as an admin without a membership. View-only = every change gets 405 `support_read_only` (REST; MCP
  exposes read tools only; the docs WebSocket is read-only). Edit = everything except people / invitations, tokens /
  OAuth / extensions, security and support access (403 `support_not_allowed`).
- Audit log: `support.granted|revoked|session.start|view|action|refused`, `support.emergency_recovery.*`. Every admin
  is emailed at the start of each support session (a console setting).
- `/auth/me` → `account.support {grant_id, mode, expires_at}`, and `/me/accounts` includes the account — this drives
  the "You are in support access" bar.
- Owner console: "Enter as support" only with an active grant; "Invite admin" to a platform-owner address and a
  recovery link — only with an active edit grant (or as an admin of the account). Without a grant there is an
  emergency path: every admin is emailed, a waiting period (default 24 hours) during which any admin can cancel,
  single use, all in the audit log. 2FA stays after a password reset.
- Console settings (`platform_settings.support`): durations, default, maximum, email on entry, logging of views,
  cool-down before a new entry, emergency wait, "the platform owner is exempt from IP allowlists" (on by default). In
  the account: personal exemptions from the IP allowlist (`ip_allowlist.exempt_user_ids`).

## 7. API tokens (Profile → Developers; Administration → Connections)

List: name, kind (personal / service), owner, scopes, boards, created, last used. Actions: create, revoke, edit. The
token is shown **once**; only a SHA-256 hash is stored. Endpoints: `GET /auth/tokens`, `POST /auth/tokens` (personal),
`POST /auth/service-tokens` (service, admins), `PATCH /auth/tokens/{id}`, `DELETE /auth/tokens/{id}`. A regular user
sees only their own tokens. Per-account API budgets: `account_settings.api_limits`. Details:
[`06-API.md`](06-API.md).

## 8. Usage (Administration → Usage)

`GET /usage?days=N` computes the numbers on the fly from the tables: automation runs and failures, webhook deliveries
and failures, storage and file count, items and boards, active people and members, a daily chart, the busiest
automations and the most recently used tokens. API calls are not counted per request (rate limits live in memory),
so `api_calls` is null.

## 9. Tidy up (Administration → Tidy up)

- A table of all boards: name, workspace, kind, creator, owners, last updated, items; actions: open / archive /
  delete / transfer ownership. Includes private and shareable boards as metadata (an admin sees the name, not the
  content). `GET /admin/boards`, `POST /admin/boards/{id}/archive`, `DELETE /admin/boards/{id}`,
  `POST /admin/boards/{id}/transfer-ownership`.
- **Scheduled cleaning**: rules run daily by the job `tidy.scheduled_cleaning` — `archive_done_items`,
  `archive_idle_boards`, `empty_trash`, `notifications_retention`, `activity_retention` (off until an admin turns
  them on; the first two can exclude workspaces), and the technical retention rules `doc_auto_versions`,
  `agent_run_logs`, `expired_oauth` (on by default). Each rule has its number of days within an allowed range.
  `GET/PUT /admin/tidy/rules`, `POST /admin/tidy/preview`, `POST /admin/tidy/run`, `GET /admin/tidy/runs`,
  `GET /admin/tidy/runs/{id}/export.csv` (a CSV of each run).

## 10. Trash

Avatar menu → Trash: everything deleted (workspaces, boards, groups, items, columns, views, updates, files) with type,
"deleted from" (full path), who deleted it and when; actions: restore / delete permanently. Kept 30 days, then purged
by the worker. Admins see everything; a user sees what they deleted and what they can edit. Restoring an item whose
board or group was deleted restores those too (or offers a destination). Endpoints: `GET /trash`,
`POST /trash/{id}/restore`, `DELETE /trash/{id}`, `DELETE /trash` (empty). An "Archive" tab next to it
(`archived_at`): `GET /archive`, `POST /archive/{type}/{id}/restore`.

## 11. Audit log

`audit_log(id, account_id, ts, actor, event, target, ip, user_agent, details JSONB)`. Events include sign-in
(`auth.login.*`, `auth.logout`, `auth.password_reset`), users (`user.invited|activated|deactivated|anonymised|role_changed`),
`security.settings_changed`, `support.*`, tokens, board deletion / kind and permission changes / exports,
`account.exported`, extensions, bulk downloads. Retention follows "Log retention" in the owner console
(`retention.audit_days`, default 730 days; empty = keep forever); the daily task `maintenance.retention` deletes older
rows, and does the same for `activity_days` (board history) and `notifications_days`. Screen: filter by user / event
/ date range, and CSV export. `GET /audit`, `GET /audit/export.csv`. (A board's `activity_log` is a different table —
the `activity` module.)

## 12. User profile (avatar → My profile)

### 12.1 Tabs and fields

| Tab                     | Fields                                                                                          | Endpoint                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Profile                 | name, title, phone, department, birthday, photo                                                 | `GET/PATCH /users/me`, `PUT/DELETE /users/me/avatar` |
| Language and region     | `locale: he \| en`, `timezone` (null = the account's)                                           | `PATCH /users/me`                            |
| Notifications           | §12.3                                                                                           | `GET/PATCH /me/notifications/settings`       |
| Appearance              | theme (light / dark / system), text size, density and similar, synced to every device          | `GET/PUT /me/appearance`                     |
| Security                | password, 2FA (enable / reset, backup codes), my sessions, "My data" (export, erasure request)  | Better Auth routes, `GET /me/security`, `POST /me/password`, `GET /me/export` |
| Developers              | personal tokens (§7)                                                                            | `/auth/tokens`                               |

### 12.2 Per-board notification settings

Board → ⋯ → Notifications: mute the board or choose categories for it — `GET/PUT /boards/{boardId}/notifications`.
The personal settings (§12.3) always apply on top.

### 12.3 Notification categories (bell / email / phone)

Four categories (`NOTIFICATION_CATEGORIES` in `packages/shared/src/api/notifications.ts`), each switchable per channel
— bell, email and phone push (PWA) — and per board:

| Category                                     | Key            |
| -------------------------------------------- | -------------- |
| Assigned to me                               | `assigned`     |
| Mentioned me                                 | `mentioned`    |
| Updates on items I follow or created         | `item_updates` |
| Reminders and system (automations, timers, plan, AI budget, …) | `reminders`    |

Email can be instant or a digest (`daily` / `weekly` at a chosen hour). The phone is off unless the account default
turns a category on (by default `assigned` and `mentioned`). Account defaults: `account_settings.notifications`.

**Notification types and "required".** Every notification type is registered once in `NOTIFICATION_TYPE_META`
(`packages/shared/src/api/notifications.ts`): its category (the switch in the settings) and `required`. Every
notification in the API is written through `notifyUsers` (`apps/api/src/modules/notifications/notify.ts`) — the
user's settings (bell / email / phone, per category and per board, the account defaults) decide; ESLint blocks
direct writes (`insertNotifications`) outside it. The worker (forgotten timer, email, push) reads the same
`channelAllowed`.
A **required** type (`required: true`) cannot be turned off by the user: it always reaches the bell and the email,
even when the category is off or the board is muted; the phone still follows the category's push switch (a type with
no category never rings the phone). Required types: security — `secret_reveals` (secret reveals above the
threshold), `ticket_access_request` (support asks to enter the account), `extension_update` (an extension version
asks for more permissions); billing — `plan_limit` (plan status / limit), `ai_budget` (AI budget); and support
tickets — `ticket_reply`, `ticket_status` (no switch; their email is sent by the tickets module according to the
support settings). Changing `required` is a product decision — update the table in the code and this paragraph
together.

## 13. Screens

`/a/<slug>/admin/<section>` — sections (`ADMIN_SECTIONS` in `apps/web/src/features/admin/AdminHub.tsx`): General ·
Notifications · Look and navigation · Users · Teams · Templates · Security · Connections · Flows · Extensions ·
AI & MCP · Usage · My plan · Tidy up · Audit log · Health.
`/a/<slug>/profile` (profile, language and region, notifications, appearance, security, developers),
`/a/<slug>/trash`, `/a/<slug>/archive`.

## 14. Endpoint summary

```
GET/PATCH   /accounts/me   PUT/GET/DELETE /accounts/me/logo   PUT/DELETE /accounts/me/email-logo
GET/POST    /account-export   GET /account-export/{id}/download   GET/POST /account-deletion   POST /account-deletion/cancel
GET/PATCH   /security   GET /security/sessions   DELETE /security/sessions/{id}   POST /security/sessions/sign-out-all
GET/PATCH   /security/captcha   GET /security/domain-join   POST /security/domain-join/domains/{domain}/verify
GET         /users   PATCH /users/{id}   POST /users/invite   GET /users/invitations
POST        /users/invitations/{id}/resend|link   DELETE /users/invitations/{id}
POST        /users/{id}/deactivate|activate|reset-2fa|recovery-link|transfer-ownership   DELETE /users/{id}/details
POST        /users/bulk   GET /users/export.csv   GET /users/{id}/export
GET/POST    /teams   PATCH/DELETE /teams/{id}
GET/POST    /support-access   DELETE /support-access/{id}   POST /support-access/recovery-requests/{id}/cancel
GET/POST    /auth/tokens   POST /auth/service-tokens   PATCH/DELETE /auth/tokens/{id}
GET         /usage   GET /admin/boards   GET/PUT /admin/tidy/rules   POST /admin/tidy/preview|run   GET /admin/tidy/runs
GET         /trash   POST /trash/{id}/restore   DELETE /trash/{id}   DELETE /trash   GET /archive   POST /archive/{type}/{id}/restore
GET         /audit   GET /audit/export.csv
GET/PATCH   /users/me   PUT/DELETE /users/me/avatar   GET/PUT /me/appearance   GET/PATCH /me/notifications/settings
GET/PUT     /boards/{boardId}/notifications   GET/POST/DELETE /me/erasure-request
```

## 15. Incoming email

Administration → Connections → "Incoming email" (`settings.inbound_email`): on / off (on by default once the
platform owner has configured a domain; an account can turn it off), and who may send — anyone (a sender outside the
account is marked "outside the account"), account members only (from a verified address), or specific domains (plus
account members). It requires a domain configured by the platform owner (`email.inbound_domain`); without one the
card says so. An item's address: in the item card's ⋯ menu ("Email to item"); a board's: in the board menu ("Email to
board"). Details: [`01-ARCHITECTURE.md`](01-ARCHITECTURE.md) §8.
