/**
 * Auto-fill engine test suite.
 *
 * Covers ISC-23, ISC-24, ISC-25, ISC-26, ISC-50, ISC-51, and determinism.
 *
 * All tests use in-memory SQLite via setDb().
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { Database } from "bun:sqlite";

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
  listAssignmentsForService,
  createCrew,
  addCrewMember,
  createBlockout,
  updateAssignmentStatus,
  type Service,
  type Person,
  type Crew,
} from "../src/db/queries.js";
import { runAutofill, type AutofillReport } from "../src/engine/autofill.js";

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
// Helpers
// ---------------------------------------------------------------------------

/** Build N people and return them. */
function makePeople(count: number, prefix = "Person"): Person[] {
  return Array.from({ length: count }, (_, i) =>
    createPerson(db, `${prefix} ${i + 1}`, `${prefix.toLowerCase().replace(/ /g, "")}${i + 1}@test.com`)
  );
}

/** Create an individual-mode team with a single role of headcount 1. */
function makeIndividualTeam(name = "Team", roleName = "Role"): { team: ReturnType<typeof createTeam>; people: Person[]; services: Service[] } {
  const team = createTeam(db, name, "individual");
  createTeamRole(db, team.id, roleName, 1);
  const people = makePeople(3, `${name}P`);
  for (const p of people) addTeamMember(db, p.id, team.id);
  const tmpl = createTemplate(db, `${name} Template`, 0, "10:30");
  addTemplateRole(db, tmpl.id, team.id, roleName, 1);
  const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-08-08"); // 8 Sundays
  return { team, people, services };
}

// ---------------------------------------------------------------------------
// ISC-23: Auto-fill never assigns to blocked-out dates (property sweep)
// ---------------------------------------------------------------------------

