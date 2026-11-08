# Calendar sync (Google Calendar, CalDAV) — an extension with its own server

Two-way sync between one Bines board and calendars, per account: Google Calendar, or any CalDAV server (iCloud,
Fastmail, Nextcloud, Radicale, …). Built on a provider interface (`src/provider.ts`); the sync core (`src/sync.ts`)
picks each member's provider from their connection.

- **Each member** connects their own calendar in their profile → "My connections" (a `user_settings_page`): a
  Google account, or a CalDAV server address + user name + app password.
  On the same page each member picks which of their calendars syncs (their main one by default) and what of it
  comes into the board: only meetings made on the board (the default: nothing already in their calendar comes in),
  also meetings they make in the calendar from now on, or also the ones already there (some days back). The admin's
  "what members may let in" caps the choice. The page also shows when it last synced, with "sync now".
- **An account admin** sets everything else in Administration → Extensions → Calendar sync (an
  `account_settings_page`): the Google OAuth client, the board, the columns, what flows each way, and the status.
- Free; nothing in Bines core is specific to it. It uses only the generic extension hooks: `user_settings_page`,
  `POST /ext/introspect`, and webhooks its server creates on its granted boards.

## Running it

From the repository root:

```sh
pnpm install
PUBLIC_URL=http://127.0.0.1:3990 BINES_ORIGIN=http://localhost:5173 CALSYNC_ENCRYPTION_KEY=dev-only-key-123456 \
  pnpm --filter @bines/ext-calendar-sync dev
```

A development Bines accepts the `http://127.0.0.1` origin: install it from `http://127.0.0.1:3990/manifest.json`
(Administration → Extensions → For developers → By address). Without `DATABASE_URL` it keeps everything in memory.
Google push notifications need an https address; without one the periodic sync does the work.

Production: the Docker image (`Dockerfile`, built from the repository root) or the `calendar-sync` profile of
`docker-compose.prod.yml` — see `docs/SELF-HOSTING.md` → "Connecting Google Calendar".

### Environment

