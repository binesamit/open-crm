# make-app-bines-os

The **Bines OS** custom app for [Make](https://www.make.com): the same resources as the n8n nodes
(`integrations/n8n-nodes-bines-os`), built as a Make custom app — JSON components only.

**No custom IML functions.** Make turns custom IML functions on only through a support ticket (publishing them
fails with `403 IM002`), so the app uses Make's built-in IML only — `if`, `ifempty`, `get`, `replace`, `trim`,
`sha256`, `createJSON`, `toCollection` … and its operators (`==`, `&&`, `+`). What plain IML cannot express is done by
the Bines OS API, generically (any integration may use it):

| Was a custom function | Now |
| --- | --- |
| `apiBase`, `absoluteUrl` | `replace(replace(trim(url), '/[/]+$/', ''), '/[/]api[/]v1$/', '')` + `/api/v1` / + the local upload path |
| `toCells`, `needsMembers` | `values` on create / update item and subitem: the API converts plain input per column type (same rules as the n8n node; dates with an offset in the person's time zone) |
| `simplifyItem` | `?format=flat` on the item endpoints: items carry `column_values` (cell text by column title) |
| `columnFields` | `GET /boards/{id}/fields` — the column-values form, field per writable column |
| `columnsOf` | `iterate: {container, condition}` over the board schema |
| `labelsOf`, `choiceLabel`, `choiceValue`, `choiceFlag` | `GET …/columns/{col}/choices` + `if` / `ifempty` / `+` in the RPC output |
| `queryBody` | flat `rules` on `items/query` (`{column_id, operator, value, choice}`), `cursor` in `pagination.body` |
| `moveMapping` | `move-to-board` without `mapping`: the server maps the columns (type + title, as the move dialog proposes) |
| `presignBody` | a JSON body with `length(parameters.data)` |
| `hookBody` | the subscription body written per trigger in `spec.ts` (`config.format: "flat"`) |
| `deliveryOf` | a `flat` subscription: the event carries `deliveryId` and `item.column_values`; the trigger outputs `{{body.event}}` |
| `verifyDelivery` | `sha256(timestamp + '.' + deliveryId, 'hex', secret)` compared with `X-Bines-Signature-Lite` (or `signatureLite` in the flat body), plus the 10-minute window — see [Signatures](#signatures) |

The API side needs a prod deploy before the app works against an instance (`values`, `format=flat`, `/fields`,
`rules`, `format: "flat"` webhooks, an optional `mapping`, the lite signature `X-Bines-Signature-Lite`).

- **19 instant triggers** — one per board event (the n8n trigger's events, subitem events included). Each has its own *dedicated, attached*
  webhook: when a person turns the scenario on, Make registers the webhook in Bines OS by itself
  (`POST /boards/{boardId}/webhooks`) and removes it when the webhook is deleted. Nothing to copy.
- **Actions** — create / update / get / archive / delete / duplicate / move an item, create / update / move /
  archive / delete a subitem, post an update, reply, upload a file, create a group, run an AI agent, get a board
  schema.
- **Searches** — search items or subitems (filters + free text, every page), find items or subitems by column value,
  get the subitems of an item, list users, list boards.
- **Make an API call** — any REST call with the same connection.

Column fields are dynamic: once a board is chosen, its columns load from `GET /boards/{id}/schema` and each one
renders in its type (a status shows its labels, people show the members, a checkbox is yes / no …). Subitem modules
take the parent board; their columns come from its sub-board. Columns with predefined values offer them to pick:
the column form (status / dropdown labels, people, tags, connected items), and **Value (pick)** under the column of
"find by column value" and of every search filter (`listValues` → `GET /boards/{id}/columns/{col}/choices`); a typed
value is used when nothing is picked.

## Layout

| Path | What |
| --- | --- |
| `src/spec.ts` | The whole app as data: base, connection, webhooks, RPCs, modules, groups. **Edit this.** |
| `src/build.ts` | Writes `app/` from the spec (`pnpm build`). |
| `app/` | What is uploaded to Make — one JSON file per Make section. Generated, committed, checked by the tests. |
| `src/icon.ts` | Draws the app's icon, `assets/icon.png` (written by the build). |
| `assets/icon.png` | The icon Make shows: 512 × 512 PNG, the Bines OS mark (see [Icon](#icon)). |
| `scripts/push.ts` | Uploads `app/` and the icon with Make's SDK-apps API (dry run by default). |
| `test/app.test.ts` | Validation: `app/` is up to date, every JSON parses, modules link to existing connections / webhooks, every `rpc://` names an RPC, **every `{{name(…)}}` is a Make built-in** (no custom function, no `app/functions`), every expression parses, groups list every module once, the 19 events match n8n, the dry run never calls `/functions`; and the real expressions run through a small IML evaluator (API base, signature check compared with `node:crypto`, subscription bodies, pickers, upload). |

```bash
pnpm --filter make-app-bines-os build      # after changing src/spec.ts
pnpm --filter make-app-bines-os test
pnpm --filter make-app-bines-os typecheck
```

`app/` sections, in Make's terms:

| File | Make section |
| --- | --- |
| `base.json` | Base: `baseUrl` from the connection (trimmed, `/api/v1` added once with `replace`), `Authorization: Bearer <token>`, errors from `body.error.message` with Make error types per status (401 → InvalidAccessToken, 429 → RateLimit …), the token hidden in logs. |
| `connections/binesOs/` | Connection, type *API key*: `baseUrl` (url) + `apiToken` (password); verified with `GET /auth/me` (shows the email). |
| `webhooks/<name>/api.json` | The webhook's communication: answers the subscription challenge (`verification` → `{"challenge": …}`), checks the lite HMAC signature (`condition`, built-in `sha256` with the secret as key), outputs the event (`{{body.event}}`). |
| `webhooks/<name>/parameters.json` | Board (+ column / label / group / channel for the events that take one), *Include the item*, *Verify signature*. |
| `webhooks/<name>/attach.json`, `detach.json` | Subscribe (`{url, event, config}` with the trigger's options and `format: "flat"`; the answer's `id` and `secret` are kept as `externalHookId` / `secret`) and unsubscribe (`DELETE /webhooks/{id}`). |
| `rpcs/<name>/` | `listBoards`, `listGroups`, `listColumns` (optionally one type: `?kind=status` / `?kind=files`; `?subitems=true` for the sub-board), `listLabels`, `listUsers`, `listAgents`, `listValues` (a column's values for pickers; `purpose` = write / find / filter), and `columnFields` — the column values form from `GET /boards/{id}/fields`. |
| `modules/<name>/` | `api` (communication), `parameters` (static), `expect` (mappable), `interface` (output), `samples`. Types: instant trigger 10, action 4, search 9, universal 12. |
| `groups.json`, `readme.md` | The module list's sections and the app's docs page. |

### Value conversion (`values`, on the server)

The API converts (`packages/shared/src/api/integration-values.ts`), with the same rules as the n8n node (`nodes/shared/values.ts`): a status by its label (any case) or id, a dropdown by labels
or ids, people by email, unique name or user id, dates `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM` taken as written (a mapped
Make date is read in the scenario's time zone, so it never shifts a day), timeline `from - to`, numbers, checkbox,
hour `HH:MM`, email / phone / link, any other type from its JSON Schema — and a JSON object is always sent as the raw
stored value. A date with an offset (a mapped Make date) is read in the person's time zone (else the account's), so it
never shifts a day. An unknown label or person answers 422 with a message that names the column and the choices.

### Signatures

Every delivery carries two HMAC-SHA256 signatures with the webhook's secret:

- `X-Bines-Signature: sha256=HMAC(secret, X-Bines-Timestamp + "." + raw body)` — the full one, for consumers that
  read the raw bytes (n8n, code).
- `X-Bines-Signature-Lite: sha256=HMAC(secret, X-Bines-Timestamp + "." + X-Bines-Delivery)` — the lite one. A `flat`
  subscription (this app's) also carries it in the body: `timestamp` and `signatureLite` at the top, `deliveryId` in
  the event.

Make gives the webhook the *parsed* body, never the bytes, and `createJSON(body)` does not reproduce them (key order,
Hebrew / Unicode escaping, number formats) — so the app checks the **lite** signature. Its `condition` (built-in IML
only) takes the timestamp, the delivery id and the signature from the headers, else from the body, the secret from
`parameters.secret` (else `webhook.secret`, where the subscription's answer is kept), and requires
`signatureLite == 'sha256=' + sha256(timestamp + '.' + deliveryId, 'hex', secret)` and a timestamp at most 10 minutes
old. That proves the call comes from Bines OS (only it and Make know the secret); a replay is limited to the window,
and the delivery id is unique per delivery. Unsigned, forged, tampered or stale calls are dropped. *Verify signature*
(advanced) switches the check off per webhook — it should stay on.

### Icon

`assets/icon.png` is the Bines OS mark (the three rounded bars of the n8n nodes' `binesOs.svg`), 512 × 512, drawn by
`src/icon.ts`. Make paints an app's logo with its theme: transparent → the theme colour (#5b5bd6), black → white. So
the bars are black on transparent, and Make shows white bars on #5b5bd6 — the brand mark. `push.ts` uploads it with
`PUT /sdk/apps/{name}/{version}/icon` (raw PNG; POST if PUT is refused with 404 / 405) and checks it with
`GET …/icon/512`.

## Publish to Make (maintainer steps)

Nothing has been sent to Make yet. Publishing needs the maintainer's Make account and approval.

1. **Make API token.** Make → your avatar → **Profile** → **API access** → **Add token**, scopes `sdk-apps:read` and
   `sdk-apps:write`. Note your zone — the start of your Make address (`eu1`, `eu2`, `us1`, `us2`).
2. **Dry run** (sends nothing, prints every call):
   ```bash
   cd integrations/make-app-bines-os
   node scripts/push.ts
   ```
3. **Push:**
   ```bash
   MAKE_API_TOKEN=<token> MAKE_ZONE=eu1 node scripts/push.ts --apply
   ```
   It creates the app (Make gives it a name such as `bines-os-xxxxxx` — printed and saved in `.make-app.json`, which
   is git-ignored), the connection, the base, 19 webhooks, the RPCs, every module, the groups and
   the docs. Running it again updates the same app. To push into an app you already made in the web editor, add
   `MAKE_APP_NAME=<its name>`.
   - If the groups call is refused, open the app in Make → **Modules** → **Groups** and paste `app/groups.json`.
4. **Try it** in a Make scenario: add **Bines OS → Watch Status Changed**, create a connection (your Bines OS address +
   a token with `boards:read`, `items:write`, `updates:write`, `webhooks`, `users:read`, `boards:write`,
   `agents:run`), pick a board, turn the scenario on, change a status. Then run **Create an Item** with a few columns.
   Check in Make's **DevTool** that the first delivery passed the signature check (*Verify signature* on).
5. **Make it public.** In the app → **Visibility**: *Public* (anyone with the link can install it). For the Make app
   directory, **Review** → submit (Make reviews the app: docs page, icon, module names, test account). The icon
   is pushed by the script (`assets/icon.png`); if the icon check fails, upload that file in the app's **General**
   tab.

### Without the script (VS Code)

The **Make Apps Editor** extension for VS Code (`Integromat.apps-sdk`) edits the same sections: create the app in
Make, open it in the extension, and paste each `app/…` file into the section of the same name (Base, Connection →
Communication / Parameters, Webhook → Communication / Parameters / Attach / Detach, RPC → Communication / Parameters,
Module → Communication / Static parameters (`parameters.json`) / Mappable parameters (`expect.json`) / Interface /
Samples). The script does exactly this through the API.

## Open questions (to check on the first push)

- **The webhook secret in the webhook's context.** Make documents that `attach`'s `response.data` is kept as the
  webhook's data; the check reads `parameters.secret`, else `webhook.secret`.
- **Upload a file.** The PUT to the presigned URL must not carry the API token. Make adds the base's headers to every
  request; if storage refuses the PUT ("only one auth mechanism"), the module needs Make's base-inheritance override.
- **Groups endpoint.** Make's API reference lists no groups endpoint; the script tries `PUT …/groups` and otherwise
  asks to paste them in the editor.
- **OAuth 2.** The connection is an API key today. Bines OS's OAuth server serves the MCP audience only;
  an OAuth connection for Make would be a follow-up.
