# 06 — REST API (`apps/api`)

This document describes the Bines OS HTTP API: its conventions (authentication, scopes, errors, pagination, rate
limits, real-time events), the main resources, worked examples, the SDK and no-code integrations, and the MCP server.
It is for developers who call the API from scripts, integrations or AI clients, and for contributors changing it.

Related documents: `docs/DECISIONS.md` (D2, D6, D7), `docs/03-COLUMN-TYPES.md` (cell value shapes),
`docs/04-AUTOMATIONS.md`, `docs/07-OPERATIONS.md` (what each operation does). The API is built with Hono +
`@hono/zod-openapi`; every route is declared with `createRoute({ request, responses })`, so the OpenAPI document is
generated from the code (`pnpm --filter @bines/api openapi:export` → `apps/api/openapi/openapi.full.json`).

> **The OpenAPI document is the exact contract.** Every running installation serves an interactive reference at
> `/api/docs`. The tables below summarize the resources and the reasoning behind them; where a body or a field differs
> from the OpenAPI document, the OpenAPI document is right.

---

## 1. Conventions

### 1.1 Base, versioning, content

- Base URL: `https://<host>/api/v1`. Breaking changes go to `/api/v2`; additive changes are unversioned.
  `GET /api/v1/openapi.json` serves the **public** document (the same as `/api/docs/openapi.json`: only what an API
  token may call — security finding S-47). The full document (every route, internal ones too; the SDK's source) is
  `GET /api/v1/openapi.full.json` for platform-owner sessions only (404 to everyone else), and is exported at build
  time with `pnpm --filter @bines/api openapi:export`.
- **Public API reference** at `/api/docs` (public, English): Scalar API Reference rendering `GET /api/docs/openapi.json`
  — the same document narrowed to what an API token may call (`apps/api/src/modules/apidocs/public-ops.ts`: routes
  forbidden in `lib/scopes.ts`, the owner console, sign-in plumbing and extension-token routes are left out), with
  guide pages (getting started, authentication & scopes, errors, pagination, rate limits, idempotency, webhooks,
  real-time, MCP, extensions — `guide.ts`, numbers taken from the code), a title and description per operation
  (`descriptions.ts`), the required scope and generated request/response examples (`examples.ts`). Internal doc
  references ("D12", "06 §1.2") are scrubbed from the public text. The renderer bundle is served from `node_modules`
  (`/api/docs/scalar.js`, no CDN) under `script-src 'self'`; the theme is in `theme.ts`. White-label via env:
  `PRODUCT_NAME`, `API_DOCS_LOGO_URL`, `API_DOCS_BRAND_COLOR`; base URL = `WEB_ORIGIN/api/v1`.
  `test/apidocs.test.ts` fails when a public operation has no wording or example, so a new endpoint cannot ship
  undocumented.
- JSON only (`Content-Type: application/json; charset=utf-8`), UTF-8; ids are strings (ULIDs for rows; column ids are
  the `[a-z_]` custom ids; group ids are slugs). Times are RFC 3339 UTC; dates are `YYYY-MM-DD`.
- Every response carries `X-Request-Id`; include it in bug reports.
- **Account scoping (D12)**: every account-scoped route requires `X-Account-Id: <account id>`. Session requests: the
  server checks an active `account_members` row for (user, account) — no row → `404 not_found` (existence is not
  leaked); deactivated → `403 forbidden`. Token requests: the token's account is used; a different `X-Account-Id` →
  `403 account_mismatch` (the header may be omitted for tokens). Suspended account → `423 account_suspended`. Unscoped
  routes: `/auth/*`, `GET /me/accounts`, `/users/me`, `/platform/*`, public forms, inbound hooks.

### 1.2 Authentication

| method | header / source | who | notes |
|---|---|---|---|
| Personal token | `Authorization: Bearer bos_pat_<40 chars>` | a user (member / admin) | Acts **as the user** with the token's scopes ∩ the user's permissions. Several tokens per user, each named, expiring, revocable. Viewers and guests cannot create tokens. |
| Service token | `Authorization: Bearer bos_svc_<40 chars>` | account-level service identity | Created by admins (`POST /auth/service-tokens`); a service user is a normal `users` row with `is_service = true`, can be a board subscriber/owner, and appears in the activity log as "Service: <name>". |
| Session cookie | `bos_session` (httpOnly, SameSite=Lax) | the web app | Better Auth session; CSRF protection by an `Origin` check on mutating requests. A session has implicit scopes = all. |
| Extension page token | `Authorization: Bearer bos_ext_…` | an extension's page in its sandboxed iframe, or its automation-action endpoint (D27) | Signed **10-minute** token for one user × one installation × one board × one feature, handed over by `postMessage` (never in a URL); acts as the user ∩ the scopes the admin granted ∩ the extension path allowlist (`packages/shared/src/extensions/token.ts`); checked against the installation as it is now on every request. |
| Extension server token | `Authorization: Bearer bos_xat_…` | an extension's own server (D27) | OAuth `client_credentials` at `POST /oauth/token` with the installation's `bos_extc_` / `bos_exts_` credentials; valid 1 hour; acts as the extension's service user with the same scope, board and path limits. Developer guide: [`docs/extensions/README.md`](extensions/README.md) (served at `/api/docs/extensions`). |
| MCP OAuth token | `Authorization: Bearer bos_oat_…` | an AI app connected through OAuth (§2.25, §5) | Only on `/mcp`. |
| Public form | none | anyone | only `GET /public/forms/:token`, `POST /public/forms/:token/uploads` and `POST /public/forms/:token/submit` |
| Inbound webhook | shared secret in `X-Bines-Secret` (required) | external systems | only `POST /hooks/in/:automation_id` |
| Inbound email | the mail provider's Svix signature (`RESEND_INBOUND_SECRET`; unsigned = 401) | Resend | only `POST /hooks/email/resend` |

`GET /auth/me` returns the resolved identity. Unauthenticated → `401 unauthenticated`; wrong scope →
`403 insufficient_scope` with `details.required`.

Tokens belong to one account each and may carry an optional `board_ids` limit. Scopes are checked by path + method
(`apps/api/src/lib/scopes.ts`). Each token has a per-minute and a per-day request budget (§1.10); an admin may set any
token's budgets, a member may lower their own token's budget but not raise it above what the account allows
(`403 token_limit_above_account`). `Idempotency-Key` is honoured per token/user for 24 hours (§1.9).

### 1.3 Scopes

`boards:read`, `boards:write` (boards, groups, columns, views, forms, templates, folders, workspace structure),
`items:read` (implied by `boards:read`), `items:write` (items, subitems, cells, links, files on cells), `updates:read`,
`updates:write`, `users:read`, `users:write` (invite / deactivate / roles; admin only), `teams:write`,
`automations:read`, `automations:write`, `webhooks`, `notifications:read`, `notifications:write`, `search`, `admin`
(account settings, audit log, support access, trash purge). A token's scopes are shown and chosen at creation; `admin`
only for admin users.

### 1.4 Error envelope

```json
{ "error": { "code": "validation_failed", "message": "cells.date_due: expected YYYY-MM-DD",
             "details": { "issues": [{ "path": ["cells","date_due"], "message": "expected YYYY-MM-DD" }] },
             "request_id": "req_01J…" } }
```

| HTTP | code | when |
|---|---|---|
| 400 | `bad_request`, `validation_failed`, `invalid_cursor`, `invalid_query_rules` | body/query invalid (zod issues in `details.issues`) |
| 401 | `unauthenticated`, `token_expired`, `token_revoked` | |
| 403 | `forbidden`, `insufficient_scope`, `guest_restricted`, `viewer_read_only`, `column_restricted`, `item_not_visible` | permission layer (D6); `item_not_visible` is returned as 404 to guests to avoid leaking existence |
| 404 | `not_found` | includes archived/trashed resources unless `?state=` asks for them |
| 409 | `conflict`, `revision_mismatch` (If-Match), `idempotency_conflict` (same key, different body), `last_group`, `column_id_taken`, `column_id_reused`, `locked` (concurrent structural change; retry) | |
| 412 | `precondition_failed` | `If-Match` present and stale |
| 413 | `payload_too_large` | > 2 MB JSON, > 500 MB file |
| 422 | `unprocessable`, `label_not_found`, `unmappable_pair`, `depth_exceeded`, `limit_exceeded` (e.g. 500 columns, 60 relation columns, 400 subscribers) | semantically invalid |
| 429 | `rate_limited` | `Retry-After` seconds |
| 500/503 | `internal`, `unavailable` | |

### 1.5 Pagination

Cursor-based lists: `?limit=100&cursor=<opaque>` (`limit` default 50, max **500**). Response:

```json
{ "data": [ … ], "next_cursor": "eyJ…", "has_more": true, "total": 1234 }
```

`total` is present only when `?count=true` (extra query). Cursors are stable for 60 minutes, encode the sort key, and
are invalid if `order_by` / filters change (`invalid_cursor`).

### 1.6 Filtering (items)

Query rules (`rules` + `operator`), sent as JSON in `POST /boards/:id/items/query` (or base64url-encoded in `?q=` on
`GET /boards/:id/items`):

```jsonc
{ "operator": "and",                                   // between rules
  "rules": [ { "column_id": "status", "operator": "any_of", "values": ["In progress", 1] },      // labels or indexes
             { "column_id": "date_due", "operator": "within_the_next", "values": ["DAYS", 7] },
             { "column_id": "timeline", "operator": "greater_than", "values": ["2026-10-01"], "compare_attribute": "END_DATE" },
             { "column_id": "name", "operator": "contains_text", "values": ["lead"] },
             { "column_id": "people", "operator": "any_of", "values": ["assigned_to_me"] } ],
  "groups": [ { "operator": "or", "rules": [ … ] } ],   // one level of nesting
  "group_ids": ["topics"],                              // restrict to groups
  "ids": ["itm_…"],                                     // ≤100
  "hierarchy": "parents" | "all",                       // default parents (depth 0)
  "state": "active" | "archived" | "all",
  "order_by": [ { "column_id": "__last_updated__", "direction": "desc" } ] }   // or __creation_log__, name, group, any column
```

Operators = `any_of, not_any_of, is_empty, is_not_empty, greater_than, greater_than_or_equals, lower_than,
lower_than_or_equal, between, not_contains_text, contains_text, contains_terms, starts_with, ends_with,
within_the_next, within_the_last`, plus shortcuts `older_than_days`, `newer_than_days`, `is_overdue`, `is_today`.
Which operators each column type accepts is listed in [`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md),
[`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md) and [`04-AUTOMATIONS.md`](04-AUTOMATIONS.md) §3. Dynamic date
values: `TODAY | TOMORROW | YESTERDAY | THIS_WEEK | THIS_MONTH | PAST_DATETIME | FUTURE_DATETIME | UPCOMING | OVERDUE`.
People values: `user:<id>`, `team:<id>`, `assigned_to_me`, `person-0` (blank). Everything is evaluated **after**
item-level visibility (D6).

### 1.7 Field selection

`GET /boards/:id/items?columns=status,owner,date_due` — each item's `cells` holds only the listed columns
(comma-separated column ids, at most **50**, each at most 64 characters; more → `400 validation_failed`). The item's own
fields (`id`, `name`, `group_id`, `parent_item_id`, `position`, `key`, dates…) always come. Ids the board does not have,
or columns the caller may not see (D6 column restrictions), are simply left out — never an error, never a leak: the
selection runs on cells already filtered by permissions. `columns=` (empty) returns no cells. It combines with `q`,
`ids` and `window`. The MCP / AI tool `query_items` takes the same selection as `columns: [...]` (same caps and rules).

There is no `?include=` expansion or `?fields=` trimming: every read returns its full object (items always with their
visible cells). Use `columns=` to keep item payloads small.

### 1.8 Revisions / ETag

Boards, columns, views, automations and forms carry `revision` (int). `GET` returns `ETag: "rev-<n>"`. Mutations accept
`If-Match: "rev-<n>"` (or a body `revision`); mismatch → `412 precondition_failed` with `details.current_revision`.
Structural writes (columns, group order, views) **require** `If-Match` from the web client; API clients may omit it
(last write wins), except `PATCH` of a column's `settings`, where it is mandatory (label reindexing is destructive).

### 1.9 Idempotency

`Idempotency-Key: <uuid>` on any `POST` / `PATCH` / `DELETE`. Stored 24 hours per token; a replay returns the stored
response (`Idempotent-Replayed: true`); the same key with a different body → `409 idempotency_conflict`. Bulk endpoints
also accept a per-row `client_ref`, echoed back.

### 1.10 Rate limits

What the server enforces (in process memory — `lib/rate-limit.ts`; counters reset on deploy, see
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) S-16):