| Variable | Required | What |
|---|---|---|
| `PUBLIC_URL` | yes | the server's public origin (`https://calendar.example.com`): the manifest's origin and every URL below |
| `BINES_ORIGIN` | yes | the Bines it works with (only its `installed` calls are believed; the pages' `frame-ancestors`) |
| `CALSYNC_ENCRYPTION_KEY` | yes | encrypts stored secrets (AES-256-GCM; `openssl rand -base64 32`); also signs the OAuth state and channel tokens |
| `DATABASE_URL` | production | its own Postgres database (created when missing and the user may); tables are made on boot |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | the default OAuth client for every account; an admin may set the account's own in the settings page |
| `PORT` | no | default `3990` |
| `SYNC_INTERVAL_MINUTES` | no | how often each calendar is read when no push arrives (default 5) |
| `RECONCILE_MINUTES` | no | how often every board item is checked against the calendars (default 60) |

### Addresses

| Path | Who calls it |
|---|---|
| `GET /health` | the hosting check (200) |
| `GET /manifest.json` | Bines (install, daily update check) |
| `POST /lifecycle` | Bines lifecycle calls (signed) |
| `POST /bines/webhook` | the board webhooks the server creates (HMAC-signed; the handshake is echoed) |
| `POST /google/push` | Google push notifications (`events.watch`; channel token checked) |
| `GET /oauth/google/callback` | **the Redirect URI to register in Google**: `${PUBLIC_URL}/oauth/google/callback` |
| `/connect.html`, `/admin.html` | the member page and the admin page (framed by Bines) |
| `/api/…` | what the two pages call, with their page token (the server asks Bines who it is: `/ext/introspect`) |

### Google OAuth client

One client for everyone (or one per account). Scopes, with `access_type=offline` and `prompt=consent`:
`openid`, `email`, `https://www.googleapis.com/auth/calendar.events`,
`https://www.googleapis.com/auth/calendar.calendarlist.readonly`. The admin page shows the Redirect URI with a copy
button and the steps in Google Cloud. A client secret entered there is stored encrypted and shown only as a hint.

## Providers

The sync core speaks only `CalendarProvider` (`src/provider.ts`): list calendars, changes since a sync token,
instances of a series, insert / update / delete, and push when the provider has it. Each connection row names its
provider (`google` | `caldav`); the engine (`createEngine({ providers })`) looks it up per calendar, so one board can
sync members on Google and members on CalDAV at the same time. The calendar id `primary` is each account's own
calendar.

### Google (`src/google.ts`)

REST with `fetch`, OAuth (refresh token stored encrypted), `syncToken` changes, `events.watch` push.

### CalDAV (`src/caldav.ts`, `src/ical.ts`, `src/xml.ts`)

RFC 4791 with `fetch` and no dependencies (a small XML reader and iCalendar reader / writer of its own).

- **Connecting** (`POST /api/connect/caldav` with `url`, `username`, `password`): discovery runs first — the address
  (or its `/.well-known/caldav`) → `current-user-principal` → `calendar-home-set` → the calendars (PROPFIND,
  only collections with VEVENT). The member's own calendar is `schedule-default-calendar-URL`, else the first
  writable one. Only an account that answers is saved: home, own calendar, address and the credentials, as JSON
  encrypted in the connection row (like a Google refresh token). Errors come back as codes: `caldav_bad_url`,
  `caldav_credentials`, `caldav_auth`, `caldav_unreachable`, `caldav_not_caldav`, `caldav_no_calendars`,
  `caldav_http`. Use an app password (iCloud, Fastmail and Google require one for CalDAV).
- **Addresses:** https only and no private / loopback hosts — the server must not be turned into a probe of its own
  network; redirects are followed by hand under the same rule. A development server (`PUBLIC_URL` on http) also
  accepts http and local hosts (a Radicale on the same machine).
- **Changes:** the `sync-collection` REPORT (RFC 6578) where the calendar has it; else the calendar's `getctag`
  (nothing changed → nothing read) and every event's `getetag` compared with the last read. Changed events are read
  with `calendar-multiget`; a gone one is a cancelled event. An expired token = a full read (links keep it from
  importing twice).
- **Writes:** PUT with `If-None-Match: *` for a new event, and read-modify-write with `If-Match` for a change (what
  the sync does not manage — alarms, guests' answers, other apps' properties — is kept; `SEQUENCE` goes up), DELETE
  with `If-Match`. A 412 (someone wrote in between) is read again and retried once. Marks: `X-BINES-ITEM-ID`,
  `X-BINES-INSTALLATION`.
- **Mapping:** timed events are written in UTC, all-day ones as `VALUE=DATE` (end exclusive). Reading: UTC, `TZID`
  by IANA name or by the file's own `VTIMEZONE` rules (`X-LIC-LOCATION`, or the STANDARD / DAYLIGHT yearly rules),
  floating times as UTC; `DURATION`; attendees with `PARTSTAT` ↔ answers (rooms left out); an event organized by
  someone else is read-only (an invitation's copy). `sendUpdates`: `all` = the server's own scheduling (RFC 6638),
  `none` = `SCHEDULE-AGENT=CLIENT` on every guest, `externalOnly` = `CLIENT` for guests in the organizer's domain.
- **Recurring:** a master with RRULE / RDATE is a series; its instances come from `calendar-multiget` with
  `<expand>` (server-side). Changing one instance writes an override (`RECURRENCE-ID`) into the series' resource;
  deleting one adds an `EXDATE` (read back as a cancelled instance).
- **No push:** CalDAV calendars are read by the periodic job (`SYNC_INTERVAL_MINUTES`, default 5).
- **Not done:** Google Meet links (a Google feature); reminders are written as VALARMs (DISPLAY, and EMAIL when the
  account's address is known). A server that ignores `<expand>` gives no instances of a series (the series itself
  is not imported); a member's deletion with "nobody told" may still be announced by servers that schedule on their
  own.

## How the sync works

- **Board → Google.** When the admin saves the settings, the server creates webhooks on the board (`item_created`,
  `item_name_changed`, `column_changed`, `item_deleted`, `item_archived`, `item_restored`, `item_moved_to_board`).
  An item with a time goes to the calendar of each member in its people column who connected (personal), and / or to
  the shared calendar. An item with nobody in its people column goes (setting `no_people`, default `creator`) to the
  personal calendar of the member who created it (`created_by` of the item), when they connected; with an unknown
  creator it goes to no personal calendar and the log says so once; `skip` = no personal calendar. The item's id is stored in the event (`extendedProperties.private.binesItemId`), so nothing is
  written twice. Times come from the core calendar's own helpers (`readTimedSpan`, `timedCells`, `allDayCells` in
  `@bines/shared`): a timeline with hours, or a date with start / end hour columns, wall-clock in the account's zone.
- **Google → board.** Push notifications plus a periodic incremental read (`syncToken`). A changed event changes its
  item (name, the template's fields, the time); a new event becomes an item through the admin's template
  (`{{title}}`, `{{description}}`, `{{location}}`, `{{meet_link}}`, `{{organizer}}`, `{{attendees}}`,
  `{{calendar}}`), with its attendees in the people column by email.
- **Switches.** Each direction × create / update / delete is its own setting. Deleting on the board: delete the
  event, cancel it (guests are told), or only unlink. Deleted / cancelled in Google: the item to the trash (soft
  delete), archive, a status label, or only unlink. Default: everything on; a delete on one side deletes on the other (the item goes to the trash, restorable).
- **Invitations** (optional): the people column's members (by email) and an email column's guests become attendees;
  changing the people column adds / removes them; `sendUpdates` = all / external only / none. With invitations on,
  members get the invitation instead of a copy of their own.
- **Answers** (optional): the guests' answers set a status label (all accepted / any declined / maybe / waiting →
  the labels the admin picks), and each changed answer can be posted as an update on the item.
- **Meet and reminders** (optional): a Google Meet link on events made from the board (written back to the column
  whose template is `{{meet_link}}`), and default pop-up / email reminders.
- **Loop protection.** Every link keeps a fingerprint of what was last synced on each side; a change equal to it is
  the echo of our own write and is dropped. **Conflicts:** when both sides changed, the later change wins.
- **Recurring events** are imported only when the admin turns them on: the instances within N days (default 90),
  refreshed daily.

Every operation of one installation runs under a lock in the one server process (run one replica).

## Tests

`pnpm --filter @bines/ext-calendar-sync test` — the sync core with Google and the Bines API mocked (`test/fakes.ts`):
mapping both ways, templates, loop protection, each switch, delete behaviours, invitations and `sendUpdates`,
answers, Meet / reminders, recurring off / on, conflicts, items with nobody in them; the server: webhook signatures,
lifecycle, OAuth state, encryption, connecting CalDAV; and CalDAV against an in-memory CalDAV server
(`test/fake-caldav.ts`: PROPFIND, REPORT sync-collection / multiget with expand, GET, PUT, DELETE, etags):
discovery, first and incremental reads, the ctag / etag fallback, an expired token, series and excluded dates, push
of an item, change over the etag, delete, invitations, a refused password; plus the iCalendar reader / writer
(`test/ical.test.ts`: folding, escaping, TZID / VTIMEZONE, all-day, answers, overrides).

## Files

| Path | What |
|---|---|
| `src/main.ts` | boot: env, store, HTTP server, the periodic job |
| `src/app.ts` | the routes |
| `src/sync.ts` | the sync core (provider-independent) |
| `src/provider.ts` | the calendar provider interface |
| `src/google.ts` | Google Calendar over REST (`fetch`), Google OAuth |
| `src/caldav.ts` | CalDAV: discovery, sync-collection / ctag-etag changes, PUT / DELETE with etags |
| `src/ical.ts` | iCalendar reader / writer, times and zones, VEVENT ↔ event |
| `src/xml.ts` | a small namespace-aware XML reader (WebDAV multistatus) |
| `src/mapping.ts` | item ↔ event, templates, fingerprints, answers |
| `src/bines.ts` | the Bines REST calls (service user, `@bines/ext-sdk/server`) |
| `src/config.ts` | the admin's settings (zod) |
| `src/crypto.ts` | AES-256-GCM, signed state, channel tokens |
| `src/store.ts`, `src/store-pg.ts` | persistence (memory / Postgres with migrations on boot) |
| `public/` | the two pages (plain JS modules, RTL, Hebrew first; `sdk.js` = `@bines/ext-sdk` with types stripped) |
