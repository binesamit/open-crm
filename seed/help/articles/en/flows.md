---
title: "Flows: connecting Make and n8n"
slug: flows
locale: en
translation_of: flows
category: "integrations-api-and-extensions"
tags: ["flows", "integrations", "automations"]
visibility: public
excerpt: "Connect your n8n, Make and Zapier accounts to see in one place which flows are running, when they ran and where they failed, and get an alert on every failure."
publish: true
---
Many businesses run some of their processes in external automation platforms: n8n, Make or Zapier. The **Flows** screen connects these platforms to the account and gathers all the flows (scenarios, Zaps) in one place: what's on, what's off, when each flow last ran, and how many times it failed this week. When a flow fails, you get an alert, and you can also run an automation on it.

## What you'll learn

- How the account admin connects an external automation platform
- How to read the list of flows and their history
- How to get an alert when a flow fails
- How the AI assistant helps you understand failures and draft new flows

## Where the screen is

- **Account admins:** **Administration** → **Flows**, or in the sidebar → **Flows**.
- **Members:** in the sidebar → **Flows**, once the account admin has shared the connection with them for viewing. If not yet, you'll see the message **Your account admins have not shared a connection with you yet.**
- Viewers and guests don't see the screen.

## Connecting an automation platform (account admins)

1. On the **Flows** screen, click **New connection**.
2. In the **Connect an automation platform** window, fill in a **Connection name**, for example "Office n8n".
3. Under **Platform**, choose **n8n**, **Make** or **Zapier**.
4. Fill in the platform details:

   - **n8n:** **Your n8n address** (in the cloud or on your own server) and the **n8n API key**.
   - **Make:** the **Zone**, which appears in your Make address, for example eu1 or us1, the **Team ID** and the **Make API token**.
   - **Zapier:** the **Zapier access token**.
5. In the **Settings** section, set the behavior (see below) and click **Save**. The key is stored encrypted and never shown again, and the connection is tested right away.

![The new connection window for an automation platform, with the platform choice and the access fields](images/flows-1.webp)

> **Note:** In Zapier you can currently only view flows and runs. Turning flows on and off and creating them is available in n8n and Make.

### Connection settings

| Setting | What it controls |
| --- | --- |
| **Who sees the flows** | **Admins** only, or **All members (view)** |
| **Alert when a flow fails** | Whether to send an alert, over the **Alert channel**: **Bell**, **Bell + email** or **Email** |
| **Who is alerted** | Specific people; with nobody chosen, all account admins |
| **Check for failures every (minutes)** | How often the system checks for failed runs |
| **Max calls to the platform per hour** | A limit on the number of calls to the external platform |
| AI permissions | Whether the AI may draft new flows, turn flows on and off, rerun failed runs and edit existing flows; every such action waits for approval |

## The list of flows

After connecting, choose the connection in the list at the top, and below it the **Flows in \<connection name\>** table appears:

| Column | What it shows |
| --- | --- |
| **Flow** | The flow's name and its tags |
| **Status** | **Active**, **Off** or **Error** |
| **Last run** | How long ago, and whether it **Succeeded** or **Failed** |
| **Failures (7 days)** | The number of failed runs in the last week, in red when there are any |

Each row has a switch to turn the flow on and off (for admins, on platforms that support it), a **Runs** button, an **Ask the assistant** button and a link to open the flow in the platform itself. Editing the flow itself is done in the external platform.

![A connection's flows table, with status, last run and failures](images/flows-2.webp)

## Run history

1. Click **Runs** in a flow's row, or **All runs** at the top of the table.
2. Filter between **All** and **Failures only**.
3. A failed run shows the error message, and **Failed at: \<step name\>** when the platform reports it.
4. Admins can click **Run again** to send the run again.

> **Tip:** On a failed run, click **Ask the assistant**. The AI assistant opens with the flow and run details, and explains what happened and what to do.

## A new flow with AI

When the setting allows it, the connection card shows the **New flow with AI** button:

1. Describe in words **What should the flow do?**, for example "When a lead comes into the leads board, create an update and send an SMS".
2. Click **Draft it**. The AI shows the steps it suggests.
3. Click **Approve and create (off)**. The flow is created in the platform switched off; connect its access details and test it before you turn it on.

## Automations on flows

In the automation builder of every board, under **Webhooks**, there are two triggers: **An external flow failed** and **An external flow works again**. Choose a connection (or **any connection**) and a flow (or **any flow**), and add an action, for example creating an item on the incidents board, with the flow name and error message as variables.

## Frequently asked questions

**The connection is marked "Error". What do I do?**\
Click **Test connection**. If the test fails, the details appear on the card. Usually the fix is **Edit** → **Change address or key**.

**What's the difference between flows and board automations?**\
Board automations run inside the system. Flows run in the external platform; this screen only shows and manages them.

## See also

- Incoming and outgoing webhooks
- API tokens and using the API
- The automation builder: triggers, conditions and actions
- The AI assistant
