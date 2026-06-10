import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  listTemplateRoles,
  addTemplateRole,
  deleteTemplateRole,
  listTeams,
  listTeamRoles,
} from "../db/queries.js";
import { layout, escHtml, flash } from "../views/layout.js";

export const templatesRouter = new Hono();

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// List templates
templatesRouter.get("/", (c) => {
  const db = getDb();
  const templates = listTemplates(db);
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  const rows = templates
    .map(
      (t) =>
        `<tr>
          <td><a href="/admin/templates/${t.id}">${escHtml(t.name)}</a></td>
          <td>${escHtml(WEEKDAYS[t.weekday] ?? String(t.weekday))}</td>
          <td>${escHtml(t.time)}</td>
        </tr>`
    )
    .join("");

  const dayOptions = WEEKDAYS.map(
    (d, i) => `<option value="${i}">${d}</option>`
  ).join("");

  const body = `
    <h1>Service Templates</h1>
    ${flash(msg, "success")}
    ${flash(err, "error")}

    <div class="card">
      <h2>Create Template</h2>
      <form method="POST" action="/admin/templates">
        <div class="form-row">
          <label for="tname">Name</label>
          <input type="text" id="tname" name="name" required placeholder="Sunday Morning Service" />
        </div>
        <div class="form-row">
          <label for="weekday">Weekday</label>
          <select id="weekday" name="weekday">${dayOptions}</select>
        </div>
        <div class="form-row">
          <label for="stime">Time</label>
          <input type="time" id="stime" name="time" value="10:30" required />
        </div>
        <button type="submit">Create Template</button>
      </form>
    </div>

    <h2>All Templates</h2>
    <table>
      <thead><tr><th>Name</th><th>Day</th><th>Time</th></tr></thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="3" style="color:#999">No templates yet.</td></tr>'}</tbody>
    </table>`;

  return c.html(layout("Templates", body));
});

// Create template
templatesRouter.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const name = String(body["name"] ?? "").trim();
  const weekday = Number(body["weekday"] ?? 0);
  const time = String(body["time"] ?? "").trim();

  if (!name || !time) {
    return c.redirect("/admin/templates?err=Name+and+time+required");
  }

  const tmpl = createTemplate(db, name, weekday, time);
  return c.redirect(`/admin/templates/${tmpl.id}?msg=Template+created`);
});

// Template detail
templatesRouter.get("/:id", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const tmpl = getTemplate(db, id);
  if (!tmpl) return c.notFound();

  const roles = listTemplateRoles(db, id);
  const teams = listTeams(db);
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  const roleRows = roles
    .map((r) => {
      const team = teams.find((t) => t.id === r.team_id);
      return `<tr>
        <td>${escHtml(team?.name ?? String(r.team_id))}</td>
        <td>${escHtml(r.role_name)}</td>
        <td>${r.headcount}</td>
        <td>
          <form method="POST" action="/admin/templates/${id}/roles/${r.id}/delete" style="display:inline">
            <button class="btn btn-sm btn-danger" type="submit">Remove</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const teamOptions = teams
    .map((t) => `<option value="${t.id}">${escHtml(t.name)}</option>`)
    .join("");

  const dayOptions = WEEKDAYS.map(
    (d, i) =>
      `<option value="${i}" ${i === tmpl.weekday ? "selected" : ""}>${d}</option>`
  ).join("");

  const body = `
    <h1>${escHtml(tmpl.name)}</h1>
    ${flash(msg, "success")}
    ${flash(err, "error")}
    <a href="/admin/templates">&larr; All Templates</a>

    <div class="card" style="margin-top:1rem">
      <h2 style="margin-top:0">Edit Template</h2>
      <form method="POST" action="/admin/templates/${id}/edit">
        <div class="form-row">
          <label>Name</label>
          <input type="text" name="name" value="${escHtml(tmpl.name)}" required />
        </div>
        <div class="form-row">
          <label>Weekday</label>
          <select name="weekday">${dayOptions}</select>
        </div>
        <div class="form-row">
          <label>Time</label>
          <input type="time" name="time" value="${escHtml(tmpl.time)}" required />
        </div>
        <button type="submit">Save Changes</button>
      </form>
    </div>

    <h2>Role Slots</h2>
    <table>
      <thead><tr><th>Team</th><th>Role</th><th>Headcount</th><th></th></tr></thead>
      <tbody>${roleRows.length ? roleRows : '<tr><td colspan="4" style="color:#999">No roles yet.</td></tr>'}</tbody>
    </table>

    ${
      teams.length > 0
        ? `<div class="card" style="margin-top:.8rem">
            <h3 style="margin-top:0">Add Role Slot</h3>
            <form method="POST" action="/admin/templates/${id}/roles"
                  style="flex-direction:row;gap:.6rem;align-items:center;flex-wrap:wrap"
                  id="addRoleForm">
              <select name="team_id" id="teamSelect" onchange="updateRoles()">${teamOptions}</select>
              <select name="role_name" id="roleSelect"><option value="">-- select role --</option></select>
              <input type="number" name="headcount" value="1" min="1" style="max-width:70px" />
              <button type="submit" class="btn btn-sm">Add</button>
            </form>
          </div>
          <script>
            const teamRoles = {
              ${teams.map((t) => `"${t.id}": ${JSON.stringify(listTeamRoles(db, t.id).map((r) => r.name))}`).join(",\n")}
            };
            function updateRoles() {
              const sel = document.getElementById("teamSelect");
              const rsel = document.getElementById("roleSelect");
              const roles = teamRoles[sel.value] || [];
              rsel.innerHTML = roles.map(r => \`<option value="\${r}">\${r}</option>\`).join("") || "<option value=''>No roles defined</option>";
            }
            updateRoles();
          </script>`
        : `<p style="color:#999">Create some teams with roles first.</p>`
    }

    <div style="margin-top:1.5rem">
      <a class="btn" href="/admin/services?template_id=${id}">Generate Services from this Template</a>
    </div>`;

  return c.html(layout(`Template: ${tmpl.name}`, body));
});

// Edit template metadata
templatesRouter.post("/:id/edit", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const name = String(body["name"] ?? "").trim();
  const weekday = Number(body["weekday"] ?? 0);
  const time = String(body["time"] ?? "").trim();

  if (!name || !time) {
    return c.redirect(`/admin/templates/${id}?err=Name+and+time+required`);
  }

  updateTemplate(db, id, name, weekday, time);
  return c.redirect(`/admin/templates/${id}?msg=Template+updated`);
});

// Add role slot
templatesRouter.post("/:id/roles", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const teamId = Number(body["team_id"]);
  const roleName = String(body["role_name"] ?? "").trim();
  const headcount = Number(body["headcount"] ?? 1);

  if (!roleName) return c.redirect(`/admin/templates/${id}?err=Role+name+required`);
  addTemplateRole(db, id, teamId, roleName, headcount || 1);
  return c.redirect(`/admin/templates/${id}?msg=Role+added`);
});

// Delete role slot
templatesRouter.post("/:id/roles/:roleId/delete", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const roleId = Number(c.req.param("roleId"));
  deleteTemplateRole(db, roleId);
  return c.redirect(`/admin/templates/${id}?msg=Role+removed`);
});
