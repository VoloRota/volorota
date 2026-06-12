import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  listServices,
  getService,
  listServiceSlots,
  listAssignmentsForService,
  listTemplates,
  getTemplate,
  listTemplateRoles,
  generateServicesFromTemplate,
  createOneOffService,
  createAssignment,
  listPeople,
  listTeams,
  listTeamRoles,
  isPersonBlockedOut,
  createServiceNote,
  listServiceNotes,
  deleteServiceNote,
} from "../db/queries.js";
import { runAutofill } from "../engine/autofill.js";
import { layout, escHtml, flash } from "../views/layout.js";
import { getTeamName } from "../db/onboarding.js";

export const servicesRouter = new Hono();

// ---------------------------------------------------------------------------
// ISC-65: date-range defaults — upcoming Sunday → +8 weeks
// ---------------------------------------------------------------------------

/**
 * Returns the YYYY-MM-DD string for the upcoming Sunday (today if today is
 * Sunday, otherwise the next Sunday).
 */
function upcomingSunday(from: Date = new Date()): string {
  const d = new Date(from);
  const dayOfWeek = d.getDay(); // 0 = Sun
  if (dayOfWeek !== 0) {
    d.setDate(d.getDate() + (7 - dayOfWeek));
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the YYYY-MM-DD string 8 weeks after the given date string.
 */
function plusEightWeeks(dateStr: string): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 56); // 8 * 7
  return d.toISOString().slice(0, 10);
}

// List services + generate/create forms
servicesRouter.get("/", (c) => {
  const db = getDb();
  const services = listServices(db);
  const templates = listTemplates(db);
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;
  const preselectedTemplateId = c.req.query("template_id") ?? null;

  const rows = services
    .map(
      (s) =>
        `<tr>
          <td><a href="/admin/services/${s.id}">${escHtml(s.name)}</a></td>
          <td>${escHtml(s.date)}</td>
          <td>${escHtml(s.time)}</td>
          <td>${s.template_id ? "Recurring" : "One-off"}</td>
        </tr>`
    )
    .join("");

  const templateOptions = templates
    .map(
      (t) =>
        `<option value="${t.id}" ${preselectedTemplateId === String(t.id) ? "selected" : ""}>${escHtml(t.name)}</option>`
    )
    .join("");

  // ISC-65: prefill forms with upcoming Sunday → +8 weeks
  const defaultFrom = upcomingSunday();
  const defaultTo = plusEightWeeks(defaultFrom);

  const body = `
    <h1>Services</h1>
    ${flash(msg, "success")}
    ${flash(err, "error")}

    ${
      templates.length > 0
        ? `<div class="card">
            <h2>Generate from Template</h2>
            <form method="POST" action="/admin/services/generate">
              <div class="form-row">
                <label for="tmpl">Template</label>
                <select id="tmpl" name="template_id" required>${templateOptions}</select>
              </div>
              <div class="form-row">
                <label for="start">Start Date</label>
                <input type="date" id="start" name="start_date" required value="${defaultFrom}" />
              </div>
              <div class="form-row">
                <label for="end">End Date</label>
                <input type="date" id="end" name="end_date" required value="${defaultTo}" />
              </div>
              <button type="submit">Generate</button>
            </form>
          </div>`
        : ""
    }

    <div class="card">
      <h2>Add One-Off Service</h2>
      <form method="POST" action="/admin/services/oneoff">
        <div class="form-row">
          <label for="sname">Name</label>
          <input type="text" id="sname" name="name" required placeholder="Special Service" />
        </div>
        <div class="form-row">
          <label for="sdate">Date</label>
          <input type="date" id="sdate" name="date" required />
        </div>
        <div class="form-row">
          <label for="stime">Time</label>
          <input type="time" id="stime" name="time" value="10:30" required />
        </div>
        <button type="submit">Create Service</button>
      </form>
    </div>

    <div class="card">
      <h2>Auto-fill a Date Range</h2>
      <form method="POST" action="/admin/services/autofill-range">
        <div class="form-row">
          <label for="af_start">Start Date</label>
          <input type="date" id="af_start" name="start_date" required value="${defaultFrom}" />
        </div>
        <div class="form-row">
          <label for="af_end">End Date</label>
          <input type="date" id="af_end" name="end_date" required value="${defaultTo}" />
        </div>
        <button type="submit">Auto-fill All Services</button>
      </form>
    </div>

    <p>
      <a href="/admin/matrix">&rarr; Matrix View</a> — see all upcoming assignments at a glance
      &nbsp;|&nbsp;
      <a href="/admin/print">&rarr; Print Schedule</a>
      &nbsp;|&nbsp;
      <a href="/admin/services/export.csv">&darr; Export CSV (all dates)</a>
    </p>
    <h2>All Services (${services.length})</h2>
    <table>
      <thead><tr><th>Name</th><th>Date</th><th>Time</th><th>Type</th></tr></thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="4" style="color:#999">No services yet.</td></tr>'}</tbody>
    </table>`;

  return c.html(layout("Services", body));
});

