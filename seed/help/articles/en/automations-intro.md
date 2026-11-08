---
title: "Introduction to automations and templates"
slug: automations-intro
locale: en
translation_of: automations-intro
category: "automations"
tags: ["automations", "boards", "getting-started"]
visibility: public
excerpt: "What automations are, where to find them on a board, and how to turn on your first automation from a ready-made recipe in a few clicks."
publish: true
---
An automation is a fixed rule the system carries out for you: **when** something happens on the board, **then** an action is performed. For example: "When status changes to 'Done', move the item to the 'Completed' group", or "One day before the due date, notify the owner". Instead of remembering to do these steps by hand, you set them up once, and they run on their own, on every item, at any hour.

Every automation reads like a sentence, so even someone who didn't build it understands right away what it does.

## What you'll learn

- How an automation is built: trigger, conditions and actions
- Where the board's automations window is and what's in it
- How to turn on an automation from a ready-made recipe
- The difference between built-in recipes and account templates
- Who can create and edit automations

## How an automation is built

Every automation has three parts:

| Part | What it says | Example |
| --- | --- | --- |
| **Trigger** (when) | The event that runs the automation | When an item is created, when a status changes, when a date arrives |
| **Conditions** (only if) | An optional filter: the automation runs only if they're met | Only if "Priority" is "High" |
| **Actions** (then) | What the system does: one or more, in order | Change a status, send a notification, create an item on another board |

One automation can include several actions in a row, for example "change the status **and** assign the item's creator **and** send a notification".

## Where the board's automations are

1. Open the board you want.
2. In the board header, click the **Automations** button (the lightning icon). The number next to the button is how many automations are active on the board.
3. The **Automations · \<board name\>** window opens with three tabs:

   - **Manage**: the list of existing automations on the board, each with an on/off switch.
   - **Create**: ready-made recipes and building a custom automation.
   - **Webhooks**: sending events from the board to external systems (shown to board owners and account admins).

![The board's automations window on the Manage tab, with a list of automations and their switches](images/automations-intro-1.webp)

## Turning on an automation from a ready-made recipe

The quickest way to start is to choose a ready-made recipe and fill in what's missing.

1. In the automations window, click **Create an automation** (or go to the **Create** tab).
2. Scroll through the recipes, or type a word like "date" or "notification" in the **Search recipes…** box.
3. Filter by category with the buttons above the list: **Status change**, **Items**, **Dates & time**, **People**, **Across boards**, **Notifications & email**, **Webhooks & integrations**.
4. Click the recipe. The automation builder opens, and the parts you still need to choose are marked with a dashed border.
5. Click each marked part and choose a value: a column, label, group, person and so on.
6. Click **Save and switch on**. The automation appears in the list with its switch on.

![The Create tab with recipes grouped by category and the search box](images/automations-intro-2.webp)

> **Tip:** Every recipe comes with a short line of explanation, for example "Keeps the board tidy: each item moves to the group that matches its status". It's a good way to discover ideas for automations you hadn't thought of.

### Popular recipes

- When a status changes → move to the matching group.
- When an item is created → whoever created the item becomes its owner.
- A reminder on the day the due date arrives, or a few days before.
- When a status changes → open an item on another team's board ("passing the baton").
- When all linked items are done → update the status here.

## A custom automation from scratch

If no recipe fits, click **Build a custom automation** on the **Create** tab: "Start from a trigger and pick actions". All the options are described in the article on the automation builder.

## Account templates

Beyond the built-in recipes, you can save an automation you built as an **account template** and install it on other boards:

1. In the automation's row, click **⋯** and choose **Save as template**.
2. Give it a name and description and click **Save**. The board's columns, groups and labels are chosen again on each install, and webhook addresses and secrets aren't saved in the template.
3. Templates are gathered on the account's **Automations** page (in the sidebar), in the **Account templates** section, and from there you install them on another board.

> **Note:** By default, only account admins save and edit templates. An admin can turn on **Members may also save and edit templates**.

## Who can do what

- Account admins, board owners and anyone with full edit permission on the board can **create, edit and delete** automations.
- Anyone who can see the board can **view** the list and the history.
- **Guests** never create or edit automations.
- An automation runs on behalf of its owner, so it can't perform an action the owner isn't allowed to perform.

## Frequently asked questions

**Does an automation also run on items already on the board?**\
An automation responds to events that happen after it's turned on. Scheduled triggers (like "every day") and future dates apply to existing items too.

**I duplicated an automation. Why is it off?**\
A copy is always created switched off, so the same work doesn't run twice before you've changed it. Edit it and switch it on.

**Can automations trigger each other?**\
Yes. An action of one automation can trigger another automation. To prevent endless loops, the system stops a chain that's too long, or an automation that keeps triggering itself.

## See also

- The automation builder: triggers, conditions and actions
- Testing, run history and troubleshooting
- The account's automation center
- Incoming and outgoing webhooks
- Board permissions and item visibility
