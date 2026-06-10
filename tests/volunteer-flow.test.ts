/**
 * VolunteerFlow test suite
 * Covers ISC-19, ISC-27, ISC-28, ISC-29, ISC-30, ISC-32, ISC-33
 *
 * All tests use an in-memory SQLite DB and the capture mail transport.
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
  createBlockout,
  listBlockoutsForPerson,
} from "../src/db/queries.js";
import {
  generateRawToken,
  createOrReplaceToken,
  lookupToken,
  hashToken,
} from "../src/volunteer/tokens.js";
import {
  sendAssignmentEmail,
  getCapturedMail,
  clearCapturedMail,
} from "../src/mail/mailer.js";
import { volunteerRouter } from "../src/routes/volunteer.js";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function buildApp(db: Database): Hono {
  const app = new Hono();
  app.route("/v", volunteerRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Test fixtures & helpers
// ---------------------------------------------------------------------------

let db: Database;
let app: Hono;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db); // includes extendSchemaForVolunteer
  setDb(db);
  clearCapturedMail();
  app = buildApp(db);
});

afterEach(() => {
  db.close();
});

/** Create a service slot directly (for tests that need precise slot control) */
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

// ---------------------------------------------------------------------------
// ISC-32: Token entropy and expiry
// ---------------------------------------------------------------------------

test("ISC-32: generateRawToken produces ≥32 bytes (256-bit entropy)", () => {
  const token = generateRawToken();
  // base64url decodes to >= 32 bytes
  // base64url: replace -_ back to +/ and add padding
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "==".slice(0, (4 - (base64.length % 4)) % 4);
  const decoded = atob(padded);
  // Each char is one byte
  expect(decoded.length).toBeGreaterThanOrEqual(32);
});

