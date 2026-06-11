import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  listTeams,
  getTeam,
  createTeam,
  listTeamRoles,
  createTeamRole,
  deleteTeamRole,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
  listPeople,
  listCrews,
  createCrew,
  listCrewMembers,
  addCrewMember,
  removeCrewMember,
  listMemberQualifications,
  setMemberQualifications,
} from "../db/queries.js";
import { layout, escHtml, flash } from "../views/layout.js";

export const teamsRouter = new Hono();

// List teams
teamsRouter.get("/", (c) => {
  const db = getDb();
  const teams = listTeams(db);
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  const rows = teams
    .map(
      (t) =>
        `<tr>
          <td><a href="/admin/teams/${t.id}">${escHtml(t.name)}</a></td>
          <td><span class="badge badge-${escHtml(t.scheduling_mode)}">${escHtml(t.scheduling_mode)}</span></td>
        </tr>`
    )
    .join("");

  const body = `
    <h1>Teams</h1>
    ${flash(msg, "success")}
    ${flash(err, "error")}

    <div class="card">
      <h2>Create Team</h2>
      <form method="POST" action="/admin/teams">
        <div class="form-row">
          <label for="name">Team Name</label>
          <input type="text" id="name" name="name" required placeholder="Sound Team" />
        </div>
        <div class="form-row">
          <label for="mode">Scheduling Mode</label>
          <select id="mode" name="scheduling_mode">
            <option value="individual">Individual rotation</option>
            <option value="crew">Crew rotation</option>
          </select>
        </div>
        <button type="submit">Create Team</button>
      </form>
    </div>

    <h2>All Teams</h2>
    <table>
      <thead><tr><th>Name</th><th>Mode</th></tr></thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="2" style="color:#999">No teams yet.</td></tr>'}</tbody>
    </table>`;

  return c.html(layout("Teams", body));
});

// Create team
teamsRouter.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const name = String(body["name"] ?? "").trim();
  const mode = String(body["scheduling_mode"] ?? "individual");

  if (!name) {
    return c.redirect("/admin/teams?err=Team+name+required");
  }
  if (mode !== "individual" && mode !== "crew") {
    return c.redirect("/admin/teams?err=Invalid+scheduling+mode");
  }

  const team = createTeam(db, name, mode);
  return c.redirect(`/admin/teams/${team.id}?msg=Team+created`);
});

