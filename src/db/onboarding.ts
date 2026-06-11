import type { Database } from "bun:sqlite";

/**
 * Setup checklist state (ISC-56).
 * All probes are cheap COUNT queries — no full table scans.
 */
export interface SetupChecklist {
  hasPeople: boolean;
  hasTeamWithRole: boolean;
  hasTeamMember: boolean;
  hasTemplateWithRole: boolean;
  hasAssignment: boolean;
}

/**
 * Returns the current checklist state.
 * When `hasAssignment` is true the caller must NOT render the checklist at all.
 */
export function getSetupChecklist(db: Database): SetupChecklist {
  const count = (sql: string): number =>
    (db.query(sql).get() as { n: number }).n;

  return {
    hasPeople: count("SELECT COUNT(*) AS n FROM people") > 0,
    hasTeamWithRole:
      count(
        "SELECT COUNT(DISTINCT team_id) AS n FROM team_roles"
      ) > 0,
    hasTeamMember: count("SELECT COUNT(*) AS n FROM team_members") > 0,
    hasTemplateWithRole:
      count(
        "SELECT COUNT(DISTINCT template_id) AS n FROM service_template_roles"
      ) > 0,
    hasAssignment: count("SELECT COUNT(*) AS n FROM assignments") > 0,
  };
}

/**
 * Look up the team name for a given team id.
 * Returns the raw id as a string when the team is not found (safe fallback).
 */
export function getTeamName(db: Database, teamId: number): string {
  const row = db
    .query("SELECT name FROM teams WHERE id = ?")
    .get(teamId) as { name: string } | null;
  return row?.name ?? String(teamId);
}
