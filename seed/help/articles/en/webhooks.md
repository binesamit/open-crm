---
title: "Incoming and outgoing webhooks"
slug: webhooks
locale: en
translation_of: webhooks
category: "integrations-api-and-extensions"
tags: ["webhooks", "integrations", "automations"]
visibility: public
excerpt: "How to send events from a board to an external system like Make or n8n, and how to receive data from an external system that runs an automation on a board."
publish: true
---
A webhook is the simplest way to connect your boards to other systems. An **outgoing webhook** sends a message to an external address every time something happens on the board, for example a new item or a status change. An **incoming webhook** is an address that an external system (a website form, Make, n8n) sends data to, and that data runs an automation on the board. That way, for example, a lead that comes in on your website can become an item on your leads board within seconds.

## What you'll learn

- How to create an outgoing webhook from a board, and what the challenge is
- How to track deliveries, test and resend
- How to send a webhook from an automation
- How to set up an incoming webhook that runs an automation

## Outgoing webhook from the board

A board's webhooks are set up in its automations window. Only board owners and account admins see the tab.

1. In the board header, click **Automations** and go to the **Webhooks** tab.
2. Click **+ New webhook**.
3. In the **URL** field, paste the receiving address, for example a Custom webhook in Make or a Webhook node in n8n.
4. Under **Event**, choose what sends the message (see the table).
5. Depending on the event, fill in a **Column**, **Label** or **Group**. For example, for "Status changed" you can leave **Any status column** and **Any label**, or narrow it down to one label.
6. Click **Verify and save**.

![The new webhook form in the Webhooks tab of the automations window](images/webhooks-1.webp)

### Verification (challenge)

When you save, the system sends a POST request to the address with `{"challenge": "…"}`, and the address needs to return the same value in its response. This confirms the address is yours and that it's live.

- **In Make:** after the Webhook, add a **Webhook response** module that returns the challenge.
- **In n8n:** use **Respond to Webhook** to return the challenge.

If verification fails, the message **Not saved:** appears with the error details.

### Available events

| Group | Events |
| --- | --- |
| Items | Item created, Item renamed, Item moved to a group, Item moved to a specific group, Item archived, Item deleted, Item restored, Item moved to a board |
| Columns | Any column changed, A specific column changed, Status changed, Column created, Column type changed |
| Subitems | Subitem created, Subitem column changed, Subitem renamed, Subitem archived, Subitem deleted |
| Updates | Update posted, Update edited, Update deleted, Subitem update posted |
| Other | Group created, Sent from an automation (send to integrations) |

### Managing existing webhooks

Each row in the list has:

- **Switch off** / **Switch on**: pause deliveries temporarily.
- **Test**: send a test message. The message **Ping delivered** appears, or the details of the failure.
- **Log**: every delivery and its status: **pending**, **delivered**, **failed** or **dead**, with **Send again** for each delivery.
- **Signing secret**: **Show**, **Copy** and **New secret**.
- **Delete**.

> **Note:** A failed delivery is retried automatically several times over a few hours. A webhook that fails again and again is switched off and marked **Switched off after many failures**. Fix the address and switch it back on.

### Security: verifying the signature

Every delivery is signed. The request headers include `X-Bines-Event` (the event name), `X-Bines-Delivery` (the delivery ID), `X-Bines-Timestamp` and `X-Bines-Signature` in the format `sha256=<hex>`: an HMAC-SHA256 signature of `timestamp + "." + request body`, using the signing secret. Verify the signature on your side, and use the delivery ID to detect duplicates.

## Webhook from an automation

When you only need to send in certain cases, with conditions, use an automation:

- The **Webhook** action ("send a webhook to {url}") sends the item to an address you choose, as part of any automation. For example: "When status changes to 'Won', send a webhook".
- The **Send to integrations (n8n / Make)** action sends the item to every webhook on the board that's registered for the **Sent from an automation** event. You can specify a **channel**, so each flow gets only what's meant for it.

## Incoming webhook: an external system runs an automation

1. In the automations window, click **Build a custom automation**.
2. As the trigger, choose **Incoming webhook** (in the **Webhooks** group).
3. In the **Secret (required)** field, enter your own secret, or leave it empty: **Empty = generated on save**.
4. Under **Which item?**, choose:

   - **No item (board level)**: suits actions like **Create an item**.
   - **By item id**, or by a column (text, email, phone, number or link): to update an existing item. In **JSON field**, write where the value is in the message.
5. Add actions. In texts you can use the incoming data: `{payload.field}`, for example `{payload.lead.name}`.
6. Save. The automation list shows an **Inbound URL** with a **Copy** button.

![An automation row with an incoming webhook and the address to copy](images/webhooks-2.webp)

Set up the address in the sending system: a POST request with a JSON body, with the secret sent in the `X-Bines-Secret` header, not in the address itself.

> **Note:** An automation saved before a secret was required is marked **No secret — inactive**. Open it and save it (a secret is generated), then copy the secret to the sending system.

## Frequently asked questions

**Is there a limit on the number of incoming messages?**\
Yes, there's a rate limit for each automation, and an address that sends a wrong secret again and again is temporarily blocked.

**How do I know exactly what was sent?**\
Open the webhook's **Log**. When testing an automation (**Preview**), the content that would be sent is shown without actually sending it.

## See also

- API tokens and using the API
- Flows: connecting to Make and n8n
- The automation builder: triggers, conditions and actions
- Testing, run history and troubleshooting