// Team detail
teamsRouter.get("/:id", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  // Cast to include leader_person_id which is added via idempotent migration
  const team = getTeam(db, id) as (ReturnType<typeof getTeam> & { leader_person_id?: number | null }) | null;
  if (!team) return c.notFound();

  const roles = listTeamRoles(db, id);
  const members = listTeamMembers(db, id);
  const allPeople = listPeople(db);
  const nonMembers = allPeople.filter((p) => !members.find((m) => m.id === p.id));
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;
  const currentLeaderId: number | null = (team as any).leader_person_id ?? null;

  const roleRows = roles
    .map(
      (r) =>
        `<tr>
          <td>${escHtml(r.name)}</td>
          <td>${r.headcount_per_service}</td>
          <td>
            <form method="POST" action="/admin/teams/${id}/roles/${r.id}/delete" style="display:inline">
              <button class="btn btn-sm btn-danger" type="submit">Remove</button>
            </form>
          </td>
        </tr>`
    )
    .join("");

  // Build per-member qualification checkboxes (ISC-53)
  // Default-open: member with no restriction rows = all checkboxes rendered as checked.
  // If some roles are checked and others unchecked, restriction rows exist for the checked ones.
  const memberRows = members
    .map((p) => {
      const qualRows = listMemberQualifications(db, id, p.id);
      // qualRows is empty → no restriction → render all as checked (default-open)
      const allUnrestricted = qualRows.length === 0;

      const roleCheckboxes = roles.length > 0
        ? `<form method="POST" action="/admin/teams/${id}/members/${p.id}/qualifications" style="display:inline;flex-direction:row;gap:.4rem;align-items:center;flex-wrap:wrap">
            ${roles.map((r) => {
              const checked = allUnrestricted || qualRows.includes(r.name);
              return `<label style="font-size:.85rem;display:inline-flex;align-items:center;gap:.2rem">
                <input type="checkbox" name="role" value="${escHtml(r.name)}"${checked ? " checked" : ""}/>
                ${escHtml(r.name)}
              </label>`;
            }).join(" ")}
            <button class="btn btn-sm" type="submit" style="margin-left:.4rem">Save</button>
           </form>`
        : `<em style="font-size:.8rem;color:#888">No roles defined</em>`;

      return `<tr>
          <td>${escHtml(p.name)}</td>
          <td>${escHtml(p.email)}</td>
          <td>${roleCheckboxes}</td>
          <td>
            <form method="POST" action="/admin/teams/${id}/members/${p.id}/remove" style="display:inline">
              <button class="btn btn-sm btn-danger" type="submit">Remove</button>
            </form>
          </td>
        </tr>`;
    })
    .join("");

  const memberOptions = nonMembers
    .map((p) => `<option value="${p.id}">${escHtml(p.name)} &lt;${escHtml(p.email)}&gt;</option>`)
    .join("");

  let crewSection = "";
  if (team.scheduling_mode === "crew") {
    const crews = listCrews(db, id);

    const crewBlocks = crews
      .map((crew) => {
        const crewMembers = listCrewMembers(db, crew.id);
        const nonCrewPeople = allPeople.filter(
          (p) => !crewMembers.find((m) => m.id === p.id)
        );

        const cmRows = crewMembers
          .map(
            (p) =>
              `<tr>
                <td>${escHtml(p.name)}</td>
                <td>
                  <form method="POST" action="/admin/teams/${id}/crews/${crew.id}/members/${p.id}/remove" style="display:inline">
                    <button class="btn btn-sm btn-danger" type="submit">Remove</button>
                  </form>
                </td>
              </tr>`
          )
          .join("");

        const cmOptions = nonCrewPeople
          .map((p) => `<option value="${p.id}">${escHtml(p.name)}</option>`)
          .join("");

        return `
          <div class="card" style="margin-bottom:1rem">
            <strong>${escHtml(crew.name)}</strong>
            <table style="margin-top:.5rem">
              <thead><tr><th>Member</th><th></th></tr></thead>
              <tbody>${cmRows.length ? cmRows : '<tr><td colspan="2" style="color:#999">No members.</td></tr>'}</tbody>
            </table>
            ${
              cmOptions
                ? `<form method="POST" action="/admin/teams/${id}/crews/${crew.id}/members" style="margin-top:.6rem;flex-direction:row;gap:.5rem;align-items:center">
                    <select name="person_id" required>${cmOptions}</select>
                    <button type="submit" class="btn btn-sm">Add to Crew</button>
                   </form>`
                : `<p style="font-size:.85rem;color:#888;margin:.4rem 0 0">All people are already in a crew on this team.</p>`
            }
          </div>`;
      })
      .join("");

    crewSection = `
      <h2>Crews</h2>
      ${crewBlocks.length ? crewBlocks : '<p style="color:#999">No crews yet.</p>'}
      <div class="card">
        <h3 style="margin-top:0">Create Crew</h3>
        <form method="POST" action="/admin/teams/${id}/crews" style="flex-direction:row;gap:.6rem;align-items:center">
          <input type="text" name="crew_name" placeholder="Crew A" required style="max-width:200px" />
          <button type="submit" class="btn btn-sm">Create</button>
        </form>
      </div>`;
  }

  const body = `
    <h1>${escHtml(team.name)}
      <span class="badge badge-${escHtml(team.scheduling_mode)}" style="font-size:.8rem;vertical-align:middle">${escHtml(team.scheduling_mode)}</span>
    </h1>
    ${flash(msg, "success")}
    ${flash(err, "error")}
    <a href="/admin/teams">&larr; All Teams</a>

    <h2>Roles</h2>
    <table>
      <thead><tr><th>Role</th><th>Headcount/Service</th><th></th></tr></thead>
      <tbody>${roleRows.length ? roleRows : '<tr><td colspan="3" style="color:#999">No roles defined.</td></tr>'}</tbody>
    </table>
    <div class="card" style="margin-top:.8rem">
      <h3 style="margin-top:0">Add Role</h3>
      <form method="POST" action="/admin/teams/${id}/roles" style="flex-direction:row;gap:.6rem;align-items:center;flex-wrap:wrap">
        <input type="text" name="role_name" placeholder="Role name" required style="max-width:200px" />
        <input type="number" name="headcount" value="1" min="1" style="max-width:70px" />
        <button type="submit" class="btn btn-sm">Add Role</button>
      </form>
    </div>

    <h2>Members</h2>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Qualified Roles</th><th></th></tr></thead>
      <tbody>${memberRows.length ? memberRows : '<tr><td colspan="4" style="color:#999">No members.</td></tr>'}</tbody>
    </table>
    ${
      memberOptions
        ? `<div class="card" style="margin-top:.8rem">
            <h3 style="margin-top:0">Add Member</h3>
            <form method="POST" action="/admin/teams/${id}/members" style="flex-direction:row;gap:.6rem;align-items:center">
              <select name="person_id" required>${memberOptions}</select>
              <button type="submit" class="btn btn-sm">Add</button>
            </form>
           </div>`
        : `<p style="font-size:.85rem;color:#888">All people are already members, or there are no people yet.</p>`
    }

    <h2>Team Leader</h2>
    <div class="card">
      <p class="muted" style="margin:0 0 .6rem">
        The team leader receives email notifications when a volunteer declines or a replacement is confirmed.
        ${currentLeaderId
          ? `Current leader: <strong>${escHtml(members.find((m) => m.id === currentLeaderId)?.name ?? "(unknown)")}</strong>`
          : `<em>None set — admin email will be used as fallback (or notifications skipped if unconfigured).</em>`
        }
      </p>
      <form method="POST" action="/admin/teams/${id}/leader" style="flex-direction:row;gap:.6rem;align-items:center">
        <select name="leader_person_id">
          <option value="">— None —</option>
          ${members.map((p) => `<option value="${p.id}"${p.id === currentLeaderId ? " selected" : ""}>${escHtml(p.name)}</option>`).join("")}
        </select>
        <button type="submit" class="btn btn-sm">Set Leader</button>
      </form>
    </div>

    ${crewSection}`;

  return c.html(layout(`Team: ${team.name}`, body));
});

