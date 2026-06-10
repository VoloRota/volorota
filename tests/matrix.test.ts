/**
 * Matrix view test suite.
 *
 * Covers ISC-16, ISC-17, ISC-18 and paging / regression.
 *
 * Fixture:
 *   - 3 teams: Worship (2 roles × 2 positions each), Sound (1 role × 1 position), Welcome (1 role × 2 positions)
 *   - 6 services from a fixed date range (2030-01-05 through 2030-02-09, weekly Sundays)
 *   - Assignments mix: confirmed, pending, declined, unfilled
 *   - One person with a blockout covering service 3's date
 *
 * Note: ISC-18 visual screenshot at 768 px is pending VERIFY evidence —
 * this test asserts the CSS contract (position:sticky, left:0, overflow-x:auto)
 * and the HTML structural contract. A human screenshot is noted below.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createTeam,
  createTeamRole,
  addTeamMember,
  createTemplate,
  addTemplateRole,
  generateServicesFromTemplate,
  listServiceSlots,
  createAssignment,
  updateAssignmentStatus,
  createBlockout,
  getMatrixData,
  type MatrixData,
} from "../src/db/queries.js";
import { matrixRouter } from "../src/routes/matrix.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
});

afterEach(() => {
  db.close();
});

/**
 * Build the standard fixture:
 *   3 teams, 6 services (weekly Sundays 2030-01-06 to 2030-02-10),
 *   a mix of confirmed/pending/declined/unfilled, one blocked-out person.
 *
 * Returns enough detail for assertions.
 */
function buildFixture() {
  // --- People ---
  const alice  = createPerson(db, "Alice",  "alice@test.com");
  const bob    = createPerson(db, "Bob",    "bob@test.com");
  const carol  = createPerson(db, "Carol",  "carol@test.com");
  const dave   = createPerson(db, "Dave",   "dave@test.com");
  const eve    = createPerson(db, "Eve",    "eve@test.com");
  const frank  = createPerson(db, "Frank",  "frank@test.com");

  // --- Teams ---
  const worship = createTeam(db, "Worship", "individual");
  const sound   = createTeam(db, "Sound",   "individual");
  const welcome = createTeam(db, "Welcome", "individual");

  // Roles (headcount drives slot count)
  // Worship: Vocals ×2, Guitar ×2
  // Sound:   Engineer ×1
  // Welcome: Greeter ×2
  createTeamRole(db, worship.id, "Vocals",  2);
  createTeamRole(db, worship.id, "Guitar",  2);
  createTeamRole(db, sound.id,   "Engineer", 1);
  createTeamRole(db, welcome.id, "Greeter", 2);

  // Team members
  addTeamMember(db, alice.id,  worship.id);
  addTeamMember(db, bob.id,    worship.id);
  addTeamMember(db, carol.id,  worship.id);
  addTeamMember(db, dave.id,   sound.id);
  addTeamMember(db, eve.id,    welcome.id);
  addTeamMember(db, frank.id,  welcome.id);

  // --- Template & 6 services (Sundays 2030-01-06 → 2030-02-10) ---
  const tmpl = createTemplate(db, "Sunday Service", 0 /* Sunday */, "10:30");
  addTemplateRole(db, tmpl.id, worship.id, "Vocals",   2);
  addTemplateRole(db, tmpl.id, worship.id, "Guitar",   2);
  addTemplateRole(db, tmpl.id, sound.id,   "Engineer", 1);
  addTemplateRole(db, tmpl.id, welcome.id, "Greeter",  2);

  const services = generateServicesFromTemplate(db, tmpl.id, "2030-01-06", "2030-02-10");
  // Should produce 6 Sundays: 1/6, 1/13, 1/20, 1/27, 2/3, 2/10

  // --- Per-service assignments ---
  // Each service has 7 slots: Vocals×2, Guitar×2, Engineer×1, Greeter×2
  const svc1Slots = listServiceSlots(db, services[0]!.id);
  const svc2Slots = listServiceSlots(db, services[1]!.id);
  const svc3Slots = listServiceSlots(db, services[2]!.id);

  // Service 1: fully confirmed for all roles
  for (const slot of svc1Slots) {
    // Assign each slot to a person (reuse people; same person can be in multiple services)
    const personMap: Record<number, number> = {
      [worship.id]: alice.id,
      [sound.id]:   dave.id,
      [welcome.id]: eve.id,
    };
    const a = createAssignment(db, slot.id, personMap[slot.team_id] ?? alice.id);
    updateAssignmentStatus(db, a.id, "confirmed");
  }

  // Service 2: pending assignments
  for (const slot of svc2Slots) {
    const personMap: Record<number, number> = {
      [worship.id]: bob.id,
      [sound.id]:   dave.id,
      [welcome.id]: frank.id,
    };
    createAssignment(db, slot.id, personMap[slot.team_id] ?? bob.id);
    // Leave as pending (default status)
  }

  // Service 3: declined + blockout on dave
  // Dave is blocked out on service 3's date (2030-01-20)
  createBlockout(db, dave.id, "2030-01-20", "2030-01-20", "Vacation");
  for (const slot of svc3Slots) {
    if (slot.team_id === sound.id) {
      // Dave assigned + declined while blocked out
      const a = createAssignment(db, slot.id, dave.id);
      updateAssignmentStatus(db, a.id, "declined");
    }
    // Others: leave unfilled (no assignment)
  }

  // Services 4-6: leave completely unfilled

  return {
    services,
    people: { alice, bob, carol, dave, eve, frank },
    teams: { worship, sound, welcome },
    slotsPerService: 7, // Vocals×2 + Guitar×2 + Engineer×1 + Greeter×2
  };
}

