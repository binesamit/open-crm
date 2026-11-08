---
title: "The item card"
slug: item-card
locale: en
translation_of: item-card
category: "item-card-and-collaboration"
tags: ["item-page", "items", "subitems", "columns"]
visibility: public
excerpt: "How to open the item card, what each tab holds, how to edit fields and subitems from it, and how to tailor the tabs to the board."
publish: true
---
The item card is the "home" of every item: in one place you'll find the updates and the conversation around it, all its fields, its subitems, its time entries and its activity log. The card opens as a panel at the side of the screen, so the board stays behind it and you can get back to it in a moment. Every card also has its own permanent link, so you can send it to a teammate and it opens on exactly the same item.

## What you'll learn

- How to open and close the item card
- What appears in the card header and its actions menu
- What you do in each tab: updates, fields, subitems, time and activity
- How board admins tailor the tabs and fields that appear in the card

## Opening and closing the card

1. On the board, hover over the item row and click **Open**, which appears next to the item name.
2. The card opens as a panel over the screen. On a computer it slides in from the side; on a phone it fills the whole screen.
3. To close it, click **Close** (the X in the corner of the card), click outside the panel, or press **Esc**. On a phone, tap the back arrow at the top of the screen.

The card also opens from anywhere else an item appears: a card in Kanban view, an event in the calendar, a row in "My work", a notification in the bell, or an entry in the inbox.

> **Tip:** If you're in the middle of editing a field, the first press of Esc only cancels the edit. A second press closes the card.

![An item card open over a board, with its header and tabs](images/item-card-1.webp)

## The card header

At the top of the card you'll see:

- **The item name.** Anyone with edit permission can click the name and change it in place. Enter saves, Esc cancels. A long name wraps onto several lines rather than being cut off.
- **The location line.** Below the name is the item key (if the board defines keys), followed by the board and group names. Clicking the board name takes you back to it. In a subitem, this shows the chain of parents instead, from the top item down to the direct parent, and each one is clickable.
- **Follow / Following.** A button that sets whether new updates on the item reach you as notifications. Details in the article "Who's seen it, reactions and following an item".
- **AI assistant.** Opens the assistant with this item as its context.
- **⋯ (actions).** The same item menu that appears in the table.

### The item actions menu

Clicking **⋯** in the header opens the actions available to you based on your permissions, including:

| Action | What it does |
| --- | --- |
| **Open in new tab** | Opens the card in a separate browser tab |
| **Copy link** / **Copy ID** / **Copy key** | Copy the item's link, ID or key to the clipboard |
| **Rename** | Changes the item's name |
| **Add subitem** | Creates a new subitem under the item |
| **Duplicate** / **Duplicate with updates** | Create a copy of the item, with or without its update thread |
| **Move to group** / **Move to another board** | Move the item |
| **Make a subitem of…** / **Make an item** | Convert between an item and a subitem |
| **Archive** / **Delete** | Remove the item from the board and close the card |

## The card tabs

Below the header is a row of tabs. **Updates** is always first, with the number of updates next to it. The other tabs, their names and their order are set in the board settings.

### Updates

This is where you write updates, reply, mention people and attach files. The full explanation is in the article "Updates, replies and mentions".

### Fields

The **Fields** tab shows the board's columns as a form: the column name, with its value next to it. Each field is edited exactly as in the table, with the same editor (status, date, people, files and so on). On a phone, this is the easiest way to edit an item.

The main **Fields** tab also shows the item's subitems table, below the fields, so you see the whole picture at a glance.

> **Note:** If a tab shows **No fields to show in this tab.**, the board admin chose an empty field list for it. You can add fields in the tab settings.

### Subitems

The **Subitems** tab shows the items under the current item, with their count in the tab title.

1. To add one, click **+ Add subitem**, type a name and press Enter. The field stays open so you can add the next one right away.
2. Every cell in the table is edited as on the board. Clicking a subitem's name opens its card, and the arrow next to it opens the next level.
3. In the toolbar above the table, choose a **View** of the subitems board, and use **Filter**, **Sort** and **Columns**. The **Summary** row at the bottom calculates each column; click it to change the type of calculation.
4. Your changes apply to the current visit. To keep them, choose **Save as the card's default**, **Save as a new view** or **Save to "…"**. **Reset** returns to the saved state.

![The Subitems tab in the card, with the view picker and the summary row](images/item-card-2.webp)

### Time

The **Time** tab appears only when the board has a time tracking column. Here you start a timer and see all of the item's time entries. Details in the article "Time tracking and timesheet".

### Activity

The **Activity** tab shows everything that happened to the item: who created it, who changed which value (with the old and new value), moves, updates written and deleted, and more. When there are no changes yet, you'll see the message **No activity**.

## Tailoring the tabs to the board

Board admins can decide how the card looks for everyone who opens an item on this board.

1. In the tab row, click the gear (**Tab settings**).
2. Drag tabs to change their order. **Updates** stays **Always first**.
3. Change the **Tab name**, or hide a tab with the switch next to it.
4. Click **Add a fields tab** to create another fields tab, for example "Client details" or "Billing", and choose exactly which fields appear in it and in what order.
5. Under **Fields per row**, choose how many fields appear side by side: 1, 2, 3 or **Automatic**. On a phone, one field per row is always shown.
6. In the **Subitems in the card** section, decide whether to show the **Subitems table in the Fields tab**, what the **Default view** is, and whether to show a **Summary row**.
7. Click **Save**.

![The tab settings window with the list of tabs and the option to add a fields tab](images/item-card-3.webp)

> **Note:** The gear appears only to people allowed to edit the board. The setting is saved for the whole board and affects all users.

## Frequently asked questions

**Why don't I see the "Time" tab?**\
It appears only when the board has a time tracking column, and only if the board admin hasn't hidden it.

**Can I send a teammate a direct link to an item?**\
Yes. In the card's **⋯** menu, choose **Copy link**. Anyone who receives the link and has access to the board will see the card open.

**Why can't I change the item's name?**\
Renaming requires edit permission on the board. The name may also be calculated automatically from other columns. In that case a special mark appears next to it, and clicking it explains why.

## See also

- Updates, replies and mentions
- Who's seen it, reactions and following an item
- Subitems and depth levels
- Items: create, edit and duplicate
- Time tracking and timesheet