// Generate services from template
servicesRouter.post("/generate", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const templateId = Number(body["template_id"]);
  const startDate = String(body["start_date"] ?? "");
  const endDate = String(body["end_date"] ?? "");

  if (!startDate || !endDate) {
    return c.redirect("/admin/services?err=Start+and+end+date+required");
  }
  if (startDate > endDate) {
    return c.redirect("/admin/services?err=Start+date+must+be+before+end+date");
  }

  try {
    const created = generateServicesFromTemplate(db, templateId, startDate, endDate);
    return c.redirect(
      `/admin/services?msg=${encodeURIComponent(`Generated ${created.length} service(s)`)}`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(`/admin/services?err=${encodeURIComponent(msg)}`);
  }
});

// Create one-off service
servicesRouter.post("/oneoff", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const name = String(body["name"] ?? "").trim();
  const date = String(body["date"] ?? "");
  const time = String(body["time"] ?? "10:30");

  if (!name || !date) {
    return c.redirect("/admin/services?err=Name+and+date+required");
  }

  const svc = createOneOffService(db, name, date, time, []);
  return c.redirect(`/admin/services/${svc.id}?msg=Service+created`);
});

// Auto-fill a date range
servicesRouter.post("/autofill-range", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const startDate = String(body["start_date"] ?? "");
  const endDate = String(body["end_date"] ?? "");

  if (!startDate || !endDate) {
    return c.redirect("/admin/services?err=Start+and+end+date+required");
  }

  const report = runAutofill(db, { startDate, endDate });
  return c.html(layout("Auto-fill Results", renderAutofillReport(report, null, db)));
});

