# 10 — The extension layer (D27)

The architecture of extensions: the slots an extension can fill, the manifest, how extension pages are loaded and
authenticated, the client SDK, external automation blocks and versioning. For platform developers and for anyone who
wants to understand how extensions talk to the core. To _build_ an extension, start with the developer guide in
[`extensions/README.md`](extensions/README.md) and [`EXTENSIONS-GUIDE.md`](EXTENSIONS-GUIDE.md).

Where the code lives: `packages/shared/src/extensions/*` (manifest, API, token), `apps/api/src/modules/extensions/*`
(including `server-side.ts`, `updates.ts`, `catalog.ts`, `extensions-server.routes.ts`),
`apps/web/src/features/extensions/*`, `packages/ext-sdk` (`@bines/ext-sdk` and `@bines/ext-sdk/server`),
`packages/create-bines-app`. Outbound MCP servers (agents calling external MCP servers) are in
`apps/api/src/modules/mcp-servers`. Where this document and the code differ, the code and D27 in
[`DECISIONS.md`](DECISIONS.md) win.

**Ground rule:** `apps/*` and `packages/*` never import from `extensions/`. An extension talks to the core only
through the public API and the slots. Removing an extension leaves the core intact.

What exists:

- A manifest and installation with a consent screen; data packs (the starter kit is a pack in `seed/packs`); and
  pages in an iframe using `@bines/ext-sdk`.
- An extension server (`manifest.server.lifecycle_url`): an extension service user, OAuth client credentials
  (`client_credentials` at `/oauth/token`, a `bos_xat_` token valid for one hour), and signed lifecycle calls
  (installed / updated / enabled / disabled / uninstalled).
- A daily update check (`extensions.update_check`), automatic or manual updates, version pinning, history and
  rollback.
- The platform catalog, with a security review per listing in the owner console
  ([`EXTENSIONS-SECURITY-REVIEW.md`](EXTENSIONS-SECURITY-REVIEW.md)).

## 1. Slots

| Slot                                       | Where it appears                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Context passed                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `board_view`                               | A view tab on a board                                                                                                                                                                                                                                                                                                                                                                                                                                               | account, user, board, view, filters               |
| `item_view`                                | A tab in the item card                                                                                                                                                                                                                                                                                                                                                                                                                                              | + item                                            |
| `board_menu_action`                        | The item / board menu                                                                                                                                                                                                                                                                                                                                                                                                                                               | + target ids                                      |
| `batch_action`                             | The batch (multi-select) bar                                                                                                                                                                                                                                                                                                                                                                                                                                        | + selected item ids                               |
| `dashboard_widget`                         | A dashboard widget                                                                                                                                                                                                                                                                                                                                                                                                                                                  | + dashboard, size                                 |
| `account_settings_page`                    | Administration → Extensions → &lt;extension&gt;                                                                                                                                                                                                                                                                                                                                                                                                                     | account, user                                     |
| `user_settings_page`                       | Every user's profile → "My connections"                                                                                                                                                                                                                                                                                                                                                                                                                             | account, user                                     |
| `panel`                                    | A page of its own, `/a/<account>/x/<installation>/panel`: the extension's strip above the app's item card. Embeddable only in sites listed under "Addresses allowed to embed" in the owner console (for example a browser side panel)                                                                                                                                                                                                                              | account, user, params (from the embedder), item   |
| `app_page`                                 | A full page in the sidebar for all users, `/a/<account>/apps/<extension>/<key>`, with a badge counter next to its name. The extension's server sets the counter for the account or for one user (`PUT /ext/app-pages/<key>/badge`); the page sets only its own user's (`setBadge`). It can be moved to the top bar or hidden like any other destination. The page's token reads and writes the `panel` boards (the installation's top-level boards the user can see, with the user's permissions, "via the extension"), and `openItemCard` opens the app's item card above the page | account, user, board_ids                          |
| `automation_trigger` / `automation_action` | The automation registry (HTTP blocks, §5)                                                                                                                                                                                                                                                                                                                                                                                                                           | event payload / item snapshot + inputs            |

## 2. manifest.json

