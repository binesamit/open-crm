#!/usr/bin/env bash
# One-minute install smoke test (CI job "quickstart"; also runs locally with Docker): the n8n-style quick start
#   docker run -it --rm -p 3000:3000 -v bines_data:/data <image>
# on a fresh volume and on another host port (so the first-run setup must take the address it was opened at). It waits
# for /api/v1/health, creates the owner in the first-run setup, signs in with the password, creates a board and an
# item, uploads a small file and downloads it back, restarts the container and checks everything is still there.
# Removes the container and the volume afterwards. Needs docker, curl and node.
#   SMOKE_IMAGE=<tag>  use an image already built (default: build docker/Dockerfile as bines-os:quickstart-smoke)
#   SMOKE_PORT=<port>  the host port (default 3310)        SMOKE_KEEP=1  leave it running
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${SMOKE_PORT:-3310}"
IMAGE="${SMOKE_IMAGE:-bines-os:quickstart-smoke}"
NAME="bines-quickstart-smoke-$$"
VOLUME="bines-quickstart-smoke-$$"
BASE="http://localhost:${PORT}"
WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- container logs ----"
    docker logs --tail 200 "$NAME" 2>&1 || true
  fi
  if [ "$status" -eq 0 ] && [ "${SMOKE_KEEP:-}" = 1 ]; then
    echo "quickstart-smoke: SMOKE_KEEP=1 - left running at $BASE; stop with: docker rm -f $NAME && docker volume rm $VOLUME"
    exit 0
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "quickstart-smoke: $*" >&2
  exit 1
}
# Reads a field of the JSON on stdin (a dotted path; arrays by index): json data.0.id
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];if(v===undefined)process.exit(3);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
api() { # api METHOD PATH [JSON] [ACCOUNT_ID]
  curl -fsS -b "$JAR" -c "$JAR" -X "$1" -H "origin: $BASE" -H 'content-type: application/json' \
    ${4:+-H "x-account-id: $4"} ${3:+--data "$3"} "$BASE/api/v1$2"
}
wait_healthy() {
  for i in $(seq 1 90); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/health" || true)" = 200 ]; then
      echo "quickstart-smoke: health 200 after ~$((i * 2))s"
      return 0
    fi
    sleep 2
  done
  fail "health never answered 200"
}
start() { docker run -d --name "$NAME" -p "${PORT}:3000" -v "${VOLUME}:/data" "$IMAGE" >/dev/null; }

if [ -z "${SMOKE_IMAGE:-}" ]; then docker build -f docker/Dockerfile -t "$IMAGE" .; fi

# 1. The quick start itself: no variables, a fresh volume.
start
wait_healthy
curl -fsS "$BASE/" | grep -i '<div id="root"' >/dev/null || fail "SPA not served"
[ "$(api GET /setup | json required)" = true ] || fail "a new installation should ask for the owner account"
[ "$(curl -fsS "$BASE/api/v1/auth/config" | json magic_link)" = false ] || fail "email is off: no sign-in link offered"

# 2. First-run setup in the browser's place: the owner, signed in by the answer.
OWNER='{"email":"owner@example.com","password":"correct-horse-battery","name":"Owner","product_name":"Smoke Works","locale":"en"}'
ACCOUNT="$(api POST /setup "$OWNER" | json account.id)" || fail "setup failed"
[ "$(api GET /setup | json required)" = false ] || fail "setup should be closed now"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "origin: $BASE" -H 'content-type: application/json' \
  --data '{"email":"x@example.com","password":"correct-horse-battery","name":"X"}' "$BASE/api/v1/setup")"
[ "$code" = 409 ] || fail "a second setup must be refused (got $code)"

# 3. A fresh sign-in with the password (a new cookie jar).
rm -f "$JAR"
curl -fsS -c "$JAR" -X POST -H "origin: $BASE" -H 'content-type: application/json' \
  --data '{"email":"owner@example.com","password":"correct-horse-battery"}' "$BASE/api/auth/sign-in/email" >/dev/null ||
  fail "password sign-in failed"
[ "$(api GET /auth/me | json user.is_platform_owner)" = true ] || fail "the owner is not the platform owner"

# 4. A board, an item, a file.
WORKSPACE="$(api GET /workspaces '' "$ACCOUNT" | json data.0.id)"
BOARD="$(api POST /boards "{\"name\":\"Smoke board\",\"workspace_id\":\"$WORKSPACE\"}" "$ACCOUNT" | json id)"
ITEM="$(api POST "/boards/$BOARD/items" '{"name":"First item"}' "$ACCOUNT" | json id)"
printf 'quickstart smoke file\n' >"$WORK/hello.txt"
SIZE="$(wc -c <"$WORK/hello.txt" | tr -d ' ')"
PRE="$(api POST /files/presign "{\"name\":\"hello.txt\",\"size\":$SIZE,\"mime\":\"text/plain\"}" "$ACCOUNT")"
FILE="$(echo "$PRE" | json file_id)"
UPLOAD="$(echo "$PRE" | json upload_url)"
case "$UPLOAD" in "$BASE/"*) ;; *) fail "upload link is not on the address the owner opened: $UPLOAD" ;; esac
curl -fsS -X PUT -H 'content-type: text/plain' --data-binary @"$WORK/hello.txt" "$UPLOAD" >/dev/null || fail "upload failed"
api POST "/files/$FILE/complete" '{}' "$ACCOUNT" >/dev/null || fail "upload did not complete"
DOWNLOAD="$(api GET "/files/$FILE" '' "$ACCOUNT" | json download_url)"
curl -fsS "$DOWNLOAD" -o "$WORK/back.txt" || fail "download failed"
cmp -s "$WORK/hello.txt" "$WORK/back.txt" || fail "the downloaded file differs"

# 5. The secrets were made and kept private; restarting keeps everything.
MODE="$(docker exec "$NAME" node -e "console.log((require('fs').statSync('/data/secrets.json').mode & 0o777).toString(8))")"
[ "$MODE" = 600 ] || fail "secrets.json should be 0600 (is $MODE)"
docker logs "$NAME" 2>&1 | grep -q 'BETTER_AUTH_SECRET"' || fail "secret names should be logged once"
SECRET="$(docker exec "$NAME" node -e "console.log(require('/data/secrets.json').BETTER_AUTH_SECRET)")"
docker logs "$NAME" 2>&1 | grep -qF -- "$SECRET" &&
  fail "a secret value reached the log"
docker rm -f "$NAME" >/dev/null
start
wait_healthy
[ "$(api GET /setup | json required)" = false ] || fail "after a restart the setup must stay closed"
[ "$(api GET "/boards/$BOARD/items" '' "$ACCOUNT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.includes(process.argv[1])))' "$ITEM")" = true ] ||
  fail "the item is gone after a restart"
curl -fsS "$(api GET "/files/$FILE" '' "$ACCOUNT" | json download_url)" | cmp -s - "$WORK/hello.txt" ||
  fail "the file is gone after a restart"

echo "quickstart-smoke: ok"
