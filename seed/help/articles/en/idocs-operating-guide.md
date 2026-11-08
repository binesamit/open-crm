---
title: "Interactive documents: operating guide"
slug: idocs-operating-guide
locale: en
translation_of: idocs-operating-guide
category: "guides"
tags: ["docs", "idocs", "quotes"]
visibility: signed_in
excerpt: "Quotes, agreements and approvals as a live page for the client: creating from a template, the editor, sections, columns, sending, the share link, signing, look, automation and API/MCP."
publish: true
---
An interactive document is an item sent to the client as a live page, for example a quote, a service agreement or a spec approval. The client opens a link without signing in. They read, tick add-ons, enter quantities, ask questions and approve with a signature. Everything they do is written to your item.

It's all settings: no price, wording or clause is fixed in code. The same mechanism is used for quotes, agreements, approvals and choice forms.

![The Docs tab in the item card](images/idocs-operating-guide-1.webp)

## 1. A new document

1. Open an item and go to the **"Docs"** tab in the card.
2. Click **"New doc"** and choose a template: an account template, or a ready-made one (quote and agreement, service agreement, spec approval, choice form, blank).
3. The editor opens right away. The document starts as a draft, with its own link for the client.

> You can hide the "Docs" tab on a board that doesn't need it: ⋯ in the card → Tab settings.

## 2. The editor

![The editor: sections, preview and settings](images/idocs-operating-guide-2.webp)

The editor is split into three parts, and each one scrolls separately:

- **Sections:** the list of the document's parts. Drag to change the order. Next to each section: an eye (hide from the client), duplicate and delete.
- **Preview:** the document exactly as the client will see it, with the item's real data. Above the preview you can choose to see it "as a client (guest) sees it" or "as a member sees it".
- **Settings:** the "Section" tab sets up the selected section. The "Document" tab sets up the whole document: look, money, link, contact, notifications and email.

**Save** saves the document. **Update the template** updates the template the document was created from.

## 3. Sections

**"Add section"** opens a catalog in nine groups: opening, background, scope and choice, price, time, trust, legal and approval, conversation, and design. There are a few main types:

| Type | What it does |
| --- | --- |
| Title | The document's name, a subtitle and fields (to, date, valid until). |
| Text | Free text. **Bold**, lists with `-`, and fields from the item such as `{col:column_name}`. You can split it into two columns, make it collapsible or numbered paragraphs (agreement clauses). |
| Priced rows | The rows come from the **subitems** or from linked items. "Always included" (base package), "Tick any" (add-ons) or "Choose one" (plans). Quantity, unit price, monthly price and "Requires". |
| Summary | One-time, discount, VAT, total, monthly and payment schedule. Updates as the client ticks. |
| Client inputs | Fields the client fills in, saved to the item's columns. |
| Questions | The client's questions arrive as updates on the item. |
| Approve and sign | Name, role, consent boxes and a signature (drawn or typed name). |
| Table, FAQ, timeline, media, call to action, divider, contents | — |

An empty section (no rows or no text) isn't shown to the client. In the editor it's marked "not shown to the client".

## 4. Columns and subitems

In a priced rows section you choose which column each part comes from: description, price, unit price, monthly, quantity, "Chosen" and "Requires".

- **"Create the columns"** creates the missing columns on the subitems board in one click, and connects them to the section.
- Several sections from the same subitems (base, add-ons, subscription): a **"Type"** column filters each section's own rows. The platform creates it when needed.
- In the "Approve and sign" section, **"Create the columns"** creates a **Signature** column and a column for the **signed copy**.
- In the document settings: **"One-time total into"** and **"Recurring total into"** write the totals to the item, so they show up on the board, in dashboards and in automations.

## 5. Sending and the share link

![The share link for the client](images/idocs-operating-guide-3.webp)

- **"Link for the client"** appears on every document in the "Docs" tab and in the editor's header. It includes the link itself, a **Copy** button and the link's state: active, expired or closed.
- **Send:** emails the link to the contact. The address comes from the email column in the document settings, or you type a different one. You can also choose **"No email"**: the document is marked as sent, and you send the link yourself, for example on WhatsApp.
- **Validity:** "Days valid after sending" in the document settings. After it expires the client sees "The document expired".
- **Replace the link:** the old link stops working. **Close the link:** the client can no longer open it. **Reopen:** puts the link back to work.
- **One-time code (optional):** in the document settings, "Before opening" → "One-time code by email". The client gets a code before the document opens.

## 6. What the client does

![The client page](images/idocs-operating-guide-4.webp)

- Ticks add-ons and enters quantities. The total and VAT update immediately, and the choices are written to your subitems.
- Asks about any clause ("Ask about this"). The question arrives as an update on the item with the client's name and the clause. Your reply in the update appears on the page.
- Fills in details, if there's a "Client inputs" section.
- Approves: name, role, ticking "I have read" and a signature, drawn or typed. After approval the page is locked.

On a phone the summary stays at the bottom of the screen, with a "Review and approve" button.

## 7. Signature and certificate

![The signature certificate](images/idocs-operating-guide-5.webp)

- After signing: the document's status changes to "Approved", the **Signature** column shows who signed and when, and the signed copy is saved in the files column. In the "Approve and sign" section you can also set a status for the item after approval.
- Clicking the signature cell opens the **Signature certificate**: who signed, how their identity was checked, server time, IP address and browser, exactly what was signed (choices and amounts), the consents, a **SHA-256** fingerprint of the signed content, and the document log.
- This is an electronic signature under Israel's Electronic Signature Law, 2001, with evidence. It's suitable for service agreements. For legal advice on the agreement's wording, consult your lawyer.
- To change a signed document: **Reopen**. A new version is created, and it needs to be signed again.

## 8. Look

- **Account default:** Administration → General → **Interactive document look**. Set the background, page background, text, secondary text, accent color, title band and font, separately for **guests** (clients) and for **members**.
- **For each template or document:** in the editor → the "Document" tab → **Look** → "Its own".
- When the contrast is below the accessibility standard (4.5:1), a warning appears next to the colors.

## 9. Automation

On the board → Automations → the **"Send an interactive document"** action. Example: "When the status changes to 'Sent', send a document from the 'Quote' template". If the item already has an open document from the same template, it's sent again. Otherwise a new document is created.

The status set on signing triggers the board's other automations, for example moving from lead to project.

## 10. API and MCP

- **REST:** all the actions are documented in the API docs, in the **Interactive documents** group: templates, an item's documents, creating, sending, the link, the log and the signature certificate.
- **MCP, the AI assistant and agents:** the tools `list_idoc_templates`, `list_item_idocs`, `get_idoc`, `create_idoc`, `send_idoc`, `get_idoc_link`, `set_idoc_link`, `get_idoc_events`, `get_idoc_signature`. Sending to the client always asks for approval before the AI does it.
- **Connecting:** in Claude.ai or ChatGPT, add a connector with the address `https://<your address>/mcp`. In Claude Code, Cursor or VS Code, create an API key with the `boards:read` and `items:write` permissions.
- **Permissions:** the same as in the app. A viewer can read documents but doesn't see the client link.

## Frequently asked questions

**Does the client need a user in the platform?** No. The link opens without signing in, and if you chose it, with a one-time code by email.

**Where do I see what the client did?** In the "Docs" tab → ⋯ → **Document log**: opened, ticked, asked, signed.

**How do I fix a document that was already sent?** Edit and save. The client sees the change the next time they open it. A signed document is reopened as a new version.

**Can I download a PDF?** The signed copy is a full HTML file in the files column. Open it and save it as a PDF from the browser.
