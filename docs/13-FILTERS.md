# 13 — Filters, sorting and grouping (the query model)

The single query model behind board filtering, sorting and grouping: its schema, semantics, how it compiles to SQL
or runs in memory, the UI that builds it and the API that accepts it. For developers working on boards, the items
API, automations or anything that filters items.

One query model serves everything: the board's filter bar, filters saved in a view, `items/query` in the API,
automation conditions, filter-based visibility (`view_items: by_filter`), dashboard widgets and search. The filter
tree is recursive (nested groups), not a flat list of rules.

## 1. The filter tree (zod, `packages/shared/src/query/filter.ts`)

Abridged — see the file for the full schema:

```ts
export const filterRuleSchema = z.object({
  kind: z.literal('rule').default('rule'),
  column_id: z.string(), // or system fields: 'name' | '__group__' | '__created_at__' | '__updated_at__' | '__creator__' | '__depth__' | '__parent__' | '__key__'
  operator: z.enum(FILTER_OPERATORS), // allowed per column type by the registry (03 §1)
  values: z.array(z.unknown()).max(200).default([]),
  attribute: z.string().optional(), // timeline: 'start'|'end'; people: 'person'|'team'; mirror: aggregate field
  match: z.enum(['any', 'all']).optional(),
  negate: z.boolean().default(false), // a local "not" (equivalent to NOT)
  disabled: z.string().optional(), // a rule switched off in the UI, kept in the tree
});
export const filterGroupSchema = z.object({
  kind: z.literal('group'),
  operator: z.enum(['and', 'or']),
  negate: z.boolean().default(false), // NOT on the whole group
  rules: z.array(z.union([filterGroupSchema, filterRuleSchema])).max(MAX_FILTER_RULES),
});
export const querySchema = z.object({
  filter: filterGroupSchema.optional(), // root = a group; empty = everything
  search: z.string().max(200).optional(), // free text over text_value — AND with filter
  person: z.string().optional(), // the bar's "Person" filter = sugar for a rule on every people column
  sort: z.array(sortLevelSchema).max(5).default([]), // {column_id, direction, nulls}
  group_by: groupBySchema.optional(), // column, direction, collapse, date unit, mode (each / ranges / first letter / …)
  subgroups: z.array(groupBySchema).max(2).optional(), // up to 3 grouping levels
  scope: z.enum(['all', 'parents', 'subitems']).default('all'), // multi-level: which levels are returned; 'parents' + match_children returns a parent if a child matches
  match_children: z.boolean().default(false),
  subitems_strict: z.boolean().optional(), // "strict filtering", below
  ignore_invalid_rules: z.boolean().optional(),
});
```

- Maximum nesting depth **5**, up to **50 rules** per query (422 beyond that). Paging (`cursor`, `limit`) is part of
  the request, not of the saved query.
- `subitems_strict` ("strict filtering"): a subitem that does not match hides everything below it as well — no dimmed
  rows; an item stays only if it matches itself, or through a chain of subitems that each match. Default off (rows on
  the path are shown dimmed). Saved with the view; also applies in the API and in automations.
- Example: "Status is New **or** (Priority P1 **and** SLA overdue) **and not** (Client empty)":

```json
{
  "filter": {
    "kind": "group",
    "operator": "and",
    "rules": [
      {
        "kind": "group",
        "operator": "or",
        "rules": [
          { "column_id": "status", "operator": "any_of", "values": ["New"] },
          {
            "kind": "group",
            "operator": "and",
            "rules": [
              { "column_id": "priority", "operator": "any_of", "values": ["P1"] },
              { "column_id": "sla_due", "operator": "lower_than", "values": ["TODAY"] }
            ]
          }
        ]
      },
      {
        "kind": "group",
        "operator": "and",
        "negate": true,
        "rules": [{ "column_id": "account", "operator": "is_empty" }]
      }
    ]
  }
}
```

## 2. Semantics

- An empty value = `null`; `is_empty` also matches a "semantically empty" value (`{ids:[]}`, `{item_ids:[]}`,
  `{persons_and_teams:[]}`).
- status / dropdown: `values` are **label texts** (stable across reordering) or numeric `id`s; they are resolved once
  per query.
