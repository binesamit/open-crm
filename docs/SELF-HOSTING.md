# Self-hosting

How to install, configure, back up and upgrade Bines OS on your own machine or server with Docker. It is for
self-hosters and system administrators; the shorter, non-technical walkthrough is [`GUIDE.md`](GUIDE.md). Three ways,
one image:

- **[Install on a server in one command](#install-on-a-server-in-one-command)** — a script for a fresh Linux server
  (any VPS): installs Docker, asks for your domain, and runs the platform with automatic HTTPS and a daily backup.
- **[Install in 1 minute](#install-in-1-minute)** — `docker run`, nothing to configure. An embedded database and
  local file storage in one volume; the owner account is created in the browser. For trying it and for small teams.
- **[Production setup](#production-setup-compose)** — `docker-compose.prod.yml`: PostgreSQL, S3-compatible file
  storage, a separate background worker. For larger teams and anything you scale or monitor.

## Install on a server in one command

For a real server (Hetzner, DigitalOcean, AWS, a machine in your office, ...) running Linux, with a domain name whose
DNS record points to it:

```sh
git clone https://github.com/binesamit/open-crm.git bines-os && sudo bash bines-os/scripts/install.sh
```

The script asks three things — the **domain** (e.g. `work.example.com`), the **owner's email** (only that address
can create the owner account; leave it empty and whoever opens the site first becomes the owner) and an optional
email for certificate expiry notices — then:

1. installs Docker if it is missing (Docker's official `get.docker.com` script);
2. builds the image from the checkout (about 5 minutes, needs ~4 GB of RAM or swap) — or, with
   `BINES_IMAGE=<image>`, runs a published image instead;
3. writes everything to `/opt/bines-os` and starts two containers: the platform in
   [standalone mode](#install-in-1-minute) and [Caddy](https://caddyserver.com), which gets a Let's Encrypt
   certificate for the domain, renews it, and redirects HTTP to HTTPS. The app's own port is not published: only
   ports 80 and 443 are open (and opened in `ufw` when it is on);
4. schedules a **daily backup** of `/data` (03:30 by default, a systemd timer — or cron): the app stops for a few
   seconds, `/data` is archived into `/opt/bines-os/backups/` and the newest 7 archives are kept.

Open `https://<your domain>` and create the owner account. The script writes no secrets: the app generates its keys
into `/data/secrets.json` on the first start.

| In `/opt/bines-os`   | What it is                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `app.env`            | The app's settings (email, PostgreSQL, S3 ... — the variables of [Install in 1 minute](#install-in-1-minute)). Yours to edit, then `docker compose up -d` in that folder. Never overwritten. |
| `install.env`        | The installer's answers. Running the installer again reuses them.                             |
| `docker-compose.yml`, `Caddyfile`, `backup.sh` | Written by the installer — run it again rather than editing them.   |
| `backups/`           | The daily archives of `/data` (database, files, `secrets.json`). Copy them off the server too. |

**Upgrade:** `git pull` in the checkout, then run the installer again — same answers, same data, the new version.

**Restore** an archive (into the same or a new server, after installing with the same domain):

```sh
cd /opt/bines-os && docker compose stop app
docker run --rm --user 0 --entrypoint sh -v bines-os_data:/data -v "$PWD/backups":/backup bines-os:local \
  -c 'rm -rf /data/* && tar xzf /backup/bines-data-<date>.tgz -C /data'
docker compose start app
```

(With `BINES_IMAGE`, put that image in place of `bines-os:local`.)

Every question is also a flag or a variable, for automation (`--yes` asks nothing):

| Flag                    | Variable             | Default          |                                                                          |
| ----------------------- | -------------------- | ---------------- | ------------------------------------------------------------------------ |
| `--domain`              | `BINES_DOMAIN`       | (asked)          | The address people open                                                  |
| `--owner-email`         | `BINES_OWNER_EMAIL`  | (asked)          | Only this address may create the owner account                           |
| `--acme-email`          | `BINES_ACME_EMAIL`   | the owner's      | Contact for Let's Encrypt                                                |
| `--dir`                 | `BINES_DIR`          | `/opt/bines-os`  | Install folder (one installation per server)                             |
| `--image`               | `BINES_IMAGE`        | build            | Run a published image instead of building one                            |
| `--source`, `--ref`     | `BINES_SOURCE`, `BINES_REF` | this checkout | Build from another checkout or a git URL (branch / tag)            |
| `--backup-time`         | `BINES_BACKUP_TIME`  | `03:30`          | Daily backup time (server clock)                                         |
| `--backup-keep`         | `BINES_BACKUP_KEEP`  | `7`              | Archives kept; `0` = no backup timer                                     |
| `--http-port`, `--https-port` | `BINES_HTTP_PORT`, `BINES_HTTPS_PORT` | `80`, `443` | Other ports (Let's Encrypt needs 80 or 443 reachable) |
| `--tls internal`        | `BINES_TLS`          | `auto`           | Caddy's own certificate authority instead of Let's Encrypt (tests, LAN)  |
| `--no-docker-install`   | `BINES_NO_DOCKER_INSTALL=1` |           | Fail instead of installing Docker                                        |

If the certificate does not arrive, check that the domain's DNS points to the server and that ports 80 and 443 are
open in your provider's firewall: `cd /opt/bines-os && docker compose logs caddy`. The CI workflow `installer`
([`scripts/install-smoke.sh`](../scripts/install-smoke.sh); it runs when the installer or the image changes) runs the
whole install on a clean Linux machine and checks it from outside.

## Install in 1 minute

```sh
docker run -it --rm -p 3000:3000 -v bines_data:/data ghcr.io/binesamit/open-crm:latest
```

Every release publishes that image (`:latest`, `:1.2`, `:1.2.3`). To build it yourself instead:
`git clone https://github.com/binesamit/open-crm.git bines-os && cd bines-os && docker build -f docker/Dockerfile -t bines-os .` (about
5 minutes), then run `bines-os` in place of the image name.

Open <http://localhost:3000> and **create the owner account** (name, email, password; the product name is optional).
That person is the platform owner and the administrator of the first account. Stop with Ctrl+C; the same command
continues where you left off. To keep it running: `docker run -d --restart unless-stopped --name bines -p 3000:3000
-v bines_data:/data ghcr.io/binesamit/open-crm:latest`.

What happens on the first start (standalone mode, the image's default command `node dist/standalone.js`):

| Piece    | Standalone mode                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| Database | Embedded PostgreSQL ([PGlite](https://pglite.dev)) in `/data/db`; migrations run at every start.              |
| Files    | `/data/files`, uploaded and downloaded through the API with short-lived signed links (like S3's).              |
| Secrets  | `BETTER_AUTH_SECRET` and `SECRET_MASTER_KEY` are generated once into `/data/secrets.json` (mode 0600).        |
| Jobs     | Automations and the worker's jobs (notifications, digests, trash and file clean-up) run in the same process. |
| Owner    | The first visit shows **Create the owner account**; it works once — as soon as a user exists it is closed.    |
| Email    | Off until you add SMTP. People sign in with a password; invitations give a link to copy.                       |

Everything the installation keeps is in the volume: **back up `/data`** (stop the container, then copy the volume,
see [Backups](#backups)). Do not lose `secrets.json`: without it stored secrets cannot be read back and everyone is
signed out.

**Options** — all optional, as `-e NAME=value`:

| Variable                                                       | Purpose                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `WEB_ORIGIN`                                                   | The address people open (`https://work.example.com`). Unset: the address the owner set up from is kept. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Email, see [Email (SMTP)](#email-smtp).                                                                  |
| `DATABASE_URL`                                                 | Use PostgreSQL instead of the embedded database (same image, same command; migrations at start).        |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | Use S3-compatible storage instead of `/data/files`.                           |
| `BETTER_AUTH_SECRET`, `SECRET_MASTER_KEY`                      | Your own keys instead of the generated ones (the environment always wins over `secrets.json`).           |
| `SEED_ADMIN_EMAIL`                                             | Name the owner in advance: only that address can create the owner account.                               |
| `TRUST_PROXY`                                                  | Behind a reverse proxy: `1` (one proxy) or `edge` (a PaaS edge such as Railway).                         |

On a server, put it behind a reverse proxy with TLS (see [Reverse proxy and TLS](#reverse-proxy-and-tls)) and set
`WEB_ORIGIN` to the HTTPS address. Over plain HTTP, sign-in works on `localhost`; on another address use HTTPS.

**Limits of standalone mode.** The embedded database is one connection inside one process, so the API, the web app
and every background job share it. It is right for evaluation and for small teams (a handful of people working at
the same time); heavy boards, many concurrent users or several replicas need PostgreSQL. Moving up keeps the same
image: set `DATABASE_URL` (and `S3_*`), or switch to the [production setup](#production-setup-compose). There is no
automatic copy from the embedded database to PostgreSQL: decide before you put a lot of data in, or move it with the
export / import tools. Run one container per volume (two processes must never open the same `/data`).

### One-click deploy on Railway

[`docker/railway/railway.json`](../docker/railway/railway.json) is a ready service configuration (Dockerfile build,
health check, restart policy) for a Railway template:

1. New project → **Deploy from GitHub repo** (your fork), then in the service's **Settings → Config-as-code** set the
   path to `/docker/railway/railway.json`.
2. Add a **volume** mounted at `/data`, and the variable `RAILWAY_RUN_UID=0` (Railway volumes belong to root; the
   image otherwise runs as an unprivileged user).
3. **Networking → Generate domain**. Variables: `TRUST_PROXY=edge` (optional: `WEB_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}`;
   unset, the public domain is used).
4. Deploy, open the domain and create the owner account — do it right away: until then, whoever opens the address
   first becomes the owner.

Save the project as a template (Project settings → **Create template**) to give others the same one-click deploy. For
PostgreSQL, add Railway's Postgres to the project and set `DATABASE_URL=${{Postgres.DATABASE_URL}}`.

## Production setup (compose)

The web app, the API, the background worker, PostgreSQL and S3-compatible file storage — one image, one compose file,
one command.

| Piece      | What it is                                                                              |
| ---------- | --------------------------------------------------------------------------------------- |
| `api`      | The API, which also serves the web app (one origin). Health: `GET /api/v1/health`.     |
| `worker`   | Background jobs: notifications, email digests, clean-up. Same image, other command.    |
| `migrate`  | One-shot release on every start: database migrations, then the idempotent seed.       |
| `postgres` | PostgreSQL 18, data in the `pgdata` volume.                                             |
| `minio`    | S3-compatible file storage, data in the `miniodata` volume. Optional (external S3).    |

Files: [`docker/Dockerfile`](../docker/Dockerfile), [`docker-compose.prod.yml`](../docker-compose.prod.yml), the
"Self-hosting" section at the end of [`.env.example`](../.env.example).

## Requirements

Install in 1 minute: Docker (Docker Desktop on Windows / macOS) and about 1 GB of RAM. The production setup:

- Docker Engine 24+ with the Compose plugin 2.24+ (`docker compose version`).
- 2 CPU cores and 4 GB of RAM for the first build (the web app is compiled in the image). Running needs about 1 GB.
- About 5 GB of disk for images, plus your data.
- `openssl` (or any other way to make random strings) for the secrets.
- For real use: a domain name and a reverse proxy with TLS (see [Reverse proxy and TLS](#reverse-proxy-and-tls)).
- Optional: an SMTP server for email (any provider), or external S3 storage.

## Quick start

```sh
git clone https://github.com/binesamit/open-crm.git bines-os && cd bines-os
cp .env.example .env
```

Open `.env` and fill in the **SELF-HOSTING** section at the end (the part above it is for developers and is
ignored by the production stack where it conflicts). The required values are empty on purpose:

```sh
ADMIN_EMAIL=you@example.com                 # the first administrator
AUTH_SECRET=$(openssl rand -base64 48)      # paste the output, not the command
SECRET_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
STORAGE_SECRET_KEY=$(openssl rand -hex 24)
```

Then start everything:

```sh
docker compose -f docker-compose.prod.yml up -d
```

The first start builds the image (a few minutes). Watch it come up with
`docker compose -f docker-compose.prod.yml ps` - `api` turns `healthy` when ready. Open `APP_URL`
(default <http://localhost:3000>).

If a required value is missing, `docker compose` refuses to start and names it.

**Keep a copy of `.env` somewhere safe.** `SECRET_MASTER_KEY` encrypts stored secrets: without it they cannot be read
back. Changing `AUTH_SECRET` signs everyone out.

## First admin account

**Standalone mode** (install in 1 minute): the browser shows **Create the owner account** while no user exists — no
command, no email needed. `first-admin-link` is for the compose setup (and standalone with `DATABASE_URL`); with the
embedded database it points you to the browser instead.

**Compose setup:** on an empty database the release creates the first account (`FIRST_ACCOUNT_NAME`, `FIRST_ACCOUNT_SLUG`,
`FIRST_ACCOUNT_KIT`) and invites `ADMIN_EMAIL` as its administrator. That person also becomes the **platform owner**
(the owner console: accounts, platform settings, branding).

- **Email configured** (see [Email](#email-smtp)): open the app, enter `ADMIN_EMAIL` and use the sign-in link you
  receive. Then accept the invitation from the account picker.
- **No email yet**: ask the server for a one-time link and open it to set a password:

  ```sh
  docker compose -f docker-compose.prod.yml exec api node dist/first-admin-link.js
  ```

  The link is valid for 7 days; running the command again replaces it. Once you are in, invite everyone else from
  Administration (invitation links can be copied there, so email is optional for them too).

Sign-up is by invitation only: nobody can create an account on your server unless invited — or unless the platform
owner turns on self sign-up in the owner console (off by default; see [`GUIDE.md`](GUIDE.md#self-sign-up-off-by-default)).

## Configuration

Every variable is documented in `.env.example`. The production stack sets the internal ones itself (database URL,
storage endpoint, `NODE_ENV`, ...) from these:

| Variable                                   | Required | Purpose                                                             |
| ------------------------------------------ | -------- | ------------------------------------------------------------------- |
| `APP_URL`                                  | yes      | The address people open; links in emails and sign-in cookies use it |
| `APP_PORT`                                 |          | Host port of the app (default 3000; `127.0.0.1:3000` = local only)  |
| `ADMIN_EMAIL`                              | yes      | First administrator and platform owner                              |
| `AUTH_SECRET`                              | yes      | Session signing key, `openssl rand -base64 48`                      |
| `SECRET_MASTER_KEY`                        | yes      | Encryption key for stored secrets, `openssl rand -base64 32`        |
| `POSTGRES_PASSWORD`                        | yes      | Database password, `openssl rand -hex 24` (hex only)                |
| `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` | yes      | MinIO admin user / your S3 keys                                     |
| `STORAGE_PUBLIC_URL`                       |          | Where browsers reach the storage (bundled MinIO only)               |
| `EMAIL_FROM`, `SMTP_*`                     |          | Email, see below                                                    |
| `PROXY_HOPS`                               |          | Reverse proxies in front of the app (`none`, `1`, ...)              |

Optional integrations read from the same `.env`: Google sign-in (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), SMS
(`TEXTME_*`), web push keys (`VAPID_*`, generated automatically when empty), error monitoring (`SENTRY_DSN`), rate
limits. AI providers, maps and branding are set in the app (owner console and Administration), not here.

The built-in help center (`seed/help`: articles, guides and guided tours) is loaded once on first boot. Set
`HELP_SEED=false` to start with an empty help center, or `HELP_SEED_DIR` to load another package folder.

After changing `.env`, apply it with `docker compose -f docker-compose.prod.yml up -d`.

## Email (SMTP)

Email is optional. Without it the app works, sign-in uses passwords, and each email that would have been sent is
logged (never its contents). The log says so once at startup: `email is off: no mail transport configured`.

Any SMTP server works (your own Postfix, Amazon SES, Postmark, Mailgun, Brevo, Gmail with an app password, ...):

```sh
EMAIL_FROM=noreply@example.com     # the sending address; your provider must allow it
SMTP_HOST=smtp.example.com
SMTP_PORT=587                      # 587 = STARTTLS (default), 465 = TLS from the start
SMTP_USER=...
SMTP_PASS=...
SMTP_SECURE=                       # true for port 465; empty = automatic
SMTP_REQUIRE_TLS=                  # empty = STARTTLS must succeed (except a relay on localhost); false = allow cleartext
```

`EMAIL_FROM` and the `SMTP_*` lines are in the email part of `.env.example` (they are shared with development).
The sender **name** is not configured here: it is a setting of each account (Administration) and of the platform
(owner console).

Transport order when several are configured: Resend (`RESEND_API_KEY`), then SMTP, then Mailpit (development).
`EMAIL_TRANSPORT=smtp` (or `resend`, `none`) forces one. Startup logs `email transport ready` with the transport in
use.

Set up SPF, DKIM and DMARC for the sending domain with your provider, or mail will land in spam.

## File storage (MinIO or S3)

Browsers upload and download files **directly** to the storage with short-lived signed URLs; file bytes never pass
through the API. So the storage must be reachable from the browser, at the address in `STORAGE_PUBLIC_URL`.

### Bundled MinIO (default)

`COMPOSE_PROFILES=minio` starts MinIO, creates the bucket (`STORAGE_BUCKET`) on first start and publishes it on
`MINIO_PORT` (default 9000). The API talks to it inside the Docker network (`http://minio:9000`); browsers use
`STORAGE_PUBLIC_URL`:

- on your own machine: `http://localhost:9000` (the default);
- on a server: put it behind your reverse proxy on its own host name, e.g. `https://files.example.com`, and set
  `STORAGE_PUBLIC_URL` to that.

Note: MinIO no longer publishes container images upstream. The compose file pins the last free build
(`bitnamilegacy/minio`), which receives no updates. For anything beyond a small installation prefer an external
S3 service.

### External S3

Any S3-compatible service: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, a MinIO / Garage / SeaweedFS you run
elsewhere. In `.env`:

```sh
COMPOSE_PROFILES=                  # do not start the bundled MinIO
STORAGE_ENDPOINT=https://s3.eu-central-1.amazonaws.com
STORAGE_REGION=eu-central-1        # R2: auto
STORAGE_BUCKET=your-bucket
STORAGE_ACCESS_KEY=...
STORAGE_SECRET_KEY=...
STORAGE_PUBLIC_URL=                # empty: browsers use the same endpoint
STORAGE_FORCE_PATH_STYLE=false     # AWS; keep true for most S3-compatible services
STORAGE_SET_CORS=true              # the app sets the bucket's CORS to APP_URL at startup
```

The bucket's CORS must allow `PUT`, `GET` and `HEAD` from `APP_URL`. With `STORAGE_SET_CORS=true` the app does it;
some providers (Cloudflare R2) need it set with their own tools instead. The app adds the storage address to its
Content-Security-Policy automatically.

## Reverse proxy and TLS

Put a reverse proxy with TLS in front for any real use: sign-in cookies, the installable phone app (PWA) and web
push need HTTPS. Example with [Caddy](https://caddyserver.com) (automatic certificates):

```caddyfile
work.example.com {
    reverse_proxy 127.0.0.1:3000
}

files.example.com {
    reverse_proxy 127.0.0.1:9000
}
```

and in `.env`:

```sh
APP_URL=https://work.example.com
APP_PORT=127.0.0.1:3000            # reachable only through the proxy
STORAGE_PUBLIC_URL=https://files.example.com
MINIO_PORT=127.0.0.1:9000
PROXY_HOPS=1                       # one proxy appends the client address to X-Forwarded-For
```

With nginx or Traefik, keep in mind:

- WebSockets (live co-editing, `/api/v1/collab`) and server-sent events (live updates) must pass: forward
  `Upgrade`/`Connection` headers and turn response buffering off for the app.
- Allow large request bodies on the storage host (uploads go there) and keep the `Host` header as sent: signed
  URLs include it.
- `PROXY_HOPS` must equal the number of proxies that append to `X-Forwarded-For`. Too high lets clients fake their
  address (rate limits); `none` ignores the header.

The owner console can later move the app to another address (Platform settings, public address); keep `APP_URL` as
the address the server starts with.

## Connecting Google Calendar

Two-way sync between a board and Google Calendar is an **extension with its own server**, shipped in the repository
(`extensions/calendar-sync/`, details in its README). Everything after the server is up is done in the UI: no code,
no per-account setup files.

**1. Run its server** (with the production compose setup):

```sh
# .env
COMPOSE_PROFILES=minio,calendar-sync
CALSYNC_PUBLIC_URL=https://calendar.example.com   # its own https address
CALSYNC_ENCRYPTION_KEY=...                         # openssl rand -base64 32
CALSYNC_PORT=127.0.0.1:3990

docker compose -f docker-compose.prod.yml up -d --build
```

and give it a host in your proxy:

```caddyfile
calendar.example.com {
    reverse_proxy 127.0.0.1:3990
}
```

It keeps its data in its own database (`calendar_sync`) on the bundled Postgres, created on first start.
`https://calendar.example.com/health` answers 200 when it is up. The address must be public: Bines and Google both
call it (Bines refuses private addresses in production).

**2. Install it in Bines:** Administration → Extensions → For developers → By address →
`https://calendar.example.com/manifest.json` → approve, and grant the board(s) to sync.

**3. The Google OAuth client** (once): the extension's settings page (Administration → Extensions → Calendar sync)
shows the exact **Redirect URI** to register — `https://calendar.example.com/oauth/google/callback` — with a copy
button and the steps in Google Cloud (enable the Calendar API, consent screen with the scopes `openid`, `email`,
`calendar.events` and `calendar.calendarlist.readonly`, an OAuth client of type "Web application"). Paste the
client id and secret there; the secret is stored encrypted and shown only as a hint. Alternatively set
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env` as the default for every account; an account admin can still
use their own client (e.g. a Google Workspace "Internal" app).

**4. Choose what syncs**, in the same settings page: the board, where the hours are (a timeline with hours, or a
date with start and end hour columns), the people column, the target (each member's own calendar, a shared calendar,
or both), what flows each way, invitations, answers, and the template a new Google event becomes an item through.
The status at the bottom shows the last sync, errors and a "Sync now" button.

**5. Each member connects their own Google account** in their profile → "My connections" → Google Calendar
(and can disconnect there).

The server's addresses (also listed in the settings page): `/lifecycle` (Bines), `/bines/webhook` (board webhooks
it creates itself), `/google/push` (Google push notifications), `/oauth/google/callback` (the Redirect URI).

## Backups

**Standalone mode:** everything is in the `/data` volume. Stop the container (the embedded database is copied
consistently only while stopped), then:

```sh
docker stop bines
docker run --rm -v bines_data:/data:ro -v "$PWD":/backup alpine tar czf /backup/bines-data-$(date +%F).tgz -C /data .
docker start bines
```

Restore by extracting the archive into an empty volume before the first start.

**Compose setup:** back up three things: the database, the files and `.env`.

```sh
# Database (consistent while running)
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backup-$(date +%F).dump

# Files in the bundled MinIO (the volume is named <project>_miniodata; the project is "bines-os")
docker run --rm -v bines-os_miniodata:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/files-$(date +%F).tgz -C /data .
```

With external S3, use your provider's versioning or replication for files.

Restore into a fresh installation (same `.env`, especially the same `SECRET_MASTER_KEY`):

```sh
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < backup.dump
docker run --rm -v bines-os_miniodata:/data -v "$PWD":/backup alpine \
  tar xzf /backup/files.tgz -C /data
docker compose -f docker-compose.prod.yml up -d
```

Test a restore once before you need it.

## Upgrades

```sh
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

The `migrate` service runs the new database migrations before the new `api` and `worker` start. Take a database
backup first. Migrations only move forward: to go back to an older version, restore the backup taken before the
upgrade.

PostgreSQL major upgrades (e.g. 18 to 19) are not automatic: dump, start the new version on an empty volume,
restore.

## Monitoring

- `GET /api/v1/health` answers 200 while the API is up; the image's Docker healthcheck uses it.
- Logs: `docker compose -f docker-compose.prod.yml logs -f api worker` (JSON lines from the API).
- Error reporting is off by default. To turn it on, run [GlitchTip](https://glitchtip.com) (or use Sentry) and set
  `SENTRY_DSN` (API and worker). The browser app's DSN is a build argument: `VITE_SENTRY_DSN` in `.env`, then
  rebuild with `up -d --build`.

## Known limitations

- **Standalone mode is one process with an embedded database** — see
  [Limits of standalone mode](#install-in-1-minute). Use PostgreSQL to scale.
- **One API process.** Live document co-editing and some rate limits are kept in the API's memory, so run a single
  `api` container (the default). This comfortably serves dozens of concurrent users.
- The bundled MinIO image is frozen (see [File storage](#file-storage-minio-or-s3)).

## Troubleshooting

| Symptom                                                         | What to check                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `required variable ... is missing a value`                      | Fill that line in the SELF-HOSTING section of `.env`.                                                                                                                          |
| `api` never becomes healthy / does not start                    | `docker compose -f docker-compose.prod.yml logs migrate api`. `Invalid environment` names the bad variable. `migrate` must end with `seed: done`.                               |
| Cannot sign in / logged out at once                             | `APP_URL` must be exactly the address in the browser bar (scheme, host and port). Behind HTTPS it must start with `https://`.                                                  |
| Standalone: `cannot use the data folder /data`                  | Mount a volume at `/data` (`-v bines_data:/data`). A host folder must be writable by uid 1000.                                                                                 |
| Standalone: the owner screen does not appear                    | An owner already exists (the volume is not new). Sign in, or start over with a new volume: `docker volume rm bines_data`.                                                    |
| `invitation_required` when signing up                           | Sign-up needs an invitation. First admin: run `first-admin-link` (see [First admin account](#first-admin-account)). Check that `ADMIN_EMAIL` is the address you use.           |
| No emails arrive                                                | Startup log of `api`: `email is off` = no transport; `email transport ready` = configured, then check the provider's logs, `EMAIL_FROM` and SPF/DKIM.                         |
| Uploads fail / images do not load                               | The browser must reach `STORAGE_PUBLIC_URL` (open it: an XML `AccessDenied` answer is fine). External S3: bucket CORS must allow `APP_URL`.                                    |
| Wrong client addresses in the audit log, rate limits hit at once | `PROXY_HOPS` must match the number of reverse proxies in front.                                                                                                                |
| Port already in use                                             | Change `APP_PORT` / `MINIO_PORT`.                                                                                                                                              |
| Lost `SECRET_MASTER_KEY`                                        | Stored secrets (connection keys, secret columns) cannot be recovered; set a new key and enter them again. Everything else is unaffected.                                       |

Start from zero (deletes all data): `docker compose -f docker-compose.prod.yml down -v`.
