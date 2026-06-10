/**
 * /admin/outbox — ISC-36
 *
 * Auth-gated page listing the most-recent 200 outbound email attempts.
 * Shows: timestamp, to, subject, transport, status.
 * Renders a capture-mode banner when VOLOROTA_SMTP_HOST is not set.
 */

import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { layout, escHtml, flash } from "../views/layout.js";

export const outboxRouter = new Hono();

outboxRouter.get("/", (c) => {
  const db = getDb();
  const isCaptureMode = !process.env.VOLOROTA_SMTP_HOST;

  const rows = db
    .query(
      `SELECT id, sent_at, to_email, subject, transport, status
       FROM outbox
       ORDER BY id DESC
       LIMIT 200`
    )
    .all() as Array<{
    id: number;
    sent_at: string;
    to_email: string;
    subject: string;
    transport: string;
    status: string;
  }>;

  const captureBanner = isCaptureMode
    ? `<div class="flash flash-info" style="margin-bottom:1rem">
         <strong>Capture mode:</strong> SMTP is not configured —
         emails are captured locally and not delivered to recipients.
         Set <code>VOLOROTA_SMTP_HOST</code> to enable delivery.
       </div>`
    : "";

  const tableRows = rows
    .map(
      (r) =>
        `<tr>
          <td style="white-space:nowrap;font-size:.85rem">${escHtml(r.sent_at)}</td>
          <td>${escHtml(r.to_email)}</td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.subject)}</td>
          <td><span class="badge badge-${escHtml(r.transport)}">${escHtml(r.transport)}</span></td>
          <td><span class="badge badge-${r.status === "sent" ? "confirmed" : r.status === "skipped_no_recipient" ? "declined" : "pending"}">${escHtml(r.status)}</span></td>
        </tr>`
    )
    .join("");

  const body = `
    <h1>Email Outbox</h1>
    ${captureBanner}
    ${rows.length === 0 ? '<p style="color:#999">No emails have been sent yet.</p>' : `
    <p style="color:#666;font-size:.9rem">Showing most recent ${rows.length} send(s).</p>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Sent At</th>
            <th>To</th>
            <th>Subject</th>
            <th>Transport</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    `}`;

  return c.html(layout("Email Outbox", body));
});
