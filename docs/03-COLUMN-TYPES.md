# 03 — Column Types Registry

This doc explains how column types work in Bines OS — the registry, and the behaviour, settings and value shape of
each type — for developers who change a type, add one, or read and write cells through the API. It implements D4 in
[`DECISIONS.md`](DECISIONS.md): a column type is a registry module, not an enum.

The complete, always-current reference (every type's settings, value shape, filters, summaries, automations, API and
MCP calls) is generated from the code: [`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md) (`pnpm docs:columns`).
When this doc and the generated catalog disagree on a field, the catalog — that is, the code — is right.

## 1. The registry

Each type is a `ColumnTypeDef` (`packages/shared/src/columns/types.ts`). Abridged:

```ts
export interface ColumnTypeDef<S = unknown, V = unknown> {
  type: string;                 // registry key, e.g. 'status'
  labelHe: string;              // name in the Hebrew UI (English via i18n)
  category: ColumnCategory;     // essentials | super_useful | relations | computed | meta | advanced
  priority: 'P0' | 'P1' | 'P2';
  storage: ColumnStorage;       // where the value lives: item row, cell, or computed
  engine?: 'links' | 'mirror' | 'formula' | 'files' | 'time' | 'vote' | 'doc' | 'progress' | 'button' | 'secret' | 'signature';
  readOnly: boolean;            // computed / meta — no writes through the API
  settingsSchema: z.ZodType<S>; // columns.settings
  valueSchema: z.ZodType<V>;    // cells.value (null = empty)
  defaultSettings: S;
  newColumnSettings?(defaults): Partial<S>;          // account defaults written on a new column
  toText(value: V, settings: S, ctx): string;        // cells.text_value: search, export, display
  localizedText?: boolean;                           // text depends on the reader's region (dates)
  toNumber?(value: V, settings: S): number | null;   // cells.number_value
  toDate?(value: V, settings: S): string | null;     // cells.date_value (ISO date)
  toDateEnd?(value: V, settings: S): string | null;
  normalize?(value: V, settings: S, ctx): V;         // derived keys inside the value (phone e164 / valid)
  validate?(value: V, settings: S): string | null;
  filterOperators: FilterOperator[];
  filterModel: FilterModel;                          // how the query engine reads the value (13-FILTERS)
  sortKey: 'text' | 'number' | 'date' | 'none';
  aggregates: Aggregate[];
  toFormula?(value: V, settings: S, ctx): FormulaInput;
  fromItem?(item: ItemMeta, settings: S): V | null;  // meta columns computed from the item row
  labelIds?(value: V): number[];                     // label types: labels in use
  geocodeQuery?(value: V): string | null;            // location: queue geocoding
  // Paste / import / bulk edit / an automation's fixed value: null clears, undefined = cannot be read (cell skipped).
  fromText?(text: string, settings: S, ctx): V | null | undefined;
}
```

- Each module is registered in `packages/shared/src/columns/index.ts`; the API, the worker and the web app use the
  same registry. `cellFromText` only routes to the registered type — there is no type switch elsewhere.
- `cells.value` is stored as JSONB exactly in the `valueSchema` shape; `text_value` / `number_value` / `date_value`
  are derived in the service on every write (not by a DB trigger) and are used for sorting, search and summaries.
- An empty value is `null` (not `{}`), in the API too.
- Column keys: `^[a-z][a-z0-9_]{0,19}$`, unique per board, never reused after deletion (kept in `columns` with
  `archived_at` / `deleted_at`).

### UI behaviour common to every type

Every cell: click = inline edit, Esc = cancel, Enter = save, Tab = next cell, Delete = clear (if the user may edit).
Hovering a truncated cell shows the full value in a tooltip. Column header menu: Column ID, Settings, Filter, Sort,
Collapse, Group by, Duplicate, Add to the right, Change type, Rename, Delete. Group footer: a summary from the type's
`aggregates` (the first by default; clicking switches; "Hide column summary" in the settings).

## 2. Core types

### 2.1 `name` — the item name

- The first, mandatory column of every board; cannot be deleted or hidden; 1–255 characters.
- Settings `{}`; value `string` (stored in `items.name`, not in cells). Clicking the name opens the item card; hover
  shows an "Open" button and the id.
- Filters: `any_of, not_any_of, contains_text, not_contains_text`. Sort: text. Automations: trigger `item_created`,
  mapping. Formula: `{name}`. Guests: edit (by board permission).
- **Name source**: `settings.name_source` = `{ mode: 'free' | 'column' | 'template', column_id?, template?,
empty_text?, warn_duplicates? }` — per board and per sub-board (each has its own name column). `free` (default) = a
  typed name. `column` = the display text of one column. `template` = text with `{column_key}` (`{{` / `}}` = literal
  braces), for example `{client} – {date}`; separators left dangling at an edge when a variable is empty are removed;
  everything empty → `empty_text`. Any column with text may be used (including connect boards, mirror and formula;
  several linked items = names separated by commas), except `name` and `button`. The text is the column's `toText`
  (as displayed) in the account's region. The server stores the name in `items.name` — search, filters,
  notifications, webhooks, export, MCP and AI keep working as usual; the item's id never changes.
  - Recompute: a change in a cell of the item; a change to the name or cells of a linked item (also on another board,
    up to 3 hops, including a parent above subitems); a type conversion of a source column; a change of the setting →
    the whole board is recomputed (above `NAME_RECOMPUTE_SYNC_MAX` = 2,000 items as a background job in windows, state
    in `boards.settings.name_recompute`, progress `board.names_recompute_progress` on the live channel).
  - A computed change is logged as `item.renamed` with `meta.computed` (not undoable by itself; undoing the cell change
    restores it); on a new item the name is part of `item.created`.
  - API: `GET/PUT /boards/:id/name-source`, `GET /boards/:id/name-duplicates` (a warning only, never a block); the item
    DTO carries `name_computed` and `name_source`; on create `name` is optional and ignored; renaming a computed name →
    409 `item_name_computed` (`details.refs`); deleting a source column → 409 `column_in_name_source`; an invalid source
    → 422 `name_source_invalid`. Import and editing, forms, automations (`set_item_name` → skipped `name_computed`), MCP
    and AI respect it. Switching back to `free` keeps the last names as text.

### 2.2 `text` — text

- One line, up to 2,000 characters. Links are detected and clickable. A `wrap` display option.
- **Suggestions from existing values**: while editing, a list of the distinct values already in the column on this
  board opens (most common first, filtered by what is typed); pick with arrows / Enter / click, or keep typing freely —
  the value stays free text (not a label). `GET /boards/:id/columns/:col/values?q=` (up to 20, only items the user can
  see). Turn off per column: `suggest: false`.
- Settings `{ hide_footer?: boolean, wrap?: boolean, suggest?: boolean }` (`suggest` defaults to `true`). Value
  `string`.
- `toText` = value. Filters: `any_of, not_any_of, is_empty, is_not_empty, contains_text, not_contains_text,
starts_with, ends_with`. Sort: text (Hebrew collation). Summary: `count`. Automations: all. Formula: yes. Guests: yes.

### 2.3 `long_text` — long text

- A multi-line editor in a pop-up; 20,000 characters; in the cell: 2 lines + "…"; optional character count in the
  footer.
- Settings `{ hide_footer?: boolean }`. Value `{ text: string }`. `toText` = text. Filters as text. Sort: text.
  Automations: all (mapping ↔ text). Formula: yes.

### 2.4 `numbers` — number

- Settings `{ unit: { symbol: '' | '₪' | '$' | '€' | '%' | string, direction: 'left' | 'right' }, precision:
-1|0|1|2|3|4, thousands: boolean, footer: 'none'|'sum'|'avg'|'median'|'min'|'max'|'count', rollup:
'sum'|'min'|'max'|'none' }` (`rollup` = roll-up to the parent on multi-level boards).
- `thousands`: a new column takes the account default `settings.defaults.number_thousands` (Administration → General
  → Defaults; on by default). The value is written on the column when it is created (adding a column, the AI / MCP
  tools, file import, a built-in template, conversion to numbers); an existing column without `thousands` keeps no
  separator. Duplicating a column keeps its settings.
- Value `number` (a JSON number; the API also accepts a string and converts it). `toNumber` = value. `precision -1` =
  no rounding; negatives allowed.
- Filters: `any_of, not_any_of, greater_than, greater_than_or_equal, lower_than, lower_than_or_equal, between,
is_empty, is_not_empty`. Sort: number. Summaries: `sum, avg, median, min, max, count`. Automations: all
  (`number_threshold`, `increment_number`, `set_column`). Formula: yes.

### 2.5 `status` — status

- One coloured label. Up to **40 labels**, 30 characters each; the colour is a key of our palette (`STATUS_COLORS` in
  `packages/shared/src/colors.ts`, 11-UI §9.1); an imported hex colour maps to the nearest key. A "done" label
  (`is_done`) drives Deadline Mode, `done_pct` and the `is_done` filter. A label in use is never deleted, only
  deactivated (`is_deactivated`). Labels may have a description (i). The empty default = grey with no text.
- Settings `{ labels: Array<{ id: number, label: string, color: string /* palette key; an old hex reads as the nearest
key */, index: number, is_done?: boolean, is_deactivated?: boolean, description?: string }>, post_update_on_change?:
boolean, conditional?: Array<{ label_id, require_columns: string[] }> }`. `id` is stable (does not change on
  reorder); `index` = display order.
- Value `{ index: number }` (= label id). The API also accepts `{label: "Working on it"}` and converts it;
  `create_labels_if_missing` creates the label. `toText` = label. `toNumber` = index (sorting by label order).
- UI: the cell is filled with the colour; clicking opens the label grid + "Edit labels"; "+" in the cell = an Update
  attached to the status; the footer is a battery (percent per label, hover shows counts); on multi-level boards the
  parent's status is a battery of its children (`BatteryValue`).
- Filters: `any_of / not_any_of` (ids), `is_done / is_not_done`, `is_empty`. Sort: by index. Summaries: `labels,
done_pct, count_done`. Automations: the most common trigger (`status_changed`), condition, action, mapping. Formula:
  yes (the label text). Guests: yes.

### 2.6 `dropdown` — dropdown (multi-select)

- Labels without colour, multi-select; typing + Enter creates a new label (if permitted); pasting a list creates
  labels; `limit_select` limits a cell to N; a label in use is deactivated, never deleted; up to 1,000 labels per
  column.
- Settings `{ labels: Array<{ id: number, label: string, is_deactivated?: boolean }>, limit_select?: boolean,
label_limit_count?: number, allow_create?: 'owners' | 'editors' | 'none' }`.
- Value `{ ids: number[] }`. `toText` = labels joined with ", ". Filters: `any_of, not_any_of, is_empty, is_not_empty`.
  Sort: text. Summary: `count`. Automations: `column_changed`, condition `any_of`, action `set_column`, mapping ↔
  dropdown / status (single). Formula: yes.

### 2.7 `date` — date

- A date picker; a time toggle; display options: weekday, week number, hide the current year. **Deadline Mode**:
  `deadline: { status_column_id, people_column_id? }` — the cell is red when past and not done, struck through when
  done; feeds My Work. Reminders = a `date_arrived` automation.
- Settings `{ show_time?: boolean, show_weekday?: boolean, show_week_number?: boolean, hide_current_year?: boolean,
deadline?: { status_column_id: string, people_column_id?: string }, rollup?: 'earliest' | 'latest' | 'none' }`.
- Value `{ date: 'YYYY-MM-DD', time?: 'HH:mm:ss' }` — **time in UTC**, shown in the user's time zone. `toDate` = date;
  `toText` by locale.
- Filters: `any_of / not_any_of` with dynamic values `TODAY | TOMORROW | YESTERDAY | THIS_WEEK | NEXT_WEEK |
THIS_MONTH | PAST | FUTURE | OVERDUE | EXACT:<date>`, `between`, `greater_than…`, `within_the_last/next: [unit, n]`,
  `is_empty`. Sort: date. Summaries: `earliest, latest, range`. Automations: `date_arrived`, `date_arrives_before`,
  `set_date(today+N | column+N | clear)`, `shift_dates`. Formula: yes (`DAYS, ADD_DAYS, FORMAT_DATE`).

### 2.8 `timeline` — timeline

- A start–end range drawn as a bar in the group colour; `milestone` (a diamond for a single date); Deadline Mode as for
  date; feeds the Gantt, timeline and workload views.
- Settings `{ show_weekends?: boolean, show_week_number?: boolean, allow_milestone?: boolean, deadline?: {...} }`.
- Value `{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', milestone?: boolean, from_time?: 'HH:MM', to_time?: 'HH:MM' }`;
  validated `from <= to`. `toDate` = from; `date_value_end` is derived too. `toText` `"01/10/2026 – 15/10/2026"`.
- **With times** (setting `show_time`): a start and an end time as well, wall-clock in the account's time zone (like
  the `hour` column), so that `from` / `to` stay the days every other reader expects. Both times or neither; on a
  single day the end is after the start. `toText` `"03/11/2026 09:00 – 10:30"` / `"03/11/2026 22:00 – 04/11/2026
02:00"`; `fromText` reads both forms. Feeds the calendar's hourly layout (11-UI §4).
- Filters: as date, with `attribute: 'start' | 'end'`. Sort: from. Summaries: `earliest, latest, range` (= earliest →
  latest). Automations: `date_arrived` with an attribute, `set_timeline`, `shift_dates`, mapping. Formula:
  `{col#start}`, `{col#end}`.

### 2.9 `people` — people

- Members, guests and teams of the account; `max_people` 0 (unlimited) | 1 | 2 | 3; the assignee is notified (can be
  muted per column); hover = user card; this is the column that defines "assignment" for `edit_assigned` and
  `view_items: assigned_or_created`.
- Settings `{ max_people: 0|1|2|3, notify_on_assign?: boolean, allow_teams?: boolean, allow_guests?: boolean }`.
- Value `{ persons_and_teams: Array<{ id: string, kind: 'person' | 'team' }> }`. Validation: account members only; a
  guest only if subscribed to the board. `toText` = names.
- Filters: `any_of / not_any_of` with `person:<id>`, `team:<id>`, `me`; `is_empty`. Sort: text. Summary: `count`.
  Automations: `person_assigned`, `assign(creator|specific|from_column)`, notify-to-column, mapping. Formula: yes
  (names). Guests: yes.

### 2.10 `email` — email

- An address + display text; click = `mailto:`; options: the item name in the subject, CC to the item's address (a
  reply arrives as an Update through incoming email, 01-ARCHITECTURE §8).
