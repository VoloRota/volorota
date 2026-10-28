import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  listPeople,
  createPerson,
  importPeopleFromCsv,
  setSmsContact,
} from "../db/queries.js";
import { layout, escHtml, flash } from "../views/layout.js";

export const peopleRouter = new Hono();

// List people + add form
peopleRouter.get("/", (c) => {
  const db = getDb();
  const people = listPeople(db);
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  const rows = people
    .map(
      (p) =>
        `<tr>
          <td>${escHtml(p.name)}</td>
          <td>${escHtml(p.email)}</td>
          <td>
            <form method="POST" action="/admin/people/${p.id}/sms" style="display:flex;gap:.35rem;align-items:center;flex-wrap:wrap">
              <input type="tel" name="phone" value="${escHtml(p.phone ?? "")}" placeholder="555-123-4567" style="width:9.5rem" aria-label="Phone for ${escHtml(p.name)}" />
              <label style="font-size:0.85rem;white-space:nowrap">
                <input type="checkbox" name="sms_opt_in" ${p.sms_opt_in ? "checked" : ""} />
                Text reminders
              </label>
              <button type="submit" style="font-size:0.8rem;padding:.15rem .5rem">Save</button>
            </form>
          </td>
          <td>${escHtml(p.created_at)}</td>
        </tr>`
    )
    .join("");

  const body = `
    <h1>People</h1>
    ${flash(msg, "success")}
    ${flash(err, "error")}

    <div class="card">
      <h2>Add Person</h2>
      <form method="POST" action="/admin/people">
        <div class="form-row">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required placeholder="Jane Smith" />
        </div>
        <div class="form-row">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required placeholder="jane@example.com" />
        </div>
        <div class="form-row">
          <label for="phone">Phone (optional, for SMS reminders)</label>
          <input type="tel" id="phone" name="phone" placeholder="555-123-4567" />
        </div>
        <div class="form-row">
          <label>
            <input type="checkbox" name="sms_opt_in" />
            Text me reminders (message rates may apply; reply STOP to opt out)
          </label>
        </div>
        <button type="submit">Add Person</button>
      </form>
    </div>

    <div class="card">
      <h2>Import from CSV</h2>
      <p style="font-size:0.88rem;color:#555;margin:0 0 .6rem">
        File must have columns: <code>name,email</code> (header row optional).
        Malformed rows are reported below — never silently dropped.
      </p>
      <form method="POST" action="/admin/people/import" enctype="multipart/form-data">
        <div class="form-row">
          <label for="csvfile">CSV file</label>
          <input type="file" id="csvfile" name="csvfile" accept=".csv,text/csv" required />
        </div>
        <button type="submit">Import</button>
      </form>
    </div>

    <h2>All People (${people.length})</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Email</th><th>SMS Reminders</th><th>Added</th></tr>
      </thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="4" style="color:#999">No people yet.</td></tr>'}</tbody>
    </table>`;

  return c.html(layout("People", body));
});

// Add single person
peopleRouter.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const name = String(body["name"] ?? "").trim();
  const email = String(body["email"] ?? "").trim();
  const phone = String(body["phone"] ?? "").trim() || null;
  const smsOptIn = body["sms_opt_in"] === "on";

  if (!name || !email) {
    return c.redirect("/admin/people?err=Name+and+email+are+required");
  }

  try {
    const person = createPerson(db, name, email);
    if (phone) setSmsContact(db, person.id, phone, smsOptIn);
    return c.redirect("/admin/people?msg=Person+added");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const encoded = encodeURIComponent(msg);
    return c.redirect(`/admin/people?err=${encoded}`);
  }
});

// Update a person's SMS contact + consent (from the inline form on the list)
peopleRouter.post("/:id/sms", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const phone = String(body["phone"] ?? "").trim() || null;
  const smsOptIn = body["sms_opt_in"] === "on";

  if (Number.isNaN(id)) {
    return c.redirect("/admin/people?err=Invalid+person");
  }
  setSmsContact(db, id, phone, smsOptIn);
  return c.redirect("/admin/people?msg=SMS+settings+saved");
});

// CSV import
peopleRouter.post("/import", async (c) => {
  const db = getDb();
  const formData = await c.req.formData();
  const file = formData.get("csvfile");

  if (!file || typeof file === "string") {
    return c.redirect("/admin/people?err=No+file+uploaded");
  }

  const text = await (file as File).text();
  const result = importPeopleFromCsv(db, text);

  const successRows = result.imported
    .map((p) => `<tr><td>${escHtml(p.name)}</td><td>${escHtml(p.email)}</td></tr>`)
    .join("");

  const errorItems = result.errors
    .map(
      (e) =>
        `<li>Row ${e.row}: <strong>${escHtml(e.reason)}</strong> — <code>${escHtml(e.line)}</code></li>`
    )
    .join("");

  const body = `
    <h1>CSV Import Result</h1>
    <div class="import-summary">
      <div class="flash flash-success">Imported ${result.imported.length} person(s).</div>

      ${
        result.errors.length > 0
          ? `<div class="flash flash-error">${result.errors.length} malformed row(s) — shown below, none were imported.</div>
             <h3>Errors</h3>
             <ul class="error-list">${errorItems}</ul>`
          : ""
      }

      ${
        result.imported.length > 0
          ? `<h3>Imported</h3>
             <table>
               <thead><tr><th>Name</th><th>Email</th></tr></thead>
               <tbody>${successRows}</tbody>
             </table>`
          : ""
      }
    </div>
    <p><a href="/admin/people">&larr; Back to People</a></p>`;

  return c.html(layout("Import Result", body));
});
