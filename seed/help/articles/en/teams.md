---
title: "Teams"
slug: teams
locale: en
translation_of: teams
category: "permissions-and-sharing"
tags: ["teams", "permissions", "users", "columns"]
visibility: public
excerpt: "Create teams in the account, assign a whole team to an item, add it to a board in one go and use it in permissions and restricted columns."
publish: true
---
A team is a group of people in the account: "Sales", "Customer service", "North team". Instead of assigning, sharing or granting permission to each person separately, you do it once for the whole team, and when someone joins or leaves the team, all the settings update by themselves. Teams save a lot of work in large accounts, and prevent mistakes like a new employee someone forgot to add to an important board.

## What you'll learn

- How to create a team and manage its members
- How to assign a team to an item
- How to add a whole team to a board
- How teams fit into item visibility and restricted columns

## Creating a team (for account admins)

1. Open the avatar menu and choose **Administration**.
2. Go to **Teams**.
3. Click **New team**, type the **Team name** and click **Create**.

The team appears in the list, with the number of members in it.

## Managing team members

1. Hover over the team's row and click its actions menu.
2. Choose **Team members**.
3. Check the people who should be in the team (and uncheck anyone leaving).
4. Click **Save**.

![The team members window with the list of people in the account and checkboxes](images/teams-1.webp)

In the same menu you'll also find **Rename** and **Delete team**.

> **Note:** Only account admins create, change and delete teams. Other users (except guests) see the list of teams on the Home screen, read-only. A person can be a member of several teams.

## Assigning a team to an item

In a people column you can assign teams too, not only people:

1. Click the cell in the item's people column.
2. In the list that opens, check the team you want.

The team appears in the cell as an avatar with its name. All team members count as assigned to the item, so it counts as "mine" for each of them in filters, and it's included in any permission based on assignment.

> **Tip:** Assigning a team works especially well for shared queues, such as service requests or incoming leads, that any team member can pick up.

## Adding a team to a board

1. Open the board, click **⋯** in the header and choose **Permissions**.
2. In the **Subscribed teams** section, click **+ Add a team** and pick a team.
3. Pick the team's **Board role**: **Owner**, **Subscriber — per the set**, or a more limited explicit role, such as **Subscriber — views and comments**.

All team members get the subscription, including anyone who joins the team in the future. If a person also has a personal subscription to the board, their personal subscription takes precedence over the team's.

## Teams in advanced permissions

Teams work in every layer of the board's permissions:

| Setting | How the team fits in |
| --- | --- |
| **Edit only items assigned to them** | A team member can edit an item their team is assigned to |
| **Only what they created or are assigned to** | A team member sees items their team is assigned to |
| **Restricted columns** | You can add a whole team to **Allowed besides owners** on a restricted column |

That way, for example, you can set a "Cost price" column to be visible only to the board owners and the "Finance" team, and have each regional team see only the clients assigned to it.

## Teams on the users screen

The **Users** screen in Administration shows each user's teams, and you can filter the list by team, which is handy when you want to check quickly who belongs where.

## Frequently asked questions

**A person was removed from the team. What happens to items the team is assigned to?**\
The team stays assigned, but the person no longer counts as assigned through it. If their access to the board came only from the team's subscription, it's removed.

**Can guests be in a team?**\
Teams are meant for people in the organization. Guests don't see the list of teams, and their access is set directly by the shared boards they were invited to.

**Can members who aren't admins create teams?**\
No. Creating and managing teams is reserved for account admins.

## See also

- Board permissions and item visibility
- The people column
- Account roles: admin, member, viewer and guest
- Managing users and invitations
- My work
