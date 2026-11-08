# 01 — Architecture

How the Bines OS codebase is put together: the monorepo layout, the life of a request, modules, realtime, background
jobs, search, files, email, observability, security, deployment and testing. It is for developers who want to change
the code or understand how a running installation behaves. It follows [`DECISIONS.md`](DECISIONS.md) D2 (stack), D3
(domain), D5 (automations), D7 (API) and D8 (extensions); the detailed data model is in
[`02-DATA-MODEL.md`](02-DATA-MODEL.md).

## 1. Monorepo layout

```
bines-os-platform/
├── apps/
│   ├── api/                 # Hono — REST /api/v1, SSE, MCP (/mcp), incoming webhooks; serves the built web app
│   │   ├── src/
│   │   │   ├── index.ts / serve.ts   # bootstrap
│   │   │   ├── standalone.ts         # one-process mode with embedded Postgres (D31)
│   │   │   ├── app.ts                # Hono app, middleware chain, OpenAPI registry
│   │   │   ├── env.ts                # zod-validated environment
│   │   │   ├── auth/                 # Better Auth wiring, 2FA
│   │   │   ├── middleware/           # auth, request-id, idempotency, security headers, compression, errors
│   │   │   ├── modules/<module>/     # feature folder per module (see §3)
│   │   │   │   ├── <module>.routes.ts    # @hono/zod-openapi routes (no business logic)
│   │   │   │   ├── <module>.service.ts   # business logic + permission checks
│   │   │   │   └── <module>.repo.ts      # Drizzle queries
│   │   │   ├── db/                   # schema.ts (Drizzle), migrate, seed, embedded PGlite
│   │   │   └── lib/                  # jobs, storage, rate limits, realtime bus, outbound HTTP guard, SMS, logger
│   │   ├── drizzle/                  # SQL migrations (0000_…, 0001_…)
│   │   └── test/                     # vitest API suite on PGlite
│   ├── web/                 # React 18 + Vite single-page app (RTL first)
│   │   └── src/
│   │       ├── app/                  # router, global styles
│   │       ├── features/<module>/    # pages, components, hooks per module
│   │       ├── lib/                  # api client, dialogs, i18n helpers, icons, locale
│   │       └── pwa/                  # service worker / installable app
│   └── worker/              # graphile-worker runner for maintenance and notification tasks (§5)
│       └── src/tasks/index.ts
├── packages/
│   ├── shared/              # domain code shared by api / web / worker (imports no other workspace package)
│   │   └── src/
│   │       ├── columns/              # column-type registry (D4), one module per family in defs/
│   │       ├── automations/          # trigger / condition / action registries + recipe schema
│   │       ├── permissions/          # pure permission resolvers (account, board, dashboard, doc)
│   │       ├── api/                  # zod schemas for every API DTO (source of the OpenAPI document)
│   │       ├── extensions/           # extension manifest, scopes, tokens
│   │       ├── i18n/{he,en}.json     # every UI string
│   │       └── colors.ts             # our status and group palettes
│   ├── ui/                  # design-system components and tokens
│   ├── sdk/                 # typed API client (MIT)
│   ├── ext-sdk/             # extension page SDK (MIT)
│   ├── create-bines-app/    # extension scaffolder (MIT)
│   └── server-ai/, server-crypto/, server-mail/, server-monitoring/   # server-side helpers shared by api and worker
├── extensions/              # optional extensions shipped with the repo — never imported by core (D8)
├── integrations/            # third-party integrations (MIT)
├── seed/                    # templates/*.json, packs/, agents/
├── scripts/                 # column catalog generator, installers, smoke tests, license tooling
├── design-guide/f4/         # the visual spec (mock-ups) behind docs/11-UI-DESIGN.md
├── e2e/                     # Playwright suite
├── docker/                  # Dockerfile for the single image
├── docker-compose.yml       # local services: postgres:18, mailpit, minio (local S3)
├── docker-compose.prod.yml  # a self-hosted production stack
└── AGENTS.md / CLAUDE.md    # rules for coding agents
```

Package dependency direction (enforced by `no-restricted-imports` in `eslint.config.js`): `packages/shared` imports no
other workspace package; `apps/api` never imports `@bines/web`, `@bines/worker` or `@bines/ui` (the one exception is
`standalone.ts`, which starts the worker in-process — D31).

