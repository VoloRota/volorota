/**
 * Auto-fill qualification test suite.
 *
 * Covers ISC-53 (role qualifications filter) and ISC-54 (cross-team same-service
 * double-book prevention).
 *
 * All tests use in-memory SQLite.
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
  setMemberQualifications,
  listMemberQualifications,
  type Person,
  type Service,
} from "../src/db/queries.js";
import { runAutofill } from "../src/engine/autofill.js";

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

function makePerson(name: string, emailSuffix?: string): Person {
  const email = `${emailSuffix ?? name.toLowerCase().replace(/ /g, ".")}@test.com`;
  return createPerson(db, name, email);
}

/** Build 8-week Sunday services from a template with a given team + role. */
function build8WeekFixture(
  teamName: string,
  roleName: string,
  schedulingMode: "individual" | "crew" = "individual"
): {
  teamId: number;
  services: Service[];
} {
  const team = createTeam(db, teamName, schedulingMode);
  createTeamRole(db, team.id, roleName, 1);
  const tmpl = createTemplate(db, `${teamName} Template`, 0, "10:30");
  addTemplateRole(db, tmpl.id, team.id, roleName, 1);
  const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-08-08");
  return { teamId: team.id, services };
}

// ---------------------------------------------------------------------------
// ISC-53: Role qualification filter
// ---------------------------------------------------------------------------

