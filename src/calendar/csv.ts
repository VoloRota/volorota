/**
 * CSV export helpers — RFC 4180 compliant.
 *
 * RFC 4180 quoting rules:
 *  - Fields containing comma, double-quote, or newline MUST be enclosed in double-quotes.
 *  - A double-quote inside a quoted field MUST be escaped by preceding it with
 *    another double-quote: "" inside "".
 *  - Other fields MAY be quoted; we quote only when necessary.
 */

import type { Database } from "bun:sqlite";
import { getExportRows, type ExportRow } from "../db/queries.js";

// ---------------------------------------------------------------------------
// RFC 4180 cell escaping
// ---------------------------------------------------------------------------

export function csvCell(value: string | null | number): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote if contains comma, double-quote, CR, or LF
  if (s.includes(",") || s.includes('"') || s.includes("\r") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Build a CSV string from export rows
// ---------------------------------------------------------------------------

export function buildCsv(rows: ExportRow[]): string {
  const CRLF = "\r\n";
  const header = ["date", "time", "service", "team", "role", "position", "assignee", "status"]
    .map(csvCell)
    .join(",");

  const lines: string[] = [header];

  for (const row of rows) {
    lines.push(
      [
        csvCell(row.date),
        csvCell(row.time),
        csvCell(row.service),
        csvCell(row.team),
        csvCell(row.role),
        csvCell(row.position + 1), // 1-based for humans
        csvCell(row.assignee),     // empty string for unfilled slots
        csvCell(row.status),
      ].join(",")
    );
  }

  return lines.join(CRLF) + CRLF;
}
