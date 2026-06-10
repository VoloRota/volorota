/**
 * Volunteer token management.
 *
 * Security properties:
 *  - Token raw value: 32 random bytes = 256-bit entropy (>= 128-bit minimum)
 *  - Stored at rest: SHA-256 hash only — raw value never persisted
 *  - Lookup: hash the incoming token, query by hash
 *  - Expiry: 90-day default; expired or unknown tokens return the same
 *    "link expired" page — no oracle distinguishing the two cases
 *  - Regenerable: calling createOrReplaceTokenForPerson deletes old row first
 *
 * Table DDL (applied via extendSchemaForVolunteer):
 *   volunteer_tokens (id, person_id, token_hash, expires_at, created_at)
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Token constants
// ---------------------------------------------------------------------------

const TOKEN_BYTE_LENGTH = 32; // 256-bit entropy
const TOKEN_EXPIRY_DAYS = 90;

// ---------------------------------------------------------------------------
// Schema extension
// ---------------------------------------------------------------------------

export function extendSchemaForVolunteer(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS volunteer_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      token_hash  TEXT    NOT NULL UNIQUE,
      expires_at  TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_email    TEXT    NOT NULL,
      subject     TEXT    NOT NULL,
      body_text   TEXT    NOT NULL,
      body_html   TEXT,
      transport   TEXT    NOT NULL DEFAULT 'capture',
      status      TEXT    NOT NULL DEFAULT 'sent',
      sent_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS replacement_requests (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id        INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
      requested_person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      status               TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','accepted','cancelled')),
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reminders_sent (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id  INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      reminder_day   INTEGER NOT NULL,
      sent_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(assignment_id, reminder_day)
    );
  `);

  // Idempotent migration: add leader_person_id to teams if not present
  const teamCols = db.query("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
  if (!teamCols.find((c) => c.name === "leader_person_id")) {
    db.exec("ALTER TABLE teams ADD COLUMN leader_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL");
  }

  // Idempotent migration: add transport + status columns to outbox if not present
  const outboxCols = db.query("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (!outboxCols.find((c) => c.name === "transport")) {
    db.exec("ALTER TABLE outbox ADD COLUMN transport TEXT NOT NULL DEFAULT 'capture'");
  }
  if (!outboxCols.find((c) => c.name === "status")) {
    db.exec("ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'");
  }
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/** Generate a cryptographically random base64url token (32 bytes = 256-bit). */
export function generateRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  // base64url: replace +/ with -_ and strip padding
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 hash of a raw token string; returns hex string. */
export async function hashToken(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compute ISO expiry timestamp 90 days from now. */
function expiryTimestamp(): string {
  const d = new Date();
  d.setDate(d.getDate() + TOKEN_EXPIRY_DAYS);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

export interface VolunteerToken {
  id: number;
  person_id: number;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

/**
 * Create (or replace) a volunteer token for a person.
 * Returns the raw token — this is the ONLY time it is available.
 */
export async function createOrReplaceToken(
  db: Database,
  personId: number
): Promise<string> {
  const raw = generateRawToken();
  const hash = await hashToken(raw);
  const expiresAt = expiryTimestamp();

  // Delete any existing token for this person
  db.prepare("DELETE FROM volunteer_tokens WHERE person_id = ?").run(personId);

  db.prepare(
    `INSERT INTO volunteer_tokens (person_id, token_hash, expires_at)
     VALUES (?, ?, ?)`
  ).run(personId, hash, expiresAt);

  return raw;
}

/**
 * Look up a volunteer token by its raw value.
 * Returns the token row if valid and not expired, null otherwise.
 *
 * NOTE: Callers should treat null (unknown) and expired identically —
 * show the same "link expired" page in both cases to avoid oracles.
 */
export async function lookupToken(
  db: Database,
  rawToken: string
): Promise<VolunteerToken | null> {
  const hash = await hashToken(rawToken);
  const row = db
    .query("SELECT * FROM volunteer_tokens WHERE token_hash = ?")
    .get(hash) as VolunteerToken | null;

  if (!row) return null;

  // Check expiry (stored as SQLite datetime string "YYYY-MM-DD HH:MM:SS")
  const expires = new Date(row.expires_at.replace(" ", "T") + "Z");
  if (Date.now() > expires.getTime()) return null;

  return row;
}

/**
 * Look up a token row by hash only (no expiry check).
 * Used to render the expired-token re-request page without leaking data.
 * Returns null if token hash is completely unknown.
 */
export async function lookupTokenNoExpiry(
  db: Database,
  rawToken: string
): Promise<VolunteerToken | null> {
  const hash = await hashToken(rawToken);
  return db
    .query("SELECT * FROM volunteer_tokens WHERE token_hash = ?")
    .get(hash) as VolunteerToken | null;
}

/**
 * Get the current (possibly expired) token for a person — admin use only.
 * Returns null if no token has been issued.
 */
export function getTokenRowForPerson(
  db: Database,
  personId: number
): VolunteerToken | null {
  return db
    .query("SELECT * FROM volunteer_tokens WHERE person_id = ?")
    .get(personId) as VolunteerToken | null;
}