// ---------------------------------------------------------------------------
// Direct query tests
// ---------------------------------------------------------------------------

describe("getMatrixData", () => {
  test("returns correct number of services in window", () => {
    buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);
    expect(data.services.length).toBe(6); // only 6 exist
  });

  test("respects the limit parameter", () => {
    buildFixture();
    const data = getMatrixData(db, "2030-01-06", 4);
    expect(data.services.length).toBe(4);
  });

  test("fromDate filters to future services (ISC-16 window)", () => {
    buildFixture();
    const data = getMatrixData(db, "2030-01-14", 8);
    // 2030-01-13 is not included; first service is 2030-01-20
    expect(data.services[0]!.date).toBe("2030-01-20");
    expect(data.services.length).toBe(4); // 1/20, 1/27, 2/3, 2/10
  });

  test("rows include ALL slot positions across the window (ISC-16)", () => {
    buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);
    // Expected rows: Vocals 1, Vocals 2, Guitar 1, Guitar 2, Engineer 1, Greeter 1, Greeter 2 = 7 rows
    expect(data.rows.length).toBe(7);
  });

  test("cell map contains an entry for every row×service combination", () => {
    buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);
    const expectedCells = data.rows.length * data.services.length;
    expect(data.cells.size).toBe(expectedCells);
  });

  test("confirmed cell has status confirmed (ISC-17)", () => {
    const { services, teams } = buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);

    // Service 1 (index 0), sound Engineer slot → confirmed
    const svc1Id = services[0]!.id;
    const engineerRow = data.rows.find(
      (r) => r.teamId === teams.sound.id && r.roleName === "Engineer"
    );
    expect(engineerRow).toBeDefined();
    const cell = data.cells.get(`${engineerRow!.slotKey}::${svc1Id}`);
    expect(cell?.status).toBe("confirmed");
    expect(cell?.personName).toBe("Dave");
  });

  test("pending cell has status pending (ISC-17)", () => {
    const { services, teams } = buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);

    const svc2Id = services[1]!.id;
    const engineerRow = data.rows.find(
      (r) => r.teamId === teams.sound.id && r.roleName === "Engineer"
    );
    expect(engineerRow).toBeDefined();
    const cell = data.cells.get(`${engineerRow!.slotKey}::${svc2Id}`);
    expect(cell?.status).toBe("pending");
    expect(cell?.personName).toBe("Dave");
  });

  test("declined cell has status declined (ISC-17)", () => {
    const { services, teams } = buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);

    const svc3Id = services[2]!.id;
    const engineerRow = data.rows.find(
      (r) => r.teamId === teams.sound.id && r.roleName === "Engineer"
    );
    expect(engineerRow).toBeDefined();
    const cell = data.cells.get(`${engineerRow!.slotKey}::${svc3Id}`);
    expect(cell?.status).toBe("declined");
  });

  test("unfilled cell has status unfilled (ISC-17)", () => {
    const { services, teams } = buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);

    // Service 4 (index 3) has no assignments at all
    const svc4Id = services[3]!.id;
    const engineerRow = data.rows.find(
      (r) => r.teamId === teams.sound.id && r.roleName === "Engineer"
    );
    expect(engineerRow).toBeDefined();
    const cell = data.cells.get(`${engineerRow!.slotKey}::${svc4Id}`);
    expect(cell?.status).toBe("unfilled");
    expect(cell?.personName).toBeNull();
  });

  test("blocked-out indicator set on correct cell (ISC-17)", () => {
    const { services, teams } = buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);

    // Dave is blocked out on 2030-01-20 (service 3) and has a declined assignment there
    const svc3Id = services[2]!.id;
    const engineerRow = data.rows.find(
      (r) => r.teamId === teams.sound.id && r.roleName === "Engineer"
    );
    expect(engineerRow).toBeDefined();
    const cell = data.cells.get(`${engineerRow!.slotKey}::${svc3Id}`);
    expect(cell?.blockedOut).toBe(true);
  });

  test("blocked-out flag NOT set on non-blocked cell (ISC-17)", () => {
    const { services, teams } = buildFixture();
    const data = getMatrixData(db, "2030-01-06", 8);

    // Service 1 engineer (Dave not blocked that date)
    const svc1Id = services[0]!.id;
    const engineerRow = data.rows.find(
      (r) => r.teamId === teams.sound.id && r.roleName === "Engineer"
    );
    expect(engineerRow).toBeDefined();
    const cell = data.cells.get(`${engineerRow!.slotKey}::${svc1Id}`);
    expect(cell?.blockedOut).toBe(false);
  });

  test("empty DB returns empty matrix gracefully", () => {
    const data = getMatrixData(db, "2030-01-01", 8);
    expect(data.services).toHaveLength(0);
    expect(data.rows).toHaveLength(0);
    expect(data.cells.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP route rendering tests (ISC-16, ISC-17, ISC-18)
// ---------------------------------------------------------------------------

/** Build a minimal Hono app around the matrix router, bypassing auth. */
function buildApp(): Hono {
  const app = new Hono();
  app.route("/admin/matrix", matrixRouter);
  return app;
}

describe("GET /admin/matrix — HTML rendering", () => {
  test("ISC-16: renders ≥4 service column headers", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    expect(res.status).toBe(200);
    const html = await res.text();

    // Count data-service-id attributes on column headers
    const matches = html.match(/data-service-id="\d+"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  test("ISC-16: renders exactly 6 column headers for 6-service fixture", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    const matches = html.match(/data-service-id="\d+"/g) ?? [];
    expect(matches.length).toBe(6);
  });

  test("ISC-16: renders a row for EVERY slot position (7 rows for fixture)", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    // Each body row carries data-slot-key
    const rowMatches = html.match(/data-slot-key="[^"]+"/g) ?? [];
    expect(rowMatches.length).toBe(7);
  });

  test("ISC-17: cell-confirmed class is present in HTML", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    expect(html).toContain("cell-confirmed");
  });

  test("ISC-17: cell-pending class is present in HTML", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    expect(html).toContain("cell-pending");
  });

  test("ISC-17: cell-declined class is present in HTML", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    expect(html).toContain("cell-declined");
  });

  test("ISC-17: cell-unfilled class is present in HTML", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    expect(html).toContain("cell-unfilled");
  });

  test("ISC-17: all four state classes present simultaneously", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    expect(html).toContain("cell-confirmed");
    expect(html).toContain("cell-pending");
    expect(html).toContain("cell-declined");
    expect(html).toContain("cell-unfilled");
  });

  test("ISC-17: confirmed cell contains correct assignee name", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    // Dave is confirmed on service 1 as Engineer
    expect(html).toContain("Dave");
  });

  test("ISC-17: blocked-out conflict indicator (⚠) present in HTML", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    // The conflict indicator uses &#9888; (⚠) and class cell-conflict/cell-blocked
    expect(html).toContain("cell-blocked");
    expect(html).toContain("cell-conflict");
    // HTML entity for ⚠
    expect(html).toContain("&#9888;");
  });

  test("ISC-17: cells link to service detail pages", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    expect(html).toContain('href="/admin/services/');
  });

  test("ISC-17: non-color distinction symbols present (✓ ? ✗ —)", async () => {
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    // ✓ confirmed, ? pending, ✗ declined, — unfilled
    expect(html).toContain("&#10003;"); // ✓
    expect(html).toContain("&#63;");    // ?
    expect(html).toContain("&#10007;"); // ✗
    expect(html).toContain("&mdash;");  // —
  });

  test("ISC-18 (CSS contract): matrix-wrapper class present with overflow-x:auto rule in stylesheet", async () => {
    // Assert the HTML carries the expected class
    buildFixture();
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    expect(html).toContain("matrix-wrapper");
    expect(html).toContain("matrix-table");
    expect(html).toContain("matrix-row-label");
  });

  test("ISC-18 (CSS contract): style.css contains overflow-x:auto on .matrix-wrapper", async () => {
    const css = await Bun.file(
      new URL("../public/style.css", import.meta.url)
    ).text();
    expect(css).toContain(".matrix-wrapper");
    expect(css).toContain("overflow-x: auto");
  });

  test("ISC-18 (CSS contract): style.css contains position:sticky and left:0 on .matrix-row-label", async () => {
    const css = await Bun.file(
      new URL("../public/style.css", import.meta.url)
    ).text();
    expect(css).toContain(".matrix-row-label");
    expect(css).toContain("position: sticky");
    expect(css).toContain("left: 0");
  });

  test("ISC-18 (CSS contract): .matrix-table neutralizes sticky-breaking ancestor rules", async () => {
    const css = await Bun.file(
      new URL("../public/style.css", import.meta.url)
    ).text();
    // position:sticky on th silently fails under border-collapse:collapse, and the
    // generic `table { overflow: hidden }` makes the table the sticky containing
    // block. Both verified by 768px screenshot 2026-06-10; do not regress.
    const matrixBlock = css.slice(css.indexOf(".matrix-table"));
    expect(matrixBlock).toContain("border-collapse: separate");
    expect(matrixBlock).toContain("overflow: visible");
  });

  test("ISC-18 (CSS contract): style.css contains responsive media query for 768px", async () => {
    const css = await Bun.file(
      new URL("../public/style.css", import.meta.url)
    ).text();
    expect(css).toContain("768px");
  });

  // NOTE (ISC-18): Visual screenshot at 768px viewport is PENDING VERIFY evidence.
  // The CSS contract is asserted above; a human visual check at 768px must happen
  // before ISC-18 can be checked off as fully verified.

  test("renders 'no services' message gracefully when window is empty", async () => {
    // No fixture built — empty DB
    const app = buildApp();
    const res = await app.request("/admin/matrix?from=2099-01-01");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No upcoming services");
  });
});

