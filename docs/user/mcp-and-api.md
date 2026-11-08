# MCP, API and integrations

Hebrew version: [mcp-and-api.he.md](mcp-and-api.he.md)

## What it's for

Connect Bines OS to the other tools you use:

- AI apps such as Claude, ChatGPT, Cursor or VS Code can read and change your boards through MCP, acting as you.
- Make, n8n and your own scripts can create and update items with an API token.
- Webhooks send board events to an outside address the moment they happen.

Everything connects as a person (or as a named service) and gets that person's permissions, never more. This guide is for users. Developers will find every endpoint in the [API reference](../06-API.md).

The API, MCP and connecting AI apps may not be included in every plan. If your plan does not include them, you will see "Not included in your plan — upgrade to use it".

## Before you start: what an admin sets

In "Administration" > "AI & MCP", the "MCP server" card controls AI apps:

- "MCP on in this account": when off, no AI tool can connect.
- "Who may connect AI tools": "Admins only", "Members", or "Members and viewers". Admins always can; guests never.
- "Sensitive actions (delete)": "Allowed" or "Blocked". A delete goes to the trash and can be undone. When blocked, these tools are not offered to AI apps.

The same card shows the "MCP address" (one address for every tool) and "Tools you get" (the list of what AI apps can do).

## Connect Claude.ai or ChatGPT

Claude.ai and ChatGPT connect with a sign-in and approval screen (OAuth). You paste only the MCP address; no token is needed.

To connect Claude.ai:

1. Get the MCP address: it is your Bines OS address followed by /mcp (for example https://work.example.com/mcp). Admins can copy it from "Administration" > "AI & MCP".
2. In Claude, open Settings > Connectors > Add custom connector.
3. Name it "Bines OS" and paste the MCP address as the URL.
4. Click Connect. Sign in to Bines OS and approve (see "The approval screen" below).

To connect ChatGPT:

1. In ChatGPT, open Settings > Apps & Connectors > Advanced and turn on Developer mode.
2. Click Create. Name: "Bines OS"; URL: the MCP address; authentication: OAuth.
3. Click Connect. Sign in to Bines OS and approve.

### The approval screen

When an AI app asks to connect, Bines OS shows "Connect an AI app":

1. Check the app's name. If it shows "Unverified", approve only if you started this connection yourself.
2. "Which account?": one connection is for one account. Connect again for another account.
3. "What it may do": "Read", "Edit" and "Automations". A viewer can connect read-only only.
4. "Which boards": "All my boards" (including boards added later) or "Only boards I choose".
5. Click "Allow and connect", or "Cancel".

If the account requires two-factor authentication or Google / Microsoft sign-in, do that first, then connect.

## Connect Claude Code, Cursor or VS Code

These tools use a personal API token.

1. Create a personal token (see "Create an API token" below). Its scopes are what the tool gets: for example read-only, or only some boards.
2. Add the MCP address with your token to the tool. Admins find ready lines to copy in "Administration" > "AI & MCP" under "How to connect":
   - Claude Code: a command to run in a terminal, with your token in place of <TOKEN>.
   - Cursor: add the block to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).
   - VS Code: add the block to .vscode/mcp.json.

## See and disconnect connected AI apps

- Your own connections: "My profile" > "API tokens". Each shows when it was connected, when it was last used and which boards it can reach.
- Admins see every member's connections under "Connected AI apps" in "Administration" > "AI & MCP".
- Click "Disconnect". The app loses access at once; you can connect it again any time.

## What AI apps can do, and how to undo it

- AI apps act exactly with the rights of the person who connected them and the scopes they approved.
- Each change by an AI app is logged in the activity log under that person, marked as coming through MCP.
- Each call can be undone as one step (the app has an "undo" tool, and the change shows in the activity log).
- Admins can cap how many AI changes a minute each connection may make ("AI changes a minute — per person, app or agent").

## Create an API token

A token connects Make, n8n or a script to the account as you, with your permissions, limited to the scopes you pick. Guests and viewers cannot create tokens.

