---
title: "Managing users and invitations"
slug: manage-users
locale: en
translation_of: manage-users
category: "account-administration"
tags: ["admin", "users", "permissions"]
visibility: signed_in
excerpt: "How account admins invite people, change roles, deactivate users, transfer ownership and manage pending invitations."
publish: true
---
The **Users** area of the admin center shows everyone in the account in one place: who's active, who was invited and hasn't joined yet, and who was deactivated. From here you invite new people, change roles, handle an employee who's leaving, including transferring their boards and automations to someone else, and control the invitation settings.

## What you'll learn

- How to find users and filter the list
- How to invite people and manage pending invitations
- How to change a role, edit details and deactivate a user
- How to transfer ownership when someone leaves
- How to act on several users at once

> **Note:** User management is open to account admins only. To get there: your profile picture in the top bar → **Administration** → **Users**.

## The user list

For each person, the list shows **Name**, **Role**, **Title & department**, **Teams**, **Last active** and **Status** (**Active**, **Invited**, **Deactivated** or **Details deleted**). Clicking a column header sorts by it.

- Search in the **Search by name or email** box.
- Filter by role, status or team with the three filters next to the search.
- Click **Export CSV** to download the user list as a file.

![The user list in the admin center with search, filters and a user's action menu](images/manage-users-1.webp)

## Inviting users

1. Click **Invite users** at the top of the screen.
2. Type **Email addresses**; you can enter several, separated by commas.
3. Choose a **Role**: **Admin**, **Member**, **Viewer** or **Guest**.
4. With the switch, decide whether to **Email the invitation** or send it with **No email — only a link to copy**.
5. Click **Send invitations**.

> **Tip:** The email didn't arrive? You can send the invitation link yourself, by WhatsApp, SMS or any other way. The link is personal and works once.

### Pending invitations

Below the list is the **Pending invitations** section. Each invitation shows its state (**Emailed**, **Opened**, **Expired** and more), who sent it and until when it's valid. The actions:

- **Resend**: sends the email again and renews the validity.
- **Copy link**: creates a new link to copy (the previous link stops working).
- In the **More invitation actions** menu: **Send again, valid for…** and **Link to copy, valid for…**, to choose a different validity.
- **Cancel**: the link stops working immediately. You can invite again at any time.

### Invitation settings

The **Invitation settings** card sets rules for every invitation in the account, whether sent from here, from a board, a workspace, a doc or a dashboard:

- **Link valid for (days)**: between 1 and 90.
- **Wait between emails (minutes)**: how long to wait before the same invitation can be sent again.
- **Tell the inviter when the invitation is accepted**.

## Actions on a user

Click the action menu on the user's row:

- **Edit**: name, job title, department and phone.
- **Change role**: choose a different role. You can't change your own role.
- **One-time sign-in link**: for a user who can't sign in. The link lets them choose a new password; it's valid for an hour and works only once. Send it only to the person themselves.
- **Reset two-factor authentication**: for when the user's phone and backup codes are lost. This is recorded in the audit log.
- **Transfer ownership…** and **Deactivate**: see below.

## Deactivating a user and transferring ownership

When someone leaves, deactivate them instead of deleting them. A deactivated user can't sign in to the account, their tokens are revoked, and they stay shown in gray in people columns, so the history is kept.

1. In the user's menu, choose **Deactivate**.
2. In the **Deactivate user** window, choose **Transfer to whom?**: someone who will receive what the user owns.
3. Tick **What to transfer**: **Boards they own**, **Automations**, **Webhooks**, **Service tokens**, and if you want, **Also the people-column assignments** (the chosen user replaces them in people cells across all boards).
4. Click **Transfer and deactivate**.

![The deactivate-user window with the choice of new owner and what to transfer](images/manage-users-2.webp)

> **Note:** Automations and webhooks left owned by a deactivated user are switched off. That's why it's best to transfer them. To make it easier, set a **Default transfer user**: they'll be suggested first in every deactivation.

You can bring a deactivated user back at any time with **Activate**.

### Deleting details

A deactivated user also has the **Delete details** option. This can't be undone: the email, name, photo, phone and job title are deleted, and the content (items, updates, files, history) stays and is shown under "Deleted user" or under the first name only, as you choose. To confirm, you need to type the user's email address.

## Actions on several users

Tick several users with the checkboxes. A bar appears at the bottom of the screen with the number selected and the actions **Role**, **Deactivate**, **Activate** and **Clear**. Deactivating in bulk doesn't transfer ownership; to transfer, deactivate each user from their own menu.

## Frequently asked questions

**Does deactivating a user delete what they created?**\
No. All their items, updates and files stay, and they keep appearing in gray.

**How do I limit which email addresses can be invited?**\
In the **Security** area, on the **Allowed domains** card.

## See also

- Inviting people to the account
- Account roles: admin, member, viewer and guest
- Teams
- Account security
- Tidy up and the audit log
