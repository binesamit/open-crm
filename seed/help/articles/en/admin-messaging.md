---
title: "Messaging: email and SMS from the account"
slug: admin-messaging
locale: en
translation_of: admin-messaging
category: "account-administration"
tags: ["admin", "notifications"]
visibility: signed_in
excerpt: "How to set who the account's emails and SMS messages come from, what the emails look like, who may send SMS, budgets and templates."
publish: true
---
The system sends emails on behalf of your account — invitations, sign-in links, notifications, digests and emails from automations — as well as SMS messages from items and automations. In the **Emails & SMS** settings you decide what these messages look like and which name they're sent from, and in the **SMS** settings you decide who may send, how much may be sent and which ready-made texts are available to everyone.

## What you'll learn

- How to change the sender name, reply-to address, color and logo of the emails
- How to preview every email and send a test email
- How to decide who sends SMS and with which budgets
- How to create SMS templates

> **Note:** These settings are available to account admins only: your profile picture → **Administration** → **General**, then scroll to the **Emails & SMS** and **SMS** cards.

## The sender and look of the emails

In the **Emails & SMS** card. An empty field = the default.

- **Email sender name** — the name the recipient sees. Empty = the account name.
- **Reply-To address** — where replies to the account's emails go. Empty = none.
- **Email colour** — the color of the bar and button in the emails, in \#rrggbb format. Empty = the platform color.
- **Email logo** — a separate image for emails. Without a separate logo, **The account logo** is used.
- **SMS sender ID** — up to 11 Latin letters or digits, or a phone number. Empty = **Platform default**.

![Emails & SMS card with the sender name, reply-to address, color and logo](images/admin-messaging-1.webp)

### Sender name approval

A sender name, reply-to address or SMS sender ID that isn't the account name needs approval from the platform admin — to prevent impersonation. Until it's approved, messages keep going out as they do now. Next to the field you'll see the status:

| Status | Meaning |
| --- | --- |
| **Waiting for approval** | The request was sent. Until it's approved, messages go out under the previous name. |
| **Approved** | The new name is in use. |
| **Rejected** | The request wasn't approved, and the reason is shown. |

## Preview and test send

In the **Email preview** section you can see every email the system sends, with sample data:

1. Choose the email type: **Account invitation**, **Sign-in link**, **Password reset**, **Notification**, **Notification digest**, **Automation email** or **Channel test**.
2. Choose the **Email language**: **עברית** or **English**.
3. Click **Preview**. In the window you can switch between **Formatted** and **Plain text**.
4. To see the email in your real inbox, click **Send a test to me**.

> **Tip:** Changed the color or logo? Preview the **Account invitation** — it's usually the first email new people get from you.

## Who sends SMS

In the **SMS** card you decide who sends SMS from items, which templates are saved, and what the budgets are — because SMS costs money.

Under **Who may send**, choose:

- **Admins** — account admins only.
- **Account members** — all members.
- **Nobody** — SMS sending is off.

> **Note:** Guests never send SMS. Automations act according to the role of the person who created them.

## Budgets

Under **Budgets** you decide how many SMS messages may be sent:

- **Per person / hour** — so one person doesn't send hundreds of messages by mistake.
- **Per account / day** — a ceiling for the whole account.

Click **Save**. Anyone who reaches the budget gets a message that they've reached the SMS budget, and sending resumes in the next hour or day.

## SMS templates

Templates are saved texts you can pick in the SMS window and in automations.

1. In the **SMS templates** section, click **New template**.
2. Write the **Template name** and the **Text**. You can use the item name and its columns, such as {item.name} or {item.status}, and they're replaced with the item's values when the message is sent.
3. Click **Save**.

![SMS template creation window with name, text and character counter](images/admin-messaging-2.webp)

To change or delete a template, use the **Edit template** and **Delete template** buttons in its row.

## API limits

The same area also has the **API limits** card — how many requests the account's tokens may send, per minute and per day, separately for personal tokens and service tokens. An empty field = the platform default. The details are in the article on API tokens.

## Frequently asked questions

**Why do recipients still see the old name?**\
A new sender name is waiting for approval from the platform admin. Until it's approved, messages go out under the previous name.

**Can I send SMS to any country?**\
That depends on the SMS provider set up on the platform. If the provider doesn't support the destination, you'll see a message when sending.

## See also

- The admin center
- Notifications and notification preferences
- The automation builder: triggers, conditions and actions
- Email, phone, link, location and country
- API tokens and using the API