```json
{
  "id": "client-file-view",
  "name": "Client file",
  "version": "1.0.0",
  "scopes": ["boards:read", "items:read", "updates:read"],
  "features": [
    { "slot": "board_view", "url": "https://ext.example.com/client-file/", "boards": ["accounts"] },
    {
      "slot": "automation_action",
      "key": "send_whatsapp",
      "url": "https://tools.example.com/blocks/whatsapp",
      "inputs": [
        { "key": "phone_column", "type": "column", "columnTypes": ["phone"] },
        { "key": "message", "type": "template" }
      ]
    }
  ],
  "settings_schema": { "type": "object", "properties": { "api_key": { "type": "string", "secret": true } } }
}
```

(Illustrative.) Registration: Administration → Extensions → "Add extension" (a manifest URL or pasted JSON) → consent
screen. The full schema is in `packages/shared/src/extensions/manifest.ts` (`manifest_version`, `id`, `version`,
`publisher`, `permissions` = API-token scopes without `admin`, `origins`, `features`, `data`).
Tables (migration `0042_market`): `extensions` (the platform catalog when `account_id` is empty, or an account's
private manifest), `extension_installations` (the approved manifest, approved scopes and boards, guests,
`pending_manifest`, the pack's `state`), `extension_kills` (the platform owner's emergency kill switch).

## 3. Loading and authentication

- An iframe with `src = url` only (**no token in the URL**),
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"` (the extension's origin is
  always different from ours — checked at install — so `allow-same-origin` gives it only its own origin),
  `referrerpolicy=no-referrer`.
- The page sends `ready`; the host (`AppFrame`) issues a `bos_ext_…` token (HMAC, 10 minutes) per user × installation
  × board × capability and sends `init` with the context and the token by `postMessage`, to the extension's origin
  only; the token is renewed through a `token` request.
- The page calls `/api/v1` with the token as a Bearer (no cookies — CORS for extensions is without credentials, and a
  cookie alone from an extension origin is rejected). Permissions = the user's permissions × approved scopes × the
  board × an allowlist of paths (board content only). Every request is checked against the installation as it is now.
- `postMessage` is checked in both directions (`source` + origin). CSP: the account page's (`/a/<slug>/…`)
  `frame-src` = the origins of the extensions active in the account.
- Every write is recorded in `activity_log` with `meta.via='app'` and one batch per request — shown as "via extension
  X", with undo.

## 4. Client SDK (`packages/ext-sdk`, published as `@bines/ext-sdk`)

```ts
const bines = createBinesSdk();
const ctx = await bines.ready(); // { account_id, board_id, installation_id, user, theme, locale, dir, item_id?, … }
await bines.api('GET', `/boards/${ctx.board_id}/items`, { query });
await bines.execute('openItemCard', { itemId }); // also: notice, openModal, closeModal, openWindow, setBadge, …
bines.listen('context', cb);
await bines.storage.get('key', { scope: 'installation' }); // 'installation' (shared) | 'user' (default)
await bines.storage.set('key', value);
```

Also: `selection()`, `notify()`, `openModal()` / `closeModal()`, `openWindow()`, `setBadge()`, `files.upload()`,
`openAutomationBuilder()`, `automations()`, `setAutomationActive()`, `autoResize()`, `token()`. The full reference is
in [`extensions/README.md`](extensions/README.md).

## 5. External automation blocks

- A signing secret per installation (`extension_installations.signing_secret`, encrypted with `lib/secrets`); the
  admin sees and rotates it in Administration → Extensions. One secret and one signing method per installation
  (`ext-signing.ts`): the same secret signs automation calls, verifies triggers and signs lifecycle calls. For an
  extension with a `server`, the secret is issued together with the credentials and delivered in `installed`;
  rotating it also rotates the credentials and sends `installed` again. Uninstalling deletes it
  (`GET /extensions/installations/:id/secret`, `POST …/secret/rotate`, audited).
