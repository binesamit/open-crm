// SPDX-License-Identifier: AGPL-3.0-only
import {
  ERROR_STATUS,
  SERVICE_TOKEN_PREFIX,
  TOKEN_PREFIX,
  TOKEN_SCOPES,
  WEBHOOK_DISABLE_AFTER_DEAD,
  WEBHOOK_EVENTS,
  WEBHOOK_RETRY_MINUTES,
} from '@bines/shared';

/**
 * The hand-written guide of the API reference (the pages before the endpoints: getting started, authentication,
 * errors, pagination, limits, idempotency, webhooks, MCP, extensions). Every number, name and address comes from
 * the code or the deployment's settings, so the guide says what this server really does. Rendered as the OpenAPI
 * `info.description` (Markdown; every `#` heading is a page in the navigation).
 */
export type GuideContext = {
  productName: string;
  /** Public origin of the deployment (`WEB_ORIGIN`). */
  origin: string;
  /** `<origin>/api/v1`. */
  apiBase: string;
  logoUrl?: string;
  /** Where the reference's own OpenAPI document is served. */
  specUrl: string;
  limits: {
    tokenPerMinute: number;
    servicePerMinute: number;
    dayPersonal: number;
    dayService: number;
    /** 0 = off. */
    accountPerMinute: number;
    /** 0 = off. */
    ipPer10s: number;
  };
  idempotencyHours: number;
  maxRequestMb: number;
  /** The n8n community-node package and the Make app's invitation link (null = not set) — Platform settings. */
  integrations: { n8n_package: string; make_invitation_url: string | null };
};

const n = (v: number) => v.toLocaleString('en-US');

const minutes = (m: number) => (m < 60 ? `${m} min` : m % 1440 === 0 ? `${m / 1440} d` : `${m / 60} h`);

const SCOPE_TEXT: Record<string, string> = {
  'boards:read': 'Read workspaces, folders, boards, groups, columns, views, items, docs and dashboards',
  'boards:write': 'Create and change workspaces, folders, boards, groups, columns, views, docs and dashboards',
  'items:write': 'Create, change, move and delete items and subitems, cells, files and time tracking',
  'updates:read': 'Read the updates (comments) thread of items',
  'updates:write': 'Post, edit and delete updates and replies',
  'users:read': 'List members and teams',
  'users:write': 'Invite, change, deactivate and reactivate members (admins only)',
  'teams:write': 'Create and change teams',
  'automations:read': 'Read automations and their run history',
  'automations:write': 'Create, change and run automations',
  'agents:read': 'Read AI agents, their runs (with every step) and approval requests',
  'agents:run': 'Run an AI agent with a prompt and stop its run (includes agents:read)',
  'agents:write': 'Create, change and delete AI agents, their knowledge, approvals and undo (includes agents:run)',
  webhooks: 'Manage board webhooks and their deliveries',
  'notifications:read': 'Read my notifications and inbox',
  'notifications:write': 'Mark notifications as read',
  search: 'Search across boards, items, updates and docs',
  admin: 'Everything above plus account settings, audit log, usage and administration (admins only)',
  'secrets:read':
    'Reveal the values of secret columns (admins only; not included in any other scope, admin neither; the token’s person needs two-factor authentication)',
};

const errorsTable = () => {
  const byStatus = new Map<number, string[]>();
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, codes]) => `| ${status} | ${codes.map((c) => `\`${c}\``).join(', ')} |`)
    .join('\n');
};

/** The Make steps: the owner's invitation link, or "ask your administrator" while there is none. */
const makeSteps = (g: GuideContext) =>
  g.integrations.make_invitation_url
    ? `1. Open the [invitation link of the ${g.productName} app](${g.integrations.make_invitation_url}) and install the app
   in your Make organization.
2. In a scenario add the ${g.productName} module and click **Create a connection**.
3. Paste the instance URL \`${g.origin}\` and an API token, then save — Make tests the connection.`
    : `The ${g.productName} app for Make is installed through an invitation link — ask your administrator for it. Then add the
${g.productName} module to a scenario, click **Create a connection** and paste the instance URL \`${g.origin}\` and an
API token.`;