| Limit | Default | Applies to | Configure |
|---|---|---|---|
| Per token | **600 requests/minute** personal, **1,200/min** service tokens; **10,000/day** personal, **50,000/day** service (a 24 h window from the first call) | requests with `Authorization: Bearer bos_…` | per token (`rate_limit_per_minute`, `daily_quota`; §1.2) |
| Per account | **3,000/minute**, all of the account's tokens together | token requests | env `RATE_LIMIT_ACCOUNT_PER_MIN` (0 = off) |
| Per client address | **5,000 per 10 seconds**, IPv6 counted per /64 | every `/api/*` request — app, tokens, auth, inbound hooks | env `RATE_LIMIT_IP_PER_10S` (0 = off) |
| Sign-in / password | Better Auth per address: sign-in 10/min, magic link 10/15 min, reset request 5/15 min, reset 10/min, change password 10/15 min | `/api/auth/*` | `auth/auth.ts` |
| Forgot password | 10 per address and 3 per email address / 15 min | `POST /auth/forgot-password` | code |
| Invitation emails | **50/hour** per inviter, all accounts together; a copied link is not an email | `POST /users/invite`, board and workspace invites, resend | env `INVITE_EMAILS_PER_HOUR` (0 = off) |
| Inbound hooks | **60 accepted calls/minute** per automation; **20 failed attempts / 10 min** per address and per automation (then 429 even with the right secret) | `POST /hooks/in/:id` | code |
| Public forms | **10 submissions / 10 min** per address, **500/hour** per form, **40 uploads / 10 min** per address | `/public/forms/*` | code (`FORM_LIMITS`) |
| AI changes (MCP, agents, assistant) | **60 writes/minute** per person, connection or agent; **600/minute** per account | write tools | account AI settings (`write_rate_per_minute`, `account_write_rate_per_minute`) |

The client address is the one the trusted proxy reports, never a header the client chose (S-10, `lib/client-ip.ts`):
`TRUST_PROXY=edge` (default — a platform edge proxy replaces `X-Forwarded-For`, its first entry is the client),
`TRUST_PROXY=<n>` (n proxies of yours append to it; the client is the n-th entry from the right) or `none` (no proxy:
the TCP peer); `CLIENT_IP_HEADER` picks another header (`x-real-ip`, `cf-connecting-ip`). The same address goes to the
audit log, the session list and Better Auth.

