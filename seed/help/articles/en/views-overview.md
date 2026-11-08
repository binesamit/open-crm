---
title: "Working with views"
slug: views-overview
locale: en
translation_of: views-overview
category: "views"
tags: ["views", "boards", "filters"]
visibility: public
excerpt: "How to create views on a board, save filters and settings in them, arrange and pin tabs, and lock and share views with your team."
publish: true
---
A view is a different way to look at the same board data: table, Kanban, calendar, Gantt, chart and more. All views read exactly the same items, so a change you make in one view (for example, moving a card in Kanban) shows up in all the others right away. Each view keeps its own filters, sorting, grouping and settings, so everyone on the team can jump to the angle they care about in one click.

## What you'll learn

- Which view types exist and how to create a new view
- How to work with unsaved changes and how to save them
- How to arrange, pin, duplicate and copy views
- The difference between a shared, private and locked view

## The main view and view types

Every board opens with the **Table** view. This is the board's base view: you can't delete it or change its type, but you can filter and sort in it as usual.

Beyond it, you can add views of these types:

| View type | Especially good for… |
| --- | --- |
| **Table** | Day-to-day work with rows and columns |
| **Kanban** | Managing stages with cards you drag between columns |
| **Calendar** | Items by date, by month or week |
| **Cards** | A gallery of cards with the important fields |
| **Timeline**, **Gantt**, **Workload** | Planning over time, dependencies and spreading the load between people |
| **Chart** | A visual summary of the data |
| **Files** | All the board's files in one place |
| **Map** | Items by address |
| **Form** | Collecting requests from outside straight into the board |
| **Dashboard** | Widgets that summarize the board |

> **Note:** The **Form** and **Dashboard** views are available according to the account's plan. If they aren't included, they appear grayed out in the menu, with an upgrade link.

## Creating a new view

1. At the top of the board, next to the view tabs, click **+** (**New view**).
2. Choose the view type from the list.
3. In the window that opens, type the **View name** and click **OK**.

![The “New view” menu open next to the view tabs, with the list of view types](images/views-overview-1.webp)

The new view starts from what is on your screen at that moment, including any filter, sort or grouping you turned on. So you can filter first, and only then "freeze" the result into a view of its own.

> **Tip:** The settings specific to each view type (for example, which column the Kanban is split by) are under the **View settings** button in the board toolbar.

## Unsaved changes

Every change you make to a view (filter, sort, grouping, hiding columns or view settings) starts out as a personal draft. The tab gets a small dot, and the bar shows a count such as **3 unsaved changes** with three options:

- **Save to view** — the changes are saved in the view and update for everyone who sees it.
- **Save as a new view** — creates a new view from the current state and leaves the original as it was.
- **Reset** — discards the draft and goes back to the saved settings.

![The unsaved changes bar, with the “Save to view”, “Save as a new view” and “Reset” buttons](images/views-overview-2.webp)

The draft survives a page refresh and switching between views, so you won't lose work by accident. In the **Table** view, saving always creates a new view, so the board's base view stays clean.

> **Note:** If someone else saved the same view while you were working, the message **Someone else saved this view meanwhile** appears, and you can choose **Overwrite** or save your changes as a new view. If the view was updated while you have an open draft, you can choose **Show the new version** or **Keep my changes**.

## View actions

Click **⋯** on the tab (or right-click it) to open the actions menu:

- **Pin to the front** / **Unpin** — pinned views always appear first.
- **Rename** — you can also double-click the tab.
- **Duplicate** — creates a copy of the view with all its settings.
- **Copy to another board…** — copies the view to another board; columns are matched by type and name.
- **Set as default** — the view that opens for everyone when they enter the board.
- **Lock view** / **Unlock** — protects the settings from changes.
- **Share with everyone** — makes a private view visible to the whole team.
- **Delete view**.

### Arranging the tabs

Drag a tab right or left to change the order. The order and pins are **personal**: they affect only you, and everyone on the team can arrange the tabs however suits them, even people with view-only access.

## Shared, private and locked views

- **Shared** — visible to everyone who can see the board.
- **Private** — visible only to you. The tab shows the **Private** label. People who aren't allowed to create shared views automatically create private ones, and can always ask the board admin to **Share with everyone**.
- **Locked** — marked with a lock. Everyone can filter and sort in it as a draft, but only board owners and account admins can save changes to it. Everyone else sees **This view is locked — save as a new view**.

> **Tip:** Locking doesn't hide information, it only protects the settings. To limit who sees what, use board permissions.

## FAQ

**I changed a filter and it disappeared for my teammate. Why?**\
Until you click **Save to view**, the change is your personal draft only. Save it so everyone sees it.

**Can I copy settings from another view?**\
Yes. In the **View settings** window, choose **Copy settings from a view** and the view (of the same type) you want to copy from. The settings come in as a draft; save to apply them.

**Why can't I delete the main table?**\
It's the board's base view, and it always exists. You can set another view as the default instead.

## See also

- Search, filter, sort and group on a board
- Kanban view
- Calendar view
- Timeline, Gantt, dependencies and workload
- Board permissions and item visibility
