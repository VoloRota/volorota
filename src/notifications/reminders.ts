/**
 * Reminder email system — ISC-35
 *
 * runReminderCheck(db, now: Date) — finds confirmed assignments whose service
 * date is exactly N days from `now` for each N in VOLOROTA_REMINDER_DAYS
 * (default "3", comma-separated, e.g. "7,3,1"), sends the volunteer a reminder
 * email with their magic link, then records the send in reminders_sent for
 * idempotency across restarts.
 *
 * The setInterval timer is ONLY started from src/index.ts. This module never
 * starts timers on import so tests remain clean.
 */

import type { Database } from "bun:sqlite";
import { sendMail } from "../mail/mailer.js";
import { createOrReplaceToken } from "../volunteer/tokens.js";

// ---------------------------------------------------------------------------
// Parse reminder days from environment
// ---------------------------------------------------------------------------

export function getReminderDays(): number[] {
  const raw = process.env.VOLOROTA_REMINDER_DAYS ?? "3";
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}

// ---------------------------------------------------------------------------
// Core idempotent reminder check — injectable `now` for tests
// ---------------------------------------------------------------------------

export async function runReminderCheck(db: Database, now: Date): Promise<void> {
  const days = getReminderDays();
  if (days.length === 0) return;

  for (const n of days) {
    // Compute target date: now + n days (UTC midnight)
    const target = new Date(now);
    target.setUTCDate(target.getUTCDate() + n);
    const targetDate = target.toISOString().slice(0, 10); // "YYYY-MM-DD"

    // Find confirmed assignments for this target date that haven't been reminded yet
    const assignments = db
      .query(
        `SELECT a.id AS assignment_id, a.person_id,
                s.name AS service_name, s.date AS service_date, s.time AS service_time,
                ss.role_name
         FROM assignments a
         JOIN service_slots ss ON ss.id = a.service_slot_id
         JOIN services s ON s.id = ss.service_id
         WHERE a.status = 'confirmed'
           AND s.date = ?
           AND a.id NOT IN (
             SELECT assignment_id FROM reminders_sent WHERE reminder_day = ?
           )`
      )
      .all(targetDate, n) as Array<{
      assignment_id: number;
      person_id: number;
      service_name: string;
      service_date: string;
      service_time: string;
      role_name: string;
    }>;

    for (const row of assignments) {
      await sendReminderEmail(db, row, n);
    }
  }
}

// ---------------------------------------------------------------------------
// Send a single reminder email and record in reminders_sent
// ---------------------------------------------------------------------------

async function sendReminderEmail(
  db: Database,
  row: {
    assignment_id: number;
    person_id: number;
    service_name: string;
    service_date: string;
    service_time: string;
    role_name: string;
  },
  reminderDay: number
): Promise<void> {
  // Get person
  const person = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(row.person_id) as { id: number; name: string; email: string } | null;
  if (!person) return;

  // Generate (or refresh) volunteer magic link token
  const rawToken = await createOrReplaceToken(db, person.id);
  const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
  const magicLink = `${appBase}/v/${rawToken}`;

  const subject = `Reminder: ${row.service_name} is in ${reminderDay} day${reminderDay === 1 ? "" : "s"}`;
  const text = [
    `Hi ${person.name},`,
    "",
    `This is a friendly reminder that you are scheduled to serve in ${reminderDay} day${reminderDay === 1 ? "" : "s"}.`,
    "",
    `Service: ${row.service_name}`,
    `Date: ${row.service_date} at ${row.service_time}`,
    `Role: ${row.role_name}`,
    "",
    "View your schedule or update your availability here:",
    magicLink,
    "",
    "No account or login needed — just click the link.",
    "",
    "Thank you for serving!",
  ].join("\n");

  const html = `
    <p>Hi ${escHtml(person.name)},</p>
    <p>This is a friendly reminder that you are scheduled to serve in
       <strong>${reminderDay} day${reminderDay === 1 ? "" : "s"}</strong>.</p>
    <table style="border-collapse:collapse;font-size:.95rem">
      <tr><th style="text-align:left;padding:.2rem .6rem">Service</th><td style="padding:.2rem .6rem">${escHtml(row.service_name)}</td></tr>
      <tr><th style="text-align:left;padding:.2rem .6rem">Date</th><td style="padding:.2rem .6rem">${escHtml(row.service_date)} at ${escHtml(row.service_time)}</td></tr>
      <tr><th style="text-align:left;padding:.2rem .6rem">Role</th><td style="padding:.2rem .6rem">${escHtml(row.role_name)}</td></tr>
    </table>
    <p style="margin-top:1rem">
      <a href="${escHtml(magicLink)}" style="display:inline-block;padding:.5rem 1rem;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px">View My Schedule</a>
    </p>
    <p style="font-size:.85rem;color:#555">Or copy this link: ${escHtml(magicLink)}</p>
    <p style="font-size:.85rem;color:#555">No account or login needed.</p>
  `;

  try {
    await sendMail(db, { to: person.email, subject, text, html });

    // Record idempotency marker — UNIQUE(assignment_id, reminder_day) prevents double-send
    db.prepare(
      "INSERT OR IGNORE INTO reminders_sent (assignment_id, reminder_day) VALUES (?, ?)"
    ).run(row.assignment_id, reminderDay);
  } catch (err) {
    console.error(
      `[reminders] Failed to send reminder for assignment ${row.assignment_id} day ${reminderDay}:`,
      err
    );
    // Do NOT insert into reminders_sent — allow retry on next check cycle
  }
}

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