// Set team leader (ISC-31)
teamsRouter.post("/:id/leader", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const leaderPersonIdRaw = String(body["leader_person_id"] ?? "").trim();
  const leaderPersonId = leaderPersonIdRaw ? Number(leaderPersonIdRaw) : null;

  if (leaderPersonId && isNaN(leaderPersonId)) {
    return c.redirect(`/admin/teams/${id}?err=Invalid+leader+selection`);
  }

  db.prepare("UPDATE teams SET leader_person_id = ? WHERE id = ?").run(
    leaderPersonId,
    id
  );
  return c.redirect(`/admin/teams/${id}?msg=Team+leader+updated`);
});

// Add role
teamsRouter.post("/:id/roles", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const roleName = String(body["role_name"] ?? "").trim();
  const headcount = Number(body["headcount"] ?? 1);

  if (!roleName) return c.redirect(`/admin/teams/${id}?err=Role+name+required`);
  createTeamRole(db, id, roleName, headcount || 1);
  return c.redirect(`/admin/teams/${id}?msg=Role+added`);
});

// Delete role
teamsRouter.post("/:id/roles/:roleId/delete", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const roleId = Number(c.req.param("roleId"));
  deleteTeamRole(db, roleId);
  return c.redirect(`/admin/teams/${id}?msg=Role+removed`);
});

// Add member
teamsRouter.post("/:id/members", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const personId = Number(body["person_id"]);
  addTeamMember(db, personId, id);
  return c.redirect(`/admin/teams/${id}?msg=Member+added`);
});

// Remove member
teamsRouter.post("/:id/members/:personId/remove", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const personId = Number(c.req.param("personId"));
  removeTeamMember(db, personId, id);
  return c.redirect(`/admin/teams/${id}?msg=Member+removed`);
});

// Save role qualifications for a member (ISC-53)
// Form posts zero or more "role" fields — checked checkboxes only.
// Semantics: if all roles are checked → we store NO rows (default-open).
// If a subset is checked → we store only the checked role names as restrictions.
// If none are checked → we store NO rows (treated same as all-open, because
//   "no roles at all" is an edge case with no practical meaning; UI always shows
//   at least one role when roles exist, so a blank save means "nothing changed").
teamsRouter.post("/:id/members/:personId/qualifications", async (c) => {
  const db = getDb();
  const teamId = Number(c.req.param("id"));
  const personId = Number(c.req.param("personId"));

  const formData = await c.req.parseBody({ all: true });
  const rawRoles = formData["role"];
  const checkedRoles: string[] = rawRoles === undefined
    ? []
    : Array.isArray(rawRoles)
    ? (rawRoles as string[])
    : [rawRoles as string];

  // Fetch the team's current roles to detect "all checked" state
  const allRoles = listTeamRoles(db, teamId);
  const allRoleNames = allRoles.map((r) => r.name);

  // If every role is checked (or no roles exist), remove all restriction rows → default-open
  const allChecked = allRoleNames.length === 0 ||
    allRoleNames.every((rn) => checkedRoles.includes(rn));

  setMemberQualifications(db, teamId, personId, allChecked ? [] : checkedRoles);

  return c.redirect(`/admin/teams/${teamId}?msg=Qualifications+saved`);
});

// Create crew
teamsRouter.post("/:id/crews", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const crewName = String(body["crew_name"] ?? "").trim();
  if (!crewName) return c.redirect(`/admin/teams/${id}?err=Crew+name+required`);
  createCrew(db, id, crewName);
  return c.redirect(`/admin/teams/${id}?msg=Crew+created`);
});

// Add crew member
teamsRouter.post("/:id/crews/:crewId/members", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const crewId = Number(c.req.param("crewId"));
  const body = await c.req.parseBody();
  const personId = Number(body["person_id"]);
  try {
    addCrewMember(db, crewId, personId);
    return c.redirect(`/admin/teams/${id}?msg=Added+to+crew`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(`/admin/teams/${id}?err=${encodeURIComponent(msg)}`);
  }
});

// Remove crew member
teamsRouter.post("/:id/crews/:crewId/members/:personId/remove", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const crewId = Number(c.req.param("crewId"));
  const personId = Number(c.req.param("personId"));
  removeCrewMember(db, crewId, personId);
  return c.redirect(`/admin/teams/${id}?msg=Removed+from+crew`);
});

