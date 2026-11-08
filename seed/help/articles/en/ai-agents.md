---
title: "AI agents"
slug: ai-agents
locale: en
translation_of: ai-agents
category: "ai-and-agents"
tags: ["ai", "agents", "automations"]
visibility: public
excerpt: "How to build an AI agent, a digital worker with a role, instructions, tools and boards, and decide when it acts and when it waits for your approval."
publish: true
---
An AI agent is a "digital worker" you build yourself: you give it a name and a role, write its instructions, and choose which tools it may use and which boards it may work on. Then you can run it manually, mention it in an update, assign it to an item or run it from an automation. Everything the agent does is logged, you can require approval before every change, and you can undo a whole run in one click.

## What you'll learn

- Where the agents screen is and who can create agents
- How to build a new agent, step by step
- How to limit the agent to certain tools and boards
- How to decide when the agent acts and when it waits for approval
- How to give the agent knowledge and run it for the first time

## The agents screen

1. In the sidebar, click **Agents**.
2. The **Agents** tab lists the account's agents: name, role, state (**Active** or **Paused**), the number of runs in the last 7 days, the monthly cost and the number of requests waiting for approval.
3. The **Waiting approvals** and **Runs** tabs gather everything the agents asked for and did. See "Agent runs and approvals".

> **Note:** The agents screen is available to admins and team members only. The account admin decides whether only admins create agents or team members too. A team member sees and manages only the agents they created. An agent needs an active AI connection in the account to run.

## Creating a new agent

Click **New agent**. The editor opens with several tabs:

1. **Profile**: **Name**, **Avatar** (an emoji or a letter), **Role** (one line: what the agent is for) and **Instructions**: what to do, how, and what never to do. The agent follows these instructions in every run. This is also where the **Agent is active** switch is.
2. **Model**: choose an **AI connection** and a **Model**, and set the **Thinking depth**, from **Low** to **Max**. Deeper = more accurate and more expensive.
3. **Tools**: tick the tools the agent may use. The tools are grouped into families (**Context**, **Structure**, **Items**, **Updates**, **Files**, **Search**, **Automations**, **Time**, **Activity**), and each tool has a risk tag: **Read**, **Change** or **Sensitive — always approved**. For change tools you can tick **With approval**.
4. **Boards**: click **Add a board…**, choose a board and set the **Access**: **View** (read only) or **Edit** (change items).
5. **When it acts**: the automatic triggers (see below).
6. **Approvals & limits**: the approval mode and the limits (see below).
7. Click **Create agent**.

![The agent editor on the tools tab, with risk tags and "With approval" switches](images/ai-agents-1.webp)

> **Tip:** You don't have to start from scratch. Click **Starter agents** and choose a ready-made template. Starter agents are added paused, in learner mode and without boards, so you can test and adjust them calmly before switching them on.

## Limits the agent can't cross

The agent sees only the tools you ticked, and only on the boards you gave it, even if someone asks it otherwise. It also can never do more than you are allowed to. Whatever is written in an update or an item reaches it as information, not as an instruction, and the limits are enforced by the system, not by the model.

## When the agent waits for approval

On the **Approvals & limits** tab, choose **When the agent waits for approval**:

| Mode | What happens |
| --- | --- |
| **Learner** | Every change waits for your approval. Recommended for a new agent. |
| **Autonomous** | Ordinary changes happen right away; sensitive actions (deleting, sending outside) always wait for approval. |

On the same tab you also set limits:

- **Steps per run**: how many times the agent calls the model in one run.
- **Cap per run (USD)**: the run stops when its cost reaches the cap.
- **Runs per day**: beyond this, runs are skipped until tomorrow.

## When the agent acts

On the **When it acts** tab:

- **Acts when mentioned in an update**: mention the agent with @ in an update on an item, and it answers as a reply in the thread. You can write **Its task when mentioned**; empty = read the update and answer it.
- **Acts when assigned in a people column**: assign the agent to an item like any other person. You can limit it to **Which people columns** and **On which boards**, and write **Its task when assigned**.
- **Also responds to guests**: off by default. When on, every change in a run a guest started waits for approval.
- **Automations that run the agent**: in the automation builder, choose the **Run an agent** action, also on a schedule (every day, every week or on a date). All the automations that run the agent are listed here.

> **Note:** The agent works only on its own boards. If you haven't chosen boards yet, a message reminds you to do so on the **Boards** tab.

## Knowledge for the agent

Once the agent is created, the **Knowledge** tab appears. You can add **Upload a file** (PDF, DOCX, TXT, MD, up to 20MB), a **Doc** from the system, a **Board** or a free **Note**. The agent searches these sources and cites the source. Each source shows its state: **Indexing…**, **Ready** or **Error**.

## First run

1. Open the **Run** tab.
2. In **What should the agent do now**, write a task, the way you'd write it for an employee.
3. To test without risk, tick **Dry run (change nothing)**.
4. Click **Run now** and follow what the agent does, step by step.

![The agent's run tab with the task box and the dry run option](images/ai-agents-2.webp)

## Frequently asked questions

**How do I pause an agent?**\
On the **Profile** tab, turn off **Agent is active**. A paused agent doesn't run, and doesn't answer mentions either.

**What happens when I delete an agent?**\
Its runs and history stay. Runs waiting for approval are cancelled.

**Why is the agent grayed out when I mention it?**\
Usually mentions are turned off for the agent, the agent is paused, or it isn't assigned to this board. The reason is shown next to its name in the mention list.

## See also

- Agent runs and approvals
- The AI assistant
- AI settings for the account
- The automation builder: triggers, conditions and actions
- Updates, replies and mentions
