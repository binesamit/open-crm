---
title: "Connecting outside AI assistants (MCP)"
slug: mcp-connect
locale: en
translation_of: mcp-connect
category: "integrations-api-and-extensions"
tags: ["mcp", "ai", "integrations"]
visibility: public
excerpt: "How to connect Claude, ChatGPT, Cursor or VS Code to your account, what you approve on the connection screen, and how to disconnect an app at any time."
publish: true
---
MCP is an open standard that lets AI assistants (Claude.ai, ChatGPT, Claude Code, Cursor and VS Code) work directly with your boards: search items, summarize updates, create tasks and update statuses, all from an ordinary conversation with the assistant. The assistant always acts on your behalf and with your permissions only: it doesn't see or change anything you can't see or change yourself.

## What you'll learn

- What you need before connecting
- How to connect Claude.ai and ChatGPT, and what you approve on the connection screen
- How to connect developer tools such as Claude Code, Cursor and VS Code
- How to see and disconnect connected apps
- What the account admin decides

## Before you start

- **The MCP address:** One address for all accounts, which the account admin finds in **Administration** → **AI & MCP**, in the **MCP server** area, with a **Copy** button. Ask them for it.
- **Permission:** The account admin decides **Who may connect AI tools**: **Admins only**, **Members**, or **Members and viewers**. Guests can never connect.
- **Plan:** Connecting AI apps depends on the account's plan.

## Connecting Claude.ai or ChatGPT

Both connect with a secure sign-in (OAuth): you paste only the MCP address, with no token, and approve on our screen.

**In Claude.ai:**

1. Settings → Connectors → Add custom connector.
2. Name: Bines OS. Address: the MCP address. The other fields aren't needed.
3. Click Connect, and our approval screen opens.

**In ChatGPT:**

1. Settings → Apps & Connectors → Advanced → turn on Developer mode.
2. Create → Name: Bines OS, address: the MCP address, authentication: OAuth.
3. Click Connect, and our approval screen opens.

### The approval screen

If you're not signed in to the platform, you're asked to sign in. Then the screen **\<app name\> wants access** appears, with the app's name and the address you'll return to.

1. Under **Which account?**, pick an account. Each connection is to one account; to connect another account, connect again. An account where you're not allowed appears disabled, with an explanation.
2. Under **What it may do**:

   - **Read**: always included: boards, items, updates, people, automations and search, whatever you can see.
   - **Edit**: creating and changing items, updates, groups, columns and boards. Deleting moves things to the Trash.
   - **Automations**: creating, switching on and switching off automations.
3. Under **Which boards**, choose **All my boards** (including boards added later) or **Only boards I choose**, and check at least one board.
4. Click **Allow and connect**. You return to the app, and the connection is ready. **Cancel** takes you back without connecting.

![The approval screen for connecting an AI app, with account, permission and board choices](images/mcp-connect-1.webp)

> **Note:** If a note says the name was provided by the app and wasn't verified, approve only if you're the one who just started the connection.

> **Tip:** In an account where you're a viewer, the connection is read-only.

## Connecting Claude Code, Cursor or VS Code

These tools connect with a personal API token instead of OAuth:

1. Create a personal token (**My profile** → **API tokens** → **New token**). The token's permissions and boards are exactly what the tool gets: for example, a read-only token gives read-only access.
2. Add the server in the tool, with the MCP address and the header `Authorization: Bearer <TOKEN>`:

   - **Claude Code:** the `claude mcp add --transport http` command in the terminal.
   - **Cursor:** in the file `~/.cursor/mcp.json`.
   - **VS Code:** in the file `.vscode/mcp.json`.

On the **AI & MCP** screen, in the **How to connect** area, the account admin sees a setup snippet ready to copy for each tool: ask them to send it to you.

## What the assistant can do

The assistant gets tools such as searching items, reading a board, creating and updating items, writing updates and working with automations, according to the permissions you approved. Every change it makes is recorded in the activity log marked "via \<app name\>", and you can undo it like any other change.

## Connected apps and disconnecting

1. Open **My profile** → the **API tokens** tab.
2. The **Connected AI apps** area lists every app you've connected: when it was **Connected**, when it was **Last used**, and which boards it can access.
3. Click **Disconnect** and confirm. The app loses access immediately, and you can connect it again at any time.

![The connected AI apps area in the profile's API tokens tab](images/mcp-connect-2.webp)

Account admins see all members' apps in **Administration** → **AI & MCP**, and can disconnect any of them.

## What the account admin decides

On the **AI & MCP** screen, in the **MCP server** area:

- **MCP on in this account**: when it's off, no AI tool can connect.
- **Who may connect AI tools**: admins always; guests never.
- **Sensitive actions (delete)**: **Allowed** or **Blocked**. When blocked, delete tools aren't shown to assistants at all.
- **Tools you get**: the list of tools the server offers.

## Frequently asked questions

**The approval screen says "In this account only admins can connect AI apps."**\
The admin limited connecting to admins. Contact them if you need access.

**What's the difference between this and external MCP servers?**\
Here, outside assistants connect **to us**. External MCP servers are the opposite direction: tools from other servers that our agents and automations use. See "Setting up AI for the account".

## See also

- API tokens and using the API
- Setting up AI for the account
- The AI assistant
- AI agents
