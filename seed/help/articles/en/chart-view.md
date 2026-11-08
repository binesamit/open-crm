---
title: "Chart view"
slug: chart-view
locale: en
translation_of: chart-view
category: "views"
tags: ["views", "dashboards", "filters"]
visibility: public
excerpt: "Turn board data into a bar, line, pie or donut chart, with a count, sum or average, that updates in real time."
publish: true
---
The chart view sums up the board in one picture: how many items are in each status, the total deals per salesperson, how the number of requests changes from month to month. The chart is calculated directly from the board's items and updates as soon as something changes, and below it there's a table with the exact numbers.

## What you'll learn

- How to create a chart view
- How to choose a chart type, axis and measure
- How to split bars by another value
- How the board's filter affects the chart

## Creating a chart view

1. At the top of the board, click **+** next to the view tabs.
2. Choose **Chart**, give it a name and click **OK**.
3. By default, the chart counts the items in each group of the board.
4. Click **View settings** in the toolbar to build the chart you need.

![A bar chart view of the total deals by status, with the table of values below](images/chart-view-1.webp)

## Chart settings

| Setting | What you choose |
| --- | --- |
| **Chart type** | **Bars**, **Stacked bars**, **Line**, **Pie** or **Donut** |
| **X axis** (or **Slices by** for pie and donut) | **Board groups**, or any column you can group by: status, people, dropdown, date and more |
| **Time unit** | When the axis is a date column: **Day**, **Week**, **Month**, **Quarter** or **Year** |
| **Split by** | For stacked bars: another column that splits each bar into colors |
| **Measure** | **Number of items**, **Sum**, **Average**, **Median**, **Minimum** or **Maximum** |
| **Numbers column** | When you choose a measure other than a count: the column it's calculated on |

![The chart's “View settings” window with “Chart type”, “X axis”, “Split by” and “Measure”](images/chart-view-2.webp)

> **Tip:** When the axis is a status column, each bar in the chart takes the color of its label, so the chart "speaks" the same language as the board.

## Useful examples

- **How many items in each stage:** type **Bars**, X axis = the status column, measure **Number of items**.
- **Revenue by month:** type **Line**, X axis = the close date column, **Time unit** = **Month**, measure **Sum** of the amount column.
- **Work breakdown by owner:** type **Pie**, **Slices by** the people column.
- **Who's working on what:** type **Stacked bars**, X axis = the people column, **Split by** = the status column.

## The chart and the board's filter

The chart is calculated only on the items that match the view. **Search**, **Filter** and the **Person** filter in the toolbar change the chart right away. So you can, for example, filter to the current quarter only and save the view as "Quarter sales".

As in every view, every change to the settings or the filter is a draft until you click **Save to view**.

> **Note:** On very large boards, the chart is calculated on up to the first 5,000 items that match the filter, and a message such as **The chart reads the first 5000 matching items.** appears. Narrow it down with a filter to get the full picture.

## FAQ

**The chart is empty. What do I do?**\
If **No data to chart** appears, the filter may be hiding all the items, or you chose a measure on an empty column. Change the filter, or choose a different axis and measure in the view settings.

**What's the difference between a chart view and a chart widget on a dashboard?**\
The drawing and the options are the same. A chart view belongs to one board and is affected by its filter; a dashboard widget can summarize several boards together.

**Can I show several charts together?**\
Create several chart views, or use a **Dashboard** view on the board to place several widgets side by side.

## See also

- Working with views
- Dashboards and widgets
- Sharing a dashboard, and a dashboard inside a board
- Search, filter, sort and group on a board
