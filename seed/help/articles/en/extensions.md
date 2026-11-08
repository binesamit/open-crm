---
title: "Extensions"
slug: extensions
locale: en
translation_of: extensions
category: "integrations-api-and-extensions"
tags: ["extensions", "integrations", "admin"]
visibility: public
excerpt: "What extensions are, how the account admin installs them, approves their permissions and updates them, and where you'll meet them in boards, item cards and automations."
publish: true
---
Extensions add new capabilities to the system without changing its core. There are two kinds: a **Data pack**, ready-to-use board templates, starter kits, automations and agent templates; and an **Extension with code**, a screen of its own inside the system, such as a special board view, a tab in the item card, a dashboard widget or a new automation action. Every extension runs fully isolated and gets only the permissions you approved, and never more than the user who opens it is allowed.

## What you'll learn

- Where extensions appear in day-to-day work
- How the account admin installs an extension and what you approve on the consent screen
- How to manage, update and remove extensions
- How to save boards and automations as a pack and move them to another account

## Where you'll meet extensions

Once the account admin has installed an extension, it can appear in the following places, on the boards approved for it:

| Place | What it looks like |
| --- | --- |
| **Board view** | A new view among the board's views |
| **Item card tab** | An extra tab in the item card |
| **Menu action** | A new entry in the ⋯ menu of the board or the item |
| **Action on selected** | A button in the bar that appears when you select several items |
| **Dashboard widget** | A new widget you can add to a dashboard |
| **Automation action** / **Automation trigger** | In the automation builder, at the bottom of the menu, under **From extensions** |
| **Settings page** | The extension's settings page in account administration |

Every change an extension makes is recorded in the activity log as "via the extension", and you can undo it.

> **Note:** If an extension was switched off, removed or not approved for a certain board, its screen shows a message that it isn't available. You can ask the account admin to turn it on.

## Managing extensions (account admins)

The screen is in **Administration** → **Extensions**, and it has four tabs:

- **Store**: extensions from the platform catalog.
- **Installed**: what's installed in the account.
- **Updates**: new versions waiting for your approval.
- **For developers**: installing a private extension and developer tools.

![The extensions screen in account administration, on the store tab](images/extensions-1.webp)

### Installing an extension from the store

1. On the **Store** tab, browse the cards. Each card shows the publisher's name, what the extension adds, and whether it is **Read-only** or **Can change data**.
2. Click **Install**. The consent screen **Install \<extension name\>** opens.
3. Go through the sections:

   - **What it adds**: the views, tabs and actions it will add, or for a data pack: templates, a starter kit, automations (off until you switch them on) and agent templates.
   - Warnings: for example, that the extension shows a screen from an external site, that it asks for write permission, or that it has its own server.
   - **Permissions**: you can turn a permission off (the extension may not work), but you can't give more than it asked for. Write permissions are marked **Writes**.
   - **Which boards**: **All boards** or **Boards I choose**, with **Add a board**.
   - **Available to guests**: off, guests don't see the extension at all. On, they see in it only what they're allowed to see.
4. Click **Approve and install**.

![The consent screen for installing an extension, with permissions, boards and guests](images/extensions-2.webp)

### Managing an installed extension

On the **Installed** tab, each extension has:

- An **Active** switch: turns it off temporarily without removing it.
- **Permissions:**: the list of approved permissions, with **Revoke this permission** for each.
- The number of boards the extension is available on, and whether it's available to guests.
- **Check for update** and **Remove**.
- **Extension settings**, when the extension has a settings page.
- **Versions**: the version history, with **Back to this version**. Going back to an earlier version locks the extension to it.

### Updates

The system checks for updates by itself, and you can also click **Check for update**. When **Automatic updates** is on, a version that doesn't ask for new permissions installs by itself, unless you locked the extension to a specific version. A version that asks for more permissions appears on the **Updates** tab, with **Review and approve**: the new permissions are marked **New**, and clicking **Approve the update** installs it.

## A private extension (for developers)

On the **For developers** tab, in the **Add an extension** area, you can install an extension that isn't in the store: choose **By address** and paste the address of a manifest file, or **Paste a manifest** with the content itself, and click **Check**. Here too, every installation goes through a consent screen.

> **Note:** An extension from a local address (localhost) works only in a development environment. A real environment requires a public https address.

## Saving as a pack

The **Save as a pack** button at the top of the screen saves boards (as templates, without items) and their automations in one file, for importing into another account through **Add an extension**, or for copying directly to another account you manage.

1. Click **Save as a pack**.
2. Fill in the **Pack name** and an **Id** (lowercase Latin letters, digits and hyphens), and choose boards.
3. Decide whether to **Include the boards' automations**: they'll be loaded switched off.
4. Click **Download the pack**.

## Frequently asked questions

**Can an extension see boards I don't have access to?**\
No. An extension works with the permissions of the user who opens it, and only on the boards and with the permissions approved at installation.

**An extension is marked "Switched off by the platform owner". What does that mean?**\
The extension was switched off in all accounts for security reasons. You can't use or install it until it's brought back into service.

## See also

- The automation builder: triggers, conditions and actions
- Working with views
- Dashboards and widgets
- API tokens and using the API
- The admin center
