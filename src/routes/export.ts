/**
 * Admin export and print routes.
 *
 * Routes (all inside /admin auth gate — mounted at /admin/services in index.ts):
 *   GET /admin/services/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD  — CSV export
 *   GET /admin/print?from=YYYY-MM-DD&to=YYYY-MM-DD                — Printable view
 *
 * Note: /admin/print is mounted separately at the app root in index.ts.
 */

import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { getExportRows } from "../db/queries.js";
import { buildCsv } from "../calendar/csv.js";
import { layout, escHtml } from "../views/layout.js";

export const exportRouter = new Hono();
export const printRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /export.csv — auth-gated CSV download
// ---------------------------------------------------------------------------

exportRouter.get("/export.csv", (c) => {
  const db = getDb();
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";

  if (!from || !to) {
    return c.text("Query params 'from' and 'to' (YYYY-MM-DD) are required.", 400);
  }
  if (from > to) {
    return c.text("'from' must be on or before 'to'.", 400);
  }

  const rows = getExportRows(db, from, to);
  const csv = buildCsv(rows);

  const filename = `volorota-${from}-to-${to}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-cache, no-store",
    },
  });
});

// ---------------------------------------------------------------------------
// GET /admin/print — auth-gated printable schedule view
// Mounted at /admin/print in index.ts
// ---------------------------------------------------------------------------

printRouter.get("/", (c) => {
  const db = getDb();
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";

  if (!from || !to) {
    // Render a date-picker form if no range given
    const body = `
      <h1>Print Schedule</h1>
      <div class="card">
        <form method="GET" action="/admin/print">
          <div class="form-row">
            <label for="pfrom">From Date</label>
            <input type="date" id="pfrom" name="from" required />
          </div>
          <div class="form-row">
            <label for="pto">To Date</label>
            <input type="date" id="pto" name="to" required />
          </div>
          <button type="submit" class="btn">View Printable Schedule</button>
        </form>
      </div>`;
    return c.html(printLayout("Print Schedule", body));
  }

  const rows = getExportRows(db, from, to);

  // Group by date+service
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.date}||${row.service}||${row.time}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  if (grouped.size === 0) {
    const body = `
      <h1>Print Schedule</h1>
      <p style="color:#999">No services found in range ${escHtml(from)} to ${escHtml(to)}.</p>
      <p><a href="/admin/print">Change dates</a></p>`;
    return c.html(printLayout("Print Schedule", body));
  }

  let sections = "";
  for (const [key, serviceRows] of grouped) {
    const parts = key.split("||");
    const date = parts[0] ?? "";
    const serviceName = parts[1] ?? "";
    const time = parts[2] ?? "";

    const tableRows = serviceRows
      .map(
        (r) =>
          `<tr>
            <td>${escHtml(r.team)}</td>
            <td>${escHtml(r.role)}</td>
            <td>${r.assignee ? escHtml(r.assignee) : '<em style="color:#aaa">Unfilled</em>'}</td>
            <td class="status-cell status-${escHtml(r.status)}">${escHtml(r.status)}</td>
          </tr>`
      )
      .join("");

    sections += `
      <div class="service-block">
        <h2>${escHtml(serviceName)}</h2>
        <p class="service-meta">${escHtml(date)} &mdash; ${escHtml(time)}</p>
        <table>
          <thead>
            <tr><th>Team</th><th>Role</th><th>Assignee</th><th>Status</th></tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;
  }

  const body = `
    <div class="print-header">
      <h1>Schedule: ${escHtml(from)} &ndash; ${escHtml(to)}</h1>
      <p class="no-print"><a href="/admin/print">Change dates</a> &nbsp;|&nbsp; <a href="/admin/services">Back to Services</a></p>
    </div>
    ${sections}`;

  return c.html(printLayout(`Schedule ${from}–${to}`, body));
});

// ---------------------------------------------------------------------------
// Print-specific layout — includes @media print CSS
// ---------------------------------------------------------------------------

function printLayout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)} — VoloRota</title>
  <style>
    /* Screen styles */
    *,*::before,*::after{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;margin:0;background:#f7f7f7;color:#1a1a1a;font-size:1rem}
    nav{background:#2c3e50;color:#fff;padding:.6rem 1rem;display:flex;gap:1rem;align-items:center}
    nav a{color:#fff;text-decoration:none;font-size:.9rem}
    main{max-width:900px;margin:0 auto;padding:1.5rem 1rem}
    h1{font-size:1.4rem;margin:.2rem 0 .4rem}
    h2{font-size:1.1rem;margin:1.2rem 0 .3rem;padding:.3rem 0;border-bottom:2px solid #2c3e50}
    .service-meta{font-size:.85rem;color:#555;margin:.1rem 0 .6rem}
    .service-block{margin-bottom:1.6rem}
    table{width:100%;border-collapse:collapse;font-size:.9rem}
    th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid #e0e0e0}
    th{font-weight:600;background:#f0f0f0;color:#333}
    .status-cell{font-size:.8rem;text-transform:uppercase;font-weight:600;letter-spacing:.03em}
    .status-confirmed{color:#1e8449}
    .status-pending{color:#b7770d}
    .status-declined{color:#a93226}
    .status-unfilled{color:#888}
    .print-header{margin-bottom:1rem}
    .card{background:#fff;border-radius:8px;padding:1rem;margin:.8rem 0;box-shadow:0 1px 3px rgba(0,0,0,.1)}
    .form-row{margin:.5rem 0}
    .form-row label{display:block;font-weight:500;margin-bottom:.2rem;font-size:.9rem}
    .form-row input{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:4px;font-size:1rem;max-width:300px}
    .btn{display:inline-block;padding:.6rem 1.2rem;background:#2c3e50;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer;text-decoration:none}

    /* Print styles */
    @media print {
      body{background:#fff;font-size:10pt}
      nav,.no-print{display:none !important}
      main{max-width:100%;padding:0}
      h1{font-size:14pt}
      h2{font-size:11pt;border-bottom:1pt solid #000;break-after:avoid}
      .service-block{break-inside:avoid;margin-bottom:1.2cm}
      .service-meta{font-size:9pt}
      table{font-size:9pt}
      th{background:#e8e8e8 !important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      th,td{padding:.25rem .35rem}
      .status-confirmed{color:#000}
      .status-pending{color:#555}
      .status-declined{color:#888}
      .status-unfilled{color:#bbb}
    }
  </style>
</head>
<body>
  <nav class="no-print">
    <a href="/admin">VoloRota Admin</a>
    <a href="/admin/services">Services</a>
    <a href="/admin/print">Print</a>
    <a href="javascript:window.print()" style="margin-left:auto">Print / Save PDF</a>
  </nav>
  <main>${body}</main>
</body>
</html>`;
}