test("ISC-32: expired token returns 4xx page containing no assignment data", async () => {
  const person = createPerson(db, "Alice", "alice@example.com");
  // Insert a token that expired yesterday
  const raw = generateRawToken();
  const hash = await hashToken(raw);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const expiresAt = yesterday.toISOString().replace("T", " ").slice(0, 19);
  db.prepare(
    "INSERT INTO volunteer_tokens (person_id, token_hash, expires_at) VALUES (?, ?, ?)"
  ).run(person.id, hash, expiresAt);

  // Create an assignment for alice
  const team = createTeam(db, "Worship", "individual");
  addTeamMember(db, person.id, team.id);
  const svc = createOneOffService(db, "Sunday Service", "2030-01-05", "10:00", []);
  const slotId = createSlot(db, svc.id, team.id);
  createAssignment(db, slotId, person.id);

  const req = new Request(`http://localhost/v/${raw}`, {
    headers: { Accept: "text/html" },
  });
  const res = await app.fetch(req);

  // Must be 4xx (we use 410 Gone)
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);

  const html = await res.text();
  // Must NOT contain assignment data
  expect(html).not.toContain("Sunday Service");
  expect(html).not.toContain("Alice");
  // Must contain re-request form
  expect(html).toContain("request-fresh-link");
  // Must NOT contain login/password inputs
  expect(html).not.toMatch(/type=["']password["']/i);
});

test("ISC-32: completely unknown token returns same class of 4xx page", async () => {
  const unknownToken = generateRawToken();
  const req = new Request(`http://localhost/v/${unknownToken}`, {
    headers: { Accept: "text/html" },
  });
  const res = await app.fetch(req);

  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);

  const html = await res.text();
  // Same expired page pattern — must have the re-request form
  expect(html).toContain("request-fresh-link");
  expect(html).not.toMatch(/type=["']password["']/i);
});

// ---------------------------------------------------------------------------
// ISC-27: Assignment email contains magic link; opening it shows assignment
// with accept/decline; NO login wall
// ---------------------------------------------------------------------------

test("ISC-27: sendAssignmentEmail captures email whose body contains /v/<token>", async () => {
  const person = createPerson(db, "Bob", "bob@example.com");
  const team = createTeam(db, "Ushers", "individual");
  addTeamMember(db, person.id, team.id);
  const svc = createOneOffService(db, "Sunday Morning", "2030-06-15", "10:30", []);
  const slotId = createSlot(db, svc.id, team.id);
  const assignment = createAssignment(db, slotId, person.id);

  await sendAssignmentEmail(db, assignment.id);

  const captured = getCapturedMail();
  expect(captured).toHaveLength(1);

  const email = captured[0]!;
  expect(email.to).toBe("bob@example.com");
  expect(email.text).toContain("/v/");
});

test("ISC-27: GET /v/:token shows assignment with Accept and Decline controls, NO login wall", async () => {
  const person = createPerson(db, "Carol", "carol@example.com");
  const team = createTeam(db, "Sound", "individual");
  addTeamMember(db, person.id, team.id);
  const svc = createOneOffService(db, "Evening Service", "2030-07-20", "18:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Sound Engineer");
  const assignment = createAssignment(db, slotId, person.id);

  // Send email and extract the token from the captured email
  await sendAssignmentEmail(db, assignment.id);
  const captured = getCapturedMail();
  expect(captured).toHaveLength(1);

  const emailText = captured[0]!.text;
  const match = emailText.match(/\/v\/([A-Za-z0-9_-]+)/);
  expect(match).not.toBeNull();
  const rawToken = match![1]!;

  // GET the magic link
  const req = new Request(`http://localhost/v/${rawToken}`, {
    headers: { Accept: "text/html" },
  });
  const res = await app.fetch(req);
  expect(res.status).toBe(200);

  const html = await res.text();
  // Shows assignment info
  expect(html).toContain("Evening Service");
  expect(html).toContain("Sound Engineer");
  // Has Accept and Decline controls
  expect(html).toContain("Accept");
  expect(html).toContain("Decline");
  // NO password or login wall
  expect(html).not.toMatch(/type=["']password["']/i);
  expect(html).not.toMatch(/login|sign.?in/i);
});

// ---------------------------------------------------------------------------
// ISC-28: Accept → confirmed; Decline → declined
// ---------------------------------------------------------------------------

test("ISC-28: accept POST flips assignment status to confirmed", async () => {
  const person = createPerson(db, "Dave", "dave@example.com");
  const team = createTeam(db, "Media", "individual");
  addTeamMember(db, person.id, team.id);
  const svc = createOneOffService(db, "Sunday Service", "2030-08-10", "10:00", []);
  const slotId = createSlot(db, svc.id, team.id);
  const assignment = createAssignment(db, slotId, person.id);

  const rawToken = await createOrReplaceToken(db, person.id);

  const req = new Request(
    `http://localhost/v/${rawToken}/assignments/${assignment.id}/accept`,
    { method: "POST" }
  );
  const res = await app.fetch(req);
  expect(res.status).toBe(302);

  const updated = getAssignment(db, assignment.id);
  expect(updated?.status).toBe("confirmed");
});

test("ISC-28: decline POST flips assignment status to declined", async () => {
  const person = createPerson(db, "Eve", "eve@example.com");
  const team = createTeam(db, "Greeting", "individual");
  addTeamMember(db, person.id, team.id);
  const svc = createOneOffService(db, "Saturday Service", "2030-08-17", "09:00", []);
  const slotId = createSlot(db, svc.id, team.id);
  const assignment = createAssignment(db, slotId, person.id);

  const rawToken = await createOrReplaceToken(db, person.id);

  const req = new Request(
    `http://localhost/v/${rawToken}/assignments/${assignment.id}/decline`,
    { method: "POST" }
  );
  const res = await app.fetch(req);
  // 200 (rendered decline + replacements page) or 302
  expect(res.status).toBeLessThan(500);

  const updated = getAssignment(db, assignment.id);
  expect(updated?.status).toBe("declined");
});

// ---------------------------------------------------------------------------
// ISC-29: Decline shows exactly eligible teammates
// Fixture: one blocked, one already serving, one eligible → only eligible shown
// ---------------------------------------------------------------------------

test("ISC-29: decline response lists exactly eligible teammates", async () => {
  const team = createTeam(db, "Worship", "individual");

  const alice = createPerson(db, "Alice", "alice@example.com");
  const bob = createPerson(db, "Bob", "bob@example.com"); // will be blocked out
  const carol = createPerson(db, "Carol", "carol@example.com"); // will already be serving
  const dave = createPerson(db, "Dave", "dave@example.com"); // eligible

  addTeamMember(db, alice.id, team.id);
  addTeamMember(db, bob.id, team.id);
  addTeamMember(db, carol.id, team.id);
  addTeamMember(db, dave.id, team.id);

  const serviceDate = "2030-09-07";
  const svc = createOneOffService(db, "Sunday Service", serviceDate, "10:00", []);

  // Slot 0: alice's slot (she declines)
  const aliceSlotId = createSlot(db, svc.id, team.id, "Lead", 0);
  const aliceAssignment = createAssignment(db, aliceSlotId, alice.id);

  // Slot 1: carol's slot (carol already serving)
  const carolSlotId = createSlot(db, svc.id, team.id, "Support", 1);
  createAssignment(db, carolSlotId, carol.id);

  // Bob: blocked out on service date
  createBlockout(db, bob.id, serviceDate, serviceDate, "Vacation");

  // Dave: no blockout, not already serving → eligible

  const rawToken = await createOrReplaceToken(db, alice.id);

  const req = new Request(
    `http://localhost/v/${rawToken}/assignments/${aliceAssignment.id}/decline`,
    { method: "POST" }
  );
  const res = await app.fetch(req);
  expect(res.status).toBeLessThan(500);

  const html = await res.text();
  // Alice declined; declined status in DB
  const updated = getAssignment(db, aliceAssignment.id);
  expect(updated?.status).toBe("declined");

  // Only Dave should appear as eligible — not Bob (blocked), not Carol (already serving),
  // not Alice (decliner)
  expect(html).toContain("Dave");
  expect(html).not.toContain("Bob");
  expect(html).not.toContain("Carol");
  // Alice should not appear as a replacement for herself
  expect(html).not.toMatch(/Ask Alice to cover/);
});

// ---------------------------------------------------------------------------
// ISC-30: Full two-token replacement flow
// A declines → requests B → email captured for B → B accepts → slot confirmed under B,
// A's original assignment removed/superseded
// ---------------------------------------------------------------------------

test("ISC-30: full two-token replacement flow", async () => {
  const team = createTeam(db, "AV", "individual");
  const alice = createPerson(db, "Alice", "alice@example.com");
  const bob = createPerson(db, "Bob", "bob@example.com");

  addTeamMember(db, alice.id, team.id);
  addTeamMember(db, bob.id, team.id);

  const svc = createOneOffService(db, "Sunday AV", "2030-10-05", "10:00", []);
  const slotId = createSlot(db, svc.id, team.id);
  const aliceAssignment = createAssignment(db, slotId, alice.id);

  const aliceToken = await createOrReplaceToken(db, alice.id);

  // Step 1: Alice declines
  await app.fetch(
    new Request(
      `http://localhost/v/${aliceToken}/assignments/${aliceAssignment.id}/decline`,
      { method: "POST" }
    )
  );
  expect(getAssignment(db, aliceAssignment.id)?.status).toBe("declined");

  // Step 2: Alice requests Bob as replacement
  clearCapturedMail();
  const reqBody = new URLSearchParams({ requested_person_id: String(bob.id) });
  const replRes = await app.fetch(
    new Request(
      `http://localhost/v/${aliceToken}/assignments/${aliceAssignment.id}/request-replacement`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: reqBody.toString(),
      }
    )
  );
  expect(replRes.status).toBeLessThan(500);

  // Email sent to Bob
  const emails = getCapturedMail();
  expect(emails.length).toBeGreaterThanOrEqual(1);
  const bobEmail = emails.find((e) => e.to === "bob@example.com");
  expect(bobEmail).toBeDefined();

  // Extract Bob's token from the email
  const linkMatch = bobEmail!.text.match(/\/v\/([A-Za-z0-9_-]+)/);
  expect(linkMatch).not.toBeNull();
  const bobRawToken = linkMatch![1]!;

  // Verify the token belongs to Bob
  const bobTok = await lookupToken(db, bobRawToken);
  expect(bobTok).not.toBeNull();
  expect(bobTok!.person_id).toBe(bob.id);

  // Extract replacement request ID from the email link
  const rrMatch = bobEmail!.text.match(/\/replacement\/(\d+)/);
  expect(rrMatch).not.toBeNull();
  const rrId = Number(rrMatch![1]);

  // Step 3: Bob views the replacement request
  const viewRes = await app.fetch(
    new Request(`http://localhost/v/${bobRawToken}/replacement/${rrId}`, {
      headers: { Accept: "text/html" },
    })
  );
  expect(viewRes.status).toBe(200);
  const viewHtml = await viewRes.text();
  expect(viewHtml).toContain("Sunday AV");

  // Step 4: Bob accepts
  const acceptRes = await app.fetch(
    new Request(
      `http://localhost/v/${bobRawToken}/replacement/${rrId}/accept`,
      { method: "POST" }
    )
  );
  expect(acceptRes.status).toBe(302);

  // Verify: active assignment for this slot is now Bob's, confirmed
  const slotAssignments = db
    .query("SELECT * FROM assignments WHERE service_slot_id = ?")
    .all(slotId) as Array<{ id: number; person_id: number; status: string }>;

  // Alice's original assignment should be gone (removed/superseded)
  const aliceStillAssigned = slotAssignments.find((a) => a.person_id === alice.id);
  expect(aliceStillAssigned).toBeUndefined();

  // Bob's assignment should exist and be confirmed
  const bobAssignment = slotAssignments.find((a) => a.person_id === bob.id);
  expect(bobAssignment).toBeDefined();
  expect(bobAssignment!.status).toBe("confirmed");

  // Replacement request should be marked accepted
  const rr = db
    .query("SELECT * FROM replacement_requests WHERE id = ?")
    .get(rrId) as { status: string } | null;
  expect(rr?.status).toBe("accepted");
});

// ---------------------------------------------------------------------------
// ISC-19: Token flow adds + removes a blockout; appears in admin blockout list
// ---------------------------------------------------------------------------

test("ISC-19: volunteer can add and remove blockout via token; blockout appears in DB", async () => {
  const person = createPerson(db, "Frank", "frank@example.com");
  const rawToken = await createOrReplaceToken(db, person.id);

  // Add blockout
  const addBody = new URLSearchParams({
    start_date: "2030-12-20",
    end_date: "2030-12-31",
    reason: "Holiday",
  });
  const addRes = await app.fetch(
    new Request(`http://localhost/v/${rawToken}/blockouts`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: addBody.toString(),
    })
  );
  expect(addRes.status).toBe(302);

  // Verify blockout in DB
  const blockouts = listBlockoutsForPerson(db, person.id);
  expect(blockouts).toHaveLength(1);
  expect(blockouts[0]!.start_date).toBe("2030-12-20");
  expect(blockouts[0]!.end_date).toBe("2030-12-31");
  expect(blockouts[0]!.reason).toBe("Holiday");

  const blockoutId = blockouts[0]!.id;

  // Remove blockout
  const deleteRes = await app.fetch(
    new Request(`http://localhost/v/${rawToken}/blockouts/${blockoutId}/delete`, {
      method: "POST",
    })
  );
  expect(deleteRes.status).toBe(302);

  // Verify removed
  const remaining = listBlockoutsForPerson(db, person.id);
  expect(remaining).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ISC-33: Cross-token isolation matrix
// ---------------------------------------------------------------------------

test("ISC-33: person A's token cannot accept/decline person B's assignment", async () => {
  const team = createTeam(db, "Tech", "individual");
  const alice = createPerson(db, "Alice", "alice@example.com");
  const bob = createPerson(db, "Bob", "bob@example.com");
  addTeamMember(db, alice.id, team.id);
  addTeamMember(db, bob.id, team.id);

  const svc = createOneOffService(db, "Test Service", "2030-11-10", "10:00", []);
  const bobSlotId = createSlot(db, svc.id, team.id);
  const bobAssignment = createAssignment(db, bobSlotId, bob.id);

  const aliceToken = await createOrReplaceToken(db, alice.id);

  // Alice's token trying to accept Bob's assignment → 404
  const acceptRes = await app.fetch(
    new Request(
      `http://localhost/v/${aliceToken}/assignments/${bobAssignment.id}/accept`,
      { method: "POST" }
    )
  );
  expect(acceptRes.status).toBe(404);

  // Alice's token trying to decline Bob's assignment → 404
  const declineRes = await app.fetch(
    new Request(
      `http://localhost/v/${aliceToken}/assignments/${bobAssignment.id}/decline`,
      { method: "POST" }
    )
  );
  expect(declineRes.status).toBe(404);

  // Status unchanged
  const assignment = getAssignment(db, bobAssignment.id);
  expect(assignment?.status).toBe("pending");
});

test("ISC-33: person A's token cannot delete person B's blockout", async () => {
  const alice = createPerson(db, "Alice", "alice@example.com");
  const bob = createPerson(db, "Bob", "bob@example.com");

  // Bob has a blockout
  const bobBlockout = createBlockout(db, bob.id, "2030-12-01", "2030-12-05");

  const aliceToken = await createOrReplaceToken(db, alice.id);

  // Alice tries to delete Bob's blockout → 404
  const deleteRes = await app.fetch(
    new Request(
      `http://localhost/v/${aliceToken}/blockouts/${bobBlockout.id}/delete`,
      { method: "POST" }
    )
  );
  expect(deleteRes.status).toBe(404);

  // Bob's blockout still exists
  const remaining = listBlockoutsForPerson(db, bob.id);
  expect(remaining).toHaveLength(1);
});

test("ISC-33: person A's token cannot view person B's replacement request", async () => {
  const team = createTeam(db, "Choir", "individual");
  const alice = createPerson(db, "Alice", "alice@example.com");
  const bob = createPerson(db, "Bob", "bob@example.com");
  const carol = createPerson(db, "Carol", "carol@example.com");
  addTeamMember(db, alice.id, team.id);
  addTeamMember(db, bob.id, team.id);
  addTeamMember(db, carol.id, team.id);

  const svc = createOneOffService(db, "Choir Service", "2030-11-17", "11:00", []);
  const slotId = createSlot(db, svc.id, team.id);
  const aliceAssignment = createAssignment(db, slotId, alice.id);

  // Alice declines and requests Bob
  const aliceToken = await createOrReplaceToken(db, alice.id);
  await app.fetch(
    new Request(
      `http://localhost/v/${aliceToken}/assignments/${aliceAssignment.id}/decline`,
      { method: "POST" }
    )
  );

  const reqBody = new URLSearchParams({ requested_person_id: String(bob.id) });
  await app.fetch(
    new Request(
      `http://localhost/v/${aliceToken}/assignments/${aliceAssignment.id}/request-replacement`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: reqBody.toString(),
      }
    )
  );

  // Get the replacement request id
  const rr = db
    .query("SELECT * FROM replacement_requests ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | null;
  expect(rr).not.toBeNull();
  const rrId = rr!.id;

  // Carol's token trying to view Bob's replacement request → 404
  const carolToken = await createOrReplaceToken(db, carol.id);
  const viewRes = await app.fetch(
    new Request(`http://localhost/v/${carolToken}/replacement/${rrId}`, {
      headers: { Accept: "text/html" },
    })
  );
  expect(viewRes.status).toBe(404);

  // Carol trying to accept Bob's replacement request → 404
  const acceptRes = await app.fetch(
    new Request(
      `http://localhost/v/${carolToken}/replacement/${rrId}/accept`,
      { method: "POST" }
    )
  );
  expect(acceptRes.status).toBe(404);
});

test("ISC-33: valid token owner can access own resources (200/302)", async () => {
  const person = createPerson(db, "Grace", "grace@example.com");
  const team = createTeam(db, "Welcome", "individual");
  addTeamMember(db, person.id, team.id);
  const svc = createOneOffService(db, "Service", "2030-12-01", "10:00", []);
  const slotId = createSlot(db, svc.id, team.id);
  const assignment = createAssignment(db, slotId, person.id);
  const blockout = createBlockout(db, person.id, "2030-12-20", "2030-12-25");

  const rawToken = await createOrReplaceToken(db, person.id);

  // GET volunteer home → 200
  const homeRes = await app.fetch(
    new Request(`http://localhost/v/${rawToken}`, {
      headers: { Accept: "text/html" },
    })
  );
  expect(homeRes.status).toBe(200);

  // Accept own assignment → 302
  const acceptRes = await app.fetch(
    new Request(
      `http://localhost/v/${rawToken}/assignments/${assignment.id}/accept`,
      { method: "POST" }
    )
  );
  expect(acceptRes.status).toBe(302);

  // Delete own blockout → 302
  const deleteRes = await app.fetch(
    new Request(
      `http://localhost/v/${rawToken}/blockouts/${blockout.id}/delete`,
      { method: "POST" }
    )
  );
  expect(deleteRes.status).toBe(302);
});
