# AI security review — Bines OS

This document records a red-team review of the AI features of Bines OS — the MCP server, agents, AI columns and the
in-app assistant — for contributors, self-hosters and security researchers. It is a historical audit of the code as
it was in October 2026: every finding below was fixed in the code with a regression test, and section 4 lists the
risks that remained at the time. Finding ids (AI-RT1 …) are cited from source comments, so they are stable.

Scope: the MCP server (`/mcp`, tokens + OAuth), agents (runs, approvals, triggers, knowledge), AI columns
(`modules/ai2`), the assistant panel, `packages/server-ai`, and the tool registry and runners. Method: a red team — a
scripted model plays the attacker (making exactly the calls a "convinced" or compromised model would make) against the
real code, plus manual code review. Related audits: [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md),
[`EXTENSIONS-SECURITY-REVIEW.md`](EXTENSIONS-SECURITY-REVIEW.md).

## Summary

**What was tested:** every way to "persuade" the AI to do harm — malicious instructions inside cells, updates, files,
board names and agent knowledge; exfiltration (webhook, email, downloading a file from an internal server address);
exceeding permissions (an agent touching a board it was not given, the assistant of a viewer writing, a guest,
restricted columns, an "only my items" board); reaching another account through each of the 35 tools; bypassing
approvals; bypassing the budget and limits; leaking AI keys and tokens; flooding (huge input, a "bomb" file);
malicious HTML in answers; and that every AI action is logged and can be undone. In total, 37 new automated tests (2
files).

**Found and fixed (13 findings, none critical):**

- **High — 3:** (1) an agent given "edit" by its creator could edit *every* item on the board even when the creator
  may edit only items assigned to them; (2) a model could "ride" an approval: approving a harmless action (a comment)
  also ran a delete sent under the same id; (3) an autonomous agent (and MCP with "block sensitive tools") could create
  an automation that sends board data to an external webhook or email without approval — an exfiltration channel that
  stays active.
- **Medium — 6:** someone who only views a board could mention an agent and have it write for them; text from a cell
  went into the *task* of an agent started by an automation (instead of being treated as data); automation secrets
  (headers, signing secret, hook URL) reached the model through MCP tools, and an automation's default title contained
  the full webhook URL; a flood of dozens of tool calls in one turn; approving after expiry; two concurrent approvals
  in the assistant ran an action twice.
- **Low — 4:** runs started at the same moment bypassed the daily run quota; keys / tokens inside an error message
  were not scrubbed from logs and error reports; a DOCX "bomb" could crash the server; a few rare internal addresses
  (6to4, Teredo, `localhost.`) passed the SSRF check.

**What remained (not bugs — decisions / follow-ups):** the MCP policy for sensitive tools is only "allow / block" (no
"only with approval in Bines"); the budget can be exceeded by one call per concurrently running run; a manual check
against a real model per model version (needs a key). Details in section 4.

---

## 1. Scope and method

| Surface | Code |
|---|---|
| MCP server | `apps/api/src/modules/mcp/*` (Bearer `bos_pat_` / `bos_svc_` / OAuth `bos_oat_`), `modules/oauth/*` |
| Tool registry + runners | `packages/shared/src/ai/tools/*`, `apps/api/src/modules/ai/tools/runners.ts` |
| Agents | `modules/agents/*` — `engine/loop.ts` (tool-use loop, approvals, limits), `engine/context.ts` (actor, boards), `triggers.ts` (mention / assign), `runs.service.ts` (runs, approvals), `knowledge*` |
| AI columns + assistant | `modules/ai2/*` |
| AI connections, budget | `modules/ai/ai.service.ts`, `packages/server-ai` |
| Outbound | `apps/api/src/lib/outbound.ts` (SSRF guard), `files.service.ts` `attachFromUrl` |

**Method.** A scripted Anthropic client (`AnthropicLike`) replaces the model. It plays the attacker: each turn it emits the
tool calls a compromised or prompt-injected model would emit (deletes, other boards, other accounts' ids, repeated
tool-use ids, floods, HTML, outbound URLs). Every assertion is about what the *platform* allows — the model is assumed
hostile. DNS and sockets are faked for the SSRF cases; no test reaches the network or spends money.

