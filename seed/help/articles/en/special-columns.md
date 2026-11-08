---
title: "Special columns: button, doc, secret and more"
slug: special-columns
locale: en
translation_of: special-columns
category: "columns"
tags: ["columns", "automations", "docs", "security"]
visibility: public
excerpt: "Meet the special columns: a button that runs an action, a doc inside the cell, an encrypted secret, a color picker, item ID, creation log, last updated and dependency."
publish: true
---
Beyond the basic columns, the app has a few columns built for special needs: running an action with a click, writing a full doc inside a row, storing client passwords securely, giving each item a running number, or recording who created and updated each item. This article covers all of them, and how to set up each one.

## What you'll learn

- How to create a button that runs an automation, opens a link or changes values
- How to work with the doc column and the secret column
- How to set up running numbers for items
- How the creation log and last updated columns help you track changes

## Button column

The **Button** column shows a colored button on every row. Clicking it runs an action on that item.

1. Add a column of type **Button** and open **Column settings**.
2. Write the **Button text**, for example "Send quote", and choose a **Color**.
3. Under **What the button does**, choose:

   - **Runs an automation** – each click runs the board's automations that have the **When a button is clicked** trigger. Create an automation like this in the automations center.
   - **Opens a link** – type the **Link address**. You can include item values in it, such as `{item.name}` or `{item.id}`.
   - **Sets values** – under **Values to write**, choose a **Column** and write a value (for example "Done" for a status column). Click **Add a value** to change several columns in one click.
4. Check **Ask for confirmation first** if the action is sensitive.
5. Click **Save**.

![Button column settings with the text, color and choice of action](images/special-columns-1.webp)

> **Tip:** After a button changes values, a message with **Undo** appears, so you can undo a click made by mistake.

## Doc column

The **Doc** column lets you write a rich doc for each item: meeting notes, a spec or minutes. Click **New doc** in the cell, and the doc opens in a side panel. Next time, clicking the doc's name in the cell opens it again. The doc has the item's permissions.

In **Column settings** you can choose a **Template for new docs**: every new doc in the column starts as a copy of a doc you pick from the board's workspace, or **No template (an empty doc)**.

## Secret column

The **Secret** column is meant for client sign-in passwords and keys, for example website access details. The value is stored encrypted on the server and isn't shown in the table, in search, in exports or in automations.

- **Entering a secret:** click the cell, type the value and click **Save**. From then on it is shown as dots only.
- **Showing it:** click the eye icon (**Show the secret**) and enter a code from your authenticator app. The secret is shown for a short time and then hidden again.
- **Copying it:** when the settings allow it, click **Copy**. The clipboard empties itself after a few seconds.

In **Column settings** you set **Who may reveal** (**Everyone who sees the column** or **Only some people**), **Show for (seconds)**, **Verification valid for** (minutes), whether to **Allow copying**, and when to **Alert admins** about many reveals.

> **Note:** To see secrets, you need to turn on two-factor authentication in your profile. Every reveal, copy and change is recorded in the **Secrets log**, which account admins can see in the admin center under **Security**. The column isn't suitable for bank passwords or highly sensitive secrets, because the encryption isn't end-to-end.

## Color picker

The **Color picker** column stores a color code, useful for example on a products or designs board. Click the cell and pick a color from the palette or type a code. In **Column settings**, choose a **Color format**: **HEX** or **RGB**.

## Item ID

The **Item ID** column gives each item a fixed running number, for example an order number or a ticket number. Existing items are numbered in the order they were created.

In **Column settings** you can set:

- **Prefix (optional)** – English letters, digits and hyphens, up to 10 characters, for example ORD-.
- **Minimum digits** – for example 4, to get 0001.
- **Next number** – to continue numbering from a previous system. The number must be higher than the highest number on the board.

The **Preview** shows what the next ID will look like, for example ORD-0125.

![Item ID settings with a prefix, number of digits and a preview](images/special-columns-2.webp)

## Creation log and last updated

These two columns fill themselves:

- **Creation log** – who created the item and when.
- **Last updated** – who last changed the item and when.

In **Column settings**, choose what to **Show**: both the person and the date, **Date only** or only the person, and check **Show the time too** if needed. In the **Last updated** column you can also choose specific columns under **Updates when changed**, so only a change in them updates the value. With nothing chosen, any change to the item counts.

## Dependency column

The **Dependency** column defines which items on the same board need to finish before an item starts. In **Column settings** you set what happens **When a previous item moves**: **Shift the same**, **Shift only on overlap** or **Arrows only**, and the **Date column that moves**. You'll find full details in the article on the timeline and Gantt.

## AI column

The **AI** column fills in values with an AI model, for example a summary, a classification or information extracted from text. It is described in a separate article.

## FAQ

**Can I duplicate an item with its secret?**\
No. For security reasons, secret column values aren't copied when you duplicate an item, duplicate a board or use templates.

**What happens to the ID of a deleted item?**\
Its number isn't reused. The next item continues from the next number in line.

## See also

- Introduction to automations and templates
- Docs
- Password and two-factor authentication
- Timeline, Gantt, dependencies and workload
- AI column
