# Sharing and permissions

Hebrew version: [sharing-and-permissions.he.md](sharing-and-permissions.he.md)

## What it's for

Decide who is in your account, which boards each person sees, and what they may change. Permissions work in layers,
from broad to narrow: the person's role in the account, the workspace, the board, and finally single columns and
items. Each layer can only narrow what the layer above allows. Account admins can always manage everything, and a
board's owners can always do everything on their board.

## Roles in the account

Every person has one role in the account:

| Role | In short |
|---|---|
| "Admin" | Manages the account: users, settings, security. Opens "Administration". |
| "Member" | Works on boards, creates boards and workspaces (by default). |
| "Viewer" | Sees the boards open to them, read only. Does not comment unless the account allows it. |
| "Guest" | Someone from outside the company (a client, a supplier). Sees only the shareable boards they were invited to. |

Guests never see workspaces, folders or boards that were not shared with them, the board's activity log, or the full
list of the account's people.

## Invite people to the account

Admins invite from "Administration":

1. Open your name at the top of the screen and choose "Administration".
2. Go to "Users" and press "Invite users".
3. Type one or more addresses in "Email addresses" (comma separated) and pick a "Role".
4. Choose "Email the invitation", or "No email — only a link to copy" if you prefer to send the link yourself
   (WhatsApp, SMS or any other way).
5. Press "Send invitations".

Open invitations are listed under "Pending invitations". From an invitation's menu you can send it again, copy its
link, or cancel it ("Cancel invitation"). An invitation link is personal and works once.

Tips:

- "Invitation settings" (on the same page) sets how many days a link stays valid (1–90), how long to wait before the
  same invitation is emailed again, and whether the inviter is told when it is accepted.
- People can also be invited from a board, a workspace, a doc or a dashboard. The same settings apply.

## Manage users

In "Administration" > "Users" you see everyone in the account with their role, teams, last activity and status. You
can search, filter by role, status or team, and export the list ("Export CSV"). From a person's menu:

- "Change role".
- "Edit" their job title, department and phone.
- "One-time sign-in link": a link to choose a new password, valid for an hour, for someone whose email does not
  arrive. Creating it is recorded in the audit log.
