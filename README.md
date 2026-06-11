# VoloRota

**A roster of the willing.** Self-hosted volunteer scheduling for churches.

VoloRota lets a church administrator define teams, roles, and recurring services, then auto-fills a fair rotation that honours blackout dates. Volunteers accept, decline, or arrange their own replacement from a phone — no account required, just a magic link in an email.

Deployable from `docker run` to first published schedule in well under 30 minutes on a 1 GB VPS.

Licensed under [AGPL-3.0](LICENSE).

---

## Features

- **People, teams, roles** — CSV import, per-member role qualifications (a keys player is never scheduled as a vocalist), team leaders, crews
- **Recurring schedules** — service templates generate instances; published services are never altered by later template edits
- **Auto-fill** — deterministic rotation honoring blockout dates: least-recently-served individuals, or whole-crew rotation ("Crew B has the 2nd Sunday"); no cross-team double-booking; unfillable slots are reported with the reason and a link to fix it
- **Volunteer flow** — magic links by email, no volunteer accounts: accept, decline, pick your own replacement, set blockout dates, subscribe a calendar feed
- **Matrix view** — services × role slots at a glance, color- and symbol-coded
- **Email** — any SMTP relay ([setup guide](#email-setup)); leader notifications on declines and replacements; configurable reminders; capture mode with an in-app outbox when no relay is configured
- **Export** — per-volunteer ICS feeds, CSV export, printable schedules; freeform per-service notes
- **Onboarding** — a setup checklist on fresh installs that retires itself once the first schedule is filled

Deliberately not included: children's check-in, giving, or a member database — VoloRota does scheduling and pairs with whatever ChMS you already use.

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
git clone https://github.com/VoloRota/volorota.git
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
| `VOLOROTA_BASE_URL` | `http://localhost:3000` | **Set this in production.** Public URL of your instance — used in emailed magic links and volunteers' calendar-feed URLs |
| `VOLOROTA_SESSION_SECRET` | auto | Optional session-signing secret (≥32 chars); generated and persisted in the DB if unset |
| `VOLOROTA_SMTP_HOST` | — | SMTP relay host; without it the app runs in capture mode (see [Email setup](#email-setup)) |
| `VOLOROTA_SMTP_PORT` | `587` | SMTP port |
| `VOLOROTA_SMTP_USER` | — | SMTP username |
| `VOLOROTA_SMTP_PASS` | — | SMTP password |
| `VOLOROTA_SMTP_FROM` | — | From address on outgoing mail |
| `VOLOROTA_SMTP_SECURE` | `false` | `true` for implicit TLS (port 465); leave `false` for STARTTLS on 587 |
| `VOLOROTA_ADMIN_EMAIL` | — | Fallback recipient for leader notifications when a team has no leader set |
| `VOLOROTA_REMINDER_DAYS` | `3` | Days before a service to email confirmed volunteers; comma-separated for multiple (e.g. `7,3`) |
| `VOLOROTA_SERVICE_MINUTES` | `75` | Event duration used in volunteers' calendar feeds |

All persistent state lives under one directory (`/data` in-container). Mount a Docker volume there and your data survives container recreation.

---

## Email setup

VoloRota sends assignment notices, decline/replacement alerts to team leaders, and reminders. Without SMTP configured it runs in **capture mode**: nothing leaves the server, every "sent" email is viewable at `/admin/outbox`, and the dashboard shows a banner saying so. That's fine for evaluating; configure a relay before volunteers rely on it.

Any standard SMTP relay works. The app reads the `VOLOROTA_SMTP_*` variables at startup — no other configuration.

### Worked example: Gmail

Gmail is the relay most small churches reach for. Two things to know up front: Google requires an **App Password** (your regular Gmail password will not work), and Gmail rewrites the From address to the authenticated account, so set `VOLOROTA_SMTP_FROM` to the same address.

1. On the Google account you'll send from, turn on **2-Step Verification** (Google account → Security). App Passwords require it.
2. Generate an App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) — name it "VoloRota", copy the 16-character password.
3. Add the variables to your compose file (or `docker run -e` flags):

```yaml
environment:
  VOLOROTA_SMTP_HOST: smtp.gmail.com
  VOLOROTA_SMTP_PORT: "587"
  VOLOROTA_SMTP_USER: church.office@gmail.com
  VOLOROTA_SMTP_PASS: "abcd efgh ijkl mnop"   # the App Password
  VOLOROTA_SMTP_FROM: church.office@gmail.com
```

4. Set `VOLOROTA_BASE_URL` to your instance's public URL (e.g. `https://schedule.yourchurch.org`) — the links inside those emails are built from it. That URL has to actually reach your server: add a DNS record (an A record for `schedule` pointing at your server's IP, at whoever hosts your domain's DNS) and put TLS in front (a reverse proxy like Caddy — see `deploy/demo/` for a working example). DNS and TLS are outside VoloRota itself, but skipping them is the most common reason emailed links don't work.
5. Restart the container. The capture-mode banner disappears; sends now show `transport: smtp` in `/admin/outbox`.

To verify: open a service, click **Notify volunteers**, and check both the recipient's inbox and `/admin/outbox`.

**Do the email domain and `VOLOROTA_BASE_URL` need to match?** No — they are independent. The From address is whatever your relay authenticates as; `VOLOROTA_BASE_URL` only controls where the links inside the emails point. Sending from `smallchurchoffice@gmail.com` with links to `https://schedule.smallchurch.org` works fine. If your church has Google Workspace on its own domain, the same App Password steps work there and the two will match — nice, but not required.

Consumer Gmail allows roughly 500 outgoing messages a day — far more than a small church's scheduling traffic. Note that routing mail through Gmail means Google processes your notification emails; if that matters to your congregation, the same five variables point at any other provider (Fastmail, Mailbox.org, Amazon SES, or your own relay) unchanged.

---

## Development Setup

**Prerequisites:** [Bun](https://bun.sh) >= 1.1

```bash
git clone https://github.com/VoloRota/volorota.git
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
