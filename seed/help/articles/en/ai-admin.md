---
title: "Setting up AI for the account"
slug: ai-admin
locale: en
translation_of: ai-admin
category: "ai-and-agents"
tags: ["ai", "admin", "mcp"]
visibility: signed_in
excerpt: "A guide for account admins: connecting an AI provider, turning AI on for the account, budget, AI assistant and image settings, and tracking costs."
publish: true
---
All the AI features in the app (the AI assistant, AI columns and AI agents) cost money by usage, so they stay off until an account admin turns them on. On the **AI & MCP** screen in account administration, you connect an AI provider with your own key, set a monthly budget, decide who uses what, and see exactly how much everything cost.

## What you'll learn

- How to add an AI connection and check that it works
- How to turn AI on for the account and set a budget
- How to set up the AI assistant and image generation
- How to track usage and costs

> **Note:** This screen is available to account admins only. To get there, click your profile picture in the top bar, choose **Administration**, and in the admin menu choose **AI & MCP**.

## Step 1: Connecting an AI provider

An AI connection is a provider and an API key, saved once for the whole account, encrypted. Every agent, AI column and the assistant picks a connection and a model from these connections.

1. In the **AI connections** card, click **New connection**.
2. Fill in a **Name** for the connection (for example "Office Claude").
3. Choose a **Provider**: **Anthropic (Claude)**, **OpenAI**, **Google Gemini** or **OpenAI-compatible**, for any server that speaks like OpenAI, such as Mistral, Groq, OpenRouter or DeepSeek. For an OpenAI-compatible provider you also need to fill in the **Server address** (ending in /v1).
4. Paste the **API key**. Under the field it says where to get a key from each provider.
5. Click **Load the provider's models** and choose a **Default model**. Without a choice, it's **Automatic — the newest**: the newest model that can use tools.
6. Save, and in the connection's row click **Test**. If everything is fine, the message **The connection works** appears.

![The AI connections card with an active connection and the test, models and edit buttons](images/ai-admin-1.webp)

> **Note:** After saving, the key can't be read back, only replaced. To change provider, open a new connection.

### The models window

Clicking **Models** in the connection's row opens the list of models, as read directly from the provider. Each model shows its capabilities (**Tools**, **Images**, **JSON**, **Streaming**, **Makes images**) and its price. Here you can:

- **Make default** another model.
- **Set price** for a model whose price isn't known, so costs are calculated correctly.
- **Add model** manually, for a server that doesn't publish a list, or for a new model that doesn't appear yet.

> **Tip:** Agents, writing by the assistant and building flows need a model that can use **Tools**. A model without this capability is marked **no tools**.

## Step 2: Turning AI on for the account

In the **AI in this account** card:

- **AI on** — the main switch. Board data is sent to the AI provider only at run time, and isn't used for training.
- **Monthly budget** — when the account reaches the budget, AI calls stop. An alert is sent before that. Empty field = no budget.
- **Who creates agents** — **Admins only** or **Members**. A member sees and manages only the agents they created.
- **New agents answer mentions** — whether new agents start with "acts when mentioned" turned on.
- **Format text written by AI** — updates written by agents and the assistant are shown formatted, with headings, lists and tables.

## Step 3: The AI assistant

In the **AI assistant** card:

1. Turn on **Assistant on**.
2. Choose an **AI connection** and a **Model** (or **The connection's default**).
3. Under **Who may use it**, choose: **Members**, **Members and viewers** or **Everyone incl. guests**. Admins always can, and guests in any case see only what they're allowed to.
4. Under **Limits**, set **Model calls per message**, **Max $ per message** and **Messages a day per person**.

## Step 4: AI images

In the **AI images** card, you choose the connection and model that create images: for the assistant, for agents, for AI columns with image output and for the automation action. You can set a **Default size**, **Default quality** and **Images per request**. To turn image generation off, choose **Off — no images**.

> **Note:** Only models marked **Makes images** appear. If the connection has no such model, choose another connection (for example OpenAI or Gemini) or mark the capability in the models window.

## Tracking usage

At the bottom of the screen, the **AI usage this month** card breaks down the real cost of every call: by connection, by source (**Agents**, **AI columns**, **AI assistant**, **AI images**, **Test**) and by model.

![The AI usage this month card with a breakdown by source and model](images/ai-admin-2.webp)

> **Tip:** If a message says some models have no price this month, their calls were recorded at a cost of 0. Set a price for them in the models window so the budget is counted correctly.

## More on this screen

The same screen also has the **MCP server** (connecting external AI tools such as Claude, ChatGPT and Cursor to the account, along with the list of connected apps) and **External MCP servers**, whose tools are available to agents and automations. The details are in the article "Connecting external AI assistants (MCP)".

## FAQ

**What happens when I delete an AI connection?**\
Agents and AI columns that use it stop working until another connection is chosen. The usage history is kept.

**AI is off everywhere even though I turned it on. Why?**\
The AI features may not be included in the account's plan. Check **My plan**.

**Can we use our own internal AI server?**\
You can connect an OpenAI-compatible server. An internal or local address is allowed only if the platform owner has enabled it.

## See also

- The AI assistant
- AI column
- AI agents
- Connecting external AI assistants (MCP)
- My plan and usage
