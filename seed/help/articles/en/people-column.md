---
title: "The people column"
slug: people-column
locale: en
translation_of: people-column
category: "columns"
tags: ["columns", "users", "teams", "notifications"]
visibility: public
excerpt: "How to assign people, teams and digital workers to items with a people column, and how assignment affects notifications, My work and permissions."
publish: true
---
The **People** column answers the question "who's responsible for this?". With it you assign each item one or more team members, a whole team, or a digital worker (an AI agent). Assignment is much more than a picture in a cell: it sends a notification to whoever was assigned, puts the item on their My work screen, and is used in filtering, automations and permissions.

## What you'll learn

- How to assign and remove people and teams from an item
- What happens when you assign someone to an item
- How to filter the board by person, including "Me"
- How the people column affects permissions and My work

## Adding a people column

Click **+** (**Add column**) at the end of the header row and choose **People**. You can add several people columns to the same board, for example "Owner" and "Approver", and give each its own name.

## Assigning people to an item

1. Click a cell in the people column.
2. In the panel that opens, type part of the name or email address in the **Search people** field.
3. Tick the checkbox next to each person you want to assign. You can choose several people.
4. The list is split into **Teams** and **People**. Ticking a team assigns the whole team at once, and each team shows its number of members.
5. Digital workers (AI agents set up so they can be assigned) appear in the list with the **Digital worker** tag.

![The people picker panel with search, teams and ticked people](images/people-column-1.webp)

The cell itself shows the profile pictures of up to three people, and if more were assigned, an extra number appears next to them (for example +2). People without a profile picture are shown with their initials.

### Removing an assignment

Open the cell. Everyone assigned appears as chips at the top of the panel. Click a chip (**Remove** and the person's name) to remove them, or untick them in the list.

> **Note:** The list shows only active members of the account. A user who was suspended or hasn't accepted their invitation yet won't appear until they're active.

## What happens when you assign someone

- **Notification:** whoever was assigned gets a notification in their updates inbox, for example "Dana assigned you to 'Quote for Alpha Ltd'". Each user can decide in their notification preferences whether to get assignment notifications, and on which channels.
- **My work:** the item appears on the **My work** screen of whoever was assigned, along with its due date and status.
- **Automations:** you can trigger an automation when a person is assigned, or assign a person automatically when something changes.

## Filtering by person

To see "what's on Yossi's desk":

1. In the board's toolbar, click **Filter**.
2. Click **+ Condition**, choose the people column and the operator **is** (or **is not**).
3. Choose the person you want. The value **Me** always shows the items of whoever is viewing the board, so a single saved view works for every team member.
4. To find items that haven't been assigned yet, choose the operator **is empty**.

![The filter panel with a condition on the people column and the value Me](images/people-column-2.webp)

## People and permissions

The people column decides who counts as "assigned" to an item. On a board where edit permissions are set to "edit assigned items only", a team member can edit only items where they (or a team they belong to) appear in one of the people columns. That way everyone can work on their own tasks without changing other people's tasks.

> **Tip:** If you want every item to get an owner the moment it's created, build an automation "when an item is created, assign…" instead of remembering to do it manually.

## The summary row

Each group has a summary row at the bottom. Click the people column's cell in that row and choose **filled** to see how many items already have someone assigned. That way you see at a glance how many tasks are still waiting for an owner. To hide the calculation, choose **None**.

## Frequently asked questions

**Can I assign a guest to an item?**\
Yes. An active guest who was invited to the account appears in the people list and can be assigned like any other member. They'll see only what their guest permissions allow.

**I assigned a team. Do all the team's members count as assigned?**\
The assignment is saved on the team itself, and everyone in it counts as assigned to the item for edit permissions and item visibility. When a new member joins the team, they get the same permissions on the team's items.

**How do I change someone from "Owner" to "Approver"?**\
Just remove them from one column and add them to the other. If you need to replace all the values in a column, you can use multi-select and bulk editing.

## See also

- Teams
- Notifications and notification preferences
- My work
- Board permissions and item visibility
- AI agents
