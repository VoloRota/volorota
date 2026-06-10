/**
 * ServiceNotes test suite
 * Covers ISC-45 (admin CRUD) and ISC-46 (volunteer page rendering)
 *
 * All tests use an in-memory SQLite DB.
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
  createServiceNote,
  listServiceNotes,
  listRelevantNotesForVolunteer,
  deleteServiceNote,
} from "../src/db/queries.js";
import { createOrReplaceToken } from "../src/volunteer/tokens.js";
import { servicesRouter } from "../src/routes/services.js";
import { volunteerRouter } from "../src/routes/volunteer.js";

// ---------------------------------------------------------------------------
// App factory helpers
// ---------------------------------------------------------------------------

function buildAdminApp(db: Database): Hono {
  const app = new Hono();
  // Attach without admin auth middleware (tests bypass auth)
  app.route("/admin/services", servicesRouter);
  return app;
}

function buildVolApp(db: Database): Hono {
  const app = new Hono();
  app.route("/v", volunteerRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: Database;
let adminApp: Hono;
let volApp: Hono;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  adminApp = buildAdminApp(db);
  volApp = buildVolApp(db);
});

afterEach(() => {
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

// ---------------------------------------------------------------------------
// ISC-45: Admin note CRUD
// ---------------------------------------------------------------------------

test("ISC-45: service-wide note persists and appears on service detail", async () => {
  const team = createTeam(db, "Sound", "individual");
  const svc = createOneOffService(db, "Sunday Morning", "2026-07-06", "10:30", []);

  const res = await adminApp.request(`/admin/services/${svc.id}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `body=Check+wireless+mics+before+service&team_id=`,
  });

  // Should redirect back to service detail
  expect(res.status).toBe(302);

  // Note should be persisted in DB
  const notes = listServiceNotes(db, svc.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.body).toBe("Check wireless mics before service");
  expect(notes[0]!.team_id).toBeNull();
  expect(notes[0]!.service_id).toBe(svc.id);

  // Should render on service detail page
  const detailRes = await adminApp.request(`/admin/services/${svc.id}`);
  const html = await detailRes.text();
  expect(html).toContain("Check wireless mics before service");
  expect(html).toContain("Service Notes");
});

test("ISC-45: team-scoped note persists and is labeled with team name", async () => {
  const team = createTeam(db, "Worship", "individual");
  const svc = createOneOffService(db, "Sunday Morning", "2026-07-06", "10:30", []);

  const res = await adminApp.request(`/admin/services/${svc.id}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `body=Song+list+at+https%3A%2F%2Fexample.com%2Fsongs&team_id=${team.id}`,
  });

  expect(res.status).toBe(302);

  const notes = listServiceNotes(db, svc.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.team_id).toBe(team.id);

  // Detail page labels team-scoped notes
  const html = await (await adminApp.request(`/admin/services/${svc.id}`)).text();
  expect(html).toContain("Worship");
  expect(html).toContain("Song list at");
});

test("ISC-45: delete note removes it from DB and it no longer renders", async () => {
  const svc = createOneOffService(db, "Sunday", "2026-07-06", "10:30", []);
  const note = createServiceNote(db, svc.id, null, "Temporary note to delete");

  // Verify it exists
  expect(listServiceNotes(db, svc.id)).toHaveLength(1);

  const res = await adminApp.request(
    `/admin/services/${svc.id}/notes/${note.id}/delete`,
    { method: "POST" }
  );
  expect(res.status).toBe(302);

  // Verify deleted from DB
  expect(listServiceNotes(db, svc.id)).toHaveLength(0);

  // Verify absent from detail page
  const html = await (await adminApp.request(`/admin/services/${svc.id}`)).text();
  expect(html).not.toContain("Temporary note to delete");
});

test("ISC-45: service-wide and team-scoped notes both render on service detail", async () => {
  const team = createTeam(db, "AV Team", "individual");
  const svc = createOneOffService(db, "Sunday", "2026-07-06", "10:30", []);

  createServiceNote(db, svc.id, null, "Service-wide announcement");
  createServiceNote(db, svc.id, team.id, "AV setup notes");

  const html = await (await adminApp.request(`/admin/services/${svc.id}`)).text();
  expect(html).toContain("Service-wide announcement");
  expect(html).toContain("AV setup notes");
  expect(html).toContain("AV Team");
});

// ---------------------------------------------------------------------------
// ISC-46: Volunteer page notes rendering
// ---------------------------------------------------------------------------

test("ISC-46: volunteer sees service-wide note on their assignment", async () => {
  const person = createPerson(db, "Alice", "alice@example.com");
  const team = createTeam(db, "Sound", "individual");
  addTeamMember(db, person.id, team.id);

  const svc = createOneOffService(db, "Sunday", "2099-07-06", "10:30", []);
  const slotId = createSlot(db, svc.id, team.id);
  db.prepare(
    "INSERT INTO assignments (service_slot_id, person_id, status) VALUES (?, ?, 'confirmed')"
  ).run(slotId, person.id);

  // Service-wide note (no team)
  createServiceNote(db, svc.id, null, "Doors open at 9am");

  const token = await createOrReplaceToken(db, person.id);
  const res = await volApp.request(`/v/${token}`);
  const html = await res.text();

  expect(html).toContain("Doors open at 9am");
});

test("ISC-46: volunteer sees own-team note on their assignment", async () => {
  const person = createPerson(db, "Bob", "bob@example.com");
  const team = createTeam(db, "Worship", "individual");
  addTeamMember(db, person.id, team.id);

  const svc = createOneOffService(db, "Sunday", "2099-07-06", "10:30", []);
  const slotId = createSlot(db, svc.id, team.id);
  db.prepare(
    "INSERT INTO assignments (service_slot_id, person_id, status) VALUES (?, ?, 'pending')"
  ).run(slotId, person.id);

  createServiceNote(db, svc.id, team.id, "Worship team: meet at 8am for prayer");

  const token = await createOrReplaceToken(db, person.id);
  const html = await (await volApp.request(`/v/${token}`)).text();
  expect(html).toContain("Worship team: meet at 8am for prayer");
});

test("ISC-46: volunteer does NOT see another team's note", async () => {
  const person = createPerson(db, "Carol", "carol@example.com");
  const myTeam = createTeam(db, "Ushers", "individual");
  const otherTeam = createTeam(db, "AV Team", "individual");
  addTeamMember(db, person.id, myTeam.id);

  const svc = createOneOffService(db, "Sunday", "2099-07-06", "10:30", []);
  const slotId = createSlot(db, svc.id, myTeam.id);
  db.prepare(
    "INSERT INTO assignments (service_slot_id, person_id, status) VALUES (?, ?, 'confirmed')"
  ).run(slotId, person.id);

  // Note scoped to the OTHER team — volunteer should NOT see this
  createServiceNote(db, svc.id, otherTeam.id, "AV-only internal setup note");
  // Service-wide note — volunteer SHOULD see this
  createServiceNote(db, svc.id, null, "Everyone: remember to sign in");

  const token = await createOrReplaceToken(db, person.id);
  const html = await (await volApp.request(`/v/${token}`)).text();

  expect(html).toContain("Everyone: remember to sign in");
  expect(html).not.toContain("AV-only internal setup note");
});

test("ISC-46: URL in note body renders as clickable <a href>", async () => {
  const person = createPerson(db, "Dave", "dave@example.com");
  const team = createTeam(db, "Tech", "individual");
  addTeamMember(db, person.id, team.id);

  const svc = createOneOffService(db, "Sunday", "2099-07-06", "10:30", []);
  const slotId = createSlot(db, svc.id, team.id);
  db.prepare(
    "INSERT INTO assignments (service_slot_id, person_id, status) VALUES (?, ?, 'confirmed')"
  ).run(slotId, person.id);

  createServiceNote(db, svc.id, null, "Setup doc: https://example.com/setup-guide");

  const token = await createOrReplaceToken(db, person.id);
  const html = await (await volApp.request(`/v/${token}`)).text();

  // URL must appear as a clickable link
  expect(html).toContain('<a href="https://example.com/setup-guide"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener"');
});

test("ISC-46: XSS probe — <script> in note body is HTML-escaped, not injected", async () => {
  const person = createPerson(db, "Eve", "eve@example.com");
  const team = createTeam(db, "Security", "individual");
  addTeamMember(db, person.id, team.id);

  const svc = createOneOffService(db, "Sunday", "2099-07-06", "10:30", []);
  const slotId = createSlot(db, svc.id, team.id);
  db.prepare(
    "INSERT INTO assignments (service_slot_id, person_id, status) VALUES (?, ?, 'confirmed')"
  ).run(slotId, person.id);

  const xssPayload = '<script>alert(1)</script>';
  createServiceNote(db, svc.id, null, xssPayload);

  const token = await createOrReplaceToken(db, person.id);
  const html = await (await volApp.request(`/v/${token}`)).text();

  // Raw <script> tag must NOT appear in the output
  expect(html).not.toContain('<script>alert(1)</script>');
  // Escaped version should appear instead
  expect(html).toContain('&lt;script&gt;');
});

// ---------------------------------------------------------------------------
// Query-level unit tests for listRelevantNotesForVolunteer
// ---------------------------------------------------------------------------

test("listRelevantNotesForVolunteer returns service-wide and own-team notes only", () => {
  const teamA = createTeam(db, "Team A", "individual");
  const teamB = createTeam(db, "Team B", "individual");
  const svc = createOneOffService(db, "Service", "2026-07-06", "10:30", []);

  createServiceNote(db, svc.id, null, "All volunteers note");
  createServiceNote(db, svc.id, teamA.id, "Team A note");
  createServiceNote(db, svc.id, teamB.id, "Team B note");

  const forA = listRelevantNotesForVolunteer(db, svc.id, teamA.id);
  expect(forA).toHaveLength(2);
  expect(forA.map((n) => n.body)).toContain("All volunteers note");
  expect(forA.map((n) => n.body)).toContain("Team A note");
  expect(forA.map((n) => n.body)).not.toContain("Team B note");

  const forB = listRelevantNotesForVolunteer(db, svc.id, teamB.id);
  expect(forB).toHaveLength(2);
  expect(forB.map((n) => n.body)).toContain("All volunteers note");
  expect(forB.map((n) => n.body)).toContain("Team B note");
  expect(forB.map((n) => n.body)).not.toContain("Team A note");
});