// Service detail — slots + assignments
servicesRouter.get("/:id", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const svc = getService(db, id);
  if (!svc) return c.notFound();

  const slots = listServiceSlots(db, id);
  const assignments = listAssignmentsForService(db, id);
  const allPeople = listPeople(db);
  const teams = listTeams(db);
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  const templateInfo = svc.template_id
    ? (() => {
        const tmpl = getTemplate(db, svc.template_id!);
        return tmpl ? ` (from template: <a href="/admin/templates/${tmpl.id}">${escHtml(tmpl.name)}</a>)` : "";
      })()
    : "";

  // Pre-compute which people are blocked out on this service date (ISC-22)
  const blockedPersonIds = new Set<number>(
    allPeople.filter((p) => isPersonBlockedOut(db, p.id, svc.date)).map((p) => p.id)
  );
  const anyoneBlocked = blockedPersonIds.size > 0;

  const slotRows = slots
    .map((slot) => {
      const assignment = assignments.find((a) => a.service_slot_id === slot.id);
      const team = teams.find((t) => t.id === slot.team_id);

      const assignedPerson = assignment
        ? allPeople.find((p) => p.id === assignment.person_id)
        : null;

      const statusBadge = assignment
        ? `<span class="badge badge-${escHtml(assignment.status)}">${escHtml(assignment.status)}</span>`
        : `<span style="color:#999">unfilled</span>`;

      // Build person options with blockout indicator (ISC-22)
      const assignOptions = allPeople
        .map((p) => {
          const blocked = blockedPersonIds.has(p.id);
          const indicator = blocked ? " [BLOCKED OUT]" : "";
          const dataBlocked = blocked ? 'data-blocked="true"' : "";
          return `<option value="${p.id}" ${assignment?.person_id === p.id ? "selected" : ""} ${dataBlocked}>${escHtml(p.name)}${escHtml(indicator)}</option>`;
        })
        .join("");

      return `<tr>
        <td>${escHtml(team?.name ?? String(slot.team_id))}</td>
        <td>${escHtml(slot.role_name)}</td>
        <td>${slot.position + 1}</td>
        <td>${assignedPerson ? escHtml(assignedPerson.name) : "—"}</td>
        <td>${statusBadge}</td>
        <td>
          <form method="POST" action="/admin/services/${id}/slots/${slot.id}/assign" style="display:inline;flex-direction:row;gap:.3rem;align-items:center">
            <select name="person_id">${assignOptions}</select>
            <button class="btn btn-sm" type="submit">Assign</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  // Add slot form (for one-off or to supplement)
  const teamOptions = teams
    .map((t) => `<option value="${t.id}">${escHtml(t.name)}</option>`)
    .join("");

  // Notes section (ISC-45)
  const notes = listServiceNotes(db, id);
  const teamOptionsForNote =
    `<option value="">— all volunteers —</option>` +
    teams.map((t) => `<option value="${t.id}">${escHtml(t.name)}</option>`).join("");
  const noteRows = notes
    .map((n) => {
      const teamName = n.team_id
        ? (teams.find((t) => t.id === n.team_id)?.name ?? String(n.team_id))
        : null;
      const scopeLabel = teamName
        ? `<span style="font-size:.8rem;color:#888">[${escHtml(teamName)}]</span> `
        : "";
      return `<li style="margin:.4rem 0;display:flex;align-items:flex-start;gap:.5rem">
        <span style="flex:1">${scopeLabel}${escHtml(n.body)}</span>
        <form method="POST" action="/admin/services/${id}/notes/${n.id}/delete" style="display:inline">
          <button type="submit" class="btn btn-sm" style="background:#c0392b;color:#fff;padding:.2rem .5rem;font-size:.8rem">Delete</button>
        </form>
      </li>`;
    })
    .join("");

  const body = `
    <h1>${escHtml(svc.name)}</h1>
    <p style="color:#555">${escHtml(svc.date)} at ${escHtml(svc.time)}${templateInfo}</p>
    ${flash(msg, "success")}
    ${flash(err, "error")}
    <a href="/admin/services">&larr; All Services</a>

    <div style="margin:.8rem 0">
      <form method="POST" action="/admin/services/${id}/autofill" style="display:inline">
        <button type="submit" class="btn">Auto-fill This Service</button>
      </form>
    </div>

    ${slots.length === 0 && svc.template_id
      ? `<p class="onboarding-hint">This service has no role slots — <a href="/admin/templates/${svc.template_id}">add roles to its template</a> and regenerate.</p>`
      : slots.length === 0
      ? `<p class="onboarding-hint">This service has no role slots — add slots below, or <a href="/admin/templates">create a template</a> with roles.</p>`
      : ""}

    <h2>Slots &amp; Assignments</h2>
    ${anyoneBlocked ? `<p style="font-size:0.85rem;color:#666"><em>[BLOCKED OUT]</em> next to a name indicates that person has a blockout on ${escHtml(svc.date)}.</p>` : ""}
    <table>
      <thead><tr><th>Team</th><th>Role</th><th>Position</th><th>Assigned</th><th>Status</th><th>Assign</th></tr></thead>
      <tbody>${slotRows.length ? slotRows : '<tr><td colspan="6" style="color:#999">No slots defined.</td></tr>'}</tbody>
    </table>

    ${
      teams.length > 0
        ? `<div class="card" style="margin-top:.8rem">
            <h3 style="margin-top:0">Add Slot</h3>
            <form method="POST" action="/admin/services/${id}/slots"
                  style="flex-direction:row;gap:.6rem;align-items:center;flex-wrap:wrap"
                  id="addSlotForm">
              <select name="team_id" id="slotTeamSelect" onchange="updateSlotRoles()">${teamOptions}</select>
              <select name="role_name" id="slotRoleSelect"><option value="">-- role --</option></select>
              <button type="submit" class="btn btn-sm">Add Slot</button>
            </form>
          </div>
          <script>
            const slotTeamRoles = {
              ${teams.map((t) => `"${t.id}": ${JSON.stringify(listTeamRoles(db, t.id).map((r) => r.name))}`).join(",\n")}
            };
            function updateSlotRoles() {
              const sel = document.getElementById("slotTeamSelect");
              const rsel = document.getElementById("slotRoleSelect");
              const roles = slotTeamRoles[sel.value] || [];
              rsel.innerHTML = roles.map(r => \`<option value="\${r}">\${r}</option>\`).join("") || "<option value=''>No roles</option>";
            }
            updateSlotRoles();
          </script>`
        : ""
    }

    <div class="card" style="margin-top:1rem" id="service-notes">
      <h2 style="margin-top:0">Service Notes</h2>
      <p style="font-size:.85rem;color:#666">Notes visible to volunteers on their assignment page. Optionally scope to a team.</p>
      ${notes.length > 0
        ? `<ul style="list-style:none;padding:0;margin:.4rem 0">${noteRows}</ul>`
        : `<p style="color:#999;font-size:.9rem">No notes yet.</p>`}
      <form method="POST" action="/admin/services/${id}/notes" style="margin-top:.8rem">
        <div class="form-row">
          <label for="note_body">Note text</label>
          <textarea id="note_body" name="body" rows="3" required
            style="width:100%;padding:.5rem;border:1px solid #ccc;border-radius:4px;font-size:.95rem;resize:vertical"
            placeholder="e.g. Sound check at 8:30 am — setup doc: https://example.com/doc"></textarea>
        </div>
        <div class="form-row">
          <label for="note_team">Scope (optional)</label>
          <select id="note_team" name="team_id">${teamOptionsForNote}</select>
        </div>
        <button type="submit" class="btn btn-sm">Add Note</button>
      </form>
    </div>`;

  return c.html(layout(`Service: ${svc.name}`, body));
});

// Add note to service (ISC-45)
servicesRouter.post("/:id/notes", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const formBody = await c.req.parseBody();
  const bodyText = String(formBody["body"] ?? "").trim();
  const teamIdRaw = String(formBody["team_id"] ?? "").trim();
  const teamId = teamIdRaw ? Number(teamIdRaw) : null;

  if (!bodyText) return c.redirect(`/admin/services/${id}?err=Note+text+required#service-notes`);

  const svc = getService(db, id);
  if (!svc) return c.notFound();

  createServiceNote(db, id, teamId, bodyText);
  return c.redirect(`/admin/services/${id}?msg=Note+added#service-notes`);
});

// Delete note from service (ISC-45)
servicesRouter.post("/:id/notes/:noteId/delete", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const noteId = Number(c.req.param("noteId"));

  const svc = getService(db, id);
  if (!svc) return c.notFound();

  deleteServiceNote(db, noteId);
  return c.redirect(`/admin/services/${id}?msg=Note+deleted#service-notes`);
});

