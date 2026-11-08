---
title: "The admin center"
slug: admin-center
locale: en
translation_of: admin-center
category: "account-administration"
tags: ["admin", "account"]
visibility: signed_in
excerpt: "A tour of the account's admin center: which areas it has, and how to set the profile, dates, defaults and the system announcement."
publish: true
---
The admin center is where account admins set everything that applies to the whole account: its details and logo, time zone and currency, defaults for new boards, users, security, connections, AI, the plan and more. Every setting saves on its own as soon as you change it, and a short **Saved** message appears.

## What you'll learn

- How to open the admin center and what each area contains
- How to change the account name and logo
- How to set dates, times, time zone and currency
- How to set defaults for new boards
- How to publish a system announcement to all account members

> **Note:** The admin center is open to account admins only. Other users don't see the way in, and even a direct link takes them back to the home page.

## Opening the admin center

1. Click your profile picture in the top bar.
2. In the menu that opens, choose **Administration**.
3. The screen opens on the **General** area. At the side of the screen there's an **Administration sections** menu; on a phone the areas appear as a row of tabs you can scroll sideways.

![The admin center with the areas menu at the side and the "General" area open](images/admin-center-1.webp)

## Areas of the admin center

| Area | What you set there |
| --- | --- |
| **General** | Account details, dates and currency, defaults, email and SMS, API limits, system announcement |
| **Notifications** | Notification defaults for the whole account |
| **Users** | Everyone in the account, invitations, roles and deactivation |
| **Teams** | Creating and managing teams |
| **Templates** | The account's board templates |
| **Security** | Active sessions, domains, two-factor authentication, IP restriction and support access |
| **Connections** | API tokens and webhooks |
| **Flows** | Connecting to Make and n8n |
| **Extensions** | Managing the account's extensions |
| **AI & MCP** | AI connections, budget, AI assistant and MCP |
| **Usage** | Automation runs, API calls, storage and active users |
| **My plan** | What the plan includes and how much has been used |
| **Tidy up** | All boards in one table and scheduled cleanup rules |
| **Audit log** | Who did what and when in the account |

## Account profile

In the **Account profile** card in the **General** area:

1. Edit the **Account name** and save.
2. Under **Logo**, click **Upload logo** and choose a square image. The logo appears in the sidebar and in the account switcher. To change it, click **Replace logo**, and to delete it, **Remove**.
3. The **Account address** and **Your role** are also shown here.

In **The phone app** card you set how the app looks on the phone's home screen (its name, color and start page) and the push notification settings.

## Dates, times and currency

In the **Dates, times and currency** card you set the account's defaults:

- **Time zone**: used by users who haven't chosen a time zone in their profile.
- **Weekend**: **Friday–Saturday** or **Saturday–Sunday**.
- **First day of the week**: in calendars and date pickers.
- **Date format** and **Time format**: **24-hour (16:30)** or **12-hour (4:30 PM)**.
- **Country**: phone numbers typed without a country code belong to this country.
- **Currency**: the currency offered when a numbers column is shown as money.

> **Tip:** Every user can change their own language and time zone in their personal profile.

## Defaults for new boards

The **Defaults for new boards** card applies only to what's created from now on; existing boards and templates don't change.

- **Item terminology**: what an item is called on a new board, for example "Lead", "Task" or "Client". Empty = "Item".
- **Status labels**: click **Edit labels** to set which labels and colors a new status column starts with.
- **Group colours**: the order in which new groups get a color. **Reset** goes back to the usual order.

## Updates and views

The **Updates** card has two switches:

- **Show who viewed updates**: every update and reply shows who has seen it.
- **Show who viewed boards**: in each board's header, who opened it and how long ago.

When a switch is off, views aren't recorded or shown.

## System announcement

A system announcement is a strip that appears at the top of the app for all account members, for example "Scheduled maintenance on Friday at 22:00".

1. In the **System announcement** card, write the **Message**.
2. You can add a **Link (optional)**: it's shown as "Details" at the end of the announcement, and must start with https://.
3. You can choose **Until (optional)**. Empty = until you remove it.
4. Click **Publish**.

![The system announcement card with text, a link and an end date](images/admin-center-2.webp)

Anyone can close the announcement for themselves. To change it, click **Update**, and to take it down completely, **Remove**.

## Frequently asked questions

**How do I add another admin to the account?**\
In the **Users** area, change the user's role to **Admin**.

**I changed the status labels, but they didn't change on an existing board. Why?**\
Defaults apply only to new columns and boards. On an existing board, edit the labels directly in the column.

## See also

- Managing users and invitations
- Account security
- My plan and usage
- Messaging: email and SMS from the account
- Account roles: admin, member, viewer and guest
