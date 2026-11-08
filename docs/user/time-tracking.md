# Time tracking

Hebrew version: [time-tracking.he.md](time-tracking.he.md)

## What it's for

Record how much time goes into each item — with a timer, or by typing it in afterwards — and get hours per person,
per item or per day for billing and reports. Every item keeps a log of time entries: who worked, from when to when,
with a note. The cell shows the total.

## Add a time tracking column

1. On the board, press "Add column".
2. Choose "Time tracking".

A board can have more than one time tracking column (for example one per kind of work).

## Start and stop the timer

1. Hover over the time tracking cell of an item.
2. Press "Start timer". The cell counts live while it runs.
3. Press "Stop timer" when you finish. The time is added to the item's total.

Good to know:

- You can run several timers at once, on different items. Several people can run a timer on the same item; each
  person has one timer per cell.
- Hover over a running cell to see who is running it and since when ("Running for … since …").
- A timer that has been running for more than 12 hours is flagged: "Running for over 12 hours — forgot to stop it?".
  Stop it and correct the end time in the log.

## Open the time log

Click the total in the cell ("Time log"), or open the item and go to the "Time" tab. The log lists every entry: date,
start, end, duration, person, source ("timer" or "manual") and note, with the "Total" at the top. An entry someone
changed is marked "Edited by …". Use "Export CSV" to download the item's log.

## Add time by hand

1. In the time log press "Add entry".
2. Pick the "Date" and the "Start".
3. Choose "By duration" and type the "Duration" (like 1:30 or 1.5), or "By end time" and pick the "End".
4. Optionally add a "Note", then press "Save".

Rules: time cannot be logged in the future, the end must be after the start, and one entry can be at most 24 hours.

## Edit or delete an entry

In the time log, open the entry's "Actions" menu and choose "Edit" (change start, end or note) or "Delete". You can
change your own entries; board owners and account admins can change anyone's.

## Get a time report for a board

1. Open the board, press "More actions" and choose "Time report". (It appears only on boards with a time tracking
   column.)
2. Pick the "Dates" (or "All time"), group "By" "Person", "Item" or "Day", and "Whose" ("Everyone" or one person).
3. The report shows "Hours", "Billable" hours and the number of "Entries", with a "Total". Timers that are still
   running are counted up to now.
4. Press "Export CSV" to download it.

## Show hours on a dashboard

Add a "Time report" widget to a dashboard. You can choose the "Period", group by "User", "Board", "Item", "Day" or
"Column (e.g. client)", and show "Billable hours only". See [Dashboards](dashboards.md).

## Start and stop timers automatically

Automations have the actions "Start time tracking" and "Stop time tracking" — for example, start the timer when an
item's status changes to an in-progress label, and stop it when it is done. See [Automations](automations.md).

## Related

- [Columns](columns.md)
- [Item card and collaboration](item-card-and-collaboration.md)
- [Dashboards](dashboards.md)
- [Automations](automations.md)
- [Import and export](import-export.md)