- "Reset two-factor authentication" for someone who lost their phone and backup codes.
- "Deactivate": they can no longer sign in to this account. You can first transfer what they own ("Transfer
  ownership…") to another person. "Default transfer user" sets who is offered first.
- "Delete details" (after deactivation): erases name, email, photo, phone and title. Their content stays, shown as
  "Deleted user". This cannot be undone.

## Teams

A team is a named group of people. You can assign a team in a people column, subscribe a team to a board, and give
a team access to restricted columns. A team counts as "mine" for each of its members.

1. Open "Administration" > "Teams".
2. Press "New team", type the "Team name" and create it.
3. Open the team and add its members.

## Workspaces: open or closed

A workspace has an "Access" setting on its "Workspace page":

- "Open workspace": everyone in the account sees the workspace; each board follows its own permissions.
- "Closed workspace": only the workspace's members and account admins see it.

To add people to a closed workspace, use "Workspace members" > "Add member". People already in the account join at
once; new people get an invitation.

## Board type

Each board has a "Board type":

- "Main": everyone in the account sees the board.
- "Private": only people invited to the board see it.
- "Shareable": people invited to the board, including guests from outside the company.

You choose the type when you create a board, and you can change it later in the board's "Permissions".

## Set a board's permissions

Only the board's owners and account admins change permissions.

1. Open the board, press "More actions" (the three dots in the board header) and choose "Permissions".
2. Under "What non-owners can do" pick one:
   - "Edit everything": items, groups, columns and views.
   - "Edit content only": items and cells, not the board's structure.
   - "Edit only items assigned to them": items they created or are assigned to (themselves or their team).
   - "View and comment": they see and comment, nothing more.
3. Under "Which items they see" choose "All items" or "Only what they created or are assigned to". With the second,
   pick "By which people columns" (or "Any people column").
4. Under "Owners and subscribers" add people ("Add subscriber") and give each a "Board role". An explicit role can
   only limit someone further than the board's setting, never widen it.
5. Under "Subscribed teams" press "Add a team". Every member of the team gets the subscription; a person's own
   subscription decides over their team's.

Owners and admins always see every item. If a board has no active owner, an admin can press "Take ownership".

### Invite someone straight to a board

In the board's "Permissions", use "Invite by email". Whoever is invited from there joins this board when they accept.
To invite a guest, the board must be "Shareable".

## Restrict a column

Hide a column, or lock it for editing, for everyone except chosen people.

1. In the board's "Permissions", find "Restricted columns" and press "Restriction".
2. Choose the column ("Which column to restrict?").
3. Choose "Restricted editing" (others see it but cannot change it) or "Restricted viewing" (others do not see the
   column at all).
4. Optionally add people and teams under "Allowed besides owners". Board owners and admins are always allowed.

A column hidden this way is also hidden from exports, and from formulas and mirrors that read it.

## Ask for a code before deleting

In the board's "Permissions", turn on "Delete with a verification code". From then on, deleting or archiving an item,
subitem or group asks for a code from an authenticator app. The board's automations still delete; AI, agents and MCP
cannot delete while this is on. Turning it off also takes a code.

## Work with guests (clients and suppliers)

There is no separate portal app: a guest signs in to the same Bines OS and sees only the boards shared with them.

1. Make the board "Shareable" (board "Permissions" > "Board type").
2. Invite the guest with "Invite by email" in the board's "Permissions", with the role "Guest".
3. Decide what the guest may do with "What non-owners can do", and limit them to their own items with "Which items
   they see" > "Only what they created or are assigned to" (assign the guest in a people column).
4. Hide internal columns with "Restricted viewing".

Account-wide guest settings, in "Administration":

- "Security" > "Guest domains": which email domains guests may be invited from. A guest always comes from a domain
  that is not one of the account's own domains.
- "General" > "Guests" > "Guests may change board structure": when off (the default), guests edit items only.

A guest who has no shared board yet sees "No board has been shared with you yet".

## See who viewed a board

When the account allows it, the board header shows who opened the board recently. On a phone, use "More actions" >
"Who viewed the board". Admins turn this on or off in "Administration" > "General" ("Show who viewed boards") and set
how many hours count as recent. When it is off, nothing is recorded.

## Sign-in options and two-factor authentication

People sign in with email and password, an emailed sign-in link ("Email me a sign-in link"), or "Continue with
Google" / "Continue with Microsoft" when the platform has these set up.

### Turn on two-factor authentication for yourself

1. Open your name > "My profile" > "Sign-in & security".
2. Press "Turn on two-factor authentication" and confirm with your current password.
3. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others),
   then type the 6-digit code and press "Confirm and turn on".
4. Save the backup codes shown. Each works once, for when your phone is not at hand.

### Require it for everyone (admins)

In "Administration" > "Security" > "Two-factor authentication", choose who must use it and a "Grace period". People
who have not set it up are asked to at their next sign-in once the grace period ends.

### Other security settings (admins)

All in "Administration" > "Security":

- "Active sessions": see who is signed in, on which device, and sign out one person or everyone.
- "Allowed domains": the account's own email domains. "Members only from these domains" limits invitations of
  admins, members and viewers to those domains.
- "Auto-join": people who sign up with an address at a verified domain join the account without an invitation, in
  the role you choose. Verify each domain with "Verify" (at once if your own verified email is at that domain, or
  with a DNS TXT record). Free mailbox domains never qualify. This works only when the platform allows self sign-up.
- "Sign in through Google or Microsoft": require provider sign-in, optionally only for certain domains; admins can be
  exempt as a way back in.
- "Passwords": the minimum length of a new password.
- "IP allowlist": the account opens only from listed addresses (off by default). Your own address must be on the list.
- "Support access": let the platform's support into the account for a limited time, view only unless you allow edit.
  Every entry is logged and you can revoke it at any moment.

## Related

- [Getting started](getting-started.md)
- [Boards, groups and items](boards-groups-items.md)
- [Columns](columns.md)
- [Account administration](account-admin.md)
- [MCP and API](mcp-and-api.md)
- [Notifications and inbox](notifications-and-inbox.md)
