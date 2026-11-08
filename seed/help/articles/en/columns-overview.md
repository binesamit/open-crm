---
title: "Adding and managing columns"
slug: columns-overview
locale: en
translation_of: columns-overview
category: "columns"
tags: ["columns", "boards", "getting-started"]
visibility: public
excerpt: "How to add a column to a board, choose the right type, change its name, order and width, add a description and delete columns you no longer need."
publish: true
---
Columns are the backbone of every board: each column defines one kind of information collected about every item, for example a status, a due date, the team member in charge or an amount. Choosing the right column type matters, because it decides how the value is filled in, how you filter and sort by it, what the summary row shows and which automations you can build on it. In this article you'll find every column type in the system and every action you can take on a column.

## What you'll learn

- How to add a new column to a board and choose its type
- Which column types exist and what each one is for
- How to change a column's name, order and width, and add a description
- How to hide a column from the view and how to delete it
- How to decide where the item name comes from

## Adding a new column

1. Open the board and scroll to the end of the table's header row.
2. Click **+** (**Add column**).
3. The window that opens shows every column type as a tile. Type in the **Search column type** field to narrow the list, for example "date".
4. Click the type you want (or press Enter to add the first result). The column is added right away at the end of the table, with the type's name as a temporary name.

![The add column window with the search field and the column type tiles](images/columns-overview-1.webp)

You can also add a column in an exact spot: open the menu of the neighboring column (see below), choose **Add column to the left** or **Add column to the right**, and then the type from the submenu.

> **Note:** Adding, changing and deleting columns is available to anyone with full edit permission on the board (board owners, editors and account admins). Members with content-only edit permission can fill in values, but can't change the board's structure.

## All column types

| Column type | What it's for | Detailed article |
| --- | --- | --- |
| **Name** | The item's name. Every board has exactly one, and it can't be deleted | Items: creating, editing and duplicating |
| **Text** | Short free text, with suggestions from values already in the column | – |
| **Long text** | Long notes and descriptions, opened in an editing panel | – |
| **Numbers** | Quantities, amounts and percentages, with a currency or unit | Numbers, rating, progress tracking, checkbox and vote |
| **Status** | One colored label from a list, including a "Done" label | Status, dropdown and tags |
| **Dropdown** | Choosing one or more labels from a list | Status, dropdown and tags |
| **Tags** | Tags shared across the whole account | Status, dropdown and tags |
| **Date** | A single date, for example a due date | Date, timeline, hour and week |
| **Timeline** | A date range from start to end | Date, timeline, hour and week |
| **Hour** | A time of day | Date, timeline, hour and week |
| **Week** | A week of the year | Date, timeline, hour and week |
| **People** | Assigning people, teams and digital workers | The people column |
| **Email** | A clickable email address | Email, phone, link, location and country |
| **Phone** | A phone number with WhatsApp, call and SMS actions | Email, phone, link, location and country |
| **Link** | A web address with display text | Email, phone, link, location and country |
| **Location** | An address that's placed on the map | Email, phone, link, location and country |
| **Country** | A country with its flag | Email, phone, link, location and country |
| **World clock** | A time zone and live local time | Email, phone, link, location and country |
| **Checkbox** | Yes / no | Numbers, rating, progress tracking, checkbox and vote |
| **Rating** | Stars | Numbers, rating, progress tracking, checkbox and vote |
| **Vote** | One vote per user | Numbers, rating, progress tracking, checkbox and vote |
| **Progress tracking** | A completion percentage calculated from statuses and subitems | Numbers, rating, progress tracking, checkbox and vote |
| **Formula** | A calculation from other columns | The formula column |
| **Connect boards** | Linking to items on another board | Connect boards and the mirror column |
| **Mirror** | Showing values from the connected items | Connect boards and the mirror column |
| **Dependency** | Preceding items on the same board, for the Gantt | Timeline, Gantt, dependencies and workload |
| **Files** | Attached files and documents | The files column |
| **Time tracking** | A timer and logged hours | Time tracking and timesheets |
| **Doc** | A full document inside the cell | Special columns: button, doc, secret and more |
| **Button** | A button that runs an action on the item | Special columns: button, doc, secret and more |
| **Secret** | An encrypted password or key | Special columns: button, doc, secret and more |
| **Color picker** | A color code | Special columns: button, doc, secret and more |
| **Item ID** | A running number for each item, with a prefix | Special columns: button, doc, secret and more |
| **Creation log** | Who created the item and when | Special columns: button, doc, secret and more |
| **Last updated** | Who updated the item and when | Special columns: button, doc, secret and more |
| **AI** | A value filled in by an AI model | The AI column |

> **Tip:** **Formula**, **Mirror**, **Progress tracking**, **Item ID**, **Creation log** and **Last updated** columns are calculated automatically, and you can't type a value into them.

## The column menu

Hover over the column header and click **⋯** (or right-click the header). In the menu you'll find:

- **Rename**: you can also click the column name or press F2.
- **Edit description**: a short explanation of the column and how to fill it in. When there's a description, an (i) mark appears next to the column name, and hovering over it shows the explanation.
- **Column settings**: appears for types that have settings (numbers, formula, connect boards, mirror, phone and more).
- **Add column to the left** / **Add column to the right**.
- **My width for everyone**: column width is personal; this action makes your width everyone's default.
- **Change column type** and **Type change history**: for board owners and account admins (see "Converting a column's type").
- **Copy column ID**: useful in formulas, the API and automations.
- **Delete column**: after you confirm. The name column can't be deleted.

![A column's action menu opened from the column header](images/columns-overview-2.webp)

## Order, width and hiding

1. **Change the order:** drag the column header and drop it in the new position.
2. **Change the width:** drag the edge of the column header. The width is saved for you only.
3. **Hide:** in the board toolbar, click **Hide**, and tick or untick columns. You can search in **Search columns**, and use **Show all** or **Hide all**. The button shows how many columns are hidden right now. Hiding belongs to the view, so you can save different views with different columns.

## Item name source

In the name column's header, click **⋯** and choose **Item name source**. In the **How items are named** window you can choose:

- **Free text**: you type the name, as usual.
- **From a column**: the name is the value of one column, for example an order number or the client's name.
- **Template**: combine several columns with text between them, for example client and date. You can set **Text when empty** and tick **Warn when two items get the same name**.

When the name is calculated, you change it through the columns it's built from, and you can't delete a column that's used as the name source.

## Frequently asked questions

**Does deleting a column delete all its values?**\
The column and all its values are removed from the board, so you'll be asked to confirm before deleting. If you change your mind, you can undo the deletion and bring the column back with its values (see "Undoing actions and the activity log").

**How do I change a text column into a numbers column without losing data?**\
Use **Change column type** from the column menu. The system shows a preview and keeps a backup of all the values.

**Why don't I see the button to add a column?**\
You probably don't have full edit permission on the board. Contact the board's owners.

## See also

- Status, dropdown and tags
- Converting a column's type
- The formula column
- Search, filter, sort and group on a board
- Board permissions and item visibility
