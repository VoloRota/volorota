# VoloRota

**A roster of the willing.** Self-hosted volunteer scheduling for churches.

VoloRota lets a church administrator define teams, roles, and recurring services, then auto-fills a fair rotation that honours blackout dates. Volunteers accept, decline, or arrange their own replacement from a phone — no account required, just a magic link in an email.

Deployable from `docker run` to first published schedule in well under 30 minutes on a 1 GB VPS.

Licensed under [AGPL-3.0](LICENSE).

---

## Feature State (Early Development)

| Feature | Status |
|---------|--------|
| Data layer (people, teams, roles, templates, services) | Done |
| Admin UI scaffolding | Done |
| CSV people import | Done |
| Authentication (admin password gate) | Done |
| Volunteer flow (magic-link accept/decline/swap) | Planned |
| Auto-rotation scheduler | Planned |
| Email notifications (SMTP) | Planned |
| Demo instance | Planned |

The data layer is fully functional. You can define your complete roster today; the scheduling and volunteer-facing features land in subsequent releases.

---

## Quickstart

### Option A — Docker one-liner

```bash
docker run -d \
  --name volorota \
  -p 3000:3000 \
  -v volorota_data:/data \
  -e VOLOROTA_PORT=3000 \
  -e VOLOROTA_ADMIN_PASSWORD='pick-a-strong-password' \
  volorota:latest
```

Open `http://localhost:3000` in a browser and sign in at the login page with the password you set. `VOLOROTA_ADMIN_PASSWORD` is required — the server refuses to start without it.

### Option B — Docker Compose (recommended for self-hosting)

```bash
git clone https://github.com/your-org/volorota.git
cd volorota

# Build the image
docker compose build

# Start
docker compose up -d
```

Open `http://localhost:3000`.

### First-Schedule Walkthrough

Work through these steps in order. Each step takes 2–5 minutes; the whole walkthrough is designed to complete in under 30 minutes.

**Step 1 — Add your people (2–5 min)**

Navigate to **Admin → People → Import CSV**.

Prepare a CSV with columns `name` and `email` (header row required):

```
name,email
Alice Smith,alice@example.com
Bob Jones,bob@example.com
Carol White,carol@example.com
```

Upload the file. Every row creates a volunteer record. You can also add people one at a time via the form on the same page.

**Step 2 — Create a team and define roles (3–5 min)**

Navigate to **Admin → Teams → New Team**.

Give the team a name (e.g., "Sunday Morning Worship"). Then add roles to the team — these are the slots that appear in the rotation (e.g., "Worship Leader", "Guitarist", "Sound Tech").

Assign volunteers to each role from your people list.

**Step 3 — Create a service template (3–5 min)**

Navigate to **Admin → Templates → New Template**.

A template defines what roles are needed for a recurring service (e.g., every Sunday needs 1 Worship Leader, 1 Guitarist, 2 Sound Techs). Link the template to your team and specify the required roles and counts.

**Step 4 — Generate service instances (2–3 min)**

Navigate to **Admin → Services → Generate**.

Pick the template, select a date range (e.g., the next 12 weeks), and generate. VoloRota creates one service record per occurrence.

**Step 5 — Review the schedule (1–2 min)**

Navigate to **Admin → Services** to see the generated schedule. From here you can view assignments, make manual adjustments, and (once the auto-scheduler ships) trigger a fair-rotation fill.

You now have a published schedule. Total time: ~15 minutes for a typical roster.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLOROTA_PORT` | `3000` (falls back to `PORT`) | Listening port |
| `VOLOROTA_DB` | `./data/volorota.db` (host), `/data/volorota.db` (container) | SQLite database path |
| `VOLOROTA_ADMIN_PASSWORD` | — | **Required.** Admin console password; server refuses to start without it |
| `VOLOROTA_SESSION_SECRET` | auto | Optional session-signing secret (≥32 chars); generated and persisted in the DB if unset |
| `VOLOROTA_SESSION_SECRET` | — | *(arriving with Auth feature)* Cookie signing secret |
| `VOLOROTA_SMTP_HOST` | — | *(arriving with Notifications feature)* SMTP relay host |
| `VOLOROTA_SMTP_PORT` | — | SMTP port |
| `VOLOROTA_SMTP_USER` | — | SMTP username |
| `VOLOROTA_SMTP_PASS` | — | SMTP password |

All persistent state lives under one directory (`/data` in-container). Mount a Docker volume there and your data survives container recreation.

---

## Development Setup

**Prerequisites:** [Bun](https://bun.sh) >= 1.1

```bash
git clone https://github.com/your-org/volorota.git
cd volorota
bun install
```

**Run in dev mode (hot reload):**

```bash
bun run dev
```

**Run tests:**

```bash
bun test
```

**Type-check:**

```bash
bunx tsc --noEmit
```

**Build and run the Docker image locally:**

```bash
docker build -t volorota:latest .
docker run --rm -p 3000:3000 -v volorota_data:/data volorota:latest
```

---

## Health Check

`GET /health` returns JSON and is suitable for container health probes:

```json
{"status":"ok","version":"0.1.0"}
```

Response time is typically < 10 ms.

---

## Data Persistence

VoloRota uses SQLite in WAL mode. All data lives in a single file at `VOLOROTA_DB`. When running in Docker, mount a named volume at `/data`:

```bash
-v volorota_data:/data
```

Destroying the container and re-creating it with the same volume restores all data exactly.

---

## License

VoloRota is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License v3.0](LICENSE) as published by the Free Software Foundation.
