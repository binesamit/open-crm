# Bines OS extensions — developer guide

This is the reference for third-party developers who build extensions for Bines OS, a work management
platform. Start with the hands-on tutorial in [`QUICKSTART.md`](QUICKSTART.md) (a working board view in under an hour),
and come back here for the details. Every Bines deployment also serves this guide at **`/api/docs/extensions`** and
the tutorial at **`/api/docs/extensions/quickstart`** (linked from Administration → Extensions → For developers).

Everything in this guide is taken from the code: the manifest schema
(`packages/shared/src/extensions/manifest.ts`), the page SDK (`packages/ext-sdk/src/index.ts`), the server SDK
(`packages/ext-sdk/src/server.ts`), the token rules (`packages/shared/src/extensions/token.ts`) and the API module
(`apps/api/src/modules/extensions/`). When this guide and the code disagree, the code wins — please report it.

Related documents: [`docs/EXTENSIONS-GUIDE.md`](../EXTENSIONS-GUIDE.md) (a shorter overview; Hebrew: `EXTENSIONS-GUIDE.he.md`), [`docs/EXTENSIONS-SECURITY-REVIEW.md`](../EXTENSIONS-SECURITY-REVIEW.md) (the red-team
review of the extension platform), `docs/DECISIONS.md` D27 (design and decisions),
and the public REST API reference served by every Bines installation at **`/api/docs`**.

---

## Contents

