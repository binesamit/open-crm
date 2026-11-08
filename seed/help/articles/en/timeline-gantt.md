---
title: "Timeline, Gantt, dependencies and workload"
slug: timeline-gantt
locale: en
translation_of: timeline-gantt
category: "views"
tags: ["views", "columns", "subitems", "boards"]
visibility: public
excerpt: "Plan projects on a timeline, link tasks with dependencies in a Gantt, and check who on the team is overloaded in the Workload view."
publish: true
---
The three planning views, **Timeline**, **Gantt** and **Workload**, help answer the big questions of any project: what happens when, what depends on what, and who on the team is carrying too much. They all work on the same board items, and a date you change by dragging updates immediately on the board and in every view.

## What you'll learn

- How to use the timeline: zoom, navigation, grouping and colors
- How to move and stretch bars by dragging
- How to set dependencies between tasks and see them in the Gantt
- How to read the Workload view and set capacity

## Timeline

The timeline shows each item as a horizontal bar, based on a **Timeline** or **Date** column on the board.

1. At the top of the board, click **+** and choose **Timeline**.
2. Give it a name and click **OK**.
3. Use the **Previous**, **Today** and **Next** buttons to navigate, and the zoom switch to choose **Days**, **Weeks**, **Months**, **Quarters** or **Years**.

A vertical line marks today, and weekend days are shaded according to the account settings.

### Working with bars

- **Move:** Drag a bar right or left. The item's dates move in whole days.
- **Change length:** In a timeline column, drag one of the bar's ends to shorten or lengthen it.
- **Item with no date:** Click the day you want in its row, and it gets that date (**Click the track to set a date**).
- **Open an item:** Click the item name, or click the bar without dragging.

After each move a message appears, such as **Dates of "Website launch" updated**, with an option to undo. Ctrl+Z also reverts the change.

### Timeline settings

In the toolbar, click **View settings**:

| Setting | Options |
| --- | --- |
| **Date column** | The date or timeline column the bars are drawn from |
| **Group rows** | **By board groups**, **No grouping**, or by a people, status or dropdown column |
| **Color by** | **Group colour**, or by the colors of a status column |

## Gantt

The Gantt is a timeline with a list of **Items** at the side, dependencies shown as arrows, and support for subitems.

1. Click **+** and choose **Gantt**.
2. To see arrows, add a column of type **Dependency** to the board (if there isn't one, you'll see the message **The board has no dependency column. Add a "Dependency" column to see arrows.**).
3. In the dependency column cell, choose the items the current item depends on.

![A Gantt view with a list of items, bars on the timeline, dependency arrows between them, and the "Critical path" button](images/timeline-gantt-1.webp)

### What else the Gantt has

- **Subitems:** Click the arrow next to an item to open its subitems as rows below it.
- **Milestones:** When the Gantt is based on a single date column, each item is shown as a milestone rather than a bar.
- **Critical path:** Click **Critical path** at the top of the view to highlight the chain of tasks where any delay pushes back the end of the project.

In addition to the timeline settings, the Gantt's view settings include **Dependency column (arrows)**, **Subitems as rows under their item** and **Critical path**.

## Dependencies: kind, lag and automatic shifting

Hover over the dependency cell and click the gear (**Kind and lag of each dependency**). For each dependency you can set:

| **Dependency kind** | Meaning |
| --- | --- |
| **Starts after the previous finishes** | The default (finish-to-start) |
| **Starts after the previous starts** | Both tasks start together or with a gap |
| **Finishes after the previous finishes** | A shared finish |
| **Finishes after the previous starts** | A rare case, for planning backwards |

**Lag in days (minus = overlap)** sets how many days separate the tasks.

What happens when a previous task moves is set in the dependency column settings, under **When a previous item moves**:

- **Shift the same**: dependent items move by the same number of days, forward and back, and keep the gap.
- **Shift only on overlap**: dependent items move forward only when an overlap is created, and only as much as needed.
- **Arrows only**: nothing moves automatically.

That's also where you choose the **Date column that moves**.

> **Tip:** The whole chain that moved because of one change is undone in one go with Ctrl+Z.

> **Note:** Dependencies link items from the same board only, and you can't create a loop (a task that depends on itself through other tasks).

## Workload

The Workload view shows a row for each person (or team) and a cell for each day or week, with their load against their capacity.

1. Click **+** and choose **Workload**. You need a people column and a date or timeline column.
2. Choose **Days** (4 weeks) or **Weeks** (12 weeks) in the switch.
3. Each cell shows that person's load for that period; clicking it shows the list of items behind the load.

![A Workload view with a row for each person, cells colored by load, and an over-capacity cell marked in red](images/timeline-gantt-2.webp)

A cell that exceeds capacity is colored with a warning color. Items with no assignee are collected in the **Unassigned** row.

### Workload settings

- **By**: **Items**, **Subitems** or **Items and subitems**. For subitems, also choose the **Subitem columns**.
- **People column** and **Date column**.
- **Measure by**: **Number of items**, or **Number / time-estimate column** (then choose the **Effort column**; the value is spread over the item's working days).
- **Capacity per day**: the default for each person.
- **Capacity per person (empty = default)**: a personal capacity, for example for someone who works part-time.

## Frequently asked questions

**I dragged a bar by mistake. How do I put it back?**\
Click undo in the message that appears, or press Ctrl+Z.

**Why can't I drag?**\
Dragging changes values on the board, so it's available only to people allowed to edit items.

**The dependencies don't move anything.**\
In the dependency column settings, check that **Arrows only** isn't selected, and that a **Date column that moves** is chosen.

## See also

- Working with views
- Date, timeline, hour and week
- Subitems and depth levels
- Calendar view
- Dashboards and widgets
