/**
 * Matrix view — /admin/matrix
 *
 * Shows the next N upcoming services as columns and every role-slot as rows.
 * Satisfies ISC-16, ISC-17, ISC-18.
 */

import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { getMatrixData, type MatrixData } from "../db/queries.js";
import { layout, escHtml } from "../views/layout.js";

export const matrixRouter = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_SIZE = 8; // default columns shown

// ---------------------------------------------------------------------------
// GET /admin/matrix
// ---------------------------------------------------------------------------

matrixRouter.get("/", (c) => {
  const db = getDb();

  // ?from=YYYY-MM-DD drives the window deterministically (used by tests and paging)
  const fromParam = c.req.query("from") ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = fromParam ?? today;

  const data = getMatrixData(db, fromDate, WINDOW_SIZE);

  // Compute prev/next paging dates
  const prevDate = getPrevWindowDate(db, fromDate);
  const nextDate =
    data.services.length > 0
      ? data.services[data.services.length - 1]!.date
      : null;

  // The "next" link uses the day after the last service in the current window
  const nextFrom = nextDate ? addDays(nextDate, 1) : null;

  const body = renderMatrix(data, fromDate, prevDate, nextFrom);
  return c.html(layout("Matrix View", body));
});

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderMatrix(
  data: MatrixData,
  fromDate: string,
  prevDate: string | null,
  nextFrom: string | null
): string {
  const { services, rows, cells } = data;

  // Paging controls
  const paging = `
    <div class="matrix-paging">
      ${prevDate ? `<a class="btn btn-sm" href="/admin/matrix?from=${prevDate}">&larr; Earlier</a>` : `<span class="btn btn-sm" style="opacity:.4;cursor:default">&larr; Earlier</span>`}
      <span class="matrix-paging-label">Services from ${escHtml(fromDate)}</span>
      ${nextFrom ? `<a class="btn btn-sm" href="/admin/matrix?from=${nextFrom}">Later &rarr;</a>` : `<span class="btn btn-sm" style="opacity:.4;cursor:default">Later &rarr;</span>`}
    </div>`;

  if (services.length === 0) {
    return `
      <h1>Matrix View</h1>
      ${paging}
      <p style="color:#999;margin-top:1.5rem">No upcoming services found from ${escHtml(fromDate)}.</p>`;
  }

  // Column headers: weekday + date + service name
  const headerCells = services
    .map((svc) => {
      const d = new Date(`${svc.date}T00:00:00Z`);
      const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
      const dateLabel = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
      return `<th class="matrix-col-header" data-service-id="${svc.id}">
        <span class="matrix-col-weekday">${escHtml(weekday)}</span>
        <span class="matrix-col-date">${escHtml(dateLabel)}</span>
        <span class="matrix-col-name">${escHtml(svc.name)}</span>
      </th>`;
    })
    .join("");

  // Body rows
  const bodyRows = rows
    .map((row) => {
      const dataCells = services
        .map((svc) => {
          const cellKey = `${row.slotKey}::${svc.id}`;
          const cell = cells.get(cellKey);

          if (!cell || cell.status === "none") {
            // Service doesn't have this slot — render a neutral empty cell
            return `<td class="matrix-cell cell-none"><span class="cell-symbol">—</span></td>`;
          }

          const stateClass = `cell-${cell.status}`;
          const symbol = stateSymbol(cell.status);
          const label =
            cell.personName ? escHtml(cell.personName) : "&mdash;";
          const conflictIndicator = cell.blockedOut
            ? `<span class="cell-conflict" title="Blocked out on this date">&#9888;</span>`
            : "";
          const linkHref = `/admin/services/${svc.id}`;

          return `<td class="matrix-cell ${stateClass}${cell.blockedOut ? " cell-blocked" : ""}" data-slot-id="${cell.slotId ?? ""}">
            <a href="${linkHref}" class="cell-link">
              <span class="cell-symbol">${symbol}</span>
              <span class="cell-name">${label}${conflictIndicator}</span>
            </a>
          </td>`;
        })
        .join("");

      return `<tr data-slot-key="${escHtml(row.slotKey)}">
        <th class="matrix-row-label" scope="row">
          <span class="row-team">${escHtml(row.teamName)}</span>
          <span class="row-role">${escHtml(row.roleName)} <span class="row-pos">${row.position + 1}</span></span>
        </th>
        ${dataCells}
      </tr>`;
    })
    .join("");

  // Legend
  const legend = `
    <div class="matrix-legend" aria-label="Legend">
      <span class="legend-item cell-confirmed"><span class="cell-symbol">${stateSymbol("confirmed")}</span> Confirmed</span>
      <span class="legend-item cell-pending"><span class="cell-symbol">${stateSymbol("pending")}</span> Pending</span>
      <span class="legend-item cell-declined"><span class="cell-symbol">${stateSymbol("declined")}</span> Declined</span>
      <span class="legend-item cell-unfilled"><span class="cell-symbol">${stateSymbol("unfilled")}</span> Unfilled</span>
      <span class="legend-item"><span class="cell-conflict" title="Blocked out">&#9888;</span> Blocked out</span>
    </div>`;

  return `
    <h1>Matrix View</h1>
    ${paging}
    ${legend}
    <div class="matrix-wrapper">
      <table class="matrix-table" aria-label="Volunteer assignment matrix">
        <thead>
          <tr>
            <th class="matrix-row-label matrix-corner" scope="col">Role</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>
          ${bodyRows.length ? bodyRows : `<tr><td colspan="${services.length + 1}" style="color:#999;padding:1rem">No role slots defined for these services.</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function stateSymbol(status: string): string {
  switch (status) {
    case "confirmed": return "&#10003;"; // ✓
    case "pending":   return "&#63;";    // ?
    case "declined":  return "&#10007;"; // ✗
    case "unfilled":  return "&mdash;";  // —
    default:          return "&mdash;";
  }
}

// ---------------------------------------------------------------------------
// Paging helpers
// ---------------------------------------------------------------------------

/**
 * Find the date of the service just before fromDate so the "Earlier" link
 * positions the window at the service that appears just before the current window.
 * Returns the date of the (WINDOW_SIZE)'th service counting backwards, or null
 * if there are no earlier services.
 */
function getPrevWindowDate(
  db: ReturnType<typeof getDb>,
  fromDate: string
): string | null {
  // Get up to WINDOW_SIZE services before fromDate, ordered desc
  const rows = db
    .query(
      `SELECT date FROM services WHERE date < ? ORDER BY date DESC, time DESC LIMIT ?`
    )
    .all(fromDate, WINDOW_SIZE) as Array<{ date: string }>;

  if (rows.length === 0) return null;
  // The last row (earliest) is the start of the prev window
  return rows[rows.length - 1]!.date;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