export const guideMarkdown = (g: GuideContext): string => {
  const p = g.productName;
  const L = g.limits;
  const logo = g.logoUrl ? `![${p}](${g.logoUrl})\n\n` : '';
  return `${logo}The ${p} REST API lets your code and no-code tools (Make, n8n, Zapier, scripts) work with the same
workspaces, boards, items, updates, files, automations and webhooks people use in the app — with the same
permissions. Everything you can do here is checked exactly like a click in the app.

**Base URL:** \`${g.apiBase}\`

# Getting started

1. **Create a token.** In ${p}, open your profile menu → **API tokens** → **New token**. Pick a name, the
   scopes it needs and an expiry. The token (\`${TOKEN_PREFIX}…\`) is shown **once** — store it in a secret manager.
2. **Call the API** with the token in the \`Authorization\` header:

\`\`\`bash
curl ${g.apiBase}/auth/me \\
  -H "Authorization: Bearer $TOKEN"
\`\`\`

3. **Read a board and add an item:**

\`\`\`bash
# Every board you can see, newest first
curl ${g.apiBase}/boards -H "Authorization: Bearer $TOKEN"

# Add an item to a board's first group, with two cells
curl -X POST ${g.apiBase}/boards/$BOARD_ID/items \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Website redesign", "cells": {"status": {"index": 1}, "date": {"date": "2026-10-20"}}}'
\`\`\`

Column ids (\`status\`, \`date\`, …) and a status column's label ids come from \`GET /boards/{id}\`; each cell's
value follows its column type.

**Conventions**

- JSON in and out (\`Content-Type: application/json\`), UTF-8. Request bodies up to ${g.maxRequestMb} MB; files are
  uploaded straight to storage with a presigned URL (see **Files**).
- Ids are opaque strings. Times are RFC 3339 in UTC (\`2026-10-06T09:30:00.000Z\`); dates are \`YYYY-MM-DD\`.
- Every response carries \`X-Request-Id\`. Include it when you report a problem.
- Use **Test request** on any endpoint below to call this server from the page with your token.

# Authentication

Send an API token as a bearer token:

\`\`\`http
Authorization: Bearer ${TOKEN_PREFIX}AbCdEf…
\`\`\`

| Token | Prefix | Who it acts as | Created by |
|---|---|---|---|
| Personal | \`${TOKEN_PREFIX}\` | You, with your permissions | Any member (not viewers or guests) — profile menu → API tokens |
| Service | \`${SERVICE_TOKEN_PREFIX}\` | A service identity of the account (shown as such in the activity log) | Account admins |

- A token belongs to **one account**. You may omit \`X-Account-Id\`; if you send it, it must name the token's
  account.
- A token can be limited to some boards; it never sees more than its owner can.
- Tokens expire (30, 90 or 365 days, or never) and can be revoked at any time; a revoked token stops at once.
- Only a hash is stored: a lost token cannot be shown again — create a new one.

## Scopes

A token can do what its scopes allow **and** what its owner may do — the stricter of the two wins. A write scope
includes its read scope.

| Scope | Allows |
|---|---|
${TOKEN_SCOPES.map((s) => `| \`${s}\` | ${SCOPE_TEXT[s] ?? ''} |`).join('\n')}