## 2. Request lifecycle

```
HTTP request
 → request-id + pino child logger
 → security headers / CORS / body limit
 → auth: Better Auth session cookie | Bearer api_token | extension token (bos_ext_ / bos_xat_)
      actor = { type: 'user'|'service'|'extension', id, accountId, role, tokenScopes? }
 → account resolution (D12): token ⇒ its account (`X-Account-Id`, if sent, must match); session ⇒ `X-Account-Id` + active
   membership lookup (404 if none); account `suspended` ⇒ 423; unscoped routes (`/auth`, `/me/accounts`, `/platform`) skip this step
 → rate limits (per IP, per account, per token — 06-API §1.10)
 → idempotency (POST/PUT/PATCH/DELETE with Idempotency-Key → cached response for 24 h)
 → zod validation of params / query / body (routes, schemas from packages/shared)
 → service.method(actor, input)
      → can(actor, action, resource)  ← permission resolver; throws a `forbidden` AppError
      → repo.* inside a transaction
      → activity_log row (same transaction)
 → response DTO
After commit:
 → DB triggers on activity_log / notifications → NOTIFY `bines_events` → SSE hub fan-out (board, dashboard, user channels)
 → DB triggers / enqueueJob → graphile-worker jobs (automations, webhooks, notifications …)
```

Rules:

- **Every** permission check is in the service layer; routes know nothing about roles. The UI hides buttons according
  to the `capabilities` the server returns, but the server is the source of truth.
- **Every** mutation writes an `activity_log` row in the same transaction. There are no "silent updates".
- Repositories return rows; services return DTOs. Database access lives in `*.repo.ts` files; a service that needs a
  query beyond simple composition calls a repository.
- Errors: `AppError(code, message, details)` from `packages/shared/src/errors.ts` — `not_found`, `forbidden`,
  `invalid_value`, `conflict` (revision), `rate_limited`, `payload_too_large` and more; each code maps to one HTTP
  status. Response format: `{ error: { code, message, details?, request_id } }`.

## 3. Modules and boundaries

The main responsibility areas. Each lives in `apps/api/src/modules/<folder>` (some areas share a folder, noted in
the table); `ls apps/api/src/modules` shows the full list, including AI, agents, docs, dashboards, idocs, billing,
licensing and more.

| Area                     | Responsibility                                                                                         | Folder(s)                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| accounts                 | account, settings, feature toggles, branding, usage counters                                           | `accounts`                        |
| platform                 | owner console (D12): create / suspend / delete accounts, cross-account usage; never reads board data  | `platform`                        |
| users                    | profile, memberships, roles, invitations, deactivate / anonymise                                        | `users`, `invitations`, `teams`   |
| auth                     | Better Auth wiring, sessions, 2FA, Google, magic link, support-access grants                           | `apps/api/src/auth`, `support`    |
| workspaces and boards    | workspaces (open / closed), members, folders; boards, kinds, settings, subscribers, board permissions, templates, duplicate, archive | `boards`, `nav`                   |
| columns, groups, items   | columns (settings validated by the registry, restrictions, reorder, change type); groups; the item tree (depth 0..5), move, duplicate, batch, visibility query builder; cell reads / writes via the registry | `items`, `boards`, `conversions`, `bulk` |
| updates                  | updates, replies, mentions, reactions, reply-by-email                                                  | `updates`, `inbound-email`        |
| files                    | presigned upload, assets, versions                                                                      | `files`                           |
| views                    | views per board (settings JSON: filters, sort, group by, hidden columns, per-type config), locks        | `views`                           |
| forms                    | public forms, password / captcha, submissions → items                                                  | `forms`, `captcha`                |
| automations              | recipe CRUD, registries, evaluation, runs, usage quota                                                 | `automations`                     |
| webhooks                 | outgoing subscriptions, challenge, HMAC delivery + retries; incoming webhooks                          | `webhooks`                        |
| notifications            | bell, email, web push, user preferences, board mute, digest                                            | `notifications`                   |
| search                   | quick search over items, boards, updates, files, people                                                | `search`                          |
| trash / archive          | soft delete / restore / purge for boards, groups, items, columns, updates                              | `trash`, `archive`                |
| activity                 | activity log reads, undo (7 days)                                                                      | `activity`                        |
| import / export          | CSV / Excel import and export                                                                          | `imports`, `export`               |
| API tokens               | personal / service tokens, scopes, revoke, usage                                                       | `tokens`                          |
| admin                    | audit log, tidy-up, usage stats, security settings                                                     | `admin`, `audit`, `tidy`          |
| extensions               | manifests, features (slots), extension tokens, storage, catalog                                        | `extensions`                      |

