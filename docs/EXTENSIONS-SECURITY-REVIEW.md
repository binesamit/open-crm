# Extensions security review — Bines OS

This document records a red-team review of the extension platform and outbound MCP servers of Bines OS, for extension
developers, self-hosters and security researchers. It is a historical audit of the code as it was in October 2026:
every finding below was fixed in the code with a regression test, and section 4 lists the risks that remained (with
their later status). Finding ids (EXT-RT1 …) and section numbers are cited from source comments, so they are stable.

Scope: install and consent, the extension frame token (`bos_ext_`), CSP `frame-src`, CORS, extension storage and
files, triggers and signed `run_extension` calls, the extension's server (service user + `client_credentials` →
`bos_xat_`, lifecycle calls), update checks, versions and rollback, the catalogue, the kill switch, the postMessage
bridge (`AppFrame`), the SDKs (`packages/ext-sdk`, `create-bines-app`) and external MCP servers. Method: a red team — a
malicious or compromised extension (its page, its server, its manifest and its updates), a malicious MCP server and an
admin of another account against the real code, plus manual code review. Related audits:
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md), [`AI-SECURITY-REVIEW.md`](AI-SECURITY-REVIEW.md). The developer guide is
[`EXTENSIONS-GUIDE.md`](EXTENSIONS-GUIDE.md).

## Summary

**The question:** how do we make sure extensions that other people build cannot harm the system? It was tested the
way an attacker would: a "bad extension" that tries everything, checked against what the platform allows it to do.

**What was tested:** stealing, forging and replaying an extension token; exceeding the permissions an admin approved
(another board, another action, a route not meant for extensions); reaching another account with ids; browser calls
from the extension's origin with the user's cookie; forged postMessage messages (another window, another extension, a
look-alike origin, a huge message); dangerous URLs injected into the manifest (`*`, `javascript:`, characters that
change the page's security policy, "reversed" names that mislead on the consent screen); bypassing re-consent through
an update (an older version, the same version with different content, a URL that swaps the manifest between preview
and install); trigger signatures (replay, clock skew); SSRF (internal addresses through lifecycle, `run_extension`,
MCP); storage and files (quota, keys, uploaded HTML); malicious HTML written by an extension; the kill switch — does it
really stop everything; the extension server's user (private boards, administration); and an MCP server that changes
its tools after they were approved. In total, 27 new automated tests (4 files) plus updated SDK tests.

**Found and fixed (16 findings):**

- **Critical — 1:** an extension granted "manage users" (`users:write`) and opened by an admin could **generate a
  one-time sign-in link for another user's account** (= account takeover), change roles, deactivate people, invite
  outsiders, share a board with a team or make a private board public. The same held for an extension's server. Fixed:
  extensions see people and teams **read-only**, and never touch who sees a board (permissions, sharing, invitations,
  board kind).
- **Medium — 5:** (1) an origin with `*` or `;` in the manifest went into the page's security policy (opening the page
  to any site / changing rules); (2) a manifest URL could show the admin a harmless extension on the consent screen and
  install another one a second later — and approving an update could approve a different version from the one the
  admin saw; (3) "save as pack" exported webhook automation secrets (secret URLs, keys, signatures) into a file meant to
  be passed around; (4) an MCP server could change an already-approved tool without re-approval ("rug pull") — the tool
  stayed enabled and unapproved; (5) the SDK and the `create-bines-app` server template trusted a forged `installed`
  call pointing the extension's server at the attacker's "platform".
- **Low — 10:** a token could see which other account the user last opened; anyone knowing an installation id could
  lock out the real extension's triggers; an MCP server's error message and tool names reached the model without an
  "untrusted" marking; invisible characters in names; an empty board list meant every board (on the server); endless
  modal dialogs; an over-deep trigger payload; a `javascript:` link in the catalogue review; a storage quota that
  parallel writes could exceed; a server token that asked for a narrower scope still got the whole grant.

**What was already strong (no failure found):** token signing and a 10-minute lifetime, binding to the extension's
origin and account; re-consent for every new permission / origin / capability; the user's cookie never works from an
extension's origin; another account's boards — 404; SSRF protection on every outbound call; HTML written by an
extension is shown as text; HTML files are served as downloads only; the kill switch stops every kind of token,
trigger, call, list and security policy.

