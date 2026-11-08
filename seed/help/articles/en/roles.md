---
title: "Account roles: admin, member, viewer and guest"
slug: roles
locale: en
translation_of: roles
category: "permissions-and-sharing"
tags: ["permissions", "users", "guests", "admin"]
visibility: public
excerpt: "What each account role is allowed to do (admin, member, viewer and guest) and how the role fits together with workspace and board permissions."
publish: true
---
Everyone in the account has one role, and it sets their general boundaries: what they see, what they can create and what they can manage. The role is the widest layer in the system's permission model; on top of it come the workspace and board settings, which can only narrow, never widen, what the role allows. Understanding the four roles will help you invite each person with the role that fits them.

## What you'll learn

- What characterizes each of the four roles
- What each role can do, in a comparison table
- How the role fits together with workspace and board permissions
- How to change a user's role

## The four roles

### Admin

Account admins are responsible for the whole account. They see **Administration** in the avatar menu, and from there they manage users, teams, templates, connections, security, usage and the plan. An admin can invite people with any role, change roles, deactivate users and take ownership of a board that has no active owners.

### Member

The regular role for the organization's employees. A member creates workspaces, folders and boards, edits items according to board permissions, writes updates, builds automations and uses flows and agents. A member who creates a board becomes its owner and manages its permissions.

### Viewer

Suits people who need to see the information without changing it: management, consultants, auditors. A viewer sees what's visible to them, but doesn't create or edit. Even when added to a board, they always get view-only permission on it, regardless of the board's settings.

### Guest

A person outside the organization: a client, a supplier, a freelancer. A guest sees only **Shareable** boards they were invited to, and inside them acts according to the permissions the board gives them. They don't see the other workspaces and boards, the full user list or the activity log.

## Comparison table

| Capability | Admin | Member | Viewer | Guest |
| --- | --- | --- | --- | --- |
| Sees open workspaces and main boards | ✔ | ✔ | ✔ (read) | ✘ |
| Sees private boards | Manages the settings; the items, when subscribed | Only when invited | Only when invited (read) | ✘ |
| Sees shareable boards | Manages the settings; the items, when subscribed | Only when invited | Only when invited (read) | Only when invited |
| Creates workspaces, folders and boards | ✔ | ✔ | ✘ | ✘ |
| Edits items | ✔ | According to board permissions | ✘ | According to board permissions |
| Writes updates and replies | ✔ | ✔ | ✘ | ✔ on their boards |
| Uploads files | ✔ | ✔ | ✘ | ✔ on their boards |
| Can be assigned in a people column | ✔ | ✔ | ✔ | ✔ |
| Builds automations | ✔ | ✔ | ✘ | ✘ |
| Invites people | Any role | Viewers and guests\* | ✘ | ✘ |
| Creates personal API tokens | ✔ | ✔ | ✘ | ✘ |
| Administration | ✔ | ✘ | ✘ | ✘ |
| Takes a seat in the plan | ✔ | ✔ | ✘ | ✘ |

\* Depending on the account settings.

> **Tip:** Viewers and guests don't count toward the plan's user quota. It's a cost-effective way to give access to people who only need to look, or to share a dedicated board with clients.

## How the role fits with the workspace and the board

Permissions in the system are built in layers, from wide to narrow:

1. **Account role**: the upper limit.
2. **Workspace**: a closed workspace is visible only to its members and the account admins.
3. **Board**: the board type (main, private, shareable), its subscribers, and the setting "what people who aren't board owners can do".
4. **Columns and items**: restricted columns, and limiting people to items they created or are assigned to.

The rule is simple: **the stricter setting wins**. If your role is viewer, no board setting will let you edit. And the other way around: board owners can be stricter for certain users, but can't give them more than their role allows.

> **Note:** Board owners and account admins bypass the restrictions inside the board: they see all of its items and columns and can change the permissions. On a private or shareable board, the account admin manages the settings even without being a subscriber, but to see the items themselves they need to join as a subscriber.

## Changing a user's role (for account admins)

1. Open the avatar menu and choose **Administration**.
2. Go to **Users**.
3. In the user's row, open the actions menu and choose **Change role**.
4. Choose the new role.

![The Users screen in Administration with the change role menu open](images/roles-1.webp)

You can also select several users in the list and change the role for all of them at once. You can't change your own role, so there's always at least one admin left in the account.

## Frequently asked questions

**How do I know what my role is?**\
Your role appears below the account name at the top of the sidebar, and also on the account selection screen.

**I turned a member into a viewer. What happens to their boards?**\
The boards stay where they are, but they can no longer edit them. It's a good idea to transfer ownership first; the Users screen has **Transfer ownership…** for that.

**A guest needs to see a main board. What do I do?**\
Guests see only shareable boards. Change the board type to **Shareable** in its permissions window, or create a dedicated shareable board for working with the client.

## See also

- Board permissions and item visibility
- Working with guests
- Inviting people to the account
- Managing users and invitations
- Workspaces and folders
