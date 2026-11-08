# Account administration

Hebrew version: [account-admin.he.md](account-admin.he.md)

## What it's for

"Administration" is where account admins set up the account for everyone: its name and logo, regional defaults,
users and teams, security, connections, AI, usage, the plan, cleaning up and the audit log. This guide also covers
the settings every person has in their own profile, and the help that is built into the app: the "First steps" list,
guided tours, the help center and support tickets.

Installing and running your own server is covered separately in the
[installation and licensing guide](../GUIDE.md).

## Open Administration

1. Click your name at the top of the screen.
2. Choose "Administration".

Only account admins see it. The sections are listed on the side (a row of chips on a phone):

| Section | What you do there |
|---|---|
| "General" | Account name and logo, dates and currency, defaults for new boards, announcements, guests, calendar and more. |
| "Notifications" | What members get in the bell and by email until they choose for themselves. |
| "Look and navigation" | What shows in the sidebar and what in the top bar, for everyone in the account. |
| "Users", "Teams", "Templates" | The account's people, teams and saved board templates. |
| "Security" | Sessions, domains, two-factor, sign-in rules, IP allowlist, support access. |
| "Connections" | API tokens, webhooks, map settings and more. |
| "Flows", "Extensions", "AI & MCP" | Visual flows, installed extensions, AI connections and MCP. |
| "Usage", "My plan", "Health", "Tidy up", "Audit log" | Consumption, the plan, errors, cleaning and the record of who did what. |

People, teams and security are explained in [Sharing and permissions](sharing-and-permissions.md).

## Account profile and branding

In "General" > "Account profile":

1. "Upload logo" (a square image). It shows in the sidebar and the account switcher, and is used as the icon of the
   phone app.
2. Change the "Account name".
3. Press "Save".

Also in "General":

- "Interactive document look": the default look of quotes and agreement pages. A template or a document can set its
  own.
- "Icon style" and "Clicking an email address": the default for members who did not choose their own in their
  profile.
- "The phone app" and "Phone notifications": how the app looks on a phone's home screen, and push notifications.

Your own colour theme, sidebar tone, text size and density are personal: open your name > "Appearance", or your
profile.

## Dates, times and currency

In "General" > "Dates, times and currency" set the account's "Time zone", "Weekend", "First day of the week", "Date
format", "Time format", "Country" (for phone numbers typed without a country code) and "Currency" (offered when a
numbers column shows money). Each person can still change language and time zone in their profile.

Hebrew dates, holidays and working days are in "Calendar & working days"; see
[Calendar and Google sync](calendar-and-google-sync.md).

## Defaults for new boards

"General" > "Defaults for new boards" applies to what is created from now on (existing boards and templates do not
change):

- "Item terminology": what an item is called on a new board (for example lead, task, client).
- "Status labels": the labels and colours a new status column starts with. Press "Edit labels"; mark the "done" label.
- "Group colours": the order in which new groups get a colour.
- "Thousands separator in new number columns".

## Post an announcement to everyone

1. In "General" > "System announcement", type the "Message".
2. Optionally add a "Link (optional)" (shown as "Details") and an end date in "Until (optional)".
3. Press "Publish".

A bar appears at the top of the app for everyone in the account until each person closes it or the end date passes.
Use "Remove" to take it down.

## Board templates

"Administration" > "Templates" lists the account's saved board templates. You save a board as a template from the
board's menu ("Save as template"). From the list you can duplicate, edit or delete a template.

## Usage, health and cleaning up

- "Usage": what the account used in a period — automation runs and failures, webhooks, tokens, storage and active
  people.
- "Health": what failed in the account, how often, and where to fix it.
- "Tidy up": every board of the account in one table — owner, last update, items, and whether it is empty, abandoned
  or ownerless — with archive, delete and ownership transfer. Private boards show only their details, not content.
  "Scheduled cleaning" holds rules that run every night; rules that touch content are off until you turn them on, and
  "Check" shows what would happen without changing anything.
- "Audit log": who did what and when — invitations, roles, deactivations, tokens, sign-outs and settings.

## My plan

When the platform you use sells plans, "My plan" shows what the plan includes, how much of each limit is used, and
the history. At a limit only the next action is blocked; no data is ever deleted or hidden. Depending on how the
platform is set up you can "Upgrade" (pay on a secure checkout page) or "Request an upgrade", and "Cancel
subscription" (you see the refund and the end date before you confirm). An account without a plan shows "The account
has no plan — no limits."

## Export all data or delete the account

In "General" > "Your data":

- "Export all data": one ZIP file with every board as an Excel file (items, subitems and updates), every doc, every
  file by board and item, and the list of users. It is prepared in the background and you get an email when it is
  ready.
- "Delete the account": three steps — keep a copy, type the account name, and enter a two-factor code (two-factor must
  be on for you). The account is locked at once and deleted for good after a waiting period; any admin can cancel
  until then.

## Your own profile

Click your name > "My profile". The tabs:

- "Profile": name, photo, job title, phone, "Language" and "Time zone", appearance, phone-number preferences and
  "Guided tours".
- "Notifications": what reaches you in the bell and by email.
- "Sign-in & security": password, two-factor authentication, and your personal data:
  - "My data": download everything held about you as one JSON file.
  - "Delete my details": ask for your personal details to be deleted. The admins of every account you belong to get
    the request; what you wrote stays under "Deleted user".

Extensions that add a personal page (for example a calendar connection) show it in your profile under "My
connections".

## Terms and policies

The "?" menu has "Terms & policies" and the "Accessibility statement". When the terms are updated, you are asked to
read and accept the new version ("Accept and continue") before you continue.

## First steps and guided tours

- "First steps": a checklist for new people in the account, with "Show me" next to each step. Open it any time from
  the "?" menu. Admins turn it on or off in "General" ("First steps" for the account's people).
- Guided tours: short tours that explain each screen. The first time you open a screen you may be offered "A short
  tour"; choose "Let's start" or "Not now". From the "?" menu run "Tour of this screen" or open "All tours" to run any
  tour again. To stop the offers, turn off "Offer me a short tour the first time I open a screen" in your profile.
  Admins turn tours on or off for the whole account in "General" > "Guided tours".

## Help center and support tickets

Open the "?" ("Help") menu:

- "Knowledge center" opens the help center: search help articles and read guides. "Quick search" finds an article
  without leaving the screen. When the account turns it on, an AI assistant answers questions from the help articles
  (admins choose its AI connection in "Help center assistant").
- "Open a ticket": send a ticket to the support team with a "Subject", "Description", "Category", "Priority" and files.
  Details that help support (the page, browser, the last error) are attached automatically; you can remove any of them
  before sending.
- "My tickets": your tickets and where they stand, open and closed.

Admins decide in "Administration" > "Security" > "Support tickets" who opens tickets ("Every member" or "Admins
only") and whether members see only their own tickets or all of the account's.

## Related

- [Getting started](getting-started.md)
- [Sharing and permissions](sharing-and-permissions.md)
- [Notifications and inbox](notifications-and-inbox.md)
- [Calendar and Google sync](calendar-and-google-sync.md)
- [AI](ai.md)
- [MCP and API](mcp-and-api.md)
- [Extensions](extensions.md)
- [Import and export](import-export.md)
