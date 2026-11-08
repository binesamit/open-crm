# AGENTS.md — for AI coding agents working in this repository

Bines OS is a self-hosted work-management platform: boards with typed columns, views, automations, dashboards, docs,
forms, a client portal, AI agents and an MCP server. Hebrew-first (RTL) UI with English; English code and comments.
Open source under the AGPL-3.0 (`LICENSE.md`, `LICENSE-EXCEPTIONS.md`). This file is the short map; `CLAUDE.md`
holds the same rules with more detail, and `docs/DECISIONS.md` is binding.

## Map

| Where | What |
|---|---|
| `apps/api` | Hono + TypeScript HTTP API, OpenAPI (`/api/docs`, `/api/v1/openapi.json`), the MCP server (`/mcp`), serves the built web app in production |
| `apps/web` | React 18 + Vite single-page app (RTL first) |
| `apps/worker` | graphile-worker: automations, jobs, scheduled work |
| `packages/shared` | zod schemas for every API, the column-type registry (`src/columns`), permissions, automations, i18n (`src/i18n/{he,en}.json`) |
| `packages/ui` | the design system (tokens, components) |
| `packages/sdk`, `packages/ext-sdk`, `packages/create-bines-app` | MIT SDKs for API clients and extensions |
| `extensions/` | optional extensions shipped with the repo (the core never imports them) |
| `seed/templates` | built-in board templates (JSON) |
| `docs/` | the product and architecture docs; `docs/COLUMN-TYPES.generated.md` is generated from the registry |
| `e2e/` | Playwright suite (`node e2e/run-stacks.mjs`) |

## Commands

```
pnpm i · pnpm dev · pnpm typecheck · pnpm lint · pnpm format:check · pnpm test
pnpm db:generate · pnpm db:migrate · pnpm db:seed · pnpm docs:columns · pnpm docs:check
```

Before you hand work over: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` at the root. Every
endpoint has an OpenAPI schema and a test; every UI string lives in `packages/shared/src/i18n/he.json` and `en.json`.

## Rules that are not negotiable

1. Every write goes through a service that calls `can(actor, action, resource)`; never trust the UI.
2. Every mutation emits one `activity_log` row (actor, source, batch_id); SSE, automations, webhooks and undo read it.
3. Soft delete only (`deleted_at`); the worker purges the trash after 30 days.
4. Column types are registry modules (`packages/shared/src/columns/defs/<family>.ts`), never switch statements
   across the codebase. A new type = one module + registration + i18n + tests; the catalog regenerates itself.
5. `account_id` on every tenant row and in every repository query.
6. zod at every boundary (HTTP, jobs, events, import). No raw SQL outside repositories.
7. Everything a customer could want to change is a setting in the UI, never a constant in code and never a
   customer-specific branch. Features that are optional or integrate a third party are extensions, not core.
8. Never log secrets; tokens are stored hashed; webhooks are signed; files go through presigned URLs.
9. Our own palette and look (`packages/shared/src/colors.ts`, `docs/11-UI-DESIGN.md`); no other product's assets,
   colours or wording. Status and data text is never bold.
10. No private material in the repo: no customer names, no production ids, no personal paths or links.

## How the product is used by AI (not by you)

- MCP: `https://<installation>/mcp` (Streamable HTTP; OAuth or an API token) — boards, items, docs, automations.
- REST: `https://<installation>/api/docs` (reference) and `/api/v1/openapi.json` (the document).
- `https://<installation>/llms.txt` lists what an AI client should read first.

## Where the facts are

- Column types: `docs/COLUMN-TYPES.generated.md` (generated), `docs/03-COLUMN-TYPES.md` (spec).
- Automations: `docs/04-AUTOMATIONS.md`. Permissions: `docs/05-PERMISSIONS.md`. API: `docs/06-API.md`.
- Install and operate: `docs/GUIDE.md`, `docs/SELF-HOSTING.md`. Licensing and keys: `docs/LICENSING.md`.
- Extensions: `docs/extensions/`. Design: `docs/11-UI-DESIGN.md`, `design-guide/f4/`.
- How the app behaves for its users: `docs/user/`. What is planned and not built: `docs/12-ROADMAP.md`.
