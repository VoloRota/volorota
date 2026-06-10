/**
 * CoreDataLayer test suite
 * Covers ISC-7 through ISC-15 and ISC-47, ISC-48, ISC-49.
 *
 * Uses a temporary in-memory SQLite DB so tests never touch ./data.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  listPeople,
  importPeopleFromCsv,
  createTeam,
  createTeamRole,
  listTeamRoles,
  addTeamMember,
  listTeamMembers,
  listPersonTeams,
  createCrew,
  listCrews,
  addCrewMember,
  listCrewMembers,
  createTemplate,
  addTemplateRole,
  listTemplateRoles,
  generateServicesFromTemplate,
  createOneOffService,
  listServices,
  listServiceSlots,
  createAssignment,
  getAssignment,
  updateTemplate,
} from "../src/db/queries.js";

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

// ---------------------------------------------------------------------------
// ISC-7: Admin can create a team with named roles and per-role headcount
// ---------------------------------------------------------------------------
test("ISC-7: create team with named roles and headcount", () => {
  const team = createTeam(db, "Sound Team", "individual");
  expect(team.id).toBeGreaterThan(0);
  expect(team.name).toBe("Sound Team");
  expect(team.scheduling_mode).toBe("individual");

  createTeamRole(db, team.id, "Sound Engineer", 1);
  createTeamRole(db, team.id, "Backup Engineer", 2);

  const roles = listTeamRoles(db, team.id);
  expect(roles).toHaveLength(2);

  const soundRole = roles.find((r) => r.name === "Sound Engineer");
  const backupRole = roles.find((r) => r.name === "Backup Engineer");

  expect(soundRole).toBeDefined();
  expect(soundRole!.headcount_per_service).toBe(1);
  expect(backupRole).toBeDefined();
  expect(backupRole!.headcount_per_service).toBe(2);
});

// ---------------------------------------------------------------------------
// ISC-8: Admin can add a person with name + email only; no password field
// ---------------------------------------------------------------------------
test("ISC-8: person creation — name and email only, no password", async () => {
  const person = createPerson(db, "Jane Smith", "jane@example.com");
  expect(person.id).toBeGreaterThan(0);
  expect(person.name).toBe("Jane Smith");
  expect(person.email).toBe("jane@example.com");
  expect(person.created_at).toBeTruthy();

  // Verify no password column in the people table schema
  const cols = db
    .query("PRAGMA table_info(people)")
    .all() as Array<{ name: string }>;
  const colNames = cols.map((c) => c.name);
  expect(colNames).not.toContain("password");
  expect(colNames).not.toContain("password_hash");

  // DOM-level: the /admin/people page must not contain input[type=password]
  // We verify this by rendering the page directly
  const { peopleRouter } = await import("../src/routes/people.js");
  const req = new Request("http://localhost/");
  const res = await peopleRouter.fetch(req);
  const html = await res.text();
  expect(html).not.toMatch(/type=["']password["']/i);
  expect(html).not.toMatch(/input.*password/i);
});

// ---------------------------------------------------------------------------
// ISC-9: A person can belong to multiple teams
// ---------------------------------------------------------------------------
test("ISC-9: person can belong to multiple teams", () => {
  const person = createPerson(db, "Multi Team Person", "multi@example.com");
  const team1 = createTeam(db, "Worship Team", "individual");
  const team2 = createTeam(db, "Nursery Team", "individual");

  addTeamMember(db, person.id, team1.id);
  addTeamMember(db, person.id, team2.id);

  // Person appears on both rosters
  const team1Members = listTeamMembers(db, team1.id);
  const team2Members = listTeamMembers(db, team2.id);

  expect(team1Members.map((m) => m.id)).toContain(person.id);
  expect(team2Members.map((m) => m.id)).toContain(person.id);

  // From person's perspective, they're on two teams
  const personTeams = listPersonTeams(db, person.id);
  expect(personTeams).toHaveLength(2);
  expect(personTeams.map((t) => t.id)).toContain(team1.id);
  expect(personTeams.map((t) => t.id)).toContain(team2.id);
});

// ---------------------------------------------------------------------------
// ISC-10: CSV import with malformed rows — 2 bad rows → summary, never silent
// ---------------------------------------------------------------------------
test("ISC-10: CSV import reports exactly 2 malformed rows, good rows imported", () => {
  const csvPath = join(import.meta.dir, "fixtures", "people-malformed.csv");
  const csvText = readFileSync(csvPath, "utf-8");

  const result = importPeopleFromCsv(db, csvText);

  // 3 valid rows: Alice, Charlie, Diana
  expect(result.imported).toHaveLength(3);
  const importedNames = result.imported.map((p) => p.name);
  expect(importedNames).toContain("Alice Johnson");
  expect(importedNames).toContain("Charlie Brown");
  expect(importedNames).toContain("Diana Prince");

  // 2 error rows: Bob (invalid email), empty name
  expect(result.errors).toHaveLength(2);

  const bobError = result.errors.find((e) => e.line.includes("Bob Smith"));
  expect(bobError).toBeDefined();
  expect(bobError!.reason.toLowerCase()).toMatch(/email/);

  const emptyNameError = result.errors.find((e) => e.line.startsWith(","));
  expect(emptyNameError).toBeDefined();
  expect(emptyNameError!.reason.toLowerCase()).toMatch(/name/);
});

test("ISC-10: malformed rows are NEVER silently dropped — error count matches", () => {
  const csv = `name,email
Valid Person,valid@example.com
,noemail@example.com
Bad Email,notanemail
`;
  const result = importPeopleFromCsv(db, csv);
  // 1 valid, 2 errors — no silent drops
  expect(result.imported).toHaveLength(1);
  expect(result.errors).toHaveLength(2);
  // Total accounted for (excluding header)
  expect(result.imported.length + result.errors.length).toBe(3);
});

// ---------------------------------------------------------------------------
// ISC-11: Admin can define a recurring service template with role slots
// ---------------------------------------------------------------------------
test("ISC-11: create service template with role slots from team", () => {
  const team = createTeam(db, "Worship Team", "individual");
  createTeamRole(db, team.id, "Musician", 3);

  const tmpl = createTemplate(db, "Sunday Morning Service", 0, "10:30");
  expect(tmpl.id).toBeGreaterThan(0);
  expect(tmpl.name).toBe("Sunday Morning Service");
  expect(tmpl.weekday).toBe(0); // Sunday
  expect(tmpl.time).toBe("10:30");

  addTemplateRole(db, tmpl.id, team.id, "Musician", 3);

  const roles = listTemplateRoles(db, tmpl.id);
  expect(roles).toHaveLength(1);
  expect(roles[0]!.role_name).toBe("Musician");
  expect(roles[0]!.headcount).toBe(3);
  expect(roles[0]!.team_id).toBe(team.id);
});

// ---------------------------------------------------------------------------
// ISC-12: Generate 8 weeks → exactly 8 service rows
// ---------------------------------------------------------------------------
test("ISC-12: generate 8 weeks from Sunday template → 8 service instances", () => {
  const team = createTeam(db, "Sound Team", "individual");
  createTeamRole(db, team.id, "Sound", 1);

  const tmpl = createTemplate(db, "Sunday Service", 0, "10:30");
  addTemplateRole(db, tmpl.id, team.id, "Sound", 1);

  // 8 weeks starting on a Sunday (2026-06-14 is a Sunday)
  const startDate = "2026-06-14";
  const endDate = "2026-08-08"; // 7 weeks + 1 day after start → 8 Sundays

  const services = generateServicesFromTemplate(db, tmpl.id, startDate, endDate);
  expect(services).toHaveLength(8);

  // All should be Sundays
  for (const svc of services) {
    const d = new Date(`${svc.date}T00:00:00Z`);
    expect(d.getUTCDay()).toBe(0); // Sunday
  }

  // Verify they exist in the DB too
  const allServices = listServices(db);
  expect(allServices).toHaveLength(8);
});

// ---------------------------------------------------------------------------
// ISC-13: Admin can add a one-off, non-recurring service
// ---------------------------------------------------------------------------
test("ISC-13: create one-off service with no template", () => {
  const svc = createOneOffService(db, "Christmas Eve Special", "2026-12-24", "18:00", []);
  expect(svc.id).toBeGreaterThan(0);
  expect(svc.name).toBe("Christmas Eve Special");
  expect(svc.date).toBe("2026-12-24");
  expect(svc.time).toBe("18:00");
  expect(svc.template_id).toBeNull();

  const allServices = listServices(db);
  expect(allServices.map((s) => s.id)).toContain(svc.id);
});

// ---------------------------------------------------------------------------
// ISC-14: Manual assignment persists with status 'pending'
// ---------------------------------------------------------------------------
test("ISC-14: manual assignment persists with status pending", () => {
  const team = createTeam(db, "Nursery Team", "individual");
  createTeamRole(db, team.id, "Caregiver", 2);
  const tmpl = createTemplate(db, "Sunday Service", 0, "10:30");
  addTemplateRole(db, tmpl.id, team.id, "Caregiver", 2);

  const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");
  expect(services).toHaveLength(1);
  const svc = services[0]!;

  const slots = listServiceSlots(db, svc.id);
  expect(slots.length).toBeGreaterThanOrEqual(1);
  const slot = slots[0]!;

  const person = createPerson(db, "Test Volunteer", "tvol@example.com");
  const assignment = createAssignment(db, slot.id, person.id);

  expect(assignment.id).toBeGreaterThan(0);
  expect(assignment.service_slot_id).toBe(slot.id);
  expect(assignment.person_id).toBe(person.id);
  expect(assignment.status).toBe("pending");

  // Verify retrieval
  const retrieved = getAssignment(db, assignment.id);
  expect(retrieved).not.toBeNull();
  expect(retrieved!.status).toBe("pending");
});

// ---------------------------------------------------------------------------
// ISC-15: Editing template does NOT mutate existing service instances
// ---------------------------------------------------------------------------
test("ISC-15: template edit does not alter existing service instances or slots", () => {
  const team = createTeam(db, "Media Team", "individual");
  createTeamRole(db, team.id, "Camera", 1);

  const tmpl = createTemplate(db, "Sunday Service", 0, "10:30");
  addTemplateRole(db, tmpl.id, team.id, "Camera", 1);

  // Generate 2 services
  const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-21");
  expect(services).toHaveLength(2);

  // Snapshot slots before template edit
  const beforeSlots = services.map((s) => ({
    id: s.id,
    slots: listServiceSlots(db, s.id),
  }));

  // Edit the template — change name, time, and add a new role
  updateTemplate(db, tmpl.id, "EDITED: Renamed Service", 0, "11:00");
  createTeamRole(db, team.id, "New Role Added", 2);
  addTemplateRole(db, tmpl.id, team.id, "New Role Added", 2);

  // Existing instances must be byte-identical (unchanged)
  const afterSlots = services.map((s) => ({
    id: s.id,
    slots: listServiceSlots(db, s.id),
  }));

  for (let i = 0; i < services.length; i++) {
    const before = beforeSlots[i]!;
    const after = afterSlots[i]!;

    // Same number of slots
    expect(after.slots.length).toBe(before.slots.length);

    // Each slot is identical
    for (let j = 0; j < before.slots.length; j++) {
      expect(after.slots[j]).toEqual(before.slots[j]);
    }
  }

  // Verify the existing services still have original name, not "EDITED"
  const existingService = listServices(db).find((s) => s.id === services[0]!.id)!;
  expect(existingService.name).toBe("Sunday Service");
  expect(existingService.time).toBe("10:30");
});

// ---------------------------------------------------------------------------
// ISC-47: Both scheduling modes persist correctly
// ---------------------------------------------------------------------------
test("ISC-47: both team scheduling modes persist", () => {
  const individualTeam = createTeam(db, "Sound Team", "individual");
  const crewTeam = createTeam(db, "Nursery Team", "crew");

  expect(individualTeam.scheduling_mode).toBe("individual");
  expect(crewTeam.scheduling_mode).toBe("crew");

  // Verify from DB read
  const teams = db.query("SELECT * FROM teams").all() as Array<{
    scheduling_mode: string;
  }>;
  const modes = teams.map((t) => t.scheduling_mode);
  expect(modes).toContain("individual");
  expect(modes).toContain("crew");
});

// ---------------------------------------------------------------------------
// ISC-48: Admin can define crews and assign members
// ---------------------------------------------------------------------------
test("ISC-48: crew creation and member assignment", () => {
  const team = createTeam(db, "Nursery Team", "crew");
  const crew = createCrew(db, team.id, "Crew A");
  expect(crew.id).toBeGreaterThan(0);
  expect(crew.name).toBe("Crew A");
  expect(crew.team_id).toBe(team.id);

  const person1 = createPerson(db, "Person One", "p1@example.com");
  const person2 = createPerson(db, "Person Two", "p2@example.com");

  addCrewMember(db, crew.id, person1.id);
  addCrewMember(db, crew.id, person2.id);

  const crews = listCrews(db, team.id);
  expect(crews).toHaveLength(1);
  expect(crews[0]!.name).toBe("Crew A");

  const members = listCrewMembers(db, crew.id);
  expect(members).toHaveLength(2);
  const memberIds = members.map((m) => m.id);
  expect(memberIds).toContain(person1.id);
  expect(memberIds).toContain(person2.id);
});

// ---------------------------------------------------------------------------
// ISC-49: Second crew assignment within same team rejected;
//          cross-team crew membership allowed
// ---------------------------------------------------------------------------
test("ISC-49: same-team second-crew assignment is rejected", () => {
  const team = createTeam(db, "Nursery Team", "crew");
  const crewA = createCrew(db, team.id, "Crew A");
  const crewB = createCrew(db, team.id, "Crew B");

  const person = createPerson(db, "Constrained Person", "constrained@example.com");

  // First assignment is fine
  addCrewMember(db, crewA.id, person.id);

  // Second assignment to different crew in SAME team must throw
  expect(() => addCrewMember(db, crewB.id, person.id)).toThrow(
    /one crew per team|already a member/i
  );

  // Verify person is still only in crewA
  const crewAMembers = listCrewMembers(db, crewA.id);
  const crewBMembers = listCrewMembers(db, crewB.id);
  expect(crewAMembers.map((m) => m.id)).toContain(person.id);
  expect(crewBMembers.map((m) => m.id)).not.toContain(person.id);
});

test("ISC-49: cross-team crew membership is allowed", () => {
  const teamA = createTeam(db, "Worship Team", "crew");
  const teamB = createTeam(db, "Nursery Team", "crew");

  const crewInA = createCrew(db, teamA.id, "Worship Crew 1");
  const crewInB = createCrew(db, teamB.id, "Nursery Crew 1");

  const person = createPerson(db, "Cross Team Person", "crossteam@example.com");

  // Should be fine — different teams
  addCrewMember(db, crewInA.id, person.id);
  addCrewMember(db, crewInB.id, person.id);

  const membersA = listCrewMembers(db, crewInA.id);
  const membersB = listCrewMembers(db, crewInB.id);
  expect(membersA.map((m) => m.id)).toContain(person.id);
  expect(membersB.map((m) => m.id)).toContain(person.id);
});