// Add slot to service
servicesRouter.post("/:id/slots", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const teamId = Number(body["team_id"]);
  const roleName = String(body["role_name"] ?? "").trim();

  if (!roleName) return c.redirect(`/admin/services/${id}?err=Role+name+required`);

  const slots = listServiceSlots(db, id);
  const position = slots.length;

  db.query(
    "INSERT INTO service_slots (service_id, team_id, role_name, position) VALUES (?, ?, ?, ?)"
  ).run(id, teamId, roleName, position);

  return c.redirect(`/admin/services/${id}?msg=Slot+added`);
});

// Assign person to slot — with conflict detection (ISC-20, ISC-21)
servicesRouter.post("/:id/slots/:slotId/assign", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const slotId = Number(c.req.param("slotId"));
  const body = await c.req.parseBody();
  const personId = Number(body["person_id"]);
  const override = body["override"] === "1";

  if (!personId) return c.redirect(`/admin/services/${id}?err=Person+required`);

  const svc = getService(db, id);
  if (!svc) return c.notFound();

  const allPeople = listPeople(db);
  const person = allPeople.find((p) => p.id === personId);
  if (!person) return c.redirect(`/admin/services/${id}?err=Person+not+found`);

  // Detect conflicts (unless override is set)
  if (!override) {
    const conflicts: string[] = [];

    // ISC-20: check blockout
    if (isPersonBlockedOut(db, personId, svc.date)) {
      conflicts.push(`${escHtml(person.name)} is blocked out on ${escHtml(svc.date)}.`);
    }

    // ISC-21: check double-booking in the same service
    const existingAssignments = listAssignmentsForService(db, id);
    const alreadyInService = existingAssignments.some(
      (a) => a.person_id === personId && a.service_slot_id !== slotId
    );
    if (alreadyInService) {
      conflicts.push(`${escHtml(person.name)} is already assigned to another role in this service.`);
    }

    if (conflicts.length > 0) {
      // Render conflict interstitial
      const conflictHtml = conflicts.map((c) => `<li>${c}</li>`).join("");
      const body = `
        <h1>Assignment Conflict Warning</h1>
        <div class="flash flash-error">
          <strong>Conflict detected:</strong>
          <ul>${conflictHtml}</ul>
        </div>
        <p>Do you want to assign <strong>${escHtml(person.name)}</strong> anyway?</p>
        <form method="POST" action="/admin/services/${id}/slots/${slotId}/assign">
          <input type="hidden" name="person_id" value="${personId}" />
          <input type="hidden" name="override" value="1" />
          <button type="submit" class="btn" style="background:#c0392b">Assign Anyway</button>
          &nbsp;
          <a href="/admin/services/${id}" class="btn" style="background:#555">Cancel</a>
        </form>`;
      return c.html(layout("Assignment Conflict", body));
    }
  }

  createAssignment(db, slotId, personId);
  return c.redirect(`/admin/services/${id}?msg=Assignment+saved`);
});