- date / timeline: dynamic values `TODAY, TOMORROW, YESTERDAY, THIS_WEEK, NEXT_WEEK, LAST_WEEK, THIS_MONTH,
NEXT_MONTH, LAST_MONTH, THIS_QUARTER, LAST_QUARTER, NEXT_QUARTER, THIS_YEAR, LAST_YEAR, NEXT_YEAR, PAST, FUTURE,
OVERDUE (past and not done, by deadline), DAYS_AGO:<n>, DAYS_AHEAD:<n> (a single day relative to today — "7 days
ago"), EXACT:<date>`. They are stored as relative values and computed on every read using the account's time zone
  and first day of the week — in quick filters, saved views and dashboard widget filters alike.
  `within_the_last/next: [n, 'days'|'workdays'|'weeks'|'months']` (workdays follow the account's weekend setting).
- people: `me`, `user:<id>`, `team:<id>` (includes team members), `none`.
- relation / mirror / formula: filterable through the denormalised values (`text_value` / `number_value` /
  `date_value`) — so formula and mirror columns can be filtered.
- `__group__` allows "group is X"; `__depth__` = level in the tree; `__key__` = the custom item key.
- Visibility: the filter runs **after** permission restrictions (`view_items`), never before.

## 3. Compiling to SQL

- Tree → an `AND/OR/NOT` expression over `EXISTS (SELECT 1 FROM cells c WHERE c.item_id = i.id AND c.column_id = $col
AND <pred>)`; for each column type `<pred>` comes from the type's filter model. Indexes: `cells(column_id,
number_value)`, `cells(column_id, date_value)`, a GIN trigram index on `text_value`, GIN on `value` for status /
  dropdown (`value->'index'`, `value->'ids'`).
- `search`: `text_value ILIKE %q%` over all cells + `items.name`.
- Sorting: a join to the sort column's cell (sort key by the type's `sortKey`: number / date / text / index); default
  `group.position, item.position`. Stable sort, with a cursor.
- `group_by`: grouping happens on the client over the current page when the primary sort is the grouping column (the
  server sorts by `group_by` and then `sort`). For people / dropdown (multi-value) columns an item appears in every
  matching group.

### 3.1 Implementation

- **One plan, two engines**: `planQuery` (`packages/shared/src/query/plan.ts`) checks columns / operators / limits and
  resolves values once (label text → id, `me` / teams → ids, date tokens → ranges by the account's time zone, weekend
  and `first_day`). The plan is run either by `applyPlan` in memory (`evaluate.ts` — the browser uses it too for
  instant filtering) or by the SQL compiler (`apps/api/src/modules/items/query.repo.ts` — in the repository, because
  SQL lives only there).
- **When in memory**: when the plan reads values computed at read time (formula, mirror, meta, `__key__`) or uses
  `match_children` (`planNeedsMemory`). Everything else runs in SQL including sorting and paging, and DTOs are built
  only for the page.
- Every column type declares a `filterModel` in the registry (`text | number | date | label | labels | people |
checkbox | links | files`); the engines know only the models, not the types.
- **Parity**: `apps/api/test/query.test.ts` runs the truth table (`packages/shared/test/query-fixtures.ts`) twice — SQL
  and memory — and both must return exactly the same thing.
- An incomplete rule (an operator that needs a value, without one) is ignored; an empty group = everything. A label
  that does not exist = nothing matches.
- Free search: the item name + the stored text of cells (not computed columns). A people filter on a user also
  matches items assigned to their teams.
- `cursor` = an encoded offset (not keyset).
- Performance: 10k items, a 3-level query + search + sort ≈ 50 ms (`query.perf.test.ts`, opt-in with
  `PERF_DATABASE_URL`). Postgres JIT is off for these queries (`set local jit = off`) — otherwise compilation alone
  takes ~0.5 s.

## 4. UI

### 4.1 The board bar

- **Search** (Ctrl+F): free text, highlights matching cells; optionally saved in the view.
- **Person**: avatars of the board's members + "me"; a click = a filter on every people column (OR between them).
- **Filter**: a quick panel — chips for each status / dropdown / people / date column with live counts; and an
  **Advanced** button → the tree builder.
- **Sort**: up to 5 levels, drag to reorder, asc / desc.
- **Group by**: up to 3 levels (status / dropdown / people / date / checkbox / rating / relation / formula and more),
  with modes per type, plus a collapsed state.
- Hide columns, Collapse all. An active state shows a dot on the button + "N filters"; **"Save to view"** /
  **"Reset"**.

### 4.2 Advanced builder

Rule rows: [column ▾] [operator ▾] [value(s)]; before each row from the second on, the group's **and / or** switch
(one choice per group) + a **"+ Group"** button that creates an indented subgroup with its own switch, and **"not"**
(NOT) as a toggle on a group. Rules can be dragged between groups. A readable sentence preview: "Status = New **or**
(Priority = P1 **and** SLA overdue) **and not** (Client empty)". A live result count. Saving: to the view, or as a URL
(`?q=<base64>`).

### 4.3 Other uses

- View: `views.settings.query` (the same `Query`); `is_locked` prevents changes but allows a temporary filter (not
  saved).
- Automations ([`04-AUTOMATIONS.md`](04-AUTOMATIONS.md)): `conditions` = a full group (not a flat list) — the
  conditions use the same builder.
- Permissions ([`05-PERMISSIONS.md`](05-PERMISSIONS.md)): `view_items: by_filter` — a filter per member / team; the
  item is visible if it matches.
- Dashboards / exports: the same `Query` as a parameter.

## 5. API

`POST /boards/{boardId}/items/query` with a `Query` body; `GET /boards/{boardId}/items/count?q=<base64(Query)>` (for
the live counts of quick filters, limited to 10 requests a second per user); `GET /boards/{boardId}/items/search`.

## 6. Tests

Unit: compiling every operator for every type (truth table against fixtures); a depth-5 tree; NOT on a group; dynamic
date values around weekends / time zones; people including teams. Integration: 10k items, a 3-level query under
150 ms with the indexes.
