---
title: "Forms"
slug: forms
locale: en
translation_of: forms
category: "docs-and-forms"
tags: ["forms", "views", "boards", "integrations"]
visibility: public
excerpt: "Build a form from a board, share it by link, QR code or embedding on a website, and every response automatically becomes a new item on the board."
publish: true
---
A form is the simplest way to get information into a board from outside: client requests, event sign-ups, equipment requests, fault reports. Each question on the form is connected to a column on the board, and each submission creates a new item with the answers in the right place, with no copying and no typos. You share the form by link, by QR code or by embedding it on your website.

## What you'll learn

- How to create a form and add questions to it
- How to use required, conditional and hidden questions
- How to share the form and control who fills it in
- How to design the form page and protect it from spam

## Creating a form

1. Open the board the responses should go to.
2. Click **+** next to the view tabs and choose **Form**.
3. Give the view a name and click **OK**. The form editor opens.
4. Fill in the **Form title** and **Description**: they appear at the top of the page.

> **Note:** Forms are available according to the account's plan. In the form editor, every change is saved automatically within a second, so there's no need to click "Save".

![The form editor with a title, a list of questions, and the “Share” and “Settings” cards](images/forms-1.webp)

## Adding and editing questions

1. In the **Questions** area, click **Add a question**.
2. Choose a column from the board. Each column can appear once.
3. Click the question (or **Edit question**) to open its settings:

   - **Question on the form** — the wording people filling it in will see (empty = the column name).
   - **Help text** — a short explanation under the question.
   - **Required** — the form can't be sent without an answer.
   - **Show only if** — a conditional question that appears only when an earlier answer equals a certain value (or **Checked** / **Not checked** for a checkbox).
4. Drag questions to change the order, and use **Remove question** to take one out.

For file questions you can set a **Max file size (MB)**, **Max number of files** and **Allowed file types**.

> **Tip:** At the bottom of the question list, **Columns that can't be questions** are listed, for example columns that are calculated automatically, with the reason.

## Hidden questions: values that fill themselves

Check **Hidden (preset value)** so people filling in the form don't see the question, but every new item gets a value. Under **Where the value comes from**, choose:

| Source | When to use it |
| --- | --- |
| **Type it** | A fixed value, for example the request source "Website" |
| **Pick from the column's options** | A label, person or date, without typing |
| **From an item on a board** | A value read from another item on every submission (and updated if the item changes) |
| **An item on the linked board** | For a connect boards column: every new item is linked to the chosen item |
| **From the link** | A value from the address, for example `?ref=newsletter`, so the same form is shared with several links |

> **Tip:** With the **From the link** source, you can send each campaign its own link and know where each request came from. Check **When the link has no value, use a fixed value** as a fallback.

## After submitting

In the **Submit and thank you** card, you set the **Submit button text**, the **Thank-you message**, or going to an address after submitting (a full address starting with https://).

## Sharing the form

In the **Share** card:

- **Form is on** — when it's off, the link returns "not found".
- **Form link** with **Copy link** and **Open the form**.
- **QR code of the form** with **Download QR**: perfect for signs and print.
- **New link** — replaces the link; the old link and its QR code stop working right away.
- **Allow embedding on other sites**, then **Copy embed code**, to show the form inside your website.

The card also shows the number of responses, for example **42 responses**.

## Form settings

In the **Settings** card:

- **Who can fill it** — **Anyone with the link**, or **Account members only** (people filling it in are asked to sign in).
- **Form language** — the texts and direction of the form page.
- **Group for new items** — the default is **The board's first group**.
- **Close on** and **Max responses** — once these are reached, the form shows **This form is closed and no longer accepts answers.**
- **Account name and logo**, **Logo** and **Cover image** — for a branded look.

### Spam protection

Every form is always protected by a honeypot field and rate limiting. You can also add Cloudflare Turnstile: enter the **Turnstile site key** and **Turnstile secret key** from your Cloudflare account.

## What people filling it in see

They open the link, answer the questions and click **Submit**. A required field that wasn't filled in is marked **Required**, and at the end the thank-you message appears. The item shows up on the board right away.

![A public form page on a phone with questions, a file field and a “Submit” button](images/forms-2.webp)

## FAQ

**Where do I see the responses?**\
Each response is an item on the board, in the chosen group. You can run automations on them, for example emailing the team about every new request.

**I changed a question. Does the link change?**\
No. The link changes only if you click **New link**.

## See also

- Working with views
- Adding and managing columns
- Introduction to automations and templates
- Connect boards and the mirror column
- Docs
