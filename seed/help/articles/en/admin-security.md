---
title: "Account security"
slug: admin-security
locale: en
translation_of: admin-security
category: "account-administration"
tags: ["admin", "security"]
visibility: signed_in
excerpt: "How account admins see who's signed in, restrict domains, require two-factor authentication, restrict IP addresses and give support temporary access."
publish: true
---
The **Security** area of the admin center brings together all the tools that help keep the account safe: the list of active sessions with the option to sign them out, restricting the domains people join from, the guest policy, requiring two-factor authentication, restricting IP addresses, and full control over the support team's access. Every change here is recorded in the audit log.

## What you'll learn

- How to see who's signed in to the account and sign sessions out
- How to restrict the account to certain domains and decide where guests come from
- How to require two-factor authentication
- How to restrict access to certain IP addresses
- How to give support temporary access and revoke it

> **Note:** The security area is open to account admins only: your profile picture → **Administration** → **Security**.

## Active sessions

The **Active sessions** card shows all the sessions of the account's people: **User**, **Device / browser**, **IP address**, when they **Signed in** and **Last active**. Your own session is marked **This device**.

- **Sign out**: signs out one session. The person will need to sign in again.
- **Sign out everyone**: signs out everyone who's signed in, except you.

> **Note:** A session belongs to a person, not to an account. Signing it out signs them out of all their accounts on that device, which is why a person who's also a member of other accounts is marked **Other accounts too**. An admin's session in another account can only be signed out from that admin's own account.

## Allowed domains and joining

In the **Allowed domains** card, add your organization's domains (for example company.co.il).

- **Members only from these domains**: an invitation for an admin, member or viewer is accepted only for an email from one of the domains.
- **Auto-join**: anyone who signs in with an email from these domains joins without an invitation, with the **Role on joining** you chose.

> **Note:** The auto-join setting is saved now, but it only takes effect once self sign-up opens. Until then, joining is by invitation only.

### Guest domains

A guest always comes from a domain that isn't the account's. In the **Guest domains** card, choose:

| Mode | Meaning |
| --- | --- |
| **Any domain** | Any email that isn't from the account's domains. |
| **Only from a list** | Guests only from the domains in the list. |
| **All but a list** | Any domain, except the ones in the list. |

## Two-factor authentication

In the **Two-factor authentication** card you decide who must sign in with a code from an authenticator app:

- **Optional**: everyone decides for themselves in their profile.
- **Required for admins**: account admins must; for everyone else it's optional.
- **Required for everyone**: everyone in the account, guests included.

When you choose one of the required options, you can also choose a **Grace period**: none or a number of days. People who haven't turned it on yet get a reminder, and at the end of the period they can't get into the account without turning it on.

![The two-factor authentication card with the three policy options](images/admin-security-1.webp)

> **Tip:** A user lost their phone and their backup codes? In the **Users** area, in their menu, choose **Reset two-factor authentication**.

## IP allowlist

When the restriction is on, the account opens only from the addresses or ranges in the list, for example only from the office.

1. The **IP allowlist** card shows **Your address now**. Click **Add to the list** to add it.
2. Add more addresses or ranges and click **Add**.
3. Switch on **Turn on the allowlist** and confirm.

> **Note:** From any other address, nobody gets into the account, apps and tokens included. You can't save a list that doesn't include your own address, so you don't lock yourself out.

## Support access

Sometimes the support team needs to get into the account to look into a problem. In the **Support access** card you decide whether, who, for how long and at what level.

1. Click **Allow access**.
2. Choose **Who**: **Platform support** or **A support person by email**.
3. Choose the **Access** type: **View only** (support sees everything as an admin would but can't change anything) or **View and edit** (acts as an admin, but doesn't manage users, security, tokens or support access).
4. Choose a **Duration**, and write a **Reason**, for example the ticket number. The reason is saved in the log.
5. Click **Allow access**.

![The support access window with the access type, duration and reason](images/admin-security-2.webp)

Every sign-in and every action by support is recorded in the audit log, and you can stop the access at any moment with **Revoke**. In the same card you can also set the **Longest access**, and turn off **Allow edit access** so that only view access is ever given.

## More in the security area

- **Support tickets**: who in the account can open tickets with the support team (**Every member** or **Admins only**), and what members see: **Their own tickets** or **All of the account's tickets**.
- **Secrets log**: who revealed, copied or changed a value in a secret column, and when. The values themselves aren't saved in the log.

## Frequently asked questions

**I turned on the IP allowlist and an employee working from home can't get in. What do I do?**\
Add their address to the list, or turn off the restriction temporarily.

**Can support get into the account without approval?**\
No. Access is given only by an admin, for a limited time, and it's recorded in the log.

## See also

- Password and two-factor authentication
- Managing users and invitations
- Tidy up and the audit log
- Working with guests
- Contacting support