**Tests:** `apps/api/test/ai-redteam.test.ts` (30 cases) and `apps/api/test/ai-redteam-ssrf.test.ts` (7 cases), plus the
existing AI suites they build on (`agents*.test.ts`, `ai2-*.test.ts`, `mcp*.test.ts`, `mcp-oauth.test.ts`).

## 2. Findings (all fixed, each with a regression test)

| id | sev | area | finding | fix | test |
|---|---|---|---|---|---|
| AI-RT1 | high | agents / privilege | An agent's "edit" level was checked against `item.update` of its creator. A creator who is an `assigned_contributor` (may edit only items assigned to them) passes that check, so the agent became a full `contributor` — editing every item the creator cannot. Same gap in the run-time re-check. | `canEditAllItems()` (`shared/permissions/board.ts`): "edit" needs a creator who may edit *every* item. Used in `checkBoards` (403 `agent_board_exceeds_creator`) and `effectiveAgentBoards` (lowered to view at the next run). | "an agent never edits more than its creator" |
| AI-RT2 | high | agents / approvals | Decisions were looked up by `tool_use_id` only. A model turn with two calls under one id (or a later turn reusing an approved id) ran the second call — e.g. `delete_item` — on the approval given for the first (`create_update`). | The loop refuses repeated ids (in a turn or across the run: the run ends `duplicate_tool_use_id`), and a decision must match the tool **and** the canonical input a person saw (`approval_mismatch`). | "a repeated tool-use id…", "an id approved in an earlier turn…" |
| AI-RT3 | medium | agents, assistant / DoS | No cap on tool calls per model turn: one turn (16k output tokens) can hold ~200 writes, all run in autonomous mode. | `MAX_TOOL_USES_PER_TURN = 20` (agents) / `MAX_ASSISTANT_TOOL_USES_PER_TURN = 20`; the rest get an error `tool_result` (`too_many_tool_calls`) and never run. | "a flood of tool calls in one turn" |
| AI-RT4 | medium | automations → agents / injection | `run_agent` rendered `{item.…}` variables into the prompt that becomes the trusted `<task>`; a cell value saying "ignore your instructions…" became part of the task. | The task is the automation's template as written; the filled-in text is passed as `<untrusted_content source="automation">`. | `agents-2.test.ts` "an automation starts the agent…" (updated) |
| AI-RT5 | medium | approvals | An approval past `expires_at` could still be approved until the hourly expiry job ran. | `decideApproval` refuses (`409 approval_expired`) and expires due approvals; the run is told it expired. | "forged, foreign and expired approvals…" |
| AI-RT6 | medium | assistant / approvals | Two "approve" requests for the same proposed action at the same time both read it as pending and both ran it. | Approved actions are claimed first with a compare-and-swap on the message (`swapMessageActions`); a stale claim → `409 actions_changed`; a failed batch releases the claim. | "two approvals of the same action at once run it once" |
| AI-RT7 | low | secrets / logs | Logs and error reports (GlitchTip / Sentry) scrubbed emails only; an error text quoting a key (`sk-ant-…`), a token (`bos_pat_…`) or a bearer value would be stored. Pino had no redaction for `apiKey` / `keyEnc`. | `lib/scrub.ts` `scrubSecrets` in `scrubEvent` (message + exception values) and in the logger's `err` serializer; more pino redact paths. | "error reports and logs mask keys…" |
| AI-RT8 | medium | automations / secrets to models | `list_automations`, `create_automation` and `test_automation` (dry-run rendering) returned webhook headers, signing secrets and full hook URLs to a model for anyone who may manage the automation (admins' MCP clients included). The default **title** (the recipe as a sentence) also carried the full hook URL — to every board reader in the app as well. | AI tools always return the redacted recipe / rendering (`redactRecipe`), titles via `redactTitle`; the sentence shows only the URL's origin; non-managers get redacted titles in the API too. | "automation secrets never reach a model…" |
| AI-RT9 | high | exfiltration | `create_automation` / `set_automation_active` are ordinary writes: an autonomous agent (or an MCP client with sensitive tools blocked) could create / switch on an automation that sends board data to any webhook or email address — a persistent exfiltration channel outside the approval / sensitive policy. | `callTool()` (`ai/tools/risk.ts`): a recipe with `webhook` / `send_email` makes the call **sensitive** — agents wait for approval in every mode; MCP and the assistant refuse it when the account blocks sensitive tools. | "an agent: an automation that sends data out waits…", "MCP with sensitive tools blocked…", "the assistant does not even propose…" |
| AI-RT10 | medium | agents / confused deputy | Anyone who can comment on a board (a board viewer, an account viewer when comments are allowed) could mention an agent with edit rights and have it write for them. Only guests were handled. | A mention / assignment by someone who may not `item.update` the board marks the run `untrusted_requester`: every write waits for a person (like a guest's run). | "a mention by someone who may only view the board…" |
| AI-RT11 | low | knowledge / DoS | DOCX extraction unzipped `word/document.xml` at its declared size; a few-MB "zip bomb" declaring gigabytes could exhaust memory. | Refused when the declared size is over `DOCX_MAX_XML_BYTES` (64 MB) — before allocation (`payload_too_large`). | "a DOCX zip bomb is refused…" |
| AI-RT12 | low | budget / quota | The day quota was a count-then-insert: runs started at the same moment (a burst of mentions, a bulk change firing `run_agent`) all passed it. | Count + insert under a per-agent `pg_advisory_xact_lock`. | "runs started at the same moment…" |
| AI-RT13 | low | SSRF | `isPrivateIp` did not decode 6to4 (`2002:a9fe:a9fe::` = 169.254.169.254) or block Teredo (`2001::/32`); `localhost.` / `metadata.google.internal.` (trailing dot) skipped the name check (the IP check still caught them after DNS). | 6to4 is decoded and checked as IPv4; Teredo blocked; trailing dots stripped before the name check. | `ai-redteam-ssrf.test.ts` |

## 3. Checks that held (no change needed)

| Category | What the attacker tried | Result | Where tested |
|---|---|---|---|
| Prompt injection — data channel | Instructions in an item name, a cell, an update, a knowledge note, a board name | Never in `system`; only inside `tool_result` blocks or `<untrusted_content>` (closing tag defused). Following them hits code-enforced limits. | redteam "hostile data…", "a board name…" |
| Injection → act outside | `update_item` on a board not given, `create_update` with another account's item | `not_found` (the board / account does not exist for the agent) | redteam |
| Injection → delete | `delete_item` in autonomous mode | Sensitive → waits for approval; cancelled → nothing deleted | redteam, `agents.test.ts` |
| Outbound | Any tool that reaches the network | Only `attach_file_from_url` (sensitive). Agents (contributors) cannot manage automations at all. | redteam |
| SSRF | Metadata / loopback / private in decimal, hex, octal, short, IPv4-mapped, NAT64, IPv6 ULA; redirects into the network; redirect loops; DNS rebinding; oversized answer | Refused; every redirect hop re-checked; the dialled address is the checked address; answer over the cap refused | `ai-redteam-ssrf.test.ts`, `mcp-tools-extra.test.ts` |
| Privilege — agent | No boards; a "view" board; a board its creator loses | Sees nothing / cannot write / lowered at the next run | redteam, `agents.test.ts` |
| Privilege — assistant | A member on a view-only board, a restricted column, an "own items" board; a viewer; a guest | Runs as the person: actions fail, items hidden, viewers/guests get read tools only, guests see only shareable boards | redteam, `ai2-assistant.test.ts` |
| Privilege — MCP | Guest token (inserted directly), viewer, board-limited token | Guest 403, viewers read-only, board limit enforced | redteam, `mcp*.test.ts` |
| Cross-account | Every one of the 35 registry tools called by another account's admin (scope `admin`) with the ids of the test account ("Acme") | Every id tool → `not_found` / `forbidden`; no Acme name in any answer; nothing changed. The test fails when a new tool has no case. | redteam "…from any tool" |
| Cross-account — agents / assistant | Another account's ids in tool calls; runs, approvals, conversations, messages by id | `not_found` / 404 | redteam, `agents.test.ts` |
| Approvals | Forged id, another account's admin, a member who does not manage the agent, viewer, guest; deciding twice | 404 / 409 | redteam |
| Learner / autonomous | Writes in learner mode; sensitive in autonomous mode | Wait for a person | `agents.test.ts` |
| Limits | Endless tool loop; huge tool answer; over-long prompt / message | `limit_steps`; `result_too_large` (200 KB, the answer is never sent); 400 | redteam, `agents.test.ts` |
| Recursion | agent → automation → agent; AI column ↔ automation ↔ agent | Depth ≤ 5 (skipped `max_depth`); AI columns never auto-run on agent / automation / AI writes | redteam, `agents-2.test.ts`, `ai2-columns.test.ts` |
| Budget | Monthly budget used up; per-run $; runs a day | Runs `skipped:quota_*`, calls refused `ai_budget_exceeded` | `agents.test.ts`, `ai2-*.test.ts` |
| Secrets | Asking the model for the key; scanning every request, transcript, tool result and API answer; a provider error that quotes the key | The key is never sent or returned (AES-GCM at rest, write-only, `key_hint`); provider errors stored as codes (`invalid_api_key`) | redteam |
| OAuth / MCP tokens | PKCE, wrong audience, refresh replay, code replay, revocation | Refused / connection revoked; no token passthrough (`authInfo.token = 'redacted'`) | `mcp-oauth.test.ts` |
| DoS | 3,000-deep JSON in a cell; a 2 MB tool call; over-long prompts | Refused (`isError` / ≥ 400, body cap 1 MB); the server keeps answering | redteam |
| Output handling | `<img onerror>`, `<script>`, `javascript:` from a model in updates, mention replies and link cells | Escaped HTML; link URLs must be http(s). The web app has no `dangerouslySetInnerHTML` in the assistant, agents, AI admin or cells (a test fails if one appears). | redteam |
| Audit | Agent, MCP and assistant writes | `actor_type = agent` + `meta.agent {agent_id, run_id}` / `meta.via = mcp` / `meta.via = ai`; every write in a batch; each batch undoes; agent create/update, AI settings and connections in `audit_log` (no key) | redteam, existing suites |

## 4. Remaining risks and recommendations

1. **MCP sensitive policy is allow / block only.** The original design also called for an "only with approval in Bines" mode. With the default
   `allow`, an MCP client may delete (to trash), move items across boards, fetch URLs and create outbound automations
   without an in-app approval (clients see `destructiveHint` and usually ask the user). Recommendation: implement the
   approval mode (reuse `agent_approvals`) or default new accounts to `block`.
2. **Budget overshoot is bounded, not zero.** The monthly budget and per-run dollars are checked before each model call,
   so concurrent runs / columns / chats can each finish one in-flight call past the limit (≤ one call of `max_tokens`
   16k each). A reservation-based budget would close it.
3. **External clients can be injected too.** Data returned by MCP tools can steer Claude.ai / ChatGPT; we cap what they
   can do (the user's rights ∩ scopes ∩ boards) and mark destructive tools, but the external model's behaviour is
   outside the platform's control. The server instructions say data is never an instruction.
4. **Old automation titles in the activity log.** `automation.created/updated` events keep the title they had; titles
   written before AI-RT8 may include a full webhook URL and are shown in board activity. Low; a one-off title
   rewrite (or redaction in the activity DTO) would clean it.
5. **Agents and "own items" boards.** On a `view_items = assigned_or_created` board an agent sees items assigned to the
   agent itself — someone assigned it, so it is intended; its transcript is visible to its managers.
6. **Assistant history replay.** Each message replays the whole conversation; per-message dollars and messages a day
   bound it, but one very long conversation makes every new message expensive. Consider trimming / summarising.
7. **PDF extraction** runs pdf.js on a ≤ 20 MB upload in a job; a hostile PDF can be slow (job-level timeout only).
8. **Real-model check.** The plan calls for one manual run per model version with the injection fixtures against a real
   model (`AI_SMOKE=1`, needs a key). The automated suite proves enforcement, not model behaviour.

## 5. How to run

```
pnpm --filter @bines/api exec vitest run test/ai-redteam.test.ts test/ai-redteam-ssrf.test.ts
```

New tools: the cross-account case enumerates `AI_TOOLS` and fails until the new tool gets an input there; outbound
action types belong in `OUTBOUND_ACTION_TYPES` (`packages/shared/src/ai/tools/risk.ts`).
