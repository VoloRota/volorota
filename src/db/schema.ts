import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const dbPath = process.env.VOLOROTA_DB ?? join(process.cwd(), "data", "volorota.db");

  // Ensure the parent directory exists
  const lastSlash = dbPath.lastIndexOf("/");
  if (lastSlash > 0) {
    mkdirSync(dbPath.substring(0, lastSlash), { recursive: true });
  }

  _db = new Database(dbPath, { create: true });
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA foreign_keys = ON;");

  applySchema(_db);
  return _db;
}

/** Override the global singleton — used by tests. */
export function setDb(db: Database): void {
  _db = db;
}

export function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      email       TEXT    NOT NULL UNIQUE,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      scheduling_mode   TEXT NOT NULL CHECK(scheduling_mode IN ('individual','crew'))
    );

    CREATE TABLE IF NOT EXISTS team_roles (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id               INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name                  TEXT    NOT NULL,
      headcount_per_service INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS team_members (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      team_id   INTEGER NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
      PRIMARY KEY (person_id, team_id)
    );

    CREATE TABLE IF NOT EXISTS crews (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name             TEXT    NOT NULL,
      rotation_order   INTEGER NOT NULL DEFAULT 0
    );

    -- crew_members: one crew per person per team enforced in application layer
    -- (see addCrewMember in queries.ts). UNIQUE on (crew_id, person_id) prevents
    -- duplicate row within same crew.
    CREATE TABLE IF NOT EXISTS crew_members (
      crew_id   INTEGER NOT NULL REFERENCES crews(id)  ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      PRIMARY KEY (crew_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS service_templates (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT    NOT NULL,
      weekday  INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
      time     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_template_roles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id   INTEGER NOT NULL REFERENCES service_templates(id) ON DELETE CASCADE,
      team_id       INTEGER NOT NULL REFERENCES teams(id),
      role_name     TEXT    NOT NULL,
      headcount     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS services (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id  INTEGER REFERENCES service_templates(id),
      date         TEXT    NOT NULL,
      time         TEXT    NOT NULL,
      name         TEXT    NOT NULL
    );

    -- Snapshot of role requirements, decoupled from template at creation time.
    -- Later template edits never touch these rows (satisfies ISC-15).
    CREATE TABLE IF NOT EXISTS service_slots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      team_id    INTEGER NOT NULL REFERENCES teams(id),
      role_name  TEXT    NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      service_slot_id INTEGER NOT NULL REFERENCES service_slots(id) ON DELETE CASCADE,
      person_id       INTEGER NOT NULL REFERENCES people(id),
      status          TEXT    NOT NULL DEFAULT 'pending'
                               CHECK(status IN ('pending','confirmed','declined')),
      UNIQUE(service_slot_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS blockouts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      start_date TEXT    NOT NULL,
      end_date   TEXT    NOT NULL,
      reason     TEXT,
      CHECK(end_date >= start_date)
    );
  `);
}
