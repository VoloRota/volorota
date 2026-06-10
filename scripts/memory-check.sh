#!/usr/bin/env bash
# scripts/memory-check.sh
# ISC-6: Verify container RSS stays ≤ 256 MB under fixture load.
#
# Seeds ~50 people / 8 teams / 12 weeks of service instances inside the container
# via docker exec + bun:sqlite, then hits several pages in a loop while capturing
# docker stats --no-stream.
#
# Usage: bash scripts/memory-check.sh [image-tag]
# Default image tag: volorota:latest
# Exit 0 = PASS (≤256 MB), exit 1 = FAIL
#
# Requirements: docker, curl

set -euo pipefail

IMAGE="${1:-volorota:latest}"
CONTAINER="volorota-memcheck-$$"
VOLUME="volorota-memcheck-vol-$$"
PORT=13743
TIMEOUT=20
MEM_LIMIT_MB=256

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker volume rm "$VOLUME"  2>/dev/null || true
}
trap cleanup EXIT

echo "[memory-check] image=$IMAGE  limit=${MEM_LIMIT_MB}MB"

# ---- build if needed ----
if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
  echo "[memory-check] Building image..."
  docker build -t "$IMAGE" "$(dirname "$0")/.."
fi

# ---- start container ----
docker run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:3000" \
  -v "${VOLUME}:/data" \
  -e VOLOROTA_DB=/data/volorota.db \
  "$IMAGE"

# Wait for ready
echo "[memory-check] Waiting for app readiness..."
for i in $(seq 1 $TIMEOUT); do
  if curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1; then
    echo "[memory-check] App ready after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" -eq "$TIMEOUT" ]; then
    echo "[memory-check] FAIL: App did not start"
    docker logs "$CONTAINER"
    exit 1
  fi
done

# Hit /health once to ensure DB file is created by the app
curl -sf "http://127.0.0.1:${PORT}/health" > /dev/null

# ---- seed fixtures inside the container ----
echo "[memory-check] Seeding fixtures inside container..."
docker exec "$CONTAINER" bun --eval "
  import { Database } from 'bun:sqlite';
  const db = new Database(process.env.VOLOROTA_DB ?? '/data/volorota.db');

  // 50 people
  const insertPerson = db.prepare('INSERT OR IGNORE INTO people (name, email) VALUES (?, ?)');
  for (let i = 1; i <= 50; i++) {
    insertPerson.run('Person ' + i, 'person' + i + '-mem@example.com');
  }

  // 8 teams
  const insertTeam = db.prepare('INSERT OR IGNORE INTO teams (name) VALUES (?)');
  for (let t = 1; t <= 8; t++) {
    insertTeam.run('Team ' + t);
  }

  // 12 weeks × 2 services/week via services table if it has service_date column
  const cols = db.query('PRAGMA table_info(services)').all();
  const colNames = cols.map((c) => c.name);
  let svcCount = 0;
  if (colNames.includes('service_date')) {
    const insertSvc = db.prepare('INSERT OR IGNORE INTO services (service_date, notes) VALUES (?, ?)');
    const base = new Date('2026-01-04');
    for (let w = 0; w < 12; w++) {
      for (const d of [0, 3]) {
        const dt = new Date(base);
        dt.setDate(base.getDate() + w * 7 + d);
        insertSvc.run(dt.toISOString().slice(0, 10), 'Week ' + w + ' service');
        svcCount++;
      }
    }
  }
  console.log('Seeded 50 people, 8 teams, ' + svcCount + ' services');
  db.close();
" 2>&1

# ---- load phase: hit pages in a loop ----
echo "[memory-check] Running load loop (30 iterations across pages)..."
PAGES=("/health" "/admin" "/admin/people" "/admin/teams" "/admin/templates" "/admin/services")
for i in $(seq 1 30); do
  for page in "${PAGES[@]}"; do
    curl -sf "http://127.0.0.1:${PORT}${page}" -o /dev/null || true
  done
done

# ---- capture memory ----
echo "[memory-check] Capturing docker stats..."
STATS=$(docker stats --no-stream --format "{{.MemUsage}}" "$CONTAINER")
echo "[memory-check] Raw stats output: ${STATS}"

# Parse the used value (format: "12.3MiB / 1GiB")
USED_RAW=$(echo "$STATS" | awk '{print $1}')
echo "[memory-check] Memory used: ${USED_RAW}"

# Convert to integer MiB (handle GiB, MiB, KiB, kB)
if echo "$USED_RAW" | grep -qi "GiB"; then
  USED_MB=$(echo "$USED_RAW" | sed 's/GiB//I' | awk '{printf "%d", $1 * 1024}')
elif echo "$USED_RAW" | grep -qi "MiB"; then
  USED_MB=$(echo "$USED_RAW" | sed 's/MiB//I' | awk '{printf "%d", $1}')
elif echo "$USED_RAW" | grep -qi "kB\|KiB"; then
  USED_MB=$(echo "$USED_RAW" | sed 's/[kKiIbB]//g' | awk '{printf "%d", $1 / 1024}')
else
  USED_MB=$(echo "$USED_RAW" | sed 's/[^0-9.]//g' | awk '{printf "%d", $1 / 1048576}')
fi

echo "[memory-check] Parsed usage: ${USED_MB} MB (limit: ${MEM_LIMIT_MB} MB)"

if [ "$USED_MB" -le "$MEM_LIMIT_MB" ]; then
  echo "[memory-check] ISC-6 PASS — ${USED_MB} MB ≤ ${MEM_LIMIT_MB} MB"
else
  echo "[memory-check] ISC-6 FAIL — ${USED_MB} MB > ${MEM_LIMIT_MB} MB"
  exit 1
fi
