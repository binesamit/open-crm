# Installation and licensing guide

For people who install and run the platform on their own server. It covers what the license allows, installing,
the optional registration with a provider, license keys, privacy and the usual questions.

Hebrew version: [GUIDE.he.md](GUIDE.he.md). Technical reference: [SELF-HOSTING.md](SELF-HOSTING.md) (installing and
operating) and [LICENSING.md](LICENSING.md) (how keys and registration work inside).

**Contents:** [What the license allows](#1-what-the-license-allows) ·
[Requirements](#2-requirements) · [Install in 1 minute](#3-install-in-1-minute) ·
[The first admin](#4-the-first-admin) · [Registration](#5-the-registration-questionnaire-optional) ·
[Editions](#6-editions) · [Activating a key](#7-activating-a-license-key) · [The license card](#8-the-license-card) ·
[Renewal and expiry](#9-renewal-and-expiry) · [Upgrades](#10-upgrading-to-a-new-version) ·
[Privacy and telemetry](#11-privacy-and-telemetry) · [Backups, email, storage, proxy](#12-backups-email-file-storage-proxy) ·
[Troubleshooting](#13-troubleshooting) · [FAQ](#14-faq) · [Support](#15-support)

## 1. What the license allows

The platform is **open source** under the GNU AGPL-3.0. Full terms: [`LICENSE.md`](../LICENSE.md), the additional
permissions in [`LICENSE-EXCEPTIONS.md`](../LICENSE-EXCEPTIONS.md), the trademark policy in
[`TRADEMARKS.md`](../TRADEMARKS.md), and the `LICENSE` file of each SDK package (MIT).

**In plain words**

| Question                                                                      | Answer                                                                                                                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can I install it and use it for free, for myself or inside my business?       | Yes.                                                                                                                                               |
| Can I use it for work I do for my clients (e.g. manage their projects in it)? | Yes.                                                                                                                                               |
| Can I change the code?                                                        | Yes.                                                                                                                                               |
| Can I share it, changed or not?                                               | Yes, under the same license: whoever receives it gets the source too.                                                                              |
| Can I host it and sell access to others (as a service)?                       | Yes. If you changed the code, the people who use your service must be able to get the source of your version (AGPL section 13). Unchanged: nothing to do. |
| Can I build it into a product I sell ("white label")?                         | Yes, under the AGPL and with your own name and logo ([`TRADEMARKS.md`](../TRADEMARKS.md)); the product name is a setting.                           |
| Can I build and sell extensions and integrations?                             | Yes, under any license: extensions that use the public API, SDKs or extension protocol are not covered by the AGPL (`LICENSE-EXCEPTIONS.md`).     |
| Do I need a license key?                                                      | No. Nothing in the software is locked. A key is only a record of activation and support from a provider you chose (see [Activating a key](#7-activating-a-license-key)). |
| I changed the code and host it for others — what must I do?                   | Point owner console → Platform settings → **Source code link** at your version. The app shows it on the sign-in screen and under ? → About (AGPL section 13). Unchanged code: nothing to do. |

**Defaults.** The platform was built in Israel: the currency (ILS), VAT (18%), the work week and holidays, the SMS
provider's reach and the legal document drafts default to Israeli values. Each is a setting (owner console or account
settings); the legal drafts are placeholders for your lawyer in any case.

## 2. Requirements

- **To try it or for a small team:** any machine with **Docker** (Docker Desktop on Windows / macOS), **1 GB of RAM**
  and a little disk. Nothing else: no database to install, no configuration file.
- **For a larger team or production:** a Linux server with **Docker Engine 24+** and the **Compose plugin 2.24+**,
  **2 CPU cores / 4 GB of RAM** for the first build, **about 5 GB of disk** plus your data, **a domain name** and a
  reverse proxy with TLS (HTTPS). Optional: an SMTP server for email; external S3 storage for files.

Details: [SELF-HOSTING.md → Requirements](SELF-HOSTING.md#requirements).

## 3. Install in 1 minute

Run the published image (every release publishes one):

```sh
docker run -it --rm -p 3000:3000 -v bines_data:/data ghcr.io/binesamit/open-crm:latest
```

Or build it yourself from the repository (about 5 minutes): `docker build -f docker/Dockerfile -t bines-os .`, then
run `bines-os` in place of the image name.

Open **http://localhost:3000** and create the owner account in the browser. That is all: the database, the uploaded
files and the secret keys are made on first start and kept in the `bines_data` volume (stop with Ctrl+C; run the same
command again to continue where you left off). Keep it running in the background with `-d --restart unless-stopped`
instead of `-it --rm`.

- **Another address** (a domain, another port): add `-e WEB_ORIGIN=https://work.example.com`.
- **Email**: off until you add SMTP (`-e SMTP_HOST=… -e SMTP_PORT=587 -e SMTP_USER=… -e SMTP_PASS=… -e
  EMAIL_FROM=…`). Without it people sign in with a password and invitations give a link to copy.
- **Back up the volume** (`/data`): it holds everything, including `secrets.json`. Without it stored secrets cannot be
  read back.
- **Limits:** one process with an embedded database — right for trying it and for small teams. For more people, or
  several servers, use PostgreSQL: the production setup below, or the same image with `-e DATABASE_URL=postgres://…`
  (and S3 with the `S3_*` variables).

### On a server, in one command

On a Linux server (any VPS) with a domain whose DNS points to it:

```sh
git clone https://github.com/binesamit/open-crm.git bines-os && sudo bash bines-os/scripts/install.sh
```

It asks for the domain and the owner's email, installs Docker if it is missing, and runs the same image behind Caddy
with automatic HTTPS (Let's Encrypt) and a daily backup of `/data` into `/opt/bines-os/backups`. Running it again
upgrades, keeping the data and the answers. Flags, restore and details: `docs/SELF-HOSTING.md`, "Install on a server
in one command".

### Production setup (PostgreSQL + file storage)

```sh
git clone https://github.com/binesamit/open-crm.git bines-os && cd bines-os
cp .env.example .env
```

Open `.env` and fill in the **SELF-HOSTING** section at the end. The required values are empty on purpose:

```sh
APP_URL=https://<your-domain>                # or http://localhost:3000 to try it locally
ADMIN_EMAIL=you@<your-domain>                # the first administrator
AUTH_SECRET=...                              # openssl rand -base64 48
SECRET_MASTER_KEY=...                        # openssl rand -base64 32
POSTGRES_PASSWORD=...                        # openssl rand -hex 24
STORAGE_SECRET_KEY=...                       # openssl rand -hex 24
```

Paste the **output** of each `openssl` command, not the command. Then:

```sh
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps   # wait until "api" is healthy
```

The first start builds the image (a few minutes). Then open `APP_URL`.

**Keep a copy of `.env` somewhere safe, outside the server.** Without `SECRET_MASTER_KEY` stored secrets cannot be
read back.

## 4. The first admin

**One-minute install:** the first visit shows **Create the owner account** (name, email, password and, optionally,
the product name). That person becomes the **platform owner** — they see the **owner console** (`/owner`), where
licensing lives — and the administrator of the first account. The screen works once: as soon as the account exists
it is gone, and the address is the sign-in page.

**Production setup:** on an empty database the first start creates the first account and invites `ADMIN_EMAIL` as
its administrator, who is also the platform owner.

- **Email configured**: open the app, enter `ADMIN_EMAIL`, use the sign-in link you receive, then accept the
  invitation. (The browser's **Create the owner account** screen also works, with `ADMIN_EMAIL` only.)
- **No email yet**: make a one-time link (valid 7 days) and open it to set a password:

  ```sh
  docker compose -f docker-compose.prod.yml exec api node dist/first-admin-link.js
  ```

Sign-up is by invitation only (unless you turn on self sign-up, below). Invite everyone else from Administration.

### Self sign-up (off by default)

People can also sign up by themselves — the same feature as on a hosted cloud, **switched off** until the platform
owner turns it on (owner console → Plans → **Self sign-up**). While it is off, `/signup` says sign-up is closed and the
sign-in page has no sign-up link. Two modes:

- **Join by domain** — people whose email is from an approved domain join an **existing account** as members. Needs
  **outbound email** (SMTP or Resend). Which account and which domains is the account's choice: its admins
  list the domains (Administration → Security → domains), verify each one — at once when their own verified address is
  at it, else by a DNS TXT record `bines-domain-verification=<token>` shown there — and turn on **auto join** with a
  role (member or viewer). Free mailbox domains never qualify, and a verified domain belongs to one account. In open
  sign-up mode too, an address at a verified domain joins that account instead of opening a new one.
- **Open sign-up** — anyone opens a **new account** of their own (hosting others). Needs outbound email, a public
  default plan and, when you ask for it, Turnstile keys. No key of any kind.

The card lists what is still missing (email, captcha keys, a public default plan, a sign-up method, a published legal
document that asks for consent); each missing item links to where it is set. If something is removed later (email, the
plan), sign-up answers "not available right now" at once and the switch stays as it was.

### First steps card

Until the installation is set up, the owner console opens with a **First steps** card: outbound email, published
legal documents, a first public plan, and self sign-up on and ready. Each step is ticked by
itself once the setting is in place, and links to where it is done. The card disappears when every step is done, or
when you press **Hide** (it stays hidden).

## 5. The registration questionnaire (optional)

Registering is **optional** and changes nothing in what the software does: an installation that never registers
holds every capability, for any number of people and items. Registering gets your installation a free **Registered**
key from a provider — a record that this installation is known to them, useful when you buy their support or hosting.

**Where it is.** Owner console → **Licensing** → License card → **Register**, and only when a license server (a
provider) is configured for your installation: owner console → Licensing → Licensing settings → License server
address, or, as a default, `LICENSE_SERVER_URL` in `.env`. **No address is built into the code**: with neither,
nothing is ever contacted. You can still paste a key you received.

**The questions:** company, size (1–5 / 6–20 / 21–100 / 100+), role, use (CRM / tasks and projects / customer
service / other), email (the only required answer), and "You may email me updates" — **never ticked for you**.

**What is sent, and only when you press Submit:** your answers, the installation id (a random number made on first
start; it identifies nothing else — no host name, no address), the version and the interface language (`he` /
`en`). Nothing else.

**What happens next:**

1. The license server emails a verification link (valid 48 hours).
2. You open it. The page shows your Registered key.
3. If the server can reach the license server, the key **installs itself**: the screen checks every few seconds
   (or press "Check now"). You can also close the screen and come back later: owner console → Licensing.
   A key that is already in force is never replaced.

**No internet on the server (offline).** In the form, under "No internet on this server?", use **Register from
another browser**. It opens `<license server>/register?instance=<your installation id>` on any computer. Register
there, confirm the email, copy the key from the verification page and paste it into the license card (see
[Activating a key](#7-activating-a-license-key)).

## 6. Editions

There is one edition. **Everything is in every installation, with no key**: boards, automations (advanced ones too),
AI with your own provider key, docs, dashboards, forms, guests and the client portal, API / MCP / webhooks / OAuth,
extensions, Google / Microsoft sign-in and two-factor, the audit log, the errors hub, secret columns, the owner console
with several accounts, hosting accounts for others and selling plans, white-label branding — for any number of people
and items.

A license key is a **record from a provider**, never a lock: it names a plan (Registered / Business / Enterprise —
the provider's names for its support offers), a number of seats, a support level and an expiry. The owner console shows
what the key says; above the seats you see a warning only; when it expires only the record expires. Nothing you use
ever turns off.

**Hosting others.** To host accounts for other people and charge for it you need no key either: owner console →
Plans (limits and prices per plan), Legal documents, then the **Self sign-up** switch — the "first steps" card lists
what is still missing.

## 7. Activating a license key

A key looks like `lic1.<…>.<…>`. It is checked **on your server, with no internet connection**.

**In the owner console** (`/owner?section=licensing`):

1. Owner console → **Licensing** → the **License** card.
2. Paste the key into **License key** and press **Install license** — or press **Upload license file** (a `.lic`,
   `.key` or `.txt` file holding the key).
3. The card shows the key's details at once.

**Through the API** (platform owner): `PUT /api/v1/platform/license` with `{ "key": "lic1.…" }`; `GET` reads the
card, `DELETE` removes the key.

**There is no environment variable for the key** (no `BINES_LICENSE_KEY`): the key is kept in the database, so it
survives restarts, upgrades and a backup/restore.

A key is installed only when it is in force **here**. Otherwise the console says why:

| Message                                     | Meaning                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| The key is not in the right format          | Part of it is missing — copy it again, in full.                        |
| The key is not signed by the licensor       | It was not issued by the licensor of this version (or it was changed). |
| The key's contents are invalid              | It is damaged. Ask for it again.                                       |
| The license has expired                     | It is past its expiry and its grace period. Ask for a renewed key.     |
| The key was issued for another installation | It names another installation id. See [FAQ: moving servers](#14-faq).  |

**Remove license** removes the record from the card. Nothing else changes and no data is deleted.

## 8. The license card

Owner console → Licensing → License shows:

- **State** (below), **Issued to**, **Edition**, **Features**, **Valid until**;
- **Seats**: "N active of M" (or "unlimited"). Active users are people — not service identities — with an active,
  non-guest membership in any account. Above the limit you see **a warning only; nothing is blocked**;
- **Grace period**, **Support**, **Installed**, **Last online check**;
- **Installation id** — the random id a key may be bound to. Give it to the licensor when you ask for a key.

| State           | What it means                                                      | What works                           |
| --------------- | ------------------------------------------------------------------ | ------------------------------------ |
| No license      | No key installed                                                   | Everything |
| Valid           | In force                                                           | Everything |
| Expiring soon   | In force, ends within 30 days — a banner                           | Everything |
| In grace period | Past its expiry, within the grace days (default 14) — a red banner | Everything |
| Expired         | Past the grace period                                              | Everything |
| Revoked         | An online check learned the licensor revoked it                    | Everything |
| Invalid         | Unreadable, not signed by the licensor, or another installation's  | Everything |

**Check online** (on the card) asks the license server whether the key is still active and whether there is a newer
key for it (a renewal or a plan change); a newer key installs itself. It sends only the installation id and the
key's id. Without an online check, revocation is unknown and a key simply runs to its expiry.

## 9. Renewal and expiry

- Business and Enterprise keys usually run **one year** (the provider decides). Registered keys do not expire.
- **30 days before** the end: an "Expiring soon" banner.
- **At the expiry**: a **grace period** (14 days unless the key says otherwise). Everything keeps working; a red
  banner says until when.
- **After the grace period**: the card shows "Expired" — the record of activation and support has ended. **Nothing
  turns off**, nothing becomes read-only, **no data is deleted**, and every user keeps working.
- **Renewing**: the licensor renews the license (same license, new date). Get the new key with **Check online**, or
  paste the key you received by email.

## 10. Upgrading to a new version

1. Back up the database (and the files) — see [Backups](SELF-HOSTING.md#backups).
2. Pull and rebuild:

   ```sh
   git pull
   docker compose -f docker-compose.prod.yml up -d --build
   ```

3. The `migrate` service runs the new database migrations before the app starts.

Migrations only move forward: to go back, restore the backup taken before the upgrade. Your license key and
installation id are in the database, so they stay as they are. Details:
[SELF-HOSTING.md → Upgrades](SELF-HOSTING.md#upgrades).

## 11. Privacy and telemetry

Nothing leaves your server unless the platform owner acts. Exactly what can be sent, and when:

| When                                         | Sent to the license server                                             | How to prevent it                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| **Submit** on the registration questionnaire | Your answers, the installation id, the version, the interface language | Skip it, or configure no license server           |
| **Check online** on the license card         | The installation id and the key's id                                   | Don't press it; `BINES_UPDATE_CHECK=false`        |
| **Telemetry**, only if you turn it on        | Once a day: `{ "instance_id", "version", "active_users", "boards" }`   | It is **off by default**; `BINES_TELEMETRY=false` |

- **Never sent:** board content, item names, files, the user list, internal addresses.
- **Telemetry is off by default.** To turn it on: owner console → Licensing → Licensing settings → **Send usage data
  (daily)**. The card shows **exactly** what would be sent before you turn it on, and when it was last sent.
- **Force everything off** in `.env`, whatever the console says:

  ```sh
  BINES_TELEMETRY=false      # no usage data, ever
  BINES_UPDATE_CHECK=false   # no online key check (and no update check)
  ```

  Then apply with `docker compose -f docker-compose.prod.yml up -d`. With no license server configured at all
  (`LICENSE_SERVER_URL` empty and nothing in Licensing settings), the platform never contacts a license server.

- The sign-in library's own telemetry is disabled in the code.

## 12. Backups, email, file storage, proxy

All in [SELF-HOSTING.md](SELF-HOSTING.md):

- [Backups](SELF-HOSTING.md#backups) — the database, the files and `.env`; test a restore once.
- [Email (SMTP)](SELF-HOSTING.md#email-smtp) — optional; any SMTP provider. Without it, sign-in uses passwords.
- [File storage](SELF-HOSTING.md#file-storage-minio-or-s3) — the bundled MinIO or any S3-compatible service.
- [Reverse proxy and TLS](SELF-HOSTING.md#reverse-proxy-and-tls) — HTTPS for `<your-domain>`, `PROXY_HOPS`.
- [Monitoring](SELF-HOSTING.md#monitoring) and [Configuration](SELF-HOSTING.md#configuration).

## 13. Troubleshooting

Installation problems (startup, sign-in, email, uploads): [SELF-HOSTING.md →
Troubleshooting](SELF-HOSTING.md#troubleshooting). Licensing:

| Symptom                                            | What to do                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Registration unavailable"                         | No license server (provider) is configured. Set one in Licensing settings (or `LICENSE_SERVER_URL`), or paste a key you received. |
| "The license server cannot be reached from here"   | The server has no internet access to it. Use **Register from another browser** and paste the key.                                    |
| "That address is not a license server"             | The license server address is wrong. Fix it in Licensing settings.                                                                   |
| The verification email did not arrive              | Check spam. The link is valid 48 hours. To send it again: Licensing settings → **Ask again**, then submit once more.                 |
| "Too many requests" when registering               | The license server limits registrations per hour. Try again later.                                                                   |
| The key does not install by itself after verifying | Press **Check now**, or copy the key from the verification page and paste it. A key already in force is never replaced.              |
| "The key was issued for another installation"      | Compare the installation id on the card with the one you gave the licensor. A fresh installation has a new id: ask for a key for it. |
| **Check online** fails with "turned off"           | `BINES_UPDATE_CHECK=false` is set. Paste the renewed key instead.                                                                    |
| A seats warning                                    | Only a warning. Deactivate users who left, or ask for more seats.                                                                    |
| The key expired                                    | See [Renewal and expiry](#9-renewal-and-expiry). Nothing was deleted.                                                                |

## 14. FAQ

**Do I have to register?** No. Nothing in the software needs a key or a registration; every installation has every
capability for any number of people and items. Registering (free) only records your installation with a provider.

**Does the platform work without internet?** Yes. Keys are checked offline. Only registration, "Check online" and
telemetry (off by default) use the network.

**What happens if I forget to renew?** You get 30 days' warning, then 14 days of grace. After that the card says
"Expired" — and that is all: nothing turns off, no data is deleted and nobody is locked out. Your provider's support
may end, as your agreement with them says.

**I moved to a new server. Does my key still work?** If you restored a backup of the database, yes: the installation
id moved with it. If you started a fresh installation, it has a new installation id: send the new id (owner console →
Licensing) to the licensor and ask for a new key. Keys issued without an installation id work anywhere.

**I need more users than my key covers.** Nothing is blocked, you only see a warning. Ask the licensor for a key with
more seats.

**Can I see exactly what telemetry sends?** Yes: owner console → Licensing → Licensing settings shows the exact
payload. It is off unless you turn it on.

**Can a feature I use today become paid later?** No. A feature that is free today stays free.

**Can I remove the platform's branding?** Yes. You can set your own product name, logo and colors, also when you host
the platform for others. Keep the attribution the license asks for (`LICENSE-EXCEPTIONS.md`), and do not use the
project's name or logo for a modified version ([`TRADEMARKS.md`](../TRADEMARKS.md)).

## 15. Support

| Key                | Support                                                            |
| ------------------ | ------------------------------------------------------------------ |
| No key, Registered | Community: the project's public channels (issues and discussions). |
| Business           | As agreed with your provider (typically email, next business day). |
| Enterprise         | As agreed with your provider (typically dedicated, with an SLA).   |

The support level of your key is shown on the license card. **Security problems:** never in a public issue — follow
[SECURITY.md](../SECURITY.md).