Each endpoint below names the scope it needs. A missing scope answers \`403 insufficient_scope\`.

**AI agents from a no-code tool.** To start an agent from Make, n8n or a script, give the token \`agents:run\`:
it may call \`POST /agents/{id}/runs\`, follow the run (\`GET /agents/runs/{id}\`) and cancel it, but not create,
change or delete agents (\`agents:write\`). The token's owner must still be allowed to run that agent in the app.

# Errors

Every error has the same JSON shape:

\`\`\`json
{
  "error": {
    "code": "validation_failed",
    "message": "Request validation failed",
    "details": { "issues": [{ "path": ["name"], "message": "Too small: expected string to have >=1 characters" }] },
    "request_id": "req_01JB9X2Q7T4V8M3K6R1N5P0W2Z"
  }
}
\`\`\`

Branch on \`code\` (stable), not on \`message\` (wording may change). \`details\` adds context where it helps
(\`issues\` for validation, \`retry_after_ms\` for rate limits).

| HTTP | Codes |
|---|---|
${errorsTable()}

Something you may not see answers \`404 not_found\`, never \`403\` — the API does not reveal what exists.

# Pagination

Lists that can grow return one page at a time with a cursor:

\`\`\`json
{ "data": [ … ], "next_cursor": "eyJvIjoxMDB9", "total": 1234 }
\`\`\`

Pass \`next_cursor\` back as \`cursor\` (with the same filters) to get the next page; \`null\` means there are no
more. \`limit\` sets the page size (each endpoint documents its default and maximum — items: 100, up to 500).

\`\`\`js
let cursor = null;
do {
  const res = await fetch(\`${g.apiBase}/boards/\${boardId}/items/query\`, {
    method: 'POST',
    headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 500, ...(cursor ? { cursor } : {}) }),
  });
  const page = await res.json();
  handle(page.data);
  cursor = page.next_cursor;
} while (cursor);
\`\`\`

A cursor belongs to its query: changing filters or sort while paging answers \`422 invalid_query\`.

# Rate limits & quotas

Each token has a budget per minute and per day. The numbers below are this platform's defaults; an account
administrator can set the account's own (Administration → API), and a token can carry its own budget (a member can
only lower it). A token runs with its own budget, else its account's, else the platform's — the \`RateLimit-*\`
headers of every response show the budget a token really runs with.

| Limit | Default | Applies to |
|---|---|---|
| Per token, per minute | ${n(L.tokenPerMinute)} (service tokens ${n(L.servicePerMinute)}) | Each token |
| Per token, per day | ${n(L.dayPersonal)} (service tokens ${n(L.dayService)}) | Each token, a 24-hour window from its first call |
${L.accountPerMinute > 0 ? `| Per account, per minute | ${n(L.accountPerMinute)} | All tokens of an account together |\n` : ''}${L.ipPer10s > 0 ? `| Per client address | ${n(L.ipPer10s)} per 10 seconds | Every request from one address |\n` : ''}
Token responses tell you where you stand (here with the default budget of a personal token):

\`\`\`http
RateLimit-Limit: ${L.tokenPerMinute}
RateLimit-Remaining: 597
RateLimit-Reset: 42
RateLimit-Policy: ${L.tokenPerMinute};w=60, ${L.dayPersonal};w=86400
\`\`\`

Over a limit you get \`429 rate_limited\` with \`Retry-After\` (seconds) and \`details.retry_after_ms\`;
\`details.quota\` is \`day\` or \`account\` when that budget ran out. Wait and retry — with exponential back-off and
jitter if you run several workers. The [MCP server](#mcp) draws from the same token budget.

**Tips:** read many items in one \`POST /boards/{id}/items/query\` instead of item by item; use the bulk
endpoints to change many items in one call; subscribe to [webhooks](#webhooks) instead of polling.

# Idempotency

Network failures happen. To retry a write safely, send an \`Idempotency-Key\` (any unique string, e.g. a UUID) on
\`POST\`, \`PATCH\`, \`PUT\` or \`DELETE\`:

\`\`\`bash
curl -X POST ${g.apiBase}/boards/$BOARD_ID/items \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Idempotency-Key: 6f1c0d5e-2b8a-4c3f-9e71-0a4d2b5c8e19" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Website redesign"}'
\`\`\`

- The same key with the same body within ${g.idempotencyHours} hours returns the **stored response** (with
  \`Idempotent-Replayed: true\`) instead of running the request again.
- The same key with a **different** body answers \`409 idempotency_conflict\`; while the first request is still
  running, \`409 idempotency_in_progress\`.
- Keys are kept per token (or per person), so two integrations cannot collide. A key is at most 128 characters.
- A rejected request (4xx) is stored and replayed like a success; a server error (5xx) frees the key for a retry.

# Webhooks

A webhook calls your URL when something happens on a board. Create one with
\`POST /boards/{boardId}/webhooks\` (scope \`webhooks\`) or from the board in the app.

**Verification.** When you subscribe, ${p} first POSTs \`{"challenge": "<64 hex characters>"}\` to your URL. Answer
\`200\` with the same JSON within 5 seconds — that proves you own the URL.

**Events:** ${WEBHOOK_EVENTS.map((e) => `\`${e}\``).join(', ')}. Every delivery is a JSON body \`{event: {...}}\`; \`event.type\`
is the event name above.

**Filters.** \`config\` narrows a subscription: \`column_id\` (\`specific_column_changed\`, \`status_changed\`, and
\`subitem_column_changed\` with a sub-board column), \`label\` (\`status_changed\` and \`subitem_column_changed\`: one
status label, by its text), \`column_type\` (\`subitem_column_changed\`: only columns of that type, e.g. \`status\`),
\`group_id\` (\`item_moved_to_specific_group\`) and \`channel\`
(\`automation_sent\`). \`file_added\` takes an optional \`column_id\` (one file column; none = any) and carries
\`event.files\` — the files just added (\`id\`, \`name\`, \`size\`, \`mime\`; a download link is
\`GET /files/{id}\`). \`include_item: true\` adds \`event.item\` — the item with its stored cells (\`{value, text}\`
keyed by column id) — so the receiver needs no second call. With an API token, \`include_item\` needs the
\`boards:read\` scope besides \`webhooks\`.

**Sent from an automation.** \`automation_sent\` is not caused by a change: an automation's "send to integrations"
action sends its item to every \`automation_sent\` subscription of the board (only those with the same \`channel\`
when the subscription names one). This is how a no-code tool (n8n, Make) listens to "when the automation says so".

\`\`\`json
{
  "event": {
    "type": "status_changed",
    "boardId": "01JB…", "itemId": "01JB…", "itemName": "Website redesign",
    "groupId": "topics", "columnId": "status", "columnType": "status",
    "value": { "index": 1 }, "previousValue": { "index": 0 },
    "actor": { "kind": "user", "id": "01JB…", "name": "Dana Levi" },
    "changedAt": "2026-10-06T09:30:00.000Z", "eventId": "01JB…", "subscriptionId": "01JB…"
  }
}
\`\`\`

**Headers and signature.** Each delivery carries \`X-Bines-Event\`, \`X-Bines-Delivery\` (a unique id — use it to
ignore duplicates), \`X-Bines-Timestamp\` and \`X-Bines-Signature: sha256=<hex>\`, the HMAC-SHA256 of
\`timestamp + "." + raw body\` with the webhook's secret. Verify it before trusting the call:

\`\`\`js
import { createHmac, timingSafeEqual } from 'node:crypto';

const verify = (secret, timestamp, rawBody, signature) => {
  const expected = 'sha256=' + createHmac('sha256', secret).update(\`\${timestamp}.\${rawBody}\`).digest('hex');
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};
\`\`\`

\`\`\`python
import hmac, hashlib

def verify(secret: str, timestamp: str, raw_body: bytes, signature: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
\`\`\`

Reject calls whose timestamp is more than a few minutes old.

**Lite signature (no raw body needed).** A receiver that only sees the parsed JSON (no-code tools such as Make) cannot
reproduce the raw bytes, so each delivery also carries \`X-Bines-Signature-Lite: sha256=<hex>\`, the HMAC-SHA256 of
\`timestamp + "." + deliveryId\` (the \`X-Bines-Delivery\` value) with the same secret. It proves the call comes from
${p}; check the timestamp window and ignore a delivery id you have already handled, so it cannot be replayed. A
\`format: "flat"\` subscription carries the same values in the body as well — \`timestamp\` and \`signatureLite\` at the
top, \`event.deliveryId\` in the event — for tools that cannot read headers:

\`\`\`js
const verifyLite = (secret, timestamp, deliveryId, signatureLite) =>
  signatureLite === 'sha256=' + createHmac('sha256', secret).update(\`\${timestamp}.\${deliveryId}\`).digest('hex');
\`\`\`

Prefer the full \`X-Bines-Signature\` when you have the raw body: only it covers the payload.

**Retries.** Answer \`2xx\` within 10 seconds. Otherwise the delivery is retried after
${WEBHOOK_RETRY_MINUTES.map(minutes).join(', ')}; then it is marked dead. After ${WEBHOOK_DISABLE_AFTER_DEAD} dead
deliveries in a row the webhook is switched off. Every delivery is logged
(\`GET /webhooks/{id}/deliveries\`) and can be sent again (\`POST /webhooks/deliveries/{id}/redeliver\`).

**Inbound webhooks** run an automation from outside: \`POST ${g.apiBase}/hooks/in/{automationId}\` with the
automation's secret in the \`X-Bines-Secret\` header (never in the URL).

# Real-time events

For dashboards and live screens, \`GET /boards/{boardId}/events\` and \`GET /me/events\` stream
[Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events). Each event names what changed;
fetch the fresh data when it arrives. Send \`Last-Event-ID\` when you reconnect to receive what you missed. For
server-to-server integrations prefer [webhooks](#webhooks).

# n8n and Make

${p} has ready-made **n8n nodes** and a **Make app**: triggers (they register their own [webhooks](#webhooks)),
actions and searches on boards, items, subitems, updates, files and AI agents — no HTTP requests to build. Both
connect with your **instance URL** \`${g.origin}\` and an [API token](#authentication) (\`/api/v1\` is added for you).
In ${p} the same steps, with your address and a copy button, are under **API tokens**.

**n8n**

1. In n8n open **Settings → Community nodes → Install**.
2. Enter the package name \`${g.integrations.n8n_package}\`, confirm and install.
3. Add the ${p} node to a workflow and create a new credential.
4. Paste the instance URL \`${g.origin}\` and an API token, then save — n8n tests the connection.

**Make**

${makeSteps(g)}

Give the token the scopes your flows need — usually \`boards:read\`, \`items:write\`, \`updates:write\` and
\`webhooks\` for triggers.

# MCP

${p} is also an **MCP server**, so AI apps (Claude, ChatGPT, Cursor, VS Code …) can read and change your boards
with your permissions.

- **Address:** \`${g.origin}/mcp\` (Streamable HTTP).
- **Claude.ai and ChatGPT:** add a custom connector with just the address. The first connection opens an approval
  screen in ${p} (OAuth) — no token to copy.
- **Claude Code, Cursor, VS Code and scripts:** send an API token as \`Authorization: Bearer ${TOKEN_PREFIX}…\`.

\`\`\`bash
claude mcp add --transport http work ${g.origin}/mcp --header "Authorization: Bearer $TOKEN"
\`\`\`

The tools respect the token's scopes; calls count against the same [rate limits](#rate-limits-quotas). \`GET /ai/mcp\`
returns the address and the tools available to you.

## Interactive documents

An item can be shared with a client as a live page (a quote, an agreement, an approval) made from a template of
sections: the client ticks options, asks questions and signs. Over MCP (and for the in-app assistant and agents):

| Tool | Scope | What it does |
| --- | --- | --- |
| \`list_idoc_templates\` | \`boards:read\` | The templates a board may use. |
| \`list_item_idocs\` | \`boards:read\` | An item's documents: status, link, views, signature. |
| \`get_idoc\` | \`boards:read\` | One document as the client sees it: rows, choices, totals. |
| \`create_idoc\` | \`items:write\` | A document for an item from a template or a starter. |
| \`send_idoc\` | \`items:write\` | Emails the link to the client (or marks it sent) — sensitive. |
| \`get_idoc_link\` | \`boards:read\` | The client's link and whether it works now. |
| \`set_idoc_link\` | \`items:write\` | Replace, close or reopen the link. |
| \`get_idoc_events\` | \`boards:read\` | The document's log. |
| \`get_idoc_signature\` | \`boards:read\` | The signature's evidence and the SHA-256 of what was signed. |
| \`get_idoc_pdf\` | \`boards:read\` | The document as PDF: a short-lived download link (signed: with the signature and its certificate). |

## Item templates

An item with its subitems at every depth — values, dates in working days after a date variable, people, text with
\`{variable}\` fields, updates and files — saved on a board and applied as a new item, or as subitems under an item
(its empty cells take the template's values). Over MCP (and for the in-app assistant and agents):

| Tool | Scope | What it does |
| --- | --- | --- |
| \`list_item_templates\` | \`boards:read\` | A board's templates and the variables each one asks for. |
| \`get_item_template\` | \`boards:read\` | One template with its whole tree. |
| \`create_item_template\` | \`boards:write\` | Saves an item (and its subitems) as a template, or makes one from a tree. |
| \`update_item_template\` | \`boards:write\` | Renames it, or replaces its tree / variables (a new version). |
| \`apply_item_template\` | \`items:write\` | A new item with all its subitems, or the subitems under an item — one undo. |
| \`delete_item_template\` | \`boards:write\` | Deletes it (can be undone) — sensitive. |

The same operations are REST endpoints under [Interactive documents](#tag/idocs). The client's link is shown only to
people who may edit the item; a viewer reads documents without it.

# Extensions

To add a board view, data or a server-side integration **inside** ${p}, build an extension: you host the code,
${p} frames it in a sandbox and gives it a short-lived extension token. Extensions use their own SDK
(\`@bines/ext-sdk\`) and starter (\`create-bines-app\`). The extension-token endpoints are documented there, not here:

- [Extensions developer guide](${g.origin}/api/docs/extensions) — the manifest, where extensions appear, permissions,
  the sandbox, the SDK, automation blocks, your own server, publishing and limits.
- [Quickstart](${g.origin}/api/docs/extensions/quickstart) — build your first extension step by step.

# Versioning

The API is versioned in the path (\`/api/v1\`). Adding endpoints, optional fields and response fields is not a
breaking change — ignore fields you do not know. Breaking changes come as a new version.

The full OpenAPI 3.1 document of this reference: [\`openapi.json\`](${g.specUrl}) — import it into Postman,
Insomnia or a code generator.
`;
};

