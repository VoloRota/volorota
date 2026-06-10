/**
 * Admin blockout management routes.
 *
 * Routes:
 *   GET  /admin/people/:personId/blockouts       — list blockouts for a person
 *   POST /admin/people/:personId/blockouts       — create blockout
 *   POST /admin/people/:personId/blockouts/:id/delete — delete blockout
 */

import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  listBlockoutsForPerson,
  createBlockout,
  deleteBlockout,
} from "../db/queries.js";
import {
  listPeople,
} from "../db/queries.js";
import { layout, escHtml, flash } from "../views/layout.js";

export const blockoutsRouter = new Hono();

// List blockouts for a person
blockoutsRouter.get("/:personId/blockouts", (c) => {
  const db = getDb();
  const personId = Number(c.req.param("personId"));
  const allPeople = listPeople(db);
  const person = allPeople.find((p) => p.id === personId);
  if (!person) return c.notFound();

  const blockouts = listBlockoutsForPerson(db, personId);
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  const rows = blockouts
    .map(
      (b) =>
        `<tr>
          <td>${escHtml(b.start_date)}</td>
          <td>${escHtml(b.end_date)}</td>
          <td>${b.reason ? escHtml(b.reason) : "<em style='color:#999'>—</em>"}</td>
          <td>
            <form method="POST" action="/admin/people/${personId}/blockouts/${b.id}/delete" style="display:inline">
              <button type="submit" class="btn btn-sm" style="background:#c0392b">Delete</button>
            </form>
          </td>
        </tr>`
    )
    .join("");

  const body = `
    <h1>Blockouts: ${escHtml(person.name)}</h1>
    <p style="color:#555">${escHtml(person.email)}</p>
    ${flash(msg, "success")}
    ${flash(err, "error")}
    <a href="/admin/people">&larr; All People</a>

    <div class="card" style="margin-top:.8rem">
      <h2>Add Blockout</h2>
      <form method="POST" action="/admin/people/${personId}/blockouts">
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
        <button type="submit">Add Blockout</button>
      </form>
    </div>

    <h2>Blockouts (${blockouts.length})</h2>
    <table>
      <thead><tr><th>Start</th><th>End</th><th>Reason</th><th>Actions</th></tr></thead>
      <tbody>${rows.length ? rows : '<tr><td colspan="4" style="color:#999">No blockouts.</td></tr>'}</tbody>
    </table>`;

  return c.html(layout(`Blockouts: ${person.name}`, body));
});

// Create blockout
blockoutsRouter.post("/:personId/blockouts", async (c) => {
  const db = getDb();
  const personId = Number(c.req.param("personId"));
  const allPeople = listPeople(db);
  const person = allPeople.find((p) => p.id === personId);
  if (!person) return c.notFound();

  const body = await c.req.parseBody();
  const startDate = String(body["start_date"] ?? "").trim();
  const endDate = String(body["end_date"] ?? "").trim();
  const reason = String(body["reason"] ?? "").trim() || null;

  if (!startDate || !endDate) {
    return c.redirect(
      `/admin/people/${personId}/blockouts?err=Start+and+end+date+required`
    );
  }

  if (endDate < startDate) {
    return c.redirect(
      `/admin/people/${personId}/blockouts?err=End+date+must+be+on+or+after+start+date`
    );
  }

  try {
    createBlockout(db, personId, startDate, endDate, reason);
    return c.redirect(
      `/admin/people/${personId}/blockouts?msg=Blockout+added`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/admin/people/${personId}/blockouts?err=${encodeURIComponent(msg)}`
    );
  }
});

// Delete blockout
blockoutsRouter.post("/:personId/blockouts/:id/delete", async (c) => {
  const db = getDb();
  const personId = Number(c.req.param("personId"));
  const blockoutId = Number(c.req.param("id"));

  deleteBlockout(db, blockoutId);
  return c.redirect(`/admin/people/${personId}/blockouts?msg=Blockout+deleted`);
});
