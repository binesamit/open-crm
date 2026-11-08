# 04 — Automations (rules engine)

This document specifies the automation engine: the recipe JSON format, the trigger, condition and action registries,
template variables, the execution model (dispatch, runs, loop protection, schedules) and the automations UI. It is for
developers extending the engine or writing recipes through the API, MCP or seed files.

Binding inputs: [`DECISIONS.md`](DECISIONS.md) (D5: automations are data; D2: graphile-worker; D6: permissions
enforced in the service layer; D21: the engine runs in the api process). Sample recipe files:
`packages/shared/test/fixtures/seed-automations/`.
Column value shapes and per-type filter operators are defined in [`03-COLUMN-TYPES.md`](03-COLUMN-TYPES.md); this doc
references them and never redefines them. UI labels are given in English (the UI is also available in Hebrew); all
identifiers, JSON, endpoints and code are English.

> Stored `conditions` are the query model's `FilterGroup` ([13-FILTERS](13-FILTERS.md)). The §1.2 condition list
> below is the seed / legacy input that `normalize.ts` converts (sugar operators → filter rules; creation log / last
> updated → `__created_at__` / `__updated_at__`). The dispatcher, the runner and the actions' `run` side live in the
> api process (D21), not in `apps/worker`, so actions use the same services as the HTTP routes.

Code layout:

```
packages/shared/src/automations/
  schema.ts            # zod: Recipe, Trigger, Condition, Action (section 1) — the authoritative schema
  triggers.ts          # trigger registry (section 2)
  conditions.ts        # condition evaluation (section 3)
  actions.ts           # action registry metadata (section 4)
  template.ts          # {item.x} template engine (section 4.3)
  date-expr.ts         # date expressions (set_date, templates)
  computed.ts          # expressions for set_computed
  normalize.ts         # legacy seed aliases → canonical (section 1.4)
  templates.ts         # the builder's template catalogue (section 8.1)
apps/api/src/modules/automations/
  automations.routes.ts / automations.service.ts / automations.repo.ts   # CRUD, runs, test (see 06-API.md)
  jobs.ts              # graphile-worker tasks: automation.dispatch, automation.run, webhook.deliver
  engine/runner.ts     # dispatch + run: conditions, actions, automation_runs
  engine/actions.ts    # the actions' run side
  engine/schedules.ts  # schedule rows → synthetic events
apps/web/src/features/automations/   # automations screens (section 8)
```

---

## 1. Recipe JSON schema

### 1.1 Shape (what lives in seed recipe files and in the `automations` table)

```jsonc
{
  "id": "L2",                                   // seed id (string) ; in DB: automations.id + seed_key
  "board": "leads",                             // seed: board key or "@portal:{client}" ; DB: board_id
  "title": "Move won/lost leads to Closed",     // optional; defaults to recipe
  "recipe": "When Status changes to Won or Lost, move item to Closed",   // human sentence, always kept
  "trigger":    { "type": "status_changed", "column": "status", "labels": ["Won", "Lost"] },
  "conditions": [ { "column": "payment", "operator": "not_any_of", "values": ["Paid"] } ],
  "actions":    [ { "type": "move_to_group", "group": "closed" } ],
  "is_active": true,
  "kind": "automation",                         // automation | integration (billing/quota bucket only)
  "note": null,                                 // free text for humans
  "mcp_prompt": "Trigger: ...\nConditions: ...\nActions:\n- ..."   // export only (section 7)
}
```

Every object may carry an extra `"text"` field (the sentence fragment shown in the builder); it is display-only and ignored by the engine.

### 1.2 Zod schema (abridged)

The authoritative schema is `packages/shared/src/automations/schema.ts`; it also defines the triggers and actions
that this abridged version omits (they are described in §2 and §4.2 — e.g. `subitem_column_changed`,
`extension_trigger`, `flow_failed`, `set_computed`, `send_sms`, `generate_image`, `run_agent`). Column references
there are `columnRef` (a column key).

