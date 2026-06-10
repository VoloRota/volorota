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
  listRelevantNotesForVolunteer,
} from "../db/queries.js";
import {
  lookupToken,
  lookupTokenNoExpiry,
  createOrReplaceToken,
} from "../volunteer/tokens.js";
import { sendMail, sendReplacementRequestEmail, sendLeaderNotification } from "../mail/mailer.js";
import { escHtml } from "../views/layout.js";
import { getConfirmedAssignments, buildIcsFeed } from "../calendar/ics.js";

// ---------------------------------------------------------------------------
// Note rendering helper (ISC-46)
// ---------------------------------------------------------------------------

/**
 * Render a note body safely: escape ALL text first, then linkify http(s) URLs
 * into <a href> elements (target=_blank rel=noopener). No other markup is injected.
 */
function linkifyNoteBody(raw: string): string {
  const escaped = escHtml(raw);
  // After escaping, URLs are still valid (they contain no HTML special chars).
  // Match http:// or https:// URLs (greedy up to whitespace or end of string).
  return escaped.replace(
    /https?:\/\/[^\s<>"]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
  );
}

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
    /* === VoloRota volunteer surface — mobile-first, self-contained === */
    /* Tokens */
    :root{
      --acc:#0f766e;--acc-dk:#0d5e58;--acc-lt:#ccfbf1;--acc-txt:#134e4a;
      --bg:#f8fafc;--card:#fff;--border:#e2e8f0;--line:#f1f5f9;
      --txt:#0f172a;--txt2:#475569;--muted:#94a3b8;
      --ok-bg:#dcfce7;--ok-bd:#16a34a;--ok-tx:#14532d;
      --pend-bg:#fef9c3;--pend-bd:#ca8a04;--pend-tx:#713f12;
      --no-bg:#fee2e2;--no-bd:#dc2626;--no-tx:#7f1d1d;
      --info-bg:#eff6ff;--info-bd:#bfdbfe;--info-tx:#1e40af;
      --warn-bg:#fff1f2;--warn-bd:#fecdd3;--warn-tx:#881337;
      --sh:0 1px 3px rgba(15,23,42,.08),0 1px 2px rgba(15,23,42,.05);
    }
    *,*::before,*::after{box-sizing:border-box}
    body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         margin:0;background:var(--bg);color:var(--txt);font-size:1rem;
         line-height:1.6;-webkit-font-smoothing:antialiased}
    /* Header */
    .vhdr{background:#0f172a;color:#f1f5f9;padding:.9rem 1.25rem;
          display:flex;align-items:center;gap:.6rem;
          font-size:1.05rem;font-weight:700;letter-spacing:-.02em;
          position:sticky;top:0;z-index:50;
          box-shadow:0 1px 0 rgba(255,255,255,.05),0 2px 4px rgba(0,0,0,.2)}
    .vhdr::before{content:"";display:inline-block;width:8px;height:8px;
                  background:#5eead4;border-radius:50%;flex-shrink:0}
    /* Content */
    .vcontent{max-width:600px;margin:0 auto;padding:1.25rem 1rem 3rem}
    /* Cards */
    .card{background:var(--card);border-radius:10px;padding:1.25rem;
          margin:.75rem 0;box-shadow:var(--sh);border:1px solid var(--border)}
    /* Typography */
    h1{font-size:1.35rem;font-weight:700;letter-spacing:-.02em;
       margin:.1rem 0 .5rem;color:var(--txt)}
    h2{font-size:1.05rem;font-weight:600;margin:.9rem 0 .4rem;color:var(--txt)}
    h3{font-size:.9rem;font-weight:600;margin:.8rem 0 .3rem;color:var(--txt2)}
    p.muted{color:var(--txt2);font-size:.875rem;margin:.2rem 0 .6rem}
    a{color:var(--acc)}
    a:hover{text-decoration:underline}
    /* Tables */
    table{width:100%;border-collapse:collapse;font-size:.875rem}
    th{text-align:left;padding:.4rem .5rem;
       font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;
       color:var(--muted);border-bottom:1px solid var(--border)}
    td{text-align:left;padding:.65rem .5rem;border-bottom:1px solid var(--line);
       vertical-align:middle}
    td a{overflow-wrap:anywhere;word-break:break-all}
    tr:last-child td{border-bottom:none}
    /* Phone: 5 columns can't fit — each assignment row becomes a stacked card */
    @media (max-width: 560px){
      .assignments table,.assignments tbody,.assignments tr,.assignments td{display:block;width:100%}
      .assignments thead{display:none}
      .assignments tr{background:#fff;border:1px solid var(--border);border-radius:10px;
        padding:.75rem .85rem;margin:0 0 .75rem}
      .assignments td{border:none;padding:.15rem 0}
      .assignments td:nth-child(1){font-weight:600;font-size:1rem;padding-bottom:.35rem}
      .assignments td:nth-child(1) ul{font-weight:400}
      .assignments td:nth-child(2),.assignments td:nth-child(3){
        display:inline-block;width:auto;color:var(--muted);font-size:.85rem;
        padding-right:.75rem}
      .assignments td:nth-child(4){display:inline-block;width:auto;padding:.15rem 0}
      .assignments td:nth-child(5){padding-top:.6rem}
      .assignments td:nth-child(5) .btn{padding:.6rem 1.2rem}
    }
    /* Assignment row — card-like on mobile */
    .asgn-row{display:flex;flex-direction:column;gap:.2rem;
              background:var(--card);border-radius:8px;
              border:1px solid var(--border);padding:.9rem 1rem;margin:.5rem 0;
              box-shadow:0 1px 2px rgba(15,23,42,.05)}
    .asgn-row-meta{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
    .asgn-row-title{font-weight:600;font-size:.95rem;color:var(--txt)}
    .asgn-row-detail{font-size:.8rem;color:var(--txt2)}
    .asgn-row-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem}
    /* Buttons — big tap targets on mobile */
    .btn{display:inline-flex;align-items:center;justify-content:center;
         padding:.7rem 1.3rem;border:none;border-radius:6px;
         font-size:.95rem;font-family:inherit;cursor:pointer;
         text-decoration:none;font-weight:600;
         transition:background .15s,transform .08s;white-space:nowrap;min-height:44px}
    .btn:active{transform:translateY(1px)}
    .btn-accept{background:var(--ok-bd);color:#fff}
    .btn-accept:hover{background:#15803d}
    .btn-decline{background:var(--no-bd);color:#fff}
    .btn-decline:hover{background:#b91c1c}
    .btn-request{background:var(--acc);color:#fff}
    .btn-request:hover{background:var(--acc-dk)}
    .btn-delete{background:var(--no-bg);color:var(--no-tx);
                border:1px solid var(--no-bd);padding:.4rem .8rem;font-size:.8rem;min-height:36px}
    .btn-delete:hover{background:#fecaca}
    .btn-submit{background:var(--acc);color:#fff}
    .btn-submit:hover{background:var(--acc-dk)}
    .btn-sm{padding:.4rem .9rem;font-size:.82rem;min-height:36px}
    /* Status chips */
    .chip{display:inline-flex;align-items:center;padding:3px .6rem;
          border-radius:999px;font-size:.72rem;font-weight:700;
          letter-spacing:.03em;text-transform:uppercase;white-space:nowrap}
    .chip-confirmed{background:var(--ok-bg);color:var(--ok-tx)}
    .chip-pending{background:var(--pend-bg);color:var(--pend-tx)}
    .chip-declined{background:var(--no-bg);color:var(--no-tx)}
    /* Backwards compat: .badge maps to .chip */
    .badge{display:inline-flex;align-items:center;padding:3px .6rem;
           border-radius:999px;font-size:.72rem;font-weight:700;
           letter-spacing:.03em;text-transform:uppercase;white-space:nowrap}
    .badge-pending{background:var(--pend-bg);color:var(--pend-tx)}
    .badge-confirmed{background:var(--ok-bg);color:var(--ok-tx)}
    .badge-declined{background:var(--no-bg);color:var(--no-tx)}
    /* Flash banners */
    .flash{padding:.75rem 1rem;border-radius:6px;border:1px solid transparent;
           font-size:.875rem;margin:.5rem 0;line-height:1.5}
    .flash-success{background:var(--ok-bg);color:var(--ok-tx);border-color:#bbf7d0}
    .flash-error{background:var(--warn-bg);color:var(--warn-tx);border-color:var(--warn-bd)}
    .flash-info{background:var(--info-bg);color:var(--info-tx);border-color:var(--info-bd)}
    /* Forms */
    .form-row{margin:.6rem 0}
    .form-row label{display:block;font-weight:600;font-size:.8rem;
                    color:var(--txt2);letter-spacing:.01em;margin-bottom:.25rem}
    .form-row input,.form-row textarea{
      width:100%;padding:.6rem .75rem;border:1px solid var(--border);
      border-radius:5px;font-size:1rem;font-family:inherit;
      background:var(--card);color:var(--txt);
      transition:border-color .15s,box-shadow .15s}
    .form-row input:focus,.form-row textarea:focus{
      outline:none;border-color:var(--acc);
      box-shadow:0 0 0 3px rgba(15,118,110,.12)}
    .btn-row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem}
    /* Calendar link block */
    .cal-block{background:var(--line);border-radius:6px;
               padding:.75rem 1rem;margin:.5rem 0;font-size:.8rem}
    .cal-url{font-family:ui-monospace,monospace;font-size:.75rem;word-break:break-all;
             background:var(--card);padding:.3rem .5rem;border-radius:4px;
             border:1px solid var(--border);display:block;margin:.4rem 0}
    /* Details/summary */
    details summary{cursor:pointer;font-size:.875rem;color:var(--acc);
                    font-weight:500;user-select:none}
    details summary:hover{text-decoration:underline}
    /* Footer */
    .vfooter{text-align:center;padding:2rem 1rem 1rem;
             font-size:.72rem;color:var(--muted);letter-spacing:.04em}
  </style>
</head>
<body>
  <div class="vhdr">VoloRota</div>
  <div class="vcontent">${body}</div>
  <div class="vfooter">VoloRota &middot; AGPL-3.0 &middot; self-hosted</div>
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
      `SELECT a.id AS assignment_id, a.status, s.id AS service_id, s.name AS service_name,
              s.date, s.time, ss.role_name, ss.team_id
       FROM assignments a
       JOIN service_slots ss ON ss.id = a.service_slot_id
       JOIN services s ON s.id = ss.service_id
       WHERE a.person_id = ? AND s.date >= ? AND a.status IN ('pending','confirmed')
       ORDER BY s.date, s.time`
    )
    .all(personId, today) as Array<{
    assignment_id: number;
    status: string;
    service_id: number;
    service_name: string;
    date: string;
    time: string;
    role_name: string;
    team_id: number;
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

  // Build assignment rows (ISC-46: include relevant service notes per assignment)
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

      // Fetch notes relevant to this assignment (service-wide + own team)
      const relevantNotes = listRelevantNotesForVolunteer(db, row.service_id, row.team_id);
      const notesHtml =
        relevantNotes.length > 0
          ? `<ul style="margin:.4rem 0 0;padding:0 0 0 1.1rem;font-size:.88rem;color:#333;overflow-wrap:anywhere">` +
            relevantNotes.map((n) => `<li>${linkifyNoteBody(n.body)}</li>`).join("") +
            `</ul>`
          : "";

      return `<tr>
        <td>${escHtml(row.service_name)}${notesHtml}</td>
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

  const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
  const calFeedUrl = `${appBase}/v/${escHtml(rawToken)}/calendar.ics`;

  const body = `
    ${msg ? `<div class="flash flash-success">${escHtml(msg)}</div>` : ""}
    ${err ? `<div class="flash flash-error">${escHtml(err)}</div>` : ""}

    <div class="card">
      <h1>Hi, ${escHtml(person.name)}</h1>
      <p class="muted">Here are your upcoming assignments.</p>

      <details style="margin:.4rem 0 .8rem">
        <summary style="cursor:pointer;font-size:.9rem;color:#2980b9">Add to your calendar</summary>
        <p style="font-size:.85rem;margin:.4rem 0 .2rem">Subscribe to your personal ICS feed in any calendar app
           (Apple Calendar, Google Calendar, Outlook, etc.):</p>
        <code style="font-size:.8rem;word-break:break-all;background:#f5f5f5;padding:.4rem .6rem;border-radius:4px;display:block">${calFeedUrl}</code>
        <p style="font-size:.8rem;color:#888;margin:.3rem 0 0">Feed includes only your confirmed assignments and updates automatically.</p>
      </details>

      <h2>Upcoming Assignments</h2>
      <div class="assignments">
      <table>
        <thead><tr><th>Service</th><th>Date</th><th>Role</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${assignmentRows || '<tr><td colspan="5" style="color:#999">No upcoming assignments.</td></tr>'}</tbody>
      </table>
      </div>

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

  // ISC-31: notify team leader of decline (fire-and-forget; non-fatal)
  try {
    await sendLeaderNotification(db, assignmentId, "declined");
  } catch (e) {
    console.error("Failed to send leader decline notification:", e);
  }

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

  // ISC-31: notify team leader of replacement acceptance (fire-and-forget; non-fatal)
  // We notify based on the original assignment (which is now deleted, but the slot/team info
  // is still accessible). Since the assignment row was deleted, we need to reconstruct enough
  // context. We pass the original assignment id but note it may be gone — sendLeaderNotification
  // must handle this gracefully or we use a different approach.
  // Better: notify with the NEW assignment (coverPersonId = personId).
  // Find the new assignment for the slot.
  try {
    const newAssignment = db
      .query(
        "SELECT * FROM assignments WHERE service_slot_id = ? AND person_id = ? AND status = 'confirmed'"
      )
      .get(originalAssignment.service_slot_id, personId) as {
      id: number;
    } | null;
    if (newAssignment) {
      await sendLeaderNotification(db, newAssignment.id, "replacement_accepted", personId);
    }
  } catch (e) {
    console.error("Failed to send leader replacement notification:", e);
  }

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
// GET /v/:token/calendar.ics — private ICS feed (confirmed assignments only)
// Same token validation as all other /v/:token routes (ISC-37)
// ---------------------------------------------------------------------------

volunteerRouter.get("/:token/calendar.ics", async (c) => {
  const db = getDb();
  const rawToken = c.req.param("token");
  const personId = await resolveToken(db, rawToken);

  if (personId === null) {
    // Return a minimal error ICS rather than HTML so calendar clients get a
    // clear 410 status code (same semantics as the rest of /v/:token)
    return new Response("Token expired or invalid", { status: 410 });
  }

  const assignments = getConfirmedAssignments(db, personId);
  const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
  const volunteerLink = `${appBase}/v/${rawToken}`;
  const ics = buildIcsFeed(assignments, volunteerLink);

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "Content-Disposition": 'attachment; filename="volorota.ics"',
    },
  });
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
