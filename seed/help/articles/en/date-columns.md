---
title: "Date, timeline, hour and week"
slug: date-columns
locale: en
translation_of: date-columns
category: "columns"
tags: ["columns", "views", "filters"]
visibility: public
excerpt: "How to use date, timeline, hour and week columns to manage due dates, ranges and schedules, and how they connect to the calendar and Gantt."
publish: true
---
Managing time is at the heart of work on every board: when something is due, when it starts, how long a stage takes, and which week everything is planned for. Four column types help you record this precisely: **Date** for a single date, **Timeline** for a range from start to end, **Hour** for a time of day, and **Week** for a whole week. All choices are made in the app's own calendar and pickers, so the experience is the same in every browser and on your phone.

## What you'll learn

- How to choose a date and a date range
- How hour and week columns work and how to set them up
- What the summary row of date columns shows
- How to filter by dates, and how dates feed the calendar and Gantt

## Date column

1. Click a cell in the date column.
2. In the calendar that opens, choose a day. The date is saved right away and the panel closes.
3. To move between months, use the arrows (**Previous month** / **Next month**), or click the month name (**Choose month**) to jump to a different month and year. **Today** takes you back to today's date.

![A date column's calendar open above a cell on the board](images/date-columns-1.webp)

The date is shown according to your region settings (for example day/month/year), so each user sees it in the format they're used to.

> **Tip:** You can also paste dates from Excel or a spreadsheet. The app recognizes common formats such as 31/12/2026 or 2026-12-31.

## Timeline column

A timeline stores a range: a start date and an end date. It's perfect for project stages, campaigns and vacations.

1. Click the cell. A calendar for choosing a range opens.
2. Click the start date and then the end date. The range is saved as soon as you've chosen both ends.
3. Click outside the panel to close it.

The cell shows a bar with the dates, which fills up gradually according to how much of the range has already passed. When you hover over the bar, a small bubble appears with the number of days in the range (for example "8 days").

![A timeline cell with a progress bar and the number-of-days bubble](images/date-columns-2.webp)

## Hour column

The **Hour** column stores a time of day, without a date. It suits, for example, a fixed meeting time or a delivery time.

1. Click the cell.
2. Type a time in the **Type a time** field (for example 9:30, 0930 or 9:30 pm) and press Enter, or choose an hour from the left column and then minutes in steps of 5 minutes.
3. **Clear** empties the cell.

In **Column settings** you can choose a **Time format**: **By region**, **24 hours** or **12 hours (AM/PM)**.

## Week column

The **Week** column stores a whole week. The cell shows the week number in the year (for example W12) and its range.

1. Click the cell.
2. Click any day in the week you want. The app selects the whole week that day belongs to.

In **Column settings** you can set the **First day of the week**: **Account setting**, or a specific day (Sunday, Monday or Saturday).

## The summary row

In date, timeline and week columns, click the column's cell in the summary row at the bottom of the group and choose:

| Option | What's shown |
| --- | --- |
| **Date range** | From the earliest date to the latest in the group |
| **earliest** | The earliest date |
| **latest** | The latest date |
| **filled** | How many items have a date |
| **None** | No calculation |

## Filtering and sorting by dates

In the board's filter, you can filter date and timeline columns by an exact date, by **between**, and by relative values such as **Today**, **This week**, **Next month**, **Overdue**, **in the last** or **in the next** (with a number of days of your choice). Relative filters update themselves every day, so a "tasks for the coming week" view always stays current. Sorting by date puts items in chronological order, and a timeline is sorted by its start date.

## Dates in views

- **Calendar** – shows items by a date or timeline column. Without such a column, the view asks you to add one.
- **Timeline and Gantt** – show each item as a bar according to its timeline, and let you drag bars to change dates.
- **Dependencies** – a **Dependency** column can move dependent items automatically when the date of a previous item changes.

## FAQ

**Can I convert a date column to a timeline?**\
Yes. Converting the column type turns a date into a one-day timeline. When converting back, you choose whether to keep the start date or the end date, and the other side is kept as a backup.

**Why does the date look different for me than for a colleague?**\
Each user sees dates according to their own region and language settings. The value itself is the same.

**How do I get a reminder before a due date?**\
Build a date-based automation, for example a trigger a number of days before the date in the column, and an action that sends a notification to the owner.

## See also

- Calendar view
- Timeline, Gantt, dependencies and workload
- Search, filter, sort and group on a board
- Converting a column type
- The automation builder: triggers, conditions and actions
