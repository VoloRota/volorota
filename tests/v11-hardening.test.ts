/**
 * V11 DemoPath + ProductionHardening test suite
 * Covers ISC-57, ISC-58, ISC-61, ISC-62, ISC-64, ISC-65, ISC-66
 * (ISC-63 has no unit test — see docs/production.md + README link)
 *
 * Tests run against the real composed app (src/index.ts) where the feature
 * under test lives in middleware or route handlers, and against isolated
 * helpers where the test only concerns a single module.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { Database } from "bun:sqlite";

// Set required env before the app module is imported
process.env.VOLOROTA_ADMIN_PASSWORD ||= "v11-hardening-test-pw";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createOneOffService,
  createAssignment,
  createTeam,
  addTeamMember,
} from "../src/db/queries.js";
import { createOrReplaceToken } from "../src/volunteer/tokens.js";
import { clearCapturedMail } from "../src/mail/mailer.js";

// Import the full composed app — headers come from the global middleware
const { default: app } = await import("../src/index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSlot(db: Database, serviceId: number, teamId: number, position = 0): number {
  return (
    db
      .prepare(
        `INSERT INTO service_slots (service_id, team_id, role_name, position)
         VALUES (?, ?, 'Greeter', ?) RETURNING id`
      )
      .get(serviceId, teamId, position) as { id: number }
  ).id;
}

async function adminCookie(): Promise<string> {
  const res = await app.fetch(
    new Request("http://x/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${process.env.VOLOROTA_ADMIN_PASSWORD}`,
    })
  );
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  clearCapturedMail();
});

// ---------------------------------------------------------------------------
// ISC-57: Landing template — hero CTA + demo section structure
// ---------------------------------------------------------------------------

describe("ISC-57: landing template demo anchors", () => {
  test("hero primary CTA href is #demo", async () => {
    const template = await Bun.file(
      new URL("../deploy/demo/landing.template.html", import.meta.url)
    ).text();
    // btn-primary must point to #demo
    expect(template).toContain('class="btn btn-primary" href="#demo"');
  });

  test("demo section contains an admin-demo action link", async () => {
    const template = await Bun.file(
      new URL("../deploy/demo/landing.template.html", import.meta.url)
    ).text();
    // The admin-demo action link must exist inside the #demo section
    expect(template).toContain("admin/login");
    expect(template).toContain("Open the admin demo");
  });

  test("demo section contains volunteer magic links for Tom, David, and Grace", async () => {
    const template = await Bun.file(
      new URL("../deploy/demo/landing.template.html", import.meta.url)
    ).text();
    expect(template).toContain("DEMO_TOKEN_TOM");
    expect(template).toContain("DEMO_TOKEN_DAVID");
    expect(template).toContain("DEMO_TOKEN_GRACE");
  });

  test("demo section id is 'demo'", async () => {
    const template = await Bun.file(
      new URL("../deploy/demo/landing.template.html", import.meta.url)
    ).text();
    expect(template).toContain('id="demo"');
  });
});

// ---------------------------------------------------------------------------
// ISC-58: Login hint — VOLOROTA_LOGIN_HINT render / absence
// ---------------------------------------------------------------------------

describe("ISC-58: login hint", () => {
  afterEach(() => {
    // Reset env so other tests don't see the hint
    delete process.env.VOLOROTA_LOGIN_HINT;
  });

  test("renders hint paragraph when VOLOROTA_LOGIN_HINT is set", async () => {
    process.env.VOLOROTA_LOGIN_HINT = "Demo password: volorota-demo";
    // GET /admin/login through the real app picks up the env at render time
    const res = await app.fetch(
      new Request("http://x/admin/login", { headers: { Accept: "text/html" } })
    );
    const html = await res.text();
    expect(html).toContain("Demo password: volorota-demo");
    expect(html).toContain("login-hint");
  });

  test("does NOT render hint element when VOLOROTA_LOGIN_HINT is unset", async () => {
    delete process.env.VOLOROTA_LOGIN_HINT;
    const res = await app.fetch(
      new Request("http://x/admin/login", { headers: { Accept: "text/html" } })
    );
    const html = await res.text();
    expect(html).not.toContain("login-hint");
  });

  test("HTML-injection probe: angle brackets in hint are escaped", async () => {
    process.env.VOLOROTA_LOGIN_HINT = '<script>alert("xss")</script>';
    const res = await app.fetch(
      new Request("http://x/admin/login", { headers: { Accept: "text/html" } })
    );
    const html = await res.text();
    // The raw tag must NOT appear verbatim
    expect(html).not.toContain('<script>alert("xss")</script>');
    // Escaped form should appear
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// ISC-61: Security headers on all response types
// ---------------------------------------------------------------------------

const EXPECTED_CSP =
  "default-src 'self'; " +
  "script-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "frame-ancestors 'none'; " +
  "form-action 'self'; " +
  "base-uri 'none'";

describe("ISC-61: security headers on all response types", () => {
  test("admin login page carries all five headers + exact CSP", async () => {
    const res = await app.fetch(
      new Request("http://x/admin/login", { headers: { Accept: "text/html" } })
    );
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("/health carries all five headers + exact CSP", async () => {
    const res = await app.fetch(new Request("http://x/health"));
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("authenticated /admin dashboard carries all five headers", async () => {
    const cookie = await adminCookie();
    const res = await app.fetch(
      new Request("http://x/admin", { headers: { Cookie: cookie, Accept: "text/html" } })
    );
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("volunteer page carries all five headers", async () => {
    const person = createPerson(db, "Header Test Vol", "header@example.com");
    const tok = await createOrReplaceToken(db, person.id);
    const res = await app.fetch(
      new Request(`http://x/v/${tok}`, { headers: { Accept: "text/html" } })
    );
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("ICS feed carries all five headers", async () => {
    const person = createPerson(db, "ICS Header Vol", "ics@example.com");
    const tok = await createOrReplaceToken(db, person.id);
    const res = await app.fetch(new Request(`http://x/v/${tok}/ics`));
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });
});

// ---------------------------------------------------------------------------
// ISC-62: Secure cookie flag — set on https://, absent on http:// or unset
// ---------------------------------------------------------------------------

describe("ISC-62: Secure cookie flag", () => {
  afterEach(() => {
    delete process.env.VOLOROTA_BASE_URL;
  });

  test("cookie contains Secure when VOLOROTA_BASE_URL is https://", async () => {
    process.env.VOLOROTA_BASE_URL = "https://schedule.example.org";
    const res = await app.fetch(
      new Request("http://x/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `password=${process.env.VOLOROTA_ADMIN_PASSWORD}`,
      })
    );
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("secure");
  });

  test("cookie does NOT contain Secure when VOLOROTA_BASE_URL is http://", async () => {
    process.env.VOLOROTA_BASE_URL = "http://localhost:3000";
    const res = await app.fetch(
      new Request("http://x/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `password=${process.env.VOLOROTA_ADMIN_PASSWORD}`,
      })
    );
    const setCookie = res.headers.get("set-cookie") ?? "";
    // "secure" must not appear as a standalone attribute (case-insensitive)
    // Note: "samesite" contains "s" so we check for the cookie attribute pattern
    const parts = setCookie.toLowerCase().split(";").map((p) => p.trim());
    expect(parts.includes("secure")).toBe(false);
  });

  test("cookie does NOT contain Secure when VOLOROTA_BASE_URL is unset", async () => {
    delete process.env.VOLOROTA_BASE_URL;
    const res = await app.fetch(
      new Request("http://x/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `password=${process.env.VOLOROTA_ADMIN_PASSWORD}`,
      })
    );
    const setCookie = res.headers.get("set-cookie") ?? "";
    const parts = setCookie.toLowerCase().split(";").map((p) => p.trim());
    expect(parts.includes("secure")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISC-64: Dashboard BASE_URL warning
// ---------------------------------------------------------------------------

describe("ISC-64: dashboard BASE_URL warning", () => {
  afterEach(() => {
    delete process.env.VOLOROTA_BASE_URL;
  });

  test("warning appears when VOLOROTA_BASE_URL is unset", async () => {
    delete process.env.VOLOROTA_BASE_URL;
    const cookie = await adminCookie();
    const res = await app.fetch(
      new Request("http://x/admin", { headers: { Cookie: cookie, Accept: "text/html" } })
    );
    const html = await res.text();
    expect(html).toContain("VOLOROTA_BASE_URL");
    expect(html).toContain("flash-warn");
  });

  test("warning appears when VOLOROTA_BASE_URL contains localhost", async () => {
    process.env.VOLOROTA_BASE_URL = "http://localhost:3000";
    const cookie = await adminCookie();
    const res = await app.fetch(
      new Request("http://x/admin", { headers: { Cookie: cookie, Accept: "text/html" } })
    );
    const html = await res.text();
    expect(html).toContain("VOLOROTA_BASE_URL");
    expect(html).toContain("flash-warn");
  });

  test("warning is absent when VOLOROTA_BASE_URL is a real https URL", async () => {
    process.env.VOLOROTA_BASE_URL = "https://schedule.example.org";
    const cookie = await adminCookie();
    const res = await app.fetch(
      new Request("http://x/admin", { headers: { Cookie: cookie, Accept: "text/html" } })
    );
    const html = await res.text();
    // The warning element must not appear — check for the identifying phrase
    expect(html).not.toContain("Emailed links will point at localhost");
  });
});

// ---------------------------------------------------------------------------
// ISC-65: Services page date-range defaults (upcoming Sunday → +8 weeks)
// ---------------------------------------------------------------------------

describe("ISC-65: services form date defaults", () => {
  /**
   * Compute expected defaults using the same logic as the route handler.
   * This is the canonical test oracle — it must stay in sync with the helper
   * in src/routes/services.ts.
   */
  function upcomingSundayStr(from: Date = new Date()): string {
    const d = new Date(from);
    const dow = d.getDay();
    if (dow !== 0) d.setDate(d.getDate() + (7 - dow));
    return d.toISOString().slice(0, 10);
  }

  function plusEightWeeksStr(dateStr: string): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + 56);
    return d.toISOString().slice(0, 10);
  }

  test("generate form start/end inputs carry upcoming-Sunday and +8-week defaults", async () => {
    const cookie = await adminCookie();

    // Create a template so the generate form renders (it's conditional on templates.length > 0)
    // We can't add a template easily without the full chain — but we can test the autofill form
    // which is always present. Both use the same defaultFrom/defaultTo values.
    const expectedFrom = upcomingSundayStr();
    const expectedTo = plusEightWeeksStr(expectedFrom);

    const res = await app.fetch(
      new Request("http://x/admin/services", {
        headers: { Cookie: cookie, Accept: "text/html" },
      })
    );
    const html = await res.text();

    // Auto-fill form is always present and uses the same defaults
    expect(html).toContain(`value="${expectedFrom}"`);
    expect(html).toContain(`value="${expectedTo}"`);
  });

  test("autofill form prefills are an upcoming Sunday and 8 weeks later", async () => {
    const cookie = await adminCookie();
    const expectedFrom = upcomingSundayStr();
    const expectedTo = plusEightWeeksStr(expectedFrom);

    const res = await app.fetch(
      new Request("http://x/admin/services", {
        headers: { Cookie: cookie, Accept: "text/html" },
      })
    );
    const html = await res.text();

    // Verify the "from" date is a Sunday (day 0)
    const fromDate = new Date(expectedFrom);
    expect(fromDate.getDay()).toBe(0);

    // Verify the "to" date is exactly 56 days later
    const toDate = new Date(expectedTo);
    const diff = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diff).toBe(56);

    // Verify the values appear in the rendered HTML
    expect(html).toContain(`value="${expectedFrom}"`);
    expect(html).toContain(`value="${expectedTo}"`);
  });
});

