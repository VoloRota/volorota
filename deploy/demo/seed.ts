/**
 * Demo seed — deterministic fixture for the public VoloRota demo.
 * Runs INSIDE the container (reset.sh copies it in and execs it).
 *
 * Demo volunteer tokens are FIXED (provided via env), not random, so the
 * published demo links survive the hourly reset. They are still 256-bit
 * secrets — set them once in deploy/demo/.env from `openssl rand -base64 32`.
 *
 * Service dates roll forward automatically: the schedule always starts on
 * the upcoming Sunday, so the demo never looks stale.
 */
import { getDb } from "/app/src/db/schema.ts";
import {
  createPerson, createTeam, createTeamRole, addTeamMember,
  createCrew, addCrewMember, createTemplate, addTemplateRole,
  generateServicesFromTemplate, createBlockout, updateAssignmentStatus,
  createServiceNote,
} from "/app/src/db/queries.ts";
import { runAutofill } from "/app/src/engine/autofill.ts";
import { hashToken } from "/app/src/volunteer/tokens.ts";

const db = getDb();
const count = db.query("SELECT COUNT(*) c FROM people").get() as { c: number };
if (count.c > 0) {
  console.log("already seeded — run reset.sh for a clean reseed");
  process.exit(0);
}

// ---- date helpers: schedule starts on the upcoming Sunday ------------------
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const today = new Date();
const nextSunday = new Date(today);
nextSunday.setUTCDate(today.getUTCDate() + ((7 - today.getUTCDay()) % 7 || 7));
const addDays = (base: Date, n: number) => {
  const d = new Date(base);
  d.setUTCDate(base.getUTCDate() + n);
  return d;
};
const horizon = addDays(nextSunday, 7 * 7); // 8 Sundays
const autofillEnd = addDays(nextSunday, 7 * 5); // fill 6, leave 2 open

// ---- people / teams ---------------------------------------------------------
const names = [
  "Sarah Mitchell", "James Carter", "Emily Rodriguez", "David Kim",
  "Rachel Thompson", "Marcus Webb", "Anna Kowalski", "Tom Bradley",
  "Grace Liu", "Peter Okafor", "Hannah Stone", "Caleb Reyes",
];
const people = names.map((n) =>
  createPerson(db, n, n.toLowerCase().replace(/ /g, ".") + "@example.com")
);

const worship = createTeam(db, "Worship", "crew");
createTeamRole(db, worship.id, "Vocals", 2);
createTeamRole(db, worship.id, "Keys", 1);
const crewA = createCrew(db, worship.id, "Crew A");
const crewB = createCrew(db, worship.id, "Crew B");
for (const p of people.slice(0, 6)) addTeamMember(db, p.id, worship.id);
for (const p of people.slice(0, 3)) addCrewMember(db, crewA.id, p.id);
for (const p of people.slice(3, 6)) addCrewMember(db, crewB.id, p.id);

const nursery = createTeam(db, "Nursery", "individual");
createTeamRole(db, nursery.id, "Nursery Worker", 2);
for (const p of people.slice(6, 10)) addTeamMember(db, p.id, nursery.id);

const sound = createTeam(db, "Sound", "individual");
createTeamRole(db, sound.id, "Sound Tech", 1);
for (const p of [people[10], people[11], people[7]]) addTeamMember(db, p.id, sound.id);

db.prepare("UPDATE teams SET leader_person_id = ? WHERE id = ?").run(people[0].id, worship.id);
db.prepare("UPDATE teams SET leader_person_id = ? WHERE id = ?").run(people[6].id, nursery.id);

// ---- schedule ---------------------------------------------------------------
const tpl = createTemplate(db, "Sunday Service", 0, "10:30");
addTemplateRole(db, tpl.id, worship.id, "Vocals", 2);
addTemplateRole(db, tpl.id, worship.id, "Keys", 1);
addTemplateRole(db, tpl.id, nursery.id, "Nursery Worker", 2);
addTemplateRole(db, tpl.id, sound.id, "Sound Tech", 1);

const services = generateServicesFromTemplate(db, tpl.id, fmt(nextSunday), fmt(horizon));

// Blockouts relative to the schedule
createBlockout(db, people[6].id, fmt(addDays(nextSunday, 11)), fmt(addDays(nextSunday, 24)), "Family vacation");
createBlockout(db, people[1].id, fmt(addDays(nextSunday, 14)), fmt(addDays(nextSunday, 14)), "Out of town");
createBlockout(db, people[10].id, fmt(addDays(nextSunday, 28)), fmt(addDays(nextSunday, 35)), "Work travel");

// Notes — including the demo disclosure (kept in data, not in product code)
createServiceNote(db, services[0]!.id, null,
  "Welcome to the VoloRota demo! This data resets every hour. Poke anything — you can't break it.");
createServiceNote(db, services[0]!.id, sound.id,
  "New wireless mics this week — setup guide: https://example.com/mic-setup");
createServiceNote(db, services[2]!.id, null,
  "Guest speaker this Sunday; service may run 15 minutes long.");

// ---- fill + mixed states ----------------------------------------------------
const report = runAutofill(db, { startDate: fmt(nextSunday), endDate: fmt(autofillEnd) });

const rows = db.query(`
  SELECT a.id, s.date FROM assignments a
  JOIN service_slots sl ON sl.id = a.service_slot_id
  JOIN services s ON s.id = sl.service_id
  ORDER BY s.date, a.id`).all() as { id: number; date: string }[];
for (const r of rows) {
  if (r.date <= fmt(addDays(nextSunday, 7))) updateAssignmentStatus(db, r.id, "confirmed");
}
const declineTarget = rows.find((r) => r.date === fmt(addDays(nextSunday, 28)));
if (declineTarget) updateAssignmentStatus(db, declineTarget.id, "declined");

// ---- fixed demo tokens ------------------------------------------------------
const expiry = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 90);
  return d.toISOString().replace("T", " ").slice(0, 19);
})();
const fixed: Array<[string, number]> = [
  ["DEMO_TOKEN_SARAH", people[0]!.id],
  ["DEMO_TOKEN_TOM", people[7]!.id],
  ["DEMO_TOKEN_GRACE", people[8]!.id],
];
for (const [envName, personId] of fixed) {
  const raw = process.env[envName];
  if (!raw || raw.length < 32) {
    console.log(`(${envName} not set or too short — skipping fixed token for person ${personId})`);
    continue;
  }
  const hash = await hashToken(raw);
  db.prepare("DELETE FROM volunteer_tokens WHERE person_id = ?").run(personId);
  db.prepare(
    "INSERT INTO volunteer_tokens (person_id, token_hash, expires_at) VALUES (?, ?, ?)"
  ).run(personId, hash, expiry);
  console.log(`fixed token installed for person ${personId} (${envName})`);
}

console.log(`seeded: ${people.length} people, 3 teams, ${services.length} services starting ${fmt(nextSunday)}`);
console.log(`autofill: ${report.filled.length} filled, ${report.skipped.length} skipped`);
