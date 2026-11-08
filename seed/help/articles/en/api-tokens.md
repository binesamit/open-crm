---
title: "API tokens and using the API"
slug: api-tokens
locale: en
translation_of: api-tokens
category: "integrations-api-and-extensions"
tags: ["api", "integrations", "security"]
visibility: public
excerpt: "How to create a personal API token or a service token, limit it to certain permissions and boards, and use it from Make, n8n or a script."
publish: true
---
An API token is a "key" that lets an external tool — Make, n8n, a script you wrote or an AI tool — work with your account through the API: read boards and items, create items, write updates and more. The token acts on your behalf and with your permissions, and never more than that. You choose exactly what it may do, on which boards and for how long — and you can deactivate it at any time.

## What you'll learn

- Where to manage tokens, and the difference between a personal token and a service token
- How to create a token and limit it
- How to use the token in API requests
- How to limit the rate of use and deactivate a token

## Where to manage tokens

- **Your tokens:** In the user menu in the top bar → **My profile** → the **API tokens** tab.
- **Account admins:** **Administration** → **Connections**. There, with **Show every member's tokens** ticked, you see the tokens of the whole account, and that's also where you create service tokens.

> **Note:** Viewers and guests can't create tokens, so they don't see the tab.

| Type | Who creates it | On whose behalf it acts |
| --- | --- | --- |
| **Personal token** | Every member and admin | On your behalf, with your permissions |
| **Service token** | Account admins only | A special user "Service: \<name\>" is created, with its own role in the account. Its actions are logged under its name, not a person's |

A service token suits the organization's permanent connections (for example, integrating the system with a website), so the connection doesn't stop working when an employee leaves.

## Creating a token

1. Click **New token** (or, for admins, **New service token**).
2. Under **Name**, give it a name that reminds you what the token is for — for example "Make — website leads".
3. For a service token, choose **The service's role**: **Member** or **Admin**.
4. Under **What the token can do**, tick only the permissions you need (see the table).
5. Under **Which boards**, keep **All my boards** or untick it and choose specific boards.
6. Choose when it **Expires**: 30 days, 90 days, a year or **Never**.
7. You can set **Usage limits** — requests per minute and requests per day. An empty field = the account default.
8. Click **New token**. In the **Token created** window, click **Copy**.

![Token creation window with the choice of permissions, boards and expiry](images/api-tokens-1.webp)

> **Note:** Copy the token right away — it won't be shown again. Whoever holds it acts on your behalf, so keep it somewhere secure and don't share it.

### The permissions you can give

| Permission | What it allows |
| --- | --- |
| **Read boards and items** | Read boards, columns, items and values |
| **Change board structure** | Create and change boards, groups, columns and views |
| **Create and edit items** | Create, update and delete items and subitems |
| **Read updates** / **Write updates** | Read and write updates on items |
| **Read users** / **Manage users (admin)** / **Manage teams** | The account's people and teams |
| **Read automations** / **Manage automations** | View automations or create and change them |
| **View AI agents and their runs** / **Run AI agents** / **Manage AI agents** | Working with agents |
| **Webhooks** | Register webhooks for boards |
| **Read notifications** / **Mark notifications** | The user's notifications |
| **Search** | Search across the whole account |
| **Everything (admin)** | All actions, for admins only |
| **Reveal secrets** | Read values in secret columns — admins only, and not included in "Everything" |

## Using the token

With every request, send the header:

`Authorization: Bearer <the token>`

The API's base address is your system's address with `/api/v1`. For example, to create an item, send a POST to `/api/v1/boards/<board id>/items` with a JSON body.

### From Make or n8n

1. In Make, use the **HTTP → Make a request** module; in n8n — the **HTTP Request** node.
2. Add the Authorization header with the token.
3. Set the request body as JSON.

At the bottom of the tokens screen you'll find the **Connecting from Make / n8n** card with a ready-made example, and the **Every API endpoint (docs)** link — full documentation in English, with examples for every action, rate limits and an explanation of errors.

> **Tip:** To receive events from the board (instead of checking over and over), use webhooks. See "Incoming and outgoing webhooks".

## Rate limits

Every token has a limit on requests per minute and per day. The token's row shows the summary — for example "600 per minute · 10,000 per day". To change it, click **Limits** in the row. Only an account admin can set a limit higher than the account default. A request that exceeds the limit gets a "too many requests" response, with a recommended waiting time.

![Token list with permissions, last use, expiry and limits](images/api-tokens-2.webp)

## Deactivating a token

1. In the token's row, click **Revoke**.
2. Confirm: **Revoke this token? Connections using it stop working.**

Each row also shows **Last used** and the expiry date, so you can spot tokens that are no longer in use and deactivate them.

## Frequently asked questions

**My token got a permission error. Why?**\
The token gets the overlap between the permissions you ticked and your actual permissions. If you don't have access to a board, neither does the token. Also make sure the board is in the token's list of boards.

**Where can I see AI apps connected to the account?**\
On the same screen, in the **Connected AI apps** area. See "Connecting external AI assistants (MCP)".

## See also

- Incoming and outgoing webhooks
- Connecting external AI assistants (MCP)
- Flows: connecting to Make and n8n
- Account security
- My profile and display settings
