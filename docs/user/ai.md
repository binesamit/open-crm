# AI in Bines OS

Hebrew version: [ai.he.md](ai.he.md)

## What it's for

Bines OS can use an AI model of your choice to answer questions about your work, summarize and fill columns, run digital workers ("agents"), make and edit images and turn voice recordings into text. You bring your own AI provider key; Bines OS never uses AI until an account admin turns it on, and every AI change can be approved first and undone.

What AI can do in Bines OS:

- The "AI assistant": a chat panel that knows where you are (an item, a board, a document, a dashboard or the whole account).
- "Agents": digital workers with a role, instructions, tools, boards and their own knowledge.
- The "AI" column: fills a cell per item (summarize, classify, extract, translate, custom prompt, or make an image).
- AI images: generate images, and "Ask AI for a change" on a picture you uploaded.
- Voice: record a voice message in an update and transcribe it.
- Web search for agents.

AI may not be included in every plan. If your plan does not include it, you will see "Not included in your plan — upgrade to use it".

## Before you start: what an admin must turn on

AI settings live in "Administration" > "AI & MCP". Only account admins can change them.

1. Open "Administration" > "AI & MCP".
2. Under "AI in this account", switch on "AI on". Board data is sent to the AI provider while running (it is not used for training).
3. Optional: set a "Monthly budget". AI calls stop when the budget is reached, and admins get an alert before that. Empty means no budget.
4. Add at least one AI connection (next section).
5. Turn on the parts you want: the "AI assistant" ("Assistant on"), "AI images", "Voice and transcription" and "Web search for agents" each have their own card on the same page.

Other settings on this page:

- "Who creates agents": "Admins only" or "Members". A member sees and manages only the agents they created.
- "New agents answer mentions": new agents start with "Acts when mentioned" on.
- "Format text written by AI": updates written by agents, the assistant and AI apps show with headings, lists, tables and links.
- "AI changes a minute — per person, app or agent" and "AI changes a minute — whole account": caps on how fast AI may change things.
- "AI usage this month": the real cost of each call, by connection, source and model.

## Connect an AI provider

An AI connection is a provider plus an API key, saved once for the account and stored encrypted. The key is never shown again; you can only replace it. Agents, AI columns and the assistant each pick a connection and a model.

To add a connection:

1. In "Administration" > "AI & MCP", find "AI connections" and click "New connection".
2. Give it a "Name" and choose a "Provider":
   - "Anthropic (Claude)", "OpenAI" or "Google Gemini": the model list is read from the provider.
   - "OpenAI-compatible": any server that speaks like OpenAI, such as Mistral, Groq, OpenRouter, DeepSeek, or a local Ollama or LM Studio. Enter the "Server address" (ending in /v1) and, if the server needs one, the key. "Known servers:" offers ready addresses.
   - "Soniox (transcription)": for transcribing voice recordings only; it has no chat models.
3. Paste the "API key". The provider's model list loads by itself.
4. Optional: choose a "Default model". With nothing chosen, the newest model that can call tools is used.
5. Save, then click "Test". You should see "The connection works".

Tips:

- A connection's provider cannot change. To switch provider, open a new connection.
- For a server that publishes no model list, type model ids in "Models (for a server without a list)".
- Click "Models" on a connection to see every model with its price and capabilities ("Tools", "Images", "JSON", "Streaming", "Makes images"). Long lists with many makers, such as OpenRouter, are searchable and grouped by maker. You can "Add model", "Make default", or set a price by hand.
- Agents, assistant changes and the flows builder need a model that can call tools.
- Deleting a connection stops the agents and AI columns that use it until they pick another one. Usage history is kept.

## Chat with the AI assistant

The assistant answers questions about the board or item, writes summaries, and proposes changes. It works with your permissions, and every change waits for your approval.

To open it:

