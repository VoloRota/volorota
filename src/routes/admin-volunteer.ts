/**
 * Admin touchpoints for VolunteerFlow.
 *
 * Mounted at:
 *   /admin/people/:id/volunteer-link   — view / regenerate a person's magic link
 *   /admin/services/:id/notify         — send assignment emails for a service
 *
 * Both are inside the /admin/* auth gate (authMiddleware in index.ts).
 */

import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { getAssignment, listAssignmentsForService, getService } from "../db/queries.js";
import { layout, escHtml, flash } from "../views/layout.js";
import {
  createOrReplaceToken,
  getTokenRowForPerson,
} from "../volunteer/tokens.js";
import { sendAssignmentEmail } from "../mail/mailer.js";

export const adminVolunteerRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /admin/people/:id/volunteer-link
// Shows the person's current magic link + regen button
// ---------------------------------------------------------------------------

adminVolunteerRouter.get("/:id/volunteer-link", async (c) => {
  const db = getDb();
  const personId = Number(c.req.param("id"));

  const person = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(personId) as { id: number; name: string; email: string } | null;

  if (!person) return c.notFound();

  const tokenRow = getTokenRowForPerson(db, personId);
  const msg = c.req.query("msg") ?? null;

  const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";

  const linkSection = tokenRow
    ? `<p><strong>Current link</strong> (expires: ${escHtml(tokenRow.expires_at)})</p>
       <p style="font-size:.85rem;word-break:break-all;background:#f5f5f5;padding:.5rem;border-radius:4px">
         ${escHtml(`${appBase}/v/[token hidden — regenerate to see]`)}
       </p>
       <p style="font-size:.8rem;color:#888">Token is stored hashed. Regenerate to produce a new copyable link.</p>`
    : `<p style="color:#888">No token issued yet. Regenerate to create one.</p>`;

  const body = `
    <h1>Volunteer Link — ${escHtml(person.name)}</h1>
    ${flash(msg, "success")}
    <div class="card">
      ${linkSection}
      <form method="POST" action="/admin/people/${personId}/volunteer-link/regenerate">
        <button type="submit" class="btn">Regenerate &amp; Copy Link</button>
      </form>
    </div>
    <p><a href="/admin/people">&larr; Back to People</a></p>`;

  return c.html(layout(`Volunteer Link: ${person.name}`, body));
});

// ---------------------------------------------------------------------------
// POST /admin/people/:id/volunteer-link/regenerate
// Generates a new token and shows the copyable link
// ---------------------------------------------------------------------------

adminVolunteerRouter.post("/:id/volunteer-link/regenerate", async (c) => {
  const db = getDb();
  const personId = Number(c.req.param("id"));

  const person = db
    .query("SELECT * FROM people WHERE id = ?")
    .get(personId) as { id: number; name: string; email: string } | null;

  if (!person) return c.notFound();

  const rawToken = await createOrReplaceToken(db, personId);
  const appBase = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
  const magicLink = `${appBase}/v/${rawToken}`;

  const body = `
    <h1>Volunteer Link — ${escHtml(person.name)}</h1>
    <div class="card">
      <div class="flash flash-success">New link generated. Copy it below and send to ${escHtml(person.name)}.</div>
      <p><strong>Magic Link</strong></p>
      <p style="word-break:break-all;background:#f5f5f5;padding:.6rem;border-radius:4px;font-size:.9rem">
        <a href="${escHtml(magicLink)}">${escHtml(magicLink)}</a>
      </p>
      <p style="font-size:.8rem;color:#888">This link is only shown once. Regenerate again if needed.</p>
    </div>
    <p><a href="/admin/people">&larr; Back to People</a></p>`;

  return c.html(layout(`Volunteer Link: ${person.name}`, body));
});

// ---------------------------------------------------------------------------
// POST /admin/services/:id/notify
// Sends assignment emails for all pending assignments in the service
// ---------------------------------------------------------------------------

adminVolunteerRouter.post("/:id/notify", async (c) => {
  const db = getDb();
  const serviceId = Number(c.req.param("id"));

  const svc = getService(db, serviceId);
  if (!svc) return c.notFound();

  const assignments = listAssignmentsForService(db, serviceId);
  const pending = assignments.filter((a) => a.status === "pending");

  let sent = 0;
  const errors: string[] = [];

  for (const assignment of pending) {
    try {
      await sendAssignmentEmail(db, assignment.id);
      sent++;
    } catch (e) {
      errors.push(
        `Assignment ${assignment.id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const resultMsg = errors.length > 0
    ? `Sent ${sent} email(s). Errors: ${errors.join("; ")}`
    : `Sent ${sent} email(s) to pending volunteers.`;

  return c.redirect(
    `/admin/services/${serviceId}?msg=${encodeURIComponent(resultMsg)}`
  );
});