Token responses carry `RateLimit-Limit` (the token's per-minute limit), `RateLimit-Remaining`, `RateLimit-Reset`
(seconds) and `RateLimit-Policy: 600;w=60, 10000;w=86400`. Every 429 is `rate_limited` with `Retry-After` (seconds) and
`details.retry_after_ms`; `details.quota` says `day` or `account` when that budget ran out. Every request counts as one
(expensive endpoints are not weighted).

### 1.11 Events (SSE)

`GET /boards/:id/events` (`Accept: text/event-stream`): live events of a board and its sub-board — `activity` events
(`activity_log` rows, the [`04-AUTOMATIONS.md`](04-AUTOMATIONS.md) §5.2 shape minus `previous_value` for columns the
viewer cannot see) and `presence` (who is viewing). Also `GET /dashboards/:id/events` and `GET /me/events` (the user's
notifications / inbox). A reconnect with `Last-Event-ID` (or `?last_event_id=`) replays what was missed, up to 24 hours;
a gap too large to replay gets a `resync` event. A `: ping` comment every 15 s; the server ends a stream after 10
minutes and the client reconnects with `Last-Event-ID`. Clients re-fetch on events (D2).

### 1.12 Common query params

`?state=active|archived|deleted|all` on lists that support it; `?order_by=`; `?q=` where supported; `?account_id=` is
not accepted (the account comes from the token or `X-Account-Id`).

---

## 2. Resources

Notation: `S:` required scope. Request/response bodies are summarized; the OpenAPI document is the exact source. All
ids are path strings.

### 2.1 Auth

Better Auth serves `/api/auth/*` (sign-in/up, magic link, OAuth callbacks, sign-out, session). Password sign-up
requires the header `x-invite-token` (D12) unless self sign-up is on (§2.1a).

| method | path | S | request → response |
|---|---|---|---|
| GET | `/auth/config` | public | which sign-in buttons the login screen shows |
| GET | `/me/invitations` | session | pending invitations for my verified email → `[{id,email,role,expires_at,account:{id,name,slug}}]` |
| POST | `/me/invitations/:id/accept` | session | joins the account → `{id,name,slug,status,role}` |
| PUT | `/me/last-account` | session | `{account_id}` — where `/` lands next time |
| POST | `/invitations/preview` | public | `{token}` → `{account:{name,slug}, email, role, expires_at}` (the token goes in the body, never in a URL) |
| POST | `/invitations/accept` | session | `{token}`; the session email must equal the invitation email (`403 invitation_email_mismatch`) |
| GET · DELETE | `/users/invitations`, `/users/invitations/:id` | admin | list / revoke pending invitations; `POST /users/invitations/:id/resend`, `POST /users/invitations/:id/link` (copyable link) |
| GET | `/me/accounts` | session | unscoped → `[{id,name,slug,logo_url,role,status}]` for the account switcher (active memberships only, suspended accounts flagged) |
| GET | `/auth/me` | any | → `{ user:{id,name,email,role,is_guest,is_platform_owner,avatar_url,locale,timezone}, account:{id,name,slug}, auth:{kind:"session"\|"pat"\|"service"\|"extension", token_id?, scopes[]}, permissions:{…} }` |
| GET | `/auth/tokens` | any | own tokens (admins: every member's) → `[{id,name,prefix,scopes,expires_at,last_used_at,created_at,limits}]` |
| POST | `/auth/tokens` | any (not viewer / guest) | `{name, scopes[], expires_in_days?, board_ids?}` → `{token:"bos_pat_…"` (shown once)`, …}` |
| POST | `/auth/service-tokens` | admin | `{name, scopes[], …}` → a service user + its `bos_svc_` token (shown once) |
| PATCH | `/auth/tokens/:id` | own / admin | `{name?, scopes?, limits?}` |
| DELETE | `/auth/tokens/:id` | own / admin | revoke (immediate) |
| GET | `/auth/integrations` | any | the connected integrations (tokens used by no-code tools) |

### 2.1a Platform (owner console, D12)

Unscoped; session only; requires `users.is_platform_owner` (else `404`). Every call writes `audit_log` in the target
account with `actor_type=system`, `details.platform_owner_id`. Never returns board/item data. The owner console has many
more routes under `/platform/*` (plans, legal documents, guides, help center, support, licensing, error reports, costs);
see the OpenAPI document. The core ones:

| method | path | notes |
|---|---|---|
| GET | `/platform/accounts` | `?q=&status=` → accounts with member counts and usage |
| POST | `/platform/accounts` | `{name, slug, first_admin_email, first_admin_name?, …}` → `201 {account, invitation_id}`. Creates the account, its settings, a first workspace, the chosen starter kit and an invitation email. `409 slug_taken` / `422 slug_reserved` |
| PATCH | `/platform/accounts/:id` | `{name?, slug?}` |
| POST | `/platform/accounts/:id/suspend` · `/restore` | `{reason}`; suspend ends that account's sessions-in-context (SSE closed) and pauses its automations/webhooks |
| DELETE | `/platform/accounts/:id` | soft delete (`deleted_at`); requires `{confirm_slug}`. All rows + files are purged by the hourly `account.deletion_sweep` after `account_deletion.grace_days`, only when the owner turned on `account_deletion.purge_console_deleted` (off by default — otherwise the account stays soft-deleted). `POST …/deletion/cancel`, `…/deletion/now` |
| POST | `/platform/accounts/:id/invite-admin` | re-send / add an admin invitation |
| GET · PATCH | `/platform/signup-settings` | self sign-up (D32): `{settings, ready, missing[], open, edition: {registered, hosting}}`; turning it on while anything is missing → `422 signup_not_ready` (`details.missing`) |
| GET | `/platform/first-steps` | the console's first-steps card: `{steps: [{key: registration\|email\|legal\|plan\|signup, done}], dismissed}` |
| POST | `/platform/first-steps/dismiss` | close the first-steps card for good → the same shape |
| GET | `/platform/legal/consents.csv`, `/platform/legal/marketing.csv` | who accepted which version (`?slug=`), who agreed to marketing email |
| GET | `/platform/signup-requests` | `?status=&q=&limit=&before=` → `{data, next}` newest first |
| POST | `/platform/signup-requests/:id/approve` · `/reject` | approve = the account is created; reject `{reason?, block_domain?}`; `409` when not pending |

Account-level routes related to plans and domains (account admins, not the platform owner):

| method | path | notes |
|---|---|---|
| GET | `/plan/cancel` | what cancelling now would do — `case` (`cooling_off` \| `period_end` \| `yearly_refund` \| `yearly_no_refund`), paid, months used, fee, refund, `ends_at`, `automatic_refund`, the purchase terms |
| POST | `/plan/cancel` | `{expected_refund, reason?}` — carries it out (`409 cancel_changed` when the refund moved, `cancel_not_available`); returns the plan |
| POST | `/plan/cancel/undo` | a cancel that refunded nothing, before the period ends (`409 cancel_not_resumable`) |
| GET | `/security/domain-join` | each account domain's verification + its DNS TXT record, auto-join and role, `available` (the platform's sign-up open), `join_url` |
| POST | `/security/domain-join/domains/{domain}/verify` | verify an account domain: the admin's own verified address at it, else its TXT record `bines-domain-verification=<token>`; `422 domain_free_mail` / `domain_record_not_found`, `409 domain_taken` |

**Self sign-up (public, D32).** Off by default: every route but `config` answers `404` until the owner turns it on; on
but not workable (key removed, email off) = `503 signup_unavailable`. `GET /public/signup/config` (`open`, methods,
plans, documents, site key) · `POST /public/signup/start` (email + password; always `{ok:true}` — the email says
"verify" or "you already have an account") · `POST /public/signup/resend` · `POST /public/signup/verify` `{token}` →
`{status: provisioned|pending_approval, account}` + session cookie · `POST /public/signup/intent` (before Google /
Microsoft; sets an HttpOnly cookie for 30 minutes) · `POST /public/signup/complete` (signed in by the provider).
Refusals: `400 captcha_required|captcha_failed`, `422 signup_email_not_allowed` (`details.reason`),
`422 legal_consent_required`, `422 signup_method_unavailable`, `429 rate_limited|signup_daily_cap`,
`409 signup_already_registered`.

### 2.2 Accounts & settings

| method | path | S | notes |
|---|---|---|---|
| GET | `/accounts/me` | any | the account: name, slug, plan, time zone, first day of week, date format, branding, features, item terminology default, trash retention |
| PATCH | `/accounts/me` | admin | same fields |
| PUT · DELETE · GET | `/accounts/me/logo`, `/accounts/me/email-logo` | admin | the account's logo and email logo |
| GET · POST | `/accounts/me/email-preview`, `/accounts/me/email-test` | admin | preview / send a test of the account's email look |
| GET | `/usage` | admin | storage, items, boards, automation actions |
| GET · PATCH | `/security` | admin | security settings (session length, two-factor policy, authorized domains, guest domain policy, IP allow-list) |
| GET · DELETE | `/security/sessions`, `/security/sessions/:id`; POST `/security/sessions/sign-out-all` | admin | active sessions |

### 2.3 Users, members, teams

| method | path | S | notes |
|---|---|---|---|
| GET | `/users` | users:read | members of the account; guests get only users sharing a board with them |
| GET · PATCH | `/users/me` | session | my profile `{name, title, phone, locale, timezone, …}` |
| PUT · DELETE | `/users/me/avatar` | session | PUT `{file_id}` — my own finished upload, `image/*`, ≤5 MB (`422` / `413`) → `{avatar_url}`; the photo belongs to the user in every account. Members (`GET /users`) and `/auth/me` carry `avatar_url`: a 1-hour inline signed URL, else the sign-in provider's picture, else `null` |
| POST | `/users/invite` | users:write | `{emails[], role:"admin"\|"member"\|"viewer"\|"guest", board_ids?[] (subscribed on accepting; the inviter needs board invite rights; guests only on shareable boards), message?}` → `{invited:[{id,email,status:"pending"}], errors:[{email,code}]}`. A guest must have a domain outside the account's authorized domains (`guest_domain_not_external`). |
| PATCH | `/users/:id` | users:write | role and profile fields (admin only for `role`) |
| POST | `/users/:id/deactivate` | users:write | body `{transfer_to_user_id?}`. Effects ([`07-OPERATIONS.md`](07-OPERATIONS.md) §9.4): sessions and tokens revoked, seat freed, owned automations transferred or deactivated, sole-owned private/shareable boards listed in the response. Cannot deactivate yourself or the last admin. |
| POST | `/users/:id/activate` | users:write | reactivate |
| POST | `/users/:id/transfer-ownership` | admin | hand a member's boards / automations to another member; the account default is `GET · PATCH /accounts/me/default-transfer-user` |
| DELETE | `/users/:id/details` | admin | "delete details": only when inactive; irreversible; content kept, attributed to a grey avatar; audit row |
| POST | `/users/:id/recovery-link` · `/users/:id/reset-2fa` | admin | account recovery for a member |
| GET | `/users/export.csv`, `/users/:id/export` | admin | member list / one member's data export |
| POST | `/users/bulk` | admin | bulk role / deactivate actions |
| GET · POST · PATCH · DELETE | `/teams`, `/teams/:id` | read: non-guests · write: admins | `{id, name, color, member_ids}`; teams can be assigned in people cells and count as "mine" |

### 2.4 Workspaces

| method | path | S | notes |
|---|---|---|---|
| GET | `/workspaces` | boards:read | closed workspaces only for their members |
| POST | `/workspaces` | boards:write (member+) | `{name, kind:"open"\|"closed"}` |
| PATCH · DELETE | `/workspaces/:id` | creator / admin | PATCH `{name?, kind?}`; DELETE (admin) only an **empty** workspace (`409 workspace_not_empty`), never the last one (`409 last_workspace`); its folders go with it ([`14-CONTEXT-MENUS.md`](14-CONTEXT-MENUS.md) §8) |
| GET · POST | `/workspaces/:id/members` | boards:read / owner | `[{user_id, kind:"owner"\|"member"}]`; DELETE `/workspaces/:id/members/:userId` |
| GET | `/workspaces/:id/tree` | boards:read | sidebar payload: folders (nested ≤3) + boards + dashboards + docs with `position` (lexorank), filtered by visibility |

### 2.5 Folders

| method | path | S | notes |
|---|---|---|---|
| POST | `/folders` | boards:write | `{workspace_id, parent_folder_id?, name, color?}` (depth ≤3 → `depth_exceeded`) |
| PATCH | `/folders/:id` | creator / admin | `{name?, color?, workspace_id?, parent_folder_id?, position?:{after_id}\|{before_id}}` — rename, recolour, reorder, move into another folder (never into itself, at most three levels) or to another workspace's root with all its contents |
| DELETE | `/folders/:id` | same | the folder and its sub-folders go to **trash**; their boards move to the workspace **root** ([`14-CONTEXT-MENUS.md`](14-CONTEXT-MENUS.md) §7 — nothing reachable is lost); the event lists `board_ids` so undo can put them back |

### 2.6 Boards

| method | path | S | notes |
|---|---|---|---|
| POST | `/boards` | boards:write | `{name, workspace_id?, folder_id?, kind:"main"\|"shareable"\|"private", template_key?, …}` → board (creator = owner). `template_key` creates the board from a template (§2.22) |
| GET | `/boards/:id` | boards:read | the board with its columns, groups, permissions, `subitems_board_id` / `parent_board_id`, `revision` |
| PATCH | `/boards/:id` | owner (or edit_everything) | `{name, description, item_terminology, kind ("main"\|"private"\|"shareable" — owners / admins; the sub-board follows), folder_id (null = root), workspace_id (move to another workspace — its root unless `folder_id` is one of its folders; needs management rights there), default_view_id, settings:{…, item_defaults{column_id:value}}, card:{tabs:[{id, type:"updates"\|"fields"\|"time"\|"activity", title?, hidden, columns?[]}]}}` + `If-Match` |
| DELETE | `/boards/:id` | owner/admin | → trash 30 days |
| POST | `/boards/:id/duplicate` | create boards | `{mode: structure\|items\|items_updates, name?, folder_id?, keep_subscribers?}` → 201 the new board |
| POST | `/boards/:id/save-as-template` | owner/admin | `{name, description?}` → 201 `{key, name}`: an account template listed by `GET /templates` and usable as `template_key` in `POST /boards` |
| GET · PUT | `/boards/:id/permissions` | read / owner-admin | `{permission_set, view_items:{mode:'all'\|'assigned_or_created', column_ids:[keys]\|'any_people'}, members:[{user_id,name,email,role}], column_restrictions:[{column_id, kind}], can_manage}`; PUT `{permission_set?, view_items?}` |
| PUT · DELETE | `/boards/:id/members/:userId` | invite (subscriber) · owner-admin (owner, others) | `{role: owner\|subscriber}`; a board keeps an owner (`409 last_owner`); anyone may remove themselves. Teams: `PUT · DELETE /boards/:id/teams/:teamId` |
| POST | `/boards/:id/invite` | invite rights | invite people by email straight to the board |
| POST | `/boards/:id/claim` | admin | take ownership of an ownerless board |
| PUT | `/boards/:id/columns/:col/restriction` | owner/admin | `{kind: 'edit'\|'view'\|null}` — owner-only edit / view |
| GET · PUT | `/boards/:id/notifications` | self | `{mode:"all"\|"mute"\|"custom", custom:{mentions,assignments,automations,updates}}` |
| POST | `/boards/:id/export` | boards:read + permission `general.export` | xlsx / csv export of the board or a view |
| GET | `/boards/:id/activity` | boards:read (guests: forbidden) | activity log, `?item_id=&user_id=&type=&from=&to=&cursor=` |
| GET | `/boards/:id/update-counts` | boards:read | `{counts:{item_id:n}}` — top-level updates per item the viewer may see |
| GET · POST · DELETE | `/admin/boards`, `/admin/boards/:id`, `/admin/boards/:id/archive`, `/admin/boards/:id/transfer-ownership` | admin | every board in the account, for administration |

Import from Excel / CSV runs in the browser: the file is read client-side, its columns are mapped onto the board's
columns (or new ones), and the rows are written through the normal item endpoints (up to 10,000 rows per import).

### 2.7 Groups

| method | path | S | notes |
|---|---|---|---|
| POST | `/boards/:id/groups` | structure right | `{title, color?, position?}` |
| PATCH | `/boards/:id/groups/:groupId` | structure | `{title, color, …}` |
| POST | `/boards/:id/groups/:groupId/reorder` | structure | `{position}` |
| POST | `/boards/:id/groups/:groupId/move-to-board` | structure + `move_to_board` right on both | `{board_id, mapping}` → the group moves with its items; unmapped columns are dropped |
| POST | `/boards/:id/groups/:groupId/duplicate` | structure | `{with_items?=true}` → 201 the group copy right below |
| POST | `/boards/:id/groups/:groupId/archive` | delete rights | a group takes its items; never the last group |
| DELETE | `/boards/:id/groups/:groupId` | structure | items go to trash with the group; `409 last_group` |

### 2.8 Columns

Column keys are unique only per board, so column routes are board-scoped (`/boards/:boardId/columns/:columnId`).
Columns are returned with `GET /boards/:id`.

| method | path | S | notes |
|---|---|---|---|
| POST | `/boards/:id/columns` | structure | `{id?: "[a-z_]{1,20}", title, type, description?, settings?, after_column_id? \| before_column_id?, width?}` (never before `name`); the id must be unique on the board **and never used before on it** (`409 column_id_reused` — ids of deleted columns are kept in `board_column_id_history`); an omitted id becomes `<type>` or `<type>_<4 random a-z>` |
| PATCH | `/boards/:id/columns/:col` | structure | `{title, description, settings, width, …}` + `If-Match` required when `settings` is present. Removing a status label in use → `422 label_in_use` with `details.count` unless the request maps old labels to new ones |
| POST | `/boards/:id/columns/:col/convert` | structure | change the column's type ([`DECISIONS.md`](DECISIONS.md) D28): values are converted, a backup is kept. `GET /boards/:id/conversions[/:conversionId]` (history, progress, report), `GET …/conversions/failed`, `POST …/conversions/:conversionId/undo` · `/restore` (from the backup) · `/clear-failed` |
| POST | `/boards/:id/columns/:col/reorder` | structure | `{position:{after_id}\|{before_id}}` |
| DELETE | `/boards/:id/columns/:col` | structure | → trash (30 days) with its cells; the response lists automations that will deactivate |
| GET · PUT | `/boards/:id/columns/:col/sequence` | boards:read / column update | item ID column ([`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md) §2.19): `{sequence: {prefix, padding, next_seq, max_seq} \| null}`; PUT `{next_seq}` — must be above `max_seq` (`400 next_seq_too_low`) |
| GET | `/boards/:id/columns/:col/values` | boards:read | `?q=` → `{data:[{value,count}]}` up to 20 distinct display values, most used first (text suggestions, 03 §2.2); view-restricted columns → 404 |
| GET | `/boards/:id/columns/:col/choices` | boards:read | the labels of a status / dropdown column (for no-code tools) |
| PUT | `/boards/:id/columns/:col/two-way` | structure | make a relation column two-way |
| GET · POST | `/boards/:id/columns/:col/workflow-versions`, `…/workflow-versions/:version/restore` | structure | history of a status column's workflow |

### 2.9 Items

| method | path | S | notes |
|---|---|---|---|
| POST | `/boards/:id/items` | items:write | `{name, group_id?, cells?:{column_id:value}, position?, create_labels:false, client_ref?}` → the item. Board **item defaults** are applied under the given cells. Example §3.1 |
| POST | `/boards/:id/items/query` | items:read | body §1.6 + `{limit, cursor}` → page. Example §3.2 |
| GET | `/boards/:id/items` | items:read | every item of the board with its visible cells; `?q=` (base64url query, §1.6) filters and sorts; `?columns=a,b` = only those cells (§1.7). **Windowed boards:** `?window=1[&window_min=n]` — a top-level board with more than n (default `WINDOW_MIN_ITEMS` = 3,000) live items answers `{data: [], windowed: {total, threshold}}` instead of every row; `?ids=a,b,…` (≤200) = just those rows ([`PERFORMANCE-REVIEW.md`](PERFORMANCE-REVIEW.md) §7.1) |
| GET | `/boards/:id/items/count`, `/boards/:id/items/search` | items:read | count / name search |
| POST | `/boards/:id/items/outline` | items:read | for windowed boards: `{query, summaries:[{column_id, fn?}], group_summary?, lanes_by?, layout: groups\|flat}` → `{total, sections:[{key, label?, color?, ids[], summaries:{col: ColumnSummary\|null}, group_summary?}], grouped_by?, truncated?, skipped_summaries?}` — every matching id in view order per group / bucket (the same engine as the browser), footers over the whole section. Computed-column footers are left out above 5,000 matches (`skipped_summaries`) |
| POST | `/boards/:id/items/bulk-query` | per action | `{query, action}` — the `items/bulk` action on every item the query matches (≤50,000), one batch, one undo |
| GET | `/items/:id` | items:read | the item with its visible cells |
| PATCH | `/items/:id` | edit right on the item | `{name?, cells?:{column_id:value\|null}, create_labels?}` — a batch cell update in one activity batch |
| POST | `/items/:id/move-to-group` | content+ | `{group_id, position?}` |
| POST | `/items/:id/reorder` | content+ | `{position}` within its group |
| POST | `/items/:id/move-to-board` | `move_to_board` right | `{board_id, group_id?, mapping}` → `{ok, event_id, dropped}`. `mapping` = source column id → target column id (same type) or null; without `mapping` the server maps by type + title, as the move dialog proposes. Subitems follow (auto-mapped). Undo restores the full snapshot. Example §3.3 |
| POST | `/items/:id/convert` | structure | item ↔ subitem: `{parent_item_id \| group_id, mapping?}` |
| POST | `/items/:id/outdent` · `/items/:id/reparent` | structure | hierarchy moves (same service as the `move_under` / `move_up` bulk actions and the MCP tool `move_item_in_hierarchy`) |
| POST | `/items/:id/duplicate` | create items | `{with_updates?}` → 201 the copy right below ("X (copy)"): cells (not the time log / files), relation links, subitems; updates when asked. Undo (`item.duplicated`) trashes the copy |
| POST | `/items/:id/subitems` | create items | `{name, cells?}` → 201 the subitem, on the board's sub-board (D14; created on first use with the columns name / people / status / date). A subitem of a subitem goes one level deeper (≤ `hierarchy_depth_max`, else `422 depth_exceeded`). `POST /boards/:subBoardId/items` → `400 subitems_need_a_parent`; renaming / deleting a sub-board → `400 sub_board`. The sub-board's columns, items and cells use the normal endpoints with the parent board's rights |
| POST | `/items/:id/archive` | delete right | → `{ok, event_id}` |
| DELETE | `/items/:id` | delete right | → trash |
| POST | `/boards/:id/items/bulk` | per action | `{item_ids (1..5,000), action}`, see below |
| GET | `/items/:id/activity` | items:read | the item's activity log |
| GET · PUT | `/items/:id/follow` | self | follow / unfollow the item |

**Bulk actions** (`POST /boards/:id/items/bulk`): `action` = `{type:"delete"}` · `{type:"archive"}` ·
`{type:"duplicate"}` · `{type:"move_to_board", board_id, group_id?, mapping}` · `{type:"move_to_group", group_id}` ·
`{type:"set_cell", column_id, value}` (`null` clears) · `{type:"change_links", column_id, add[], remove[]}` (relation
columns; each item keeps its other links) · `{type:"shift_dates", column_id, days}` (date / timeline) ·
`{type:"move_under", parent_item_id, mapping?}` (under an item / subitem of the same board; items of the board go to the
sub-board, cells by `mapping`, automatic when omitted) · `{type:"move_up"}` (a sub-subitem under its grandparent, a
subitem to an item after its parent). One transaction, one `batch_id` on every event + a
`batch.executed {action,count,skipped}` summary → `{ok, batch_id, event_id, done, skipped}`;
`POST /activity/:event_id/undo` undoes the whole batch. Unknown / other-board / not-allowed (edit_assigned) items are
**skipped and counted**; a bad value fails the request (422). For hierarchy moves own subitems come along; a checked
row whose checked ancestor carries it counts as done; the branch must fit `hierarchy_depth_max`
(`422 tree_too_deep`), never under itself or its own subitems (`400 tree_cycle`); `item.create` is required on the board
the rows land on. To act on everything a filter matches, use `POST /boards/:id/items/bulk-query`.

**Time tracking** ([`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md) §3.3):

| method | path | S | notes |
|---|---|---|---|
| POST | `/items/:id/time/start` | item update | `{column_id, note?}` → entry — starts my timer on this cell; my other timers keep running (several at once); idempotent on the same cell |
| POST | `/items/:id/time/stop` | | `{column_id?}` stops my running timer(s) on this item; none → `409 no_running_timer` |
| GET · POST | `/items/:id/time/entries` | read / item update | GET → `{data:[TimeEntry]}` newest first. POST `{column_id, started_at, ended_at \| duration_s, user_id?, note?, billable?}`: not in the future, end after start, ≤24 h (`422 time_*`); `user_id` ≠ me only for board owners/admins (or `allow_other_users:"all"`); `allow_manual:false` → 403 |
| PATCH · DELETE | `/time/entries/:id` | mine, or any as board owner/admin | PATCH `{started_at?, ended_at?, note?, billable?}` → sets `edited_by/at`; DELETE → trash. Writing the cell directly (`PUT /items/:id/cells/:col`) → `422 column_read_only` |
| GET | `/me/time/running` | session | `{data: [{entry, item:{id,name,board_id}}]}` — all my running timers |
| GET | `/boards/:id/time/report` · `/boards/:id/time/report.csv` · `/items/:id/time/entries.csv` | item read | `?group_by=user\|item\|day&from=YYYY-MM-DD&to=…&user_id=` → `{group_by, from, to, total_s, billable_s, running, rows:[{key,label,duration_s,billable_s,entries}]}`; the board and its subitems, local days, visible items only. CSV: one row per entry (UTF-8 BOM, CRLF, decimal hours) |

### 2.10 Subitems (and deeper levels)

Subitems live on the board's **sub-board** (D14): `POST /items/:parentId/subitems` creates one (`depth_exceeded` beyond
`hierarchy_depth_max`), and every `/items/:id/*` route works on a subitem (`move-to-group` is rejected for subitems).
The sub-board's id is `subitems_board_id` in `GET /boards/:id`; its columns are read and changed through the normal
board and column endpoints.

