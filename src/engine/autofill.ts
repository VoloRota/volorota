/**
 * VoloRota Auto-Fill Engine
 *
 * Pure module: operates on a Database instance, no HTTP, fully testable.
 *
 * === Individual mode fairness ===
 * For each unfilled slot (processed in service-date order, then slot position):
 *   1. Collect team members not blocked out on that service date.
 *   2. Remove anyone already assigned (pending/confirmed/declined) in that service.
 *   3. From remaining candidates, pick the one least-recently-served in this team:
 *        - never served (last_served IS NULL) → sorts first
 *        - else sort ascending by last_served date string (YYYY-MM-DD, lexicographic = chronological)
 *        - deterministic tie-break: lowest person.id wins
 *   4. Record the assignment in the in-session state so subsequent slots in the same
 *      run see it (two slots in one service get two different people).
 *
 * === Crew mode rotation ===
 * For each service (in date order) on a crew-mode team:
 *   1. Find which crew is "up next" by continuing from the last crew-assigned service:
 *        - look at the most recent past service for this team that has any assignment
 *          from a crew member; find which crew that was → the next crew in rotation_order.
 *        - if no prior assignments, start with rotation_order=0 (lowest id tie-break).
 *        - within a single run, advance the crew pointer after each service.
 *   2. Assign all unfilled slots for this team in this service from the assigned crew's
 *      member list (sorted by person.id for determinism, cycling if crew < slots).
 *   3. If a crew member is blocked out on the service date, leave their slot unfilled
 *      and flag it — never substitute from another crew.
 *
 * === Invariants ===
 * - NEVER overwrite an existing assignment row (any status counts as occupied).
 * - Slots with no legal candidate are left with no assignment row and are reported.
 * - Deterministic: same DB state → same output (no wall-clock or randomness).
 */

import type { Database } from "bun:sqlite";
import {
  listServices,
  listServiceSlots,
  listAssignmentsForService,
  listTeamMembers,
  listCrews,
  listCrewMembers,
  getTeam,
  isPersonBlockedOut,
  lastServedDateByPerson,
  listTeamQualifications,
  type Service,
  type ServiceSlot,
  type Assignment,
  type Team,
  type Person,
  type Crew,
} from "../db/queries.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutofillOptions {
  /** Only process services with dates in [startDate, endDate] (YYYY-MM-DD, inclusive). */
  startDate?: string;
  /** Only process services with dates in [startDate, endDate] (YYYY-MM-DD, inclusive). */
  endDate?: string;
  /** If provided, only auto-fill this single service ID. */
  serviceId?: number;
}

export interface FillResult {
  /** Slot id that was filled. */
  slotId: number;
  serviceId: number;
  serviceName: string;
  serviceDate: string;
  roleName: string;
  position: number;
  teamId: number;
  personId: number;
  personName: string;
  crewName?: string;
  /**
   * ISC-54: present when the chosen person was already assigned elsewhere in
   * this service (across teams) and was the only available candidate.
   * Value: "double_booked"
   */
  flags?: "double_booked";
}

export interface SkipResult {
  slotId: number;
  serviceId: number;
  serviceName: string;
  serviceDate: string;
  roleName: string;
  position: number;
  teamId: number;
  reason:
    | "all_candidates_blocked"
    | "no_team_members"
    | "no_crew_members"
    | "crew_member_blocked"
    | "already_assigned"
    | "no_qualified_in_crew"; // ISC-53: crew member not qualified for this role
  /** For crew mode: which crew was assigned to this service. */
  crewName?: string;
  personId?: number;
  personName?: string;
}