describe("ISC-23: blockout safety property", () => {
  test("ISC-23: no assignment lands on a blocked-out date (varied fixtures)", () => {
    const { team, people, services } = makeIndividualTeam("BlockSafety");

    // Block person 0 on weeks 1, 3, 5 (odd indices)
    // Block person 1 on week 2
    createBlockout(db, people[0]!.id, services[0]!.date, services[0]!.date);
    createBlockout(db, people[0]!.id, services[2]!.date, services[2]!.date);
    createBlockout(db, people[0]!.id, services[4]!.date, services[4]!.date);
    createBlockout(db, people[1]!.id, services[1]!.date, services[1]!.date);
    // Block person 2 for a multi-day range covering weeks 6 and 7
    createBlockout(
      db,
      people[2]!.id,
      services[5]!.date,
      services[6]!.date
    );

    const report = runAutofill(db);

    // Collect all (person, date) pairs and verify no blockout is violated
    for (const fill of report.filled) {
      const person = people.find((p) => p.id === fill.personId)!;
      // Check DB blockout
      const blocked = db
        .query(
          `SELECT id FROM blockouts
           WHERE person_id = ? AND start_date <= ? AND end_date >= ?`
        )
        .get(fill.personId, fill.serviceDate, fill.serviceDate);
      expect(blocked).toBeNull();
    }
  });

  test("ISC-23: with 3 people and various blockouts, zero violations across 8 weeks", () => {
    const team = createTeam(db, "T", "individual");
    createTeamRole(db, team.id, "R", 1);
    const p1 = createPerson(db, "P1", "p1@x.com");
    const p2 = createPerson(db, "P2", "p2@x.com");
    const p3 = createPerson(db, "P3", "p3@x.com");
    for (const p of [p1, p2, p3]) addTeamMember(db, p.id, team.id);

    const tmpl = createTemplate(db, "T", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "R", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-08-08");

    // Block everyone except one person each week — always one available
    createBlockout(db, p1.id, services[0]!.date, services[0]!.date);
    createBlockout(db, p2.id, services[0]!.date, services[0]!.date);
    createBlockout(db, p2.id, services[3]!.date, services[3]!.date);
    createBlockout(db, p3.id, services[1]!.date, services[1]!.date);
    createBlockout(db, p3.id, services[5]!.date, services[5]!.date);

    const report = runAutofill(db);

    for (const fill of report.filled) {
      const blocked = db
        .query(
          `SELECT id FROM blockouts WHERE person_id = ? AND start_date <= ? AND end_date >= ?`
        )
        .get(fill.personId, fill.serviceDate, fill.serviceDate);
      expect(blocked).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// ISC-24: Least-recently-served ordering
// ---------------------------------------------------------------------------

describe("ISC-24: least-recently-served rotation", () => {
  test("ISC-24: never-served person is filled first", () => {
    const team = createTeam(db, "LRS Team", "individual");
    createTeamRole(db, team.id, "Role", 1);

    const alice = createPerson(db, "Alice", "alice@lrs.com");
    const bob = createPerson(db, "Bob", "bob@lrs.com");
    const carol = createPerson(db, "Carol", "carol@lrs.com");
    for (const p of [alice, bob, carol]) addTeamMember(db, p.id, team.id);

    const tmpl = createTemplate(db, "LRS Template", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Role", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-08-08");

    // Pre-assign: Alice served most recently (week 1), Bob served less recently (week 0)
    // Carol never served → should go first
    const slotsWk0 = listServiceSlots(db, services[0]!.id);
    const slotsWk1 = listServiceSlots(db, services[1]!.id);
    createAssignment(db, slotsWk0[0]!.id, bob.id);
    createAssignment(db, slotsWk1[0]!.id, alice.id);

    // Auto-fill from week 2 onward
    const report = runAutofill(db, { startDate: services[2]!.date });

    // The first auto-filled slot should be Carol (never served)
    const firstFill = report.filled[0]!;
    expect(firstFill.personId).toBe(carol.id);
  });

  test("ISC-24: person with older serve date comes before person with newer date", () => {
    const team = createTeam(db, "LRS2 Team", "individual");
    createTeamRole(db, team.id, "Sound", 1);

    const alice = createPerson(db, "Alice", "alice@lrs2.com");
    const bob = createPerson(db, "Bob", "bob@lrs2.com");
    for (const p of [alice, bob]) addTeamMember(db, p.id, team.id);

    const tmpl = createTemplate(db, "LRS2", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Sound", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-08-08");

    // Bob served at week 0, Alice at week 1 → Bob is older → Bob should go next
    createAssignment(db, listServiceSlots(db, services[0]!.id)[0]!.id, bob.id);
    createAssignment(db, listServiceSlots(db, services[1]!.id)[0]!.id, alice.id);

    // Week 2: should pick Bob (older serve date)
    const report = runAutofill(db, { startDate: services[2]!.date, endDate: services[2]!.date });

    expect(report.filled.length).toBe(1);
    expect(report.filled[0]!.personId).toBe(bob.id);
  });

  test("ISC-24: deterministic tie-break by person id when serve dates equal", () => {
    const team = createTeam(db, "Tie Team", "individual");
    createTeamRole(db, team.id, "Camera", 1);

    // Two people with identical serve history (neither ever served)
    const p1 = createPerson(db, "Person A", "pA@x.com");
    const p2 = createPerson(db, "Person B", "pB@x.com");
    // p1 gets lower id (created first)
    expect(p1.id).toBeLessThan(p2.id);
    addTeamMember(db, p1.id, team.id);
    addTeamMember(db, p2.id, team.id);

    const tmpl = createTemplate(db, "Tie Template", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Camera", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);
    // p1 (lower id) wins tie
    expect(report.filled[0]!.personId).toBe(p1.id);
  });

  test("ISC-24: same run fills two slots in one service with two different people", () => {
    const team = createTeam(db, "Two Slot", "individual");
    createTeamRole(db, team.id, "Camera", 2);

    const p1 = createPerson(db, "P1", "p1@2s.com");
    const p2 = createPerson(db, "P2", "p2@2s.com");
    addTeamMember(db, p1.id, team.id);
    addTeamMember(db, p2.id, team.id);

    const tmpl = createTemplate(db, "Two Slot Template", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Camera", 2);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);
    expect(report.filled.length).toBe(2);
    const ids = report.filled.map((f) => f.personId);
    expect(ids[0]).not.toBe(ids[1]); // different people
  });
});

// ---------------------------------------------------------------------------
// ISC-25: Auto-fill never overwrites existing assignments
// ---------------------------------------------------------------------------

describe("ISC-25: existing assignments untouched", () => {
  test("ISC-25: manual pre-seed assignment is unchanged after auto-fill", () => {
    const team = createTeam(db, "Preserve Team", "individual");
    createTeamRole(db, team.id, "Role", 1);
    const [alice, bob] = makePeople(2, "Preserve");
    addTeamMember(db, alice!.id, team.id);
    addTeamMember(db, bob!.id, team.id);

    const tmpl = createTemplate(db, "Preserve Tmpl", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Role", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const slots = listServiceSlots(db, services[0]!.id);
    // Pre-seed Bob manually
    const manual = createAssignment(db, slots[0]!.id, bob!.id);
    expect(manual.person_id).toBe(bob!.id);

    const report = runAutofill(db);

    // Auto-fill should have found nothing to fill (slot already occupied)
    expect(report.filled.length).toBe(0);

    // Bob's assignment must be exactly as created
    const afterAssignments = listAssignmentsForService(db, services[0]!.id);
    expect(afterAssignments).toHaveLength(1);
    expect(afterAssignments[0]!.person_id).toBe(bob!.id);
    expect(afterAssignments[0]!.status).toBe("pending");
    expect(afterAssignments[0]!.id).toBe(manual.id);
  });

  test("ISC-25: declined assignment also blocks auto-fill from overwriting", () => {
    const team = createTeam(db, "Declined Team", "individual");
    createTeamRole(db, team.id, "Role", 1);
    const [alice] = makePeople(1, "Declined");
    addTeamMember(db, alice!.id, team.id);

    const tmpl = createTemplate(db, "Declined Tmpl", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Role", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const slots = listServiceSlots(db, services[0]!.id);
    const a = createAssignment(db, slots[0]!.id, alice!.id);
    updateAssignmentStatus(db, a.id, "declined");

    const report = runAutofill(db);
    // The slot was occupied (declined row exists) → auto-fill skips it
    expect(report.filled.length).toBe(0);

    const afterAssignments = listAssignmentsForService(db, services[0]!.id);
    expect(afterAssignments[0]!.status).toBe("declined");
    expect(afterAssignments[0]!.person_id).toBe(alice!.id);
  });
});

// ---------------------------------------------------------------------------
// ISC-26: All candidates blocked → slot left unfilled and flagged
// ---------------------------------------------------------------------------

describe("ISC-26: all-blocked slots reported not force-assigned", () => {
  test("ISC-26: no assignment row created when all candidates blocked out", () => {
    const team = createTeam(db, "AllBlocked Team", "individual");
    createTeamRole(db, team.id, "Role", 1);
    const [p1, p2] = makePeople(2, "AB");
    addTeamMember(db, p1!.id, team.id);
    addTeamMember(db, p2!.id, team.id);

    const tmpl = createTemplate(db, "AllBlocked Tmpl", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Role", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    // Block EVERYONE
    createBlockout(db, p1!.id, services[0]!.date, services[0]!.date);
    createBlockout(db, p2!.id, services[0]!.date, services[0]!.date);

    const report = runAutofill(db);

    expect(report.filled.length).toBe(0);
    expect(report.skipped.length).toBe(1);
    expect(report.skipped[0]!.reason).toBe("all_candidates_blocked");

    // Confirm no assignment row was created
    const assignments = listAssignmentsForService(db, services[0]!.id);
    expect(assignments.length).toBe(0);
  });

  test("ISC-26: skipped slot report includes service details and slot info", () => {
    const team = createTeam(db, "SkipReport", "individual");
    createTeamRole(db, team.id, "Camera", 1);
    const [p1] = makePeople(1, "SR");
    addTeamMember(db, p1!.id, team.id);

    const tmpl = createTemplate(db, "SkipReport Tmpl", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Camera", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    createBlockout(db, p1!.id, services[0]!.date, services[0]!.date);

    const report = runAutofill(db);
    expect(report.skipped[0]!.serviceName).toContain("SkipReport");
    expect(report.skipped[0]!.roleName).toBe("Camera");
    expect(report.skipped[0]!.serviceDate).toBe(services[0]!.date);
  });
});

// ---------------------------------------------------------------------------
// ISC-50: Crew rotation follows rotation_order
// ---------------------------------------------------------------------------

describe("ISC-50: crew rotation order", () => {
  test("ISC-50: 8-week fixture with 3 crews cycles in rotation_order exactly", () => {
    const team = createTeam(db, "Crew Team", "crew");
    createTeamRole(db, team.id, "Nursery", 1);

    // 3 crews; rotation_order 0, 1, 2
    const crewA = createCrew(db, team.id, "Crew A");
    const crewB = createCrew(db, team.id, "Crew B");
    const crewC = createCrew(db, team.id, "Crew C");

    // Set rotation_order explicitly
    db.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(0, crewA.id);
    db.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(1, crewB.id);
    db.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(2, crewC.id);

    // Create 2 members per crew (all also team members)
    const membersA = makePeople(2, "CA");
    const membersB = makePeople(2, "CB");
    const membersC = makePeople(2, "CC");
    for (const p of [...membersA, ...membersB, ...membersC]) addTeamMember(db, p.id, team.id);
    for (const p of membersA) addCrewMember(db, crewA.id, p.id);
    for (const p of membersB) addCrewMember(db, crewB.id, p.id);
    for (const p of membersC) addCrewMember(db, crewC.id, p.id);

    const tmpl = createTemplate(db, "Crew Template", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Nursery", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-08-08"); // 8 Sundays
    expect(services.length).toBe(8);

    const report = runAutofill(db);

    // No skipped slots — all should fill
    expect(report.skipped.length).toBe(0);
    expect(report.filled.length).toBe(8);

    // Determine expected crew sequence: A, B, C, A, B, C, A, B
    const expectedCrews = [crewA, crewB, crewC, crewA, crewB, crewC, crewA, crewB];
    const membersByCrewId = new Map<number, number[]>([
      [crewA.id, membersA.map((m) => m.id)],
      [crewB.id, membersB.map((m) => m.id)],
      [crewC.id, membersC.map((m) => m.id)],
    ]);

    for (let i = 0; i < 8; i++) {
      const fill = report.filled[i]!;
      const expectedCrew = expectedCrews[i]!;
      const expectedMemberIds = membersByCrewId.get(expectedCrew.id)!;
      expect(expectedMemberIds).toContain(fill.personId);
      expect(fill.crewName).toBe(expectedCrew.name);
    }
  });

  test("ISC-50: crew mode fills service slots from assigned crew members only", () => {
    const team = createTeam(db, "Crew Fill Test", "crew");
    createTeamRole(db, team.id, "Slot", 2); // 2 slots per service

    const crewA = createCrew(db, team.id, "Alpha");
    const crewB = createCrew(db, team.id, "Beta");
    db.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(0, crewA.id);
    db.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(1, crewB.id);

    const alphaMembers = makePeople(2, "Alpha");
    const betaMembers = makePeople(2, "Beta");
    for (const p of [...alphaMembers, ...betaMembers]) addTeamMember(db, p.id, team.id);
    for (const p of alphaMembers) addCrewMember(db, crewA.id, p.id);
    for (const p of betaMembers) addCrewMember(db, crewB.id, p.id);

    const tmpl = createTemplate(db, "Crew Fill Tmpl", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Slot", 2);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-21"); // 2 weeks

    const report = runAutofill(db);
    expect(report.filled.length).toBe(4); // 2 slots × 2 services

    // Week 1: Alpha crew fills both slots
    const wk1Fills = report.filled.filter((f) => f.serviceDate === services[0]!.date);
    for (const fill of wk1Fills) {
      expect(alphaMembers.map((m) => m.id)).toContain(fill.personId);
    }

    // Week 2: Beta crew fills both slots
    const wk2Fills = report.filled.filter((f) => f.serviceDate === services[1]!.date);
    for (const fill of wk2Fills) {
      expect(betaMembers.map((m) => m.id)).toContain(fill.personId);
    }
  });
});

// ---------------------------------------------------------------------------
// ISC-51: Crew mode blockout → that member's slot unfilled, no cross-crew substitution
// ---------------------------------------------------------------------------

describe("ISC-51: crew blockout handling", () => {
  test("ISC-51: blocked crew member's slot is unfilled, others in crew still assigned", () => {
    const team = createTeam(db, "Crew Blockout", "crew");
    createTeamRole(db, team.id, "Usher", 2); // 2 slots per service

    const crewA = createCrew(db, team.id, "Crew A");
    const crewB = createCrew(db, team.id, "Crew B");
    db.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(0, crewA.id);
    db.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(1, crewB.id);

    const [memberA1, memberA2] = makePeople(2, "CBA");
    const [memberB1, memberB2] = makePeople(2, "CBB");
    for (const p of [memberA1!, memberA2!, memberB1!, memberB2!]) addTeamMember(db, p.id, team.id);
    addCrewMember(db, crewA.id, memberA1!.id);
    addCrewMember(db, crewA.id, memberA2!.id);
    addCrewMember(db, crewB.id, memberB1!.id);
    addCrewMember(db, crewB.id, memberB2!.id);

    const tmpl = createTemplate(db, "Crew Blockout Tmpl", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Usher", 2);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14"); // 1 week

    // Block memberA1 (first crew A member by id order)
    createBlockout(db, memberA1!.id, services[0]!.date, services[0]!.date);

    const report = runAutofill(db);

    // 1 slot filled (memberA2), 1 slot skipped (memberA1 blocked)
    expect(report.filled.length).toBe(1);
    expect(report.skipped.length).toBe(1);

    // The filled slot must be memberA2 (from Crew A — no cross-crew substitution)
    expect(report.filled[0]!.personId).toBe(memberA2!.id);
    expect(report.filled[0]!.crewName).toBe("Crew A");

    // The skipped slot must be flagged as crew_member_blocked with correct person
    const skip = report.skipped[0]!;
    expect(skip.reason).toBe("crew_member_blocked");
    expect(skip.personId).toBe(memberA1!.id);
    expect(skip.crewName).toBe("Crew A");

    // Verify Crew B members were NOT assigned to anything in this service
    const assignments = listAssignmentsForService(db, services[0]!.id);
    const assignedIds = assignments.map((a) => a.person_id);
    expect(assignedIds).not.toContain(memberB1!.id);
    expect(assignedIds).not.toContain(memberB2!.id);
  });

  test("ISC-51: when all crew members for a service are blocked, all slots unfilled", () => {
    const team = createTeam(db, "AllCrewBlocked", "crew");
    createTeamRole(db, team.id, "Role", 1);

    const crew = createCrew(db, team.id, "Only Crew");
    const [m1] = makePeople(1, "ACB");
    addTeamMember(db, m1!.id, team.id);
    addCrewMember(db, crew.id, m1!.id);

    const tmpl = createTemplate(db, "ACB Tmpl", 0, "10:00");
    addTemplateRole(db, tmpl.id, team.id, "Role", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    createBlockout(db, m1!.id, services[0]!.date, services[0]!.date);

    const report = runAutofill(db);
    expect(report.filled.length).toBe(0);
    expect(report.skipped.length).toBe(1);
    expect(report.skipped[0]!.reason).toBe("crew_member_blocked");

    const assignments = listAssignmentsForService(db, services[0]!.id);
    expect(assignments.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism: same DB state → same output
// ---------------------------------------------------------------------------

describe("Determinism", () => {
  test("two runs on identical fresh fixtures produce identical assignment sets", () => {
    // Helper to build and run, return sorted assignment array
    function buildAndRun(): Array<{ slot_id: number; person_id: number }> {
      const freshDb = new Database(":memory:");
      freshDb.exec("PRAGMA foreign_keys = ON;");
      applySchema(freshDb);
      setDb(freshDb);

      const team = createTeam(freshDb, "Det Team", "individual");
      createTeamRole(freshDb, team.id, "Det Role", 1);

      const people = Array.from({ length: 4 }, (_, i) =>
        createPerson(freshDb, `Det${i}`, `det${i}@x.com`)
      );
      for (const p of people) addTeamMember(freshDb, p.id, team.id);

      // Seed some prior serve history
      const tmpl = createTemplate(freshDb, "Det Template", 0, "10:00");
      addTemplateRole(freshDb, tmpl.id, team.id, "Det Role", 1);
      const services = generateServicesFromTemplate(
        freshDb,
        tmpl.id,
        "2026-06-14",
        "2026-08-08"
      );

      // Pre-assign weeks 0 and 1
      createAssignment(freshDb, listServiceSlots(freshDb, services[0]!.id)[0]!.id, people[0]!.id);
      createAssignment(freshDb, listServiceSlots(freshDb, services[1]!.id)[0]!.id, people[1]!.id);

      const report = runAutofill(freshDb, { startDate: services[2]!.date });

      const result = report.filled
        .map((f) => ({ slot_id: f.slotId, person_id: f.personId }))
        .sort((a, b) => a.slot_id - b.slot_id);

      freshDb.close();
      return result;
    }

    const run1 = buildAndRun();
    const run2 = buildAndRun();

    expect(run1).toEqual(run2);
  });

  test("determinism holds with crew mode over 3 weeks", () => {
    function buildAndRunCrew(): Array<{ slot_id: number; person_id: number }> {
      const freshDb = new Database(":memory:");
      freshDb.exec("PRAGMA foreign_keys = ON;");
      applySchema(freshDb);
      setDb(freshDb);

      const team = createTeam(freshDb, "Det Crew", "crew");
      createTeamRole(freshDb, team.id, "Role", 1);

      const crewA = createCrew(freshDb, team.id, "A");
      const crewB = createCrew(freshDb, team.id, "B");
      freshDb.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(0, crewA.id);
      freshDb.prepare("UPDATE crews SET rotation_order = ? WHERE id = ?").run(1, crewB.id);

      const pa = createPerson(freshDb, "PA", "pa@d.com");
      const pb = createPerson(freshDb, "PB", "pb@d.com");
      addTeamMember(freshDb, pa.id, team.id);
      addTeamMember(freshDb, pb.id, team.id);
      addCrewMember(freshDb, crewA.id, pa.id);
      addCrewMember(freshDb, crewB.id, pb.id);

      const tmpl = createTemplate(freshDb, "DC Tmpl", 0, "10:00");
      addTemplateRole(freshDb, tmpl.id, team.id, "Role", 1);
      generateServicesFromTemplate(freshDb, tmpl.id, "2026-06-14", "2026-06-28"); // 3 Sundays

      const report = runAutofill(freshDb);
      const result = report.filled
        .map((f) => ({ slot_id: f.slotId, person_id: f.personId }))
        .sort((a, b) => a.slot_id - b.slot_id);

      freshDb.close();
      return result;
    }

    expect(buildAndRunCrew()).toEqual(buildAndRunCrew());
  });
});
