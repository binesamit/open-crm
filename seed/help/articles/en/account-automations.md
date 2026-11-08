---
title: "The account's automations center"
slug: account-automations
locale: en
translation_of: account-automations
category: "automations"
tags: ["automations", "account"]
visibility: public
excerpt: "A snapshot of every automation in the account: how many ran, how many failed and what's scheduled — plus an on/off switch, history and templates for each automation."
publish: true
---
When you have automations on many boards, it's hard to keep track of them board by board. The account's **Automations** page brings them all together in one place: what's active, how many runs there were in the last month, where there were errors and what's about to run in the next 24 hours. From here you can also switch automations on and off, duplicate them, view their history and manage the account's automation templates.

## What you'll learn

- How to get to the account's automations center
- What the numbers and the chart show
- Which actions you can take on each automation from here
- How to manage and install account templates

## How to get there

1. In the sidebar, click **Automations** (the lightning icon).
2. The page shows every automation **on the boards you can see**. Automations on boards you don't have access to won't appear.

> **Tip:** On a phone, you'll find the page through the **Me** tab in the bottom bar.

![The account's Automations page with stat tiles and a daily runs chart](images/account-automations-1.webp)

## The numbers at the top of the page

| Tile | What it counts |
| --- | --- |
| **Active** | How many automations are switched on out of all automations |
| **Runs (30 days)** | All the runs in the last month |
| **Actions done (30 days)** | The total number of actions the automations actually performed |
| **Errors (7 days)** | Runs that failed or partly succeeded in the last week — marked in red when there are any |
| **Scheduled in 24 h** | Date and schedule runs expected in the next 24 hours |

Below the tiles is the **Runs per day, 30 days** chart: a bar for each day, with a red mark on days that had errors. Hovering over a bar shows that day's breakdown.

## The list of automations by board

Automations are grouped by board. Each board shows its name (clicking it opens the board) and the number of automations on it. In each row you'll see:

- A **switch** to turn it on and off.
- The automation's name, and below it how many runs there were in the last 7 days and how many errors.
- A **Needs fixing** tag if the automation was switched off because of a problem.
- A **⋯** button with all the actions.

### The actions in the ⋯ menu

1. **Open the board** — editing and testing an automation happen in the board's own automations window.
2. **History** — all the automation's recent runs, with details of actions and reasons.
3. **Save as template** — save the automation as an account template (for those allowed).
4. **Duplicate** — creates a switched-off copy on the same board.
5. **Switch on** / **Switch off**.
6. **Delete** — after you confirm.

> **Note:** You can switch on, switch off, duplicate and delete only automations you're allowed to manage. Other people's automations appear with a disabled switch.

## Account templates

At the bottom of the page is the **Account templates** area — automations you saved as templates so you can use them again on other boards. When you install a template on another board, the platform matches the columns, groups and labels again by type and name.

### Install a template on a board

1. In the template's row, click **⋯** and choose **Install**.
2. In the **Install "\<template name\>"** window, choose a **Board**.
3. The **What fits on this board** area lists every pick you need to complete — for example the column "Status", the group "Done" or the label "Done". The platform suggests the closest match; change it if needed.
4. If the template has a webhook URL, you'll be asked to enter it again.
5. Decide whether to **Switch on right away**, and click **Install**. By default the automation stays off until you switch it on.

![The install template window with a board picker and column matching](images/account-automations-2.webp)

> **Note:** If the template uses subitem columns, add one subitem to the target board before installing.

### Who manages templates

Account admins save, edit and delete templates. Next to the area's heading, admins have a **Members may also save and edit templates** switch — turn it on to let members manage templates too.

## Frequently asked questions

**Why is there no edit button here?**\
Editing and testing happen in each board's automations window, where you have all of the board's columns and groups. Choose **Open the board** in the ⋯ menu.

**Does an admin see every automation in the account?**\
The page shows automations on the boards the user can see. Admins see almost all boards, but private boards are shown only to their subscribers.

**What's the difference between an account template and a ready-made recipe?**\
Ready-made recipes come with the platform and appear on the **Create** tab of every board. Account templates are automations you built and saved, with the trigger, conditions and actions you set.

## See also

- Introduction to automations and templates
- Testing, run history and troubleshooting
- The automation builder: triggers, conditions and actions
- My plan and usage
