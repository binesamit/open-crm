#!/usr/bin/env bash
# One-command server install: the standalone image behind Caddy with automatic HTTPS, and a daily
# backup of /data. On a fresh Linux server (Ubuntu, Debian, Fedora, CentOS/RHEL, ...) as root:
#
#   sudo bash scripts/install.sh                       # from a checkout of this repository: builds the image here
#   sudo BINES_IMAGE=<registry>/<image>:<tag> bash install.sh     # or: run a published image
#
# It installs Docker if it is missing, asks for the domain (and, optionally, the owner's email and an address for the
# certificate authority), writes everything to one folder (default /opt/bines-os) and starts two containers:
#   app   — the platform in standalone mode (embedded database, files and generated secrets in the `data` volume)
#   caddy — the reverse proxy: ports 80/443, a Let's Encrypt certificate for the domain, renewed by itself
# and a daily timer that stops the app for a few seconds, archives /data and keeps the newest copies.
#
# Nothing here is specific to one installation: every value is a question, a flag or an environment variable, and
# no secret is written by this script (the app makes its own keys in /data/secrets.json on the first start).
# Running it again upgrades: the new image, the same data and settings (answers are kept in install.env).
#
# Flags (each also as an environment variable):
#   --domain NAME          BINES_DOMAIN       the address people open, e.g. work.example.com (its DNS must point here)
#   --owner-email ADDR     BINES_OWNER_EMAIL  only this address may create the owner account (recommended; empty =
#                                             whoever opens the site first)
#   --acme-email ADDR      BINES_ACME_EMAIL   contact address for the certificate authority (optional)
#   --dir PATH             BINES_DIR          install folder (default /opt/bines-os)
#   --image REF            BINES_IMAGE        run this image instead of building one
#   --source PATH|GIT_URL  BINES_SOURCE       build from this checkout or git repository (default: the checkout this
#                                             script is in)
#   --ref REF              BINES_REF          the branch or tag to build from a git repository (default: its default)
#   --backup-time HH:MM    BINES_BACKUP_TIME  daily backup time, server clock (default 03:30)
#   --backup-keep N        BINES_BACKUP_KEEP  how many daily archives to keep (default 7; 0 = no backup timer)
#   --http-port N          BINES_HTTP_PORT    host port for HTTP (default 80; Let's Encrypt needs 80 or 443 public)
#   --https-port N         BINES_HTTPS_PORT   host port for HTTPS (default 443)
#   --tls MODE             BINES_TLS          auto (Let's Encrypt, default) | internal (Caddy's own CA: tests, LAN)
#   --no-docker-install    BINES_NO_DOCKER_INSTALL=1  fail instead of installing Docker
#   -y, --yes              BINES_YES=1        no questions: everything comes from flags / variables / install.env
#   -h, --help
set -euo pipefail

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
  exit 0
}

# The checkout this script is in (none when it comes through a pipe: curl ... | sudo bash).
SCRIPT_DIR=""
if [ -f "${BASH_SOURCE[0]:-}" ]; then SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi

# ---------------------------------------------------------------------------------------------------- options
DOMAIN="${BINES_DOMAIN:-}"
OWNER_EMAIL="${BINES_OWNER_EMAIL:-}"
ACME_EMAIL="${BINES_ACME_EMAIL:-}"
DIR="${BINES_DIR:-/opt/bines-os}"
IMAGE="${BINES_IMAGE:-}"
SOURCE="${BINES_SOURCE:-}"
REF="${BINES_REF:-}"
BACKUP_TIME="${BINES_BACKUP_TIME:-}"
BACKUP_KEEP="${BINES_BACKUP_KEEP:-}"
HTTP_PORT="${BINES_HTTP_PORT:-}"
HTTPS_PORT="${BINES_HTTPS_PORT:-}"
TLS="${BINES_TLS:-}"
NO_DOCKER_INSTALL="${BINES_NO_DOCKER_INSTALL:-}"
YES="${BINES_YES:-}"

