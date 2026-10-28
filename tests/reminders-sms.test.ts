/**
 * SMS reminder channel tests
 *
 * Covers:
 *  - No SMS without phone or without sms_opt_in (consent gate)
 *  - SMS sent exactly once for opted-in person (idempotency across reruns)
 *  - Email and SMS idempotency are independent channels
 *  - SMS body carries service details, magic link, and STOP opt-out
 *  - sms_outbox records the send
 *  - Existing email behavior is unchanged for people without SMS
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
  setSmsContact,
} from "../src/db/queries.js";
import {
  getCapturedMail,
  clearCapturedMail,
} from "../src/mail/mailer.js";
import {
  getCapturedSms,
  clearCapturedSms,
} from "../src/notifications/sms.js";
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
  clearCapturedSms();
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

const NOW = new Date("2030-01-01T00:00:00Z");

interface SetupOpts {
  phone?: string | null;
  smsOptIn?: boolean;
}

function setupConfirmedAssignment(opts: SetupOpts = {}): void {
  const person = createPerson(db, "Jane Volunteer", "jane@example.com");
  setSmsContact(db, person.id, opts.phone ?? null, opts.smsOptIn ?? false);
  const team = createTeam(db, "Worship", "individual");
  addTeamMember(db, person.id, team.id);

  const svc = createOneOffService(
    db,
    "Sunday Service",
    daysFromNow(NOW, 3),
    "10:00",
    []
  );
  const slotId = createSlot(db, svc.id, team.id, "Vocals");
  const assignment = createAssignment(db, slotId, person.id);
  updateAssignmentStatus(db, assignment.id, "confirmed");
}

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

test("no SMS when person has no phone (email still goes)", async () => {
  setupConfirmedAssignment({ phone: null, smsOptIn: true });
  await runReminderCheck(db, NOW);
  expect(getCapturedSms()).toHaveLength(0);
  expect(getCapturedMail()).toHaveLength(1);
});

test("no SMS when person has a phone but never opted in", async () => {
  setupConfirmedAssignment({ phone: "+15551234567", smsOptIn: false });
  await runReminderCheck(db, NOW);
  expect(getCapturedSms()).toHaveLength(0);
  expect(getCapturedMail()).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Opted-in flow
// ---------------------------------------------------------------------------

test("opted-in person gets exactly one SMS, idempotent across reruns", async () => {
  setupConfirmedAssignment({ phone: "+15551234567", smsOptIn: true });
  await runReminderCheck(db, NOW);
  expect(getCapturedSms()).toHaveLength(1);
  expect(getCapturedMail()).toHaveLength(1);

  // Rerun — no double-sends on either channel
  await runReminderCheck(db, NOW);
  expect(getCapturedSms()).toHaveLength(1);
  expect(getCapturedMail()).toHaveLength(1);
});

test("SMS body includes service details, link, and STOP language", async () => {
  setupConfirmedAssignment({ phone: "+15551234567", smsOptIn: true });
  await runReminderCheck(db, NOW);
  const sms = getCapturedSms()[0]!;
  expect(sms.to).toBe("+15551234567");
  expect(sms.body).toContain("Sunday Service");
  expect(sms.body).toContain("Reply STOP to opt out");
  expect(sms.body).toMatch(/https?:\/\/\S+\/v\//); // magic link
});

test("sms_outbox records the send", async () => {
  setupConfirmedAssignment({ phone: "+15551234567", smsOptIn: true });
  await runReminderCheck(db, NOW);
  const rows = db
    .query("SELECT to_phone, transport, status FROM sms_outbox")
    .all() as Array<{ to_phone: string; transport: string; status: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.to_phone).toBe("+15551234567");
  expect(rows[0]!.transport).toBe("capture");
  expect(rows[0]!.status).toBe("sent");
});

// ---------------------------------------------------------------------------
// Channel independence
// ---------------------------------------------------------------------------

test("SMS idempotency does not suppress email on later runs", async () => {
  setupConfirmedAssignment({ phone: "+15551234567", smsOptIn: true });

  // Simulate: SMS already recorded, email not yet (e.g. email failed run 1)
  const assignment = db
    .query("SELECT id FROM assignments LIMIT 1")
    .get() as { id: number };
  db.prepare(
    "INSERT OR IGNORE INTO reminders_sent (assignment_id, reminder_day, channel) VALUES (?, 3, 'sms')"
  ).run(assignment.id);

  await runReminderCheck(db, NOW);
  // Email still sent; SMS not re-sent
  expect(getCapturedMail()).toHaveLength(1);
  expect(getCapturedSms()).toHaveLength(0);
});

test("both channels record independently in reminders_sent", async () => {
  setupConfirmedAssignment({ phone: "+15551234567", smsOptIn: true });
  await runReminderCheck(db, NOW);
  const ch = db
    .query("SELECT channel FROM reminders_sent ORDER BY channel")
    .all() as Array<{ channel: string }>;
  expect(ch.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
});

test("pending assignments get no SMS and no email", async () => {
  const person = createPerson(db, "Jane Volunteer", "jane@example.com");
  setSmsContact(db, person.id, "+15551234567", true);
  const team = createTeam(db, "Worship", "individual");
  addTeamMember(db, person.id, team.id);
  const svc = createOneOffService(
    db,
    "Sunday Service",
    daysFromNow(NOW, 3),
    "10:00",
    []
  );
  const slotId = createSlot(db, svc.id, team.id, "Vocals");
  createAssignment(db, slotId, person.id); // stays pending

  await runReminderCheck(db, NOW);
  expect(getCapturedSms()).toHaveLength(0);
  expect(getCapturedMail()).toHaveLength(0);
});