### 2.11 Cells

| method | path | S | notes |
|---|---|---|---|
| PUT | `/items/:id/cells/:columnId` | edit right + column not edit-restricted | body `{value}` in the type's write shape ([`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md), [`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md): status `{label}` / `{index}`, people `{persons_and_teams:[{id,kind}]}`, date `{date,time?}`, timeline `{from,to}`, numbers `number`, text `string`, email `{email,text?}`, link `{url,text?}`, phone `{phone,country?}`, checkbox `{checked:true}`, dropdown `{labels[]}` / `{ids[]}`, rating `{rating}`, board_relation `{item_ids[]}`, file `{file_ids[]}`, location `{lat,lng,address}`, country `{code}`, hour `{hour,minute}`, week `{start_date}`, tags `{tag_ids[]}` / `{tags:[names]}`, color_picker `{hex}`) → cell `{column_id,type,value,text,updated_at}` |
| DELETE | `/items/:id/cells/:columnId` | | clear |
| PATCH | `/items/:id` | | several cells at once (§2.9) |
| POST | `/items/:id/cells/:columnId/vote` | | vote column |
| PUT · POST | `/items/:id/cells/:columnId/secret` (PUT), `…/secret/reveal`, `…/secret/copy` (POST) | | secret column: stored encrypted, revealed or copied on request (audited) |
| POST | `/items/:id/cells/:columnId/doc` | | the doc of a doc cell — made on first use, the same doc afterwards; it has the item's permissions |

