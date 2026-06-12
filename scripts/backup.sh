#!/usr/bin/env bash
# scripts/backup.sh — WAL-safe SQLite backup for a running VoloRota container.
#
# Usage:
#   ./scripts/backup.sh [CONTAINER] [OUTPUT_DIR]
#
#   CONTAINER   — Docker container name or ID (default: volorota)
#   OUTPUT_DIR  — Host directory to write the backup file (default: ./backups)
#
# The backup is taken with SQLite's VACUUM INTO, which is fully WAL-safe and
# produces a defragmented, fully-checkpointed copy — even while VoloRota is
# running and accepting writes.  The output file has no -wal or -shm companion
# and can be restored directly.
#
# Restore procedure (also documented in docs/production.md):
#   1. docker compose stop (or docker stop volorota)
#   2. Copy the .db backup over /data/volorota.db inside the volume:
#        docker cp backup-<ts>.db volorota:/data/volorota.db
#   3. Remove any stale WAL/SHM files left from the old database:
#        docker run --rm -v volorota_data:/data busybox \
#          sh -c 'rm -f /data/volorota.db-wal /data/volorota.db-shm'
#   4. docker compose start (or docker start volorota)
#   5. Spot-check: curl http://localhost:3000/health
#
# Test your restore before you need it — a backup you have never tested is not
# a backup.
#
# Cron example (daily at 02:00, 30-day retention):
#   0 2 * * * /path/to/volorota/scripts/backup.sh volorota /var/backups/volorota \
#     && find /var/backups/volorota -name '*.db' -mtime +30 -delete

set -euo pipefail

CONTAINER="${1:-volorota}"
OUTPUT_DIR="${2:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILENAME="backup-${TIMESTAMP}.db"
CONTAINER_BACKUP_PATH="/data/${BACKUP_FILENAME}"

echo "[backup] Container : ${CONTAINER}"
echo "[backup] Output dir: ${OUTPUT_DIR}"
echo "[backup] Filename  : ${BACKUP_FILENAME}"

# Ensure output directory exists on the host
mkdir -p "${OUTPUT_DIR}"

# Run VACUUM INTO inside the container via Bun (bun:sqlite).
# This avoids the sqlite3 CLI dependency — the container ships Bun but not sqlite3.
docker exec "${CONTAINER}" \
  bun -e "
    import { Database } from 'bun:sqlite';
    const src = process.env.VOLOROTA_DB ?? '/data/volorota.db';
    const dst = '${CONTAINER_BACKUP_PATH}';
    const db = new Database(src, { readonly: true });
    db.exec('VACUUM INTO \`' + dst + '\`');
    db.close();
    console.log('[backup] VACUUM INTO completed: ' + dst);
  "

# Copy the backup from the container to the host
docker cp "${CONTAINER}:${CONTAINER_BACKUP_PATH}" "${OUTPUT_DIR}/${BACKUP_FILENAME}"

# Remove the temporary copy from the container
docker exec "${CONTAINER}" rm -f "${CONTAINER_BACKUP_PATH}"

echo "[backup] Done: ${OUTPUT_DIR}/${BACKUP_FILENAME}"
