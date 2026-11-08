# Views

Hebrew version: [views.he.md](views.he.md)

## What it's for

A view is a way of looking at the items of one board. The same items can show as a table, as cards on a Kanban, on a calendar, on a timeline, on a map and more. Views never copy data: change an item in one view and every other view shows the change at once.

Each board opens with a "Table" view that always exists. You add more views as tabs next to it.

## The view types

| View | What it shows | What the board needs |
| --- | --- | --- |
| "Table" | Rows and columns, grouped by the board's groups. The default way of working. | Nothing |
| "Kanban" | Cards in lanes, one lane per label. Drag a card to another lane to change its label. | A status or dropdown column |
| "Calendar" | Items on a month, week or day grid by their date. | A date or timeline column |
| "Cards" | Each item as a tile with the fields you choose. | Nothing |
| "Timeline" | Each item as a bar across days, weeks or months. | A date or timeline column |
| "Gantt" | A timeline with dependency arrows, subitems and the critical path. | A date or timeline column (a "Dependency" column for arrows) |
| "Workload" | How much work each person has per day or week, against a daily capacity. | A people column and a date or timeline column |
| "Chart" | Bars, stacked bars, a line, a pie or a donut built from the board's items. | Nothing |
| "Files" | Every file on the board in one gallery: from file columns and, if you want, from updates. | Nothing |
| "Map" | Items as markers by their address. | A location column |
| "Form" | A form that adds items to the board. See [Docs and forms](docs-and-forms.md). | Your plan must include forms |
| "Dashboard" | Widgets (numbers, charts, a battery and more) for this board only. See [Dashboards](dashboards.md). | Your plan must include dashboards |

Installed extensions can add their own view types. They appear at the bottom of the same menu. See [Extensions](extensions.md).

If a view type is not in your plan, it shows in the menu as unavailable, with a way to upgrade.

## Add a view

1. Open the board.
2. Click "+" ("New view") at the end of the view tabs.
3. Pick a view type.
4. The new tab opens. Click the gear ("View settings") to choose its columns and options.

A new view starts from what you see now: the current filter, sort and grouping are copied into it.

If you are not allowed to create shared views on this board, the types show "(Private)" and the new view is visible only to you.

## Rename, duplicate, copy or delete a view

Right-click a tab, or open its "..." menu ("Actions for view ...").

- "Rename" changes the tab's name.
- "Duplicate" makes a copy on the same board.
- "Copy to another board..." copies the view and its settings to another board. Columns are matched by type and title.
- "Delete view" removes it. The main "Table" view cannot be deleted.

## Pin and order tabs

- Drag a tab to move it. Your order is personal: it does not change what others see.
- "Pin to the front" keeps a tab first. Pinned tabs stay before the others. "Unpin" releases it.

## Save changes to a view

Filters, sort, grouping, hidden columns and view settings are first a draft for you only.

1. Change something (for example add a filter). The tab gets a dot and the bar shows "{n} unsaved changes".
2. Choose:
   - "Save to view" saves it for everyone who uses the view.
   - "Save as new view" keeps the original view and makes a new one with your changes.
   - "Reset" drops your changes.

Your draft survives a page refresh, and stays for about a day. Column widths and collapsed groups are saved for you automatically, without pressing save.

If someone else saved the same view while you were working, you are asked to choose "Overwrite" or save your changes as a new view. If the view was updated while you had no changes, you see "This view was updated by someone else" with "Show the new version" or "Keep my changes".

## Default, locked and private views

Board owners and admins have extra choices in the tab menu:

- "Set as default" makes the view the one the board opens with.
- "Lock view" protects its settings. Others can still filter and sort for themselves, but can only save as a new view ("This view is locked — save as a new view"). "Unlock" removes the lock. Locking does not hide anything; it only protects the settings.
- A private view (marked "Private") is seen only by the person who made it. "Share with everyone" turns it into a shared view.

## View settings

Click the gear at the end of the toolbar ("View settings"). What you see depends on the view type.