1. Open "My profile" > "API tokens" and click "New token".
2. Give it a "Name", for example "Make — website leads".
3. Under "What the token can do", tick only what you need, for example "Read boards and items", "Create and edit items", "Write updates" or "Webhooks".
4. Under "Which boards", keep "All my boards" or limit it to some boards.
5. Choose when it "Expires": a number of days, "A year" or "Never".
6. Click to create, then "Copy" the token right away. It will not be shown again. Whoever holds it acts as you.

Tips:

- A token with "Reveal secrets" can read secret columns, so it needs two-factor authentication and a fresh code from your authenticator app.
- "Usage limits" sets "Requests per minute" and "Requests per day" for a token. Empty means the account's default; only admins can go above it.
- To stop a token, click "Revoke". Connections using it stop working.

### Service tokens (admins)

A service token belongs to a named service, not a person, so its actions show in the log as "Service: <name>".

1. Open "Administration" > "Connections".
2. Click "New service token", pick "The service's role", the scopes and the boards.
3. Copy the token.

Admins can also tick "Show every member's tokens" there to see and revoke anyone's tokens.

## Connect Make or n8n

Bines OS has ready-made nodes for n8n and an app for Make, with triggers, actions and searches on boards and items. The steps are under "n8n and Make" at the bottom of "API tokens".

For n8n:

1. In n8n open Settings > Community nodes > Install.
2. Enter the package name shown in Bines OS ("Package name") and install.
3. Add the Bines OS node to a workflow and create a new credential.
4. Paste "Your instance URL" (shown in Bines OS) and an API token, then save. n8n tests the connection.

For Make:

1. Click "Open the invitation link" and install the app in your Make organization. If there is no link, ask your administrator.
2. In a scenario add the Bines OS module and click "Create a connection".
3. Paste the instance URL and an API token, then save. Make tests the connection.

Give the token the scopes your flows need, such as reading boards, writing items and updates, and "Webhooks" for triggers.

You can also call the API from any HTTP module: send the header Authorization: Bearer <token> with a JSON body. "Every API endpoint (docs)" opens the full list.

## Send board events to another tool (webhooks)

A webhook sends an event from a board to an outside address, for example a Make custom webhook or an n8n Webhook node. It is signed and retried on failure.

1. Open the board's automations window and go to the "Webhooks" tab.
2. Click "+ New webhook".
3. Paste the "URL" and choose the "Event", for example "Item created", "Status changed" or "A specific column changed". Some events ask for a column, label or group.
4. Click "Verify and save". Bines OS sends a challenge first, and the address must return it (in Make: a Webhook response module; in n8n: Respond to Webhook).

After saving you can:

- Click "Ping" to send a test.
- Open "Log" to see each delivery, and click "Send again" to resend one.
- Show the "Signing secret" to check signatures, or create a "New secret".
- "Switch off" or "Switch on" the webhook. A webhook that fails many times is switched off by itself ("Switched off after many failures").

Admins find a shortcut in "Administration" > "Connections" > "Webhooks".

### Receive data and send items from automations

- The automation trigger "When a webhook arrives" ("Incoming webhook") starts an automation when an outside tool calls it.
- The automation action "Send to integrations (n8n / Make)" sends an item to your integrations on a channel you choose.

See [Automations](automations.md) for how to build these.

## Watch your n8n, Make and Zapier flows

Admins can connect the account's n8n, Make or Zapier accounts in "Administration" > "Flows" to see what runs, when it last ran and where it failed.

1. Click "New connection" and choose the "Platform".
2. Fill in the address or zone and the key. The key is stored encrypted and never shown again.
3. Click "Test connection".

In "Settings" you choose "Who sees the flows", whether to send an "Alert when a flow fails", and whether AI may draft or edit flows (every AI flow waits for approval and is saved switched off). Some platforms allow monitoring only. Editing a flow happens in the platform itself ("Open in the platform").

## Related

- [AI](ai.md)
- [Automations](automations.md)
- [Workflows](workflows.md)
- [Extensions](extensions.md)
- [Sharing and permissions](sharing-and-permissions.md)
- [Account administration](account-admin.md)
- [Import and export](import-export.md)
