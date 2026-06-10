import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface Person {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export function listPeople(db: Database): Person[] {
  return db.query("SELECT * FROM people ORDER BY name").all() as Person[];
}

export function createPerson(db: Database, name: string, email: string): Person {
  const stmt = db.prepare(
    "INSERT INTO people (name, email) VALUES (?, ?) RETURNING *"
  );
  return stmt.get(name, email.toLowerCase().trim()) as Person;
}

export function getPersonByEmail(db: Database, email: string): Person | null {
  return db
    .query("SELECT * FROM people WHERE email = ?")
    .get(email.toLowerCase().trim()) as Person | null;
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export interface ImportResult {
  imported: Person[];
  errors: Array<{ row: number; line: string; reason: string }>;
}

export function importPeopleFromCsv(db: Database, csvText: string): ImportResult {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const result: ImportResult = { imported: [], errors: [] };

  if (lines.length === 0) return result;

  // Find and skip header row
  let dataStart = 0;
  const first = lines[0]?.trim().toLowerCase() ?? "";
  if (first === "name,email" || first.startsWith("name,")) {
    dataStart = 1;
  }

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;

    const parts = line.split(",");
    const rowNum = i + 1;

    if (parts.length < 2) {
      result.errors.push({ row: rowNum, line, reason: "missing email column" });
      continue;
    }

    const name = (parts[0] ?? "").trim();
    const email = (parts[1] ?? "").trim().toLowerCase();

    if (!name) {
      result.errors.push({ row: rowNum, line, reason: "name is empty" });
      continue;
    }

    if (!email || !email.includes("@") || !email.includes(".")) {
      result.errors.push({ row: rowNum, line, reason: "invalid email" });
      continue;
    }

    // Check duplicate in DB
    const existing = getPersonByEmail(db, email);
    if (existing) {
      result.errors.push({ row: rowNum, line, reason: `email already exists: ${email}` });
      continue;
    }

    try {
      const person = createPerson(db, name, email);
      result.imported.push(person);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ row: rowNum, line, reason: msg });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Teams & Roles
// ---------------------------------------------------------------------------

export interface Team {
  id: number;
  name: string;
  scheduling_mode: "individual" | "crew";
}

export interface TeamRole {
  id: number;
  team_id: number;
  name: string;
  headcount_per_service: number;
}

export function listTeams(db: Database): Team[] {
  return db.query("SELECT * FROM teams ORDER BY name").all() as Team[];
}

export function getTeam(db: Database, id: number): Team | null {
  return db.query("SELECT * FROM teams WHERE id = ?").get(id) as Team | null;
}

export function createTeam(
  db: Database,
  name: string,
  scheduling_mode: "individual" | "crew"
): Team {
  return db
    .prepare("INSERT INTO teams (name, scheduling_mode) VALUES (?, ?) RETURNING *")
    .get(name, scheduling_mode) as Team;
}

export function listTeamRoles(db: Database, teamId: number): TeamRole[] {
  return db
    .query("SELECT * FROM team_roles WHERE team_id = ? ORDER BY id")
    .all(teamId) as TeamRole[];
}

export function createTeamRole(
  db: Database,
  teamId: number,
  name: string,
  headcount: number
): TeamRole {
  return db
    .prepare(
      "INSERT INTO team_roles (team_id, name, headcount_per_service) VALUES (?, ?, ?) RETURNING *"
    )
    .get(teamId, name, headcount) as TeamRole;
}

export function deleteTeamRole(db: Database, roleId: number): void {
  db.prepare("DELETE FROM team_roles WHERE id = ?").run(roleId);
}

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

export function addTeamMember(db: Database, personId: number, teamId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO team_members (person_id, team_id) VALUES (?, ?)"
  ).run(personId, teamId);
}

export function removeTeamMember(db: Database, personId: number, teamId: number): void {
  db.prepare(
    "DELETE FROM team_members WHERE person_id = ? AND team_id = ?"
  ).run(personId, teamId);
}

export function listTeamMembers(db: Database, teamId: number): Person[] {
  return db
    .query(
      `SELECT p.* FROM people p
       JOIN team_members tm ON tm.person_id = p.id
       WHERE tm.team_id = ?
       ORDER BY p.name`
    )
    .all(teamId) as Person[];
}

export function listPersonTeams(db: Database, personId: number): Team[] {
  return db
    .query(
      `SELECT t.* FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.person_id = ?`
    )
    .all(personId) as Team[];
}

// ---------------------------------------------------------------------------
// Crews
// ---------------------------------------------------------------------------

export interface Crew {
  id: number;
  team_id: number;
  name: string;
  rotation_order: number;
}

export function listCrews(db: Database, teamId: number): Crew[] {
  return db
    .query("SELECT * FROM crews WHERE team_id = ? ORDER BY rotation_order, id")
    .all(teamId) as Crew[];
}

export function getCrew(db: Database, id: number): Crew | null {
  return db.query("SELECT * FROM crews WHERE id = ?").get(id) as Crew | null;
}

export function createCrew(db: Database, teamId: number, name: string): Crew {
  return db
    .prepare(
      "INSERT INTO crews (team_id, name, rotation_order) VALUES (?, ?, 0) RETURNING *"
    )
    .get(teamId, name) as Crew;
}

export function listCrewMembers(db: Database, crewId: number): Person[] {
  return db
    .query(
      `SELECT p.* FROM people p
       JOIN crew_members cm ON cm.person_id = p.id
       WHERE cm.crew_id = ?
       ORDER BY p.name`
    )
    .all(crewId) as Person[];
}

/**
 * Add a person to a crew.
 * Enforces: a person can belong to at most one crew per team.
 * Throws a descriptive error if the constraint is violated.
 */
export function addCrewMember(db: Database, crewId: number, personId: number): void {
  const crew = getCrew(db, crewId);
  if (!crew) throw new Error(`Crew ${crewId} not found`);

  // Check if person is already in a crew in this team
  const existing = db
    .query(
      `SELECT cm.crew_id, c.name AS crew_name
       FROM crew_members cm
       JOIN crews c ON c.id = cm.crew_id
       WHERE cm.person_id = ? AND c.team_id = ?`
    )
    .get(personId, crew.team_id) as { crew_id: number; crew_name: string } | null;

  if (existing) {
    throw new Error(
      `Person ${personId} is already a member of crew "${existing.crew_name}" in this team. ` +
        `A person can only belong to one crew per team.`
    );
  }

  db.prepare("INSERT INTO crew_members (crew_id, person_id) VALUES (?, ?)").run(
    crewId,
    personId
  );
}

export function removeCrewMember(db: Database, crewId: number, personId: number): void {
  db.prepare(
    "DELETE FROM crew_members WHERE crew_id = ? AND person_id = ?"
  ).run(crewId, personId);
}

/** Return which crew (if any) a person belongs to within a given team. */
export function getPersonCrewInTeam(
  db: Database,
  personId: number,
  teamId: number
): Crew | null {
  return db
    .query(
      `SELECT c.* FROM crews c
       JOIN crew_members cm ON cm.crew_id = c.id
       WHERE cm.person_id = ? AND c.team_id = ?`
    )
    .get(personId, teamId) as Crew | null;
}

// ---------------------------------------------------------------------------
// Service templates
// ---------------------------------------------------------------------------

export interface ServiceTemplate {
  id: number;
  name: string;
  weekday: number;
  time: string;
}

export interface ServiceTemplateRole {
  id: number;
  template_id: number;
  team_id: number;
  role_name: string;
  headcount: number;
}

export function listTemplates(db: Database): ServiceTemplate[] {
  return db
    .query("SELECT * FROM service_templates ORDER BY weekday, time")
    .all() as ServiceTemplate[];
}

export function getTemplate(db: Database, id: number): ServiceTemplate | null {
  return db
    .query("SELECT * FROM service_templates WHERE id = ?")
    .get(id) as ServiceTemplate | null;
}

export function createTemplate(
  db: Database,
  name: string,
  weekday: number,
  time: string
): ServiceTemplate {
  return db
    .prepare(
      "INSERT INTO service_templates (name, weekday, time) VALUES (?, ?, ?) RETURNING *"
    )
    .get(name, weekday, time) as ServiceTemplate;
}

export function updateTemplate(
  db: Database,
  id: number,
  name: string,
  weekday: number,
  time: string
): void {
  db.prepare(
    "UPDATE service_templates SET name = ?, weekday = ?, time = ? WHERE id = ?"
  ).run(name, weekday, time, id);
}

export function addTemplateRole(
  db: Database,
  templateId: number,
  teamId: number,
  roleName: string,
  headcount: number
): ServiceTemplateRole {
  return db
    .prepare(
      `INSERT INTO service_template_roles (template_id, team_id, role_name, headcount)
       VALUES (?, ?, ?, ?) RETURNING *`
    )
    .get(templateId, teamId, roleName, headcount) as ServiceTemplateRole;
}

export function listTemplateRoles(
  db: Database,
  templateId: number
): ServiceTemplateRole[] {
  return db
    .query("SELECT * FROM service_template_roles WHERE template_id = ? ORDER BY id")
    .all(templateId) as ServiceTemplateRole[];
}

export function deleteTemplateRole(db: Database, roleId: number): void {
  db.prepare("DELETE FROM service_template_roles WHERE id = ?").run(roleId);
}

// ---------------------------------------------------------------------------
// Services (instances)
// ---------------------------------------------------------------------------

export interface Service {
  id: number;
  template_id: number | null;
  date: string;
  time: string;
  name: string;
}

export interface ServiceSlot {
  id: number;
  service_id: number;
  team_id: number;
  role_name: string;
  position: number;
}

export function listServices(db: Database): Service[] {
  return db
    .query("SELECT * FROM services ORDER BY date, time")
    .all() as Service[];
}

export function getService(db: Database, id: number): Service | null {
  return db.query("SELECT * FROM services WHERE id = ?").get(id) as Service | null;
}

export function listServiceSlots(db: Database, serviceId: number): ServiceSlot[] {
  return db
    .query("SELECT * FROM service_slots WHERE service_id = ? ORDER BY position, id")
    .all(serviceId) as ServiceSlot[];
}

/**
 * Generate service instances from a template over a date range [startDate, endDate].
 * Dates are ISO strings "YYYY-MM-DD".
 * Returns the list of created service rows.
 */
export function generateServicesFromTemplate(
  db: Database,
  templateId: number,
  startDate: string,
  endDate: string
): Service[] {
  const template = getTemplate(db, templateId);
  if (!template) throw new Error(`Template ${templateId} not found`);

  const roles = listTemplateRoles(db, templateId);

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  const created: Service[] = [];
  const cursor = new Date(start);

  // Advance to first matching weekday
  while (cursor.getUTCDay() !== template.weekday) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);

    // Build slot list from snapshot of template roles
    const slots: Array<{ teamId: number; roleName: string; position: number }> = [];
    let pos = 0;
    for (const role of roles) {
      for (let h = 0; h < role.headcount; h++) {
        slots.push({ teamId: role.team_id, roleName: role.role_name, position: pos++ });
      }
    }

    const svc = db
      .prepare(
        "INSERT INTO services (template_id, date, time, name) VALUES (?, ?, ?, ?) RETURNING *"
      )
      .get(templateId, dateStr, template.time, template.name) as Service;

    for (const slot of slots) {
      db.prepare(
        "INSERT INTO service_slots (service_id, team_id, role_name, position) VALUES (?, ?, ?, ?)"
      ).run(svc.id, slot.teamId, slot.roleName, slot.position);
    }

    created.push(svc);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return created;
}