/** The resource groups of the navigation (tag → title and description). Unknown tags fall back to their name. */
export const TAGS: { group: string; tags: { name: string; title: string; description: string }[] }[] = [
  {
    group: 'Workspace structure',
    tags: [
      {
        name: 'workspaces',
        title: 'Workspaces',
        description: 'Top-level spaces that hold folders, boards, docs and dashboards.',
      },
      {
        name: 'folders',
        title: 'Folders',
        description: 'Folders organise boards, docs and dashboards inside a workspace (nested up to three levels).',
      },
      {
        name: 'boards',
        title: 'Boards',
        description:
          'Boards hold items in groups, with typed columns. Includes templates, duplication and moving between workspaces.',
      },
      { name: 'groups', title: 'Groups', description: 'Sections of a board that items belong to.' },
      {
        name: 'columns',
        title: 'Columns',
        description:
          'Typed fields of a board (status, people, date, numbers, relations …). Each item has one cell per column.',
      },
      {
        name: 'views',
        title: 'Views',
        description:
          'Saved views of a board: table, kanban, calendar, timeline, chart, map and more, with filters and sort.',
      },
      {
        name: 'forms',
        title: 'Forms',
        description:
          'Public forms on a board: a form view whose questions are the board’s columns, and the public endpoints its page uses — each submission creates an item.',
      },
      {
        name: 'idocs',
        title: 'Interactive documents',
        description:
          'An item shared as a live page made of sections (a quote, an agreement, an approval): templates, an item’s documents, the public page’s endpoints (choices, questions, one-time code, signing) and signature certificates.',
      },
      {
        name: 'item-templates',
        title: 'Item templates',
        description:
          'An item with its subitems at every depth, saved on a board and applied as a new item or as subitems under an item: values, dates in working days after a date variable, people, text with {variable} fields, updates and files.',
      },
      {
        name: 'permissions',
        title: 'Board permissions',
        description: 'Who may see and edit a board, its columns and its items.',
      },
    ],
  },
  {
    group: 'Work',
    tags: [
      {
        name: 'items',
        title: 'Items',
        description:
          'The rows of a board: create, read, query, change cells, move, duplicate, archive and delete. Subitems are items too.',
      },
      {
        name: 'updates',
        title: 'Updates',
        description: 'The conversation on an item: updates, replies, reactions and the item activity.',
      },
      {
        name: 'files',
        title: 'Files',
        description: 'Upload files with presigned URLs and attach them to items and updates.',
      },
      {
        name: 'time',
        title: 'Time tracking',
        description: 'Timers and time entries on time-tracking columns, and time reports.',
      },
      { name: 'tags', title: 'Tags', description: 'Account-wide tags for the tags column.' },
      { name: 'search', title: 'Search', description: 'Search across boards, items, updates and docs.' },
      { name: 'my-work', title: 'My work', description: 'The items assigned to me across boards.' },
      {
        name: 'docs',
        title: 'Docs',
        description: 'Collaborative documents: content, comments, versions, sharing, import and export.',
      },
      { name: 'dashboards', title: 'Dashboards', description: 'Dashboards and their widgets over one or more boards.' },
    ],
  },
  {
    group: 'History & recovery',
    tags: [
      {
        name: 'activity',
        title: 'Activity & undo',
        description: 'What changed, by whom — and undo / redo of an action or a whole batch.',
      },
      { name: 'archive', title: 'Archive', description: 'Archived boards, groups and items, and restoring them.' },
      {
        name: 'trash',
        title: 'Trash',
        description: 'Deleted things stay in the trash for 30 days and can be restored.',
      },
    ],
  },
  {
    group: 'Automation & integration',
    tags: [
      {
        name: 'automations',
        title: 'Automations',
        description: 'When-this-then-that rules on a board, their runs and test runs.',
      },
      {
        name: 'scenarios',
        title: 'Scenarios',
        description:
          'Automations drawn as a graph on a board: one trigger, then filters, branches, actions and waits — their switch, their runs (each step’s outcome) and test runs.',
      },
      {
        name: 'webhooks',
        title: 'Webhooks',
        description:
          'Signed calls to your URL when something happens on a board, with delivery logs and redelivery. See the Webhooks guide.',
      },
      {
        name: 'inbound-email',
        title: 'Incoming email',
        description:
          'The email address of an item (mail to it becomes an update) or a board (mail to it becomes a new item).',
      },
      { name: 'realtime', title: 'Real-time events', description: 'Server-Sent Event streams for live screens.' },
      { name: 'ai', title: 'AI', description: 'AI connections, AI columns and the account’s AI settings and usage.' },
      {
        name: 'agents',
        title: 'Agents',
        description: 'AI agents ("digital workers") that act on boards: their settings, knowledge, runs and approvals.',
      },
      { name: 'mcp', title: 'MCP', description: 'The account’s MCP server for AI apps.' },
      {
        name: 'geo',
        title: 'Maps & addresses',
        description: 'Map configuration and address lookup for location columns.',
      },
    ],
  },
  {
    group: 'Account & people',
    tags: [
      { name: 'me', title: 'Me', description: 'The identity behind the token and my own preferences.' },
      { name: 'accounts', title: 'Account', description: 'The account and its settings.' },
      {
        name: 'users',
        title: 'Members',
        description: 'People of the account: invite, change roles, deactivate, transfer ownership.',
      },
      { name: 'teams', title: 'Teams', description: 'Teams of members, usable wherever a person can be chosen.' },
      {
        name: 'notifications',
        title: 'Notifications',
        description: 'My notifications and inbox, and notification settings.',
      },
      { name: 'security', title: 'Security', description: 'Account security settings (admins).' },
      { name: 'audit', title: 'Audit log', description: 'Who did what in the account (admins).' },
      { name: 'usage', title: 'Usage', description: 'Account usage over time (admins).' },
      {
        name: 'tidy',
        title: 'Administration',
        description: 'Board administration and scheduled clean-up rules (admins).',
      },
      {
        name: 'help',
        title: 'Help center',
        description: 'The public help center: published help articles and their categories (no sign-in).',
      },
      {
        name: 'legal',
        title: 'Legal documents',
        description: 'The published legal documents — terms, privacy policy and the rest (no sign-in).',
      },
      {
        name: 'pricing',
        title: 'Pricing',
        description:
          'The pricing page as data: the public plans, add-ons, VAT and questions (no sign-in; for your website).',
      },
      { name: 'system', title: 'System', description: 'Health of the service.' },
    ],
  },
];