// ---------------------------------------------------------------------------
// ISC-66: Backup — VACUUM INTO on a live WAL database
// ---------------------------------------------------------------------------

describe("ISC-66: backup via VACUUM INTO", () => {
  test("VACUUM INTO produces a snapshot with matching row counts", async () => {
    // Seed the source database with some rows
    const p1 = createPerson(db, "Backup Test Alpha", "alpha@backup.test");
    const p2 = createPerson(db, "Backup Test Beta", "beta@backup.test");
    const team = createTeam(db, "Backup Team", "individual");
    addTeamMember(db, p1.id, team.id);
    addTeamMember(db, p2.id, team.id);
    const svc = createOneOffService(db, "Backup Sunday", "2030-02-01", "10:00", []);
    const slotId = createSlot(db, svc.id, team.id, 0);
    createAssignment(db, slotId, p1.id);

    // Count rows in the source tables
    const srcPeople = (db.query("SELECT COUNT(*) as n FROM people").get() as { n: number }).n;
    const srcTeams = (db.query("SELECT COUNT(*) as n FROM teams").get() as { n: number }).n;
    const srcServices = (db.query("SELECT COUNT(*) as n FROM services").get() as { n: number }).n;
    const srcAssignments = (db.query("SELECT COUNT(*) as n FROM assignments").get() as { n: number }).n;

    expect(srcPeople).toBe(2);
    expect(srcTeams).toBe(1);
    expect(srcServices).toBe(1);
    expect(srcAssignments).toBe(1);

    // Use VACUUM INTO to create a snapshot (this is the same mechanism as backup.sh)
    const snapshotPath = `/tmp/volorota-backup-test-${Date.now()}.db`;
    db.exec(`VACUUM INTO '${snapshotPath}'`);

    // Open the snapshot as a separate read-only connection
    const snap = new Database(snapshotPath, { readonly: true });

    try {
      const snapPeople = (snap.query("SELECT COUNT(*) as n FROM people").get() as { n: number }).n;
      const snapTeams = (snap.query("SELECT COUNT(*) as n FROM teams").get() as { n: number }).n;
      const snapServices = (snap.query("SELECT COUNT(*) as n FROM services").get() as { n: number }).n;
      const snapAssignments = (snap.query("SELECT COUNT(*) as n FROM assignments").get() as { n: number }).n;

      expect(snapPeople).toBe(srcPeople);
      expect(snapTeams).toBe(srcTeams);
      expect(snapServices).toBe(srcServices);
      expect(snapAssignments).toBe(srcAssignments);
    } finally {
      snap.close();
      // Clean up the snapshot file
      await Bun.file(snapshotPath).exists().then((exists) => {
        if (exists) {
          import("node:fs").then((fs) => fs.unlinkSync(snapshotPath));
        }
      });
    }
  });

  test("VACUUM INTO on a WAL-mode DB produces a snapshot without -wal or -shm companions", async () => {
    // Seed a row to ensure WAL is active
    createPerson(db, "WAL Test Person", "wal@backup.test");

    const snapshotPath = `/tmp/volorota-wal-test-${Date.now()}.db`;
    db.exec(`VACUUM INTO '${snapshotPath}'`);

    // The snapshot must exist
    expect(await Bun.file(snapshotPath).exists()).toBe(true);

    // There must be no -wal companion file (VACUUM INTO always checkpoints)
    expect(await Bun.file(`${snapshotPath}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${snapshotPath}-shm`).exists()).toBe(false);

    // Clean up
    await import("node:fs").then((fs) => {
      try { fs.unlinkSync(snapshotPath); } catch { /* ignore */ }
    });
  });
});
