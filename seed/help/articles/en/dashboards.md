---
title: "Dashboards and widgets"
slug: dashboards
locale: en
translation_of: dashboards
category: "dashboards"
tags: ["dashboards", "boards", "time-tracking", "filters"]
visibility: public
excerpt: "Build a dashboard that sums up several boards together with widgets for numbers, charts, status batteries, tables, workload and time reports."
publish: true
---
A dashboard is a summary screen that brings together data from several boards: how many deals closed this month across all teams, where every active project stands, who's overloaded this week and how many hours were logged for a customer. A dashboard is made of widgets you choose, arrange and configure, and it updates in real time as the data on the boards changes.

## What you'll learn

- How to create a dashboard and choose its boards
- Which widgets exist and how to add them
- How to configure a widget, filter it and arrange the layout
- How to filter the whole dashboard by a search or a person

## Creating a dashboard

1. In the sidebar, click **Add new** (**+**).
2. Choose **New dashboard**. The dashboard is created in the workspace and opens right away.
3. Click the title to give it a name.

> **Note:** Dashboards are available depending on the account's plan.

## Choosing the boards

An empty dashboard shows **No widgets yet** and **Choose boards to get started**.

1. Click **Boards** at the top of the dashboard.
2. In the **The dashboard's boards** window, search for and tick the boards, from any workspace, up to 50 boards.
3. Click **Save**. The number of boards appears next to the title, for example **3 boards**.

## Adding widgets

Click **Add widget** and choose a type:

| Widget | What it shows |
| --- | --- |
| **Numbers** | One big number: count, sum, average, median, minimum or maximum |
| **Chart** | Bars, stacked bars, line, pie or donut |
| **Status battery** | How items split across the labels of a status column, as a single bar |
| **Items table** | A list of items with the columns you choose |
| **Calendar** | Items by date |
| **Timeline** | Items as bars on a timeline |
| **Workload** | Each person's workload |
| **Time report** | Hours logged in time tracking columns, by period |
| **Board view** | A board's view, embedded in the dashboard |
| **Text** | A heading, an explanation or instructions for the team |

Extensions installed in the account can add widgets of their own to the list.

![A dashboard with numbers widgets, a bar chart, a status battery and an items table](images/dashboards-1.webp)

A new widget gets sensible starting settings from the boards, for example a battery on the first status column, and already shows data.

## Arranging the dashboard

- **Move:** drag the widget by its **Drag to move** handle.
- **Resize:** drag the corner (**Drag to resize**).
- **Delete:** in the widget's **⋯** menu, choose **Delete**.

The layout is saved for everyone.

## Widget settings

In the widget's **⋯** menu, choose **Settings**. Every widget has:

- **Title**.
- **Boards**: which of the dashboard's boards the widget reads (**None ticked — all of the dashboard's boards**).
- **Count**: **Items**, **Subitems** or **Both**.
- **Widget filter**: conditions of its own: **Add condition**, and whether **All conditions** or **Any condition** must match.

Plus settings by type, for example:

- **Numbers:** **Calculation**, **Numbers column**, and **Before the number** / **After the number** (such as "hours"). If the column already has a unit set, such as ₪, you don't need to add it again.
- **Chart:** **Chart type**, **X axis** (**Board**, **Group** or **Column**), **Split by** and **Group dates by**.
- **Workload:** **People column** and **Split by status**.
- **Time report:** **Period** (today, this week, this month, this quarter, a custom range and more), **Group by** user, board, item, day or column, and **Billable hours only**.
- **Board view:** **Board** and **View**.

Click **Save** to apply.

![The settings window of a numbers widget with "Title", "Boards", "Count", "Calculation" and "Widget filter"](images/dashboards-2.webp)

> **Tip:** Columns are recognized by their type and name across all boards. If a column has a different name on one board, you can manually choose **The column on** that board.

## Filtering the whole dashboard

In the filter row above the widgets:

- **Search all widgets**: narrows every widget down to the items that match the search.
- **Person**: **Everyone**, **Me**, or a specific team member.

Anyone allowed to edit the dashboard can click **Save the filter for everyone** to make it the standing filter.

## Permissions and data privacy

Each viewer sees in the widgets only what they're allowed to see on the boards. Boards they don't have access to aren't counted for them, and a note appears, such as **2 hidden boards**.

In the **⋯** menu at the top of the dashboard: **Add to favorites**, **Copy link**, **Duplicate dashboard** and **Delete**.

> **Note:** On boards with a very large number of items, the widgets are calculated on the first 5,000 items of each board, and a message says so.

## Frequently asked questions

**A team member doesn't see the "Add widget" button.**\
Only the dashboard's owners and editors can add, move and configure widgets. See the article on sharing a dashboard.

**Does the data update by itself?**\
Yes. A change on a board shows up in the dashboard in real time, for everyone who has it open.

## See also

- Sharing a dashboard and a dashboard inside a board
- Chart view
- Time tracking and time reports
- Timeline, Gantt, dependencies and workload
- Extensions