- Settings `{ include_item_in_subject?: boolean, cc_item_address?: boolean }`. Value `{ email: string, text?: string
}`; RFC-lite validation. `toText` = text ?? email.
- Filters: text-like. Sort: text. Automations: `send_email(to: column)`, mapping, condition. Formula: yes.

### 2.11 `phone` — phone

- A number + country; a flag; click actions; validated with `libphonenumber-js`.
- Value `{ phone, country?, e164?, valid }` — `phone` as typed (= the display text); `e164` / `valid` are derived on
  every write (`ColumnTypeDef.normalize`) from the cell's country → the column's `default_country` → the account's
  `locale.country`; whatever the client sends for them is discarded. Changing `default_country` re-normalises the
  column's cells (`normalizeSettingsKeys`); for old cells run `pnpm --filter @bines/api phone:backfill [--apply]`.
- Settings: `default_country`, `click_actions_enabled` (a toggle, on by default), `actions` (a subset of whatsapp /
  telegram / call / sms / copy), `default_action`, `telegram_username_column`. Links and menu:
  `packages/shared/src/columns/phone.ts` (`phoneActionLink`, `phoneMenuActions`, `resolvePhoneClick`). SMS from the
  item: `POST /items/{id}/sms`.
- Filters: text-like. Sort: text. Automations: condition / mapping / webhook payload. Formula: yes.

