---
title: "The automation builder: triggers, conditions and actions"
slug: automation-builder
locale: en
translation_of: automation-builder
category: "automations"
tags: ["automations", "subitems", "columns"]
visibility: public
excerpt: "A complete guide to the automation builder: every available trigger and action, “and” and “or” conditions, variables in text, column mapping and subitems."
publish: true
---
The automation builder lets you put together any rule you want, as a sentence that reads in plain language: **When** (a trigger), **Only if** (conditions), **Then** (actions). Every part you need to fill in appears as a "chip": click it and pick a value from a list. There's no code to write and no column names to remember.

## What you'll learn

- How to open the builder and complete a sentence
- Which triggers and actions are available, and what each one does
- How to add conditions, including "or", condition groups and negation
- How to use variables such as the item name and a link to the item
- How to work with subitems and the parent item

## Opening the builder

1. In the board header, click **Automations**.
2. Go to the **Create** tab and click **Build a custom automation**, or pick a ready-made recipe as a starting point.
3. To edit an existing automation, click **Edit** on its row in the **Manage** tab.

The window is called **New automation** (or **Edit automation**) and has three rows: **When**, **Only if**, **Then**.

![The automation builder with a status change trigger, a condition and two actions](images/automation-builder-1.webp)

## Step 1: Pick the trigger

Click the chip next to **When** and pick a trigger from the menu. Triggers are grouped by topic:

| Group | Trigger | How it reads in the sentence |
| --- | --- | --- |
| Status change | Status changes | When {column} changes to {label} |
| Column changes | Column changes | When {column} changes |
| Column changes | A button is clicked | When {column} is clicked |
| Column changes | Checkbox checked | When {column} is checked / unchecked |
| Column changes | Person assigned | When {someone} is assigned in {column} |
| Column changes | Number crosses a threshold | When {column} is greater than / less than {value} |
| Items | Item created | When an item is created |
| Items | Item created in group | When an item is created in group {group} |
| Items | Item moves to a group | When an item moves to group {group} |
| Items | Update posted | When an update is posted (optionally: one that contains certain text) |
| Items | Item archived / deleted / restored | When an item is archived, when an item is deleted, when an item is restored |
| Subitems | Subitem created | When a subitem is created |
| Subitems | Subitem status changes | When a subitem's {column} changes to {label} |
| Subitems | When a subitem's column changes | When a subitem's {column} changes |
| Dates & time | Date arrives | When the date in {column} arrives, on the day itself / N days before or after it, at {time} |
| Dates & time | N days before a date | {N} days before the date in {column}, at {time} |
| Dates & time | Every day / week / month | Every hour / day / week on… / month on the … of the month, at {time}, for every item on the board |
| Across boards | All linked items done | When all items linked in {connect column} are done |
| Webhooks | Incoming webhook | When a webhook arrives from an outside system |
| Webhooks | An external flow failed / works again | When a flow fails in {connection}: {flow} |

> **Tip:** If extensions that provide triggers are installed in the account, they appear at the bottom of the menu under **From extensions**.

When you pick a column, the list shows only columns of the right type (for example, only status columns in a status trigger). On a board with subitems, the list is split into **Item columns** and **Subitem columns**, and picking a subitem column switches the trigger to its subitem version automatically.

## Step 2: Conditions (optional)

Conditions narrow the automation down to certain cases, for example "Only if **Priority** is **High**".

1. Click **+ Condition** in the **Only if** row.
2. Pick a column, an operator (such as "is", "is not", "is empty") and a value.
3. To add another condition, choose whether it joins with **And** or **Or**. You can also create a nested group of conditions, and negate a condition.

Below the conditions, a readable sentence sums them up, with brackets around each group, so you can check that the logic is right.

## Step 3: Actions

Click **+ Choose an action** (and later **+ action**) and pick what happens. You can add several actions; they run in order, and you delete an action by clicking its trash icon.