- Click "AI assistant" in the sidebar (on a phone, in the top bar), or the assistant button on a board or item card.
- Or open quick search ("Search everything", Ctrl+B, or Cmd+B on a Mac), type your question and choose "Ask the agent".

To use it:

1. Check what the panel is about: its subtitle shows the place, for example "Board" or "The whole account".
2. Under "Who answers", keep the assistant or pick one of the account's agents that allows chat.
3. Type in the box. Use @ to point at an item, board, document or dashboard.
4. Proposed changes appear as cards marked "Waiting for approval". Click "Approve", "Reject" or "Approve all".
5. After changes run you can click "Undo" to take them back.

More:

- "New conversation" starts fresh. "Earlier conversations" lists your past chats on this page; you can delete one.
- When the answer comes from the help center, the assistant can offer "Show me: …", which starts a guided tour.
- If the panel says the assistant is off, ask an admin. Admins choose its connection and model, "Who may use it" ("Members", "Members and viewers" or "Everyone incl. guests"), and "Limits" (model calls and a $ cap per message, and messages a day per person).

### Attach files to a chat

1. Click "Attach files", drag files onto the panel ("Drop here to attach to the chat"), or paste a screenshot.
2. You can attach up to 10 files per message.

The assistant reads images (with a model that reads images), PDF, Word (DOCX) and text files. Very large files are cut or refused.

## Build an agent

An agent is a digital worker you set up once: role, instructions, model, tools and boards. Everything it does is logged, can wait for your approval, and a whole run can be undone.

To create an agent:

1. Open "Agents" in the sidebar and click "New agent". Or click "Starter agents" and "Add" a ready one; starter agents are added paused, in learner mode and without boards.
2. In "Profile": give it a "Name", an "Avatar", a one-line "Role" and its "Instructions" (what to do, how, and what never to do).
3. In "Model": choose the "AI connection", the "Model" and the "Thinking depth" (deeper is more accurate and more expensive).
4. In "Tools": tick only the tools it may use. Each tool is marked "Read", "Change" or "Sensitive — always approved". You can require approval per tool ("With approval").
5. In "Boards": "Add a board…" and set "Access" to "View" or "Edit". The agent never gets more than you can do.
6. In "Approvals & limits": choose when it waits for approval:
   - "Learner": every change waits for your approval. Recommended for a new agent.
   - "Autonomous": ordinary changes run at once; sensitive actions (deleting, sending outside) always wait.
   Set "Steps per run", "Cap per run (USD)" and "Runs per day".
7. Click "Create agent".

You need an AI connection before an agent can run. Who may create agents is set by an admin ("Who creates agents").

### Improve the instructions with AI

1. In the agent's "Profile", click "Improve with AI".
2. Optional: write "What to change (optional)", for example "more polite with customers".
3. Click "Suggest instructions". You see the changes: added text in green, removed text in red.
4. Edit the suggestion if you like, then click "Apply".
5. Save the agent. Nothing is saved until you do.

### Give an agent knowledge

In the "Knowledge" tab you can add files (PDF, DOCX, TXT, MD, up to 20MB), docs, boards and notes. The agent searches them with "Search knowledge" and cites the source. It reads only what the agent's creator can read; a board is read with the board tools, not copied.

1. Open the agent and go to "Knowledge".
2. Click "Upload a file", "Pick a doc", "Pick a board", or write a note with a "Title" and "Text".
3. Wait for indexing to finish. Use "Read again" after a source changes.

### Decide when an agent acts

In "When it acts":

- "Acts when mentioned in an update": people @mention the agent in an update; its answer is posted as a reply.
- "Acts when assigned in a people column": assign the agent to an item, and it works on that item. You can limit it to some people columns and boards.
- "People can chat with it in the AI panel": pick it under "Who answers" in the AI panel.
- "Also responds to guests": off by default. When on, every change in a run a guest started waits for approval.
- Automations can run an agent with the action "Run an agent", also on a schedule.

What an update or item says reaches the agent as information, never as instructions.

