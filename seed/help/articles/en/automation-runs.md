---
title: "Testing, run history and troubleshooting"
slug: automation-runs
locale: en
translation_of: automation-runs
category: "automations"
tags: ["automations", "boards"]
visibility: public
excerpt: "How to test an automation on a real item before turning it on, read the run history, and understand why an automation was skipped or failed."
publish: true
---
A good automation is one you trust. That's why every automation has two tools: **Test**, which shows what it will do to a particular item before it writes anything, and **History**, which records every run, every action, and the exact reason for every skip or failure. With them you can track down a problem within a minute, without guessing.

## What you'll learn

- How to run a safe test (preview) and a real run
- How to read the run history
- What each run status and skip reason means
- What to do when an automation is marked "Needs fixing"

## Testing an automation on an item

1. In the board header, click **Automations** and open the **Manage** tab.
2. In the automation's row, click **Test** (on a phone: through **⋯**).
3. In the **Test · \<automation name\>** window, under **On which item?**, type in the **Search an item…** box and choose an item. To choose a different item, click **change**.
4. Click **Preview**. The system checks the conditions on the item and shows the result, **without writing anything**:

   - **Conditions met — the actions would do (nothing written):** and under it each action, with the texts exactly as they'd be sent (for example the message with the item name already in it).
   - **Conditions not met for this item — nothing would run**, and under it, exactly which condition failed.
5. When everything looks right, click **Run it for real** to actually run the automation on the item. The message **It ran — see the history** appears.

![The test window with a chosen item and a preview of the actions](images/automation-runs-1.webp)

> **Tip:** The preview is completely safe: it doesn't change columns, send notifications or send webhooks. Use it freely before turning anything on.

> **Note:** A real run performs all the actions, including sending emails, SMS and webhooks. If you're testing an automation that sends messages to clients, choose a test item.

## Run history

1. In the automation's row, click **History**.
2. The **History · \<automation name\>** window shows the latest runs, newest at the top. For each run: its status, the date and time, and the reason if it was skipped.
3. Click a run to open the details of its actions: each action, whether it was **Done**, **Skipped** or hit an **Error**, and the reason in parentheses.

![Run history with an open run and the details of its actions](images/automation-runs-2.webp)

### Run statuses

| Status | What it means |
| --- | --- |
| **Succeeded** | All actions were performed |
| **Partial** | Some actions were performed and some failed |
| **Failed** | No action succeeded |
| **Skipped** | The automation didn't run; the reason appears next to it |
| **Pending** / **Running** | The run is queued or happening right now |

### Common reasons a run is skipped

| Reason shown | What happened and what to do |
| --- | --- |
| **Conditions not met** | The trigger happened, but the conditions ("only if") weren't met. That's normal; check the conditions if you expected it to run. |
| **Switched off** | The automation was switched off before the run started. |
| **The item is gone** | The item was deleted or moved before the automation got to run. |
| **Chain too long** / **Loop stopped** / **Cycle stopped** | Automations kept triggering each other. The system stopped the chain to prevent an endless loop. |
| **The plan's automation runs for this month are used up** | You've reached the monthly quota. See "My plan and usage". |
| **The action is not in the plan** | The action requires a different plan. |

### Common reasons at the action level

Next to a skipped action you'll see a short explanation, for example: **The value was already set**, **Already in that group**, **No recipients**, **No phone number**, **No linked item**, **The source is empty**, **The timer was already running**, or **No person made the change (a form, a schedule or another automation)**. Most of the time the explanation itself tells you what to fix, for example filling in the phone column on the item.

## An automation marked "Needs fixing"

If a column, group, label or board the automation uses was deleted, or the automation fails again and again, the system switches it off and marks it with a **Needs fixing** tag. Such automations appear at the top of the list, and the automation's owner gets a notification.

1. Click **Edit** on the marked row.
2. The problematic chip is highlighted, and under the builder there's an explanation like **Unknown column** or **Unknown label**.
3. Choose a new value and click **Save and switch on**.

A **had errors** tag on a row means one of the recent runs failed. Open **History** to see which action and why.

## Frequently asked questions

**I changed a status and the automation didn't run. Why?**\
Open **History**. If there's a **Skipped** run, the reason is written next to it. If there's no run at all, make sure the switch is on, and that the change really matches the trigger (for example: the right label, in the same column).

**A scheduled automation didn't run at the time I expected.**\
Date and schedule automations run by the account's time zone. Make sure the date column has a value, and that the date hadn't already passed when you set it up.

**How long is the history kept?**\
The history shows each automation's latest runs. For a summary of the whole account over the last 30 days, see the account's automation center.

## See also

- The automation builder: triggers, conditions and actions
- The account's automation center
- Introduction to automations and templates
- My plan and usage
