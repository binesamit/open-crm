# Search, filter, sort and group

Hebrew version: [search-filter-sort-group.he.md](search-filter-sort-group.he.md)

## What it's for

A board can hold thousands of items. These tools help you find what you need: search everything in the account, search one board, show only the items that match conditions, put them in order, group them by a column, hide columns you don't need, and color items by a rule.

All of these tools are on the toolbar above the board: "Search this board...", "Filter", "Sort", "Group by", "Hide" and the gear ("View settings").

## Search the whole account

1. Press Ctrl+B (on a Mac, ⌘B), or click "Search".
2. Type at least two letters ("Search items, boards, updates and people").
3. Results are grouped: "Items", "Boards", "Docs", "Dashboards", "Updates", "People", "Files" and "Tags". Use the arrow keys and Enter, or click.

More:
- Tick "Include archive" to find archived items too.
- Type `#` and a tag name to list the items with that tag.
- Type `>` to run a command, such as "My work", "Inbox", "Archive", "Trash", "Automations" or "Notification settings".
- If the AI assistant is on in your account, the last row lets you "ask the agent" with what you typed.
- "Recent searches" shows what you searched before; "Clear recent searches" removes them.

You only find what you are allowed to see.

## Search one board

1. Press Ctrl+F on a board (or click "Search this board...").
2. Type. The board narrows as you type and the matching text is highlighted.
3. Press Esc to clear.

Board search looks in item names and in the text of cells. It stays when you switch views of the same board. On a board, Ctrl+F opens the board search, not the browser's find bar.

## Filter items

1. Click "Filter".
2. On the side, pick a column. Its values show as a check list with live counts. Tick the values you want.
3. The bottom row shows what is on, "{n} matching", and "Clear".

Quick lists exist for groups, status, dropdown, people, tags and date columns. A date column offers choices like "Today", "This week", "Overdue", "In the past" and "Exact date...". People columns offer "Me" ("Assigned to me").

The "Filter" button counts the active conditions. Hover it to read them.

### Advanced conditions

For anything a quick list can't do:

1. In the filter panel, choose "Advanced conditions".
2. Click "+ Condition". Choose the column ("Where"), the condition and the value.
3. Add more conditions. Choose "And" or "Or" to combine them ("Combine conditions").
4. Click "+ Condition group" to nest a group with its own And/Or. "Not" turns a group into its opposite.

Conditions depend on the column type, for example "contains", "is empty", "greater than", "between", "in the last", "in the next", "before", "after", "is done", "checked" and "timer is running". Date conditions such as "This week" or "{n} days ago" are relative, so the filter keeps working every day.

A condition that doesn't fit its column any more (for example after a column type changed) is skipped and marked. Pick another column or condition, or remove it.

### Filter by linked items

For a connected boards column you can filter by the linked items' values. Choose "Linked items": "Any linked item" or "All linked items".

### Subitems in a filter

- "Person also finds items by their subitems": a person filter also shows an item when one of its subitems is assigned to that person.
- "Strict filtering": a subitem that does not match hides everything under it too, instead of showing dimmed rows.

## Sort items

1. Click "Sort".
2. Click "+ Add sort", choose a column and the direction.
3. Add more levels. Drag them to change which comes first.
4. "Remove sort" removes a level. With no sort, items keep the board order.

In the table you can also sort subitems ("Sort subitems") by the subitems' own columns.

## Group items

By default the table shows the board's own groups. To group by a column instead:

1. Click "Group by".
2. Under "Group by" choose a column. "No grouping (board groups)" goes back to the board's groups.
3. Choose the "Order" and how to group, depending on the column:
   - dates: by when (today, this week, next month, overdue...), or by day, week, month, quarter or year; a timeline by its "Start" or "End". "Show the past in detail (last week, last month...)" splits the past too.
   - people: "Each person", "By combination" or "By team".
   - numbers: "Exact value" or "Ranges" ("Range size", or "Automatic").
   - text: "Each value", "By name (A–Z)" or "First letter"; email "By domain"; phone "By country".
4. Tick "Also show empty labels" to keep groups with no items.
5. "+ Another grouping level (up to 3)" adds a level inside. Drag levels to reorder them.

Grouping is "Saved in the view, like filters and sorting."

## Hide columns

1. Click "Hide" (it shows "{n} hidden" when some are hidden).
2. Untick the columns to hide. "Search columns" finds a column by name. "Show all" and "Hide all" do it in one click.
3. Subitem columns have their own list under "Subitems".
4. Drag a column in this list to change the column order.

Hiding never deletes data.

## Color items by a rule

1. Click the gear ("View settings") and choose "Color".
2. In "Conditional coloring", click "New coloring rule".
3. Set "When" (the condition) and "Color": "the whole item" or one column's cell, and the color.

Rules apply top to bottom — the first match wins.

## Save what you set up

Filter, sort, grouping, hidden columns and coloring belong to the view and start as your draft. Use "Save to view" to keep them for everyone, "Save as new view" for a new tab, or "Reset" to drop them. See [Views](views.md).

## Keyboard shortcuts

| Keys | What it does |
| --- | --- |
| Ctrl+B | "Search everything" |
| Ctrl+F | "Search the board" |
| Ctrl+G | "Collapse / expand all groups" |
| Shift+? | "Shortcut list" |

## Related

- [Views](views.md)
- [Boards, groups and items](boards-groups-items.md)
- [Columns](columns.md)
- [Dashboards](dashboards.md)
- [Notifications and inbox](notifications-and-inbox.md)
- [AI](ai.md)
