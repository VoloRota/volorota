/**
 * /admin/settings — SMTP status + test email delivery
 *
 * GET  /admin/settings        → settings page with SMTP status and test-email form
 * POST /admin/settings/test-email → send a test email; redirect with ?msg or ?err
 *
 * The test email works in both modes:
 *   capture mode — message lands in the outbox so the admin can confirm the
 *                  pipeline is wired up (transport shows "capture")
 *   SMTP mode    — message is actually delivered; any misconfiguration surfaces
 *                  as an error banner here instead of silently on a real volunteer
 */

import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { layout, escHtml, flash } from "../views/layout.js";
import { sendMail } from "../mail/mailer.js";

export const settingsRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /admin/settings
// ---------------------------------------------------------------------------

settingsRouter.get("/", (c) => {
  const msg = c.req.query("msg") ?? null;
  const err = c.req.query("err") ?? null;

  const smtpHost = process.env.VOLOROTA_SMTP_HOST ?? "";
  const isCaptureMode = !smtpHost;

  const smtpStatus = isCaptureMode
    ? `<span class="badge badge-pending">Capture mode</span>
       <p style="margin:.4rem 0 0;font-size:.88rem;color:#555">
         Emails are stored locally and not delivered to recipients.
         Set <code>VOLOROTA_SMTP_HOST</code> to enable real delivery.
         <a href="/admin/outbox">View outbox →</a>
       </p>`
    : `<span class="badge badge-confirmed">SMTP active</span>
       <p style="margin:.4rem 0 0;font-size:.88rem;color:#555">
         Host: <code>${escHtml(smtpHost)}</code> ·
         Port: <code>${escHtml(process.env.VOLOROTA_SMTP_PORT ?? "587")}</code> ·
         From: <code>${escHtml(process.env.VOLOROTA_SMTP_FROM ?? process.env.VOLOROTA_SMTP_USER ?? "volorota@localhost")}</code>
       </p>`;

  const defaultTo = process.env.VOLOROTA_ADMIN_EMAIL ?? "";

  const body = `
    <h1>Settings</h1>
    ${flash(msg, "success")}
    ${flash(err, "error")}

    <div class="card">
      <h2>Email delivery</h2>
      <p style="margin:0 0 .75rem"><strong>Status:</strong></p>
      ${smtpStatus}
    </div>

    <div class="card">
      <h2>Send test email</h2>
      <p style="font-size:.88rem;color:#555;margin:0 0 .8rem">
        Sends a test message through the active transport. Use this to verify
        SMTP is configured correctly before notifying volunteers.
        ${isCaptureMode ? "In capture mode the message appears in the <a href=\"/admin/outbox\">outbox</a> but is not delivered." : ""}
      </p>
      <form method="POST" action="/admin/settings/test-email">
        <div class="form-row">
          <label for="to">Send to</label>
          <input
            type="email"
            id="to"
            name="to"
            required
            placeholder="admin@example.com"
            value="${escHtml(defaultTo)}"
          />
        </div>
        <button type="submit">Send test email</button>
      </form>
    </div>`;

  return c.html(layout("Settings", body));
});

// ---------------------------------------------------------------------------
// POST /admin/settings/test-email
// ---------------------------------------------------------------------------

settingsRouter.post("/test-email", async (c) => {
  const db = getDb();
  const body = await c.req.parseBody();
  const to = String(body["to"] ?? "").trim();

  if (!to || !to.includes("@")) {
    return c.redirect("/admin/settings?err=" + encodeURIComponent("Please enter a valid email address."));
  }

  const baseUrl = process.env.VOLOROTA_BASE_URL ?? "http://localhost:3000";
  const isCaptureMode = !process.env.VOLOROTA_SMTP_HOST;
  const transportNote = isCaptureMode
    ? "Email delivery is in capture mode — this message was stored locally, not delivered."
    : "If you received this, SMTP delivery is working correctly.";

  try {
    await sendMail(db, {
      to,
      subject: "[VoloRota] Test email",
      text: [
        "This is a test email from VoloRota.",
        "",
        transportNote,
        "",
        `Sent from: ${baseUrl}`,
      ].join("\n"),
      html: `
        <p>This is a test email from <strong>VoloRota</strong>.</p>
        <p>${escHtml(transportNote)}</p>
        <p style="font-size:.85rem;color:#555">Sent from: ${escHtml(baseUrl)}</p>
      `,
    });

    const successMsg = isCaptureMode
      ? `Test email captured (capture mode) — check the outbox to confirm.`
      : `Test email sent to ${to}. Check your inbox.`;

    return c.redirect("/admin/settings?msg=" + encodeURIComponent(successMsg));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.redirect("/admin/settings?err=" + encodeURIComponent(`Failed to send: ${detail}`));
  }
});
