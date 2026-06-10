/**
 * Reminder tests — ISC-35
 *
 * Covers:
 *  - Sends exactly once for confirmed assignments N days ahead
 *  - Multiple N values (VOLOROTA_REMINDER_DAYS)
 *  - Second run sends nothing (idempotency)
 *  - Does NOT send for pending or declined assignments
 *  - Does NOT send for assignments whose service is NOT exactly N days away
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createTeam,
  addTeamMember,
  createOneOffService,
  createAssignment,
  updateAssignmentStatus,
} from "../src/db/queries.js";
import {
  getCapturedMail,
  clearCapturedMail,
} from "../src/mail/mailer.js";
import { runReminderCheck } from "../src/notifications/reminders.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  clearCapturedMail();
  delete process.env.VOLOROTA_REMINDER_DAYS;
});

afterEach(() => {
  db.close();
  delete process.env.VOLOROTA_REMINDER_DAYS;
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

/** Build a Date that is exactly `daysAhead` UTC days from `now`. */
function daysFromNow(now: Date, daysAhead: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// ISC-35: Basic reminder send
// ---------------------------------------------------------------------------

test("ISC-35: sends reminder email for confirmed assignment exactly 3 days away", async () => {
  const person = createPerson(db, "Alice", "alice@example.com");
  const team = createTeam(db, "Worship", "individual");
  addTeamMember(db, person.id, team.id);

  const now = new Date("2030-01-01T00:00:00Z");
  const serviceDate = daysFromNow(now, 3);
  const svc = createOneOffService(db, "Sunday Service", serviceDate, "10:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Vocals");
  const assignment = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, assignment.id, "confirmed");

  await runReminderCheck(db, now);

  const captured = getCapturedMail();
  expect(captured).toHaveLength(1);
  expect(captured[0]!.to).toBe("alice@example.com");
  expect(captured[0]!.subject).toContain("3 day");
  expect(captured[0]!.text).toContain("Sunday Service");
  expect(captured[0]!.text).toContain(serviceDate);
  // Must include the volunteer's magic link
  expect(captured[0]!.text).toContain("/v/");
});

// ---------------------------------------------------------------------------
// ISC-35: Idempotency — second run sends nothing
// ---------------------------------------------------------------------------