need_value() { if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
  --domain) need_value "$@"; DOMAIN="$2"; shift 2 ;;
  --owner-email) need_value "$@"; OWNER_EMAIL="$2"; shift 2 ;;
  --acme-email) need_value "$@"; ACME_EMAIL="$2"; shift 2 ;;
  --dir) need_value "$@"; DIR="$2"; shift 2 ;;
  --image) need_value "$@"; IMAGE="$2"; shift 2 ;;
  --source) need_value "$@"; SOURCE="$2"; shift 2 ;;
  --ref) need_value "$@"; REF="$2"; shift 2 ;;
  --backup-time) need_value "$@"; BACKUP_TIME="$2"; shift 2 ;;
  --backup-keep) need_value "$@"; BACKUP_KEEP="$2"; shift 2 ;;
  --http-port) need_value "$@"; HTTP_PORT="$2"; shift 2 ;;
  --https-port) need_value "$@"; HTTPS_PORT="$2"; shift 2 ;;
  --tls) need_value "$@"; TLS="$2"; shift 2 ;;
  --no-docker-install) NO_DOCKER_INSTALL=1; shift ;;
  -y | --yes) YES=1; shift ;;
  -h | --help) usage ;;
  *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = Linux ] || die "this installer is for a Linux server (on a laptop use: docker run -p 3000:3000 -v bines_data:/data <image>)"
[ "$(id -u)" = 0 ] || die "run it as root: sudo bash $0 $*"

# A previous install's answers are the defaults (a flag or variable given now wins).
ENV_FILE="$DIR/install.env"
if [ -f "$ENV_FILE" ]; then
  say "found an existing installation in $DIR: upgrading it"
  # shellcheck disable=SC1090
  prev() { (set +u; . "$ENV_FILE"; eval "printf '%s' \"\${$1:-}\""); }
  DOMAIN="${DOMAIN:-$(prev DOMAIN)}"
  OWNER_EMAIL="${OWNER_EMAIL:-$(prev OWNER_EMAIL)}"
  ACME_EMAIL="${ACME_EMAIL:-$(prev ACME_EMAIL)}"
  IMAGE="${IMAGE:-$(prev IMAGE_FROM)}"
  SOURCE="${SOURCE:-$(prev SOURCE)}"
  REF="${REF:-$(prev REF)}"
  BACKUP_TIME="${BACKUP_TIME:-$(prev BACKUP_TIME)}"
  BACKUP_KEEP="${BACKUP_KEEP:-$(prev BACKUP_KEEP)}"
  HTTP_PORT="${HTTP_PORT:-$(prev HTTP_PORT)}"
  HTTPS_PORT="${HTTPS_PORT:-$(prev HTTPS_PORT)}"
  TLS="${TLS:-$(prev TLS)}"
fi
BACKUP_TIME="${BACKUP_TIME:-03:30}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"
TLS="${TLS:-auto}"

# Questions read the terminal even when the script itself comes from a pipe (curl ... | sudo bash).
TTY=""
if [ -z "$YES" ] && { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
ask() { # ask VAR "question" [default]
  local answer
  [ -n "$TTY" ] || return 0
  printf '%s%s: ' "$2" "${3:+ [$3]}" >"$TTY"
  IFS= read -r answer <"$TTY" || true
  printf -v "$1" '%s' "${answer:-${3:-}}"
}

[ -n "$DOMAIN" ] || ask DOMAIN "Domain people will open (its DNS A/AAAA record must point to this server), e.g. work.example.com"
[ -n "$DOMAIN" ] || die "a domain is required (--domain or BINES_DOMAIN): sign-in, the phone app and notifications need HTTPS"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##')"
printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$|^localhost$|^([a-z0-9-]+\.)*(test|local|internal|lan)$' ||
  die "not a domain name: $DOMAIN"
if [ ! -f "$ENV_FILE" ] && [ -z "$OWNER_EMAIL" ]; then
  ask OWNER_EMAIL "Owner's email — only this address can create the owner account (Enter = whoever opens the site first)"
fi
if [ -z "$ACME_EMAIL" ] && [ "$TLS" = auto ] && [ ! -f "$ENV_FILE" ]; then
  ask ACME_EMAIL "Email for certificate expiry notices from Let's Encrypt (optional)" "$OWNER_EMAIL"
fi
for e in "$OWNER_EMAIL" "$ACME_EMAIL"; do
  [ -z "$e" ] || printf '%s' "$e" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || die "not an email address: $e"
done
case "$TLS" in auto | internal) ;; *) die "--tls must be auto or internal" ;; esac
printf '%s' "$BACKUP_TIME" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' || die "--backup-time must be HH:MM"
printf '%s' "$BACKUP_KEEP$HTTP_PORT$HTTPS_PORT" | grep -Eq '^[0-9]+$' || die "--backup-keep and the ports must be numbers"

