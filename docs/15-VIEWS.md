# 15 — Views: lifecycle, saving, the main table, personal versus shared

What happens to a change a user makes in a board view — when it is saved, for whom, and how to go back — plus the
view data model, API and the advanced view types (timeline, Gantt, workload, chart, files, map). For developers
working on boards and views. It complements [`13-FILTERS.md`](13-FILTERS.md) (what is filtered) and
[`11-UI-DESIGN.md`](11-UI-DESIGN.md) (how it looks).

## 1. Three layers of state

| Layer                             | Where it is stored                                            | Visible to                     | Examples                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **View (shared)**                 | `views.settings`                                              | everyone who can see the board | view type, filter, sort, grouping, hidden columns, column order and width, Kanban / Calendar settings, collapsed groups (default) |
| **Personal override (saved)**     | `user_view_prefs(user_id, view_id, settings)`                 | the user only                  | column widths and order, collapsed groups, text wrapping                                                                         |
| **Draft (personal, not saved)**   | client state + URL (`?q=`) + `sessionStorage`                 | the tab / session only         | every filter / sort / grouping / hiding change until Save or Reset                                                              |

The UI always shows `effective = merge(view.settings, personal_prefs, draft)`. Precedence: draft > personal > view.

## 2. The "unsaved" (dirty) state

- As soon as the draft differs from `view.settings` (after normalisation), the tab gets a dot and the bar shows
  **"Save to view" | "Save as new view" | "Reset"** (and a count, e.g. "3 changes").
- A draft survives a refresh (`sessionStorage` per view) and is encoded in the URL so you can share "here is what I
  see" without saving (`?q=<base64>`); opening such a URL loads the draft on top of the view.
- Switching to another view keeps the previous view's draft aside (nothing is lost); drafts expire after 24 hours.
- **Reset** = discard the draft.

## 3. Who may save

| Action                                   | Permission                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Create a view                            | `view.create` (editors, contributors, assignees)                                                                     |
| Save a change to a shared view           | `view.update` (editors); the creator of a shared view can save to it as long as they have `view.create`              |
| Save to a **locked** view                | `view.manage` (board owners / admins); others get "Save as new view" only                                            |
| Delete a view                            | its creator, or `view.manage` for others' views; **the main table cannot be deleted**                               |
| Personal view (`views.visibility = 'private'`) | any user can create one for themselves; it does not count towards the 100-view limit, is invisible to others (404), and can be made shared |

## 4. The main table

- Every board has one: `type: table`, `is_system: true` — it cannot be deleted or change type; it can be renamed,
  locked, and save a filter / sort / hidden columns like any view. It is created on the board's first open
  (`ensureMainTable`), not when the board is created, so old boards and boards from templates or imports get one too.
- The view a board opens with = `views.is_default` (it can be moved to another view); a link to the board without a
  view opens it.
- Hiding a column in the main table never deletes data; "Hidden columns: 3" in the bar, with a list to restore.

## 5. Locked views (`is_locked`)

- Only managers (`view.manage`) change them; for everyone else the bar works **as a draft only** (filter and sort
  freely, but no saving), and the save button becomes "Save as new view".
- Locking hides nothing — it protects the settings, it is not a viewing permission (for that there are `view_items`
  and `restricted_view`).

## 6. Creating, duplicating, ordering

- "+" next to the tabs → the views center: Table, Kanban, Calendar, Cards, Form, Timeline, Gantt, Workload, Chart,
  Files, Map, Dashboard, and extension views (`board_view`).
- A new view starts **from the current effective state** (including the draft) — this is exactly "Save as new view".
- Duplicate, rename, make default, lock, delete (to the trash for 30 days), copy to another board (columns matched by
  type + title).
- Limit: 100 shared views per board.
- **Tab order and pinning are personal**: each user orders their own tabs by dragging and pins views (⋯ / right-click
  → "Pin to start"). Pinned views always come first; a pinned view moves only among pinned ones and an unpinned one
  only among unpinned ones (it stops at the boundary). Stored in `user_board_prefs.settings.layout`
  (`PUT /boards/{boardId}/views/layout`); it changes nothing for others, and viewers can order too. A user who never
  reordered sees the shared `views.position`.

## 7. Data model (in addition to [`02-DATA-MODEL.md`](02-DATA-MODEL.md))

```
views(id, board_id, type, name, position, is_default, is_system, is_locked, visibility 'shared'|'private', owner_id, settings jsonb, revision, created_by, deleted_at)
user_view_prefs(user_id, view_id, settings jsonb, updated_at)           -- PK (user_id, view_id)
user_board_prefs(user_id, board_id, last_view_id, settings jsonb)       -- the view opened last, the personal tab layout
```

`views.settings` (zod, `viewSettingsSchema` in `packages/shared/src/views/settings.ts`), abridged:

```ts
{ query: Query,                        // 13-FILTERS (filter, search?, person?, sort, group_by, subgroups, scope)
  hidden_columns: string[], column_order: string[], column_widths: Record<col, number>,
  collapsed_groups: string[], wrap_text: boolean, row_height: 'single'|'double'|'triple',
  mobile_layout: 'table'|'cards', show_summary: boolean,
  summaries: Record<col, SummaryFn>,   // footer function per column
  group_summary: { column_id, fn? } | null,   // one field summarised next to each group's name; off by default
  subitems_sort, subitems_hidden_columns,
  kanban?, calendar?, cards?, timeline?, gantt?, workload?, chart?, dashboard?, files?, map?, extension?,
  coloring: ColoringRule[] }
```

`revision` + `If-Match` on save: when two people save the same view, the second one gets 409 and a choice "Overwrite /
Save as new".

