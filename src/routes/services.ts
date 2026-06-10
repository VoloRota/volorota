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
} from "../db/queries.js";
import { layout, escHtml, flash } from "../views/layout.js";

export const servicesRouter = new Hono();

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
                <input type="date" id="start" name="start_date" required />
              </div>
              <div class="form-row">
                <label for="end">End Date</label>
                <input type="date" id="end" name="end_date" required />
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

  // For one-off services allow adding slot definitions
  const templateInfo = svc.template_id
    ? (() => {
        const tmpl = getTemplate(db, svc.template_id!);
        return tmpl ? ` (from template: <a href="/admin/templates/${tmpl.id}">${escHtml(tmpl.name)}</a>)` : "";
      })()
    : "";

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

      const assignOptions = allPeople
        .map(
          (p) =>
            `<option value="${p.id}" ${assignment?.person_id === p.id ? "selected" : ""}>${escHtml(p.name)}</option>`
        )
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

  const body = `
    <h1>${escHtml(svc.name)}</h1>
    <p style="color:#555">${escHtml(svc.date)} at ${escHtml(svc.time)}${templateInfo}</p>
    ${flash(msg, "success")}
    ${flash(err, "error")}
    <a href="/admin/services">&larr; All Services</a>

    <h2>Slots &amp; Assignments</h2>
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
    }`;

  return c.html(layout(`Service: ${svc.name}`, body));
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

// Assign person to slot
servicesRouter.post("/:id/slots/:slotId/assign", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const slotId = Number(c.req.param("slotId"));
  const body = await c.req.parseBody();
  const personId = Number(body["person_id"]);

  if (!personId) return c.redirect(`/admin/services/${id}?err=Person+required`);

  createAssignment(db, slotId, personId);
  return c.redirect(`/admin/services/${id}?msg=Assignment+saved`);
});
