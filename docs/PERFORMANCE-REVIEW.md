# Performance review — Bines OS

This document records a performance review of Bines OS under load, for contributors working on performance and for
self-hosters sizing an installation. It is a historical audit of the code as it was in October 2026: it describes the
method, the measurements before and after, the bottlenecks found and what was changed, and what remained open at the
time (with later status where known). Section numbers are cited from source comments and scripts, so they are stable.

Target: **50 concurrent users, 100,000 items in one account**. Thresholds: p95 < 300 ms for reads, p95 < 500 ms for
writes, errors < 1%. Everything was measured locally (no staging or production environment).

## 1. Summary

| | before | after (1 process) | after (4 processes) |
|---|---|---|---|
| reads p95 (full mix) | 18.4 s | 4.0 s | 1.4 s |
| writes p95 (full mix) | 13.3 s | 3.0 s | 1.0 s |
| reads p95 — without opening 25k+ boards | — | 378 ms | **256 ms ✓** |
| writes p95 — without opening 25k+ boards | — | 273 ms ✓ | **114 ms ✓** |
| requests per second | 9/s | 24/s (35/s without the big ones) | 32/s (35/s) |
| errors | 0.3% / 0.7% | 0% | 0% |

- **The database is no longer the bottleneck** — all heavy queries (search, My Work, board search, cell loading)
  dropped to 30–130 ms. What remained was **Node CPU**: opening a 30k-item board cost ~1.3 s of CPU (was ~5), and Node
  is a single process — every such open delays everything else.
- **Without opening 25k+ boards the target is met** (4 processes: reads p95 256 ms, writes 114 ms, 0 errors). With
  such opens — not, even with 4 processes (p95 for opening a big board 4.8 s). This could not be solved by a point fix:
  **the UI loaded the whole board** (`GET /boards/:id/items` — 44 MB of JSON for 30k items, 4 MB gzipped). The real
  fix = server-side windowed loading (§7.1, built — see §7a).
- **The most severe finding in real use** did not show in k6: every change by anyone on a board made **everyone
  viewing it** reload the whole board (SSE → `invalidateQueries(items)`). On a 30k board with 10 viewers — 10 × 44 MB
  × seconds of CPU per edit. Fixed: an item event refreshes only that row (`?ids=`, ~28 ms and 3 KB instead of 1.3 s
  and 44 MB).

## 2. Environment and method

- **A separate database for testing** — a `bines-perf-pg` container (postgres:18-alpine, port 5434,
  `pg_stat_statements` loaded, `log_min_duration_statement=200`) instead of the local development database: the
  development data is untouched and statistics can be reset.
  ```
  docker run -d --name bines-perf-pg -e POSTGRES_USER=bines -e POSTGRES_PASSWORD=bines -e POSTGRES_DB=bines_perf -p 5434:5432 \
    postgres:18-alpine -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=all -c log_min_duration_statement=200
  docker exec bines-perf-pg psql -U bines -d bines_perf -c "create extension pg_stat_statements"
  DATABASE_URL=postgres://bines:bines@localhost:5434/bines_perf pnpm db:migrate && ... pnpm db:seed
  ```
- **Data** — `pnpm --filter @bines/api perf:seed` (`apps/api/scripts/perf-seed.ts`, ~4 minutes): a new `perf100k`
  account through the owner console (invitation → password sign-up → approval), 50 users, 10 boards of uneven sizes
  (30k / 27k / 25k / 6k / 4k / 3k / 2k / 1.5k / 1k / 500 = 100,000), each with status / people / date / numbers / text /
  dropdown / tags / formula columns, 7 of them with a relation to clients + a mirror, 2–10 groups, 2 extra views
  (kanban, filtered); 16.9k subitems in 4 sub-boards; 13.5k updates (25% with a reply), 559 files in updates, 1,477
  files in a files column; 3.1k notifications; an `item.created` event per item. The structure is created through the
  API (the same code as the app), the rows by bulk insert (cells through `parseCellValue`, like a service write). It
  refuses a non-local database unless `PERF_SEED_ALLOW_REMOTE=1`. Output: `perf/.perf-perf100k.json` (not in git). A
  rerun reuses the existing account; `--reset` rebuilds it.
