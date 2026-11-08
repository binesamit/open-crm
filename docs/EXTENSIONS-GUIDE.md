# Building a Bines OS extension — developer guide

A short overview for developers who want to build an extension: what an extension is, the manifest, the page SDK,
an optional server and how to ship it.

> **The full developer guide is [`docs/extensions/README.md`](extensions/README.md)** (every surface, the
> complete SDK API, automation blocks, limits, the catalog review) with a step-by-step tutorial in
> [`docs/extensions/QUICKSTART.md`](extensions/QUICKSTART.md); every deployment serves both at `/api/docs/extensions`.

Hebrew: [`EXTENSIONS-GUIDE.he.md`](EXTENSIONS-GUIDE.he.md). Design and decisions: `docs/DECISIONS.md` D27.

An extension adds something to Bines OS **without changing its core**: a board view, data (templates,
automation recipes, agent templates), and — optionally — its own server that the platform talks to. You host the
code; Bines frames your page in a sandbox and sends you signed calls. Your code never runs inside Bines.

Goal of this guide: a working board view in about an hour.

---

## 1. Quick start (10 minutes)

```sh
# from a clone of the Bines repo
node packages/create-bines-app/index.mjs my-view --name "My view"          # a board view
node packages/create-bines-app/index.mjs crm-sync --server                  # + its own server (§6)
cd my-view
npm install
npm run dev                                                                 # http://localhost:5180
```