Read-only types (`formula, mirror, auto_number, creation_log, last_updated, item_id, progress, button`, time tracking)
→ `422 column_read_only`.

### 2.12 Links (board_relation / dependency)

A relation cell is written like any cell: `PUT /items/:id/cells/:columnId` with `{item_ids[]}` (replace), or the bulk
action `change_links` to add / remove links on many items. Two-way columns update the mirrored side inside the same
transaction and emit `link.changed` on both items. Matching candidates for a relation picker:
`GET /boards/:id/columns/:col/relation-matches`.

`POST /items/:id/cells/:columnId/links`, `PATCH · DELETE …/links/:linkId` manage **file links** (a URL kept in a files
column next to uploaded files).

### 2.13 Updates

| method | path | S | notes |
|---|---|---|---|
| GET | `/items/:id/updates` | updates:read | threaded: `[{id,body_html,body_text,body_json,author,created_at,edited_at,mentions[],files[],likes:{count,me},reactions:[{reaction,count,me}],replies:[...]}]` — reactions in the fixed `REACTIONS` order |
| POST | `/items/:id/updates` | updates:write (view_comment allows) | `{doc}` — the rich editor's ProseMirror JSON (≤200 KB), rendered by the server through the allowlist; **or** `{body}` — plain text with `[@Name](user:id)` mentions. Never both; an empty doc → 400; mentions must be account members (422). `file_ids?[]` |
| PATCH · DELETE | `/updates/:id` | author / owner (delete) | PATCH `{doc}` or `{body}` like create |
| POST | `/updates/:id/replies` | | `{doc}` or `{body}`, `file_ids?` |
| POST · DELETE | `/updates/:id/like` | | = reaction `like` |
| PUT · DELETE | `/updates/:id/reactions/:reaction` | anyone who reads the item | add / remove my reaction; `:reaction` ∈ `like, heart, laugh, party, wow, sad`; idempotent |
| PUT | `/updates/:id/tasks/:index` | | tick a checklist task inside an update |
| DELETE | `/updates/:id/files/:fileId` | author | remove an attachment |
| GET | `/updates/views`, `/updates/:id/views` | | who has seen an update |

### 2.14 Files

| method | path | notes |
|---|---|---|
| POST | `/files/presign` | `{name, size, mime, purpose}` → `{file_id, upload_url, method:"PUT", headers, expires_at}` (S3 presigned; max 500 MB) |
| POST | `/files/:id/complete` | after upload → `{file:{id,name,size,mime,url,thumb_url}}` (the server HEADs the object) |
| POST | `/items/:id/cells/:columnId/files` | `{file_ids[]}` attach; `DELETE …/files/:fileId` detaches → **trash** (object type `file`, with all its versions; same retention as other trash; restore puts it back into its cell — 404 when the item/column is gone, `409 parent_in_trash` when either is in the trash; undo of `file.removed` restores) |
| GET | `/items/:id/cells/:columnId/files.zip`, `/updates/:id/files.zip` | all files of a cell / an update as one zip |
| GET | `/files/:id` | metadata + `version` + `download_url` (signed, 15 min); access checked through the owning cell/update. A file id serves its **current** version (`?exact=1`: the file itself, i.e. version 1); an older version's id serves that version to whoever may read the file |
| GET | `/files/:id/versions` | files columns only. `{data:[{id, version, name, size, mime, created_by:{id,name}\|null, created_at, current}]}` newest first; readers of the file |
| POST | `/files/:id/versions` | `{file_id}` — an own finished upload (presign → PUT → complete) becomes the next version (current). Rights as attaching to the cell (item update + column edit restriction). `409 file_in_use` when the upload is attached elsewhere. → the version DTO. Event `file.version_added` |
| POST | `/files/:id/versions/:versionId/make-current` | copies that version server-side as version N+1 (current); history is never rewritten. → the version DTO. Event `file.version_restored` |
| DELETE | `/files/:id/versions/:versionId` | at once, row + stored bytes; the version's uploader or a board owner/admin. `409 version_is_current`; `409 first_version_kept` (version 1 anchors the file in its cell). Event `file.version_deleted` |
| GET | `/files/:id/ai-edit` | `{available, reason}` — may the caller ask the AI for a change now (the viewer shows the box only then): edit rights on the cell, AI on / plan / budget, the account's image connection **and** model set. Reasons: the refusal code (`role_ceiling`, `column_restricted:<key>`, `ai_disabled`, `ai_budget_exceeded`, `ai_image_no_model`, `ai_images_not_configured`, `plan_feature_unavailable` …). 404 when the file is not readable |
| POST | `/files/:id/ai-edit` | `{instruction (1–2000), version_id?}` — "Ask the AI for a change": the picture (`version_id` = an older version being viewed, else the current one) + the instruction go to the account's image connection/model (Administration → AI → images; no other connection, no default model) via image edit; the result is stored as version N+1 (current), name kept (the extension follows the new type, e.g. `.jpg` → `.png`). Order of checks — nothing is spent before all pass: read + edit rights (as uploading a version; guests refused `ai_not_for_guests`) → `assertAiAvailable` (status, `ai` feature, plan + account budget) → image model chosen → PNG/JPEG/WebP ≤ 20 MB read from the bytes (`422 ai_source_not_image`) → the shared AI change rate (surface `app`; 429) → the call. A model without image edit: `422 ai_model_no_image_edit`, no call, no charge. Usage in `ai_usage` source `image`. → the version DTO + `from_version`, `model`, `cost_usd`. Event `file.version_added` with `after.ai = true` + `instruction`. Undo = make-current of the previous version. MCP / agents: tool `edit_file_image {file_id, instruction, version_id?}` (sensitive, open-world) |
| POST | `/files/:id/transcribe` | `{force?}` — the text of an audio / video file the caller may read, with the account's speech-to-text connection (`assertAiAvailable`, usage source `transcription`; not for guests). **On request only** by default (`settings.ai.voice.auto` = false; true = the composer transcribes each recording automatically). The text is kept on the file version (`assets.transcript`); asking again returns it (`reused: true`, no call, no charge) unless `force`. → `{text, model, cost_usd, reused?}` |
| GET | `/files/:id/transcript` | `{transcript: {text, model, created_at, edited_at} \| null, can_edit}` — readers of the file; `can_edit` = may edit the holder (the update's author / the cell's editors; a not-yet-attached recording: its uploader). No AI, no cost. A new version starts without a transcript. Transcripts are not indexed by search |
| PATCH | `/files/:id/transcript` | `{text}` — corrects it (empty removes it); same rights as `can_edit`, `403 transcript_edit_not_allowed`. Event `file.transcript_edited` (before/after text) on the holding item |
| DELETE | `/files/:id` | → trash |
| GET | `/boards/:id/files` | every file on the board (the files view) |

### 2.15 Views & forms

| method | path | notes |
|---|---|---|
| GET · POST | `/boards/:id/views` | `{name, type, settings:{filters:<query rules>, sort, group_by, hidden_columns[], column_order[], column_widths{}, collapsed_groups[], …}}`; ≤100 per board. View types: [`15-VIEWS.md`](15-VIEWS.md) |
| PUT | `/boards/:id/views/layout` | the order of the board's view tabs |
| PATCH · DELETE | `/views/:id` | `If-Match`; `{locked:true}` owner/admin only; locked views reject PATCH from others (`view_locked`) |
| POST | `/views/:id/duplicate` | |
| PUT · DELETE | `/views/:id/prefs` | my personal, unsaved changes to a view |
| POST | `/views/:id/open` | record that I opened the view (recents) |
| GET · PATCH | `/views/:id/form` | a form is a view of type `form`: its questions and settings (password, active, success message, redirect, …) |
| POST | `/views/:id/form/token` | (re)issue the form's public token |
| GET | `/public/forms/:token` (public, no auth) | schema for rendering; `403 form_inactive`; a password-protected form needs the password |
| POST | `/public/forms/:token/uploads` (public) | file upload for a file question |
| POST | `/public/forms/:token/submit` (public) | `{answers:{column_id:value}, …}` → creates the item in the form's group as actor `{kind:"form"}`; emits `item.created source=form`; rate limits in §1.10; honeypot field |

