/**
 * Notification tests — ISC-31, ISC-36
 *
 * Covers:
 *  - Leader notification on decline
 *  - Leader notification on replacement acceptance
 *  - No-leader fallback to VOLOROTA_ADMIN_EMAIL
 *  - Neither leader nor admin email → skipped_no_recipient outbox row
 *  - Outbox page renders rows + capture-mode banner
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createTeam,
  addTeamMember,
  createOneOffService,
  createAssignment,
  getAssignment,
} from "../src/db/queries.js";
import {
  createOrReplaceToken,
} from "../src/volunteer/tokens.js";
import {
  getCapturedMail,
  clearCapturedMail,
  sendLeaderNotification,
} from "../src/mail/mailer.js";
import { volunteerRouter } from "../src/routes/volunteer.js";
import { outboxRouter } from "../src/routes/outbox.js";
import {
  authMiddleware,
  handleLoginGet,
  handleLoginPost,
  handleLogout,
  type AuthEnv,
} from "../src/auth.js";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function buildApp(db: Database): Hono {
  const app = new Hono();
  app.route("/v", volunteerRouter);
  return app;
}

function buildAdminApp(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  app.get("/admin/login", handleLoginGet);
  app.post("/admin/login", handleLoginPost);
  app.post("/admin/logout", handleLogout);
  app.use("/admin/*", authMiddleware);
  app.route("/admin/outbox", outboxRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: Database;
let app: Hono;
let adminApp: ReturnType<typeof buildAdminApp>;

const ADMIN_PASSWORD = "testpass";

beforeEach(() => {
  process.env.VOLOROTA_ADMIN_PASSWORD = ADMIN_PASSWORD;
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  clearCapturedMail();
  app = buildApp(db);
  adminApp = buildAdminApp(db);
});

afterEach(() => {
  delete process.env.VOLOROTA_ADMIN_EMAIL;
  db.close();
});

function createSlot(
  db: Database,
  serviceId: number,
  teamId: number,
  roleName = "Volunteer",
  position = 0
): number {
  const result = db
    .prepare(
      "INSERT INTO service_slots (service_id, team_id, role_name, position) VALUES (?, ?, ?, ?) RETURNING id"
    )
    .get(serviceId, teamId, roleName, position) as { id: number };
  return result.id;
}

function setTeamLeader(db: Database, teamId: number, personId: number | null): void {
  db.prepare("UPDATE teams SET leader_person_id = ? WHERE id = ?").run(personId, teamId);
}

async function getAdminSession(app: Hono<AuthEnv>): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`,
    })
  );
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie;
}

// ---------------------------------------------------------------------------
// ISC-31: Leader notification on decline
// ---------------------------------------------------------------------------

test("ISC-31: decline sends email to team leader", async () => {
  const leader = createPerson(db, "Leader Laura", "laura@example.com");
  const volunteer = createPerson(db, "Alice", "alice@example.com");
  const team = createTeam(db, "Worship", "individual");
  addTeamMember(db, leader.id, team.id);
  addTeamMember(db, volunteer.id, team.id);
  setTeamLeader(db, team.id, leader.id);

  const svc = createOneOffService(db, "Sunday Service", "2030-06-15", "10:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Vocals");
  const assignment = createAssignment(db, slotId, volunteer.id);

  const token = await createOrReplaceToken(db, volunteer.id);

  clearCapturedMail();
  const res = await app.fetch(
    new Request(`http://localhost/v/${token}/assignments/${assignment.id}/decline`, {
      method: "POST",
    })
  );
  expect(res.status).toBeLessThan(500);

  const captured = getCapturedMail();
  const leaderMail = captured.find((m) => m.to === "laura@example.com");
  expect(leaderMail).toBeDefined();
  expect(leaderMail!.subject).toContain("declined");
  expect(leaderMail!.text).toContain("Sunday Service");
  expect(leaderMail!.text).toContain("2030-06-15");
  expect(leaderMail!.text).toContain("Vocals");
  expect(leaderMail!.text).toContain("Alice");
});

test("ISC-31: decline with no leader falls back to VOLOROTA_ADMIN_EMAIL", async () => {
  process.env.VOLOROTA_ADMIN_EMAIL = "admin@example.com";

  const volunteer = createPerson(db, "Bob", "bob@example.com");
  const team = createTeam(db, "Sound", "individual");
  addTeamMember(db, volunteer.id, team.id);
  // No leader set

  const svc = createOneOffService(db, "Evening Service", "2030-07-01", "18:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Sound");
  const assignment = createAssignment(db, slotId, volunteer.id);

  const token = await createOrReplaceToken(db, volunteer.id);

  clearCapturedMail();
  await app.fetch(
    new Request(`http://localhost/v/${token}/assignments/${assignment.id}/decline`, {
      method: "POST",
    })
  );

  const captured = getCapturedMail();
  const adminMail = captured.find((m) => m.to === "admin@example.com");
  expect(adminMail).toBeDefined();
  expect(adminMail!.text).toContain("Evening Service");
});

test("ISC-31: decline with no leader and no ADMIN_EMAIL writes skipped_no_recipient outbox row", async () => {
  delete process.env.VOLOROTA_ADMIN_EMAIL;

  const volunteer = createPerson(db, "Carol", "carol@example.com");
  const team = createTeam(db, "Greeting", "individual");
  addTeamMember(db, volunteer.id, team.id);
  // No leader, no admin email

  const svc = createOneOffService(db, "Morning Service", "2030-08-10", "09:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Greeter");
  const assignment = createAssignment(db, slotId, volunteer.id);

  await sendLeaderNotification(db, assignment.id, "declined");

  // Should NOT have sent any email
  const captured = getCapturedMail();
  expect(captured).toHaveLength(0);

  // Should have a skipped_no_recipient row in outbox
  const skipped = db
    .query("SELECT * FROM outbox WHERE status = 'skipped_no_recipient'")
    .all() as Array<{ status: string; to_email: string }>;
  expect(skipped.length).toBeGreaterThanOrEqual(1);
  expect(skipped[0]!.to_email).toBe("");
});

// ---------------------------------------------------------------------------
// ISC-31: Leader notification on replacement acceptance
// ---------------------------------------------------------------------------

test("ISC-31: replacement acceptance sends email to team leader", async () => {
  const leader = createPerson(db, "Leader Lee", "lee@example.com");
  const alice = createPerson(db, "Alice", "alice@example.com");
  const bob = createPerson(db, "Bob", "bob@example.com");
  const team = createTeam(db, "Media", "individual");
  addTeamMember(db, leader.id, team.id);
  addTeamMember(db, alice.id, team.id);
  addTeamMember(db, bob.id, team.id);
  setTeamLeader(db, team.id, leader.id);

  const svc = createOneOffService(db, "Sunday AV", "2030-09-14", "10:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Camera");
  const aliceAssignment = createAssignment(db, slotId, alice.id);
  const aliceToken = await createOrReplaceToken(db, alice.id);

  // Alice declines
  await app.fetch(
    new Request(`http://localhost/v/${aliceToken}/assignments/${aliceAssignment.id}/decline`, {
      method: "POST",
    })
  );

  // Alice requests Bob
  clearCapturedMail();
  const reqBody = new URLSearchParams({ requested_person_id: String(bob.id) });
  await app.fetch(
    new Request(`http://localhost/v/${aliceToken}/assignments/${aliceAssignment.id}/request-replacement`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: reqBody.toString(),
    })
  );

  // Extract Bob's token from the email
  const bobEmail = getCapturedMail().find((m) => m.to === "bob@example.com");
  expect(bobEmail).toBeDefined();
  const tokenMatch = bobEmail!.text.match(/\/v\/([A-Za-z0-9_-]+)/);
  const bobToken = tokenMatch![1]!;
  const rrMatch = bobEmail!.text.match(/\/replacement\/(\d+)/);
  const rrId = Number(rrMatch![1]);

  // Bob accepts
  clearCapturedMail();
  await app.fetch(
    new Request(`http://localhost/v/${bobToken}/replacement/${rrId}/accept`, {
      method: "POST",
    })
  );

  const captured = getCapturedMail();
  const leaderMail = captured.find((m) => m.to === "lee@example.com");
  expect(leaderMail).toBeDefined();
  expect(leaderMail!.subject).toContain("Replacement confirmed");
  expect(leaderMail!.text).toContain("Sunday AV");
  expect(leaderMail!.text).toContain("Bob");
});

// ---------------------------------------------------------------------------
// ISC-36: Outbox page renders rows + capture-mode banner
// ---------------------------------------------------------------------------

test("ISC-36: outbox page renders capture-mode banner when SMTP not configured", async () => {
  delete process.env.VOLOROTA_SMTP_HOST;
  const session = await getAdminSession(adminApp);

  const res = await adminApp.fetch(
    new Request("http://localhost/admin/outbox", {
      headers: { Cookie: session },
    })
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html.toLowerCase()).toContain("capture mode");
  expect(html.toLowerCase()).toContain("smtp");
});

test("ISC-36: outbox page lists email rows after sends", async () => {
  // Send a couple of emails via the capture transport
  const volunteer = createPerson(db, "Dave", "dave@example.com");
  const leader = createPerson(db, "Leader", "leader@example.com");
  const team = createTeam(db, "Tech", "individual");
  addTeamMember(db, volunteer.id, team.id);
  addTeamMember(db, leader.id, team.id);
  setTeamLeader(db, team.id, leader.id);

  const svc = createOneOffService(db, "Tech Sunday", "2030-10-05", "10:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Tech");
  const assignment = createAssignment(db, slotId, volunteer.id);

  const token = await createOrReplaceToken(db, volunteer.id);
  await app.fetch(
    new Request(`http://localhost/v/${token}/assignments/${assignment.id}/decline`, {
      method: "POST",
    })
  );

  const session = await getAdminSession(adminApp);
  const res = await adminApp.fetch(
    new Request("http://localhost/admin/outbox", {
      headers: { Cookie: session },
    })
  );
  expect(res.status).toBe(200);
  const html = await res.text();

  // Should have outbox rows
  expect(html).toContain("leader@example.com");
});

test("ISC-36: outbox page is auth-gated (unauthenticated gets redirect or 401)", async () => {
  // With Accept: text/html the middleware redirects; without it returns 401.
  // Both mean the page is protected. Test the HTML path (browser scenario).
  const res = await adminApp.fetch(
    new Request("http://localhost/admin/outbox", {
      headers: { Accept: "text/html" },
    })
  );
  // Should redirect to login (302) for HTML requests
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location).toContain("login");
});
