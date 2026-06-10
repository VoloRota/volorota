/**
 * Mailer abstraction — ISC-27, ISC-30
 *
 * Interface: sendMail({ to, subject, text, html? })
 *
 * Default transport: CAPTURE
 *   - Appends to an in-memory array accessible to tests.
 *   - Also writes to the `outbox` table in SQLite (admin-viewable).
 *
 * Notifications feature (future) plugs SMTP in by calling setTransport().
 *
 * Assignment helpers:
 *   sendAssignmentEmail(db, assignmentId)  — called from admin "Notify" action
 *   sendReplacementRequestEmail(db, replacementRequestId, toPersonId)
 */

import type { Database } from "bun:sqlite";
import {
  getAssignment,
  getService,
  listServiceSlots,
} from "../db/queries.js";
import { createOrReplaceToken } from "../volunteer/tokens.js";

// ---------------------------------------------------------------------------
// Mail message type
// ---------------------------------------------------------------------------

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// ---------------------------------------------------------------------------
// Transport interface — seam for future SMTP
// ---------------------------------------------------------------------------

export interface MailTransport {
  send(db: Database, msg: MailMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Capture transport (default)
// ---------------------------------------------------------------------------

/** In-memory outbox — readable by tests. Reset between test suites. */
const _capturedMail: MailMessage[] = [];

export function getCapturedMail(): MailMessage[] {
  return _capturedMail;
}

export function clearCapturedMail(): void {
  _capturedMail.length = 0;
}

const captureTransport: MailTransport = {
  async send(db: Database, msg: MailMessage): Promise<void> {
    _capturedMail.push({ ...msg });
    // Persist to outbox table (if it exists — it's created by extendSchemaForVolunteer)
    try {
      db.prepare(
        `INSERT INTO outbox (to_email, subject, body_text, body_html)
         VALUES (?, ?, ?, ?)`
      ).run(msg.to, msg.subject, msg.text, msg.html ?? null);
    } catch {
      // outbox table may not exist in minimal test setups — silently skip
    }
  },
};

// ---------------------------------------------------------------------------
// Active transport (swappable)
// ---------------------------------------------------------------------------

let _activeTransport: MailTransport = captureTransport;

export function setTransport(t: MailTransport): void {
  _activeTransport = t;
}

export function resetToCaptureTransport(): void {
  _activeTransport = captureTransport;
}

// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------

export async function sendMail(db: Database, msg: MailMessage): Promise<void> {
  await _activeTransport.send(db, msg);
}

// ---------------------------------------------------------------------------
// Assignment email helper
// ---------------------------------------------------------------------------

/**
 * Send an assignment notification email for a given assignment ID.
 * Regenerates the volunteer's magic link each time to keep it fresh.
 *
 * Called from the admin "Notify volunteers" action on service detail page.
 */
export async function sendAssignmentEmail(
  db: Database,
  assignmentId: number
): Promise<void> {
  const assignment = getAssignment(db, assignmentId);
  if (!assignment) throw new Error(`Assignment ${assignmentId} not found`);

  // Get the slot → service
  const slots = db
    .query("SELECT * FROM service_slots WHERE id = ?")
    .get(assignment.service_slot_id) as {
      id: number;
      service_id: number;
      role_name: string;
    } | null;
  if (!slots) throw new Error(`Slot ${assignment.service_slot_id} not found`);

  const service = getService(db, slots.service_id);
  if (!service) throw new Error(`Service ${slots.service_id} not found`);

  // Get the person
  const person = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(assignment.person_id) as { id: number; name: string; email: string } | null;
  if (!person) throw new Error(`Person ${assignment.person_id} not found`);

  // Generate (or regenerate) volunteer magic-link token
  const rawToken = await createOrReplaceToken(db, person.id);

  const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
  const magicLink = `${appBase}/v/${rawToken}`;

  const subject = `You're scheduled: ${service.name} on ${service.date}`;
  const text = [
    `Hi ${person.name},`,
    "",
    `You have been scheduled for "${service.name}" on ${service.date} at ${service.time}.`,
    `Role: ${slots.role_name}`,
    "",
    "Please let us know if you can make it:",
    magicLink,
    "",
    "No account or login needed — just click the link.",
    "",
    "Thank you!",
  ].join("\n");

  const html = `
    <p>Hi ${escHtmlMail(person.name)},</p>
    <p>You have been scheduled for <strong>${escHtmlMail(service.name)}</strong>
       on ${escHtmlMail(service.date)} at ${escHtmlMail(service.time)}.<br/>
       Role: ${escHtmlMail(slots.role_name)}</p>
    <p><a href="${escHtmlMail(magicLink)}" style="display:inline-block;padding:.5rem 1rem;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px">View &amp; Respond</a></p>
    <p style="font-size:.85rem;color:#555">Or copy this link: ${escHtmlMail(magicLink)}</p>
    <p style="font-size:.85rem;color:#555">No account or login needed.</p>
  `;

  await sendMail(db, { to: person.email, subject, text, html });
}

// ---------------------------------------------------------------------------
// Replacement request email helper
// ---------------------------------------------------------------------------

/**
 * Email a teammate asking them to cover a declined slot.
 *
 * replacementRequestId — the replacement_requests row
 * toPersonId — the teammate being asked
 */
export async function sendReplacementRequestEmail(
  db: Database,
  replacementRequestId: number,
  toPersonId: number
): Promise<void> {
  const rr = db
    .query("SELECT * FROM replacement_requests WHERE id = ?")
    .get(replacementRequestId) as {
      id: number;
      assignment_id: number;
      requested_person_id: number;
    } | null;
  if (!rr) throw new Error(`Replacement request ${replacementRequestId} not found`);

  const assignment = getAssignment(db, rr.assignment_id);
  if (!assignment) throw new Error(`Assignment ${rr.assignment_id} not found`);

  const slot = db
    .query("SELECT * FROM service_slots WHERE id = ?")
    .get(assignment.service_slot_id) as {
      id: number;
      service_id: number;
      role_name: string;
    } | null;
  if (!slot) throw new Error(`Slot ${assignment.service_slot_id} not found`);

  const service = getService(db, slot.service_id);
  if (!service) throw new Error(`Service ${slot.service_id} not found`);

  const toPerson = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(toPersonId) as { id: number; name: string; email: string } | null;
  if (!toPerson) throw new Error(`Person ${toPersonId} not found`);

  // Generate (or regenerate) the teammate's magic token
  const rawToken = await createOrReplaceToken(db, toPerson.id);

  const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
  // Deep-link directly to the replacement request
  const magicLink = `${appBase}/v/${rawToken}/replacement/${replacementRequestId}`;

  const subject = `Can you cover? ${service.name} on ${service.date}`;
  const text = [
    `Hi ${toPerson.name},`,
    "",
    `A teammate needs coverage for "${service.name}" on ${service.date} at ${service.time}.`,
    `Role: ${slot.role_name}`,
    "",
    "Would you be willing to cover this slot?",
    magicLink,
    "",
    "No account or login needed — just click the link.",
    "",
    "Thank you!",
  ].join("\n");

  const html = `
    <p>Hi ${escHtmlMail(toPerson.name)},</p>
    <p>A teammate needs coverage for <strong>${escHtmlMail(service.name)}</strong>
       on ${escHtmlMail(service.date)} at ${escHtmlMail(service.time)}.<br/>
       Role: ${escHtmlMail(slot.role_name)}</p>
    <p><a href="${escHtmlMail(magicLink)}" style="display:inline-block;padding:.5rem 1rem;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px">View &amp; Respond</a></p>
    <p style="font-size:.85rem;color:#555">Or copy this link: ${escHtmlMail(magicLink)}</p>
    <p style="font-size:.85rem;color:#555">No account or login needed.</p>
  `;

  await sendMail(db, { to: toPerson.email, subject, text, html });
}

// ---------------------------------------------------------------------------
// Internal HTML escape (minimal — used only in email HTML bodies)
// ---------------------------------------------------------------------------

function escHtmlMail(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