/**
 * Create a one-off (non-recurring) service. Slots are copied from provided role specs.
 */
export function createOneOffService(
  db: Database,
  name: string,
  date: string,
  time: string,
  slots: Array<{ teamId: number; roleName: string; position: number }>
): Service {
  const svc = db
    .prepare(
      "INSERT INTO services (template_id, date, time, name) VALUES (NULL, ?, ?, ?) RETURNING *"
    )
    .get(date, time, name) as Service;

  for (const slot of slots) {
    db.prepare(
      "INSERT INTO service_slots (service_id, team_id, role_name, position) VALUES (?, ?, ?, ?)"
    ).run(svc.id, slot.teamId, slot.roleName, slot.position);
  }

  return svc;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export interface Assignment {
  id: number;
  service_slot_id: number;
  person_id: number;
  status: "pending" | "confirmed" | "declined";
}

export function createAssignment(
  db: Database,
  serviceSlotId: number,
  personId: number
): Assignment {
  return db
    .prepare(
      `INSERT INTO assignments (service_slot_id, person_id, status)
       VALUES (?, ?, 'pending')
       ON CONFLICT(service_slot_id, person_id) DO UPDATE SET status = 'pending'
       RETURNING *`
    )
    .get(serviceSlotId, personId) as Assignment;
}

export function getAssignment(db: Database, id: number): Assignment | null {
  return db
    .query("SELECT * FROM assignments WHERE id = ?")
    .get(id) as Assignment | null;
}

export function listAssignmentsForService(
  db: Database,
  serviceId: number
): Assignment[] {
  return db
    .query(
      `SELECT a.* FROM assignments a
       JOIN service_slots ss ON ss.id = a.service_slot_id
       WHERE ss.service_id = ?`
    )
    .all(serviceId) as Assignment[];
}

export function updateAssignmentStatus(
  db: Database,
  id: number,
  status: "pending" | "confirmed" | "declined"
): void {
  db.prepare("UPDATE assignments SET status = ? WHERE id = ?").run(status, id);
}

// ---------------------------------------------------------------------------
// Blockouts
// ---------------------------------------------------------------------------

export interface Blockout {
  id: number;
  person_id: number;
  start_date: string;
  end_date: string;
  reason: string | null;
}

export function listBlockoutsForPerson(db: Database, personId: number): Blockout[] {
  return db
    .query(
      "SELECT * FROM blockouts WHERE person_id = ? ORDER BY start_date, end_date"
    )
    .all(personId) as Blockout[];
}

export function createBlockout(
  db: Database,
  personId: number,
  startDate: string,
  endDate: string,
  reason?: string | null
): Blockout {
  return db
    .prepare(
      `INSERT INTO blockouts (person_id, start_date, end_date, reason)
       VALUES (?, ?, ?, ?) RETURNING *`
    )
    .get(personId, startDate, endDate, reason ?? null) as Blockout;
}

export function getBlockout(db: Database, id: number): Blockout | null {
  return db
    .query("SELECT * FROM blockouts WHERE id = ?")
    .get(id) as Blockout | null;
}

export function deleteBlockout(db: Database, id: number): void {
  db.prepare("DELETE FROM blockouts WHERE id = ?").run(id);
}

/**
 * Returns true if the given person has a blockout covering the given date
 * (date is YYYY-MM-DD string; blockout range is inclusive on both ends).
 */
export function isPersonBlockedOut(
  db: Database,
  personId: number,
  date: string
): boolean {
  const row = db
    .query(
      `SELECT id FROM blockouts
       WHERE person_id = ? AND start_date <= ? AND end_date >= ?
       LIMIT 1`
    )
    .get(personId, date, date);
  return row !== null;
}

/**
 * Returns the set of person IDs (from a given list) who are blocked out on a date.
 */
export function blockedOutPersonIds(
  db: Database,
  personIds: number[],
  date: string
): Set<number> {
  if (personIds.length === 0) return new Set();
  const placeholders = personIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT DISTINCT person_id FROM blockouts
       WHERE person_id IN (${placeholders}) AND start_date <= ? AND end_date >= ?`
    )
    .all(...personIds, date, date) as Array<{ person_id: number }>;
  return new Set(rows.map((r) => r.person_id));
}

// ---------------------------------------------------------------------------
// Matrix view queries
// ---------------------------------------------------------------------------

export interface MatrixService {
  id: number;
  date: string;
  time: string;
  name: string;
}

export interface MatrixRow {
  slotKey: string;       // "teamId:roleName:position" — stable row identity
  teamId: number;
  teamName: string;
  roleName: string;
  position: number;      // 0-based within (team, role)
  label: string;         // e.g. "Worship — Vocals 2"
}

export interface MatrixCell {
  slotKey: string;
  serviceId: number;
  slotId: number | null;  // null = no slot exists for this service × row combo
  personId: number | null;
  personName: string | null;
  status: "confirmed" | "pending" | "declined" | "unfilled" | "none";
  // "none" means the service doesn't have this slot at all (sparse matrix)
  blockedOut: boolean;
}

export interface MatrixData {
  services: MatrixService[];
  rows: MatrixRow[];
  cells: Map<string, MatrixCell>;  // key = `${slotKey}::${serviceId}`
}

/**
 * Fetch all data needed to render the matrix view for a window of services.
 * Services are ordered by date asc; rows grouped by team → role → position.
 * Single-pass data collection: 4 queries, no per-cell lookups.
 *
 * @param fromDate   YYYY-MM-DD — window start (inclusive)
 * @param limit      max number of services to include (default 8)
 */
export function getMatrixData(
  db: Database,
  fromDate: string,
  limit = 8
): MatrixData {
  // 1. Fetch the service window
  const services = db
    .query(
      `SELECT id, date, time, name FROM services
       WHERE date >= ? ORDER BY date, time LIMIT ?`
    )
    .all(fromDate, limit) as MatrixService[];

  if (services.length === 0) {
    return { services: [], rows: [], cells: new Map() };
  }

  const serviceIds = services.map((s) => s.id);
  const placeholders = serviceIds.map(() => "?").join(",");

  // 2. Fetch all slots for these services, with team names
  const slotRows = db
    .query(
      `SELECT ss.id AS slot_id, ss.service_id, ss.team_id, ss.role_name, ss.position,
              t.name AS team_name
       FROM service_slots ss
       JOIN teams t ON t.id = ss.team_id
       WHERE ss.service_id IN (${placeholders})
       ORDER BY t.name, ss.role_name, ss.position`
    )
    .all(...serviceIds) as Array<{
      slot_id: number;
      service_id: number;
      team_id: number;
      role_name: string;
      position: number;
      team_name: string;
    }>;

  // 3. Fetch all assignments for these slots
  const slotIds = slotRows.map((r) => r.slot_id);
  let assignmentMap = new Map<number, { person_id: number; person_name: string; status: string }>();

  if (slotIds.length > 0) {
    const assignPlaceholders = slotIds.map(() => "?").join(",");
    const assignRows = db
      .query(
        `SELECT a.service_slot_id, a.person_id, a.status, p.name AS person_name
         FROM assignments a
         JOIN people p ON p.id = a.person_id
         WHERE a.service_slot_id IN (${assignPlaceholders})`
      )
      .all(...slotIds) as Array<{
        service_slot_id: number;
        person_id: number;
        status: string;
        person_name: string;
      }>;
    for (const a of assignRows) {
      assignmentMap.set(a.service_slot_id, {
        person_id: a.person_id,
        person_name: a.person_name,
        status: a.status,
      });
    }
  }

  // 4. Fetch blockouts for all assigned persons across the service dates
  const assignedPersonIds = [...new Set([...assignmentMap.values()].map((a) => a.person_id))];
  const minDate = services[0]!.date;
  const maxDate = services[services.length - 1]!.date;
  const blockedOutSet = new Set<string>(); // "personId::date"

  if (assignedPersonIds.length > 0) {
    const bPlaceholders = assignedPersonIds.map(() => "?").join(",");
    const blockoutRows = db
      .query(
        `SELECT person_id, start_date, end_date FROM blockouts
         WHERE person_id IN (${bPlaceholders})
           AND start_date <= ? AND end_date >= ?`
      )
      .all(...assignedPersonIds, maxDate, minDate) as Array<{
        person_id: number;
        start_date: string;
        end_date: string;
      }>;

    // For each blockout range, mark each service date that falls within it
    for (const bo of blockoutRows) {
      for (const svc of services) {
        if (svc.date >= bo.start_date && svc.date <= bo.end_date) {
          blockedOutSet.add(`${bo.person_id}::${svc.date}`);
        }
      }
    }
  }

  // Build the ordered set of unique row keys (team → role → position)
  const rowMap = new Map<string, MatrixRow>();
  for (const sr of slotRows) {
    const key = `${sr.team_id}:${sr.role_name}:${sr.position}`;
    if (!rowMap.has(key)) {
      const posLabel = sr.position + 1; // 1-based for display
      rowMap.set(key, {
        slotKey: key,
        teamId: sr.team_id,
        teamName: sr.team_name,
        roleName: sr.role_name,
        position: sr.position,
        label: `${sr.team_name} — ${sr.role_name} ${posLabel}`,
      });
    }
  }
  const rows = [...rowMap.values()];

  // Build the cell map
  const cells = new Map<string, MatrixCell>();

  // Initialize all cells as "none" (slot doesn't exist for this service)
  for (const row of rows) {
    for (const svc of services) {
      const cellKey = `${row.slotKey}::${svc.id}`;
      cells.set(cellKey, {
        slotKey: row.slotKey,
        serviceId: svc.id,
        slotId: null,
        personId: null,
        personName: null,
        status: "none",
        blockedOut: false,
      });
    }
  }

  // Fill in actual slot + assignment data
  for (const sr of slotRows) {
    const slotKey = `${sr.team_id}:${sr.role_name}:${sr.position}`;
    const cellKey = `${slotKey}::${sr.service_id}`;
    const assignment = assignmentMap.get(sr.slot_id) ?? null;
    const svc = services.find((s) => s.id === sr.service_id)!;

    const blockedOut = assignment
      ? blockedOutSet.has(`${assignment.person_id}::${svc.date}`)
      : false;

    cells.set(cellKey, {
      slotKey,
      serviceId: sr.service_id,
      slotId: sr.slot_id,
      personId: assignment?.person_id ?? null,
      personName: assignment?.person_name ?? null,
      status: assignment
        ? (assignment.status as "confirmed" | "pending" | "declined")
        : "unfilled",
      blockedOut,
    });
  }

  return { services, rows, cells };
}

/**
 * Return person id → most recent non-declined assignment date within a team,
 * or null for members who have never been assigned (or only declined).
 * Used by the autofill engine to compute least-recently-served ordering.
 */
export function lastServedDateByPerson(
  db: Database,
  teamId: number
): Map<number, string | null> {
  const rows = db
    .query(
      `SELECT tm.person_id,
              MAX(CASE WHEN a.status != 'declined' THEN s.date ELSE NULL END) AS last_served
       FROM team_members tm
       LEFT JOIN assignments a ON a.person_id = tm.person_id
       LEFT JOIN service_slots ss ON ss.id = a.service_slot_id AND ss.team_id = tm.team_id
       LEFT JOIN services s ON s.id = ss.service_id
       WHERE tm.team_id = ?
       GROUP BY tm.person_id`
    )
    .all(teamId) as Array<{ person_id: number; last_served: string | null }>;

  return new Map(rows.map((r) => [r.person_id, r.last_served]));
}

// ---------------------------------------------------------------------------
// Service Notes (ISC-45, ISC-46)
// ---------------------------------------------------------------------------

export interface ServiceNote {
  id: number;
  service_id: number;
  team_id: number | null;
  body: string;
  created_at: string;
}

/** Create a note attached to a service, optionally scoped to a team. */
export function createServiceNote(
  db: Database,
  serviceId: number,
  teamId: number | null,
  body: string
): ServiceNote {
  return db
    .prepare(
      `INSERT INTO service_notes (service_id, team_id, body)
       VALUES (?, ?, ?) RETURNING *`
    )
    .get(serviceId, teamId ?? null, body) as ServiceNote;
}

/** List all notes for a service (admin view — all teams). */
export function listServiceNotes(
  db: Database,
  serviceId: number
): ServiceNote[] {
  return db
    .query(
      "SELECT * FROM service_notes WHERE service_id = ? ORDER BY created_at"
    )
    .all(serviceId) as ServiceNote[];
}

/**
 * List notes relevant to a volunteer's assignment on a service.
 * Returns service-wide notes (team_id IS NULL) plus notes scoped to the given team.
 */
export function listRelevantNotesForVolunteer(
  db: Database,
  serviceId: number,
  teamId: number
): ServiceNote[] {
  return db
    .query(
      `SELECT * FROM service_notes
       WHERE service_id = ? AND (team_id IS NULL OR team_id = ?)
       ORDER BY created_at`
    )
    .all(serviceId, teamId) as ServiceNote[];
}

/** Delete a single note by id. */
export function deleteServiceNote(db: Database, noteId: number): void {
  db.prepare("DELETE FROM service_notes WHERE id = ?").run(noteId);
}

