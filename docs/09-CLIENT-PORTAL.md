# 09 — Guests and the client portal

How outside people — clients, contractors, partners — work with an account as **guests**: what they see, what they
can do, how they are invited, and the isolation guarantees that are tested. For developers and for admins setting up
client-facing boards.

The "portal" is **not a separate app**: it is the same web app and the same shell (`AppShell`), showing a guest only
what the board and item permissions allow ([`05-PERMISSIONS.md`](05-PERMISSIONS.md)). Everything a guest sees is real
data from the account's boards — no sync, no copies.

## 1. The model: guests are board-scoped (D23)

- A guest is invited to one or more **shareable** boards. What they see and do there is decided by that board's
  permissions — there is no separate "client" entity attached to a guest (D23 in [`DECISIONS.md`](DECISIONS.md)).
- To let several clients share one board while each sees only their own items, set the board's item visibility to
  "only items they created or are assigned to" (`view_items`, [`05-PERMISSIONS.md`](05-PERMISSIONS.md)) with an
  assignment column. Otherwise, use one shareable board per client.
- Columns a guest must not see or edit are restricted per column (`restricted_view` / `restricted_edit`).
- Guests change a board's structure (columns, groups) only if the account permission `guests_edit_structure` is on;
  by default they edit items only.

## 2. Invitation and sign-in

1. An admin (or a member allowed by `invite_guests`) invites by email from the board's members dialog or
   Administration → Users: `POST /users/invite {email, role: 'guest', board_ids}` — shareable boards only, attached
   when the invitation is accepted. The guest's email domain must differ from the account's domains, and the
   account's `guest_domain_policy` applies ([`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md) §3.1, §5).
2. The guest signs in with a magic link or a password. A guest is not a workspace member.

## 3. What the guest sees

The same shell with a sidebar limited to the boards shared with them, and a guest home
(`apps/web/src/features/shell/GuestHome.tsx`) instead of the regular home. A guest with nothing shared yet sees who
to ask, not an empty account.

## 4. The item card for a guest

The same card as members, reduced to what the board allows — editable fields per the board's permissions,
**Updates** as a conversation thread, files. Board activity is **not** shown to guests.

## 5. Notifications

Guests get bell and email notifications on assignment, mentions and updates on their items, per the same categories
and settings as members ([`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md) §12.3).

## 6. Public forms (no sign-in)

A form is a board view (`/f/:token`): access `public` or `members`, optional CAPTCHA (Cloudflare Turnstile, account
setting), questions mapped to columns (required, help text, hidden fields filled from the URL, conditional
questions), file uploads with limits, target group, closing date and submission cap, success message or redirect,
privacy notice, logo and cover, optional embedding. A submitted item is created by `form:<id>`, and its creation log
shows "Form". Endpoints: `GET/PATCH /views/{id}/form`, `POST /views/{id}/form/token`, and the public
`GET /public/forms/{token}`, `POST /public/forms/{token}/submit`, `POST /public/forms/{token}/uploads`.

## 7. Email to a board or item

When the platform owner has configured an inbound email domain, each board and each item has its own address
(board menu → "Email to board"; item card ⋯ → "Email to item"). An email to a board creates an item; an email to an
item becomes an update. Who may send is an account setting ([`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md) §15).

## 8. What a guest never sees or does

Workspaces and folders of boards not shared with them, boards they are not subscribed to, the board activity log,
the list of all users (only people on their items), board settings, automations, API tokens, and data outside what
the board shows them (exports contain only what the guest sees).

## 9. Branding

Guests see the account's portal name (`branding.portal_name`) and logo ([`08-ACCOUNT-ADMIN.md`](08-ACCOUNT-ADMIN.md)
§2).

## 10. Isolation tests (required before production)

`apps/api/test/guest-isolation.test.ts` — two guests on one shareable board with "only what they created or are
assigned to":

1. Each guest lists only their own items; the owner sees everything.
2. Another guest's item is **404** (not 403, so as not to reveal it exists) — get, updates, cells.
3. Search, query, count and column values stay inside their items.
4. A column restricted for editing is 403 for the guest.
5. A relation to an internal item shows empty to the guest.
6. SSE: events about another guest's items never reach them.
7. An export holds only what the guest sees.
