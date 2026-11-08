# Catalogue sample extensions (round 13)

Two first-party code extensions offered in every account's store (Administration → תוספות → חנות), plus the
`crm-starter` data pack (`seed/packs/crm-starter.json`, no code, always seeded):

| key | slot | scopes | what it does |
| --- | --- | --- | --- |
| `board-summary` ("סיכום בורד") | `board_view` | `boards:read` | items, % done, overdue, by status / group / person |
| `kanban-stats` ("סטטיסטיקת קנבן") | `dashboard_widget` | `boards:read` | per dashboard board: items per status lane, % done, biggest lane; the viewer picks the status column (kept in the extension's per-user storage) |

Both are read-only, have no server, render everything from the API as text (never HTML), and run under a strict CSP.
Their manifests are `seed/packs/sample-*.json` with the placeholder `{{SAMPLE_EXTENSIONS_ORIGIN}}`; `pnpm db:seed`
(and the deploy's bootstrap) fills it from the env var of that name and publishes them to the catalogue with a review
record. Without the variable they are left out. The seed refuses an origin equal to `WEB_ORIGIN`, and in production
anything that is not public https.

## Development

```
node extensions/catalog/serve.mjs            # http://127.0.0.1:3997 (its own origin)
SAMPLE_EXTENSIONS_ORIGIN=http://127.0.0.1:3997 pnpm db:seed
```

(or put `SAMPLE_EXTENSIONS_ORIGIN` in `.env`). `/board-summary/manifest.json` and `/kanban-stats/manifest.json` also
work with "למפתחים → install by URL".

## Production — a separate origin, never the app's

The pages must be served from an origin different from the app (an extension on our origin would get our cookies and
DOM; the install refuses it anyway). Build the static files and host them on any static host:

```
node extensions/catalog/build.mjs dist-ext --origin https://ext.example.com --app https://<app origin>
```

`dist-ext/` holds the pages, `sdk.js` (from `packages/ext-sdk`), `config.js` (the SDK pinned to the app's origin —
messages from any other window are ignored) and `_headers` (Cloudflare Pages / Netlify format: CSP with
`frame-ancestors <app origin>`, `connect-src <app origin>`, `nosniff`, `no-referrer`).

Suggested hosting: Cloudflare Pages (the files bucket already lives on Cloudflare R2) on its own subdomain (e.g. `ext.example.com`), or a
small static Railway service — either way its own hostname. Then set `SAMPLE_EXTENSIONS_ORIGIN=https://ext.example.com`
on the API service; the next deploy's bootstrap publishes the samples. Changing the origin later = a new manifest
version for the installed copies (a new origin waits for each account admin's consent, as for any extension).
