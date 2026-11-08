---
title: "My plan and usage"
slug: plan-usage
locale: en
translation_of: plan-usage
category: "account-administration"
tags: ["plan", "admin"]
visibility: signed_in
excerpt: "How to see what the account's plan includes and how much of it has been used, and how to track usage of automations, the API, storage and users."
publish: true
---
Two areas in the admin center answer the question "how much are we using the system": **My plan** shows what the plan includes, how much of each limit has already been used, and the history of plans in the account; **Usage** shows what the account actually consumed recently: automations, webhooks, API calls, storage and active users. Together they help you plan ahead, before you reach a limit.

## What you'll learn

- How to read the plan screen and the usage meters
- What happens when you reach a plan limit
- Which features depend on the plan
- How to track the account's usage over time

> **Note:** Both areas are open to account admins only: profile picture → **Administration** → **My plan** or **Usage**.

## The current plan

The **Current plan** card shows the plan name, its status, the billing cycle (**Monthly** or **Yearly**) and the version. During a trial, it also shows when the trial ends.

| Status | Meaning |
| --- | --- |
| **Trial** | The account is on a trial until the date shown. |
| **Active** | Everything is fine. |
| **Past due** | After the grace period, the account will become read-only. |
| **Read-only** | All the data is visible, but it can't be changed until the plan is renewed. |
| **Suspended** | Only the plan page is available until the plan is renewed. |

![The My plan screen with the current plan, the usage meters and the list of features](images/plan-usage-1.webp)

### Usage meters

Below the plan details is a meter for each limit: **Users**, **Boards**, **Items**, **File storage**, **Automation runs**, **AI budget** and **API calls**. Each meter shows how much has been used out of how much (for example 8 / 10), along with when it resets: **Resets at the start of every month** or **Resets every day**. A limit with no restriction is marked **Unlimited**.

> **Tip:** When you reach a limit, only the next action of that kind is blocked. No data is deleted or hidden. For example, when you reach the board limit you can still work on all existing boards; you just can't create a new one.

### Features

The **Features** section lists which features are included in the plan, and which are marked **Not in the plan**:

- Artificial intelligence (assistant, agents, AI columns)
- Advanced automations (webhook, email, SMS, integrations, agents)
- API, MCP and OAuth apps
- Installing extensions
- External flows (n8n, Make)
- Dashboards, docs, public forms and inviting guests

A feature that isn't included in the plan doesn't disappear from the screen: its button is shown grayed out, with the explanation **Not included in your plan — upgrade to use it**. Users who aren't admins see **Ask an account admin to upgrade.**

### History and upgrading

The **History** card lists all the plans the account has had: plan, status, from date and to date. To upgrade, click **Upgrade** at the top of the screen: a window opens explaining how to upgrade, sometimes with a **Details and upgrade** link as well.

## The usage screen

In the **Usage** area you see what the account consumed over the period you choose at the top of the screen: **7 days**, **30 days** or **90 days**.

1. **Summary cards**: **Automation runs** (and how many failed), **Webhook deliveries**, **API calls**, **Active users** (out of how many in the account), **Storage** (and the number of files), **Items** and **Boards**.
2. **Automation runs per day**: a bar chart for each day. Hovering over a day also shows the webhook deliveries.
3. **Top automations**: a table with the automation, the board, the number of runs, the failures and the last run. An automation that's switched off is marked **Off**.
4. **Tokens in use**: the API tokens in use, by most recent use.

![The usage screen with the summary cards and the daily runs chart](images/plan-usage-2.webp)

> **Tip:** An automation with many failures in the **Top automations** table? Open its run history to understand what's going wrong.

## Frequently asked questions

**We reached the user limit. Will anyone be disconnected?**\
No. All existing users keep working; only new invitations are blocked until you upgrade or deactivate users.

**Where can we see how much we've spent on AI?**\
The **AI budget** meter on the plan screen shows usage against the limit. A full breakdown by source and model is in the **AI & MCP** area, on the **AI usage this month** card.

**Our account says it has no plan. What does that mean?**\
**The account has no plan — no limits.** All features are open.

## See also

- The admin center
- Setting up AI for the account
- Testing, run history and troubleshooting
- API tokens and using the API
- Managing users and invitations
