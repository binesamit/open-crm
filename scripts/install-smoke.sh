#!/usr/bin/env bash
# Server installer smoke test (CI job "installer"): runs scripts/install.sh on a clean Linux machine
# as a server owner would — no questions (--yes), Caddy's internal CA instead of Let's Encrypt (a CI runner has no
# public DNS name) — then checks it from OUTSIDE the installation: from this machine's network address and from a
# separate container that is not on the installation's network. HTTP redirects to HTTPS, health and the web app over
# HTTPS, the owner lock (only the named address may create the owner), sign-in with a secure cookie, a board, the
# backup (an archive, the app healthy again, the timer scheduled), and an upgrade (running the installer again keeps
# the data). Needs root (sudo), docker and curl; removes everything it made unless SMOKE_KEEP=1.
#   SMOKE_IMAGE=<tag>   install this image (--image) instead of building from the checkout
set -euo pipefail

cd "$(dirname "$0")/.."
DOMAIN="${SMOKE_DOMAIN:-bines-smoke.test}"
DIR="${SMOKE_DIR:-/opt/bines-smoke}"
OWNER='owner@example.com'
PASSWORD='correct-horse-battery'
WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
SUDO=""
[ "$(id -u)" = 0 ] || SUDO="sudo"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- installation logs ----"
    $SUDO docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" logs --tail 150 2>&1 || true
  fi
  if [ "${SMOKE_KEEP:-}" != 1 ]; then
    $SUDO docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" down -v >/dev/null 2>&1 || true
    $SUDO systemctl disable --now bines-os-backup.timer >/dev/null 2>&1 || true
    $SUDO rm -rf "$DIR" /etc/systemd/system/bines-os-backup.* /etc/cron.d/bines-os-backup || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "install-smoke: $*" >&2
  exit 1
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];if(v===undefined)process.exit(3);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }

# This machine as the outside world sees it: its network address, not the loopback.
HOST_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
[ -n "$HOST_IP" ] || HOST_IP="$(hostname -I | awk '{print $1}')"
[ -n "$HOST_IP" ] || fail "no network address"
BASE="https://$DOMAIN"
c() { curl -sS -k --resolve "$DOMAIN:443:$HOST_IP" --resolve "$DOMAIN:80:$HOST_IP" "$@"; }
api() { # api METHOD PATH [JSON] [ACCOUNT_ID]
  c -f -b "$JAR" -c "$JAR" -X "$1" -H "origin: $BASE" -H 'content-type: application/json' \
    ${4:+-H "x-account-id: $4"} ${3:+--data "$3"} "$BASE/api/v1$2"
}

# 1. The install, as documented — no questions.
$SUDO env ${SMOKE_IMAGE:+BINES_IMAGE="$SMOKE_IMAGE"} bash scripts/install.sh --yes --dir "$DIR" --domain "$DOMAIN" \
  --tls internal --owner-email "$OWNER" --backup-keep 2
for f in docker-compose.yml Caddyfile install.env app.env backup.sh; do $SUDO test -f "$DIR/$f" || fail "$f missing"; done
[ "$($SUDO stat -c %a "$DIR")" = 700 ] || fail "the install folder should be private"
$SUDO grep -qiE 'secret|password' "$DIR/install.env" "$DIR/docker-compose.yml" && fail "no secrets in the installer's files"
PUBLISHED="$($SUDO docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" port app 3000 2>/dev/null || true)"
case "$PUBLISHED" in '' | *:0) ;; *) fail "the app's port must not be published, only the proxy's (got $PUBLISHED)" ;; esac

# 2. From outside: plain HTTP redirects to HTTPS; health and the web app over HTTPS.
code="$(c -o /dev/null -w '%{http_code} %{redirect_url}' "http://$DOMAIN/")"
case "$code" in 30[18]\ https://"$DOMAIN"/*) ;; *) fail "HTTP should redirect to HTTPS (got: $code)" ;; esac
for i in $(seq 1 30); do
  [ "$(c -o /dev/null -w '%{http_code}' "$BASE/api/v1/health" || true)" = 200 ] && break
  [ "$i" = 30 ] && fail "health over HTTPS never answered 200"
  sleep 2
done
c -f "$BASE/" | grep -qi '<div id="root"' || fail "the web app is not served over HTTPS"
# The same from a container on Docker's default network: not the installation's network, not this host's loopback.
docker run --rm --add-host "$DOMAIN:$HOST_IP" curlimages/curl:8.11.1 -fsSk -o /dev/null -w '%{http_code}' \
  "https://$DOMAIN/api/v1/health" | grep -qx 200 || fail "not reachable from another machine's point of view"

# 3. The owner lock: only the named address creates the owner; then sign-in with a secure cookie.
[ "$(api GET /setup | json required)" = true ] || fail "a new installation should ask for the owner account"
code="$(c -o /dev/null -w '%{http_code}' -X POST -H "origin: $BASE" -H 'content-type: application/json' \
  --data "{\"email\":\"intruder@example.com\",\"password\":\"$PASSWORD\",\"name\":\"X\"}" "$BASE/api/v1/setup")"
[ "$code" = 403 ] || fail "another address must not create the owner (got $code)"
ACCOUNT="$(api POST /setup "{\"email\":\"$OWNER\",\"password\":\"$PASSWORD\",\"name\":\"Owner\",\"locale\":\"en\"}" | json account.id)" ||
  fail "setup failed"
rm -f "$JAR"
c -f -D "$WORK/headers" -c "$JAR" -X POST -H "origin: $BASE" -H 'content-type: application/json' \
  --data "{\"email\":\"$OWNER\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/sign-in/email" >/dev/null || fail "sign-in failed"
grep -i '^set-cookie:' "$WORK/headers" | grep -qi 'secure' || fail "the session cookie should be Secure behind HTTPS"
[ "$(api GET /auth/me | json user.is_platform_owner)" = true ] || fail "the owner is not the platform owner"
WORKSPACE="$(api GET /workspaces '' "$ACCOUNT" | json data.0.id)"
BOARD="$(api POST /boards "{\"name\":\"Smoke board\",\"workspace_id\":\"$WORKSPACE\"}" "$ACCOUNT" | json id)"

# 4. The backup: scheduled, makes an archive, and the app is back.
if [ -d /run/systemd/system ]; then
  $SUDO systemctl list-timers --all | grep -q bines-os-backup.timer || fail "the daily backup timer is not scheduled"
fi
$SUDO "$DIR/backup.sh"
ARCHIVE="$($SUDO sh -c "ls -1t '$DIR'/backups/bines-data-*.tgz | head -1")"
$SUDO tar tzf "$ARCHIVE" | grep -q 'secrets.json' || fail "the archive should hold /data (secrets.json)"
for i in $(seq 1 45); do
  [ "$(c -o /dev/null -w '%{http_code}' "$BASE/api/v1/health" || true)" = 200 ] && break
  [ "$i" = 45 ] && fail "the app did not come back after the backup"
  sleep 2
done

# 5. Upgrade: the installer again, no flags — the answers are kept, so is the data.
$SUDO env ${SMOKE_IMAGE:+BINES_IMAGE="$SMOKE_IMAGE"} bash scripts/install.sh --yes --dir "$DIR"
[ "$(api GET /setup | json required)" = false ] || fail "after an upgrade the setup must stay closed"
[ "$(api GET "/boards/$BOARD" '' "$ACCOUNT" | json id)" = "$BOARD" ] || fail "the board is gone after an upgrade"

echo "install-smoke: ok"