```ts
import { z } from "zod";

export const columnId = z.string().regex(/^[a-z_][a-z0-9_]{0,39}$/);      // our ids: [a-z_]{1,20}; imported ids keep digits
export const groupRef  = z.string().min(1);                               // group id or "@top" | "@bottom"
export const boardRef  = z.string().min(1);                               // seed key, "@portal:{client}", "@self", or uuid
export const peopleRef = z.union([
  z.literal("@creator"), z.literal("@actor"), z.literal("@owner"), z.literal("@board_owners"),
  z.literal("@subscribers"), z.literal("@mentions"),
  z.string().regex(/^column:[a-z_][a-z0-9_]*$/),                           // people column on the item
  z.string().regex(/^mirror:[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/),         // relation column . column on linked item
  z.string().regex(/^user:[0-9a-f-]{36}$/), z.string().regex(/^team:[0-9a-f-]{36}$/),
  z.string().email(),
]);
export const timeHHMM  = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const weekday   = z.enum(["sun","mon","tue","wed","thu","fri","sat"]);

// ---------- triggers ----------
export const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item_created") }),
  z.object({ type: z.literal("item_created_in_group"), group: groupRef }),
  z.object({ type: z.literal("status_changed"), column: columnId,
             labels: z.union([z.literal("any"), z.array(z.string()).min(1)]).default("any"),
             from_labels: z.array(z.string()).optional() }),
  z.object({ type: z.literal("column_changed"), column: columnId }),
  z.object({ type: z.literal("date_arrived"), column: columnId,
             offset_days: z.number().int().min(-365).max(365).default(0),     // + after, - before
             time: timeHHMM.default("09:00") }),
  z.object({ type: z.literal("date_arrives_before"), column: columnId,
             days: z.number().int().min(1).max(365), time: timeHHMM.default("09:00") }),
  z.object({ type: z.literal("every_time_period"),
             period: z.enum(["hour","day","week","month"]), time: timeHHMM.default("09:00"),
             weekday: weekday.optional(), day_of_month: z.number().int().min(1).max(28).optional(),
             scope: z.enum(["board","each_item"]).default("each_item") }),
  z.object({ type: z.literal("item_moved_to_group"), group: z.union([groupRef, z.literal("any")]).default("any") }),
  z.object({ type: z.literal("checkbox_checked"), column: columnId, state: z.enum(["checked","unchecked"]).default("checked") }),
  z.object({ type: z.literal("button_clicked"), column: columnId }),
  z.object({ type: z.literal("update_posted"), contains: z.string().optional() }),
  z.object({ type: z.literal("subitem_created") }),
  z.object({ type: z.literal("subitem_status_changed"), column: columnId,
             labels: z.union([z.literal("any"), z.array(z.string()).min(1)]).default("any"),
             all_subitems: z.boolean().default(false) }),                  // true = fire on parent when ALL subitems have label
  z.object({ type: z.literal("connected_items_all_done"), column: columnId,  // board_relation column on this board
             done_column: columnId.optional(),                             // status col on the linked board; default: its first status col
             done_labels: z.array(z.string()).optional() }),               // default: labels flagged is_done
  z.object({ type: z.literal("person_assigned"), column: columnId, who: z.union([z.literal("any"), peopleRef]).default("any") }),
  z.object({ type: z.literal("number_threshold"), column: columnId,
             operator: z.enum(["greater_than","greater_than_or_equals","lower_than","lower_than_or_equal"]), value: z.number() }),
  z.object({ type: z.literal("item_archived") }),
  z.object({ type: z.literal("item_deleted") }),
  z.object({ type: z.literal("item_restored") }),
  z.object({ type: z.literal("webhook_in"), secret: z.string().min(16).optional(), // always set on save (S-11)
             item_lookup: z.object({ column: columnId, path: z.string() }).optional() }),   // map payload → existing item
]);

// ---------- conditions ----------
export const ConditionOperator = z.enum([
  "any_of","not_any_of","is_empty","is_not_empty",
  "greater_than","greater_than_or_equals","lower_than","lower_than_or_equal","between",
  "contains_text","not_contains_text","contains_terms","starts_with","ends_with",
  "within_the_next","within_the_last","older_than_days","newer_than_days",
  "is_checked","is_not_checked","is_overdue","is_today","is_past","is_future",
]);
export const Condition = z.object({
  column: z.union([columnId, z.literal("name"), z.literal("group"), z.literal("__creation_log__"), z.literal("__last_updated__")]),
  operator: ConditionOperator,
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).default([]),
  compare_attribute: z.enum(["START_DATE","END_DATE"]).optional(),   // timeline
  text: z.string().optional(),
});
export const ConditionGroup = z.object({ operator: z.enum(["and","or"]).default("and"), rules: z.array(Condition).min(1) });

// ---------- actions ----------
const tmpl = z.string();                                                   // template string, see §4.3
const cellValue = z.unknown();                                             // typed per column in 03-COLUMN-TYPES.md
const dateExpr = z.string().regex(/^(today|now|clear|column:[a-z_][a-z0-9_]*)([+-]\d+[dwm])?(@([01]\d|2[0-3]):[0-5]\d)?$/);
const mapping  = z.record(columnId, columnId);                             // targetColumn: sourceColumn
const fixed    = z.record(columnId, z.unknown());                          // targetColumn: value or template

export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_status"), column: columnId, label: z.string() }),
  z.object({ type: z.literal("set_column"), column: columnId, value: cellValue }),
  z.object({ type: z.literal("set_date"), column: columnId, value: dateExpr }),
  z.object({ type: z.literal("set_item_name"), name: tmpl }),
  z.object({ type: z.literal("increment_number"), column: columnId, by: z.number().default(1) }),
  z.object({ type: z.literal("clear_column"), column: columnId }),
  z.object({ type: z.literal("move_to_group"), group: groupRef }),
  z.object({ type: z.literal("move_to_board"), board: boardRef, group: groupRef.optional(), mapping: mapping.optional(),
             subitem_mapping: mapping.optional() }),
  z.object({ type: z.literal("create_item"), board: boardRef, group: groupRef.optional(), name: tmpl.default("{item.name}"),
             mapping: mapping.optional(), fixed: fixed.optional(),
             connect_column: columnId.optional(),            // relation column ON THE SOURCE item that will point to the new item
             connect_back_column: columnId.optional() }),    // relation column ON THE NEW item pointing back (default: auto two-way)
  z.object({ type: z.literal("create_subitem"), name: tmpl, fixed: fixed.optional(), mapping: mapping.optional() }),
  z.object({ type: z.literal("duplicate_item"), with_updates: z.boolean().default(false), group: groupRef.optional(), name: tmpl.optional() }),
  z.object({ type: z.literal("archive_item") }),
  z.object({ type: z.literal("delete_item") }),
  z.object({ type: z.literal("assign"), column: columnId, who: peopleRef, mode: z.enum(["add","replace"]).default("add") }),
  z.object({ type: z.literal("unassign"), column: columnId, who: z.union([peopleRef, z.literal("all")]) }),
  z.object({ type: z.literal("notify"), to: z.union([peopleRef, z.array(peopleRef)]), message: tmpl }),
  z.object({ type: z.literal("send_email"), to: z.union([peopleRef, z.array(peopleRef)]), subject: tmpl, body_html: tmpl,
             reply_to: z.string().email().optional(), attach_files_column: columnId.optional() }),
  z.object({ type: z.literal("webhook"), url: tmpl, method: z.enum(["POST","PUT"]).default("POST"),
             payload: z.union([z.literal("item"), z.record(z.unknown())]).default("item"),   // "item" = full snapshot; object = template
             headers: z.record(z.string()).optional(), secret: z.string().optional() }),
  z.object({ type: z.literal("start_time_tracking"), column: columnId }),
  z.object({ type: z.literal("stop_time_tracking"), column: columnId }),
  z.object({ type: z.literal("create_update"), body: tmpl }),
  z.object({ type: z.literal("connect_items"), column: columnId, target: z.enum(["created","trigger_item"]).default("created"),
             item_id: tmpl.optional() }),
  z.object({ type: z.literal("run_extension"), block: z.string(), input: z.record(z.unknown()).optional() }),
]);

// ---------- recipe ----------
export const Recipe = z.object({
  id: z.string().min(1),
  board: boardRef,
  title: z.string().max(120).optional(),
  recipe: z.string().min(1).max(500),
  trigger: Trigger,
  conditions: z.array(z.union([Condition, ConditionGroup])).default([]),    // top level = AND
  actions: z.array(Action).min(1).max(20),
  is_active: z.boolean().default(true),
  kind: z.enum(["automation","integration"]).default("automation"),
  note: z.string().nullable().optional(),
  mcp_prompt: z.string().optional(),
  owner_user_id: z.string().uuid().optional(),
});
export type Recipe = z.infer<typeof Recipe>;
export const RecipeFile = z.object({ $schema: z.string().optional(), module: z.string(), automations: z.array(Recipe) });
```

### 1.3 DB table (`automations`, detail in 02-DATA-MODEL.md)

| column | type | notes |
|---|---|---|
| id | ulid pk | |
| account_id | ulid | |
| board_id | ulid null | the board the trigger listens on; null = account-level (e.g. flow triggers) |
| seed_key | text null | `"L2"` etc. for idempotent re-seeding |
| title | text | |
| recipe | jsonb | `{ trigger, conditions, actions }`, validated by the zod schema on every write |
| is_active | bool | |
| owner_id | ulid | actions needing a human context (email sender name, permissions) use the owner; deactivating a user deactivates their automations |
| created_from_template_id | ulid null | the account automation template it was made from |
| run_count, last_run_at, last_error_at, consecutive_errors | | denormalized for the list; 20 consecutive errors switch it off (§5.7) |
| deactivated_reason | text null | why the engine switched it off |
| note | text null | free text for humans |
| revision | int | `If-Match` |
| created_by, created_at, updated_at, deleted_at | | |

`automation_schedules` (section 5.6) holds cron rows for `every_time_period`, `date_arrived`, `date_arrives_before`.

### 1.4 Legacy aliases accepted by `normalize.ts` (seed compatibility)

The seed files use a few shorthand forms. The loader rewrites them to the canonical schema before validation; the API also accepts them on `POST /automations` and stores the canonical form.

| seed form | canonical |
|---|---|
| `{"type":"assign_creator","column":X}` | `{"type":"assign","column":X,"who":"@creator"}` |
| `{"type":"gmail_send",...}` | `{"type":"send_email",...}` (`body` → `body_html`) |
| `{"type":"time_tracking_start"/"time_tracking_stop"}` | `start_time_tracking` / `stop_time_tracking` |
| `{"type":"mcp","tool":"task.inherit_account"}` | `{"type":"run_extension","block":"mcp:task.inherit_account"}` (accepted but not run; use `copy_from_linked` instead) |
| `{"type":"date_arrives_before","days":7}` | unchanged (canonical keeps `days`) |
| `labels:"any"` | unchanged |
| `{"column":"<creation_log column>", "operator":"older_than_days"}` | unchanged |
| `set_date value "today+3d"` | unchanged |
| `notify to "@owner"` | `@board_owners` |
| `fixed: {"account":"{item_id}"}` | `{"account":"{item.id}"}` |
| template `{item name}`, `{creator}`, `{Status}` (a column title) | `{item.name}`, `{creator}`, `{item.<id of the column titled Status>}` (resolved per board at load) |
| `board: "@portal:{client}"` | expanded by the seeder into one automation per client portal board |

