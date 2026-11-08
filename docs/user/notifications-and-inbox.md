# Notifications, inbox and My work

Hebrew version: [notifications-and-inbox.he.md](notifications-and-inbox.he.md)

## What it's for

Bines OS tells you what needs your attention, in a few places:

- The bell ("Notifications") — when you are assigned, mentioned, or someone replies to you, plus automation messages
  and approvals.
- "Inbox" — the updates written on items you follow, where you can read and reply in one place.
- "My work" — every item assigned to you, across all boards, sorted by date.
- Email and phone — the same notifications, as you choose.

You can also send email into Bines OS: mail to an item becomes an update, and mail to a board opens a new item.

## The bell

1. Click the bell in the top bar. The number shows how many are unread.
2. Notifications are grouped into "Today", "Yesterday" and "Earlier". Use "All" or "Unread" to filter.
3. Click a notification to open the item.
4. Click "Mark all as read" to clear the count.
5. The gear button opens "Notification settings".

You get a notification, for example, when someone mentions you, assigns you to an item, replies to your update, or
writes an update on an item you follow; when an automation notifies you; when a doc or dashboard is shared with you;
when a timer has been running for over 12 hours; and when an AI agent asks for approval (you can approve or reject
right in the bell).

## Follow an item

You follow an item automatically when you create it, are assigned to it, write an update on it or are mentioned in
it. Following means new updates on it reach you.

- To follow an item by hand, open the item and click "Follow". It changes to "Following".
- To stop, click it again. Bines OS remembers that you unfollowed.

## Inbox

1. Click "Inbox" in the side menu (on a phone, in the bottom bar).
2. You see new updates and replies on items you follow. Choose "All" or "Mentions only".
3. Click "Reply" under an update, write in "Write a reply…" and send.
4. Click "Mark as read" on one update, or "Mark all as read". "Show read" brings back what you already read.

## My work

"My work" lists every item assigned to you on all the boards you can see.

1. Click "My work" in the side menu.
2. Items are grouped by date: "Overdue", "Today", "This week", "Next week", "Later" and "No date". Under "Group" you
   can switch to "By board".
3. Tick "Hide done items" to hide finished items, and "Include subitems" to add subitems assigned to you.
4. Click "Customize" to choose, for each board, whether it appears and which "Date column", "Status column" and "People
   column" count. "Any people column" means you appear in any of them.

When there are more than 1,000 items or 50 boards, the most recently updated are shown.

## Choose how you are notified

1. Open your avatar menu and choose "Notification settings" (or click the gear in the bell).
2. Under "My notifications", each kind has a switch for "Bell", "Email" and "Phone":
   - "I was assigned to an item"
   - "Someone mentioned me"
   - "Updates and replies on items I follow"
   - "Reminders (forgotten timer)"
3. Under "How to get emails", choose "One email per notification", "Daily summary" or "Weekly summary", and the day
   and hour for summaries.
4. "Muted boards" lists the boards you muted; click "Unmute" to hear from one again.

These settings apply to the current account. Admins set the "Account defaults" in Administration > Notifications —
what members get until they choose for themselves. A personal choice always wins.

## Phone notifications

On a phone with the app installed, Bines OS asks "Get notifications on this phone?". Choose "Yes" to get push
notifications on that device (only what matters: when you are assigned or mentioned). The browser must allow
notifications. You can change which kinds go to your phone in the "Phone" column of "Notification settings".

## Control notifications from one board

1. Open the board and click "Notifications" in its header.
2. Choose:
   - "Get notifications from this board" — the default.
   - "Custom — choose what comes from this board" — narrows what you get from this board. What you turned off in your
     own settings stays off.
   - "Mute this board for me".
   - "Mute this board for everyone" — board owners and admins only.

## Email to an item

Every item can have its own email address. Mail sent to it becomes an update on the item, attachments included. Put
the address in Cc, or forward mail to it.

1. Open the item and open its ⋯ menu.
2. Choose "Email to this item".
3. Click "Create address", then "Copy".
4. To replace the address, click "New address" — the old one stops working at once and for good. To stop receiving
   mail, click "Remove address".

## Email to a board

Mail sent to a board's address opens a new item: the subject becomes its name, and the text and files become its
first update.

1. Open the board and open its ⋯ menu.
2. Choose "Email to this board".
3. Click "Create address", then "Copy". "New address" and "Remove address" work as for items.

## What incoming mail looks like

- The update says who sent it ("by email from …"). Mail from someone who is not in the account is marked "outside the
  account".
- Long messages are cut. "Show all" and "Show less" open and close the full text. When a message is too long, the full
  message is attached as `message.eml`.
- Attachments are added as files. Files that were not attached are listed with the reason, for example "too big",
  "file type not supported" or "small image, such as a signature's".
- Images in the message body can be kept as files and shown in place, depending on the account settings.

## Turn on incoming email (admins)

Incoming email must be set up on the platform first (a mail domain set by the platform operator). Then:

1. Go to Administration > Connections > "Incoming email".
2. Switch on "Receive email to items and boards".
3. Under "Who may send", choose "Anyone" (clients and suppliers too), "Account members" (from their verified address
   only) or "Some domains" (members, and senders from the "Allowed domains").
4. Optional: "Keep images from the message body" and the "Smallest image kept" (to skip signature logos), and "Show
   images the message loads from the web" (shown through the app, so the sender does not learn who read it).

If an item's menu says "Incoming email is off in this account", ask an admin to turn it on.

## Replies by email

An AI agent, or an AI assistant connected to Bines OS, can answer the person who emailed an item, by email, from that
item. The answer goes only to the address the message came from, and is kept as an update marked "sent by email to
…". See [AI](ai.md) and [MCP and API](mcp-and-api.md).

## Related

- [Item card and collaboration](item-card-and-collaboration.md)
- [Automations](automations.md)
- [Getting started](getting-started.md)
- [Time tracking](time-tracking.md)
- [AI](ai.md)
- [Account administration](account-admin.md)
- [Sharing and permissions](sharing-and-permissions.md)
