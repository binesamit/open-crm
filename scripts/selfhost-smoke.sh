#!/usr/bin/env bash
# Self-hosting smoke test (CI job "self-host"; also runs locally with Docker):
# builds the image, starts docker-compose.prod.yml from a fresh .env (generated secrets, no real values),
# waits for GET /api/v1/health = 200, checks the worker and the release ran, then tears everything down
# (volumes included). Refuses to touch an existing .env.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -p bines-os-smoke -f docker-compose.prod.yml)
PORT="${SMOKE_PORT:-3300}"
MINIO="${SMOKE_MINIO_PORT:-9300}"

if [ -e .env ]; then
  echo "selfhost-smoke: .env already exists - refusing to overwrite it (run in a clean checkout)" >&2
  exit 1
fi

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- compose ps ----"; "${COMPOSE[@]}" ps -a || true
    echo "---- logs ----"; "${COMPOSE[@]}" logs --no-color --tail 200 || true
  fi
  if [ "$status" -eq 0 ] && [ "${SMOKE_KEEP:-}" = 1 ]; then
    echo "selfhost-smoke: SMOKE_KEEP=1 - left running; stop with: ${COMPOSE[*]} down -v && rm .env"
    exit 0
  fi
  "${COMPOSE[@]}" down -v --remove-orphans || true
  rm -f .env
  exit "$status"
}
trap cleanup EXIT

# The quick start: copy the example, fill in the self-hosting section.
cp .env.example .env
set_var() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; }
set_var ADMIN_EMAIL admin@example.com
set_var AUTH_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
set_var SECRET_MASTER_KEY "$(openssl rand -base64 32 | tr -d '\n')"
set_var POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_var STORAGE_SECRET_KEY "$(openssl rand -hex 24)"
set_var APP_URL "http://localhost:${PORT}"
set_var APP_PORT "${PORT}"
set_var MINIO_PORT "${MINIO}"
set_var STORAGE_PUBLIC_URL "http://localhost:${MINIO}"

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up -d --build

echo "selfhost-smoke: waiting for http://localhost:${PORT}/api/v1/health"
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/api/v1/health" || true)"
  if [ "$code" = "200" ]; then
    echo "selfhost-smoke: health 200 after ~$((i * 2))s"
    break
  fi
  if [ "$i" = 90 ]; then
    echo "selfhost-smoke: health never answered 200 (last: $code)" >&2
    exit 1
  fi
  sleep 2
done

# The SPA is served by the api on the same origin.
curl -fsS "http://localhost:${PORT}/" | grep -i '<div id="root"' >/dev/null || { echo "selfhost-smoke: SPA not served" >&2; exit 1; }

# The one-shot release succeeded and the worker is up.
"${COMPOSE[@]}" logs migrate | grep 'seed: done' || { echo "selfhost-smoke: release did not finish" >&2; exit 1; }
[ "$("${COMPOSE[@]}" ps --status running --services | grep -cx worker)" = 1 ] || {
  echo "selfhost-smoke: worker is not running" >&2
  exit 1
}

# No email configured: the first administrator gets a link from the terminal.
"${COMPOSE[@]}" exec -T api node dist/first-admin-link.js | grep "localhost:${PORT}/invite/" >/dev/null || {
  echo "selfhost-smoke: first-admin-link printed no invitation link" >&2
  exit 1
}

echo "selfhost-smoke: ok"
