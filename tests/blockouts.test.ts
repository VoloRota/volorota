/**
 * Blockouts CRUD test suite.
 *
 * Covers:
 *  - createBlockout / listBlockoutsForPerson / deleteBlockout
 *  - isPersonBlockedOut (single date range check)
 *  - blockedOutPersonIds (batch)
 *  - Edge cases: same-day blockout, adjacent ranges
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createBlockout,
  listBlockoutsForPerson,
  deleteBlockout,
  getBlockout,
  isPersonBlockedOut,
  blockedOutPersonIds,
} from "../src/db/queries.js";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

test("blockout CRUD: create and list", () => {
  const person = createPerson(db, "Alice", "alice@example.com");
  const b = createBlockout(db, person.id, "2026-07-01", "2026-07-07", "Vacation");
  expect(b.id).toBeGreaterThan(0);
  expect(b.person_id).toBe(person.id);
  expect(b.start_date).toBe("2026-07-01");
  expect(b.end_date).toBe("2026-07-07");
  expect(b.reason).toBe("Vacation");

  const list = listBlockoutsForPerson(db, person.id);
  expect(list).toHaveLength(1);
  expect(list[0]!.id).toBe(b.id);
});

test("blockout CRUD: null reason persists", () => {
  const person = createPerson(db, "Bob", "bob@example.com");
  const b = createBlockout(db, person.id, "2026-08-01", "2026-08-01");
  expect(b.reason).toBeNull();
});

test("blockout CRUD: multiple blockouts per person", () => {
  const person = createPerson(db, "Carol", "carol@example.com");
  createBlockout(db, person.id, "2026-06-15", "2026-06-15", "Short day");
  createBlockout(db, person.id, "2026-07-20", "2026-07-27", "Holiday");

  const list = listBlockoutsForPerson(db, person.id);
  expect(list).toHaveLength(2);
});

test("blockout CRUD: delete removes record", () => {
  const person = createPerson(db, "Dave", "dave@example.com");
  const b = createBlockout(db, person.id, "2026-09-01", "2026-09-05");
  expect(getBlockout(db, b.id)).not.toBeNull();

  deleteBlockout(db, b.id);
  expect(getBlockout(db, b.id)).toBeNull();

  const list = listBlockoutsForPerson(db, person.id);
  expect(list).toHaveLength(0);
});

test("blockout CRUD: blockouts are per-person (no cross-contamination)", () => {
  const alice = createPerson(db, "Alice", "a@example.com");
  const bob = createPerson(db, "Bob", "b@example.com");

  createBlockout(db, alice.id, "2026-06-01", "2026-06-10");

  expect(listBlockoutsForPerson(db, alice.id)).toHaveLength(1);
  expect(listBlockoutsForPerson(db, bob.id)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// isPersonBlockedOut
// ---------------------------------------------------------------------------

test("isPersonBlockedOut: date inside range → true", () => {
  const person = createPerson(db, "Eve", "eve@example.com");
  createBlockout(db, person.id, "2026-07-01", "2026-07-31");

  expect(isPersonBlockedOut(db, person.id, "2026-07-15")).toBe(true);
  expect(isPersonBlockedOut(db, person.id, "2026-07-01")).toBe(true); // start inclusive
  expect(isPersonBlockedOut(db, person.id, "2026-07-31")).toBe(true); // end inclusive
});

test("isPersonBlockedOut: date outside range → false", () => {
  const person = createPerson(db, "Frank", "frank@example.com");
  createBlockout(db, person.id, "2026-07-01", "2026-07-31");

  expect(isPersonBlockedOut(db, person.id, "2026-06-30")).toBe(false);
  expect(isPersonBlockedOut(db, person.id, "2026-08-01")).toBe(false);
});

test("isPersonBlockedOut: single-day blockout covers exact date only", () => {
  const person = createPerson(db, "Grace", "grace@example.com");
  createBlockout(db, person.id, "2026-06-14", "2026-06-14"); // single day

  expect(isPersonBlockedOut(db, person.id, "2026-06-14")).toBe(true);
  expect(isPersonBlockedOut(db, person.id, "2026-06-13")).toBe(false);
  expect(isPersonBlockedOut(db, person.id, "2026-06-15")).toBe(false);
});

test("isPersonBlockedOut: no blockouts → always false", () => {
  const person = createPerson(db, "Henry", "henry@example.com");
  expect(isPersonBlockedOut(db, person.id, "2026-06-14")).toBe(false);
});

// ---------------------------------------------------------------------------
// blockedOutPersonIds (batch)
// ---------------------------------------------------------------------------

test("blockedOutPersonIds: returns correct subset", () => {
  const alice = createPerson(db, "Alice", "alice@b.com");
  const bob = createPerson(db, "Bob", "bob@b.com");
  const carol = createPerson(db, "Carol", "carol@b.com");

  createBlockout(db, alice.id, "2026-08-01", "2026-08-10");
  // Bob has no blockout
  createBlockout(db, carol.id, "2026-07-30", "2026-08-05");

  const blocked = blockedOutPersonIds(db, [alice.id, bob.id, carol.id], "2026-08-03");
  expect(blocked.has(alice.id)).toBe(true);
  expect(blocked.has(bob.id)).toBe(false);
  expect(blocked.has(carol.id)).toBe(true);
});

test("blockedOutPersonIds: empty person list → empty set", () => {
  const blocked = blockedOutPersonIds(db, [], "2026-08-01");
  expect(blocked.size).toBe(0);
});