Every view type:
- "Copy settings from a view" takes the settings of another view of the same type on the board. Save to apply them.
- "Color" opens "Conditional coloring". See [Search, filter, sort and group](search-filter-sort-group.md).

Table:
- "Row height": "One line", "Two lines" or "Three lines".
- "Wrap text (do not cut long text)".
- "Summary row in each group" and "Summary next to the group name" (with its calculation).
- "Table on phones": "Table" or "Cards".
- On the main table only, "Column order on the default table": "Shared: a drag changes it for everyone" or "Personal: everyone keeps their own".

Kanban:
- "Kanban lanes by" picks the status or dropdown column.
- "Fields on cards" picks what each card shows.
- "Show empty lanes".

Calendar:
- "Date column" and "Color by".
- "Click on an empty day": "New or existing item", "New item", "Date for an existing item" or "Off".
- "Show by the hour" shows a time grid. Then choose "Where the hours come from": "Timeline with hours" (one column) or "Date + start hour + end hour" (three columns), and set "Drag snaps to (minutes)", "Hours shown", "Hour height", "New item length", "Show weekends" and "Fields on the card".

Cards: the fields shown on each tile.

Timeline: the date column, "Group rows" ("By board groups", "No grouping" or a column) and colour.

Gantt: as the timeline, plus "Dependency column (arrows)", "Show subitems" and "Critical path".

Workload: "People column", "Measure by" ("Number of items" or "Number / time-estimate column"), "Effort column", "Capacity per day" and "Capacity per person (empty = default)". "By" chooses "Items", "Subitems" or "Items and subitems".

Chart: "Chart type", "X axis" (board groups or a column; for a date column a "Time unit"), "Split by" for stacked bars, and "Measure" ("Number of items", or sum, average, median, minimum or maximum of a "Number column"). A table of the values shows under the chart.

Files: "File column", "File type", "Uploaded by", "Sort" and "Include files from updates".

Map: "Location column" and "Marker colour by" (a status column, or "One colour").

## Work in each view

Kanban
- Drag a card to another lane to change its label.
- "+ New item" at the bottom of a lane adds an item with that label.
- A lane's menu has "New item in this lane" and moves the lane.

Calendar
- Switch between "Day", "3 days", "Week", "Work week" and "Month". "Today" jumps back to today.
- Drag an item to another day (or hour) to change its date.
- Click an empty day to add a new item or give a date to an existing one ("What goes on this day").
- Right-click an item for "Quick edit", its status, a colour, "Open item" and "Delete".

Timeline and Gantt
- Zoom with "Days", "Weeks", "Months", "Quarters" or "Years".
- Drag a bar to move its dates; drag its edge to make it longer or shorter (timeline column). Undo with the toast or Ctrl+Z.
- Click the track of an item with no date to set one.
- In the Gantt, dependent items move by the rule set on the "Dependency" column: "Shift the same", "Shift only on overlap" or "Arrows only".

Workload
- Each cell shows the load against the capacity ("{load} of {capacity}"). Items with no person show under "Unassigned".

Files
- Click a file to preview it; "Download" saves it.

Map
- Markers close together merge into a number; zoom in to see them. Click a marker to see the item, then "Open item".
- The map counts addresses still being located and addresses not found. The map provider and address search are set by an admin (see [Account administration](account-admin.md)).

## Views on a phone

- The "Views" button opens "Choose a view", with "All views" to manage them.
- "Filter & view" opens the toolbar tools (filter, sort, group, hide, settings) as one list.
- A table can show as cards on phones (view setting "Table on phones").
- The calendar has its own phone layout.

## Tips

- Filters, sort and grouping are per view. Search is per board and stays when you switch views.
- Seeing a view never shows items you may not see; board permissions always apply.

## Related

- [Search, filter, sort and group](search-filter-sort-group.md)
- [Boards, groups and items](boards-groups-items.md)
- [Columns](columns.md)
- [Dashboards](dashboards.md)
- [Docs and forms](docs-and-forms.md)
- [Calendar and Google sync](calendar-and-google-sync.md)
- [Extensions](extensions.md)
- [Sharing and permissions](sharing-and-permissions.md)
