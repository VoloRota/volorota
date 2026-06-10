/**
 * Volunteer-facing routes — mounted at /v OUTSIDE the admin auth gate.
 *
 * Every route:
 *  1. Validates the bearer token (path param :token).
 *  2. Re-checks resource ownership on every resource access (ISC-33).
 *  3. Returns a friendly 4xx page — never data — for unknown/expired tokens.
 *  4. Returns 404 for cross-person resource access (never reveals existence).
 *
 * Routes:
 *   GET  /v/:token                             — volunteer home
 *   POST /v/:token/assignments/:id/accept      — accept assignment
 *   POST /v/:token/assignments/:id/decline     — decline + show eligible replacements
 *   POST /v/:token/assignments/:id/request-replacement  — create replacement request
 *   GET  /v/:token/replacement/:rrId           — view replacement request (teammate)
 *   POST /v/:token/replacement/:rrId/accept    — teammate accepts coverage
 *   POST /v/:token/blockouts                   — add blockout
 *   POST /v/:token/blockouts/:bid/delete       — remove blockout
 *   POST /v/request-fresh-link                 — re-request a link by email (no data shown)
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getDb } from "../db/schema.js";
import {
  getAssignment,
  updateAssignmentStatus,
  listAssignmentsForService,
  listServiceSlots,
  getService,
  listTeamMembers,
  isPersonBlockedOut,
  createBlockout,
  deleteBlockout,
  listBlockoutsForPerson,
  getBlockout,
} from "../db/queries.js";
import {
  lookupToken,
  lookupTokenNoExpiry,
  createOrReplaceToken,
} from "../volunteer/tokens.js";
import { sendMail, sendReplacementRequestEmail } from "../mail/mailer.js";
import { escHtml } from "../views/layout.js";

// ---------------------------------------------------------------------------
// Minimal volunteer layout — no admin nav, mobile-first
// ---------------------------------------------------------------------------

function volLayout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)} — VoloRota</title>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;margin:0;background:#f7f7f7;color:#1a1a1a;font-size:1rem}
    .vhdr{background:#2c3e50;color:#fff;padding:.8rem 1rem;font-size:1.1rem;font-weight:600}
    .vcontent{max-width:600px;margin:0 auto;padding:1rem}
    .card{background:#fff;border-radius:8px;padding:1rem;margin:.8rem 0;box-shadow:0 1px 3px rgba(0,0,0,.1)}
    h1{font-size:1.4rem;margin:.2rem 0 .6rem}
    h2{font-size:1.1rem;margin:.8rem 0 .4rem}
    table{width:100%;border-collapse:collapse;font-size:.9rem}
    th,td{text-align:left;padding:.5rem .4rem;border-bottom:1px solid #eee}
    th{font-weight:600;color:#555}
    .btn{display:inline-block;padding:.6rem 1.1rem;border:none;border-radius:6px;font-size:1rem;cursor:pointer;text-decoration:none;font-weight:500}
    .btn-accept{background:#27ae60;color:#fff}
    .btn-decline{background:#c0392b;color:#fff}
    .btn-request{background:#2980b9;color:#fff}
    .btn-delete{background:#e74c3c;color:#fff;padding:.3rem .7rem;font-size:.85rem}
    .btn-submit{background:#2c3e50;color:#fff}
    .badge{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.78rem;font-weight:600}
    .badge-pending{background:#f39c12;color:#fff}
    .badge-confirmed{background:#27ae60;color:#fff}
    .badge-declined{background:#c0392b;color:#fff}
    .flash{padding:.7rem 1rem;border-radius:6px;margin:.6rem 0}
    .flash-success{background:#d5f5e3;color:#1e8449}
    .flash-error{background:#fce4e4;color:#a93226}
    .flash-info{background:#d6eaf8;color:#1a5276}
    .form-row{margin:.5rem 0}
    .form-row label{display:block;font-weight:500;margin-bottom:.2rem;font-size:.9rem}
    .form-row input,.form-row textarea{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:4px;font-size:1rem}
    .btn-row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem}
    p.muted{color:#666;font-size:.9rem}
  </style>
</head>
<body>
  <div class="vhdr">VoloRota</div>
  <div class="vcontent">${body}</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expiredPage(msg?: string): string {
  const text = msg ?? "This link has expired or is invalid.";
  return volLayout(
    "Link Expired",
    `<div class="card">
      <h1>Link Expired</h1>
      <p class="flash flash-info">${escHtml(text)}</p>
      <p>Request a fresh link below. If the email address matches a volunteer in the system,
         you will receive a new link shortly.</p>
      <form method="POST" action="/v/request-fresh-link">
        <div class="form-row">
          <label for="email">Your email address</label>
          <input type="email" id="email" name="email" required placeholder="you@example.com" autocomplete="email" />
        </div>
        <div class="btn-row">
          <button class="btn btn-submit" type="submit">Send Fresh Link</button>
        </div>
      </form>
    </div>`
  );
}

/** Resolve token from path param; returns personId or null (expired/unknown). */
async function resolveToken(
  db: Database,
  rawToken: string
): Promise<number | null> {
  const tok = await lookupToken(db, rawToken);
  return tok ? tok.person_id : null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const volunteerRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /v/:token — volunteer home
// ---------------------------------------------------------------------------

volunteerRouter.get("/:token", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const personId = await resolveToken(db, rawToken);

  if (personId === null) {
    return c.html(expiredPage(), 410);
  }

  // Load person
  const person = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(personId) as { id: number; name: string; email: string } | null;
  if (!person) return c.html(expiredPage(), 410);

  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  // Upcoming assignments (pending + confirmed, future dates)
  const today = new Date().toISOString().slice(0, 10);
  const upcomingRows = db
    .query(
      `SELECT a.id AS assignment_id, a.status, s.name AS service_name, s.date, s.time, ss.role_name
       FROM assignments a
       JOIN service_slots ss ON ss.id = a.service_slot_id
       JOIN services s ON s.id = ss.service_id
       WHERE a.person_id = ? AND s.date >= ? AND a.status IN ('pending','confirmed')
       ORDER BY s.date, s.time`
    )
    .all(personId, today) as Array<{
    assignment_id: number;
    status: string;
    service_name: string;
    date: string;
    time: string;
    role_name: string;
  }>;

  // Past declined assignments (last 30 days) — show for reference
  const past30 = new Date();
  past30.setDate(past30.getDate() - 30);
  const past30Str = past30.toISOString().slice(0, 10);
  const recentDeclined = db
    .query(
      `SELECT a.id AS assignment_id, a.status, s.name AS service_name, s.date, ss.role_name
       FROM assignments a
       JOIN service_slots ss ON ss.id = a.service_slot_id
       JOIN services s ON s.id = ss.service_id
       WHERE a.person_id = ? AND s.date >= ? AND a.status = 'declined'
       ORDER BY s.date DESC`
    )
    .all(personId, past30Str) as Array<{
    assignment_id: number;
    status: string;
    service_name: string;
    date: string;
    role_name: string;
  }>;

  // Blockouts
  const blockouts = listBlockoutsForPerson(db, personId);

  // Build assignment rows
  const assignmentRows = upcomingRows
    .map((row) => {
      const badge = `<span class="badge badge-${escHtml(row.status)}">${escHtml(row.status)}</span>`;
      const actions =
        row.status === "pending"
          ? `<form method="POST" action="/v/${escHtml(rawToken)}/assignments/${row.assignment_id}/accept" style="display:inline">
               <button class="btn btn-accept" type="submit">Accept</button>
             </form>
             <form method="POST" action="/v/${escHtml(rawToken)}/assignments/${row.assignment_id}/decline" style="display:inline;margin-left:.3rem">
               <button class="btn btn-decline" type="submit">Decline</button>
             </form>`
          : row.status === "confirmed"
          ? `<form method="POST" action="/v/${escHtml(rawToken)}/assignments/${row.assignment_id}/decline" style="display:inline">
               <button class="btn btn-decline" type="submit">Can&apos;t make it</button>
             </form>`
          : "";

      return `<tr>
        <td>${escHtml(row.service_name)}</td>
        <td>${escHtml(row.date)}</td>
        <td>${escHtml(row.role_name)}</td>
        <td>${badge}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");

  const declinedRows = recentDeclined
    .map(
      (row) =>
        `<tr>
          <td>${escHtml(row.service_name)}</td>
          <td>${escHtml(row.date)}</td>
          <td>${escHtml(row.role_name)}</td>
          <td><span class="badge badge-declined">declined</span></td>
        </tr>`
    )
    .join("");

  // Build blockout rows
  const blockoutRows = blockouts
    .map(
      (b) =>
        `<tr>
          <td>${escHtml(b.start_date)}</td>
          <td>${escHtml(b.end_date)}</td>
          <td>${b.reason ? escHtml(b.reason) : "<em>—</em>"}</td>
          <td>
            <form method="POST" action="/v/${escHtml(rawToken)}/blockouts/${b.id}/delete">
              <button class="btn btn-delete" type="submit">Remove</button>
            </form>
          </td>
        </tr>`
    )
    .join("");

  const body = `
    ${msg ? `<div class="flash flash-success">${escHtml(msg)}</div>` : ""}
    ${err ? `<div class="flash flash-error">${escHtml(err)}</div>` : ""}

    <div class="card">
      <h1>Hi, ${escHtml(person.name)}</h1>
      <p class="muted">Here are your upcoming assignments.</p>

      <h2>Upcoming Assignments</h2>
      <table>
        <thead><tr><th>Service</th><th>Date</th><th>Role</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${assignmentRows || '<tr><td colspan="5" style="color:#999">No upcoming assignments.</td></tr>'}</tbody>
      </table>

      ${
        declinedRows
          ? `<details style="margin-top:.8rem"><summary style="cursor:pointer;font-size:.9rem;color:#666">Recently declined</summary>
             <table style="margin-top:.4rem">
               <thead><tr><th>Service</th><th>Date</th><th>Role</th><th>Status</th></tr></thead>
               <tbody>${declinedRows}</tbody>
             </table></details>`
          : ""
      }
    </div>

    <div class="card">
      <h2>My Blockout Dates</h2>
      <p class="muted">Dates you are unavailable to serve.</p>
      <table>
        <thead><tr><th>Start</th><th>End</th><th>Reason</th><th></th></tr></thead>
        <tbody>${blockoutRows || '<tr><td colspan="4" style="color:#999">No blockouts set.</td></tr>'}</tbody>
      </table>

      <h3 style="margin-top:1rem">Add a Blockout</h3>
      <form method="POST" action="/v/${escHtml(rawToken)}/blockouts">
        <div class="form-row">
          <label for="start_date">Start Date</label>
          <input type="date" id="start_date" name="start_date" required />
        </div>
        <div class="form-row">
          <label for="end_date">End Date</label>
          <input type="date" id="end_date" name="end_date" required />
        </div>
        <div class="form-row">
          <label for="reason">Reason (optional)</label>
          <input type="text" id="reason" name="reason" placeholder="Vacation, travel, etc." />
        </div>
        <div class="btn-row">
          <button class="btn btn-submit" type="submit">Add Blockout</button>
        </div>
      </form>
    </div>`;

  return c.html(volLayout(`Hi, ${person.name}`, body));
});

// ---------------------------------------------------------------------------
// POST /v/:token/assignments/:id/accept
// ---------------------------------------------------------------------------

volunteerRouter.post("/:token/assignments/:id/accept", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const assignmentId = Number(c.req.param("id"));

  const personId = await resolveToken(db, rawToken);
  if (personId === null) return c.html(expiredPage(), 410);

  // Ownership check (ISC-33)
  const assignment = getAssignment(db, assignmentId);
  if (!assignment || assignment.person_id !== personId) {
    return c.notFound();
  }

  updateAssignmentStatus(db, assignmentId, "confirmed");
  return c.redirect(`/v/${rawToken}?msg=You%27re+confirmed%21+See+you+there.`);
});

// ---------------------------------------------------------------------------
// POST /v/:token/assignments/:id/decline
// Show eligible replacement teammates after decline
// ---------------------------------------------------------------------------

volunteerRouter.post("/:token/assignments/:id/decline", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const assignmentId = Number(c.req.param("id"));

  const personId = await resolveToken(db, rawToken);
  if (personId === null) return c.html(expiredPage(), 410);

  // Ownership check (ISC-33)
  const assignment = getAssignment(db, assignmentId);
  if (!assignment || assignment.person_id !== personId) {
    return c.notFound();
  }

  updateAssignmentStatus(db, assignmentId, "declined");

  // Find eligible replacement teammates (ISC-29)
  // Eligible = same team, not blocked out on service date, not already assigned in this service
  const slot = db
    .query("SELECT * FROM service_slots WHERE id = ?")
    .get(assignment.service_slot_id) as {
    id: number;
    service_id: number;
    team_id: number;
    role_name: string;
  } | null;

  let eligibleHtml = "";
  let serviceDate = "";
  let serviceName = "";

  if (slot) {
    const service = getService(db, slot.service_id);
    if (service) {
      serviceDate = service.date;
      serviceName = service.name;

      // All team members
      const teamMembers = listTeamMembers(db, slot.team_id);

      // Already serving in this service (any status, any slot)
      const existingAssignments = listAssignmentsForService(db, slot.service_id);
      const alreadyServingIds = new Set(existingAssignments.map((a) => a.person_id));

      // Eligible = not the decliner, not blocked out, not already assigned
      const eligible = teamMembers.filter((p) => {
        if (p.id === personId) return false;
        if (alreadyServingIds.has(p.id)) return false;
        if (isPersonBlockedOut(db, p.id, service.date)) return false;
        return true;
      });

      if (eligible.length > 0) {
        const eligibleRows = eligible
          .map(
            (p) =>
              `<tr>
                <td>${escHtml(p.name)}</td>
                <td>
                  <form method="POST" action="/v/${escHtml(rawToken)}/assignments/${assignmentId}/request-replacement">
                    <input type="hidden" name="requested_person_id" value="${p.id}" />
                    <button class="btn btn-request" type="submit">Ask ${escHtml(p.name)} to cover</button>
                  </form>
                </td>
              </tr>`
          )
          .join("");

        eligibleHtml = `
          <div class="card">
            <h2>Find a Replacement</h2>
            <p class="muted">The following teammates are available for
               <strong>${escHtml(serviceName)}</strong> on ${escHtml(serviceDate)}.
               Ask one to cover your slot.</p>
            <table>
              <thead><tr><th>Name</th><th>Action</th></tr></thead>
              <tbody>${eligibleRows}</tbody>
            </table>
          </div>`;
      } else {
        eligibleHtml = `
          <div class="card">
            <h2>Replacement Options</h2>
            <p class="flash flash-info">No available teammates found for this service.
               Your team leader has been notified of the open slot.</p>
          </div>`;
      }
    }
  }

  const body = `
    <div class="flash flash-success">Your assignment has been declined.</div>
    ${eligibleHtml}
    <p><a href="/v/${escHtml(rawToken)}">Back to my schedule</a></p>`;

  return c.html(volLayout("Assignment Declined", body));
});

// ---------------------------------------------------------------------------
// POST /v/:token/assignments/:id/request-replacement (ISC-29/30)
// ---------------------------------------------------------------------------

volunteerRouter.post("/:token/assignments/:id/request-replacement", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const assignmentId = Number(c.req.param("id"));

  const personId = await resolveToken(db, rawToken);
  if (personId === null) return c.html(expiredPage(), 410);

  // Ownership check (ISC-33)
  const assignment = getAssignment(db, assignmentId);
  if (!assignment || assignment.person_id !== personId) {
    return c.notFound();
  }

  const formBody = await c.req.parseBody();
  const requestedPersonId = Number(formBody["requested_person_id"]);
  if (!requestedPersonId) {
    return c.redirect(`/v/${rawToken}?err=No+teammate+selected`);
  }

  // Verify the requested person is a real person
  const requestedPerson = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(requestedPersonId) as { id: number; name: string } | null;
  if (!requestedPerson) return c.notFound();

  // Verify requested person is a teammate in the same team for this slot
  const slot = db
    .query("SELECT * FROM service_slots WHERE id = ?")
    .get(assignment.service_slot_id) as {
    id: number;
    service_id: number;
    team_id: number;
  } | null;
  if (!slot) return c.redirect(`/v/${rawToken}?err=Slot+not+found`);

  const teamMembers = listTeamMembers(db, slot.team_id);
  const isTeammate = teamMembers.some((m) => m.id === requestedPersonId);
  if (!isTeammate) return c.notFound();

  // Create replacement request record
  const rr = db
    .prepare(
      `INSERT INTO replacement_requests (assignment_id, requested_person_id, status)
       VALUES (?, ?, 'pending') RETURNING *`
    )
    .get(assignmentId, requestedPersonId) as {
    id: number;
    assignment_id: number;
    requested_person_id: number;
    status: string;
  };

  // Send email to teammate with their magic link deep-linked to this request
  try {
    await sendReplacementRequestEmail(db, rr.id, requestedPersonId);
  } catch (e) {
    // Email failure is non-fatal — request is still created
    console.error("Failed to send replacement request email:", e);
  }

  const body = `
    <div class="card">
      <div class="flash flash-success">
        A request has been sent to <strong>${escHtml(requestedPerson.name)}</strong>.
        You will see the outcome reflected in your schedule.
      </div>
      <p><a href="/v/${escHtml(rawToken)}">Back to my schedule</a></p>
    </div>`;

  return c.html(volLayout("Request Sent", body));
});

// ---------------------------------------------------------------------------
// GET /v/:token/replacement/:rrId — teammate views replacement request
// ---------------------------------------------------------------------------

volunteerRouter.get("/:token/replacement/:rrId", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const rrId = Number(c.req.param("rrId"));

  const personId = await resolveToken(db, rawToken);
  if (personId === null) return c.html(expiredPage(), 410);

  const person = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(personId) as { id: number; name: string } | null;
  if (!person) return c.html(expiredPage(), 410);

  // Ownership check: only the requested_person_id can view this (ISC-33)
  const rr = db
    .query("SELECT * FROM replacement_requests WHERE id = ?")
    .get(rrId) as {
    id: number;
    assignment_id: number;
    requested_person_id: number;
    status: string;
  } | null;

  if (!rr || rr.requested_person_id !== personId) {
    return c.notFound();
  }

  const assignment = getAssignment(db, rr.assignment_id);
  if (!assignment) return c.notFound();

  const slot = db
    .query("SELECT * FROM service_slots WHERE id = ?")
    .get(assignment.service_slot_id) as {
    id: number;
    service_id: number;
    role_name: string;
  } | null;
  if (!slot) return c.notFound();

  const service = getService(db, slot.service_id);
  if (!service) return c.notFound();

  const msg = c.req.query("msg") ?? null;

  const statusNote =
    rr.status === "accepted"
      ? `<div class="flash flash-success">You already accepted this — you&apos;re confirmed for this service!</div>`
      : rr.status === "cancelled"
      ? `<div class="flash flash-info">This replacement request has been cancelled.</div>`
      : "";

  const actionButtons =
    rr.status === "pending"
      ? `<form method="POST" action="/v/${escHtml(rawToken)}/replacement/${rrId}/accept">
           <div class="btn-row">
             <button class="btn btn-accept" type="submit">Yes, I&apos;ll cover this slot</button>
             <a class="btn btn-decline" href="/v/${escHtml(rawToken)}">No, go back</a>
           </div>
         </form>`
      : "";

  const body = `
    <div class="card">
      <h1>Coverage Request</h1>
      ${msg ? `<div class="flash flash-success">${escHtml(msg)}</div>` : ""}
      ${statusNote}
      <p>A teammate has asked if you can cover the following slot:</p>
      <table>
        <tr><th>Service</th><td>${escHtml(service.name)}</td></tr>
        <tr><th>Date</th><td>${escHtml(service.date)}</td></tr>
        <tr><th>Time</th><td>${escHtml(service.time)}</td></tr>
        <tr><th>Role</th><td>${escHtml(slot.role_name)}</td></tr>
      </table>
      ${actionButtons}
    </div>`;

  return c.html(volLayout("Coverage Request", body));
});

// ---------------------------------------------------------------------------
// POST /v/:token/replacement/:rrId/accept (ISC-30)
// ---------------------------------------------------------------------------

volunteerRouter.post("/:token/replacement/:rrId/accept", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const rrId = Number(c.req.param("rrId"));

  const personId = await resolveToken(db, rawToken);
  if (personId === null) return c.html(expiredPage(), 410);

  // Ownership check (ISC-33)
  const rr = db
    .query("SELECT * FROM replacement_requests WHERE id = ?")
    .get(rrId) as {
    id: number;
    assignment_id: number;
    requested_person_id: number;
    status: string;
  } | null;

  if (!rr || rr.requested_person_id !== personId) {
    return c.notFound();
  }

  if (rr.status !== "pending") {
    return c.redirect(
      `/v/${rawToken}/replacement/${rrId}?msg=This+request+has+already+been+resolved`
    );
  }

  const originalAssignment = getAssignment(db, rr.assignment_id);
  if (!originalAssignment) return c.notFound();

  const slot = db
    .query("SELECT * FROM service_slots WHERE id = ?")
    .get(originalAssignment.service_slot_id) as {
    id: number;
    service_id: number;
  } | null;
  if (!slot) return c.notFound();

  // Mark replacement request accepted BEFORE deleting the original assignment
  // (ON DELETE CASCADE would delete the replacement_requests row if we deleted first)
  db.prepare(
    "UPDATE replacement_requests SET status = 'accepted' WHERE id = ?"
  ).run(rrId);

  // Remove the original assignment (superseded by replacement)
  db.prepare("DELETE FROM assignments WHERE id = ?").run(rr.assignment_id);

  // Create a confirmed assignment for the replacement person
  db.prepare(
    `INSERT INTO assignments (service_slot_id, person_id, status)
     VALUES (?, ?, 'confirmed')`
  ).run(originalAssignment.service_slot_id, personId);

  return c.redirect(
    `/v/${rawToken}/replacement/${rrId}?msg=You%27re+confirmed%21+See+you+there.`
  );
});

// ---------------------------------------------------------------------------
// POST /v/:token/blockouts — add a blockout (ISC-19)
// ---------------------------------------------------------------------------

volunteerRouter.post("/:token/blockouts", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");

  const personId = await resolveToken(db, rawToken);
  if (personId === null) return c.html(expiredPage(), 410);

  const formBody = await c.req.parseBody();
  const startDate = String(formBody["start_date"] ?? "").trim();
  const endDate = String(formBody["end_date"] ?? "").trim();
  const reason = String(formBody["reason"] ?? "").trim() || null;

  if (!startDate || !endDate) {
    return c.redirect(`/v/${rawToken}?err=Start+and+end+date+required`);
  }
  if (endDate < startDate) {
    return c.redirect(`/v/${rawToken}?err=End+date+must+be+on+or+after+start+date`);
  }

  createBlockout(db, personId, startDate, endDate, reason);
  return c.redirect(`/v/${rawToken}?msg=Blockout+added`);
});

// ---------------------------------------------------------------------------
// POST /v/:token/blockouts/:bid/delete — remove a blockout (ISC-19)
// ---------------------------------------------------------------------------

volunteerRouter.post("/:token/blockouts/:bid/delete", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const blockoutId = Number(c.req.param("bid"));

  const personId = await resolveToken(db, rawToken);
  if (personId === null) return c.html(expiredPage(), 410);

  // Ownership check (ISC-33)
  const blockout = getBlockout(db, blockoutId);
  if (!blockout || blockout.person_id !== personId) {
    return c.notFound();
  }

  deleteBlockout(db, blockoutId);
  return c.redirect(`/v/${rawToken}?msg=Blockout+removed`);
});

// ---------------------------------------------------------------------------
// POST /v/request-fresh-link — re-request a link by email
// Same response regardless of whether email matches (no oracle)
// ---------------------------------------------------------------------------

volunteerRouter.post("/request-fresh-link", async (c) => {
  const db = getDb();
  const formBody = await c.req.parseBody();
  const email = String(formBody["email"] ?? "")
    .trim()
    .toLowerCase();

  // Always show same confirmation page — no oracle
  const confirmPage = volLayout(
    "Check Your Email",
    `<div class="card">
      <h1>Check Your Email</h1>
      <p class="flash flash-success">
        If that email matches a volunteer in our system,
        a fresh link is on its way to you.
      </p>
      <p class="muted">Check your inbox (and spam folder) in the next few minutes.</p>
    </div>`
  );

  if (!email || !email.includes("@")) {
    return c.html(confirmPage);
  }

  // Attempt to find the person and send a fresh link (fire-and-forget)
  try {
    const person = db
      .query("SELECT * FROM people WHERE email = ?")
      .get(email) as { id: number; name: string; email: string } | null;

    if (person) {
      const rawToken = await createOrReplaceToken(db, person.id);
      const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
      const magicLink = `${appBase}/v/${rawToken}`;

      await sendMail(db, {
        to: person.email,
        subject: "Your VoloRota volunteer link",
        text: [
          `Hi ${person.name},`,
          "",
          "Here is your fresh volunteer link:",
          magicLink,
          "",
          "No account or login needed — just click the link.",
          "",
          "This link expires in 90 days.",
        ].join("\n"),
        html: `
          <p>Hi ${person.name},</p>
          <p>Here is your fresh volunteer link:</p>
          <p><a href="${magicLink}">${magicLink}</a></p>
          <p style="font-size:.85rem;color:#555">No account or login needed. This link expires in 90 days.</p>
        `,
      });
    }
  } catch (e) {
    console.error("Error sending fresh link:", e);
    // Never surface errors to the client
  }

  return c.html(confirmPage);
});