- **API** — `WEB_CONCURRENCY=1|4 API_PORT=3100 DATABASE_URL=…5434… LOG_LEVEL=warn pnpm --filter @bines/api exec tsx src/index.ts`.
- **Load** — `perf/k6/board-mix.js` in Docker (`grafana/k6`):
  ```
  MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/perf:/perf" grafana/k6 run /perf/k6/board-mix.js \
    -e BASE=http://host.docker.internal:3100 -e DURATION=3m [-e OPEN_BIG=0] [-e LABEL=x]
  ```
  50 virtual users, each a real user from the seed (a session cookie from a password sign-in), 3 minutes, 1–4 seconds
  of "think time" between actions. Mix: opening a board like the web app (board + views + update counts + all items +
  sub-board items, in parallel) 10% · item queries (filter + sort / search / "mine") 15% · item card (item + updates +
  activity) 15% · cell edit 25% · posting an update 8% · My Work 7% · global search 10% · inbox 10%. In parallel: 50
  open SSE connections (one per user). `OPEN_BIG=0` = the same mix without opening boards of 20k+ (isolating their
  cost). Results: `perf/results/` (not in git).
- **Profiling** — `apps/api/scripts/perf-profile.ts`: one in-process request under the V8 profiler (self time per
  function + a `.cpuprofile` file for DevTools). `pg_stat_statements` before / after each run;
  `EXPLAIN (ANALYZE, BUFFERS)` for suspect queries.
- **Caveat** — one 8-core laptop ran the server, Postgres, k6 and other containers at the same time; the numbers are
  noisy (±20%) and there is no real network in between. They are good for before / after comparisons and for finding
  bottlenecks, not as a production guarantee.

## 3. Numbers — single request (no load)

| request | before | after |
|---|---|---|
| `GET /boards/:id/items` — 30k board | 4,690 ms · 43 MB | **1,311 ms · 4.0 MB (gzip)** |
| `GET /boards/:id/items?ids=…` — row refresh (new) | (whole board reload) | **28 ms · 3 KB** |
| `GET /boards/:sub/items` — 5.9k sub-board | 439 ms · 2.8 MB | 123 ms · 255 KB |
| `GET /boards/:id/items` — 500 board | 124 ms · 388 KB | 47 ms · 46 KB |
| `POST items/query` — search on a board with subitems | **3,998 ms** | **130 ms** |
| `POST items/query` — status filter + sum sort | 216 ms | 95 ms |
| `GET /me/work` (user with 5.9k assignments) | 390 ms | 166 ms |
| `GET /search?q=Acme` (5.6k matching items) | 304 ms | 78 ms |
| `GET /boards/:id/update-counts` (30k) | 70 ms · 102 KB | 64 ms · 47 KB |
| board / views / tree / inbox / item card | 5–50 ms | 5–40 ms |

## 4. Numbers — k6, 50 users, 3 minutes (p95, ms)

| endpoint | before | after, 1 process | after, 4 processes | 4 processes, without 20k+ |
|---|---|---|---|---|
| board | 5,180 | 1,345 | 718 | 69 |
| views | 6,340 | 1,801 | 839 | 94 |
| update_counts | 6,015 | 1,452 | 678 | 99 |
| items_all (board < 20k) | 18,417 | 3,311 | 1,591 | 512 |
| items_all_big (25k–30k) | 25,265 | 6,558 | 4,806 | — |
| sub_items_all | 10,780 | 3,097 | 1,197 | 340 |
| query_filter | 19,039 | 4,656 | 1,837 | 242 |
| query_search | 21,925 | 4,312 | 1,444 | 252 |
| query_person | 16,459 | 3,866 | 1,251 | 211 |
| item / updates / activity | 11,520 / 7,988 / 7,859 | 2,669 / 1,612 / 1,643 | 709 / 568 / 562 | 88 / 68 / 62 |
| my_work | 21,145 | 4,294 | 1,866 | 318 |
| search | 22,319 | 5,711 | 2,034 | 255 |
| inbox_count / notifications | 7,373 / 7,743 | 4,598 / 1,483 | 1,427 / 589 | 179 / 68 |
| set_cell (write) | 14,057 | 3,227 | 1,014 | 118 |
| post_update (write) | 10,521 | 2,158 | 1,072 | 100 |
| **all reads** (median / p95) | 3,869 / 18,379 | 531 / 3,965 | 70 / 1,406 | **32 / 256 ✓** |
| **all writes** (median / p95) | 2,879 / 13,307 | 551 / 3,042 | 52 / 1,043 | **33 / 114 ✓** |
| board open (wall time, p95) | 22,527 | 5,968 | 3,718 | 514 |
| errors (reads / writes) | 0.30% / 0.71% | 0% / 0% | 0% / 0% | 0% / 0% |
| requests | 1,803 (9/s) | 4,453 (24/s) | 6,051 (32/s) | 6,473 (35/s) |