### 2.16 Automations

| method | path | S | notes |
|---|---|---|---|
| GET | `/boards/:id/automations` | automations:read | the board's automations |
| POST | `/boards/:id/automations` | automations:write + board permission `general.automations` | `Recipe` body ([`04-AUTOMATIONS.md`](04-AUTOMATIONS.md) §1.2) → the stored canonical recipe + `warnings[]` (data-loss mappings). Example §3.6 |
| POST | `/boards/:id/automations/computed-preview` | | preview of a computed-value action |
| GET | `/automations` · `/automations/usage` | automations:read | every automation the caller can see across boards; usage per day / top automations |
| GET · PATCH · DELETE | `/automations/:id` | | PATCH partial `{title, trigger, conditions, actions, is_active, owner_user_id}` + `If-Match`; `is_active` turns it on / off |
| GET | `/automations/:id/runs` | | the run log (status, event, item, actions ok / failed) |
| POST | `/automations/:id/test` | | `{item_id, dry_run:true}` → what the conditions and actions would do; `dry_run:false` → runs it |
| POST | `/automations/:id/save-as-template` · `/automation-templates…` | | reusable automation templates: list, edit, propose, install |
| POST | `/hooks/in/:automationId` (no auth) | | inbound trigger (04 §2 `webhook_in`); `X-Bines-Secret` required; → `202 {event_id}` |
| POST | `/hooks/email/resend` (signed, no auth) | | incoming email: `email.received` → one queued message per item / board address → always `200 {received: true}` (never says whether an address exists); 429 per client address on bursts / bad signatures |
| GET · POST · DELETE | `/items/:id/email-address`, `/boards/:id/email-address` | comment on the item / create items on the board | the address (`{kind, address, off, created_at}`; null while off); POST makes it on first use, DELETE retires it |
| POST | `/items/:id/email-address/rotate`, `/boards/:id/email-address/rotate` | same | a new address; the old one stops working for good |

### 2.17 Webhooks (outgoing)

| method | path | S | notes |
|---|---|---|---|
| GET | `/boards/:id/webhooks` | webhooks | |
| POST | `/boards/:id/webhooks` | webhooks | `{url (https, ≤255), event, config?, secret?, active:true, description?, skip_handshake?}` — `event` ∈ `item_created, item_name_changed, column_changed, specific_column_changed, status_changed, item_moved_to_group, item_moved_to_specific_group, item_archived, item_deleted, item_restored, subitem_created, subitem_column_changed, subitem_name_changed, subitem_moved, subitem_archived, subitem_deleted, update_created, update_edited, update_deleted, subitem_update_created, column_created, group_created, item_moved_to_board, link_changed, button_clicked, form_submitted`; `config`: `{column_id}` / `{column_id, label}` or `{column_id, "$any$":true}` / `{group_id}`. **Handshake**: before saving, the API POSTs `{"challenge":"<random 64 hex>"}` to `url` and expects `200` with the body `{"challenge":"<same>"}` within 5 s; otherwise `422 webhook_challenge_failed`. Board owners and admins may set `skip_handshake` for receivers that cannot echo (the webhook is stored as not verified). Example §3.5. Unknown event names → `422 unknown_webhook_event`. |
| GET · PATCH · DELETE | `/webhooks/:id` | | PATCH `{url (re-handshake), active, config, secret}` |
| POST | `/webhooks/:id/rotate-secret` | | |
| GET | `/webhooks/:id/deliveries` | | `[{id,event_id,attempt,status:"pending"\|"ok"\|"failed"\|"dead",response_code,response_ms,next_retry_at,error,created_at}]` |
| POST | `/webhooks/deliveries/:id/redeliver` | | |
| POST | `/webhooks/:id/test` | | sends a synthetic `ping` event |

Delivery: `POST url` with headers `Content-Type: application/json`, `X-Bines-Event: <event>`,
`X-Bines-Delivery: <delivery_id>`, `X-Bines-Timestamp: <unix ms>`,
`X-Bines-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>`,
`X-Bines-Signature-Lite: sha256=<hex HMAC-SHA256(secret, timestamp + "." + delivery_id)>` (for receivers that only see
the parsed body, such as some no-code tools; a `format: "flat"` subscription also carries `timestamp` and
`signatureLite` at the top of the body), `User-Agent: BinesOS-Webhooks/1`. Success = 2xx within 10 s. Retries with
backoff `1m, 5m, 30m, 2h, 6h, 24h` (6 attempts), then `dead`; after 50 consecutive dead deliveries the webhook is
disabled automatically (`active=false, disabled_reason`) and its creator notified. Order is best-effort per webhook
(single queue); consumers must dedupe by `delivery_id` / `triggerUuid`. Payload format §4.3.

### 2.18 Notifications & inbox

| method | path | notes |
|---|---|---|
| GET | `/me/notifications` | the bell: `?unread=true&cursor=` → `[{id,kind,title,body,item:{id,name,board_id},actor,read_at,created_at,url}]` |
| POST | `/me/notifications/read` | `{ids[]}` or `{all:true}` |
| GET · PATCH | `/me/notifications/settings` | per-kind delivery: bell / email / digest |
| GET | `/me/inbox`, `/me/inbox/count` | update feed: updates + replies from subscribed boards / items and mentions |
| POST | `/me/inbox/read` | mark inbox entries read |
| GET · POST · DELETE | `/me/push-subscriptions`, `/me/push-subscriptions/:id`, `POST /me/push-subscriptions/unsubscribe` | web-push subscriptions |

### 2.19 Activity log & undo

| method | path | notes |
|---|---|---|
| GET | `/boards/:id/activity`, `/items/:id/activity` | §2.6; guests forbidden |
| POST | `/activity/:eventId/undo` | `{force?}` — reverses one event; an event that has a `batch_id` reverses its **whole batch** (one toast = one action). Allowed ≤ **7 days**, only for the **actor** of the event or an admin (`403 forbidden` otherwise), and only for reversible types (registry in `apps/api/src/modules/activity/undo.service.ts`): every `*.deleted` that went to trash (item, group, column, view, update, board, folder, workspace, doc, dashboard — restored through the trash entry in `meta.trash_entry_id`), `cell.changed`, `item.renamed`, `item.created`, `item.moved_to_group`, `item.reordered`, `item.moved_to_board`, `item.converted`, `group.moved_to_board`, `item.archived`, `group.archived`, `board.archived`, `item.duplicated`, `group.duplicated`, column created / settings changed / type changed, file and dashboard changes, and bulk batches. When the subject changed since the event → `409 changed_since` unless `force:true`. Returns `{ok, undone:n}`; writes compensating events with `actor` = the undoer and `meta.undo_of = event_id`, and marks the original `undone_at` / `undone_by_event_id`. `409 already_undone` / `422 not_undoable` / `422 undo_expired` |
| POST | `/activity/:eventId/redo` | re-applies an undone event |
| POST | `/activity/batches/:batchId/undo` | `{force?}` — every reversible event of the batch, newest first, in one transaction |

### 2.20 Trash & archive

| method | path | notes |
|---|---|---|
| GET | `/trash` | → `{data:[{id, object_type, object_id, name, board_id, board_name, deleted_by:{id,name}, deleted_at, purge_after}]}` newest first (≤500; filtering is done by the client) — admins see all; others only what they deleted. `id` is the trash **entry** id |
| POST | `/trash/:entryId/restore` | restores to the original place; an item whose group is gone lands at the bottom of the board's first group; items restore with their subitems (cells/updates were never removed). `409 parent_in_trash {parent_type, parent_entry_id}` when its board / parent item / parent folder / workspace is in trash (the UI offers to restore that first) → `{ok, object_type, object_id, board_id}` |
| DELETE | `/trash/:entryId` | "delete permanently" (deleter or admin): the entry leaves the trash now (`purge_after = now()`), the rows are removed by the next `trash.purge` run |
| DELETE | `/trash` | admin: empty the trash (all entries) → `{ok, count}` |
| GET | `/archive` | → `{data:[{type:'item'\|'group'\|'board', id, name, board_id, board_name, archived_at, archived_by}]}` newest first, only on boards I can read |
| POST | `/items/:id/archive` · `/boards/:id/groups/:gid/archive` · `/boards/:id/archive` | archive (delete rights; a group takes its items, never the last group; boards: owner/admin) → `{ok, event_id}` (undo) |
| POST | `/archive/:type/:id/restore` | back in place (an item whose group is gone → the first group; a group with the items archived with it) → `{ok, board_id}` |

Every delete-to-trash endpoint answers `{ok:true, event_id}` — the event to pass to `/activity/:id/undo` (the UI's
60-second toast).

Purge job (`trash.purge`, worker cron, hourly): every entry past `purge_after` → hard delete
(`apps/worker/src/repositories/trash.repo.ts`). A purged column keeps its row as a tombstone (its key is never reused)
and loses its cells. Entries of children purged with a board/group are marked purged too. Once nothing references a
stored file any more, the hourly `files.purge` job removes it (with all its versions) from storage.

### 2.21 Search

`GET /search?q=&…` → grouped results (items, updates, files, boards, docs, people) over item names, cell text, updates
and file names; Postgres full-text search; respects visibility; powers the quick-search palette.
`GET · POST · DELETE /search/recent` — my recent searches / visits. Favorites: `GET · PUT /me/favorites`
(`/me/favorite-boards`, `/me/favorite-docs`).

### 2.22 Templates & tags

| method | path | notes |
|---|---|---|
| GET | `/templates` | built-in (`seed/templates`) + account templates; `GET /templates/hidden` lists built-ins an admin hid |
| PATCH · DELETE | `/templates/:key` | owner/admin |
| POST | `/templates/:key/duplicate` · `/restore` · `/draft` | copy a template, restore a hidden built-in, open a template as an editable draft board (`POST /boards/:id/template-draft/save`, `DELETE /boards/:id/template-draft`) |
| — | `POST /boards {template_key}` | use a template (§2.6) |
| GET · POST | `/tags` | account-wide tags `{name, color}` |