## 8. API

`GET /boards/{boardId}/views` · `POST /boards/{boardId}/views {type,name,settings,visibility}` ·
`PATCH /views/{id} {settings|name|is_locked|is_default|position}` (If-Match) · `POST /views/{id}/duplicate` ·
`DELETE /views/{id}` (not the system view) · `PUT /views/{id}/prefs` (personal) · `DELETE /views/{id}/prefs` ·
`PUT /boards/{boardId}/views/layout` (personal tab order) · `POST /views/{id}/open` (remember the last opened view).
Forms: `GET/PATCH /views/{id}/form`.

## 9. UI flows

1. **Edit without saving**: change a filter / sort → a dot on the tab → keep working; a refresh keeps it; "Reset"
   reverts.
2. **Edit and save**: "Save to view" → the draft is written to `views.settings` (if allowed) → event `view.updated` →
   SSE refreshes everyone (people without a draft see the new settings; someone with a draft keeps theirs).
3. **Working on someone else's view**: if not allowed to save — draft only + "Save as new view".
4. **Main table**: as above; structural changes (columns / groups) belong to the board, not the view, and are saved
   immediately.
5. **Personal preferences**: column widths and collapsed groups are saved automatically to `user_view_prefs` without
   "Save".

## 10. Tests

A draft does not leak to another user; saving to a locked view → 403; If-Match conflict → 409; deleting the main
table → 400; a URL draft loads on top of the view; a private view does not appear for others and does not count
towards the limit; personal prefs do not change `views.revision`.

## 11. Implementation

- Server: `apps/api/src/modules/views/*` (migration `0006_views`: `views.is_system`, `views.visibility`,
  `user_view_prefs`, `user_board_prefs`).
- Permissions: board actions `view.create` (editor / contributor / assignee), `view.update` (editor), `view.manage`
  (owner / admin — locking, default, saving to a locked view, deleting others' views). A private view belongs to its
  creator only; anyone else gets 404.
- `If-Match` is optional: without the header the save goes through (overwrite); with an old revision → 409
  `revision_mismatch`.
- Client: `features/board/views/use-view-state.ts` — a draft per view in `sessionStorage` (expires after 24 hours),
  `?q=` only when the query differs from the saved one, `?view=` when the view is not the default. Personal
  preferences are saved after 600 ms of quiet (`PUT /views/{id}/prefs`, merged).
- Filtering / sorting / grouping on the board run in the browser over the items already loaded (the same engine as
  the server) — instant response; rules on deleted columns are dropped (`pruneQuery`) instead of breaking the view.

## 12. Timeline / Gantt / Workload (D25)

- **A shared timeline component** (no external library): pure maths in `packages/shared/src/timeline/axis.ts` (zoom
  day / week / month / quarter / year, units by the account's first day of the week, offsets from the start of the
  row — true RTL through `inset-inline-start`; only the mouse calculations know the direction: `offsetInAxis`,
  `dragDays`), and the UI in `apps/web/src/features/board/timeline/TimeAxis.tsx` (headers, a background with the
  account's weekend, a "today" line, zoom and navigation).
- `views.settings.timeline` / `gantt` / `workload`: the date column, grouping (`__group__` / `__none__` / a people,
  status or dropdown column), colour, zoom; Gantt adds a dependency column, subitems and the critical path; Workload —
  a people column, a measure (`count` / `column`), an effort column, day / week, daily capacity +
  `capacity_overrides` per person. Everything is a draft until saved (D20); filtering, search and the person filter
  apply as usual.
- Dragging a bar writes the date column (`PUT /items/:id/cells/:col`) with an undo toast / Ctrl+Z; the bar's edge
  changes the length (timeline only). A windowed board (`WINDOW_MIN_ITEMS`) loads by the axis range
  (`onCalendarRange`, the calendar's path).
- **The `dependency` column**: `item_links.meta` (`kind`, `lag_days`; migration `0035_timeline`), same board only, a
  cycle → 422 `dependency_cycle`. Shifting happens on the server (`items/dependencies.service.ts`, `planShifts` in
  shared) in the same transaction and batch as the edit → one Ctrl+Z reverts the whole chain; the response includes
  `shifted_item_ids`.

## 13. Chart, Files, Map

The same lifecycle (draft / save / lock) and the same filter bar; the settings are in `viewSettingsSchema` (`chart`,
`files`, `map`), in the "View settings" panel.

- **Chart** — the dashboard chart widget's drawing component (`ChartDrawing`, the `viz.css` palette) over the items
  matching the view. Data: `boardChartData` (shared, `views/chart.ts`) in the browser — live with the board; on a
  windowed board — `POST /boards/{id}/chart` (the same function on the server, up to 5,000 items). Settings: type
  (bars / stacked / line / pie / donut), X axis (the board's groups or a column; for a date — a time unit), split (in
  stacked), measure (count, or sum / avg / median / min / max of a number column). A table of values below the chart.
- **Files** — `GET /boards/{id}/files`: the files of file columns + files from updates and replies, of items and
  subitems, by the reader's permissions (`view_items`, column view restrictions). Filter by column / type / uploader
  + sort (saved in the view), and the view's filter / search (only files of matching items). A click opens
  `FileViewer`.
- **Map** — MapLibre (BSD-3) with the account's style (OpenFreeMap by default; changed in Administration →
  Connections → Maps, and the sources enter the CSP from the settings). Markers = elements over a clustered GeoJSON
  source (clusters with a count), coloured by a status column; a click = the item's card on the side → open the item.
  Addresses without coordinates are counted ("waiting for geocoding" / "not found").