| Group | Action | How it reads in the sentence |
| --- | --- | --- |
| Columns | Set status | set {column} to {label} |
| Columns | Set a column | set {column} to {value} |
| Columns | Set a date | set {column} to {today / now / empty, plus N days} |
| Columns | Rename the item | rename the item to {name} |
| Columns | Increase a number | add {1} to {column} |
| Columns | Clear a column | clear {column} |
| Columns | Start / stop time tracking | start time tracking in {column} (and choose whose timer) |
| Columns | Generate an AI image | generate an image into the {files column}: {description} |
| Items | Move to group | move to group {group} |
| Items | Duplicate the item / Archive / Delete | duplicate the item, archive the item, delete the item |
| Subitems & parent item | Create a subitem | create a subitem {name} |
| Subitems & parent item | Set a column of the parent / of each subitem | set the parent's {column} to {value} |
| Subitems & parent item | Copy from the parent / to the parent / to each subitem | copy the parent's {column} into {column} |
| People | Assign / Unassign | assign {someone} in {column} |
| Notifications & email | Notify | notify {someone}: {message} |
| Notifications & email | Send email | email {someone}: {subject} |
| Notifications & email | Post an update | post an update: {content} |
| Notifications & email | Send SMS | send an SMS to {phone column}: {message} |
| Across boards | Move to board / Create an item | move to board {board}, create an item in {board} |
| Across boards | Connect items | connect items in {connect column} |
| Across boards | Copy from a linked item | set {column} to the {column} of the item linked in {connect column} |
| Webhooks & integrations | Webhook | send a webhook to {address} |
| Webhooks & integrations | Run an agent | run agent {agent}: {instruction} |
| Webhooks & integrations | Send to integrations (n8n / Make) | send the item to integrations on channel {channel} |

![The automation builder's actions menu, split into groups](images/automation-builder-2.webp)

> **Note:** Some actions (Webhook, email, SMS, sending to integrations, running an agent and generating an image) depend on the account's plan. If they're not included, they appear in the menu as disabled, with an explanation and a link to upgrade.

### Who gets the notification

In notify, email and assign actions you can choose: **the item's creator**, **whoever made the change**, **the board owners**, **the board's subscribers**, a people column from the item (or from the parent item), or a specific person in the account. For email you can also choose an email column.

### Variables in text

Below every text field (message, subject, name, update content) there are variable buttons: **Item name**, each of the item's columns, **board name**, **item link**, **who did it** and **Today**. Clicking one adds the variable, and it shows as a readable chip, for example "The item {Item name} moved to stage {Status}".

### Mapping columns between boards

The **Create an item** and **Move to board** actions have a **Column mapping (N)** button. Use it to set what carries over to the target board: click **Map by name** to match columns with the same name automatically, or pick the source column for each column on the target. When creating an item, you can also set **A fixed value**. A column that isn't mapped stays empty.

## Step 4: Name and save

1. In the **Name (optional)** field you can give the automation a name. If you leave it empty, the name is a description of the trigger and actions.
2. Click **Save and switch on** for the automation to start running right away, or **Save as off** to switch it on later.

If something isn't valid (a deleted column, a label that doesn't exist, an action that needs an item when the trigger doesn't provide one), an explanation appears below the builder and the problem chip is marked.

## Frequently asked questions

**Can I build an automation on subitems?**\
Yes. Pick a trigger from the **Subitems** group, or pick a subitem column inside a regular trigger. On a board with several levels you can choose **at any level**, **subitems only** or **sub-subitems only**.

**What happens if one action fails?**\
The other actions keep running. The automation's history shows exactly which action failed and why.

**Why don't I see the external flows trigger?**\
Only people with access to the flows screen can pick a connection. Ask the account admin to share the flows with you.

## See also

- Introduction to automations and templates
- Testing, run history and troubleshooting
- Incoming and outgoing webhooks
- Flows: connecting to Make and n8n
- Subitems and depth levels