Item templates (an item with its subitems, reusable): `/boards/:id/item-templates`, `/item-templates/:id`,
`POST /item-templates/:id/apply`.

### 2.23 My Work

`GET /me/work` → sections (past, today, this week, next week, later, no date) of items where the user is in a people
column, with the per-board chosen date / status columns; `PATCH /me/work/settings` (boards, date / status column per
board, hide done, which people columns count). Limits: 50 boards / 1,000 items / updated within 4 months.

### 2.24 Support access & audit

| method | path | notes |
|---|---|---|
| GET · POST · DELETE | `/support-access`, `/support-access/:id` | an admin grants the platform's support team time-boxed access to the account; every use is audited |
| POST | `/support/access-requests/:id/approve` · `/decline` | answer a support access request raised from a ticket |
| GET | `/audit`, `/audit/export.csv` | admin: `?user_id=&event=&from=&to=&cursor=` — sign-ins, failed sign-ins, token created / revoked, invitations, role changes, deactivation, exports, purges, permission changes, support access, settings changes; CSV export |

### 2.25 AI and MCP

See also §5 for an overview of the MCP server. D26 in [`DECISIONS.md`](DECISIONS.md) records the decisions behind it.

| method | path | notes |
|---|---|---|
| GET · PATCH | `/ai/settings` | admin; `settings.ai`: `enabled` (off by default), `mcp_enabled`, `mcp_roles` (members / viewers besides admins; guests never), `agent_creators`, `mcp_sensitive` (`allow` / `block`), `monthly_budget_usd`, `budget_alert_pct`, write rates; audited `ai.settings_changed` |
| GET · POST | `/ai/connections` | admin; AI connection = provider + API key, AES-256-GCM encrypted (`SECRETS_KEY`, else derived from `BETTER_AUTH_SECRET`), write-only — only `key_hint` (`…AbCd`) comes back |
| PATCH · DELETE | `/ai/connections/:id` | admin; rename, default model, replace the key; delete = soft (usage history keeps the name) |
| POST | `/ai/connections/:id/test` | admin; a free provider call (models list) → `{ok, error}`, kept as `last_test` |
| GET · POST | `/ai/connections/:id/models`, `/ai/connections/models` | the models a connection offers |
| GET | `/ai/usage` | admin; `?month=YYYY-MM` spend per connection × source × model from `ai_usage` (the real cost of each call) |
| GET | `/ai/mcp` | anyone in the account: `{url: WEB_ORIGIN/mcp, enabled, allowed, protocol_versions, tools}` for the "AI & MCP" page |
| POST | **`/mcp`** (web origin, not `/api/v1`) | the MCP server (§5) |
| GET | `/.well-known/oauth-protected-resource[/mcp]` (web origin) | RFC 9728: `resource` = `WEB_ORIGIN/mcp`, `authorization_servers` = [`WEB_ORIGIN`], `scopes_supported` |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414: the endpoints below, `code_challenge_methods_supported: [S256]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true` |
| POST | `/oauth/register` | RFC 7591 dynamic client registration (redirect URIs: https, loopback http, or an app scheme); 20/h per address |
| GET | `/oauth/authorize` | code flow; PKCE S256 and `state` mandatory; `resource` must be `WEB_ORIGIN/mcp`; client = a registered id or a Client ID Metadata Document URL (fetched via `outbound.ts`); exact redirect URI match (a loopback port may vary). Bad client / redirect → `/connect?error=`; other errors → back with `error`, `state`, `iss`; else → the consent page `/connect?request=<id>` |
| POST | `/oauth/token` | `authorization_code` (+ `code_verifier`, `redirect_uri`, `resource`) and `refresh_token` (rotating; a replay revokes the connection). `{access_token (1 h), refresh_token, expires_in, scope}`, `no-store` |
| POST | `/oauth/revoke` | RFC 7009: an access token alone; a refresh token ends the connection. Always 200 |
| GET | `/oauth-requests/{id}` | session only: the consent screen — client, redirect host, requested groups, my accounts with `allowed` / `reason` |
| POST | `/oauth-requests/{id}/approve` · `/deny` | session only: `{account_id, groups: [write, automations], board_ids?}` → `{redirect_to}` (code + state + iss, or `access_denied`) |
| GET | `/mcp-connections` (`?all=true` admins) | connected AI apps in the account; `DELETE /mcp-connections/{id}` disconnects (own, or any for admins). Audit `mcp.connected` / `mcp.disconnected` / `mcp.token_replay` |

---

## 3. Full examples

Sample ids, names and labels below are illustrative. Status and dropdown labels are whatever the board defines, in any
language.

### 3.1 Create item with cells

`POST /api/v1/boards/brd_01J9X/items` · `Authorization: Bearer bos_pat_…` · `Idempotency-Key: 7d7b…`

```json
{ "name": "Lead: Sample Studio", "group_id": "topics", "create_labels": false,
  "cells": {
    "status":       { "label": "New" },
    "owner":        { "persons_and_teams": [ { "id": "usr_01J8A", "kind": "person" } ] },
    "next_follow":  { "date": "2026-10-05", "time": "09:00" },
    "email":        { "email": "hello@studio.example" },
    "phone":        { "phone": "+972501234567", "country": "IL" },
    "budget":       12000,
    "source":       { "labels": ["Instagram"] },
    "account":      { "item_ids": ["itm_01J7Q"] } } }
```

`201 Created` · no `ETag` (items are not revisioned)

```json
{ "id": "itm_01J9Y2", "board_id": "brd_01J9X", "group_id": "topics", "parent_item_id": null, "depth": 0,
  "name": "Lead: Sample Studio", "position": "0|hzzzzz:", "created_at": "2026-10-01T08:12:33.120Z", "updated_at": "2026-10-01T08:12:33.120Z",
  "creator": { "id": "usr_01J8A", "name": "Alex Example" },
  "cells": {
    "status":      { "type": "status", "value": { "index": 0, "label": "New" }, "text": "New" },
    "owner":       { "type": "people", "value": { "persons_and_teams": [ { "id": "usr_01J8A", "kind": "person" } ] }, "text": "Alex Example" },
    "next_follow": { "type": "date", "value": { "date": "2026-10-05", "time": "09:00" }, "text": "2026-10-05 09:00" },
    "email":       { "type": "email", "value": { "email": "hello@studio.example", "text": "hello@studio.example" }, "text": "hello@studio.example" },
    "phone":       { "type": "phone", "value": { "phone": "+972501234567", "country": "IL" }, "text": "+972 50-123-4567" },
    "budget":      { "type": "numbers", "value": 12000, "text": "12,000" },
    "source":      { "type": "dropdown", "value": { "ids": [3], "labels": ["Instagram"] }, "text": "Instagram" },
    "account":     { "type": "board_relation", "value": { "item_ids": ["itm_01J7Q"] }, "text": "Sample Studio" },
    "created_log": { "type": "creation_log", "value": { "at": "2026-10-01T08:12:33.120Z", "by": "usr_01J8A" }, "text": "Alex Example, 01/10/2026" } },
  "url": "https://work.example.com/boards/brd_01J9X/items/itm_01J9Y2" }
```

Error when a label does not exist and `create_labels` is false:

```json
{ "error": { "code": "label_not_found", "message": "cells.status: label 'Nwe' not found", "details": { "column_id": "status", "label": "Nwe", "available": ["New","Working on it","Won","Lost"] }, "request_id": "req_…" } }
```

### 3.2 Query items with rules

`POST /api/v1/boards/brd_01J9X/items/query`

```json
{ "operator": "and",
  "rules": [ { "column_id": "status", "operator": "not_any_of", "values": ["Won", "Lost"] },
             { "column_id": "next_follow", "operator": "within_the_next", "values": ["DAYS", 7] },
             { "column_id": "owner", "operator": "any_of", "values": ["assigned_to_me"] } ],
  "groups": [ { "operator": "or", "rules": [ { "column_id": "budget", "operator": "greater_than", "values": [5000] },
                                              { "column_id": "source", "operator": "any_of", "values": ["Referral"] } ] } ],
  "order_by": [ { "column_id": "next_follow", "direction": "asc" } ],
  "limit": 100 }
```

`200 OK`

```json
{ "data": [ { "id": "itm_01J9Y2", "name": "Lead: Sample Studio", "group_id": "topics",
              "cells": { "status": { "type": "status", "value": { "index": 0, "label": "New" }, "text": "New" },
                         "next_follow": { "type": "date", "value": { "date": "2026-10-05", "time": "09:00" }, "text": "2026-10-05 09:00" },
                         "owner": { "type": "people", "value": { "persons_and_teams": [ { "id": "usr_01J8A", "kind": "person" } ] }, "text": "Alex Example" },
                         "budget": { "type": "numbers", "value": 12000, "text": "12,000" } } } ],
  "next_cursor": "eyJrIjoiMjAyNi0xMC0wNSIsImlkIjoiaXRtXzAxSjlZMiJ9", "has_more": true }
```

### 3.3 Move item to another board with mapping

`POST /api/v1/items/itm_01J9Y2/move-to-board`

```json
{ "board_id": "brd_ACC", "group_id": "active",
  "mapping": { "status": "status", "owner": "owner", "email": "email", "phone": "phone", "budget": "mrr", "source": null } }
```

`mapping` maps each source column to a target column of the same type, or `null` to drop it. Omit `mapping` to let the
server map columns by type + title.

`200 OK`

```json
{ "ok": true, "event_id": "evt_01J9Z1", "dropped": ["source"] }
```

The item keeps its id; its subitems, updates, files and activity history move with it. `POST /activity/evt_01J9Z1/undo`
within 7 days puts it back with the dropped cells restored.

### 3.4 Set board permissions with `view_items`

`PUT /api/v1/boards/brd_SUP/permissions`

```json
{ "permission_set": "edit_assigned",
  "view_items": { "mode": "assigned_or_created", "column_ids": ["handler"] } }
```

