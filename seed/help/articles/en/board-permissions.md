---
title: "Board permissions and item visibility"
slug: board-permissions
locale: en
translation_of: board-permissions
category: "permissions-and-sharing"
tags: ["permissions", "boards", "teams", "columns"]
visibility: public
excerpt: "Decide who sees the board and what they may do on it, limit visibility to the items assigned to each person, and lock sensitive columns."
publish: true
---
Not everyone who works on a board needs to do everything on it. Sometimes you want the team to update statuses but not change the board's structure; sometimes each rep should see only their own clients; and sometimes one column — price, salary, internal notes — should stay visible to just a few. The board's **Permissions** window brings all these decisions together in one place.

## What you'll learn

- How to open the permissions window and who can change it
- How to choose a board type and a permission level for board members
- How to limit each user to the items they created or are assigned to
- How to manage owners, subscribers and teams
- How to restrict columns for editing or viewing

## Open the permissions window

1. Open the board.
2. In the board's header, click **⋯** and choose **Permissions**.

![A board's permissions window: the board type, what non-owners may do and which items they see](images/board-permissions-1.webp)

> **Note:** Only board owners and account admins change permissions. Everyone else sees the window read-only, with the message **Only board owners and admins change permissions.**

## Board type

In the **Board type** section you choose who sees the board at all:

- **Main** — all account members see the board (subject to access to the workspace).
- **Private** — only people invited to the board see it.
- **Shareable** — people invited to the board, including guests from outside the company.

## What non-owners can do

This is the board's central setting. Choose one of four options:

| Option | What it allows |
| --- | --- |
| **Edit everything** | Items, groups, columns and views |
| **Edit content only** | Items and cells — not the board's structure |
| **Edit only items assigned to them** | Items they created, or that they (or their team) are assigned to |
| **View and comment** | They see and comment, but don't change anything |

The setting applies to everyone who isn't an owner of the board. Board owners can always do everything.

> **Tip:** "Edit content only" is a great choice for boards with a fixed process: the team updates the items, but nobody deletes a column or changes status labels by mistake.

## Which items they see

In the **Which items they see** section you set item visibility:

1. **All items** — the default.
2. **Only what they created or are assigned to** — each user sees only items they created, or that they (or a team they belong to) are assigned to.

When you choose the second option, you can set **By which people columns** the assignment is decided: **Any people column**, or specific columns only (for example only "Handling rep", and not "Created by").

> **Note:** Board owners and account admins always see all items. A subitem is visible when it or its parent item is visible. An item that isn't visible to a user won't appear for them anywhere — not in search, not in updates and not in exports.

## Owners and subscribers

The **Owners and subscribers** section lists everyone added to the board:

1. Click **Add subscriber** and choose a person from the account.
2. For each person on the list, choose a **Board role**:

   - **Owner** — full control, including permissions.
   - **Subscriber — per the set** — gets whatever is set in "What non-owners can do".
   - A lower explicit role, for example **Subscriber — views and comments**.
3. To remove someone from the board, click the X in their row.

An explicit role only restricts beyond the board's setting — it doesn't expand it. If the board is set to "Edit content only", you can't give a subscriber "Edits everything"; but you can limit a particular subscriber to "Views and comments".

> **Note:** A board must have at least one active owner. If the only owner is deactivated, a message appears, and the account admin can click **Take ownership**.

### Invite new people

In the **Invite by email** section you can invite people who aren't in the account yet. Anyone invited from here is added to this board when they accept the invitation.

## Subscribed teams

Instead of adding people one by one, you can add a whole team:

1. In the **Subscribed teams** section, click **+ Add a team** and choose a team.
2. Choose a **Board role** for the team, just as for a person.

All the team's members get the subscription. If a person also has a personal subscription, the personal one takes precedence over the team's.

## Restricted columns

In the **Restricted columns** section you lock sensitive columns:

1. Click **+ Restriction**.
2. In **Which column to restrict?** choose a column, then the type of restriction:

   - **Restricted editing** — everyone sees the column, but only those allowed can change it. Others see a lock.
   - **Restricted viewing** — anyone not allowed doesn't see the column at all.
3. In the column's row, under **Allowed besides owners**, add people or teams. If you don't add anyone, the restriction is **Owners only**.
4. To change the type of restriction or remove it, click the restriction type label in the row, or **Remove the restriction**.

![The restricted columns section with a column on restricted viewing and the list of allowed people](images/board-permissions-2.webp)

> **Tip:** Board owners and account admins are always allowed in restricted columns, so there's no need to add them to the allowed list.

## Frequently asked questions

**I gave a user "Edits everything" but they still can't edit.**\
Check their role in the account. A viewer in the account is always a viewer on the board, regardless of the board's settings — the stricter setting wins.

**How do I set up a board where each client sees only their own requests?**\
Make the board **Shareable**, choose **Only what they created or are assigned to**, invite the clients as guests and assign each one to their items. See the article on working with guests.

**Is a filtered view enough to hide information?**\
No. A filter in a view is only a convenience. To really hide something, use "Which items they see" or "Restricted viewing" on a column.

## See also

- Account roles: admin, member, viewer and guest
- Working with guests
- Teams
- People column
- Invite people to the account