### 2.12 `link` — link

- A URL + text; `default_text`.
- Settings `{ default_text?: string }`. Value `{ url: string, text?: string }`; validation: http(s) only. `toText` =
  text ?? url.
- Filters: text-like on the text **and the url**. Sort: text. Automations: condition, mapping, `set_column`. Formula:
  **yes** (`{col}` = url).

### 2.13 `checkbox` — checkbox

- Settings `{ color?: string }`. Value `{ checked: boolean }` (`null` = unchecked). `toText` `"v" | ""`. `toNumber`
  1 | 0.
- Filters: `is_empty / is_not_empty` (= unchecked / checked). Sort: number. Summary: `count_done` (checked).
  Automations: `checkbox_checked`, `set_column`. Formula: yes. Group by: yes.

### 2.14 `rating` — rating

- Settings `{ max: 3|4|5|10, symbol: 'stars' | 'hearts', color?: string }`. Value `{ rating: number }` 1..max. Footer:
  `avg`. Filters: `any_of, greater_than…`. Automations: `column_changed`, `set_column`. Formula: yes.

### 2.15 `file` — files

- Several files per cell, from the computer or a link; 500 MB per file; preview (image / PDF), versions (uploading a
  file with the same name = a new version), a ZIP download of the cell; a board-level files gallery (the `files` view).
- Settings `{ allowed_mime?: string[], max_files?: number }`. Value `{ files: Array<{ asset_id: string, name: string,
size: number, mime: string, version: number, added_by: string, added_at: string }> }` — uploaded through presign
  (`POST /files/presign` → PUT → `POST /items/:id/cells/:col/files`), never through `cells.value` directly; delete =
  `clear` / remove the asset.
- `toText` = names. Filters: `is_empty / is_not_empty`, `contains_text` (name). Sort: count. Summary: `count`.
  Automations: trigger `file_added`, condition `is_not_empty`; not in mapping. Formula: no. Guests: upload / download.

### 2.16 `board_relation` — connect boards

- Links to items on another board (or the same board); `boards[]`; `allow_multiple`; `two_way` (below); clicking a
  chip opens the item; the picker opens with the items of the target boards listed (no typing needed), search filters
  them, and when nothing matches "Create item '…'" creates an item in the target board's top group (a board picker if
  there are several; requires `items.create` on the target) and links it.