In a **development** Bines (`pnpm dev`, http://localhost:5173), sign in as an account admin:

1. **Administration → Extensions → Add by URL** → `http://localhost:5180/manifest.json` → **Check**.
2. The consent screen lists what the extension adds and which permissions it asks for, in plain words. You will
   see a **development-mode** warning: `localhost` origins are accepted only outside production.
3. Approve. Open a board → **+ view** → your view. It reads the board's items through the SDK.

Edit `src/main.ts`; Vite reloads the frame.

---

## 2. The manifest

`manifest.config.mjs` builds it (the dev server serves it at `/manifest.json`; `node manifest.config.mjs
https://ext.example.com` prints the production one). The schema lives in `packages/shared/src/extensions/manifest.ts`.

```json
{
  "manifest_version": 1,
  "id": "my-view",
  "name": "My view",
  "version": "1.0.0",
  "publisher": { "name": "You", "email": "you@example.com" },
  "permissions": ["boards:read"],
  "origins": ["https://ext.example.com"],
  "features": [{ "type": "board_view", "key": "main", "name": "My view", "url": "https://ext.example.com/index.html" }],
  "server": { "lifecycle_url": "https://ext.example.com/bines/lifecycle" }
}
```

| Field | Rules |
|---|---|
| `id` | `a-z0-9-`, 2–48, stable forever — it is the extension's key in every account |
| `version` | semver. A version that asks for **nothing new** is applied automatically (daily check); a new **scope**, **origin** or **feature** (or adding `server`) waits for an admin's consent |
| `permissions` | API token scopes except `admin` (`boards:read`, `items:write`, `updates:write` …). Ask for the minimum |
| `origins` | `https://` origins your code is served from / your server listens on (no path). Never the platform's own origin. `http://localhost:*` only in development |
| `features[].url` | must be on one of `origins` |
| `server.lifecycle_url` | optional (§6); must be on one of `origins` |
| `data` | a data pack: `board_templates`, `starter_kit`, `automation_recipes`, `agent_templates` (no code at all) |

---

## 3. The page: `@bines/ext-sdk`

Your page runs in `<iframe sandbox>` on **your** origin. It never sees the user's session. The host hands it a
**10-minute token** by `postMessage` (never in a URL); the SDK keeps it in memory and asks for a fresh one.

```ts
import { createBinesSdk } from '@bines/ext-sdk';

const bines = createBinesSdk({ hostOrigin: 'https://your-bines.example.com' }); // pin it in production
const ctx = await bines.ready();            // account, board, user, theme, locale, dir
const { data } = await bines.items();       // GET /boards/:board/items
await bines.api('PATCH', `/items/${id}`, { body: { name: 'New' } }); // needs items:write
bines.listen('context', (c) => applyTheme(c.theme));
bines.autoResize();                          // the frame follows your page's height
await bines.execute('openItemCard', { itemId: id });
// The app's own automation builder over your page, its trigger one of your own (on the user's click):
const { saved, automation_id } = await bines.openAutomationBuilder({
  trigger: 'conversation_button',
  // The trigger's own `inputs` (manifest): this automation runs only for fires whose payload has button === 'b-7'.
  config: { with_item: true, inputs: { button: 'b-7' } },
});
const live = await bines.automations('button'); // which automations use your trigger
await bines.setAutomationActive(live[0].id, false); // on / off, with the member's own rights
```

What a token may do is the **intersection** of: the user's own rights × the scopes the admin granted × the
board the view is on × an allowlist of paths (board content only — never tokens, extensions, administration,
AI, agents or the owner console). Every write is recorded as "via extension X" and can be undone.

Rules: show API data as **text** (`textContent`), never as HTML; keep tokens in memory only; never log them.

---

## 4. Permissions, consent and guests

- Only account **admins** install; members can ask. The admin may grant fewer scopes than you ask for (handle a
  `403 insufficient_scope` gracefully), limit you to some boards, and decide whether guests may use you (off by
  default).
- Disabling, uninstalling, a narrower grant or the platform's **emergency switch** apply on the very next request.

---

## 5. Versions and updates

- Bines fetches your manifest **once a day** (and when the admin presses "check for updates").
- Same or older version → nothing. Newer, asking for nothing new → applied, recorded in the version history, and
  your server gets `updated`. Newer **with** a new scope / origin / feature → stays on the old version; the admins
  get a bell notification and approve it on the consent screen.
- Admins can turn automatic updates off, **lock** a version, and go **back** to any approved version (which locks
  it there).

---

## 6. Your own server (optional)

Add `"server": { "lifecycle_url": "…" }`. On install the extension gets an **extension service user** (a member of
the account, never a person) and **OAuth client credentials**.

### Lifecycle calls

`POST <lifecycle_url>` with JSON and these headers:

```
x-bines-event:      extension.installed | extension.updated | extension.enabled | extension.disabled | extension.uninstalled
x-bines-delivery:   <id>
x-bines-timestamp:  <ms since epoch>
x-bines-signature:  sha256=<hex HMAC-SHA256(signing_secret, "<timestamp>.<raw body>")>
```

```json
{
  "event": "installed",
  "account": { "id": "…", "name": "Acme", "slug": "acme" },
  "installation": { "id": "…", "key": "crm-sync", "version": "1.0.0", "status": "enabled", "scopes": ["boards:read"], "board_ids": null, "workspace_ids": null },
  "credentials": {
    "client_id": "bos_extc_…", "client_secret": "bos_exts_…", "signing_secret": "bos_extw_…",
    "token_endpoint": "https://your-bines.example.com/oauth/token",
    "api_base": "https://your-bines.example.com/api/v1"
  }
}
```

- `installed` carries the credentials and is signed with the signing secret it carries. **Prove them** by trading
  them for a token (below) before you trust them — only the real platform can issue it. Store them in your secret
  store, per installation.
- Every later call is signed with the saved signing secret. Check the signature over the **raw** body and refuse a
  timestamp older than 5 minutes (replay).
- `disabled` / `enabled` with `"reason": "platform_kill"` = the platform owner's emergency switch.
- After `uninstalled` the credentials and every token are dead; delete what you stored.
- Answer `2xx` quickly. A failed call is shown to the admin, who can **Reconnect** (new credentials, a fresh
  `installed`).

### Tokens: OAuth `client_credentials`

```sh
curl -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://your-bines.example.com/oauth/token
# → {"access_token":"bos_xat_…","token_type":"Bearer","expires_in":3600,"scope":"boards:read",
#    "installation_id":"…","account_id":"…","api_base":"https://…/api/v1"}
curl -H "Authorization: Bearer bos_xat_…" https://your-bines.example.com/api/v1/boards/<board>/items
```

The token acts as your service user × granted scopes × granted boards × the same path allowlist. `scope=` may
narrow it, never widen it. It lives an hour; ask again with the credentials.

### Helpers

```ts
import { createServerClient, verifyLifecycle } from '@bines/ext-sdk/server';

// `platform` is required with `trustInstalled`: the first `installed` call is signed with the secret it carries, so
// only its origin (platform, token_endpoint, api_base) proves it came from the Bines you work with.
const event = await verifyLifecycle({
  secret: saved?.signing_secret,
  headers: req.headers,
  body: rawBody,
  trustInstalled: true,
  platform: 'https://app.example.com', // your Bines origin
});
const client = createServerClient(event.credentials ?? saved);
await client.token();                                   // proves the credentials
const items = await client.api('GET', `/boards/${boardId}/items`);
```

`create-bines-app --server` writes a dependency-free Node example (`server/lifecycle.mjs`).

---

## 7. Shipping

1. `npm run build` → host `dist/` and the manifest on your **https** origin (TLS 1.2+, HSTS).
2. Pin `hostOrigin` in the SDK and set `Content-Security-Policy: frame-ancestors <your Bines origin>`.
3. Each account adds you by URL — or the **platform owner** publishes you in the catalog for every account.

### The catalog review

The platform owner ticks every item before a code extension enters the catalog:

- HTTPS only (TLS 1.2+) and HSTS — the manifest and every origin.
- Only the scopes it needs, each explained.
- No tokens stored beyond memory, none logged; secrets in `secret` fields.
- Every call from the platform: HMAC signature + timestamp checked.
- No `eval` of user content; platform content shown as text.
- A privacy policy: where data goes, if anywhere.
- Platform side: rate limit per installation, quota, timeouts, emergency switch, audit log.

---

## 8. Troubleshooting

| Symptom | Cause |
|---|---|
| `422 manifest_invalid` with `origins: … must be https` | a production Bines refuses `http://` and `localhost` origins |
| `feature_origin_not_listed` / `server_origin_not_listed` | the URL's origin is missing from `origins` |
| The frame is blank | your page's `frame-ancestors` does not include the Bines origin, or the URL is wrong |
| `401` with a frame token | the token expired (the SDK renews it) or the installation was disabled / uninstalled / killed |
| `403 insufficient_scope` | the admin did not grant that scope (or a new version needs consent first) |
| `403 not_for_extensions` | the path is outside the extension allowlist (by design) |
| `404` on a board | the board is not one the installation is allowed on, or the user cannot see it |
| Lifecycle "failed" in the admin screen | your endpoint did not answer `2xx` within 10 s; fix it and press **Reconnect** |
