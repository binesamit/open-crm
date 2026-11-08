---
title: "Working with guests"
slug: guests
locale: en
translation_of: guests
category: "permissions-and-sharing"
tags: ["guests", "permissions", "boards"]
visibility: public
excerpt: "Share a board with clients, suppliers and freelancers, so they see only what's meant for them while you keep working as usual."
publish: true
---
Guests are people outside the organization you want to bring into the work: a client following their project, a supplier updating order statuses, a freelancer receiving tasks. A guest uses exactly the same interface as any user, but sees only the shareable boards they were invited to, and inside them, if you like, only their own items. This lets you build a real "client portal" without a separate system and without copying information.

## What you'll learn

- What a guest sees and what they can't do
- How to prepare a board for sharing with guests
- How to invite a guest to a board
- How to build a board where each client sees only their own items
- How to limit which domains guests can be invited from

## What a guest sees

- **Only shareable boards** they were invited to. The sidebar shows only the workspaces and folders that lead to those boards, not the rest of the account's structure.
- **Inside the board**: whatever the board permissions allow them: full editing, content editing, editing the items assigned to them, or viewing and commenting.
- **People**: only those they work with on the shared boards, not the account's full user list.

What a guest **can't** do:

- Invite people, build automations or own a board.
- Be a member of a workspace.
- See Administration, the Trash, the archive, the activity log or API tokens.

A guest who hasn't had any board shared with them yet lands on a screen that says **No board has been shared with you yet**, with an explanation of whom to contact.

> **Tip:** Guests don't take a seat in the plan's user quota.

## Step 1: Prepare the board

Guests can join only a **Shareable** board.

1. Open the board, click **⋯** in the header and choose **Permissions**.
2. Under **Board type**, choose **Shareable**.
3. Under **What non-owners can do**, choose the right permission level. For working with clients, **Edit only items assigned to them** or **View and comment** are common choices.

> **Note:** If the board is main or private, the invitation section shows the message **Guests join only shareable boards — change the board type above to Shareable.**

## Step 2: Invite the guest

1. In the same permissions window, scroll to the **Invite by email** section.
2. Type the guest's email address in **Email addresses**.
3. Under **Role**, choose **Guest**.
4. Click **Send invitations**.

![The permissions window of a shareable board, with a guest invited by email](images/guests-1.webp)

The guest receives an email with a link, chooses a name and password, and is added to the board as soon as they accept. If the email doesn't arrive, copy the link that appears after sending and send it over WhatsApp.

> **Note:** A guest's email address must be from a domain that isn't your organization's. Employees from the account's domain are invited as members or viewers.

## Client portal: everyone sees only their own

The common scenario: one "Requests" board, where each client sees only their own requests.

1. Make sure the board has a people column, for example "Requester" or "Client".
2. In the **Permissions** window, under **Which items they see**, choose **Only what they created or are assigned to**.
3. Under **By which people columns**, choose the right column (or leave **Any people column**).
4. Invite the clients as guests, and assign each one to their items in the people column.

From now on, each client sees only the items they're assigned to or created themselves. A new item a client opens stays visible to them. You, the board owners, keep seeing all the items as usual.

![The board as the guest sees it: only the items assigned to them](images/guests-2.webp)

> **Tip:** If the board has an internal column, for example "Team notes" or "Cost price", set it to **Restricted viewing** in the **Restricted columns** section, and guests won't see it at all.

## Docs and dashboards

You can also share a doc or a dashboard with guests, when they're set as shareable. On a dashboard, a guest sees widget data only from boards shared with them.

## Guest domain policy (for account admins)

Account admins decide which domains guests may be invited from, in **Administration** → **Security**, in the **Guest domains** section:

- **Any domain**: any email that isn't from the account's domains.
- **Only from a list**: guests only from the domains on the list.
- **All but a list**: any domain except those on the list.

## Removing a guest

- **From one board**: in the **Permissions** window, under **Owners and subscribers**, click the X in the guest's row.
- **From the whole account**: the account admin deactivates the user on the Users screen in Administration.

## Frequently asked questions

**The "Guest" option shows as unavailable.**\
Inviting guests depends on the account's plan. If it says **Not in the plan**, contact your account admin.

**Can a guest invite their colleagues?**\
No. Only users from your organization can invite guests.

**Does the guest see the names of all our employees?**\
No. A guest sees only the people subscribed to the boards shared with them, and on a restricted board, only those who appear on the items they see.

## See also

- Board permissions and item visibility
- Account roles: admin, member, viewer and guest
- Inviting people to the account
- Account security
- Sharing a dashboard, and a dashboard inside a board
