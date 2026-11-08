---
title: "Time tracking and the time report"
slug: time-tracking
locale: en
translation_of: time-tracking
category: "columns"
tags: ["time-tracking", "columns", "item-page", "import-export"]
visibility: public
excerpt: "How to measure work time with a timer or manual entries in a time tracking column, edit entries, and produce a time report for the board by person, item or day."
publish: true
---
The **Time tracking** column helps you know how much time you really spent on each task, client and project. You can start a timer with one click when you start working, or log time manually afterwards. All entries are collected in the item's time log, and from there you can produce a time report for the whole board, sum it up by people, items or days, and export it to a CSV file for billing clients or for payroll.

## What you'll learn

- How to start and stop a timer
- How to add, edit and delete manual time entries
- How the time log in the item card works
- How to produce a time report for the board and export it

## Adding a time tracking column

Click **+** (**Add column**) at the end of the header row and choose **Time tracking**. Each item's cell shows the total time logged on it, in hours:minutes format.

## Starting a timer

1. Hover over the cell in the time tracking column. The start button appears (▶ **Start timer**).
2. Click it. The timer starts running, the total in the cell updates in real time, and the button turns into a stop button.
3. When you finish working, click **Stop timer**. A new time entry is created in the log.

![A time tracking cell with a running timer and a stop button](images/time-tracking-1.webp)

> **Tip:** You can run several timers at once, on different items, and several people can run timers on the same item. Hovering over the total shows who is running a timer right now and since when.

> **Note:** A timer that runs for more than 12 hours is marked in the log with the message **Running for over 12 hours — forgot to stop it?**, so you can fix the entry.

## The item's time log

Clicking the total in the cell opens the item card on the **Time** tab. Here you see:

- The **Total** time logged on the item, and a button to start or stop your timer.
- A list of all entries: who logged it, when, how long, whether the entry came from a **timer** or is **manual**, and a note if one was written. An edited entry says who edited it.
- An entry that's running right now is marked as **running**.

### Adding a manual entry

Forgot to start a timer? You can log time afterwards:

1. In the time log, click **Add entry**.
2. If the board has more than one time tracking column, pick the **Column**.
3. Pick a **Date** and a **Start**.
4. Set the length in one of two ways: **By duration** (for example 1:30 or 1.5 for an hour and a half) or **By end time**.
5. You can add a **Note**, for example "Spec meeting with the client".
6. Click **Save**.

![The form for adding a manual time entry in the item's time log](images/time-tracking-2.webp)

A manual entry can't be in the future, the end time must be after the start time, and a single entry can last up to 24 hours.

### Editing and deleting an entry

Next to each entry, click **⋯** (**Actions**) and choose **Edit** to fix the date, times or note, or **Delete** to remove it. The total in the cell updates right away.

### Exporting an item's log

At the bottom of the time log, click **Export CSV** to download all of the item's entries to a file you can open in Excel.

## The board's time report

The time report sums up all the time logged on the board.

1. In the board header, click **⋯** (**More actions**) and choose **Time report**.
2. Pick a range of **Dates** in the calendar, or leave it on **All time**.
3. Under **By**, choose how to group: **Person**, **Item** or **Day**.
4. In **Whose**, pick a specific person, or **Everyone**.
5. The table shows **Hours**, **Billable** and **Entries** for each row, with a **Total** at the bottom.
6. Click **Export to CSV** to download the report.

![The board's time report window grouped by person, with a total and an export button](images/time-tracking-3.webp)

> **Tip:** If timers are running when you produce the report, the report includes them up to the current moment and says how many such timers there are.

## Frequently asked questions

**Can I edit the total in the cell directly?**\
No. The total is calculated from the entries. To change it, add, edit or delete entries in the time log.

**What happens to the timer if I close the browser?**\
The timer keeps running on the server. When you come back, you can stop it from the board or from the item card.

**Can I convert a time tracking column to a numbers column?**\
No. Time tracking is based on entries, so it isn't supported in type conversion. To analyze hours in Excel, use the CSV export from the time report.

## See also

- The item card
- My work
- Exporting a board to Excel
- Adding and managing columns
- The chart view