**What remained:** see section 4 — per-process state (replay cache, rate limits) on multi-replica deployments, and a
token an extension exfiltrates from its own page being usable for up to 10 minutes (inherent: it acts as the user
within the admin's grant).

---

## 1. Scope and method

| Surface | Code |
|---|---|
| Install, consent, versions, catalogue, kill switch | `apps/api/src/modules/extensions/{extensions.service,updates,catalog,platform-extensions,manifest-source,packs,pack-export}.ts` |
| Frame token `bos_ext_`, path allowlist, CORS, CSP | `ext-token.ts`, `ext-origins.ts`, `packages/shared/src/extensions/{token,manifest}.ts`, `middleware/security-headers.ts` |
| Storage, uploads, signed triggers, `run_extension` | `ext-storage.ts`, `ext.routes.ts`, `ext-automation.ts`, `ext-signing.ts` |
| Extension server (service user, `bos_xat_`, lifecycle) | `server-side.ts`, `/oauth/token` |
| Host bridge | `apps/web/src/features/extensions/AppFrame.tsx` (+ `frame-protocol.ts`) |
| SDKs | `packages/ext-sdk/src/{index,server}.ts`, `packages/create-bines-app/template/server/lifecycle.mjs` |
| Outbound MCP | `apps/api/src/modules/mcp-servers/*` |

**Method.** One local HTTP server plays the attacker's extension origin, its server (lifecycle + action endpoint),
its manifest URL (switchable between requests) and a malicious MCP server. Tokens are minted by an **admin** (the
worst case — an extension acts as whoever opens it). Each EXT-RT case was confirmed to fail before its fix (EXT-RT1:
the recovery link answered 200 with a working sign-in URL).

**Tests:** `apps/api/test/extensions-redteam.test.ts` (20), `apps/web/src/features/extensions/frame-protocol.test.ts`
(5), `packages/shared/test/extensions-manifest.test.ts` (+1), `packages/ext-sdk/test/server.test.ts` (+1, 1 updated).

## 2. Findings (all fixed, each with a regression test)

| id | sev | area | finding | fix | test |
|---|---|---|---|---|---|
| EXT-RT1 | critical | frame / server tokens | The allowlist admitted every route under `/users`, `/teams` and most of `/boards/:id/*`. An extension with `users:write` opened by an admin could `POST /users/:id/recovery-link` (a one-time sign-in link = account takeover), change roles, deactivate, invite outsiders, export people, reset 2FA, transfer ownership; with `teams:write` / `boards:write` it could change team membership, share a board with a team, invite to a board, claim a board, set column restrictions, or `PATCH /boards/:id` `kind` / `permission_set` / `workspace_id` (who sees the board). The same held for the extension server's service-user token. Percent-encoded paths (`%72ecovery-link`) reached the route too. | `extensionPathAllowed(path, method)`: `/users` → only `GET /users` and `GET /users/me`; `/teams` and `/auth/me` read-only; denied under `/boards/:id/`: `permissions, members, teams, invite, claim, webhooks, automations, ai-columns, export, save-as-template, template-draft`, `columns/:id/restriction`. `assertExtensionRequest` (both token kinds) also refuses `PATCH /boards/:id` with `kind`, `permission_set` or `workspace_id`. | redteam "EXT-RT1 …" (3 cases), shared allowlist test |
| EXT-RT2 | medium | manifest → CSP | `originSchema` only compared `new URL(s).origin === s`; the URL parser lets `*`, `;`, `,`, quotes and more through the host. `https://*` / `https://*.host` became a CSP wildcard in the account's `frame-src`, `https://a.com;worker-src` injected a directive. | `isPlainOrigin`: the host must be DNS labels (punycode), IPv4 or `[IPv6]`; the CSP / CORS builder filters stored origins again. | "origins are plain hosts…", "an install with a wildcard origin…" |
| EXT-RT3 | medium | consent | (a) Install by URL fetched the manifest again: a server could show a harmless manifest on the consent screen and serve another (same id / version, now with a `server`, origins, features) to the install. (b) `approve-update` approved whatever was pending — the daily check could have replaced the version the admin reviewed. | Preview returns `digest` (sha256 of the validated manifest); install with `manifest_digest` refuses a different manifest (`409 manifest_changed`). `approve-update` takes `version` (`409 pending_update_changed`). The web sends both. | "a manifest URL that serves something else…", "approving a waiting update…" |
| EXT-RT4 | medium | data packs | "Save as pack" copied automation recipes as stored: webhook URLs (Make / Zapier hook URLs are secrets), header values and signing secrets ended up in a JSON file meant to be passed around. | Recipes and titles go through `redactRecipe` / `redactTitle` (AI-RT8); they load inactive and are filled in again. | "webhook URLs, headers and signing secrets stay…" |
| EXT-RT5 | medium | outbound MCP | `refresh` kept an admin's decision (enabled, approval off) by tool **name**: a server could change a tool's description (new injected instructions) or input schema after approval — a "rug pull". | Each decision stores a fingerprint of description + input schema; a changed tool goes back off and to approval (`mcp_server.tools_changed` audited). | "a tool that changes after it was enabled…" |
| EXT-RT6 | medium | SDK / template | The first `installed` lifecycle call is signed with the secret it carries. `verifyLifecycle({trustInstalled})` and the `create-bines-app` server accepted any such call; "prove the credentials by trading them for a token" used the `token_endpoint` **from the same call**, so a forged `installed` pointed the extension's server at the attacker's "platform" (and could replace a real installation's saved credentials). | `verifyLifecycle` requires `platform` with `trustInstalled` and checks `platform`, `token_endpoint`, `api_base` against it; `createServerClient` refuses a token endpoint on another origin than the API; the template pins `BINES_ORIGIN`. Guide updated. | `ext-sdk/test/server.test.ts` |
| EXT-RT7 | low | tokens | `/auth/me` runs without `requireAccount`: a token (extension, API, MCP) with `X-Account-Id` of another account its person belongs to got that account's name / role, and every token saw `last_account_id`. | Extension requests: the header must be the installation's account (404). `/auth/me` with any token answers for the token's account only, `last_account_id: null`. | "the token never names another account…" |
| EXT-RT8 | low | triggers / DoS | 20 bad signatures with an installation id blocked that installation for 10 minutes — the id is no secret (activity log, token claims), so anyone could lock the real server out. | Failures block the sending address only (HMAC is not brute-forceable). | "bad signatures lock out the sender's address…" |
| EXT-RT9 | low | MCP → models | A remote JSON-RPC error message (200 chars) became our error message (`mcp_error: …`) and reached an agent's model unwrapped; tool names were free text (up to 128 chars) that land in tool titles. | Error code `mcp_error`; the remote text is in `details.remote_message`, wrapped as `<untrusted_content>` for agents. Tool names must use the MCP name characters. | "a tool that changes…" (error part, name filter) |
| EXT-RT10 | low | consent screen | Names / descriptions could contain bidi overrides (U+202A–E, U+2066–9) and control characters — a reversed or hidden publisher name. | Manifest text fields refuse them (direction marks U+200E/F stay allowed for Hebrew). | "names cannot carry bidi overrides…" |
| EXT-RT11 | low | server token | `boardIds: row.boardIds?.length ? … : null` — an empty grant list would mean every board (unreachable through the API today, `min(1)`). | The grant list as stored. | defence in depth (code) |
| EXT-RT12 | low | host bridge | A modal frame could `openModal` again — an endless stack of dialogs over the app. | `openModal` from a modal is refused (`modal_open`). | `frame-protocol.ts` + manual |
| EXT-RT13 | low | triggers | A trigger payload of any depth went into `{payload.*}` and the activity log. | Depth ≤ 8, objects only (`422 payload_too_deep`). | "…depth are refused" |
| EXT-RT14 | low | catalogue | `review.privacy_url` was `z.url()` — accepts `javascript:`. | http(s) only. | schema |
| EXT-RT15 | low | storage | Quota check then write: parallel `PUT`s could each pass the 1 MB quota (and insert the same key twice). | Count + write under a per-installation advisory lock. | "parallel writes cannot pass the storage quota…" |
| EXT-RT16 | low | server token | `/oauth/token` with a narrower `scope` answered that scope, but the token kept the whole grant. | `extension_server_tokens.scopes` (migration `0043_extredteam`); requests use grant ∩ token scopes. | "EXT-RT16 — a narrower scope…" |

## 3. Checks that held (no change needed)

| Category | What the attacker tried | Result | Where tested |
|---|---|---|---|
| Token forgery | Changed claims (account, board) with the old signature; a token signed with another key; an expired token | 401 (HMAC-SHA256 over the claims, key from the server secret — required in production) | redteam EXT-RT7 |
| Token origin binding | The token from another extension's origin, from `null` | 401; a browser always sends Origin | redteam, `extensions.test.ts` |
| Cross-account | Another account's admin: mint, read the secret, patch the installation; our ids with their header | 404 | redteam |
| Board scope | Token for one board on another board; widget tokens; settings-page token | `not_found`; widgets get only the dashboard's readable boards; settings page none | `extensions*.test.ts` |
| CORS | Cookie from an extension origin; a non-extension bearer from one; preflight | An extension origin must send an extension token (401 otherwise); no `Allow-Credentials`; exact origin match from enabled, not-killed installations | `extensions.test.ts` |
| CSP / clickjacking | Framing our app; a frame from an unlisted origin | `frame-ancestors 'none'` + `X-Frame-Options: DENY`; `frame-src` per account page from its enabled extensions only | `extensions.test.ts`, redteam |
| Sandbox | Top navigation, our cookies / DOM, device APIs | `sandbox` without top navigation; own origin (ours refused at install and in the frame); `allow=""`; no-referrer | code review, `frame-protocol.test.ts` |
| postMessage | Another frame / window / tab, look-alike or navigated origin, other protocol / version / types, cyclic or huge payloads; the token in a URL | Only this frame's window **and** origin; replies posted to that origin only; JSON copies ≤ 64 KB; the token travels by postMessage only | `frame-protocol.test.ts` |
| `openModal` | `//evil`, `/\evil`, `javascript:`, `data:`, `blob:`, `user@host` | Same origin, http(s) only | `frame-protocol.test.ts` |
| Re-consent | New scope / origin / feature / server via update; same version with new content; a lower version; rollback to a bigger version | Waits for an admin; same / lower → `current`; rollback with more → pending | redteam, `extensions-3.test.ts` |
| Signatures | Replay, ±6 min skew, seconds instead of ms, bad HMAC | 401 (`replay` / `stale` / `bad_signature`) | redteam, `extensions-2.test.ts` |
| SSRF | Lifecycle URL, action URL, manifest URL, MCP URL and OAuth token URL on private / metadata addresses | `lib/outbound`: public addresses only in production, no redirects, every call re-checked; origins https-only in production | `ai-redteam-ssrf.test.ts`, `mcp-servers.test.ts`, `extensions.test.ts` |
| Storage | Another installation's / user's keys, traversal, `%` / `_` prefixes, oversized values | Keyed by the token's installation (+ user); key regex; `starts_with` (no LIKE); 64 KB / 1 MB / 1000 keys | redteam, `extensions-2.test.ts` |
| Files | `text/html`, SVG, XHTML, JS uploads | Stored, but only images / PDF / media / plain text are ever served inline — everything else is an attachment | redteam |
| HTML from an extension | `<img onerror>` / `<script>` in an update; names, labels, options, notices in our UI | Updates escaped by the update renderer; React text everywhere in the extension UI (no `dangerouslySetInnerHTML`); toasts prefixed with the extension's name, 3 per 10 s | redteam, code review |
| Service user | Private boards, admin routes, webhooks, tokens | A `member`; private boards only if an admin adds it; the same allowlist as frames (EXT-RT1) | redteam, `extensions-3.test.ts` |
| Kill switch | Frame token, server token, client credentials, new mints, trigger, `run_extension` call, feature lists, blocks, CSP | All stop at once (CSP / CORS caches: this process at once, others ≤ 30 s) | redteam "the kill switch…" |
| Outbound MCP | Results with injections; tools on by default; agent calls | Results wrapped `<untrusted_content>`; tools off until an admin enables them; approval on by default; the automation run log keeps no answer | `mcp-servers.test.ts` |

## 4. Remaining risks and recommendations

1. **Personal API tokens and recovery links.** At the time, a personal `bos_pat_` token of an admin with
   `users:write` could still call `POST /users/:id/recovery-link` and `reset-2fa` — a leaked admin token would be an
   account takeover of every member. **Resolved since:** both routes (and the owner console's recovery link) are
   session-only in `apps/api/src/lib/scopes.ts`.
2. **Per-process state.** The signature replay cache and every rate limiter live in one process; with several API
   replicas a captured signed trigger could be replayed once per replica inside the 5-minute window, and CSP / CORS
   caches may lag ≤ 30 s after a kill. Move to Redis / Postgres when scaling out.
3. **A token the extension exfiltrates.** The page receives a real token (≤ 10 minutes, its board, its grant). The
   origin binding stops other browsers' pages, not the extension's own server. That is the design (the extension acts
   as the user within the admin's grant); the kill switch and disabling stop it at once.
4. **The extension's own pages are public URLs.** Anyone can frame them; the SDK trusts the first parent that sends
   `init` unless `hostOrigin` is pinned. Developers should pin `hostOrigin` and send `frame-ancestors <bines origin>`
   (the extension guides now say so).
5. **Data-pack updates apply without consent** (by design — [`DECISIONS.md`](DECISIONS.md) D21 / D27): new inactive automation recipes, board
   templates and starter agents (inactive, learner mode) arrive with an auto-update. Activation stays a person's act.
6. **MCP runtime behaviour.** A server can change what a tool *does* without changing its description; the per-call
   approval (default on) and the untrusted wrapping are the controls.
7. **UI wording for the new 409s** (`manifest_changed`, `pending_update_changed`) — at the time the generic conflict
   message was shown; specific strings have since been added to the i18n files.
8. **Behaviour changes for developers:** `openModal` from a modal is refused; `verifyLifecycle({trustInstalled})`
   needs `platform`; `createServerClient` refuses a token endpoint on another origin; extensions can no longer write
   people, teams or sharing.

## 5. How to run

```
pnpm --filter @bines/api exec vitest run test/extensions-redteam.test.ts
pnpm --filter @bines/web exec vitest run src/features/extensions
pnpm --filter @bines/ext-sdk test
```

A new route under `/boards`, `/items`, `/updates`, `/users`, `/teams`, `/search` or `/tags` is reachable by
extensions unless it is denied in `packages/shared/src/extensions/token.ts` — decide there whether it is board content.