One process without big boards: reads p95 378 ms, writes 273 ms. "Before" was measured on the code before any change,
on the same data. In the "after" run's `pg_stat_statements` no query averaged above 145 ms; total database time in the
run was ~100 seconds on 8 cores — the database is far from saturation.

## 5. Bottlenecks found, and what changed

### 5.1 Live refresh reloaded the whole board on every change (web) — the most critical

`use-board-live.ts`: every `cell.*` / `item.*` / `update.*` from someone else → `invalidateQueries(['board', id,
'items'])` → every viewer reloaded the whole board. **Fixed:** an event that names an item (`isRowEvent`) is batched
(150 ms) and only that item is fetched — `GET /boards/:id/items?ids=a,b,c` (up to 200; an item that was deleted /
moved / hidden does not come back ⇒ it leaves the cache; `mergeRows` in shared). A sub-board row also refreshes its
parent item (subitem mirrors). Over 200 rows, an event without an item, or an error ⇒ a full reload as before. Files:
`packages/shared/src/api/realtime.ts`, `apps/web/src/features/board/use-board-live.ts`,
`apps/api/src/modules/items/{items.routes,items.service}.ts`.

### 5.2 Loading a whole board: 5.3 s → 1.3 s CPU (30k items)

The V8 profile showed: ~1 s building 30k `inArray` placeholders in Drizzle (and Postgres parsing them), items read
twice, 200k cells going through full Drizzle mapping (5 timestamps to `Date` per row), `toFormula` computed for every
cell even when no formula reads it, a new Map per item for every formula column, and a Postgres sort spilling to disk
(`external merge`). **Changed:**

- `anyId()` in `items.repo` — `= any($1::varchar[])`, a single parameter (itemsByIds, cellsByItemIds, linksFromItems,
  childItemsOf, columnValueCounts).
- `Calculator.prefetch(ids, levels, known, boardId)` — rows already loaded are not read again; for a whole-board load
  cells are read by `board_id` (`ix_cells_board`, 45 ms) rather than by 30k ids; cells are read with a raw
  `db.execute` of 4 columns (`cellValuesByItemIds` / `cellValuesByBoard`: 1.1 s → 0.5 s).
- `Calculator.display()` — a plain stored cell is read directly, with no memo and no intermediate object; a cell's
  formula value is computed only when a formula or mirror reads it (`formulaOf`, a `LAZY` marker); the column map by
  key and a formula's reference list are built once per board / column.
- `listBoardItems` sorts in memory (`byDepthPosition`, "C" collation as in query.repo) rather than in SQL.

### 5.3 gzip — there was none

A 44 MB `c.json` went out as is, and the bundle (1.9 MB) was served uncompressed in production. **Changed:**
`middleware/compress.ts` (`gzipJson`) — JSON over 8 KB is compressed with async zlib (thread pool, not the event loop),
smaller responses go out as is, SSE is untouched; `/assets/*` with Hono's `compress()`. 44 MB → 4 MB.

### 5.4 Search on a board with subitems: 4 s → 130 ms

Every search on a board with a sub-board ran "in memory" — loading the whole board and sub-board. **Changed:** when
the search is the only thing that reads subitems and all subitems are visible to the user, it runs in SQL (`exists`
over `items s where s.root_item_id = i.id` — name and cells, any depth), with the same result (a new test compares SQL
with in-memory).

### 5.5 My Work: 700 ms → 50 ms in the database

`assignedItemIds` ran `exists (… jsonb_array_elements …)` for every item updated in the last 4 months. **Changed:** a
`materialized` CTE of people cells containing me (`value @> {"persons_and_teams":[{"id":…}]}`) through the existing GIN
index (`ix_cells_value_gin`, jsonb_path_ops), then the items.

### 5.6 Global search: 640 ms → 70 ms in the database

`(name ilike or exists(tags) or exists(text))` over every item in the account, sorted with two more `exists` per row;
the tags branch scanned the whole cells table even when no tag matched. **Changed:** candidates first, each through its
own index (trigram on name and on `text_value`, GIN on tags `value @> {"tag_ids":[…]}`), each candidate carrying
"matching tag / tag with the exact name", and the sort runs only over them.

### 5.7 Position keys growing linearly (found along the way)