1. [What an extension is](#1-what-an-extension-is)
2. [How it fits together](#2-how-it-fits-together)
3. [The manifest](#3-the-manifest)
4. [Surfaces (where your extension appears)](#4-surfaces-where-your-extension-appears)
5. [Permissions (scopes)](#5-permissions-scopes)
6. [Sandbox, CSP and origins](#6-sandbox-csp-and-origins)
7. [The page SDK — `@bines/ext-sdk`](#7-the-page-sdk--binesext-sdk)
8. [Calling the REST API](#8-calling-the-rest-api)
9. [Tokens and credentials](#9-tokens-and-credentials)
10. [Automation blocks (actions and triggers)](#10-automation-blocks-actions-and-triggers)
11. [Your own server — `@bines/ext-sdk/server`](#11-your-own-server--binesext-sdkserver)
12. [Data packs (no code)](#12-data-packs-no-code)
13. [Local development and testing](#13-local-development-and-testing)
14. [Packaging and hosting](#14-packaging-and-hosting)
15. [Distribution: private install and the catalog](#15-distribution-private-install-and-the-catalog)
16. [Versions and updates](#16-versions-and-updates)
17. [Security rules](#17-security-rules)
18. [Limits](#18-limits)
19. [Troubleshooting](#19-troubleshooting)
20. [Where things live in the repository](#20-where-things-live-in-the-repository)

---

## 1. What an extension is

An extension adds something to Bines OS **without changing its core**. One extension = one **manifest** (a JSON file)
that may contain several **features** and/or a **data pack**:

| Kind | What it contains | What runs |
|---|---|---|
| **Data pack** | board templates, a starter kit (workspace + folders + boards), automation recipes, automation templates, AI agent templates | nothing — only data the platform already knows how to load |
| **Code extension** | pages shown inside Bines (board view, item tab, menu/batch action, dashboard widget, settings page), automation actions/triggers, and optionally its own server | **your** code, on **your** origin. Pages run in a sandboxed iframe; automation calls go to your HTTPS endpoint. Your code never runs inside the Bines server or the Bines page. |

You host the code. Bines frames your pages, hands them short-lived tokens, and sends your server signed HTTP calls.

## 2. How it fits together

```
 Bines web app (host)                              Your origin (https://ext.example.com)
 ┌───────────────────────────────┐                 ┌──────────────────────────────────┐
 │ board / item card / dashboard │  <iframe        │ index.html + @bines/ext-sdk      │
 │   ┌───────────────────────┐   │  sandbox> ───▶  │   bines.ready() → context        │
 │   │ AppFrame (host bridge)│◀──┼── postMessage ──┤   bines.api('GET', '/boards/…')  │
 │   └───────────────────────┘   │  (token, ctx)   └───────────────┬──────────────────┘
 └───────────────────────────────┘                                 │ fetch + Bearer bos_ext_…
                                                                   ▼
 Bines REST API  /api/v1  ◀────────────────────────────────────────┘
        │  signed POST (automation action, lifecycle)     ┌──────────────────────────────┐
        └────────────────────────────────────────────────▶│ your server (optional)       │
           ◀── signed POST /automations/triggers/…/fire ──│ @bines/ext-sdk/server        │
           ◀── OAuth client_credentials → bos_xat_ token ─│                              │
                                                          └──────────────────────────────┘
```

- **Installation** is per account and only by an **account admin**, through a consent screen that lists, in plain
  words, every feature and permission the manifest asks for. The admin may grant fewer scopes, limit the extension to
  some boards, and decide whether guests may use it (off by default).
- **Identity**: a page acts **as the user who opens it** — never more than that user may do, never more than the
  scopes the admin granted, and only on the board (or dashboard boards) it is shown on. A server acts as the
  extension's **service user**, with the same scope and board limits.
- **Audit**: every write is recorded as "via extension X" and can be undone like any other change.
- **Kill switches**: disabling, uninstalling, narrowing the grant, or the platform owner's emergency switch take
  effect on the very next request.

## 3. The manifest

Schema: `extensionManifestSchema` in `packages/shared/src/extensions/manifest.ts`. The same schema validates on the
server (install, update), in the consent screen and in the developer tab.

```json
{
  "manifest_version": 1,
  "id": "deal-board",
  "name": "לוח עסקאות",
  "name_en": "Deal board",
  "description": "תצוגת לוח לעסקאות",
  "description_en": "A board view for deals",
  "version": "1.2.0",
  "icon": "💼",
  "publisher": { "name": "Acme Ltd", "email": "dev@acme.example", "url": "https://acme.example" },
  "permissions": ["boards:read", "items:write"],
  "origins": ["https://ext.acme.example"],
  "features": [
    { "type": "board_view", "key": "main", "name": "עסקאות", "name_en": "Deals", "url": "https://ext.acme.example/index.html" }
  ],
  "server": { "lifecycle_url": "https://ext.acme.example/bines/lifecycle" }
}
```

### Top-level fields

| Field | Required | Rules |
|---|---|---|
| `manifest_version` | yes | must be `1` |
| `id` | yes | `^[a-z][a-z0-9-]{1,47}$`, not `empty`/`default`. **Stable forever** — it is the extension's key in every account and the prefix of its automation blocks |
| `name`, `name_en` | `name` yes | 1–80 chars, no control or bidi-override characters (`text_control_chars`) |
| `description`, `description_en` | no | up to 1000 chars |
| `version` | yes | semver `1.2.3` (optional `-pre` / `+build`) |
| `icon` | no | one emoji or a short mark (≤ 8 chars) |
| `publisher` | yes | `{ name (≤120), email?, url? }` |
| `permissions` | no | scopes from §5, no duplicates. Default `[]` |
| `origins` | required when there are `features` or a `server` | up to 5 plain origins (`https://host[:port]`, no path, no wildcard). `http://localhost`, `127.0.0.1`, `[::1]` and `*.localhost` are accepted **only by a non-production Bines**. Never the Bines origin itself |
| `features` | no | up to 20 (§4). Each `key` is `^[a-z][a-z0-9_-]{0,39}$` and unique; every `url` must be on one of `origins` |
| `server` | no | `{ lifecycle_url }` on one of `origins` (§11) |
| `data` | no | a data pack (§12) |

A manifest with no features, no data and no server is refused (`manifest_empty`). Validation errors come back as
`path: message` lines (e.g. `features.0.url: feature_origin_not_listed`).

## 4. Surfaces (where your extension appears)

Every **framed** feature has `key`, `name`, `name_en?`, `url`, `description?`. The page receives an `ExtContext`
(§7.2); the fields that are filled depend on the surface:

| `type` | Where it appears | Extra manifest fields | Context the page gets | Token reaches |
|---|---|---|---|---|
| `board_view` | a tab under the board's "+ view" | — | `board_id` | that board |
| `item_view` | a tab in the item card | — | `board_id`, `item_id` | that item's board |
| `board_menu_action` | the board ⋯ menu and/or the item menu; opens in a modal | `contexts`: `["board"]`, `["item"]` or both (default both); `modal: { width 320–1200 (560), height 160–900 (420) }` | `board_id`, `item_id` (from an item), `selection.item_ids`, `modal: true` | that board |
| `batch_action` | the batch bar when items are selected; opens in a modal | `modal` as above | `board_id`, `selection.item_ids`, `modal: true` | that board |
| `dashboard_widget` | a widget in a dashboard | `default_size: { w 2–12, h 1–12 }` (default 4×3) | `board_id: ''`, `board_ids`, `dashboard_id`, `widget_id` | only the dashboard's boards **the viewer may see** |
| `account_settings_page` | Administration → Extensions → your extension (admins only) | — | `board_id: ''` | no board content |
| `user_settings_page` | Each member's profile → "My connections" (every member) | — | `board_id: ''` | no board content; the token names the member |
| `panel` | its own narrow page `/a/<account>/x/<installation>/panel`: your page in a strip on top, the app's own item card under it (open one with `execute('openItemCard', { itemId })`). Framed only by origins the platform owner allowed (owner console → allowed embedding origins), e.g. a browser side panel | — | `board_id: ''`, `board_ids`, `item_id` (the open card), `params` (what the embedding site handed over, updated live) | the installation's boards **this person reads** |
| `app_page` | A full page in the app's sidebar (every member the installation reaches), at `/a/<account>/apps/<extension id>/<key>`, with an optional count beside it (§4.1); `openItemCard` opens the app's item card over the page | `icon?`: one of the app's icons (below) | `board_id: ''`, `board_ids` | the installation's boards **this person reads** (as a `panel`); the token names the member |

Two **server** features are not framed (§10):

| `type` | What it is | Fields |
|---|---|---|
| `automation_action` | "…then *name*" in the automation builder; Bines POSTs a signed call to `url` | `key`, `name`, `name_en?`, `url`, `description?`, `inputs` (≤ 20 form fields) |
| `automation_trigger` | "when *name*"; your server fires it | `key`, `name`, `name_en?`, `description?`, `payload_fields` (≤ 30 `{key, label}` hints), `inputs` (≤ 10 `{key, label, label_en?, type: 'text', placeholder?}` — set per automation, §10.2) |

An automation action's form fields (`inputs[]`): `key` (`^[a-z][a-z0-9_]{0,31}$`), `label`, `label_en?`,
`type` (`text` | `template` | `number` | `boolean` | `select` | `column`), `required` (default false),
`options` (for `select`, ≤ 50 `{value, label}`), `column_types` (for `column`), `placeholder`. `template` fields accept
`{item.…}` variables that are rendered for the item when the automation runs.

Extensions cannot render custom column types (cells); a column type is part of the core registry.

### 4.1 A page in the sidebar (`app_page`) and its count

```json
{ "type": "app_page", "key": "inbox", "name": "שיחות", "name_en": "Conversations", "url": "https://ext.example.com/inbox", "icon": "chat" }
```

- The entry sits with the app's destinations — in the full sidebar, the collapsed rail (name as tooltip and for screen
  readers), the top bar and the phone's menu. Each person (or the admin, for everyone) can move it to the top bar or
  hide it, like any destination (Profile → Appearance / Administration → Look and navigation).
- Its frame fills the page panel. Guests see it only where the admin allowed guests for the installation.
- **Items** (e.g. the item a conversation is linked to): its page token reads and writes on the installation's
  top-level boards **this member reads** (`context.board_ids`, at most 200) — the same boards as a `panel` — with the
  member's own rights and within the granted scopes: `GET /boards/{id}` (columns), `GET`/`PATCH /items/{id}`,
  `PUT /items/{id}/cells/{column}`, `POST /boards/{id}/items`… Any other board is `404`; a viewer's writes are `403`.
  Each write is recorded as the member "via" your app (one batch per request, undoable). The profile page
  (`user_settings_page`) still reads no board.
- `execute('openItemCard', { itemId })` opens the app's own item card **over** the page (a drawer; full screen on a
  phone) — the member stays on your page, and closing the card returns to it.
- `icon` names one of the app's drawings: `chat`, `inbox`, `mail`, `send`, `bell`, `calendar`, `clock`, `chart`,
  `dashboard`, `table`, `kanban`, `timeline`, `board`, `doc`, `file`, `folder`, `book`, `people`, `person`, `building`,
  `map`, `place`, `star`, `heart`, `bolt`, `flow`, `sparkle`, `image`, `mic`, `ext`. An unknown name shows the generic
  extension icon.
- **The count** (e.g. unread conversations): `PUT /ext/app-pages/{key}/badge` with `{ "count": 3 }`
  (`0`–1,000,000; `null` removes it).
  - Your **server** token sets the account's count (everyone sees it), or one member's with `"user_id"` (wins over the
    account's for that member; an unknown or inactive member is `404`).
  - A **page** token (or `bines.setBadge(n)` from the page) sets only the count of the member on the page.
  - Only keys of your own `app_page`s (anything else is `404`); never another extension's. 600 changes/min per
    installation.
  - Open apps update at once (no polling). The app shows "99+" above 99, puts the exact count in the link's accessible
    name ("Conversations, 3 unread") and announces it politely when it goes up.

## 5. Permissions (scopes)

`permissions` uses the API token scopes, **minus `admin` and `secrets:read`** (`EXTENSION_SCOPES`). Ask for the
minimum — every scope is shown to the admin, who may grant fewer (handle `403 insufficient_scope`).

| Scope | Allows (within the user's own rights and the granted boards) |
|---|---|
| `boards:read` | read boards, columns, groups and items (also implied by `boards:write` and `items:write`) |
| `boards:write` | change board structure (columns, groups, views) |
| `items:write` | create, change, move and delete items and cells; upload files (`files.upload`) |
| `updates:read` / `updates:write` | read / post item updates (comments) |
| `users:read` | read the account's member list and the current user (`users:write` and `teams:write` exist as scopes but **people and teams are read-only for extensions** — see below) |
| `automations:read` / `automations:write` | listed for completeness; automation paths are **not** reachable with an extension token |
| `agents:read` / `agents:run` / `agents:write` | listed for completeness; AI and agent paths are **not** reachable with an extension token |
| `webhooks`, `notifications:read` / `notifications:write`, `search` | `search` reaches `/search`; the others are outside the extension path allowlist |

On top of scopes, an extension token may only call an **allowlist of paths** (`extensionPathAllowed`):
`/auth/me`, `/boards/…`, `/items/…`, `/updates/…`, `/users` and `/users/me` (read only), `/teams/…` (read only),
`/search/…`, `/tags/…`, and its own `/ext/storage/…` and `/ext/files`. Even inside `/boards/:id/…` it can **never**
reach `permissions`, `members`, `teams`, `invite`, `claim`, `webhooks`, `automations`, `ai-columns`, `export`,
`save-as-template`, `template-draft` or a column's `restriction`, and a `PATCH /boards/:id` may not change `kind`,
`permission_set` or `workspace_id`. Anything else answers `403 not_for_extensions`. In short: an extension works with
**board content**, never with who can see it, account administration, tokens, AI or the owner console.

## 6. Sandbox, CSP and origins

What the host does (`apps/web/src/features/extensions/AppFrame.tsx`):

- Your page is framed with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"`,
  `referrerpolicy="no-referrer"` and `allow=""` (no camera, microphone, geolocation …). `allow-same-origin` gives the
  page **its own** origin only — never the Bines origin, cookies, storage or DOM. No top navigation.
- The Bines page's CSP `frame-src` lists only the origins of extensions **enabled in that account**; Bines' CORS lets
  those origins call the API **with an extension token only, never with cookies**.
- Messages are accepted only from your frame's window **and** your origin, speaking protocol `bines-ext` v1.

What you must do on your side:

- Serve pages over **HTTPS** (TLS 1.2+, HSTS) from the origins listed in the manifest.
- Send `Content-Security-Policy: frame-ancestors <your Bines origin>` so nobody else can frame you. A strict CSP for
  your page is recommended, e.g. `default-src 'self'; script-src 'self'; connect-src <your Bines origin>;
  frame-ancestors <your Bines origin>` (this is what the first-party sample extensions ship — see
  `extensions/catalog/build.mjs`).
- Pin the host: `createBinesSdk({ hostOrigin: 'https://bines.example.com' })`. Without it the SDK trusts whichever
  parent introduces itself first — fine in development, not in production.

## 7. The page SDK — `@bines/ext-sdk`

Source: `packages/ext-sdk/src/index.ts` (MIT, dependency-free, erasable TypeScript). Exported: `createBinesSdk`,
`BinesApiError`, `PROTOCOL` (`'bines-ext'`), `PROTOCOL_VERSION` (`1`) and the types `BinesSdk`, `SdkOptions`,
`ExtContext`, `ExtToken`, `ExtSurface`, `HostAction`, `StorageScope`, `NotifyTone`, `UploadedFile`, `HostMessage`,
`FrameMessage`.

### 7.1 Creating the SDK

```ts
import { createBinesSdk } from '@bines/ext-sdk';

const bines = createBinesSdk({ hostOrigin: 'https://bines.example.com' });
```

```ts
type SdkOptions = {
  hostOrigin?: string;   // pin the host origin (recommended in production)
  timeoutMs?: number;    // how long to wait for a host reply (default 10 000 ms; openModal waits until closed)
  window?: Window;       // for tests
  fetch?: typeof fetch;  // for tests
};
```

Create it **once**, as early as possible: it posts `ready` to the parent immediately and the host answers with `init`
(the context and the first token).

### 7.2 Context

```ts
type ExtContext = {
  account_id: string;
  board_id: string;                 // '' on a dashboard widget or a settings page
  installation_id: string;
  extension_key: string;
  feature: string;                  // the feature key from your manifest
  user: { id: string; name: string };
  theme: 'light' | 'dark';
  locale: 'he' | 'en';
  dir: 'rtl' | 'ltr';
  surface?: ExtSurface;             // older hosts omit it (= a board view)
  item_id?: string | null;          // item tab, or a menu action from an item
  selection?: { item_ids: string[] }; // menu / batch action
  board_ids?: string[];             // dashboard widget / board view / panel / app page: the boards its token reads
  dashboard_id?: string | null;
  widget_id?: string | null;
  modal?: boolean;                  // shown in a modal frame
  params?: Record<string, unknown> | null; // what openModal({ params }) passed
};
```

Bines is bilingual and right-to-left in Hebrew: apply `dir`, `locale` and `theme` to your document and follow changes.

### 7.3 API reference (`BinesSdk`)

| Member | Signature | Notes |
|---|---|---|
| `ready` | `() => Promise<ExtContext>` | resolves once the host introduced itself |
| `get` | `(what: 'context') => Promise<ExtContext>` | the current context |
| `listen` | `(event: 'context', cb: (ctx: ExtContext) => void) => () => void` | called on `init` and whenever the context changes (theme, locale …); returns an unsubscribe function. `'context'` is the only event |
| `api` | `<T = unknown>(method: string, path: string, opts?: { query?: Record<string, string>; body?: unknown }) => Promise<T>` | a REST call relative to `/api/v1` with the extension token (§8). JSON in, JSON out. Retries once with a fresh token on `401`. Throws `BinesApiError` |
| `items` | `<T = unknown>() => Promise<T>` | shorthand for `GET /boards/{board_id}/items` → `{ data: Item[] }` |
| `selection` | `() => Promise<string[]>` | the items the page is about: a batch selection, else the item of an item tab / item menu, else `[]` |
| `notify` | `(text: string, opts?: { tone?: 'info' \| 'success' \| 'error' }) => Promise<void>` | a toast "*extension name*: *text*" (≤ 200 chars, at most 3 per 10 s per frame) |
| `openModal` | `(opts?: { path?: string; width?: number; height?: number; params?: Record<string, unknown> }) => Promise<unknown>` | opens another page of **your** extension (same origin; `path` relative to the current page) in a modal over the app. Resolves with what that page passes to `closeModal(result)`, or `undefined` if the user closed it. One modal at a time; not from inside a modal (`modal_open`). Size clamped to 320–1200 × 160–900 |
| `closeModal` | `(result?: unknown) => Promise<void>` | inside a modal frame: closes it and hands `result` (JSON-safe) to the opener |
| `storage.get` | `<T = unknown>(key: string, opts?: { scope?: 'installation' \| 'user' }) => Promise<T \| null>` | `null` when missing |
| `storage.set` | `(key: string, value: unknown, opts?: { scope? }) => Promise<void>` | any JSON value |
| `storage.delete` | `(key: string, opts?: { scope? }) => Promise<void>` | |
| `storage.list` | `(opts?: { scope?; prefix?: string }) => Promise<{ key: string; size: number }[]>` | |
| `files.upload` | `(file: Blob, opts?: { name?: string; item_id?: string; column_id?: string }) => Promise<UploadedFile>` | ≤ 4 MB, needs `items:write`, uploads as the user; with `item_id` + `column_id` it is also attached to that file cell. `UploadedFile = { id, name, size, mime }` |
| `openWindow` | `(path: string, opts?: { width?: number; height?: number }) => Promise<void>` | opens a page of **your** extension (same origin; `path` relative to the current page) in a new **top-level** window, with no opener — for a sign-in such as Google's, which refuses to load in a sandboxed window. Call it from the user's click. The page gets no handle: have your server tell it how the sign-in ended. Size clamped to 320–1200 × 320–1000 |
| `execute` | `(action: 'resize' \| 'notice' \| 'notify' \| 'openItemCard' \| 'openModal' \| 'closeModal' \| 'openAutomationBuilder' \| 'setAutomationActive', payload?: unknown) => Promise<unknown>` | the raw host actions. The one you need directly: `execute('openItemCard', { itemId })` opens an item card (with the user's own rights) |
| `autoResize` | `() => () => void` | keeps the frame as tall as your page (`ResizeObserver` → `resize`); returns a stop function. Not needed for widgets, which fill their tile |
| `setBadge` | `(count: number \| null, opts?: { key?: string }) => Promise<void>` | the count beside one of your sidebar pages (`app_page`, default: this page's key) — **this member's own** only; `null` removes it (§4.1) |
| `openAutomationBuilder` | `(opts: { trigger: string; config?: { with_item?: boolean; inputs?: Record<string, string> }; board_id?: string }) => Promise<{ saved: boolean; automation_id?: string }>` | opens the app's own automation builder in a dialog over your page, the trigger already set to one of **your own** `automation_trigger` keys (`with_item`: the trigger brings an item; `inputs`: values of the trigger's `inputs`, prefilled and locked — §10.2; another key is `bad_input`). `board_id`: one of the boards your token reads (`context.board_ids`; default: the frame's board). The member's own rights apply: who may not manage that board's automations gets the app's refusal (`forbidden`, and a toast). Call it on the user's click; one at a time, not from a modal (`modal_open`). Resolves when the dialog closes. Other errors: `bad_trigger` (not your trigger, or not on that board), `bad_board` |
| `automations` | `(trigger: string) => Promise<ExtAutomation[]>` | `GET /ext/automations?trigger=` — the automations that use one of **your own** triggers, on the boards your token reads that this member reads: `{ id, board_id, name, active, trigger }` (e.g. which of your buttons has a live automation). Read only, a page token only; editing one stays in the app |
| `setAutomationActive` | `(automationId: string, active: boolean) => Promise<{ active: boolean }>` | switches on / off an automation whose trigger is **your own**, on a board your token reads — through the app, with the member's session and rights (without `automation.manage` on that board: `forbidden` and the app's toast). Errors: `bad_automation` (not found, or not on your trigger), `bad_board` |
| `token` | `() => Promise<ExtToken>` | the page's current token (renewed when under a minute is left), to hand to **your own server** in a header — it asks Bines who it is with `POST /ext/introspect` (§11.2a). Never put it in a URL or storage |

Storage scopes: `user` (the default) is per installation × user; `installation` is shared by all users of the
installation in that account. Keys match `^[A-Za-z0-9._:-]{1,200}$`.

Errors: REST failures throw `BinesApiError { status: number; code: string; message: string }` (the API's
`error.code`, e.g. `insufficient_scope`, `not_for_extensions`, `not_found`). Host actions reject with an `Error` whose
message is the host's code (`bad_item`, `bad_path`, `modal_open`, `not_modal`, `bad_trigger`, `bad_board`, `bad_automation`, `forbidden`,
`unknown_action`, `host_timeout`).

### 7.4 The postMessage protocol (if you do not use the SDK)

The SDK is the supported way. For reference: the frame posts `{ protocol: 'bines-ext', v: 1, type: 'ready' }`; the
host answers `{ …, type: 'init', context, token }`, later `{ …, type: 'context', context }`; the frame sends
`{ …, type: 'request', id, action, payload }` with `action` ∈ `token | resize | notice | notify | openItemCard |
openModal | closeModal | openWindow | pickBoards | setBadge | openAutomationBuilder | setAutomationActive` and gets `{ …, type: 'reply', id, ok, result?, error? }`. The token is **never** in a URL.

## 8. Calling the REST API

- Base: `<Bines origin>/api/v1` (the token's `api_base`). Full reference: `<Bines origin>/api/docs` (OpenAPI at
  `/api/v1/openapi.json`).
- Headers: `Authorization: Bearer <token>`, `X-Account-Id: <account_id>` (the SDK adds both),
  `Content-Type: application/json` for bodies. Requests carry **no cookies** (`credentials: 'omit'`).
- Errors are JSON `{ "error": { "code": "…", "message": "…" } }`.

Common calls from a page (`bines.api` adds the base and headers):

```ts
const { data: items } = await bines.api<{ data: Item[] }>('GET', `/boards/${ctx.board_id}/items`);
await bines.api('PATCH', `/items/${itemId}`, { body: { name: 'New name' } });          // items:write
await bines.api('POST', `/items/${itemId}/updates`, { body: { body: 'Called the client' } }); // updates:write
const me = await bines.api('GET', '/auth/me');
```

`GET /boards/{id}/items` returns every item of the board with its `cells` keyed by column id (`PATCH /items/{id}` takes `{ name?, cells? }`). For large boards,
query with `POST /boards/{id}/items/query` (see `/api/docs`). Cell value shapes per column type are documented in the
API reference.

Rate limits per extension token: **600 requests/min per installation** and **240/min per user**; `429` carries
`retry_after_ms`. Server tokens: 600/min per installation.

## 9. Tokens and credentials

| Prefix | What | Lifetime | Who gets it |
|---|---|---|---|
| `bos_ext_` | page / automation-call token: one user × one installation × one board × one feature | **10 minutes** | your page, by postMessage (the SDK renews it a minute before expiry); your automation action endpoint, inside the call body |
| `bos_extc_` / `bos_exts_` | OAuth client id / client secret of an installation | until reconnect / uninstall | your server, in the `installed` lifecycle call |
| `bos_extw_` | the installation's signing secret (HMAC for every signed call) | until rotated / reconnect | your server (`installed`), or copied by an admin from Administration → Extensions → the extension (for extensions with automation blocks but no `server`) |
| `bos_xat_` | server access token (`client_credentials`) — acts as the extension's service user | **1 hour** | your server, from `POST /oauth/token` |

Every `bos_ext_` / `bos_xat_` request is checked against the installation **as it is now** (enabled, not killed,
granted scopes and boards). Keep tokens in memory; never log them, never put them in a URL, `localStorage` or a cookie.

## 10. Automation blocks (actions and triggers)

Admins build automations in the UI; your blocks appear in the builder as sentences. A block is named
`<extension id>.<feature key>` (e.g. `crm-sync.send_sms`).

### 10.1 Automation action — Bines calls you

When the automation runs, Bines sends `POST <feature.url>` (through an SSRF-guarded client: public addresses only in
production, no redirects, **30 s timeout**, response read up to 8 KB):

Headers:

```
content-type: application/json
user-agent: BinesOS-Extensions/1
x-bines-delivery: <run_id>:<action_index>
x-bines-installation: <installation id>
x-bines-attempt: 1 | 2 | 3
x-bines-timestamp: <ms since epoch>
x-bines-signature: sha256=<hex HMAC-SHA256(signing_secret, "<timestamp>.<raw body>")>
```

Body:

```json
{
  "type": "automation_action",
  "block": "crm-sync.send_sms",
  "delivery_id": "<run_id>:<action_index>",
  "installation_id": "…", "account_id": "…", "automation_id": "…", "run_id": "…",
  "board": { "id": "…", "name": "Leads" },
  "item": { "id": "…", "name": "…", "url": "https://…" },
  "input": { "message": "Hi {item.name} → rendered text" },
  "trigger_time": "2026-10-08T10:00:00.000Z",
  "attempt": 1,
  "token": { "token": "bos_ext_…", "expires_at": "…", "api_base": "https://…/api/v1", "scopes": ["boards:read"] }
}
```

- Verify the signature over the **raw** body, the timestamp (± 5 minutes) and replays — `verifyBinesSignature` does
  all three (§11.3). Read the body as text **before** parsing it.
- Use `token` to write back (e.g. an update on the item). It acts as the automation's owner on that board; writes are
  "via extension X", undoable, and part of the automation chain (loop guard).
- Answer `2xx` quickly. Optional result: `{ "output": { … } }` (an object) is stored in the run log.
- Retries: `5xx`, `408`, `429`, timeouts and network errors are retried — at most **3 attempts**, after 30 s and 2 min.
  Other `4xx` are final. Use `delivery_id` to make your handler idempotent. Every outcome appears in the automation's
  run history. The builder's "test" dry run never calls you.

### 10.2 Automation trigger — you call Bines

```ts
import { fireBinesTrigger } from '@bines/ext-sdk/server';

await fireBinesTrigger({
  appOrigin: 'https://bines.example.com',
  installationId,                 // from `installed` or the admin screen
  secret: signingSecret,          // bos_extw_…
  block: 'crm-sync.new_lead',     // <extension id>.<trigger key>
  payload: { phone: '050…', source: 'web' },   // becomes {payload.*} in the automation
  boardId,                        // optional: only this board
  itemId,                         // optional: the item the automation runs on (must be on that board)
});
```

This is a signed `POST <app>/api/v1/automations/triggers/<block>/fire` with `x-bines-installation`,
`x-bines-timestamp`, `x-bines-signature` and body `{ payload, board_id?, item_id? }`. Every active automation that
listens to the trigger on the installation's boards hears it. Limits: 120 accepted fires/min per installation; repeated
signature failures from one address are blocked for a while.

**Trigger inputs (one trigger, many automations).** A trigger may declare `inputs`, e.g.
`[{ "key": "button", "label": "Button" }]`. Each automation stores its own values (`trigger.inputs`, e.g.
`{ "button": "b-7" }`): the builder shows them as fields, and `openAutomationBuilder({ trigger, config: { inputs } })`
prefills and locks them. A fire then runs only the automations whose stored values equal the same keys of its
`payload` (`payload.button === "b-7"`, compared as text). An automation without values (or with empty ones) runs for
every fire, as before. Only the trigger's own input keys may be stored (`extension_input_unknown`).

## 11. Your own server — `@bines/ext-sdk/server`

Add `"server": { "lifecycle_url": "https://…" }` to the manifest when you need to act **without** a user opening a
page (sync jobs, webhooks from other systems). On install the extension gets a **service user** (a member of the
account, never a person) and **OAuth client credentials**.

Source: `packages/ext-sdk/src/server.ts` (Web Crypto + fetch only: Node 20+, Deno, Bun, Workers). Never import it in a
page.

### 11.1 Lifecycle calls

`POST <lifecycle_url>`, JSON, timeout 10 s, headers:

```
x-bines-event:     extension.installed | extension.updated | extension.enabled | extension.disabled | extension.uninstalled
x-bines-delivery:  <id>
x-bines-timestamp: <ms since epoch>
x-bines-signature: sha256=<hex HMAC-SHA256(signing_secret, "<timestamp>.<raw body>")>
```

Body (`LifecycleEvent`):

```ts
type LifecycleEvent = {
  event: 'installed' | 'updated' | 'enabled' | 'disabled' | 'uninstalled';
  delivery_id: string;
  sent_at: string;
  platform: string;                       // the Bines origin
  account: { id: string; name?: string; slug?: string };
  installation: { id: string; key: string; version: string; previous_version?: string; status: string;
                  scopes: string[]; board_ids: string[] | null;
                  workspace_ids: string[] | null };                  // both null = every board; else their union
  reason?: string;                        // e.g. 'platform_kill' (the platform owner's emergency switch)
  credentials?: ServerCredentials;        // only in `installed`
};
type ServerCredentials = { client_id: string; client_secret: string; signing_secret: string;
                           token_endpoint: string; api_base: string };
```

- `installed` carries the credentials and is signed with the signing secret **it carries** — anyone could forge one.
  Accept it only with `trustInstalled: true` **and** `platform: '<your Bines origin>'` (the SDK then requires
  `platform`, `token_endpoint` and `api_base` to be that origin), and prove the credentials by trading them for a
  token before you trust them. Store them in a secret store, per installation.
- Every later call is signed with the saved signing secret.
- After `uninstalled` the credentials and every token are dead — delete what you stored.
- A failed call is shown to the admin, who can press **Reconnect** (new credentials, a fresh `installed`).

### 11.2 OAuth `client_credentials`

```sh
curl -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://bines.example.com/oauth/token
# {"access_token":"bos_xat_…","token_type":"Bearer","expires_in":3600,"scope":"boards:read",
#  "installation_id":"…","account_id":"…","api_base":"https://bines.example.com/api/v1"}
```

`scope=` may narrow the token (asking for a scope that was not granted → `invalid_scope`). The token acts as the
service user × granted scopes × granted boards × the same path allowlist (§5).

### 11.2a Who is on your page, and hearing about changes

- **`POST /ext/introspect`** (server token only), body `{ "token": "<a page token>" }`. Your page (e.g. a
  `user_settings_page` where a member connects an outside account) hands its token (`bines.token()`) to your server; the answer says
  who it belongs to: `{ active, user: { id, name, email }, account_id, feature, expires_at }`. A token of another
  installation, an expired one or a bad one is `{ active: false }`.
- **Webhooks of your own** (server token, `webhooks` scope): `POST /boards/{id}/webhooks` on a board you were granted,
  to a URL on one of your manifest's `origins` only (the handshake applies as usual). You list, change and delete only
  the webhooks your server made; uninstalling turns them off.

### 11.3 Server SDK reference

| Export | Signature |
|---|---|
| `verifyLifecycle` | `(opts: { secret?: string \| null; headers: Headers \| Record<string, string \| string[] \| undefined>; body: string; maxAgeMs?: number; trustInstalled?: boolean; platform?: string; now?: number }) => Promise<LifecycleEvent>` — throws `LifecycleSignatureError` |
| `createServerClient` | `(creds: { client_id; client_secret; token_endpoint; api_base }, opts?: { fetch?: typeof fetch }) => ServerClient` — refuses credentials whose `token_endpoint` and `api_base` are on different origins |
| `ServerClient.token` | `() => Promise<string>` — fetched and renewed a minute before expiry |
| `ServerClient.api` | `<T = unknown>(method: string, path: string, body?: unknown) => Promise<T>` — retries once on `401`; throws `BinesServerError { status, code }` |
| `verifyBinesSignature` | `(p: { secret: string; timestamp: string \| null \| undefined; signature: string \| null \| undefined; body: string; now?: number; toleranceSeconds?: number; seen?: { has(sig): boolean; add(sig): unknown } }) => Promise<'ok' \| 'missing' \| 'stale' \| 'bad_signature' \| 'replay'>` |
| `fireBinesTrigger` | `(p: { appOrigin; installationId; secret; block; payload: Record<string, unknown>; boardId?; itemId?; fetch?; now? }) => Promise<Response>` |
| `signBinesBody` / `signLifecycle` | `(secret: string, timestamp: string, body: string) => Promise<string>` → `sha256=<hex>` |
| `SIGNATURE_TOLERANCE_SECONDS` | `300` |
| `setAppPageBadge` | `(client: ServerClient, key: string, count: number \| null, opts?: { userId?: string }) => Promise<{ key; count; user_id }>` — the count beside your sidebar page: the account's, or one member's (§4.1) |

```ts
import { createServerClient, verifyLifecycle } from '@bines/ext-sdk/server';

// rawBody: the request body as text, before JSON.parse
const event = await verifyLifecycle({
  secret: saved?.signing_secret,      // undefined for the first `installed`
  headers: req.headers,
  body: rawBody,
  trustInstalled: true,
  platform: 'https://bines.example.com',
});
if (event.event === 'installed') {
  const client = createServerClient(event.credentials!);
  await client.token();               // proves the credentials are real
  await secretStore.put(event.installation.id, event.credentials);
}
```

`create-bines-app --server` writes a dependency-free Node example of all this (`server/lifecycle.mjs`).

## 12. Data packs (no code)

A manifest with `data` and no features installs content the platform already understands:

| `data.` | Max | Shape |
|---|---|---|
| `board_templates` | 100 | the shape of `seed/templates/*.json` (`key`, `name`, columns, groups …), with `"format_version": 2` |
| `starter_kit` | 1 | `{ workspace_name?, folders[], boards: [{ template, folder? }], all_builtin_templates?: { except[] } }` |
| `automation_recipes` | 500 | `{ key, board (template key), title?, recipe: { trigger, conditions, actions } }` — loaded **inactive** |
| `automation_templates` | 200 | `{ key, name, description?, category?, recipe, slots[] }` — goes to the account's template library |
| `agent_templates` | 50 | the shape of `seed/agents/*.json` |

The easiest way to make one: build the boards and automations in Bines, then **Administration → Extensions → "Save
as pack"** (`POST /extensions/packs/export`; webhook secrets are never exported). Examples: `seed/packs/crm-starter.json`,
`seed/packs/bines-starter.json`.

## 13. Local development and testing

**Option A — a local Bines (full control).** Requires access to the Bines repository.

```sh
docker compose up -d && pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev   # Bines on http://localhost:5173
node packages/create-bines-app/index.mjs my-view --name "My view"                     # your extension
cd my-view && npm install && npm run dev                                              # http://localhost:5180
```

Then, signed in as an account admin: **Administration → Extensions → For developers → By address** →
`http://localhost:5180/manifest.json` → **Check** → approve. A development Bines accepts `localhost` origins and shows a
development-mode notice; a production Bines refuses them. See [`QUICKSTART.md`](QUICKSTART.md) for the whole walk-through.

**Option B — a real (production) Bines account where you are an admin.** Expose your dev server on a public HTTPS
address (any HTTPS tunnel), set that origin in the manifest, and add it by URL in the same "For developers" tab. It is
installed as a **private** extension of that account only.

**Reference extensions in the repo:**

- `extensions/summary-cards/` — `index.html`/`app.js` (a board view) and `kit.html`/`kit.js` (item tab, menu and batch
  actions, widget, settings page, automation action and trigger). `node extensions/summary-cards/serve.mjs` serves them
  on `http://127.0.0.1:3998` with `/manifest.json` and `/kit/manifest.json`; `/kit/run` shows a verified automation
  action that writes back with the call's token.
- `extensions/catalog/` — the two first-party catalog extensions (`board-summary`, a board view; `kanban-stats`, a
  dashboard widget using per-user storage) and `build.mjs`, which produces deployable static files with CSP headers.

**Unit tests.** `createBinesSdk({ window, fetch })` accepts a fake window and fetch, so you can drive the protocol in
tests (see `packages/ext-sdk/test/*.test.ts`). For servers, `verifyBinesSignature({ now })`, `signBinesBody` and
`createServerClient(…, { fetch })` make signed calls reproducible.

## 14. Packaging and hosting

1. `npm run build` → host `dist/` on your HTTPS origin (any static host).
2. Produce the production manifest: `node manifest.config.mjs https://ext.example.com [https://api.ext.example.com]`
   (printed on stderr) and host it (e.g. `https://ext.example.com/manifest.json`).
3. Pin `hostOrigin` in `createBinesSdk`, and set `frame-ancestors` (and ideally `connect-src`) to the Bines origin.
4. Your server (if any) on an origin listed in `origins`, HTTPS, answering lifecycle calls within 10 s.

There is no upload of extension code to Bines: the manifest URL **is** the package. (A manifest can also be pasted as
JSON in the "For developers" tab — useful for data packs.)

## 15. Distribution: private install and the catalog

| Level | Who | How |
|---|---|---|
| **Private** | any account admin | Administration → Extensions → For developers → add by URL or paste the JSON → consent screen. No review — the admin is responsible |
| **Platform catalog** ("Store" tab) | the **platform owner** of a Bines installation | Owner console → Extensions → "Publish to the catalog" by URL (or a pasted manifest). A code extension enters only with every review item ticked (below); data packs may skip it. Accounts still install it themselves, through the same consent screen |

To get into a catalog today, send the platform owner your manifest URL plus answers to the **review checklist**
(`REVIEW_CHECKS` in `packages/shared/src/extensions/server.ts`):

| Check | What the reviewer verifies |
|---|---|
| `https_only` | the manifest and every origin are HTTPS (TLS 1.2+) with HSTS |
| `least_scopes` | only the scopes it needs, each explained |
| `no_token_storage` | tokens only in memory, never logged; secrets in a secret store |
| `verifies_signatures` | every call from Bines: HMAC signature + timestamp + replay checked |
| `no_eval` | no `eval` of user content; platform content shown as text, never as HTML |
| `privacy_policy` | a privacy policy URL: where data goes, if anywhere |
| `platform_limits` | (platform side) rate limits, quota, timeouts, emergency switch, audit log are in place |

The platform owner can unpublish an entry (installed copies keep their version) and has an **emergency switch** that
turns an extension off in every account at once (tokens, frames and CORS).

## 16. Versions and updates

- Bines re-fetches your manifest **once a day** and when an admin presses "Check for update".
- Same or lower `version` → nothing happens. Bump `version` for every change you ship.
- A higher version that asks for **nothing new** → applied automatically, recorded in the version history, and your
  server gets `updated` (with `previous_version`).
- A higher version that adds a **scope**, an **origin**, a **feature** (by `type:key`) or a `server` → the installation
  stays on the approved version; admins get a notification and must approve the new one on the consent screen.
- Admins can turn automatic updates off, **lock** a version, and **roll back** to any approved version (which locks it).
- Design for both: a page must cope with a token that has fewer scopes than the manifest asks for.
- Never change `id` or a feature's `key` — a new key is a new feature (consent again), and automations reference
  blocks by `<id>.<key>`.
- The postMessage protocol is versioned (`v: 1`); new context fields are added as optional.

## 17. Security rules

Must-haves (also what the catalog review checks):

1. Show API data as **text** (`textContent`, attributes) — never `innerHTML` with platform content; no `eval`.
2. Tokens and secrets in memory or a server-side secret store only. Never in URLs, logs, `localStorage` or cookies.
3. Pin `hostOrigin`; send `frame-ancestors <Bines origin>`.
4. Verify every signed call: signature over the raw body, timestamp ± 5 min, replay (`seen` store). Accept `installed`
   only with `platform` pinned, and prove credentials by fetching a token.
5. Least privilege: ask for the fewest scopes; handle `403 insufficient_scope` and `404` on boards you were not
   granted.
6. Treat everything from users (item names, cells, updates, trigger payloads) as untrusted input in your own systems.
7. Make automation handlers idempotent by `delivery_id`; answer fast and do slow work asynchronously.
8. Publish a privacy policy saying where data goes.

## 18. Limits

| What | Limit |
|---|---|
| Features per manifest / origins | 20 / 5 |
| Page token lifetime | 10 min (auto-renewed by the SDK) |
| Server token lifetime | 1 h |
| API calls with page tokens | 600/min per installation, 240/min per user |
| API calls with server tokens | 600/min per installation |
| Storage value / quota / keys | 64 KB per value, 1 MB per installation (all users together), 1000 keys |
| File upload (`files.upload`) | 4 MB per file, 30 uploads/min |
| Messages from a frame to the host | 80 per 10 s per frame (extra ones are ignored) |
| Toasts (`notify`) | 3 per 10 s per frame, 200 chars |
| Sidebar page counts (`app_page`) | 0–1,000,000; 600 changes/min per installation |
| Modal size | 320–1200 × 160–900 px |
| Automation action call | 30 s timeout, 3 attempts (30 s, 2 min backoff), 8 KB response read |
| Trigger fires | 120/min per installation |
| Lifecycle call | 10 s timeout |
| Signature tolerance | ± 300 s |

## 19. Troubleshooting

| Symptom | Cause |
|---|---|
| `422 manifest_invalid` … `origins: … must be https` | a production Bines refuses `http://` and `localhost` origins |
| `feature_origin_not_listed` / `server_origin_not_listed` | the URL's origin is missing from `origins` |
| `origins_required` / `manifest_empty` | features or a server without origins / a manifest with nothing in it |
| `text_control_chars` | a name or description contains control or bidi-override characters |
| The frame is blank | your `frame-ancestors` does not include the Bines origin, or the URL is wrong |
| `ready()` never resolves | the page is not framed by Bines, or `hostOrigin` is pinned to a different origin than the Bines that frames it |
| `401` | the token expired (the SDK renews it) or the installation is disabled / uninstalled / killed |
| `403 insufficient_scope` | the admin did not grant that scope (or a new version awaits consent) |
| `403 not_for_extensions` | the path is outside the extension allowlist (§5), by design |
| `404` on a board or item | the board is not one the installation is allowed on, or the user cannot see it |
| `host_timeout` | the host did not answer within `timeoutMs` (default 10 s) |
| Lifecycle "failed" in the admin screen | your endpoint did not answer `2xx` within 10 s; fix it and press **Reconnect** |
| Automation run shows the action failed | see the run history: HTTP status, attempts and your error; `401` from you usually means a wrong signing secret |

## 20. Where things live in the repository

| Path | What |
|---|---|
| `packages/ext-sdk/` | `@bines/ext-sdk` (page) and `@bines/ext-sdk/server` — MIT |
| `packages/create-bines-app/` | the project scaffolder (Vite + SDK + manifest + optional server) — MIT |
| `packages/shared/src/extensions/` | manifest schema, token rules and path allowlist, server/catalog types |
| `apps/api/src/modules/extensions/` | install, consent, tokens, storage, automation blocks, lifecycle, catalog, kill switch |
| `apps/web/src/features/extensions/` | the host bridge (`AppFrame.tsx`, `frame-protocol.ts`), slots, admin and owner screens |
| `extensions/summary-cards/`, `extensions/catalog/` | reference extensions |
| `extensions/browser/` | a Chrome / Edge side panel that frames the `panel` surface (no data of its own) |
| `extensions/calendar-sync/` | a complete extension with its own server: two-way Google Calendar sync (member page + admin page, OAuth, webhooks, push) |
| `seed/packs/` | data-pack and catalog manifests |
| `apps/api/src/modules/apidocs/guide.ts` | the public API docs' guide pages (`/api/docs`) |