// Auto-fill a single service
servicesRouter.post("/:id/autofill", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const svc = getService(db, id);
  if (!svc) return c.notFound();

  const report = runAutofill(db, { serviceId: id });
  return c.html(layout("Auto-fill Results", renderAutofillReport(report, id, db)));
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a skip-reason key to a plain-language sentence + fix link.
 *
 * Contract:
 * - Known reasons return a specific sentence and direct fix link.
 * - ANY unknown reason key (including future keys added by sibling features)
 *   renders as humanized text (underscores → spaces) with a generic link to
 *   the teams page, so the template never needs to change for new keys.
 */
function skipReasonHtml(
  s: {
    reason: string;
    teamId: number;
    roleName: string;
    personName?: string;
    crewName?: string;
  },
  db: import("bun:sqlite").Database
): string {
  const teamName = escHtml(getTeamName(db, s.teamId));
  const teamLink = `<a href="/admin/teams/${s.teamId}">the ${teamName} team page</a>`;

  switch (s.reason) {
    case "all_candidates_blocked":
      return `Everyone on the ${teamName} team is blocked out on this date — go to ${teamLink} to check availability.`;

    case "no_team_members":
      return `The ${teamName} team has no members yet — add people on ${teamLink}.`;

    case "no_crew_members":
      return `The ${teamName} team has no crew members yet — add crew members on ${teamLink}.`;

    case "crew_member_blocked": {
      const who = s.personName ? escHtml(s.personName) : "A crew member";
      const crew = s.crewName ? ` (${escHtml(s.crewName)})` : "";
      return `${who}${crew} on the ${teamName} team is blocked out on this date. In crew mode, no substitution is made — see ${teamLink}.`;
    }

    case "already_assigned":
      return `This slot was already assigned before auto-fill ran.`;

    case "no_qualified_members":
      return `No one on the ${teamName} team is qualified for the ${escHtml(s.roleName)} role — assign qualifications on ${teamLink}.`;

    case "no_qualified_in_crew":
      return `No one in the assigned crew on the ${teamName} team is qualified for the ${escHtml(s.roleName)} role — see ${teamLink}.`;

    default: {
      // Generic fallback: humanize underscores so any future reason key renders
      // readably without requiring a template change here.
      const humanized = s.reason.replace(/_/g, " ");
      return `Could not fill: ${escHtml(humanized)} — check ${teamLink} for details.`;
    }
  }
}

interface ReportSkipped {
  serviceName: string;
  serviceDate: string;
  roleName: string;
  position: number;
  reason: string;
  teamId: number;
  crewName?: string;
  personName?: string;
}

interface ReportFilled {
  serviceName: string;
  serviceDate: string;
  roleName: string;
  position: number;
  personName: string;
  crewName?: string;
}

function renderAutofillReport(
  report: { filled: ReportFilled[]; skipped: ReportSkipped[] },
  serviceId: number | null,
  dbInstance: import("bun:sqlite").Database
): string {
  const backLink = serviceId
    ? `<a href="/admin/services/${serviceId}">&larr; Back to Service</a>`
    : `<a href="/admin/services">&larr; All Services</a>`;

  const filledRows = report.filled.map((f) =>
    `<tr>
      <td>${escHtml(f.serviceName)}</td>
      <td>${escHtml(f.serviceDate)}</td>
      <td>${escHtml(f.roleName)}</td>
      <td>${f.position + 1}</td>
      <td>${escHtml(f.personName)}${f.crewName ? ` <em>(${escHtml(f.crewName)})</em>` : ""}</td>
    </tr>`
  ).join("");

  const skippedRows = report.skipped.map((s) => {
    const reasonHtml = skipReasonHtml(s, dbInstance);
    return `<tr>
      <td>${escHtml(s.serviceName)}</td>
      <td>${escHtml(s.serviceDate)}</td>
      <td>${escHtml(s.roleName)}</td>
      <td>${s.position + 1}</td>
      <td>${reasonHtml}</td>
    </tr>`;
  }).join("");

  // Zero-slot dead-end: auto-fill ran on a service (or range) that has no slots
  // at all — neither filled nor skipped will have entries.
  const zeroSlotNotice =
    report.filled.length === 0 && report.skipped.length === 0
      ? `<div class="onboarding-hint">
           Auto-fill found no unfilled slots. If you expected to fill slots, the services in
           this range may have no roles defined. ${
             serviceId
               ? `<a href="/admin/services/${serviceId}">Go back to the service</a> and add slots, or`
               : "Check your templates —"
           } <a href="/admin/templates">add roles to a template</a> then regenerate services.
         </div>`
      : "";

  return `
    <h1>Auto-fill Results</h1>
    ${backLink}
    <p style="margin:.8rem 0">
      <strong>${report.filled.length}</strong> slot(s) filled &nbsp;|&nbsp;
      <strong>${report.skipped.length}</strong> slot(s) could not be filled.
    </p>

    ${report.filled.length > 0 ? `
    <h2>Filled (${report.filled.length})</h2>
    <table>
      <thead><tr><th>Service</th><th>Date</th><th>Role</th><th>Position</th><th>Assigned To</th></tr></thead>
      <tbody>${filledRows}</tbody>
    </table>` : ""}

    ${report.skipped.length > 0 ? `
    <h2>Could Not Fill (${report.skipped.length})</h2>
    <table>
      <thead><tr><th>Service</th><th>Date</th><th>Role</th><th>Position</th><th>Reason</th></tr></thead>
      <tbody>${skippedRows}</tbody>
    </table>` : ""}

    ${zeroSlotNotice}
  `;
}