**Extension features ("slots")** (D8, details in [`10-EXTENSIONS.md`](10-EXTENSIONS.md)): `board_view`,
`item_view`, `board_menu_action`, `batch_action`, `dashboard_widget`, `account_settings_page`,
`user_settings_page`, `panel`, `app_page`, `automation_action`, `automation_trigger`. Core defines them in
`packages/shared/src/extensions/manifest.ts` and runs only what is registered in the database; nothing in `apps/*` or
`packages/*` imports from `extensions/`.

## 4. Realtime (SSE)

- `GET /api/v1/boards/:boardId/events` — the board channel; `GET /api/v1/dashboards/:dashboardId/events` — a
  dashboard; `GET /api/v1/me/events` — the user channel (notifications, My Work, invitations).
- An in-memory hub in each `api` instance; fan-out between instances through `LISTEN/NOTIFY` on the `bines_events`
  channel. No Redis (D2). A trigger on `activity_log` and on `notifications` sends a payload of ids only (`id,
account_id, type, board_id, item_id, column_id, actor_id, actor_type, batch_id, request_id`, plus `user_id` for a
  notification — `busEventSchema` in `apps/api/src/lib/realtime.ts`); `activity_log` itself is the outbox. The client
  receives ids and refetches what it needs.
- Event types (families): `board.*`, `group.*`, `item.*`, `cell.*`, `column.*`, `update.*`, `view.*`,
  `automation.run.*`, `notification.created`, `presence.*`.
- **Visibility filtering**: before sending to a subscriber the hub checks that the subscriber may read the item — an
  event about an item a guest cannot see never reaches them.
- Reconnection: `Last-Event-ID` → the server replays missed events from `activity_log` (up to 24 h / 500 events);
  beyond that it sends `{type: "resync"}` and the client refetches. A `: ping` heartbeat every 15 s; each stream closes
  itself after 10 minutes and on server shutdown (many proxies cut long HTTP requests), and the browser reconnects with
  `Last-Event-ID`. Client backoff: 1 s → 30 s.
- Client: targeted TanStack Query invalidation (`['board', id, 'items']`, `['item', id]`) with optimistic updates.

## 5. Background jobs (graphile-worker)

One queue (the `graphile_worker` schema in Postgres), **two runners**: each process takes only the tasks it registered,
so they share the queue without taking each other's jobs. Jobs are enqueued by database triggers on `activity_log` /
`notifications` or by `enqueueJob` (`apps/api/src/lib/jobs.ts`). In tests there is no worker schema — services run
the work directly. In standalone mode (D31) both runners live in the single process.

**A. In the API process** (D21 — actions go through the same services as the routes;
`apps/api/src/modules/automations/jobs.ts`):

| Task                                                                             | Trigger                                                                      | Notes                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `automation.dispatch`                                                            | DB trigger on each activity row                                              | activity row → the runs it causes (+ agent triggers)         |
| `automation.run`                                                                 | dispatch / manual                                                            | runs a recipe through the services as actor `automation:<id>`; writes `automation_run` |
| `automation.schedule_tick`                                                       | cron, every minute                                                           | time-based triggers (04 §5.6)                                |
| `webhook.deliver`                                                                | a matching event                                                             | HMAC-SHA256 signed POST; one attempt per job, a failure schedules the next |
| `extension.call_retry`                                                           | an extension call failed                                                     | attempts 2–3 with backoff                                    |
| `maintenance.idempotency_purge`                                                  | cron, hourly                                                                 | purges idempotency keys                                      |
| `geo.geocode` / `geo.sweep`                                                      | a location cell changed / cron every 10 min                                  | queue `geo`, one job at a time                               |
| `agent.run` / `agent.resume` / `agent.knowledge_index` / `agent.expire_approvals` | run / approval / knowledge source / cron hourly                              | agents                                                       |
| `ai.column_run` / `ai.column_auto`                                               | a large run / cron every minute                                              | AI columns                                                   |
| `ai.image_unit`                                                                  | one design of an AI column run with images                                   | the image queue (sequential per run; `images.concurrency` runs in parallel per account; retries with backoff) |
| `tidy.scheduled_cleaning`                                                        | cron, daily 02:40 UTC                                                        | each account's scheduled cleaning rules                      |
| `extensions.update_check`                                                        | cron, daily 03:25 UTC                                                        | checks for extension updates                                 |
| `column.convert` / `column.convert_purge`                                        | a large type conversion / cron daily                                         | D28                                                          |
| `board.names_recompute`                                                          | a name-source change on a large board                                        | computed item names (03 §2.1)                                |
| `flows.check`                                                                    | cron, every 5 min                                                            | failure alerts for external flows                            |
| `billing.plan_transitions`                                                       | cron, every minute                                                           | scheduled plan status changes                                |
| `errors.alerts` / `errors.maintain`                                              | cron every minute / hourly                                                   | error center: alerts, digest, retention                      |
| `inbound_email.process`                                                          | an incoming email webhook                                                    | §8                                                           |

