import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  listPeople,
  createPerson,
  importPeopleFromCsv,
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
        <tr><th>Name</th><th>Email</th><th>Added</th></tr>
      </thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="3" style="color:#999">No people yet.</td></tr>'}</tbody>
    </table>`;

  return c.html(layout("People", body));
});

// Add single person
peopleRouter.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const name = String(body["name"] ?? "").trim();
  const email = String(body["email"] ?? "").trim();

  if (!name || !email) {
    return c.redirect("/admin/people?err=Name+and+email+are+required");
  }

  try {
    createPerson(db, name, email);
    return c.redirect("/admin/people?msg=Person+added");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const encoded = encodeURIComponent(msg);
    return c.redirect(`/admin/people?err=${encoded}`);
  }
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
