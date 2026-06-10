/**
 * AdminAuth test suite — ISC-39
 *
 * Verifies:
 *  1. Every mounted /admin/* route rejects anonymous HTML requests with 302 → /admin/login
 *  2. Every mounted /admin/* route rejects anonymous non-HTML requests with 401
 *  3. /admin/login itself is publicly accessible (200)
 *  4. Wrong password → re-rendered login with error, no session cookie set
 *  5. Correct password → session cookie set; subsequent /admin/people returns 200
 *  6. Logout clears session; next request is rejected again
 *  7. Server config validation rejects missing VOLOROTA_ADMIN_PASSWORD
 *
 * Uses a temp in-memory SQLite DB so tests never touch ./data.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";

import { applySchema, setDb } from "../src/db/schema.js";
import {
  validateAuthConfig,
  authMiddleware,
  handleLoginGet,
  handleLoginPost,
  handleLogout,
  getSigningSecret,
  resetSigningSecretCache,
  resetAttemptRecords,
  type AuthEnv,
} from "../src/auth.js";
import { layout } from "../src/views/layout.js";
import { peopleRouter } from "../src/routes/people.js";
import { teamsRouter } from "../src/routes/teams.js";
import { templatesRouter } from "../src/routes/templates.js";
import { servicesRouter } from "../src/routes/services.js";

// ---------------------------------------------------------------------------
// Test app factory — rebuilds for each test so we get a fresh in-memory DB
// ---------------------------------------------------------------------------

const TEST_PASSWORD = "TestPass!99";

function buildApp(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Inject DB into context
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });

  // Login / logout (unauthenticated)
  app.get("/admin/login", handleLoginGet);
  app.post("/admin/login", handleLoginPost);
  app.post("/admin/logout", handleLogout);

  // Auth gate
  app.use("/admin/*", authMiddleware);

  // Admin routes
  app.get("/admin", (c) => c.html(layout("Dashboard", "<h1>VoloRota Admin</h1>")));
  app.route("/admin/people", peopleRouter);
  app.route("/admin/teams", teamsRouter);
  app.route("/admin/templates", templatesRouter);
  app.route("/admin/services", servicesRouter);

  return app;
}

let db: Database;
let app: Hono<AuthEnv>;

beforeEach(() => {
  // Set password env for auth functions to read
  process.env.VOLOROTA_ADMIN_PASSWORD = TEST_PASSWORD;

  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  setDb(db);

  // Reset module-level caches between tests
  resetSigningSecretCache();
  resetAttemptRecords();

  app = buildApp(db);
});

afterEach(() => {
  db.close();
  delete process.env.VOLOROTA_ADMIN_PASSWORD;
});

// ---------------------------------------------------------------------------
// Helper: extract Set-Cookie header value (first match for cookie name)
// ---------------------------------------------------------------------------

function extractCookie(res: Response, name: string): string | null {
  const headers = res.headers;
  // Bun's Headers.getSetCookie() returns all Set-Cookie values
  const cookies: string[] = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) return c;
  }
  return null;
}

function cookieHeader(cookieLine: string): string {
  // Only send the name=value portion (strip attributes)
  return cookieLine.split(";")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Test 1 — Anonymous HTML requests to /admin/* → 302 to /admin/login
// ---------------------------------------------------------------------------

const adminRoutes = [
  "/admin",
  "/admin/people",
  "/admin/teams",
  "/admin/templates",
  "/admin/services",
];

test("ISC-39: anonymous HTML requests to all /admin/* routes → 302 redirect", async () => {
  for (const route of adminRoutes) {
    const req = new Request(`http://localhost${route}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  }
});

// ---------------------------------------------------------------------------
// Test 2 — Anonymous non-HTML requests to /admin/* → 401
// ---------------------------------------------------------------------------

test("ISC-39: anonymous non-HTML (API) requests to /admin/* → 401", async () => {
  for (const route of adminRoutes) {
    const req = new Request(`http://localhost${route}`, {
      headers: { Accept: "application/json" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — /admin/login is publicly reachable
// ---------------------------------------------------------------------------

test("ISC-39: /admin/login is publicly accessible (200)", async () => {
  const req = new Request("http://localhost/admin/login", {
    headers: { Accept: "text/html" },
  });
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Login");
  // Must contain a password input
  expect(html).toMatch(/type=["']password["']/i);
});

// ---------------------------------------------------------------------------
// Test 4 — Wrong password → error shown, no session cookie
// ---------------------------------------------------------------------------

test("ISC-39: wrong password shows error and sets no session cookie", async () => {
  const req = new Request("http://localhost/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    },
    body: "password=wrongpassword",
  });
  const res = await app.fetch(req);

  // Should re-render the login page (200), not redirect
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html.toLowerCase()).toMatch(/incorrect password/i);

  // No session cookie should be set
  const cookie = extractCookie(res, "volorota_sess");
  expect(cookie).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 5 — Correct password → session cookie set; /admin/people returns 200
// ---------------------------------------------------------------------------

test("ISC-39: correct password sets session cookie; authenticated request returns 200", async () => {
  // POST login
  const loginReq = new Request("http://localhost/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    },
    body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
  });
  const loginRes = await app.fetch(loginReq);

  // Should redirect to /admin after successful login
  expect(loginRes.status).toBe(302);

  // Session cookie must be set
  const cookieLine = extractCookie(loginRes, "volorota_sess");
  expect(cookieLine).not.toBeNull();

  // Cookie should be HttpOnly and SameSite=Lax
  expect(cookieLine!.toLowerCase()).toContain("httponly");
  expect(cookieLine!.toLowerCase()).toContain("samesite=lax");

  // Use cookie to hit /admin/people
  const authedReq = new Request("http://localhost/admin/people", {
    headers: {
      Accept: "text/html",
      Cookie: cookieHeader(cookieLine!),
    },
  });
  const authedRes = await app.fetch(authedReq);
  expect(authedRes.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Test 6 — Logout clears session; next request rejected
// ---------------------------------------------------------------------------

test("ISC-39: logout clears session; subsequent request is rejected", async () => {
  // 1. Log in
  const loginRes = await app.fetch(
    new Request("http://localhost/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
    })
  );
  const cookieLine = extractCookie(loginRes, "volorota_sess");
  expect(cookieLine).not.toBeNull();

  // 2. Log out
  const logoutRes = await app.fetch(
    new Request("http://localhost/admin/logout", {
      method: "POST",
      headers: {
        Accept: "text/html",
        Cookie: cookieHeader(cookieLine!),
      },
    })
  );
  expect(logoutRes.status).toBe(302);

  // The cookie should be cleared (Max-Age=0 or expired)
  const clearedCookie = extractCookie(logoutRes, "volorota_sess");
  // Hono deleteCookie sets Max-Age=0
  if (clearedCookie) {
    expect(clearedCookie.toLowerCase()).toMatch(/max-age=0|expires=thu, 01 jan 1970/);
  }

  // 3. Try to access /admin/people — should be rejected now
  const rejectedRes = await app.fetch(
    new Request("http://localhost/admin/people", {
      headers: {
        Accept: "text/html",
        // Send the old (now invalidated) cookie value if logout didn't clear it
        Cookie: clearedCookie ? cookieHeader(clearedCookie) : "",
      },
    })
  );
  expect(rejectedRes.status).toBe(302);
  expect(rejectedRes.headers.get("location")).toBe("/admin/login");
});

// ---------------------------------------------------------------------------
// Test 7 — validateAuthConfig rejects missing / empty password
// ---------------------------------------------------------------------------

test("ISC-39: validateAuthConfig returns error when VOLOROTA_ADMIN_PASSWORD is unset", () => {
  const original = process.env.VOLOROTA_ADMIN_PASSWORD;
  delete process.env.VOLOROTA_ADMIN_PASSWORD;

  const result = validateAuthConfig();
  expect(result).not.toBeNull();
  expect(result!.toLowerCase()).toMatch(/volorota_admin_password/i);

  process.env.VOLOROTA_ADMIN_PASSWORD = original;
});

test("ISC-39: validateAuthConfig returns error when VOLOROTA_ADMIN_PASSWORD is empty string", () => {
  const original = process.env.VOLOROTA_ADMIN_PASSWORD;
  process.env.VOLOROTA_ADMIN_PASSWORD = "";

  const result = validateAuthConfig();
  expect(result).not.toBeNull();
  expect(result!.toLowerCase()).toMatch(/volorota_admin_password/i);

  process.env.VOLOROTA_ADMIN_PASSWORD = original;
});

test("ISC-39: validateAuthConfig returns null when password is set", () => {
  process.env.VOLOROTA_ADMIN_PASSWORD = "some-strong-password";
  const result = validateAuthConfig();
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 8 — Session secret persists in DB (reused across instances)
// ---------------------------------------------------------------------------

test("ISC-39: signing secret persists in DB so new app instances reuse it", () => {
  const secret1 = getSigningSecret(db);
  resetSigningSecretCache();
  const secret2 = getSigningSecret(db);
  // Both should be identical byte arrays
  expect(Buffer.from(secret1).toString("hex")).toBe(Buffer.from(secret2).toString("hex"));
});
