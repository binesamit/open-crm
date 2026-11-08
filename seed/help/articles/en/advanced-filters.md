---
title: "Advanced conditionss: conditions, condition groups and connectors"
slug: advanced-filters
locale: en
translation_of: advanced-filters
category: "search-filter-and-sort"
tags: ["filters", "views", "subitems", "columns"]
visibility: public
excerpt: "How to build a complex filter with “and” and “or”, nested condition groups, negation, relative dates, system columns and subitem columns."
publish: true
---
The quick filter is enough for most everyday questions, but sometimes you need to ask something more complex. For example: "deals with status New, **or** high-priority deals that are overdue, **but not** ones without a client". The advanced filter builds questions like these from conditions and condition groups, in the same editor used for conditional coloring, automations and other places in the app.

## What you'll learn

- Add conditions and choose a column, condition and value
- Connect conditions with "and" or "or"
- Create condition groups and use negation
- Filter by relative dates, system columns and subitems

## Adding a condition

1. In the board toolbar, click **Filter**.
2. Scroll to the **Advanced conditions** section and click **+ Condition**.
3. In the new condition, choose:

   - **Column** – any column on the board, plus system fields (see below).
   - **Condition** – the options depend on the column type.
   - **Value** – a choice from a list, text, a number or a date, as needed.
4. The board updates right away. **Remove condition** (X) deletes the condition.

![The advanced filter section with two conditions and a nested condition group](images/advanced-filters-1.webp)

### Which conditions each column type has

| Column type | Example conditions |
| --- | --- |
| Text, name, email | **is**, **is not**, **contains**, **does not contain**, **starts with**, **ends with**, **is empty**, **is not empty** |
| Numbers | **greater than**, **greater than or equal**, **lower than**, **lower than or equal**, **between**, **is empty** |
| Status and dropdown | **is**, **is not**, **is done**, **is not done**, **is empty**, **is not empty** |
| Date and timeline | **is**, **before**, **after**, **between**, **in the last**, **in the next**, **is empty** |
| People | **is** (including **Me** and teams), **is not**, **is empty** |
| Checkbox | **Checked**, **Not checked** |

A condition that has no value yet simply doesn't affect the result, so you can build the filter step by step.

## "And" and "or"

When there is more than one condition, a connector picker appears next to the second condition:

- **And** – an item shows only if it meets **all** the conditions.
- **Or** – an item shows if it meets **at least one** of the conditions.

The choice applies to all the conditions at the same level, so inside one group all the conditions are joined by the same word. To combine "and" with "or", use condition groups.

## Condition groups

1. Click **+ Condition group**. An indented frame is created with a first condition and its own connector picker. By default it is the opposite of the one at the level above.
2. Add conditions to the group with the **+ Condition** inside it.
3. You can create a group inside a group, up to five levels deep.
4. **Remove group** deletes the group with all its conditions.

**Example:** "Status **is** New **or** (Priority **is** High **and** Due date **is** Overdue)":

1. At the top level, choose **Or**.
2. Condition 1: Status **is** New.
3. **+ Condition group**, and inside it **And**: Priority **is** High, and Due date **is** Overdue.

## Negation

At the top of every condition group (the indented frame) there is a **Not** button. When it is on, the frame turns red and the group shows what does **not** meet its conditions. This lets you say "everything except…". For example, create a **+ Condition group** with the condition Client **is empty** and turn on **Not** in it: only items that have a client are shown.

## Relative dates

In date columns, use relative values so the filter stays correct over time:

- **Today**, **Tomorrow**, **Yesterday**
- **This week**, **Next week**, **Last week**, **This month**, **This quarter**, **This year** and more
- **In the past**, **In the future**, **Overdue** (a past date on an item that isn't marked done yet)
- A number of days: type a number and choose **days ago** or **days ahead**
- **Exact date…** to pick from a calendar

With **in the last** and **in the next** you choose a number and a **Unit**: **days**, **Working days**, **weeks** or **months**. Working days and the first day of the week follow the account settings.

![Choosing a relative date value in a condition, with the options Today, This week and Overdue](images/advanced-filters-2.webp)

## System fields and subitems

The column list also includes fields that aren't shown as columns:

- **Group** – the group the item is in
- **Creation date** and **Last updated**
- **Created by**

On a board with subitems, their columns also appear, named **Subitem: …**. A condition like this shows items that have a matching subitem, and expands only the matching subitems. Above the editor there is also the option **Person also finds items by their subitems**, which makes filtering by person and search show an item even when only one of its subitems matches.

## Connect boards columns

If a connect boards column is set to "only suggest items that…", by view or by filter, the filter shows two extra conditions for it: **has a link that does not match its filter** and **all links match its filter**. This makes it easy to find, for example, deals linked to a client who is no longer active.

## Where else this editor is used

The same condition editor is also used in:

- **Conditional coloring** – each coloring rule is a condition
- **Automations** – conditions that decide when an automation runs
- Limiting the suggestions in a connect boards column
- Filtering dashboard widgets

## Saving and sharing

The filter is part of the view. Once you've built it, click **Save to view** or **Save as a new view** in the save bar, and everyone who opens the view sees the same result. Relative dates such as "this week" are recalculated every time the view opens.

## FAQ

**How many conditions can I add?**\
Up to 50 conditions in one filter, in up to five levels of groups.

**What's the difference between "is not" and negating a group?**\
**is not** negates one condition. **Not** negates a whole group of conditions, for example "Not (Status is Done and Owner is Me)".

**Do the quick filter and the advanced filter work together?**\
Yes. Both edit the same filter. A value chosen in the quick filter also appears as a condition in the advanced section, and vice versa.

## See also

- Search, filter, sort and group on a board
- Conditional coloring
- The automation builder: triggers, conditions and actions
- Connect boards and the mirror column
- Working with views