- Settings `{ board_ids: string[], allow_multiple: boolean, two_way?: boolean, reflection_column_id?: string }`.
- **Two-way** (`PUT /boards/:id/columns/:key/two-way`, in the column settings): only when the column connects to a
  single board. It pairs the column with a relation column on the target board — a new one (default name = this
  board's name; requires `column.create` there) or an existing one that connects back to this board only and is not
  paired with another (`column.update` there). Both get `two_way: true` and `reflection_column_id` = the other's key;
  turning it on completes the reverse of every existing link on both sides (a union — nothing deleted, no event per
  cell). Self-board: supported with a separate partner column (not the column itself).
  - Every link write (cell, bulk, file import, duplicate, automation, MCP / AI, move to another board and its undo) is
    reflected on the other side through `syncReflection` (`items/relations.service`): `item_links` rows + the cell
    cache, `cell.changed` on the other item with `meta.reflected_from`, without checking permissions on the other
    board and without echoing back. An import script that writes `item_links` directly calls `syncReflection` itself
    (or pairs after writing with `pairTwoWayColumns`, which completes). `allow_multiple: false` is not enforced on the
    reflection.
  - Turning it off: both columns go back to one-way; the links stay. Deleting one side (to the trash): the other
    becomes one-way; restoring pairs again (with completion) if the partner is alive, connects back and is not paired
    with another; otherwise the column goes back to one-way. An item in the trash: its link rows stay on both sides
    (hidden in views, back on restore). Deleting a whole board does not change the settings. Duplicating a board or
    saving it as a template copies the column as one-way.
  - `two_way` / `reflection_column_id` in ordinary settings (column create / update) are kept as they are on the
    server and cannot be changed that way; while two-way, `board_ids` is locked (422 `two_way_unavailable`).
- Value `{ item_ids: string[] }` — the truth is in `item_links` (from_item, to_item, column_id, position);
  `cells.value` is a cache updated in the same transaction. Validation: the target belongs to `board_ids`, read
  permission on the target board.
- `toText` = item names. The cell DTO also returns `names: string[]` aligned with `value.item_ids` — never split
  `text` on ", " (a name can contain a comma). Renaming an item updates the stored text (`text_value`) of the relation
  cells pointing at it (`refreshRelationCells`; for dependencies only the text). Filters: `any_of / not_any_of` (ids),
  `contains_text` (name), `is_empty`. Sort: text. Summary: `count`. Automations: `link_changed`, `connect_items`,
  `create_item(..., connect_column)`, `connected_items_all_done`; not in the notify field. Formula: yes (names).
  Guests: only if they can see the target board.

### 2.17 `mirror` — mirror

- Shows a column of the linked items through a relation column (or of the item's subitems, D14); **two-way editing**
  when linked to a single item (it updates the source, with the source's permissions); a summary when several are
  linked, by source type: numbers → `sum|avg|median|min|max|count`; status → `labels` (battery) | `done_pct`; date /
  timeline → `earliest|latest|range`; text → a list; mirror-of-mirror up to 2 levels; the item name and Updates cannot
  be mirrored (the relation itself already shows names).
- Settings `{ relation_column_id: string, source_board_id: string, source_column_id: string, aggregate?: Aggregate }`.
- Value: **computed on read** (`apps/api/src/modules/items/computed.ts`) — nothing is stored in cells. The API returns
  `{ display_value, items: [{item_id, value}] }`.
- Filters: **yes** (evaluated on the computed values). Sort: by source type. Summary: as the source. Automations:
  condition; not an action. Formula: yes. Guests: edit if permitted on the source. Read-only through the API (a write
  → 422 pointing to the source).

### 2.18 `formula` — formula

- A row-level expression with `{column_id}` references and functions, **computed on read** from the columns it
  references; it can be filtered, sorted and used as an automation condition (not a trigger).
- Settings `{ formula: string, result_type?: 'auto'|'number'|'text'|'date'|'boolean', unit?: {symbol, direction},
precision?: -1..4, thousands?: boolean }`. Validation: parsing (`packages/shared/src/formula/`), references exist, no
  cycles, depth ≤ 5, length ≤ 10,000.
- **Numeric result display** (as numbers §2.4, the same controls in the column settings): unit / currency / percent,
  `precision` = a fixed number of digits (-1 / unset = up to 2 digits), thousands separator. Applies to the cell, the
  summary row, dashboards, export and a mirror of the formula — also a mirror of a mirror (the format passes down the
  chain). `count` stays a plain number. Text / date / boolean results are unchanged.
- **`TODAY()` in the account's time zone** (account settings → `locale.timezone`, not the reader's and not UTC); the
  calendar parts of a date-with-time (`YEAR / MONTH / DAY / WEEKNUM / HOUR / MINUTE / ADD_DAYS / SUBTRACT_DAYS /
WORKDAYS / FORMAT_DATE`) are read in that zone too; a date without a time never shifts. `NOW()` stays an instant (ISO,
  UTC).
- Functions: `IF, AND, OR, NOT, SWITCH, SUM, AVERAGE, MIN, MAX, ROUND, ROUNDUP, ROUNDDOWN, ABS, MOD, DIVIDE, MULTIPLY,
CONCATENATE, LEN, LEFT, RIGHT, TRIM, UPPER, LOWER, REPLACE, SEARCH, TEXT, VALUE, TODAY, NOW, DATE, DAYS, HOURS_DIFF,
MINUTES, WORKDAYS, ADD_DAYS, SUBTRACT_DAYS, FORMAT_DATE, YEAR, MONTH, DAY, WEEKNUM, HOUR, ISBLANK, COUNT, COUNTDONE`
  (spreadsheet-style syntax — for example `IF(OR({lookup_a}>0,{lookup_b}>0),"🔴 Red",…)`).
- Columns that can be referenced: name, text, long_text, numbers, status (text), dropdown, date, timeline (#start /
  #end), people (names), email, phone, link, checkbox, rating, item_id, creation_log, last_updated, board_relation,
  mirror, formula, country, hour, world_clock, time_tracking (seconds), vote (count), subitems (`{subitems#count}`).
  Not: file, tags, location, week, color_picker, progress, button, doc.
- Automations: condition yes, trigger no, notify field yes. Read-only.

### 2.19 `item_id` — item ID / custom key

- Shows the id (ULID) or a **custom key**: an optional prefix + a running number with padding (`BT-0042`). The number
  is in `items.key_seq`, one sequence per board in `item_keys`, assigned in the item's transaction; it does not change
  when the item moves between groups.
- **The prefix is optional** — empty = the number only (1, 2, … 324), and then there is no uniqueness; a non-empty
  prefix is unique in the account (a partial index). A new column (API / UI, without settings) =
  `{display:'custom_key', prefix:'', padding:1}`; creating it or changing its settings creates the sequence
  (`ensureItemKeySequence`) and numbers existing items by creation order.
- "Next number" is set in the column settings (`PUT /boards/:id/columns/:col/sequence {next_seq}`; it must be greater
  than the highest number on the board) — to continue numbering from a previous system. Moving to another board: the
  item takes the target board's next number (or none); undo restores the previous one. Sorting by the number
  (`toNumber`).
- Settings `{ display: 'id' | 'custom_key', prefix?: string, padding?: number, copy_as: 'text' | 'link' }`. Value:
  computed `{ key: string }`. Filters: `contains_text, any_of`. Sort: number (seq). Automations: notify field
  (`{item.key}`), condition. Formula: yes. Read-only.

### 2.20 Auto number

There is no separate auto-number type that renumbers on reorder; use `item_id` with a custom key (§2.19) for running
numbers.

### 2.21 `creation_log` — creation log

- Who created the item and when; modes `person | date | both`; for a public form — "Form: <form name>".
- Settings `{ mode: 'person' | 'date' | 'both', show_time?: boolean }`. Value: computed from `items.created_by /
created_at`. Filters: `any_of` (person), date operators. Sort: date. Formula: yes. Read-only.

### 2.22 `last_updated` — last updated

- The last column change (not Updates). Value computed from `items.last_cell_change_at / _by` (updated on every cell
  write). Filters: date operators, person. Sort: date. Read-only.
- Settings `{ mode?: 'both' | 'date' | 'person' (legacy: 'ago' = date), show_time?: boolean, columns?: string[] }`.
  `columns`: only a change in one of these columns (keys; `name` too) counts; if none changed, the cell is empty. The
  calculation (`column-changes.repo`): the later of `cells.updated_at / updated_by` of those columns (written on
  every write; survives activity-log cleanup and import) and their last `cell.changed` event in `activity_log` (the
  only trace of a cleared value; `item.renamed` for the name). One query per load, only on boards that have such a
  column.

### 2.23 Subitems (not a column — a sub-board)

Subitems live on a **sub-board** with its own columns (D14):

- A board may have one sub-board (`boards.parent_board_id` → the parent; created with the first subitem; hidden from
  the sidebar, search and board lists). Subitems are items of the sub-board whose `parent_item_id` is an item of the
  parent board. The sub-board has **its own columns** (by default: name, owner, status, date), managed from the
  subitems' header like any board's columns.
- Levels below a subitem (up to `hierarchy_depth_max` ≤ 5) stay on the same sub-board and share its columns.
- Permissions, subscribers and `view_items` are the parent board's.
- In the table: an expand arrow + child count by the item name; subitems open below as a nested table with its own
  header, indented one step per level.
- Parent columns read subitems through a **mirror** that targets "subitems" (aggregate per type — sum, earliest–latest,
  status battery) and through the roll-up ("show summary on parent").
- Converting item ↔ subitem maps cells between the two boards' columns by type + title (a mapping dialog); unmapped
  values are listed before confirming.

## 3. Additional types

### 3.1 `tags` — tags

- Account-wide tags (`tags` table); typing `#tag` in a cell creates or finds one; colour; deleting a tag globally is
  allowed (with confirmation and a usage count).
- Settings `{}`. Value `{ tag_ids: string[] }` (a write also accepts `{ tags: string[] }` — names found or created in
  the account; the cell is the source of truth). The tag colour is a key of the group palette. Filters `any_of /
not_any_of`. Automations: **yes** (`column_changed`, `set_column`, mapping ↔ dropdown). Formula: yes (names).

### 3.2 `dependency` — dependency

- Dependencies between items on the same board; `mode: 'flexible' | 'strict' | 'visual'`; lead / lag days; kinds FS /
  SS / FF / SF; shifts dates by `date_column_id` (date / timeline; unset = the board's first timeline, else first
  date) — a date change of a predecessor shifts its dependents per the mode (server-side, one batch); arrows in the
  timeline / Gantt views.
- Settings `{ mode, date_column_id, allow_multiple: true }`. Value `{ item_ids: string[], lag_days?: Record<item_id,
number>, kind?: Record<item_id,'FS'|'SS'|'FF'|'SF'> }` (the truth is in `item_links` with the kind and lag).
  Automations: trigger only. Formula: yes (names).

### 3.3 `time_tracking` — time tracking

The column is a **log of entries (sessions) per item**, not a single number. The value shown in the cell = the sum of
closed entries + the time running now. It is the source of truth for billable hours on the sample `tasks` board.

**Data model** — a dedicated `time_entries` table (not only JSONB), so hours can be reported by client / user / date:

```
time_entries(id, account_id, board_id, item_id, column_id, user_id, started_at timestamptz, ended_at timestamptz NULL,
             duration_s int GENERATED (ended_at - started_at), source 'timer'|'manual'|'automation'|'import',
             note text, billable boolean default true, edited_by, edited_at, created_at, deleted_at)
```

`cells.value` is a cache: `{ duration: number /* seconds, closed entries only */, running: boolean, runners?: {
user_id, since }[], entries_count: number }`, updated in the same transaction as every change to `time_entries`.
`number_value = duration` (+ running time computed on the client).

**UI behaviour**

- **Cell**: `02:35:12` (or `2.6h` per `settings.display`); a ▶ / ⏸ button for **my** timer (on hover, or always while
  running); while running, a live counter of all timers running in the cell; hover shows who is running it and since
  when. Clicking the value opens the item's **time log** (the "Time" tab in the card).
- **Time log** (a panel / modal, also a tab in the item card): a table of entries — date, start, end, duration, user,
  source (timer / manual), note, billable ✓; total and per-user sums; filter by user / range; **inline editing** of
  start / end / note (an edited entry is marked "edited by X" in a different colour); delete (to the trash, undo); CSV
  export of the log.
- **Starting a timer**: ▶ starts an entry `source: timer` for the current user. **Several timers can run at once**: on
  different items, and different users on the same item; only **one timer per user per cell** (a second ▶ on the same
  cell returns the running one). ⏸ closes my timer in the cell; an entry running over 12 hours triggers a "Forgot a
  timer?" notification and can be trimmed by hand.
- **Manual entry** ("+ Add entry"): three ways — (a) date + start time + end time; (b) date + duration (`1:30` or
  `1.5h`) → the end is computed from the start or the start from the end; (c) a date range for a long entry.
  Validation: not in the future, end after start, at most 24 hours per entry, the user's time zone. Owners / admins
  may log **in another user's name** (recorded in `edited_by`).
- **Column settings**: `{ display: 'hms' | 'decimal_hours', show_seconds: boolean, billable_default: boolean,
allow_manual: boolean, allow_other_users: 'owners' | 'all' | 'none', rounding?: 'none' | '5m' | '15m' (rounds up in
display / export, not in the data), rollup: 'sum' }`.
- **Summaries**: the group footer = the sum (and "per user" on hover); on multi-level boards the parent shows the sum
  of its children (can be turned off); the workload view reads from here.
- **Overlaps**: overlapping entries of the same user on the same item are flagged with a warning, not blocked.

**API** (all through the service, all emit events): `POST /items/:id/time/start {column_id, note?}` ·
`POST /items/:id/time/stop` · `GET /items/:id/time/entries?user&from&to` · `GET /items/:id/time/entries.csv` ·
`POST /items/:id/time/entries {column_id, started_at, ended_at | duration_s, user_id?, note?, billable?}` ·
`PATCH /time/entries/:id` · `DELETE /time/entries/:id` · `GET /boards/:id/time/report?group_by=user|item|day&from&to`
(and `report.csv`) · `GET /me/time/running` (all my running timers). A direct write to the column's `cells.value` →
422.

**Events and automations**: `time.started`, `time.stopped {duration_s}`, `time.entry_added|edited|deleted`; actions
`time_tracking_start` / `time_tracking_stop` (for example "when status → Working on it, start a timer for the user who
changed it"); a `number_threshold` trigger on the sum ("10 hours passed — notify"); a `greater_than` condition on the
duration (in hours). Mapping: no. Formula: `{col}` = seconds (for example `ROUND({time}/3600,1)*{rate}` for billing).
Filter / sort: number. Guests: see it; start a timer only with `edit_content` + column permission.

### 3.4 `progress` — progress tracking

Computed on read (engine `progress`, read-only): the board's status columns with weights; a column on an `is_done`
label counts as complete. Settings `{ columns: {column_id, weight}[], subitems: {column_id, weight} | null,
hide_percent }` — no columns = every status column with equal weight; `subitems` = the share of subitems on a "done"
label in their status column. Value `{ percent }`. Filter / sort: number; summaries avg / min / max / median. Formula:
yes (percent).

### 3.5 `button` — button

No value (engine `button`). A click = `POST /items/:id/buttons/:col` (permission = editing the item and the column,
`edit_assigned`, column restrictions) → a `button.clicked` event (dispatched to automations; automation trigger
`button_clicked {column}`). Settings `{ label, color, confirm, action }`; `action`: `automation` (the event only),
`open_url` (a template with `{item.name}` / `{item.<key>}` — URL-encoded), `set_values` (`[{column_id, text}]` — text
read as a paste through `cellFromText`, written with `writeCell` in one batch → a single Ctrl+Z).

### 3.6 `location` — location

Value `{ address, lat?, lng?, place_id?, country_code?, geocode_failed? }`. An address without coordinates is queued
as `geo.geocode` (graphile-worker in the API process, a queue named `geo` = one job at a time + an interval of
`GEOCODER_MIN_INTERVAL_MS` — Nominatim allows up to one request per second, with an identifying User-Agent). The result
is stored in `geocode_cache` (per account and normalised address — each address is looked up once) and in the cell
(only if the address did not change) with a `cell.geocoded` event; `geo.sweep` every 10 minutes collects cells written
outside the service (import, bulk). A Google API key (account settings, encrypted, write-only) enables autocomplete
while typing (`/geo/autocomplete` through the server) and Google geocoding. Text "32.08, 34.78" = coordinates. Filter:
text. Formula: address.

### 3.7 `country` — country

Value `{ code: 'IL' }` (ISO-3166 alpha-2); the name comes from `Intl.DisplayNames` in the reader's language
(`localizedText`); the stored text = Hebrew · English (searchable in both). The flag is an SVG image
(country-flag-icons, MIT). Text input: a code or a name in Hebrew / English. Filter: text.

### 3.8 `hour` — hour

Value `{ hour: 0-23, minute: 0-59 }`; settings `{ format: 'auto' | '24h' | '12h' }` (auto = the reader's). The number
= minutes from midnight (sorting). Text input: "9:30", "0930", "9:30 pm". Our own picker (hours + minutes in steps of
5, or typing).

### 3.9 `week` — week

Value `{ start, end }` (7 days); settings `{ first_day? }` (empty = the account's). The picker is our `Calendar` (any
day picks its week). Date operators, sort by date. Text input: a date (its week) or a 7-day range.

### 3.10 `world_clock` — world clock

Value `{ timezone }` (IANA, validated); settings `{ format, work_start, work_end, work_days }`; the cell shows the live
time + city + a green dot during working hours. Text input: a zone or a city ("London"). Filter: text.

### 3.11 `vote` — vote

One vote per user; value `{ voter_ids: string[] }` (written only through `POST /items/:id/cells/:col/vote` with
`{vote: boolean}`; engine `vote`; not duplicated; not in undo). Summary: `count`. Formula: yes (count).

### 3.12 `color_picker` — color picker

Value `{ color: '#rrggbb' }`; settings `{ format: 'hex' | 'rgb' }` (the text form). Our own picker: the system
palette + typing a hex (not `<input type=color>`). Text input: `#abc`, `#aabbcc`, `rgb(…)`.

### 3.13 `doc` — doc

One live document per cell (`docs.host = 'cell'`), opened in a side panel over the board (or as a page). Value `{
doc_id, name }` — written only through `POST /items/:id/cells/:col/doc` (created the first time; engine `doc`) and when
the doc is renamed; the text = the doc's name. Permissions = the item's: whoever sees the item reads and comments (an
account viewer reads), whoever may change the cell edits and manages. Setting: `template_doc_id` — a workspace doc
every new doc in the column starts from. Duplicating an item / board duplicates the doc; trashing the item takes the
doc with it.

### 3.14 `ai` — AI column (D26)

An ordinary column type (`packages/shared/src/columns/defs/ai.ts`). Value `{ text, number?, date?, ai?: { at, model,
cost_usd, kind } }` — `ai` marks the value as AI-generated (without it = written by hand; a value can be edited by
hand, which drops the mark).

**Settings**: `kind` (`summarize` / `classify` / `extract` / `translate` / `custom`), `connection_id` + `model` (an
AI connection from "AI & MCP"), `inputs` (column keys) + `include_name` + `include_updates` / `updates_limit`,
`instructions` (a prompt with `{column title}` / `{id}` references, appended to the input), `length`, `labels_from` (a
status / dropdown column) or `labels`, `write_to` (also write the label into a status / dropdown column, in the same
batch), `extract` (text / number / date / email / phone), `language`, `auto_run`, `max_items_per_run`,
`max_usd_per_run`, `max_usd_per_month`.

**Running**: `POST /boards/:id/ai-columns/:col/run` (`items` / `empty` / `all`; above 5 items — a job
`ai.column_run`), as the person running it: only columns they can see are sent, items they cannot see are skipped;
guests do not run. Each run = one batch (trigger `bines.ai`, `meta.via = 'ai'`) → one undo. Cost goes to `ai_usage`
(source `column`) + `ai_column_usage` per month. Auto-run: a change in an input column (not a write by AI / agent /
automation) → `ai_column_pending` with a 5 s delay → `ai.column_auto`.

**Images as input.** `output: 'image'` stores the image as a file in `image_column`; `image_size` / `image_quality`.

- `source_image_columns` — file columns on the board, in order (up to 10; the legacy key `source_image_column` reads as
  a list of one, and the form saves the new key): the item's images there (PNG / JPEG / WebP up to 20 MB, read from
  storage on the server — not a link) are sent with the request in column order, older before newer within a column.
  `source_image_count`: `'all'` (default) or the last N from each column (1–20).
- When there are more than the provider accepts, the newest that fit are sent (`inputImageLimit` in
  `packages/server-ai`): OpenAI gpt-image `/images/edits` — up to 16 images, up to 50 MB per request (DALL·E 2 — one);
  Gemini 3 image — 14; Gemini 2.5 Flash Image and an unknown Gemini model — 3, up to 15 MB (a Gemini inline request up
  to 20 MB after base64); text output (vision) — up to 20 images, Anthropic 20 MB / OpenAI 35 MB / Gemini and
  OpenAI-compatible 15 MB. The cell stores `ai.source_images: { sent, total }` and shows "X of Y sent" when fewer were
  sent. With several columns a short line is added to the prompt: "Images 1–3: «Photos». Image 4: «Approved sketch»."
- `when_no_source_image`: `'text'` (default — generate from the description only: text-to-image
  `/images/generations`, or the prompt without image blocks for text output) or `'skip'`.
- Image output = image-to-image (OpenAI `/images/edits` multipart; Gemini — `inlineData` parts next to the text;
  Imagen and DALL·E 3 do not edit → `ai_model_no_image_edit`; DALL·E 2 — one PNG). Text output = image blocks for a
  model with `vision` (otherwise `ai_model_no_vision`, not charged).
- An item without an image in the source columns with `skip` — not run and not charged (`no_source_image`); one of
  the columns hidden from the runner — `source_column_unavailable`; the output column is also a source column —
  `same_image_columns`.
- Auto-run also listens to a person's `file.added` in one of the source columns (not an AI / automation / agent
  write). `file.added` carries `meta.column_key / column_type` and schedules `automation.dispatch` itself — only when
  the board has an active automation / webhook or an AI column with auto-run.
- Automations: trigger `file_added` (`column` optional = any file column); the `generate_image` action takes
  `source_columns` (a list in order; the legacy `source_column` still works — the latest image), `source_count`
  (`'all'` default / N) and `when_no_source_image` (`text` default = from the description; `skip` = the action is
  skipped with `no_source_image`). Webhook `file_added` (`config.column_id` optional, `event.files`). The
  `generate_image` MCP / agent tool: `source_file_id` (with `get_file_link` permission), `source_column_id` (the latest
  image) or `source_column_ids` (all images, in column order).

**Style examples from other items.** `style_examples: { column, filter, count } | null` (default `null` = off):

- `column` — a file column on the board (for example "Approved sketch"); `filter` — which items supply examples, in
  the board's filter model (the same rules as views and `items/query`, for example status = Approved; `null` / no rules
  = any item with an image in the column); `count` — the newest N images (default 3, 1–10), by when the file was added
  to the cell (`cell_files.created_at`), never from the item being processed.
- One query for candidates (`newestFileMatches`: the filter + "has a usable image in the column" in SQL, ordered by
  the newest image, LIMIT N; a filter that needs computed values — formula / mirror — is evaluated in memory, then one
  query on the ids), and one more query for their images; only the chosen N are read from storage.
- Permissions: as the runner — a person: board permissions, item visibility and column restrictions (the examples
  column hidden from them = no examples); auto-run / automation — the automation's owner. An item without access is
  simply left out, and no name or title of another item enters the prompt.
- Examples are sent **first**, before the item's images, with a line: "Images 1–3 are approved examples of the
  required style (from «Approved sketch»). Follow their style." followed by the item's own image-column line (numbered
  on). With the provider's limit, examples come first (up to `count`) and the item's images fill the rest (newest).
  The cell stores `ai.source_images: { sent, total, examples }` (sent / total include both) and the cell shows "X of Y
  sent, Z of them style examples". Works for image output (edit) and text output (vision). No matching examples — runs
  as without them, no error. A missing column / not a file column — `style_column_unavailable`; a condition on a column
  missing or hidden from the runner — `style_filter_invalid`. Cost: the same accounting; the extra images are charged
  by the provider (a hint next to the setting). The same option exists in the `generate_image` action
  (`style_examples`) and the `generate_image` MCP tool (`style_column_id`, `style_filter`, `style_count`) — one helper
  (`listStyleExamples`).

**Several designs, versions, "rails" and rejection.** Image output only; everything is a setting in the form.

- `photo_mode`: `'each'` (default for a new column) — a separate call per source image (up to the newest 20,
  `AI_EACH_PHOTOS_MAX`; style examples / the locked base are sent with each call) and a design per image; `'together'`
  — one call with all the images.
- `variations` 1–4 (default 1) — designs per call: the provider's `n` up to the account's per-call cap
  (`images.max_images`), beyond that repeated calls; each design is a paid image (images × variations — a hint in the
  form). The run limits (`max_usd_per_run`, `max_usd_per_month`) are checked before every call after the first, and
  the account / plan budget on every call (`generateImages`); stopping in the middle of a cell keeps what was created
  and the run stops (`stopped`); a call that fails after something was created ends only that cell.
- **Tracking in the cell:** `ai.outputs: [{ file_id (the root), name, source_asset_id | null, variation, version?,
rejected?, source_images? }]` (up to 80), `ai.file_id` = the first (compatibility), `ai.calls` (when more than one),
  `ai.source_images` = the sum over calls. Each design is its own file in the output column.
- **Re-running:** `image_on_rerun`: `'version'` (default for a new column) — the new design is saved as a new version
  (`addFileVersion`) of the design the cell created for the same image + variation, as long as that file is still in
  the output column and not rejected (otherwise a new file); history is kept and "make current" restores an earlier
  version (adding the version is not part of the run's undo); `'add'` — an additional file. A per-run choice:
  `on_existing: 'version' | 'add'` in `POST …/ai-columns/{id}/run` (also for a single cell — the same endpoint), saved
  with the run (`mode` = `items:add`). In the UI, ▶ on a cell that has designs, "Run" in the selection bar and "Run on
  all" in the column menu and form open a "New version of the existing design / Additional design" menu (the column
  setting first).
- **Fidelity:** `fidelity`: `'free'` (default); `'close'` — a prompt line: keep the composition, framing and colours of
  the first image; `'locked'` ("rails") — an approved base: the newest image in `fidelity_base_column` (a file column
  of the item; optional), otherwise the newest style example — sent first as the image to edit, the item's image after
  it as a reference, and the prompt says to keep everything in the base exactly and replace only the figure / person
  with the one in the image; other style examples are not sent then. No base → `'close'` with `ai.note:
'fidelity_no_base'` (shown in the cell; not an error); a missing / hidden base column → `fidelity_base_unavailable`.
  Prompting only — no masks and no inpainting.
- **Rejection:** ✕ "Remove the design" in the cell → a confirmation → `POST
/boards/{boardId}/ai-columns/{columnId}/items/{itemId}/outputs/{fileId}/reject`: the file leaves the output column to
  the trash (`detachFromCell` — file-removal permissions apply; undo / restore brings it back) and its entry in
  `ai.outputs` is marked `rejected: true`. Removing an AI file directly from the file column marks it the same way
  (`markAiOutputsRejected` in `detachFromCell`). The next run creates a new design instead of a rejected one.
- **Older columns:** settings saved before `photo_mode` existed (they have `image_on_rerun` but no `photo_mode`) read
  as `photo_mode: 'together'`; `add` stays `add`; `replace` → `version`. The form saves explicit values on the next
  save.

**The image queue.** Image output is never produced inside the request or in one loop that can stop silently:

- A run first **plans** every cell — a design per source image × variation (`each`), or per variation (`together`) —
  and records them in the cell as `ai.outputs.status: 'pending'` with `ai.run_id`; then **one job per design**
  (`ai.image_unit`, payload `{run_id, item_id, source, variation}`) creates them one after another: one call to the
  provider (`generateImages` — AI enabled, the plan, the budget, `ai_usage`), the file is saved at once (a new file or
  a new version, per the re-run rules), the cell is updated (`done`) and the next job is queued.
- Each run is sequential (graphile `job_key` = `ai.image:{run}`), with up to `images.concurrency` runs of an account in
  parallel (an account setting, Administration → AI → Images, 1–4, default 1; queues named
  `ai.images:{account}:{slot}`). Planning up to 5 items happens in the request, above that in an `ai.column_run` job;
  without a job runner (tests, dev without a worker) the same steps run in place.
- **Retries:** 429 / timeout / 5xx / network failure → the design goes back to `pending` with `error` (`rate_limited` /
  `timeout` / `provider_unavailable` / `network`), `attempts` and `retry_at`, and is queued again after an exponential
  wait with jitter (10 s, 20, 40, 80 — up to 5 attempts), or after the provider's `Retry-After`; charged only on
  success. A content refusal / another 4xx / a 429 of `insufficient_quota` → `failed` with the reason, no retry.
- **Caps:** `max_usd_per_run` and `max_usd_per_month` are checked before every design; when reached, all remaining
  designs of the run are marked `failed` with `limit_run_usd` / `limit_month_usd` (never silently dropped) and the run
  stops (`stopped`); the account / plan budget and AI being off behave the same with their own codes.
- **The run counts designs:** `unit: 'image'`, `total` = designs to produce (an item that cannot run = one failure),
  `done` / `failed`; the response returns `running` and the client follows `GET /ai-columns/runs/{id}`.
- **Filling the gaps:** `only_missing: true` in the run request (`mode` = `items:missing`) or `POST
/boards/{b}/ai-columns/{c}/items/{i}/retry-missing` — only `failed` designs, or `pending` / `running` ones of a run
  that no longer has a live job (a job locked more than 15 minutes counts as dead); a created design is never
  created or charged again. A cell whose designs are being created by a live run is not planned again
  (`ai_run_in_progress`).
- In the UI: "3 of 8 created" in the cell during the run, a state per design in the panel (waiting / being created /
  will retry soon · reason / not created · reason), a "Fill the gaps" button in the panel and "Fill missing images"
  in the selection bar and column menu; a hint next to "Max $ per run".
- The `generate_image` automation action and MCP tool stay synchronous inside their job / request, but every call
  goes through the same retry mechanism (3 attempts, up to about half a minute) before the set stops.

### 3.15 `secret` — secret

A password or key kept on an item (for example a client's site login). The value is encrypted outside `cells` and
read / written through the secret endpoints (engine `secret`); the cell holds only a marker `{ set, updated_at,
updated_by, checked? }`. Revealing needs a fresh two-factor code (`verify_minutes`) and, per `reveal_mode`, either
board access or being listed in `reveal_user_ids`; a revealed value stays on screen for `reveal_seconds`. Other
settings: `copy_allowed`, `change_requires_code`, `multiline`, `kind` (`text` / `checkbox`), `checkbox_visible`,
`alert_threshold`. Full settings: [`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md#secret).

### 3.16 `signature` — signature

Who signed an interactive document of the item, and when. Written only by the signing endpoint of an interactive
document (engine `signature` — `PUT /cells` refuses it; duplicate / board copy / templates skip it); the evidence
(identity check, IP, exactly what was signed and its SHA-256, the consents) lives in `idoc_signatures` and opens as a
certificate from the cell. Full settings: [`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md#signature).

## 4. Adding a column type

A new type = one module in `packages/shared/src/columns/defs/<family>.ts` + its registration in
`packages/shared/src/columns/index.ts` + i18n keys (`he.json` and `en.json`) + tests. Never add a `switch` on the type
elsewhere in the codebase. Run `pnpm docs:columns` to regenerate the catalog; CI fails (`pnpm docs:check`) when it is
stale.

## 5. Change type (conversion)

Converting a column to another type is defined in D28 and implemented in `packages/shared/src/columns/convert.ts`:

- Every cell goes `old value → text (the old type's toText) → new value (the paste parser, cellFromText)`, except pairs
  with a direct rule that keeps more (status ↔ dropdown by label id, date ↔ timeline, numbers ↔ rating, text ↔ long
  text, contact types → their address).
- A preview (dry run) and the conversion run the same code, so the counts match; the conversion needs the preview's
  fingerprint (stale → 409).
- A cell that fails stays empty; its original value is kept in a backup (`column_conversion_cells`), shown on hover
  and listed by a "failed in conversion" filter. Text → status / dropdown / tags creates the missing labels / tags
  (shown in the preview). Backups are kept 90 days by default (admins choose 30 / 90 / 365 / forever).
- Only board owners and account admins convert; above 5,000 cells the conversion runs as a background job with the
  column locked and a progress bar. Undo (toast / Ctrl+Z / activity log, 7 days) restores type, settings, values and
  dependents from the backup.
- Not convertible (a new column + copy is the way): the name column; computed types (formula, mirror, progress,
  item id, creation log, last updated); own-writer types (files, time tracking, votes, cell docs, buttons); relations
  (connect boards, dependency); AI columns.

## 6. Summary matrix

| type           | write via API                     | filter        | sort      | aggregates                   | automation T/C/A/M | formula ref | guest edit          |
| -------------- | --------------------------------- | ------------- | --------- | ---------------------------- | ------------------ | ----------- | ------------------- |
| name           | yes                               | yes           | text      | —                            | T/C/-/M            | yes         | yes                 |
| text           | yes                               | yes           | text      | count                        | T/C/A/M            | yes         | yes                 |
| long_text      | yes                               | yes           | text      | count                        | T/C/A/M            | yes         | yes                 |
| numbers        | yes                               | yes           | number    | sum avg median min max count | T/C/A/M            | yes         | yes                 |
| status         | yes                               | yes           | index     | labels done_pct count_done   | T/C/A/M            | yes         | yes                 |
| dropdown       | yes                               | yes           | text      | count                        | T/C/A/M            | yes         | yes                 |
| date           | yes                               | rich          | date      | earliest latest range        | T/C/A/M            | yes         | yes                 |
| timeline       | yes                               | rich          | date      | earliest latest range        | T/C/A/M            | yes         | yes                 |
| people         | yes                               | yes           | text      | count                        | T/C/A/M            | yes         | yes                 |
| email          | yes                               | yes           | text      | count                        | -/C/A/M            | yes         | yes                 |
| phone          | yes                               | yes           | text      | count                        | -/C/-/M            | yes         | yes                 |
| link           | yes                               | yes           | text      | count                        | -/C/A/M            | yes         | yes                 |
| checkbox       | yes                               | yes           | number    | count_done                   | T/C/A/M            | yes         | yes                 |
| rating         | yes                               | yes           | number    | avg                          | T/C/A/-            | yes         | yes                 |
| file           | upload endpoints                  | empty/text    | count     | count                        | T/C/-/-            | no          | yes                 |
| board_relation | yes                               | yes           | text      | count                        | T/C/A/-            | yes         | if can see target   |
| mirror         | read-only (edits go to source)    | yes           | by source | by source                    | -/C/-/-            | yes         | via source          |
| formula        | read-only                         | yes           | by result | by result                    | -/C/-/-            | yes         | —                   |
| item_id        | read-only                         | yes           | number    | —                            | -/C/-/-            | yes         | —                   |
| creation_log   | read-only                         | yes           | date      | —                            | -/C/-/-            | yes         | —                   |
| last_updated   | read-only                         | yes           | date      | —                            | -/C/-/-            | yes         | —                   |
| tags           | yes                               | yes           | text      | count                        | T/C/A/M            | yes         | yes                 |
| dependency     | yes                               | yes           | text      | count                        | T/-/-/-            | yes         | yes                 |
| time_tracking  | time endpoints (entries log)      | number        | number    | sum (per user)               | T/C/A/-            | yes         | yes                 |
| progress       | read-only (computed)              | number        | number    | avg min max median           | -/C/-/-            | yes         | —                   |
| button         | click endpoint                    | no            | no        | —                            | T/-/-/-            | no          | click (edit right)  |
| location       | yes                               | text          | text      | count                        | -/C/-/M            | yes         | yes                 |
| country        | yes                               | yes           | text      | count                        | -/C/-/M            | yes         | yes                 |
| hour           | yes                               | text          | number    | count                        | -/C/A/M            | yes         | yes                 |
| week           | yes                               | date          | date      | earliest latest range        | -/C/A/M            | yes         | yes                 |
| world_clock    | yes                               | text          | text      | count                        | -/C/A/M            | yes         | yes                 |
| vote           | vote endpoint                     | number        | number    | count                        | -/-/-/-            | yes         | vote                |
| color_picker   | yes                               | text          | text      | count                        | -/C/A/M            | yes         | yes                 |
| doc            | cell-doc endpoint                 | text (name)   | text      | count                        | —                  | no          | item rights         |
| ai             | yes (text by hand) + run endpoint | text          | text      | count                        | -/C/-/M            | yes         | no run              |
| secret         | secret endpoints                  | see catalog   | —         | —                            | see catalog        | see catalog | per reveal settings |
| signature      | signing endpoint only             | see catalog   | —         | —                            | see catalog        | see catalog | —                   |

T / C / A / M = trigger / condition / action / mapping. For the exact automation, filter and summary support of every
type, see [`COLUMN-TYPES.generated.md`](COLUMN-TYPES.generated.md).