export interface AutofillReport {
  filled: FillResult[];
  skipped: SkipResult[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Insert a pending assignment row and return it. */
function insertAssignment(db: Database, slotId: number, personId: number): void {
  db.prepare(
    `INSERT INTO assignments (service_slot_id, person_id, status)
     VALUES (?, ?, 'pending')`
  ).run(slotId, personId);
}

/**
 * Determine which crew is "up next" for a team, given services already processed
 * in this run and the prior DB state.
 *
 * @param db - Database instance
 * @param teamId - Team id
 * @param crews - Crews for this team in rotation order (sorted by rotation_order ASC, id ASC)
 * @param alreadyAssignedThisRun - Map of serviceId → crewId assigned during this run
 * @param servicesSoFar - Services processed so far in this run (date order), prior to `currentServiceId`
 * @returns The crew to assign to the current service
 */
function nextCrewForTeam(
  db: Database,
  teamId: number,
  crews: Crew[],
  lastAssignedCrewId: number | null
): Crew {
  if (crews.length === 0) throw new Error(`No crews for team ${teamId}`);
  if (crews.length === 1) return crews[0]!;

  if (lastAssignedCrewId === null) {
    // Never assigned before → start with the first crew (lowest rotation_order, lowest id)
    return crews[0]!;
  }

  const lastIdx = crews.findIndex((c) => c.id === lastAssignedCrewId);
  if (lastIdx < 0) {
    // Last crew no longer exists; start from beginning
    return crews[0]!;
  }
  return crews[(lastIdx + 1) % crews.length]!;
}

/**
 * Find which crew (if any) was last assigned for a given team across all
 * historical assignments in the DB (excluding the current run).
 * Returns the crew id or null.
 */
function findLastHistoricalCrewId(db: Database, teamId: number): number | null {
  // Find the most recent service that has an assignment for a slot in this team,
  // where the assigned person belongs to a crew in this team.
  const row = db
    .query(
      `SELECT c.id AS crew_id
       FROM services s
       JOIN service_slots ss ON ss.service_id = s.id AND ss.team_id = ?
       JOIN assignments a ON a.service_slot_id = ss.id
       JOIN crew_members cm ON cm.person_id = a.person_id
       JOIN crews c ON c.id = cm.crew_id AND c.team_id = ?
       ORDER BY s.date DESC, s.id DESC
       LIMIT 1`
    )
    .get(teamId, teamId) as { crew_id: number } | null;

  return row ? row.crew_id : null;
}

// ---------------------------------------------------------------------------
// Individual-mode fill logic
// ---------------------------------------------------------------------------

function fillIndividualSlots(
  db: Database,
  service: Service,
  slots: ServiceSlot[],
  existingAssignments: Map<number, Assignment>, // keyed by service_slot_id
  // In-run tracking: personId → last served date (updated as we fill)
  lastServedInRun: Map<number, string | null>,
  // In-run tracking: which person ids are already assigned in this service
  // for this team (within-team exclusion — pre-seeded from existing assignments)
  assignedInServiceThisTeam: Set<number>,
  // ISC-54: cross-team same-service set — persons already serving this service
  // via ANY team.  Filled + updated as each assignment is written across all teams.
  assignedInServiceCrossTeam: Set<number>,
  // ISC-53: qualification map for this team (see listTeamQualifications)
  qualifications: Map<number, Set<string>>,
  report: AutofillReport
): void {
  for (const slot of slots) {
    // Skip if already assigned
    if (existingAssignments.has(slot.id)) {
      continue;
    }

    const members = listTeamMembers(db, slot.team_id);

    if (members.length === 0) {
      report.skipped.push({
        slotId: slot.id,
        serviceId: service.id,
        serviceName: service.name,
        serviceDate: service.date,
        roleName: slot.role_name,
        position: slot.position,
        teamId: slot.team_id,
        reason: "no_team_members",
      });
      continue;
    }

    // Filter: not blocked out, not already in this service (within-team),
    //         and qualified for this slot's role (ISC-53)
    const candidates = members.filter((p) => {
      if (assignedInServiceThisTeam.has(p.id)) return false;
      if (isPersonBlockedOut(db, p.id, service.date)) return false;
      // ISC-53: qualification check — default-open when no restriction rows exist
      const qualSet = qualifications.get(p.id);
      if (qualSet !== undefined && !qualSet.has(slot.role_name)) return false;
      return true;
    });

    if (candidates.length === 0) {
      report.skipped.push({
        slotId: slot.id,
        serviceId: service.id,
        serviceName: service.name,
        serviceDate: service.date,
        roleName: slot.role_name,
        position: slot.position,
        teamId: slot.team_id,
        reason: "all_candidates_blocked",
      });
      continue;
    }

    // ISC-54: separate candidates into those not yet serving this service
    // (preferred) and those already serving via another team (last resort).
    const preferredCandidates = candidates.filter((p) => !assignedInServiceCrossTeam.has(p.id));
    const lastResortCandidates = candidates.filter((p) => assignedInServiceCrossTeam.has(p.id));

    // Pick from preferred if available; else fall back to last-resort + flag
    const pool = preferredCandidates.length > 0 ? preferredCandidates : lastResortCandidates;
    const isDoubleBook = preferredCandidates.length === 0 && lastResortCandidates.length > 0;

    // Sort by least-recently-served: null (never served) first, then ascending date, then id
    pool.sort((a, b) => {
      const aDate = lastServedInRun.get(a.id) ?? null;
      const bDate = lastServedInRun.get(b.id) ?? null;

      if (aDate === null && bDate === null) return a.id - b.id;
      if (aDate === null) return -1;
      if (bDate === null) return 1;
      if (aDate < bDate) return -1;
      if (aDate > bDate) return 1;
      return a.id - b.id;
    });

    const chosen = pool[0]!;

    // Write to DB
    insertAssignment(db, slot.id, chosen.id);

    // Update in-run state
    lastServedInRun.set(chosen.id, service.date);
    assignedInServiceThisTeam.add(chosen.id);
    assignedInServiceCrossTeam.add(chosen.id);

    const fillEntry: FillResult = {
      slotId: slot.id,
      serviceId: service.id,
      serviceName: service.name,
      serviceDate: service.date,
      roleName: slot.role_name,
      position: slot.position,
      teamId: slot.team_id,
      personId: chosen.id,
      personName: chosen.name,
    };
    if (isDoubleBook) {
      fillEntry.flags = "double_booked";
    }
    report.filled.push(fillEntry);
  }
}

// ---------------------------------------------------------------------------
// Crew-mode fill logic
// ---------------------------------------------------------------------------

function fillCrewSlots(
  db: Database,
  service: Service,
  slots: ServiceSlot[],
  existingAssignments: Map<number, Assignment>,
  crews: Crew[],
  assignedCrew: Crew,
  // ISC-54: cross-team same-service set (shared across all teams for this service)
  assignedInServiceCrossTeam: Set<number>,
  // ISC-53: qualification map for this team
  qualifications: Map<number, Set<string>>,
  report: AutofillReport
): void {
  const crewMembers = listCrewMembers(db, assignedCrew.id);

  if (crewMembers.length === 0) {
    // No members in this crew — flag all slots
    for (const slot of slots) {
      if (existingAssignments.has(slot.id)) continue;
      report.skipped.push({
        slotId: slot.id,
        serviceId: service.id,
        serviceName: service.name,
        serviceDate: service.date,
        roleName: slot.role_name,
        position: slot.position,
        teamId: slot.team_id,
        reason: "no_crew_members",
        crewName: assignedCrew.name,
      });
    }
    return;
  }

  // Assign slots from crew members in id-order (deterministic), cycling if needed
  const sortedMembers = [...crewMembers].sort((a, b) => a.id - b.id);
  let memberIdx = 0;

  for (const slot of slots) {
    if (existingAssignments.has(slot.id)) {
      continue;
    }

    const member = sortedMembers[memberIdx % sortedMembers.length]!;
    memberIdx++;

    // Check individual blockout — leave unfilled if blocked, never substitute
    if (isPersonBlockedOut(db, member.id, service.date)) {
      report.skipped.push({
        slotId: slot.id,
        serviceId: service.id,
        serviceName: service.name,
        serviceDate: service.date,
        roleName: slot.role_name,
        position: slot.position,
        teamId: slot.team_id,
        reason: "crew_member_blocked",
        crewName: assignedCrew.name,
        personId: member.id,
        personName: member.name,
      });
      continue;
    }

    // ISC-53: qualification check — leave unfilled if crew member not qualified
    const qualSet = qualifications.get(member.id);
    if (qualSet !== undefined && !qualSet.has(slot.role_name)) {
      report.skipped.push({
        slotId: slot.id,
        serviceId: service.id,
        serviceName: service.name,
        serviceDate: service.date,
        roleName: slot.role_name,
        position: slot.position,
        teamId: slot.team_id,
        reason: "no_qualified_in_crew",
        crewName: assignedCrew.name,
        personId: member.id,
        personName: member.name,
      });
      continue;
    }

    // ISC-54: crew mode cross-team conflict — leave slot unfilled (consistent with ISC-51)
    if (assignedInServiceCrossTeam.has(member.id)) {
      report.skipped.push({
        slotId: slot.id,
        serviceId: service.id,
        serviceName: service.name,
        serviceDate: service.date,
        roleName: slot.role_name,
        position: slot.position,
        teamId: slot.team_id,
        reason: "crew_member_blocked",
        crewName: assignedCrew.name,
        personId: member.id,
        personName: member.name,
      });
      continue;
    }

    insertAssignment(db, slot.id, member.id);
    assignedInServiceCrossTeam.add(member.id);

    report.filled.push({
      slotId: slot.id,
      serviceId: service.id,
      serviceName: service.name,
      serviceDate: service.date,
      roleName: slot.role_name,
      position: slot.position,
      teamId: slot.team_id,
      personId: member.id,
      personName: member.name,
      crewName: assignedCrew.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run auto-fill on the given services (filtered by options).
 *
 * Contract:
 * - Never overwrites existing assignment rows (any status).
 * - Deterministic: same DB state → same result.
 * - No randomness, no wall-clock dependency.
 */
export function runAutofill(db: Database, options: AutofillOptions = {}): AutofillReport {
  const report: AutofillReport = { filled: [], skipped: [] };

  // Fetch services in date order
  let services = listServices(db);

  if (options.serviceId !== undefined) {
    services = services.filter((s) => s.id === options.serviceId);
  } else {
    if (options.startDate) {
      services = services.filter((s) => s.date >= options.startDate!);
    }
    if (options.endDate) {
      services = services.filter((s) => s.date <= options.endDate!);
    }
  }

  // --- Individual-mode bookkeeping (shared across all services in date order) ---
  // Maps: teamId → Map<personId, lastServedDate|null>
  const teamLastServed = new Map<number, Map<number, string | null>>();

  // --- Crew-mode bookkeeping ---
  // Maps: teamId → last crew id assigned (either from DB history or this run)
  const teamLastCrewId = new Map<number, number | null>();

  // Group slots by team_id within each service and handle per team scheduling mode
  for (const service of services) {
    const allSlots = listServiceSlots(db, service.id);
    if (allSlots.length === 0) continue;

    const existingAssignments = listAssignmentsForService(db, service.id);
    const assignmentBySlot = new Map<number, Assignment>(
      existingAssignments.map((a) => [a.service_slot_id, a])
    );

    // Group slots by team
    const teamIds = [...new Set(allSlots.map((s) => s.team_id))];

    // ISC-54: cross-team same-service set — tracks ALL persons already serving
    // this service (from pre-existing assignments across any team + filled this run).
    // Seeded with all pre-existing assignment persons regardless of team.
    const assignedInServiceCrossTeam = new Set<number>(
      existingAssignments.map((a) => a.person_id)
    );

    // Track which persons are already assigned in this service (manual + auto this run)
    // keyed per-team for individual mode within-team exclusion; reset per service
    const assignedInServiceByTeam = new Map<number, Set<number>>();
    for (const teamId of teamIds) {
      const assignedSet = new Set<number>(
        existingAssignments
          .filter((a) => {
            const slot = allSlots.find((sl) => sl.id === a.service_slot_id);
            return slot?.team_id === teamId;
          })
          .map((a) => a.person_id)
      );
      assignedInServiceByTeam.set(teamId, assignedSet);
    }

    for (const teamId of teamIds) {
      const team = getTeam(db, teamId);
      if (!team) continue;

      const teamSlots = allSlots
        .filter((s) => s.team_id === teamId)
        .sort((a, b) => a.position - b.position || a.id - b.id);

      // ISC-53: load qualification map for this team (batch — one query per team)
      const qualifications = listTeamQualifications(db, teamId);

      if (team.scheduling_mode === "individual") {
        // Lazily initialize last-served map for this team
        if (!teamLastServed.has(teamId)) {
          teamLastServed.set(teamId, lastServedDateByPerson(db, teamId));
        }
        const lastServedMap = teamLastServed.get(teamId)!;
        const assignedSet = assignedInServiceByTeam.get(teamId)!;

        fillIndividualSlots(
          db,
          service,
          teamSlots,
          assignmentBySlot,
          lastServedMap,
          assignedSet,
          assignedInServiceCrossTeam,
          qualifications,
          report
        );
      } else {
        // Crew mode
        const crews = listCrews(db, teamId);
        if (crews.length === 0) {
          for (const slot of teamSlots) {
            if (assignmentBySlot.has(slot.id)) continue;
            report.skipped.push({
              slotId: slot.id,
              serviceId: service.id,
              serviceName: service.name,
              serviceDate: service.date,
              roleName: slot.role_name,
              position: slot.position,
              teamId,
              reason: "no_crew_members",
            });
          }
          continue;
        }

        // Initialize last crew id from DB history if not yet done
        if (!teamLastCrewId.has(teamId)) {
          teamLastCrewId.set(teamId, findLastHistoricalCrewId(db, teamId));
        }

        const lastCrewId = teamLastCrewId.get(teamId) ?? null;
        const assignedCrew = nextCrewForTeam(db, teamId, crews, lastCrewId);

        // Update pointer for subsequent services in this run
        teamLastCrewId.set(teamId, assignedCrew.id);

        fillCrewSlots(
          db,
          service,
          teamSlots,
          assignmentBySlot,
          crews,
          assignedCrew,
          assignedInServiceCrossTeam,
          qualifications,
          report
        );
      }
    }
  }

  return report;
}
