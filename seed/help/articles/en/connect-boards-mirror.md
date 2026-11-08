---
title: "Connect boards and the mirror column"
slug: connect-boards-mirror
locale: en
translation_of: connect-boards-mirror
category: "columns"
tags: ["columns", "boards", "subitems"]
visibility: public
excerpt: "How to link items between boards with a connect boards column, turn on a two-way connection, limit the items offered, and show values from the connected board in a mirror column."
publish: true
---
In real work, information is spread across several boards: clients on one board, projects on another and invoices on a third. The **Connect boards** column links items on different boards, for example a project and its client, and the **Mirror** column shows values from the linked items on your board, such as the client's phone number or the total of all their invoices. That way there's no need to type the same information twice, and every change at the source updates everywhere right away.

## What you'll learn

- How to create a connect boards column and pick the connected boards
- How to link items, create a new item from the cell and open a linked item
- How to turn on a two-way connection
- How to limit which items are offered for linking
- How to show and summarize values in a mirror column

## Creating a connect boards column

1. Click **+** (**Add column**) and choose **Connect boards**.
2. In the column menu (**⋯**), choose **Column settings**.
3. Under **Boards to connect**, check one or more boards. You can search for a board by name.
4. Leave **Allow multiple items** checked if each item can link to several items (for example a project with several contacts), or uncheck it to allow just one item.
5. Click **Save**.

## Linking items

1. Click a cell in the connect column.
2. A list of the items on the connected board opens. Type in the **Search items** field to narrow it down. If there are many items, the first 30 are shown, and typing searches all of them.
3. Click an item to link it. Linked items show in the cell as chips.
4. Can't find it? Type the full name and click **+ Create "..."**. A new item is created on the connected board and linked right away. When the column is connected to several boards, you choose which board to create it on.
5. To peek at an item without linking it, click **Open** next to the result.

Clicking a chip in the cell opens the linked item's card over the current board, without losing your place.

![An open connect boards cell with item search and the option to create a new item](images/connect-boards-mirror-1.webp)

## Two-way connection

In a two-way connection, a link made on one side automatically appears on the other board too. For example, when you link a project to a client, the client sees the project in their list of projects.

1. In the connect column's **Column settings**, make sure only one board is selected and that the setting is saved.
2. Turn on the **Two-way connection** switch.
3. Under **Column on the other board**, choose:

   - **New column**: type the name of the column to create on the other board.
   - **Existing column**: pick an existing connect column on the other board that links back to this board.
4. Click **Turn on two-way**. All existing links on both sides also appear on the other side.

> **Note:** In a two-way connection the connected board is fixed. Turning the switch off keeps both columns and all the links, but from then on each side updates separately, as a one-way connection.

## Limiting the items offered

Sometimes you want to allow linking only to some of the items, for example only active clients. In **Column settings**, in the **Offer only items that…** section, choose for each connected board:

- **All items**: the default.
- **By view**: pick a shared view of the connected board. The list shows only items that appear in it, and any change to the view changes the list too.
- **By filter**: set conditions right here.

More options: **Show only matching items in the cell**, **Apply the filter in the API and to agents too**, and **Text above the list**, which explains to users why they see only some of the items.

> **Tip:** An item that's already linked and stops matching the filter isn't removed. It stays linked and is marked with a warning, and you can remove it by clicking **Remove link**.

## The mirror column

The **Mirror** column shows a value from a column on the connected board, through the connect column. It's read-only and updates automatically.

1. Make sure the board has a connect boards column.
2. Click **+** (**Add column**) and choose **Mirror**.
3. In **Column settings**, choose:

   - **Through connection column**: the connect column used to reach the items. You can also choose **Subitems** to show values from each item's subitems.
   - **Column to show**: the column on the connected board whose value you want to see.
   - **Summary**: when the column is numeric and several items are linked: **Sum**, **Average**, **Median**, **Minimum**, **Maximum** or **Count**.
4. When you show a status or dropdown column, you can choose **Show as**: **Text**, **Coloured labels** or a **Colour bar** that shows the distribution.
5. Click **Save**.

![Mirror column settings with the connection column, the column to show and the summary type](images/connect-boards-mirror-2.webp)

## Frequently asked questions

**Can I edit a value through the mirror column?**\
No. A mirror column only displays. To change a value, open the linked item (click the chip in the connect column) and edit it there.

**Do I need permission for the connected board?**\
Yes. To see and link items, you need access to the connected board.

**Can I use a mirror column in a formula?**\
Yes. A formula can read a mirror column's value, for example to work out a balance from the total of linked invoices.

## See also

- The formula column
- Subitems and depth levels
- Adding and managing columns
- Working with views
- Timeline, Gantt, dependencies and workload