Loader: `apps/api/scripts/seed-automations.ts` reads the recipe files of the directory in `SEED_AUTOMATIONS_DIR` (optional; none ship with the repository), resolves `board` keys through `seed/templates/*.json` → created board ids, resolves `{client_item_id}` / `{portal board}` placeholders per client, normalizes, validates, upserts by `(account_id, seed_key)`.

---

## 2. Trigger registry

Each trigger is an entry of the registry in `packages/shared/src/automations/triggers.ts`. The shape below is the
conceptual interface (the code's `TriggerDef` also carries a category and column-type filters for the builder):

```ts
export interface TriggerDef<Cfg> {
  type: string;
  configSchema: z.ZodType<Cfg>;
  /** which activity_log event types can satisfy this trigger (empty = scheduled only) */
  events: ActivityEventType[];
  /** cheap in-memory match against the event; runs before loading the item */
  match(cfg: Cfg, ev: ActivityEvent, ctx: { board: BoardMeta }): boolean | Promise<boolean>;
  /** scheduled triggers: compute next fire time(s) */
  schedule?(cfg: Cfg, board: BoardMeta): CronSpec;
  /** sentence fragment for the builder (localized) */
  sentence(cfg: Cfg, board: BoardMeta): string;
  /** columns types allowed in `column` (for the builder) */
  columnTypes?: ColumnType[];
  /** what the trigger exposes to templates beyond the item (e.g. previous_value, update) */
  outputs: string[];
}
```

| type | fires on activity event | config | notes |
|---|---|---|---|
| `item_created` | `item.created` (depth 0 only) | — | includes items created by API, form, import, email, automations (subject to loop rules §5.4). Not fired on duplicate-with-items board copies, restore, or move-to-board arrivals (those fire `item.moved_to_board`). |
| `item_created_in_group` | `item.created` where `group_id` matches | `group` | |
| `status_changed` | `cell.changed` on a `status` column | `column`, `labels` (`"any"` or list), optional `from_labels` | Match by label text (case-sensitive, trimmed). `any` also fires on clear → label `""`. Exposes `{previous_value}`. |
| `column_changed` | `cell.changed` on any column (not `name`) | `column` | Fires when the normalized value actually differs (service layer compares JSON after canonicalization). Not supported for read-only computed types (`formula`, `mirror`, `auto_number`, `creation_log`, `last_updated`, `progress`, `item_id`). `columns` (also on `subitem_column_changed`): every column heard — a change in any of them fires it; `column` is the first. |
| `date_arrived` | scheduled (`schedule.fired`) | `column` (date/timeline), `offset_days` (negative = before), `time` | One schedule row per (automation, item) with a non-empty date; recomputed on every cell change of that column. For timeline, `compare_attribute` defaults to `END_DATE` (configurable via `column: "timeline_col#start"`). Fires once per item per value; editing the date re-arms. |
| `date_arrives_before` | scheduled | `column`, `days`, `time` | Sugar for `date_arrived` with `offset_days: -days`; kept for seed/import parity. |
| `every_time_period` | scheduled | `period` hour/day/week/month, `time`, `weekday`, `day_of_month`, `scope` | `scope: each_item` (default) runs conditions+actions per non-archived item of the board (paged 500/batch) — the "every day, if X then Y" semantics. `scope: board` runs once with no item context (actions limited to `create_item`, `webhook`, `notify`, `send_email`, `run_extension`). |
| `item_moved_to_group` | `item.moved_to_group` | `group` or `any` | Not fired for arrivals from another board. |
| `checkbox_checked` | `cell.changed` on `checkbox` | `column`, `state` | |
| `file_added` | `file.added` (an upload, a file attached from a link, an AI-made image) | optional `column` (a `file` column; unset = any file column of the board) | The event carries `meta.column_key`. An automation never hears files it added itself. |
| `button_clicked` | `button.clicked` | `column` | The button column has no value; clicking emits an event with `actor`. The button's `settings.automation_ids` is derived (UI lists automations bound to it). |
| `update_posted` | `update.created` (not replies; `reply.created` separate) | optional `contains` substring | Exposes `{update.body}`, `{update.author}`. Automation-created updates do not re-trigger (§5.4). |
| `subitem_created` | `item.created` with `depth ≥ 1` | — | Registered on the **parent board**; item context = the subitem, `{parent.*}` available. |
| `subitem_status_changed` | `cell.changed` on a subitem's status column | `column`, `labels`, `all_subitems` | Item context = parent item when `all_subitems: true` (fires when every non-archived subitem matches), else the subitem. |
| `connected_items_all_done` | `cell.changed` on the **linked** board's `done_column`, plus `link.changed` on this board | `column` (board_relation here), `done_column`, `done_labels` | Dispatcher follows back-links: an event on board B reaches the items of other boards whose relation columns point at B. Fires on the transition to all-done. |
| `person_assigned` | `cell.changed` on `people` where `added` non-empty | `column`, `who` | Fires once per added person; `{assignee}` exposed. |
| `number_threshold` | `cell.changed` on `numbers` / formula output / mirror-number | `column`, `operator`, `value` | Fires only on crossing (previous did not satisfy, new does). |
| `item_archived` / `item_deleted` / `item_restored` | `item.archived` / `item.deleted` / `item.restored` | — | Actions on the item itself are limited to `notify`, `webhook`, `send_email`, `create_update` (on a deleted item: none of the write actions). |
| `webhook_in` | `webhook_in.received` | `secret`, `item_lookup` | Inbound URL: `POST /api/v1/hooks/in/:automation_id` (no session; the automation's secret in the `X-Bines-Secret` header is required — generated on save when left empty; `?secret=` is refused, S-11). Payload available as `{payload.*}`. If `item_lookup` resolves an item, the run has item context; else board-only context (same action limits as `scope: board`). Rate limit 60/min per automation; 20 failed attempts per 10 min per address and per automation, then 429. |
| `subitem_column_changed` | `cell.changed` on the sub-board | `column` / `columns` (sub-board column keys or `name`), `level` | Item context = the subitem. `level` (`any` / `subitem` / `sub_subitem`, also on the other subitem triggers) picks which depth of the sub-board is heard (D14). |
| `extension_trigger` | an installed extension fires `<extension>.<feature>` with a signed call to `POST /automations/triggers/:block/fire` | `block`, `with_item`, `inputs?` | D27. The call's `payload` is `{payload.*}`; with `with_item` its `item_id` is the run's item. `inputs` = values the payload must carry under the same keys (none = every fire). |
| `flow_failed` / `flow_recovered` | the flow connections' failure check (Administration → Flows: n8n / Make / Zapier) | `connection` (an id or `any`), `flow?` | An external flow failed, or ran fine again after failing. Account-wide, on every board whose active automation listens; board-level runs; templates read `{flow.*}`. |

Not in the list on purpose: `item_name_changed` is covered by `column_changed` with `column: "name"`; a form submission
fires `item_created` (the event's `meta.via` is `form`).

---

## 3. Condition operators per column type

Conditions reuse the filter operators of the column registry (`packages/shared/src/columns/defs/<family>.ts`, see 03-COLUMN-TYPES.md) plus five automation-only sugar operators. The engine evaluates a condition by calling `columnDef.filterOps[operator].test(cellValue, values, ctx)`; the same function serves `items/query`. `values` for status/dropdown are **label texts** (not indexes) so recipes survive label reordering; the engine resolves text→index at eval time.

| column type | operators |
|---|---|
| `name`, `text`, `long_text`, `email`, `link`, `phone`, `location`, `country` | `any_of`, `not_any_of`, `is_empty`, `is_not_empty`, `contains_text`, `not_contains_text`, `contains_terms`, `starts_with`, `ends_with` |
| `status`, `dropdown`, `tags`, `color_picker` | `any_of`, `not_any_of`, `is_empty`, `is_not_empty` |
| `numbers`, `rating`, `auto_number`, `item_id`, `vote`, `progress`, `formula` (numeric output), `time_tracking` (seconds) | `any_of`, `not_any_of`, `is_empty`, `is_not_empty`, `greater_than`, `greater_than_or_equals`, `lower_than`, `lower_than_or_equal`, `between` |
| `date`, `timeline` (`compare_attribute`), `creation_log`, `last_updated`, `week`, `hour` | `any_of` (values `["EXACT","2026-10-15"]` or dynamic `TODAY|TOMORROW|YESTERDAY|THIS_WEEK|THIS_MONTH|PAST_DATETIME|FUTURE_DATETIME|UPCOMING|OVERDUE`), `not_any_of`, `is_empty`, `is_not_empty`, `greater_than`, `lower_than`, `between`, `within_the_next` (`["DAYS"|"WORKDAYS"|"WEEKS"|"MONTHS", n]`), `within_the_last`, `older_than_days` (`[n]`), `newer_than_days`, `is_overdue`, `is_today`, `is_past`, `is_future` |
| `people` | `any_of` (`"user:<id>"`, `"team:<id>"`, `"@actor"`, `"@creator"`, `"@me"` only in UI filters), `not_any_of`, `is_empty`, `is_not_empty` |
| `checkbox` | `is_checked`, `is_not_checked` (aliases of `is_not_empty` / `is_empty`) |
| `board_relation`, `dependency` | `any_of` (item ids or templates like `{client_item_id}`), `not_any_of`, `is_empty`, `is_not_empty`, `contains_text` (on linked item names) |
| `mirror` | operators of the mirrored type, evaluated on the computed value |
| `file`, `doc` | `is_empty`, `is_not_empty` |
| `group` (pseudo column) | `any_of`, `not_any_of` with group ids |
| `subtasks` (pseudo) | `is_empty`, `is_not_empty`, `all_done`, `greater_than` (count) |
| `button`, `integration`, `world_clock` | not allowed in conditions |

Semantics: a missing cell behaves as empty. `any_of` with `values: []` is a validation error. Top-level conditions are AND; a `ConditionGroup` nests one level of OR (`{operator:"or", rules:[...]}`), matching the `groups` of the items query (06-API.md §2). Conditions are always evaluated against a **fresh snapshot** loaded after the event (§5.3), never against the event payload.

---

## 4. Action registry

### 4.1 Interface

Conceptual interface; the metadata lives in `packages/shared/src/automations/actions.ts` and the run side in
`apps/api/src/modules/automations/engine/actions.ts`.

```ts
export interface ActionDef<Cfg> {
  type: string;
  configSchema: z.ZodType<Cfg>;
  /** true when the action needs an item in context */
  needsItem: boolean;
  /** does this action write through the service layer (and therefore emit events)? */
  writes: boolean;
  /** quota bucket: "automation" | "integration" (webhook, send_email, run_extension) */
  bucket: "automation" | "integration";
  run(cfg: Cfg, ctx: RunContext): Promise<ActionResult>;   // ActionResult = { ok, output?, skipped?, error? }
  sentence(cfg: Cfg, board: BoardMeta): string;
  /** builder metadata: which column types fit `column`, which refs are legal for `to`/`who` */
  columnTypes?: ColumnType[];
}
export interface RunContext {
  account_id: string; automation: Recipe; run_id: string; depth: number;
  actor: SystemActor;                     // { kind: "automation", id, display: "Automation: <title>" }
  services: Services;                     // same ItemService/UpdateService/... the API uses
  item?: ItemSnapshot; board: BoardMeta;  // trigger item, fresh
  event: ActivityEvent; vars: TemplateVars;
  outputs: { created_item?: ItemSnapshot; created_subitem?: ItemSnapshot; }  // written by earlier actions in the same run
}
```

### 4.2 Catalogue

| type | config | effect (through service layer) | notes / validation |
|---|---|---|---|
| `set_status` | `column`, `label` | `cells.set(item, column, {label})` | Label must exist on the column (validated at save; at run time a missing label → action error `LABEL_NOT_FOUND`, no auto-create). Allowed column types: `status`. |
| `set_column` | `column`, `value` | `cells.set` with a value in that column type's write shape (03-COLUMN-TYPES.md). Strings may contain templates. | Rejected for read-only types. For `dropdown` with unknown labels: created if `settings.allow_create_labels`, else error. |
| `set_date` | `column`, `value` | date expression: `today`, `now`, `clear`, `today+3d`, `today-1w`, `column:date_x+2d`, `today@14:00`, `column:timeline#end+1m` | Units d/w/m (calendar) and h (hours — `now+4h`, an SLA; on a plain date whole days only). Evaluated in the **account time zone**. `timeline` column: sets `to`; `from` kept or set equal if empty. |
| `set_item_name` | `name` (template) | `items.rename` | max 255 chars after rendering |
| `increment_number` | `column`, `by` | read fresh value, write `value + by` | Concurrency: service uses `UPDATE ... SET value = value + :by` via jsonb numeric, no read-modify-write race. |
| `set_computed` | `column`, `expression`, `round?`, `on_empty?` | the expression (the formula column's language and engine, `computed.ts`) evaluated on a fresh snapshot as the owner reads it → the result written to `column` (numbers / text / long text / date / hour), which stays a plain, hand-editable column | References: `{key}` the item, `{parent.key}` its parent, `{relation.key}` the first linked item (`#sum` / `#avg` / `#min` / `#max` / `#count` over all of them), `{key\|1}` a default for an empty cell, `{timeline#end}`. `round` = digits after the point. `on_empty` when a referenced value is empty without a default, there is no result (÷0) or the column cannot hold it (a word into a number): `skip` (default), `clear`, `zero`. A referenced column that is gone → `column_not_found` (structural, the automation switches off). Dates: `ADD_DAYS({job_date}, 3)`. Unchanged → `skipped`. Example (a service line, a subitem): trigger `subitem_column_changed` with `columns: ["service","qty"]`, action `{"type":"set_computed","column":"planned_minutes","expression":"{qty\|1} * {service.min_per_unit}","round":2}`. |
| `clear_column` | `column` | `cells.clear` | |
| `move_to_group` | `group` | `items.moveToGroup` | `@top` / `@bottom` accepted. If the item is already there → `skipped`. |
| `move_to_board` | `board`, `group?`, `mapping?`, `subitem_mapping?` | `items.moveToBoard` (07-OPERATIONS.md §3.4) | Mapping is `{target: source}`; missing mapping → auto-map by type+title (case-insensitive). Unmapped columns' data is dropped (warning shown in the builder at save time). Subsequent actions in the same run operate on the moved item (new board context). |
| `create_item` | `board`, `group?`, `name`, `mapping?`, `fixed?`, `connect_column?`, `connect_back_column?` | `items.create` on target board with cells = mapping (type-compatible copy, §6.2) ⊕ fixed (templates rendered) ; then relations | `board: "@self"` = same board. Result stored in `ctx.outputs.created_item` for `connect_items` and templates `{created.id}`. |
| `create_subitem` | `name`, `fixed?`, `mapping?` | `items.create` with `parent_item_id = item.id` | Fails if parent at `depth 5`. |
| `create_item_from_template` | `board`, `template`, `group?`, `variables?`, `connect_column?`, `connect_back_column?` | item templates: `applyItemTemplate` on `board` (its first group by default) — the whole tree, values, updates, files; then the relations. One batch for the action (one undo: the tree and the links). | `template` must be a template of `board` the saver may read (checked on save). `variables` = `{template question: trigger item column or name}`: a date question ← date / timeline, a person ← people (persons only), text ← any column's text; unset = the question's default. A required question with no answer → `skipped: missing_variables: <question>`; too deep for the board → `skipped: too_deep`; a deleted template → error `item_template_not_found` (structural: the automation is switched off). Board-level runs allowed (no answers from an item). |
| `add_template_subitems` | `template`, `variables?` | `applyItemTemplate` with `parent_item_id = item.id`: the template's subitems (every depth) under the trigger item; the item's empty cells take the template's values. One batch. | A template of the automation's board. No subitems in the template → `skipped: template_has_no_subitems`. Same answers / skips as above. |
| `duplicate_item` | `with_updates`, `group?`, `name?` | `items.duplicate` | Duplicate goes right below the source (or to `group`). |
| `archive_item` | — | `items.archive` | |
| `delete_item` | — | `items.delete` (→ trash) | A run that deletes its own item stops after this action (later actions `skipped: ITEM_GONE`) unless they are `notify`/`webhook`/`send_email`. |
| `assign` | `column`, `who`, `mode` | `cells.set` on people column | `who`: `@creator`, `@actor`, `@board_owners`, `user:`, `team:`, `column:<people col>` (copy from another column), `mirror:<relation>.<people col>`. `mode: add` (default) merges; `replace` overwrites. |
| `unassign` | `column`, `who` | | |
| `send_sms` | `column` (phone), `template?` (id of an account SMS template) or `message` | SMS through the account's SMS provider, logged as an update with source `sms` | Runs as the owner: the account's "who may send SMS" (`settings.sms.send_policy`) applies to the owner's role; counts against the account's daily SMS budget (not the owner's hourly one). Empty cell → `skipped: no_phone`; a number the provider cannot reach → error `sms_unsupported_number`. Integration bucket. |
| `notify` | `to`, `message` | `notifications.create` per resolved user (in-app bell + per-user email digest settings) | Recipients resolved: people columns (persons + team members, dedup), `@board_owners`, `@subscribers`, `@mentions` (users @mentioned in the rendered message), `@creator`, `@actor`, email literal → **not** allowed (use `send_email`). The actor of the original event is excluded only when the recipient list came from `@actor`-free refs and `settings.notify_self = false` (default false — "don't notify me of my own actions"). Each recipient counts as one action. Notification links to the item. |
| `send_email` | `to`, `subject`, `body_html`, `reply_to?`, `attach_files_column?` | the account's mail transport via `email.send` | `to`: email columns (`column:email_x`), `mirror:relation.email_col`, user refs (their account email), literal addresses. From: the `EMAIL_FROM` address with the automation owner's name; `reply_to` defaults to owner's email. HTML body sanitized (allow-list). Body templates get `{item.url}`. Max 20 recipients per action. |
| `webhook` | `url`, `method`, `payload`, `headers?`, `secret?` | enqueue `webhook_deliveries` row (same pipeline as board webhooks, 06-API.md §webhooks: HMAC header, retries) | `payload: "item"` sends the standard event envelope with full item snapshot; object payload is rendered recursively with templates (string values only). URL may contain `{item.<col>}`. Private/loopback IPs blocked (SSRF guard). Timeout 10s. `secret` overrides the automation's default signing secret. |
| `start_time_tracking` / `stop_time_tracking` | `column`, `who?`, `fallback?` | Whose timer: `@actor` (whoever made the change; the default for new automations), `column:<people>` (each person in it), `user:<id>`, `@automation_owner`; stop also `@all` (every running timer in the column). **Unset `who` = the automation owner** (recipes saved before the option; never rewritten). Each target acts with their own rights. | Start when already running → `skipped`. Stop when not running → `skipped`. `@actor` counts only `user` / `api` changes (an API token / MCP = the token's user; the AI panel writes as the user). A form, schedule, email, another automation, an agent (its service user is not a person who tracks time) or a webhook has no person → `fallback` people column, else `skipped: no_person_made_the_change`. Guests (`guest`), viewers / no edit rights (`no_edit_rights`), no access to the board (`no_board_access`), restricted column (`column_restricted`), left the account (`not_an_active_member`) → skipped with the reason (per person in `output.skipped` when others succeeded). Someone else's timer (not the owner's, not the person who made the change) needs the column's `allow_other_users`. |
| `create_update` | `body` | `updates.create` as the system actor, body rendered (Markdown→HTML) | Marked `source: automation` so `update_posted` triggers ignore it (§5.4). |
| `connect_items` | `column`, `target`, `item_id?` | `links.add(item, column, targetItem)` | `target: created` links to `ctx.outputs.created_item`; `trigger_item` links the created item back to the trigger item (used when `connect_column` lives on the created item's board); `item_id` template for arbitrary ids. Two-way relation columns update both sides automatically (03-COLUMN-TYPES.md board_relation). |
| `copy_from_linked` | `relation`, `source`, `column` | the first item linked through `relation` → its `source` cell (a column key of the linked board, or `name`) converted to `column`'s type → `items.update` | E.g. copy the client from a task's linked project. Skipped when nothing is linked / the source is empty / unchanged. |
| `run_agent` | `agent`, `prompt` | `createAgentRun` (AI agents, D26): `prompt` rendered over the item is the task; the item goes to the agent as `<untrusted_content>` data. `trigger: schedule` when the automation fires on a clock, else `automation`. | The automation's owner must manage the agent (checked on save and on run). Skipped `self_trigger` when the event was written by that agent's own run; the run carries the chain depth, so agent → automation → agent stops at depth 5. Not a write of the automation itself (the agent writes as itself). |
| `generate_image` | `column` (file), `prompt` (template), `source_columns?`, `source_count?`, `when_no_source_image?`, `style_examples?`, `photo_mode?`, `variations?`, `fidelity?`, `fidelity_base_column?`, `size?`, `quality?`, `connection?`, `model?` | An image described by `prompt`, made by the account's image model (Administration → AI & MCP) or by `connection` / `model`, saved as a new file in `column` | Needs the plan's `ai` feature. `generate_image` takes optional `source_columns` (file columns of the item, in order; the first version's single `source_column` still works and sends its newest image): their PNG / JPEG / WebP images are the pictures the new one starts from (image to image), in column order — `source_count` `"all"` (default) or the newest N of each; when the model takes fewer, the newest go (the run's output says `source_images: {sent, total}`); with several columns the prompt gets a line naming which images came from which column. No image there → `when_no_source_image`: `"text"` (default) makes it from the description only, `"skip"` skips the action (`no_source_image`). Style examples: `style_examples: { column, filter?, count? }` — the newest `count` (default 3, 1–10) images of the file column `column` on OTHER items of the board that match `filter` (the board filter model, e.g. status = Approved; none = any item with an image there), read as the automation's owner (items, or a column, the owner can't read are left out). They go first, before the item's own photos, with a line "Images 1–N are approved examples of the required style (from «…»). Follow their style."; they take the model's image limit first, the item's photos fill the rest, and `source_images` counts both (`examples` = how many were examples). None match → runs as without them. `photo_mode` `"each"` (one image per source photo, a separate charged call each) / `"together"` (unset = together; the builder sets `each` when photos are first picked on an action), `variations` 1–4 per call (the provider's `n` up to the account's per-call cap, then repeated calls), `fidelity` `"close"` (keep the composition and colours of the starting picture) / `"locked"` (an approved base — the newest image of `fidelity_base_column`, a file column of the item, else the newest style example — goes first as the picture to edit, the item's photo as the subject; the prompt keeps everything of the base and swaps only the figure; no base → close, with `fidelity_no_base` in the run's warnings; prompt guidance only, no masks). The action always adds new files (it keeps no record of earlier designs to version); the output says `calls` when there were several. |
| `send_document` | `template`, `send` | Interactive documents: the item's document from `template` (the open one made from it earlier, else a new one); with `send` its link is emailed to the document's contact | See [`INTERACTIVE-DOCUMENTS.he.md`](INTERACTIVE-DOCUMENTS.he.md) (Hebrew). |
| `set_parent_column` | `column`, `value` | Sets a column of the trigger item's parent (subitems, D14) | `value` = a value or template, like `set_column`. |
| `set_subitems_column` | `column`, `value`, `where?` | Sets a column on each direct subitem of the item | `where` = a filter over the sub-board's columns. |
| `copy_from_parent` / `copy_to_parent` / `copy_to_subitems` | `source`, `column`, `where?` (to subitems) | Copies `source` (a column key or `name`) between the item and its parent / its direct subitems, converted to the target column's type | |
| `send_to_integrations` | `channel?` | Sends the item to every integration subscribed to the board's `automation_sent` webhook event (an n8n / Make trigger registers it when its workflow is switched on) | `channel` lets a subscription receive only these actions. |
| `run_extension` | `block`, `input?` | An installed extension's action (D27): `block` = `<extension>.<feature>`; a signed POST to the extension's server with the item and the rendered `input` | Failed calls are retried twice with backoff (`EXT_RETRY_TASK`), each attempt recorded in the run. The old seed alias `mcp:<tool>` is accepted but not run. Counts as an integration action. |

Everything that writes goes through the same `Services` the API uses → permission checks apply to the **system actor**, which has `edit_everything` on the automation's board and on target boards where the automation **owner** has at least `edit_content`. If the owner lacks rights on a target board (e.g. cross-board create), the action fails with `FORBIDDEN_FOR_OWNER` and the automation is flagged in the Manage list; it is not silently run as admin. Guests may own automations only on shareable boards they are subscribed to and only with actions targeting that board.

### 4.3 Template variables (`template.ts`)

Syntax: `{path}` and `{path|helper:arg|helper}`. Unknown paths render as empty string and add a `warning` to the action log. Escaping: `{{` renders a literal `{`.

| variable | value |
|---|---|
| `{item.name}`, `{item.id}`, `{item.url}`, `{item.group}` (title), `{item.group_id}`, `{item.created_at}`, `{item.creator}` (name) | trigger item (or the parent for `all_subitems`) |
| `{item.<column_id>}` | the column's `toText()` rendering (03-COLUMN-TYPES.md) — e.g. status label, `"Dana Cohen, Noa"` for people, `2026-10-15` for date |
| `{item.<column_id>.raw}` | JSON value as string |
| `{item.<column_id>.<field>}` | typed sub-field: `.email`, `.url`, `.from`, `.to`, `.number`, `.label`, `.index`, `.ids`, `.first` |
| `{item.<relation_col>.<col_on_linked>}` | first linked item's column text (`mirror:` semantics); `{item.<relation_col>.*.<col>}` joins all with `, ` |
| `{parent.*}` | parent item (subitem triggers) |
| `{created.*}`, `{created_subitem.*}` | items created earlier in this run |
| `{board.name}`, `{board.id}`, `{board.url}`, `{workspace.name}` | |
| `{creator}`, `{actor}` | display names; `{actor.email}`, `{actor.id}` |
| `{previous_value}`, `{new_value}` | status/column triggers (text) |
| `{update.body}`, `{update.author}`, `{update.url}` | update_posted |
| `{payload.<json.path>}` | webhook_in / form_submitted |
| `{today}`, `{now}`, `{today+3d}`, `{today|date:DD/MM/YYYY}` | account time zone |
| `{automation.title}`, `{run.id}` | |

Helpers: `|date:<fmt>` (dayjs tokens; default per account setting), `|upper`, `|lower`, `|trim`, `|truncate:80`, `|default:—`, `|number:2` (fixed decimals), `|currency:ILS`, `|json` (JSON-encode, for webhook object payloads), `|url` (encodeURIComponent), `|first`, `|join:, `, `|plus:3d` / `|minus:1w` (dates), `|html` (escape; default on in `body_html`/update bodies for item values — `|raw` disables).

Rendering of `{item.<column>}` where `column` is a column **title** (seed files may use `{Status}`) is resolved to the column id at save time by the normalizer; stored recipes never carry titles.

---

## 5. Execution model

### 5.1 Pipeline

```
API / UI / import / inbound email / form / scheduler
        │  (any write goes through Services)
        ▼
 activity_log row  ──INSERT trigger──▶  graphile-worker job "automation.dispatch" (payload: event_id)
        │                                           │
        │                                           ▼
        │                               dispatcher: load event + board, select active automations
        │                               on that board whose trigger.events ∋ event.type, run match()
        │                                           │  for each matched automation
        │                                           ▼
        │                               job "automation.run" (payload: event_id, automation_id, item_id, depth)
        │                                           │
        │                                           ▼
        │                               runner: fresh item snapshot → conditions → actions (sequential,
        │                               through Services as actor automation:<id>) → automation_runs
        └── also feeds SSE, webhooks, notifications
```

Jobs (graphile-worker, registered by the api process): `automation.dispatch`, `automation.run`, `automation.schedule_tick` (every minute) and `webhook.deliver`. Concurrency is `AUTOMATION_CONCURRENCY` (default 4).

The activity_log → job hand-off is a Postgres trigger (`AFTER INSERT ON activity_log FOR EACH ROW EXECUTE graphile_worker.add_job('automation.dispatch', json_build_object('event_id', NEW.id))`) so that no write can be lost between the API transaction and the queue: the event and the job are committed atomically. Events of kind `automation.*`, `webhook.*`, `notification.*` are excluded by a `WHEN` clause.

### 5.2 Event shape (`activity_log`, see 02-DATA-MODEL.md)

```jsonc
{ "id": "evt_01J...", "account_id": "...", "board_id": "...", "item_id": "...", "parent_item_id": null,
  "type": "cell.changed",                       // item.created|item.renamed|cell.changed|item.moved_to_group|item.moved_to_board|
                                                // item.archived|item.deleted|item.restored|item.duplicated|link.changed|update.created|
                                                // reply.created|button.clicked|group.*|column.*|board.*|schedule.fired|webhook_in.received
  "column_id": "status", "column_type": "status",
  "value": {"index":1,"label":"Won"}, "previous_value": {"index":0,"label":"New"},
  "actor": {"kind":"user","id":"..."} ,          // or {"kind":"automation","id":"...","run_id":"...","depth":2} | {"kind":"api","token_id":"..."} | {"kind":"system"}
  "source": "ui|api|automation|form|import|email|webhook_in|scheduler",
  "batch_id": "...",                             // batch actions / imports share one id (used by undo)
  "created_at": "2026-10-01T08:12:33.120Z" }
```

### 5.3 Runner algorithm (`runner.ts`)

1. `SELECT ... FOR UPDATE SKIP LOCKED` the `automation_runs` row created by the dispatcher with `(event_id, automation_id)` unique → idempotency: a redelivered job finds the row in state `done`/`running` and exits.
2. Load the automation (must still be `is_active`; else mark run `skipped:inactive`).
3. Load a **fresh** item snapshot (`items.getSnapshot(item_id, { cells: true, parent: true, links: 1 })`). If the item was deleted meanwhile and the trigger is not `item_deleted` → `skipped:item_gone`.
4. Evaluate conditions (§3) against the snapshot. Not matched → run state `skipped:conditions`, with the first failing condition recorded (`run.log[0]`), and the run is kept for the history view but excluded from quota.
5. Build `RunContext` with the system actor `{kind:"automation", id, run_id, depth: event.actor.depth+1 || 1}`.
6. For each action, in order: render templates → `action.run()` inside its own transaction → append `{index, type, status: ok|error|skipped, duration_ms, output, error}` to `run.log`. **Independent actions continue after a failure.** Dependent ones (`connect_items` with `target: created` after a failed `create_item`, any item action after `delete_item`/`move_to_board` failure) are marked `skipped:dependency`.
7. Finish: `status = succeeded | partial | failed | skipped`, `finished_at`; the automation's run count, last run and consecutive-error count are updated.
8. Writes performed by actions produce their own `activity_log` rows with `actor.kind = automation` → they are dispatched again (that is how chains work) subject to §5.4.

### 5.4 Loop protection

| rule | value | behaviour |
|---|---|---|
| Max depth | depth > 5 | dispatcher does not dispatch; logs `automation_runs` row `skipped:max_depth` on the automations that would have matched |
| Self re-trigger | same `automation_id` on the same `item_id` within **10 s** of its previous run start, inside an automation chain | `skipped:self_loop` |
| Runs per item | the same automation already ran **60** times on the same item in the last minute (any depth) | `failed` with error `run_limit` in the run history |
| Own writes | an automation never triggers on an event written by itself | hard rule |
| Chain tracking | every write made by a run carries `{run_id, chain}` (the runs it came from); agent runs carry their depth too, so agent → automation → agent chains stop at the same depth | used for the depth limit and to find the first human in a chain |
| Scheduled fan-out | `every_time_period` with `scope: each_item` on boards > 10,000 items | runs in pages of 500 as separate jobs; items touched by an earlier page's actions are not reconsidered in the same tick |

### 5.5 Idempotency

`automation_runs` has `UNIQUE (event_id, automation_id)`. The dispatcher inserts rows with `status: queued` before enqueueing the run job; a duplicate insert (job retried after a crash) is a no-op (`ON CONFLICT DO NOTHING`), and the runner refuses to execute a row not in `queued`. Action-level idempotency is per action: `create_item` records the created id in `run.log[i].output.item_id` before the transaction commits (same transaction), so a crash mid-run leaves either no item or a logged one; on resume the runner starts at the first action without a log entry.

### 5.6 Scheduled triggers (`automation_schedules`)

```sql
create table automation_schedules (
  id uuid primary key, account_id uuid, automation_id uuid, item_id uuid null,   -- null for every_time_period
  kind text,                 -- 'date' | 'period'
  fire_at timestamptz,       -- next fire, UTC (computed from account tz)
  value_hash text,           -- hash of the date value that produced fire_at (date kind)
  fired_at timestamptz null,
  unique (automation_id, item_id)
);
create index on automation_schedules (fire_at) where fired_at is null;
```

- `every_time_period`: one row per automation; after each fire `fire_at` advances by the period. Hourly → minute `0` of each hour; day/week/month → `time` in the account tz (`account_settings.timezone`, default `Asia/Jerusalem`). DST handled by recomputing in local time.
- `date_arrived` / `date_arrives_before`: on every `cell.changed` of the watched column (and on `item.created`, `item.restored`, `item.moved_to_board` arrivals) the service upserts the row with `fire_at = date + offset_days @ time` and `fired_at = null` when `value_hash` changed; empty date → row deleted. A date in the past at upsert time (e.g. set yesterday's date) fires **immediately once** only if `offset_days ≤ 0` and the date is within the last 24h; older → not fired ("When date arrives" does not fire for past dates).
- `automation.schedule_tick` (every minute): `UPDATE ... SET fired_at = now() WHERE fire_at <= now() AND fired_at IS NULL RETURNING *` in batches of 1,000 → inserts a synthetic `activity_log` row `type: schedule.fired` per row (`item_id` set for date kinds) → normal dispatch. Missed ticks (worker down) catch up on restart; `every_time_period` rows older than 2 periods fire once, not N times.
- Pausing an automation (`is_active = false`) keeps the rows but the dispatcher skips; deleting removes them. Archiving an item removes its date rows; restore recomputes.

### 5.7 Failure semantics and surfacing

- Per action status in the run's action log; `status: partial` when at least one action succeeded and one failed.
- Transient errors (DB timeout, webhook 5xx / timeout, mail provider 429) are retried where the pipeline supports it: webhooks via the `webhook_deliveries` backoff (06-API.md), extension calls twice more with backoff; other actions are not retried (the user re-runs from the run history, "Run again" = new run with the same event).
- Error classes: `VALIDATION` (bad label, column deleted), `PERMISSION` (`FORBIDDEN_FOR_OWNER`), `NOT_FOUND` (target board/group deleted), `RATE_LIMIT`, `EXTERNAL` (webhook/email/extension), `INTERNAL`.
- After **20 consecutive errored runs** (`too_many_errors`), or on a structural error — `column_not_found`,
  `group_not_found`, `board_not_found`, `label_not_found`, `agent_not_found`, `item_template_not_found` — the automation
  is switched off with `deactivated_reason`, and the automations list shows why, with a way to open the builder and
  fix it (the builder re-validates columns and labels on open). Deactivating a user switches off the automations they
  own (`owner_deactivated`).

### 5.8 Usage

`GET /automations/usage` (Administration, §8.3) reports runs per day by outcome, the actions carried out and the
scheduled triggers due soon. There is no hard monthly cap by default; the loop rules in §5.4 exist to stop runaway
chains.

---

## 6. Cross-board recipes and connect semantics

### 6.1 Board references in recipes

`board` in `move_to_board` / `create_item` is a board id in the database. The builder lists boards the **owner** can
edit. The seed / template form keeps symbolic keys (`"tasks"`, `"@portal:{client}"`, `"@self"`). When a board is
duplicated or saved as a template, cross-board actions keep pointing at the original target board (`@self` points at
the copy). When the target board is gone, the action fails with `board_not_found`, which switches the automation off
(§5.7).

### 6.2 `mapping` and `fixed` for `create_item` / `move_to_board`

- `mapping: { "<target_column>": "<source_column>" }`. Copy is type-aware via `columnDef.fromText(targetDef.toText(value))` when types differ, raw JSON copy when types match. Allowed pairs beyond identical types: `status→status` (by label text; missing label → error unless target `allow_create_labels`), `text↔long_text`, `numbers→text`, `date→timeline` (`from=to=date`), `timeline→date` (`end`), `people→people` (same account), `email→text`, `board_relation→board_relation` only if the target column points at the same board, `mirror/formula → text|numbers` (computed value), `name→any text`. Anything else → save-time validation error `UNMAPPABLE_PAIR`.
- `fixed: { "<target_column>": <value or template> }` applied after mapping; string values are templates and are then parsed with the target type's `fromText` (so `"{item.id}"` into a `board_relation` column links the trigger item; `"Portal"` into a status column resolves the label).
- `name` default `{item.name}`.
- Item **default values** of the target board (07-OPERATIONS.md §7.1) apply first; mapping/fixed override.

### 6.3 Connect semantics

- `connect_column` on `create_item`: a `board_relation` column **on the trigger item's board** that will receive the new item (added, not replaced, when the column allows multiple). The column must reference the target board, else `VALIDATION`.
- If the relation column is two-way (`settings.two_way_column_id`), the service layer writes the mirror side; nothing extra to configure. If it is one-way and `connect_back_column` is given, the runner also links new → trigger item.
- `connected_items_all_done` and `mirror:` references follow links backwards: a change on board B reaches the items of other boards that link to it.
- Permissions: linking requires the owner to have `view` on the target board; mirror values displayed to a user are filtered by **their** rights on the linked board (D6 item visibility) — automation evaluation uses the owner's rights.
- Portal pattern: one automation per client portal board; the condition `board_relation any_of [{client_item_id}]` is resolved at seed time to the Accounts item id. Because item-level visibility (D6) already filters the real boards for guests, portal mirroring automations are **optional** and used only when a portal needs a different structure than the source board.

---

## 7. Export

`mcp_prompt` (§1.1) is generated from the recipe by the `sentence()` functions (`sentence.ts`) for the builder and for
AI clients. A recipe can be read and written as JSON through the API (`GET /boards/:id/automations`,
`POST /boards/:id/automations`) and the MCP tools.

---

## 8. UI — the automations center

Entry points: the board header's **Automations** button (with the number of active automations) opens the board's
automations center (`apps/web/src/features/automations/AutomationsDialog.tsx`); the account-wide page `/automations`
(`AccountAutomationsPage.tsx`) lists every automation of the boards the user can see, by board, with its switch,
its last 7 days and the account's usage.

### 8.1 Create

- A catalogue of template cards by category (Status change, Items, Dates & time, Column changes, Subitems, Across
  boards, Notifications & email, Webhooks & integrations). Each card is a sentence with highlighted blanks ("When
  **Status** changes to **something**, move item to **group**"); a search box filters the sentences. The catalogue is
  `packages/shared/src/automations/templates.ts`; accounts may also save their own automation templates (admins, and
  members when `members_manage_automation_templates` is on).
- Clicking a card opens the **sentence builder** (RTL-aware): one trigger, zero or more conditions ("and only if"),
  one or more actions ("then"). Clicking a blank opens the proper picker: column (filtered by the allowed column
  types), label (chips in the status colours), group, board (boards the owner can edit), people (`@creator`,
  `@actor`, board owners, users, teams, people columns), a date expression builder (today / today + N days / from a
  column), a message editor with `{` autocomplete of template variables, a mapping table for cross-board actions
  (auto-mapped rows pre-filled, rows that would lose data marked), and the webhook URL + secret.
- **Build a custom automation**: the same builder, starting from an empty trigger; trigger list = §2, condition list
  = §3 for the chosen column, action list = §4.
- Footer: a live sentence preview, **Save and switch on** and **Save as off**. Saving calls
  `POST /boards/:id/automations`; server validation errors are shown on the matching part of the sentence.

### 8.2 Manage

The board's automations (`GET /boards/:id/automations`): on/off switch (`is_active`), sentence (click to edit),
owner, last run and recent results, and the run history. Automations switched off by the engine (§5.7) show why
(`deactivated_reason`) with a way to open and fix them.

**Run history** (`GET /automations/:id/runs`, newest first, paged): time, trigger item, the actor that caused the
event, status, per-action log with rendered templates and errors.

### 8.3 Account usage

The account-wide page shows what ran in the last 30 days: runs per day by outcome (ok / partial / error / skipped),
actions carried out, and scheduled triggers due soon. Data from `GET /automations/usage`.

### 8.4 Run-once test

Pick an item → `POST /automations/:id/test` with `{item_id, dry_run}` (`dry_run` defaults to `true`). A dry run
evaluates the conditions and renders every action (templates, resolved recipients, mapping result) without writing,
returning a preview; `dry_run: false` queues a real run with the user as the actor (loop rules apply). Webhook actions
in a dry run return the exact payload that would be sent.

## 9. Test plan

### 9.1 Unit (`packages/shared`, vitest)

- `schema.ts`: every sample seed file parses after `normalize()`; invalid cases (unknown action type, `any_of []`,
  a bad `set_date` expression, mapping to an unknown column) are rejected with the expected zod path.
- `template.ts`: all variables in §4.3 against a fixture snapshot (Hebrew and English values), helpers, unknown path →
  empty + warning, `{{` escape, nested relation path, `|json` inside object payloads.
- Trigger `match()` for every trigger with positive and negative events; `number_threshold` fires on crossing only;
  `status_changed` with `from_labels`; `person_assigned` added-set logic.
- Condition evaluation per operator per column type (reusing the column registry's filter tests with the automation
  sugar operators).
- Date math: `today+3d`, `column:x-1w`, month-end rollover, DST change days, `time` in the account time zone.

### 9.2 Integration (`apps/api/test`, on PGlite)

Files: `automations-engine.test.ts`, `automations-api.test.ts`, `automations-subitems.test.ts`,
`automations-timer.test.ts`, `automations-computed.test.ts`, `automation-templates.test.ts` and others.

- API write → `activity_log` row → job enqueued in the same transaction (a rollback leaves no job).
- End-to-end recipes: status → move group; date arrived + condition + two actions; create in group → create an item
  on another board with mapping + fixed + connect (two-way relation populated); `connected_items_all_done` fires on
  the transition, not on every later change; time tracking start / stop (skipped when already running);
  `every_time_period` with `scope: each_item`; `date_arrives_before` scheduling.
- Idempotency: the same `event_id` enqueued twice → one run; a crash between action 1 and 2 → resuming creates no
  duplicate item.
- Loop protection: A sets status X → B sets status Y → A… stops at the depth limit with `skipped:max_depth`; a self
  loop within 10 s is skipped; an automation's own writes are ignored.
- Failure semantics: action 2 of 3 throws → run `partial`, action 3 still runs; `delete_item` then `set_status` →
  `skipped:ITEM_GONE`; 20 consecutive errors → auto-deactivation.
- Permissions: an owner lacking rights on the target board → `FORBIDDEN_FOR_OWNER`; activity rows carry
  `actor.kind = automation` and show in the item's activity log with the automation's title.
- Scheduler: missed ticks catch up once; editing a date re-arms; clearing deletes the schedule row; an archived item's
  rows are removed and recomputed on restore; a past date within 24 h fires once, older does not.
- Webhook action: HMAC signature verified by a test receiver; 5xx → retried with backoff; a private-IP URL rejected.
- Email action: mail mocked; recipients from `column:` / `mirror:`; HTML sanitized; 20-recipient cap.

### 9.3 API contract

CRUD + `If-Match` on automations, switching on / off, `runs` paging, `test` dry runs return previews.

### 9.4 UI (Playwright)

Create from a template: fill the blanks, save, switch, dry-run preview; custom builder validation errors shown on the
sentence; the mapping table marks data-loss rows; run history; fixing an automation switched off after a referenced
column was deleted; RTL rendering of sentences with mixed Hebrew / English text.
