/**
 * ICS feed generator — RFC 5545 compliant, hand-rolled (no runtime dep).
 *
 * Design decisions (see CalendarAndExport.md):
 *  - UTC-only times (no VTIMEZONE block needed)
 *  - CONFIRMED assignments only
 *  - Stable UID: assignment-<id>@volorota
 *  - Duration: 75 min default, overrideable via VOLOROTA_SERVICE_MINUTES env
 *  - CRLF line endings + 75-octet fold as required by RFC 5545 §3.1
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IcsAssignment {
  assignment_id: number;
  service_name: string;
  service_date: string; // YYYY-MM-DD
  service_time: string; // HH:MM
  role_name: string;
  team_name: string;
}

// ---------------------------------------------------------------------------
// RFC 5545 text escaping (§3.3.11)
// Escape: backslash, semicolon, comma, newlines
// ---------------------------------------------------------------------------

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// RFC 5545 §3.1 line folding:
// Lines MUST be folded at 75 octets (not chars — UTF-8 bytes).
// Continuation lines begin with a single SPACE character.
// ---------------------------------------------------------------------------

function foldLine(line: string): string {
  // Work in bytes to count octets correctly
  const encoder = new TextEncoder();

  // Fast path: already fits
  if (encoder.encode(line).length <= 75) {
    return line;
  }

  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;

    if (currentBytes + charBytes > 75) {
      parts.push(current);
      current = " " + char; // continuation line starts with SPACE
      currentBytes = 1 + charBytes; // 1 for the leading space
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }

  return parts.join("\r\n");
}

// ---------------------------------------------------------------------------
// Build a content line: "PROP:value" or "PROP;params:value", then fold it
// ---------------------------------------------------------------------------

function contentLine(name: string, value: string): string {
  return foldLine(`${name}:${value}`) + "\r\n";
}

// ---------------------------------------------------------------------------
// Convert a service date (YYYY-MM-DD) and time (HH:MM) to UTC ISO compact form
// e.g. "2026-06-15" + "10:30" → "20260615T103000Z"
// We treat the stored date+time as-is UTC since there is no tz info in the DB.
// ---------------------------------------------------------------------------

function toUtcStamp(date: string, time: string): string {
  // date: YYYY-MM-DD, time: HH:MM
  const [y, m, d] = date.split("-");
  const [hh, mm] = time.split(":");
  return `${y}${m}${d}T${hh}${mm}00Z`;
}

function addMinutes(utcStamp: string, minutes: number): string {
  // Parse the compact UTC stamp back to a Date, add minutes
  const raw = utcStamp.slice(0, 15); // "20260615T103000"
  const year = parseInt(raw.slice(0, 4), 10);
  const month = parseInt(raw.slice(4, 6), 10) - 1;
  const day = parseInt(raw.slice(6, 8), 10);
  const hour = parseInt(raw.slice(9, 11), 10);
  const min = parseInt(raw.slice(11, 13), 10);
  const sec = parseInt(raw.slice(13, 15), 10);
  const dt = new Date(Date.UTC(year, month, day, hour, min, sec));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutes);
  return (
    dt.getUTCFullYear().toString().padStart(4, "0") +
    (dt.getUTCMonth() + 1).toString().padStart(2, "0") +
    dt.getUTCDate().toString().padStart(2, "0") +
    "T" +
    dt.getUTCHours().toString().padStart(2, "0") +
    dt.getUTCMinutes().toString().padStart(2, "0") +
    dt.getUTCSeconds().toString().padStart(2, "0") +
    "Z"
  );
}

// ---------------------------------------------------------------------------
// Build a DTSTAMP for "now"
// ---------------------------------------------------------------------------

function nowUtcStamp(): string {
  const now = new Date();
  return (
    now.getUTCFullYear().toString().padStart(4, "0") +
    (now.getUTCMonth() + 1).toString().padStart(2, "0") +
    now.getUTCDate().toString().padStart(2, "0") +
    "T" +
    now.getUTCHours().toString().padStart(2, "0") +
    now.getUTCMinutes().toString().padStart(2, "0") +
    now.getUTCSeconds().toString().padStart(2, "0") +
    "Z"
  );
}

// ---------------------------------------------------------------------------
// Query: get confirmed assignments for a given person
// ---------------------------------------------------------------------------

export function getConfirmedAssignments(
  db: Database,
  personId: number
): IcsAssignment[] {
  return db
    .query(
      `SELECT a.id AS assignment_id, s.name AS service_name, s.date AS service_date,
              s.time AS service_time, ss.role_name, t.name AS team_name
       FROM assignments a
       JOIN service_slots ss ON ss.id = a.service_slot_id
       JOIN services s ON s.id = ss.service_id
       JOIN teams t ON t.id = ss.team_id
       WHERE a.person_id = ? AND a.status = 'confirmed'
       ORDER BY s.date, s.time`
    )
    .all(personId) as IcsAssignment[];
}

// ---------------------------------------------------------------------------
// Build the ICS feed string for a person
// ---------------------------------------------------------------------------

export function buildIcsFeed(
  assignments: IcsAssignment[],
  volunteerLink: string
): string {
  const durationMinutes = (() => {
    const env = process.env.VOLOROTA_SERVICE_MINUTES;
    if (env) {
      const parsed = parseInt(env, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 75;
  })();

  const dtstamp = nowUtcStamp();

  let cal = "";
  cal += "BEGIN:VCALENDAR\r\n";
  cal += contentLine("PRODID", "-//VoloRota//VoloRota Volunteer Scheduler//EN");
  cal += contentLine("VERSION", "2.0");
  cal += contentLine("CALSCALE", "GREGORIAN");
  cal += contentLine("METHOD", "PUBLISH");

  for (const a of assignments) {
    const dtstart = toUtcStamp(a.service_date, a.service_time);
    const dtend = addMinutes(dtstart, durationMinutes);
    const uid = `assignment-${a.assignment_id}@volorota`;
    const summary = `VoloRota: ${a.role_name} — ${a.service_name}`;
    const description = `Team: ${a.team_name}\\nYour volunteer link: ${volunteerLink}`;

    cal += "BEGIN:VEVENT\r\n";
    cal += contentLine("UID", uid);
    cal += contentLine("DTSTAMP", dtstamp);
    cal += contentLine("DTSTART", dtstart);
    cal += contentLine("DTEND", dtend);
    cal += contentLine("SUMMARY", escapeText(summary));
    cal += contentLine("DESCRIPTION", escapeText(description));
    cal += "END:VEVENT\r\n";
  }

  cal += "END:VCALENDAR\r\n";
  return cal;
}