### Run an agent by hand and review its work

1. Open the agent's "Run" tab and write "What should the agent do now".
2. Tick "Dry run (change nothing)" to test safely, then click "Run now".
3. "What the agent did" shows each step. Click "Stop" to end a run.
4. To take everything back, click "Undo the run". Items it created go to the trash.

Requests waiting for you are on the "Waiting approvals" tab of "Agents". Past runs are under "Runs".

### Let an agent search the web

1. In the agent's tools, switch on "Web search".
2. If you are an admin, this approves it at once. If you are a member, it waits for an admin ("Waiting for an admin").

Web search works only when the platform allows it and an admin set a search service in "Administration" > "AI & MCP" > "Web search for agents" (the service, its key, and limits per run and per day). Every search is in the run log.

### Give an agent outside tools (MCP)

Admins can add external MCP servers (for example n8n or Make) under "External MCP servers" in "AI & MCP". Each tool is off until an admin enables it. In an agent, the "External tools (MCP)" section lets you switch on those tools, with or without approval.

## Fill a column with AI

The "AI" column fills a cell for each item from the item's own data.

1. Click "Add column" and choose "AI".
2. Choose "What the column does": "Summarize", "Classify", "Extract", "Translate" or "Custom prompt".
3. Choose the "AI connection" and "Model".
4. Under "What the AI reads", pick columns, "Item name" or "The item's latest updates". In a prompt you can name a column in braces, for example {Status}.
5. For "Classify", list the labels (one per line). You can "Also write the label to" a status or dropdown column.
6. Optional: "Run by itself when its input columns change", and limits ("Items per run", "Max $ per run", "Max $ per month").
7. Click "Run on empty cells" or "Run on all cells".

On a cell you can "Run again", "Edit by hand" or "Clear". To run on chosen items only, select them and click "AI" in the bar that appears.

### Make images in an AI column

Set "Output" to an image. The image is saved as a file in the "File column for the image" you pick. You can send the item's own photos ("Source photos"), add "Style examples" from approved items, and choose variations per photo. Each image is charged on its own. If a limit stops a run, missing images are marked "not made" and can be made later with "Complete missing images".

## Make and edit images

An admin sets the image connection and model in "AI & MCP" > "AI images" (only models marked "Makes images"), with default size, quality and "Images per request". These are used by the "Generate an image" tool of the assistant, agents and MCP, and by the automation action "Generate an AI image".

To change a picture you uploaded:

1. Open a PNG, JPEG or WebP image from a file column or an update.
2. Open "Versions".
3. In "Ask AI for a change", write "What should change in the picture?", for example "remove the background".
4. Click "Send to AI". It can take up to a minute.

The result is saved as a new version. To undo, make the version before it current. Each change is a charged AI image.

## Record and transcribe voice

1. When writing an update, click the microphone ("Voice recording") and speak. The recording plays in place.
2. To turn it into text, click "Transcribe". With several recordings, "Transcribe all" does them together.

An admin turns this on in "AI & MCP" > "Voice and transcription": "Recording in updates" (free), "Transcription" with a "Transcription connection" (Soniox, OpenAI or OpenAI-compatible), "Language", and "When to transcribe" ("On request" or "Automatically"). Transcription works only while AI is on and is not available to guests.

## Costs and safety

- AI costs money per use, paid to your provider. The monthly budget stops AI calls when reached.
- The assistant and agents act with the permissions of the person who uses or created them, never more.
- Changes can wait for approval, are logged, and can be undone.
- Text from items, updates and the web is treated as information, not instructions.

## Related

- [MCP and API](mcp-and-api.md)
- [Automations](automations.md)
- [Columns](columns.md)
- [Item card and collaboration](item-card-and-collaboration.md)
- [Dashboards](dashboards.md)
- [Workflows](workflows.md)
- [Account administration](account-admin.md)
- [Sharing and permissions](sharing-and-permissions.md)