`rankBetween(last, null)` ("add at the end") added a character every ~5 inserts: in a group of 3,000 items ~600
characters, with 30k ~6 KB. In a development database with imported data the average was 557 characters and the
maximum 2,002; in the test data 402 on average = ~12 MB of the 44 MB of a 30k board, and that is what made the sort
spill to disk. **Changed:** `after()` in `lexorank.ts` — appending at the end adds one unit at a depth that leaves
room for ~36³ inserts; 50,000 inserts ⇒ at most 8 characters. Existing keys do not change (even a long key gets a
short successor); see §7.3.

### 5.8 Multiple processes (opt-in)

`WEB_CONCURRENCY=n` in `apps/api/src/index.ts` (default 1 — no change): n API processes on the same port
(`node:cluster`). Safe because nothing request-related lives in process memory: sessions are in the database, live
events come from NOTIFY to every process, the automation queue is graphile-worker; the automation engine runs only in
process 0. Caveat: token rate limits are counted per process. On a platform with replicas, the same idea = replicas.
Each process opens up to 10 pool connections + LISTEN ⇒ 4 processes ≈ 45 connections (Postgres default: 100).

### 5.9 Indexes

No missing index was found: every database problem was a query shape that did not use an existing index (GIN on
`cells.value`, trigram on name and `text_value`, `ix_cells_board`). An index on `(board_id, depth, position)` for
board loading was tried — Postgres did not choose it (long keys, an estimate of 30k rows), so it was removed and the
sort moved to memory. Hence this review added no migration.

## 6. Web — bundle and Lighthouse

**Before:** one JS file, 1,887 KB (548 KB gzip) — served **without gzip** in production. TipTap + ProseMirror alone
~390 KB, loaded even on the sign-in screen.
**After:** the editor (`features/item/Composer.tsx`, with TipTap) loads only when an item card opens (`React.lazy`,
435 KB / 139 KB gzip); the owner console, administration (`AdminSections`), automations, trash and archive are
separate chunks (`lazyPage` in `router.tsx`). First load (JS + CSS): **1,920 KB → 1,404 KB, gzip 545 KB → 398 KB**,
and now actually sent gzipped.

Lighthouse 12 (mobile profile, simulated throttling; a static server with gzip — `perf/serve-web.mjs` — for both
builds, against the same API):

| page | score | FCP | LCP | TBT | weight |
|---|---|---|---|---|---|
| sign-in — before / after | 0.66 / **0.73** | 5.1 s / 4.4 s | 5.6 s / 4.5 s | 0 / 0 | 637 KB / 491 KB |
| My Work — before / after | 0.59 / **0.69** | 5.1 s / 4.4 s | 6.2 s / 5.2 s | 283 ms / 108 ms | 683 KB / 538 KB |
| 6k board — before / after | 0.33 / 0.35 | 4.7 s / 4.1 s | 10.4 s / 9.7 s | 6.2 s / 6.1 s | 1,246 KB / 1,100 KB |

A 6,000-item board: Total Blocking Time of 6 seconds (simulated mobile; ~1.5 seconds on a desktop) — processing the
items in the browser (filtering / grouping / summaries over the whole list) and 3.9 seconds of Style & Layout. See
§7.2.

## 7. What remained (by priority)

1. **Boards of 25k+ — server-side windowed loading.** As long as the UI receives the whole board, opening a 30k board
   = ~1.3 s of CPU and 4 MB (gzip) — it cannot meet 300 ms in any mix of 50 users. Proposal: above a threshold the
   table switches to "server" mode: `POST items/query` with a cursor for the visible window (already filters and sorts
   in SQL), group counts / summaries from the server (one aggregate query), and grouping / filtering / sorting sent as
   a query instead of running in the browser; live refresh already works by row. **Done — see §7a.**
2. **Board processing in the browser** (TBT 6 s for a 6k board on mobile). **Addressed by §7a:** the measured
   computation is 4–8 ms; the cost was React / Style & Layout and parsing 5 MB of JSON, and such boards now load in
   windows.
3. **Existing long position keys** (in databases written before §5.7) — a one-off script that recomputes the keys of
   each group / parent from the current order (`initialRanks` — now short), in a transaction. Saves ~25% of board size
   and sort cost. **Open** — no such script is in the repository.
4. **In production:** run replicas (or `WEB_CONCURRENCY` by vCPU count) and check `max_connections`; consider a
   configurable `DB_POOL_MAX`. **Open** — the pool size is still fixed at 10 in `apps/api/src/db/client.ts` (it was not
   a bottleneck in the measurements).
