# VoloRota — Production Operations Checklist

Work through this checklist before pointing real volunteers at your instance.
Every item is either a one-time setup or a habit. Each has exactly one action.

---

## Pre-Launch Checklist

### 1. Set `VOLOROTA_BASE_URL`

**Why it matters:** Every emailed link — accept, decline, replacement, blockout,
calendar feed — is built from this URL.  Without it (or with `localhost`), the
links you email your volunteers will not work.

**Action:** In your compose file or `docker run` command, add:

```yaml
environment:
  VOLOROTA_BASE_URL: https://schedule.yourchurch.org
```

The URL must be reachable by your volunteers' devices.  After setting it the
dashboard warning disappears.

---

### 2. Put TLS in front (HTTPS)

**Why it matters:** Volunteer magic links carry authentication tokens.  Without
HTTPS, those tokens travel in plain text.  It also enables the `Secure` cookie
flag that VoloRota sets automatically when `VOLOROTA_BASE_URL` starts with
`https://`.

**Action:** Use a reverse proxy.  The `deploy/demo/` directory contains a
working Caddy example.  Caddy handles certificate renewal automatically:

```caddyfile
schedule.yourchurch.org {
    reverse_proxy localhost:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```

Add the `Strict-Transport-Security` (HSTS) header at the proxy layer as shown —
it tells browsers to enforce HTTPS permanently.

Nginx works equally well; the Caddy example is illustrative, not prescriptive.

---

### 3. Set `VOLOROTA_SESSION_SECRET`

**Why it matters:** Session cookies are signed with this secret.  If it is
unset, VoloRota generates one and persists it in the database — sessions survive
container restarts as long as the volume is intact.  If you ever replace the
volume (e.g., migrating to a new server), the generated secret moves with the
database, so existing sessions remain valid.

**Tradeoff:** Providing your own secret via env gives you a known value you can
back up and restore independently of the database.  Either approach is
acceptable; the generated secret is not weaker cryptographically.

**Action (if you want an explicit secret):**

```bash
openssl rand -hex 32
```

Add the output as:

```yaml
VOLOROTA_SESSION_SECRET: "the-64-hex-char-value-you-just-generated"
```

The value must be at least 32 characters; VoloRota uses the first 32.

---

### 4. Configure SMTP and verify a test send

**Why it matters:** Without SMTP, VoloRota runs in capture mode — no emails
leave the server.  Your volunteers will never receive their magic links.

**Action:** Follow the [Gmail worked example in the README](../README.md#email-setup)
or point the `VOLOROTA_SMTP_*` variables at any standard relay.

After configuring, restart the container, open a service, click
**Notify volunteers**, and confirm delivery in both the recipient's inbox and
`/admin/outbox`.  The capture-mode banner on the dashboard disappears once SMTP
is active.

---

### 5. Back up your database regularly

**Why it matters:** VoloRota stores everything in one SQLite file.  A backup is
the only recovery path from accidental deletion, volume corruption, or migration.

**Action:** Run `scripts/backup.sh` manually first to verify it works, then add
it to cron:

```bash
# Daily at 02:00 — keep 30 days
0 2 * * * /path/to/volorota/scripts/backup.sh volorota /var/backups/volorota \
  && find /var/backups/volorota -name '*.db' -mtime +30 -delete
```

The script uses SQLite's `VACUUM INTO`, which is WAL-safe — it produces a clean
snapshot even while VoloRota is running.

**Test your restore before you need it** (see below).  A backup you have never
tested is not a backup.

#### Restore procedure

1. Stop the container:
   ```bash
   docker compose stop
   ```

2. Copy the backup file into the container's data volume:
   ```bash
   docker cp backup-<timestamp>.db volorota:/data/volorota.db
   ```

3. Remove stale WAL and SHM files from the old database — these are specific to
   the previous database and will corrupt the restored one if left in place:
   ```bash
   docker run --rm -v volorota_data:/data busybox \
     sh -c 'rm -f /data/volorota.db-wal /data/volorota.db-shm'
   ```

4. Start the container:
   ```bash
   docker compose start
   ```

5. Spot-check:
   ```bash
   curl http://localhost:3000/health
   # → {"status":"ok","version":"..."}
   ```

---

## Upgrading VoloRota

VoloRota's database schema changes are **additive** — new columns and tables are
added with `ALTER TABLE ... ADD COLUMN` or equivalent, and every new column has
a default.  Existing data is never altered or dropped by an upgrade.

That said: **back up before every upgrade.**  The procedure is:

1. Run `scripts/backup.sh` and confirm the backup file is on the host.
2. Pull the new image (or `git pull` for source builds):
   ```bash
   # Docker Hub image
   docker pull volorota/volorota:latest

   # Or source rebuild
   git pull && docker compose build
   ```
3. Restart:
   ```bash
   docker compose up -d
   ```
4. Check `/health` and the dashboard.

If anything looks wrong, restore from the pre-upgrade backup using the restore
procedure above.

---

## Proxy Configuration Reference

The headers VoloRota sets in-app (CSP, X-Frame-Options, X-Content-Type-Options,
Referrer-Policy, Permissions-Policy) cover the application layer.  Your reverse
proxy should add the remaining transport-layer header:

| Header | Recommended value | Where to set |
|--------|------------------|-------------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Proxy |

All other security headers are already set by the application.  Do not
duplicate them at the proxy — a consistent single source is easier to audit.
