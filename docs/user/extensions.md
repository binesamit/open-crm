# Extensions

Hebrew version: [extensions.he.md](extensions.he.md)

## What it's for

Extensions add things to Bines OS without changing the product itself: a new board view, a tab in the item card, a dashboard widget, a page in the sidebar, an automation trigger or action, or a ready set of boards and automations. Each extension asks for permissions on a consent screen before it installs, and an admin can switch it off or remove it at any time.

There are two kinds:

- "Data pack": boards, templates, automations or agent templates. It runs no code.
- "Extension with code": shows its own screen from an outside site, fully isolated, with only the permissions you approved.

Installing extensions is done by account admins, in "Administration" > "Extensions". It may not be included in every plan. Want to build one? See the [extensions developer guide](../EXTENSIONS-GUIDE.md).

## Install an extension from the store

1. Open "Administration" > "Extensions". The "Store" tab lists the extensions the platform offers.
2. Open an extension to see what it adds, then click "Install".
3. Review the consent screen (next section) and click "Approve and install".

If the store is empty, the platform owner has not published extensions yet. You can still install a private extension under "For developers".

## The consent screen

Before anything installs, "Install {name}" shows:

- "What it adds": for example "Board view: …", "Item card tab: …", "Dashboard widget: …", "A page in the sidebar for every member: …", "A page in each member's profile: …", "Automation action: …", or a workspace with folders and boards. Automations from a pack load switched off until you switch them on.
- "Loaded from": the sites the extension's screens come from.
- Warnings, for example that it shows its own screen from an outside site, that it also asks to write ("Every change it makes is logged 'via the extension' and can be undone"), or that it has its own server.
- "Permissions": what it may do, such as "Read boards and items", "Create and change items" or "Write updates". You can switch a permission off (the extension may then not work fully); you can never give more than it asked for.
- "Where it works": "The whole account" or "Workspaces and boards I choose". A workspace also covers boards added to it later.
- "Available to guests": off means guests do not see the extension at all; on means they see in it only what they may see anyway.

Click "Approve and install" to finish.

## Install a private extension

1. In "Administration" > "Extensions", open the "For developers" tab.
2. Choose "By address" and paste the manifest address, or "Paste a manifest" and paste its content (a file made with "Save as a pack" works too).
3. Click "Check", then go through the consent screen.

An extension on a local address (localhost) works in development only.

## Use an installed extension

Depending on what it adds, you find it in different places:

- Board view: add it like any other view on a board. If the extension asks to use more boards, you tick which ones under "Boards this view uses".
- Item card tab: a new tab in the item card.
- Board menu action or "Action on selected items": in the board menu, or in the bar that appears when you select items.
- Dashboard widget: in the list of widgets when you add one to a dashboard.
- Automation trigger or action: in the automation builder, under "From extensions".
- Page in the sidebar: a full page for every member, with a count of unread things next to its name. You can move it to the top bar or hide it like any other place in the navigation.
- Page in the profile: under "My profile" > "Profile", in "My connections", for personal setup such as connecting your own account in another service.
- Settings page: "Extension settings" in "Administration" > "Extensions", for admins.
- Panel: some extensions offer a panel for a browser side panel. Admins copy the "Panel address" and paste it into the browser extension's settings (Chrome / Edge).

An extension never sees more than the person using it. Everything it does is logged and can be undone.

## Manage installed extensions

In "Administration" > "Extensions" > "Installed":

- Switch an extension "On" or off.
- See its "Permissions:" and click "Revoke this permission" to take one away.
- Click "Change" to choose again where it works.
- Click "Uninstall" to remove it.

### Updates and versions

- With "Automatic updates", a new version that asks for nothing new installs by itself.
- A version that asks for more permissions waits in the "Updates" tab ("Version … awaits approval — it asks for more: …"). Click "Review and approve" and then "Approve the update".
- Click "Check for update" to check now.
- "Versions" lists every version that ran in the account. "Back to this version" returns to it and locks the extension there until you unlock it. You can also choose "Lock on version …".

If you see "Switched off by the platform owner", the extension was disabled for every account on the platform and cannot be used until it is switched back on.

## Save your boards as a pack

In "Administration" > "Extensions", "Save as a pack" saves boards (as templates, without items) and, if you tick "Include the boards' automations (they load switched off)", their automations in one file. Click "Download the pack", then install it in another account through "Add an extension".

## Related

- [AI](ai.md)
- [MCP and API](mcp-and-api.md)
- [Views](views.md)
- [Dashboards](dashboards.md)
- [Automations](automations.md)
- [Sharing and permissions](sharing-and-permissions.md)
- [Account administration](account-admin.md)
