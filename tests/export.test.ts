/**
 * Export + Print test suite — ISC-38
 *
 * Verifies:
 *  1. CSV export: header row present with correct columns
 *  2. CSV export: row count matches fixture slots in date range
 *  3. CSV export: unfilled slot has empty assignee column
 *  4. CSV export: quoted commas in names round-trip through a CSV parser
 *  5. CSV export: embedded quotes (double-quote escaping RFC 4180)
 *  6. CSV export: out-of-range services excluded
 *  7. CSV route: auth-gated (401 without session)
 *  8. CSV route: missing params → 400
 *  9. Print route: @media print CSS rules present in served HTML
 * 10. Print route: date-grouped content rendered (service name appears once per group)
 * 11. Print route: auth-gated (401 without session)
 * 12. Print route: no params → renders date picker form
 * 13. buildCsv: RFC 4180 cell escaping (comma, quote, newline)
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createTeam,
  createOneOffService,
  createAssignment,
  updateAssignmentStatus,
  getExportRows,
} from "../src/db/queries.js";
import {
  authMiddleware,
  handleLoginGet,
  handleLoginPost,
  handleLogout,
  resetSigningSecretCache,
  resetAttemptRecords,
  type AuthEnv,
} from "../src/auth.js";
import { exportRouter, printRouter } from "../src/routes/export.js";
import { buildCsv } from "../src/calendar/csv.js";
import { csvCell } from "../src/calendar/csv.js";

// ---------------------------------------------------------------------------
// Minimal CSV parser (RFC 4180) for test assertions
// ---------------------------------------------------------------------------

/** Parse a CRLF-or-LF delimited CSV string into a 2D array of strings. */
function parseCsvSimple(text: string): string[][] {
  // Normalize line endings
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Strip trailing newline
  const stripped = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (stripped === "") return [];

  const lines = stripped.split("\n");
  return lines.map((line) => parseCsvRow(line));
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let field = "";
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      if (line[i] === ",") i++; // skip comma
    } else {
      // Unquoted field
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Test app helpers
// ---------------------------------------------------------------------------

function buildApp(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });

  // Login/logout
  app.get("/admin/login", handleLoginGet);
  app.post("/admin/login", handleLoginPost);
  app.post("/admin/logout", handleLogout);

  app.use("/admin/*", authMiddleware);

  app.route("/admin/services", exportRouter);
  app.route("/admin/print", printRouter);

  return app;
}

/** Get a session cookie by logging in */
async function getSessionCookie(app: Hono<AuthEnv>, password = "testpass"): Promise<string> {
  const res = await app.request("/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
  });
  const cookies = res.headers.get("Set-Cookie") ?? "";
  const match = cookies.match(/volorota_sess=[^;]+/);
  return match ? match[0] : "";
}

/** Create a service slot directly */
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
let app: Hono<AuthEnv>;

