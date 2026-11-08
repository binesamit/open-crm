# Contributing

How to set up the repository, the checks a pull request must pass and the rules the code follows. For anyone who
wants to send a fix or a feature; looking for something to work on? See the [roadmap](docs/12-ROADMAP.md).

Thank you for helping! This project is open source under the GNU AGPL-3.0 (`LICENSE.md`), with the additional
permissions in `LICENSE-EXCEPTIONS.md`; the SDK packages and integrations are MIT. See "License" in `README.md` for
what that means in practice.

> The license exceptions, the trademark policy and the CLA are drafts pending legal review; this guide describes how
> the repository is set up.

## Contributor License Agreement (CLA)

Before your first pull request can be merged, you sign the [CLA](CLA.md) — once, by commenting the sentence the CLA
bot asks for on your pull request. It lets the maintainers keep shipping your contribution under the project's
license (and under other licenses if ever needed); in return the CLA promises that your contribution always stays
available under an OSI-approved license. You keep the copyright in your work.
We do **not** use the DCO (`Signed-off-by`) — the CLA replaces it.

## Getting started

```bash
docker compose up -d     # Postgres, Mailpit (mail), MinIO (files)
pnpm i
pnpm db:migrate && pnpm db:seed
pnpm dev                 # api + web + worker
```

Node 22 (`.nvmrc`) and pnpm 9 (`packageManager` in `package.json`).

## Before you open a pull request

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

- **Tests**: every endpoint has an API test (`apps/api/test/<module>.test.ts`, on PGlite — no services needed);
  shared logic has unit tests; UI flows have Playwright specs in `e2e/`.
- **i18n**: every user-facing string is a key in `packages/shared/src/i18n/he.json` **and** `en.json` (Hebrew first).
- **RTL**: logical CSS only (`ms-`/`me-`, `start`/`end`); check the screen in Hebrew.
- **No browser-native UI**: no `window.confirm/alert/prompt` (use `confirmDialog`), no native date/time pickers,
  tooltips via `data-tip`.
- **Generic, never per client**: behaviour is configured in the UI (settings, data), never hard-coded for one customer.

## Code rules (short version — `CLAUDE.md` has the full list)

1. Every write goes through a service that checks permissions (`can(...)`), and emits an event to `activity_log`.
2. zod at every boundary; every endpoint has an OpenAPI schema and a test.
3. Column types, automation actions/triggers and similar are registry modules — no switch statements across the code.
4. `account_id` on every tenant row; every query filters by it.
5. Never log secrets or tokens.

## License headers

Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-only` (MIT in the SDK packages and the
integrations). Dependencies are covered under "Dependencies" below.

## Commits and pull requests

- One topic per pull request; describe what changed and how you tested it (a screenshot for UI, RTL included).
- Commit messages in English, imperative mood ("Add …", "Fix …").
- New files start with an SPDX line: `// SPDX-License-Identifier: AGPL-3.0-only` (core) or `MIT` (SDK packages
  and integrations).
- Pull requests from forks run `.github/workflows/pr-checks.yml` (format, lint, typecheck, unit tests) and `ci.yml`
  (the full API suite) — neither needs any secret.

## Dependencies

New production dependencies must have a license the project can ship: `pnpm check:licenses`
(`scripts/check-licenses.mjs`, also in CI) accepts permissive licenses, the GPL family version 3 and the LGPL, and
fails on source-available terms (BUSL, SSPL, FSL…), GPL-2.0-only or an unknown license. A justified exception goes
into `scripts/license-policy.json` with its reason. After changing dependencies, regenerate
`THIRD-PARTY-NOTICES.md` with `pnpm licenses:notices`.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting security issues

Please do not open a public issue — report privately, as described in [SECURITY.md](SECURITY.md).