**B. In `apps/worker`** (maintenance and notifications; `apps/worker/src/tasks/index.ts`):

| Task                     | Trigger                          | Notes                                                    |
| ------------------------ | -------------------------------- | -------------------------------------------------------- |
| `notifications.dispatch` | DB trigger on a new notification | email by the user's channel preferences                  |
| `notifications.push`     | DB trigger                       | Web Push (PWA)                                           |
| `notifications.digest`   | cron, hourly                     | a summary email for whoever's time has come              |
| `trash.purge`            | cron, hourly                     | rows with `deleted_at` older than 30 days + their files  |
| `files.purge`            | cron, hourly                     | orphaned files (24 h grace)                              |
| `time.forgotten`         | cron, hourly                     | timers left running                                      |
| `support.sla`            | cron, every 5 min                | SLA breaches of support tickets                          |
| `system.ping`            | manual                           | liveness check                                           |

A failure on the last attempt is recorded in the error center (source `job`, the task name only, never the payload).

Some work that is often a job elsewhere is done differently here: search reads `text_value` / `name`, derived on
write (§6); formulas, mirrors and progress are computed on read (`apps/api/src/modules/items/computed.ts`); board
export is synchronous (`GET /boards/:id/export`).

## 6. Search

- Postgres only: `cells.text_value` (computed by the registry's `toText`), `items.name` and `updates.body_text`,
  searched with trigram-friendly `ILIKE` (`pg_trgm` GIN indexes); agent knowledge uses a `tsvector` with the `simple`
  configuration (Hebrew has no stemmer in Postgres; prefixes are stripped instead).
- Quick search: `GET /api/v1/search?q=` — items, boards, updates, files, people; filtered by visibility (a join on the
  `items` query builder).

## 7. Files

- S3-compatible object storage (Cloudflare R2, AWS S3, MinIO …) or a local directory (`FILES_DIR`, used by standalone
  mode). `POST /files/presign` → a direct PUT from the browser → `POST /files/complete` (the server checks that the
  object exists). Maximum 500 MB per file. Key: `{account_id}/{asset_id}/{filename}`. Bucket CORS is set by the API
  unless `S3_SET_CORS=false` (for example, R2 object-level keys cannot change CORS — set it with
  `wrangler r2 bucket cors set` instead). See [`SELF-HOSTING.md`](SELF-HOSTING.md).
- `assets` table: owning item / update, mime, size, sha256. Downloads go through a signed URL (15 minutes) — never a
  public bucket; permission is checked against the containing item.

## 8. Email

- Outgoing: invitations, magic links, notifications, digest, verification — through Resend or SMTP
  (`packages/server-mail`). From: the address in `EMAIL_FROM` (or `RESEND_FROM`) only; the sender name comes from the
  account / platform settings; Reply-To is dynamic.
- Incoming (`apps/api/src/modules/inbound-email/`):
  - Addresses: `item-<token>@<domain>` → an update on the item; `board-<token>@<domain>` → a new item (the subject is
    the name) with the email as its first update. `token` = 24 random characters (not derived from the id), stored in
    `inbound_addresses`, created on first use; "new address" sets `disabled_at` on the old one (it never comes back).
  - The domain is a platform setting, `email.inbound_domain` (owner console; empty = off). Per account:
    `settings.inbound_email` (`enabled`, `senders` = anyone / members / domains, `domains`) — managed under
    Administration → Connections. No domain is hard-coded.
  - `POST /api/v1/hooks/email/resend`: a Svix signature (`svix-id/timestamp/signature`, HMAC-SHA256, ≤ 5 min skew)
    checked against `RESEND_INBOUND_SECRET`; without a valid signature ⇒ 401; per IP a request limit (120 / minute)
    and a bad-signature limit (20 / 10 minutes) ⇒ 429. The answer is always `{received: true}` — the same for an
    existing, disabled or unknown address (it never reveals whether a token exists). The webhook carries only metadata:
    each of our addresses gets a row in `inbound_emails` (unique per address + provider id) and a job
    `inbound_email.process`.
  - The job fetches the email and attachments (`GET /emails/receiving/{id}`, `/attachments`; `RESEND_INBOUND_API_KEY`
    or `RESEND_API_KEY`) and rejects it (with the reason on the row) when: SPF and DKIM both failed / DMARC failed, the
    Message-ID was already received at that address, it is an auto-reply, it is our own mail bouncing back, a limit
    was hit (60 / hour per address, 500 per account), or the sender policy does not allow the sender.
  - Who writes: an active account member with a **verified** email that matches the sender and who may write there ⇒
    in their name. Anyone else ⇒ the actor is the address's creator, but the update has no author (`created_by` null),
    `source = email`, `meta.email = {from, name, subject, external}` — no member is impersonated. The address's creator
    is notified like a follower.
  - The text: `text` (or HTML ⇒ text), without the quoted history (`stripQuotedReply`), up to 20K characters.
    Attachments: up to 10, 25 MB each, 50 MB per message, allowed types only (as for a file from a link); inline
    signature images are skipped; downloads go through `outboundDownload` (SSRF guard).
  - The Reply-To of a notification email about an item with a live address (when the account enables it) is the item's
    address ⇒ "Reply" arrives as an update. The digest keeps the account's Reply-To.

**SMS:** `apps/api/src/lib/sms.ts` sends through TextMe (`TEXTME_API_KEY`, `TEXTME_SENDER_ID`); `status: 0` means
success. Test a channel from the owner console: `POST /platform/diagnostics/notify {channel, to}`.

## 9. Observability

- `pino` JSON logs with `request_id`, `actor`, `account_id`; level `info` in production. **Never log** tokens,
  passwords or update bodies (`apps/api/src/lib/scrub.ts` strips credentials from error texts).
- Error reporting through the Sentry SDK (`packages/server-monitoring`) in api / web / worker, off unless
  `SENTRY_DSN` is set; any Sentry-protocol server (Sentry, GlitchTip) works. The built-in error center records
  failures too.
- `GET /api/v1/health` for health checks.

## 10. Security

- Sessions: Better Auth cookies (`HttpOnly; Secure; SameSite=Lax`) with trusted-origin checks; Bearer tokens are not
  cookie-bound.
- Rate limits: in-memory, per instance — per IP (`RATE_LIMIT_IP_PER_10S`), per account (`RATE_LIMIT_ACCOUNT_PER_MIN`)
  and per API token; stricter limits on auth, forms and incoming webhooks. Details in [`06-API.md`](06-API.md) §1.10.
- Secrets only from the environment (`apps/api/src/env.ts`, zod-validated at startup) or generated and stored by the
  installation (standalone mode).
- Tenant isolation: `account_id` is required in every repository query.
- Uploads: MIME type verified, names cleaned, no inline HTML / SVG. Rich text: the server renders HTML from a
  structured document through an allowlist (`packages/shared/src/rich.ts`) — HTML from the browser is never stored or
  shown.
- Headers: CSP (`frame-ancestors 'none'` except extension pages), HSTS, `X-Content-Type-Options`, Referrer-Policy
  (`apps/api/src/middleware/security-headers.ts`).
- Audit log on every admin / security action (see [`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md)).
- Past reviews: [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md), [`AI-SECURITY-REVIEW.md`](AI-SECURITY-REVIEW.md),
  [`EXTENSIONS-SECURITY-REVIEW.md`](EXTENSIONS-SECURITY-REVIEW.md).

## 11. Deployment

- **Single image** (`docker/Dockerfile`): the API serves the built SPA (`apps/web/dist`) from one origin (D2). Without
  `DATABASE_URL` it runs in standalone mode (embedded Postgres, local files, generated keys — D31); with it, it uses
  an external PostgreSQL 18 (with the `pg_trgm` extension) and S3-compatible storage.
- **Split services** (larger installations): `api` (build `pnpm --filter @bines/web --filter @bines/api build`, start
  `pnpm --filter @bines/api start`, health check `/api/v1/health`) and `worker` (build
  `pnpm --filter @bines/worker build`, start `pnpm --filter @bines/worker start`; no public port). Migrations run
  (`pnpm db:migrate`) before the new `api` starts.
- Install options, environment variables and the compose / PaaS setups: [`SELF-HOSTING.md`](SELF-HOSTING.md) and
  [`GUIDE.md`](GUIDE.md); day-to-day operations: [`07-OPERATIONS.md`](07-OPERATIONS.md); releases:
  [`RELEASING.md`](RELEASING.md).

## 12. Local development

```
docker compose up -d        # postgres:18 (5433), mailpit (8025 UI / 1025 SMTP), minio (9000/9001)
pnpm i
pnpm db:migrate && pnpm db:seed   # seed = the first account (SEED_ACCOUNT_*) + the board templates
pnpm dev                    # api :3000, web :5173, worker
```

Copy `.env.example` to `.env`; locally, email goes to Mailpit over SMTP.

## 13. Testing strategy

| Level       | Tool                                                                                               | What                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | vitest                                                                                             | `packages/shared`: every column registry module (settings / value schemas, `toText` / `fromText` round trips, filter operators), automation registries, permission resolvers against the matrix in `05-PERMISSIONS.md` |
| Integration | vitest + PGlite (Postgres in-process via WASM — the same migrations, no Docker; `apps/api/test/helpers.ts`) | services + repositories: every endpoint at least happy path + forbidden + validation; visibility queries; trash / restore; realtime                           |
| Web         | vitest + happy-dom                                                                                 | components and hooks in `apps/web`                                                                                                                           |
| E2E         | Playwright (`e2e/`)                                                                                | board grid, item card and updates, permissions, portal isolation, accessibility scans (`a11y-scan.spec.ts`) and more                                         |
| Load        | `perf/`, `apps/api/scripts/perf-*.ts`                                                              | large boards; see [`PERFORMANCE-REVIEW.md`](PERFORMANCE-REVIEW.md)                                                                                           |

## 14. CI (GitHub Actions)

Workflows in `.github/workflows/`:

- `ci.yml` — install → `pnpm format:check`, `pnpm lint`, `pnpm docs:check`, `pnpm typecheck`, build, the full API
  suite.
- `pr-checks.yml` — the same checks for pull requests from forks (no secrets needed).
- `security.yml` — `pnpm audit`, OSV scanner, license check, Semgrep, Gitleaks.
- `a11y.yml` — Playwright accessibility scans.
- `selfhost.yml`, `installer.yml` — smoke tests of the image, compose and the install script.
- `release.yml` — builds and publishes releases ([`RELEASING.md`](RELEASING.md)); `cla.yml` — the CLA bot.

## 15. Code standards

1. A feature folder per module (`routes` / `service` / `repo`). No global "utils" holding business logic.
2. Zod at every boundary: every route input / output, every column `settings` / `value`, every job payload, every env
   variable.
3. Database access in `*.repo.ts`; a repository always receives the executor and `accountId`.
4. Every mutation: transaction → `activity_log` row.
5. Every endpoint: an OpenAPI schema (`createRoute`) + a test (at least 200 + 403).
6. Permissions: `can(...)` in the service, before every write; for reads, a query builder that filters.
7. IDs: ULID (`newId()` from `packages/shared/src/ids.ts`), `id` columns are text. Column keys: `^[a-z][a-z0-9_]{0,19}$`.
8. UI strings only in `packages/shared/src/i18n/he.json` and `en.json` (`t('board.newItem')`). No hard-coded Hebrew
   in TSX.
9. Logical CSS only (`margin-inline-start`, `inset-inline-end`); no `left` / `right` except direction icons with an
   `rtl:` variant.
10. Soft delete only (`deleted_at`); purges only by the worker.
11. No `console.log`; use the logger. No secrets in logs.
12. Small commits, English messages, imperative mood, optionally with a module prefix:
    `items: allow move between boards with column mapping`.