test("ISC-35: second run sends zero additional emails (idempotent)", async () => {
  const person = createPerson(db, "Bob", "bob@example.com");
  const team = createTeam(db, "Sound", "individual");
  addTeamMember(db, person.id, team.id);

  const now = new Date("2030-02-01T00:00:00Z");
  const serviceDate = daysFromNow(now, 3);
  const svc = createOneOffService(db, "Wednesday Service", serviceDate, "19:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Sound");
  const assignment = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, assignment.id, "confirmed");

  // First run
  await runReminderCheck(db, now);
  expect(getCapturedMail()).toHaveLength(1);

  // Second run — must send nothing
  clearCapturedMail();
  await runReminderCheck(db, now);
  expect(getCapturedMail()).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ISC-35: Multiple N values
// ---------------------------------------------------------------------------

test("ISC-35: multiple VOLOROTA_REMINDER_DAYS values send correct reminders", async () => {
  process.env.VOLOROTA_REMINDER_DAYS = "7,3";

  const alice = createPerson(db, "Alice", "alice@example.com");
  const bob = createPerson(db, "Bob", "bob@example.com");
  const team = createTeam(db, "Media", "individual");
  addTeamMember(db, alice.id, team.id);
  addTeamMember(db, bob.id, team.id);

  const now = new Date("2030-03-01T00:00:00Z");

  // Alice's service is 7 days away
  const aliceDate = daysFromNow(now, 7);
  const svcA = createOneOffService(db, "Service A", aliceDate, "10:00", []);
  const slotA = createSlot(db, svcA.id, team.id, "Camera");
  const assignA = createAssignment(db, slotA, alice.id);
  updateAssignmentStatus(db, assignA.id, "confirmed");

  // Bob's service is 3 days away
  const bobDate = daysFromNow(now, 3);
  const svcB = createOneOffService(db, "Service B", bobDate, "10:00", []);
  const slotB = createSlot(db, svcB.id, team.id, "Sound");
  const assignB = createAssignment(db, slotB, bob.id);
  updateAssignmentStatus(db, assignB.id, "confirmed");

  await runReminderCheck(db, now);

  const captured = getCapturedMail();
  expect(captured).toHaveLength(2);

  const aliceMail = captured.find((m) => m.to === "alice@example.com");
  const bobMail = captured.find((m) => m.to === "bob@example.com");
  expect(aliceMail).toBeDefined();
  expect(aliceMail!.subject).toContain("7 day");
  expect(bobMail).toBeDefined();
  expect(bobMail!.subject).toContain("3 day");
});

// ---------------------------------------------------------------------------
// ISC-35: Confirmed-only — pending and declined assignments not reminded
// ---------------------------------------------------------------------------

test("ISC-35: pending assignment does NOT receive a reminder", async () => {
  const person = createPerson(db, "Carol", "carol@example.com");
  const team = createTeam(db, "Welcome", "individual");
  addTeamMember(db, person.id, team.id);

  const now = new Date("2030-04-01T00:00:00Z");
  const serviceDate = daysFromNow(now, 3);
  const svc = createOneOffService(db, "Easter Service", serviceDate, "10:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Greeter");
  const assignment = createAssignment(db, slotId, person.id);
  // Status remains 'pending' — do not confirm

  await runReminderCheck(db, now);
  expect(getCapturedMail()).toHaveLength(0);
});

test("ISC-35: declined assignment does NOT receive a reminder", async () => {
  const person = createPerson(db, "Dave", "dave@example.com");
  const team = createTeam(db, "Choir", "individual");
  addTeamMember(db, person.id, team.id);

  const now = new Date("2030-05-01T00:00:00Z");
  const serviceDate = daysFromNow(now, 3);
  const svc = createOneOffService(db, "Choir Sunday", serviceDate, "11:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Tenor");
  const assignment = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, assignment.id, "declined");

  await runReminderCheck(db, now);
  expect(getCapturedMail()).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ISC-35: Does not send when service is NOT exactly N days away
// ---------------------------------------------------------------------------

test("ISC-35: assignment 4 days away (not 3) does NOT get 3-day reminder", async () => {
  const person = createPerson(db, "Eve", "eve@example.com");
  const team = createTeam(db, "AV", "individual");
  addTeamMember(db, person.id, team.id);

  const now = new Date("2030-06-01T00:00:00Z");
  const serviceDate = daysFromNow(now, 4); // 4 days, not 3
  const svc = createOneOffService(db, "AV Sunday", serviceDate, "10:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Projection");
  const assignment = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, assignment.id, "confirmed");

  // Default reminder days = [3]
  await runReminderCheck(db, now);
  expect(getCapturedMail()).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ISC-35: reminders_sent table records the idempotency key
// ---------------------------------------------------------------------------

test("ISC-35: reminders_sent row is recorded after send", async () => {
  const person = createPerson(db, "Frank", "frank@example.com");
  const team = createTeam(db, "Tech", "individual");
  addTeamMember(db, person.id, team.id);

  const now = new Date("2030-07-01T00:00:00Z");
  const serviceDate = daysFromNow(now, 3);
  const svc = createOneOffService(db, "Tech Service", serviceDate, "10:00", []);
  const slotId = createSlot(db, svc.id, team.id, "Tech");
  const assignment = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, assignment.id, "confirmed");

  await runReminderCheck(db, now);

  const row = db
    .query("SELECT * FROM reminders_sent WHERE assignment_id = ? AND reminder_day = 3")
    .get(assignment.id);
  expect(row).not.toBeNull();
});
