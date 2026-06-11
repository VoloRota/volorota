#!/usr/bin/env bash
# Reset the VoloRota demo to its seed state. Run from deploy/demo/.
# Wired to a systemd timer (volorota-demo-reset.timer) for hourly resets.
set -euo pipefail
cd "$(dirname "$0")"

# Load env (DEMO_TOKEN_*, VOLOROTA_ADMIN_PASSWORD, DEMO_DOMAIN)
set -a; source ./.env; set +a

COMPOSE="docker compose"
VOLUME="demo_volorota-demo-data"

echo "[reset] $(date -Is) stopping app + wiping demo volume"
$COMPOSE rm -sf volorota >/dev/null
docker volume rm "$VOLUME" >/dev/null 2>&1 || true

echo "[reset] starting fresh"
$COMPOSE up -d volorota >/dev/null
sleep 3

echo "[reset] seeding"
docker compose cp ./seed.ts volorota:/tmp/seed.ts
$COMPOSE exec -T \
  -e VOLOROTA_DB=/data/volorota.db \
  -e DEMO_TOKEN_DAVID="${DEMO_TOKEN_DAVID:-}" \
  -e DEMO_TOKEN_TOM="${DEMO_TOKEN_TOM:-}" \
  -e DEMO_TOKEN_GRACE="${DEMO_TOKEN_GRACE:-}" \
  volorota bun /tmp/seed.ts

echo "[reset] rendering landing page"
mkdir -p ./landing
sed -e "s|\${DEMO_TOKEN_DAVID}|${DEMO_TOKEN_DAVID:-}|g" \
    -e "s|\${DEMO_TOKEN_TOM}|${DEMO_TOKEN_TOM:-}|g" \
    -e "s|\${DEMO_TOKEN_GRACE}|${DEMO_TOKEN_GRACE:-}|g" \
    ./landing.template.html > ./landing/index.html

echo "[reset] done"