beforeEach(() => {
  process.env.VOLOROTA_ADMIN_PASSWORD = "testpass";
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  resetSigningSecretCache();
  resetAttemptRecords();
  app = buildApp(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Fixture builder
//
// date range: 2026-07-01 to 2026-07-31
// Services:
//   svc1 "Morning Worship" 2026-07-06: 2 slots, 1 filled (confirmed), 1 unfilled
//   svc2 "Evening Service" 2026-07-13: 1 slot, filled (pending)
// Outside range:
//   svc3 "Out-of-Range"    2026-08-03: 1 slot (should NOT appear)
// ---------------------------------------------------------------------------

async function buildFixture() {
  const teamW = createTeam(db, "Worship Team", "individual");
  const teamU = createTeam(db, "Ushers", "individual");

  const alice = createPerson(db, "Alice Smith", "alice@example.com");
  const bob = createPerson(db, "Bob, Jones", "bob@example.com"); // comma in name — CSV escaping test

  const svc1 = createOneOffService(db, "Morning Worship", "2026-07-06", "10:30", []);
  const svc2 = createOneOffService(db, "Evening Service", "2026-07-13", "19:00", []);
  const svc3 = createOneOffService(db, "Out-of-Range", "2026-08-03", "10:30", []);

  // svc1: 2 slots
  const slot1a = createSlot(db, svc1.id, teamW.id, "Vocals", 0); // filled → confirmed
  const slot1b = createSlot(db, svc1.id, teamU.id, "Greeter", 1); // unfilled

  // svc2: 1 slot, filled → pending
  const slot2a = createSlot(db, svc2.id, teamW.id, "Sound", 0);

  // svc3: out of range
  const slot3a = createSlot(db, svc3.id, teamW.id, "Vocals", 0);

  // Assignments
  const a1 = createAssignment(db, slot1a, alice.id);
  updateAssignmentStatus(db, a1.id, "confirmed");

  const a2 = createAssignment(db, slot2a, bob.id);
  // Leave as pending (default)

  const a3 = createAssignment(db, slot3a, alice.id);
  updateAssignmentStatus(db, a3.id, "confirmed");

  return {
    alice, bob,
    svc1, svc2, svc3,
    slot1a, slot1b, slot2a, slot3a,
  };
}

// ---------------------------------------------------------------------------
// Test 1: CSV header row
// ---------------------------------------------------------------------------

test("ISC-38: CSV export has correct header columns", async () => {
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/services/export.csv?from=2026-07-01&to=2026-07-31",
    { headers: { Cookie: cookie } }
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/csv");

  const text = await res.text();
  const rows = parseCsvSimple(text);
  expect(rows.length).toBeGreaterThan(0);

  const header = rows[0]!;
  expect(header).toEqual([
    "date", "time", "service", "team", "role", "position", "assignee", "status",
  ]);
});

// ---------------------------------------------------------------------------
// Test 2: Row count matches fixture slots in range
// ---------------------------------------------------------------------------

test("ISC-38: CSV row count matches fixture slots in date range", async () => {
  await buildFixture();
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/services/export.csv?from=2026-07-01&to=2026-07-31",
    { headers: { Cookie: cookie } }
  );
  const text = await res.text();
  const rows = parseCsvSimple(text);
  // Header + 3 data rows (slot1a, slot1b, slot2a — svc3 is out of range)
  expect(rows.length).toBe(1 + 3);
});

// ---------------------------------------------------------------------------
// Test 3: Unfilled slot has empty assignee
// ---------------------------------------------------------------------------

test("ISC-38: unfilled slot has empty assignee column", async () => {
  await buildFixture();
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/services/export.csv?from=2026-07-01&to=2026-07-31",
    { headers: { Cookie: cookie } }
  );
  const text = await res.text();
  const rows = parseCsvSimple(text);
  const dataRows = rows.slice(1);

  // Find the row for the unfilled Greeter slot
  const greeterRow = dataRows.find(
    (r) => r[4] === "Greeter" && r[6] === ""
  );
  expect(greeterRow).toBeDefined();
  expect(greeterRow![7]).toBe("unfilled");
});

// ---------------------------------------------------------------------------
// Test 4: Quoted commas in names round-trip correctly
// ---------------------------------------------------------------------------

test("ISC-38: CSV round-trips comma in assignee name (RFC 4180 quoting)", async () => {
  await buildFixture(); // bob has "Bob, Jones"
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/services/export.csv?from=2026-07-01&to=2026-07-31",
    { headers: { Cookie: cookie } }
  );
  const text = await res.text();
  const rows = parseCsvSimple(text);
  const dataRows = rows.slice(1);

  // The row for the Sound slot should have "Bob, Jones" as assignee
  const soundRow = dataRows.find((r) => r[4] === "Sound");
  expect(soundRow).toBeDefined();
  expect(soundRow![6]).toBe("Bob, Jones");
});

// ---------------------------------------------------------------------------
// Test 5: Out-of-range services excluded
// ---------------------------------------------------------------------------

