---
title: "Agent runs and approvals"
slug: agent-runs-approvals
locale: en
translation_of: agent-runs-approvals
category: "ai-and-agents"
tags: ["agents", "ai", "notifications"]
visibility: public
excerpt: "How to follow what an AI agent did, approve or reject actions it asks for, stop a run and undo all its changes."
publish: true
---
Every time an AI agent works, whether you ran it manually, mentioned it in an update or an automation started it, a "run" is created. The run records every step: what the agent read, what it decided and what it changed. When the agent wants to take an action that requires approval, it stops and waits for you. This article explains how to follow runs, how to approve and reject, and how to undo a whole run if something didn't turn out the way you wanted.

## What you'll learn

- Where to see all the agents' runs
- What a run's details show
- How to approve or reject waiting actions
- How to stop a run and undo all its changes
- Why a run can fail or be skipped

## The run list

1. In the sidebar, click **Agents**.
2. Go to the **Runs** tab to see all the runs of all the agents you manage. For the runs of a single agent, open the agent and go to its own **Runs** tab.
3. Each run shows the agent, what started it (**Run now**, **Automation**, **Mentioned in an update**, **Assigned in a people column** or **Schedule**), the status, the number of steps and the cost.

| Status | Meaning |
| --- | --- |
| **Queued** | The run is waiting to start. |
| **Running** | The agent is working now. |
| **Waiting for approval** | The agent stopped and is waiting for you to approve an action. |
| **Done** | The run finished successfully. |
| **Failed** | The run stopped because of a problem (the reason is shown). |
| **Cancelled** | Someone stopped the run. |
| **Skipped** | The run didn't start, for example because of the daily run limit. |

## A run's details

Click a run to open **What the agent did**. You'll see **The task** the agent received, the answers of **The agent**, and every action it took, described in plain words, such as "Change 'Status' of 'Alpha Ltd' on the 'Customers' board to 'Working on it'". Next to each action is its outcome: **Done**, **Rejected**, **Expired**, **Blocked** or **Failed**. In a dry run, actions are marked **Dry run — not done**.

![An agent run's details with the steps, an action waiting for approval and approve and reject buttons](images/agent-runs-approvals-1.webp)

## Approving and rejecting actions

When an agent in **Learner** mode wants to change something, or an **Autonomous** agent wants to take a sensitive action, the run switches to **Waiting for approval**. You can decide in three places:

1. **In the notification bell**: a notification "asks for approval" arrives, with **Approve** and **Reject** buttons right in the notification.
2. **On the Waiting approvals tab** of the agents screen: all the requests in one place. Click **Open the full run** to see the context before you decide.
3. **In the run's details** themselves.

After **Approve**, the message "Approved — the agent continues" appears, and the run continues exactly from where it stopped. After **Reject**: "Rejected — the agent is told". The agent gets a message that the action was rejected and by whom, and continues or finishes accordingly.

> **Note:** An approval request doesn't wait forever. Each request shows until when it's valid (72 hours). After that it's marked **Expired** and can no longer be approved.

> **Tip:** An agent's requests can be approved by account admins and by whoever created the agent. Every decision is saved with the name of the person who approved or rejected it.

## Stopping and undoing a run

- **Stop**: while the run is active, click **Stop** in the run's details. The agent stops immediately.
- **Undo the run**: after the run has finished, click **Undo all changes** (the number in parentheses shows how many changes will be undone) and confirm. Everything the agent changed in the run is undone together, and items it created go to the Trash. The run is marked **Undone**.

![The Undo all changes button in the details of a finished run](images/agent-runs-approvals-2.webp)

## Why a run failed or was skipped

The reason is shown in the run's details. The common ones:

| Reason | What to do |
| --- | --- |
| The agent's daily run limit was reached | Wait until tomorrow, or raise **Runs per day** on the **Approvals & limits** tab. |
| The cost cap per run / the step limit per run was reached | Raise the limit, or split the task into smaller parts. |
| The account's monthly AI budget is used up | Contact the account admin. |
| The agent has no AI connection / the AI key is invalid | The account admin needs to check the connection in the AI settings. |
| The agent is paused | Switch it on in the **Profile** tab. |
| Three actions failed in a row | Check in the run's details what failed and refine the instructions. |

## Frequently asked questions

**Can I undo only some of a run's changes?**\
Undoing a run reverts all its changes together. For a single change, you can use the item's activity log.

**Who sees the runs?**\
Account admins see all runs. A team member sees the runs of the agents they created.

**Did the agent start itself?**\
No. An agent doesn't start itself: a change it makes won't trigger an automation that runs it again.

## See also

- AI agents
- Notifications and notification preferences
- Undo and the activity log
- Trash and restoring
- AI settings for the account
