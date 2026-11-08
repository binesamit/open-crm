# Calendar and Google sync

Hebrew version: [calendar-and-google-sync.he.md](calendar-and-google-sync.he.md)

## What it's for

See a board's items on a calendar, plan by the hour, count durations in working days, show Hebrew dates and holidays,
and keep a board in two-way sync with Google Calendar (or another calendar). The calendar always shows real items: a
change on the calendar changes the item, and the other way round.

## Add a calendar view to a board

1. Open the board and press "New view" next to the view tabs.
2. Choose "Calendar".
3. If the board has no date column yet, the view says "A calendar needs a date or timeline column on the board." Press
   "Add a date column" or "Add a timeline column".
4. If the board has several date columns, choose "Which column does the calendar show?". The choice is kept in the
   view; press "Save" on the view to keep it for everyone.

Switch between "Day", "3 days", "Week", "Work week" and "Month", and use "Today", "Previous" and "Next" to move around.

## Add and move items on the calendar

- To add: click a day (or an hour). In "What goes on this day" choose "New item" (type the "Item name" and pick the
  "Group") or "Existing item" (search by name), then press "Create".
- To move: drag the item to another day or hour. The date in the item changes at once.
- Right-click an item for "Quick edit", to change its status, set a "Colour" (or create a colour column), or "Open
  item".
- "All day" items sit at the top of each day in the hour views.

## Plan by the hour

1. Open "View settings" of the calendar view.
2. Turn on "Show by the hour".
3. Under "Where the hours come from" choose:
   - "Timeline with hours": one timeline column that holds the start and end date and time. If the column has no
     hours yet, press "Turn on hours in the column".
   - "Date + start hour + end hour": three columns. The hours are read in the account's time zone. You can choose "No
     end hour (fixed length)".
4. Optionally set "Drag snaps to (minutes)", "Hours shown" ("From" / "To"), "Hour height", "New item length", "Show
   weekends" and "Fields on the card".

## Weekend and first day of the week

Account admins set them in "Administration" > "General" > "Dates, times and currency" ("Weekend", "First day of the
week"). They are used by calendars, date pickers and working-day counts.

## Show Hebrew dates

Account admins choose in "Administration" > "General" > "Calendar & working days" > "Hebrew date":

- "Off".
- "In calendars only": the Hebrew date appears in calendars.
- "Also in table cells": also as a second line in date cells.

A single date column can also show or hide it: in the column's settings, "Hebrew date" > "Shown" or "Hidden".

## Holidays and the account's own days

In "Administration" > "General" > "Calendar & working days":

1. Pick a "Holiday set" ("Israeli holidays" or "No holidays").
2. Under "Holidays", set each holiday's "State": "Day off", "Half day", "Marked working day" or "Not shown". The list
   shows each holiday's next date. A holiday marked "Locked by the platform owner" cannot be changed in the account.
3. Under "The account's own days" press "Add a day" for days of your own, such as a team day or a year-end closing:
   pick a date or a range, give it a "Day name" and a state.
4. Turn on "Mark days off in the date picker" to show a red dot under days off and an orange one under half days. A
   date column can choose this for itself ("Mark days off in the picker").

A field you leave unset follows the platform default; "Back to the platform default" undoes your change.

## Count working days

- "Default duration counting" (in "Calendar & working days") decides how the length of a date span is counted when a
  column does not choose otherwise: "Calendar days", "Working days (without weekends)" or "Working days (without
  weekends and holidays)". "A half day counts as" sets whether a half day counts as half a day, a working day or a day
  off.
- In a timeline column's settings: "Count the duration in", "Show the duration in the cell and on the bar", and "Keep
  the working days when moving" (moving a bar keeps its number of working days; the end moves to fit).
- In timeline and Gantt views, "Working days only" hides weekends and days off from the time axis; half days stay.
- When you select several items, "Shift dates" can move a date column by days or by working days.
- Item templates can set dates in working days on the account's calendar (see [Item templates](item-templates.md)).

## Sync a board with Google Calendar

Two-way sync with Google Calendar, or any CalDAV calendar (iCloud, Fastmail, Nextcloud and others), comes as the
"Calendar sync" extension. It is available when your platform offers it; an account admin installs it from
"Administration" > "Extensions" (see [Extensions](extensions.md)).

### Set it up (admin)

Open the extension's settings page ("Calendar sync — settings") and go through its steps:

1. "Google connection": connect your own Google calendar (needed to pick a shared calendar).
2. "Board and hours": pick the board and "Where the hours are" — "Timeline with hours" or "Date + hours".
3. "People and calendars": pick the people column and the target — "Each person's calendar", "A shared calendar" or
   "Both" — and what happens to "A meeting with nobody in it" ("The calendar of whoever created it" or "Do not sync").
4. "What syncs": create, update and delete, each direction on its own ("From the board to Google", "From Google to the
   board"), and what a delete does on the other side.
5. "Invitations and answers": optionally "Send invitations" to the people in the item and to guests from an email
   column, choose "Who is told about invitations and changes", and turn guests' answers into a status label. You can
   also add a "Google Meet link on new meetings", "Reminders", and "Import recurring events".
6. "New calendar event": how an event made in the calendar becomes an item ("Item name", "Group", "Columns").
7. "Status and activity": the sync status, a log of actions, and "Sync now".

### Connect your own calendar (every member)

1. Open your name > "My profile", and find "My connections" > "My calendar".
2. Press "Connect" next to "Google Calendar" and approve in Google's window. For another calendar choose "Another
   calendar (CalDAV)" and enter the "Server address", "User name" and an "App password", then "Check and connect".
3. Under "What syncs" choose the "Calendar to sync" (the "Main calendar" by default) and "What comes into the board from
   my calendar": "Board meetings only" (the default), "Also new ones", or "Also existing" (with "Days back"). Your admin
   may limit this choice.

Meetings on the board that you are part of go to the calendar you connect, and changes there come back to the board.
A change on the board reaches your calendar at once; a change in your calendar reaches the board within seconds and at
most within a few minutes. "Disconnect" stops the sync; events already in your calendar stay there.

## Related

- [Views](views.md)
- [Columns](columns.md)
- [Item templates](item-templates.md)
- [Extensions](extensions.md)
- [Account administration](account-admin.md)
- [Automations](automations.md)
