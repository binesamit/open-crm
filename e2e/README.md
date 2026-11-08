# Browser tests (E2E)

Playwright specs against the real stack (API, web app, Postgres, Mailpit). They run locally, not on GitHub
(GitHub runs the security checks only).

## Ways to run

| Command | What it does |
| --- | --- |
| `pnpm e2e [specs]` | One stack, one worker, on the usual dev ports and the database in `.env`. Starts the API and web app unless they already run. |
| `pnpm e2e:parallel` | The same stack: `isolated` specs on `E2E_WORKERS` workers (default 3), then the `serial` ones on one. |
| `node e2e/run-stacks.mjs --shards N [specs] [playwright args]` | N complete stacks side by side, each with a fresh database, its own Mailpit container and its own ports, each running 1/N of the specs on one worker. The fastest full run. |
| `pnpm e2e:unregistered` | The edition-limits spec on its own stack and fresh database. |

`serial-specs.ts` lists the specs that change account- or user-level state; they never run beside another test in
the same account. With `run-stacks.mjs` every stack has its own database, so each stack runs its share one after the
other and the stacks never meet.

`clipboard-specs.ts` lists the specs that use the machine's real clipboard. It is one per machine, so with several
stacks every stack skips them (`E2E_CLIPBOARD=skip`) and the first stack runs them all after its share
(`E2E_CLIPBOARD=only`). A new spec that reads or writes the real clipboard goes in that list.

## run-stacks.mjs

Needs Docker running (Postgres from `docker-compose.yml`; Mailpit containers are started per stack and removed
afterwards). Before starting anything it checks that every port is free, and stops otherwise.

| Setting | Default | Meaning |
| --- | --- | --- |
| `--shards N` / `E2E_STACKS` | 3 | Number of stacks |
| `E2E_PORT_BASE` | 4100 | Stack n listens on base + 10·n … +3 (web, API, Mailpit, geocoder) |
| `E2E_HOST` | 127.0.0.1 | Listen address (never `localhost`: a browser may resolve it to another program's `::1`) |
| `E2E_DATABASE_URL` | `DATABASE_URL` | Postgres server for the stacks' databases, named `<db>_e2e_s<n>` |
| `E2E_MAILPIT_IMAGE` | `axllent/mailpit:latest` | Mailpit image |
| `E2E_KEEP=1` | off | Keep the stacks' databases afterwards |

Each stack's output is in `test-results/stacks/s<n>.log`; failure screenshots in `test-results/stacks/s<n>/`.
Containers are named `bines-e2e-<port base>-s<n>`, so two sessions on different port bases never collide.

## Addresses

Specs never hard-code a port: `stack.ts` reads `E2E_WEB_URL`, `E2E_API_URL`, `E2E_MAILPIT_URL` and `E2E_GEO_URL`
(defaults: the dev stack on localhost 5173 / 3000 / 8025 and 127.0.0.1:3999). `playwright.config.ts` also takes
`E2E_DATABASE_URL` (the API's database) and `E2E_REUSE_SERVERS=0` (never reuse a server already listening).
