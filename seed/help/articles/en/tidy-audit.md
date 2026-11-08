---
title: "Tidy up and the audit log"
slug: tidy-audit
locale: en
translation_of: tidy-audit
category: "account-administration"
tags: ["admin", "archive", "security"]
visibility: signed_in
excerpt: "How to review every board in the account, deal with empty and abandoned boards, set up automatic nightly cleanup and check the audit log for who did what."
publish: true
---
As an account grows, it collects boards nobody uses anymore, items that were finished long ago, and boards whose owner has left. The **Tidy up** area gathers all the boards into one table and lets you deal with them quickly, and even set cleanup rules that run on their own every night. The **Audit log** area completes the picture: it records who did what in the account, and when.

## What you'll learn

- How to find empty, old or ownerless boards
- How to archive a board, delete it or transfer its ownership
- How to set up scheduled cleanup rules and check them before turning them on
- How to search and filter the audit log

> **Note:** Both areas are open to account admins only: your profile picture → **Administration** → **Tidy up** or **Audit log**.

## All boards in one table

The table shows every board with its **Workspace**, **Kind** (**Main**, **Shareable** or **Private**), **Owners**, **Last updated**, **Items** and **Status** (**Active**, **Empty** or **Archived**).

1. Search in the **Search a board or workspace** box.
2. Under **Show**, choose what to see: **All**, **Empty**, **Not updated**, **No active owner** or **Archived**.
3. When you choose **Not updated**, also set the period in **Not updated for**: 30, 90, 180 or 365 days and more.

![The board table in Tidy up with the "No active owner" filter](images/tidy-audit-1.webp)

> **Note:** For a private or shareable board you aren't on, you see only general details, not its content.

### Board actions

In each board's actions menu:

- **Open**: go to the board.
- **Archive**: the board leaves the sidebar and stays in the archive; you can restore it from there.
- **Delete**: the board moves to the Trash.
- **Transfer ownership**: choose the **New owner**, and if you like, tick **Keep the current owners too**.

> **Tip:** The **No active owner** filter is great after an employee leaves: it shows exactly which boards need a new owner.

## Scheduled cleaning

In the **Scheduled cleaning** card you set rules that run every night. Rules that touch content are off until you turn them on; technical cleaning (marked **Technical**) is on from the start.

| Rule | What it does |
| --- | --- |
| **Archive done items** | Items whose status is "done" and that haven't changed for a number of days move to the archive. |
| **Archive idle boards** | Boards with no change for a number of days. A board without an active owner is never archived. |
| **Empty the trash sooner** | What has been in the Trash longer than a number of days is deleted for good (without the rule, after 30 days). |
| **Delete old notifications** | Bell notifications above a certain age. |
| **Delete old activity log** | Old change history (at least 90 days). |
| **Automatic doc versions** | Automatically saved versions. Named versions are kept forever. |
| **Agent run logs** | The step details of old runs. The run summary and its cost stay. |
| **Expired OAuth grants** | Codes and tokens of AI connections that expired or were revoked. |

For each rule you set a number of days, and you can choose **Workspaces left alone**.

1. Click **Check** to see what would happen, without changing anything. For each rule you'll see how many things would change, with examples.
2. When everything looks right, turn on the rules you want. They'll run the next night.
3. You can also click **Run now** to run the enabled rules right away.

At the bottom of the card you'll see the **Last run** and **Earlier runs**: when they ran, whether they were scheduled or manual, and how many changes were made. You can download a run's details as a CSV file.

> **Note:** Archived items and boards can be restored from the archive. What retention rules delete doesn't come back. Always start with **Check**.

## Audit log

The **Audit log** records who did what and when in the account: invitations, role changes, deactivations, tokens, sign-outs, settings changes, archiving and deleting boards, support access, sharing with guests and revealing secrets.

Each entry shows **When**, **Who**, **Event**, **Target**, **Details** (what it was before and after) and **IP**. Actions the system did on its own are marked **System**.

1. Filter by user (**Anyone**), by event (**All events**) or by **Date range**.
2. Click **Clear filters** to go back to all entries.
3. Page through with **Previous** and **Next**.
4. Click **Export CSV** to download the entries, according to the current filter.

![The audit log filtered by the "Role changed" event](images/tidy-audit-2.webp)

## Frequently asked questions

**I archived a board by mistake. How do I get it back?**\
On the **Archive** page (your profile picture → **Archive**), click **Restore** next to the board, or filter here by **Archived**.

**Can I delete entries from the audit log?**\
No. The log is there to keep a record, so it can't be edited or deleted.

## See also

- The archive
- Trash and restoring
- Managing users and invitations
- Account security
- The admin center
