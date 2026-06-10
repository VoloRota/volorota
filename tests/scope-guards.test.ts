/**
 * ScopeGuards test suite — the anti-criteria made permanent.
 * Covers ISC-40 (no ChMS scope creep), ISC-41 (zero-password volunteer
 * journey), ISC-42 (no third-party resource loads, static portion).
 *
 * All probes run through the REAL composed app (src/index.ts) — route
 * absence and journey behavior are properties of the composition, not of
 * any router in isolation (see Changelog 2026-06-10).
 */

import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";

process.env.VOLOROTA_ADMIN_PASSWORD ||= "scope-guard-test-pw";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  createPerson,
  createTeam,
  createTeamRole,
  addTeamMember,
  createOneOffService,
  createAssignment,
} from "../src/db/queries.js";
import { createOrReplaceToken, generateRawToken } from "../src/volunteer/tokens.js";
import { clearCapturedMail } from "../src/mail/mailer.js";

const { default: app } = await import("../src/index.js");

let db: Database;

function createSlot(db: Database, serviceId: number, teamId: number, position = 0): number {
  return (
    db
      .prepare(
        `INSERT INTO service_slots (service_id, team_id, role_name, position)
         VALUES (?, ?, 'Greeter', ?) RETURNING id`
      )
      .get(serviceId, teamId, position) as { id: number }
  ).id;
}

async function adminCookie(): Promise<string> {
  const res = await app.fetch(
    new Request("http://x/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${process.env.VOLOROTA_ADMIN_PASSWORD}`,
    })
  );
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);
  clearCapturedMail();
});

// ---------------------------------------------------------------------------
// ISC-40 — Anti: scope creep. ChMS-feature endpoints must not exist.
// ---------------------------------------------------------------------------

describe("ISC-40: scope-creep endpoints absent", () => {
  const FORBIDDEN_PUBLIC = [
    "/checkin", "/check-in", "/giving", "/donations", "/members",
    "/songs", "/chords", "/attendance", "/groups",
  ];
  const FORBIDDEN_ADMIN = [
    "/admin/checkin", "/admin/giving", "/admin/donations",
    "/admin/members", "/admin/songs", "/admin/chords",
  ];

  test("public scope-creep paths return 404", async () => {
    for (const path of FORBIDDEN_PUBLIC) {
      const res = await app.fetch(new Request(`http://x${path}`));
      expect(`${path}:${res.status}`).toBe(`${path}:404`);
    }
  });

  test("admin scope-creep paths return 404 even with a valid session", async () => {
    const cookie = await adminCookie();
    expect(cookie).toContain("volorota_sess=");
    for (const path of FORBIDDEN_ADMIN) {
      const res = await app.fetch(
        new Request(`http://x${path}`, { headers: { Cookie: cookie, Accept: "text/html" } })
      );
      expect(`${path}:${res.status}`).toBe(`${path}:404`);
    }
  });
});

// ---------------------------------------------------------------------------
// ISC-41 — Anti: friction. The full volunteer journey renders zero password
// inputs and zero account-creation affordances.
// ---------------------------------------------------------------------------

const PASSWORD_INPUT = /type=["']?password/i;
const SIGNUP_AFFORDANCE = /create (an )?account|sign ?up|register/i;

function assertFrictionFree(label: string, html: string) {
  expect(`${label}:${PASSWORD_INPUT.test(html)}`).toBe(`${label}:false`);
  expect(`${label}:${SIGNUP_AFFORDANCE.test(html)}`).toBe(`${label}:false`);
}

describe("ISC-41: zero-password volunteer journey", () => {
  test("home → accept → decline → replacement → expired-token pages are all password-free", async () => {
    // Fixture: two teammates on one team, one service, both assigned
    const alice = createPerson(db, "Alice Guard", "alice.guard@example.com");
    const bob = createPerson(db, "Bob Guard", "bob.guard@example.com");
    const team = createTeam(db, "Greeters", "individual");
    createTeamRole(db, team.id, "Greeter", 2);
    addTeamMember(db, alice.id, team.id);
    addTeamMember(db, bob.id, team.id);
    const svc = createOneOffService(db, "Sunday Service", "2030-01-05", "10:00", []);
    const slotA = createSlot(db, svc.id, team.id, 0);
    const slotB = createSlot(db, svc.id, team.id, 1);
    const a1 = createAssignment(db, slotA, alice.id);
    createAssignment(db, slotB, alice.id); // second assignment to exercise decline
    const tok = await createOrReplaceToken(db, alice.id);

    const pages: Array<[string, Response]> = [];

    pages.push(["home", await app.fetch(new Request(`http://x/v/${tok}`, { headers: { Accept: "text/html" } }))]);

    const accept = await app.fetch(
      new Request(`http://x/v/${tok}/assignments/${a1.id}/accept`, { method: "POST" })
    );
    // follow redirect target if any
    if (accept.status >= 300 && accept.status < 400) {
      const loc = accept.headers.get("location")!;
      pages.push(["post-accept", await app.fetch(new Request(`http://x${loc}`, { headers: { Accept: "text/html" } }))]);
    } else {
      pages.push(["post-accept", accept]);
    }

    // decline the second assignment — response lists eligible teammates inline
    const a2 = db.query("SELECT id FROM assignments WHERE service_slot_id = ?").get(slotB) as { id: number };
    pages.push(["decline", await app.fetch(
      new Request(`http://x/v/${tok}/assignments/${a2.id}/decline`, { method: "POST" })
    )]);

    // expired/unknown token → friendly re-request page
    pages.push(["expired", await app.fetch(
      new Request(`http://x/v/${generateRawToken()}`, { headers: { Accept: "text/html" } })
    )]);

    for (const [label, res] of pages) {
      const html = await res.text();
      expect(html.length).toBeGreaterThan(0);
      assertFrictionFree(label, html);
    }
  });
});

// ---------------------------------------------------------------------------
// ISC-42 — Anti: privacy (static portion). No page or stylesheet references a
// third-party origin in any resource-loading position. The live network-panel
// sweep is performed with a real browser at VERIFY (see ISA evidence).
// ---------------------------------------------------------------------------

const RESOURCE_TAG = /<(script|link|img|iframe|source|video|audio)\b[^>]*>/gi;
const EXTERNAL_URL = /(?:src|href)=["']https?:\/\//i;

function externalResources(html: string): string[] {
  const hits: string[] = [];
  for (const m of html.matchAll(RESOURCE_TAG)) {
    if (EXTERNAL_URL.test(m[0])) hits.push(m[0]);
  }
  return hits;
}

describe("ISC-42: zero third-party resource references (static)", () => {
  test("all admin pages + volunteer page reference only same-origin resources", async () => {
    const person = createPerson(db, "Carol Guard", "carol.guard@example.com");
    const tok = await createOrReplaceToken(db, person.id);
    const cookie = await adminCookie();

    const routes = [
      "/admin", "/admin/login", "/admin/people", "/admin/teams",
      "/admin/templates", "/admin/services", "/admin/matrix",
      "/admin/outbox", "/admin/print", `/v/${tok}`,
    ];
    for (const path of routes) {
      const res = await app.fetch(
        new Request(`http://x${path}`, { headers: { Cookie: cookie, Accept: "text/html" } })
      );
      const html = await res.text();
      const hits = externalResources(html);
      expect(`${path}:${hits.join("|")}`).toBe(`${path}:`);
    }
  });

  test("stylesheet contains no external url() or @import", async () => {
    const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
    expect(/url\(\s*["']?https?:\/\//i.test(css)).toBe(false);
    expect(/@import\s+["'(]/i.test(css)).toBe(false);
  });
});