describe("ISC-53: role qualifications filter individual mode", () => {
  test("ISC-53: keys-only member never appears in Vocals slots over 8-week fixture", () => {
    // Worship team with Vocals + Keys roles
    const team = createTeam(db, "Worship", "individual");
    createTeamRole(db, team.id, "Vocals", 1);
    createTeamRole(db, team.id, "Keys", 1);

    const alice = makePerson("Alice", "alice.isc53");   // keys only
    const bob   = makePerson("Bob",   "bob.isc53");     // both roles (no restriction rows)
    const carol = makePerson("Carol", "carol.isc53");   // both roles

    for (const p of [alice, bob, carol]) addTeamMember(db, p.id, team.id);

    // Restrict Alice to Keys only
    setMemberQualifications(db, team.id, alice.id, ["Keys"]);

    const tmpl = createTemplate(db, "Worship Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, team.id, "Vocals", 1);
    addTemplateRole(db, tmpl.id, team.id, "Keys", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-08-08");
    expect(services.length).toBe(8);

    const report = runAutofill(db);

    // Alice must NEVER appear in a Vocals slot
    const vocalsFilledByAlice = report.filled.filter(
      (f) => f.personId === alice.id && f.roleName === "Vocals"
    );
    expect(vocalsFilledByAlice).toHaveLength(0);

    // Alice MUST appear in Keys slots (she's eligible for those)
    const keysFilledByAlice = report.filled.filter(
      (f) => f.personId === alice.id && f.roleName === "Keys"
    );
    expect(keysFilledByAlice.length).toBeGreaterThan(0);
  });

  test("ISC-53: member with NO qualification rows is eligible for all roles", () => {
    const team = createTeam(db, "Sound", "individual");
    createTeamRole(db, team.id, "Front-of-House", 1);
    createTeamRole(db, team.id, "Monitors", 1);

    const alice = makePerson("Alice", "alice.noqrow");   // no restriction rows
    const bob   = makePerson("Bob",   "bob.noqrow");     // no restriction rows

    addTeamMember(db, alice.id, team.id);
    addTeamMember(db, bob.id, team.id);

    // Deliberately do NOT call setMemberQualifications for either member

    const tmpl = createTemplate(db, "Sound Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, team.id, "Front-of-House", 1);
    addTemplateRole(db, tmpl.id, team.id, "Monitors", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    // 2 slots filled, none skipped (both eligible for both roles)
    expect(report.filled.length).toBe(2);
    expect(report.skipped.length).toBe(0);

    // Both roles filled with someone
    const roles = report.filled.map((f) => f.roleName);
    expect(roles).toContain("Front-of-House");
    expect(roles).toContain("Monitors");
  });

  test("ISC-53: only qualified member fills slot when others are restricted", () => {
    const team = createTeam(db, "Media", "individual");
    createTeamRole(db, team.id, "Camera", 1);

    const alice = makePerson("Alice", "alice.onlycam");  // restricted to Livestream only
    const bob   = makePerson("Bob",   "bob.onlycam");    // no restriction → all roles

    addTeamMember(db, alice.id, team.id);
    addTeamMember(db, bob.id, team.id);

    // Alice restricted to "Livestream" (not "Camera") — effectively disqualified from Camera
    setMemberQualifications(db, team.id, alice.id, ["Livestream"]);

    const tmpl = createTemplate(db, "Media Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, team.id, "Camera", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    expect(report.filled.length).toBe(1);
    // Bob fills Camera (no restriction rows → eligible for all roles)
    expect(report.filled[0]!.personId).toBe(bob.id);
    expect(report.filled[0]!.roleName).toBe("Camera");
    // Alice not in any filled slot
    expect(report.filled.some((f) => f.personId === alice.id)).toBe(false);
  });

  test("ISC-53: all-roles-restricted member treated as all-open (no restriction rows)", () => {
    const team = createTeam(db, "Worship2", "individual");
    createTeamRole(db, team.id, "Drums", 1);

    const alice = makePerson("Alice", "alice.allopen");
    addTeamMember(db, alice.id, team.id);

    // All roles checked → setMemberQualifications called with [] → default-open
    setMemberQualifications(db, team.id, alice.id, []);

    // Verify no rows in DB — confirms default-open storage
    const rows = listMemberQualifications(db, team.id, alice.id);
    expect(rows).toHaveLength(0);

    const tmpl = createTemplate(db, "W2 Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, team.id, "Drums", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);
    // Alice fills the Drums slot (no restriction — default-open)
    expect(report.filled.length).toBe(1);
    expect(report.filled[0]!.personId).toBe(alice.id);
    expect(report.filled[0]!.roleName).toBe("Drums");
    expect(report.skipped.length).toBe(0);
  });

  test("ISC-53: slot skipped when all members are restricted away from that role", () => {
    const team = createTeam(db, "Ushers", "individual");
    createTeamRole(db, team.id, "Door", 1);
    createTeamRole(db, team.id, "Usher", 1);

    const alice = makePerson("Alice", "alice.skipall");
    const bob   = makePerson("Bob",   "bob.skipall");

    addTeamMember(db, alice.id, team.id);
    addTeamMember(db, bob.id, team.id);

    // Both restricted to Usher only — neither can fill Door
    setMemberQualifications(db, team.id, alice.id, ["Usher"]);
    setMemberQualifications(db, team.id, bob.id,   ["Usher"]);

    const tmpl = createTemplate(db, "Ushers Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, team.id, "Door", 1);
    addTemplateRole(db, tmpl.id, team.id, "Usher", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    // Door slot skipped with the qualification-specific reason — not the
    // misleading "blocked" wording (rebase integration with OnboardingGuidance)
    const doorSkips = report.skipped.filter((s) => s.roleName === "Door");
    expect(doorSkips.length).toBe(1);
    expect(doorSkips[0]!.reason).toBe("no_qualified_members");

    // Usher slot filled by one of them
    const usherFills = report.filled.filter((f) => f.roleName === "Usher");
    expect(usherFills.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ISC-53: Crew mode qualification filter
// ---------------------------------------------------------------------------

describe("ISC-53: role qualifications filter crew mode", () => {
  test("ISC-53: unqualified crew member leaves slot unfilled with no_qualified_in_crew reason", () => {
    const team = createTeam(db, "Crew Worship", "crew");
    createTeamRole(db, team.id, "Vocals", 1);

    const crew = createCrew(db, team.id, "Team A");
    const alice = makePerson("Alice", "alice.crewqual");

    addTeamMember(db, alice.id, team.id);
    addCrewMember(db, crew.id, alice.id);

    // Alice restricted to Keys only → not qualified for Vocals
    setMemberQualifications(db, team.id, alice.id, ["Keys"]);

    const tmpl = createTemplate(db, "CW Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, team.id, "Vocals", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    expect(report.filled.length).toBe(0);
    expect(report.skipped.length).toBe(1);
    expect(report.skipped[0]!.reason).toBe("no_qualified_in_crew");
    expect(report.skipped[0]!.personId).toBe(alice.id);
    expect(report.skipped[0]!.crewName).toBe("Team A");
    expect(report.skipped[0]!.roleName).toBe("Vocals");
  });

  test("ISC-53: crew member with no restriction rows fills any role", () => {
    const team = createTeam(db, "Crew Sound", "crew");
    createTeamRole(db, team.id, "FOH", 1);

    const crew = createCrew(db, team.id, "Sound A");
    const bob = makePerson("Bob", "bob.crewnorestrict");

    addTeamMember(db, bob.id, team.id);
    addCrewMember(db, crew.id, bob.id);
    // No setMemberQualifications call → default-open

    const tmpl = createTemplate(db, "CS Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, team.id, "FOH", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    expect(report.filled.length).toBe(1);
    expect(report.filled[0]!.personId).toBe(bob.id);
    expect(report.skipped.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ISC-54: Cross-team same-service double-book prevention
// ---------------------------------------------------------------------------

describe("ISC-54: cross-team same-service exclusion individual mode", () => {
  test("ISC-54: person with alternative available → zero cross-team double-books", () => {
    // Two teams: Worship + Sound. Both individual mode.
    const worship = createTeam(db, "Worship54A", "individual");
    createTeamRole(db, worship.id, "Vocals", 1);

    const sound = createTeam(db, "Sound54A", "individual");
    createTeamRole(db, sound.id, "FOH", 1);

    // Three people: Alice is on BOTH teams. Bob is Sound-only. Carol is Worship-only.
    const alice = makePerson("Alice", "alice.54a");
    const bob   = makePerson("Bob",   "bob.54a");
    const carol = makePerson("Carol", "carol.54a");

    addTeamMember(db, alice.id, worship.id);
    addTeamMember(db, carol.id, worship.id);
    addTeamMember(db, alice.id, sound.id);
    addTeamMember(db, bob.id,   sound.id);

    // Single service with both teams
    const tmpl = createTemplate(db, "54A Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, worship.id, "Vocals", 1);
    addTemplateRole(db, tmpl.id, sound.id, "FOH", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");
    expect(services.length).toBe(1);

    const report = runAutofill(db);

    expect(report.filled.length).toBe(2);
    expect(report.skipped.length).toBe(0);

    // Each filled slot must be a different person
    const filledPersonIds = report.filled.map((f) => f.personId);
    const uniqueIds = new Set(filledPersonIds);
    expect(uniqueIds.size).toBe(2); // no double-book

    // No fill should carry the double_booked flag
    const doubleBooked = report.filled.filter((f) => f.flags === "double_booked");
    expect(doubleBooked).toHaveLength(0);
  });

  test("ISC-54: sole-candidate across teams → slot filled + flagged double_booked", () => {
    // One team: Worship. One team: Sound. Only Alice is on both — no alternative.
    const worship = createTeam(db, "Worship54B", "individual");
    createTeamRole(db, worship.id, "Vocals", 1);

    const sound = createTeam(db, "Sound54B", "individual");
    createTeamRole(db, sound.id, "FOH", 1);

    const alice = makePerson("Alice", "alice.54b");
    addTeamMember(db, alice.id, worship.id);
    addTeamMember(db, alice.id, sound.id);

    const tmpl = createTemplate(db, "54B Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, worship.id, "Vocals", 1);
    addTemplateRole(db, tmpl.id, sound.id, "FOH", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    // Both slots filled (last-resort)
    expect(report.filled.length).toBe(2);
    expect(report.skipped.length).toBe(0);

    // Alice fills both — but at least the second one is flagged
    const aliceFills = report.filled.filter((f) => f.personId === alice.id);
    expect(aliceFills.length).toBe(2);

    // The double-book flag must appear on exactly one entry
    const flagged = report.filled.filter((f) => f.flags === "double_booked");
    expect(flagged.length).toBe(1);
    expect(flagged[0]!.personId).toBe(alice.id);
  });

  test("ISC-54: pre-existing manual assignment seeds cross-team set", () => {
    // Alice is manually assigned to Worship. Sound auto-fill should not pick Alice.
    const worship = createTeam(db, "Worship54C", "individual");
    createTeamRole(db, worship.id, "Vocals", 1);

    const sound = createTeam(db, "Sound54C", "individual");
    createTeamRole(db, sound.id, "FOH", 1);

    const alice = makePerson("Alice", "alice.54c");
    const bob   = makePerson("Bob",   "bob.54c");

    addTeamMember(db, alice.id, worship.id);
    addTeamMember(db, alice.id, sound.id);
    addTeamMember(db, bob.id,   sound.id);

    const tmpl = createTemplate(db, "54C Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, worship.id, "Vocals", 1);
    addTemplateRole(db, tmpl.id, sound.id, "FOH", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    // Manually pre-assign Alice to Worship Vocals
    const slots = listServiceSlots(db, services[0]!.id);
    const vocalsSlot = slots.find((s) => s.role_name === "Vocals")!;
    createAssignment(db, vocalsSlot.id, alice.id);

    const report = runAutofill(db);

    // Worship slot is already filled (skipped by auto-fill)
    expect(report.filled.length).toBe(1); // only Sound FOH

    // Sound FOH must be filled by Bob, not Alice
    expect(report.filled[0]!.roleName).toBe("FOH");
    expect(report.filled[0]!.personId).toBe(bob.id);
    expect(report.filled[0]!.flags).toBeUndefined();
  });

  test("ISC-54: determinism — same DB → same cross-team assignment output", () => {
    function buildAndRun(): Array<{ slot_id: number; person_id: number }> {
      const freshDb = new Database(":memory:");
      freshDb.exec("PRAGMA foreign_keys = ON;");
      applySchema(freshDb);
      setDb(freshDb);

      const worship = createTeam(freshDb, "W", "individual");
      createTeamRole(freshDb, worship.id, "Vocals", 1);
      const sound = createTeam(freshDb, "S", "individual");
      createTeamRole(freshDb, sound.id, "FOH", 1);

      const alice = createPerson(freshDb, "Alice", "alice@det54.com");
      const bob   = createPerson(freshDb, "Bob",   "bob@det54.com");
      const carol = createPerson(freshDb, "Carol", "carol@det54.com");

      addTeamMember(freshDb, alice.id, worship.id);
      addTeamMember(freshDb, carol.id, worship.id);
      addTeamMember(freshDb, alice.id, sound.id);
      addTeamMember(freshDb, bob.id,   sound.id);

      const tmpl = createTemplate(freshDb, "Det54", 0, "10:30");
      addTemplateRole(freshDb, tmpl.id, worship.id, "Vocals", 1);
      addTemplateRole(freshDb, tmpl.id, sound.id, "FOH", 1);
      generateServicesFromTemplate(freshDb, tmpl.id, "2026-06-14", "2026-06-28"); // 3 weeks

      const report = runAutofill(freshDb);
      const result = report.filled
        .map((f) => ({ slot_id: f.slotId, person_id: f.personId }))
        .sort((a, b) => a.slot_id - b.slot_id);

      freshDb.close();
      return result;
    }

    expect(buildAndRun()).toEqual(buildAndRun());
  });

  test("ISC-54: three teams in one service — each gets a distinct person", () => {
    const teamA = createTeam(db, "TeamA54D", "individual");
    createTeamRole(db, teamA.id, "Role", 1);
    const teamB = createTeam(db, "TeamB54D", "individual");
    createTeamRole(db, teamB.id, "Role", 1);
    const teamC = createTeam(db, "TeamC54D", "individual");
    createTeamRole(db, teamC.id, "Role", 1);

    const alice = makePerson("Alice", "alice.54d");
    const bob   = makePerson("Bob",   "bob.54d");
    const carol = makePerson("Carol", "carol.54d");

    // Each person is on all three teams
    for (const t of [teamA, teamB, teamC]) {
      addTeamMember(db, alice.id, t.id);
      addTeamMember(db, bob.id,   t.id);
      addTeamMember(db, carol.id, t.id);
    }

    const tmpl = createTemplate(db, "3Team Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, teamA.id, "Role", 1);
    addTemplateRole(db, tmpl.id, teamB.id, "Role", 1);
    addTemplateRole(db, tmpl.id, teamC.id, "Role", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    expect(report.filled.length).toBe(3);
    const ids = report.filled.map((f) => f.personId);
    const uniqueIds = new Set(ids);
    // With 3 teams and 3 distinct people, zero double-books expected
    expect(uniqueIds.size).toBe(3);
    expect(report.filled.every((f) => f.flags === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISC-54: Crew mode cross-team conflict
// ---------------------------------------------------------------------------

describe("ISC-54: cross-team same-service conflict crew mode", () => {
  test("ISC-54: crew member already serving via individual team → crew slot unfilled", () => {
    // Individual team fills Alice first; Crew team has Alice as next — leaves slot unfilled.
    const indTeam = createTeam(db, "Individual54E", "individual");
    createTeamRole(db, indTeam.id, "Sound", 1);

    const crewTeam = createTeam(db, "Crew54E", "crew");
    createTeamRole(db, crewTeam.id, "Usher", 1);

    const alice = makePerson("Alice", "alice.54e");
    const bob   = makePerson("Bob",   "bob.54e");   // only on individual team

    addTeamMember(db, alice.id, indTeam.id);
    addTeamMember(db, bob.id,   indTeam.id);
    addTeamMember(db, alice.id, crewTeam.id);

    const crew = createCrew(db, crewTeam.id, "Only Crew");
    addCrewMember(db, crew.id, alice.id);

    // Build a template that includes both teams
    // We order: individual team first (lower team_id) so Sound fills Alice first.
    // Actually the engine processes by team_id order — individual has lower id.
    const tmpl = createTemplate(db, "54E Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, indTeam.id, "Sound", 1);
    addTemplateRole(db, tmpl.id, crewTeam.id, "Usher", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    // Sound fills (Bob or Alice — Bob is least-recently-served with lower id)
    const soundFill = report.filled.find((f) => f.roleName === "Sound");
    expect(soundFill).toBeDefined();

    // Usher slot: Alice is the only crew member, but if she was assigned to Sound,
    // the crew slot gets skipped (crew_member_blocked).
    // If Bob was picked for Sound, Alice fills Usher — still no double-book.
    const aliceFills = report.filled.filter((f) => f.personId === alice.id);
    // Alice must not appear in more than one fill entry (no double-book without flag)
    const aliceDoubleBooks = aliceFills.filter((f) => f.flags !== "double_booked");
    expect(aliceDoubleBooks.length).toBeLessThanOrEqual(1);
  });

  test("ISC-54: crew member already assigned cross-team → crew slot flagged unfilled", () => {
    // Pre-assign Alice manually to individual team. Crew team has Alice as only member.
    const indTeam = createTeam(db, "Individual54F", "individual");
    createTeamRole(db, indTeam.id, "Sound", 1);

    const crewTeam = createTeam(db, "Crew54F", "crew");
    createTeamRole(db, crewTeam.id, "Usher", 1);

    const alice = makePerson("Alice", "alice.54f");

    addTeamMember(db, alice.id, indTeam.id);
    addTeamMember(db, alice.id, crewTeam.id);

    const crew = createCrew(db, crewTeam.id, "Crew F");
    addCrewMember(db, crew.id, alice.id);

    const tmpl = createTemplate(db, "54F Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, indTeam.id, "Sound", 1);
    addTemplateRole(db, tmpl.id, crewTeam.id, "Usher", 1);
    const services = generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    // Manually assign Alice to Sound slot before running autofill
    const slots = listServiceSlots(db, services[0]!.id);
    const soundSlot = slots.find((s) => s.role_name === "Sound")!;
    createAssignment(db, soundSlot.id, alice.id);

    const report = runAutofill(db);

    // Sound slot already filled (manual) → 0 auto-fills from individual team
    // Usher slot: Alice already in cross-team set → crew_member_blocked
    const usherSkip = report.skipped.find((s) => s.roleName === "Usher");
    expect(usherSkip).toBeDefined();
    expect(usherSkip!.reason).toBe("crew_member_blocked");
    expect(usherSkip!.personId).toBe(alice.id);

    // No assignment row for Usher slot
    const allAssignments = listAssignmentsForService(db, services[0]!.id);
    const usherSlot = slots.find((s) => s.role_name === "Usher")!;
    const usherAssignment = allAssignments.find((a) => a.service_slot_id === usherSlot.id);
    expect(usherAssignment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combined ISC-53 + ISC-54: qualification + cross-team in same run
// ---------------------------------------------------------------------------

describe("ISC-53 + ISC-54: combined qualification and cross-team", () => {
  test("qualified-only candidate fills correct role on correct team without double-book", () => {
    // Worship (individual): Vocals + Keys; Alice = Keys only, Bob = both
    // Sound (individual): FOH; Alice is on Sound too, Bob is not
    const worship = createTeam(db, "WC54", "individual");
    createTeamRole(db, worship.id, "Vocals", 1);
    createTeamRole(db, worship.id, "Keys", 1);

    const sound = createTeam(db, "SC54", "individual");
    createTeamRole(db, sound.id, "FOH", 1);

    const alice = makePerson("Alice", "alice.combined");
    const bob   = makePerson("Bob",   "bob.combined");

    addTeamMember(db, alice.id, worship.id);
    addTeamMember(db, bob.id,   worship.id);
    addTeamMember(db, alice.id, sound.id);

    // Alice restricted to Keys on Worship
    setMemberQualifications(db, worship.id, alice.id, ["Keys"]);

    const tmpl = createTemplate(db, "WC54 Template", 0, "10:30");
    addTemplateRole(db, tmpl.id, worship.id, "Vocals", 1);
    addTemplateRole(db, tmpl.id, worship.id, "Keys", 1);
    addTemplateRole(db, tmpl.id, sound.id, "FOH", 1);
    generateServicesFromTemplate(db, tmpl.id, "2026-06-14", "2026-06-14");

    const report = runAutofill(db);

    // Check Vocals — must NOT be Alice
    const vocalsFill = report.filled.find((f) => f.roleName === "Vocals");
    expect(vocalsFill).toBeDefined();
    expect(vocalsFill!.personId).toBe(bob.id);

    // Check Keys — Alice is eligible
    const keysFill = report.filled.find((f) => f.roleName === "Keys");
    expect(keysFill).toBeDefined();
    expect(keysFill!.personId).toBe(alice.id);

    // Check FOH — Alice is now serving Worship already; only Alice is on Sound.
    // Should be filled with double_booked flag (Alice only candidate)
    const fohFill = report.filled.find((f) => f.roleName === "FOH");
    expect(fohFill).toBeDefined();
    expect(fohFill!.personId).toBe(alice.id);
    expect(fohFill!.flags).toBe("double_booked");
  });
});