# ---------------------------------------------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  [ -z "$NO_DOCKER_INSTALL" ] || die "Docker is not installed (and --no-docker-install was given)"
  say "installing Docker (Docker's official script, get.docker.com)"
  command -v curl >/dev/null 2>&1 || {
    if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl ca-certificates
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl
    elif command -v yum >/dev/null 2>&1; then yum install -y -q curl
    else die "curl is missing: install curl (or Docker) and run this again"; fi
  }
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi
if ! docker info >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (try: systemctl start docker)"
fi
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing (Docker's packages include it: docker-compose-plugin)"

# ---------------------------------------------------------------------------------------------------- the image
mkdir -p "$DIR/backups"
chmod 700 "$DIR"
# shellcheck disable=SC2034 # written to install.env through ${!v}
IMAGE_FROM="$IMAGE"
if [ -n "$IMAGE" ]; then
  say "pulling $IMAGE"
  docker pull "$IMAGE"
  RUN_IMAGE="$IMAGE"
else
  if [ -z "$SOURCE" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../docker/Dockerfile" ]; then SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"; fi
  [ -n "$SOURCE" ] || die "no image to run: give --image <published image>, or --source <checkout or git URL> to build one"
  CONTEXT="$SOURCE"
  if [ ! -d "$SOURCE" ]; then
    command -v git >/dev/null 2>&1 || die "git is needed to build from $SOURCE"
    CONTEXT="$DIR/src"
    if [ -d "$CONTEXT/.git" ]; then
      git -C "$CONTEXT" fetch --depth 1 origin ${REF:+"$REF"}
      git -C "$CONTEXT" reset --hard FETCH_HEAD
    else
      git clone --depth 1 ${REF:+--branch "$REF"} "$SOURCE" "$CONTEXT"
    fi
  fi
  [ -f "$CONTEXT/docker/Dockerfile" ] || die "$CONTEXT has no docker/Dockerfile"
  RUN_IMAGE="bines-os:local"
  say "building the image from $CONTEXT (about 5 minutes; needs ~4 GB of RAM or swap)"
  docker build -f "$CONTEXT/docker/Dockerfile" -t "$RUN_IMAGE" "$CONTEXT"
fi

# ---------------------------------------------------------------------------------------------------- files
# The answers, for the next run (upgrade) and for the backup script. No secrets in it.
umask 077
{
  echo '# Written by install.sh — the answers of the last install. Edit and run install.sh again to change them.'
  for v in DOMAIN OWNER_EMAIL ACME_EMAIL IMAGE_FROM SOURCE REF BACKUP_TIME BACKUP_KEEP HTTP_PORT HTTPS_PORT TLS; do
    printf '%s=%q\n' "$v" "${!v}"
  done
  printf 'IMAGE=%q\n' "$RUN_IMAGE"
} >"$ENV_FILE"

# The app's own settings (email, PostgreSQL, S3 ...): yours to edit, never overwritten.
if [ ! -f "$DIR/app.env" ]; then
  cat >"$DIR/app.env" <<'EOF'
# Settings of the app (see docs/SELF-HOSTING.md). After editing: cd <this folder> && docker compose up -d
# Email (optional; without it people sign in with a password and invitation links are copied):
# EMAIL_FROM=noreply@example.com
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
# PostgreSQL instead of the embedded database (decide before you add a lot of data):
# DATABASE_URL=postgres://user:password@host:5432/db
EOF
fi

COMPOSE_OWNER=""
[ -z "$OWNER_EMAIL" ] || COMPOSE_OWNER="      SEED_ADMIN_EMAIL: \"$OWNER_EMAIL\""
cat >"$DIR/docker-compose.yml" <<EOF
# Written by install.sh — run it again rather than editing (your settings go in app.env).
name: bines-os
services:
  app:
    image: $RUN_IMAGE
    restart: unless-stopped
    env_file: [app.env]
    environment:
      WEB_ORIGIN: "https://$DOMAIN$([ "$HTTPS_PORT" = 443 ] || printf ':%s' "$HTTPS_PORT")"
      TRUST_PROXY: "1"
$COMPOSE_OWNER
    volumes:
      - data:/data
  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on: [app]
    ports:
      - "$HTTP_PORT:$HTTP_PORT"
      - "$HTTPS_PORT:$HTTPS_PORT"
      - "$HTTPS_PORT:$HTTPS_PORT/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
volumes:
  data:
  caddy_data:
  caddy_config:
EOF
sed -i '/^$/d' "$DIR/docker-compose.yml"

{
  printf '{\n'
  [ -z "$ACME_EMAIL" ] || printf '\temail %s\n' "$ACME_EMAIL"
  # The same ports inside and out, so redirects and certificates name the port people use.
  [ "$HTTP_PORT" = 80 ] || printf '\thttp_port %s\n' "$HTTP_PORT"
  [ "$HTTPS_PORT" = 443 ] || printf '\thttps_port %s\n' "$HTTPS_PORT"
  printf '}\n\n%s {\n' "$DOMAIN"
  [ "$TLS" = internal ] && printf '\ttls internal\n'
  printf '\tencode zstd gzip\n\treverse_proxy app:3000\n}\n'
} >"$DIR/Caddyfile"

# ---------------------------------------------------------------------------------------------------- backup
cat >"$DIR/backup.sh" <<'EOF'
#!/usr/bin/env bash
# Daily backup (written by install.sh): stops the app for a few seconds — the embedded database is copied
# consistently only while stopped — archives the data volume (database, files, secrets.json) into backups/, starts the
# app again whatever happens, and keeps the newest BACKUP_KEEP archives. Restore: see docs/SELF-HOSTING.md.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./install.env
STAMP="$(date +%F-%H%M)"
trap 'docker compose start app >/dev/null' EXIT
docker compose stop app >/dev/null
docker run --rm --user 0 --entrypoint tar -v bines-os_data:/data:ro -v "$PWD/backups":/backup "$IMAGE" \
  czf "/backup/bines-data-$STAMP.tgz" -C /data .
chmod 600 "backups/bines-data-$STAMP.tgz"
ls -1t backups/bines-data-*.tgz | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
echo "backup: backups/bines-data-$STAMP.tgz"
EOF
chmod 700 "$DIR/backup.sh"

if [ "$BACKUP_KEEP" -gt 0 ]; then
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    cat >/etc/systemd/system/bines-os-backup.service <<EOF
[Unit]
Description=Bines OS daily backup of /data
Requires=docker.service
After=docker.service
[Service]
Type=oneshot
ExecStart=$DIR/backup.sh
EOF
    cat >/etc/systemd/system/bines-os-backup.timer <<EOF
[Unit]
Description=Bines OS daily backup
[Timer]
OnCalendar=*-*-* $BACKUP_TIME:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now bines-os-backup.timer >/dev/null
    BACKUP_NOTE="daily at $BACKUP_TIME (systemd timer bines-os-backup), the newest $BACKUP_KEEP kept"
  elif [ -d /etc/cron.d ]; then
    printf '%s %s * * * root %s >>%s/backups/backup.log 2>&1\n' "${BACKUP_TIME#*:}" "${BACKUP_TIME%:*}" "$DIR/backup.sh" "$DIR" \
      >/etc/cron.d/bines-os-backup
    BACKUP_NOTE="daily at $BACKUP_TIME (cron), the newest $BACKUP_KEEP kept"
  else
    BACKUP_NOTE="NOT scheduled (no systemd or cron here): run $DIR/backup.sh yourself"
    warn "no systemd or cron: the daily backup is not scheduled"
  fi
else
  rm -f /etc/systemd/system/bines-os-backup.timer /etc/systemd/system/bines-os-backup.service /etc/cron.d/bines-os-backup
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload 2>/dev/null || true; fi
  BACKUP_NOTE="off (--backup-keep 0)"
fi

# ---------------------------------------------------------------------------------------------------- start
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say "the firewall (ufw) is on: opening ports $HTTP_PORT and $HTTPS_PORT"
  ufw allow "$HTTP_PORT/tcp" >/dev/null
  ufw allow "$HTTPS_PORT/tcp" >/dev/null
fi
if [ "$TLS" = auto ]; then
  # Let's Encrypt checks the domain from outside: a DNS record pointing elsewhere is the usual first-install problem.
  RESOLVED="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  [ -n "$RESOLVED" ] || warn "$DOMAIN does not resolve yet: point its DNS to this server; the certificate is issued once it does"
fi

say "starting"
docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" up -d --remove-orphans
for _ in $(seq 1 90); do
  STATE="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" ps -q app)" 2>/dev/null || true)"
  [ "$STATE" = healthy ] && break
  sleep 2
done
[ "$STATE" = healthy ] || die "the app did not become healthy: docker compose --project-directory $DIR logs app"

URL="https://$DOMAIN$([ "$HTTPS_PORT" = 443 ] || printf ':%s' "$HTTPS_PORT")"
cat <<EOF

  Bines OS is running.

  Open      $URL
            and create the owner account$([ -z "$OWNER_EMAIL" ] && printf ' — right away: until then whoever opens it first becomes the owner' || printf ' with %s' "$OWNER_EMAIL")
  Folder    $DIR   (settings: app.env; then: docker compose up -d)
  Backups   $DIR/backups — $BACKUP_NOTE
  Upgrade   run this installer again
  Logs      cd $DIR && docker compose logs -f

EOF
