# Interactive documents (quotes, agreements, approvals)

Hebrew version: [interactive-documents.he.md](interactive-documents.he.md)

## What it's for

An interactive document is a live page you share with a client from an item: a price quote, a service agreement, a spec approval or a selection form. The client opens a link without signing in, reads, ticks add-ons, changes quantities, asks questions and approves with a signature. Everything they do is written back to your item.

Nothing is fixed: prices, wording and sections all come from your templates and your item's columns.

## Create a document

1. Open the item and go to the "Documents" tab on the card.
2. Click "New document" and choose a template: one of your account's templates, or one of the "Starters": Quote and agreement, Service agreement, Spec approval, Selection form, or Blank.
3. The editor opens. The document starts as a "Draft" with its own client link.

If a board does not need the tab, hide it from the card's "Tab settings" (see [Item card](item-card-and-collaboration.md)).

## The editor

The editor has three parts, each scrolling on its own:

- "Sections": the parts of the document. Drag to reorder. Next to each: "Hide" (hidden from the client), "Duplicate" and "Remove".
- "Preview": the document exactly as the client will see it, with the item's real data. Above it, "Preview as" "a client (guest) sees it" or "a member sees it".
- Settings: the "Section" tab sets the selected section; the "Document" tab sets the whole document (look, money, link, contact, notifications and the email).

"Save" saves the document; "Save and close" also leaves the editor. "Update the template" saves your changes back to the template it came from.

## Sections

Click "Add section" and pick from the catalog. The main kinds:

| Section | What it does |
| --- | --- |
| "Header" | The document's title, a subtitle and fields such as date or validity. |
| "Text" | Free text, with values from the item. Can be split into "Two columns". |
| "Item fields" | A label and a value from the item's columns. |
| "Priced rows" | Rows from the item's subitems or linked items, each "Always included", "Tick any" (add-ons) or "Choose one" (packages), with quantity, unit price and monthly price. |
| "Summary" | One-time total, discount, VAT, total, monthly and payment terms. Updates as the client ticks. |
| "Client inputs" | Fields the client fills in, saved to the item's columns. |
| "Questions" | The client's questions arrive as updates on the item. |
| "Approval" | Name, role, boxes to tick and a signature. |
| "Table", "FAQ", "Timeline", "Media", "Call to action", "Divider", "Contents", "People" | Supporting content. |

An empty section (no rows or no text) is not shown to the client. In the editor it is marked "This section is empty and is not shown to the client."

Values from a field or fixed text: header and field values are picked from the item's fields and update by themselves. To write a fixed value instead, choose "✎ Type a fixed value" in the list.

## Connect columns and subitems

In a "Priced rows" section, "Which column feeds each part" sets where the description, "One-time price", "Price per unit (× quantity)", "Recurring price", "Quantity" and "Chosen (checkbox)" come from.

- "Create the columns" creates any missing columns on the subitems board and connects them to the section.
- Several sections from the same subitems (base, add-ons, subscription): "Filter rows by column" lets each section show its own kind.
- In the "Approval" section, "Create the columns" creates a signature column and a column to keep the signed copy.
- In the "Document" tab, "One-time total into" and "Recurring total into" write the totals to item columns, so they show on the board, in dashboards and in automations.

## Send the document

- "Link for the client" appears on every document in the "Documents" tab and in the editor header: the link, "Copy", and its state ("Active", "Expired" or "Closed").
- "Send" emails the link to the contact. The address comes from the "Contact email column" in the document's settings, or you type another. You can also choose "No email (I will share the link myself)": the document is marked sent and you share the link yourself, for example by WhatsApp.
- "Days valid after sending" (in the document's settings) sets how long the link works. After that the client sees that the document has expired.
- "Replace the link" makes the old link stop working. "Close the link" stops the client from opening it. "Reopen" brings it back.
- Optional: under "Before opening", choose "One-time code by email" so the client gets a code before the document opens.

The "Notifications" settings choose "Who is told" (a people column, or whoever created the document) and when: "When the client opens it", "When the client changes a choice", "When the client approves".

## What the client does

- Ticks add-ons and changes quantities. Totals and VAT update at once, and the choices are written to your subitems.
- "Select all" above the rows ticks or clears every row of a "Tick any" section. Turn it off in the section's settings: "The client can select all at once".
- Asks about any part with "Ask about this". The question arrives as an update on the item with the client's name and the section; your reply in that update shows on the page and reaches the client by email.
- Fills in details, if there is a "Client inputs" section.
- Approves: name, role, the required boxes, and a signature, drawn or typed. After approving, the page is locked.

On a phone, the summary stays at the bottom of the screen with an "Approve" button. The client can "Download PDF" from the top of the page at any time.

## PDF

- "Download PDF" is on the client's page, on every document in the "Documents" tab, and in the editor header. It is the same file for the client and your team.
- Before signing: the document as the client sees it now, with choices, totals and questions, marked as a draft on every page.
- After signing: exactly what was signed, with the signature and a signature certificate page. The signed copy is also saved as a PDF in the files column.
- In the editor, the PDF is of the saved version. Save first.
- Up to 60 pages. A longer document gets a message; split it into several documents.

## Signature and certificate

- After signing, the document's status changes to "Approved", the signature column shows who signed and when, and the signed copy is saved as a PDF. The "Approval" section can also set "Status after approval" on the item.
- Click the signature cell to open the "Signature certificate": the signer, how identity was checked, server time, source (IP address and browser), "What was signed", the consents, a SHA-256 "Document fingerprint", and the "Document log".
- To change a signed document, "Reopen" it. This creates a new version that must be signed again.

## The document log

In the "Documents" tab, open a document's "More actions" > "Document log" to see every event: created, sent, opened, verified with a code, changed a choice, filled in details, asked a question, approved and signed, downloaded the PDF, link replaced or closed, and expired.

## Templates

- "Save as template" on a document turns it into a template for this board or for all boards.
- "Manage templates" (in the "New document" menu) lists your templates.

## Look

- Account default: Administration > General > "Interactive document look". Set the background, page background, text, secondary text, accent, header bar and font, separately for guests (clients) and for members.
- Per template or document: in the editor, "Document" tab > "Look (colours and font)" > "Its own".
- When colour contrast is too low for accessibility, a warning appears next to the colours.

## Automations

On the board's automations, use the action "Send an interactive document". For example: when the status changes to Sent, send a document from the Quote template. If the item already has an open document from that template, it is sent again; otherwise a new one is created. The status set on approval can trigger the board's other automations.

AI assistants and agents connected through MCP can also create, send and read documents; sending to a client always asks for your confirmation first (see [MCP and API](mcp-and-api.md)).

## Questions

Does the client need an account? No. The link opens without signing in, and, if you chose it, with a one-time code by email.

How do I fix a document already sent? Edit and save. The client sees the change next time they open it. A signed document is reopened as a new version.

Who can delete a signed document? Only an admin.

## Related

- [Item card and collaboration](item-card-and-collaboration.md)
- [Boards, groups and items](boards-groups-items.md)
- [Columns](columns.md)
- [Automations](automations.md)
- [Docs and forms](docs-and-forms.md)
- [MCP and API](mcp-and-api.md)
- [Account administration](account-admin.md)
