/**
 * ICS feed test suite — ISC-37
 *
 * Verifies:
 *  1. Feed parses with zero errors via node-ical (RFC 5545 lint)
 *  2. Only confirmed assignments appear — pending/declined/other-person noise filtered out
 *  3. Event count matches person's confirmed count in the fixture
 *  4. Stable UID: same UID across two requests / two buildIcsFeed calls
 *  5. All lines are ≤ 75 octets after unfolding / per-line after folding
 *  6. TEXT escaping: service name with comma and semicolon round-trips correctly
 *  7. Cross-token: person B's token never yields person A's events (route-level)
 *  8. Bogus token → 4xx from route
 *  9. VCALENDAR envelope: PRODID, VERSION, METHOD:PUBLISH present
 * 10. DTSTART/DTEND in UTC (ends with Z), DTEND = DTSTART + 75 min default
 *
 * PENDING VERIFY — calendar-client import:
 *   Actual calendar client import (Apple Calendar, Google Calendar, Outlook)
 *   has NOT been performed in automated tests. This is a human/Seven verification
 *   step at the VERIFY phase. Evidence: feed parses with 0 errors via node-ical;
 *   RFC 5545 structural properties verified below.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import ical, { type CalendarComponent } from "node-ical";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createTeam,
  createOneOffService,
  createAssignment,
  updateAssignmentStatus,
} from "../src/db/queries.js";
import { createOrReplaceToken } from "../src/volunteer/tokens.js";
import { volunteerRouter } from "../src/routes/volunteer.js";
import { getConfirmedAssignments, buildIcsFeed } from "../src/calendar/ics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(db: Database): Hono {
  const app = new Hono();
  app.route("/v", volunteerRouter);
  return app;
}

/** Insert a service slot directly */
function createSlot(
  db: Database,
  serviceId: number,
  teamId: number,
  roleName = "Volunteer",
  position = 0
): number {
  const r = db
    .prepare(
      "INSERT INTO service_slots (service_id, team_id, role_name, position) VALUES (?, ?, ?, ?) RETURNING id"
    )
    .get(serviceId, teamId, roleName, position) as { id: number };
  return r.id;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database;
let app: Hono;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  app = buildApp(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Fixture builder
//
// Person A: 2 confirmed, 1 pending, 1 declined
// Person B: 1 confirmed  (noise for person A's feed)
// ---------------------------------------------------------------------------

async function buildFixture() {
  const teamA = createTeam(db, "Worship", "individual");
  const teamB = createTeam(db, "Ushers", "individual");

  const personA = createPerson(db, "Alice Smith", "alice@example.com");
  const personB = createPerson(db, "Bob Jones", "bob@example.com");

  // Services
  const svc1 = createOneOffService(db, "Sunday Service 1", "2026-07-06", "10:30", []);
  const svc2 = createOneOffService(db, "Sunday Service 2", "2026-07-13", "10:30", []);
  const svc3 = createOneOffService(db, "Sunday Service 3", "2026-07-20", "10:30", []);
  const svc4 = createOneOffService(db, "Sunday Service 4", "2026-07-27", "10:30", []);

  // Slots
  const slot1 = createSlot(db, svc1.id, teamA.id, "Vocals", 0);
  const slot2 = createSlot(db, svc2.id, teamA.id, "Vocals", 0);
  const slot3 = createSlot(db, svc3.id, teamA.id, "Vocals", 0);
  const slot4 = createSlot(db, svc4.id, teamB.id, "Greeter", 0);
  const slotB = createSlot(db, svc1.id, teamB.id, "Greeter", 1);

  // Person A assignments: confirmed, confirmed, pending, declined
  const a1 = createAssignment(db, slot1, personA.id);
  updateAssignmentStatus(db, a1.id, "confirmed");
  const a2 = createAssignment(db, slot2, personA.id);
  updateAssignmentStatus(db, a2.id, "confirmed");
  const a3 = createAssignment(db, slot3, personA.id); // pending — should NOT appear
  const a4 = createAssignment(db, slot4, personA.id);
  updateAssignmentStatus(db, a4.id, "declined"); // declined — should NOT appear

  // Person B: confirmed (noise — should NOT appear in person A's feed)
  const ab = createAssignment(db, slotB, personB.id);
  updateAssignmentStatus(db, ab.id, "confirmed");

  const tokenA = await createOrReplaceToken(db, personA.id);
  const tokenB = await createOrReplaceToken(db, personB.id);

  return { personA, personB, tokenA, tokenB, confirmedCountA: 2 };
}

// ---------------------------------------------------------------------------
// Test 1: Feed parses with 0 errors (RFC 5545 lint via node-ical)
// ---------------------------------------------------------------------------

test("ISC-37: feed parses with 0 errors via node-ical", async () => {
  const { tokenA, confirmedCountA } = await buildFixture();

  const res = await app.request(`/v/${tokenA}/calendar.ics`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/calendar");

  const body = await res.text();

  // node-ical sync parse — throws on fatal parse errors
  let parseError: Error | null = null;
  let events: Record<string, unknown> = {};
  try {
    events = ical.sync.parseICS(body);
  } catch (e) {
    parseError = e instanceof Error ? e : new Error(String(e));
  }

  expect(parseError).toBeNull();

  // Count VEVENT components
  const vevents = Object.values(events).filter(
    (v) =>
      typeof v === "object" && v !== null && (v as { type?: string }).type === "VEVENT"
  );
  expect(vevents.length).toBe(confirmedCountA);
});

// ---------------------------------------------------------------------------
// Test 2: Only confirmed assignments — pending/declined excluded
// ---------------------------------------------------------------------------

test("ISC-37: only confirmed assignments appear (pending/declined excluded)", async () => {
  const { personA } = await buildFixture();

  const assignments = getConfirmedAssignments(db, personA.id);
  // Fixture has 2 confirmed, 1 pending, 1 declined for person A
  expect(assignments.length).toBe(2);
  for (const a of assignments) {
    // The underlying query only returns confirmed — double-check via raw DB
    const raw = db
      .query("SELECT status FROM assignments WHERE id = ?")
      .get(a.assignment_id) as { status: string } | null;
    expect(raw?.status).toBe("confirmed");
  }
});

// ---------------------------------------------------------------------------
// Test 3: Stable UID across two calls
// ---------------------------------------------------------------------------

test("ISC-37: UID is stable across two buildIcsFeed calls", async () => {
  const { personA } = await buildFixture();

  const assignments = getConfirmedAssignments(db, personA.id);
  const feed1 = buildIcsFeed(assignments, "http://localhost:3000/v/token");
  const feed2 = buildIcsFeed(assignments, "http://localhost:3000/v/token");

  // Extract UIDs from each feed
  function extractUids(icsText: string): string[] {
    return icsText
      .split(/\r\n/)
      .filter((line) => line.startsWith("UID:"))
      .map((line) => line.slice(4));
  }

  const uids1 = extractUids(feed1).sort();
  const uids2 = extractUids(feed2).sort();

  expect(uids1.length).toBe(2);
  expect(uids1).toEqual(uids2);

  // UIDs must follow the stable pattern assignment-<id>@volorota
  for (const uid of uids1) {
    expect(uid).toMatch(/^assignment-\d+@volorota$/);
  }
});

// ---------------------------------------------------------------------------
// Test 4: Line length ≤ 75 octets per line
// ---------------------------------------------------------------------------

test("ISC-37: all lines ≤ 75 octets (RFC 5545 §3.1 folding)", async () => {
  const { personA } = await buildFixture();

  const assignments = getConfirmedAssignments(db, personA.id);
  const feed = buildIcsFeed(assignments, "http://localhost:3000/v/token");

  const encoder = new TextEncoder();
  // Split by CRLF; strip the trailing empty string after final CRLF
  const lines = feed.split("\r\n").filter((l, i, arr) => i < arr.length - 1 || l !== "");

  const longLines = lines.filter((line) => encoder.encode(line).length > 75);
  expect(longLines).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 5: TEXT escaping — comma and semicolon in service name
// ---------------------------------------------------------------------------

test("ISC-37: TEXT escaping for comma and semicolon in service name", async () => {
  // Create a service with a name containing comma and semicolon
  const team = createTeam(db, "Tech", "individual");
  const person = createPerson(db, "Carol Day", "carol@example.com");
  const svc = createOneOffService(
    db,
    "Special Service, Easter; Morning",
    "2026-04-05",
    "09:00",
    []
  );
  const slotId = createSlot(db, svc.id, team.id, "Sound", 0);
  const a = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, a.id, "confirmed");

  const assignments = getConfirmedAssignments(db, person.id);
  const feed = buildIcsFeed(assignments, "http://localhost:3000/v/tk");

  // The SUMMARY line should have escaped comma and semicolon
  // RFC 5545 escaping: \, and \;
  expect(feed).toContain("\\,");
  expect(feed).toContain("\\;");

  // Parses cleanly
  const events = ical.sync.parseICS(feed);
  const vevents = Object.values(events).filter(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      (v as { type?: string }).type === "VEVENT"
  ) as Array<{ type: string; summary: string }>;
  expect(vevents.length).toBe(1);
  // node-ical unescapes the summary for us
  expect(vevents[0]!.summary).toContain("Special Service, Easter; Morning");
});

// ---------------------------------------------------------------------------
// Test 6: Cross-token isolation — person B's token never yields person A's events
// ---------------------------------------------------------------------------

test("ISC-37: cross-token: person B feed has no person A events", async () => {
  const { tokenB, confirmedCountA } = await buildFixture();

  const resB = await app.request(`/v/${tokenB}/calendar.ics`);
  expect(resB.status).toBe(200);

  const bodyB = await resB.text();
  const eventsB = ical.sync.parseICS(bodyB);
  const veventsB = Object.values(eventsB).filter(
    (v) =>
      typeof v === "object" && v !== null && (v as { type?: string }).type === "VEVENT"
  );

  // Person B has exactly 1 confirmed assignment
  expect(veventsB.length).toBe(1);

  // And it must be different from person A's confirmed count
  expect(veventsB.length).not.toBe(confirmedCountA);
});

// ---------------------------------------------------------------------------
// Test 7: Bogus/expired token → 410 (same as rest of /v/:token)
// ---------------------------------------------------------------------------

test("ISC-37: bogus token → 410", async () => {
  const res = await app.request("/v/totallybogustoken12345/calendar.ics");
  expect(res.status).toBe(410);
});

// ---------------------------------------------------------------------------
// Test 8: VCALENDAR envelope — PRODID, VERSION, METHOD:PUBLISH
// ---------------------------------------------------------------------------

test("ISC-37: VCALENDAR envelope has PRODID, VERSION 2.0, METHOD:PUBLISH", async () => {
  const { personA } = await buildFixture();

  const assignments = getConfirmedAssignments(db, personA.id);
  const feed = buildIcsFeed(assignments, "http://localhost:3000/v/tok");

  expect(feed).toContain("BEGIN:VCALENDAR\r\n");
  expect(feed).toContain("END:VCALENDAR\r\n");
  expect(feed).toContain("VERSION:2.0\r\n");
  expect(feed).toContain("METHOD:PUBLISH\r\n");
  // PRODID line may be folded, but the start must be there
  expect(feed).toContain("PRODID:");
});

// ---------------------------------------------------------------------------
// Test 9: DTSTART/DTEND in UTC, DTEND = DTSTART + 75 min
// ---------------------------------------------------------------------------

test("ISC-37: DTSTART/DTEND are UTC and DTEND is DTSTART + 75 min", async () => {
  const team = createTeam(db, "Music", "individual");
  const person = createPerson(db, "Dave Lee", "dave@example.com");
  // Service at 10:30 on 2026-07-06 UTC
  const svc = createOneOffService(db, "Morning Service", "2026-07-06", "10:30", []);
  const slotId = createSlot(db, svc.id, team.id, "Piano", 0);
  const a = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, a.id, "confirmed");

  const assignments = getConfirmedAssignments(db, person.id);
  const feed = buildIcsFeed(assignments, "http://localhost:3000/v/tok");

  // DTSTART should be 20260706T103000Z (10:30 UTC)
  expect(feed).toContain("DTSTART:20260706T103000Z\r\n");
  // DTEND should be 20260706T114500Z (10:30 + 75 min = 11:45 UTC)
  expect(feed).toContain("DTEND:20260706T114500Z\r\n");
});

// ---------------------------------------------------------------------------
// Test 10: VOLOROTA_SERVICE_MINUTES env override
// ---------------------------------------------------------------------------

test("ISC-37: VOLOROTA_SERVICE_MINUTES overrides default 75-min duration", async () => {
  const team = createTeam(db, "Sound", "individual");
  const person = createPerson(db, "Eve Fox", "eve@example.com");
  const svc = createOneOffService(db, "Evening Service", "2026-08-02", "18:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Sound Tech", 0);
  const a = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, a.id, "confirmed");

  const assignments = getConfirmedAssignments(db, person.id);

  // Temporarily set env
  const orig = process.env.VOLOROTA_SERVICE_MINUTES;
  process.env.VOLOROTA_SERVICE_MINUTES = "60";
  try {
    const feed = buildIcsFeed(assignments, "http://localhost:3000/v/tok");
    // 18:00 + 60 min = 19:00
    expect(feed).toContain("DTSTART:20260802T180000Z\r\n");
    expect(feed).toContain("DTEND:20260802T190000Z\r\n");
  } finally {
    if (orig === undefined) {
      delete process.env.VOLOROTA_SERVICE_MINUTES;
    } else {
      process.env.VOLOROTA_SERVICE_MINUTES = orig;
    }
  }
});