- `automation_action` (`run_extension`, `block = "<extension>.<feature>"`): a signed `POST url` —
  `X-Bines-Timestamp` (ms) + `X-Bines-Signature: sha256=HMAC(secret, "<ts>.<body>")` + `X-Bines-Installation` +
  `X-Bines-Attempt`; the body:
  `{type, block, delivery_id, installation_id, account_id, automation_id, run_id, board, item, input, trigger_time,
attempt, token}` — `input` = the manifest's `inputs` after template rendering; `token` = a short-lived extension
  token for the automation's board, on behalf of the automation's owner (writing back = "via extension X", inside the
  automation chain — it does not trigger itself; depth ≤5). Sent through `lib/outbound.ts` (SSRF protection, no
  redirects), 30 s timeout, up to 3 attempts (5xx / 408 / 429 / timeout; a 4xx is final) — retries are queued
  (`extension.call_retry`, 30 s → 2 min) and every result updates `automation_runs.actions_log`. A `200 {output}` is
  stored in the run log.
- `automation_trigger` (`extension_trigger`): the extension's server calls
  `POST /api/v1/automations/triggers/<extension>.<feature>/fire` `{board_id?, item_id?, payload}`, signed with the
  same secret (±5 minute window; a repeated signature is a replay and is rejected). The event
  `extension_trigger.fired` goes to every board of the installation with an active automation listening to it;
  `{payload.*}` is available in templates.
- Trigger fields: `automation_trigger.inputs` (up to 10, text). Each automation stores values in `trigger.inputs`
  (fields in the builder; `openAutomationBuilder({ config: { inputs } })` fills and locks them). Firing runs only the
  automations whose values equal the same keys in `payload` (as text). Without values — every firing runs it. A key
  the trigger does not declare is rejected on save (`extension_input_unknown`).
- The builder shows blocks by name (`GET /extensions/automation-blocks`) and builds the form from `inputs`; saving
  checks that the block is available on the board and the required fields are filled. On the extension side:
  `@bines/ext-sdk/server` (`verifyBinesSignature`, `fireBinesTrigger`).

### 5.1 Other slots in detail

`item_view` (a tab in the item card), `board_menu_action` (`contexts: board|item` — the board's ⋯ menu / the item
menu) and `batch_action` (the batch bar) open in a modal with `selection` in the context; `dashboard_widget` (a token
that reads only the dashboard's boards the viewer may see and the extension is approved for); `account_settings_page`
(admins, a token without boards). Extension storage `/ext/storage/{installation|user}/:key` (64 KB per value, 1 MB and
1000 keys per installation; a guest / viewer does not write shared storage; uninstalling deletes it — reinstalling
starts empty) and upload `/ext/files` (≤4 MB, `items:write`, then attached to a file column).

`openAutomationBuilder({ trigger, config?, board_id? })`: the app's automation builder (the same `Builder` as board
automations) opens in a window above the page with the trigger already chosen — only an `automation_trigger` of the
calling extension (any other key is rejected), on a board its token reads. With the user's permissions (without
`automation.manage` on the board — the usual refusal), only on a click, one at a time and not from inside a modal;
returns `{ saved, automation_id? }` when closed. `GET /ext/automations?trigger=<key>` (`bines.automations`): the
automations using its trigger on the token's boards that the user can see — `{id, board_id, name, active, trigger}`,
read-only, page tokens only; the automation routes themselves stay closed to extensions.
`setAutomationActive({ automation_id, active })` (`bines.setAutomationActive`): a host action that turns an automation
on / off in the user's session — only if its trigger belongs to the calling extension, on a board the token reads, and
with `automation.manage` (otherwise the usual refusal); returns `{ active }`.

## 6. Examples in the repository

- `extensions/catalog/` — sample catalog extensions: `board-summary` (`board_view`: items, % done, overdue, by status /
  group / person) and `kanban-stats` (`dashboard_widget`), read-only, no server; plus more samples in the same folder.
- `extensions/summary-cards/` — a minimal `board_view` used in development and tests.
- `extensions/calendar-sync/` — an extension with its own server: two-way sync between a board and Google Calendar or
  CalDAV.
- `extensions/browser/` — a Chrome / Edge side panel that embeds the `panel` slot.

## 7. Versions and release

semver in the manifest. "Check for updates": a version with no new scope / origin / capability updates by itself;
otherwise it is kept in `pending_manifest` until an admin approves it (consent screen). Private per account, plus the
platform catalog (D27).
