# Bines OS Platform — Claude Code guide

Bines OS — a self-hosted work management platform (CRM, projects, support, finance + client portal).
Teams + clients as guests; multi-account — the platform owner can open more accounts (D12). Open source under the AGPL-3.0 (`LICENSE.md`, `LICENSE-EXCEPTIONS.md`, D33); the short map for agents is `AGENTS.md`. Hebrew-first UI (RTL), English code.

## Read order
1. `docs/DECISIONS.md` — binding architecture decisions. Do not deviate without changing this file first.
   Maintainers may keep private working notes (session handoff, plans, ops tools) outside the repo in
   `../private-reference/` (`docs/`, `scripts/agent-tools/`); read them there when present. The code never needs them.
2. `docs/00-PRD.md` → `docs/01-ARCHITECTURE.md` → `docs/02-DATA-MODEL.md` (+ `apps/api/src/db/schema.ts`).
3. The doc for the module you touch: `03-COLUMN-TYPES`, `04-AUTOMATIONS`, `05-PERMISSIONS`, `06-API`, `07-OPERATIONS`,
   `08-ACCOUNT-ADMIN`, `09-CLIENT-PORTAL`, `10-EXTENSIONS`, `11-UI-DESIGN`. Plan and tasks: `12-ROADMAP.md`.
4. Research notes and business data are private and live OUTSIDE the repo in `../private-reference/` (never commit them back). Our visual spec is `design-guide/f4/`.
5. `seed/templates/*.json` = built-in board templates (generic sample boards); `seed/packs/*.json` = starter kits and sample extensions (data). Per-account automation recipes are not in the repo: `automations:seed` reads them from `SEED_AUTOMATIONS_DIR` when set.

## Stack & commands
pnpm workspaces monorepo (`pnpm -r`, no turbo — D2). `apps/api` (Hono, TS), `apps/web` (React 18 + Vite), `apps/worker` (graphile-worker), `packages/shared`, `packages/sdk`, `packages/ui`.
PostgreSQL 18 + Drizzle; Better Auth; S3-compatible files; Resend email; Railway deploy; docker-compose for local (WSL2).
```
pnpm i · pnpm dev · pnpm typecheck · pnpm lint · pnpm test · pnpm db:generate · pnpm db:migrate · pnpm db:seed
```

## Hard rules
1. Every write goes through a **service** that calls `can(actor, action, resource)` (`packages/shared/permissions`). Never trust the UI. Strictest rule wins. Owners bypass board/column restrictions. Guests see only shareable boards they subscribe to, and only items visible per `boards.view_items`.
2. Every mutation **emits an event** to `activity_log` (one row, with `actor`, `source`, `batch_id`). SSE, automations, webhooks, undo all read from it.
3. **Soft delete only** (`deleted_at`); trash purge after 30 days by the worker. Archive is forever.
4. Column types are **registry modules** (`packages/shared/src/columns/defs/<family>.ts`, registered in `columns/index.ts`), never switch statements across the codebase. Cell values are JSONB in the module's `valueSchema`; `text_value/number_value/date_value` are derived on write.
5. Column ids: `[a-z][a-z0-9_]{0,19}`, unique per board, never reused after deletion. Imported source ids are kept verbatim.
6. Automations are **data** (`{trigger, conditions, actions}`); the worker executes actions via the same services as the API, as actor `automation:<id>`, with loop protection (depth ≤5, 10s self-retrigger guard).
7. `account_id` on every tenant row; every repository query filters by it. Several accounts live side by side (D12): account comes from `X-Account-Id` + membership check per request (sessions are not account-bound; tokens are). Cross-account access = 404. Platform owner bypasses nothing inside an account.
8. zod at every boundary (HTTP, jobs, events, import). No raw SQL outside `repositories/`. Every endpoint has an OpenAPI schema and a test.
9. UI: RTL-first, logical CSS only, strings in `packages/shared/i18n/he.json` (+ `en.json`), tokens from `11-UI-DESIGN.md`. Status/group colours = our own palette, stored as keys (`packages/shared/colors`, D30). Never use a imported palette's hex values (a test guards it).
10. Never log secrets or tokens; API tokens stored hashed; webhooks signed (HMAC-SHA256); files only via presigned URLs.
11. Items are a tree (`parent_item_id`, `depth ≤ 5`); subitems live on the board's **sub-board** with their own columns (D14).
12. Core never imports from `extensions/`.

## How to add…
- **A column type**: a `ColumnTypeDef` (03 §1) in the right family file under `packages/shared/src/columns/defs/` (basic, labels, dates, contact, computed) with `importSettings` for template settings → add it to `DEFS` in `packages/shared/src/columns/index.ts` → cell component in the `CELLS` map of `apps/web/src/features/board/cells/index.tsx` → tests in `packages/shared/test/columns.test.ts` → row in 03 matrix.
- **An automation action/trigger**: `packages/shared/automations/{actions,triggers}/<key>.ts` (schema + `run`/`match`) → register → sentence fragment in `i18n` → UI picker config → test with a fixture event.
- **An endpoint**: zod schemas in `packages/shared/api/<module>.ts` → route in `apps/api/src/modules/<module>/routes.ts` (zod-openapi) → service → repository → event → test (`apps/api/test/<module>.test.ts`) → SDK regenerates from OpenAPI.
- **A board template**: JSON in `seed/templates/` following `seed/templates/README.md` → `pnpm db:seed` upserts by `key`.

## Seed & import
`pnpm db:seed` loads `seed/templates` as account templates. Users bring data in through Excel/CSV import from a board (bulk import) or through the API/MCP (M5).