// ---------------------------------------------------------------------------
// Paging tests
// ---------------------------------------------------------------------------

describe("Matrix paging — ?from= window selection", () => {
  test("?from= drives window deterministically (start at 3rd service)", async () => {
    buildFixture();
    const app = buildApp();
    // 2030-01-20 is the 3rd Sunday — window should start there
    const res = await app.request("/admin/matrix?from=2030-01-20");
    const html = await res.text();
    // Should have 4 services: 1/20, 1/27, 2/3, 2/10
    const matches = html.match(/data-service-id="\d+"/g) ?? [];
    expect(matches.length).toBe(4);
    // First column header should mention Jan 20
    expect(html).toContain("Jan 20");
  });

  test("next link present when more services exist beyond window", async () => {
    buildFixture();
    const app = buildApp();
    // With limit 4, there will be services beyond the window
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    // Next paging link present with a ?from= param
    expect(html).toMatch(/href="\/admin\/matrix\?from=2030-0[12]-\d\d">Later/);
  });

  test("earlier link absent when at the very beginning", async () => {
    buildFixture();
    const app = buildApp();
    // 2030-01-06 is the first service date — no earlier services
    const res = await app.request("/admin/matrix?from=2030-01-06");
    const html = await res.text();
    // Should not have an active href for earlier
    expect(html).not.toContain('href="/admin/matrix?from=" ');
    // The Earlier button should be disabled (no href pointing to a date)
    expect(html).toMatch(/opacity:\.4[^<]*Earlier/);
  });

  test("paging links point to correct dates", async () => {
    buildFixture();
    const app = buildApp();
    // Start at 2030-01-20 (3rd service); window = 4 services (1/20,1/27,2/3,2/10)
    const res = await app.request("/admin/matrix?from=2030-01-20");
    const html = await res.text();

    // Next: day after last service in window (2030-02-10 + 1 = 2030-02-11)
    expect(html).toContain('href="/admin/matrix?from=2030-02-11"');
    // Prev: earliest of up-to-8 services before 2030-01-20 = 2030-01-06
    expect(html).toContain('href="/admin/matrix?from=2030-01-06"');
  });
});
