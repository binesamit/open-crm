---
title: "Conditional coloring"
slug: conditional-coloring
locale: en
translation_of: conditional-coloring
category: "boards-groups-and-items"
tags: ["views", "boards", "filters"]
visibility: public
excerpt: "How to color a whole item or a single cell by a condition, for example overdue tasks in red and large amounts in green, and save the coloring in the view."
publish: true
---
Conditional coloring turns the board into an instrument panel: whatever needs attention jumps out without searching. You set a rule, for example "when the due date is overdue", and choose what to color and in which color. Every item that meets the condition is colored right away, and when it no longer meets it, the color goes away by itself. Conditions are built exactly like filter conditions, so you can use any column and any operator you already know.

## What you'll learn

- Opening the coloring panel in the view settings
- Creating a rule that colors a whole item or a single cell
- Understanding the order of rules and which one "wins"
- Saving the coloring in the view and sharing it with the team

> **Note:** Conditional coloring is available in the table view. The rules are saved as part of the view, so each view can have different coloring.

## Opening the coloring panel

1. On the board, go to the table view you want to color.
2. In the toolbar, click the gear icon (**View settings**).
3. Click **Color**. If there are already rules, their number appears next to it.

The **Conditional coloring** panel opens, with the explanation: rules work from top to bottom, and the first one that matches decides.

## Creating a coloring rule

1. Click **+ New coloring rule**.
2. In the **When** row, build the condition:

   - Choose a **Column**, for example "Status", "Due date", "Amount" or "Name".
   - Choose a **Condition**, for example **is**, **contains**, **greater than**, **before** or **is empty**.
   - Choose or type the **Value**.
3. In the **Color** row, choose what to color:

   - **the whole item**: the whole row gets a background in the color you chose.
   - **the … cell**: only the cell in the column you chose is colored. The column doesn't have to be the one in the condition.
4. Click one of the color circles.

The change shows on the board right away, even before you close the panel.

![The conditional coloring panel with two rules: a whole item in red and a cell in green](images/conditional-coloring-1.webp)

### Useful examples

| What you want to see | Condition | What to color |
| --- | --- | --- |
| Tasks past their due date | Due date **is** overdue | The whole item, in red |
| Big deals | Amount **greater than** 10,000 | The cell in the amount column, in green |
| Urgent items | Name **contains** "urgent" | The whole item, in orange |
| My tasks | Owner **is** me | The cell in the owner column, in blue |
| No owner | Owner **is empty** | The cell in the owner column, in gray |

> **Tip:** In date columns you can choose relative values such as **Today**, **This week**, **Overdue** or **in the last …**. That way the coloring stays correct tomorrow and next week too, without updating the rule.

## The order of rules: which one wins

- Rules are checked from top to bottom.
- Each row's item color is set by the first matching rule among the **the whole item** rules.
- Each cell's color is set by the first matching rule among the rules that color that same cell.
- A cell's color is set separately from the row's color, so you can combine them: a row in one shade and a highlighted cell in another.

If two rules clash, make sure the more important one is on top. To change the order, delete the less important rule and create it again; it's added at the bottom.

## Editing and deleting rules

- To change a rule, just change its column, condition, value, target or color.
- To delete a rule, click the **Remove condition** button (X) at the end of the condition row.
- A single view can have up to 30 rules.

## Saving and sharing

Like any change to a view, coloring rules are kept as a draft until you decide to save:

1. Close the panel (Esc or click outside it). The text "N unsaved changes" appears above the board.
2. Click **Save to view** to save in the current view, or **Save as a new view** to create a separate view (you'll be asked to name it and confirm). **Reset** discards the changes.

![The save bar with the Save to view and Reset buttons](images/conditional-coloring-2.webp)

> **Note:** You can't save changes directly to the board's main table. Instead, **Save as a new view** creates a new view with the coloring. Everyone who opens a saved shared view sees it.

## Frequently asked questions

**The color didn't show on an item that meets the condition. Why?**\
Check that there isn't another rule above it that matches the same row or the same cell. The first matching rule decides. Also check that the condition is complete, meaning a value is chosen.

**Can I color by a subitem column?**\
Yes. When choosing the column, **Subitem: …** columns appear too. An item is colored only if it has a subitem that meets the condition.

**Does the coloring show in Kanban and the calendar too?**\
No. Conditional coloring belongs to the table view. In Kanban and cards, the color is set by the view's own settings.

## See also

- Working with views
- Advanced conditionss: conditions, condition groups and connections
- Search, filter, sort and group on a board
- Status, dropdown and tags
