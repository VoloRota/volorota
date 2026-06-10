#!/usr/bin/env bash
# scripts/volume-persistence-test.sh
# ISC-4: Verify that data created in a VoloRota container survives container destruction and re-creation.
#
# Uses a named Docker volume. SQLite operations run inside the container via docker exec,
# which avoids host filesystem permission issues and matches real deployment behaviour.
#
# Usage: bash scripts/volume-persistence-test.sh [image-tag]
# Default image tag: volorota:latest
#
# Requirements: docker, curl
# Exit 0 = PASS, exit 1 = FAIL

set -euo pipefail

IMAGE="${1:-volorota:latest}"
CONTAINER="volorota-persist-$$"
VOLUME="volorota-persist-vol-$$"
PORT=13742
TIMEOUT=20

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker volume rm "$VOLUME"  2>/dev/null || true
}
trap cleanup EXIT

echo "[persistence-test] image=$IMAGE  volume=$VOLUME  port=$PORT"

# ---- build if needed ----
if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
  echo "[persistence-test] Image not found; building..."
  docker build -t "$IMAGE" "$(dirname "$0")/.."
fi

# Helper: start the container
start_container() {
  docker run -d \
    --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:3000" \
    -v "${VOLUME}:/data" \
    -e VOLOROTA_DB=/data/volorota.db \
    -e VOLOROTA_ADMIN_PASSWORD=test-only-password \
    "$IMAGE"
}

# Helper: wait for /health
wait_ready() {
  local label="$1"
  echo "[persistence-test] Waiting for ${label} to be ready..."
  for i in $(seq 1 $TIMEOUT); do
    if curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1; then
      echo "[persistence-test] ${label} ready after ${i}s"
      return 0
    fi
    sleep 1
  done
  echo "[persistence-test] FAIL: ${label} did not become ready in ${TIMEOUT}s"
  docker logs "$CONTAINER" 2>&1 | tail -20
  return 1
}

# Helper: run a bun SQLite snippet inside the running container
exec_sql() {
  docker exec "$CONTAINER" bun --eval "$1" 2>&1
}

# ---- start first container ----
echo "[persistence-test] Starting first container..."
start_container
wait_ready "first container"

# Trigger DB initialisation
curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null

SEED_EMAIL="alice-persist-$$@example.com"
echo "[persistence-test] Seeding person: ${SEED_EMAIL}"

exec_sql "
  import { Database } from 'bun:sqlite';
  const db = new Database(process.env.VOLOROTA_DB ?? '/data/volorota.db');
  db.exec(\"INSERT OR IGNORE INTO people (name, email) VALUES ('Alice Persistence', '${SEED_EMAIL}')\");
  db.close();
"

PRE_COUNT=$(exec_sql "
  import { Database } from 'bun:sqlite';
  const db = new Database(process.env.VOLOROTA_DB ?? '/data/volorota.db');
  const row = db.query(\"SELECT COUNT(*) as c FROM people WHERE email='${SEED_EMAIL}'\").get();
  process.stdout.write(String(row.c) + '\n');
  db.close();
" | tr -d '[:space:]')

if [ "$PRE_COUNT" != "1" ]; then
  echo "[persistence-test] FAIL: Seed write did not land (count=${PRE_COUNT})"
  exit 1
fi
echo "[persistence-test] Pre-destroy count: ${PRE_COUNT} — OK"

# ---- destroy container ----
echo "[persistence-test] Destroying container..."
docker rm -f "$CONTAINER"

# ---- restart with same volume ----
echo "[persistence-test] Re-creating container with same volume..."
start_container
wait_ready "second container"

# ---- verify data survived ----
POST_COUNT=$(exec_sql "
  import { Database } from 'bun:sqlite';
  const db = new Database(process.env.VOLOROTA_DB ?? '/data/volorota.db');
  const row = db.query(\"SELECT COUNT(*) as c FROM people WHERE email='${SEED_EMAIL}'\").get();
  process.stdout.write(String(row.c) + '\n');
  db.close();
" | tr -d '[:space:]')

if [ "$POST_COUNT" != "1" ]; then
  echo "[persistence-test] FAIL: Data did not survive container recreation (count=${POST_COUNT})"
  exit 1
fi
echo "[persistence-test] Post-recreate count: ${POST_COUNT} — PASS"

# ---- verify /health still responds ----
HEALTH_BODY=$(curl -sf "http://127.0.0.1:${PORT}/health")
echo "[persistence-test] /health response: ${HEALTH_BODY}"
if ! echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  echo "[persistence-test] FAIL: /health did not return status:ok after recreation"
  exit 1
fi

echo "[persistence-test] ISC-4 PASS — data intact after container recreation"
