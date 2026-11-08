// SPDX-License-Identifier: AGPL-3.0-only
import { DOC_STATE_MAX_BYTES, MCP_SCOPE_GROUPS, TOKEN_PREFIX } from '@bines/shared';
import type { GuideContext } from './guide';

/**
 * The hand-written pages of the internal API reference (`/api/docs/internal`, platform owner only)
 * what the reference is, how access is labelled, and the three channels the OpenAPI document cannot describe —
 * the MCP server (`/mcp`), the docs collaboration WebSocket (`/api/v1/collab`) and Better Auth's sign-in routes
 * (`/api/auth/*`). Numbers and names come from the code (`docs/collab.ts`, `auth/auth.ts`, `mcp/*`), so the page says
 * what this server does. Rendered as the OpenAPI `info.description` (every `#` heading is a page in the navigation).
 */

/** Kept in step with `docs/collab.ts` (not imported: that module pulls the Hocuspocus server into the docs build). */
export const COLLAB_DOC = {
  path: '/api/v1/collab',
  tokenMinutes: 5,
  debounceS: 2,
  maxDebounceS: 10,
  recheckS: 30,
  maxMessageBytes: 2 * DOC_STATE_MAX_BYTES,
} as const;

/** Kept in step with `auth/auth.ts` / `auth/two-factor.ts`. */
export const AUTH_DOC = {
  basePath: '/api/auth',
  cookie: 'bos.session_token',
  sessionDays: 30,
  magicLinkMinutes: 10,
  resetHours: 1,
} as const;

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export const internalGuideMarkdown = (g: GuideContext, counts: { total: number; internal: number }): string => {
  const p = g.productName;
  return `> **Internal — subject to change.** This reference lists every route of the ${p} API, including the ones
> the web app and the owner console use and no integration should. Internal routes may change or disappear in any
> release without notice. Visible to the platform owner only.

# Overview

This page is generated from the same route schemas as the [public API reference](/api/docs), without the public
filter: **${counts.total} operations**, of which **${counts.internal} are internal**. Each operation shows:

- a **Public** or **Internal** badge — public operations are the ones the public reference documents (an API token
  may call them);
- **Access** — who may call it: the platform owner, the support console (owner or support staff), a signed-in
  person only (session cookie; API tokens are refused), an account member with \`X-Account-Id\`, or a token scope;
- the parameters, request and response schemas as the route validates them.

Operations are grouped by module (the route's tag); the owner console (\`/platform/*\`) is split by area. The raw
document is [\`/api/docs/internal/openapi.json\`](/api/docs/internal/openapi.json) (also
\`/api/v1/openapi.full.json\`). Three channels are not REST routes and are described by hand below:
[MCP server](#mcp-server), [Docs collaboration WebSocket](#docs-collaboration-websocket) and
[Sign-in (Better Auth)](#sign-in-better-auth).

## Calling internal routes

The web app calls \`${g.apiBase}\` with the session cookie (\`${AUTH_DOC.cookie}\`) and, for account routes, the
\`X-Account-Id\` header. Owner-console routes answer **404** to anyone who is not the platform owner (they do not
advertise themselves) and never accept an API token. "Session only" routes (token management, the owner console,
account switching, OAuth consent, installing extensions, the in-app AI chat) refuse every token with 403
\`not_with_a_token\`.

# MCP server

The account's MCP server for AI apps, at \`${g.origin}/mcp\` — Streamable HTTP, stateless (each JSON-RPC request
on its own: \`initialize\` → \`tools/list\` → \`tools/call\`), built on the official TypeScript SDK. Mounted on the
web origin, outside \`/api/v1\`, so it is not in the OpenAPI document.

- **Authentication:** bearer only, never cookies (no CSRF). Either an API token (\`${TOKEN_PREFIX}…\` or a
  service token) — its account, scopes, board limit and rate budget, shared with the REST API — or an OAuth access
  token (Claude.ai, ChatGPT) issued for the \`/mcp\` resource. A request without one answers 401 with
  \`WWW-Authenticate: Bearer … resource_metadata=…, scope="${[...MCP_SCOPE_GROUPS.read, ...MCP_SCOPE_GROUPS.write].join(' ')}"\`.
- **OAuth discovery** (also outside the document): \`/.well-known/oauth-protected-resource\` (and \`…/mcp\`),
  \`/.well-known/oauth-authorization-server\`, \`/oauth/authorize\`, \`/oauth/token\`, \`/oauth/register\` (dynamic
  client registration) and \`/oauth/revoke\`.
- **Tools:** self-described — \`tools/list\` returns each tool's name, description and JSON input schema, filtered
  by the connection's scopes (viewers read only; sensitive tools hidden when the account blocks them). In the API,
  \`GET /ai/mcp\` returns the address and the tools available to the caller. The tools are the AI tool registry
  (\`ai/tools\`), run as the token's user through the shared AI tool gate (plan, support access, approvals).
- **Who may connect:** guests never; viewers and members only when the account allows MCP for them.
- **Limits:** request body up to 1 MB; every call counts against the token's per-minute and daily budget.

\`\`\`bash
curl -s ${g.origin}/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

# Docs collaboration WebSocket

Live co-editing of docs: a Hocuspocus (Yjs) server inside the API process, on the same HTTP server and origin.
\`GET ${COLLAB_DOC.path}\` upgrades to a WebSocket; it is not a REST route, so it is not in the document.

- **Document name:** \`<account_id>:<doc_id>\` — the \`collab_name\` that \`GET /docs/{id}\` returns.
- **Authentication:** the session cookie (send the token \`session\`), or a ${COLLAB_DOC.tokenMinutes}-minute
  collab token from \`POST /docs/{id}/collab-token\` sent as the Hocuspocus token (for clients without the cookie).
  The token is bound to one account, doc and person.
- **Origin:** same-origin only — the app's origin or the host the request came to; anything else gets 404 on the
  upgrade.
- **Access:** checked per document on connect — account membership (or a support grant), the account's IP
  allowlist and two-factor requirement, and the doc's permissions. A doc one cannot read is refused; viewers,
  commenters and view-only support connect read-only. Open connections are checked again every
  ${COLLAB_DOC.recheckS} s and on access events (doc members, kind, move, trash; board / workspace / team / account
  changes): a revoked session or lost access closes the socket and the client reconnects and is checked again.
- **Saving:** the Yjs state is the truth; it is saved debounced ${COLLAB_DOC.debounceS} s (at most every
  ${COLLAB_DOC.maxDebounceS} s), deriving the ProseMirror JSON, the search text and the files the doc shows. One
  \`doc.edited\` activity per person and doc every ~10 minutes of editing.
- **Limits:** a WebSocket message is at most ${mb(COLLAB_DOC.maxMessageBytes)} (twice the largest doc state).
- **Without a socket:** \`GET /docs/{id}/content\` reads the content as last saved (ProseMirror JSON + plain
  text); versions, comments and export are REST routes too.
- **Known limit:** a doc lives in the memory of one process — editors must reach the same API instance.

# Sign-in (Better Auth)

Sign-in, sign-up, sessions and the second factor are served by Better Auth at \`${AUTH_DOC.basePath}/*\` (its own
router, outside \`/api/v1\`). The web app uses its client (\`apps/web/src/lib/auth-client.ts\`). The session is a
cookie \`${AUTH_DOC.cookie}\` (secure in production), valid ${AUTH_DOC.sessionDays} days and renewed daily. Requests must
come from a trusted origin (the public address, \`WEB_ORIGIN\` and addresses kept during a move).

| Route | Purpose |
| --- | --- |
| \`POST /sign-in/email\` | Email + password. May answer \`twoFactorRedirect\` — finish with the second factor. |
| \`POST /sign-up/email\` | Create a password user — only with a valid invitation: header \`x-invite-token\` and the invited email. |
| \`POST /sign-in/magic-link\` | Email a one-time sign-in link (${AUTH_DOC.magicLinkMinutes} minutes). |
| \`GET /magic-link/verify\` | The link's target: signs in and redirects. |
| \`POST /sign-in/social\` | Start Google sign-in (only when \`GOOGLE_CLIENT_ID\` / \`GOOGLE_CLIENT_SECRET\` are set). |
| \`GET /callback/:provider\` | The OAuth provider's callback. |
| \`GET /get-session\` | The current session and user (\`isPlatformOwner\`, \`locale\`, \`timezone\`). |
| \`POST /sign-out\` | End the session. |
| \`POST /request-password-reset\` | Email a reset link (${AUTH_DOC.resetHours} hour, single use; the token is in the URL fragment). |
| \`POST /reset-password\` | Set the new password with the token; every other session is signed out. |
| \`POST /change-password\` | Change the password with the current one. |
| \`POST /two-factor/enable\` · \`/disable\` · \`/get-totp-uri\` | Authenticator app (TOTP) setup; disabling is refused while an account requires 2FA. |
| \`POST /two-factor/verify-totp\` · \`/verify-backup-code\` | Finish a sign-in that asked for the second factor. |
| \`POST /two-factor/generate-backup-codes\` | 10 new backup codes. |

- **Second factor on every door:** after a magic link or Google sign-in the same challenge applies (the session
  is dropped, the browser lands on \`/login?two_factor=1\`); a device trusted for 30 days skips it.
- **Rate limits (per IP, production):** \`/sign-in/email\` 10/min, \`/sign-in/magic-link\` 10 per 15 min,
  \`/request-password-reset\` 5 per 15 min, \`/reset-password\` 10/min, \`/change-password\` 10 per 15 min.
- **Password length:** the platform / account minimum (owner console and account security settings) is enforced
  on sign-up, reset and change.
- The app's own sign-in helpers are REST routes in the document: \`GET /auth/config\` (which ways in are on),
  \`POST /auth/forgot-password\`, \`POST /auth/recovery/preview\`, \`GET /auth/me\` and the invitation routes.
`;
};