`200 OK` — the board's permissions as `GET /boards/:id/permissions` returns them: guests and members without owner
rights on this board now see only items where they are assigned in the `handler` column or that they created; owners
and admins see everything. The model is described in [`05-PERMISSIONS.md`](05-PERMISSIONS.md).

### 3.5 Create webhook + handshake

`POST /api/v1/boards/brd_01J9X/webhooks`

```json
{ "url": "https://hooks.example.com/abc123", "event": "status_changed", "config": { "column_id": "status", "label": "Won" },
  "description": "won deals → CRM sync" }
```

Server → `POST https://hooks.example.com/abc123`

```json
{ "challenge": "4f1c0f0e8a2b4d6e9c7a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6" }
```

The receiver must answer `200` with `{"challenge":"4f1c…a6"}` (extra fields are ignored). Then:

`201 Created`

```json
{ "id": "whk_01JA0", "board_id": "brd_01J9X", "url": "https://hooks.example.com/abc123", "event": "status_changed",
  "config": { "column_id": "status", "label": "Won" }, "active": true, "secret": "whs_9f3…(shown once)",
  "created_by": "usr_01J8A", "created_at": "2026-10-01T08:30:00.000Z", "verified": true }
```

Handshake failure: `422 webhook_challenge_failed` with details about the receiver's answer.

### 3.6 Create automation

`POST /api/v1/boards/brd_QUO/automations`

```json
{ "id": "Q2", "board": "quotes",
  "recipe": "When Valid until arrives, and only if Status is Sent, change Status to Expired and notify board owners",
  "trigger": { "type": "date_arrived", "column": "valid_until", "offset_days": 0, "time": "09:00" },
  "conditions": [ { "column": "status", "operator": "any_of", "values": ["Sent"] } ],
  "actions": [ { "type": "set_status", "column": "status", "label": "Expired" },
               { "type": "notify", "to": "@board_owners", "message": "Quote expired: {item.name} ({item.account})" } ],
  "is_active": true, "kind": "automation" }
```

`201 Created`

```json
{ "id": "aut_01JA1", "board_id": "brd_QUO", "seed_key": "Q2",
  "title": "When Valid until arrives, and only if Status is Sent, change Status to Expired and notify board owners",
  "recipe": "…", "trigger": { "type": "date_arrived", "column": "valid_until", "offset_days": 0, "time": "09:00" },
  "conditions": [ { "column": "status", "operator": "any_of", "values": ["Sent"] } ],
  "actions": [ { "type": "set_status", "column": "status", "label": "Expired" }, { "type": "notify", "to": "@board_owners", "message": "Quote expired: {item.name} ({item.account})" } ],
  "is_active": true, "kind": "automation", "owner": { "id": "usr_01J8A", "name": "Alex Example" }, "revision": 1,
  "warnings": [], "created_at": "2026-10-01T08:35:00.000Z" }
```

The recipe format is specified in [`04-AUTOMATIONS.md`](04-AUTOMATIONS.md).

---

## 4. `packages/sdk`, no-code tools, webhook payload

### 4.1 TypeScript client

`@bines/sdk` (`packages/sdk`, MIT) is a thin `fetch` client: base URL, authentication (an API token for scripts, or
the session cookie in the browser), the `X-Account-Id` header, the error envelope as a typed `ApiError`, and an optional
retry on 429 that honours `Retry-After`. The request and response types come from `@bines/shared` (the same zod schemas
the API validates with) and from the OpenAPI document.

```ts
import { createClient, ApiError } from "@bines/sdk";

const api = createClient({
  baseUrl: "https://work.example.com",   // the client adds /api/v1
  token: process.env.BOS_TOKEN!,         // bos_pat_… or bos_svc_…
  retryOn429: 3,                          // wait Retry-After and retry, up to 3 times
});

const item = await api.post<{ id: string }>(
  "/boards/brd_01J9X/items",
  { name: "New lead", cells: { status: { label: "New" } } },
  { "idempotency-key": crypto.randomUUID() },   // a retry cannot create the item twice (§1.9)
);
await api.put(`/items/${item.id}/cells/status`, { value: { label: "Working on it" } });

try {
  await api.patch("/boards/brd_01J9X", { name: "Leads" }, { "if-match": '"rev-3"' });
} catch (e) {
  if (e instanceof ApiError) console.error(e.status, e.body.code, e.body.request_id);
}
```

The client exposes `get`, `post`, `patch`, `put` and `delete`; each takes the path under `/api/v1` and optional extra
headers. For extensions use `@bines/ext-sdk` ([`docs/extensions/README.md`](extensions/README.md)).

### 4.2 Make / n8n / Zapier

- **n8n**: the community nodes in `integrations/n8n-nodes-bines-os` — triggers that register their own webhooks, and
  actions and searches on boards, items, subitems, templates, updates, files, time tracking and AI agents. Without
  them, use the **HTTP Request** node (Generic → Header Auth `Authorization: Bearer …`) and a **Webhook** node that
  answers the handshake with `{"challenge": "{{$json.body.challenge}}"}` (a *Respond to Webhook* node).
- **Make**: the custom app in `integrations/make-app-bines-os` — instant triggers, actions, searches and RPCs, built
  from JSON components. Without it, use **HTTP → Make a request** (`Authorization: Bearer {{token}}`,
  `Idempotency-Key: {{uuid}}`, JSON body) and a **Custom webhook** whose *Webhook response* module returns
  `{"challenge": "{{1.challenge}}"}`.
- **Zapier**: **Webhooks by Zapier** (Custom Request for actions, Catch Hook for triggers). Catch Hook cannot echo
  the challenge, so a board owner or admin registers the hook with `skip_handshake` (§2.17).

Endpoints that help no-code tools: `?format=flat` on item endpoints (cells as `column_values` keyed by column title),
`GET /boards/:id/columns/:col/choices`, plain `values` input on item create / update (converted per column type), and
`move-to-board` without `mapping`.

### 4.3 Webhook payload format

The body of every delivery is an `event` object: `type`, `itemId`, `itemName` and the fields below. Creating a webhook
with an unknown event name is refused with `422 unknown_webhook_event` — use the names in §2.17.

```jsonc
{ "event": {
    "type": "status_changed",                       // the event name
    "triggerUuid": "dlv_01JA2…",                    // = delivery id, unique per attempt-set; use for dedupe
    "originalTriggerUuid": null,                    // set when the change was caused by an automation run (= run_id)
    "triggerTime": "2026-10-01T08:40:12.341Z",
    "subscriptionId": "whk_01JA0",
    "accountId": "acc_01J0",
    "userId": "usr_01J8A",                           // actor; for automations: "automation:aut_01JA1", for forms: "form:frm_…"
    "actor": { "kind": "user", "id": "usr_01J8A", "name": "Alex Example" },
    "boardId": "brd_01J9X", "boardName": "Leads",
    "groupId": "topics", "groupName": "Open leads", "isTopGroup": true,
    "itemId": "itm_01J9Y2", "itemName": "Lead: Sample Studio",
    "parentItemId": null, "parentItemBoardId": null,
    "columnId": "status", "columnType": "status", "columnTitle": "Status",
    "value":         { "index": 1, "label": "Won", "text": "Won" },
    "previousValue": { "index": 0, "label": "New", "text": "New" },
    "changedAt": "2026-10-01T08:40:12.100Z",
    "app": "bines-os", "eventId": "evt_01J9Z9", "batchId": null,
    "item": { "id": "itm_01J9Y2", "name": "…", "url": "…", "cells": { "...": "included when webhook.config.include_item = true" } } } }
```

Event-specific fields: `item_created` → no `columnId` / `value`; `update_created` →
`updateId, body, bodyText, replyId?, mentions[]`; `item_moved_to_group` → `sourceGroupId, destGroupId`;
`item_moved_to_board` → `sourceBoardId, destBoardId, mapping`; `link_changed` → `value.item_ids`, `added[]`,
`removed[]`; `button_clicked` → `columnId`; `form_submitted` → `formId, answers`; `ping` → `{type:"ping", webhookId}`.
Values use the cell **read shape** of [`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md) plus `text`.

---

## 5. MCP server

Every installation runs a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI clients (Claude,
ChatGPT, IDE agents and others) can read and change boards on a user's behalf.

- **Endpoint:** `https://<your-domain>/mcp` (the web origin, not under `/api/v1`). Streamable HTTP, stateless, built
  on the official TypeScript SDK (`@modelcontextprotocol/server` v2): the 2026-07-28 protocol revision plus the
  2025-era revisions.
- **Turning it on:** AI is off by default. An account admin enables it in Administration → AI (`/ai/settings`:
  `enabled`, `mcp_enabled`, and which roles may connect — members and viewers besides admins; guests never).
  `GET /ai/mcp` tells any member the URL and whether they may connect.
- **Authentication:** `Authorization: Bearer` with a personal or service token (`bos_pat_…` / `bos_svc_…`), or an
  OAuth access token (`bos_oat_…`) issued through the OAuth 2.1 flow in §2.25 — clients that support MCP
  authorization discover it from the `401` response (`WWW-Authenticate` with
  `resource_metadata="…/.well-known/oauth-protected-resource/mcp"` and `scope`). Cookies are never accepted. On the
  consent screen the user picks the account, the permission groups (write, automations) and optionally a board limit.
- **Tools:** `AI_TOOLS` (`packages/shared/src/ai/tools`) — boards, items, columns, updates, docs, files, dashboards,
  automations, templates, search, help and `undo`. The list a client sees is filtered by the token's scopes; viewers
  get read-only tools; tools marked sensitive are hidden when the account blocks them (`mcp_sensitive`).
- **Limits and audit:** the token's account, scopes, board limit and request budget apply (§1.10), plus the shared AI
  change rate (60 writes per minute per person / connection by default). Each write call runs in one transaction with
  one `batch_id`; activity rows carry `actor_type='api'`, `meta.via='mcp'` and
  `meta.mcp={tool, client, token_id, batch_id}`. The `undo` tool (or `POST /activity/batches/:id/undo`) reverts a call.
- **Connections:** connected AI apps are listed at `GET /mcp-connections` and can be disconnected there; connecting,
  disconnecting and refresh-token replay are audited.

The public API reference (`/api/docs`) has an MCP guide page, and `/llms.txt` on an installation tells an AI client
what to read first.