5. **A load test against a deployed environment**: the same `board-mix.js` with that environment's `BASE` / `CONFIG`
   after running `perf:seed` there (`PERF_SEED_ALLOW_REMOTE=1`) — including a real network — and a short k6 run in CI.
   Notes for a deployed server: the cookie is `__Secure-bos.session_token`, the origin = `BASE`, and sign-in is limited
   to 10 per minute per address ⇒ the k6 setup waits out 429s (`SETUP_TIMEOUT=600s` for 50 users, ~5 minutes).
6. Small: `query_filter` with a sort on a 30k board (40–145 ms in the database: `exists` per item +
   `count(*) over()`), search in updates (18 ms), `update-counts` (13 ms) — acceptable today.

## 7a. Windowed loading — built (§7.1)

A top-level board with more than `WINDOW_MIN_ITEMS` (3,000) items is not loaded whole. `GET items?window=1` returns
only the size; the table requests `POST items/outline` — all matching ids in view order, per group / bucket, with the
footer summaries and the header summary computed on the server (the same engine as in the browser); the rows
themselves load by id (`?ids=`, 200 per request) as they enter the screen, and a row not yet loaded shows as a
placeholder. Editing / dragging / live refresh write to the cache as usual ⇒ the outline refreshes (at most every
800 ms). Kanban: lanes from the server (`lanes_by`) + "show more"; cards: a flat list + "show more"; calendar: only the
date range on screen. Select all ⇒ `POST items/bulk-query` (one action by query, up to 50k, one undo). Boards ≤ 3,000
items — exactly as before. Summaries of computed columns (formula / mirror) are skipped above 5,000 results
(`skipped_summaries`) — each one cost ~2 seconds. The outline sort in SQL: no `count(*) over()` and a local `work_mem`
(the long keys from §5.7 spilled to disk).

Measurement (`apps/api/scripts/windowed-bench.ts`, in-process against the test database, median of 5, ms):

| board | before: whole board | after: size check + outline + first screen (60) | toolbar change (outline) |
|---|---|---|---|
| 30k | 1,567 · 43 MB (3.9 MB gz) | 18 + 293 + 35 · ~0.9 MB (0.4 MB gz) | filter + sort 186 · search 238 · group 303 |
| 27k | 1,668 · 40 MB | 17 + 276 + 32 | 169 · 226 · 279 |
| 25k | 1,434 · 31 MB | 16 + 217 + 30 | 172 · 215 · 222 |
| 6k | 186 · 5.7 MB | 8 + 56 + 15 | 61 · 52 · 53 |

A window of 200 rows: 37–41 ms, 25 KB gz. In the browser, filtering / sorting / grouping / all summaries over a whole
board of 3k–6k items take 4–8 ms (`windowed-bench.ts --client`) — so the TBT in §6 for a 6k board was React / Style &
Layout and parsing 5 MB of JSON, not the computation; a Web Worker would not have helped, and such a board now loads
in windows (only ~200 rows in memory and a bounded DOM).

Remaining: a huge sub-board is still loaded whole; the "import and edit" sheet loads the whole board itself (up to 10k
rows). E2E coverage: `e2e/windowed.spec.ts` (a 30k board through the API).

## 8. Files

- New: `apps/api/scripts/perf-seed.ts` (`perf:seed`), `apps/api/scripts/perf-profile.ts`, `perf/k6/board-mix.js`,
  `perf/serve-web.mjs`, `apps/api/src/middleware/compress.ts`, `apps/web/src/features/item/Composer.tsx`,
  `apps/api/test/items-live.test.ts`, `packages/shared/test/live-rows.test.ts`, this document.
- Changed: `apps/api/src/{app,index}.ts`,
  `apps/api/src/modules/items/{items.repo,items.service,items.routes,computed,query.repo,query.service}.ts`,
  `apps/api/src/modules/mywork/mywork.repo.ts`, `apps/api/src/modules/search/search.repo.ts`,
  `packages/shared/src/{lexorank,api/realtime}.ts`, `packages/shared/test/lexorank.test.ts`,
  `apps/api/test/query.test.ts`, `apps/web/src/features/board/use-board-live.ts`,
  `apps/web/src/features/item/ItemCard.tsx`, `apps/web/src/app/router.tsx`, `apps/api/package.json` (`perf:seed`),
  `.gitignore` (`perf/.perf-*.json`, `perf/results/`).
- The row-based live refresh (§5.1) is covered by API and shared tests and by `e2e/m4-realtime.spec.ts`.