test("ISC-38: services outside date range are excluded from CSV", async () => {
  await buildFixture();
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/services/export.csv?from=2026-07-01&to=2026-07-31",
    { headers: { Cookie: cookie } }
  );
  const text = await res.text();
  const rows = parseCsvSimple(text);
  const dataRows = rows.slice(1);

  // The out-of-range service "Out-of-Range" (2026-08-03) must not appear
  const outOfRange = dataRows.find((r) => r[2] === "Out-of-Range");
  expect(outOfRange).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Test 6: CSV route auth-gated
// ---------------------------------------------------------------------------

test("ISC-38: CSV export route requires authentication", async () => {
  const res = await app.request(
    "/admin/services/export.csv?from=2026-07-01&to=2026-07-31",
    { headers: { Accept: "application/json" } } // non-HTML to get 401 not redirect
  );
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Test 7: CSV route missing params → 400
// ---------------------------------------------------------------------------

test("ISC-38: CSV export returns 400 when from/to params missing", async () => {
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/services/export.csv",
    { headers: { Cookie: cookie } }
  );
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Test 8: Print route renders @media print CSS
// ---------------------------------------------------------------------------

test("ISC-38: print route includes @media print CSS rules", async () => {
  await buildFixture();
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/print?from=2026-07-01&to=2026-07-31",
    { headers: { Cookie: cookie } }
  );
  expect(res.status).toBe(200);

  const html = await res.text();
  expect(html).toContain("@media print");
  // Core print rules present
  expect(html).toContain("display:none");
});

// ---------------------------------------------------------------------------
// Test 9: Print route renders date-grouped content
// ---------------------------------------------------------------------------

test("ISC-38: print route renders service names and date-grouped content", async () => {
  await buildFixture();
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/print?from=2026-07-01&to=2026-07-31",
    { headers: { Cookie: cookie } }
  );
  const html = await res.text();

  // Both services in range should appear
  expect(html).toContain("Morning Worship");
  expect(html).toContain("Evening Service");

  // Out-of-range must NOT appear
  expect(html).not.toContain("Out-of-Range");

  // Assignee names present
  expect(html).toContain("Alice Smith");
  expect(html).toContain("Bob, Jones");
});

// ---------------------------------------------------------------------------
// Test 10: Print route auth-gated
// ---------------------------------------------------------------------------

test("ISC-38: print route requires authentication", async () => {
  const res = await app.request(
    "/admin/print?from=2026-07-01&to=2026-07-31",
    { headers: { Accept: "application/json" } }
  );
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Test 11: Print route with no params renders date-picker form
// ---------------------------------------------------------------------------

test("ISC-38: print route with no params renders date-picker form", async () => {
  const cookie = await getSessionCookie(app);
  const res = await app.request(
    "/admin/print",
    { headers: { Cookie: cookie } }
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('type="date"');
  expect(html).toContain('name="from"');
  expect(html).toContain('name="to"');
});

// ---------------------------------------------------------------------------
// Unit tests for buildCsv / csvCell
// ---------------------------------------------------------------------------

test("ISC-38: csvCell escapes comma with RFC 4180 quoting", () => {
  expect(csvCell("hello, world")).toBe('"hello, world"');
});

test("ISC-38: csvCell escapes double-quote by doubling", () => {
  expect(csvCell('say "hello"')).toBe('"say ""hello"""');
});

test("ISC-38: csvCell does not quote plain strings", () => {
  expect(csvCell("hello world")).toBe("hello world");
  expect(csvCell("alice")).toBe("alice");
});

test("ISC-38: csvCell handles null as empty string", () => {
  expect(csvCell(null)).toBe("");
});

test("ISC-38: buildCsv produces CRLF line endings", () => {
  const csv = buildCsv([]);
  // Header-only CSV ends with CRLF
  expect(csv).toMatch(/\r\n$/);
  expect(csv.split("\r\n").length).toBeGreaterThan(1);
});

test("ISC-38: buildCsv position column is 1-based", () => {
  // Create a minimal ExportRow with position=0 — CSV should show "1"
  const team = createTeam(db, "Tech", "individual");
  const svc = createOneOffService(db, "Test Service", "2026-09-01", "10:00", []);
  createSlot(db, svc.id, team.id, "Camera", 0);

  const rows = getExportRows(db, "2026-09-01", "2026-09-01");
  const csv = buildCsv(rows);
  const parsed = parseCsvSimple(csv);
  const dataRow = parsed[1]!;

  // position column (index 5) should be "1" for position=0
  expect(dataRow[5]).toBe("1");
});

// Regression: the full composed app (src/index.ts) must serve /admin/services/export.csv —
// exportRouter's literal route is shadowed by servicesRouter's /:id if mounted after it.
test("full app: export.csv reachable through real route composition", async () => {
  process.env.VOLOROTA_ADMIN_PASSWORD ||= "test-password";
  const { default: realApp } = await import("../src/index.js");
  const res = await realApp.fetch(
    new Request("http://x/admin/services/export.csv?from=2026-01-01&to=2026-12-31", {
      headers: { Accept: "application/json" },
    })
  );
  // Auth gate returns 401 for non-HTML — anything but 404 proves the route resolves
  expect([200, 401]).toContain(res.status);
  expect(res.status).not.toBe(404);
});
